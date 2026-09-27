/**
 * Control-plane configuration from the environment. Parsed once at start; secrets are kept on the
 * config object and never copied into logs, events or API responses.
 */
import { existsSync, statSync } from "node:fs";
import { isIP } from "node:net";
import { join, resolve } from "node:path";
import { parseFormsOrigins } from "./forms-adapter.ts";
import { log } from "./log.ts";

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
  /** AIRLOCK_PRODUCTION=1: a deployment. Test-only overrides (e.g. the inference base URL) are refused. */
  production: boolean;
  /** Committed live-gate receipts (AIRLOCK_LIVE_GATE_EVIDENCE_DIR, default <repo>/docs/evidence/live-gate). */
  liveGateEvidenceDir: string;
  /** Repository root, for reporting evidence paths relative to it. */
  repoRoot: string;
  /** Vultr instance id of this control-plane VM (AIRLOCK_INSTANCE_ID), shown on repair availability. */
  instanceId: string | null;
  /**
   * Directory of labelled diagnostic scripts an operator or judge may launch whatever the model
   * driver (AIRLOCK_DIAGNOSTIC_SCRIPTS_DIR). Null: none, except the scripted driver's own catalog.
   */
  diagnosticScriptsDir: string | null;
  /** max_tokens per model turn (AIRLOCK_MODEL_MAX_TOKENS, default 16384; reasoning counts against it). */
  modelMaxTokens: number;
  /** Sent as reasoning_effort only when set (AIRLOCK_MODEL_REASONING_EFFORT). */
  modelReasoningEffort: string | null;
  /**
   * AIRLOCK_MODEL_VISION=1: the configured model accepts images (verify with
   * `bun scripts/probe-model.ts --vision <model>`); general tasks then attach screenshots to the
   * next model turn. Unset: no image is ever sent.
   */
  modelVision: boolean;
  /**
   * Labelled diagnostic scripts for general tasks (AIRLOCK_GENERAL_DIAGNOSTIC_SCRIPTS_DIR), merged
   * into the diagnostics catalog; null: none.
   */
  generalDiagnosticScriptsDir: string | null;
  /** Built web UI (apps/web/dist) served at `/` behind the API; null when the directory is absent. */
  webDist: string | null;
  /** Cookie `Secure` flag; true unless AIRLOCK_INSECURE_COOKIES=1 (local http). */
  secureCookies: boolean;
  /**
   * Socket peer addresses of trusted reverse proxies ("loopback" = 127.0.0.0/8 and ::1). Only a
   * request arriving from one of them has X-Forwarded-For / X-Real-IP honoured by the login
   * limiter. Empty: those headers are never trusted.
   */
  trustedProxies: string[];
  sessionTtlMs: number;
  exportGrantTtlMs: number;
  hostileMinIntervalMs: number;
  /** Minimum interval between any two hostile runs, whoever starts them. */
  hostileGlobalMinIntervalMs: number;
  previewMinIntervalMs: number;
  /**
   * Supported final-action destinations (airlock-forms-v1): AIRLOCK_FORMS_ORIGINS, a comma-separated
   * list of origins, with the shared AIRLOCK_FORMS_SECRET (≥ 32 chars). Empty: browser_propose_submit
   * is refused and no final action is possible.
   */
  formsOrigins: string[];
  formsSecret: string | null;
  /** Public origin of the Airlock fixtures service, substituted for {{AIRLOCK_FIXTURES_ORIGIN}} in scripted diagnostics. */
  fixturesOrigin: string | null;
  /** AIRLOCK_PUBLIC_HOST: this deployment's own public hostname(s), never allowed as a task destination. */
  publicHosts: string[];
  /** Human browser control returns to the agent after this long without a human action (AIRLOCK_CONTROL_IDLE_MS). */
  controlIdleMs: number;
  /** How long taking control waits for the in-flight browser op (AIRLOCK_CONTROL_SETTLE_MS). */
  controlSettleMs: number;
  /** Lifetime of an action proposal and its approval code (AIRLOCK_PROPOSAL_TTL_MS). */
  proposalTtlMs: number;
  /** Teardown retries for a finished task whose cleanup was not confirmed (AIRLOCK_CLEANUP_RETRIES, cleanup-sweeper.ts). */
  cleanupRetries: number;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** The only inference endpoint a deployment talks to (CLAUDE.md §3.10). */
