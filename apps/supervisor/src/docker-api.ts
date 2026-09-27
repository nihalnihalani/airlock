/**
 * The only Docker this service knows how to do.
 *
 * Narrow vocabulary adapted from OpenBot `supervisor/src/docker.ts` (MIT, CopilotKit 2026): there is
 * no passthrough and no generic "run this Docker call". Every verb here is expressed in terms the
 * supervisor derived itself (names, labels, fixed create options). This interface exists so the
 * lifecycle, exec, freeze and invoke logic can be tested against a fake without a daemon.
 */
import type { Readable } from "node:stream";

export interface ContainerCreateSpec {
  name: string;
  image: string;
  labels: Record<string, string>;
  env: string[];
  user: string;
  workingDir: string;
  entrypoint: string[];
  cmd: string[];
  hostname: string;
  hostConfig: {
    runtime: string;
    networkMode: "none";
    readonlyRootfs: true;
    capDrop: ["ALL"];
    securityOpt: ["no-new-privileges"];
    pidsLimit: number;
    memory: number;
    memorySwap: number;
    nanoCpus: number;
    ipcMode: "private";
    restartPolicy: { Name: "no" };
    tmpfs: Record<string, string>;
    mounts: { type: "volume"; source: string; target: string; readOnly: boolean }[];
  };
}

export interface ContainerSummary {
  name: string;
  labels: Record<string, string>;
  state: string;
}

export interface VolumeSummary {
  name: string;
  labels: Record<string, string>;
}

export interface VolumeDetail extends VolumeSummary {
  driver: string;
  scope: string;
  options: Record<string, unknown>;
}

/** The subset of `docker inspect` the hardening checks read. Kept loose; checks validate. */
export interface ContainerDetail {
  id: string;
  name: string;
  image: string;
  state: { status: string; running: boolean; exitCode: number; oomKilled: boolean; startedAt: string; finishedAt: string };
  config: {
    user: string;
    workingDir: string;
    env: string[];
    entrypoint: string[] | string | undefined;
    cmd: string[] | undefined;
    labels: Record<string, string>;
    image: string;
    exposedPorts: Record<string, unknown>;
  };
  hostConfig: Record<string, unknown>;
  mounts: { type: string; name?: string | undefined; source: string; destination: string; rw: boolean }[];
  networks: Record<string, unknown>;
}

export interface ExecSpec {
  cmd: string[];
  user: string;
  workingDir: string;
  env?: string[];
  stdin?: Uint8Array;
}

/** A started exec. `stream` carries Docker's multiplexed frames (8-byte header per chunk). */
export interface ExecSession {
  stream: Readable;
  /** Resolves with the exit code once the process is no longer running; null if unknowable. */
  exitCode(): Promise<number | null>;
  /** Tears down the client side; the process may keep running, which the caller must handle. */
  abort(): void;
}

export interface DockerApi {
  ping(): Promise<boolean>;
  version(): Promise<string>;
  info(): Promise<{ runtimes: string[]; defaultRuntime: string }>;
  inspectImage(ref: string): Promise<{ id: string; repoDigests: string[] } | null>;

  /** Create a `local` volume with exactly these driver options (a size-capped tmpfs); never adopts an existing one. */
  createVolume(name: string, labels: Record<string, string>, driverOpts: Record<string, string>): Promise<void>;
  inspectVolume(name: string): Promise<VolumeDetail | null>;
  removeVolume(name: string): Promise<void>;
  listVolumes(labelFilters: string[]): Promise<VolumeSummary[]>;

  createContainer(spec: ContainerCreateSpec): Promise<void>;
  startContainer(name: string): Promise<void>;
  stopContainer(name: string, timeoutSeconds: number): Promise<void>;
  removeContainer(name: string, force: boolean): Promise<void>;
  inspectContainer(name: string): Promise<ContainerDetail | null>;
  listContainers(labelFilters: string[]): Promise<ContainerSummary[]>;
  /**
   * Upload a tar into the container. Docker accepts archive writes into a stopped container, so an
   * aborted upload's effect is unknown: callers treat an aborted or failed write as lost control.
   */
  putArchive(name: string, tar: Uint8Array, path: string, signal?: AbortSignal): Promise<void>;
  exec(name: string, spec: ExecSpec, signal: AbortSignal): Promise<ExecSession>;
}
