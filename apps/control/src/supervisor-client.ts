/**
 * Typed client for the Airlock supervisor HTTP API (apps/supervisor).
 *
 * Every mutating call carries an Operation {operationId, requestDigest}. The digest binds the id to
 * exactly one request body (contracts `requestDigestOf`). Retries after transport failures replay
 * the SAME operationId so the supervisor can return its recorded result instead of acting twice;
 * a 409 (fenced, stale generation, revoked, digest mismatch, inspection failed) is surfaced as a
 * typed `SupervisorFenceError` and never retried.
 */
import { randomBytes } from "node:crypto";
import { z } from "zod";
import {
  AttemptState,
  AuthorToolResult,
  BlastRadiusCard,
  BrowserEvidence,
  BrowserOpResult,
  CollectOutputsResult,
  DestroyResult as DestroyResultSchema,
  EgressLog,
  FreezeResult as FreezeResultSchema,
  HostCheck,
  InvokeResult,
  requestDigestOf,
  type AttemptRef,
  type AdapterRequest,
  type AuthorToolArgs,
  type BrowserOp,
  type CandidateBundle,
  type Operation,
  type SandboxRole,
} from "@airlock/contracts";
import { log } from "./log.ts";

export class SupervisorError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly operationId?: string,
  ) {
    super(message);
    this.name = "SupervisorError";
  }
}
/** 409: fenced, stale generation, revoked, operation digest mismatch or inspection/probe refusal. */
export class SupervisorFenceError extends SupervisorError {
  constructor(message: string, operationId?: string) {
    super(message, 409, operationId);
    this.name = "SupervisorFenceError";
  }
}
/** 404: the supervisor does not know this attempt (already destroyed, reconciled away, or never made). */
export class SupervisorNotFoundError extends SupervisorError {
  constructor(message: string, operationId?: string) {
    super(message, 404, operationId);
    this.name = "SupervisorNotFoundError";
  }
}
/** 503 or transport failure after retries: the supervisor/docker is unavailable. */
export class SupervisorUnavailableError extends SupervisorError {
  constructor(message: string, operationId?: string) {
    super(message, 503, operationId);
    this.name = "SupervisorUnavailableError";
  }
}

/** 429: the execution host has no admission capacity for another sandbox right now. Retryable. */
export class SupervisorCapacityError extends SupervisorError {
  constructor(message: string, operationId?: string) {
    super(message, 429, operationId);
    this.name = "SupervisorCapacityError";
  }
}

/** Unauthenticated liveness only; the host check is on the authenticated `/host`. */
export const HealthResponse = z.object({ ok: z.boolean() });
export type HealthResponse = z.infer<typeof HealthResponse>;

export interface SupervisorClient {
  health(signal?: AbortSignal): Promise<HealthResponse>;
  host(signal?: AbortSignal): Promise<HostCheck>;
  createAttempt(input: CreateAttemptInput, opts?: CallOptions): Promise<AttemptState>;
  /**
   * Extend an attempt's execution authorization (contracts `RenewRequest`). The supervisor never
   * extends past the absolute deadline and never revives a revoked/destroyed attempt: 404/409 mean
   * the authority is gone.
   */
  renew(input: { ref: AttemptRef; authorizedUntil: string }, opts?: CallOptions): Promise<AttemptState>;
  authorTool(input: { ref: AttemptRef; args: AuthorToolArgs }, opts?: CallOptions): Promise<AuthorToolResult>;
  freeze(input: { ref: AttemptRef }, opts?: CallOptions): Promise<FreezeResult>;
  revoke(input: { ref: AttemptRef }, opts?: CallOptions): Promise<AttemptState>;
  destroy(input: { ref: AttemptRef }, opts?: CallOptions): Promise<DestroyResult>;
  getAttempt(attemptId: string, signal?: AbortSignal): Promise<AttemptState>;
  listAttempts(signal?: AbortSignal): Promise<AttemptState[]>;
  invoke(
    input: {
      taskId: string;
      profileId: string;
      role: "baseline" | "candidate" | "preview";
      bundle?: CandidateBundle;
      request: AdapterRequest;
      absoluteDeadline: string;
    },
    opts?: CallOptions,
  ): Promise<InvokeResult>;
  hostile(input: { profileId: string; command: string }, opts?: CallOptions): Promise<BlastRadiusCard>;
  /**
   * One runner operation on a live browser attempt (`POST /attempts/:id/browser`). `interrupted`
   * means the runner was lost: the outcome is unknown, the attempt is closed, never replay it.
   */
  browserOp(input: { ref: AttemptRef; request: BrowserOp }, opts?: CallOptions): Promise<BrowserOpResult>;
  /** What the supervisor established when it created the browser attempt (`GET /attempts/:id/browser`). */
  browserEvidence(attemptId: string, signal?: AbortSignal): Promise<BrowserEvidence>;
  /** The per-attempt egress proxy's decisions (`GET /attempts/:id/egress`). */
  egressLog(attemptId: string, signal?: AbortSignal): Promise<EgressLog>;
  /** Stop an analysis/node sandbox and collect `outputs/` read-only (`POST /attempts/:id/collect-outputs`). */
  collectOutputs(input: { ref: AttemptRef }, opts?: CallOptions): Promise<CollectOutputsResult>;
}

