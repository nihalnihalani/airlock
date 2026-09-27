/**
 * In-memory SupervisorClient for tests. Models attempts, author tools, freeze envelopes, invoke
 * observations (decided by the test's `observe` function) and teardown bookkeeping. Nothing here
 * executes anything.
 */
import { createHash } from "node:crypto";
import type {
  AdapterRequest,
  AttemptRef,
  AttemptState,
  AuthorToolArgs,
  AuthorToolResult,
  BlastRadiusCard,
  CandidateBundle,
  ExecResult,
  HostCheck,
  InvokeResult,
  IsolationProbe,
  Observation,
  Operation,
  RuntimeInspection,
  SandboxRole,
  TeardownRecord,
} from "@airlock/contracts";
import type { LoadedProfile } from "../../src/profiles.ts";
import {
  SupervisorError,
  SupervisorFenceError,
  SupervisorNotFoundError,
  type CallOptions,
  type DestroyResult,
  type FreezeResult,
  type HealthResponse,
  type SupervisorClient,
} from "../../src/supervisor-client.ts";

const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

export function fakeHost(overrides: Partial<HostCheck> = {}): HostCheck {
  return {
    checkedAt: new Date().toISOString(),
    dockerVersion: "fake-27",
    cpuVirtualization: true,
    kvmPresent: false,
    kvmReadWrite: false,
    availableRuntimes: ["runc"],
    selectedRuntime: "runc",
    devUnsafe: true,
    ...overrides,
  };
}

export function fakeInspection(container: string, overrides: Partial<RuntimeInspection> = {}): RuntimeInspection {
  return {
    inspectedAt: new Date().toISOString(),
    container,
    runtime: "runc",
    devUnsafe: true,
    imageDigest: "sha256:fakeimage",
    guestUname: "Linux fake 6.1.0 #1 SMP x86_64",
    guestHostname: container,
    checks: {
      networkNone: true,
      nonRootUser: true,
      readOnlyRootfs: true,
      capDropAll: true,
      noNewPrivileges: true,
      pidsLimited: true,
      memoryLimited: true,
      cpuLimited: true,
      noHostBinds: true,
      noPorts: true,
      privateIpc: true,
      restartDisabled: true,
      ownedLabels: true,
    },
    allPassed: true,
    ...overrides,
  };
}

export function fakeProbe(allBlocked = true): IsolationProbe {
  const r = allBlocked ? "BLOCKED" : "REACHED";
  return { probedAt: new Date().toISOString(), metadataEndpoint: r, dns: r, outboundTcp: r, dockerSocket: "BLOCKED", hostMounts: "BLOCKED", allBlocked };
}

export function okExec(overrides: Partial<ExecResult> = {}): ExecResult {
  return { status: "succeeded", exitCode: 0, stdout: "", stderr: "", truncated: false, timedOut: false, durationMs: 5, ...overrides };
}

function cleanTeardown(): TeardownRecord {
  return { destroyedAt: new Date().toISOString(), containersRemaining: [], volumesRemaining: [], clean: true };
}

export interface FakeAttempt {
  ref: AttemptRef;
  role: SandboxRole;
  container: string;
  status: AttemptState["status"];
  files: Map<string, string>;
  deadline: string;
  /** Execution authorization (M1); absent = until the deadline. Expiry stops dispatch like revocation. */
  authorizedUntil?: string;
}

export interface FakeSupervisorOptions {
  profile: LoadedProfile;
  /** Decide adapter observations for an invocation. */
  observe: (role: "baseline" | "candidate" | "preview", files: Map<string, string>, request: AdapterRequest) => Observation[] | { exec: Partial<ExecResult>; observations: Observation[]; protocolErrors?: string[] };
  /** Author exec behaviour. Default: succeed with stdout "ran <command>". */
  exec?: (command: string, files: Map<string, string>, signal?: AbortSignal) => Promise<ExecResult>;
  /** Runs at the start of every one-shot invocation (before observations are produced); may delay it. */
  beforeInvoke?: (role: "baseline" | "candidate" | "preview", input: { taskId: string }) => Promise<void>;
  probeBlocked?: boolean;
  inspectionPassed?: boolean;
  freezeConfirmed?: boolean;
  host?: HostCheck;
  /** Runs for every mutating call after the caller's `beforeSend` hook and before the call acts. */
  onDispatch?: (kind: string, operation: Operation) => Promise<void> | void;
  /** Freeze envelope `rejected` entries (collector rejections) to add. */
  freezeRejected?: (files: Map<string, string>) => { path: string; reason: string }[];
}