export const PINNED_VULTR_BASE = "https://api.vultrinference.com/v1";
export const DEFAULT_MODEL_MAX_TOKENS = 16384;
const MAX_MODEL_MAX_TOKENS = 131072;

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
  const production = env.AIRLOCK_PRODUCTION === "1";
  const baseUrl = parseInferenceBaseUrl(env.VULTR_INFERENCE_BASE_URL, { production, allowTestUrl: env.AIRLOCK_ALLOW_TEST_INFERENCE_URL === "1" });
  const modelMaxTokens = intEnv(env, "AIRLOCK_MODEL_MAX_TOKENS", DEFAULT_MODEL_MAX_TOKENS, 256, MAX_MODEL_MAX_TOKENS);
  const modelReasoningEffort = parseReasoningEffort(env.AIRLOCK_MODEL_REASONING_EFFORT);

  const operatorPassword = env.AIRLOCK_OPERATOR_PASSWORD?.trim() || null;
  const judgePassword = env.AIRLOCK_JUDGE_PASSWORD?.trim() || null;
  for (const [name, value] of [["AIRLOCK_OPERATOR_PASSWORD", operatorPassword], ["AIRLOCK_JUDGE_PASSWORD", judgePassword]] as const) {
    if (value !== null && value.length < 8) throw new ConfigError(`${name} must be at least 8 characters`);
  }
  if (operatorPassword && judgePassword && operatorPassword === judgePassword)
    throw new ConfigError("AIRLOCK_OPERATOR_PASSWORD and AIRLOCK_JUDGE_PASSWORD must differ");
  if (!operatorPassword && !judgePassword)
    log.warn("No AIRLOCK_OPERATOR_PASSWORD or AIRLOCK_JUDGE_PASSWORD set: only the read-only viewer role is available");

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

  const liveGateEvidenceDir = resolve(env.AIRLOCK_LIVE_GATE_EVIDENCE_DIR?.trim() || resolve(repoRoot, "docs/evidence/live-gate"));
  const diagnosticRaw = env.AIRLOCK_DIAGNOSTIC_SCRIPTS_DIR?.trim() ?? "";
  let diagnosticScriptsDir: string | null = null;
  if (diagnosticRaw !== "" && diagnosticRaw !== "none") {
    diagnosticScriptsDir = resolve(diagnosticRaw);
    requireDir(diagnosticScriptsDir, "AIRLOCK_DIAGNOSTIC_SCRIPTS_DIR");
  }
  const generalRaw = env.AIRLOCK_GENERAL_DIAGNOSTIC_SCRIPTS_DIR?.trim() ?? "";
  let generalDiagnosticScriptsDir: string | null = null;
  if (generalRaw !== "" && generalRaw !== "none") {
    generalDiagnosticScriptsDir = resolve(generalRaw);
    requireDir(generalDiagnosticScriptsDir, "AIRLOCK_GENERAL_DIAGNOSTIC_SCRIPTS_DIR");
  }
  const visionRaw = env.AIRLOCK_MODEL_VISION?.trim() ?? "";
  if (visionRaw !== "" && visionRaw !== "0" && visionRaw !== "1") throw new ConfigError("AIRLOCK_MODEL_VISION must be 1 (the model accepts images) or 0/unset");
  const instanceId = env.AIRLOCK_INSTANCE_ID?.trim() || null;
  if (instanceId !== null && !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(instanceId)) throw new ConfigError("AIRLOCK_INSTANCE_ID must be a plain identifier (letters, digits, . _ : -; at most 128)");

  let formsOrigins: string[];
  try {
    formsOrigins = parseFormsOrigins(env.AIRLOCK_FORMS_ORIGINS);
  } catch (error) {
    throw new ConfigError(`AIRLOCK_FORMS_ORIGINS: ${error instanceof Error ? error.message : "invalid"}`);
  }
  const formsSecret = env.AIRLOCK_FORMS_SECRET?.trim() || null;
  if (formsOrigins.length > 0 && (!formsSecret || formsSecret.length < 32)) throw new ConfigError("AIRLOCK_FORMS_SECRET (at least 32 characters, shared with the forms destination) is required when AIRLOCK_FORMS_ORIGINS is set");
  const fixturesRaw = env.AIRLOCK_FIXTURES_ORIGIN?.trim() || "";
  let fixturesOrigin: string | null = null;
  if (fixturesRaw) {
    try {
      const url = new URL(fixturesRaw);
      if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) throw new Error("not an http(s) origin");
      fixturesOrigin = url.origin;
    } catch {
      throw new ConfigError("AIRLOCK_FIXTURES_ORIGIN must be an http(s) origin, e.g. https://fixtures.example.org");
    }
  }

  const publicHosts: string[] = [];
  for (const part of (env.AIRLOCK_PUBLIC_HOST ?? "").split(",").map((p) => p.trim()).filter(Boolean)) {
    try {
      const host = new URL(/^https?:\/\//i.test(part) ? part : `https://${part}`).hostname.toLowerCase().replace(/^\[|\]$/g, "");
      if (!host) throw new Error("empty");
      if (!publicHosts.includes(host)) publicHosts.push(host);
    } catch {
      throw new ConfigError(`AIRLOCK_PUBLIC_HOST entry "${part.slice(0, 100)}" is not a hostname or origin`);
    }
  }

  return {
    formsOrigins,
    publicHosts,
    formsSecret,
    fixturesOrigin,
    controlIdleMs: intEnv(env, "AIRLOCK_CONTROL_IDLE_MS", 5 * 60_000, 10_000, 60 * 60_000),
    controlSettleMs: intEnv(env, "AIRLOCK_CONTROL_SETTLE_MS", 10_000, 1000, 120_000),
    proposalTtlMs: intEnv(env, "AIRLOCK_PROPOSAL_TTL_MS", 15 * 60_000, 60_000, 24 * 60 * 60_000),
    cleanupRetries: intEnv(env, "AIRLOCK_CLEANUP_RETRIES", 6, 0, 100),
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
    production,
    liveGateEvidenceDir,
    repoRoot: resolve(repoRoot),
    instanceId,
    diagnosticScriptsDir,
    modelMaxTokens,
    modelReasoningEffort,
    modelVision: visionRaw === "1",
    generalDiagnosticScriptsDir,
    secureCookies: env.AIRLOCK_INSECURE_COOKIES !== "1",
    trustedProxies: parseTrustedProxies(env.AIRLOCK_TRUST_PROXY),
    sessionTtlMs: intEnv(env, "AIRLOCK_SESSION_TTL_MS", 12 * 60 * 60 * 1000, 60_000, 30 * 24 * 60 * 60 * 1000),
    exportGrantTtlMs: intEnv(env, "AIRLOCK_EXPORT_GRANT_TTL_MS", 24 * 60 * 60 * 1000, 60_000, 30 * 24 * 60 * 60 * 1000),
    hostileMinIntervalMs: intEnv(env, "AIRLOCK_HOSTILE_MIN_INTERVAL_MS", 10_000, 0, 3_600_000),
    hostileGlobalMinIntervalMs: intEnv(env, "AIRLOCK_HOSTILE_GLOBAL_MIN_INTERVAL_MS", 3_000, 0, 3_600_000),
    previewMinIntervalMs: intEnv(env, "AIRLOCK_PREVIEW_MIN_INTERVAL_MS", 2_000, 0, 3_600_000),
  };
}

