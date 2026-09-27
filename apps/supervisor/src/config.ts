/**
 * Supervisor configuration, read once from the environment.
 *
 * Nothing here is caller-selectable at runtime: the image, runtime, caps and profiles come from
 * this configuration plus the profile directory. Requests only name attempts and operations.
 */
import { readFileSync } from "node:fs";
import { isIPv4, isIPv6 } from "node:net";
import { totalmem } from "node:os";
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
  /** AIRLOCK_PRODUCTION=1 (set by deploy/host/sandbox-host.sh): refuse every dev-only configuration. */
  production: boolean;
  /**
   * The `sha256:` image ID the runtime image must have (AIRLOCK_RUNTIME_IMAGE_ID, captured by deploy
   * after the build). Every inspection compares the container's effective image ID to it; a retag
   * fails closed. Required unless dev-unsafe.
   */
  runtimeImageId: string | undefined;
  /** The Vultr instance id of this execution host (AIRLOCK_INSTANCE_ID), echoed in HostCheck. */
  instanceId: string | undefined;
  /** Host admission budget (see capacity.ts). */
  capacity: CapacityBudget;
  /**
   * The browser plane (Chromium sandbox + per-attempt egress proxy). Undefined when
   * AIRLOCK_BROWSER_IMAGE is not set: `role: "browser"` is then refused as unsupported.
   */
  browser: BrowserPlaneConfig | undefined;
}

/**
 * The browser runtime profile. It is not a repository profile: there is exactly one, it is fixed by
 * this configuration, and a request selects it with `profileId: "browser"` and `role: "browser"`.
 */
export interface BrowserPlaneConfig {
  image: string;
  /** Pinned `sha256:` image ID (AIRLOCK_BROWSER_IMAGE_ID); required outside dev-unsafe. */
  imageId: string | undefined;
  egressImage: string;
  /** Pinned `sha256:` image ID (AIRLOCK_EGRESS_IMAGE_ID); required outside dev-unsafe. */
  egressImageId: string | undefined;
  /** Path of the Chromium seccomp profile (AIRLOCK_BROWSER_SECCOMP) and its compact JSON. */
  seccompPath: string;
  seccompJson: string;
  memoryBytes: number;
  pidsLimit: number;
  shmBytes: number;
  tmpBytes: number;
  cpus: number;
  egressMemoryBytes: number;
  egressPidsLimit: number;
  egressCpus: number;
  /** Upper bound on a browser attempt's absolute deadline. */
  attemptTimeoutMs: number;
}

export interface CapacityBudget {
  memoryBytes: number;
  pids: number;
  scratchBytes: number;
  maxSandboxes: number;
  /** Charged per sandbox on top of caps.memoryBytes: the guest VM's own footprint under Kata. */
  vmOverheadBytes: number;
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
  const bindClass = classifyBind(bind);
  if (bindClass === "invalid" || bindClass === "public") {
    return {
      ok: false,
      reason: `SUPERVISOR_BIND=${bind} is ${bindClass === "invalid" ? "not an IP address (or localhost)" : "a wildcard or public address"}. The supervisor holds the Docker socket and listens only on loopback or a private address (RFC 1918, 100.64.0.0/10, fc00::/7, fe80::/10).`,
    };
  }
  const production = env.AIRLOCK_PRODUCTION?.trim() === "1";

  const runtimeRaw = env.AIRLOCK_RUNTIME?.trim() || "kata";
  const runtime = RuntimeName.safeParse(runtimeRaw);
  if (!runtime.success) return { ok: false, reason: "AIRLOCK_RUNTIME must be one of kata, runsc, runc." };
  const devUnsafe = env.AIRLOCK_DEV_UNSAFE?.trim() === "1";
  if (production && (devUnsafe || runtime.data === "runc")) {
    return {
      ok: false,
      reason: `AIRLOCK_PRODUCTION=1 refuses ${devUnsafe ? "AIRLOCK_DEV_UNSAFE=1" : "AIRLOCK_RUNTIME=runc"}: a deployment runs kata (target) or runsc (floor), never the dev-unsafe runc path.`,
    };
  }
  if (devUnsafe && bindClass !== "loopback") {
    return { ok: false, reason: `AIRLOCK_DEV_UNSAFE=1 is allowed only with a loopback SUPERVISOR_BIND (got ${bind}); dev-unsafe is a local-development mode.` };
  }
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