export interface CreateAttemptInput {
  ref: AttemptRef;
  profileId: string;
  role: SandboxRole;
  absoluteDeadline: string;
  authorizedUntil?: string;
  /** Browser role only: destinations the attempt's egress proxy allows (from task policy, never from the model). */
  egressAllow?: string[];
}

export interface CallOptions {
  signal?: AbortSignal;
  /** Replay an earlier operation id (idempotent retry after an uncertain outcome). */
  operationId?: string;
  /** Per-request timeout (ms). Defaults depend on the call. */
  timeoutMs?: number;
  /**
   * Called once with the call's Operation after it is built and BEFORE the first byte is sent, so
   * the caller can persist the dispatch intent (operation journal). If it throws, nothing is sent.
   */
  beforeSend?: (operation: Operation) => Promise<void> | void;
}

export type DestroyResult = z.infer<typeof DestroyResultSchema>;
export type { BrowserEvidence, BrowserOpResult, CollectOutputsResult, EgressLog } from "@airlock/contracts";
export type FreezeResult = z.infer<typeof FreezeResultSchema>;

export function newOperationId(): string {
  return `op-${randomBytes(12).toString("hex")}`;
}

export async function buildOperation(body: Record<string, unknown>, operationId = newOperationId()): Promise<Operation> {
  const requestDigest = await requestDigestOf({ ...body, operation: { operationId } });
  return { operationId, requestDigest };
}

const DEFAULT_TIMEOUTS = {
  read: 10_000,
  createAttempt: 120_000,
  authorTool: 90_000,
  freeze: 120_000,
  revoke: 60_000,
  renew: 15_000,
  destroy: 60_000,
  invoke: 180_000,
  hostile: 120_000,
  browserOp: 90_000,
  collectOutputs: 120_000,
} as const;

export interface HttpSupervisorClientOptions {
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
  /** Transport retries for mutating calls (same operationId). Default 2. */
  retries?: number;
  retryDelayMs?: number;
}

