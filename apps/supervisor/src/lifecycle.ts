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
import {
  type AttemptRef,
  type AttemptState,
  type AuthorToolResult,
  type Caps,
  FileEnvelope,
  type FreezeResult,
  type HostListing,
  type IsolationProbe,
  type Operation,
  type ProfileManifest,
  type RuntimeInspection,
  type SandboxRole,
  type TeardownRecord,
  workspaceBytesOf,
} from "@airlock/contracts";
import { HostCapacity, sandboxCost } from "./capacity";
import type { SupervisorConfig } from "./config";
import type { CreateAttemptRequest, DestroyResult } from "./types";
import type { DockerApi } from "./docker-api";
import { SupervisorError, describe } from "./errors";
import { SANDBOX_USER, SUPERVISOR_GRACE_MS, authorCommand, runExec, timedCommand } from "./exec";
import type { HostReport } from "./host";
import { type AttemptNames, attemptLabels, attemptNames, ours, ownedFilter, ATTEMPT_LABEL, OPERATION_LABEL, OWNER_LABEL, ROLE_LABEL, TASK_LABEL } from "./names";
import { type AttemptRecord, Journal, attemptStateOf, authorityEndsAt } from "./operations";
import { createLogger, log, type Logger } from "./log";
import { runProbe } from "./probe";
import { type ExpectedSandbox, InspectionFailed, type SandboxSpec, inspectSandbox, sandboxCreateSpec, workspaceDriverOpts, workspaceVolumeBounded } from "./runtime";
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
}

export interface ProvisionRequest {
  container: string;
  volume: string;
  labels: Record<string, string>;
  profile: ProfileManifest;
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
      const detail = await this.api.inspectContainer(record.container);
      if (!detail) {
        this.journal.updateAttempt(record.attemptId, { status: "unknown", revoked: true });
        this.log.warn("attempt container missing after restart; marked unknown", { attemptId: record.attemptId, container: record.container });
        seen.missing += 1;
        continue;
      }
      if (record.revoked || authorityEndsAt(record) < new Date().toISOString()) {
        if (detail.state.running) await this.api.stopContainer(record.container, STOP_SECONDS);
        if (!record.revoked) this.journal.revoke(record.attemptId, "revoked");
        seen.stopped += 1;
        continue;
      }
      // Live at the crash: revoke (persisted first), then stop and confirm. A stop that fails or is
      // not confirmed stays `unknown` with dispatch closed and the janitor keeps retrying it.
      this.journal.revoke(record.attemptId, "unknown");
      this.closeDispatch(record.attemptId);
      if (detail.state.running) await this.stopAndConfirm(record, "restart");
      this.log.warn("attempt was live at restart; revoked, stopped and marked unknown", { attemptId: record.attemptId, container: record.container, status: record.status, wasRunning: detail.state.running });
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
      const createsWorkspace = role !== "collector";
      const record = byAttempt.get(container.labels[ATTEMPT_LABEL] ?? "");
      const profile = record ? this.profiles.get(record.profileId) : undefined;
      const costs = (profile ? [profile] : profiles).map((p) => sandboxCost(p.caps, this.capacity.budget, createsWorkspace));
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
  admit(container: string, profile: ProfileManifest, createsWorkspace: boolean): void {
    this.capacity.reserve(container, sandboxCost(profile.caps, this.capacity.budget, createsWorkspace));
    this.log.debug("capacity reserved", { container, used: this.capacity.used() });
  }
  profile(profileId: string): ProfileManifest {
    const profile = this.profiles.get(profileId);
    if (!profile) throw new SupervisorError("unsupported_profile", `Profile ${profileId} is not supported by this supervisor.`);
    return profile;
  }

