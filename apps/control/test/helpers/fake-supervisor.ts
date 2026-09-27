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
  BrowserEvidence,
  BrowserAnyOp,
  BrowserOpResult,
  BrowserResponse,
  CandidateBundle,
  CollectOutputsResult,
  EgressLog,
  ExecResult,
  HostCheck,
  HostListing,
  InvokeResult,
  IsolationProbe,
  Observation,
  Operation,
  RuntimeInspection,
  SandboxRole,
  TeardownRecord,
} from "@airlock/contracts";
import type { LoadedProfile } from "../../src/profiles.ts";
import { encodePng } from "../../src/png.ts";
import { hostAllowed } from "../../src/task-profiles.ts";
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
    imageId: "sha256:fakeimage",
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

function cleanTeardown(host?: HostListing): TeardownRecord {
  return { destroyedAt: new Date().toISOString(), containersRemaining: [], volumesRemaining: [], clean: true, ...(host ? { host } : {}) };
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
  /** Binary files (put inputs, outputs a fake exec writes); wins over `files` on collection. */
  binary: Map<string, Uint8Array>;
  egressAllow?: string[];
  /** Browser role: the simulated runner's state. */
  browser?: { generation: number; url: string | null; allowed: number; denied: number };
}

/** A page the fake browser serves for a URL (exact match after dropping the fragment). */
export interface FakePage {
  title: string;
  text: string;
  controls?: { ref: string; role: string; name: string }[];
  status?: number;
}

export const FAKE_SCREENSHOT = encodePng(4, 3, [200, 30, 30]);

export interface FakeSupervisorOptions {
  profile: LoadedProfile;
  /** Decide adapter observations for an invocation. */
  observe: (role: "baseline" | "candidate" | "preview", files: Map<string, string>, request: AdapterRequest) => Observation[] | { exec: Partial<ExecResult>; observations: Observation[]; protocolErrors?: string[] };
  /** Author exec behaviour. Default: succeed with stdout "ran <command>". */
  exec?: (command: string, files: Map<string, string>, signal?: AbortSignal, attempt?: FakeAttempt) => Promise<ExecResult>;
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
  /** Overrides applied to every inspection this fake reports (runtime, devUnsafe, imageId…). */
  inspection?: Partial<RuntimeInspection>;
  /** Host-wide listing attached to every teardown record (destroy, invoke, hostile). */
  teardownHost?: () => HostListing;
  /** Pages the simulated browser runner serves (browser role). */
  pages?: Record<string, FakePage>;
  /** Scripted browser replies: return a result to override the simulated runner, or undefined to fall through. */
  browserOp?: (attempt: FakeAttempt, request: BrowserAnyOp, callIndex: number) => BrowserOpResult | undefined | Promise<BrowserOpResult | undefined>;
  /** Collect-outputs: extra collector rejections, and whether the stop is confirmed (default true). */
  collectRejected?: (attempt: FakeAttempt) => { path: string; reason: string }[];
  collectStopConfirmed?: boolean;
  /** Make destroy fail (docker error) for matching attempts; the attempt stays live. */
  destroyFails?: (attempt: FakeAttempt) => boolean;
  /** Refuse createAttempt for a role the way the real supervisor does (status + machine-readable code). */
  createRefusal?: (role: SandboxRole) => { status: number; code: string; message: string } | undefined;
  /** Browser evidence override (e.g. a --no-sandbox Chromium). */
  browserEvidence?: Partial<BrowserEvidence["status"]["sandbox"]>;
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
  /** Every browser runner request, in order. */
  readonly browserRequests: { attemptId: string; request: BrowserAnyOp }[] = [];
  readonly collected: string[] = [];
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

