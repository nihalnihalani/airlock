/**
 * Docker adapter and container hardening.
 *
 * Hardening flags and the fail-closed effective-configuration inspection are adapted from OpenMuse
 * `apps/server/src/computer.ts` (pin 205cc386b75aae1a862f3fdd43104b570c8d0911):
 *
 *   MIT License, Copyright (c) 2026 OpenMuse contributors. Permission is hereby granted, free of
 *   charge, to any person obtaining a copy of this software and associated documentation files (the
 *   "Software"), to deal in the Software without restriction ... THE SOFTWARE IS PROVIDED "AS IS",
 *   WITHOUT WARRANTY OF ANY KIND.
 *
 * The narrow dockerode verbs (labels, ownership at every inspect, tolerated 304/404/409 codes) are
 * adapted from OpenBot `supervisor/src/docker.ts` (pin 3c73cf00efba46122dfd0447485e2b61f1d6a2cd,
 * MIT, Copyright (c) 2026 CopilotKit).
 *
 * Airlock modifications: dockerode instead of the docker CLI; per-attempt disposable identity instead
 * of a per-owner persistent computer; explicit runtime selection with inspection of the effective
 * runtime; guest uname/hostname read from inside; image digest recorded; caps come from the profile.
 */
import Docker from "dockerode";
import { connect as netConnect } from "node:net";
import { PassThrough } from "node:stream";
import type { Caps, RuntimeInspection, RuntimeName } from "@airlock/contracts";
import type {
  ContainerCreateSpec,
  ContainerDetail,
  DockerApi,
  ExecSession,
  ExecSpec,
  NetworkDetail,
  VolumeDetail,
} from "./docker-api";
import { runtimeTierOfName } from "./config";
import { SupervisorError, describe, dockerUnavailable, statusOf } from "./errors";
import { log } from "./log";
import { Demuxer, SANDBOX_USER, runExec, timedCommand } from "./exec";
import { ours } from "./names";

export const TMPFS_TMP = "rw,nosuid,nodev,noexec,size=67108864,mode=1777";

/**
 * The per-attempt workspace is a `local` volume backed by a size-capped tmpfs, so a sandbox can never
 * write more than `caps.workspaceBytes` and never touches host disk (writes beyond the cap fail with
 * ENOSPC inside the sandbox; the pages are charged to the sandbox's memory cgroup). The contents live
 * only while some container holds the mount, which is why freeze provisions the collector before it
 * stops the author container.
 */
export function workspaceDriverOpts(sizeBytes: number): Record<string, string> {
  if (!Number.isInteger(sizeBytes) || sizeBytes <= 0) throw new SupervisorError("internal", `workspace size ${sizeBytes} is not a positive integer.`);
  return { type: "tmpfs", device: "tmpfs", o: `size=${sizeBytes},uid=1000,gid=1000,mode=0755` };
}

/** The effective-config check for a workspace volume: local driver and exactly the bounded tmpfs options. */
export function workspaceVolumeBounded(detail: VolumeDetail, sizeBytes: number): boolean {
  const expected = workspaceDriverOpts(sizeBytes);
  const options = detail.options;
  return (
    detail.driver === "local" &&
    Object.keys(options).length === Object.keys(expected).length &&
    Object.entries(expected).every(([k, v]) => options[k] === v)
  );
}
export const SANDBOX_ENV = ["HOME=/workspace", "LANG=C.UTF-8"];
const ENV_ALLOWED_PREFIXES = ["PATH=", "HOME=", "LANG=", "LC_", "PYTHON", "PIP_", "GPG_KEY=", "AIRLOCK_", "TZ="];

// ---------------------------------------------------------------------------------------------
// Create spec
// ---------------------------------------------------------------------------------------------

export interface SandboxSpec {
  name: string;
  image: string;
  labels: Record<string, string>;
  caps: Caps;
  dockerRuntime: string;
  mount: { volume: string; target: "/workspace" | "/candidate"; readOnly: boolean };
  workingDir: "/workspace" | "/";
  /**
   * Code runtimes (analysis/node) bring their own image and therefore their own pin: when present,
   * `imagePin.imageId` replaces the repository runtime pin (AIRLOCK_RUNTIME_IMAGE_ID) at inspection.
   * `imageId` undefined = no pin (dev-unsafe only; config refuses it otherwise).
   */
  imagePin?: { imageId: string | undefined };
  /** The fixed readiness exec for this image (default READINESS_ARGV: python3 -I -S). */
  readinessArgv?: string[];
  /** Env prefixes the image itself is known to set, on top of ENV_ALLOWED_PREFIXES. */
  extraEnvPrefixes?: string[];
}

