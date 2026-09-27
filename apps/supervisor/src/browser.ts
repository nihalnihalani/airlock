/**
 * The browser plane: one Chromium sandbox plus one egress proxy per browser attempt.
 *
 * Topology (research/40 §3, runtime/browser/demo.sh is the reference wiring):
 *
 *   [browser]  --per-attempt --internal network only-->  [egress proxy]  --per-attempt egress network-->  allowlist
 *
 * Nothing here is caller-selectable: images, users, networks, seccomp profile, limits and the proxy
 * address come from supervisor configuration and derived names. A request supplies only the
 * destinations (`egressAllow`, controller policy) and runner operations (contracts `BrowserOp`).
 * The runner's replies are untrusted observations: they are parsed strictly, bounded, and any
 * malformed or oversized reply (or a lost runner) is an interrupted attempt, never a retry.
 */
import { createHash } from "node:crypto";
import {
  type BrowserOp,
  BrowserObserveResult,
  BrowserResponse,
  BrowserScreenshotResult,
  BrowserStatusResult,
  type IsolationProbe,
  type RuntimeInspection,
  type RuntimeName,
} from "@airlock/contracts";
import type { BrowserPlaneConfig } from "./config";
import type { ContainerCreateSpec, ContainerDetail, NetworkDetail } from "./docker-api";
import type { EffectiveCheck } from "./runtime";
import { ours } from "./names";

/** The only `profileId` a browser attempt may name: the browser runtime profile is configuration. */
export const BROWSER_PROFILE_ID = "browser";
/** pwuser in the Playwright image; the runner socket tmpfs is owned by it. */
export const BROWSER_USER = "1001:1001";
/** bun in the egress image. */
export const EGRESS_USER = "1000:1000";
export const EGRESS_PORT = 3128;
export const EGRESS_PORTS_JSON = "[443,80]";
export const BROWSER_ENTRYPOINT = ["node", "/opt/airlock/runner.mjs"];
export const EGRESS_ENTRYPOINT = ["bun", "src/index.ts"];
export const BROWSER_WORKDIR = "/opt/airlock";
export const EGRESS_WORKDIR = "/app";
export const RUNNER_SOCKET_DIR = "/run/airlock";
export const RUNNER_TMPFS = "rw,nosuid,nodev,noexec,size=1048576,mode=0700,uid=1001,gid=1001";
export const CLIENT = "/opt/airlock/client.mjs";
/** How many egress decision lines are kept as evidence (the newest). */
export const EGRESS_DECISIONS_KEPT = 200;

export function browserTmpfs(tmpBytes: number): string {
  return `rw,nosuid,nodev,noexec,size=${tmpBytes},mode=1777`;
}

