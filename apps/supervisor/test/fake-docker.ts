/**
 * A fake DockerApi for tests: records every call in order, keeps containers/volumes in memory,
 * reports an inspect detail that mirrors the create spec (so hardening checks pass unless a test
 * tampers with it), and answers execs from a scripted handler that emits multiplexed frames.
 */
import { Readable } from "node:stream";
import type { ContainerCreateSpec, ContainerDetail, DockerApi, ExecSession, ExecSpec } from "../src/docker-api";
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

export function defaultHandler(overrides: Partial<Record<"uname" | "hostname" | "probe" | "materialize" | "collector" | "adapter" | "author" | "head", ScriptedExec>> = {}): ExecHandler {
  return (_container, spec) => {
    const cmd = spec.cmd.join(" ");
    if (cmd.includes("/bin/uname")) return overrides.uname ?? { stdout: "Linux fake 6.1.0 #1 SMP x86_64 GNU/Linux\n" };
    if (cmd.includes("/bin/hostname")) return overrides.hostname ?? { stdout: "sandbox\n" };
    if (cmd.includes("probe.sh")) return overrides.probe ?? { stdout: `${PROBE_OK}\n` };
    if (cmd.includes("materialize.py")) return overrides.materialize ?? { stdout: '{"materialized": 10, "replaced": []}\n' };
    if (cmd.includes("collector.py")) return overrides.collector ?? { stdout: JSON.stringify({ schemaVersion: 1, files: [], rejected: [] }) };
    if (cmd.includes("adapter.py")) return overrides.adapter ?? { stdout: "" };
    if (cmd.includes("/usr/bin/head")) return overrides.head ?? { stdout: "file contents" };
    return overrides.author ?? { stdout: "1\n" };
  };
}

export class FakeDocker implements DockerApi {
  readonly calls: string[] = [];
  readonly containers = new Map<string, { spec: ContainerCreateSpec; running: boolean }>();
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
    this.containers.set(spec.name, { spec, running: false });
  }
  async startContainer(name: string) {
    this.record(`startContainer ${name}`);
    const c = this.containers.get(name);
    if (!c) throw Object.assign(new Error("no such container"), { statusCode: 404 });
    c.running = true;
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
  async removeContainer(name: string, force: boolean) {
    this.record(`removeContainer ${name} force=${force}`);
    this.containers.delete(name);
  }
  async inspectContainer(name: string): Promise<ContainerDetail | null> {
    this.record(`inspectContainer ${name}`);
    const c = this.containers.get(name);
    if (!c) return null;
    const s = c.spec;
    const detail: ContainerDetail = {
      id: `id-${name}`,
      name,
      image: `sha256:${"0".repeat(64)}`,
      state: { status: c.running ? "running" : "exited", running: c.running, exitCode: 0, oomKilled: false, startedAt: "", finishedAt: "" },
      config: {
        user: s.user,
        workingDir: s.workingDir,
        env: [...s.env, "PATH=/usr/local/bin:/usr/bin:/bin", "PYTHON_VERSION=3.12.0"],
        entrypoint: s.entrypoint,
        cmd: s.cmd,
        labels: s.labels,
        image: s.image,
        exposedPorts: {},
      },
      hostConfig: {
        Runtime: s.hostConfig.runtime,
        NetworkMode: s.hostConfig.networkMode,
        ReadonlyRootfs: true,
        CapDrop: ["ALL"],
        CapAdd: null,
        SecurityOpt: ["no-new-privileges"],
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
      },
      mounts: s.hostConfig.mounts.map((m) => ({ type: "volume", name: m.source, source: "", destination: m.target, rw: !m.readOnly })),
      networks: { none: {} },
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