  /** Idempotent operation wrapper: same id + digest replays; different digest conflicts. */
  async withOperation(operation: Operation, kind: string, fn: () => Promise<OperationResponse>): Promise<OperationResponse> {
    const startedAt = Date.now();
    const begin = this.journal.beginOperation(operation, kind);
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
    const requested = Date.parse(absoluteDeadline);
    const now = Date.now();
    if (!Number.isFinite(requested) || requested <= now) {
      throw new SupervisorError("invalid_body", "absoluteDeadline must be in the future.");
    }
    return new Date(Math.min(requested, now + caps.attemptTimeoutMs)).toISOString();
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
    if (!this.config.runtimeImageId && /^sha256:[a-f0-9]{64}$/.test(result.detail.image)) this.host.check.runtimeImageId = result.detail.image;
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
  async teardownRecord(labelFilters: string[]): Promise<TeardownRecord> {
    const [containers, volumes] = await Promise.all([this.api.listContainers(labelFilters), this.api.listVolumes(labelFilters)]);
    const containersRemaining = containers.map((c) => c.name).sort();
    const volumesRemaining = volumes.map((v) => v.name).sort();
    const host = await this.hostListing();
    return {
      destroyedAt: new Date().toISOString(),
      containersRemaining,
      volumesRemaining,
      clean: containersRemaining.length === 0 && volumesRemaining.length === 0,
      host,
    };
  }

  /**
   * Every Airlock-owned container and volume on this Docker host, by the owner label alone (any
   * namespace), so another deployment's or a test's leftovers are not hidden from the listing.
   */
  async hostListing(): Promise<HostListing> {
    const filter = [`${OWNER_LABEL}=true`];
    const [containers, volumes] = await Promise.all([this.api.listContainers(filter), this.api.listVolumes(filter)]);
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
      await this.api.stopContainer(record.container, STOP_SECONDS);
      const detail = await this.api.inspectContainer(record.container);
      if (detail?.state.running) {
        this.journal.updateAttempt(record.attemptId, { status: "unknown" });
        this.log.warn("container still running after stop; marked unknown", { attemptId: record.attemptId, container: record.container, reason });
        return false;
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
    return this.withOperation(body.operation, "createAttempt", async () => {
      if (body.role !== "author" && body.role !== "hostile") {
        throw new SupervisorError("invalid_body", `Role ${body.role} is a one-shot role; use POST /invoke.`);
      }
      const profile = this.profile(body.profileId);
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
        this.checkTaskGeneration(body.ref);
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
        const fail = async (code: "inspection_failed" | "probe_failed" | "internal", message: string, probe?: IsolationProbe) => {
          this.journal.updateAttempt(names.attemptId, { inspection: provisioned.inspection, ...(probe ? { probe } : {}) });
          await this.removeResources(names.container, names.volume);
          this.journal.updateAttempt(names.attemptId, { status: "destroyed", revoked: true });
          this.journal.tombstone(names.attemptId, names.taskId, message);
          throw new SupervisorError(code, message);
        };
        const materialized = await this.materialize(names.container, profile.caps, signal);
        if (materialized.result.status !== "succeeded") {
          await fail("internal", `Materializing the pristine source tree failed (${materialized.result.status}): ${materialized.result.stderr.slice(0, 400)}`);
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
  private checkTaskGeneration(ref: AttemptRef): void {
    for (const other of this.journal.listTaskAttempts(ref.taskId)) {
      if (other.attemptId === ref.attemptId) continue;
      if (ref.generation < other.generation) {
        throw new SupervisorError("stale_generation", `Generation ${ref.generation} is older than generation ${other.generation} already recorded for task ${ref.taskId}.`);
      }
      if (other.status !== "destroyed" && !other.revoked) {
        throw new SupervisorError("fenced", `Attempt ${other.attemptId} (generation ${other.generation}) of task ${ref.taskId} is still live; revoke or destroy it before creating ${ref.attemptId}.`);
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
    return this.withOperation(operation, "renew", () =>
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

  async authorTool(ref: AttemptRef, operation: Operation, args: { kind: "read"; path: string } | { kind: "write"; path: string; content: string } | { kind: "exec"; command: string }): Promise<OperationResponse> {
    this.names(ref, "author");
    return this.withOperation(operation, "authorTool", async () => {
      const record = this.journal.fence(ref);
      if (record.role !== "author") throw new SupervisorError("fenced", `Attempt ${ref.attemptId} is a ${record.role} sandbox; author tools are not available.`);
      if (record.status !== "running") throw new SupervisorError("fenced", `Attempt ${ref.attemptId} is ${record.status}; author tools need a running sandbox.`);
      const profile = this.profile(record.profileId);
      const result = await this.runTool(record, profile, args);
      return { status: 200, body: result };
    });
  }

  private async runTool(record: AttemptRecord, profile: ProfileManifest, args: { kind: "read"; path: string } | { kind: "write"; path: string; content: string } | { kind: "exec"; command: string }): Promise<AuthorToolResult> {
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
      try {
        await this.api.stopContainer(record.container, STOP_SECONDS);
      } catch (error) {
        this.journal.updateAttempt(record.attemptId, { status: "unknown" });
        this.log.warn("stop after quarantine failed", { attemptId: record.attemptId, container: record.container, error });
      }
    });
  }

  // -------------------------------------------------------------------------------------------
  // Freeze / revoke / destroy
  // -------------------------------------------------------------------------------------------

  async freeze(ref: AttemptRef, operation: Operation): Promise<OperationResponse> {
    this.names(ref, "author");
    return this.withOperation(operation, "freeze", () =>
      this.withLock(ref.attemptId, async () => {
        const record = this.journal.fenceLifecycle(ref);
        if (record.role !== "author") throw new SupervisorError("fenced", `Only author attempts can be frozen; ${ref.attemptId} is ${record.role}.`);
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
        // 1. revoke dispatch
        this.journal.revoke(record.attemptId, "revoked");
        this.closeDispatch(record.attemptId);
        // 2. hold the workspace: the collector (a fresh container that has run nothing) mounts the
        //    volume read-only BEFORE the author stops. The workspace is a tmpfs volume whose contents
        //    exist only while a container holds the mount; without the hold, stopping the author would
        //    discard the candidate before it could be collected.
        const { held, envelope } = await this.collect(names, profile, async () => {
          // 3. stop the container
          await this.api.stopContainer(record.container, STOP_SECONDS);
          const stoppedAt = new Date().toISOString();
          // 4. settle outstanding execs and writes. If any did not settle (or a write's effect is
          //    unknown) a late write could still land in the workspace: refuse to collect or seal.
          const settled = await this.settle(record.attemptId);
          if (!settled) {
            this.journal.updateAttempt(record.attemptId, { status: "unknown" });
            this.log.warn("freeze: outstanding operations did not settle; refusing to collect", { attemptId: record.attemptId, container: record.container, uncertainWrite: this.uncertainWrites.has(record.attemptId) });
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
        });
        // 6. collected in the fresh container with the volume read-only
        const result: FreezeResult = { stoppedAt: held.stoppedAt, stopConfirmed: true, outstandingOperationsSettled: held.settled, envelope };
        this.log.info("attempt frozen and collected", { attemptId: record.attemptId, container: record.container, collector: names.collector, stoppedAt: held.stoppedAt, settled: held.settled, files: envelope.files.length, rejected: envelope.rejected.length, bytes: envelope.files.reduce((n, f) => n + f.byteLength, 0) });
        return { status: 200, body: result };
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
  private async collect<T>(names: AttemptNames, profile: ProfileManifest, afterHold: () => Promise<T>): Promise<{ held: T; envelope: FileEnvelope }> {
    const labels = attemptLabels(names, "collector");
    const deadline = new Date(Date.now() + profile.caps.commandTimeoutMs * 2 + 60_000).toISOString();
    this.journal.insertEphemeral({ container: names.collector, volume: null, taskId: names.taskId, operationId: `collect-${names.attemptId}`, role: "collector", deadline, createdAt: new Date().toISOString() });
    try {
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
      const outputBytes = Math.ceil(profile.caps.maxTotalBytes * 1.4) + 65_536 + profile.caps.maxFiles * 2048;
      const outcome = await runExec(
        this.api,
        names.collector,
        {
          cmd: timedCommand(["/usr/local/bin/python", "-I", "-S", COLLECTOR, "--root", "/candidate/src", "--profile", PROFILE_JSON], profile.caps.commandTimeoutMs / 1000),
          user: SANDBOX_USER,
          workingDir: "/",
        },
        { timeoutMs: profile.caps.commandTimeoutMs + SUPERVISOR_GRACE_MS, outputBytes },
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
      const parsed = FileEnvelope.safeParse(raw);
      if (!parsed.success) throw new SupervisorError("internal", `Collector envelope does not validate: ${parsed.error.issues[0]?.message ?? "unknown"}`);
      return { held, envelope: parsed.data };
    } finally {
      await this.removeResources(names.collector);
      this.journal.deleteEphemeral(names.collector);
    }
  }

  async revoke(ref: AttemptRef, operation: Operation): Promise<OperationResponse> {
    this.names(ref, "author");
    return this.withOperation(operation, "revoke", () =>
      this.withLock(ref.attemptId, async () => {
        const record = this.journal.fenceLifecycle(ref, { allowNewer: true });
        const current = this.journal.getAttempt(record.attemptId);
        if (!current || current.status === "destroyed") throw new SupervisorError("revoked", `Attempt ${record.attemptId} was destroyed.`);
        this.journal.revoke(record.attemptId, current.status === "stopped" ? "stopped" : "revoked");
        this.closeDispatch(record.attemptId);
        await this.api.stopContainer(record.container, STOP_SECONDS);
        const detail = await this.api.inspectContainer(record.container);
        if (detail?.state.running) {
          this.journal.updateAttempt(record.attemptId, { status: "unknown" });
          this.log.warn("revoke: container did not stop; termination not confirmed", { attemptId: record.attemptId, container: record.container });
          throw new SupervisorError("docker_unavailable", `Container ${record.container} did not stop; termination is not confirmed.`);
        }
        const state = this.journal.getAttempt(record.attemptId);
        this.log.info("attempt revoked and stopped", { attemptId: record.attemptId, container: record.container, status: state?.status ?? current.status });
        return { status: 200, body: attemptStateOf(state ?? current) };
      }),
    );
  }

  async destroy(ref: AttemptRef, operation: Operation): Promise<OperationResponse> {
    this.names(ref, "author");
    return this.withOperation(operation, "destroy", () =>
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
        this.revokeSignals.delete(record.attemptId);
        const result: DestroyResult = { teardown };
        this.log.info(teardown.clean ? "attempt destroyed" : "attempt teardown incomplete", { attemptId: record.attemptId, container: names.container, volume: names.volume, containersRemaining: teardown.containersRemaining, volumesRemaining: teardown.volumesRemaining });
        return { status: 200, body: result };
      }),
    );
  }

  private async destroyResources(names: AttemptNames): Promise<TeardownRecord> {
    await this.removeResources(names.collector);
    await this.removeResources(names.container, names.volume);
    return this.teardownRecord(ownedFilter(this.config.namespace, { taskId: names.taskId, attemptId: names.attemptId }));
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
        const detail = await this.api.inspectContainer(current.container);
        if (!detail?.state.running) return;
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
          : attempt !== undefined && live.has(attempt) && live.get(attempt)?.container === container.name;
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
