/**
 * Control API (web → control). Cookie sessions, role checks on every route, SSE with
 * Last-Event-ID replay from the store, preview/export bound to the sealed candidate digest and to
 * the runtime image, adapter and contract it was verified under, repair availability from
 * committed live-gate evidence, and the judge-only hostile panel. Errors are JSON `{error}`.
 * `referenceCommitMaintainerOnly` never leaves this process. Every response carries a
 * Content-Security-Policy and nosniff/no-referrer headers.
 *
 * Task-route foundations follow OpenMuse `apps/server/src/engine/routes.ts` (MIT,
 * 205cc386b75aae1a862f3fdd43104b570c8d0911) in shape only; the routes, roles and ownership checks
 * are Airlock's.
 */
import { randomBytes } from "node:crypto";
import { extname, join, resolve, sep } from "node:path";
import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import {
  CreateTaskRequest,
  PreviewRequest,
  canonicalJson,
  sha256,
  type AdapterRequest,
  type BlastRadiusCard,
  type CandidateBundle,
  type ExportGrant,
  type ExportSeal,
  type HostCheck,
  type ProfileManifest,
  type RepairAvailability,
  type Role,
  type RunEvent,
  type SourceManifest,
  type Task,
  type TaskView,
  type VerificationRecord,
} from "@airlock/contracts";
import type { AvailabilityService, DiagnosticScript } from "./availability.ts";
import type { TaskEventBus } from "./events.ts";
import { log } from "./log.ts";
import type { LoadedProfile } from "./profiles.ts";
import { ExportIntegrityError } from "./artifacts/index.ts";
import { ARTIFACT_KIND_BUNDLE, STORE_KIND_VERIFICATIONS, computeAdapterDigest, type ArtifactStoreLike } from "./repair-handler.ts";
import { LoginRateLimited, SESSION_COOKIE, readCookie, type SessionRecord, type SessionService } from "./sessions.ts";
import type { Store } from "./store/index.ts";
import { SupervisorCapacityError, SupervisorError, SupervisorFenceError, SupervisorUnavailableError, type SupervisorClient } from "./supervisor-client.ts";
import type { TaskWorker } from "./worker/index.ts";

export class AppError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 401 | 403 | 404 | 409 | 410 | 413 | 422 | 429 | 500 | 502 | 503 = 400,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export type ExportBundleFn = (input: {
  profile: ProfileManifest;
  baseFiles: Record<string, string>;
  bundle: CandidateBundle;
  verification: VerificationRecord;
  baseline: VerificationRecord;
  task: Task;
  events: RunEvent[];
}) => Promise<{ files: { path: string; bytes: Uint8Array }[] }>;
export type ZipFilesFn = (files: { path: string; bytes: Uint8Array }[]) => Uint8Array;

export interface ApiDeps {
  store: Store;
  sessions: SessionService;
  profiles: Map<string, LoadedProfile>;
  supervisor: SupervisorClient;
  artifacts: ArtifactStoreLike;
  /** `abort` for cancel; `running` (when present) makes the worker's heartbeat part of control-plane health. */
  worker: Pick<TaskWorker, "abort"> & Partial<Pick<TaskWorker, "running">>;
  bus: TaskEventBus;
  exportBundle: ExportBundleFn;
  zipFiles: ZipFilesFn;
  exportGrantTtlMs: number;
  /** Minimum interval between hostile runs per client key (not per session: a re-login is the same client). */
  hostileMinIntervalMs: number;
  /** Minimum interval between any two hostile runs, from any client (default 3 s). */
  hostileGlobalMinIntervalMs?: number;
  /** Minimum interval between preview invocations per session and per client key (each one is a sandbox run on VM B). */
  previewMinIntervalMs?: number;
  /** Directory holding runtime/python/adapter.py: preview/export recompute the adapter digest from it. */
  runtimeDir: string;
  /** Names a task may select with `scriptedDriver` (labelled diagnostics); null/absent: none. */
  scriptedDrivers?: string[] | null;
  /** Title/description of each launchable diagnostic script, for `GET /api/diagnostics`. */
  diagnostics?: DiagnosticScript[] | null;
  /** Scripted-driver mode: the script a task runs when it names none (recorded on the task as its label). */
  defaultScriptedDriver?: string | null;
  /** Live repair evidence gate; absent: tasks are created without a repair-availability check. */
  availability?: AvailabilityService;
  /** The worker heartbeat record older than this marks the control plane unhealthy (default 15 s). */
  workerStaleMs?: number;
  /** Built web UI directory served for every non-/api GET (SPA fallback to index.html). */
  webDist?: string | null;
  /**
   * Socket peer addresses of the reverse proxies in front of this process (`"loopback"` stands
   * for 127.0.0.0/8 and ::1). Only a request whose socket peer is one of them has its
   * X-Forwarded-For (rightmost hop) / X-Real-IP honoured by the login limiter; a request that
   * reaches the port directly from any other peer, and a request whose peer is unknown, is keyed
   * on its peer no matter what headers it carries. Empty or absent: headers are never trusted.
   */
  trustedProxies?: string[];
  now?: () => number;
  /** SSE poll interval (ms) as a safety net behind the bus. */
  ssePollMs?: number;
}

type Env = { Variables: { session: SessionRecord | null; role: Role; token: string | null } };

export const STORE_KIND_TASKS = "tasks";
export const STORE_KIND_GRANTS = "export-grants";
/** Artifact-store kind of the sealed export records (ExportSeal); the zip bytes are a blob. */
export const ARTIFACT_KIND_EXPORT = "export";
const MAX_JSON_BODY = 256 * 1024;
/**
 * The built UI needs no inline script; Radix injects a <style> element at runtime (scroll lock),
 * so styles alone allow 'unsafe-inline'. Everything else is same-origin only.
 */
