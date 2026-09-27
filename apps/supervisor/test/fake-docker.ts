/**
 * A fake DockerApi for tests: records every call in order, keeps containers/volumes in memory,
 * reports an inspect detail that mirrors the create spec (so hardening checks pass unless a test
 * tampers with it), and answers execs from a scripted handler that emits multiplexed frames.
 */
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import type { ContainerCreateSpec, ContainerDetail, DockerApi, ExecSession, ExecSpec, NetworkCreateSpec, NetworkDetail } from "../src/docker-api";
import { SupervisorError } from "../src/errors";

export interface ScriptedExec {
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  /** Delay before the stream ends. */
  delayMs?: number;
  /** Never end the stream (simulates a hung process). */
  hang?: boolean;
  /** Emit a stream error instead of ending. */
  error?: string;
  /** Send stdout in chunks of this many bytes. */
  chunk?: number;
}

export function frame(type: 1 | 2, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + data.length);
  out[0] = type;
  new DataView(out.buffer).setUint32(4, data.length, false);
  out.set(data, 8);
  return out;
}

export function fakeSession(script: ScriptedExec, signal?: AbortSignal): ExecSession {
  const stream = new Readable({ read() {} });
  const enc = new TextEncoder();
  const chunk = script.chunk ?? 65536;
  const push = (type: 1 | 2, text: string) => {
    const bytes = enc.encode(text);
    for (let i = 0; i < bytes.length; i += chunk) stream.push(frame(type, bytes.subarray(i, Math.min(i + chunk, bytes.length))));
  };
  let ended = false;
  const finish = () => {
    if (ended) return;
    ended = true;
    if (script.error) stream.destroy(new Error(script.error));
    else stream.push(null);
  };
  setTimeout(() => {
    if (script.stdout) push(1, script.stdout);
    if (script.stderr) push(2, script.stderr);
    if (!script.hang) setTimeout(finish, script.delayMs ?? 0);
  }, 0);
  signal?.addEventListener("abort", () => stream.destroy(), { once: true });
  return {
    stream,
    async exitCode() {
      return script.exitCode === undefined ? 0 : script.exitCode;
    },
    abort() {
      stream.destroy();
    },
  };
}

export type ExecHandler = (container: string, spec: ExecSpec) => ScriptedExec;

export const PROBE_OK = JSON.stringify({ metadataEndpoint: "BLOCKED", dns: "BLOCKED", outboundTcp: "BLOCKED", dockerSocket: "BLOCKED", hostMounts: "BLOCKED", allBlocked: true });

export const BROWSER_PROBE_OK = JSON.stringify({ metadataEndpoint: "BLOCKED", dns: "BLOCKED", outboundTcp: "BLOCKED", dockerSocket: "BLOCKED", hostMounts: "BLOCKED", allBlocked: true });

/** A minimal PNG-signed byte string with its digest, for scripted screenshots. */
export function fakePng(): { png: string; bytes: number; sha256: string } {
  const bytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("fake-png-body")]);
  return { png: bytes.toString("base64"), bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}

export type RunnerRequest = { schemaVersion: 1; id: string; op: string; args?: Record<string, unknown> };

/** Scripted runner: answers each op with a well-formed result; state = one generation counter. */
export function fakeRunner(overrides: Partial<Record<string, (req: RunnerRequest, generation: number) => ScriptedExec>> = {}): (req: RunnerRequest) => ScriptedExec {
  let generation = 0;
  const ok = (req: RunnerRequest, result: unknown): ScriptedExec => ({ stdout: `${JSON.stringify({ schemaVersion: 1, id: req.id, op: req.op, ok: true, result })}\n` });
  return (req) => {
    const custom = overrides[req.op];
    if (custom) return custom(req, generation);
    switch (req.op) {
      case "status":
        return ok(req, { ready: true, browserVersion: "fake-chromium", generation, activeTabId: "tab-1", tabCount: 1, uid: 1001, proxy: String(req.args?.proxy ?? PROXY_HINT.value), sandbox: { chromiumProcesses: 5, anyNoSandboxFlag: false, zygotePresent: true, renderersInNestedPidNamespace: true, renderers: 1 } });
      case "navigate":
        generation += 1;
        return ok(req, { generation, tabId: "tab-1", url: String(req.args?.url), status: 200 });
      case "observe":
        generation += 1;
        return ok(req, { generation, tabId: "tab-1", url: "https://example.com/", title: "Example", text: "Example Domain", textTruncated: false, controls: [{ ref: "e1", role: "link", name: "More information" }], controlsTruncated: false, tabs: [{ tabId: "tab-1", url: "https://example.com/", title: "Example", active: true }], events: [], droppedEvents: 0, pendingReview: false });
      case "click": {
        if (req.args?.generation !== generation) return { stdout: `${JSON.stringify({ schemaVersion: 1, id: req.id, op: req.op, ok: false, error: "stale_reference", message: "observe again" })}\n` };
        generation += 1;
        return ok(req, { generation, invalidated: true, url: "https://www.iana.org/" });
      }
      case "screenshot":
        return ok(req, { ...fakePng(), width: 1280, height: 800, url: "https://example.com/", tabId: "tab-1", generation, capturedAt: new Date().toISOString() });
      default:
        return ok(req, { generation, url: "https://example.com/" });
    }
  };
}
/** The proxy URL the scripted status reports (set by FakeDocker from the browser container's env). */
export const PROXY_HINT = { value: "" };

