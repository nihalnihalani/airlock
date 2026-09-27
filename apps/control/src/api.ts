/**
 * Control API (web → control). Cookie sessions, role checks on every route, SSE with
 * Last-Event-ID replay from the store, preview/export bound to the sealed candidate digest, and
 * the judge-only hostile panel. Errors are JSON `{error}`. `referenceCommitMaintainerOnly` never
 * leaves this process.
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
  type AdapterRequest,
  type CandidateBundle,
  type ExportGrant,
  type HostCheck,
  type ProfileManifest,
  type Role,
  type RunEvent,
  type SourceManifest,
  type Task,
  type TaskView,
  type VerificationRecord,
} from "@airlock/contracts";
import type { TaskEventBus } from "./events.ts";
import type { LoadedProfile } from "./profiles.ts";
import { ARTIFACT_KIND_BUNDLE, STORE_KIND_VERIFICATIONS, type ArtifactStoreLike } from "./repair-handler.ts";
import { LoginRateLimited, SESSION_COOKIE, readCookie, type SessionRecord, type SessionService } from "./sessions.ts";
import type { Store } from "./store/index.ts";
import { SupervisorError, SupervisorFenceError, SupervisorUnavailableError, type SupervisorClient } from "./supervisor-client.ts";
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
  worker: Pick<TaskWorker, "abort">;
  bus: TaskEventBus;
  exportBundle: ExportBundleFn;
  zipFiles: ZipFilesFn;
  exportGrantTtlMs: number;
  hostileMinIntervalMs: number;
  /** Per-session minimum interval between preview invocations (each one is a sandbox run on VM B). */
  previewMinIntervalMs?: number;
  /** Names a task may select with `scriptedDriver`; null (default) when the live driver is configured. */
  scriptedDrivers?: string[] | null;
  /** Built web UI directory served for every non-/api GET (SPA fallback to index.html). */
  webDist?: string | null;
  /**
   * Only when a reverse proxy in front of this process is known to overwrite/append
   * X-Forwarded-For does the login limiter key on the proxy's (rightmost) hop; otherwise those
   * headers are attacker-supplied and the socket peer address is used.
   */
  trustProxy?: boolean;
  now?: () => number;
  /** SSE poll interval (ms) as a safety net behind the bus. */
  ssePollMs?: number;
}

type Env = { Variables: { session: SessionRecord | null; role: Role; token: string | null } };

export const STORE_KIND_TASKS = "tasks";
export const STORE_KIND_GRANTS = "export-grants";
const MAX_JSON_BODY = 256 * 1024;
const TERMINAL = new Set<Task["status"]>(["cancelled", "done", "failed"]);