  const runtimeImageId = env.AIRLOCK_RUNTIME_IMAGE_ID?.trim() || undefined;
  if (runtimeImageId !== undefined && !/^sha256:[a-f0-9]{64}$/.test(runtimeImageId)) {
    return { ok: false, reason: "AIRLOCK_RUNTIME_IMAGE_ID must be a `sha256:<64 hex>` image ID (docker image inspect --format '{{.Id}}')." };
  }
  const effectiveDevUnsafe = runtime.data === "runc" && devUnsafe;
  if (runtimeImageId === undefined && (production || !effectiveDevUnsafe)) {
    return {
      ok: false,
      reason: "AIRLOCK_RUNTIME_IMAGE_ID is not set. Outside dev-unsafe the supervisor enforces the built runtime image's ID on every inspection; deploy captures it after runtime/python/build.sh.",
    };
  }
  const instanceId = env.AIRLOCK_INSTANCE_ID?.trim() || undefined;
  if (instanceId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(instanceId)) {
    return { ok: false, reason: "AIRLOCK_INSTANCE_ID must be letters, digits and hyphens (a Vultr instance id)." };
  }

  const headroom = parseBytes(env.AIRLOCK_HOST_HEADROOM_BYTES, 1024 * 1024 * 1024);
  if (headroom === undefined) return { ok: false, reason: "AIRLOCK_HOST_HEADROOM_BYTES must be a positive integer." };
  const memoryBudget = parseBytes(env.AIRLOCK_HOST_MEMORY_BYTES, totalmem() - headroom);
  if (memoryBudget === undefined || memoryBudget <= 0) {
    return { ok: false, reason: "AIRLOCK_HOST_MEMORY_BYTES must be a positive integer (the default, total memory minus AIRLOCK_HOST_HEADROOM_BYTES, is not positive on this host)." };
  }
  const pidsBudget = parseBytes(env.AIRLOCK_HOST_PIDS, 4096);
  if (pidsBudget === undefined) return { ok: false, reason: "AIRLOCK_HOST_PIDS must be a positive integer." };
  const scratchBudget = parseBytes(env.AIRLOCK_HOST_SCRATCH_BYTES, 4 * 1024 * 1024 * 1024);
  if (scratchBudget === undefined) return { ok: false, reason: "AIRLOCK_HOST_SCRATCH_BYTES must be a positive integer." };
  const maxSandboxes = parseBytes(env.AIRLOCK_MAX_SANDBOXES, 8);
  if (maxSandboxes === undefined) return { ok: false, reason: "AIRLOCK_MAX_SANDBOXES must be a positive integer." };
  // Kata runs each sandbox in its own guest VM, whose kernel and agent are not inside caps.memoryBytes.
  const vmOverhead = parseBytes(env.AIRLOCK_VM_OVERHEAD_BYTES, runtime.data === "kata" ? 160 * 1024 * 1024 : 0, true);
  if (vmOverhead === undefined) return { ok: false, reason: "AIRLOCK_VM_OVERHEAD_BYTES must be a non-negative integer." };

  const browser = loadBrowserPlane(env, repoRoot, { production, devUnsafe: effectiveDevUnsafe });
  if (!browser.ok) return browser;

  return {
    ok: true,
    config: {
      token,
      port,
      bind,
      runtime: runtime.data,
      dockerRuntime: dockerRuntimeOverride || DOCKER_RUNTIME_NAME[runtime.data],
      devUnsafe: effectiveDevUnsafe,
      profilesDir,
      dataDir,
      journalPath,
      dockerSocket: resolveDockerSocket(env),
      namespace,
      retentionMs: retention,
      janitorIntervalMs: janitor,
      production,
      runtimeImageId,
      instanceId,
      capacity: { memoryBytes: memoryBudget, pids: pidsBudget, scratchBytes: scratchBudget, maxSandboxes, vmOverheadBytes: vmOverhead },
      browser: browser.value,
    },
  };
}