export function defaultHandler(
  overrides: Partial<Record<"uname" | "hostname" | "probe" | "materialize" | "collector" | "outputs" | "adapter" | "author" | "head" | "ready" | "count" | "browserProbe", ScriptedExec>> & { runner?: (req: RunnerRequest) => ScriptedExec } = {},
): ExecHandler {
  const runner = overrides.runner ?? fakeRunner();
  return (_container, spec) => {
    const cmd = spec.cmd.join(" ");
    if (cmd.includes("client.mjs")) {
      const req = JSON.parse(new TextDecoder().decode(spec.stdin ?? new Uint8Array())) as RunnerRequest;
      return runner(req);
    }
    if (cmd.includes("stdout.write('ready")) return overrides.ready ?? { stdout: "ready\n" };
    if (cmd.includes("node -e")) return overrides.browserProbe ?? { stdout: `${BROWSER_PROBE_OK}\n` };
    if (cmd.includes("airlock-blast")) return overrides.count ?? { stdout: "16\n" };
    if (cmd.includes("/bin/uname")) return overrides.uname ?? { stdout: "Linux fake 6.1.0 #1 SMP x86_64 GNU/Linux\n" };
    if (cmd.includes("/bin/hostname")) return overrides.hostname ?? { stdout: "sandbox\n" };
    if (cmd.includes("probe.sh")) return overrides.probe ?? { stdout: `${PROBE_OK}\n` };
    if (cmd.includes("materialize.py")) return overrides.materialize ?? { stdout: '{"materialized": 10, "replaced": []}\n' };
    if (cmd.includes("collector.py")) return overrides.collector ?? { stdout: JSON.stringify({ schemaVersion: 1, files: [], rejected: [] }) };
    if (cmd.includes("collect_outputs.py")) return overrides.outputs ?? { stdout: JSON.stringify({ schemaVersion: 1, files: [], rejected: [] }) };
    if (cmd.includes("adapter.py")) return overrides.adapter ?? { stdout: "" };
    if (cmd.includes("/usr/bin/head")) return overrides.head ?? { stdout: "file contents" };
    return overrides.author ?? { stdout: "1\n" };
  };
}

export class FakeDocker implements DockerApi {
  readonly calls: string[] = [];
  readonly containers = new Map<string, { spec: ContainerCreateSpec; running: boolean; networks: Set<string>; exitCode: number }>();
  readonly networks = new Map<string, { spec: NetworkCreateSpec; containers: Set<string> }>();
  /** Per-container stdout log (the egress proxy's decision lines). */
  readonly logs = new Map<string, string>();
  /** Health reported for a running container; default: browser-plane browsers are healthy, others have none. */
  health: (name: string) => string | undefined = (name) => (name.includes("-browser-") ? "healthy" : undefined);
  /** When set, a started egress container exits at once (simulates config_error). */
  egressFails = false;
  readonly volumes = new Map<string, { labels: Record<string, string>; options: Record<string, string> }>();
  handler: ExecHandler;
  runtimes = ["runc", "io.containerd.runc.v2"];
  defaultRuntime = "runc";
  /** Mutate the detail before it is returned (to make inspection fail in tests). */
  tamper: ((detail: ContainerDetail) => ContainerDetail) | undefined;
  /** Track abort signals handed to exec so tests can assert revocation reached the stream. */
  readonly execSignals: AbortSignal[] = [];

  constructor(handler: ExecHandler = defaultHandler()) {
    this.handler = handler;
  }

  private record(call: string) {
    this.calls.push(call);
  }