/** Validate controller-supplied destinations the way the proxy will, so a bad entry is a 400, not a dead proxy. */
export function checkEgressAllow(allow: string[]): string | undefined {
  for (const entry of allow) {
    const host = entry.startsWith(".") ? entry.slice(1) : entry;
    if (host.length === 0 || host.length > 253) return `egressAllow entry ${JSON.stringify(entry)} is empty or too long.`;
    const last = host.slice(host.lastIndexOf(".") + 1);
    if (/^[0-9]+$/.test(last)) return `egressAllow entry ${JSON.stringify(entry)} ends in a numeric label (IP literals and numeric TLDs are refused).`;
    if (entry.startsWith(".") && !host.includes(".")) return `egressAllow suffix ${JSON.stringify(entry)} is too broad (a suffix needs at least two labels).`;
    if (host.split(".").some((label) => label.length > 63)) return `egressAllow entry ${JSON.stringify(entry)} has a label longer than 63 characters.`;
  }
  if (new Set(allow).size !== allow.length) return "egressAllow contains duplicates.";
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Expected containers and networks
// ---------------------------------------------------------------------------------------------

export interface ExpectedContainer {
  kind: "browser" | "egress";
  name: string;
  image: string;
  /** Pinned image ID; absent only in dev-unsafe. */
  imageId: string | undefined;
  labels: Record<string, string>;
  user: string;
  workingDir: string;
  entrypoint: string[];
  /** The exact value of every AIRLOCK_* variable (set by the supervisor or fixed by the image). */
  airlockEnv: Record<string, string>;
  networkMode: string;
  /** Exactly these networks are attached. */
  networks: string[];
  securityOpt: string[];
  tmpfs: Record<string, string>;
  shmSize: number | undefined;
  memoryBytes: number;
  pidsLimit: number;
  cpus: number;
  /** Ports the IMAGE declares (never published). */
  exposedPorts: string[];
  dockerRuntime: string;
  defaultRuntime: string;
}

export interface ExpectedNetwork {
  name: string;
  internal: boolean;
  bridge: string;
  labels: Record<string, string>;
  /** Exactly these containers may be attached (subset while provisioning). */
  containers: string[];
}

export interface BrowserPairNames {
  browser: string;
  egress: string;
  internalNetwork: string;
  egressNetwork: string;
  internalBridge: string;
  egressBridge: string;
}

export function expectedPair(
  names: BrowserPairNames,
  plane: BrowserPlaneConfig,
  labels: { browser: Record<string, string>; egress: Record<string, string>; internal: Record<string, string>; egressNet: Record<string, string> },
  allow: string[],
  runtime: { dockerRuntime: string; defaultRuntime: string },
): { browser: ExpectedContainer; egress: ExpectedContainer; internal: ExpectedNetwork; egressNet: ExpectedNetwork } {
  return {
    egress: {
      kind: "egress",
      name: names.egress,
      image: plane.egressImage,
      imageId: plane.egressImageId,
      labels: labels.egress,
      user: EGRESS_USER,
      workingDir: EGRESS_WORKDIR,
      entrypoint: EGRESS_ENTRYPOINT,
      airlockEnv: {
        AIRLOCK_EGRESS_ALLOW: JSON.stringify(allow),
        AIRLOCK_EGRESS_PORTS: EGRESS_PORTS_JSON,
        AIRLOCK_EGRESS_LISTEN: `0.0.0.0:${EGRESS_PORT}`,
      },
      networkMode: names.egressNetwork,
      networks: [names.egressNetwork, names.internalNetwork].sort(),
      securityOpt: ["no-new-privileges"],
      tmpfs: {},
      shmSize: undefined,
      memoryBytes: plane.egressMemoryBytes,
      pidsLimit: plane.egressPidsLimit,
      cpus: plane.egressCpus,
      exposedPorts: [`${EGRESS_PORT}/tcp`],
      ...runtime,
    },
    browser: {
      kind: "browser",
      name: names.browser,
      image: plane.image,
      imageId: plane.imageId,
      labels: labels.browser,
      user: BROWSER_USER,
      workingDir: BROWSER_WORKDIR,
      entrypoint: BROWSER_ENTRYPOINT,
      airlockEnv: {
        AIRLOCK_PROXY: `http://${names.egress}:${EGRESS_PORT}`,
        AIRLOCK_RUNNER_SOCKET: `${RUNNER_SOCKET_DIR}/runner.sock`,
      },
      networkMode: names.internalNetwork,
      networks: [names.internalNetwork],
      securityOpt: ["no-new-privileges", `seccomp=${plane.seccompJson}`],
      tmpfs: { "/tmp": browserTmpfs(plane.tmpBytes), [RUNNER_SOCKET_DIR]: RUNNER_TMPFS },
      shmSize: plane.shmBytes,
      memoryBytes: plane.memoryBytes,
      pidsLimit: plane.pidsLimit,
      cpus: plane.cpus,
      exposedPorts: [],
      ...runtime,
    },
    internal: { name: names.internalNetwork, internal: true, bridge: names.internalBridge, labels: labels.internal, containers: [names.browser, names.egress].sort() },
    egressNet: { name: names.egressNetwork, internal: false, bridge: names.egressBridge, labels: labels.egressNet, containers: [names.egress] },
  };
}

/** Env as created: only the AIRLOCK_* values the supervisor sets (the image supplies the rest). */
function createEnv(expected: ExpectedContainer): string[] {
  const imageFixed = new Set(["AIRLOCK_RUNNER_SOCKET", "AIRLOCK_EGRESS_LISTEN"]);
  return Object.entries(expected.airlockEnv)
    .filter(([k]) => !imageFixed.has(k))
    .map(([k, v]) => `${k}=${v}`);
}

export function containerCreateSpec(expected: ExpectedContainer): ContainerCreateSpec {
  return {
    name: expected.name,
    image: expected.image,
    labels: expected.labels,
    env: createEnv(expected),
    user: expected.user,
    workingDir: expected.workingDir,
    entrypoint: expected.entrypoint,
    cmd: [],
    hostname: expected.kind === "browser" ? "browser" : "egress",
    hostConfig: {
      runtime: expected.dockerRuntime,
      networkMode: expected.networkMode,
      readonlyRootfs: true,
      capDrop: ["ALL"],
      securityOpt: expected.securityOpt,
      pidsLimit: expected.pidsLimit,
      memory: expected.memoryBytes,
      memorySwap: expected.memoryBytes,
      nanoCpus: Math.round(expected.cpus * 1_000_000_000),
      ipcMode: "private",
      restartPolicy: { Name: "no" },
      tmpfs: expected.tmpfs,
      mounts: [],
      ...(expected.shmSize !== undefined ? { shmSize: expected.shmSize } : {}),
    },
  };
}

export function networkOptions(bridge: string): Record<string, string> {
  return { "com.docker.network.bridge.name": bridge, "com.docker.network.bridge.enable_ip_masquerade": "true" };
}

// ---------------------------------------------------------------------------------------------
// Effective-configuration inspection (fail closed)
// ---------------------------------------------------------------------------------------------

const ENV_PREFIXES = ["PATH=", "LANG=", "LC_ALL=", "HOME=", "PLAYWRIGHT_BROWSERS_PATH=", "NODE_ENV=", "BUN_RUNTIME_TRANSPILER_CACHE_PATH=", "BUN_INSTALL_BIN=", "AIRLOCK_"];

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : Number.NaN;
}
function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
function sameSet(a: string[], b: string[]): boolean {
  const sa = [...new Set(a)].sort();
  const sb = [...new Set(b)].sort();
  return sa.length === a.length && JSON.stringify(sa) === JSON.stringify(sb);
}