const IMAGE_REF = /^[a-z0-9][a-z0-9._\/-]{0,200}(:[A-Za-z0-9._-]{1,128})?(@sha256:[a-f0-9]{64})?$/;
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/;

function loadBrowserPlane(
  env: Record<string, string | undefined>,
  repoRoot: string,
  mode: { production: boolean; devUnsafe: boolean },
): { ok: true; value: BrowserPlaneConfig | undefined } | { ok: false; reason: string } {
  const image = env.AIRLOCK_BROWSER_IMAGE?.trim();
  if (!image) return { ok: true, value: undefined };
  const egressImage = env.AIRLOCK_EGRESS_IMAGE?.trim() || "airlock-egress:dev";
  for (const [name, value] of [["AIRLOCK_BROWSER_IMAGE", image], ["AIRLOCK_EGRESS_IMAGE", egressImage]] as const) {
    if (!IMAGE_REF.test(value)) return { ok: false, reason: `${name} is not an image reference.` };
  }
  const imageId = env.AIRLOCK_BROWSER_IMAGE_ID?.trim() || undefined;
  const egressImageId = env.AIRLOCK_EGRESS_IMAGE_ID?.trim() || undefined;
  for (const [name, value] of [["AIRLOCK_BROWSER_IMAGE_ID", imageId], ["AIRLOCK_EGRESS_IMAGE_ID", egressImageId]] as const) {
    if (value !== undefined && !IMAGE_ID.test(value)) return { ok: false, reason: `${name} must be a \`sha256:<64 hex>\` image ID.` };
    if (value === undefined && (mode.production || !mode.devUnsafe)) {
      return { ok: false, reason: `${name} is not set. Outside dev-unsafe the supervisor enforces the built browser/egress image IDs on every inspection; deploy captures them after the build.` };
    }
  }
  const seccompPath = resolve(repoRoot, env.AIRLOCK_BROWSER_SECCOMP?.trim() || "runtime/browser/seccomp/chromium.json");
  let seccompJson: string;
  try {
    const parsed = JSON.parse(readFileSync(seccompPath, "utf8")) as { defaultAction?: unknown; syscalls?: unknown };
    if (typeof parsed.defaultAction !== "string" || !Array.isArray(parsed.syscalls)) throw new Error("not a seccomp profile (defaultAction/syscalls)");
    if (parsed.defaultAction === "SCMP_ACT_ALLOW") throw new Error("defaultAction SCMP_ACT_ALLOW is not a restricting profile");
    seccompJson = JSON.stringify(parsed);
  } catch (error) {
    return { ok: false, reason: `AIRLOCK_BROWSER_SECCOMP ${seccompPath} is not a usable seccomp profile (${(error as Error).message}).` };
  }
  const n = (name: string, fallback: number, min: number): number | string => {
    const value = parseBytes(env[name], fallback);
    return value === undefined || value < min ? `${name} must be an integer >= ${min}.` : value;
  };
  const f = (name: string, fallback: number): number | string => {
    const raw = env[name]?.trim();
    if (!raw) return fallback;
    const value = Number(raw);
    return /^\d+(\.\d+)?$/.test(raw) && value >= 0.1 && value <= 64 ? value : `${name} must be a CPU count between 0.1 and 64.`;
  };
  const values = {
    memoryBytes: n("AIRLOCK_BROWSER_MEMORY_BYTES", 2 * 1024 ** 3, 256 * 1024 ** 2),
    pidsLimit: n("AIRLOCK_BROWSER_PIDS", 256, 64),
    shmBytes: n("AIRLOCK_BROWSER_SHM_BYTES", 256 * 1024 ** 2, 64 * 1024 ** 2),
    tmpBytes: n("AIRLOCK_BROWSER_TMP_BYTES", 512 * 1024 ** 2, 64 * 1024 ** 2),
    cpus: f("AIRLOCK_BROWSER_CPUS", 1),
    egressMemoryBytes: n("AIRLOCK_EGRESS_MEMORY_BYTES", 128 * 1024 ** 2, 64 * 1024 ** 2),
    egressPidsLimit: n("AIRLOCK_EGRESS_PIDS", 64, 16),
    egressCpus: f("AIRLOCK_EGRESS_CPUS", 0.5),
    attemptTimeoutMs: n("AIRLOCK_BROWSER_ATTEMPT_TIMEOUT_MS", 30 * 60_000, 60_000),
  };
  for (const value of Object.values(values)) if (typeof value === "string") return { ok: false, reason: value };
  return {
    ok: true,
    value: { image, imageId, egressImage, egressImageId, seccompPath, seccompJson, ...(values as { [K in keyof typeof values]: number }) },
  };
}