export function createApp(deps: ApiDeps) {
  const now = () => deps.now?.() ?? Date.now();
  const iso = () => new Date(now()).toISOString();
  const app = new Hono<Env>();
  const hostileLast = new Map<string, number>();
  const previewLast = new Map<string, number>();
  const previewMinIntervalMs = deps.previewMinIntervalMs ?? 2000;

  app.onError((error, c) => {
    if (error instanceof AppError) return c.json({ error: error.message }, error.status);
    if (error instanceof z.ZodError) return c.json({ error: `invalid body: ${error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ").slice(0, 500)}` }, 400);
    if (error instanceof LoginRateLimited) return c.json({ error: error.message }, 429);
    if (error instanceof SupervisorUnavailableError) return c.json({ error: "supervisor unavailable" }, 503);
    if (error instanceof SupervisorFenceError) return c.json({ error: error.message.slice(0, 300) }, 409);
    if (error instanceof SupervisorError) return c.json({ error: error.message.slice(0, 300) }, 502);
    console.error({ timestamp: new Date().toISOString(), context: { path: c.req.path }, error: error instanceof Error ? `${error.name}: ${error.message.slice(0, 300)}` : "request failed" });
    return c.json({ error: "internal error" }, 500);
  });
  app.notFound((c) => c.json({ error: "not found" }, 404));

  // Session resolution on every request; viewer when no valid cookie.
  app.use("*", async (c, next) => {
    const token = readCookie(c.req.header("cookie"), SESSION_COOKIE);
    const session = await deps.sessions.resolve(token);
    c.set("token", token);
    c.set("session", session);
    c.set("role", session?.role ?? "viewer");
    await next();
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
  const requireOwnerOrOperator = (session: SessionRecord, owner: string) => {
    if (session.role !== "operator" && session.owner !== owner) throw new AppError("not the owner of this task", 403);
  };
  const publicManifest = (m: ProfileManifest): Omit<ProfileManifest, "referenceCommitMaintainerOnly"> => {
    const { referenceCommitMaintainerOnly: _omit, ...rest } = m;
    return rest;
  };
  // The login limiter's key. X-Forwarded-For / X-Real-IP are client-controlled unless a trusted
  // proxy sets them, and even then only the hop the proxy appended (the rightmost) is its word;
  // rotating the leftmost entry must not buy a fresh budget. Without a trusted proxy the key is
  // the socket peer address (Bun's server.requestIP); when that is unknown every client shares
  // one bucket, which fails closed rather than open.
  const peerAddress = (c: Context<Env>): string | null => {
    const server = c.env as { requestIP?: (req: Request) => { address: string } | null } | undefined;
    try {
      const ip = server?.requestIP?.(c.req.raw)?.address;
      return typeof ip === "string" && ip.length > 0 ? ip.slice(0, 128) : null;
    } catch {
      return null;
    }
  };
  const clientKey = (c: Context<Env>): string => {
    if (deps.trustProxy) {
      const hops = (c.req.header("x-forwarded-for") ?? "").split(",").map((h) => h.trim()).filter(Boolean);
      const hop = hops.at(-1) ?? c.req.header("x-real-ip")?.trim();
      if (hop) return `proxy:${hop.slice(0, 128)}`;
    }
    const peer = peerAddress(c);
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
  app.get("/api/host", async (c) => c.json(await deps.supervisor.host()));

  // ---- tasks ----------------------------------------------------------------------------------------
  app.post("/api/tasks", async (c) => {
    const session = requireRole(c, "operator", "judge");
    const body = await readJson(c, CreateTaskRequest);
    if (!deps.profiles.has(body.profileId)) throw new AppError(`profile "${body.profileId}" is not supported`, 422);
    if (body.scriptedDriver !== undefined) {
      if (!deps.scriptedDrivers) throw new AppError("scriptedDriver is only accepted when the control plane runs a scripted model driver", 422);
      if (!deps.scriptedDrivers.includes(body.scriptedDriver)) throw new AppError(`scripted driver "${body.scriptedDriver}" is not available; available: ${deps.scriptedDrivers.join(", ")}`, 422);
    }
    const at = iso();
    const task: Task = {
      id: `task-${randomBytes(8).toString("hex")}`,
      owner: session.owner,
      profileId: body.profileId,
      issueText: body.issueText,
      ...(body.scriptedDriver !== undefined ? { scriptedDriver: body.scriptedDriver } : {}),
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
    await deps.store.appendEvent(session.owner, task.id, { id: `evt-${randomBytes(8).toString("hex")}`, at, kind: "lifecycle", title: "Task created", detail: `profile ${task.profileId}` });
    return c.json(task, 201);
  });
  app.get("/api/tasks", async (c) => {
    const rows = await deps.store.scan<Task>(STORE_KIND_TASKS);
    const tasks = rows.map((r) => r.value).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return c.json(tasks);
  });
  app.get("/api/tasks/:id", async (c) => {
    const { owner, task } = await loadTask(taskId(c));
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
    const id = taskId(c);
    const { owner } = await loadTask(id);
    // Replay cursor: the browser's automatic reconnect sends Last-Event-ID; apps/web's own
    // reopen (after a CLOSED stream) passes ?lastEventId=<seq>; ?after= is kept for curl users.
    const header = c.req.header("last-event-id") ?? c.req.query("lastEventId") ?? c.req.query("after") ?? "0";
    const afterSeq = /^\d{1,12}$/.test(header) ? Number(header) : 0;
    const pollMs = deps.ssePollMs ?? 2000;
    return streamSSE(c, async (stream) => {
      let cursor = afterSeq;
      let lastTaskUpdatedAt = "";
      let wake: (() => void) | null = null;
      const unsubscribe = deps.bus.subscribe(id, () => wake?.());
      const send = async (event: RunEvent) => {
        if (event.seq <= cursor) return;
        cursor = event.seq;
        await stream.writeSSE({ id: String(event.seq), event: event.kind, data: JSON.stringify(event) });
      };
      const drain = async () => {
        for (;;) {
          const batch = await deps.store.listEvents(id, cursor, 500);
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
      }
    });
  });

  app.post("/api/tasks/:id/cancel", async (c) => {
    const session = requireRole(c, "operator", "judge");
    const { owner, task } = await loadTask(taskId(c));
    requireOwnerOrOperator(session, owner);
    if (TERMINAL.has(task.status)) throw new AppError(`task is already ${task.status}`, 409);
    if (task.status === "cancelling") return c.json(task);
    const at = iso();
    let next: Task | null = null;
    if (task.status === "queued") {
      next = await deps.store.compareAndSwap<Task>(owner, STORE_KIND_TASKS, task.id, { status: "queued", leaseId: null }, { status: "cancelled", updatedAt: at });
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

  // Preview is deliberately open to judge sessions on any task (the demo flow: the operator runs
  // the repair, the judge tries the sealed candidate). It writes nothing and is bound to the sealed
  // digest; what bounds it is the per-session interval, since every call is a sandbox run on VM B.
  app.post("/api/tasks/:id/preview", async (c) => {
    const session = requireRole(c, "operator", "judge");
    const { owner, task } = await loadTask(taskId(c));
    const body = await readJson(c, PreviewRequest);
    const lastPreview = previewLast.get(session.id) ?? 0;
    if (now() - lastPreview < previewMinIntervalMs) throw new AppError(`previews are limited to one per ${Math.ceil(previewMinIntervalMs / 1000)} s per session`, 429);
    previewLast.set(session.id, now());
    if (previewLast.size > 1000) previewLast.clear();
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
    const request: AdapterRequest = { schemaVersion: 1, cases: [{ id: "preview", input: body.input }] };
    const deadlineMs = Math.min(profile.manifest.caps.attemptTimeoutMs, profile.manifest.caps.commandTimeoutMs * 3);
    const result = await deps.supervisor.invoke(
      { taskId: task.id, profileId: task.profileId, role: "preview", bundle, request, absoluteDeadline: new Date(now() + deadlineMs).toISOString() },
      { timeoutMs: deadlineMs + 30_000 },
    );
    const observation = result.observations.find((o) => o.caseId === "preview");
    return c.json({ candidateDigest: task.candidateDigest, ...(observation ? { observation } : {}), exec: result.exec, inspection: result.inspection });
  });

  app.post("/api/tasks/:id/export", async (c) => {
    const session = requireRole(c, "operator", "judge");
    const { owner, task } = await loadTask(taskId(c));
    requireOwnerOrOperator(session, owner);
    if (!task.candidateDigest || !task.verificationRecordId || !task.baselineRecordId) throw new AppError("task has no verified candidate to export", 409);
    const verification = await deps.store.get<VerificationRecord>(owner, STORE_KIND_VERIFICATIONS, task.verificationRecordId);
    if (!verification || verification.candidateDigest !== task.candidateDigest) throw new AppError("verification record missing or for a different candidate", 409);
    const existing = (await deps.store.list<ExportGrant>(session.owner, STORE_KIND_GRANTS)).find(
      (g) => g.taskId === task.id && g.candidateDigest === task.candidateDigest && g.verificationRecordId === verification.id && Date.parse(g.expiresAt) > now(),
    );
    const grant: ExportGrant = existing ?? {
      id: `grant-${randomBytes(12).toString("hex")}`,
      owner: session.owner,
      taskId: task.id,
      candidateDigest: task.candidateDigest,
      verificationRecordId: verification.id,
      createdAt: iso(),
      expiresAt: new Date(now() + deps.exportGrantTtlMs).toISOString(),
    };
    if (!existing) {
      const inserted = await deps.store.insertImmutable(session.owner, STORE_KIND_GRANTS, grant);
      if (!inserted) throw new AppError("grant id collision; retry", 409);
      const event = await deps.store.appendEvent(owner, task.id, { id: `evt-${randomBytes(8).toString("hex")}`, at: iso(), kind: "artifact", title: "Export authorized", detail: `grant ${grant.id} for ${grant.candidateDigest}` });
      deps.bus.publish(event);
    }
    return c.json({ grantId: grant.id, url: `/api/exports/${grant.id}`, expiresAt: grant.expiresAt }, existing ? 200 : 201);
  });

  app.get("/api/exports/:grantId", async (c) => {
    const session = requireRole(c, "operator", "judge");
    const grantId = c.req.param("grantId");
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(grantId)) throw new AppError("invalid grant id", 400);
    const grant = await deps.store.get<ExportGrant>(session.owner, STORE_KIND_GRANTS, grantId);
    if (!grant) throw new AppError("grant not found", 404);
    if (Date.parse(grant.expiresAt) <= now()) throw new AppError("grant expired; request a new export", 410);
    const { owner, task } = await loadTask(grant.taskId);
    if (task.candidateDigest !== grant.candidateDigest || task.verificationRecordId !== grant.verificationRecordId)
      throw new AppError("task no longer matches this grant", 409);
    const verification = await deps.store.get<VerificationRecord>(owner, STORE_KIND_VERIFICATIONS, grant.verificationRecordId);
    const baseline = task.baselineRecordId ? await deps.store.get<VerificationRecord>(owner, STORE_KIND_VERIFICATIONS, task.baselineRecordId) : null;
    if (!verification || !baseline) throw new AppError("verification records missing", 409);
    const bundle = await deps.artifacts.getJson<CandidateBundle>(ARTIFACT_KIND_BUNDLE, grant.candidateDigest);
    if (!bundle || bundle.candidateDigest !== grant.candidateDigest) throw new AppError("sealed candidate bundle missing", 409);
    const profile = deps.profiles.get(task.profileId);
    if (!profile) throw new AppError("profile no longer loaded", 409);
    const events = await deps.store.listEvents(task.id, 0, 5000);
    const { files } = await deps.exportBundle({ profile: publicManifest(profile.manifest) as ProfileManifest, baseFiles: profile.baseFiles, bundle, verification, baseline, task, events });
    const zip = deps.zipFiles(files);
    c.header("content-type", "application/zip");
    c.header("content-disposition", `attachment; filename="airlock-${task.id}-${grant.candidateDigest.slice(0, 12)}.zip"`);
    c.header("cache-control", "private, no-store");
    return new Response(new Uint8Array(zip).buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength) as ArrayBuffer, { status: 200, headers: c.res.headers });
  });

  // ---- hostile panel --------------------------------------------------------------------------------
  app.post("/api/hostile", async (c) => {
    const session = requireRole(c, "operator", "judge");
    const body = await readJson(c, z.object({ command: z.string().min(1).max(4096), profileId: z.string().max(64).optional() }));
    const last = hostileLast.get(session.id) ?? 0;
    if (now() - last < deps.hostileMinIntervalMs) throw new AppError(`hostile runs are limited to one per ${Math.ceil(deps.hostileMinIntervalMs / 1000)} s per session`, 429);
    hostileLast.set(session.id, now());
    if (hostileLast.size > 1000) hostileLast.clear();
    const profileId = body.profileId ?? [...deps.profiles.keys()][0];
    if (!profileId || !deps.profiles.has(profileId)) throw new AppError("no such profile", 422);
    const card = await deps.supervisor.hostile({ profileId, command: body.command });
    return c.json(card);
  });

  // ---- web UI (last, so every /api route above takes precedence) ------------------------------
  if (deps.webDist) mountStatic(app, deps.webDist);

  return app;
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