/**
 * The browser-plane counterpart of runtime.ts `checkEffective`. `checks.networkNone` is recorded
 * false (true to fact: these containers are on supervisor-created networks); the topology is carried
 * by `checks.networkAsDesigned` (exactly the designed attachments) and by `checkNetwork`.
 */
export function checkPairEffective(detail: ContainerDetail, expected: ExpectedContainer, namespace: string): EffectiveCheck {
  const h = detail.hostConfig;
  const c = detail.config;
  const failures: string[] = [];
  const check = (name: string, ok: boolean): boolean => {
    if (!ok) failures.push(name);
    return ok;
  };
  const securityOpt = list(h.SecurityOpt).map(String).map((o) => (o === "no-new-privileges:true" ? "no-new-privileges" : o));
  const entrypoint = Array.isArray(c.entrypoint) ? c.entrypoint : typeof c.entrypoint === "string" ? [c.entrypoint] : [];
  const exposed = Object.keys(c.exposedPorts ?? {});

  const networkAsDesigned = check("networkAsDesigned", h.NetworkMode === expected.networkMode && sameSet(Object.keys(detail.networks), expected.networks));
  const checks: RuntimeInspection["checks"] = {
    networkNone: false,
    networkAsDesigned,
    nonRootUser: check("nonRootUser", c.user === expected.user && !/^0(:|$)/.test(c.user) && c.user !== "root"),
    readOnlyRootfs: check("readOnlyRootfs", h.ReadonlyRootfs === true),
    capDropAll: check("capDropAll", list(h.CapDrop).includes("ALL") && list(h.CapAdd).length === 0 && h.Privileged !== true),
    noNewPrivileges: check("noNewPrivileges", securityOpt.includes("no-new-privileges")),
    pidsLimited: check("pidsLimited", num(h.PidsLimit) > 0 && num(h.PidsLimit) <= expected.pidsLimit),
    memoryLimited: check("memoryLimited", num(h.Memory) > 0 && num(h.Memory) <= expected.memoryBytes && num(h.MemorySwap) === num(h.Memory)),
    cpuLimited: check("cpuLimited", num(h.NanoCpus) > 0 && num(h.NanoCpus) <= expected.cpus * 1_000_000_000),
    noHostBinds: check(
      "noHostBinds",
      list(h.Binds).length === 0 &&
        list(h.Devices).length === 0 &&
        list(h.DeviceRequests).length === 0 &&
        list(h.VolumesFrom).length === 0 &&
        (h.PidMode === "" || h.PidMode === undefined) &&
        (h.UsernsMode === "" || h.UsernsMode === undefined) &&
        (h.UTSMode === "" || h.UTSMode === undefined) &&
        detail.mounts.length === 0,
    ),
    noPorts: check(
      "noPorts",
      Object.keys(record(h.PortBindings)).length === 0 && h.PublishAllPorts !== true && exposed.every((p) => expected.exposedPorts.includes(p)),
    ),
    privateIpc: check("privateIpc", h.IpcMode === "private"),
    restartDisabled: check("restartDisabled", record(h.RestartPolicy).Name === "no"),
    ownedLabels: check("ownedLabels", ours(namespace, c.labels) && Object.entries(expected.labels).every(([k, v]) => c.labels[k] === v)),
  };

  const effectiveRuntime = typeof h.Runtime === "string" ? h.Runtime : "";
  const runtimeMatches = check(
    "runtime",
    effectiveRuntime === expected.dockerRuntime || (effectiveRuntime === "" && expected.defaultRuntime === expected.dockerRuntime),
  );
  const airlockEntries = c.env.filter((e) => e.startsWith("AIRLOCK_"));
  const tmpfs = record(h.Tmpfs);
  const results = [
    check("securityOpt", sameSet(securityOpt, expected.securityOpt)),
    networkAsDesigned,
    check("dns", list(h.Dns).length === 0 && list(h.DnsSearch).length === 0 && list(h.ExtraHosts).length === 0 && list(h.Links).length === 0),
    check("sysctls", Object.keys(record(h.Sysctls)).length === 0 && h.CgroupnsMode !== "host" && h.OomKillDisable !== true),
    check("name", detail.name === expected.name),
    check("image", c.image === expected.image),
    check("imageId", expected.imageId === undefined || detail.image === expected.imageId),
    check("workingDir", c.workingDir === expected.workingDir),
    check("entrypoint", JSON.stringify(entrypoint) === JSON.stringify(expected.entrypoint) && list(c.cmd).length === 0),
    check("tmpfs", sameSet(Object.keys(tmpfs), Object.keys(expected.tmpfs)) && Object.entries(expected.tmpfs).every(([k, v]) => tmpfs[k] === v)),
    check("shm", expected.shmSize === undefined || num(h.ShmSize) === expected.shmSize),
    check(
      "env",
      c.env.every((e) => ENV_PREFIXES.some((p) => e.startsWith(p))) &&
        airlockEntries.length === Object.keys(expected.airlockEnv).length &&
        Object.entries(expected.airlockEnv).every(([k, v]) => airlockEntries.includes(`${k}=${v}`)),
    ),
  ];
  const identityMatches = results.every(Boolean);
  // networkNone is false by design here; networkAsDesigned carries the topology check instead.
  const allPassed = Object.entries(checks).every(([k, v]) => k === "networkNone" || v) && runtimeMatches && identityMatches;
  return { checks, runtimeMatches, identityMatches, allPassed, failures };
}

