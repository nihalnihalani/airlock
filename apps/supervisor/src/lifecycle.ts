/**
 * Attempt lifecycle: create → tools → freeze/revoke → destroy, plus deadlines and the janitor.
 *
 * Ordering rules (research/37 "Cancellation, recovery and identity", CLAUDE.md §3.5):
 *   - record before dispatch: the journal row exists before any Docker side effect;
 *   - freeze: revoke → stop (t=2) → settle outstanding execs and writes → re-inspect stopped →
 *     collect in a fresh container with the volume read-only; an unsettled operation refuses the
 *     freeze (`unknown`, 409) because a late write could still land in the workspace;
 *   - every start/exec re-checks the fence immediately before the side effect;
 *   - lost control over a command stops the whole container (OpenMuse quarantine);
 *   - failed teardown stays visible (`unknown`) and the identity is tombstoned so nothing can
 *     resurrect it;
 *   - restart: every live attempt is revoked, stopped and marked `unknown` (see `reconcile`);
 *   - execution authority ends at min(authorizedUntil, deadline); `renew` moves authorizedUntil
 *     (never past the deadline, never for revoked work) and one timer enforces the earlier of the two;
 *   - host admission: every sandbox reserves its share of the host budget before any Docker call
 *     and releases it only once its container is confirmed removed (capacity.ts).
 */
import type { z } from "zod";
import {
  type AttemptRef,
  BrowserEvidence as BrowserEvidenceSchema,
  type AttemptState,
  type AuthorToolArgs,
  type AuthorToolResult,
  type BrowserOp,
  type BrowserOpResult,
  type BrowserStatusResult,
  type Caps,
  type CollectOutputsResult,
  FileEnvelope,
  type FreezeResult,
  OutputEnvelope as OutputEnvelopeSchema,
  type HostListing,
  type IsolationProbe,
  type Operation,
  type ProfileManifest,
  type RuntimeInspection,
  type SandboxRole,
  type TeardownRecord,
  workspaceBytesOf,
} from "@airlock/contracts";
import { HostCapacity, browserCosts, sandboxCost } from "./capacity";
import type { BrowserPlaneConfig, CodeRole, CodeRuntimeConfig, SupervisorConfig } from "./config";
import {
  CODE_WORKSPACE,
  InputQuota,
  OUTPUTS_COLLECTOR,
  OUTPUTS_COLLECTOR_STDOUT_BYTES,
  type SandboxProfile,
  codePathProblem,
  codeProfile,
  decodeBase64Strict,
  isCodeRole,
  outputsCollectorProfile,
  sha256Hex,
  validateOutputEnvelope,
} from "./code";
import {
  BROWSER_PROFILE_ID,
  BROWSER_USER,
  BROWSER_WORKDIR,
  type EgressEvidence,
  type ExpectedContainer,
  type ParsedReply,
  RESPONSE_CAP_BYTES,
  type RunnerOp,
  browserProbeArgv,
  checkEgressAllow,
  checkNetwork,
  checkPairEffective,
  classifyReply,
  clientArgv,
  containerCreateSpec,
  expectedPair,
  listeningMatches,
  networkOptions,
  opTimeouts,
  parseEgressLog,
  runnerRequest,
  sandboxEvidenceFailures,
  toInspection,
} from "./browser";
import type { CreateAttemptRequest, DestroyResult } from "./types";
import {
  DOWNLOAD_CHUNK_BYTES,
  type DownloadChunkResult,
  type DownloadReadResult,
  MAX_DOWNLOAD_BYTES,
  MAX_UPLOADS,
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_TOTAL_BYTES,
  type SupervisorBrowserOp,
  UPLOAD_CHUNK_BYTES,
  UPLOAD_FINALIZE,
  UPLOAD_FIRST_CHUNK,
  UPLOAD_NEXT_CHUNK,
  chunkProblem,
  sha256Of,
  sniffMediaType,
  uploadIdFor,
} from "./browser-files";
import type { DockerApi } from "./docker-api";
import { SupervisorError, describe } from "./errors";
import { MAX_STDIN_BYTES, SANDBOX_USER, SUPERVISOR_GRACE_MS, authorCommand, runExec, timedCommand } from "./exec";
import type { HostReport } from "./host";
import { type AttemptNames, attemptContainers, attemptLabels, attemptNames, attemptNetworks, ours, ownedFilter, ATTEMPT_LABEL, NETWORK_LABEL, OPERATION_LABEL, OWNER_LABEL, ROLE_LABEL, TASK_LABEL } from "./names";
import { type AttemptRecord, Journal, type OperationBinding, attemptStateOf, authorityEndsAt } from "./operations";
import { createLogger, log, type Logger } from "./log";
import { parseProbeOutput, runProbe } from "./probe";
import { type ExpectedSandbox, InspectionFailed, type SandboxSpec, inspectSandbox, runtimeNameOf, sandboxCreateSpec, workspaceDriverOpts, workspaceVolumeBounded } from "./runtime";
import { ancestorDirs, createTar } from "./tar";

export const MATERIALIZE = "/opt/airlock/materialize.py";
export const COLLECTOR = "/opt/airlock/collector.py";
export const PROFILE_JSON = "/opt/airlock/profile/profile.json";
const STOP_SECONDS = 2;
const SETTLE_MS = 20_000;
/** Bound on one author write; shorter than SETTLE_MS so a slow write resolves before settle gives up. */
const WRITE_TIMEOUT_MS = 10_000;
const MAX_TIMER_MS = 2_147_000_000;

export interface OperationResponse {
  status: number;
  body: unknown;
}

export interface CoreDeps {
  api: DockerApi;
  journal: Journal;
  config: SupervisorConfig;
  profiles: Map<string, ProfileManifest>;
  host: HostReport;
  /** Test seam: a Logger, or a plain sink that receives each finished JSON line. Default: the process logger. */
  log?: Logger | ((line: string) => void);
  /** Test seam: how long freeze waits for outstanding operations (default SETTLE_MS). */
  settleMs?: number;
  /** Test seam: the abort timeout on one author write (default WRITE_TIMEOUT_MS). */
  writeTimeoutMs?: number;
  /** Test seam: browser-plane readiness waits (defaults: health 90 s, proxy 20 s, poll 500 ms). */
  browserWaits?: { healthMs?: number; listeningMs?: number; pollMs?: number };
}

/** What a browser attempt showed before it was handed out (contracts BrowserEvidence). */
export type BrowserEvidence = z.infer<typeof BrowserEvidenceSchema> & { probe: IsolationProbe };

/** A browser provisioning refusal that carries whatever evidence was gathered. */
class BrowserRefused extends SupervisorError {
  constructor(code: "inspection_failed" | "probe_failed" | "internal", message: string, readonly inspection?: RuntimeInspection, readonly probe?: IsolationProbe) {
    super(code, message);
  }
}

export interface ProvisionRequest {
  container: string;
  volume: string;
  labels: Record<string, string>;
  profile: SandboxProfile;
  mount: { target: "/workspace" | "/candidate"; readOnly: boolean };
  workingDir: "/workspace" | "/";
  /** Create the volume (fresh workspace) or reuse an existing one (collector). */
  createVolume: boolean;
}

export interface Provisioned {
  inspection: RuntimeInspection;
  expected: ExpectedSandbox;
  guest: { uname: string; hostname: string };
}

export class Supervisor {
  readonly api: DockerApi;
  readonly journal: Journal;
  readonly config: SupervisorConfig;
  readonly profiles: Map<string, ProfileManifest>;
  readonly host: HostReport;
  readonly capacity: HostCapacity;
  private readonly log: Logger;
  private readonly outstanding = new Map<string, Set<Promise<unknown>>>();
  /** Attempts with a write whose effect is unknown (aborted or failed mid-upload): never collectable. */
  private readonly uncertainWrites = new Set<string>();
  private readonly settleMs: number;
  private readonly writeTimeoutMs: number;
  private readonly locks = new Map<string, Promise<void>>();
  private readonly revokeSignals = new Map<string, AbortController>();
  private readonly deadlineTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** The newest runner generation seen per browser attempt (BrowserOpResult.generationBefore). */
  private readonly browserGenerations = new Map<string, number>();
  private readonly browserWaits: { healthMs: number; listeningMs: number; pollMs: number };
  /** Uploads placed into each browser attempt (count and bytes). */
  private readonly uploadQuota = new Map<string, { count: number; bytes: number }>();
  /** Bytes placed under inputs/ per analysis/node attempt (per-file and per-attempt quotas). */
  private readonly inputQuota = new InputQuota();
  private janitorTimer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;

  constructor(deps: CoreDeps) {
    this.api = deps.api;
    this.journal = deps.journal;
    this.config = deps.config;
    this.profiles = deps.profiles;
    this.host = deps.host;
    this.capacity = new HostCapacity(deps.config.capacity);
    this.settleMs = deps.settleMs ?? SETTLE_MS;
    this.writeTimeoutMs = deps.writeTimeoutMs ?? WRITE_TIMEOUT_MS;
    this.browserWaits = { healthMs: 90_000, listeningMs: 20_000, pollMs: 500, ...deps.browserWaits };
    this.log = typeof deps.log === "function" ? createLogger({ app: "supervisor", level: "debug", write: (line) => (deps.log as (line: string) => void)(line) }) : (deps.log ?? log);
  }

  // -------------------------------------------------------------------------------------------
  // Startup / shutdown
  // -------------------------------------------------------------------------------------------

  async start(): Promise<void> {
    const interrupted = this.journal.interruptPendingOperations();
    if (interrupted > 0) this.log.warn("marked pending operations as interrupted after restart", { interrupted });
    await this.reconcile();
    await this.adoptCapacity();
    await this.janitor();
    this.janitorTimer = setInterval(() => {
      this.janitor().catch((error) => this.log.error("janitor failed", { error }));
    }, this.config.janitorIntervalMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.janitorTimer) clearInterval(this.janitorTimer);
    for (const timer of this.deadlineTimers.values()) clearTimeout(timer);
    this.deadlineTimers.clear();
  }

  /**
   * Journal vs Docker after a restart: a live attempt whose container is gone becomes unknown;
   * revoked or expired ones are stopped; every other live attempt (`created` or `running`) is
   * revoked, stopped and marked `unknown`, never re-armed.
   *
   * Why every live attempt and not only those with an interrupted operation: the operations journal
   * does not bind an operation to an attempt, a `created` attempt never finished its probe, and the
   * in-memory record of outstanding execs and writes died with the process, so no live attempt can
   * be proven idle. The conservative choice matches research/37 "Cancellation, recovery and
   * identity": a crash yields `unknown/interrupted`, and the controller discards an uncertain author
   * workspace and starts an explicit fresh attempt. `unknown` also refuses freeze, so the uncertain
   * workspace is never collected.
   */
  private async reconcile(): Promise<void> {
    const startedAt = Date.now();
    const seen = { attempts: 0, missing: 0, stopped: 0, interrupted: 0 };
    for (const record of this.journal.listAttempts()) {
      if (record.status === "destroyed") continue;
      seen.attempts += 1;
      // A browser attempt owns two containers (browser + egress proxy); both are handled alike.
      const containers = this.containersOf(record);
      const details = await Promise.all(containers.map((c) => this.api.inspectContainer(c)));
      const detail = details[0];
      const anyRunning = details.some((d) => d?.state.running === true);
      if (!detail) {
        this.journal.updateAttempt(record.attemptId, { status: "unknown", revoked: true });
        this.closeDispatch(record.attemptId);
        if (anyRunning) await this.stopAndConfirm(record, "restart");
        this.log.warn("attempt container missing after restart; marked unknown", { attemptId: record.attemptId, container: record.container });
        seen.missing += 1;
        continue;
      }
      if (record.revoked || authorityEndsAt(record) < new Date().toISOString()) {
        for (const [i, d] of details.entries()) if (d?.state.running) await this.api.stopContainer(containers[i]!, STOP_SECONDS);
        if (!record.revoked) this.journal.revoke(record.attemptId, "revoked");
        seen.stopped += 1;
        continue;
      }
      // Live at the crash: revoke (persisted first), then stop and confirm. A stop that fails or is
      // not confirmed stays `unknown` with dispatch closed and the janitor keeps retrying it.
      this.journal.revoke(record.attemptId, "unknown");
      this.closeDispatch(record.attemptId);
      if (anyRunning) await this.stopAndConfirm(record, "restart");
      this.log.warn("attempt was live at restart; revoked, stopped and marked unknown", { attemptId: record.attemptId, role: record.role, containers, status: record.status, wasRunning: anyRunning });
      seen.interrupted += 1;
    }
    this.log.debug("reconcile pass", { ...seen, durationMs: Date.now() - startedAt });
  }

  /**
   * Restart: every owned container Docker still lists counts against the host budget until its
   * removal is confirmed, whatever its state. Attempts are charged by their profile; one-shot and
   * collector containers (whose profile is not recorded) by the most expensive loaded profile.
   */
  private async adoptCapacity(): Promise<void> {
    const byAttempt = new Map(this.journal.listAttempts().map((a) => [a.attemptId, a]));
    const profiles = [...this.profiles.values()];
    for (const container of await this.api.listContainers(ownedFilter(this.config.namespace))) {
      const role = container.labels[ROLE_LABEL];
      if ((role === "browser" || role === "egress") && this.config.browser) {
        const costs = browserCosts(this.config.browser, this.capacity.budget);
        this.capacity.adopt(container.name, role === "browser" ? costs.browser : costs.egress);
        continue;
      }
      const createsWorkspace = role !== "collector";
      const record = byAttempt.get(container.labels[ATTEMPT_LABEL] ?? "");
      const profile = record ? this.profileOrUndefined(record) : undefined;
      const candidates: SandboxProfile[] = [...profiles, ...this.codeProfiles()];
      const costs = (profile ? [profile] : candidates).map((p) => sandboxCost(p.caps, this.capacity.budget, createsWorkspace));
      const cost = costs.reduce((max, c) => (c.memoryBytes > max.memoryBytes ? c : max), costs[0] ?? { memoryBytes: 0, pids: 0, scratchBytes: 0 });
      this.capacity.adopt(container.name, cost);
    }
    const used = this.capacity.used();
    if (used.sandboxes > 0) this.log.info("capacity: adopted existing sandboxes after restart", { ...used, budget: this.capacity.budget });
  }