/**
 * VULTR_INFERENCE_BASE_URL: only `https://api.vultrinference.com/v1` (a trailing slash is ignored).
 * Another https URL is accepted only with AIRLOCK_ALLOW_TEST_INFERENCE_URL=1 and never with
 * AIRLOCK_PRODUCTION=1; tests inject a fake driver or transport instead of pointing at a host.
 */
export function parseInferenceBaseUrl(raw: string | undefined, options: { production: boolean; allowTestUrl: boolean }): string {
  const value = (raw?.trim() || PINNED_VULTR_BASE).replace(/\/+$/, "");
  if (value === PINNED_VULTR_BASE) return value;
  if (options.production) throw new ConfigError(`VULTR_INFERENCE_BASE_URL must be ${PINNED_VULTR_BASE} in production (AIRLOCK_PRODUCTION=1)`);
  if (!options.allowTestUrl) throw new ConfigError(`VULTR_INFERENCE_BASE_URL must be ${PINNED_VULTR_BASE}; another endpoint needs AIRLOCK_ALLOW_TEST_INFERENCE_URL=1 (never in production)`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError("VULTR_INFERENCE_BASE_URL is not a valid URL");
  }
  if (url.protocol !== "https:") throw new ConfigError("VULTR_INFERENCE_BASE_URL must be https");
  if (url.username || url.password) throw new ConfigError("VULTR_INFERENCE_BASE_URL must not carry credentials");
  log.warn("VULTR_INFERENCE_BASE_URL overridden for testing (AIRLOCK_ALLOW_TEST_INFERENCE_URL=1): runs are not Vultr Serverless Inference", { host: url.host });
  return value;
}