export class FakeSupervisor implements SupervisorClient {
  /** Live attempts. Destroyed ones move to `tombstones`, as the real journal keeps them. */
  readonly attempts = new Map<string, FakeAttempt>();
  readonly tombstones = new Map<string, AttemptState>();
  readonly destroyed: string[] = [];
  readonly revoked: string[] = [];
  readonly invocations: { role: string; bundleDigest?: string; caseIds: string[] }[] = [];
  readonly toolCalls: { attemptId: string; args: AuthorToolArgs }[] = [];
  readonly hostileCommands: string[] = [];
  readonly createdAttempts: { attemptId: string; authorizedUntil?: string; absoluteDeadline: string }[] = [];
  readonly renewals: { attemptId: string; authorizedUntil: string; at: number }[] = [];
  /** Every mutating call in dispatch order, with the operation id its caller journaled. */
  readonly operations: { kind: string; operationId: string; attemptId?: string }[] = [];
  private operationCounter = 0;
  hostCheck: HostCheck;

  constructor(private readonly options: FakeSupervisorOptions) {
    this.hostCheck = options.host ?? fakeHost();
  }

  async health(): Promise<HealthResponse> {
    return { ok: true };
  }
  async host(): Promise<HostCheck> {
    return this.hostCheck;
  }

  /** Builds the Operation a real client would send, runs the caller's journal hook, then records the dispatch. */
  protected async dispatch(kind: string, body: unknown, opts?: CallOptions, attemptId?: string): Promise<Operation> {
    const operation: Operation = { operationId: opts?.operationId ?? `op-fake-${++this.operationCounter}`, requestDigest: sha(JSON.stringify({ kind, body })) };
    await opts?.beforeSend?.(operation);
    this.operations.push({ kind, operationId: operation.operationId, ...(attemptId ? { attemptId } : {}) });
    await this.options.onDispatch?.(kind, operation);
    return operation;
  }

  /** Authorization expiry (M1): past `authorizedUntil` the attempt is stopped and dispatch refused. */
  private authorized(attempt: FakeAttempt) {
    if (attempt.authorizedUntil && Date.now() > Date.parse(attempt.authorizedUntil) && (attempt.status === "running" || attempt.status === "created")) attempt.status = "stopped";
  }

  private fence(ref: AttemptRef): FakeAttempt {
    if (this.tombstones.has(ref.attemptId)) throw new SupervisorFenceError(`Attempt ${ref.attemptId} was destroyed.`);
    const attempt = this.attempts.get(ref.attemptId);
    if (!attempt) throw new SupervisorNotFoundError(`unknown attempt ${ref.attemptId}`);
    if (attempt.ref.taskId !== ref.taskId) throw new SupervisorNotFoundError("attempt belongs to another task");
    if (attempt.ref.generation !== ref.generation) throw new SupervisorFenceError("stale generation");
    return attempt;
  }

  async createAttempt(input: { ref: AttemptRef; profileId: string; role: SandboxRole; absoluteDeadline: string; authorizedUntil?: string }, opts?: CallOptions): Promise<AttemptState> {
    await this.dispatch("createAttempt", input, opts, input.ref.attemptId);
    this.createdAttempts.push({ attemptId: input.ref.attemptId, absoluteDeadline: input.absoluteDeadline, ...(input.authorizedUntil ? { authorizedUntil: input.authorizedUntil } : {}) });
    if (input.profileId !== this.options.profile.manifest.id) throw new SupervisorFenceError("unknown profile");
    const inspection = fakeInspection(`airlock-${input.ref.attemptId}`, this.options.inspectionPassed === false ? { allPassed: false } : {});
    const probe = fakeProbe(this.options.probeBlocked !== false);
    if (!inspection.allPassed || !probe.allBlocked) throw new SupervisorFenceError("inspection or probe failed; sandbox destroyed");
    const files = new Map<string, string>();
    for (const [path, text] of Object.entries(this.options.profile.baseFiles)) files.set(path, text);
    const attempt: FakeAttempt = { ref: input.ref, role: input.role, container: inspection.container, status: "running", files, deadline: input.absoluteDeadline, ...(input.authorizedUntil ? { authorizedUntil: input.authorizedUntil } : {}) };
    this.attempts.set(input.ref.attemptId, attempt);
    return { ref: input.ref, role: input.role, container: attempt.container, status: "running", inspection, probe, deadline: input.absoluteDeadline, ...(input.authorizedUntil ? { authorizedUntil: input.authorizedUntil } : {}) };
  }

