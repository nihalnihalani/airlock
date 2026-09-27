/**
 * Attempt lifecycle: create → tools → freeze/revoke → destroy, plus deadlines and the janitor.
 *
 * Ordering rules (research/37 "Cancellation, recovery and identity", CLAUDE.md §3.5):
 *   - record before dispatch: the journal row exists before any Docker side effect;
 *   - freeze: revoke → stop (t=2) → settle outstanding execs → re-inspect stopped → collect in a
 *     fresh container with the volume read-only;
 *   - every start/exec re-checks the fence immediately before the side effect;
 *   - lost control over a command stops the whole container (OpenMuse quarantine);
 *   - failed teardown stays visible (`unknown`) and the identity is tombstoned so nothing can
 *     resurrect it.
 */
import {
  type AttemptRef,
  type AttemptState,
  type AuthorToolResult,
  type Caps,
  FileEnvelope,
  type FreezeResult,
  type IsolationProbe,
  type Operation,
  type ProfileManifest,
  type RuntimeInspection,
  type SandboxRole,
  type TeardownRecord,
  workspaceBytesOf,
} from "@airlock/contracts";
import type { SupervisorConfig } from "./config";
import type { CreateAttemptRequest, DestroyResult } from "./types";
import type { DockerApi } from "./docker-api";
import { SupervisorError, describe } from "./errors";
import { SANDBOX_USER, SUPERVISOR_GRACE_MS, authorCommand, runExec, timedCommand } from "./exec";
import type { HostReport } from "./host";
import { type AttemptNames, attemptLabels, attemptNames, ours, ownedFilter, ATTEMPT_LABEL, OPERATION_LABEL, ROLE_LABEL, TASK_LABEL } from "./names";
import { type AttemptRecord, Journal, attemptStateOf } from "./operations";
import { createLogger, log, type Logger } from "./log";
import { runProbe } from "./probe";
import { type ExpectedSandbox, InspectionFailed, type SandboxSpec, inspectSandbox, sandboxCreateSpec, workspaceDriverOpts, workspaceVolumeBounded } from "./runtime";
import { ancestorDirs, createTar } from "./tar";

