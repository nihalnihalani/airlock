/**
 * Control-plane configuration from the environment. Parsed once at start; secrets are kept on the
 * config object and never copied into logs, events or API responses.
 */
import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/** `scriptPath` is one script file or a directory of `<name>.json` scripts (see scripted.ts). */
export type DriverMode = { kind: "vultr" } | { kind: "scripted"; scriptPath: string };

export interface Config {
  port: number;
  bind: string;
  dataDir: string;
  profilesDir: string;
  /** Directory holding runtime/python/adapter.py (for the adapter digest). */
  runtimeDir: string;
  supervisorUrl: string;
  supervisorToken: string;
  operatorPassword: string | null;
  judgePassword: string | null;
  driver: DriverMode;
  vultr: { apiKey: string | null; baseUrl: string; model: string };
  /** Built web UI (apps/web/dist) served at `/` behind the API; null when the directory is absent. */
  webDist: string | null;
  /** Cookie `Secure` flag; true unless AIRLOCK_INSECURE_COOKIES=1 (local http). */
  secureCookies: boolean;
  sessionTtlMs: number;
  exportGrantTtlMs: number;
  hostileMinIntervalMs: number;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const DEFAULT_VULTR_BASE = "https://api.vultrinference.com/v1";

function intEnv(env: Record<string, string | undefined>, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new ConfigError(`${name} must be an integer between ${min} and ${max}`);
  return n;
}

function requireDir(path: string, label: string) {
  if (!existsSync(path) || !statSync(path).isDirectory()) throw new ConfigError(`${label} is not a directory: ${path}`);
}

export function loadConfig(env: Record<string, string | undefined> = process.env, repoRoot = resolve(import.meta.dir, "../../..")): Config {
  const supervisorToken = env.SUPERVISOR_TOKEN?.trim() ?? "";
  if (!supervisorToken) throw new ConfigError("SUPERVISOR_TOKEN is required");
  if (supervisorToken.length < 16) throw new ConfigError("SUPERVISOR_TOKEN must be at least 16 characters");

  const supervisorUrl = env.SUPERVISOR_URL?.trim() || "http://127.0.0.1:4300";
  if (!/^https?:\/\/[^\s/]+/.test(supervisorUrl)) throw new ConfigError("SUPERVISOR_URL must be an http(s) URL");

  const driverRaw = env.AIRLOCK_MODEL_DRIVER?.trim() || "vultr";
  let driver: DriverMode;
  if (driverRaw === "vultr") driver = { kind: "vultr" };
  else if (driverRaw.startsWith("scripted:")) {
    const scriptPath = resolve(driverRaw.slice("scripted:".length));
    if (!existsSync(scriptPath) || !(statSync(scriptPath).isFile() || statSync(scriptPath).isDirectory()))
      throw new ConfigError(`AIRLOCK_MODEL_DRIVER script file or directory not found: ${scriptPath}`);
    driver = { kind: "scripted", scriptPath };
  } else throw new ConfigError('AIRLOCK_MODEL_DRIVER must be "vultr" or "scripted:<path>"');

  const apiKey = env.VULTR_INFERENCE_API_KEY?.trim() || null;
  const model = env.AIRLOCK_MODEL?.trim() || "";
  if (driver.kind === "vultr") {
    if (!apiKey) throw new ConfigError("VULTR_INFERENCE_API_KEY is required for the vultr driver");
    if (!model) throw new ConfigError("AIRLOCK_MODEL is required for the vultr driver");
  }
  const baseUrl = env.VULTR_INFERENCE_BASE_URL?.trim() || DEFAULT_VULTR_BASE;
  if (!/^https:\/\//.test(baseUrl)) throw new ConfigError("VULTR_INFERENCE_BASE_URL must be https");

  const operatorPassword = env.AIRLOCK_OPERATOR_PASSWORD?.trim() || null;
  const judgePassword = env.AIRLOCK_JUDGE_PASSWORD?.trim() || null;
  for (const [name, value] of [["AIRLOCK_OPERATOR_PASSWORD", operatorPassword], ["AIRLOCK_JUDGE_PASSWORD", judgePassword]] as const) {
    if (value !== null && value.length < 8) throw new ConfigError(`${name} must be at least 8 characters`);
  }
  if (operatorPassword && judgePassword && operatorPassword === judgePassword)
    throw new ConfigError("AIRLOCK_OPERATOR_PASSWORD and AIRLOCK_JUDGE_PASSWORD must differ");
  if (!operatorPassword && !judgePassword)
    console.warn("No AIRLOCK_OPERATOR_PASSWORD or AIRLOCK_JUDGE_PASSWORD set: only the read-only viewer role is available");

  const profilesDir = resolve(env.AIRLOCK_PROFILES_DIR?.trim() || resolve(repoRoot, "profiles"));
  requireDir(profilesDir, "AIRLOCK_PROFILES_DIR");
  const runtimeDir = resolve(env.AIRLOCK_RUNTIME_DIR?.trim() || resolve(repoRoot, "runtime/python"));
  const webDistRaw = env.AIRLOCK_WEB_DIST?.trim();
  let webDist: string | null = null;
  if (webDistRaw === "" || webDistRaw === "none") webDist = null;
  else {
    const candidate = resolve(webDistRaw || resolve(repoRoot, "apps/web/dist"));
    if (existsSync(join(candidate, "index.html"))) webDist = candidate;
    else if (webDistRaw) throw new ConfigError(`AIRLOCK_WEB_DIST has no index.html: ${candidate} (build with: bun run --cwd apps/web build)`);
  }

  return {
    port: intEnv(env, "PORT", 3000, 1, 65535),
    bind: env.CONTROL_BIND?.trim() || "0.0.0.0",
    dataDir: resolve(env.AIRLOCK_DATA_DIR?.trim() || "./data"),
    profilesDir,
    runtimeDir,
    webDist,
    supervisorUrl,
    supervisorToken,
    operatorPassword,
    judgePassword,
    driver,
    vultr: { apiKey, baseUrl, model },
    secureCookies: env.AIRLOCK_INSECURE_COOKIES !== "1",
    sessionTtlMs: intEnv(env, "AIRLOCK_SESSION_TTL_MS", 12 * 60 * 60 * 1000, 60_000, 30 * 24 * 60 * 60 * 1000),
    exportGrantTtlMs: intEnv(env, "AIRLOCK_EXPORT_GRANT_TTL_MS", 24 * 60 * 60 * 1000, 60_000, 30 * 24 * 60 * 60 * 1000),
    hostileMinIntervalMs: intEnv(env, "AIRLOCK_HOSTILE_MIN_INTERVAL_MS", 10_000, 0, 3_600_000),
  };
}

/** A copy of the config safe to print: secrets replaced. */
export function redactConfig(config: Config): Record<string, unknown> {
  return {
    ...config,
    supervisorToken: "[redacted]",
    operatorPassword: config.operatorPassword ? "[set]" : null,
    judgePassword: config.judgePassword ? "[set]" : null,
    vultr: { ...config.vultr, apiKey: config.vultr.apiKey ? "[redacted]" : null },
  };
}