  async renew(input: { ref: AttemptRef; authorizedUntil: string }, opts?: CallOptions): Promise<AttemptState> {
    await this.dispatch("renew", input, opts, input.ref.attemptId);
    const attempt = this.fence(input.ref);
    this.authorized(attempt);
    if (attempt.status !== "running") throw new SupervisorFenceError(`attempt is ${attempt.status}; authorization cannot be renewed`);
    const until = Math.min(Date.parse(input.authorizedUntil), Date.parse(attempt.deadline));
    attempt.authorizedUntil = new Date(until).toISOString();
    this.renewals.push({ attemptId: input.ref.attemptId, authorizedUntil: attempt.authorizedUntil, at: Date.now() });
    return { ref: attempt.ref, role: attempt.role, container: attempt.container, status: attempt.status, deadline: attempt.deadline, authorizedUntil: attempt.authorizedUntil };
  }

  async authorTool(input: { ref: AttemptRef; args: AuthorToolArgs }, opts?: CallOptions): Promise<AuthorToolResult> {
    await this.dispatch("authorTool", input, opts, input.ref.attemptId);
    const attempt = this.fence(input.ref);
    this.authorized(attempt);
    if (attempt.status !== "running") throw new SupervisorFenceError(`attempt is ${attempt.status}`);
    this.toolCalls.push({ attemptId: input.ref.attemptId, args: input.args });
    const args = input.args;
    if (args.kind === "read") {
      const content = attempt.files.get(args.path);
      if (content === undefined) return { kind: "refused", reason: `no such file ${args.path}` };
      return { kind: "read", content, truncated: false };
    }
    if (args.kind === "write") {
      attempt.files.set(args.path, args.content);
      return { kind: "write", byteLength: Buffer.byteLength(args.content, "utf8") };
    }
    const exec = this.options.exec ?? (async (command: string) => okExec({ stdout: `ran ${command}` }));
    return { kind: "exec", result: await exec(args.command, attempt.files, opts?.signal) };
  }

  async freeze(input: { ref: AttemptRef }, opts?: CallOptions): Promise<FreezeResult> {
    await this.dispatch("freeze", input, opts, input.ref.attemptId);
    const attempt = this.fence(input.ref);
    attempt.status = "stopped";
    const files = this.options.profile.manifest.allowedReplacementPaths
      .filter((p) => attempt.files.has(p))
      .map((path) => {
        const bytes = Buffer.from(attempt.files.get(path)!, "utf8");
        return { path, byteLength: bytes.byteLength, sha256: sha(bytes), contentBase64: bytes.toString("base64") };
      });
    return {
      stoppedAt: new Date().toISOString(),
      stopConfirmed: this.options.freezeConfirmed !== false,
      outstandingOperationsSettled: this.options.freezeConfirmed !== false,
      envelope: { schemaVersion: 1, files, rejected: this.options.freezeRejected?.(attempt.files) ?? [] },
    };
  }

  async revoke(input: { ref: AttemptRef }, opts?: CallOptions): Promise<AttemptState> {
    await this.dispatch("revoke", input, opts, input.ref.attemptId);
    const attempt = this.fence(input.ref);
    attempt.status = "revoked";
    this.revoked.push(input.ref.attemptId);
    return { ref: attempt.ref, role: attempt.role, container: attempt.container, status: "revoked", deadline: attempt.deadline };
  }

  async destroy(input: { ref: AttemptRef }, opts?: CallOptions): Promise<DestroyResult> {
    await this.dispatch("destroy", input, opts, input.ref.attemptId);
    const attempt = this.fence(input.ref);
    this.attempts.delete(input.ref.attemptId);
    this.tombstones.set(input.ref.attemptId, { ref: attempt.ref, role: attempt.role, container: attempt.container, status: "destroyed", deadline: attempt.deadline });
    this.destroyed.push(input.ref.attemptId);
    return { teardown: cleanTeardown() };
  }

