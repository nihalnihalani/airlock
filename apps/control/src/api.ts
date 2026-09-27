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
  ApprovalDecision,
  CreateTaskRequest,
  HumanBrowserAction,
  PreviewRequest,
  canonicalJson,
  sha256,
  type AdapterRequest,
  type Artifact,
  type BlastRadiusCard,
  type BrowserAnyOp,
  type BrowserOpResult,
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
import { ArtifactError, ArtifactService, OWNER_QUOTA_BYTES, OWNER_QUOTA_FILES, UPLOAD_MAX_BYTES, dispositionFor, inlineAllowed } from "./artifact-service.ts";
import type { AvailabilityService, DiagnosticScript } from "./availability.ts";
import { ControlError, type ControlService } from "./browser-control.ts";
import { decideProposal, listProposals } from "./proposals.ts";
import { buildGeneralBundle, type GeneralExportGrant, type GeneralExportSeal } from "./general-export.ts";
import { STORE_KIND_GENERAL_CODE } from "./general-handler.ts";
import { TASK_PROFILES, publicTaskProfile, validateEgressAllow, type TaskProfile } from "./task-profiles.ts";
import type { TaskEventBus } from "./events.ts";
import { log } from "./log.ts";
import type { LoadedProfile } from "./profiles.ts";
import { redactBlastRadiusCard } from "./redact.ts";
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
  /**
   * AIRLOCK_PRODUCTION=1: tasks are refused while the supervisor is dev-unsafe, and a record
   * measured on a dev-unsafe host or plain runc (or, for export, without a fully BLOCKED isolation
   * probe on both records) is never previewed or exported.
   */
  production?: boolean;
  /** Task artifacts (uploads, outputs, screenshots); built from store + artifacts when absent. */
  artifactService?: ArtifactService;
  /** General task profile registry (default: task-profiles.ts). */
  taskProfiles?: ReadonlyMap<string, TaskProfile>;
  now?: () => number;
  /** SSE poll interval (ms) as a safety net behind the bus. */
  ssePollMs?: number;
  /** Exclusive browser control, live view and approvals (shared with the general handler). */
  control?: ControlService;
}

/** A human action: contracts HumanBrowserAction, or a file operation naming the caller's artifact (never bytes or paths). */
const HumanActionBody = z.union([
  HumanBrowserAction,
  z
    .object({
      request: z.discriminatedUnion("op", [
        z.object({ op: z.literal("download.list"), args: z.object({}).strict().optional() }),
        z.object({ op: z.literal("download.read"), args: z.object({ downloadId: z.string().regex(/^dl-[0-9]{1,6}$/) }).strict() }),
        z.object({ op: z.literal("upload"), args: z.object({ ref: z.string().regex(/^[a-z0-9]{1,16}$/i), generation: z.number().int().nonnegative(), artifactId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/) }).strict() }),
      ]),
    })
    .strict(),
]);

/** The runner's reply for the UI: image and file bytes are replaced by the stored artifact. */
function redactBrowserResult(raw: BrowserOpResult): BrowserOpResult {
  const response = raw.response;
  if (!response || !response.ok || !response.result || typeof response.result !== "object") return raw;
  const { png: _png, contentBase64: _content, ...rest } = response.result as Record<string, unknown>;
  return { ...raw, response: { ...response, result: rest } };
}

type Env = { Variables: { session: SessionRecord | null; role: Role; token: string | null } };

export const STORE_KIND_TASKS = "tasks";
export const STORE_KIND_GRANTS = "export-grants";
/** Artifact-store kind of the sealed export records (ExportSeal); the zip bytes are a blob. */
export const ARTIFACT_KIND_EXPORT = "export";
/** Artifact-store kind of sealed general-task evidence bundles (GeneralExportSeal). */
export const ARTIFACT_KIND_GENERAL_EXPORT = "general-export";
export const STORE_KIND_GENERAL_GRANTS = "general-export-grants";
/** Served with artifact bytes: nothing in them may run, load or frame anything. */
export const ARTIFACT_CSP = "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
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
/** Rate-limit memory per map; past it, expired entries go first, then the oldest. */
const RATE_KEYS_CAP = 1000;
export const PREDATES_IMAGE_IDENTITY = "verification record predates image identity; re-run verification";

/**
 * Records `keys` as used at `at`. Bounded without resetting everyone's limit: entries older than
 * the interval (they no longer limit anything) are evicted first, then the least recently used.
 */