export const CONTENT_SECURITY_POLICY = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
const DRIFT_REFUSAL = "configuration changed since verification";
/** Worker heartbeat record (written by TaskWorker.tick on every poll). */
const WORKER_STATUS = { owner: "system", kind: "worker-status", id: "tasks" } as const;
const TERMINAL = new Set<Task["status"]>(["cancelled", "done", "failed"]);

export function createApp(deps: ApiDeps) {
  const now = () => deps.now?.() ?? Date.now();
  const iso = () => new Date(now()).toISOString();
  const app = new Hono<Env>();
  const hostileLast = new Map<string, number>();
  let hostileGlobalLast = 0;
  let hostileInFlight = false;
  const hostileGlobalMinIntervalMs = deps.hostileGlobalMinIntervalMs ?? 3000;
  const previewLast = new Map<string, number>();
  const previewMinIntervalMs = deps.previewMinIntervalMs ?? 2000;

  app.onError((error, c) => {
    if (error instanceof AppError) return c.json({ error: error.message }, error.status);
    if (error instanceof z.ZodError) return c.json({ error: `invalid body: ${error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ").slice(0, 500)}` }, 400);
    if (error instanceof LoginRateLimited) return c.json({ error: error.message }, 429);
    if (error instanceof ExportIntegrityError) {
      log.error("export refused: sealed candidate no longer matches its manifest", { path: c.req.path, error });
      return c.json({ error: `sealed candidate no longer matches its manifest; export refused (${error.message.slice(0, 200)})` }, 409);
    }
    if (error instanceof SupervisorUnavailableError) return c.json({ error: "supervisor unavailable" }, 503);
    if (error instanceof SupervisorCapacityError) return c.json({ error: "execution host at capacity; try again shortly" }, 429);
    if (error instanceof SupervisorFenceError) return c.json({ error: error.message.slice(0, 300) }, 409);
    if (error instanceof SupervisorError) return c.json({ error: error.message.slice(0, 300) }, 502);
    log.error("request failed", { method: c.req.method, path: c.req.path, error: error instanceof Error ? error : "request failed" });
    return c.json({ error: "internal error" }, 500);
  });
  app.notFound((c) => c.json({ error: "not found" }, 404));

  // Session resolution on every request; viewer when no valid cookie. At debug level every
  // request is logged with its outcome: method, path, status, duration, role and body sizes,
  // never a body, header or token.
  app.use("*", async (c, next) => {
    const startedAt = now();
    const token = readCookie(c.req.header("cookie"), SESSION_COOKIE);
    const session = await deps.sessions.resolve(token);
    c.set("token", token);
    c.set("session", session);
    c.set("role", session?.role ?? "viewer");
    try {
      await next();
    } finally {
      setSecurityHeaders(c);
      if (log.enabled("debug")) {
        const requestBytes = Number(c.req.header("content-length") ?? "0") || 0;
        const responseBytes = Number(c.res.headers.get("content-length") ?? "0") || 0;
        log.debug("http", {
          method: c.req.method,
          path: c.req.path,
          status: c.res.status,
          durationMs: now() - startedAt,
          role: session?.role ?? "viewer",
          requestBytes,
          ...(responseBytes ? { responseBytes } : {}),
          ...(c.res.headers.get("content-type")?.startsWith("text/event-stream") ? { sse: true } : {}),
        });
      }
    }
  });

  const requireRole = (c: Context<Env>, ...roles: Role[]): SessionRecord => {
    const session = c.get("session");
    if (!session) throw new AppError("sign in required", 401);
    if (!roles.includes(session.role)) throw new AppError(`requires role ${roles.join(" or ")}`, 403);
    return session;
  };
  const readJson = async <T>(c: Context<Env>, schema: z.ZodType<T>): Promise<T> => {
    const length = Number(c.req.header("content-length") ?? "0");
    if (Number.isFinite(length) && length > MAX_JSON_BODY) throw new AppError("body too large", 413);
    const text = await c.req.text();
    if (text.length > MAX_JSON_BODY) throw new AppError("body too large", 413);
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new AppError("body must be JSON", 400);
    }
    return schema.parse(json);
  };
  const taskId = (c: Context<Env>): string => {
    const id = c.req.param("id") ?? "";
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id)) throw new AppError("invalid task id", 400);
    return id;
  };
  const loadTask = async (id: string): Promise<{ owner: string; task: Task }> => {
    const rows = await deps.store.scanWhere<Task>(STORE_KIND_TASKS, { id });
    const row = rows.find((r) => r.value.id === id);
    if (!row) throw new AppError("task not found", 404);
    return { owner: row.owner, task: row.value };
  };
  const canAccess = (session: SessionRecord, owner: string) => session.role === "operator" || session.owner === owner;
  /**
   * Every task route: a session is required, and a task that is not the caller's reads as absent
   * (404, not 403), so task ids cannot be probed. Operators see every task; a judge sees only the
   * tasks its own session created (CLAUDE.md §3.6).
   */
  const authorizeTask = async (c: Context<Env>): Promise<{ session: SessionRecord; owner: string; task: Task }> => {
    const session = requireRole(c, "operator", "judge");
    const { owner, task } = await loadTask(taskId(c));
    if (!canAccess(session, owner)) throw new AppError("task not found", 404);
    return { session, owner, task };
  };
  const publicManifest = (m: ProfileManifest): Omit<ProfileManifest, "referenceCommitMaintainerOnly"> => {
    const { referenceCommitMaintainerOnly: _omit, ...rest } = m;
    return rest;
  };
  // The login limiter's key. X-Forwarded-For / X-Real-IP are client-controlled unless a trusted
  // proxy sets them, and even then only the hop the proxy appended (the rightmost) is its word;
  // rotating the leftmost entry must not buy a fresh budget. A proxy is trusted by its socket
  // peer address, never by a flag alone: a client that reaches the port directly (bypassing the
  // proxy) writes its own rightmost hop, so its headers are ignored and it is keyed on its peer.
  // Without a trusted proxy the key is the socket peer address (Bun's server.requestIP); when that
  // is unknown every client shares one bucket, which fails closed rather than open.
  const peerAddress = (c: Context<Env>): string | null => {
    const server = c.env as { requestIP?: (req: Request) => { address: string } | null } | undefined;
    try {
      const ip = server?.requestIP?.(c.req.raw)?.address;
      return typeof ip === "string" && ip.length > 0 ? ip.slice(0, 128) : null;
    } catch {
      return null;
    }
  };
  const trustedProxies = deps.trustedProxies ?? [];
  const isTrustedProxy = (peer: string): boolean => {
    const plain = peer.startsWith("::ffff:") ? peer.slice("::ffff:".length) : peer;
    return trustedProxies.some((p) => (p === "loopback" ? plain.startsWith("127.") || plain === "::1" : p === plain || p === peer));
  };
  const clientKey = (c: Context<Env>): string => {
    const peer = peerAddress(c);
    if (peer && trustedProxies.length > 0 && isTrustedProxy(peer)) {
      const hops = (c.req.header("x-forwarded-for") ?? "").split(",").map((h) => h.trim()).filter(Boolean);
      const hop = hops.at(-1) ?? c.req.header("x-real-ip")?.trim();
      if (hop) return `proxy:${hop.slice(0, 128)}`;
    }
    return peer ? `peer:${peer}` : "unknown";
  };

  // ---- session --------------------------------------------------------------------------------
  app.post("/api/session", async (c) => {
    const body = await readJson(c, z.object({ password: z.string().min(1).max(1024) }));
    const result = await deps.sessions.login(body.password, clientKey(c));
    if (!result) throw new AppError("password incorrect", 401);
    c.header("set-cookie", deps.sessions.cookieFor(result.token));
    return c.json({ role: result.session.role });
  });
  app.delete("/api/session", async (c) => {
    await deps.sessions.logout(c.get("token"));
    c.header("set-cookie", deps.sessions.clearCookie());
    return c.json({ role: "viewer" });
  });
  app.get("/api/session", (c) => c.json({ role: c.get("role") }));

  // ---- profiles, host ---------------------------------------------------------------------------
  app.get("/api/profiles", (c) => c.json([...deps.profiles.values()].map((p) => publicManifest(p.manifest))));
  // Liveness only: no host facts, no task data.
  app.get("/api/health", (c) => c.json({ ok: true }));
  app.get("/api/host", async (c) => {
    requireRole(c, "operator", "judge");
    return c.json(await deps.supervisor.host());
  });
  // No task data: whether live repair is currently backed by evidence, and why not.
  app.get("/api/repair-availability", async (c) => {
    const requested = c.req.query("profileId");
    const profile = requested ? deps.profiles.get(requested) : [...deps.profiles.values()][0];
    if (!profile) throw new AppError("no such profile", 404);
    return c.json(await repairAvailability(profile));
  });
  app.get("/api/diagnostics", (c) => {
    requireRole(c, "operator", "judge");
    const scripts = deps.diagnostics ?? (deps.scriptedDrivers ?? []).map((name) => ({ name, title: name, description: "" }));
    return c.json({ scripts: scripts.filter((s) => (deps.scriptedDrivers ?? []).includes(s.name)) });
  });

  // ---- tasks ----------------------------------------------------------------------------------------
  app.post("/api/tasks", async (c) => {
    const session = requireRole(c, "operator", "judge");
    const body = await readJson(c, CreateTaskRequest);
    if (!deps.profiles.has(body.profileId)) throw new AppError(`profile "${body.profileId}" is not supported`, 422);
    if (body.scriptedDriver !== undefined) {
      if (!deps.scriptedDrivers || deps.scriptedDrivers.length === 0) throw new AppError("scriptedDriver is only accepted when the control plane has a diagnostic script catalog (AIRLOCK_DIAGNOSTIC_SCRIPTS_DIR or a scripted model driver)", 422);
      if (!deps.scriptedDrivers.includes(body.scriptedDriver)) throw new AppError(`scripted driver "${body.scriptedDriver}" is not available; available: ${deps.scriptedDrivers.join(", ")}`, 422);
    }
    // A labelled diagnostic never counts as a model repair; a scripted-driver control plane labels
    // every task with the script it will run.
    const scriptedDriver = body.scriptedDriver ?? deps.defaultScriptedDriver ?? undefined;
    // Live repair runs only while committed live-gate evidence backs it. An operator running the
    // gate itself (`liveGate: true`) is exempt: that run is how the evidence is produced.
    const liveGate = body.liveGate === true;
    if (liveGate && session.role !== "operator") throw new AppError("liveGate runs require the operator role", 403);
    if (liveGate && scriptedDriver !== undefined) throw new AppError("a live-gate run cannot use a scripted driver", 422);
    let repairDisabledReason: string | undefined;
    if (scriptedDriver === undefined && !liveGate && deps.availability?.driver === "vultr") {
      const availability = await repairAvailability(deps.profiles.get(body.profileId)!);
      if (!availability.available) repairDisabledReason = `live repair unavailable: ${availability.reason}`.slice(0, 1024);
    }
    const at = iso();
    const task: Task = {
      id: `task-${randomBytes(8).toString("hex")}`,
      owner: session.owner,
      profileId: body.profileId,
      issueText: body.issueText,
      ...(scriptedDriver !== undefined ? { scriptedDriver } : {}),
      ...(repairDisabledReason !== undefined ? { repairDisabledReason } : {}),
      ...(liveGate ? { liveGate: true } : {}),
      status: "queued",
      phase: "prepare",
      generation: 0,
      leaseId: null,
      leaseUntil: null,
      attempts: 0,
      budget: { modelCallsUsed: 0, repairAttemptsUsed: 0 },
      createdAt: at,
      updatedAt: at,
    };
    const inserted = await deps.store.insertIfAbsent(session.owner, STORE_KIND_TASKS, task);
    if (!inserted) throw new AppError("task id collision; retry", 409);
    await deps.store.appendEvent(session.owner, task.id, {
      id: `evt-${randomBytes(8).toString("hex")}`,
      at,
      kind: "lifecycle",
      title: "Task created",
      detail: `profile ${task.profileId}${scriptedDriver !== undefined ? `; diagnostic (scripted:${scriptedDriver}), not a model repair` : ""}${liveGate ? "; live-gate attempt" : ""}${repairDisabledReason ? `; ${repairDisabledReason} (reproduction and baseline only)` : ""}`,
      data: { ...(scriptedDriver !== undefined ? { diagnostic: true, scriptedDriver } : {}), ...(liveGate ? { liveGate: true } : {}), ...(repairDisabledReason ? { repairDisabledReason } : {}) },
    });
    return c.json(task, 201);
  });
  app.get("/api/tasks", async (c) => {
    const session = requireRole(c, "operator", "judge");
    const tasks =
      session.role === "operator"
        ? (await deps.store.scan<Task>(STORE_KIND_TASKS)).map((r) => r.value)
        : await deps.store.list<Task>(session.owner, STORE_KIND_TASKS);
    return c.json(tasks.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
  });
  app.get("/api/tasks/:id", async (c) => {
    const { owner, task } = await authorizeTask(c);
    const view: TaskView = { task };
    const profile = deps.profiles.get(task.profileId);
    if (profile) view.cases = profile.contract.cases.map((cs) => ({ id: cs.id, kind: cs.kind, title: cs.title }));
    if (task.baselineRecordId) {
      const rec = await deps.store.get<VerificationRecord>(owner, STORE_KIND_VERIFICATIONS, task.baselineRecordId);
      if (rec) view.baseline = rec;
    }
    if (task.verificationRecordId) {
      const rec = await deps.store.get<VerificationRecord>(owner, STORE_KIND_VERIFICATIONS, task.verificationRecordId);
      if (rec) view.verification = rec;
    }
    if (task.candidateDigest) {
      const bundle = await deps.artifacts.getJson<CandidateBundle>(ARTIFACT_KIND_BUNDLE, task.candidateDigest);
      if (bundle) view.manifest = bundle.manifest as SourceManifest;
    }
    const host = view.verification?.runtimeProfile.host ?? view.baseline?.runtimeProfile.host;
    if (host) view.host = host as HostCheck;
    return c.json(view);
  });

  app.get("/api/tasks/:id/events", async (c) => {
    const { owner, task: opened } = await authorizeTask(c);
    const id = opened.id;
    const token = c.get("token");
    // Replay cursor: the browser's automatic reconnect sends Last-Event-ID; apps/web's own
    // reopen (after a CLOSED stream) passes ?lastEventId=<seq>; ?after= is kept for curl users.
    const header = c.req.header("last-event-id") ?? c.req.query("lastEventId") ?? c.req.query("after") ?? "0";
    const afterSeq = /^\d{1,12}$/.test(header) ? Number(header) : 0;
    const pollMs = deps.ssePollMs ?? 2000;
    const role = c.get("role");
    log.debug("sse: subscribe", { taskId: id, afterSeq, role });
    return streamSSE(c, async (stream) => {
      let cursor = afterSeq;
      let lastTaskUpdatedAt = "";
      let wake: (() => void) | null = null;
      let sent = 0;
      let replayed = false;
      const openedAt = now();
      const unsubscribe = deps.bus.subscribe(id, () => wake?.());
      const send = async (event: RunEvent) => {
        if (event.seq <= cursor) return;
        cursor = event.seq;
        sent += 1;
        await stream.writeSSE({ id: String(event.seq), event: event.kind, data: JSON.stringify(event) });
      };
      // The session is re-checked before every batch is written: a stream outlives neither its
      // session's expiry nor a logout, and a revoked reader gets no further events.
      const stillAuthorized = async () => {
        const current = await deps.sessions.resolve(token);
        return !!current && canAccess(current, owner);
      };
      const drain = async (): Promise<Task | null | "unauthorized"> => {
        for (;;) {
          const batch = await deps.store.listEvents(id, cursor, 500);
          if (!(await stillAuthorized())) return "unauthorized";
          for (const event of batch) await send(event);
          if (batch.length < 500) break;
        }
        const task = await deps.store.get<Task>(owner, STORE_KIND_TASKS, id);
        if (task && task.updatedAt !== lastTaskUpdatedAt) {
          lastTaskUpdatedAt = task.updatedAt;
          await stream.writeSSE({ event: "task", data: JSON.stringify(task) });
        }
        return task;
      };
      try {
        let lastHeartbeat = now();
        for (;;) {
          const task = await drain();
          if (task === "unauthorized") {
            // Named so the client stops reconnecting instead of retrying into 401s.
            log.debug("sse: session ended; closing stream", { taskId: id });
            await stream.writeSSE({ event: "end", data: JSON.stringify({ status: "unauthorized" }) });
            break;
          }
          if (!replayed) {
            replayed = true;
            log.debug("sse: replayed", { taskId: id, afterSeq, throughSeq: cursor, events: sent });
          }
          if (!task || (TERMINAL.has(task.status) && (await deps.store.listEvents(id, cursor, 1)).length === 0)) {
            await stream.writeSSE({ event: "end", data: JSON.stringify({ status: task?.status ?? "missing" }) });
            break;
          }
          if (stream.aborted || stream.closed) break;
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, pollMs);
            wake = () => {
              clearTimeout(timer);
              resolve();
            };
          });
          wake = null;
          if (stream.aborted || stream.closed) break;
          if (now() - lastHeartbeat >= 15_000) {
            lastHeartbeat = now();
            await stream.write(": keepalive\n\n");
          }
        }
      } finally {
        unsubscribe();
        log.debug("sse: closed", { taskId: id, afterSeq, throughSeq: cursor, events: sent, durationMs: now() - openedAt, aborted: stream.aborted });
      }
    });
  });

  app.post("/api/tasks/:id/cancel", async (c) => {
    const { session, owner, task } = await authorizeTask(c);
    if (TERMINAL.has(task.status)) throw new AppError(`task is already ${task.status}`, 409);
    if (task.status === "cancelling") return c.json(task);
    const at = iso();
    let next: Task | null = null;
    if (task.status === "queued") {
      // A queued task that still names an attempt (requeued after a lost lease) may have a sandbox
      // on VM B: it goes through `cancelling` so the worker's cancel pass revokes and confirms the
      // teardown. Only a task that never had an attempt is cancelled by the state change alone.
      next = task.attemptId
        ? await deps.store.compareAndSwap<Task>(owner, STORE_KIND_TASKS, task.id, { status: "queued", leaseId: null, attemptId: task.attemptId }, { status: "cancelling", leaseUntil: null, updatedAt: at })
        : await deps.store.compareAndSwap<Task>(owner, STORE_KIND_TASKS, task.id, { status: "queued", leaseId: null }, { status: "cancelled", updatedAt: at }, [], ["attemptId"]);
    }
    if (!next) {
      next = await deps.store.compareAndSwap<Task>(owner, STORE_KIND_TASKS, task.id, { status: "running" }, { status: "cancelling", updatedAt: at });
    }
    if (!next) {
      // Raced with the worker (queued→running or running→terminal). Reload and report.
      const latest = await loadTask(task.id);
      if (TERMINAL.has(latest.task.status)) throw new AppError(`task is already ${latest.task.status}`, 409);
      throw new AppError("task state changed; retry cancel", 409);
    }
    deps.worker.abort(task.id);
    const event = await deps.store.appendEvent(owner, task.id, { id: `evt-${randomBytes(8).toString("hex")}`, at, kind: "lifecycle", title: next.status === "cancelled" ? "Task cancelled before it started" : "Cancellation requested", detail: `by ${session.role}` });
    deps.bus.publish(event);
    return c.json(next);
  });

  // Preview is owner-or-operator like every task route. It writes nothing and is bound to the sealed
  // digest; what bounds it is the per-session interval, since every call is a sandbox run on VM B.
  app.post("/api/tasks/:id/preview", async (c) => {
    const { session, owner, task } = await authorizeTask(c);
    const body = await readJson(c, PreviewRequest);
    if (!task.candidateDigest || !task.verificationRecordId) throw new AppError("task has no verified candidate", 409);
    if (body.candidateDigest !== task.candidateDigest) throw new AppError("candidateDigest does not match the task's sealed candidate", 409);
    const verification = await deps.store.get<VerificationRecord>(owner, STORE_KIND_VERIFICATIONS, task.verificationRecordId);
    if (!verification || verification.candidateDigest !== task.candidateDigest) throw new AppError("verification record missing or for a different candidate", 409);
    if (!verification.passed) throw new AppError("candidate did not pass checks; preview refused", 409);
    if (canonicalJson(body.input).length > 65536) throw new AppError("preview input exceeds 64 KiB", 413);
    const bundle = await deps.artifacts.getJson<CandidateBundle>(ARTIFACT_KIND_BUNDLE, task.candidateDigest);
    if (!bundle) throw new AppError("sealed candidate bundle missing", 409);
    if (bundle.candidateDigest !== task.candidateDigest) throw new AppError("stored bundle digest mismatch", 409);
    const profile = deps.profiles.get(task.profileId);
    if (!profile) throw new AppError("profile no longer loaded", 409);
    // CLAUDE.md §3.3: preview uses exactly the runtime image, adapter and contract it was verified under.
    await refuseDrift(verification, profile, "preview refused");
    const request: AdapterRequest = { schemaVersion: 1, cases: [{ id: "preview", input: body.input }] };
    const deadlineMs = Math.min(profile.manifest.caps.attemptTimeoutMs, profile.manifest.caps.commandTimeoutMs * 3);
    // Only a preview that actually dispatches a sandbox run counts against the interval, which is
    // kept per session AND per client key: logging in again does not buy a fresh budget.
    const keys = [`session:${session.id}`, `client:${clientKey(c)}`];
    if (keys.some((k) => now() - (previewLast.get(k) ?? 0) < previewMinIntervalMs)) throw new AppError(`previews are limited to one per ${Math.ceil(previewMinIntervalMs / 1000)} s per session and client`, 429);
    if (previewLast.size > 1000) previewLast.clear();
    for (const k of keys) previewLast.set(k, now());
    const result = await deps.supervisor.invoke(
      { taskId: task.id, profileId: task.profileId, role: "preview", bundle, request, absoluteDeadline: new Date(now() + deadlineMs).toISOString() },
      { timeoutMs: deadlineMs + 30_000 },
    );
    // The supervisor's own inspection of the preview sandbox must name the verified image and runtime.
    if (result.inspection.imageDigest !== verification.runtimeImageDigest || result.inspection.runtime !== verification.runtimeProfile.inspection.runtime) {
      log.warn("preview refused: sandbox runtime differs from verification", { taskId: task.id, verifiedImage: verification.runtimeImageDigest, previewImage: result.inspection.imageDigest, verifiedRuntime: verification.runtimeProfile.inspection.runtime, previewRuntime: result.inspection.runtime });
      throw new AppError(`${DRIFT_REFUSAL} (preview sandbox ran image ${result.inspection.imageDigest.slice(0, 80)} on ${result.inspection.runtime}; verified ${verification.runtimeImageDigest.slice(0, 80)} on ${verification.runtimeProfile.inspection.runtime}); preview refused`, 409);
    }
    const observation = result.observations.find((o) => o.caseId === "preview");
    return c.json({ candidateDigest: task.candidateDigest, ...(observation ? { observation } : {}), exec: result.exec, inspection: result.inspection });
  });

  app.post("/api/tasks/:id/export", async (c) => {
    const { session, owner, task } = await authorizeTask(c);
    const eligible = await exportEligibility(owner, task);
    const seal = await sealExport(owner, task, eligible);
    const existing = (await deps.store.list<ExportGrant>(session.owner, STORE_KIND_GRANTS)).find(
      (g) => g.taskId === task.id && g.sealId === seal.id && g.zipDigest === seal.zipDigest && Date.parse(g.expiresAt) > now(),
    );
    const grant: ExportGrant = existing ?? {
      id: `grant-${randomBytes(12).toString("hex")}`,
      owner: session.owner,
      taskId: task.id,
      candidateDigest: seal.candidateDigest,
      verificationRecordId: seal.verificationRecordId,
      verificationRecordDigest: seal.verificationRecordDigest,
      sealId: seal.id,
      zipDigest: seal.zipDigest,
      createdAt: iso(),
      expiresAt: new Date(now() + deps.exportGrantTtlMs).toISOString(),
    };
    if (!existing) {
      const inserted = await deps.store.insertImmutable(session.owner, STORE_KIND_GRANTS, grant);
      if (!inserted) throw new AppError("grant id collision; retry", 409);
      // Recorded after sealing, so grant events never change the sealed zip.
      const event = await deps.store.appendEvent(owner, task.id, { id: `evt-${randomBytes(8).toString("hex")}`, at: iso(), kind: "artifact", title: "Export authorized", detail: `grant ${grant.id} for ${grant.candidateDigest}; zip ${grant.zipDigest}` });
      deps.bus.publish(event);
      log.debug("export grant created", { grantId: grant.id, taskId: task.id, candidateDigest: grant.candidateDigest, verificationRecordId: grant.verificationRecordId, zipDigest: grant.zipDigest, role: session.role, expiresAt: grant.expiresAt });
    }
    return c.json({ grantId: grant.id, url: `/api/exports/${grant.id}`, expiresAt: grant.expiresAt, zipDigest: grant.zipDigest }, existing ? 200 : 201);
  });

  app.get("/api/exports/:grantId", async (c) => {
    const session = requireRole(c, "operator", "judge");
    const grantId = c.req.param("grantId");
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(grantId)) throw new AppError("invalid grant id", 400);
    const grant = await deps.store.get<ExportGrant>(session.owner, STORE_KIND_GRANTS, grantId);
    if (!grant) throw new AppError("grant not found", 404);
    if (Date.parse(grant.expiresAt) <= now()) throw new AppError("grant expired; request a new export", 410);
    // Grants issued before sealed exports existed name no seal: they authorize nothing now.
    if (!grant.sealId || !grant.zipDigest || !grant.verificationRecordDigest) throw new AppError("grant predates sealed exports; request a new export", 410);
    const { owner, task } = await loadTask(grant.taskId);
    if (!canAccess(session, owner)) throw new AppError("grant not found", 404);
    // Eligibility is checked when the grant is used, not only when it was issued.
    const eligible = await exportEligibility(owner, task);
    if (eligible.verification.id !== grant.verificationRecordId || eligible.verificationRecordDigest !== grant.verificationRecordDigest || task.candidateDigest !== grant.candidateDigest)
      throw new AppError("task no longer matches this grant", 409);
    const seal = await deps.artifacts.getJson<ExportSeal>(ARTIFACT_KIND_EXPORT, grant.sealId);
    if (!seal || seal.zipDigest !== grant.zipDigest || seal.taskId !== task.id || seal.verificationRecordDigest !== grant.verificationRecordDigest || seal.baselineRecordId !== eligible.baseline.id || seal.baselineRecordDigest !== eligible.baselineRecordDigest)
      throw new AppError("sealed export missing or does not match this grant", 409);
    const zip = await deps.artifacts.getBlob(seal.zipDigest);
    if (!zip) throw new AppError("sealed export bytes missing", 409);
    if (zip.byteLength !== seal.byteLength || (await sha256(zip)) !== seal.zipDigest) throw new AppError("sealed export bytes no longer match their digest", 409);
    c.header("content-type", "application/zip");
    c.header("content-disposition", `attachment; filename="airlock-${task.id}-${grant.candidateDigest.slice(0, 12)}.zip"`);
    c.header("cache-control", "private, no-store");
    c.header("x-content-type-options", "nosniff");
    c.header("x-airlock-zip-sha256", seal.zipDigest);
    return new Response(new Uint8Array(zip).buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength) as ArrayBuffer, { status: 200, headers: c.res.headers });
  });

  /**
   * A task may be exported only as a passing candidate: outcome CANDIDATE_PASSED_CHECKS, a candidate
   * record that passed for exactly the sealed digest, and a baseline record that passed (the
   * reported failure reproduced and the regression cases held) under the same contract and adapter.
   * A failed or unverified repair never reaches the passing-candidate export.
   */
  async function exportEligibility(owner: string, task: Task): Promise<{ verification: VerificationRecord; baseline: VerificationRecord; verificationRecordDigest: string; baselineRecordDigest: string }> {
    if (task.status !== "done" || task.outcome !== "CANDIDATE_PASSED_CHECKS") throw new AppError(`only a candidate that passed its checks can be exported (task ${task.status}${task.outcome ? `, ${task.outcome}` : ""})`, 409);
    if (!task.candidateDigest || !task.verificationRecordId || !task.baselineRecordId) throw new AppError("task has no verified candidate to export", 409);
    const verification = await deps.store.get<VerificationRecord>(owner, STORE_KIND_VERIFICATIONS, task.verificationRecordId);
    const baseline = await deps.store.get<VerificationRecord>(owner, STORE_KIND_VERIFICATIONS, task.baselineRecordId);
    if (!verification || verification.role !== "candidate" || verification.taskId !== task.id || verification.candidateDigest !== task.candidateDigest)
      throw new AppError("verification record missing or for a different candidate", 409);
    if (!verification.passed || verification.completedCases !== verification.requiredCases) throw new AppError("candidate did not pass checks; export refused", 409);
    if (!baseline || baseline.role !== "baseline" || baseline.taskId !== task.id || !baseline.passed) throw new AppError("baseline did not reproduce the reported failure under the frozen contract; export refused", 409);
    if (baseline.contractDigest !== verification.contractDigest || baseline.adapterDigest !== verification.adapterDigest) throw new AppError("baseline and candidate were measured under different contracts or adapters; export refused", 409);
    if (baseline.runtimeImageDigest !== verification.runtimeImageDigest) throw new AppError("baseline and candidate were measured on different runtime images; export refused", 409);
    // Drift refuses a new grant AND the download of an already-sealed zip: evidence measured under a
    // configuration that is no longer the running one is not handed out as current.
    const profile = deps.profiles.get(task.profileId);
    if (!profile) throw new AppError("profile no longer loaded", 409);
    await refuseDrift(verification, profile, "export refused");
    return { verification, baseline, verificationRecordDigest: await sha256(canonicalJson(verification)), baselineRecordDigest: await sha256(canonicalJson(baseline)) };
  }

  /**
   * Builds the export zip once per (task, candidate record) and stores it content-addressed; every
   * later grant and download serves those bytes. The seal id is derived from the pair, so two
   * concurrent first exports race on one immutable record and the loser adopts the winner's seal.
   */
  async function sealExport(owner: string, task: Task, eligible: Awaited<ReturnType<typeof exportEligibility>>): Promise<ExportSeal> {
    const { verification, baseline } = eligible;
    const id = `exp-${(await sha256(`${task.id}\n${verification.id}`)).slice(0, 40)}`;
    const matches = (seal: ExportSeal | null): seal is ExportSeal =>
      !!seal && seal.taskId === task.id && seal.candidateDigest === task.candidateDigest && seal.verificationRecordDigest === eligible.verificationRecordDigest && seal.baselineRecordDigest === eligible.baselineRecordDigest;
    const existing = await deps.artifacts.getJson<ExportSeal>(ARTIFACT_KIND_EXPORT, id);
    if (existing) {
      if (!matches(existing)) throw new AppError("sealed export does not match the task's verification records", 409);
      // A grant is only issued for bytes that are actually there (the blob store re-hashes on read).
      if (!(await deps.artifacts.getBlob(existing.zipDigest))) throw new AppError("sealed export bytes missing; export refused", 409);
      return existing;
    }
    const bundle = await deps.artifacts.getJson<CandidateBundle>(ARTIFACT_KIND_BUNDLE, task.candidateDigest!);
    if (!bundle || bundle.candidateDigest !== task.candidateDigest) throw new AppError("sealed candidate bundle missing", 409);
    const profile = deps.profiles.get(task.profileId);
    if (!profile) throw new AppError("profile no longer loaded", 409);
    // Evidence cutoff: every event recorded so far except export bookkeeping. The task is terminal,
    // so nothing the run did is left out; grant events are never part of the sealed payload.
    const events = (await deps.store.listEvents(task.id, 0, 5000)).filter((e) => !(e.kind === "artifact" && (e.title === "Export authorized" || e.title === "Export sealed")));
    const { files } = await deps.exportBundle({ profile: publicManifest(profile.manifest) as ProfileManifest, baseFiles: profile.baseFiles, bundle, verification, baseline, task, events });
    const zip = deps.zipFiles(files);
    const zipDigest = await deps.artifacts.putBlob(zip);
    const seal: ExportSeal = {
      schemaVersion: 1,
      id,
      taskId: task.id,
      candidateDigest: task.candidateDigest!,
      verificationRecordId: verification.id,
      verificationRecordDigest: eligible.verificationRecordDigest,
      baselineRecordId: baseline.id,
      baselineRecordDigest: eligible.baselineRecordDigest,
      zipDigest,
      byteLength: zip.byteLength,
      eventsThroughSeq: events.at(-1)?.seq ?? 0,
      sealedAt: iso(),
    };
    if (await deps.artifacts.putImmutableJson(ARTIFACT_KIND_EXPORT, id, seal)) {
      const event = await deps.store.appendEvent(owner, task.id, { id: `evt-${randomBytes(8).toString("hex")}`, at: iso(), kind: "artifact", title: "Export sealed", detail: `zip ${zipDigest} (${zip.byteLength} bytes, events through #${seal.eventsThroughSeq})` });
      deps.bus.publish(event);
      return seal;
    }
    const winner = await deps.artifacts.getJson<ExportSeal>(ARTIFACT_KIND_EXPORT, id);
    if (!matches(winner)) throw new AppError("sealed export does not match the task's verification records", 409);
    return winner;
  }

  // ---- hostile panel --------------------------------------------------------------------------------
  // Judge role only (37 §hostile panel). Limited per client key, not per session (a re-login is
  // the same client), plus a global interval and one run at a time across every client.
  app.post("/api/hostile", async (c) => {
    requireRole(c, "judge");
    const body = await readJson(c, z.object({ command: z.string().min(1).max(4096), profileId: z.string().max(64).optional() }));
    const profileId = body.profileId ?? [...deps.profiles.keys()][0];
    if (!profileId || !deps.profiles.has(profileId)) throw new AppError("no such profile", 422);
    const key = clientKey(c);
    if (hostileInFlight) throw new AppError("a hostile run is already in progress; try again when it finishes", 429);
    if (now() - (hostileLast.get(key) ?? 0) < deps.hostileMinIntervalMs) throw new AppError(`hostile runs are limited to one per ${Math.ceil(deps.hostileMinIntervalMs / 1000)} s per client`, 429);
    if (now() - hostileGlobalLast < hostileGlobalMinIntervalMs) throw new AppError(`hostile runs are limited to one per ${Math.ceil(hostileGlobalMinIntervalMs / 1000)} s overall`, 429);
    if (hostileLast.size > 1000) hostileLast.clear();
    hostileLast.set(key, now());
    hostileGlobalLast = now();
    hostileInFlight = true;
    try {
      const healthyBefore = await controlPlaneHealthy();
      const card: BlastRadiusCard = await deps.supervisor.hostile({ profileId, command: body.command });
      const healthyAfter = await controlPlaneHealthy();
      card.survived.controlPlane = { healthyBefore, healthyAfter, checkedAt: iso() };
      return c.json(card);
    } finally {
      hostileInFlight = false;
    }
  });

  /** Store answers a query, and (for a running worker) its heartbeat record is fresh. */
  async function controlPlaneHealthy(): Promise<boolean> {
    try {
      const status = await deps.store.get<{ lastTickAt?: string }>(WORKER_STATUS.owner, WORKER_STATUS.kind, WORKER_STATUS.id);
      if (deps.worker.running === undefined) return true;
      if (!deps.worker.running) return false;
      const at = Date.parse(status?.lastTickAt ?? "");
      return Number.isFinite(at) && now() - at <= (deps.workerStaleMs ?? 15_000);
    } catch (error) {
      log.warn("control-plane health check failed", { error: error instanceof Error ? error : "health check failed" });
      return false;
    }
  }

  async function repairAvailability(profile: LoadedProfile): Promise<RepairAvailability> {
    if (!deps.availability) return { available: false, reason: "repair availability is not configured on this control plane", driver: "unknown" };
    let host: HostCheck | null = null;
    try {
      host = await deps.supervisor.host();
    } catch (error) {
      log.warn("repair availability: supervisor host check failed", { error: error instanceof Error ? error : "host check failed" });
    }
    return deps.availability.evaluate(profile, host);
  }

  /**
   * 409 unless the verification record's adapter digest, contract digest and runtime still match
   * what would run now: the adapter digest recomputed from disk, the loaded contract, and the
   * supervisor's current host check (selected runtime and, when it reports one in the same form,
   * the enforced runtime image id).
   */
  async function refuseDrift(verification: VerificationRecord, profile: LoadedProfile, action: string): Promise<void> {
    const drift: string[] = [];
    let adapterDigest: string;
    try {
      adapterDigest = await computeAdapterDigest(deps.runtimeDir, profile);
    } catch (error) {
      throw new AppError(`${DRIFT_REFUSAL} (adapter unreadable: ${error instanceof Error ? error.message.slice(0, 200) : "unknown"}); ${action}`, 409);
    }
    if (adapterDigest !== verification.adapterDigest) drift.push(`adapter ${adapterDigest.slice(0, 12)} ≠ verified ${verification.adapterDigest.slice(0, 12)}`);
    if (profile.contractDigest !== verification.contractDigest) drift.push(`contract ${profile.contractDigest.slice(0, 12)} ≠ verified ${verification.contractDigest.slice(0, 12)}`);
    const host = await deps.supervisor.host();
    const verifiedRuntime = verification.runtimeProfile.inspection.runtime;
    if (host.selectedRuntime !== verifiedRuntime) drift.push(`runtime ${host.selectedRuntime} ≠ verified ${verifiedRuntime}`);
    // HostCheck.runtimeImageId is an image id (`sha256:<id>`); the record carries the inspected
    // image's repo digest when it has one (`name@sha256:…`), else its id. Compare like with like;
    // the preview sandbox's own inspection is compared after the run either way.
    const verifiedImage = verification.runtimeImageDigest;
    if (host.runtimeImageId && !verifiedImage.includes("@") && host.runtimeImageId !== verifiedImage) drift.push(`runtime image ${host.runtimeImageId.slice(0, 80)} ≠ verified ${verifiedImage.slice(0, 80)}`);
    if (drift.length) {
      log.warn("refused: configuration drift since verification", { taskId: verification.taskId, action, drift });
      throw new AppError(`${DRIFT_REFUSAL} (${drift.join("; ")}); ${action}`, 409);
    }
  }

  // ---- web UI (last, so every /api route above takes precedence) ------------------------------
  if (deps.webDist) mountStatic(app, deps.webDist);

  return app;
}