  async ping() {
    this.record("ping");
    return true;
  }
  async version() {
    return "fake-1.0";
  }
  async info() {
    return { runtimes: this.runtimes, defaultRuntime: this.defaultRuntime };
  }
  async inspectImage(ref: string) {
    return { id: `sha256:${"0".repeat(64)}`, repoDigests: [`${ref.split(":")[0]}@sha256:${"1".repeat(64)}`] };
  }
  async createVolume(name: string, labels: Record<string, string>, driverOpts: Record<string, string>) {
    this.record(`createVolume ${name} ${Object.entries(driverOpts).map(([k, v]) => `${k}=${v}`).join(",")}`);
    if (this.volumes.has(name)) throw Object.assign(new Error("conflict"), { statusCode: 409 });
    this.volumes.set(name, { labels, options: driverOpts });
  }
  async inspectVolume(name: string) {
    const v = this.volumes.get(name);
    return v ? { name, labels: v.labels, driver: "local", scope: "local", options: v.options } : null;
  }
  async removeVolume(name: string) {
    this.record(`removeVolume ${name}`);
    this.volumes.delete(name);
  }
  async listVolumes(labelFilters: string[]) {
    return [...this.volumes.entries()].filter(([, v]) => matches(v.labels, labelFilters)).map(([name, v]) => ({ name, labels: v.labels }));
  }
  async createContainer(spec: ContainerCreateSpec) {
    this.record(`createContainer ${spec.name}`);
    if (this.containers.has(spec.name)) throw Object.assign(new Error("conflict"), { statusCode: 409 });
    const networks = new Set<string>();
    if (spec.hostConfig.networkMode !== "none") {
      const network = this.networks.get(spec.hostConfig.networkMode);
      if (!network) throw Object.assign(new Error("network not found"), { statusCode: 404 });
      network.containers.add(spec.name);
      networks.add(spec.hostConfig.networkMode);
    }
    this.containers.set(spec.name, { spec, running: false, networks, exitCode: 0 });
  }
  async startContainer(name: string) {
    this.record(`startContainer ${name}`);
    const c = this.containers.get(name);
    if (!c) throw Object.assign(new Error("no such container"), { statusCode: 404 });
    c.running = true;
    const allow = c.spec.env.find((e) => e.startsWith("AIRLOCK_EGRESS_ALLOW="))?.slice("AIRLOCK_EGRESS_ALLOW=".length);
    if (allow !== undefined) {
      if (this.egressFails) {
        c.running = false;
        c.exitCode = 2;
        this.logs.set(name, `${JSON.stringify({ event: "config_error", message: "bad" })}\n`);
        return;
      }
      const entries = JSON.parse(allow) as string[];
      this.logs.set(name, `${JSON.stringify({ ts: new Date().toISOString(), event: "listening", listen: "0.0.0.0:3128", allowExact: entries.filter((e) => !e.startsWith(".")), allowSuffixes: entries.filter((e) => e.startsWith(".")), ports: [443, 80] })}\n`);
    }
    const proxy = c.spec.env.find((e) => e.startsWith("AIRLOCK_PROXY="));
    if (proxy) PROXY_HINT.value = proxy.slice("AIRLOCK_PROXY=".length);
  }
  async createNetwork(spec: NetworkCreateSpec) {
    this.record(`createNetwork ${spec.name} internal=${spec.internal}`);
    if (this.networks.has(spec.name)) throw new SupervisorError("name_held", `A network named ${spec.name} already exists; it will not be adopted.`);
    this.networks.set(spec.name, { spec, containers: new Set() });
  }
  /** Mutate a network detail before it is returned (to make inspection fail in tests). */
  tamperNetwork: ((detail: NetworkDetail) => NetworkDetail) | undefined;
  async inspectNetwork(name: string): Promise<NetworkDetail | null> {
    const n = this.networks.get(name);
    if (!n) return null;
    const detail: NetworkDetail = { id: `net-${name}`, name, driver: "bridge", internal: n.spec.internal, enableIPv6: false, labels: n.spec.labels, options: n.spec.options, containers: [...n.containers].sort() };
    return this.tamperNetwork ? this.tamperNetwork(detail) : detail;
  }
  async removeNetwork(name: string) {
    this.record(`removeNetwork ${name}`);
    const n = this.networks.get(name);
    if (!n) return;
    if (n.containers.size > 0) throw new SupervisorError("docker_unavailable", `network ${name} has active endpoints`);
    this.networks.delete(name);
  }
  async listNetworks(labelFilters: string[]) {
    return [...this.networks.entries()].filter(([, n]) => matches(n.spec.labels, labelFilters)).map(([name, n]) => ({ name, labels: n.spec.labels }));
  }
  async connectNetwork(network: string, container: string) {
    this.record(`connectNetwork ${network} ${container}`);
    const n = this.networks.get(network);
    const c = this.containers.get(container);
    if (!n || !c) throw new SupervisorError("docker_unavailable", "no such network or container");
    n.containers.add(container);
    c.networks.add(network);
  }
  async containerLogs(name: string, options: { tail: number; maxBytes: number }) {
    if (!this.containers.has(name)) return null;
    const lines = (this.logs.get(name) ?? "").split("\n").filter(Boolean).slice(-options.tail);
    const text = lines.map((l) => `${l}\n`).join("");
    return text.length > options.maxBytes ? text.slice(-options.maxBytes) : text;
  }
  /** When set, `stopContainer` throws this for the named container instead of stopping it (Docker API fault). */
  stopError: ((name: string) => Error | undefined) | undefined;
  async stopContainer(name: string, timeoutSeconds: number) {
    const error = this.stopError?.(name);
    this.record(`stopContainer ${name} t=${timeoutSeconds}${error ? " (FAIL)" : ""}`);
    if (error) throw error;
    const c = this.containers.get(name);
    if (c) c.running = false;
  }
  /** When set, `removeContainer` throws this for the named container and leaves it in place. */
  removeError: ((name: string) => Error | undefined) | undefined;
  async removeContainer(name: string, force: boolean) {
    const error = this.removeError?.(name);
    this.record(`removeContainer ${name} force=${force}${error ? " (FAIL)" : ""}`);
    if (error) throw error;
    for (const n of this.networks.values()) n.containers.delete(name);
    this.containers.delete(name);
  }
  async inspectContainer(name: string): Promise<ContainerDetail | null> {
    this.record(`inspectContainer ${name}`);
    const c = this.containers.get(name);
    if (!c) return null;
    const s = c.spec;
    const imageEnv = s.image.includes("browser")
      ? ["PATH=/usr/local/bin:/usr/bin:/bin", "PLAYWRIGHT_BROWSERS_PATH=/ms-playwright", "NODE_ENV=production", "AIRLOCK_RUNNER_SOCKET=/run/airlock/runner.sock"]
      : s.image.includes("egress")
        ? ["PATH=/usr/local/bin:/usr/bin:/bin", "BUN_RUNTIME_TRANSPILER_CACHE_PATH=0", "AIRLOCK_EGRESS_LISTEN=0.0.0.0:3128"]
        : ["PATH=/usr/local/bin:/usr/bin:/bin", "PYTHON_VERSION=3.12.0"];
    const health = c.running ? this.health(name) : undefined;
    const detail: ContainerDetail = {
      id: `id-${name}`,
      name,
      image: `sha256:${"0".repeat(64)}`,
      state: { status: c.running ? "running" : "exited", running: c.running, exitCode: c.exitCode, oomKilled: false, startedAt: "", finishedAt: "", ...(health ? { health } : {}) },
      config: {
        user: s.user,
        workingDir: s.workingDir,
        env: [...s.env, ...imageEnv],
        entrypoint: s.entrypoint,
        cmd: s.cmd,
        labels: s.labels,
        image: s.image,
        exposedPorts: s.image.includes("egress") ? { "3128/tcp": {} } : {},
      },
      hostConfig: {
        Runtime: s.hostConfig.runtime,
        NetworkMode: s.hostConfig.networkMode,
        ReadonlyRootfs: true,
        CapDrop: ["ALL"],
        CapAdd: null,
        SecurityOpt: [...s.hostConfig.securityOpt],
        PidsLimit: s.hostConfig.pidsLimit,
        Memory: s.hostConfig.memory,
        MemorySwap: s.hostConfig.memorySwap,
        NanoCpus: s.hostConfig.nanoCpus,
        IpcMode: "private",
        RestartPolicy: { Name: "no" },
        Tmpfs: s.hostConfig.tmpfs,
        Binds: null,
        Devices: [],
        DeviceRequests: null,
        PidMode: "",
        UsernsMode: "",
        PortBindings: {},
        PublishAllPorts: false,
        Privileged: false,
        ...(s.hostConfig.shmSize !== undefined ? { ShmSize: s.hostConfig.shmSize } : {}),
      },
      mounts: s.hostConfig.mounts.map((m) => ({ type: "volume", name: m.source, source: "", destination: m.target, rw: !m.readOnly })),
      networks: s.hostConfig.networkMode === "none" ? { none: {} } : Object.fromEntries([...c.networks].map((n) => [n, {}])),
    };
    return this.tamper ? this.tamper(detail) : detail;
  }
  async listContainers(labelFilters: string[]) {
    return [...this.containers.entries()]
      .filter(([, c]) => matches(c.spec.labels, labelFilters))
      .map(([name, c]) => ({ name, labels: c.spec.labels, state: c.running ? "running" : "exited" }));
  }
  /**
   * Shape archive uploads: `delayMs` before the write lands; `hang` never lands until the request is
   * aborted (then rejects); `ignoreAbort` keeps hanging even when aborted (an unresponsive daemon).
   * `refuse` answers like the runtime adapter does for a Docker 4xx (nothing written).
   * A landed write is recorded as `putArchive-landed <name>`.
   */
  archive: { delayMs?: number; hang?: boolean; ignoreAbort?: boolean; refuse?: boolean } = {};
  /** Every archive that landed, with its bytes (tests parse the tar headers). */
  readonly archives: { container: string; path: string; tar: Uint8Array }[] = [];
  async putArchive(name: string, tar: Uint8Array, path: string, signal?: AbortSignal) {
    this.record(`putArchive ${name} ${path} ${tar.length}b`);
    // Same contract as the runtime adapter (runtime.ts): 404 → not_found, other 4xx → invalid_body.
    if (!this.containers.has(name)) throw new SupervisorError("not_found", `Container ${name} is gone; cannot deliver files.`);
    if (this.archive.refuse) throw new SupervisorError("invalid_body", `Docker refused the upload to ${name} (400); nothing was written.`);
    const { delayMs = 0, hang = false, ignoreAbort = false } = this.archive;
    if (hang || delayMs > 0) {
      await new Promise<void>((resolve, reject) => {
        if (!hang) setTimeout(resolve, delayMs);
        if (!ignoreAbort) signal?.addEventListener("abort", () => reject(Object.assign(new Error("request aborted"), { name: "AbortError" })), { once: true });
      });
    }
    // Docker accepts archive writes into a stopped container: only a removed one refuses.
    if (!this.containers.has(name)) throw Object.assign(new Error("no such container"), { statusCode: 404 });
    this.record(`putArchive-landed ${name}`);
    this.archives.push({ container: name, path, tar });
  }
  async exec(name: string, spec: ExecSpec, signal: AbortSignal): Promise<ExecSession> {
    this.record(`exec ${name} ${spec.cmd.join(" ")}`);
    const c = this.containers.get(name);
    if (!c) throw Object.assign(new Error("No such container"), { statusCode: 404 });
    if (!c.running) throw Object.assign(new Error("Container is not running"), { statusCode: 409 });
    this.execSignals.push(signal);
    return fakeSession(this.handler(name, spec), signal);
  }
}