  // -------------------------------------------------------------------------------------------
  // Shared helpers
  // -------------------------------------------------------------------------------------------

  /**
   * Host admission (M2): reserve this sandbox's memory, PIDs and scratch against the host budget,
   * synchronously, before any Docker call. Throws `capacity` (429) with nothing created.
   */
  admit(container: string, profile: SandboxProfile, createsWorkspace: boolean): void {
    this.capacity.reserve(container, sandboxCost(profile.caps, this.capacity.budget, createsWorkspace));
    this.log.debug("capacity reserved", { container, used: this.capacity.used() });
  }
  profile(profileId: string): ProfileManifest {
    const profile = this.profiles.get(profileId);
    if (!profile) throw new SupervisorError("unsupported_profile", `Profile ${profileId} is not supported by this supervisor.`);
    return profile;
  }

  /** The configured analysis/node runtime, or `unsupported_profile` (400) when its image is not set. */
  codePlane(role: CodeRole): CodeRuntimeConfig {
    const plane = this.config.code?.[role];
    if (!plane) throw new SupervisorError("unsupported_profile", `The ${role} runtime is not configured on this supervisor (AIRLOCK_${role.toUpperCase()}_IMAGE is not set).`);
    return plane;
  }

  private codeProfiles(): SandboxProfile[] {
    return (["analysis", "node"] as const).flatMap((role) => (this.config.code?.[role] ? [codeProfile(this.config.code[role]!)] : []));
  }

  /** The runtime profile an attempt record was created with (repository profile, or analysis/node runtime). */
  private profileFor(record: Pick<AttemptRecord, "role" | "profileId">): SandboxProfile {
    return isCodeRole(record.role) ? codeProfile(this.codePlane(record.role)) : this.profile(record.profileId);
  }

  private profileOrUndefined(record: Pick<AttemptRecord, "role" | "profileId">): SandboxProfile | undefined {
    try {
      return this.profileFor(record);
    } catch {
      return undefined;
    }
  }

  /** Idempotent operation wrapper: same id + digest replays; different digest conflicts. */
  async withOperation(operation: Operation, kind: string, fn: () => Promise<OperationResponse>, binding: OperationBinding = {}): Promise<OperationResponse> {
    const startedAt = Date.now();
    const begin = this.journal.beginOperation(operation, kind, binding);
    if (begin.kind !== "new") this.log.debug("journal: operation not new", { operationId: operation.operationId, kind, outcome: begin.kind, ...(begin.kind === "replay" ? { httpStatus: begin.httpStatus } : {}) });
    if (begin.kind === "replay") return { status: begin.httpStatus, body: begin.result };
    if (begin.kind === "conflict") throw new SupervisorError("operation_conflict", `Operation ${operation.operationId} already exists with a different request digest.`);
    if (begin.kind === "in_progress") throw new SupervisorError("operation_in_progress", `Operation ${operation.operationId} is still in progress.`);
    this.log.debug("journal: operation begun", { operationId: operation.operationId, kind });
    try {
      const response = await fn();
      this.journal.completeOperation(operation.operationId, response.status, response.body);
      this.log.debug("journal: operation completed", { operationId: operation.operationId, kind, status: response.status, durationMs: Date.now() - startedAt });
      return response;
    } catch (error) {
      const status = error instanceof SupervisorError ? error.status : 500;
      const body = { error: describe(error), code: error instanceof SupervisorError ? error.code : "internal" };
      if (error instanceof SupervisorError && error.code === "capacity") {
        // Refused before any effect: not a receipt. The same operation id may be retried later.
        this.journal.abandonOperation(operation.operationId);
        this.log.info("operation refused at host admission", { operationId: operation.operationId, kind, error: error.message });
        throw error;
      }
      this.journal.completeOperation(operation.operationId, status, body);
      this.log.debug("journal: operation failed", { operationId: operation.operationId, kind, status, code: body.code, durationMs: Date.now() - startedAt, error });
      throw error;
    }
  }

  /** `withOperation` bound to the attempt the request names (GET /operations/:id reports it). */
  private withRefOperation(ref: AttemptRef, operation: Operation, kind: string, fn: () => Promise<OperationResponse>): Promise<OperationResponse> {
    return this.withOperation(operation, kind, fn, { taskId: ref.taskId, attemptId: ref.attemptId, generation: ref.generation });
  }

  /** GET /operations/:id: the journal row for reconciliation by id (M8). */
  operationRecord(operationId: string) {
    return this.journal.getOperation(operationId);
  }