/**
 * AIRLOCK_TRUST_PROXY: unset, empty or "0" trusts no proxy header; "1" (or "loopback") trusts a
 * reverse proxy on this host; otherwise a comma-separated list of the proxies' IP addresses as
 * they appear as socket peers of this process.
 */
export function parseTrustedProxies(raw: string | undefined): string[] {
  const value = raw?.trim() ?? "";
  if (value === "" || value === "0") return [];
  if (value === "1" || value === "loopback") return ["loopback"];
  const out: string[] = [];
  for (const part of value.split(",").map((p) => p.trim()).filter(Boolean)) {
    if (part === "loopback") out.push(part);
    else if (isIP(part)) out.push(part);
    else throw new ConfigError(`AIRLOCK_TRUST_PROXY must be 1 (loopback proxy) or a comma-separated list of proxy IP addresses; got "${part}"`);
  }
  return out;
}

/**
 * AIRLOCK_MODEL_REASONING_EFFORT: unset or empty sends nothing; otherwise a short identifier such
 * as "low", "medium" or "high" passed through as `reasoning_effort` (the provider decides its meaning).
 */
export function parseReasoningEffort(raw: string | undefined): string | null {
  const value = raw?.trim() ?? "";
  if (value === "") return null;
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(value)) throw new ConfigError('AIRLOCK_MODEL_REASONING_EFFORT must be a short lowercase identifier such as "low", "medium" or "high"');
  return value;
}

/** A copy of the config safe to print: secrets replaced. */
export function redactConfig(config: Config): Record<string, unknown> {
  return {
    ...config,
    supervisorToken: "[redacted]",
    operatorPassword: config.operatorPassword ? "[set]" : null,
    judgePassword: config.judgePassword ? "[set]" : null,
    formsSecret: config.formsSecret ? "[redacted]" : null,
    vultr: { ...config.vultr, apiKey: config.vultr.apiKey ? "[redacted]" : null },
  };
}

/**
 * The transport handed to the live driver: never follows a redirect (a 3xx is an error, so the
 * bearer key cannot be forwarded to another host) and refuses any URL outside the configured base.
 */
export function inferenceFetch(baseUrl: string, fetchImpl: typeof fetch = fetch): typeof fetch {
  const base = new URL(baseUrl);
  const prefix = baseUrl.replace(/\/+$/, "") + "/";
  const wrapped = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.origin !== base.origin || !(url.href + "/").startsWith(prefix)) throw new Error(`inference request outside ${base.origin}${base.pathname} refused`);
    return fetchImpl(input, { ...init, redirect: "error" });
  }) as typeof fetch;
  return wrapped;
}