/** A per-attempt network is exactly what the supervisor created: bridge, internal flag, no IPv6, fixed bridge name, owned labels, only its containers. */
export function checkNetwork(detail: NetworkDetail | null, expected: ExpectedNetwork, namespace: string, options: { exactContainers: boolean }): string[] {
  if (!detail) return [`${expected.name}:missing`];
  const failures: string[] = [];
  if (detail.name !== expected.name) failures.push(`${expected.name}:name`);
  if (detail.driver !== "bridge") failures.push(`${expected.name}:driver`);
  if (detail.internal !== expected.internal) failures.push(`${expected.name}:internal`);
  if (detail.enableIPv6) failures.push(`${expected.name}:ipv6`);
  if (detail.options["com.docker.network.bridge.name"] !== expected.bridge) failures.push(`${expected.name}:bridgeName`);
  if (!ours(namespace, detail.labels) || Object.entries(expected.labels).some(([k, v]) => detail.labels[k] !== v)) failures.push(`${expected.name}:labels`);
  const attached = detail.containers;
  const okContainers = options.exactContainers ? sameSet(attached, expected.containers) : attached.every((c) => expected.containers.includes(c));
  if (!okContainers) failures.push(`${expected.name}:containers`);
  return failures;
}

export interface PairInspection {
  inspection: RuntimeInspection;
  failures: string[];
}

