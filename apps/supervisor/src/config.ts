/**
 * Supervisor configuration, read once from the environment.
 *
 * Nothing here is caller-selectable at runtime: the image, runtime, caps and profiles come from
 * this configuration plus the profile directory. Requests only name attempts and operations.
 */
import { resolve } from "node:path";
import { RuntimeName } from "@airlock/contracts";
import { resolveNamespace } from "./names";

export interface SupervisorConfig {
  token: string;
  port: number;
  bind: string;
  runtime: RuntimeName;
  /** The name Docker knows the runtime by (`docker info` → Runtimes). */
  dockerRuntime: string;
  devUnsafe: boolean;
  profilesDir: string;
  dataDir: string;
  journalPath: string;
  dockerSocket: string | undefined;
  namespace: string;
  /** How long a stopped attempt's volume is retained past its deadline before the janitor destroys it. */
  retentionMs: number;
  janitorIntervalMs: number;
}

export type ConfigResult = { ok: true; config: SupervisorConfig } | { ok: false; reason: string };

const DOCKER_RUNTIME_NAME: Record<RuntimeName, string> = { kata: "kata", runsc: "runsc", runc: "runc" };

/**
 * Classify a runtime name by what it says about itself, or `undefined` for a name that says nothing.
 * Shared-kernel OCI runtimes (runc, crun, youki) are the lowest tier and are recognised first.
 */
export function runtimeTierOfName(name: string): RuntimeName | undefined {
  if (/runc|crun|youki/i.test(name)) return "runc";
  if (/kata/i.test(name)) return "kata";
  if (/runsc|gvisor/i.test(name)) return "runsc";
  return undefined;
}

function parsePort(raw: string | undefined, fallback: number): number | undefined {
  if (raw === undefined || raw.trim() === "") return fallback;
  if (!/^\d{1,5}$/.test(raw.trim())) return undefined;
  const port = Number.parseInt(raw.trim(), 10);
  return port >= 1 && port <= 65535 ? port : undefined;
}

export function loadConfig(env: Record<string, string | undefined>, repoRoot: string): ConfigResult {
  const token = env.SUPERVISOR_TOKEN?.trim();
  if (!token || token.length < 16) {
    return {
      ok: false,
      reason:
        "SUPERVISOR_TOKEN is not set (or shorter than 16 characters). This process holds the Docker socket and will not start without the secret its caller must present.",
    };
  }
  const port = parsePort(env.PORT, 4300);
  if (port === undefined) return { ok: false, reason: "PORT must be an integer between 1 and 65535." };
  const bind = env.SUPERVISOR_BIND?.trim() || "127.0.0.1";
  if (!/^[A-Za-z0-9.:\-\[\]]{1,128}$/.test(bind)) return { ok: false, reason: "SUPERVISOR_BIND is not a bind address." };

  const runtimeRaw = env.AIRLOCK_RUNTIME?.trim() || "kata";
  const runtime = RuntimeName.safeParse(runtimeRaw);
  if (!runtime.success) return { ok: false, reason: "AIRLOCK_RUNTIME must be one of kata, runsc, runc." };
  const devUnsafe = env.AIRLOCK_DEV_UNSAFE?.trim() === "1";
  if (runtime.data === "runc" && !devUnsafe) {
    return {
      ok: false,
      reason:
        "AIRLOCK_RUNTIME=runc is not an acceptable shipped runtime. Set AIRLOCK_DEV_UNSAFE=1 only for local development; every record will be labelled dev-unsafe.",
    };
  }
  const dockerRuntimeOverride = env.AIRLOCK_DOCKER_RUNTIME_NAME?.trim();
  if (dockerRuntimeOverride && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(dockerRuntimeOverride)) {
    return { ok: false, reason: "AIRLOCK_DOCKER_RUNTIME_NAME is not a runtime name." };
  }
  if (dockerRuntimeOverride) {
    // The override names the runtime Docker lists; it cannot name a runtime of a different tier
    // than AIRLOCK_RUNTIME, or every inspection would carry an assumed tier (CLAUDE.md §3.8).
    const tierByName = runtimeTierOfName(dockerRuntimeOverride);
    if (tierByName !== undefined && tierByName !== runtime.data) {
      return {
        ok: false,
        reason: `AIRLOCK_DOCKER_RUNTIME_NAME=${dockerRuntimeOverride} names a ${tierByName} runtime but AIRLOCK_RUNTIME=${runtime.data}. The recorded tier is inspected, never assumed; fix one of them.`,
      };
    }
  }
  const dataDir = resolve(repoRoot, env.AIRLOCK_DATA_DIR?.trim() || "data/supervisor");
  const journalPath = resolve(repoRoot, env.AIRLOCK_JOURNAL_PATH?.trim() || `${dataDir}/supervisor-journal.sqlite`);
  const profilesDir = resolve(repoRoot, env.AIRLOCK_PROFILES_DIR?.trim() || "profiles");
  let namespace: string;
  try {
    namespace = resolveNamespace(env.AIRLOCK_NAMESPACE);
  } catch (error) {
    return { ok: false, reason: (error as Error).message };
  }
  const retention = parseMs(env.AIRLOCK_RETENTION_MS, 30 * 60_000);
  if (retention === undefined) return { ok: false, reason: "AIRLOCK_RETENTION_MS must be a positive integer." };
  const janitor = parseMs(env.AIRLOCK_JANITOR_INTERVAL_MS, 30_000);
  if (janitor === undefined) return { ok: false, reason: "AIRLOCK_JANITOR_INTERVAL_MS must be a positive integer." };

  return {
    ok: true,
    config: {
      token,
      port,
      bind,
      runtime: runtime.data,
      dockerRuntime: dockerRuntimeOverride || DOCKER_RUNTIME_NAME[runtime.data],
      devUnsafe: runtime.data === "runc" && devUnsafe,
      profilesDir,
      dataDir,
      journalPath,
      dockerSocket: resolveDockerSocket(env),
      namespace,
      retentionMs: retention,
      janitorIntervalMs: janitor,
    },
  };
}

/** DOCKER_SOCKET wins; otherwise a unix:// DOCKER_HOST (Colima, rootless Docker); otherwise dockerode's default. */
export function resolveDockerSocket(env: Record<string, string | undefined>): string | undefined {
  const explicit = env.DOCKER_SOCKET?.trim();
  if (explicit) return explicit;
  const host = env.DOCKER_HOST?.trim();
  if (host?.startsWith("unix://")) return host.slice("unix://".length);
  return undefined;
}

function parseMs(raw: string | undefined, fallback: number): number | undefined {
  if (raw === undefined || raw.trim() === "") return fallback;
  if (!/^\d{1,12}$/.test(raw.trim())) return undefined;
  const value = Number.parseInt(raw.trim(), 10);
  return value > 0 ? value : undefined;
}