export function rememberRateKeys(map: Map<string, number>, keys: string[], at: number, intervalMs: number, cap = RATE_KEYS_CAP): void {
  for (const k of keys) {
    map.delete(k);
    map.set(k, at);
  }
  if (map.size <= cap) return;
  for (const [k, t] of map) {
    if (map.size <= cap) return;
    if (at - t >= intervalMs && !keys.includes(k)) map.delete(k);
  }
  for (const k of map.keys()) {
    if (map.size <= cap) return;
    if (!keys.includes(k)) map.delete(k);
  }
}

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
  const artifactService = deps.artifactService ?? new ArtifactService(deps.store, deps.artifacts, () => (deps.now?.() ?? Date.now()));
  const taskProfiles = deps.taskProfiles ?? TASK_PROFILES;

  app.onError((error, c) => {
    if (error instanceof AppError) return c.json({ error: error.message }, error.status);
    if (error instanceof ArtifactError) return c.json({ error: error.message }, error.status);
    if (error instanceof ControlError) return c.json({ error: error.message }, error.status);
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

  // Cross-site request forgery: the session cookie is SameSite=Strict, and on top of that every
  // state-changing API request from a browser must come from this origin. Browsers send
  // Sec-Fetch-Site and Origin on such requests; a cross-site value is refused. Non-browser clients
  // (scripts, curl) send neither and are authenticated by the cookie they hold.
  app.use("/api/*", async (c, next) => {
    const method = c.req.method.toUpperCase();
    if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
      const site = c.req.header("sec-fetch-site");
      if (site !== undefined && site !== "same-origin" && site !== "none") return c.json({ error: "cross-site request refused" }, 403);
      const origin = c.req.header("origin");
      if (origin !== undefined) {
        let originHost: string | null = null;
        try {
          originHost = origin === "null" ? null : new URL(origin).host;
        } catch {
          originHost = null;
        }
        const host = c.req.header("x-forwarded-host") && trustedProxyRequest(c) ? c.req.header("x-forwarded-host") : c.req.header("host");
        if (!originHost || !host || originHost !== host) return c.json({ error: "cross-origin request refused" }, 403);
      }
    }
    await next();
  });
  const trustedProxyRequest = (c: Context<Env>): boolean => {
    const peer = peerAddress(c);
    return !!peer && trustedProxies.length > 0 && isTrustedProxy(peer);
  };

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
  // General task profiles: tools, budgets, checks and whether uploads are accepted (no task data).
  app.get("/api/task-profiles", (c) => c.json([...taskProfiles.values()].map(publicTaskProfile)));
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
    const availability = await repairAvailability(profile);
    // Instance ids and the model name are for signed-in operators and judges only.
    if (!c.get("session")) {
      const { instances: _instances, model: _model, ...open } = availability;
      return c.json(open);
    }
    return c.json(availability);
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
    if (body.kind === "general") return createGeneralTask(c, session, body);
    if (body.inputArtifactIds?.length || body.egressAllow?.length) throw new AppError("inputArtifactIds and egressAllow are for general tasks (kind \"general\")", 422);
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
    if (deps.production) {
      const host = await deps.supervisor.host();
      if (host.devUnsafe || host.selectedRuntime === "runc")
        throw new AppError(`this production control plane refuses new tasks: the supervisor runs ${host.selectedRuntime}${host.devUnsafe ? " with AIRLOCK_DEV_UNSAFE" : ""} (gVisor or Kata required)`, 503);
    }
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
  /**
   * A general task (40 §6): the profile must be in the general registry; inputs must be the caller's
   * own uploads (and the profile must accept uploads); egressAllow is required for a browser profile
   * and validated (no IP literals, localhost, `.internal`…), empty otherwise. The controller, not the
   * request, decides images, tools, limits and checks.
   */
  async function createGeneralTask(c: Context<Env>, session: SessionRecord, body: z.infer<typeof CreateTaskRequest>) {
    const profile = taskProfiles.get(body.profileId);
    if (!profile) throw new AppError(`general task profile "${body.profileId}" is not supported; available: ${[...taskProfiles.keys()].join(", ")}`, 422);
    if (body.liveGate) throw new AppError("liveGate applies to repair tasks only", 422);
    if (body.scriptedDriver !== undefined) {
      if (!deps.scriptedDrivers || !deps.scriptedDrivers.includes(body.scriptedDriver)) throw new AppError(`scripted driver "${body.scriptedDriver}" is not available`, 422);
    }
    const egress = validateEgressAllow(body.egressAllow, profile);
    if (!egress.ok) throw new AppError(`egressAllow refused: ${egress.reasons.join("; ")}`, 422);
    const inputIds = [...new Set(body.inputArtifactIds ?? [])];
    if (inputIds.length > 0 && !profile.acceptsUploads) throw new AppError(`profile "${profile.id}" does not accept input files`, 422);
    for (const id of inputIds) {
      const found = await artifactService.find(id);
      // Another owner's artifact reads as absent, like a task.
      if (!found || found.owner !== session.owner || found.artifact.kind !== "upload") throw new AppError(`input artifact ${id} not found among your uploads`, 422);
    }
    if (deps.production) {
      const host = await deps.supervisor.host();
      if (host.devUnsafe || host.selectedRuntime === "runc") throw new AppError(`this production control plane refuses new tasks: the supervisor runs ${host.selectedRuntime}${host.devUnsafe ? " with AIRLOCK_DEV_UNSAFE" : ""} (gVisor or Kata required)`, 503);
    }
    const scriptedDriver = body.scriptedDriver ?? deps.defaultScriptedDriver ?? undefined;
    const at = iso();
    const task: Task = {
      id: `task-${randomBytes(8).toString("hex")}`,
      owner: session.owner,
      profileId: profile.id,
      issueText: body.issueText,
      kind: "general",
      ...(inputIds.length ? { inputArtifactIds: inputIds } : {}),
      ...(egress.hosts.length ? { egressAllow: egress.hosts } : {}),
      ...(scriptedDriver !== undefined ? { scriptedDriver } : {}),
      status: "queued",
      phase: "prepare",
      generation: 0,
      leaseId: null,
      leaseUntil: null,
      attempts: 0,
      budget: { modelCallsUsed: 0, repairAttemptsUsed: 0, tokensUsed: 0 },
      cleanup: { status: "none", at },
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
      detail: `general task, profile ${profile.id} v${profile.version}${egress.hosts.length ? `; destinations ${egress.hosts.join(", ")}` : ""}${inputIds.length ? `; ${inputIds.length} input file(s)` : ""}${scriptedDriver !== undefined ? `; diagnostic (scripted:${scriptedDriver}), not a model run` : ""}`,
      data: { kind: "general", profileId: profile.id, profileVersion: profile.version, egressAllow: egress.hosts, inputArtifactIds: inputIds, ...(scriptedDriver !== undefined ? { diagnostic: true, scriptedDriver } : {}) },
    });
    return c.json(task, 201);
  }

  // ---- uploads and artifacts (C28) ----------------------------------------------------------------
  // Raw body upload: `POST /api/uploads` with the file bytes as the body and its name in the
  // `x-filename` header (URI-encoded allowed). No multipart. The type is sniffed from the bytes.
  app.post("/api/uploads", async (c) => {
    const session = requireRole(c, "operator", "judge");
    let filename = c.req.header("x-filename") ?? "";
    try {
      filename = decodeURIComponent(filename);
    } catch {
      // keep the raw header; it is sanitised anyway
    }
    if (!filename.trim() || filename.length > 1024) throw new AppError("x-filename header required (the file's name)", 400);
    const length = Number(c.req.header("content-length") ?? "");
    if (Number.isFinite(length) && length > UPLOAD_MAX_BYTES) throw new AppError(`upload exceeds ${UPLOAD_MAX_BYTES} bytes`, 413);
    const bytes = await readBodyBounded(c.req.raw, UPLOAD_MAX_BYTES);
    const artifact = await artifactService.ingestUpload(session.owner, filename, bytes);
    log.debug("upload stored", { artifactId: artifact.id, bytes: artifact.byteLength, mediaType: artifact.mediaType, role: session.role });
    return c.json(artifact, 201);
  });
  app.get("/api/uploads", async (c) => {
    const session = requireRole(c, "operator", "judge");
    const artifacts = await artifactService.listUploads(session.owner);
    return c.json({ artifacts, quota: { usedFiles: artifacts.length, usedBytes: artifacts.reduce((n, a) => n + a.byteLength, 0), maxFiles: OWNER_QUOTA_FILES, maxBytes: OWNER_QUOTA_BYTES, maxFileBytes: UPLOAD_MAX_BYTES } });
  });
  const serveArtifact = async (c: Context<Env>, artifact: Artifact) => {
    const bytes = await artifactService.bytes(artifact);
    const inline = inlineAllowed(artifact) && c.req.query("download") !== "1";
    c.header("content-type", artifact.mediaType);
    c.header("content-disposition", dispositionFor(artifact, inline));
    c.header("cache-control", "private, no-store");
    c.header("x-content-type-options", "nosniff");
    c.header("content-security-policy", ARTIFACT_CSP);
    c.header("x-airlock-sha256", artifact.sha256);
    return new Response(new Uint8Array(bytes).buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, { status: 200, headers: c.res.headers });
  };
  const artifactIdParam = (raw: string | undefined) => {
    const id = raw ?? "";
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id)) throw new AppError("invalid artifact id", 400);
    return id;
  };
  // Owner or operator; anything else reads as absent (404), like tasks.
  app.get("/api/artifacts/:artifactId", async (c) => {
    const session = requireRole(c, "operator", "judge");
    const found = await artifactService.find(artifactIdParam(c.req.param("artifactId")));
    if (!found || !canAccess(session, found.owner)) throw new AppError("artifact not found", 404);
    return serveArtifact(c, found.artifact);
  });
  app.get("/api/tasks/:id/artifacts", async (c) => {
    const { owner, task } = await authorizeTask(c);
    return c.json(await artifactService.listForTask(owner, task));
  });
  app.get("/api/tasks/:id/artifacts/:artifactId", async (c) => {
    const { owner, task } = await authorizeTask(c);
    const id = artifactIdParam(c.req.param("artifactId"));
    const artifact = (await artifactService.listForTask(owner, task)).find((a) => a.id === id);
    if (!artifact) throw new AppError("artifact not found", 404);
    return serveArtifact(c, artifact);
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

  // ---- human control, live view, supported final actions (40 Stage 5; audit 42 C22–C27) ------------
  // Owner or operator (authorizeTask), general browser tasks only, while the task runs in this
  // process. A human action keeps the task's egress policy, deadline and budgets and is never an
  // approval; there is no debugger/CDP endpoint.
  const controlService = (): ControlService => {
    if (!deps.control) throw new AppError("human control is not available on this control plane", 409);
    return deps.control;
  };
  const authorizeBrowserTask = async (c: Context<Env>) => {
    const ctx = await authorizeTask(c);
    if (ctx.task.kind !== "general" || !taskProfiles.get(ctx.task.profileId)?.browser) throw new AppError("only general tasks with a browser support human control", 422);
    return ctx;
  };
  const requireRunning = (task: Task) => {
    if (task.status !== "running") throw new AppError(`the task is ${task.status}; this needs a running task`, 409);
  };
  app.get("/api/tasks/:id/control", async (c) => {
    const { task } = await authorizeBrowserTask(c);
    return c.json({ control: task.control ?? { holder: "agent", since: task.updatedAt }, live: deps.control?.state(task.id) ?? null, idleMs: deps.control?.idleMs ?? null });
  });
  app.post("/api/tasks/:id/control/take", async (c) => {
    const { session, task } = await authorizeBrowserTask(c);
    requireRunning(task);
    return c.json(await controlService().take(task.id, { owner: session.owner, role: session.role }));
  });
  app.post("/api/tasks/:id/control/release", async (c) => {
    const { session, task } = await authorizeBrowserTask(c);
    return c.json(await controlService().release(task.id, { owner: session.owner, role: session.role }));
  });
  app.post("/api/tasks/:id/control/action", async (c) => {
    const { session, task } = await authorizeBrowserTask(c);
    requireRunning(task);
    const body = await readJson(c, HumanActionBody);
    let request: BrowserAnyOp;
    let tool: string;
    if (body.request.op === "upload") {
      // Only the caller's own artifacts can be uploaded, as their exact recorded bytes.
      const args = body.request.args;
      const found = await artifactService.find(args.artifactId);
      if (!found || found.owner !== session.owner) throw new AppError("artifact not found among your files", 404);
      if (found.artifact.byteLength > UPLOAD_MAX_BYTES) throw new AppError("artifact too large to upload", 413);
      const bytes = await artifactService.bytes(found.artifact);
      const filename = found.artifact.filename.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[^A-Za-z0-9]+/, "").slice(0, 128) || "upload.bin";
      request = { op: "upload", args: { ref: args.ref, generation: args.generation, filename, artifactSha256: found.artifact.sha256, contentBase64: Buffer.from(bytes).toString("base64") } };
      tool = "human_upload";
    } else {
      request = body.request as BrowserAnyOp;
      tool = `human_${request.op.replace(/[^a-z]+/g, "_")}`;
    }
    const outcome = await controlService().humanAction(task.id, { owner: session.owner }, request, request.op === "screenshot" ? "human_screenshot" : tool);
    if (!outcome.ok && !outcome.raw) return c.json({ ok: false, error: outcome.error, detail: outcome.payload }, 422);
    return c.json({ ok: outcome.ok, ...(outcome.ok ? {} : { error: outcome.error }), ...(outcome.ok && outcome.artifactId ? { artifactId: outcome.artifactId } : {}), result: redactBrowserResult(outcome.raw!) });
  });

  app.get("/api/tasks/:id/live", async (c) => {
    const { owner, task } = await authorizeBrowserTask(c);
    const frames = (await artifactService.listForTask(owner, task)).filter((a) => a.kind === "screenshot");
    const latest = frames.at(-1);
    return c.json({
      frame: latest ? { artifactId: latest.id, url: `/api/tasks/${task.id}/artifacts/${latest.id}`, sourceUrl: latest.source?.url ?? null, tool: latest.source?.tool ?? null, createdAt: latest.createdAt, sha256: latest.sha256, byteLength: latest.byteLength } : null,
      frames: frames.length,
      control: task.control ?? { holder: "agent", since: task.updatedAt },
      liveBrowser: deps.control?.state(task.id)?.liveBrowser ?? false,
      refreshMinIntervalMs: deps.control?.refreshMinIntervalMs ?? null,
    });
  });
  app.post("/api/tasks/:id/live/refresh", async (c) => {
    const { task } = await authorizeBrowserTask(c);
    requireRunning(task);
    const outcome = await controlService().liveRefresh(task.id);
    if (!outcome.ok) return c.json({ ok: false, error: outcome.error }, outcome.raw ? 502 : 409);
    return c.json({ ok: true, artifactId: outcome.artifactId, url: `/api/tasks/${task.id}/artifacts/${outcome.artifactId}` });
  });

  app.get("/api/tasks/:id/approvals", async (c) => {
    const { owner, task } = await authorizeBrowserTask(c);
    return c.json(await listProposals(deps.store, owner, task.id));
  });
  app.post("/api/tasks/:id/approvals/:aid/decide", async (c) => {
    const { session, owner, task } = await authorizeBrowserTask(c);
    const aid = c.req.param("aid") ?? "";
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(aid)) throw new AppError("invalid proposal id", 400);
    const body = await readJson(c, ApprovalDecision);
    // Only a running task can carry an approval out (its run expires open proposals when it ends).
    if (task.status !== "running") {
      const existing = (await listProposals(deps.store, owner, task.id)).find((p) => p.id === aid);
      if (!existing) throw new AppError("proposal not found", 404);
      throw new AppError(existing.status === "expired" ? "the proposal expired" : `the task is ${task.status}; the proposal can no longer be decided`, existing.status === "expired" ? 410 : 409);
    }
    const result = await decideProposal(deps.store, { owner, taskId: task.id, proposalId: aid, decision: body.decision, payloadDigest: body.payloadDigest, decidedBy: session.owner, now: now() });
    if (!result.ok) throw new AppError(result.error, result.status);
    deps.control?.notify(task.id);
    const event = await deps.store.appendEvent(owner, task.id, {
      id: `evt-${randomBytes(8).toString("hex")}`,
      at: iso(),
      kind: "lifecycle",
      title: body.decision === "approve" ? "Proposal approved" : "Proposal rejected",
      detail: `${result.proposal.formId} on ${result.proposal.destination} by ${session.role}; payload digest ${result.proposal.payloadDigest}`,
      data: { proposalId: aid, status: result.proposal.status, decidedBy: session.owner, payloadDigest: result.proposal.payloadDigest },
    });
    deps.bus.publish(event);
    return c.json(result.proposal);
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
    refuseUnsafeRecord(verification, "preview refused");
    if (canonicalJson(body.input).length > 65536) throw new AppError("preview input exceeds 64 KiB", 413);
    const bundle = await deps.artifacts.getJson<CandidateBundle>(ARTIFACT_KIND_BUNDLE, task.candidateDigest);
    if (!bundle) throw new AppError("sealed candidate bundle missing", 409);
    if (bundle.candidateDigest !== task.candidateDigest) throw new AppError("stored bundle digest mismatch", 409);
    const profile = deps.profiles.get(task.profileId);
    if (!profile) throw new AppError("profile no longer loaded", 409);
    // CLAUDE.md §3.3: preview uses exactly the runtime image, adapter and contract it was verified under.
    await refuseDrift(verification, profile, "preview refused", { newAuthorization: true });
    const request: AdapterRequest = { schemaVersion: 1, cases: [{ id: "preview", input: body.input }] };
    const deadlineMs = Math.min(profile.manifest.caps.attemptTimeoutMs, profile.manifest.caps.commandTimeoutMs * 3);
    // Only a preview that actually dispatches a sandbox run counts against the interval, which is
    // kept per session AND per client key: logging in again does not buy a fresh budget.
    const keys = [`session:${session.id}`, `client:${clientKey(c)}`];
    if (keys.some((k) => now() - (previewLast.get(k) ?? 0) < previewMinIntervalMs)) throw new AppError(`previews are limited to one per ${Math.ceil(previewMinIntervalMs / 1000)} s per session and client`, 429);
    rememberRateKeys(previewLast, keys, now(), previewMinIntervalMs);
    const result = await deps.supervisor.invoke(
      { taskId: task.id, profileId: task.profileId, role: "preview", bundle, request, absoluteDeadline: new Date(now() + deadlineMs).toISOString() },
      { timeoutMs: deadlineMs + 30_000 },
    );
    // The supervisor's own inspection of the preview sandbox must name the verified image and runtime
    // (and, when both carry one, the same local image id).
    const verifiedImageId = verification.runtimeProfile.inspection.imageId;
    const imageIdDiffers = !!verifiedImageId && !!result.inspection.imageId && result.inspection.imageId !== verifiedImageId;
    if (imageIdDiffers || result.inspection.imageDigest !== verification.runtimeImageDigest || result.inspection.runtime !== verification.runtimeProfile.inspection.runtime) {
      log.warn("preview refused: sandbox runtime differs from verification", { taskId: task.id, verifiedImage: verification.runtimeImageDigest, previewImage: result.inspection.imageDigest, verifiedImageId: verifiedImageId ?? null, previewImageId: result.inspection.imageId ?? null, verifiedRuntime: verification.runtimeProfile.inspection.runtime, previewRuntime: result.inspection.runtime });
      const ran = imageIdDiffers ? `${result.inspection.imageId!.slice(0, 80)}` : result.inspection.imageDigest.slice(0, 80);
      const verified = imageIdDiffers ? verifiedImageId!.slice(0, 80) : verification.runtimeImageDigest.slice(0, 80);
      throw new AppError(`${DRIFT_REFUSAL} (preview sandbox ran image ${ran} on ${result.inspection.runtime}; verified ${verified} on ${verification.runtimeProfile.inspection.runtime}); preview refused`, 409);
    }
    const observation = result.observations.find((o) => o.caseId === "preview");
    return c.json({ candidateDigest: task.candidateDigest, ...(observation ? { observation } : {}), exec: result.exec, inspection: result.inspection });
  });

  app.post("/api/tasks/:id/export", async (c) => {
    const { session, owner, task } = await authorizeTask(c);
    if (task.kind === "general") return exportGeneral(c, session, owner, task);
    const eligible = await exportEligibility(owner, task, { newAuthorization: true });
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
    if (!grant) {
      const general = await deps.store.get<GeneralExportGrant>(session.owner, STORE_KIND_GENERAL_GRANTS, grantId);
      if (general) return downloadGeneral(c, session, general);
      throw new AppError("grant not found", 404);
    }
    if (Date.parse(grant.expiresAt) <= now()) throw new AppError("grant expired; request a new export", 410);
    // Grants issued before sealed exports existed name no seal: they authorize nothing now.
    if (!grant.sealId || !grant.zipDigest || !grant.verificationRecordDigest) throw new AppError("grant predates sealed exports; request a new export", 410);
    const { owner, task } = await loadTask(grant.taskId);
    if (!canAccess(session, owner)) throw new AppError("grant not found", 404);
    // Eligibility is checked when the grant is used, not only when it was issued.
    const eligible = await exportEligibility(owner, task, { newAuthorization: false });
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
  async function exportEligibility(owner: string, task: Task, options: { newAuthorization: boolean }): Promise<{ verification: VerificationRecord; baseline: VerificationRecord; verificationRecordDigest: string; baselineRecordDigest: string }> {
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
    const baselineImageId = baseline.runtimeProfile.inspection.imageId;
    const candidateImageId = verification.runtimeProfile.inspection.imageId;
    if (baselineImageId && candidateImageId && baselineImageId !== candidateImageId) throw new AppError("baseline and candidate were measured on different runtime image ids; export refused", 409);
    refuseUnsafeRecord(baseline, "export refused");
    refuseUnsafeRecord(verification, "export refused");
    // M6: in production both records must carry checkpoint 4, fully BLOCKED.
    if (deps.production)
      for (const record of [baseline, verification])
        if (record.runtimeProfile.probe?.allBlocked !== true)
          throw new AppError(`the ${record.role} record carries no fully BLOCKED isolation probe (checkpoint 4); export refused`, 409);
    // Drift refuses a new grant AND the download of an already-sealed zip: evidence measured under a
    // configuration that is no longer the running one is not handed out as current.
    const profile = deps.profiles.get(task.profileId);
    if (!profile) throw new AppError("profile no longer loaded", 409);
    await refuseDrift(verification, profile, "export refused", options);
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

  // ---- general-task evidence bundle (C37) ---------------------------------------------------------------
  async function generalEligibility(task: Task): Promise<{ outcome: GeneralExportSeal["outcome"]; resultDigest: string; profile: TaskProfile }> {
    if (task.status !== "done" || (task.outcome !== "RESULT_VERIFIED" && task.outcome !== "RESULT_PARTIAL") || !task.result)
      throw new AppError(`only a verified or partial general result can be exported (task ${task.status}${task.outcome ? `, ${task.outcome}` : ""})`, 409);
    const profile = taskProfiles.get(task.profileId);
    if (!profile) throw new AppError("task profile no longer available", 409);
    return { outcome: task.outcome, resultDigest: await sha256(canonicalJson(task.result)), profile };
  }

  async function exportGeneral(c: Context<Env>, session: SessionRecord, owner: string, task: Task) {
    const eligible = await generalEligibility(task);
    const id = `gexp-${(await sha256(`${task.id}\n${eligible.resultDigest}`)).slice(0, 40)}`;
    let seal = await deps.artifacts.getJson<GeneralExportSeal>(ARTIFACT_KIND_GENERAL_EXPORT, id);
    if (seal && (seal.taskId !== task.id || seal.resultDigest !== eligible.resultDigest)) throw new AppError("sealed evidence does not match the task's result", 409);
    if (!seal) {
      const events = (await deps.store.listEvents(task.id, 0, 5000)).filter((e) => !(e.kind === "artifact" && (e.title === "Export authorized" || e.title === "Export sealed")));
      const all = await artifactService.listForTask(owner, task);
      const inputs = all.filter((a) => a.kind === "upload");
      const artifacts: { artifact: Artifact; bytes: Uint8Array }[] = [];
      for (const artifact of all.filter((a) => a.kind !== "upload")) artifacts.push({ artifact, bytes: await artifactService.bytes(artifact) });
      const code = (await deps.store.get<{ files: Record<string, { sha256: string; byteLength: number }> }>(owner, STORE_KIND_GENERAL_CODE, task.id))?.files ?? {};
      const codeFiles: { path: string; bytes: Uint8Array }[] = [];
      for (const [path, ref] of Object.entries(code)) {
        const bytes = await deps.artifacts.getBlob(ref.sha256);
        if (bytes) codeFiles.push({ path, bytes });
      }
      const { files } = buildGeneralBundle({ task, profile: eligible.profile, inputs, artifacts, codeFiles, events });
      const zip = deps.zipFiles(files);
      const zipDigest = await deps.artifacts.putBlob(zip);
      const fresh: GeneralExportSeal = { schemaVersion: 1, id, taskId: task.id, outcome: eligible.outcome, resultDigest: eligible.resultDigest, zipDigest, byteLength: zip.byteLength, eventsThroughSeq: events.at(-1)?.seq ?? 0, sealedAt: iso() };
      if (await deps.artifacts.putImmutableJson(ARTIFACT_KIND_GENERAL_EXPORT, id, fresh)) {
        seal = fresh;
        const event = await deps.store.appendEvent(owner, task.id, { id: `evt-${randomBytes(8).toString("hex")}`, at: iso(), kind: "artifact", title: "Export sealed", detail: `evidence bundle ${zipDigest} (${zip.byteLength} bytes, events through #${fresh.eventsThroughSeq})${eligible.outcome === "RESULT_PARTIAL" ? "; PARTIAL result" : ""}` });
        deps.bus.publish(event);
      } else seal = await deps.artifacts.getJson<GeneralExportSeal>(ARTIFACT_KIND_GENERAL_EXPORT, id);
      if (!seal || seal.resultDigest !== eligible.resultDigest) throw new AppError("sealed evidence does not match the task's result", 409);
    } else if (!(await deps.artifacts.getBlob(seal.zipDigest))) throw new AppError("sealed evidence bytes missing; export refused", 409);
    const existing = (await deps.store.list<GeneralExportGrant>(session.owner, STORE_KIND_GENERAL_GRANTS)).find((g) => g.taskId === task.id && g.sealId === seal!.id && Date.parse(g.expiresAt) > now());
    const grant: GeneralExportGrant = existing ?? {
      id: `grant-${randomBytes(12).toString("hex")}`,
      owner: session.owner,
      taskId: task.id,
      sealId: seal.id,
      resultDigest: seal.resultDigest,
      zipDigest: seal.zipDigest,
      outcome: seal.outcome,
      createdAt: iso(),
      expiresAt: new Date(now() + deps.exportGrantTtlMs).toISOString(),
    };
    if (!existing) {
      if (!(await deps.store.insertImmutable(session.owner, STORE_KIND_GENERAL_GRANTS, grant))) throw new AppError("grant id collision; retry", 409);
      const event = await deps.store.appendEvent(owner, task.id, { id: `evt-${randomBytes(8).toString("hex")}`, at: iso(), kind: "artifact", title: "Export authorized", detail: `grant ${grant.id}; evidence bundle ${grant.zipDigest}` });
      deps.bus.publish(event);
    }
    return c.json({ grantId: grant.id, url: `/api/exports/${grant.id}`, expiresAt: grant.expiresAt, zipDigest: grant.zipDigest, outcome: grant.outcome, partial: grant.outcome === "RESULT_PARTIAL" }, existing ? 200 : 201);
  }

  async function downloadGeneral(c: Context<Env>, session: SessionRecord, grant: GeneralExportGrant) {
    if (Date.parse(grant.expiresAt) <= now()) throw new AppError("grant expired; request a new export", 410);
    const { owner, task } = await loadTask(grant.taskId);
    if (!canAccess(session, owner)) throw new AppError("grant not found", 404);
    const eligible = await generalEligibility(task);
    if (eligible.resultDigest !== grant.resultDigest) throw new AppError("task no longer matches this grant", 409);
    const seal = await deps.artifacts.getJson<GeneralExportSeal>(ARTIFACT_KIND_GENERAL_EXPORT, grant.sealId);
    if (!seal || seal.zipDigest !== grant.zipDigest || seal.taskId !== task.id) throw new AppError("sealed evidence missing or does not match this grant", 409);
    const zip = await deps.artifacts.getBlob(seal.zipDigest);
    if (!zip || zip.byteLength !== seal.byteLength || (await sha256(zip)) !== seal.zipDigest) throw new AppError("sealed evidence bytes no longer match their digest", 409);
    c.header("content-type", "application/zip");
    c.header("content-disposition", `attachment; filename="airlock-${task.id}-${seal.outcome === "RESULT_PARTIAL" ? "partial" : "verified"}.zip"`);
    c.header("cache-control", "private, no-store");
    c.header("x-content-type-options", "nosniff");
    c.header("x-airlock-zip-sha256", seal.zipDigest);
    return new Response(new Uint8Array(zip).buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength) as ArrayBuffer, { status: 200, headers: c.res.headers });
  }

  // ---- hostile panel --------------------------------------------------------------------------------
  // Judge role only (37 §hostile panel). Limited per client key, not per session (a re-login is
  // the same client), plus a global interval and one run at a time across every client.
  app.post("/api/hostile", async (c) => {
    const session = requireRole(c, "judge");
    const body = await readJson(c, z.object({ command: z.string().min(1).max(4096), profileId: z.string().max(64).optional() }));
    const profileId = body.profileId ?? [...deps.profiles.keys()][0];
    if (!profileId || !deps.profiles.has(profileId)) throw new AppError("no such profile", 422);
    const key = clientKey(c);
    if (hostileInFlight) throw new AppError("a hostile run is already in progress; try again when it finishes", 429);
    if (now() - (hostileLast.get(key) ?? 0) < deps.hostileMinIntervalMs) throw new AppError(`hostile runs are limited to one per ${Math.ceil(deps.hostileMinIntervalMs / 1000)} s per client`, 429);
    if (now() - hostileGlobalLast < hostileGlobalMinIntervalMs) throw new AppError(`hostile runs are limited to one per ${Math.ceil(hostileGlobalMinIntervalMs / 1000)} s overall`, 429);
    rememberRateKeys(hostileLast, [key], now(), deps.hostileMinIntervalMs);
    hostileGlobalLast = now();
    hostileInFlight = true;
    try {
      const healthyBefore = await controlPlaneHealthy();
      const card: BlastRadiusCard = await deps.supervisor.hostile({ profileId, command: body.command });
      const healthyAfter = await controlPlaneHealthy();
      card.survived.controlPlane = { healthyBefore, healthyAfter, checkedAt: iso() };
      // Other tasks' attempts and sandboxes are counted, never named, except to an operator.
      if (session.role === "operator") return c.json(card);
      const own = new Set((await deps.store.list<Task>(session.owner, STORE_KIND_TASKS)).map((t) => t.id));
      return c.json(redactBlastRadiusCard(card, own));
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
  /** Production (AIRLOCK_PRODUCTION=1): a record measured dev-unsafe or on plain runc is never served. */
  function refuseUnsafeRecord(record: VerificationRecord, action: string): void {
    if (!deps.production) return;
    const insp = record.runtimeProfile.inspection;
    if (insp.devUnsafe || record.runtimeProfile.host.devUnsafe || insp.runtime === "runc")
      throw new AppError(`the ${record.role} record was measured on ${insp.runtime}${insp.devUnsafe || record.runtimeProfile.host.devUnsafe ? " (dev-unsafe)" : ""}; a production control plane does not serve it; ${action}`, 409);
  }

  async function refuseDrift(verification: VerificationRecord, profile: LoadedProfile, action: string, options: { newAuthorization: boolean }): Promise<void> {
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
    // HostCheck.runtimeImageId is a local image id (`sha256:<id>`). A record carries the inspected
    // image id (`inspection.imageId`) when the supervisor reports it; older records carry only
    // `runtimeImageDigest`: the repo digest when the image has one (`name@sha256:…`, not comparable
    // with an id), else the id itself. Compare like with like; a record whose identity cannot be
    // compared is refused new grants and previews (fail closed). The preview sandbox's own
    // inspection is compared after the run either way.
    const verifiedImageId = verification.runtimeProfile.inspection.imageId;
    const verifiedImage = verification.runtimeImageDigest;
    if (host.runtimeImageId) {
      if (verifiedImageId) {
        if (verifiedImageId !== host.runtimeImageId) drift.push(`runtime image ${host.runtimeImageId.slice(0, 80)} ≠ verified ${verifiedImageId.slice(0, 80)}`);
      } else if (!verifiedImage.includes("@")) {
        if (verifiedImage !== host.runtimeImageId) drift.push(`runtime image ${host.runtimeImageId.slice(0, 80)} ≠ verified ${verifiedImage.slice(0, 80)}`);
      } else if (options.newAuthorization) {
        log.warn("refused: verification record predates image identity", { taskId: verification.taskId, action, verifiedImage: verifiedImage.slice(0, 120) });
        throw new AppError(`${PREDATES_IMAGE_IDENTITY}; ${action}`, 409);
      }
    }
    if (drift.length) {
      log.warn("refused: configuration drift since verification", { taskId: verification.taskId, action, drift });
      throw new AppError(`${DRIFT_REFUSAL} (${drift.join("; ")}); ${action}`, 409);
    }
  }

  // ---- web UI (last, so every /api route above takes precedence) ------------------------------
  if (deps.webDist) mountStatic(app, deps.webDist);

  return app;
}

/** Reads a request body, refusing (413) once it exceeds `cap` bytes; never buffers past the cap. */
async function readBodyBounded(req: Request, cap: number): Promise<Uint8Array> {
  const reader = req.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => undefined);
      throw new AppError(`upload exceeds ${cap} bytes`, 413);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

/** Applied to every response, API, static and SSE alike (a streaming response keeps its body). */
function setSecurityHeaders(c: Context<Env>) {
  const apply = (headers: Headers) => {
    // Artifact bytes carry their own, stricter policy (ARTIFACT_CSP); everything else gets the app's.
    if (headers.get("content-security-policy") !== ARTIFACT_CSP) headers.set("content-security-policy", CONTENT_SECURITY_POLICY);
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