export function toInspection(
  expected: ExpectedContainer,
  effective: EffectiveCheck,
  detail: ContainerDetail,
  context: { runtime: RuntimeName; devUnsafe: boolean; imageDigest: string; guestUname: string; guestHostname: string },
): RuntimeInspection {
  return {
    inspectedAt: new Date().toISOString(),
    container: expected.name,
    runtime: context.runtime,
    devUnsafe: context.devUnsafe || context.runtime === "runc",
    imageDigest: context.imageDigest,
    ...(/^sha256:[a-f0-9]{64}$/.test(detail.image) ? { imageId: detail.image } : {}),
    guestUname: context.guestUname,
    guestHostname: context.guestHostname,
    checks: effective.checks,
    allPassed: effective.allPassed && detail.name === expected.name,
  };
}

// ---------------------------------------------------------------------------------------------
// Runner dispatch
// ---------------------------------------------------------------------------------------------

/** The per-operation budget (research/40 Stage 1 starting points). */
export function opBudgetMs(op: BrowserOp["op"]): number {
  if (op === "navigate") return 30_000;
  if (op === "screenshot") return 20_000;
  return 15_000;
}

/**
 * Timeouts for one runner call, nested so the innermost fires first: the client's own transport
 * timeout (budget + 5 s, so the runner's internal navigation/action timeouts surface as runner
 * errors, not transport loss), coreutils `timeout` in the container (+8 s), and the supervisor's
 * hard stream deadline (+12 s). Anything past the client timeout is loss of control.
 */
export function opTimeouts(op: BrowserOp["op"]): { clientMs: number; containerSeconds: number; supervisorMs: number } {
  const budget = opBudgetMs(op);
  return { clientMs: budget + 5_000, containerSeconds: Math.ceil((budget + 8_000) / 1000), supervisorMs: budget + 12_000 };
}

/** Response bytes allowed on stdout: the protocol's 4 MiB plus framing margin. */
export const RESPONSE_CAP_BYTES = 4 * 1024 * 1024 + 64 * 1024;

export function runnerRequest(operationId: string, op: BrowserOp): Uint8Array {
  const request: Record<string, unknown> = { schemaVersion: 1, id: operationId, op: op.op };
  if ("args" in op && op.args !== undefined) request.args = op.args;
  return new TextEncoder().encode(JSON.stringify(request));
}