  async createAttempt(input: { ref: AttemptRef; profileId: string; role: SandboxRole; absoluteDeadline: string; authorizedUntil?: string; egressAllow?: string[] }, opts?: CallOptions): Promise<AttemptState> {
    await this.dispatch("createAttempt", input, opts, input.ref.attemptId);
    this.createdAttempts.push({ attemptId: input.ref.attemptId, absoluteDeadline: input.absoluteDeadline, ...(input.authorizedUntil ? { authorizedUntil: input.authorizedUntil } : {}) });
    const refusal = this.options.createRefusal?.(input.role);
    if (refusal) {
      const error = refusal.status === 409 ? new SupervisorFenceError(`supervisor 409: ${refusal.message}`) : new SupervisorError(`supervisor ${refusal.status}: ${refusal.message}`, refusal.status);
      error.code = refusal.code;
      throw error;
    }
    const general = input.role === "browser" || input.role === "analysis" || input.role === "node";
    if (general ? input.profileId !== input.role : input.profileId !== this.options.profile.manifest.id) throw new SupervisorFenceError("unknown profile");
    if (input.egressAllow && input.role !== "browser") throw new SupervisorError("egressAllow is for browser attempts only", 400);
    const inspection = fakeInspection(`airlock-${input.ref.attemptId}`, { ...(this.options.inspection ?? {}), ...(this.options.inspectionPassed === false ? { allPassed: false } : {}) });
    const probe = fakeProbe(this.options.probeBlocked !== false);
    if (!inspection.allPassed || !probe.allBlocked) throw new SupervisorFenceError("inspection or probe failed; sandbox destroyed");
    const files = new Map<string, string>();
    if (!general) for (const [path, text] of Object.entries(this.options.profile.baseFiles)) files.set(path, text);
    const attempt: FakeAttempt = {
      ref: input.ref,
      role: input.role,
      container: inspection.container,
      status: "running",
      files,
      binary: new Map(),
      deadline: input.absoluteDeadline,
      ...(input.authorizedUntil ? { authorizedUntil: input.authorizedUntil } : {}),
      ...(input.egressAllow ? { egressAllow: input.egressAllow } : {}),
      ...(input.role === "browser" ? { browser: { generation: 0, url: null, allowed: 0, denied: 0 } } : {}),
    };
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
    if (args.kind === "put") {
      if (!args.path.startsWith("inputs/")) return { kind: "refused", reason: "put is only allowed under inputs/" };
      const bytes = Buffer.from(args.contentBase64, "base64");
      attempt.files.set(args.path, bytes.toString("utf8"));
      attempt.binary.set(args.path, new Uint8Array(bytes));
      return { kind: "put", byteLength: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") };
    }
    const exec = this.options.exec ?? (async (command: string) => okExec({ stdout: `ran ${command}` }));
    return { kind: "exec", result: await exec(args.command, attempt.files, opts?.signal, attempt) };
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
    if (this.options.destroyFails?.(attempt)) throw new SupervisorError("docker: container removal failed", 500);
    this.attempts.delete(input.ref.attemptId);
    this.tombstones.set(input.ref.attemptId, { ref: attempt.ref, role: attempt.role, container: attempt.container, status: "destroyed", deadline: attempt.deadline });
    this.destroyed.push(input.ref.attemptId);
    return { teardown: cleanTeardown(this.options.teardownHost?.()), ...(attempt.browser ? { egressSummary: { allowed: attempt.browser.allowed, denied: attempt.browser.denied } } : {}) };
  }

  async browserOp(input: { ref: AttemptRef; request: BrowserAnyOp }, opts?: CallOptions): Promise<BrowserOpResult> {
    await this.dispatch("browserOp", input, opts, input.ref.attemptId);
    const attempt = this.fence(input.ref);
    this.authorized(attempt);
    if (attempt.role !== "browser" || !attempt.browser) throw new SupervisorFenceError(`attempt ${attempt.ref.attemptId} is not a browser attempt`);
    if (attempt.status !== "running") throw new SupervisorFenceError(`attempt is ${attempt.status}`);
    this.browserRequests.push({ attemptId: attempt.ref.attemptId, request: input.request });
    const scripted = await this.options.browserOp?.(attempt, input.request, this.browserRequests.length - 1);
    if (scripted) {
      if (scripted.status === "interrupted") attempt.status = "stopped";
      return scripted;
    }
    const b = attempt.browser;
    const generationBefore = b.generation;
    const ok = (result: unknown): BrowserOpResult => ({ response: { schemaVersion: 1, id: null, op: input.request.op, ok: true, result }, status: "completed", durationMs: 3, generationBefore });
    const fail = (error: Extract<BrowserResponse, { ok: false }>["error"], message: string): BrowserOpResult => ({ response: { schemaVersion: 1, id: null, op: input.request.op, ok: false, error, message }, status: "completed", durationMs: 3, generationBefore });
    const page = (url: string | null) => (url ? this.options.pages?.[url.split("#")[0]!] : undefined);
    const req = input.request;
    switch (req.op) {
      case "navigate": {
        const host = new URL(req.args.url).hostname;
        if (!hostAllowed(host, attempt.egressAllow ?? [])) {
          b.denied += 1;
          return fail("navigation_failed", "net::ERR_TUNNEL_CONNECTION_FAILED");
        }
        b.allowed += 1;
        b.generation += 1;
        b.url = req.args.url;
        return ok({ generation: b.generation, tabId: "tab-1", url: req.args.url, status: page(req.args.url)?.status ?? (page(req.args.url) ? 200 : 404) });
      }
      case "observe": {
        b.generation += 1;
        const p = page(b.url);
        return ok({ generation: b.generation, tabId: "tab-1", url: b.url ?? "about:blank", title: p?.title ?? "", text: p?.text ?? "", textTruncated: false, controls: p?.controls ?? [], controlsTruncated: false, tabs: [{ tabId: "tab-1", url: b.url ?? "about:blank", title: p?.title ?? "", active: true }], events: [], droppedEvents: 0, pendingReview: false });
      }
      case "click":
      case "type":
      case "key":
        if (req.args.generation !== b.generation) return fail("stale_reference", "ref/generation is not from the latest observe of the active tab");
        return ok({ generation: b.generation, invalidated: false, url: b.url ?? "about:blank" });
      case "scroll":
        return ok({ generation: b.generation, url: b.url ?? "about:blank" });
      case "screenshot":
        return ok({ png: Buffer.from(FAKE_SCREENSHOT).toString("base64"), bytes: FAKE_SCREENSHOT.byteLength, width: 4, height: 3, sha256: sha(FAKE_SCREENSHOT), url: b.url ?? "about:blank", tabId: "tab-1", generation: b.generation, capturedAt: new Date().toISOString() });
      case "tabs.list":
        return ok({ generation: b.generation, activeTabId: "tab-1", tabs: [{ tabId: "tab-1", url: b.url ?? "about:blank", title: page(b.url)?.title ?? "", active: true }] });
      case "tabs.switch":
      case "tabs.close":
        return fail("tab_not_found", `no tab ${req.args.tabId}`);
      default:
        return ok({ ready: true });
    }
  }

  async browserEvidence(attemptId: string): Promise<BrowserEvidence> {
    const attempt = this.attempts.get(attemptId);
    if (!attempt || attempt.role !== "browser") throw new SupervisorNotFoundError("No browser evidence for this attempt.");
    return {
      status: { ready: true, browserVersion: "fake-chromium-1", generation: 0, activeTabId: null, tabCount: 0, uid: 1000, proxy: "http://egress:3128", sandbox: { chromiumProcesses: 3, anyNoSandboxFlag: false, zygotePresent: true, renderersInNestedPidNamespace: true, renderers: 1, ...(this.options.browserEvidence ?? {}) } },
      browserInspection: fakeInspection(attempt.container, this.options.inspection ?? {}),
      egressInspection: fakeInspection(`${attempt.container}-egress`, this.options.inspection ?? {}),
      networks: { internal: `airlock-int-${attemptId}`, egress: `airlock-egr-${attemptId}` },
      egressAllow: attempt.egressAllow ?? [],
    };
  }

  async egressLog(attemptId: string): Promise<EgressLog> {
    const attempt = this.attempts.get(attemptId);
    if (!attempt?.browser) throw new SupervisorNotFoundError("No browser attempt with egress evidence.");
    return { decisions: [], summary: { allowed: attempt.browser.allowed, denied: attempt.browser.denied } };
  }

  async collectOutputs(input: { ref: AttemptRef }, opts?: CallOptions): Promise<CollectOutputsResult> {
    await this.dispatch("collectOutputs", input, opts, input.ref.attemptId);
    const attempt = this.fence(input.ref);
    if (attempt.role !== "analysis" && attempt.role !== "node") throw new SupervisorFenceError(`only analysis/node attempts can be collected; ${attempt.ref.attemptId} is ${attempt.role}`);
    attempt.status = "stopped";
    this.collected.push(attempt.ref.attemptId);
    const byPath = new Map<string, Uint8Array>();
    for (const [path, text] of attempt.files) if (path.startsWith("outputs/")) byPath.set(path, new Uint8Array(Buffer.from(text, "utf8")));
    for (const [path, bytes] of attempt.binary) if (path.startsWith("outputs/")) byPath.set(path, bytes);
    const rejected = this.options.collectRejected?.(attempt) ?? [];
    const mediaType = (p: string) => (p.endsWith(".png") ? "image/png" : p.endsWith(".json") ? "application/json" : p.endsWith(".csv") ? "text/csv" : "text/plain");
    const files = [...byPath]
      .map(([path, bytes]) => ({ path: path.slice("outputs/".length), bytes }))
      .filter((f) => !rejected.some((r) => r.path === f.path))
      .sort((a, b) => (a.path < b.path ? -1 : 1))
      .map((f) => ({ path: f.path, byteLength: f.bytes.byteLength, sha256: sha(f.bytes), mediaType: mediaType(f.path), contentBase64: Buffer.from(f.bytes).toString("base64") }));
    return { stoppedAt: new Date().toISOString(), stopConfirmed: this.options.collectStopConfirmed !== false, envelope: { schemaVersion: 1, files, rejected } };
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
      inspection: fakeInspection(container, this.options.inspection ?? {}),
      exec,
      observations,
      protocolErrors: Array.isArray(decided) ? [] : (decided.protocolErrors ?? []),
      teardown: cleanTeardown(this.options.teardownHost?.()),
    };
  }

  async hostile(input: { profileId: string; command: string }): Promise<BlastRadiusCard> {
    this.hostileCommands.push(input.command);
    const container = `airlock-hostile-${this.hostileCommands.length}`;
    return {
      operationId: `op-hostile-${this.hostileCommands.length}`,
      container,
      inspection: fakeInspection(container, this.options.inspection ?? {}),
      exec: okExec({ status: "failed", exitCode: 137, stderr: "Killed" }),
      died: { container, runtime: "runc", guestUname: "Linux fake", reason: "command terminated" },
      survived: { supervisorHealthy: true, hostSentinelUnchanged: true, otherAttemptsRunning: this.attempts.size, hostUptimeSeconds: 100 },
      teardown: cleanTeardown(this.options.teardownHost?.()),
    };
  }
}