export type BindClass = "loopback" | "private" | "public" | "invalid";

/**
 * Where a listen address sits. Wildcards (0.0.0.0, ::) count as public: they listen on every
 * interface, including the public one. Only literal addresses (and `localhost`) are accepted, so a
 * hostname can never resolve somewhere unexpected.
 */
export function classifyBind(raw: string): BindClass {
  const bind = raw.startsWith("[") && raw.endsWith("]") ? raw.slice(1, -1) : raw;
  if (bind === "localhost") return "loopback";
  if (isIPv4(bind)) return classifyIPv4(bind);
  if (isIPv6(bind)) {
    const lower = bind.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped?.[1]) return classifyIPv4(mapped[1]);
    const groups = expandIPv6(lower);
    if (!groups) return "invalid";
    if (groups.every((g) => g === 0)) return "public"; // ::
    if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return "loopback"; // ::1
    const first = groups[0] ?? 0;
    if ((first & 0xfe00) === 0xfc00) return "private"; // fc00::/7
    if ((first & 0xffc0) === 0xfe80) return "private"; // fe80::/10
    return "public";
  }
  return "invalid";
}

function classifyIPv4(ip: string): BindClass {
  const [a = -1, b = -1] = ip.split(".").map((part) => Number.parseInt(part, 10));
  if (a === 127) return "loopback";
  if (a === 10) return "private";
  if (a === 172 && b >= 16 && b <= 31) return "private";
  if (a === 192 && b === 168) return "private";
  if (a === 100 && b >= 64 && b <= 127) return "private"; // 100.64.0.0/10 (CGNAT, NetBird/Tailscale)
  return "public"; // including 0.0.0.0
}

function expandIPv6(ip: string): number[] | undefined {
  const withoutZone = ip.split("%")[0] ?? "";
  const halves = withoutZone.split("::");
  if (halves.length > 2) return undefined;
  const parse = (part: string) => (part === "" ? [] : part.split(":").map((g) => Number.parseInt(g, 16)));
  const head = parse(halves[0] ?? "");
  const tail = halves.length === 2 ? parse(halves[1] ?? "") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 && missing !== 0) return undefined;
  if (missing < 0) return undefined;
  const groups = [...head, ...new Array<number>(halves.length === 2 ? missing : 0).fill(0), ...tail];
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : undefined;
}

/** DOCKER_SOCKET wins; otherwise a unix:// DOCKER_HOST (Colima, rootless Docker); otherwise dockerode's default. */
export function resolveDockerSocket(env: Record<string, string | undefined>): string | undefined {
  const explicit = env.DOCKER_SOCKET?.trim();
  if (explicit) return explicit;
  const host = env.DOCKER_HOST?.trim();
  if (host?.startsWith("unix://")) return host.slice("unix://".length);
  return undefined;
}

function parseBytes(raw: string | undefined, fallback: number, allowZero = false): number | undefined {
  if (raw === undefined || raw.trim() === "") return Number.isFinite(fallback) ? Math.floor(fallback) : undefined;
  if (!/^\d{1,16}$/.test(raw.trim())) return undefined;
  const value = Number.parseInt(raw.trim(), 10);
  return value > 0 || (allowZero && value === 0) ? value : undefined;
}

function parseMs(raw: string | undefined, fallback: number): number | undefined {
  if (raw === undefined || raw.trim() === "") return fallback;
  if (!/^\d{1,12}$/.test(raw.trim())) return undefined;
  const value = Number.parseInt(raw.trim(), 10);
  return value > 0 ? value : undefined;
}