/** `head -c <n> | node client.mjs` under coreutils timeout: stdin is read by length, never closed. */
export function clientArgv(stdinBytes: number, containerSeconds: number): string[] {
  if (!Number.isInteger(stdinBytes) || stdinBytes <= 0) throw new Error("stdin length must be a positive integer");
  return [
    "/usr/bin/timeout",
    "--signal=TERM",
    "--kill-after=2s",
    `${containerSeconds}s`,
    "/bin/sh",
    "-c",
    'head -c "$1" | exec node /opt/airlock/client.mjs',
    "airlock-client",
    String(stdinBytes),
  ];
}

export type ParsedReply =
  | { kind: "completed"; response: BrowserResponse; generation: number | null }
  | { kind: "refused"; response: BrowserResponse }
  | { kind: "interrupted"; response: BrowserResponse | null; reason: string };

/**
 * Classify one client run. Exit 0 with a well-formed reply for this request → completed; exit 2
 * (the client refused the input; the runner never saw it) → refused; anything else — exit 3, a
 * timeout, lost control, oversized or malformed output, a reply for another request, a result that
 * fails its schema, a screenshot whose bytes do not match its digest — is interrupted.
 */
export function classifyReply(
  op: BrowserOp,
  operationId: string,
  outcome: { status: string; exitCode: number | null; stdout: string; truncated: boolean; controlLost: boolean },
): ParsedReply {
  const parsed = parseLine(outcome.stdout);
  if (outcome.controlLost || outcome.status === "timed_out" || outcome.status === "interrupted") {
    return { kind: "interrupted", response: parsed, reason: `runner call ${outcome.status}${outcome.controlLost ? " (control lost)" : ""}` };
  }
  if (outcome.truncated || outcome.stdout.length > RESPONSE_CAP_BYTES) return { kind: "interrupted", response: null, reason: "runner reply exceeded the response cap" };
  if (outcome.exitCode === 3) return { kind: "interrupted", response: parsed, reason: `runner transport failure (${parsed && !parsed.ok ? parsed.error : "exit 3"})` };
  if (outcome.exitCode === 2 && parsed && !parsed.ok) return { kind: "refused", response: parsed };
  if (outcome.exitCode !== 0) return { kind: "interrupted", response: parsed, reason: `client exited ${outcome.exitCode}` };
  if (!parsed) return { kind: "interrupted", response: null, reason: "runner reply is not one BrowserResponse JSON line" };
  if (parsed.id !== operationId || parsed.op !== op.op) return { kind: "interrupted", response: null, reason: "runner reply does not answer this request" };
  if (!parsed.ok) return { kind: "completed", response: parsed, generation: null };
  const problem = validateResult(op.op, parsed.result);
  if (problem) return { kind: "interrupted", response: null, reason: `runner result invalid: ${problem}` };
  const generation = (parsed.result as { generation?: unknown }).generation;
  return { kind: "completed", response: parsed, generation: typeof generation === "number" ? generation : null };
}