export const MATERIALIZE = "/opt/airlock/materialize.py";
export const COLLECTOR = "/opt/airlock/collector.py";
export const PROFILE_JSON = "/opt/airlock/profile/profile.json";
const STOP_SECONDS = 2;
const SETTLE_MS = 20_000;
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
  private readonly log: Logger;
  private readonly outstanding = new Map<string, Set<Promise<unknown>>>();
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
    this.log = typeof deps.log === "function" ? createLogger({ app: "supervisor", level: "debug", write: (line) => (deps.log as (line: string) => void)(line) }) : (deps.log ?? log);
  }

  // -------------------------------------------------------------------------------------------
  // Startup / shutdown
  // -------------------------------------------------------------------------------------------

  async start(): Promise<void> {
    const interrupted = this.journal.interruptPendingOperations();
    if (interrupted > 0) this.log.warn("marked pending operations as interrupted after restart", { interrupted });
    await this.reconcile();
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

  /** Journal vs Docker: a live attempt whose container is gone becomes unknown; revoked ones are stopped. */
  private async reconcile(): Promise<void> {
    const startedAt = Date.now();
    const seen = { attempts: 0, missing: 0, stopped: 0, rearmed: 0 };
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
      if (record.revoked || record.deadline < new Date().toISOString()) {
        if (detail.state.running) await this.api.stopContainer(record.container, STOP_SECONDS);
        if (!record.revoked) this.journal.revoke(record.attemptId, "revoked");
        seen.stopped += 1;
        continue;
      }
      if (record.status === "running" && !detail.state.running) {
        // It stopped while nobody was watching: nothing may dispatch into it again.
        this.journal.revoke(record.attemptId, "unknown");
        this.log.warn("attempt container stopped while unobserved; dispatch closed", { attemptId: record.attemptId, container: record.container });
        continue;
      }
      this.armDeadline(record);
      seen.rearmed += 1;
    }
    this.log.debug("reconcile pass", { ...seen, durationMs: Date.now() - startedAt });
  }

  // -------------------------------------------------------------------------------------------
  // Shared helpers
  // -------------------------------------------------------------------------------------------

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

  /** Create volume (optional) + container, start it, inspect the effective config, fail closed. */
  async provision(request: ProvisionRequest): Promise<Provisioned> {
    const expected = this.expectedFor(request);
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
      this.log.debug("sandbox provisioned", { container: request.container, volume: request.volume, image: request.profile.runtimeImage, runtime: inspection.runtime, devUnsafe: inspection.devUnsafe, allPassed: inspection.allPassed, guestHostname: inspection.guestHostname, mount: request.mount });
      return { inspection, expected, guest: { uname: inspection.guestUname, hostname: inspection.guestHostname } };
    } catch (error) {
      this.log.warn("sandbox provisioning failed; removing its resources", { container: request.container, volume: request.volume, error });
      await this.removeResources(request.container, volumeCreated ? request.volume : undefined);
      throw error;
    }
  }

  inspect(expected: ExpectedSandbox, options: { requireRunning: boolean; previousGuest?: { uname: string; hostname: string } }) {
    return inspectSandbox(
      this.api,
      expected,
      {
        namespace: this.config.namespace,
        configuredRuntime: this.config.runtime,
        devUnsafe: this.config.devUnsafe,
        defaultRuntime: this.host.defaultRuntime,
      },
      options,
    );
  }

  /** Force-remove a container and (optionally) a volume; never throws. */
  async removeResources(container: string, volume?: string): Promise<void> {
    const startedAt = Date.now();
    try {
      await this.api.removeContainer(container, true);
    } catch (error) {
      this.log.warn("remove container failed", { container, error });
    }
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

  /** Checkpoint 5: list what the supervisor still owns under these labels. */
  async teardownRecord(labelFilters: string[]): Promise<TeardownRecord> {
    const [containers, volumes] = await Promise.all([this.api.listContainers(labelFilters), this.api.listVolumes(labelFilters)]);
    const containersRemaining = containers.map((c) => c.name).sort();
    const volumesRemaining = volumes.map((v) => v.name).sort();
    return {
      destroyedAt: new Date().toISOString(),
      containersRemaining,
      volumesRemaining,
      clean: containersRemaining.length === 0 && volumesRemaining.length === 0,
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

  private armDeadline(record: AttemptRecord): void {
    if (this.stopped) return;
    const existing = this.deadlineTimers.get(record.attemptId);
    if (existing) clearTimeout(existing);
    const delay = Math.min(Math.max(0, Date.parse(record.deadline) - Date.now()), MAX_TIMER_MS);
    const timer = setTimeout(() => {
      this.log.debug("deadline timer fired", { attemptId: record.attemptId, deadline: record.deadline });
      this.expire(record.attemptId).catch((error) => this.log.error("expire failed", { attemptId: record.attemptId, error }));
    }, delay);
    this.deadlineTimers.set(record.attemptId, timer);
    this.log.debug("deadline armed", { attemptId: record.attemptId, deadline: record.deadline, delayMs: delay });
  }

  /**
   * The absolute deadline: revoke and stop regardless of the caller. Like `revoke`, the stop is
   * confirmed by inspection; a stop that fails or is not confirmed leaves the row `unknown` (visible,
   * dispatch closed) and the janitor keeps retrying the stop (CLAUDE.md §3.5).
   */
  async expire(attemptId: string): Promise<void> {
    await this.withLock(attemptId, async () => {
      const record = this.journal.getAttempt(attemptId);
      if (!record || record.status === "destroyed" || record.revoked) return;
      this.log.info("attempt deadline reached; revoking and stopping", { attemptId, container: record.container, deadline: record.deadline });
      this.journal.revoke(attemptId, "revoked");
      this.closeDispatch(attemptId);
      await this.stopAndConfirm(record, "deadline");
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
      return this.withLock(names.attemptId, async () => {
        if (this.journal.isTombstoned(names.attemptId)) {
          throw new SupervisorError("revoked", `Attempt ${names.attemptId} was destroyed earlier and cannot be resurrected.`);
        }
        if (this.journal.getAttempt(names.attemptId)) throw new SupervisorError("operation_conflict", `Attempt ${names.attemptId} already exists.`);
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
          revoked: false,
          devUnsafe: this.config.devUnsafe,
          createdAt: now,
          updatedAt: now,
        };
        // Record before dispatch.
        this.journal.insertAttempt(record);
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
        const probe = await runProbe(this.api, names.container, "/workspace", signal);
        this.log.debug("isolation probe", { attemptId: names.attemptId, container: names.container, allBlocked: probe.allBlocked, metadataEndpoint: probe.metadataEndpoint, dns: probe.dns, outboundTcp: probe.outboundTcp, dockerSocket: probe.dockerSocket, hostMounts: probe.hostMounts });
        if (!probe.allBlocked) {
          await fail("probe_failed", `Isolation probe not fully BLOCKED (${probeSummary(probe)}); sandbox destroyed and run refused.`, probe);
        }
        // Re-check the fence before handing the sandbox out: the deadline may have passed meanwhile.
        const current = this.journal.getAttempt(names.attemptId);
        if (!current || current.revoked || current.deadline < new Date().toISOString()) {
          await fail("internal", "Attempt deadline passed during preparation.", probe);
        }
        this.journal.updateAttempt(names.attemptId, { status: "running", inspection: provisioned.inspection, probe });
        this.armDeadline({ ...record, status: "running" });
        this.log.info("attempt running", { attemptId: names.attemptId, taskId: names.taskId, role: body.role, container: names.container, runtime: provisioned.inspection.runtime, devUnsafe: provisioned.inspection.devUnsafe, deadline });
        const state = this.journal.getAttempt(names.attemptId);
        if (!state) throw new SupervisorError("internal", "Attempt vanished from the journal.");
        return { status: 200, body: attemptStateOf(state) };
      });
    });
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
      this.journal.fence({ taskId: record.taskId, attemptId: record.attemptId, generation: record.generation });
      await this.tracked(record.attemptId, () => this.api.putArchive(record.container, tar, sourceRoot));
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

  /** Keep a handle on every in-flight exec so freeze can wait for them. */
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
        const profile = this.profile(record.profileId);
        const current = this.journal.getAttempt(record.attemptId);
        if (!current || current.status === "destroyed" || current.status === "unknown") {
          throw new SupervisorError("fenced", `Attempt ${record.attemptId} is ${current?.status ?? "gone"}; nothing to freeze.`);
        }
        const names = this.names(ref, "author");
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
          // 4. settle outstanding execs
          const settled = await this.settle(record.attemptId);
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
    if (!set || set.size === 0) return true;
    const pending = [...set].map((p) => p.then(() => undefined, () => undefined));
    const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), SETTLE_MS));
    const outcome = await Promise.race([Promise.all(pending).then(() => "settled" as const), timeout]);
    return outcome === "settled";
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
        const record = this.journal.fenceLifecycle(ref);
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
        const record = this.journal.fenceLifecycle(ref);
        const names = this.names(ref, record.role);
        this.journal.revoke(record.attemptId, record.status === "destroyed" ? "destroyed" : "revoked");
        this.closeDispatch(record.attemptId);
        const teardown = await this.destroyResources(names);
        this.journal.updateAttempt(record.attemptId, { status: teardown.clean ? "destroyed" : "unknown" });
        this.journal.tombstone(record.attemptId, record.taskId, teardown.clean ? "destroyed" : "teardown incomplete");
        this.outstanding.delete(record.attemptId);
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

  async janitor(): Promise<{ expired: string[]; destroyed: string[]; removedUnknown: string[] }> {
    const report = { expired: [] as string[], destroyed: [] as string[], removedUnknown: [] as string[] };
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
