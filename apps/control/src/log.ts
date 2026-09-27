/**
 * Structured logger: one JSON object per line, `{ts, level, app, msg, ...fields}`, levels
 * error > warn > info > debug, selected by AIRLOCK_LOG_LEVEL (default info). No dependencies.
 *
 * Secrets never reach a line: any field whose name looks like a credential (token, authorization,
 * cookie, password, secret, apiKey, ...) is replaced by "[redacted]" at any depth, string values
 * carrying a bearer/cookie header are redacted, and Error values are reduced to name + message.
 * Callers still must not put a secret in `msg` or under an innocent field name.
 *
 * The same file lives in apps/supervisor/src/log.ts (kept identical by hand; no shared package
 * so that neither app grows a runtime dependency on the other).
 */

export type LogLevel = "error" | "warn" | "info" | "debug";
export type LogFields = Record<string, unknown>;

export interface Logger {
  readonly app: string;
  readonly level: LogLevel;
  enabled(level: LogLevel): boolean;
  error(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  debug(msg: string, fields?: LogFields): void;
  /** A logger that adds `fields` to every line (e.g. `{taskId}`). */
  child(fields: LogFields): Logger;
}

const ORDER: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };
export const LOG_LEVELS = Object.keys(ORDER) as LogLevel[];

const SECRET_KEY = /(token|authorization|cookie|passw|secret|api[-_]?key|credential|set-cookie|bearer)/i;
const SECRET_VALUE = /^(bearer\s+\S+|airlock_session=\S+)/i;
const MAX_DEPTH = 6;
const MAX_STRING = 4096;

/** AIRLOCK_LOG_LEVEL → level; unknown or empty values fall back to `fallback` (never throw at startup). */
export function levelFromEnv(raw: string | undefined, fallback: LogLevel = "info"): LogLevel {
  const value = (raw ?? "").trim().toLowerCase();
  return (LOG_LEVELS as string[]).includes(value) ? (value as LogLevel) : fallback;
}

/** Deep copy of `value` with credential-like keys and values replaced; bounded depth and string length. */
export function redact(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    if (SECRET_VALUE.test(value)) return "[redacted]";
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…[${value.length - MAX_STRING} more]` : value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return typeof value === "bigint" ? value.toString() : value;
  if (value instanceof Error) return { name: value.name, message: redact(value.message.slice(0, 1000)), ...("code" in value && typeof (value as { code?: unknown }).code === "string" ? { code: (value as { code: string }).code } : {}) };
  if (depth >= MAX_DEPTH) return "[depth]";
  if (Array.isArray(value)) return value.slice(0, 100).map((v) => redact(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY.test(key) ? (v === undefined || v === null || v === "" ? v : "[redacted]") : redact(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

export interface LoggerOptions {
  app: string;
  level?: LogLevel;
  /** Test seam / sink; default: stdout for info+debug, stderr for warn+error. */
  write?: (line: string, level: LogLevel) => void;
  now?: () => Date;
  base?: LogFields;
}

function defaultWrite(line: string, level: LogLevel) {
  if (level === "error" || level === "warn") process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

export function createLogger(options: LoggerOptions): Logger {
  const level = options.level ?? "info";
  const write = options.write ?? defaultWrite;
  const now = options.now ?? (() => new Date());
  const base = options.base ?? {};
  const emit = (lvl: LogLevel, msg: string, fields?: LogFields) => {
    if (ORDER[lvl] > ORDER[level]) return;
    const record = { ts: now().toISOString(), level: lvl, app: options.app, msg: String(msg).slice(0, MAX_STRING), ...(redact({ ...base, ...(fields ?? {}) }) as LogFields) };
    let line: string;
    try {
      line = JSON.stringify(record);
    } catch {
      line = JSON.stringify({ ts: record.ts, level: lvl, app: options.app, msg: record.msg, fields: "[unserializable]" });
    }
    write(line, lvl);
  };
  return {
    app: options.app,
    level,
    enabled: (lvl) => ORDER[lvl] <= ORDER[level],
    error: (msg, fields) => emit("error", msg, fields),
    warn: (msg, fields) => emit("warn", msg, fields),
    info: (msg, fields) => emit("info", msg, fields),
    debug: (msg, fields) => emit("debug", msg, fields),
    child: (fields) => createLogger({ ...options, level, base: { ...base, ...fields } }),
  };
}

/** The process logger. Level from AIRLOCK_LOG_LEVEL (default info). */
export const log: Logger = createLogger({ app: "control", level: levelFromEnv(process.env.AIRLOCK_LOG_LEVEL) });