  /** Serialize lifecycle decisions per attempt (create/freeze/revoke/destroy/expire). */
  private async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.locks.set(key, previous.then(() => current));
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.locks.get(key) === current) this.locks.delete(key);
    }
  }

  private revokeSignal(attemptId: string): AbortSignal {
    let controller = this.revokeSignals.get(attemptId);
    if (!controller) {
      controller = new AbortController();
      this.revokeSignals.set(attemptId, controller);
    }
    return controller.signal;
  }

  private closeDispatch(attemptId: string): void {
    this.revokeSignals.get(attemptId)?.abort();
    const timer = this.deadlineTimers.get(attemptId);
    if (timer) clearTimeout(timer);
    this.deadlineTimers.delete(attemptId);
  }

  /** Bound a caller deadline by the profile cap; reject a deadline already in the past. */
  boundDeadline(absoluteDeadline: string, caps: Caps): string {
    return this.boundDeadlineMs(absoluteDeadline, caps.attemptTimeoutMs);
  }

  private boundDeadlineMs(absoluteDeadline: string, maxMs: number): string {
    const requested = Date.parse(absoluteDeadline);
    const now = Date.now();
    if (!Number.isFinite(requested) || requested <= now) {
      throw new SupervisorError("invalid_body", "absoluteDeadline must be in the future.");
    }
    return new Date(Math.min(requested, now + maxMs)).toISOString();
  }

  expectedFor(request: ProvisionRequest): ExpectedSandbox {
    const spec: SandboxSpec = {
      name: request.container,
      image: request.profile.runtimeImage,
      labels: request.labels,
      caps: request.profile.caps,
      dockerRuntime: this.config.dockerRuntime,
      mount: { volume: request.volume, target: request.mount.target, readOnly: request.mount.readOnly },
      workingDir: request.workingDir,
      ...(request.profile.imagePin ? { imagePin: request.profile.imagePin } : {}),
      ...(request.profile.readinessArgv ? { readinessArgv: request.profile.readinessArgv } : {}),
      ...(request.profile.extraEnvPrefixes ? { extraEnvPrefixes: request.profile.extraEnvPrefixes } : {}),
    };
    return { ...spec, defaultRuntime: this.host.defaultRuntime };
  }

  /**
   * Create volume (optional) + container, start it, inspect the effective config (including the
   * pinned image ID and the runner readiness exec), fail closed. A caller that has not admitted the
   * sandbox yet is admitted here, before the first Docker call.
   */
  async provision(request: ProvisionRequest): Promise<Provisioned> {
    const expected = this.expectedFor(request);
    if (!this.capacity.has(request.container)) this.admit(request.container, request.profile, request.createVolume);
    let volumeCreated = false;
    const workspaceBytes = workspaceBytesOf(request.profile.caps);
    try {
      if (request.createVolume) {
        await this.api.createVolume(request.volume, request.labels, workspaceDriverOpts(workspaceBytes));
        volumeCreated = true;
      }
      // Effective check of the volume itself: it must be the size-capped tmpfs this supervisor
      // creates, whether it was created just now or is being reused (collector).
      const volume = await this.api.inspectVolume(request.volume);
      if (!volume || !ours(this.config.namespace, volume.labels) || !workspaceVolumeBounded(volume, workspaceBytes)) {
        throw new SupervisorError("inspection_failed", `Volume ${request.volume} is not a ${workspaceBytes}-byte bounded workspace owned by this supervisor; refusing to mount it.`);
      }
      await this.api.createContainer(sandboxCreateSpec(expected));
      await this.api.startContainer(request.container);
      const { inspection } = await this.inspect(expected, { requireRunning: true });
      this.capacity.settled(request.container);
      this.log.debug("sandbox provisioned", { container: request.container, volume: request.volume, image: request.profile.runtimeImage, runtime: inspection.runtime, devUnsafe: inspection.devUnsafe, allPassed: inspection.allPassed, guestHostname: inspection.guestHostname, mount: request.mount });
      return { inspection, expected, guest: { uname: inspection.guestUname, hostname: inspection.guestHostname } };
    } catch (error) {
      this.capacity.settled(request.container);
      this.log.warn("sandbox provisioning failed; removing its resources", { container: request.container, volume: request.volume, error });
      await this.removeResources(request.container, volumeCreated ? request.volume : undefined);
      throw error;
    }
  }

  async inspect(expected: ExpectedSandbox, options: { requireRunning: boolean; previousGuest?: { uname: string; hostname: string } }) {
    const result = await inspectSandbox(
      this.api,
      expected,
      {
        namespace: this.config.namespace,
        configuredRuntime: this.config.runtime,
        devUnsafe: this.config.devUnsafe,
        defaultRuntime: this.host.defaultRuntime,
        runtimeImageId: this.config.runtimeImageId,
      },
      options,
    );
    // Dev-unsafe without a pin: record the image ID actually observed (HostCheck.runtimeImageId).
    if (!expected.imagePin && !this.config.runtimeImageId && /^sha256:[a-f0-9]{64}$/.test(result.detail.image)) this.host.check.runtimeImageId = result.detail.image;
    return result;
  }

  /**
   * Force-remove a container and (optionally) a volume; never throws. The container's host
   * reservation is released only when an inspect confirms it is gone; otherwise the janitor keeps
   * checking.
   */
  async removeResources(container: string, volume?: string): Promise<void> {
    const startedAt = Date.now();
    try {
      await this.api.removeContainer(container, true);
    } catch (error) {
      this.log.warn("remove container failed", { container, error });
    }
    await this.releaseIfGone(container);
    if (volume) {
      // Volume removal races the container's own removal; retry briefly.
      for (let i = 0; i < 5; i++) {
        try {
          await this.api.removeVolume(volume);
          this.log.debug("resources removed", { container, volume, attempts: i + 1, durationMs: Date.now() - startedAt });
          return;
        } catch (error) {
          if (i === 4) this.log.warn("remove volume failed", { volume, error });
          await new Promise((r) => setTimeout(r, 200 * (i + 1)));
        }
      }
    }
    this.log.debug("resources removed", { container, volume: volume ?? null, durationMs: Date.now() - startedAt });
  }

  /** Release a reservation once Docker confirms the container no longer exists. */
  private async releaseIfGone(container: string): Promise<boolean> {
    if (!this.capacity.has(container)) return false;
    let detail;
    try {
      detail = await this.api.inspectContainer(container);
    } catch (error) {
      this.log.warn("capacity: could not confirm removal; reservation kept", { container, error });
      return false;
    }
    if (detail) return false;
    this.capacity.release(container);
    this.log.debug("capacity released", { container, used: this.capacity.used() });
    return true;
  }

  /**
   * Checkpoint 5: list what the supervisor still owns under these labels, plus the host-wide
   * listing taken right after (M7): "(no sandboxes)" means that listing is empty, not this filter.
   */
  async teardownRecord(labelFilters: string[]): Promise<TeardownRecord & { networksRemaining: string[] }> {
    const [containers, volumes, networks] = await Promise.all([this.api.listContainers(labelFilters), this.api.listVolumes(labelFilters), this.api.listNetworks(labelFilters)]);
    const containersRemaining = containers.map((c) => c.name).sort();
    const volumesRemaining = volumes.map((v) => v.name).sort();
    // A browser attempt is clean only when its two per-attempt networks are gone too.
    const networksRemaining = networks.map((n) => n.name).sort();
    const host = await this.hostListing();
    return {
      destroyedAt: new Date().toISOString(),
      containersRemaining,
      volumesRemaining,
      clean: containersRemaining.length === 0 && volumesRemaining.length === 0 && networksRemaining.length === 0,
      host,
      networksRemaining,
    };
  }

  /**
   * Every Airlock-owned container and volume on this Docker host, by the owner label alone (any
   * namespace), so another deployment's or a test's leftovers are not hidden from the listing.
   */
  async hostListing(): Promise<HostListing & { networks: string[] }> {
    const filter = [`${OWNER_LABEL}=true`];
    const [containers, volumes, networks] = await Promise.all([this.api.listContainers(filter), this.api.listVolumes(filter), this.api.listNetworks(filter)]);
    return {
      listedAt: new Date().toISOString(),
      scope: "host",
      containers: containers
        .map((c) => ({
          name: c.name,
          ...(c.labels[TASK_LABEL] ? { taskId: c.labels[TASK_LABEL] } : {}),
          ...(c.labels[ROLE_LABEL] ? { role: c.labels[ROLE_LABEL] } : {}),
          state: c.state,
        }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
      volumes: volumes.map((v) => v.name).sort(),
      // Airlock-owned per-attempt networks: "(no sandboxes)" requires these empty too.
      networks: networks.map((n) => n.name).sort(),
    };
  }

  /** Run the fixed materializer in a fresh sandbox. */
  async materialize(container: string, caps: Caps, signal?: AbortSignal) {
    return runExec(
      this.api,
      container,
      { cmd: timedCommand(["/usr/local/bin/python", MATERIALIZE], caps.commandTimeoutMs / 1000), user: SANDBOX_USER, workingDir: "/workspace" },
      { timeoutMs: caps.commandTimeoutMs + SUPERVISOR_GRACE_MS, outputBytes: 16_384, ...(signal ? { signal } : {}) },
    );
  }

  // -------------------------------------------------------------------------------------------
  // Attempts
  // -------------------------------------------------------------------------------------------

  private names(ref: AttemptRef, role: SandboxRole): AttemptNames {
    const names = attemptNames(this.config.namespace, ref.taskId, ref.attemptId, role);
    if (!names.ok) throw new SupervisorError("invalid_body", names.reason);
    return names.value;
  }

  /** Every container an attempt record owns (browser: the browser and its egress proxy). */
  private containersOf(record: Pick<AttemptRecord, "taskId" | "attemptId" | "role" | "container">): string[] {
    const names = attemptNames(this.config.namespace, record.taskId, record.attemptId, record.role);
    return names.ok ? attemptContainers(names.value) : [record.container];
  }

  private networksOf(record: Pick<AttemptRecord, "taskId" | "attemptId" | "role">): string[] {
    const names = attemptNames(this.config.namespace, record.taskId, record.attemptId, record.role);
    return names.ok ? attemptNetworks(names.value) : [];
  }

  /** One timer per attempt, at min(authorizedUntil, deadline); re-armed by every renewal. */
  private armDeadline(record: AttemptRecord): void {
    if (this.stopped) return;
    const existing = this.deadlineTimers.get(record.attemptId);
    if (existing) clearTimeout(existing);
    const endsAt = authorityEndsAt(record);
    const delay = Math.min(Math.max(0, Date.parse(endsAt) - Date.now()), MAX_TIMER_MS);
    const timer = setTimeout(() => {
      this.log.debug("deadline timer fired", { attemptId: record.attemptId, deadline: record.deadline, authorizedUntil: record.authorizedUntil });
      this.expire(record.attemptId).catch((error) => this.log.error("expire failed", { attemptId: record.attemptId, error }));
    }, delay);
    this.deadlineTimers.set(record.attemptId, timer);
    this.log.debug("deadline armed", { attemptId: record.attemptId, deadline: record.deadline, authorizedUntil: record.authorizedUntil, delayMs: delay });
  }

  /**
   * The end of execution authority (the absolute deadline, or an authorization that was not renewed
   * in time): revoke and stop regardless of the caller. Like `revoke`, the stop is confirmed by
   * inspection; a stop that fails or is not confirmed leaves the row `unknown` (visible, dispatch
   * closed) and the janitor keeps retrying the stop (CLAUDE.md §3.5). A timer that fires after a
   * renewal it raced re-arms instead of revoking.
   */
  async expire(attemptId: string): Promise<void> {
    await this.withLock(attemptId, async () => {
      const record = this.journal.getAttempt(attemptId);
      if (!record || record.status === "destroyed" || record.revoked) return;
      const endsAt = authorityEndsAt(record);
      if (Date.parse(endsAt) > Date.now()) {
        this.armDeadline(record);
        return;
      }
      const cause = record.authorizedUntil < record.deadline ? "authorization" : "deadline";
      this.log.info(cause === "deadline" ? "attempt deadline reached; revoking and stopping" : "attempt authorization lapsed without renewal; revoking and stopping", { attemptId, container: record.container, deadline: record.deadline, authorizedUntil: record.authorizedUntil });
      this.journal.revoke(attemptId, "revoked");
      this.closeDispatch(attemptId);
      await this.stopAndConfirm(record, cause);
    });
  }

  /** Stop a revoked attempt's container and confirm it; on failure or an unconfirmed stop, mark `unknown`. */
  private async stopAndConfirm(record: AttemptRecord, reason: string): Promise<boolean> {
    try {
      const containers = this.containersOf(record);
      for (const container of containers) await this.api.stopContainer(container, STOP_SECONDS);
      for (const container of containers) {
        const detail = await this.api.inspectContainer(container);
        if (detail?.state.running) {
          this.journal.updateAttempt(record.attemptId, { status: "unknown" });
          this.log.warn("container still running after stop; marked unknown", { attemptId: record.attemptId, container, reason });
          return false;
        }
      }
      this.log.debug("stop confirmed", { attemptId: record.attemptId, container: record.container, reason });
      return true;
    } catch (error) {
      this.journal.updateAttempt(record.attemptId, { status: "unknown" });
      this.log.warn("stop failed; marked unknown", { attemptId: record.attemptId, container: record.container, reason, error });
      return false;
    }
  }

  async createAttempt(body: CreateAttemptRequest): Promise<OperationResponse> {
    // Every body validation runs INSIDE the operation so that a repeat with the same id and digest
    // replays the recorded receipt even when a time-dependent check (the deadline) would fail now.
    return this.withRefOperation(body.ref, body.operation, "createAttempt", async () => {
      if (body.role === "browser") return this.createBrowserAttempt(body);
      const code = isCodeRole(body.role);
      if (body.egressAllow !== undefined) throw new SupervisorError("invalid_body", "egressAllow applies to browser attempts only; task sandboxes have no network.");
      if (!code && body.role !== "author" && body.role !== "hostile") {
        throw new SupervisorError("invalid_body", `Role ${body.role} is a one-shot role; use POST /invoke.`);
      }
      let profile: SandboxProfile;
      if (isCodeRole(body.role)) {
        // Like the browser profile, an analysis/node runtime is configuration: profileId names the role.
        const plane = this.codePlane(body.role);
        if (body.profileId !== body.role) throw new SupervisorError("invalid_body", `A ${body.role} attempt uses the ${body.role} runtime profile: profileId must be "${body.role}".`);
        profile = codeProfile(plane);
      } else {
        profile = this.profile(body.profileId);
      }
      const names = this.names(body.ref, body.role);
      const deadline = this.boundDeadline(body.absoluteDeadline, profile.caps);
      const authorizedUntil = body.authorizedUntil === undefined ? deadline : this.boundAuthorization(body.authorizedUntil, deadline);
      return this.withLock(names.attemptId, async () => {
        // From here to insertAttempt there is no await: the tombstone, generation and admission
        // checks and the insert are one step, so two creates for one task cannot both pass.
        if (this.journal.isTombstoned(names.attemptId)) {
          throw new SupervisorError("revoked", `Attempt ${names.attemptId} was destroyed earlier and cannot be resurrected.`);
        }
        if (this.journal.getAttempt(names.attemptId)) throw new SupervisorError("operation_conflict", `Attempt ${names.attemptId} already exists.`);
        this.checkTaskGeneration(body.ref, body.role);
        const now = new Date().toISOString();
        const record: AttemptRecord = {
          taskId: names.taskId,
          attemptId: names.attemptId,
          generation: body.ref.generation,
          role: body.role,
          profileId: profile.id,
          container: names.container,
          volume: names.volume,
          status: "created",
          deadline,
          authorizedUntil,
          revoked: false,
          devUnsafe: this.config.devUnsafe,
          createdAt: now,
          updatedAt: now,
        };
        // Admit (host budget) before any Docker call, then record before dispatch.
        this.admit(names.container, profile, true);
        try {
          this.journal.insertAttempt(record);
        } catch (error) {
          this.capacity.release(names.container);
          throw error;
        }
        const labels = attemptLabels(names);
        let provisioned: Provisioned;
        try {
          provisioned = await this.provision({
            container: names.container,
            volume: names.volume,
            labels,
            profile,
            mount: { target: "/workspace", readOnly: false },
            workingDir: "/workspace",
            createVolume: true,
          });
        } catch (error) {
          this.journal.updateAttempt(names.attemptId, { status: "destroyed", revoked: true, ...(error instanceof InspectionFailed ? { inspection: error.inspection } : {}) });
          this.journal.tombstone(names.attemptId, names.taskId, `provision failed: ${describe(error)}`);
          throw error;
        }
        const signal = this.revokeSignal(names.attemptId);
        // Every failure after the container exists — a refusal below or anything thrown by
        // materialize/probe/journal (Docker unavailable, a stream error) — revokes, closes dispatch,
        // removes the sandbox, and releases its reservation only on confirmed removal. A removal
        // that is not confirmed leaves the row `unknown` (revoked, so it fences nothing) for the janitor.
        let cleaned = false;
        const cleanup = async (reason: string, probe?: IsolationProbe) => {
          cleaned = true;
          this.journal.revoke(names.attemptId, "revoked");
          this.closeDispatch(names.attemptId);
          this.journal.updateAttempt(names.attemptId, { inspection: provisioned.inspection, ...(probe ? { probe } : {}) });
          await this.removeResources(names.container, names.volume);
          let gone = false;
          try {
            gone = (await this.api.inspectContainer(names.container)) === null;
          } catch (error) {
            this.log.warn("create cleanup: could not confirm removal", { attemptId: names.attemptId, error });
          }
          this.journal.updateAttempt(names.attemptId, { status: gone ? "destroyed" : "unknown", revoked: true });
          this.journal.tombstone(names.attemptId, names.taskId, reason);
        };
        const fail = async (code: "inspection_failed" | "probe_failed" | "internal", message: string, probe?: IsolationProbe): Promise<never> => {
          await cleanup(message, probe);
          throw new SupervisorError(code, message);
        };
        try {
          if (code) {
            // inputs/ (root-owned: only the supervisor places inputs), code/ and outputs/ (uid 1000).
            await this.api.putArchive(names.container, codeLayoutTar(), CODE_WORKSPACE, AbortSignal.timeout(this.writeTimeoutMs));
          } else {
            const materialized = await this.materialize(names.container, profile.caps, signal);
            if (materialized.result.status !== "succeeded") {
              await fail("internal", `Materializing the pristine source tree failed (${materialized.result.status}): ${materialized.result.stderr.slice(0, 400)}`);
            }
          }
          const probe = await runProbe(this.api, names.container, "/workspace", workspaceBytesOf(profile.caps), signal);
          this.log.debug("isolation probe", { attemptId: names.attemptId, container: names.container, allBlocked: probe.allBlocked, metadataEndpoint: probe.metadataEndpoint, dns: probe.dns, outboundTcp: probe.outboundTcp, dockerSocket: probe.dockerSocket, hostMounts: probe.hostMounts });
          if (!probe.allBlocked) {
            await fail("probe_failed", `Isolation probe not fully BLOCKED (${probeSummary(probe)}); sandbox destroyed and run refused.`, probe);
          }
          // Re-check the fence before handing the sandbox out: the deadline may have passed meanwhile.
          const current = this.journal.getAttempt(names.attemptId);
          if (!current || current.revoked || authorityEndsAt(current) < new Date().toISOString()) {
            await fail("internal", "Attempt deadline or authorization passed during preparation.", probe);
          }
          this.journal.updateAttempt(names.attemptId, { status: "running", inspection: provisioned.inspection, probe });
          this.armDeadline({ ...(current ?? record), status: "running" });
          this.log.info("attempt running", { attemptId: names.attemptId, taskId: names.taskId, role: body.role, container: names.container, runtime: provisioned.inspection.runtime, devUnsafe: provisioned.inspection.devUnsafe, deadline });
          const state = this.journal.getAttempt(names.attemptId);
          if (!state) throw new SupervisorError("internal", "Attempt vanished from the journal.");
          return { status: 200, body: attemptStateOf(state) };
        } catch (error) {
          if (!cleaned) {
            this.log.warn("attempt preparation threw; removing the sandbox", { attemptId: names.attemptId, container: names.container, error });
            await cleanup(`preparation failed: ${describe(error)}`).catch((cleanupError) => this.log.error("create cleanup failed", { attemptId: names.attemptId, error: cleanupError }));
          }
          throw error;
        }
      });
    });
  }

  /** Bound a requested authorization: in the future, never past the attempt's deadline. */
  private boundAuthorization(authorizedUntil: string, deadline: string): string {
    const requested = Date.parse(authorizedUntil);
    if (!Number.isFinite(requested) || requested <= Date.now()) throw new SupervisorError("invalid_body", "authorizedUntil must be in the future.");
    return new Date(Math.min(requested, Date.parse(deadline))).toISOString();
  }

  /**
   * A new attempt never silently supersedes a live one of the same task: while any older attempt of
   * the task is live (not revoked, not destroyed) the create is refused; the caller revokes or
   * destroys it first. A generation older than one already recorded for the task is stale.
   */
  private checkTaskGeneration(ref: AttemptRef, role: SandboxRole): void {
    for (const other of this.journal.listTaskAttempts(ref.taskId)) {
      if (other.attemptId === ref.attemptId) continue;
      if (ref.generation < other.generation) {
        throw new SupervisorError("stale_generation", `Generation ${ref.generation} is older than generation ${other.generation} already recorded for task ${ref.taskId}.`);
      }
      // One live attempt per task and role family: a task may hold one browser session and one
      // code sandbox at a time (the combined workflow), never two of the same family.
      if (other.status !== "destroyed" && !other.revoked && roleFamily(other.role) === roleFamily(role)) {
        throw new SupervisorError("fenced", `Attempt ${other.attemptId} (generation ${other.generation}, ${other.role}) of task ${ref.taskId} is still live; revoke or destroy it before creating ${ref.attemptId}.`);
      }
    }
  }

  /**
   * M1: extend (or shorten) an attempt's execution authorization. Clamped to the absolute deadline;
   * refused for an unknown, revoked, stopped, destroyed or tombstoned attempt, for any generation
   * but the recorded one, and once the current authorization has lapsed: a renewal never revives.
   */
  async renew(ref: AttemptRef, operation: Operation, authorizedUntil: string): Promise<OperationResponse> {
    this.names(ref, "author");
    return this.withRefOperation(ref, operation, "renew", () =>
      this.withLock(ref.attemptId, async () => {
        const record = this.journal.fence(ref);
        if (record.status !== "running") throw new SupervisorError("fenced", `Attempt ${ref.attemptId} is ${record.status}; only a running attempt can be renewed.`);
        const bounded = this.boundAuthorization(authorizedUntil, record.deadline);
        this.journal.updateAttempt(record.attemptId, { authorizedUntil: bounded });
        const updated = this.journal.getAttempt(record.attemptId);
        if (!updated) throw new SupervisorError("internal", "Attempt vanished from the journal.");
        this.armDeadline(updated);
        this.log.debug("attempt authorization renewed", { attemptId: record.attemptId, authorizedUntil: bounded, requested: authorizedUntil, deadline: record.deadline });
        return { status: 200, body: attemptStateOf(updated) };
      }),
    );
  }

  getAttempt(attemptId: string): AttemptState | null {
    const record = this.journal.getAttempt(attemptId);
    return record ? attemptStateOf(record) : null;
  }

  listAttempts(): AttemptState[] {
    return this.journal.listAttempts().map(attemptStateOf);
  }

  // -------------------------------------------------------------------------------------------
  // Author tools
  // -------------------------------------------------------------------------------------------

  /**
   * POST /attempts/:id/tool. Author (repair) attempts: read/write within the profile's paths, exec in
   * the source root; `put` is refused (400). Analysis/node attempts: `put` only under inputs/ (binary,
   * quota-bound, root-owned 0444), `write` only under code/ (text), `read` of code/ or outputs/, `exec`
   * in /workspace; a put/write/read elsewhere is refused (400).
   */
  async authorTool(ref: AttemptRef, operation: Operation, args: AuthorToolArgs): Promise<OperationResponse> {
    this.names(ref, "author");
    return this.withRefOperation(ref, operation, "authorTool", async () => {
      const record = this.journal.fence(ref);
      const code = isCodeRole(record.role);
      if (record.role !== "author" && !code) throw new SupervisorError("fenced", `Attempt ${ref.attemptId} is a ${record.role} sandbox; author tools are not available.`);
      if (record.status !== "running") throw new SupervisorError("fenced", `Attempt ${ref.attemptId} is ${record.status}; author tools need a running sandbox.`);
      if (isCodeRole(record.role)) {
        const plane = this.codePlane(record.role);
        return { status: 200, body: await this.runCodeTool(record, plane, args) };
      }
      if (args.kind === "put") throw new SupervisorError("invalid_body", "Author tool kind \"put\" is available to analysis and node attempts only; repair attempts write source text with \"write\".");
      const profile = this.profile(record.profileId);
      const result = await this.runTool(record, profile, args);
      return { status: 200, body: result };
    });
  }

  /** Deliver a tar into a running sandbox with the write semantics of runTool (fence, tracked, uncertain → quarantine). */
  private async deliver(record: AttemptRecord, tar: Uint8Array, root: string, signal: AbortSignal, onDefiniteFailure?: () => void): Promise<void> {
    this.journal.fence({ taskId: record.taskId, attemptId: record.attemptId, generation: record.generation });
    if (signal.aborted) {
      onDefiniteFailure?.();
      throw new SupervisorError("revoked", `Attempt ${record.attemptId} is revoked; dispatch is closed.`);
    }
    try {
      await this.tracked(record.attemptId, () =>
        this.api.putArchive(record.container, tar, root, AbortSignal.timeout(this.writeTimeoutMs)).catch((error: unknown) => {
          if (error instanceof SupervisorError && (error.code === "not_found" || error.code === "invalid_body")) onDefiniteFailure?.();
          else this.uncertainWrites.add(record.attemptId);
          throw error;
        }),
      );
    } catch (error) {
      if (this.uncertainWrites.has(record.attemptId)) await this.quarantine(record, `write lost control (${describe(error)})`);
      throw error;
    }
  }

  private async runCodeTool(record: AttemptRecord, plane: CodeRuntimeConfig, args: AuthorToolArgs): Promise<AuthorToolResult> {
    const signal = this.revokeSignal(record.attemptId);
    const caps = codeProfile(plane).caps;

    if (args.kind === "put") {
      const problem = codePathProblem(args.path, ["inputs"]);
      if (problem) throw new SupervisorError("invalid_body", `put: ${problem}`);
      const bytes = decodeBase64Strict(args.contentBase64);
      if (!bytes) throw new SupervisorError("invalid_body", "put: contentBase64 is not strict (canonical, padded) base64.");
      // Reserve synchronously: two concurrent puts cannot both fit into the last bytes of the quota.
      const quota = this.inputQuota.reserve(record.attemptId, args.path, bytes.byteLength, { maxFileBytes: plane.maxInputFileBytes, maxTotalBytes: plane.maxInputTotalBytes });
      if (quota) throw new SupervisorError("invalid_body", `put: ${quota}`);
      const digest = sha256Hex(bytes);
      // Root-owned, read-only for the sandbox user: files 0444, directories 0755 (only root may add).
      const tar = createTar([
        ...ancestorDirs([args.path]).map((dir) => ({ path: dir, kind: "dir" as const, uid: 0, gid: 0, mode: 0o755 })),
        { path: args.path, kind: "file" as const, bytes, uid: 0, gid: 0, mode: 0o444 },
      ]);
      await this.deliver(record, tar, CODE_WORKSPACE, signal, () => this.inputQuota.release(record.attemptId, args.path));
      this.log.debug("input placed", { attemptId: record.attemptId, path: args.path, bytes: bytes.byteLength, sha256: digest, attemptInputBytes: this.inputQuota.total(record.attemptId) });
      return { kind: "put", byteLength: bytes.byteLength, sha256: digest };
    }

    if (args.kind === "write") {
      const problem = codePathProblem(args.path, ["code"]);
      if (problem) throw new SupervisorError("invalid_body", `write: ${problem}`);
      const bytes = new TextEncoder().encode(args.content);
      if (bytes.length > caps.maxFileBytes) throw new SupervisorError("invalid_body", `write: content is ${bytes.length} bytes; the limit is ${caps.maxFileBytes}.`);
      const tar = createTar([
        ...ancestorDirs([args.path]).map((dir) => ({ path: dir, kind: "dir" as const })),
        { path: args.path, kind: "file" as const, bytes },
      ]);
      await this.deliver(record, tar, CODE_WORKSPACE, signal);
      return { kind: "write", byteLength: bytes.length };
    }

    if (args.kind === "read") {
      const problem = codePathProblem(args.path, ["code", "outputs"]);
      if (problem) throw new SupervisorError("invalid_body", `read: ${problem}`);
      this.journal.fence({ taskId: record.taskId, attemptId: record.attemptId, generation: record.generation });
      const outcome = await this.tracked(record.attemptId, () =>
        runExec(
          this.api,
          record.container,
          { cmd: timedCommand(["/usr/bin/head", "-c", String(caps.maxFileBytes + 1), "--", `${CODE_WORKSPACE}/${args.path}`], 10), user: SANDBOX_USER, workingDir: CODE_WORKSPACE },
          { timeoutMs: 10_000 + SUPERVISOR_GRACE_MS, outputBytes: caps.maxFileBytes + 1, signal },
        ),
      );
      if (outcome.controlLost) await this.quarantine(record, "read tool lost control");
      if (outcome.result.status !== "succeeded") return { kind: "refused", reason: `Could not read ${args.path}: ${outcome.result.stderr.trim().slice(0, 300) || outcome.result.status}` };
      const bytes = new TextEncoder().encode(outcome.result.stdout);
      const truncated = bytes.length > caps.maxFileBytes || outcome.result.truncated;
      return { kind: "read", content: truncated ? new TextDecoder().decode(bytes.subarray(0, caps.maxFileBytes)) : outcome.result.stdout, truncated };
    }

    // exec: the model's command, cwd /workspace, bounded like author commands.
    this.journal.fence({ taskId: record.taskId, attemptId: record.attemptId, generation: record.generation });
    const outcome = await this.tracked(record.attemptId, () =>
      runExec(
        this.api,
        record.container,
        { cmd: authorCommand(args.command, caps.commandTimeoutMs / 1000), user: SANDBOX_USER, workingDir: CODE_WORKSPACE },
        { timeoutMs: caps.commandTimeoutMs + SUPERVISOR_GRACE_MS, outputBytes: caps.outputBytes, signal },
      ),
    );
    if (outcome.controlLost) await this.quarantine(record, `exec lost control (${outcome.result.status})`);
    return { kind: "exec", result: outcome.result };
  }

  private async runTool(record: AttemptRecord, profile: ProfileManifest, args: Exclude<AuthorToolArgs, { kind: "put" }>): Promise<AuthorToolResult> {
    const caps = profile.caps;
    const signal = this.revokeSignal(record.attemptId);
    const refused = (reason: string): AuthorToolResult => ({ kind: "refused", reason });
    const sourceRoot = profile.sourceRoot;

    if (args.kind === "read") {
      if (!profile.readablePaths.includes(args.path) && !profile.allowedReplacementPaths.includes(args.path)) {
        return refused(`Path ${args.path} is not readable in profile ${profile.id}.`);
      }
      this.journal.fence({ taskId: record.taskId, attemptId: record.attemptId, generation: record.generation });
      const outcome = await this.tracked(record.attemptId, () =>
        runExec(
          this.api,
          record.container,
          { cmd: timedCommand(["/usr/bin/head", "-c", String(caps.maxFileBytes + 1), "--", `${sourceRoot}/${args.path}`], 10), user: SANDBOX_USER, workingDir: sourceRoot },
          { timeoutMs: 10_000 + SUPERVISOR_GRACE_MS, outputBytes: caps.maxFileBytes + 1, signal },
        ),
      );
      if (outcome.controlLost) await this.quarantine(record, "read tool lost control");
      if (outcome.result.status !== "succeeded") return refused(`Could not read ${args.path}: ${outcome.result.stderr.trim().slice(0, 300) || outcome.result.status}`);
      const bytes = new TextEncoder().encode(outcome.result.stdout);
      const truncated = bytes.length > caps.maxFileBytes || outcome.result.truncated;
      const content = truncated ? new TextDecoder().decode(bytes.subarray(0, caps.maxFileBytes)) : outcome.result.stdout;
      return { kind: "read", content, truncated };
    }

    if (args.kind === "write") {
      if (!profile.allowedReplacementPaths.includes(args.path)) {
        return refused(`Path ${args.path} is not writable in profile ${profile.id}; allowed: ${profile.allowedReplacementPaths.join(", ")}.`);
      }
      const bytes = new TextEncoder().encode(args.content);
      if (bytes.length > caps.maxFileBytes) return refused(`Content is ${bytes.length} bytes; the limit is ${caps.maxFileBytes}.`);
      const tar = createTar([
        ...ancestorDirs([args.path]).map((dir) => ({ path: dir, kind: "dir" as const })),
        { path: args.path, kind: "file" as const, bytes },
      ]);
      // The fence is re-checked synchronously right before dispatch, and `tracked` registers the
      // write in the same tick, so a freeze/revoke either fences it here or finds it outstanding.
      // Revocation does not abort an accepted write (an aborted upload's effect is unknown); freeze
      // waits for it instead. Only the write's own timeout aborts it, and then its effect is unknown.
      this.journal.fence({ taskId: record.taskId, attemptId: record.attemptId, generation: record.generation });
      if (signal.aborted) throw new SupervisorError("revoked", `Attempt ${record.attemptId} is revoked; dispatch is closed.`);
      try {
        await this.tracked(record.attemptId, () =>
          this.api.putArchive(record.container, tar, sourceRoot, AbortSignal.timeout(this.writeTimeoutMs)).catch((error: unknown) => {
            // Marked before the tracked promise settles, so a concurrent settle already sees it. Only a
            // definite refusal (container gone, Docker 4xx) is known to have written nothing; an
            // abort, timeout or transport error leaves the write's effect unknown.
            if (!(error instanceof SupervisorError && (error.code === "not_found" || error.code === "invalid_body"))) this.uncertainWrites.add(record.attemptId);
            throw error;
          }),
        );
      } catch (error) {
        if (this.uncertainWrites.has(record.attemptId)) await this.quarantine(record, `write lost control (${describe(error)})`);
        throw error;
      }
      return { kind: "write", byteLength: bytes.length };
    }

    // exec
    this.journal.fence({ taskId: record.taskId, attemptId: record.attemptId, generation: record.generation });
    const outcome = await this.tracked(record.attemptId, () =>
      runExec(
        this.api,
        record.container,
        { cmd: authorCommand(args.command, caps.commandTimeoutMs / 1000), user: SANDBOX_USER, workingDir: sourceRoot },
        { timeoutMs: caps.commandTimeoutMs + SUPERVISOR_GRACE_MS, outputBytes: caps.outputBytes, signal },
      ),
    );
    if (outcome.controlLost) await this.quarantine(record, `exec lost control (${outcome.result.status})`);
    return { kind: "exec", result: outcome.result };
  }

  /** Keep a handle on every in-flight exec and write so freeze can wait for them. */
  private async tracked<T>(attemptId: string, fn: () => Promise<T>): Promise<T> {
    let set = this.outstanding.get(attemptId);
    if (!set) {
      set = new Set();
      this.outstanding.set(attemptId, set);
    }
    const promise = fn();
    set.add(promise);
    try {
      return await promise;
    } finally {
      set.delete(promise);
      if (set.size === 0) this.outstanding.delete(attemptId);
    }
  }

  /** OpenMuse quarantine: when a command's fate is unknown, stop the whole sandbox and close dispatch. */
  private async quarantine(record: AttemptRecord, reason: string): Promise<void> {
    await this.withLock(record.attemptId, async () => {
      const current = this.journal.getAttempt(record.attemptId);
      // Already revoked (freeze/revoke/deadline): whoever closed dispatch also stopped the container.
      if (!current || current.status === "destroyed" || current.revoked) return;
      this.log.warn("attempt quarantined", { attemptId: record.attemptId, container: record.container, reason });
      this.journal.revoke(record.attemptId, "revoked");
      this.closeDispatch(record.attemptId);
      for (const container of this.containersOf(current)) {
        try {
          await this.api.stopContainer(container, STOP_SECONDS);
        } catch (error) {
          this.journal.updateAttempt(record.attemptId, { status: "unknown" });
          this.log.warn("stop after quarantine failed", { attemptId: record.attemptId, container, error });
        }
      }
    });
  }

  // -------------------------------------------------------------------------------------------
  // Freeze / revoke / destroy
  // -------------------------------------------------------------------------------------------

  async freeze(ref: AttemptRef, operation: Operation): Promise<OperationResponse> {
    this.names(ref, "author");
    return this.withRefOperation(ref, operation, "freeze", () =>
      this.withLock(ref.attemptId, async () => {
        const record = this.journal.fenceLifecycle(ref);
        if (record.role !== "author") {
          throw new SupervisorError("fenced", record.role === "browser" ? `Browser attempts are never frozen or collected (${ref.attemptId}); revoke or destroy it.` : `Only author attempts can be frozen; ${ref.attemptId} is ${record.role}.`);
        }
        if (authorityEndsAt(record) <= new Date().toISOString()) {
          throw new SupervisorError("fenced", `Attempt ${ref.attemptId} is past its execution authorization; it will be stopped, not collected.`);
        }
        const profile = this.profile(record.profileId);
        const current = this.journal.getAttempt(record.attemptId);
        // Only a live author that this process has watched without interruption can be frozen. A
        // revoked, stopped or unknown attempt (cancelled, expired, or live at a restart and later
        // stopped by the janitor) holds a workspace whose last writes are uncertain: never collected.
        if (!current || current.status !== "running" || current.revoked) {
          throw new SupervisorError("fenced", `Attempt ${record.attemptId} is ${current ? `${current.status}${current.revoked ? " (revoked)" : ""}` : "gone"}; only a live, unrevoked author attempt can be frozen.`);
        }
        const names = this.names(ref, "author");
        // 0. admit the collector before anything changes: a full host refuses the freeze (429) with
        //    the attempt still live, instead of revoking it and then failing to collect.
        this.admit(names.collector, profile, false);
        // From here the collector reservation is owned by `collect`, whose finally removes the
        // collector and releases it on confirmed removal; anything thrown before that releases it here.
        try {
          // 1. revoke dispatch
          this.journal.revoke(record.attemptId, "revoked");
          this.closeDispatch(record.attemptId);
        } catch (error) {
          this.capacity.release(names.collector);
          throw error;
        }
        // 2. hold the workspace: the collector (a fresh container that has run nothing) mounts the
        //    volume read-only BEFORE the author stops. The workspace is a tmpfs volume whose contents
        //    exist only while a container holds the mount; without the hold, stopping the author would
        //    discard the candidate before it could be collected.
        const { held, envelope } = await this.collect(names, profile, this.sourceCollector(profile), () => this.stopSettleInspect(record, names, profile, current, "freeze"));
        // 6. collected in the fresh container with the volume read-only
        const result: FreezeResult = { stoppedAt: held.stoppedAt, stopConfirmed: true, outstandingOperationsSettled: held.settled, envelope };
        this.log.info("attempt frozen and collected", { attemptId: record.attemptId, container: record.container, collector: names.collector, stoppedAt: held.stoppedAt, settled: held.settled, files: envelope.files.length, rejected: envelope.rejected.length, bytes: envelope.files.reduce((n, f) => n + f.byteLength, 0) });
        return { status: 200, body: result };
      }),
    );
  }

  /**
   * Steps 3–5 of freeze and collect-outputs, run while the collector holds the volume: stop the
   * container, settle outstanding execs and writes (refuse when any did not settle or a write's effect
   * is unknown: a late write could still land), re-inspect it stopped, record `stopped`.
   */
  private async stopSettleInspect(record: AttemptRecord, names: AttemptNames, profile: SandboxProfile, current: AttemptRecord, what: "freeze" | "collect-outputs"): Promise<{ stoppedAt: string; settled: boolean }> {
    // 3. stop the container
    await this.api.stopContainer(record.container, STOP_SECONDS);
    const stoppedAt = new Date().toISOString();
    // 4. settle outstanding execs and writes
    const settled = await this.settle(record.attemptId);
    if (!settled) {
      this.journal.updateAttempt(record.attemptId, { status: "unknown" });
      this.log.warn(`${what}: outstanding operations did not settle; refusing to collect`, { attemptId: record.attemptId, container: record.container, uncertainWrite: this.uncertainWrites.has(record.attemptId) });
      throw new SupervisorError("fenced", `Outstanding operations on ${record.container} did not settle; the workspace is uncertain and will not be collected.`);
    }
    // 5. re-inspect stopped
    const expected = this.expectedFor({
      container: names.container,
      volume: names.volume,
      labels: attemptLabels(names),
      profile,
      mount: { target: "/workspace", readOnly: false },
      workingDir: "/workspace",
      createVolume: false,
    });
    const guest = current.inspection ? { uname: current.inspection.guestUname, hostname: current.inspection.guestHostname } : undefined;
    const { detail } = await this.inspect(expected, { requireRunning: false, ...(guest ? { previousGuest: guest } : {}) });
    if (detail.state.running) {
      this.journal.updateAttempt(record.attemptId, { status: "unknown" });
      throw new SupervisorError("fenced", `Container ${record.container} is still running after stop; refusing to collect.`);
    }
    this.journal.updateAttempt(record.attemptId, { status: "stopped" });
    return { stoppedAt, settled };
  }

  /** The repair collector: runtime/python/collector.py over the profile's allowlist at /candidate/src. */
  private sourceCollector(profile: SandboxProfile): CollectorRun<FileEnvelope> {
    return {
      argv: ["/usr/local/bin/python", "-I", "-S", COLLECTOR, "--root", "/candidate/src", "--profile", PROFILE_JSON],
      outputBytes: Math.ceil(profile.caps.maxTotalBytes * 1.4) + 65_536 + profile.caps.maxFiles * 2048,
      parse: (raw) => {
        const parsed = FileEnvelope.safeParse(raw);
        return parsed.success ? { ok: true, envelope: parsed.data } : { ok: false, reason: parsed.error.issues[0]?.message ?? "unknown" };
      },
    };
  }

  /** The output collector: runtime/outputs/collect_outputs.py over /candidate/outputs (analysis image). */
  private outputsCollector(): CollectorRun<z.infer<typeof OutputEnvelopeSchema>> {
    return {
      argv: ["/usr/local/bin/python3", "-I", "-S", OUTPUTS_COLLECTOR, "--root", "/candidate"],
      outputBytes: OUTPUTS_COLLECTOR_STDOUT_BYTES,
      parse: validateOutputEnvelope,
    };
  }

  /**
   * POST /attempts/:id/collect-outputs (analysis and node attempts). The freeze ordering, with the
   * output collector: admit the collector → revoke dispatch → a fresh analysis-image container
   * mounts the workspace read-only (holding the tmpfs volume) → stop → settle (refuse when
   * unsettled) → re-inspect stopped → collect_outputs.py → the supervisor re-validates the envelope.
   * The attempt is left stopped; destroy removes it.
   */
  async collectOutputs(ref: AttemptRef, operation: Operation): Promise<OperationResponse> {
    this.names(ref, "author");
    return this.withRefOperation(ref, operation, "collectOutputs", () =>
      this.withLock(ref.attemptId, async () => {
        const record = this.journal.fenceLifecycle(ref);
        if (!isCodeRole(record.role)) {
          throw new SupervisorError("fenced", record.role === "author" ? `Attempt ${ref.attemptId} is a repair attempt; use freeze.` : `Only analysis and node attempts have outputs to collect; ${ref.attemptId} is ${record.role}.`);
        }
        if (authorityEndsAt(record) <= new Date().toISOString()) {
          throw new SupervisorError("fenced", `Attempt ${ref.attemptId} is past its execution authorization; it will be stopped, not collected.`);
        }
        const current = this.journal.getAttempt(record.attemptId);
        if (!current || current.status !== "running" || current.revoked) {
          throw new SupervisorError("fenced", `Attempt ${record.attemptId} is ${current ? `${current.status}${current.revoked ? " (revoked)" : ""}` : "gone"}; only a live, unrevoked analysis/node attempt can be collected.`);
        }
        const profile = codeProfile(this.codePlane(record.role));
        // Node outputs are collected with the analysis image (config refuses node without analysis).
        const collectorProfile = outputsCollectorProfile(this.codePlane("analysis"), profile.caps);
        const names = this.names(ref, record.role);
        // 0. admit the collector first: a full host refuses (429) with the attempt still live.
        this.admit(names.collector, collectorProfile, false);
        try {
          // 1. revoke dispatch
          this.journal.revoke(record.attemptId, "revoked");
          this.closeDispatch(record.attemptId);
        } catch (error) {
          this.capacity.release(names.collector);
          throw error;
        }
        let stopped = false;
        try {
          // 2–6. hold (collector mounts the volume read-only), stop, settle, inspect stopped, collect.
          const { held, envelope } = await this.collect(names, collectorProfile, this.outputsCollector(), async () => {
            const result = await this.stopSettleInspect(record, names, profile, current, "collect-outputs");
            stopped = true;
            return result;
          });
          const result: CollectOutputsResult = { stoppedAt: held.stoppedAt, stopConfirmed: true, envelope };
          this.log.info("attempt stopped and outputs collected", { attemptId: record.attemptId, role: record.role, container: record.container, collector: names.collector, stoppedAt: held.stoppedAt, files: envelope.files.length, rejected: envelope.rejected.length, bytes: envelope.files.reduce((n, f) => n + f.byteLength, 0) });
          return { status: 200, body: result };
        } catch (error) {
          // Dispatch is already revoked. If the failure came before the stop (collector could not be
          // provisioned), stop the sandbox now so a revoked container is never left running.
          if (!stopped) {
            const latest = this.journal.getAttempt(record.attemptId);
            if (latest && (latest.status === "running" || latest.status === "revoked") && (await this.stopAndConfirm(latest, "collect-outputs failed"))) {
              this.journal.updateAttempt(record.attemptId, { status: "stopped" });
            }
          }
          throw error;
        }
      }),
    );
  }

  private async settle(attemptId: string): Promise<boolean> {
    const set = this.outstanding.get(attemptId);
    if (!set || set.size === 0) return !this.uncertainWrites.has(attemptId);
    const pending = [...set].map((p) => p.then(() => undefined, () => undefined));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), this.settleMs);
    });
    const outcome = await Promise.race([Promise.all(pending).then(() => "settled" as const), timeout]);
    clearTimeout(timer);
    return outcome === "settled" && !this.uncertainWrites.has(attemptId);
  }

  /**
   * The collector: fresh container with the workspace volume mounted read-only at /candidate, fixed
   * argv. It is provisioned first (holding the tmpfs-backed volume), then `afterHold` stops and
   * confirms the author container, and only then does the collector run. The author workspace holds
   * the source tree at <volume>/src, so the collector root is /candidate/src.
   */
  private async collect<T, E>(names: AttemptNames, profile: SandboxProfile, run: CollectorRun<E>, afterHold: () => Promise<T>): Promise<{ held: T; envelope: E }> {
    const labels = attemptLabels(names, "collector");
    const deadline = new Date(Date.now() + profile.caps.commandTimeoutMs * 2 + 60_000).toISOString();
    try {
      this.journal.insertEphemeral({ container: names.collector, volume: null, taskId: names.taskId, operationId: `collect-${names.attemptId}`, role: "collector", deadline, createdAt: new Date().toISOString() });
      await this.provision({
        container: names.collector,
        volume: names.volume,
        labels,
        profile,
        mount: { target: "/candidate", readOnly: true },
        workingDir: "/",
        createVolume: false,
      });
      const held = await afterHold();
      const outcome = await runExec(
        this.api,
        names.collector,
        { cmd: timedCommand(run.argv, profile.caps.commandTimeoutMs / 1000), user: SANDBOX_USER, workingDir: "/" },
        { timeoutMs: profile.caps.commandTimeoutMs + SUPERVISOR_GRACE_MS, outputBytes: run.outputBytes },
      );
      if (outcome.result.status !== "succeeded") {
        throw new SupervisorError("internal", `Collector did not succeed (${outcome.result.status}, exit ${outcome.result.exitCode}): ${outcome.result.stderr.slice(0, 400)}`);
      }
      if (outcome.result.truncated) throw new SupervisorError("internal", "Collector output exceeded the profile's total byte bound.");
      let raw: unknown;
      try {
        raw = JSON.parse(outcome.result.stdout);
      } catch {
        throw new SupervisorError("internal", "Collector printed something that is not a JSON envelope.");
      }
      const parsed = run.parse(raw);
      if (!parsed.ok) throw new SupervisorError("internal", `Collector envelope does not validate: ${parsed.reason}`);
      return { held, envelope: parsed.envelope };
    } finally {
      await this.removeResources(names.collector);
      this.journal.deleteEphemeral(names.collector);
    }
  }

  async revoke(ref: AttemptRef, operation: Operation): Promise<OperationResponse> {
    this.names(ref, "author");
    return this.withRefOperation(ref, operation, "revoke", () =>
      this.withLock(ref.attemptId, async () => {
        const record = this.journal.fenceLifecycle(ref, { allowNewer: true });
        const current = this.journal.getAttempt(record.attemptId);
        if (!current || current.status === "destroyed") throw new SupervisorError("revoked", `Attempt ${record.attemptId} was destroyed.`);
        this.journal.revoke(record.attemptId, current.status === "stopped" ? "stopped" : "revoked");
        this.closeDispatch(record.attemptId);
        const containers = this.containersOf(record);
        for (const container of containers) await this.api.stopContainer(container, STOP_SECONDS);
        for (const container of containers) {
          const detail = await this.api.inspectContainer(container);
          if (detail?.state.running) {
            this.journal.updateAttempt(record.attemptId, { status: "unknown" });
            this.log.warn("revoke: container did not stop; termination not confirmed", { attemptId: record.attemptId, container });
            throw new SupervisorError("docker_unavailable", `Container ${container} did not stop; termination is not confirmed.`);
          }
        }
        const state = this.journal.getAttempt(record.attemptId);
        this.log.info("attempt revoked and stopped", { attemptId: record.attemptId, container: record.container, status: state?.status ?? current.status });
        return { status: 200, body: attemptStateOf(state ?? current) };
      }),
    );
  }

  async destroy(ref: AttemptRef, operation: Operation): Promise<OperationResponse> {
    this.names(ref, "author");
    return this.withRefOperation(ref, operation, "destroy", () =>
      this.withLock(ref.attemptId, async () => {
        const record = this.journal.fenceLifecycle(ref, { allowNewer: true });
        const names = this.names(ref, record.role);
        this.journal.revoke(record.attemptId, record.status === "destroyed" ? "destroyed" : "revoked");
        this.closeDispatch(record.attemptId);
        const teardown = await this.destroyResources(names);
        this.journal.updateAttempt(record.attemptId, { status: teardown.clean ? "destroyed" : "unknown" });
        this.journal.tombstone(record.attemptId, record.taskId, teardown.clean ? "destroyed" : "teardown incomplete");
        this.outstanding.delete(record.attemptId);
        this.uncertainWrites.delete(record.attemptId);
        this.inputQuota.forget(record.attemptId);
        this.uploadQuota.delete(record.attemptId);
        this.revokeSignals.delete(record.attemptId);
        this.browserGenerations.delete(record.attemptId);
        const egress = record.role === "browser" ? (this.journal.getBrowser(record.attemptId)?.egress as EgressEvidence | null) : null;
        const result: DestroyResult = { teardown, ...(egress ? { egressSummary: egress.summary } : {}) };
        this.log.info(teardown.clean ? "attempt destroyed" : "attempt teardown incomplete", { attemptId: record.attemptId, container: names.container, volume: names.volume, containersRemaining: teardown.containersRemaining, volumesRemaining: teardown.volumesRemaining });
        return { status: 200, body: result };
      }),
    );
  }

  private async destroyResources(names: AttemptNames): Promise<TeardownRecord> {
    await this.removeResources(names.collector);
    if (names.role === "browser") {
      // Keep the proxy's decisions as evidence before its container (and log) is removed.
      await this.captureEgress(names).catch((error) => this.log.warn("egress evidence could not be collected before teardown", { attemptId: names.attemptId, error }));
      await this.removeResources(names.container);
      await this.removeResources(names.egress);
      await this.removeNetworks([names.internalNetwork, names.egressNetwork]);
    } else {
      await this.removeResources(names.container, names.volume);
    }
    return this.teardownRecord(ownedFilter(this.config.namespace, { taskId: names.taskId, attemptId: names.attemptId }));
  }

  /** Remove owned networks (never a foreign one), retrying while endpoints detach. Never throws. */
  private async removeNetworks(networks: string[]): Promise<void> {
    for (const network of networks) {
      for (let i = 0; i < 5; i++) {
        try {
          const detail = await this.api.inspectNetwork(network);
          if (!detail) break;
          if (!ours(this.config.namespace, detail.labels)) {
            this.log.warn("network not owned by this supervisor; left in place", { network });
            break;
          }
          await this.api.removeNetwork(network);
        } catch (error) {
          if (i === 4) this.log.warn("remove network failed", { network, error });
          await new Promise((r) => setTimeout(r, 200 * (i + 1)));
        }
      }
    }
  }

  // -------------------------------------------------------------------------------------------
  // Browser attempts (browser.ts): Chromium sandbox on a per-attempt --internal network whose only
  // peer is a per-attempt egress proxy. Created, inspected, probed and torn down as one unit.
  // -------------------------------------------------------------------------------------------

  private browserPlane(): BrowserPlaneConfig {
    const plane = this.config.browser;
    if (!plane) throw new SupervisorError("unsupported_profile", "The browser plane is not configured on this supervisor (AIRLOCK_BROWSER_IMAGE is not set).");
    return plane;
  }

  private browserExpected(names: AttemptNames, plane: BrowserPlaneConfig, allow: string[]) {
    const base = attemptLabels(names, "browser");
    return expectedPair(
      {
        browser: names.container,
        egress: names.egress,
        internalNetwork: names.internalNetwork,
        egressNetwork: names.egressNetwork,
        internalBridge: names.internalBridge,
        egressBridge: names.egressBridge,
      },
      plane,
      {
        browser: base,
        egress: attemptLabels(names, "egress"),
        internal: { ...base, [NETWORK_LABEL]: "internal" },
        egressNet: { ...base, [NETWORK_LABEL]: "egress" },
      },
      allow,
      { dockerRuntime: this.config.dockerRuntime, defaultRuntime: this.host.defaultRuntime },
    );
  }

  private async createBrowserAttempt(body: CreateAttemptRequest): Promise<OperationResponse> {
    const plane = this.browserPlane();
    if (body.profileId !== BROWSER_PROFILE_ID) {
      throw new SupervisorError("invalid_body", `A browser attempt uses the browser runtime profile: profileId must be "${BROWSER_PROFILE_ID}".`);
    }
    const allow = body.egressAllow ?? [];
    const badAllow = checkEgressAllow(allow);
    if (badAllow) throw new SupervisorError("invalid_body", badAllow);
    const names = this.names(body.ref, "browser");
    const deadline = this.boundDeadlineMs(body.absoluteDeadline, plane.attemptTimeoutMs);
    const authorizedUntil = body.authorizedUntil === undefined ? deadline : this.boundAuthorization(body.authorizedUntil, deadline);
    return this.withLock(names.attemptId, async () => {
      // As for author attempts: tombstone, generation, admission and insert are one synchronous step.
      if (this.journal.isTombstoned(names.attemptId)) {
        throw new SupervisorError("revoked", `Attempt ${names.attemptId} was destroyed earlier and cannot be resurrected.`);
      }
      if (this.journal.getAttempt(names.attemptId)) throw new SupervisorError("operation_conflict", `Attempt ${names.attemptId} already exists.`);
      this.checkTaskGeneration(body.ref, "browser");
      const now = new Date().toISOString();
      const record: AttemptRecord = {
        taskId: names.taskId,
        attemptId: names.attemptId,
        generation: body.ref.generation,
        role: "browser",
        profileId: BROWSER_PROFILE_ID,
        container: names.container,
        volume: "",
        status: "created",
        deadline,
        authorizedUntil,
        revoked: false,
        devUnsafe: this.config.devUnsafe,
        createdAt: now,
        updatedAt: now,
      };
      // Host admission for BOTH containers (each with its VM overhead) before any Docker call.
      const costs = browserCosts(plane, this.capacity.budget);
      this.capacity.reserveAll([
        { container: names.container, cost: costs.browser },
        { container: names.egress, cost: costs.egress },
      ]);
      this.log.debug("capacity reserved (browser + egress)", { attemptId: names.attemptId, used: this.capacity.used() });
      try {
        this.journal.insertAttempt(record);
        this.journal.insertBrowser(names.attemptId, allow);
      } catch (error) {
        this.capacity.release(names.container);
        this.capacity.release(names.egress);
        throw error;
      }
      const signal = this.revokeSignal(names.attemptId);
      let evidence: BrowserEvidence;
      try {
        evidence = await this.provisionBrowser(names, plane, allow, signal);
      } catch (error) {
        const refused = error instanceof BrowserRefused ? error : undefined;
        this.journal.updateAttempt(names.attemptId, {
          status: "destroyed",
          revoked: true,
          ...(refused?.inspection ? { inspection: refused.inspection } : {}),
          ...(refused?.probe ? { probe: refused.probe } : {}),
        });
        this.journal.tombstone(names.attemptId, names.taskId, `browser provision failed: ${describe(error)}`);
        this.closeDispatch(names.attemptId);
        throw error;
      }
      this.journal.updateBrowser(names.attemptId, { evidence });
      // Re-check the fence before handing the sandbox out.
      const current = this.journal.getAttempt(names.attemptId);
      if (!current || current.revoked || authorityEndsAt(current) < new Date().toISOString()) {
        this.journal.updateAttempt(names.attemptId, { inspection: evidence.browserInspection, probe: evidence.probe });
        const teardown = await this.destroyResources(names);
        this.journal.updateAttempt(names.attemptId, { status: teardown.clean ? "destroyed" : "unknown", revoked: true });
        this.journal.tombstone(names.attemptId, names.taskId, "deadline or authorization passed during preparation");
        throw new SupervisorError("internal", "Attempt deadline or authorization passed during preparation.");
      }
      this.journal.updateAttempt(names.attemptId, { status: "running", inspection: evidence.browserInspection, probe: evidence.probe });
      this.armDeadline({ ...current, status: "running" });
      this.log.info("browser attempt running", {
        attemptId: names.attemptId,
        taskId: names.taskId,
        container: names.container,
        egress: names.egress,
        networks: [names.internalNetwork, names.egressNetwork],
        runtime: evidence.browserInspection.runtime,
        devUnsafe: evidence.browserInspection.devUnsafe,
        browserVersion: evidence.status.browserVersion,
        sandbox: evidence.status.sandbox,
        egressAllow: allow,
        deadline,
      });
      const state = this.journal.getAttempt(names.attemptId);
      if (!state) throw new SupervisorError("internal", "Attempt vanished from the journal.");
      return { status: 200, body: attemptStateOf(state) };
    });
  }

  /**
   * networks → egress proxy (both networks, started, listening with exactly the allowlist) →
   * browser (internal network only, healthy) → effective-config inspection of both containers and
   * both networks → runner `status` with Chromium sandbox evidence → isolation probe. Any failure
   * removes everything created and refuses the attempt.
   */
  private async provisionBrowser(names: AttemptNames, plane: BrowserPlaneConfig, allow: string[], signal: AbortSignal): Promise<BrowserEvidence> {
    const expected = this.browserExpected(names, plane, allow);
    let browserInspection: RuntimeInspection | undefined;
    let probe: IsolationProbe | undefined;
    try {
      await this.api.createNetwork({ name: expected.internal.name, labels: expected.internal.labels, internal: true, options: networkOptions(expected.internal.bridge) });
      await this.api.createNetwork({ name: expected.egressNet.name, labels: expected.egressNet.labels, internal: false, options: networkOptions(expected.egressNet.bridge) });
      await this.api.createContainer(containerCreateSpec(expected.egress));
      await this.api.connectNetwork(expected.internal.name, expected.egress.name);
      await this.api.startContainer(expected.egress.name);
      await this.waitEgressListening(expected.egress.name, allow);
      await this.api.createContainer(containerCreateSpec(expected.browser));
      await this.api.startContainer(expected.browser.name);
      await this.waitBrowserHealthy(expected.browser.name);

      const egressInspection = await this.inspectPairMember(expected.egress);
      browserInspection = await this.inspectPairMember(expected.browser);
      const networkFailures = [
        ...checkNetwork(await this.api.inspectNetwork(expected.internal.name), expected.internal, this.config.namespace, { exactContainers: true }),
        ...checkNetwork(await this.api.inspectNetwork(expected.egressNet.name), expected.egressNet, this.config.namespace, { exactContainers: true }),
      ];
      if (networkFailures.length > 0) {
        throw new BrowserRefused("inspection_failed", `Browser network inspection failed (${networkFailures.join(", ")}); refusing to dispatch.`, browserInspection);
      }

      const reply = await this.runnerCall(expected.browser.name, `status-${names.attemptId}`.slice(0, 64), { op: "status" }, signal);
      if (reply.kind !== "completed" || !reply.response.ok) {
        const reason = reply.kind === "interrupted" ? reply.reason : reply.response.ok ? "refused" : `${reply.response.error}: ${reply.response.message}`;
        throw new BrowserRefused("probe_failed", `Browser runner status failed (${reason}); sandbox destroyed and run refused.`, browserInspection);
      }
      const status = reply.response.result as BrowserStatusResult;
      const sandboxFailures = sandboxEvidenceFailures(status, expected.browser.airlockEnv.AIRLOCK_PROXY!, plane.mutationOrigins);
      if (sandboxFailures.length > 0) {
        throw new BrowserRefused("probe_failed", `Chromium sandbox evidence missing (${sandboxFailures.join(", ")}); sandbox destroyed and run refused.`, browserInspection);
      }
      if (reply.generation !== null) this.browserGenerations.set(names.attemptId, reply.generation);
      else this.browserGenerations.set(names.attemptId, status.generation);

      probe = await this.browserProbe(expected.browser.name, signal);
      if (!probe.allBlocked) {
        throw new BrowserRefused("probe_failed", `Isolation probe not fully BLOCKED (${probeSummary(probe)}); sandbox destroyed and run refused.`, browserInspection, probe);
      }
      this.capacity.settled(names.container);
      this.capacity.settled(names.egress);
      return {
        status,
        browserInspection,
        egressInspection,
        probe,
        networks: { internal: expected.internal.name, egress: expected.egressNet.name },
        egressAllow: allow,
      };
    } catch (error) {
      this.capacity.settled(names.container);
      this.capacity.settled(names.egress);
      this.log.warn("browser provisioning failed; removing its resources", { attemptId: names.attemptId, error });
      await this.destroyResources(names);
      if (error instanceof BrowserRefused || !(error instanceof SupervisorError && error.code === "inspection_failed")) throw error;
      throw new BrowserRefused("inspection_failed", error.message, browserInspection, probe);
    }
  }

  private async waitEgressListening(container: string, allow: string[]): Promise<void> {
    const end = Date.now() + this.browserWaits.listeningMs;
    for (;;) {
      const logs = await this.api.containerLogs(container, { tail: 50, maxBytes: 64 * 1024 });
      const evidence = parseEgressLog(logs ?? "", allow, "live");
      if (evidence.listening) {
        if (!listeningMatches(evidence.listening, allow)) {
          throw new SupervisorError("inspection_failed", `The egress proxy did not parse the requested allowlist exactly (listening: ${JSON.stringify(evidence.listening).slice(0, 300)}).`);
        }
        return;
      }
      const detail = await this.api.inspectContainer(container);
      if (!detail?.state.running) {
        throw new SupervisorError("inspection_failed", `The egress proxy exited before listening (exit ${detail?.state.exitCode ?? "?"}): ${(logs ?? "").trim().slice(-300)}`);
      }
      if (Date.now() >= end) throw new SupervisorError("inspection_failed", "The egress proxy did not report listening in time.");
      await new Promise((r) => setTimeout(r, this.browserWaits.pollMs));
    }
  }

  private async waitBrowserHealthy(container: string): Promise<void> {
    const end = Date.now() + this.browserWaits.healthMs;
    for (;;) {
      const detail = await this.api.inspectContainer(container);
      if (!detail?.state.running) throw new SupervisorError("inspection_failed", `The browser runner exited before it was healthy (exit ${detail?.state.exitCode ?? "?"}, oomKilled ${detail?.state.oomKilled ?? "?"}).`);
      if (detail.state.health === "healthy") return;
      if (detail.state.health === "unhealthy") throw new SupervisorError("inspection_failed", "The browser runner is unhealthy.");
      if (Date.now() >= end) throw new SupervisorError("inspection_failed", `The browser runner was not healthy within ${this.browserWaits.healthMs} ms (health ${detail.state.health ?? "none"}).`);
      await new Promise((r) => setTimeout(r, this.browserWaits.pollMs));
    }
  }

  /** Effective config of one browser-plane container, fail closed; guest uname/hostname read from inside. */
  private async inspectPairMember(expected: ExpectedContainer): Promise<RuntimeInspection> {
    const detail = await this.api.inspectContainer(expected.name);
    if (!detail) throw new SupervisorError("inspection_failed", `Container ${expected.name} does not exist; refusing to dispatch.`);
    if (!ours(this.config.namespace, detail.config.labels)) throw new SupervisorError("inspection_failed", `Container ${expected.name} is not owned by this supervisor; refusing to dispatch.`);
    const effective = checkPairEffective(detail, expected, this.config.namespace);
    const image = await this.api.inspectImage(detail.image);
    const imageDigest = image ? (image.repoDigests[0] ?? image.id) : detail.image;
    const effectiveRuntime = typeof detail.hostConfig.Runtime === "string" ? detail.hostConfig.Runtime : "";
    const runtime = runtimeNameOf(effectiveRuntime, this.config.runtime, expected.dockerRuntime, this.host.defaultRuntime);
    let guestUname = "";
    let guestHostname = "";
    if (!detail.state.running) {
      effective.failures.push("running");
      effective.allPassed = false;
    } else if (effective.allPassed) {
      const run = (argv: string[], bytes: number) =>
        runExec(this.api, expected.name, { cmd: timedCommand(argv, 5), user: expected.user, workingDir: expected.workingDir }, { timeoutMs: 10_000, outputBytes: bytes });
      const uname = await run(["/usr/bin/uname", "-a"], 512);
      const host = await run(["/usr/bin/hostname"], 128);
      if (uname.result.status !== "succeeded" || host.result.status !== "succeeded") {
        effective.failures.push("guestIdentity");
        effective.allPassed = false;
      } else {
        guestUname = uname.result.stdout.trim().slice(0, 512);
        guestHostname = host.result.stdout.trim().slice(0, 128);
      }
    }
    const inspection = toInspection(expected, effective, detail, { runtime, devUnsafe: this.config.devUnsafe, imageDigest, guestUname, guestHostname });
    this.log.debug("browser-plane inspection", { container: expected.name, kind: expected.kind, allPassed: inspection.allPassed, runtime, failures: effective.failures });
    if (!inspection.allPassed) {
      throw new BrowserRefused("inspection_failed", `${expected.kind} container inspection failed (${effective.failures.join(", ")}); refusing to dispatch.`, expected.kind === "browser" ? inspection : undefined);
    }
    return inspection;
  }

  private async browserProbe(container: string, signal: AbortSignal): Promise<IsolationProbe> {
    const probedAt = new Date().toISOString();
    const outcome = await runExec(this.api, container, { cmd: browserProbeArgv(), user: BROWSER_USER, workingDir: BROWSER_WORKDIR }, { timeoutMs: 30_000, outputBytes: 4096, signal });
    if (outcome.result.status !== "succeeded") return parseProbeOutput("", probedAt);
    return parseProbeOutput(outcome.result.stdout, probedAt);
  }

  /** One bounded runner call: `head -c <n> | node client.mjs` with the request on stdin. */
  private async runnerCall(container: string, requestId: string, op: RunnerOp, signal: AbortSignal): Promise<ParsedReply> {
    const stdin = runnerRequest(requestId, op);
    if (stdin.byteLength > MAX_STDIN_BYTES) throw new SupervisorError("invalid_body", `Runner request is ${stdin.byteLength} bytes; the limit is ${MAX_STDIN_BYTES}.`);
    const timeouts = opTimeouts(op.op);
    const outcome = await runExec(
      this.api,
      container,
      { cmd: clientArgv(stdin.byteLength, timeouts.containerSeconds), user: BROWSER_USER, workingDir: BROWSER_WORKDIR, env: [`AIRLOCK_CLIENT_TIMEOUT_MS=${timeouts.clientMs}`], stdin },
      { timeoutMs: timeouts.supervisorMs, outputBytes: RESPONSE_CAP_BYTES, signal },
    );
    const reply = classifyReply(op, requestId, { ...outcome.result, controlLost: outcome.controlLost });
    this.log.debug("browser runner call", { container, op: op.op, requestId, kind: reply.kind, exitCode: outcome.result.exitCode, execStatus: outcome.result.status, durationMs: outcome.result.durationMs, stdoutBytes: outcome.result.stdout.length, ...(reply.kind === "interrupted" ? { reason: reply.reason } : {}) });
    return reply;
  }

  /**
   * POST /attempts/:id/browser. Journaled like every mutating call (a duplicate operation id replays
   * the recorded result, never re-dispatches); serialized per attempt (one runner op at a time);
   * the fence is re-checked immediately before dispatch; a lost runner closes the attempt.
   */
  async browserOp(ref: AttemptRef, operation: Operation, request: SupervisorBrowserOp): Promise<OperationResponse> {
    this.names(ref, "browser");
    return this.withRefOperation(ref, operation, "browserOp", async () => {
      const accepted = this.journal.fence(ref);
      if (accepted.role !== "browser") throw new SupervisorError("fenced", `Attempt ${ref.attemptId} is a ${accepted.role} sandbox; browser operations are not available.`);
      if (accepted.status !== "running") throw new SupervisorError("fenced", `Attempt ${ref.attemptId} is ${accepted.status}; browser operations need a running attempt.`);
      return this.withLock(`browser-op:${ref.attemptId}`, async () => {
        // Fence re-check immediately before dispatch (the op may have queued behind another).
        const record = this.journal.fence(ref);
        if (record.status !== "running") throw new SupervisorError("fenced", `Attempt ${ref.attemptId} is ${record.status}; browser operations need a running attempt.`);
        const signal = this.revokeSignal(record.attemptId);
        if (signal.aborted) throw new SupervisorError("revoked", `Attempt ${record.attemptId} is revoked; dispatch is closed.`);
        const generationBefore = this.browserGenerations.get(record.attemptId) ?? null;
        const startedAt = Date.now();
        let reply: ParsedReply;
        if (request.op === "download.read") {
          reply = await this.readDownload(record, operation.operationId, request.args.downloadId, signal);
        } else if (request.op === "upload") {
          const placed = await this.placeUpload(record, operation.operationId, request.args, signal);
          reply =
            placed.kind === "failed"
              ? placed.reply
              : await this.tracked(record.attemptId, () =>
                  this.runnerCall(record.container, operation.operationId, { op: "upload", args: { ref: request.args.ref, generation: request.args.generation, uploadId: placed.uploadId, filename: request.args.filename, sha256: placed.sha256 } }, signal),
                );
        } else {
          reply = await this.tracked(record.attemptId, () => this.runnerCall(record.container, operation.operationId, request as RunnerOp, signal));
        }
        const durationMs = Date.now() - startedAt;
        let result: BrowserOpResult;
        if (reply.kind === "interrupted") {
          // A lost runner is an interrupted attempt: the outcome of this op is unknown and it is never
          // replayed. Revoke dispatch and stop both containers.
          this.log.warn("browser runner lost; attempt interrupted", { attemptId: record.attemptId, op: request.op, operationId: operation.operationId, reason: reply.reason });
          await this.quarantine(record, `browser runner lost during ${request.op}: ${reply.reason}`);
          result = { response: reply.response, status: "interrupted", durationMs, generationBefore };
        } else if (reply.kind === "refused") {
          result = { response: reply.response, status: "refused", durationMs, generationBefore };
        } else {
          if (reply.generation !== null) this.browserGenerations.set(record.attemptId, reply.generation);
          result = { response: reply.response, status: "completed", durationMs, generationBefore };
        }
        return { status: 200, body: result };
      });
    });
  }

  /**
   * download.read: the file in bounded runner chunks (≤ 2 MiB each, so every reply stays under the
   * 4 MiB response cap), each chunk checked for offset/size/metadata consistency, the whole re-verified
   * here (size ≤ 10 MiB, sha256 equal to the runner's claim) and its media type re-sniffed here. A
   * runner whose bytes do not match its own digest is treated as lost (interrupted), like a screenshot.
   */
  private async readDownload(record: AttemptRecord, operationId: string, id: string, signal: AbortSignal): Promise<ParsedReply> {
    const ref = { taskId: record.taskId, attemptId: record.attemptId, generation: record.generation };
    const parts: Buffer[] = [];
    let first: DownloadChunkResult | undefined;
    let offset = 0;
    const maxCalls = Math.ceil(MAX_DOWNLOAD_BYTES / DOWNLOAD_CHUNK_BYTES) + 1;
    for (let call = 0; call < maxCalls; call++) {
      this.journal.fence(ref);
      if (signal.aborted) throw new SupervisorError("revoked", `Attempt ${record.attemptId} is revoked; dispatch is closed.`);
      const reply = await this.tracked(record.attemptId, () => this.runnerCall(record.container, operationId, { op: "download.read", args: { downloadId: id, offset } }, signal));
      if (reply.kind !== "completed" || !reply.response.ok) return reply;
      const chunk = reply.response.result as DownloadChunkResult;
      const problem = chunkProblem(chunk, { downloadId: id, offset, ...(first ? { first } : {}) });
      if (problem) return { kind: "interrupted", response: null, reason: `download chunk invalid: ${problem}` };
      first ??= chunk;
      parts.push(Buffer.from(chunk.chunkBase64, "base64"));
      offset += chunk.chunkBytes;
      if (chunk.eof) break;
    }
    if (!first || offset !== first.bytes) return { kind: "interrupted", response: null, reason: "download did not reach its end within the chunk budget" };
    const bytes = Buffer.concat(parts);
    if (bytes.length !== first.bytes || bytes.length > MAX_DOWNLOAD_BYTES) return { kind: "interrupted", response: null, reason: "download size does not match" };
    if (sha256Of(bytes) !== first.sha256) return { kind: "interrupted", response: null, reason: "download bytes do not match their sha256" };
    const result: DownloadReadResult = {
      downloadId: id,
      suggestedFilename: first.suggestedFilename,
      url: first.url,
      mediaType: sniffMediaType(bytes, first.suggestedFilename),
      runnerMediaType: first.mediaType,
      bytes: bytes.length,
      sha256: first.sha256,
      contentBase64: bytes.toString("base64"),
      chunks: parts.length,
    };
    this.log.debug("browser download read", { attemptId: record.attemptId, downloadId: id, bytes: bytes.length, sha256: first.sha256, mediaType: result.mediaType, chunks: parts.length });
    return { kind: "completed", response: { schemaVersion: 1, id: operationId, op: "download.read", ok: true, result }, generation: null };
  }

  /**
   * upload, step 1: the control plane's bytes are checked against artifactSha256 and the per-attempt
   * quota BEFORE anything is placed (a mismatch is a 400 and nothing reaches the container); then
   * they are streamed through the bounded stdin path (≤ 256 KiB per exec) into
   * /tmp/uploads/<uploadId>/.part as the runner user, re-verified there (size + sha256) and renamed
   * to the plain file name. The runner never receives a path, only the derived uploadId and name.
   */
  private async placeUpload(
    record: AttemptRecord,
    operationId: string,
    args: { filename: string; artifactSha256: string; contentBase64: string },
    signal: AbortSignal,
  ): Promise<{ kind: "placed"; uploadId: string; sha256: string } | { kind: "failed"; reply: ParsedReply }> {
    const bytes = decodeBase64Strict(args.contentBase64);
    if (!bytes) throw new SupervisorError("invalid_body", "upload: contentBase64 is not strict (canonical, padded) base64.");
    if (bytes.byteLength === 0) throw new SupervisorError("invalid_body", "upload: the file is empty.");
    if (bytes.byteLength > MAX_UPLOAD_BYTES) throw new SupervisorError("invalid_body", `upload: ${bytes.byteLength} bytes; the limit is ${MAX_UPLOAD_BYTES}.`);
    const digest = sha256Hex(bytes);
    if (digest !== args.artifactSha256) {
      throw new SupervisorError("invalid_body", `upload: the bytes hash to ${digest}, not artifactSha256 ${args.artifactSha256}; nothing was placed.`);
    }
    const used = this.uploadQuota.get(record.attemptId) ?? { count: 0, bytes: 0 };
    if (used.count + 1 > MAX_UPLOADS || used.bytes + bytes.byteLength > MAX_UPLOAD_TOTAL_BYTES) {
      throw new SupervisorError("invalid_body", `upload: this attempt has placed ${used.count} uploads (${used.bytes} bytes); the limits are ${MAX_UPLOADS} uploads and ${MAX_UPLOAD_TOTAL_BYTES} bytes.`);
    }
    // Counted from the first byte placed; a failed placement keeps its share (the bytes may be there).
    this.uploadQuota.set(record.attemptId, { count: used.count + 1, bytes: used.bytes + bytes.byteLength });
    const uploadId = uploadIdFor(operationId);
    const ref = { taskId: record.taskId, attemptId: record.attemptId, generation: record.generation };
    const run = async (script: string, positional: string[], stdin?: Uint8Array) => {
      this.journal.fence(ref);
      if (signal.aborted) throw new SupervisorError("revoked", `Attempt ${record.attemptId} is revoked; dispatch is closed.`);
      return this.tracked(record.attemptId, () =>
        runExec(
          this.api,
          record.container,
          { cmd: timedCommand(["/bin/sh", "-c", script, "airlock-upload", ...positional], 15), user: BROWSER_USER, workingDir: BROWSER_WORKDIR, ...(stdin ? { stdin } : {}) },
          { timeoutMs: 15_000 + SUPERVISOR_GRACE_MS, outputBytes: 4096, signal },
        ),
      );
    };
    const failed = async (step: string, outcome: Awaited<ReturnType<typeof run>>): Promise<{ kind: "failed"; reply: ParsedReply }> => {
      const reason = `upload placement ${step} ${outcome.result.status} (exit ${outcome.result.exitCode}): ${outcome.result.stderr.trim().slice(0, 200)}`;
      if (outcome.controlLost) {
        await this.quarantine(record, reason);
        return { kind: "failed", reply: { kind: "interrupted", response: null, reason } };
      }
      return { kind: "failed", reply: { kind: "refused", response: { schemaVersion: 1, id: operationId, op: "upload", ok: false, error: "action_failed", message: reason.slice(0, 512) } } };
    };
    for (let offset = 0; offset < bytes.byteLength; offset += UPLOAD_CHUNK_BYTES) {
      const chunk = bytes.subarray(offset, Math.min(offset + UPLOAD_CHUNK_BYTES, bytes.byteLength));
      const outcome = await run(offset === 0 ? UPLOAD_FIRST_CHUNK : UPLOAD_NEXT_CHUNK, [String(chunk.byteLength), uploadId], chunk);
      if (outcome.result.status !== "succeeded" || outcome.controlLost) return failed(`chunk at ${offset}`, outcome);
    }
    const finalized = await run(UPLOAD_FINALIZE, [uploadId, String(bytes.byteLength), digest, args.filename]);
    if (finalized.result.status !== "succeeded" || finalized.controlLost) return failed("finalize", finalized);
    if (finalized.result.stdout.trim() !== `${bytes.byteLength} ${digest}`) {
      return { kind: "failed", reply: { kind: "interrupted", response: null, reason: "placed upload does not match its size and sha256 inside the container" } };
    }
    this.log.debug("browser upload placed", { attemptId: record.attemptId, uploadId, bytes: bytes.byteLength, sha256: digest, execs: Math.ceil(bytes.byteLength / UPLOAD_CHUNK_BYTES) + 1 });
    return { kind: "placed", uploadId, sha256: digest };
  }

  /** GET /attempts/:id/browser: the evidence taken at create (sandbox status, inspections, probe, networks). */
  browserEvidence(attemptId: string): (BrowserEvidence & { attemptId: string }) | null {
    const row = this.journal.getBrowser(attemptId);
    if (!row?.evidence) return null;
    return { attemptId, ...(row.evidence as BrowserEvidence) };
  }

  /**
   * GET /attempts/:id/egress: the proxy's decisions (newest EGRESS_DECISIONS_KEPT) and counts. Read
   * live from the proxy's log while its container exists (and recorded); afterwards the recorded copy.
   */
  async egressEvidence(attemptId: string): Promise<(EgressEvidence & { attemptId: string; egressContainer: string }) | null> {
    const record = this.journal.getAttempt(attemptId);
    const row = this.journal.getBrowser(attemptId);
    if (!record || record.role !== "browser" || !row) return null;
    const names = attemptNames(this.config.namespace, record.taskId, record.attemptId, record.role);
    if (!names.ok) return null;
    const live = await this.captureEgress(names.value);
    if (live) return { attemptId, egressContainer: names.value.egress, ...live };
    const recorded = row.egress as EgressEvidence | null;
    return { attemptId, egressContainer: names.value.egress, ...(recorded ? { ...recorded, source: "recorded" as const } : { collectedAt: new Date().toISOString(), source: "recorded" as const, allow: row.egressAllow, decisions: [], summary: { allowed: 0, denied: 0 } }) };
  }

  /** Read the proxy's log tail (bounded) and record it; null when the container is gone. */
  private async captureEgress(names: AttemptNames): Promise<EgressEvidence | null> {
    const row = this.journal.getBrowser(names.attemptId);
    if (!row) return null;
    const logs = await this.api.containerLogs(names.egress, { tail: 2000, maxBytes: 1024 * 1024 });
    if (logs === null) return null;
    const evidence = parseEgressLog(logs, row.egressAllow, "live");
    this.journal.updateBrowser(names.attemptId, { egress: evidence });
    return evidence;
  }

  // -------------------------------------------------------------------------------------------
  // Janitor
  // -------------------------------------------------------------------------------------------

  async janitor(): Promise<{ expired: string[]; destroyed: string[]; removedUnknown: string[]; released: string[] }> {
    const report = { expired: [] as string[], destroyed: [] as string[], removedUnknown: [] as string[], released: [] as string[] };
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();

    // A revoked row whose stop was never confirmed (`unknown`) keeps getting its stop retried until
    // the container is confirmed stopped; only then is it recorded `stopped`.
    for (const record of this.journal.listAttempts()) {
      if (!record.revoked || record.status !== "unknown") continue;
      await this.withLock(record.attemptId, async () => {
        const current = this.journal.getAttempt(record.attemptId);
        if (!current || current.status !== "unknown") return;
        const details = await Promise.all(this.containersOf(current).map((c) => this.api.inspectContainer(c)));
        if (!details.some((d) => d?.state.running)) return;
        this.log.info("janitor: attempt unknown and still running; retrying the stop", { attemptId: current.attemptId, container: current.container });
        if (await this.stopAndConfirm(current, "janitor")) {
          this.journal.updateAttempt(current.attemptId, { status: "stopped" });
          report.expired.push(current.attemptId);
        }
      });
    }

    // Authority that lapsed without its timer (belt and braces): revoke and stop.
    for (const record of this.journal.listAttempts()) {
      if (record.status === "destroyed" || record.revoked || authorityEndsAt(record) >= nowIso) continue;
      await this.expire(record.attemptId);
      report.expired.push(record.attemptId);
    }

    for (const record of this.journal.expiredAttempts(nowIso)) {
      if (!record.revoked) {
        await this.expire(record.attemptId);
        report.expired.push(record.attemptId);
      }
      if (Date.parse(record.deadline) + this.config.retentionMs < nowMs) {
        await this.withLock(record.attemptId, async () => {
          const names = attemptNames(this.config.namespace, record.taskId, record.attemptId, record.role);
          if (!names.ok) return;
          const teardown = await this.destroyResources(names.value);
          this.journal.updateAttempt(record.attemptId, { status: teardown.clean ? "destroyed" : "unknown" });
          this.journal.tombstone(record.attemptId, record.taskId, "expired; janitor destroyed");
          this.closeDispatch(record.attemptId);
        });
        report.destroyed.push(record.attemptId);
      }
    }

    const ephemerals = new Map(this.journal.listEphemerals().map((e) => [e.container, e]));
    for (const e of ephemerals.values()) {
      if (e.deadline < nowIso) {
        await this.removeResources(e.container, e.volume ?? undefined);
        this.journal.deleteEphemeral(e.container);
        ephemerals.delete(e.container);
        report.removedUnknown.push(e.container);
      }
    }

    const live = new Map(this.journal.listAttempts().filter((a) => a.status !== "destroyed").map((a) => [a.attemptId, a]));
    const owned = ownedFilter(this.config.namespace);
    for (const container of await this.api.listContainers(owned)) {
      const attempt = container.labels[ATTEMPT_LABEL];
      const role = container.labels[ROLE_LABEL];
      const operation = container.labels[OPERATION_LABEL];
      const known =
        (operation !== undefined || role === "collector")
          ? ephemerals.has(container.name)
          : attempt !== undefined && live.has(attempt) && this.containersOf(live.get(attempt)!).includes(container.name);
      if (known) continue;
      this.log.info("janitor: removing unknown container", { container: container.name, labels: container.labels });
      await this.removeResources(container.name);
      if (attempt && !operation && role !== "collector") this.journal.tombstone(attempt, container.labels[TASK_LABEL] ?? "unknown", "unknown container removed by janitor");
      report.removedUnknown.push(container.name);
    }
    for (const volume of await this.api.listVolumes(owned)) {
      const attempt = volume.labels[ATTEMPT_LABEL];
      const operation = volume.labels[OPERATION_LABEL];
      const known = operation !== undefined
        ? [...ephemerals.values()].some((e) => e.volume === volume.name)
        : attempt !== undefined && live.get(attempt)?.volume === volume.name;
      if (known) continue;
      this.log.info("janitor: removing unknown volume", { volume: volume.name });
      try {
        await this.api.removeVolume(volume.name);
      } catch (error) {
        this.log.warn("janitor: remove volume failed", { volume: volume.name, error });
      }
      report.removedUnknown.push(volume.name);
    }
    for (const network of await this.api.listNetworks(owned)) {
      const attempt = network.labels[ATTEMPT_LABEL];
      const record = attempt !== undefined ? live.get(attempt) : undefined;
      if (record && this.networksOf(record).includes(network.name)) continue;
      this.log.info("janitor: removing unknown network", { network: network.name });
      await this.removeNetworks([network.name]);
      report.removedUnknown.push(network.name);
    }
    // Host admission: a reservation whose container is confirmed gone is released (this is how a
    // quarantined or failed removal eventually gives its share back).
    for (const container of this.capacity.releasable()) {
      if (await this.releaseIfGone(container)) report.released.push(container);
    }
    this.log.debug("janitor pass", { ...report, durationMs: Date.now() - nowMs });
    return report;
  }
}

function probeSummary(probe: IsolationProbe): string {
  return (["metadataEndpoint", "dns", "outboundTcp", "dockerSocket", "hostMounts"] as const)
    .filter((k) => probe[k] !== "BLOCKED")
    .map((k) => `${k}=${probe[k]}`)
    .join(", ");
}

/** A fixed collector program run in the fresh read-only collector container, and how its stdout is validated. */
interface CollectorRun<E> {
  argv: string[];
  outputBytes: number;
  parse: (raw: unknown) => { ok: true; envelope: E } | { ok: false; reason: string };
}

/** analysis/node workspace layout: inputs/ root-owned 0755 (supervisor-only), code/ and outputs/ owned by the sandbox user. */
export function codeLayoutTar(): Uint8Array {
  return createTar([
    { path: "inputs", kind: "dir", uid: 0, gid: 0, mode: 0o755 },
    { path: "code", kind: "dir" },
    { path: "outputs", kind: "dir" },
  ]);
}

/** Browser sessions and code sandboxes are separate families; a task may hold one live attempt of each. */
export function roleFamily(role: string): "browser" | "code" {
  return role === "browser" ? "browser" : "code";
}