function parseLine(stdout: string): BrowserResponse | null {
  const text = stdout.trim();
  if (text.length === 0 || text.includes("\n")) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = BrowserResponse.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

const GENERATION_OPS = new Set(["navigate", "click", "type", "key", "scroll", "tabs.list", "tabs.switch", "tabs.close"]);

export function validateResult(op: string, result: unknown): string | undefined {
  if (op === "status") return issue(BrowserStatusResult.safeParse(result));
  if (op === "observe") return issue(BrowserObserveResult.safeParse(result));
  if (op === "screenshot") {
    const parsed = BrowserScreenshotResult.safeParse(result);
    if (!parsed.success) return issue(parsed);
    const png = Buffer.from(parsed.data.png, "base64");
    if (png.length !== parsed.data.bytes) return "screenshot byte count does not match its data";
    if (!png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "screenshot is not a PNG";
    if (createHash("sha256").update(png).digest("hex") !== parsed.data.sha256) return "screenshot sha256 does not match its bytes";
    return undefined;
  }
  if (GENERATION_OPS.has(op)) {
    const g = (result as { generation?: unknown } | null)?.generation;
    if (typeof result !== "object" || result === null || !Number.isSafeInteger(g) || (g as number) < 0) return "result has no generation";
  }
  return undefined;
}

function issue(result: { success: boolean; error?: { issues: { path: (string | number)[]; message: string }[] } }): string | undefined {
  if (result.success) return undefined;
  const first = result.error?.issues[0];
  return first ? `${first.path.join(".")}: ${first.message}` : "does not match schema";
}

/** The sandbox evidence a browser attempt must show before it is handed out. */
export function sandboxEvidenceFailures(status: BrowserStatusResult, expectedProxy: string): string[] {
  const failures: string[] = [];
  if (status.sandbox.anyNoSandboxFlag) failures.push("anyNoSandboxFlag");
  if (!status.sandbox.zygotePresent) failures.push("zygoteMissing");
  if (!status.sandbox.renderersInNestedPidNamespace) failures.push("renderersNotInNestedPidNamespace");
  if (status.uid === 0) failures.push("runnerIsRoot");
  if (status.proxy !== expectedProxy) failures.push("proxyMismatch");
  return failures;
}

// ---------------------------------------------------------------------------------------------
// Isolation probe (checkpoint 4) for the browser container: a fixed script, run as pwuser.
// ---------------------------------------------------------------------------------------------

/**
 * Direct routes must all fail from the browser container: metadata, external DNS, a direct TCP
 * socket; no Docker socket; no mount outside the expected set. The proxy is the only way out and
 * is exercised separately (status/navigate). Output is one JSON line; parsed by probe.ts rules.
 */
export const BROWSER_PROBE_SCRIPT = String.raw`
const net = require("net"), dns = require("dns"), fs = require("fs");
const out = { metadataEndpoint: "UNKNOWN", dns: "UNKNOWN", outboundTcp: "UNKNOWN", dockerSocket: "UNKNOWN", hostMounts: "UNKNOWN" };
const tcp = (host, port) => new Promise((resolve) => {
  const s = net.connect({ host, port });
  const done = (r) => { s.destroy(); resolve(r); };
  s.setTimeout(2500, () => done("BLOCKED"));
  s.on("connect", () => done("REACHED"));
  s.on("error", () => done("BLOCKED"));
});
const lookup = () => new Promise((resolve) => {
  const t = setTimeout(() => resolve("BLOCKED"), 3000);
  dns.lookup("example.com", { all: true }, (e, a) => { clearTimeout(t); resolve(!e && a && a.length ? "REACHED" : "BLOCKED"); });
});
function mounts() {
  const ok = new Set(["/", "/tmp", "/run/airlock", "/dev/shm", "/etc/hosts", "/etc/hostname", "/etc/resolv.conf"]);
  const tmpfsOnly = new Set(["/tmp", "/run/airlock", "/dev/shm"]);
  for (const line of fs.readFileSync("/proc/self/mountinfo", "utf8").split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split(" - ");
    const point = parts[0].split(" ")[4];
    const type = (parts[1] || "").split(" ")[0];
    const pseudo = /^\/(proc|sys|dev)(\/|$)/.test(point);
    if (!ok.has(point) && !pseudo) return "REACHED";
    if (tmpfsOnly.has(point) && type !== "tmpfs") return "REACHED";
  }
  return "BLOCKED";
}
(async () => {
  out.metadataEndpoint = await tcp("169.254.169.254", 80);
  out.outboundTcp = await tcp("1.1.1.1", 443);
  out.dns = await lookup();
  out.dockerSocket = fs.existsSync("/var/run/docker.sock") || fs.existsSync("/run/docker.sock") ? "REACHED" : "BLOCKED";
  try { out.hostMounts = mounts(); } catch { out.hostMounts = "UNKNOWN"; }
  out.allBlocked = Object.values(out).every((v) => v === "BLOCKED");
  process.stdout.write(JSON.stringify(out) + "\n");
})();
`;

export function browserProbeArgv(): string[] {
  return ["/usr/bin/timeout", "--signal=TERM", "--kill-after=2s", "20s", "node", "-e", BROWSER_PROBE_SCRIPT];
}

export type { IsolationProbe };

// ---------------------------------------------------------------------------------------------
// Egress decisions (the proxy's stdout JSON lines)
// ---------------------------------------------------------------------------------------------

/** contracts EgressDecision: `at`, `host`, `port`, `decision`, `reason`, plus bounded extras. */
export interface EgressDecision {
  at?: string;
  host: string;
  port?: number;
  decision: "allow" | "deny";
  reason: string;
  method?: string;
  status?: number;
  address?: string;
}

export interface EgressEvidence {
  collectedAt: string;
  source: "live" | "recorded";
  allow: string[];
  /** The newest decisions, at most EGRESS_DECISIONS_KEPT. */
  decisions: EgressDecision[];
  /** Counts over the decision lines read (the log tail), not only those kept. */
  summary: { allowed: number; denied: number };
  /** The proxy's own `listening` line, when seen (its parsed allowlist). */
  listening?: { allowExact: string[]; allowSuffixes: string[]; ports: number[] };
}

const str = (v: unknown, max: number): string | undefined => (typeof v === "string" ? v.slice(0, max) : undefined);
const int = (v: unknown): number | undefined => (Number.isInteger(v) ? (v as number) : undefined);

export function parseEgressLog(text: string, allow: string[], source: "live" | "recorded"): EgressEvidence {
  const decisions: EgressDecision[] = [];
  let allowed = 0;
  let denied = 0;
  let listening: EgressEvidence["listening"];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{") || trimmed.length > 8192) continue;
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (raw.event === "listening") {
      const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").map((x) => x.slice(0, 253)).slice(0, 256) : []);
      listening = { allowExact: strings(raw.allowExact), allowSuffixes: strings(raw.allowSuffixes), ports: Array.isArray(raw.ports) ? raw.ports.filter((p): p is number => Number.isInteger(p)).slice(0, 16) : [] };
      continue;
    }
    if (raw.event !== "decision" || (raw.decision !== "allow" && raw.decision !== "deny")) continue;
    if (raw.decision === "allow") allowed += 1;
    else denied += 1;
    const d: EgressDecision = { host: str(raw.host, 253) ?? "", decision: raw.decision, reason: str(raw.reason, 128) ?? "" };
    const at = str(raw.ts, 40);
    const method = str(raw.method, 16);
    const port = int(raw.port);
    const status = int(raw.status);
    const address = str(raw.address, 64);
    if (at !== undefined) d.at = at;
    if (method !== undefined) d.method = method;
    if (port !== undefined) d.port = port;
    if (status !== undefined) d.status = status;
    if (address !== undefined) d.address = address;
    decisions.push(d);
  }
  return {
    collectedAt: new Date().toISOString(),
    source,
    allow,
    decisions: decisions.slice(-EGRESS_DECISIONS_KEPT),
    summary: { allowed, denied },
    ...(listening ? { listening } : {}),
  };
}

/** The proxy parsed exactly the allowlist the supervisor passed. */
export function listeningMatches(listening: EgressEvidence["listening"], allow: string[]): boolean {
  if (!listening) return false;
  const exact = allow.filter((a) => !a.startsWith(".")).sort();
  const suffixes = allow.filter((a) => a.startsWith(".")).sort();
  return (
    JSON.stringify([...listening.allowExact].sort()) === JSON.stringify(exact) &&
    JSON.stringify([...listening.allowSuffixes].sort()) === JSON.stringify(suffixes) &&
    JSON.stringify([...listening.ports].sort((a, b) => a - b)) === JSON.stringify([80, 443])
  );
}