export function sandboxCreateSpec(spec: SandboxSpec): ContainerCreateSpec {
  return {
    name: spec.name,
    image: spec.image,
    labels: spec.labels,
    env: SANDBOX_ENV,
    user: SANDBOX_USER,
    workingDir: spec.workingDir,
    entrypoint: ["/usr/bin/sleep"],
    cmd: ["infinity"],
    hostname: "sandbox",
    hostConfig: {
      runtime: spec.dockerRuntime,
      networkMode: "none",
      readonlyRootfs: true,
      capDrop: ["ALL"],
      securityOpt: ["no-new-privileges"],
      pidsLimit: spec.caps.pidsLimit,
      memory: spec.caps.memoryBytes,
      memorySwap: spec.caps.memoryBytes,
      nanoCpus: Math.round(spec.caps.cpus * 1_000_000_000),
      ipcMode: "private",
      restartPolicy: { Name: "no" },
      tmpfs: { "/tmp": TMPFS_TMP },
      mounts: [{ type: "volume", source: spec.mount.volume, target: spec.mount.target, readOnly: spec.mount.readOnly }],
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Effective-config inspection (fail closed)
// ---------------------------------------------------------------------------------------------

export interface ExpectedSandbox extends SandboxSpec {
  /** What Docker calls its default runtime; an empty HostConfig.Runtime means this one. */
  defaultRuntime: string;
}

export interface EffectiveCheck {
  checks: RuntimeInspection["checks"];
  runtimeMatches: boolean;
  identityMatches: boolean;
  allPassed: boolean;
  failures: string[];
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : Number.NaN;
}
function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function checkEffective(detail: ContainerDetail, expected: ExpectedSandbox, namespace: string): EffectiveCheck {
  const h = detail.hostConfig;
  const c = detail.config;
  const failures: string[] = [];
  const check = (name: string, ok: boolean): boolean => {
    if (!ok) failures.push(name);
    return ok;
  };

  const networks = Object.keys(detail.networks);
  const securityOpt = list(h.SecurityOpt).map(String);
  const entrypoint = Array.isArray(c.entrypoint) ? c.entrypoint : typeof c.entrypoint === "string" ? [c.entrypoint] : [];
  const mount = detail.mounts[0];

  const checks: RuntimeInspection["checks"] = {
    networkNone: check("networkNone", h.NetworkMode === "none" && networks.every((n) => n === "none")),
    nonRootUser: check("nonRootUser", c.user === SANDBOX_USER),
    readOnlyRootfs: check("readOnlyRootfs", h.ReadonlyRootfs === true),
    capDropAll: check("capDropAll", list(h.CapDrop).includes("ALL") && list(h.CapAdd).length === 0 && h.Privileged !== true),
    noNewPrivileges: check(
      "noNewPrivileges",
      securityOpt.length === 1 && (securityOpt[0] === "no-new-privileges" || securityOpt[0] === "no-new-privileges:true"),
    ),
    pidsLimited: check("pidsLimited", num(h.PidsLimit) > 0 && num(h.PidsLimit) <= expected.caps.pidsLimit),
    memoryLimited: check(
      "memoryLimited",
      num(h.Memory) > 0 && num(h.Memory) <= expected.caps.memoryBytes && num(h.MemorySwap) === num(h.Memory),
    ),
    cpuLimited: check("cpuLimited", num(h.NanoCpus) > 0 && num(h.NanoCpus) <= expected.caps.cpus * 1_000_000_000),
    noHostBinds: check(
      "noHostBinds",
      list(h.Binds).length === 0 &&
        list(h.Devices).length === 0 &&
        list(h.DeviceRequests).length === 0 &&
        (h.PidMode === "" || h.PidMode === undefined) &&
        (h.UsernsMode === "" || h.UsernsMode === undefined) &&
        detail.mounts.length === 1 &&
        mount !== undefined &&
        mount.type === "volume" &&
        mount.name === expected.mount.volume &&
        mount.destination === expected.mount.target &&
        mount.rw === !expected.mount.readOnly,
    ),
    noPorts: check(
      "noPorts",
      Object.keys(record(h.PortBindings)).length === 0 &&
        Object.keys(c.exposedPorts ?? {}).length === 0 &&
        h.PublishAllPorts !== true,
    ),
    privateIpc: check("privateIpc", h.IpcMode === "private"),
    restartDisabled: check("restartDisabled", record(h.RestartPolicy).Name === "no"),
    ownedLabels: check(
      "ownedLabels",
      ours(namespace, c.labels) && Object.entries(expected.labels).every(([k, v]) => c.labels[k] === v),
    ),
  };

  const effectiveRuntime = typeof h.Runtime === "string" ? h.Runtime : "";
  const runtimeMatches = check(
    "runtime",
    effectiveRuntime === expected.dockerRuntime || (effectiveRuntime === "" && expected.defaultRuntime === expected.dockerRuntime),
  );
  const tmpfs = record(h.Tmpfs);
  const identityMatches =
    check("name", detail.name === expected.name) &&
    check("image", c.image === expected.image) &&
    check("workingDir", c.workingDir === expected.workingDir) &&
    check("entrypoint", JSON.stringify(entrypoint) === JSON.stringify(["/usr/bin/sleep"]) && JSON.stringify(c.cmd ?? []) === JSON.stringify(["infinity"])) &&
    check("tmpfs", Object.keys(tmpfs).length === 1 && tmpfs["/tmp"] === TMPFS_TMP) &&
    check(
      "env",
      c.env.every((entry) => [...ENV_ALLOWED_PREFIXES, ...(expected.extraEnvPrefixes ?? [])].some((prefix) => entry.startsWith(prefix))),
    );

  const allPassed = Object.values(checks).every(Boolean) && runtimeMatches && identityMatches;
  return { checks, runtimeMatches, identityMatches, allPassed, failures };
}

/**
 * Docker's effective runtime string → contract RuntimeName. The name is classified BEFORE the
 * configured tier is consulted, so a container that actually runs on `runc` is recorded as `runc`
 * (and therefore dev-unsafe) even when the configuration claims kata or gVisor (CLAUDE.md §3.8).
 * Only a name that says nothing about its tier is taken as the configured one, and only when it is
 * exactly the docker name this supervisor was configured to create containers with.
 */
export function runtimeNameOf(effective: string, configured: RuntimeName, dockerRuntime: string, defaultRuntime: string): RuntimeName {
  const name = effective === "" ? defaultRuntime : effective;
  const byName = runtimeTierOfName(name);
  if (byName !== undefined) return byName;
  if (name === dockerRuntime) return configured;
  return "runc";
}

export interface InspectContext {
  namespace: string;
  configuredRuntime: RuntimeName;
  devUnsafe: boolean;
  defaultRuntime: string;
  /** The pinned `sha256:` image ID (AIRLOCK_RUNTIME_IMAGE_ID). Absent only in dev-unsafe. */
  runtimeImageId?: string | undefined;
}

/**
 * The fixed readiness exec (M12): the runner's interpreter starts, isolated (-I -S), as the sandbox
 * user, and prints `ready`. Bounded to 4 s inside the container and 5 s at the supervisor. Anything
 * else (timeout, other output, a non-zero exit) fails the inspection closed before any dispatch.
 */
export const READINESS_ARGV = ["/usr/local/bin/python3", "-I", "-S", "-c", "import sys; sys.stdout.write('ready\\n')"];

/** The node image's readiness exec: the interpreter starts with an empty environment and prints `ready`. */
export const NODE_READINESS_ARGV = ["/usr/bin/env", "-i", "/usr/local/bin/node", "-e", "process.stdout.write('ready\\n')"];

export async function runnerReady(api: DockerApi, container: string, workingDir: string, argv: string[] = READINESS_ARGV): Promise<boolean> {
  const outcome = await runExec(api, container, { cmd: timedCommand(argv, 4), user: SANDBOX_USER, workingDir }, { timeoutMs: 5_000, outputBytes: 64 });
  return outcome.result.status === "succeeded" && outcome.result.exitCode === 0 && outcome.result.stdout === "ready\n" && !outcome.controlLost;
}

/**
 * Inspect the EFFECTIVE configuration of a container this supervisor created and fail closed.
 * When the container is running, also read `uname -a` and `hostname` from inside (checkpoint 3).
 * `previousGuest` lets a stopped re-inspection keep the values read while it ran.
 */
export async function inspectSandbox(
  api: DockerApi,
  expected: ExpectedSandbox,
  context: InspectContext,
  options: { requireRunning: boolean; previousGuest?: { uname: string; hostname: string } },
): Promise<{ inspection: RuntimeInspection; detail: ContainerDetail }> {
  const detail = await api.inspectContainer(expected.name);
  if (!detail) throw new SupervisorError("inspection_failed", `Container ${expected.name} does not exist; refusing to dispatch.`);
  if (!ours(context.namespace, detail.config.labels)) {
    throw new SupervisorError("inspection_failed", `Container ${expected.name} is not owned by this supervisor; refusing to dispatch.`);
  }
  const effective = checkEffective(detail, expected, context.namespace);
  // D2: the container's effective image ID must be the pinned runtime image. A retagged tag (same
  // name, other bytes) produces a different ID and fails closed here, on every inspection.
  const pinned = expected.imagePin ? expected.imagePin.imageId : context.runtimeImageId;
  if (pinned !== undefined && detail.image !== pinned) {
    effective.failures.push("imageId");
    effective.identityMatches = false;
    effective.allPassed = false;
  }
  const image = await api.inspectImage(detail.image);
  const imageDigest = image ? (image.repoDigests[0] ?? image.id) : detail.image;
  const effectiveRuntime = typeof detail.hostConfig.Runtime === "string" ? detail.hostConfig.Runtime : "";
  const runtime = runtimeNameOf(effectiveRuntime, context.configuredRuntime, expected.dockerRuntime, context.defaultRuntime);

  let guestUname = options.previousGuest?.uname ?? "";
  let guestHostname = options.previousGuest?.hostname ?? "";
  if (detail.state.running && effective.allPassed && !(await runnerReady(api, expected.name, expected.workingDir, expected.readinessArgv))) {
    effective.failures.push("readiness");
    effective.allPassed = false;
  }
  if (detail.state.running && effective.allPassed) {
    const uname = await runExec(api, expected.name, { cmd: timedCommand(["/bin/uname", "-a"], 5), user: SANDBOX_USER, workingDir: expected.workingDir }, { timeoutMs: 10_000, outputBytes: 512 });
    const host = await runExec(api, expected.name, { cmd: timedCommand(["/bin/hostname"], 5), user: SANDBOX_USER, workingDir: expected.workingDir }, { timeoutMs: 10_000, outputBytes: 128 });
    if (uname.result.status !== "succeeded" || host.result.status !== "succeeded") {
      effective.failures.push("guestIdentity");
      effective.allPassed = false;
    } else {
      guestUname = uname.result.stdout.trim().slice(0, 512);
      guestHostname = host.result.stdout.trim().slice(0, 128);
    }
  } else if (options.requireRunning && !detail.state.running) {
    effective.failures.push("running");
    effective.allPassed = false;
  }

  const inspection: RuntimeInspection = {
    inspectedAt: new Date().toISOString(),
    container: expected.name,
    runtime,
    devUnsafe: context.devUnsafe || runtime === "runc",
    imageDigest,
    // The effective local image ID, always recorded (the control plane compares it with
    // HostCheck.runtimeImageId for preview/export drift).
    ...(/^sha256:[a-f0-9]{64}$/.test(detail.image) ? { imageId: detail.image } : {}),
    guestUname,
    guestHostname,
    checks: effective.checks,
    allPassed: effective.allPassed,
  };
  if (!effective.allPassed) {
    throw new InspectionFailed(inspection, effective.failures);
  }
  return { inspection, detail };
}

export class InspectionFailed extends SupervisorError {
  constructor(readonly inspection: RuntimeInspection, readonly failures: string[]) {
    super("inspection_failed", `Sandbox isolation inspection failed (${failures.join(", ")}); refusing to dispatch.`);
  }
}

// ---------------------------------------------------------------------------------------------
// dockerode adapter
// ---------------------------------------------------------------------------------------------

export function createDockerode(socketPath: string | undefined): DockerApi {
  return traceDockerApi(createRawDockerode(socketPath));
}

/** Debug line per Docker verb: names, duration, a bounded summary of the result, never image bytes or stream content. */
export function traceDockerApi(api: DockerApi): DockerApi {
  const fields: { [K in keyof DockerApi]: (args: Parameters<DockerApi[K]>) => Record<string, unknown> } = {
    ping: () => ({}),
    version: () => ({}),
    info: () => ({}),
    inspectImage: ([ref]) => ({ image: ref }),
    createVolume: ([name, , driverOpts]) => ({ volume: name, driverOpts }),
    inspectVolume: ([name]) => ({ volume: name }),
    removeVolume: ([name]) => ({ volume: name }),
    listVolumes: ([filters]) => ({ filters }),
    createContainer: ([spec]) => ({ container: spec.name, image: spec.image, runtime: spec.hostConfig.runtime, network: spec.hostConfig.networkMode, user: spec.user }),
    startContainer: ([name]) => ({ container: name }),
    stopContainer: ([name, timeoutSeconds]) => ({ container: name, timeoutSeconds }),
    removeContainer: ([name, force]) => ({ container: name, force }),
    inspectContainer: ([name]) => ({ container: name }),
    listContainers: ([filters]) => ({ filters }),
    putArchive: ([name, tar, path]) => ({ container: name, bytes: tar.byteLength, path }),
    exec: ([name, spec]) => ({ container: name, user: spec.user, workingDir: spec.workingDir, argv: spec.cmd.map((a) => a.slice(0, 200)).slice(0, 12), stdinBytes: spec.stdin?.byteLength ?? 0 }),
    createNetwork: ([spec]) => ({ network: spec.name, internal: spec.internal, options: spec.options }),
    inspectNetwork: ([name]) => ({ network: name }),
    removeNetwork: ([name]) => ({ network: name }),
    listNetworks: ([filters]) => ({ filters }),
    connectNetwork: ([network, container]) => ({ network, container }),
    containerLogs: ([name, options]) => ({ container: name, ...options }),
  };
  const summary: Partial<{ [K in keyof DockerApi]: (result: Awaited<ReturnType<DockerApi[K]>>) => Record<string, unknown> }> = {
    ping: (ok) => ({ ok }),
    version: (v) => ({ version: v }),
    info: (i) => ({ runtimes: i.runtimes, defaultRuntime: i.defaultRuntime }),
    inspectImage: (i) => ({ found: i !== null, ...(i ? { id: i.id, repoDigests: i.repoDigests } : {}) }),
    inspectVolume: (v) => ({ found: v !== null }),
    listVolumes: (v) => ({ count: v.length, names: v.map((x) => x.name).slice(0, 20) }),
    inspectContainer: (c) => ({ found: c !== null, ...(c ? { running: c.state.running, status: c.state.status, exitCode: c.state.exitCode } : {}) }),
    listContainers: (c) => ({ count: c.length, names: c.map((x) => x.name).slice(0, 20) }),
    inspectNetwork: (n) => ({ found: n !== null, ...(n ? { internal: n.internal, containers: n.containers } : {}) }),
    listNetworks: (n) => ({ count: n.length, names: n.map((x) => x.name).slice(0, 20) }),
    containerLogs: (text) => ({ chars: text?.length ?? null }),
  };
  const traced = {} as DockerApi;
  for (const key of Object.keys(fields) as (keyof DockerApi)[]) {
    const original = api[key] as (...args: unknown[]) => Promise<unknown>;
    (traced as unknown as Record<string, unknown>)[key] = async (...args: unknown[]) => {
      const startedAt = Date.now();
      const named = (fields[key] as (a: unknown[]) => Record<string, unknown>)(args);
      try {
        const result = await original.apply(api, args);
        const extra = (summary[key] as ((r: unknown) => Record<string, unknown>) | undefined)?.(result) ?? {};
        log.debug(`docker ${key}`, { ...named, durationMs: Date.now() - startedAt, ...extra });
        return result;
      } catch (error) {
        log.debug(`docker ${key} failed`, { ...named, durationMs: Date.now() - startedAt, error });
        throw error;
      }
    };
  }
  return traced;
}

function createRawDockerode(socketPath: string | undefined): DockerApi {
  const docker = new Docker(socketPath ? { socketPath } : undefined);
  const enginePath = socketPath ?? "/var/run/docker.sock";

  const wrap = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (error) {
      throw dockerUnavailable(error);
    }
  };

  return {
    async ping() {
      try {
        await docker.ping();
        return true;
      } catch {
        return false;
      }
    },
    version: () => wrap(async () => (await docker.version()).Version ?? "unknown"),
    info: () =>
      wrap(async () => {
        const info = (await docker.info()) as { Runtimes?: Record<string, unknown>; DefaultRuntime?: string };
        return { runtimes: Object.keys(info.Runtimes ?? {}), defaultRuntime: info.DefaultRuntime ?? "runc" };
      }),
    async inspectImage(ref) {
      try {
        const info = await docker.getImage(ref).inspect();
        return { id: info.Id, repoDigests: info.RepoDigests ?? [] };
      } catch (error) {
        if (statusOf(error) === 404) return null;
        throw dockerUnavailable(error);
      }
    },

    async createVolume(name, labels, driverOpts) {
      try {
        await docker.createVolume({ Name: name, Labels: labels, Driver: "local", DriverOpts: driverOpts });
      } catch (error) {
        if (statusOf(error) === 409) throw new SupervisorError("name_held", `A volume named ${name} already exists; it will not be adopted.`);
        throw dockerUnavailable(error);
      }
      // Docker returns 201 for an existing volume with the same name too: check ownership explicitly.
      const detail = await this.inspectVolume(name);
      if (!detail || Object.entries(labels).some(([k, v]) => detail.labels[k] !== v)) {
        throw new SupervisorError("name_held", `A volume named ${name} exists and does not belong to this attempt; it will not be adopted.`);
      }
      if (detail.driver !== "local" || Object.entries(driverOpts).some(([k, v]) => detail.options[k] !== v)) {
        throw new SupervisorError("name_held", `A volume named ${name} exists with other driver options; it will not be adopted.`);
      }
    },
    async inspectVolume(name): Promise<VolumeDetail | null> {
      try {
        const v = await docker.getVolume(name).inspect();
        return { name: v.Name, labels: v.Labels ?? {}, driver: v.Driver, scope: v.Scope, options: v.Options ?? {} };
      } catch (error) {
        if (statusOf(error) === 404) return null;
        throw dockerUnavailable(error);
      }
    },
    async removeVolume(name) {
      try {
        await docker.getVolume(name).remove({ force: true });
      } catch (error) {
        if (statusOf(error) === 404) return;
        throw dockerUnavailable(error);
      }
    },
    listVolumes: (labelFilters) =>
      wrap(async () => {
        const result = await docker.listVolumes({ filters: { label: labelFilters } });
        return (result.Volumes ?? []).map((v) => ({ name: v.Name, labels: v.Labels ?? {} }));
      }),

    async createContainer(spec) {
      const options: Docker.ContainerCreateOptions = {
        name: spec.name,
        Image: spec.image,
        Labels: spec.labels,
        Env: spec.env,
        User: spec.user,
        WorkingDir: spec.workingDir,
        Entrypoint: spec.entrypoint,
        Cmd: spec.cmd,
        Hostname: spec.hostname,
        HostConfig: {
          Runtime: spec.hostConfig.runtime,
          NetworkMode: spec.hostConfig.networkMode,
          ReadonlyRootfs: spec.hostConfig.readonlyRootfs,
          CapDrop: spec.hostConfig.capDrop,
          SecurityOpt: spec.hostConfig.securityOpt,
          PidsLimit: spec.hostConfig.pidsLimit,
          Memory: spec.hostConfig.memory,
          MemorySwap: spec.hostConfig.memorySwap,
          NanoCpus: spec.hostConfig.nanoCpus,
          IpcMode: spec.hostConfig.ipcMode,
          RestartPolicy: spec.hostConfig.restartPolicy,
          Tmpfs: spec.hostConfig.tmpfs,
          Mounts: spec.hostConfig.mounts.map((m) => ({ Type: "volume", Source: m.source, Target: m.target, ReadOnly: m.readOnly })),
          ...(spec.hostConfig.shmSize !== undefined ? { ShmSize: spec.hostConfig.shmSize } : {}),
        },
      };
      try {
        await docker.createContainer(options);
      } catch (error) {
        if (statusOf(error) === 409) throw new SupervisorError("name_held", `A container named ${spec.name} already exists; it will not be adopted.`);
        if (statusOf(error) === 404) throw new SupervisorError("unsupported_profile", `Runtime image ${spec.image} is not present on this host.`);
        throw dockerUnavailable(error);
      }
    },
    async startContainer(name) {
      try {
        await docker.getContainer(name).start();
      } catch (error) {
        if (statusOf(error) === 304) return;
        throw dockerUnavailable(error);
      }
    },
    async stopContainer(name, timeoutSeconds) {
      try {
        await docker.getContainer(name).stop({ t: timeoutSeconds });
      } catch (error) {
        const status = statusOf(error);
        if (status === 304 || status === 404) return;
        throw dockerUnavailable(error);
      }
    },
    async removeContainer(name, force) {
      try {
        await docker.getContainer(name).remove({ force, v: false });
      } catch (error) {
        if (statusOf(error) === 404) return;
        throw dockerUnavailable(error);
      }
    },
    async inspectContainer(name) {
      let info: Docker.ContainerInspectInfo;
      try {
        info = await docker.getContainer(name).inspect();
      } catch (error) {
        if (statusOf(error) === 404) return null;
        throw dockerUnavailable(error);
      }
      return {
        id: info.Id,
        name: info.Name.replace(/^\//, ""),
        image: info.Image,
        state: {
          status: info.State.Status,
          running: info.State.Running,
          exitCode: info.State.ExitCode,
          oomKilled: info.State.OOMKilled,
          startedAt: info.State.StartedAt,
          finishedAt: info.State.FinishedAt,
          health: (info.State as { Health?: { Status?: string } }).Health?.Status,
        },
        config: {
          user: info.Config.User,
          workingDir: info.Config.WorkingDir,
          env: info.Config.Env ?? [],
          entrypoint: info.Config.Entrypoint,
          cmd: info.Config.Cmd,
          labels: info.Config.Labels ?? {},
          image: info.Config.Image,
          exposedPorts: info.Config.ExposedPorts ?? {},
        },
        hostConfig: (info.HostConfig ?? {}) as Record<string, unknown>,
        mounts: (info.Mounts ?? []).map((m) => ({ type: m.Type, name: m.Name, source: m.Source, destination: m.Destination, rw: m.RW })),
        networks: info.NetworkSettings?.Networks ?? {},
      };
    },
    listContainers: (labelFilters) =>
      wrap(async () => {
        const containers = await docker.listContainers({ all: true, filters: { label: labelFilters } });
        return containers.map((c) => ({ name: (c.Names?.[0] ?? "").replace(/^\//, ""), labels: c.Labels ?? {}, state: c.State }));
      }),
    async putArchive(name, tar, path, signal) {
      try {
        await docker.getContainer(name).putArchive(Buffer.from(tar), { path, noOverwriteDirNonDir: true, ...(signal ? { abortSignal: signal } : {}) });
      } catch (error) {
        const status = statusOf(error);
        if (status === 404) throw new SupervisorError("not_found", `Container ${name} is gone; cannot deliver files.`);
        // Any other 4xx is Docker refusing the upload outright: nothing was written.
        if (status !== undefined && status >= 400 && status < 500) throw new SupervisorError("invalid_body", `Docker refused the upload to ${name} (${status}); nothing was written.`);
        throw dockerUnavailable(error);
      }
    },
    async exec(name, spec: ExecSpec, signal): Promise<ExecSession> {
      const container = docker.getContainer(name);
      const exec = await container.exec({
        Cmd: spec.cmd,
        User: spec.user,
        WorkingDir: spec.workingDir,
        ...(spec.env ? { Env: spec.env } : {}),
        AttachStdout: true,
        AttachStderr: true,
        AttachStdin: spec.stdin !== undefined,
        Tty: false,
        abortSignal: signal,
      });
      if (spec.stdin !== undefined) return startWithStdin(enginePath, exec, spec.stdin, name);
      const stream = await exec.start({ Detach: false, Tty: false, abortSignal: signal });
      return {
        stream: stream as unknown as ExecSession["stream"],
        async exitCode() {
          const deadline = Date.now() + 5_000;
          while (Date.now() < deadline) {
            const info = await exec.inspect();
            if (!info.Running) return typeof info.ExitCode === "number" ? info.ExitCode : null;
            await new Promise((r) => setTimeout(r, 50));
          }
          return null;
        },
        abort() {
          try {
            (stream as unknown as { destroy(): void }).destroy();
          } catch (error) {
            log.warn("exec stream destroy failed", { container: name, error });
          }
        },
      };
    },

    async createNetwork(spec) {
      try {
        await docker.createNetwork({
          Name: spec.name,
          Driver: "bridge",
          Internal: spec.internal,
          EnableIPv6: false,
          Attachable: false,
          Labels: spec.labels,
          Options: spec.options,
          CheckDuplicate: true,
        } as Docker.NetworkCreateOptions);
      } catch (error) {
        if (statusOf(error) === 409) throw new SupervisorError("name_held", `A network named ${spec.name} already exists; it will not be adopted.`);
        throw dockerUnavailable(error);
      }
    },
    async inspectNetwork(name): Promise<NetworkDetail | null> {
      try {
        const n = (await docker.getNetwork(name).inspect()) as {
          Id: string; Name: string; Driver: string; Internal?: boolean; EnableIPv6?: boolean;
          Labels?: Record<string, string> | null; Options?: Record<string, string> | null; Containers?: Record<string, { Name?: string }> | null;
        };
        return {
          id: n.Id,
          name: n.Name,
          driver: n.Driver,
          internal: n.Internal === true,
          enableIPv6: n.EnableIPv6 === true,
          labels: n.Labels ?? {},
          options: n.Options ?? {},
          containers: Object.values(n.Containers ?? {}).map((c) => c.Name ?? "").filter(Boolean).sort(),
        };
      } catch (error) {
        if (statusOf(error) === 404) return null;
        throw dockerUnavailable(error);
      }
    },
    async removeNetwork(name) {
      try {
        await docker.getNetwork(name).remove();
      } catch (error) {
        if (statusOf(error) === 404) return;
        throw dockerUnavailable(error);
      }
    },
    listNetworks: (labelFilters) =>
      wrap(async () => {
        const networks = (await docker.listNetworks({ filters: { label: labelFilters } })) as { Name: string; Labels?: Record<string, string> | null }[];
        return networks.map((n) => ({ name: n.Name, labels: n.Labels ?? {} }));
      }),
    async connectNetwork(network, container) {
      try {
        await docker.getNetwork(network).connect({ Container: container });
      } catch (error) {
        throw dockerUnavailable(error);
      }
    },
    async containerLogs(name, options) {
      let raw: unknown;
      try {
        raw = await docker.getContainer(name).logs({ stdout: true, stderr: false, follow: false, tail: options.tail, timestamps: false });
      } catch (error) {
        if (statusOf(error) === 404) return null;
        throw dockerUnavailable(error);
      }
      const bytes = typeof raw === "string" ? new TextEncoder().encode(raw) : new Uint8Array(raw as Buffer);
      const demuxer = new Demuxer();
      const parts: Uint8Array[] = [];
      let total = 0;
      for (const frame of demuxer.push(bytes)) {
        if (frame.type === 2) continue;
        parts.push(frame.data);
        total += frame.data.length;
      }
      const joined = new Uint8Array(total);
      let offset = 0;
      for (const p of parts) {
        joined.set(p, offset);
        offset += p.length;
      }
      // Keep the newest bytes: the tail is what matters, and the cap bounds memory.
      const kept = joined.length > options.maxBytes ? joined.subarray(joined.length - options.maxBytes) : joined;
      return new TextDecoder("utf-8", { fatal: false }).decode(kept);
    },
  };
}

/**
 * Start an exec whose stdin carries `stdin`, over a raw HTTP/1.1 upgrade on the engine's unix
 * socket (dockerode's hijacked start does not complete under Bun). Stdin is written once and never
 * half-closed; the command reads exactly `stdin.byteLength` bytes (see ExecSpec.stdin). The
 * returned stream carries Docker's multiplexed frames like the non-stdin path.
 */
function startWithStdin(enginePath: string, exec: Docker.Exec, stdin: Uint8Array, container: string): Promise<ExecSession> {
  return new Promise<ExecSession>((resolve, reject) => {
    const body = JSON.stringify({ Detach: false, Tty: false });
    const socket = netConnect({ path: enginePath });
    const stream = new PassThrough();
    let head = Buffer.alloc(0);
    let upgraded = false;
    let settled = false;
    const fail = (error: Error) => {
      if (!settled) {
        settled = true;
        socket.destroy();
        reject(dockerUnavailable(error));
      } else {
        stream.destroy(error);
      }
    };
    socket.setTimeout(15_000, () => {
      if (!upgraded) fail(new Error("exec start did not upgrade within 15 s"));
    });
    socket.once("error", (error) => fail(error));
    socket.once("connect", () => {
      socket.write(
        `POST /exec/${exec.id}/start HTTP/1.1\r\nHost: docker\r\nContent-Type: application/json\r\nConnection: Upgrade\r\nUpgrade: tcp\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
      );
    });
    socket.on("data", (chunk: Buffer) => {
      if (upgraded) {
        stream.write(chunk);
        return;
      }
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end === -1) {
        if (head.length > 16_384) fail(new Error("exec start response head too large"));
        return;
      }
      const statusLine = head.subarray(0, head.indexOf("\r\n")).toString("latin1");
      if (!/^HTTP\/1\.[01] 101 /.test(statusLine)) {
        const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(statusLine)?.[1] ?? "0");
        fail(Object.assign(new Error(`exec start refused: ${statusLine.slice(0, 120)}`), { statusCode: status }));
        return;
      }
      upgraded = true;
      socket.setTimeout(0);
      const rest = head.subarray(end + 4);
      if (rest.length > 0) stream.write(rest);
      socket.write(Buffer.from(stdin));
      settled = true;
      resolve({
        stream,
        async exitCode() {
          const deadline = Date.now() + 5_000;
          while (Date.now() < deadline) {
            const info = await exec.inspect();
            if (!info.Running) return typeof info.ExitCode === "number" ? info.ExitCode : null;
            await new Promise((r) => setTimeout(r, 50));
          }
          return null;
        },
        abort() {
          try {
            socket.destroy();
            stream.destroy();
          } catch (error) {
            log.warn("exec stream destroy failed", { container, error });
          }
        },
      });
    });
    socket.once("end", () => stream.end());
    socket.once("close", () => {
      if (!settled) fail(new Error("engine closed the exec start connection"));
      else if (!stream.writableEnded) stream.end();
    });
  });
}