export class HttpSupervisorClient implements SupervisorClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly retries: number;
  private readonly retryDelayMs: number;

  constructor(private readonly options: HttpSupervisorClientOptions) {
    if (!/^https?:\/\//.test(options.baseUrl)) throw new Error("SUPERVISOR_URL must be an http(s) URL");
    if (!options.token) throw new Error("SUPERVISOR_TOKEN is required");
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = options.fetch ?? fetch;
    this.retries = Math.max(0, Math.min(5, options.retries ?? 2));
    this.retryDelayMs = Math.max(0, options.retryDelayMs ?? 500);
  }

  health(signal?: AbortSignal) {
    return this.get("/health", HealthResponse, signal, false);
  }
  host(signal?: AbortSignal) {
    return this.get("/host", HostCheck, signal, true);
  }
  async getAttempt(attemptId: string, signal?: AbortSignal) {
    assertPlainId(attemptId);
    return this.get(`/attempts/${encodeURIComponent(attemptId)}`, AttemptState, signal, true);
  }
  listAttempts(signal?: AbortSignal) {
    return this.get("/attempts", z.array(AttemptState), signal, true);
  }
  createAttempt(input: CreateAttemptInput, opts?: CallOptions) {
    const body: Record<string, unknown> = { ...input };
    if (input.authorizedUntil === undefined) delete body.authorizedUntil;
    if (input.egressAllow === undefined) delete body.egressAllow;
    return this.mutate("/attempts", body, AttemptState, DEFAULT_TIMEOUTS.createAttempt, opts);
  }
  renew(input: { ref: AttemptRef; authorizedUntil: string }, opts?: CallOptions) {
    return this.mutate(`/attempts/${encodeURIComponent(input.ref.attemptId)}/renew`, input, AttemptState, DEFAULT_TIMEOUTS.renew, opts);
  }
  authorTool(input: { ref: AttemptRef; args: AuthorToolArgs }, opts?: CallOptions) {
    return this.mutate(`/attempts/${encodeURIComponent(input.ref.attemptId)}/tool`, input, AuthorToolResult, DEFAULT_TIMEOUTS.authorTool, opts);
  }
  freeze(input: { ref: AttemptRef }, opts?: CallOptions) {
    return this.mutate(`/attempts/${encodeURIComponent(input.ref.attemptId)}/freeze`, input, FreezeResultSchema, DEFAULT_TIMEOUTS.freeze, opts);
  }
  revoke(input: { ref: AttemptRef }, opts?: CallOptions) {
    return this.mutate(`/attempts/${encodeURIComponent(input.ref.attemptId)}/revoke`, input, AttemptState, DEFAULT_TIMEOUTS.revoke, opts);
  }
  destroy(input: { ref: AttemptRef }, opts?: CallOptions) {
    return this.mutate(`/attempts/${encodeURIComponent(input.ref.attemptId)}/destroy`, input, DestroyResultSchema, DEFAULT_TIMEOUTS.destroy, opts);
  }
  invoke(
    input: {
      taskId: string;
      profileId: string;
      role: "baseline" | "candidate" | "preview";
      bundle?: CandidateBundle;
      request: AdapterRequest;
      absoluteDeadline: string;
    },
    opts?: CallOptions,
  ) {
    const body: Record<string, unknown> = { ...input };
    if (input.bundle === undefined) delete body.bundle;
    return this.mutate("/invoke", body, InvokeResult, DEFAULT_TIMEOUTS.invoke, opts);
  }
  hostile(input: { profileId: string; command: string }, opts?: CallOptions) {
    return this.mutate("/hostile", input, BlastRadiusCard, DEFAULT_TIMEOUTS.hostile, opts);
  }
  browserOp(input: { ref: AttemptRef; request: BrowserOp }, opts?: CallOptions) {
    return this.mutate(`/attempts/${encodeURIComponent(input.ref.attemptId)}/browser`, input, BrowserOpResult, DEFAULT_TIMEOUTS.browserOp, opts);
  }
  async browserEvidence(attemptId: string, signal?: AbortSignal) {
    assertPlainId(attemptId);
    return this.get(`/attempts/${encodeURIComponent(attemptId)}/browser`, BrowserEvidence, signal, true);
  }
  async egressLog(attemptId: string, signal?: AbortSignal) {
    assertPlainId(attemptId);
    return this.get(`/attempts/${encodeURIComponent(attemptId)}/egress`, EgressLog, signal, true);
  }
  collectOutputs(input: { ref: AttemptRef }, opts?: CallOptions) {
    return this.mutate(`/attempts/${encodeURIComponent(input.ref.attemptId)}/collect-outputs`, input, CollectOutputsResult, DEFAULT_TIMEOUTS.collectOutputs, opts);
  }

  private headers(json: boolean): Record<string, string> {
    return {
      authorization: `Bearer ${this.options.token}`,
      accept: "application/json",
      ...(json ? { "content-type": "application/json" } : {}),
    };
  }

  /**
   * Reads are idempotent: a transport failure or timeout is retried once, then reported as
   * SupervisorUnavailableError naming the supervisor, never as a raw fetch error. A caller-side
   * abort is reported as an aborted call, not as an unreachable supervisor.
   */
  private async get<T>(path: string, schema: z.ZodType<T>, signal: AbortSignal | undefined, auth: boolean): Promise<T> {
    const headers = auth ? this.headers(false) : { accept: "application/json" };
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (signal?.aborted) throw new SupervisorError("Call aborted", 0);
      const startedAt = Date.now();
      try {
        const response = await this.request(path, { method: "GET", headers }, DEFAULT_TIMEOUTS.read, signal);
        const decoded = await this.decode(response, schema);
        log.debug("supervisor call", { method: "GET", path, status: response.status, attempt, durationMs: Date.now() - startedAt });
        return decoded;
      } catch (error) {
        log.debug("supervisor call failed", { method: "GET", path, attempt, durationMs: Date.now() - startedAt, error });
        if (error instanceof SupervisorError) throw error;
        if (signal?.aborted) throw new SupervisorError("Call aborted", 0);
        lastError = error;
        if (attempt === 0) await new Promise((r) => setTimeout(r, this.retryDelayMs));
      }
    }
    const message = lastError instanceof Error ? lastError.message : "unreachable";
    throw new SupervisorUnavailableError(`Supervisor unreachable at ${this.baseUrl} (${path}): ${message.slice(0, 200)}`);
  }

  private async mutate<T>(
    path: string,
    body: Record<string, unknown>,
    schema: z.ZodType<T>,
    defaultTimeout: number,
    opts?: CallOptions,
  ): Promise<T> {
    const operation = await buildOperation(body, opts?.operationId);
    const payload = JSON.stringify({ ...body, operation });
    // The intent is recorded before anything leaves this process (37 §Cancellation: a crash between
    // intent and acknowledgement must be reconcilable by operation id, never re-executed blindly).
    if (opts?.beforeSend) await opts.beforeSend(operation);
    const timeoutMs = opts?.timeoutMs ?? defaultTimeout;
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      if (opts?.signal?.aborted) throw new SupervisorError("Call aborted", 0, operation.operationId);
      const startedAt = Date.now();
      const call = { method: "POST", path, operationId: operation.operationId, attempt, requestBytes: payload.length, timeoutMs };
      try {
        const response = await this.request(path, { method: "POST", headers: this.headers(true), body: payload }, timeoutMs, opts?.signal);
        if (response.status === 503) {
          lastError = new SupervisorUnavailableError(await errorText(response), operation.operationId);
          log.debug("supervisor call unavailable; will replay the same operation", { ...call, status: 503, durationMs: Date.now() - startedAt });
          await this.backoff(attempt);
          continue;
        }
        const decoded = await this.decode(response, schema, operation.operationId);
        log.debug("supervisor call", { ...call, status: response.status, durationMs: Date.now() - startedAt });
        return decoded;
      } catch (error) {
        const fenced = error instanceof SupervisorFenceError;
        log.debug(fenced ? "supervisor call fenced" : "supervisor call failed", { ...call, durationMs: Date.now() - startedAt, fenced, error });
        if (error instanceof SupervisorError) throw error;
        if (opts?.signal?.aborted) throw new SupervisorError("Call aborted", 0, operation.operationId);
        // Transport failure or timeout: outcome uncertain → replay the SAME operation id.
        lastError = error;
        await this.backoff(attempt);
      }
    }
    const message = lastError instanceof Error ? lastError.message : "supervisor unreachable";
    throw new SupervisorUnavailableError(`Supervisor call failed after retries: ${message.slice(0, 200)}`, operation.operationId);
  }

  private async backoff(attempt: number) {
    if (attempt >= this.retries) return;
    await new Promise((r) => setTimeout(r, this.retryDelayMs * (attempt + 1)));
  }

  private async request(path: string, init: RequestInit, timeoutMs: number, signal?: AbortSignal): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
    const onAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      return await this.fetchImpl(`${this.baseUrl}${path}`, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  private async decode<T>(response: Response, schema: z.ZodType<T>, operationId?: string): Promise<T> {
    if (!response.ok) {
      const message = await errorText(response);
      if (response.status === 409) throw new SupervisorFenceError(message, operationId);
      if (response.status === 404) throw new SupervisorNotFoundError(message, operationId);
      if (response.status === 429) throw new SupervisorCapacityError(message, operationId);
      if (response.status === 503) throw new SupervisorUnavailableError(message, operationId);
      throw new SupervisorError(message, response.status, operationId);
    }
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new SupervisorError("Supervisor returned a non-JSON body", 502, operationId);
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new SupervisorError(`Supervisor response failed validation: ${parsed.error.issues[0]?.message ?? "invalid"}`, 502, operationId);
    }
    return parsed.data;
  }
}

async function errorText(response: Response): Promise<string> {
  try {
    const text = (await response.text()).slice(0, 2000);
    try {
      const json = JSON.parse(text) as { error?: unknown };
      if (json && typeof json.error === "string") return `supervisor ${response.status}: ${json.error}`;
    } catch {
      // fall through to raw text
    }
    return `supervisor ${response.status}: ${text || response.statusText}`;
  } catch {
    return `supervisor ${response.status}`;
  }
}

function assertPlainId(id: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id) || id.length > 64) throw new SupervisorError("invalid attempt id", 400);
}