/** Applied to every response, API, static and SSE alike (a streaming response keeps its body). */
function setSecurityHeaders(c: Context<Env>) {
  const apply = (headers: Headers) => {
    headers.set("content-security-policy", CONTENT_SECURITY_POLICY);
    headers.set("x-content-type-options", "nosniff");
    headers.set("referrer-policy", "no-referrer");
  };
  try {
    apply(c.res.headers);
  } catch {
    // Immutable headers (a passed-through fetch Response): re-wrap without touching the body.
    const res = new Response(c.res.body, c.res);
    apply(res.headers);
    c.res = res;
  }
}

const STATIC_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

/**
 * Serve the built web UI. Registered after every /api route so the API always wins; `/api/*`
 * misses stay JSON 404s. Paths are normalised and confined to the dist directory (no traversal,
 * no dotfiles); anything unknown falls back to index.html for the hash-routed SPA.
 */
function mountStatic(app: Hono<Env>, dir: string) {
  const root = resolve(dir);
  app.get("*", async (c) => {
    const pathname = c.req.path;
    if (pathname === "/api" || pathname.startsWith("/api/")) return c.json({ error: "not found" }, 404);
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return c.json({ error: "not found" }, 404);
    }
    if (decoded.includes("\0") || decoded.split("/").some((seg) => seg.startsWith(".") && seg.length > 0)) return c.json({ error: "not found" }, 404);
    const target = resolve(root, `.${decoded.replace(/\/+$/, "") || "/index.html"}`);
    const file = target === root || !target.startsWith(root + sep) ? null : Bun.file(target);
    const ext = extname(target);
    if (file && ext && (await file.exists())) {
      c.header("content-type", STATIC_TYPES[ext] ?? "application/octet-stream");
      c.header("cache-control", ext === ".html" ? "no-cache" : "public, max-age=31536000, immutable");
      return c.body(await file.arrayBuffer());
    }
    const index = Bun.file(join(root, "index.html"));
    if (!(await index.exists())) return c.json({ error: "not found" }, 404);
    c.header("content-type", STATIC_TYPES[".html"]!);
    c.header("cache-control", "no-cache");
    return c.body(await index.arrayBuffer());
  });
}