  async getAttempt(attemptId: string): Promise<AttemptState> {
    const gone = this.tombstones.get(attemptId);
    if (gone) return gone;
    const attempt = this.attempts.get(attemptId);
    if (!attempt) throw new SupervisorNotFoundError("unknown attempt");
    return { ref: attempt.ref, role: attempt.role, container: attempt.container, status: attempt.status, deadline: attempt.deadline, ...(attempt.authorizedUntil ? { authorizedUntil: attempt.authorizedUntil } : {}) };
  }
  async listAttempts(): Promise<AttemptState[]> {
    return [...this.attempts.keys()].map((id) => ({ ...this.attemptsSnapshot(id) }));
  }
  private attemptsSnapshot(id: string): AttemptState {
    const a = this.attempts.get(id)!;
    return { ref: a.ref, role: a.role, container: a.container, status: a.status, deadline: a.deadline };
  }

  async invoke(input: {
    taskId: string;
    profileId: string;
    role: "baseline" | "candidate" | "preview";
    bundle?: CandidateBundle;
    request: AdapterRequest;
    absoluteDeadline: string;
  }, opts?: CallOptions): Promise<InvokeResult> {
    await this.dispatch("invoke", { ...input, bundle: input.bundle?.candidateDigest }, opts);
    // Like HttpSupervisorClient: an aborted signal drops the client side of the call only; the
    // supervisor-side run (modelled by beforeInvoke) carries on regardless.
    if (this.options.beforeInvoke) {
      const run = this.options.beforeInvoke(input.role, { taskId: input.taskId });
      const aborted = new Promise<never>((_, reject) => {
        if (opts?.signal?.aborted) reject(new SupervisorError("Call aborted", 0));
        opts?.signal?.addEventListener("abort", () => reject(new SupervisorError("Call aborted", 0)), { once: true });
      });
      await (opts?.signal ? Promise.race([run, aborted]) : run);
    }
    const files = new Map<string, string>();
    for (const [path, text] of Object.entries(this.options.profile.baseFiles)) files.set(path, text);
    if (input.role !== "baseline") {
      if (!input.bundle) throw new SupervisorFenceError("bundle required");
      for (const f of input.bundle.files) {
        const bytes = Buffer.from(f.contentBase64, "base64");
        if (sha(bytes) !== f.sha256) throw new SupervisorFenceError(`file digest mismatch for ${f.path}`);
        files.set(f.path, bytes.toString("utf8"));
      }
    }
    this.invocations.push({ role: input.role, ...(input.bundle ? { bundleDigest: input.bundle.candidateDigest } : {}), caseIds: input.request.cases.map((c) => c.id) });
    const decided = this.options.observe(input.role, files, input.request);
    const observations = Array.isArray(decided) ? decided : decided.observations;
    const exec = okExec({ stdout: observations.map((o) => JSON.stringify(o)).join("\n"), ...(Array.isArray(decided) ? {} : decided.exec) });
    const container = `airlock-${input.role}-${this.invocations.length}`;
    return {
      operationId: `op-fake-${this.invocations.length}`,
      role: input.role,
      container,
      inspection: fakeInspection(container),
      exec,
      observations,
      protocolErrors: Array.isArray(decided) ? [] : (decided.protocolErrors ?? []),
      teardown: cleanTeardown(),
    };
  }

  async hostile(input: { profileId: string; command: string }): Promise<BlastRadiusCard> {
    this.hostileCommands.push(input.command);
    const container = `airlock-hostile-${this.hostileCommands.length}`;
    return {
      operationId: `op-hostile-${this.hostileCommands.length}`,
      container,
      inspection: fakeInspection(container),
      exec: okExec({ status: "failed", exitCode: 137, stderr: "Killed" }),
      died: { container, runtime: "runc", guestUname: "Linux fake", reason: "command terminated" },
      survived: { supervisorHealthy: true, hostSentinelUnchanged: true, otherAttemptsRunning: this.attempts.size, hostUptimeSeconds: 100 },
      teardown: cleanTeardown(),
    };
  }
}