function matches(labels: Record<string, string>, filters: string[]): boolean {
  return filters.every((f) => {
    const [k, v] = f.split("=");
    return k !== undefined && labels[k] === v;
  });
}

/** Parse ustar headers written by src/tar.ts: name, mode, uid, gid, type and file bytes. */
export function tarEntries(tar: Uint8Array): { path: string; mode: number; uid: number; gid: number; type: "file" | "dir"; bytes: Uint8Array }[] {
  const out: { path: string; mode: number; uid: number; gid: number; type: "file" | "dir"; bytes: Uint8Array }[] = [];
  const dec = new TextDecoder();
  const str = (a: number, b: number) => dec.decode(tar.subarray(a, b)).replace(/\0.*$/s, "");
  let off = 0;
  while (off + 512 <= tar.length) {
    if (tar.subarray(off, off + 512).every((b) => b === 0)) break;
    const name = str(off, off + 100);
    const prefix = str(off + 345, off + 500);
    const size = Number.parseInt(str(off + 124, off + 136), 8);
    const typeflag = String.fromCharCode(tar[off + 156] ?? 48);
    const full = (prefix ? `${prefix}/${name}` : name).replace(/\/$/, "");
    out.push({ path: full, mode: Number.parseInt(str(off + 100, off + 108), 8), uid: Number.parseInt(str(off + 108, off + 116), 8), gid: Number.parseInt(str(off + 116, off + 124), 8), type: typeflag === "5" ? "dir" : "file", bytes: tar.slice(off + 512, off + 512 + size) });
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}
