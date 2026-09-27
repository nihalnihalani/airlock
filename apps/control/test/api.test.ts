import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import type { BlastRadiusCard, RepairAvailability, Task, VerificationRecord } from "@airlock/contracts";
import { ARTIFACT_KIND_EXPORT, CONTENT_SECURITY_POLICY, createApp, PREDATES_IMAGE_IDENTITY, rememberRateKeys, STORE_KIND_GRANTS, type ApiDeps } from "../src/api.ts";
import { RepairAvailabilityService, SCRIPTED_REASON } from "../src/availability.ts";
import { exportBundle } from "../src/artifacts/index.ts";
import { TaskEventBus } from "../src/events.ts";
import { ARTIFACT_KIND_BUNDLE, STORE_KIND_VERIFICATIONS, computeAdapterDigest } from "../src/repair-handler.ts";
import { SessionService } from "../src/sessions.ts";
import { createStore, type Store } from "../src/store/index.ts";
import { exportBundleDouble, FX_FIXED_SOURCE, fixtureObserve, makeFixture, MemoryArtifactStore, scriptedDriverDouble, zipFilesDouble, type Fixture } from "./helpers/doubles.ts";
import { FakeSupervisor, fakeHost } from "./helpers/fake-supervisor.ts";
import { makeHarness, OWNER, type Harness } from "./helpers/harness.ts";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const OPERATOR = "operator-pass-123";
const JUDGE = "judge-pass-456";

let fixture: Fixture;
beforeAll(async () => {
  fixture = await makeFixture();
});
afterAll(async () => {
  await fixture.cleanup();
});

interface Ctx {
  app: ReturnType<typeof createApp>;
  store: Store;
  supervisor: FakeSupervisor;
  artifacts: MemoryArtifactStore;
  harness: Harness | null;
  bus: TaskEventBus;
  deps: ApiDeps;
  close: () => Promise<void>;
}

async function makeCtx(options: { withWorker?: boolean; now?: () => number; webDist?: string; trustedProxies?: string[]; realExport?: boolean; driverScript?: Parameters<typeof scriptedDriverDouble>[0]; supervisor?: FakeSupervisor; extra?: Partial<ApiDeps> } = {}): Promise<Ctx> {
  const supervisor = options.supervisor ?? new FakeSupervisor({ profile: fixture.profile, observe: fixtureObserve });
  let harness: Harness | null = null;
  let store: Store;
  let artifacts: MemoryArtifactStore;
  let bus: TaskEventBus;
  if (options.withWorker) {
    const driver = scriptedDriverDouble(options.driverScript ?? [
      { toolCalls: [{ name: "write_file", args: { path: "lib/mod.py", content: FX_FIXED_SOURCE } }] },
      { toolCalls: [{ name: "submit_candidate", args: { summary: "fix" } }] },
    ]);
    harness = await makeHarness(fixture, supervisor, driver);
    store = harness.store;
    artifacts = harness.artifacts;
    bus = harness.bus;
    harness.worker.start();
  } else {
    store = await createStore();
    artifacts = new MemoryArtifactStore();
    bus = new TaskEventBus();
  }
  const sessions = new SessionService(store, { operatorPassword: OPERATOR, judgePassword: JUDGE, ttlMs: 60_000, secureCookies: false, ...(options.now ? { now: options.now } : {}) });
  const deps: ApiDeps = {
    store,
    sessions,
    profiles: new Map([[fixture.profile.manifest.id, fixture.profile]]),
    supervisor,
    artifacts,
    worker: harness?.worker ?? { abort: () => undefined },
    bus,
    exportBundle: options.realExport ? exportBundle : exportBundleDouble,
    zipFiles: zipFilesDouble,
    exportGrantTtlMs: 60_000,
    hostileMinIntervalMs: 10_000,
    runtimeDir: fixture.runtimeDir,
    ssePollMs: 20,
    ...(options.now ? { now: options.now } : {}),
    ...(options.webDist ? { webDist: options.webDist } : {}),
    ...(options.trustedProxies ? { trustedProxies: options.trustedProxies } : {}),
    ...options.extra,
  };
  const app = createApp(deps);
  return { app, store, supervisor, artifacts, harness, bus, deps, close: async () => (harness ? harness.close() : store.close()) };
}

async function login(app: Ctx["app"], password: string): Promise<string> {
  const res = await app.request("/api/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }) });
  expect(res.status).toBe(200);
  const cookie = res.headers.get("set-cookie") ?? "";
  expect(cookie).toContain("HttpOnly");
  return cookie.split(";")[0]!;
}
const json = (body: unknown, cookie?: string) => ({ method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });

async function completedTask(ctx: Ctx, cookie: string): Promise<Task> {
  const created = await ctx.app.request("/api/tasks", json({ profileId: "fx-1", issueText: "compute(0) raises" }, cookie));
  expect(created.status).toBe(201);
  const task = (await created.json()) as Task;
  return ctx.harness!.waitFor(task.id);
}

describe("sessions", () => {
  test("login roles, viewer by default, logout, wrong password", async () => {
    const ctx = await makeCtx();
    try {
      expect(await (await ctx.app.request("/api/session")).json()).toEqual({ role: "viewer" });
      const op = await login(ctx.app, OPERATOR);
      expect(await (await ctx.app.request("/api/session", { headers: { cookie: op } })).json()).toEqual({ role: "operator" });
      const judge = await login(ctx.app, JUDGE);
      expect(await (await ctx.app.request("/api/session", { headers: { cookie: judge } })).json()).toEqual({ role: "judge" });
      const bad = await ctx.app.request("/api/session", json({ password: "nope-nope-nope" }));
      expect(bad.status).toBe(401);
      expect(await bad.json()).toEqual({ error: "password incorrect" });
      const out = await ctx.app.request("/api/session", { method: "DELETE", headers: { cookie: op } });
      expect(out.status).toBe(200);
      expect(await (await ctx.app.request("/api/session", { headers: { cookie: op } })).json()).toEqual({ role: "viewer" });
      // Tampered cookie value never resolves.
      expect(await (await ctx.app.request("/api/session", { headers: { cookie: "airlock_session=../../x" } })).json()).toEqual({ role: "viewer" });
    } finally {
      await ctx.close();
    }
  });

  test("login rate limit cannot be evaded by rotating X-Forwarded-For (proxy headers are ignored unless trusted)", async () => {
    const ctx = await makeCtx();
    try {
      let last = 0;
      for (let i = 0; i < 12; i++) last = (await ctx.app.request("/api/session", { ...json({ password: "wrong-wrong" }), headers: { "content-type": "application/json", "x-forwarded-for": `10.0.0.${i}`, "x-real-ip": `10.1.0.${i}` } })).status;
      expect(last).toBe(429);
      // A correct password on a locked-out key is refused too: no guessing budget beyond the limit.
      expect((await ctx.app.request("/api/session", { ...json({ password: OPERATOR }), headers: { "content-type": "application/json", "x-forwarded-for": "10.0.0.99" } })).status).toBe(429);
    } finally {
      await ctx.close();
    }
  });

  // Over a real socket (Bun.serve) so the peer address reaches the app, as in index.ts.
  const serve = (app: Ctx["app"]) => {
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch });
    const post = async (headers: Record<string, string>, password = "wrong-wrong") =>
      (await fetch(`http://127.0.0.1:${server.port}/api/session`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ password }) })).status;
    return { post, stop: () => server.stop(true) };
  };

  test("with a trusted loopback proxy the limit is keyed on the rightmost X-Forwarded-For hop, so a rotating client-supplied leftmost entry does not evade it", async () => {
    const ctx = await makeCtx({ trustedProxies: ["loopback"] });
    const s = serve(ctx.app);
    try {
      let last = 0;
      for (let i = 0; i < 12; i++) last = await s.post({ "x-forwarded-for": `10.0.0.${i}, 203.0.113.7` });
      expect(last).toBe(429);
      // Another client behind the same proxy has its own budget.
      expect(await s.post({ "x-forwarded-for": "10.0.0.1, 203.0.113.8" })).toBe(401);
    } finally {
      s.stop();
      await ctx.close();
    }
  });

  test("a client that reaches the port directly, bypassing the trusted proxy, cannot evade the limit with its own X-Forwarded-For or X-Real-IP", async () => {
    // The proxy is at 203.0.113.7; this connection's peer is 127.0.0.1, so its headers are attacker-supplied.
    const ctx = await makeCtx({ trustedProxies: ["203.0.113.7"] });
    const s = serve(ctx.app);
    try {
      const statuses = new Set<number>();
      for (let i = 0; i < 12; i++) statuses.add(await s.post({ "x-forwarded-for": `10.0.0.${i}` }));
      expect(statuses.has(429)).toBe(true);
      for (let i = 0; i < 3; i++) expect(await s.post({ "x-real-ip": `10.1.0.${i}` })).toBe(429);
      // The correct password on the locked-out peer is refused too.
      expect(await s.post({ "x-forwarded-for": "10.0.0.99" }, OPERATOR)).toBe(429);
    } finally {
      s.stop();
      await ctx.close();
    }
  });

  test("a trusted proxy flag without a known peer address does not trust the headers", async () => {
    // app.request() carries no server env, so the peer is unknown: fail closed on one shared key.
    const ctx = await makeCtx({ trustedProxies: ["loopback"] });
    try {
      let last = 0;
      for (let i = 0; i < 12; i++) last = (await ctx.app.request("/api/session", { ...json({ password: "wrong-wrong" }), headers: { "content-type": "application/json", "x-forwarded-for": `10.0.0.${i}, 203.0.113.${i}` } })).status;
      expect(last).toBe(429);
    } finally {
      await ctx.close();
    }
  });

  test("login is rate limited per client", async () => {
    const ctx = await makeCtx();
    try {
      let last = 0;
      for (let i = 0; i < 12; i++) last = (await ctx.app.request("/api/session", { ...json({ password: "wrong-wrong" }), headers: { "content-type": "application/json", "x-forwarded-for": "10.9.9.9" } })).status;
      expect(last).toBe(429);
    } finally {
      await ctx.close();
    }
  });
});

describe("routes and roles", () => {
  test("profiles never expose the maintainer reference commit", async () => {
    const ctx = await makeCtx();
    try {
      const res = await ctx.app.request("/api/profiles");
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).not.toContain("referenceCommitMaintainerOnly");
      expect(text).not.toContain("b".repeat(40));
      expect((JSON.parse(text) as { id: string }[])[0]?.id).toBe("fx-1");
    } finally {
      await ctx.close();
    }
  });

  test("viewer cannot create, cancel, preview, export or run hostile; invalid bodies are 400", async () => {
    const ctx = await makeCtx();
    try {
      expect((await ctx.app.request("/api/tasks", json({ profileId: "fx-1", issueText: "x" }))).status).toBe(401);
      expect((await ctx.app.request("/api/hostile", json({ command: "rm -rf /" }))).status).toBe(401);
      const op = await login(ctx.app, OPERATOR);
      const bad = await ctx.app.request("/api/tasks", json({ profileId: "fx-1" }, op));
      expect(bad.status).toBe(400);
      expect(((await bad.json()) as { error: string }).error).toContain("invalid body");
      const unsupported = await ctx.app.request("/api/tasks", json({ profileId: "nope", issueText: "x" }, op));
      expect(unsupported.status).toBe(422);
      // scriptedDriver is a diagnostics-only field: refused when no scripted catalog is configured.
      const scripted = await ctx.app.request("/api/tasks", json({ profileId: "fx-1", issueText: "x", scriptedDriver: "diagnostic" }, op));
      expect(scripted.status).toBe(422);
      expect(((await scripted.json()) as { error: string }).error).toContain("scripted");
      const notJson = await ctx.app.request("/api/tasks", { method: "POST", headers: { "content-type": "application/json", cookie: op }, body: "{oops" });
      expect(notJson.status).toBe(400);
      expect((await ctx.app.request("/api/tasks/nope", { headers: { cookie: op } })).status).toBe(404);
      expect((await ctx.app.request("/api/tasks/../etc", { headers: { cookie: op } })).status).toBe(404);
      // No anonymous reads of task data: list, detail and events all need a session.
      expect((await ctx.app.request("/api/tasks")).status).toBe(401);
      expect((await ctx.app.request("/api/tasks/nope")).status).toBe(401);
      expect((await ctx.app.request("/api/tasks/nope/events")).status).toBe(401);
      // The host check needs a session; liveness does not, and says nothing else.
      expect((await ctx.app.request("/api/host")).status).toBe(401);
      expect((await ctx.app.request("/api/host", { headers: { cookie: op } })).status).toBe(200);
      const health = await ctx.app.request("/api/health");
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ ok: true });
    } finally {
      await ctx.close();
    }
  });

  test("create → list → view; a judge cannot see or cancel an operator's task, operator can cancel anything", async () => {
    const ctx = await makeCtx();
    try {
      const op = await login(ctx.app, OPERATOR);
      const judge = await login(ctx.app, JUDGE);
      const created = await ctx.app.request("/api/tasks", json({ profileId: "fx-1", issueText: "compute(0) raises" }, op));
      expect(created.status).toBe(201);
      const task = (await created.json()) as Task;
      expect(task.status).toBe("queued");
      // A role is never an owner: each login is its own principal.
      expect(task.owner).toMatch(/^operator-[a-f0-9]{24}$/);
      const list = (await (await ctx.app.request("/api/tasks", { headers: { cookie: op } })).json()) as Task[];
      expect(list.map((t) => t.id)).toEqual([task.id]);
      expect(await (await ctx.app.request("/api/tasks", { headers: { cookie: judge } })).json()).toEqual([]);
      expect((await ctx.app.request(`/api/tasks/${task.id}`, { headers: { cookie: judge } })).status).toBe(404);
      expect((await ctx.app.request(`/api/tasks/${task.id}/events`, { headers: { cookie: judge } })).status).toBe(404);
      const view = (await (await ctx.app.request(`/api/tasks/${task.id}`, { headers: { cookie: op } })).json()) as { task: Task; cases?: { id: string; kind: string; title: string }[] };
      expect(view.task.id).toBe(task.id);
      // Contract case titles ride on the view for the case table; inputs/expectations do not.
      expect(view.cases?.map((c) => c.id)).toEqual(fixture.profile.contract.cases.map((c) => c.id));
      expect(view.cases?.every((c) => typeof c.title === "string" && !("input" in c))).toBe(true);
      expect((await ctx.app.request(`/api/tasks/${task.id}/cancel`, json({}, judge))).status).toBe(404);
      const cancelled = await ctx.app.request(`/api/tasks/${task.id}/cancel`, json({}, op));
      expect(cancelled.status).toBe(200);
      expect(((await cancelled.json()) as Task).status).toBe("cancelled");
      expect((await ctx.app.request(`/api/tasks/${task.id}/cancel`, json({}, op))).status).toBe(409);
    } finally {
      await ctx.close();
    }
  });

  test("hostile is judge only and rate limited per client, so logging in again does not reset it", async () => {
    let t = 1_000_000;
    const ctx = await makeCtx({ now: () => t });
    try {
      const op = await login(ctx.app, OPERATOR);
      expect((await ctx.app.request("/api/hostile", json({ command: "true" }, op))).status).toBe(403);
      const judge = await login(ctx.app, JUDGE);
      const first = await ctx.app.request("/api/hostile", json({ command: ":(){ :|:& };:" }, judge));
      expect(first.status).toBe(200);
      expect(((await first.json()) as { survived: { supervisorHealthy: boolean } }).survived.supervisorHealthy).toBe(true);
      const second = await ctx.app.request("/api/hostile", json({ command: "cat /etc/shadow" }, judge));
      expect(second.status).toBe(429);
      // A fresh login (new session, same client) is still limited.
      const relogin = await login(ctx.app, JUDGE);
      expect((await ctx.app.request("/api/hostile", json({ command: "cat /etc/shadow" }, relogin))).status).toBe(429);
      t += 10_001;
      expect((await ctx.app.request("/api/hostile", json({ command: "cat /etc/shadow" }, judge))).status).toBe(200);
      expect(ctx.supervisor.hostileCommands).toHaveLength(2);
      expect((await ctx.app.request("/api/hostile", json({ command: "" }, judge))).status).toBe(400);
    } finally {
      await ctx.close();
    }
  });
});

describe("static web UI", () => {
  test("serves dist behind /api with SPA fallback; refuses traversal and dotfiles", async () => {
    const dist = await mkdtemp(join(tmpdir(), "airlock-dist-"));
    await mkdir(join(dist, "assets"));
    await writeFile(join(dist, "index.html"), "<!doctype html><title>Airlock</title>");
    await writeFile(join(dist, "assets", "app.js"), "console.log(1)");
    await writeFile(join(dist, ".secret"), "nope");
    const ctx = await makeCtx({ webDist: dist });
    try {
      const index = await ctx.app.request("/");
      expect(index.status).toBe(200);
      expect(index.headers.get("content-type")).toContain("text/html");
      expect(await index.text()).toContain("Airlock");
      const js = await ctx.app.request("/assets/app.js");
      expect(js.status).toBe(200);
      expect(js.headers.get("content-type")).toContain("javascript");
      // Unknown paths fall back to the SPA shell; API misses stay JSON 404s.
      expect((await ctx.app.request("/tasks/abc")).headers.get("content-type")).toContain("text/html");
      const apiMiss = await ctx.app.request("/api/nope");
      expect(apiMiss.status).toBe(404);
      expect(await apiMiss.json()).toEqual({ error: "not found" });
      expect((await ctx.app.request("/api/session")).status).toBe(200);
      expect((await ctx.app.request("/.secret")).status).toBe(404);
      const traversal = await ctx.app.request("/assets/..%2f..%2f..%2fetc%2fpasswd");
      expect(traversal.status === 404 || (traversal.headers.get("content-type") ?? "").includes("text/html")).toBe(true);
      expect(await traversal.text()).not.toContain("root:");
    } finally {
      await ctx.close();
    }
  });

  test("without a dist directory every non-API path is a JSON 404", async () => {
    const ctx = await makeCtx();
    try {
      const res = await ctx.app.request("/");
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not found" });
    } finally {
      await ctx.close();
    }
  });
});

describe("SSE", () => {
  test("replays events after Last-Event-ID and ends on a terminal task", async () => {
    const ctx = await makeCtx();
    try {
      const at = new Date().toISOString();
      const task: Task = { id: "task-sse", owner: OWNER, profileId: "fx-1", issueText: "x", status: "done", phase: "ready", outcome: "CHECKS_FAILED", generation: 1, leaseId: null, leaseUntil: null, attempts: 1, budget: { modelCallsUsed: 1, repairAttemptsUsed: 1 }, createdAt: at, updatedAt: at };
      await ctx.store.put(OWNER, "tasks", task);
      for (let i = 1; i <= 5; i++) await ctx.store.appendEvent(OWNER, task.id, { id: `e${i}`, at, kind: "info", title: `event ${i}`, detail: "" });
      const op = await login(ctx.app, OPERATOR);
      const res = await ctx.app.request("/api/tasks/task-sse/events", { headers: { "last-event-id": "3", cookie: op } });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      const body = await res.text();
      const ids = [...body.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
      expect(ids).toEqual([4, 5]);
      expect(body).toContain("event: task");
      expect(body).toContain("event: end");
      expect(body).not.toContain('"title":"event 3"');
      // apps/web reopens a CLOSED stream with ?lastEventId=<seq>; it must replay like the header.
      const viaQuery = await (await ctx.app.request("/api/tasks/task-sse/events?lastEventId=4", { headers: { cookie: op } })).text();
      expect([...viaQuery.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]))).toEqual([5]);
      const bothHeaderWins = await (await ctx.app.request("/api/tasks/task-sse/events?lastEventId=1", { headers: { "last-event-id": "4", cookie: op } })).text();
      expect([...bothHeaderWins.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]))).toEqual([5]);
    } finally {
      await ctx.close();
    }
  });

  test("unknown task → 404; no header → full replay", async () => {
    const ctx = await makeCtx();
    try {
      const op = await login(ctx.app, OPERATOR);
      expect((await ctx.app.request("/api/tasks/task-none/events", { headers: { cookie: op } })).status).toBe(404);
      const at = new Date().toISOString();
      await ctx.store.put(OWNER, "tasks", { id: "task-x", owner: OWNER, profileId: "fx-1", issueText: "x", status: "failed", phase: "prepare", generation: 0, leaseId: null, leaseUntil: null, attempts: 1, budget: { modelCallsUsed: 0, repairAttemptsUsed: 0 }, createdAt: at, updatedAt: at });
      await ctx.store.appendEvent(OWNER, "task-x", { id: "e1", at, kind: "error", title: "boom", detail: "" });
      const body = await (await ctx.app.request("/api/tasks/task-x/events", { headers: { cookie: op } })).text();
      expect([...body.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]))).toEqual([1]);
    } finally {
      await ctx.close();
    }
  });
});

describe("preview and export", () => {
  test("preview refuses digest mismatch, unverified tasks, and runs on the sealed bundle when allowed", async () => {
    const ctx = await makeCtx({ withWorker: true });
    try {
      const op = await login(ctx.app, OPERATOR);
      const task = await completedTask(ctx, op);
      expect(task.outcome).toBe("CANDIDATE_PASSED_CHECKS");
      const wrong = await ctx.app.request(`/api/tasks/${task.id}/preview`, json({ candidateDigest: "0".repeat(64), input: { x: 5 } }, op));
      expect(wrong.status).toBe(409);
      expect(((await wrong.json()) as { error: string }).error).toContain("does not match");
      const ok = await ctx.app.request(`/api/tasks/${task.id}/preview`, json({ candidateDigest: task.candidateDigest, input: { x: 5 } }, op));
      expect(ok.status).toBe(200);
      const result = (await ok.json()) as { candidateDigest: string; observation?: { valueCanonical?: string } };
      expect(result.candidateDigest).toBe(task.candidateDigest!);
      expect(result.observation?.valueCanonical).toBe("10");
      const preview = ctx.supervisor.invocations.find((i) => i.role === "preview");
      expect(preview?.bundleDigest).toBe(task.candidateDigest!);
      expect(preview?.caseIds).toEqual(["preview"]);
      expect((await ctx.app.request(`/api/tasks/${task.id}/preview`, json({ candidateDigest: task.candidateDigest, input: { x: 5 } }))).status).toBe(401);
      // A task whose verification did not pass is refused.
      const failedAt = new Date().toISOString();
      await ctx.store.put(OWNER, "tasks", { ...task, id: "task-failed", verificationRecordId: "ver-none", updatedAt: failedAt });
      expect((await ctx.app.request("/api/tasks/task-failed/preview", json({ candidateDigest: task.candidateDigest, input: { x: 1 } }, op))).status).toBe(409);
    } finally {
      await ctx.close();
    }
  });

  test("preview is owner-or-operator and rate limited per session and per client", async () => {
    let t = 5_000_000;
    const ctx = await makeCtx({ withWorker: true, now: () => t });
    try {
      const op = await login(ctx.app, OPERATOR);
      const judge = await login(ctx.app, JUDGE);
      const otherJudge = await login(ctx.app, JUDGE);
      const task = await completedTask(ctx, judge);
      const body = { candidateDigest: task.candidateDigest, input: { x: 5 } };
      // The judge who ran the repair may try its own sealed candidate.
      expect((await ctx.app.request(`/api/tasks/${task.id}/preview`, json(body, judge))).status).toBe(200);
      // Another judge sharing the judge password is a different principal: the task reads as absent.
      expect((await ctx.app.request(`/api/tasks/${task.id}/preview`, json(body, otherJudge))).status).toBe(404);
      // But not in a tight loop: one preview per interval per session, like /api/hostile.
      const second = await ctx.app.request(`/api/tasks/${task.id}/preview`, json(body, judge));
      expect(second.status).toBe(429);
      // Another session from the same client shares the client's budget (a re-login buys nothing).
      expect((await ctx.app.request(`/api/tasks/${task.id}/preview`, json(body, op))).status).toBe(429);
      t += 2_001;
      expect((await ctx.app.request(`/api/tasks/${task.id}/preview`, json(body, judge))).status).toBe(200);
      t += 2_001;
      expect((await ctx.app.request(`/api/tasks/${task.id}/preview`, json(body, op))).status).toBe(200);
      expect(ctx.supervisor.invocations.filter((i) => i.role === "preview")).toHaveLength(3);
    } finally {
      await ctx.close();
    }
  });

  test("preview refuses when the stored bundle bytes no longer match the sealed digest", async () => {
    const ctx = await makeCtx({ withWorker: true });
    try {
      const op = await login(ctx.app, OPERATOR);
      const task = await completedTask(ctx, op);
      const key = `${ARTIFACT_KIND_BUNDLE}/${task.candidateDigest}`;
      const bundle = ctx.artifacts.json.get(key) as { candidateDigest: string };
      ctx.artifacts.json.set(key, { ...bundle, candidateDigest: "f".repeat(64) });
      const res = await ctx.app.request(`/api/tasks/${task.id}/preview`, json({ candidateDigest: task.candidateDigest, input: { x: 5 } }, op));
      expect(res.status).toBe(409);
    } finally {
      await ctx.close();
    }
  });

  test("export grant is immutable and repeatable; download requires the granting owner", async () => {
    const ctx = await makeCtx({ withWorker: true });
    try {
      const op = await login(ctx.app, OPERATOR);
      const judge = await login(ctx.app, JUDGE);
      const task = await completedTask(ctx, op);
      const owner = (await ctx.store.scanWhere<Task>("tasks", { id: task.id }))[0]!.owner;
      const first = await ctx.app.request(`/api/tasks/${task.id}/export`, json({}, op));
      expect(first.status).toBe(201);
      const grant = (await first.json()) as { grantId: string; url: string; expiresAt: string; zipDigest: string };
      const second = await ctx.app.request(`/api/tasks/${task.id}/export`, json({}, op));
      expect(second.status).toBe(200);
      expect(await second.json()).toEqual(grant);
      const stored = await ctx.store.get<{ candidateDigest: string; verificationRecordDigest: string; zipDigest: string }>(owner, STORE_KIND_GRANTS, grant.grantId);
      expect(stored?.candidateDigest).toBe(task.candidateDigest!);
      expect(stored?.verificationRecordDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(stored?.zipDigest).toBe(grant.zipDigest);
      expect(await ctx.store.insertImmutable(owner, STORE_KIND_GRANTS, { id: grant.grantId, candidateDigest: "0".repeat(64) })).toBe(false);
      expect((await ctx.store.get<{ candidateDigest: string }>(owner, STORE_KIND_GRANTS, grant.grantId))?.candidateDigest).toBe(task.candidateDigest!);

      const dl1 = await ctx.app.request(grant.url, { headers: { cookie: op } });
      expect(dl1.status).toBe(200);
      expect(dl1.headers.get("content-type")).toBe("application/zip");
      expect(dl1.headers.get("x-content-type-options")).toBe("nosniff");
      const bytes1 = new Uint8Array(await dl1.arrayBuffer());
      expect(sha(bytes1)).toBe(grant.zipDigest);
      const dl2 = await ctx.app.request(grant.url, { headers: { cookie: op } });
      const bytes2 = new Uint8Array(await dl2.arrayBuffer());
      expect(Buffer.from(bytes1).equals(Buffer.from(bytes2))).toBe(true);
      const text = Buffer.from(bytes1).toString("utf8");
      expect(text).toContain("manifest.json");
      expect(text).not.toContain("b".repeat(40));
      expect((await ctx.app.request(grant.url, { headers: { cookie: judge } })).status).toBe(404);
      expect((await ctx.app.request(grant.url)).status).toBe(401);
      // Verification records are immutable in the store too.
      const rec = await ctx.store.get<{ id: string; passed: boolean }>(owner, STORE_KIND_VERIFICATIONS, task.verificationRecordId!);
      expect(await ctx.store.insertImmutable(owner, STORE_KIND_VERIFICATIONS, { ...rec!, passed: false })).toBe(false);
    } finally {
      await ctx.close();
    }
  });

  test("the export zip is sealed once: later grants, other sessions, new events and a restart serve identical bytes", async () => {
    const ctx = await makeCtx({ withWorker: true, realExport: true });
    try {
      const judge = await login(ctx.app, JUDGE);
      const op = await login(ctx.app, OPERATOR);
      const task = await completedTask(ctx, judge);
      const owner = (await ctx.store.scanWhere<Task>("tasks", { id: task.id }))[0]!.owner;
      const g1 = (await (await ctx.app.request(`/api/tasks/${task.id}/export`, json({}, judge))).json()) as { url: string; zipDigest: string };
      const b1 = new Uint8Array(await (await ctx.app.request(g1.url, { headers: { cookie: judge } })).arrayBuffer());
      // A different principal gets its own grant for the same sealed bytes; its grant event, and any
      // later event, are outside the sealed payload.
      await ctx.store.appendEvent(owner, task.id, { id: "evt-late", at: new Date().toISOString(), kind: "info", title: "late event", detail: "" });
      const g2 = (await (await ctx.app.request(`/api/tasks/${task.id}/export`, json({}, op))).json()) as { url: string; zipDigest: string };
      expect(g2.zipDigest).toBe(g1.zipDigest);
      const b2 = new Uint8Array(await (await ctx.app.request(g2.url, { headers: { cookie: op } })).arrayBuffer());
      expect(Buffer.from(b1).equals(Buffer.from(b2))).toBe(true);
      expect(sha(b1)).toBe(g1.zipDigest);
      expect(Buffer.from(b1).toString("utf8")).not.toContain("late event");
      expect(Buffer.from(b1).toString("utf8")).not.toContain("Export authorized");
      // A second control process over the same store and artifacts serves the same bytes.
      const restarted = createApp({ ...ctx.deps, sessions: new SessionService(ctx.store, { operatorPassword: OPERATOR, judgePassword: JUDGE, ttlMs: 60_000, secureCookies: false }) });
      const b3 = new Uint8Array(await (await restarted.request(g1.url, { headers: { cookie: judge } })).arrayBuffer());
      expect(Buffer.from(b1).equals(Buffer.from(b3))).toBe(true);
      // Tampering the stored zip is detected on read, never served.
      ctx.artifacts.blobs.set(g1.zipDigest, new Uint8Array([1, 2, 3]));
      expect((await ctx.app.request(g1.url, { headers: { cookie: judge } })).status).toBe(409);
      // A seal whose bytes are gone issues no new grant.
      ctx.artifacts.blobs.delete(g1.zipDigest);
      const third = await login(ctx.app, OPERATOR);
      expect((await ctx.app.request(`/api/tasks/${task.id}/export`, json({}, third))).status).toBe(409);
    } finally {
      await ctx.close();
    }
  });

  test("concurrent first exports seal one zip", async () => {
    const ctx = await makeCtx({ withWorker: true, realExport: true });
    try {
      const op = await login(ctx.app, OPERATOR);
      const judge = await login(ctx.app, JUDGE);
      const task = await completedTask(ctx, judge);
      const results = await Promise.all([
        ctx.app.request(`/api/tasks/${task.id}/export`, json({}, judge)),
        ctx.app.request(`/api/tasks/${task.id}/export`, json({}, op)),
      ]);
      const digests = await Promise.all(results.map(async (r) => ((await r.json()) as { zipDigest: string }).zipDigest));
      expect(new Set(digests).size).toBe(1);
      expect([...ctx.artifacts.json.keys()].filter((k) => k.startsWith(`${ARTIFACT_KIND_EXPORT}/`))).toHaveLength(1);
    } finally {
      await ctx.close();
    }
  });

  test("export is refused for a failed repair and for a baseline that did not reproduce, when granting and when downloading", async () => {
    const ctx = await makeCtx({ withWorker: true });
    try {
      const op = await login(ctx.app, OPERATOR);
      const task = await completedTask(ctx, op);
      const owner = (await ctx.store.scanWhere<Task>("tasks", { id: task.id }))[0]!.owner;
      const grant = (await (await ctx.app.request(`/api/tasks/${task.id}/export`, json({}, op))).json()) as { url: string };
      const verification = (await ctx.store.get<VerificationRecord>(owner, STORE_KIND_VERIFICATIONS, task.verificationRecordId!))!;
      const baseline = (await ctx.store.get<VerificationRecord>(owner, STORE_KIND_VERIFICATIONS, task.baselineRecordId!))!;
      const at = new Date().toISOString();
      // CHECKS_FAILED with a failing candidate record.
      await ctx.store.insertImmutable(owner, STORE_KIND_VERIFICATIONS, { ...verification, id: "ver-failed", passed: false });
      await ctx.store.put(owner, "tasks", { ...task, id: "task-failed", outcome: "CHECKS_FAILED", verificationRecordId: "ver-failed", updatedAt: at });
      const failed = await ctx.app.request("/api/tasks/task-failed/export", json({}, op));
      expect(failed.status).toBe(409);
      expect(((await failed.json()) as { error: string }).error).toContain("CHECKS_FAILED");
      // Outcome claims a pass but the candidate record says otherwise.
      await ctx.store.put(owner, "tasks", { ...task, id: "task-lying", verificationRecordId: "ver-failed", updatedAt: at });
      expect((await ctx.app.request("/api/tasks/task-lying/export", json({}, op))).status).toBe(409);
      // Baseline that did not reproduce.
      await ctx.store.insertImmutable(owner, STORE_KIND_VERIFICATIONS, { ...verification, id: "ver-nobase", taskId: "task-nobase" });
      await ctx.store.insertImmutable(owner, STORE_KIND_VERIFICATIONS, { ...baseline, id: "ver-base-bad", taskId: "task-nobase", passed: false });
      await ctx.store.put(owner, "tasks", { ...task, id: "task-nobase", verificationRecordId: "ver-nobase", baselineRecordId: "ver-base-bad", updatedAt: at });
      const nobase = await ctx.app.request("/api/tasks/task-nobase/export", json({}, op));
      expect(nobase.status).toBe(409);
      expect(((await nobase.json()) as { error: string }).error).toContain("baseline");
      // A grant is re-checked when used: the task now points at a failing record.
      await ctx.store.put(owner, "tasks", { ...task, outcome: "CHECKS_FAILED", updatedAt: at });
      expect((await ctx.app.request(grant.url, { headers: { cookie: op } })).status).toBe(409);
    } finally {
      await ctx.close();
    }
  });

  test("a grant issued before sealed exports existed authorizes nothing", async () => {
    const ctx = await makeCtx({ withWorker: true });
    try {
      const op = await login(ctx.app, OPERATOR);
      const task = await completedTask(ctx, op);
      const session = (await ctx.store.scan<{ owner: string; role: string }>("sessions")).find((r) => r.value.role === "operator")!.value;
      const legacy = { id: "grant-legacy", owner: session.owner, taskId: task.id, candidateDigest: task.candidateDigest, verificationRecordId: task.verificationRecordId, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() };
      await ctx.store.insertImmutable(session.owner, STORE_KIND_GRANTS, legacy);
      expect((await ctx.app.request("/api/exports/grant-legacy", { headers: { cookie: op } })).status).toBe(410);
    } finally {
      await ctx.close();
    }
  });

  test("export of a candidate whose stored bundle bytes no longer match the manifest is refused with 409 and a reason, not 500", async () => {
    const ctx = await makeCtx({ withWorker: true, realExport: true });
    try {
      const op = await login(ctx.app, OPERATOR);
      const task = await completedTask(ctx, op);
      // Tamper the stored bundle's bytes before the export is sealed; the manifest and candidateDigest are untouched.
      const key = `${ARTIFACT_KIND_BUNDLE}/${task.candidateDigest}`;
      const bundle = ctx.artifacts.json.get(key) as { files: { contentBase64: string }[] };
      bundle.files[0]!.contentBase64 = Buffer.from("def compute(x):\n    return 'tampered'\n").toString("base64");
      const refused = await ctx.app.request(`/api/tasks/${task.id}/export`, json({}, op));
      expect(refused.status).toBe(409);
      const body = (await refused.json()) as { error: string };
      expect(body.error).toContain("no longer matches");
      expect(body.error).toContain("lib/mod.py");
      expect([...ctx.artifacts.json.keys()].some((k) => k.startsWith(`${ARTIFACT_KIND_EXPORT}/`))).toBe(false);
    } finally {
      await ctx.close();
    }
  });

  test("export refused for a task without a verified candidate", async () => {
    const ctx = await makeCtx();
    try {
      const op = await login(ctx.app, OPERATOR);
      const created = (await (await ctx.app.request("/api/tasks", json({ profileId: "fx-1", issueText: "x" }, op))).json()) as Task;
      expect((await ctx.app.request(`/api/tasks/${created.id}/export`, json({}, op))).status).toBe(409);
      expect((await ctx.app.request("/api/exports/grant-missing", { headers: { cookie: op } })).status).toBe(404);
    } finally {
      await ctx.close();
    }
  });

  test("the event stream carries command output only to its owner or an operator, and closes when the session ends", async () => {
    const ctx = await makeCtx({
      withWorker: true,
      driverScript: [
        { toolCalls: [{ name: "write_file", args: { path: "lib/mod.py", content: FX_FIXED_SOURCE } }] },
        { toolCalls: [{ name: "run", args: { command: "cat lib/mod.py" } }] },
        { toolCalls: [{ name: "submit_candidate", args: { summary: "fix" } }] },
      ],
    });
    try {
      const judge = await login(ctx.app, JUDGE);
      const otherJudge = await login(ctx.app, JUDGE);
      const op = await login(ctx.app, OPERATOR);
      const created = (await (await ctx.app.request("/api/tasks", json({ profileId: "fx-1", issueText: "x" }, judge))).json()) as Task;
      await ctx.harness!.waitFor(created.id);
      expect((await ctx.app.request(`/api/tasks/${created.id}/events`)).status).toBe(401);
      expect((await ctx.app.request(`/api/tasks/${created.id}/events`, { headers: { cookie: otherJudge } })).status).toBe(404);
      for (const cookie of [judge, op]) {
        const body = await (await ctx.app.request(`/api/tasks/${created.id}/events`, { headers: { cookie } })).text();
        const execData = body
          .split("\n")
          .filter((line) => line.startsWith("data: "))
          .map((line) => JSON.parse(line.slice(6)) as { kind?: string; data?: { tool?: string; result?: { stdout?: string } } })
          .find((e) => e.kind === "exec" && e.data?.tool === "run");
        expect(execData?.data?.result?.stdout).toBe("ran cat lib/mod.py");
      }
    } finally {
      await ctx.close();
    }
  });

  test("an open event stream stops delivering once its session is logged out", async () => {
    const ctx = await makeCtx();
    try {
      const judge = await login(ctx.app, JUDGE);
      const created = (await (await ctx.app.request("/api/tasks", json({ profileId: "fx-1", issueText: "x" }, judge))).json()) as Task;
      // No worker: the task stays queued, so the stream would stay open indefinitely.
      const res = await ctx.app.request(`/api/tasks/${created.id}/events`, { headers: { cookie: judge } });
      expect(res.status).toBe(200);
      const reader = res.body!.getReader();
      const first = new TextDecoder().decode((await reader.read()).value);
      expect(first).toContain("Task created");
      await ctx.app.request("/api/session", { method: "DELETE", headers: { cookie: judge } });
      const owner = (await ctx.store.scanWhere<Task>("tasks", { id: created.id }))[0]!.owner;
      await ctx.store.appendEvent(owner, created.id, { id: "evt-after-logout", at: new Date().toISOString(), kind: "info", title: "secret after logout", detail: "" });
      let rest = "";
      const deadline = Date.now() + 2000;
      for (;;) {
        const chunk = await Promise.race([reader.read(), new Promise<{ done: true; value: undefined }>((r) => setTimeout(() => r({ done: true, value: undefined }), Math.max(1, deadline - Date.now())))]);
        if (chunk.done) break;
        rest += new TextDecoder().decode(chunk.value);
      }
      expect(rest).not.toContain("secret after logout");
      // The stream ends with a named reason so the client stops reconnecting into 401s.
      expect(rest).toContain("event: end");
      expect(rest).toContain('"status":"unauthorized"');
    } finally {
      await ctx.close();
    }
  });

  test("a session written before per-login owners (owner equal to its role) is refused", async () => {
    const ctx = await makeCtx();
    try {
      const token = "legacytoken";
      const { createHash } = await import("node:crypto");
      const id = createHash("sha256").update(token).digest("hex");
      await ctx.store.put("system", "sessions", { id, owner: "judge", role: "judge", createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() });
      const res = await ctx.app.request("/api/session", { headers: { cookie: `airlock_session=${token}` } });
      expect(((await res.json()) as { role: string }).role).toBe("viewer");
      expect((await ctx.app.request("/api/tasks", { headers: { cookie: `airlock_session=${token}` } })).status).toBe(401);
    } finally {
      await ctx.close();
    }
  });

  test("cancelling a queued task that still names an attempt goes through teardown, not straight to cancelled", async () => {
    const ctx = await makeCtx();
    try {
      const op = await login(ctx.app, OPERATOR);
      const created = (await (await ctx.app.request("/api/tasks", json({ profileId: "fx-1", issueText: "x" }, op))).json()) as Task;
      const owner = (await ctx.store.scanWhere<Task>("tasks", { id: created.id }))[0]!.owner;
      // A lost lease requeues a task with its attemptId still set.
      await ctx.store.put(owner, "tasks", { ...created, attemptId: "att-requeued", generation: 1 });
      const res = await ctx.app.request(`/api/tasks/${created.id}/cancel`, json({}, op));
      expect(res.status).toBe(200);
      const next = (await res.json()) as Task;
      expect(next.status).toBe("cancelling");
      expect(next.attemptId).toBe("att-requeued");
      expect(next.leaseId).toBeNull();
      expect(next.leaseUntil).toBeNull();
      // A task that never had an attempt is still cancelled by the state change alone.
      const fresh = (await (await ctx.app.request("/api/tasks", json({ profileId: "fx-1", issueText: "y" }, op))).json()) as Task;
      expect(((await (await ctx.app.request(`/api/tasks/${fresh.id}/cancel`, json({}, op))).json()) as Task).status).toBe("cancelled");
    } finally {
      await ctx.close();
    }
  });

  test("cancel via the API mid-run reaches cancelled and destroys the sandbox", async () => {
    const ctx = await makeCtx({ withWorker: true });
    try {
      const op = await login(ctx.app, OPERATOR);
      const created = (await (await ctx.app.request("/api/tasks", json({ profileId: "fx-1", issueText: "x" }, op))).json()) as Task;
      const final = await ctx.harness!.waitFor(created.id);
      // Fast scripted run: cancel after completion is a 409, and nothing is left behind.
      expect(final.status).toBe("done");
      expect((await ctx.app.request(`/api/tasks/${created.id}/cancel`, json({}, op))).status).toBe(409);
      expect(ctx.supervisor.attempts.size).toBe(0);
      const events = await ctx.store.listEvents(created.id);
      expect(events[0]?.title).toBe("Task created");
      expect(events.at(-1)?.title).toBe("Outcome CANDIDATE_PASSED_CHECKS");
    } finally {
      await ctx.close();
    }
  });
});

// ---- milestone 2: drift, hostile, availability, diagnostics, CSP --------------------------------

/** Lets a test change what the preview sandbox's own inspection reports. */
class DriftingSupervisor extends FakeSupervisor {
  previewImage: string | null = null;
  override async invoke(input: Parameters<FakeSupervisor["invoke"]>[0], opts?: Parameters<FakeSupervisor["invoke"]>[1]) {
    const result = await super.invoke(input, opts);
    if (input.role === "preview" && this.previewImage) return { ...result, inspection: { ...result.inspection, imageDigest: this.previewImage } };
    return result;
  }
}
const errorOf = async (res: Response) => ((await res.json()) as { error: string }).error;

describe("preview and export are bound to the verified runtime, adapter and contract (M5)", () => {
  test("adapter, contract, runtime and runtime-image drift refuse preview, a new grant and a sealed download; restoring the configuration allows them again", async () => {
    let t = 7_000_000;
    const ctx = await makeCtx({ withWorker: true, now: () => t });
    const adapterPath = join(fixture.runtimeDir, "adapter.py");
    const original = await Bun.file(adapterPath).text();
    try {
      const op = await login(ctx.app, OPERATOR);
      const task = await completedTask(ctx, op);
      const body = { candidateDigest: task.candidateDigest, input: { x: 5 } };
      const preview = () => ctx.app.request(`/api/tasks/${task.id}/preview`, json(body, op));
      const exportIt = () => ctx.app.request(`/api/tasks/${task.id}/export`, json({}, op));
      const grant = (await (await exportIt()).json()) as { url: string };
      const expectRefused = async (what: string) => {
        const p = await preview();
        expect(p.status).toBe(409);
        const pe = await errorOf(p);
        expect(pe).toContain("configuration changed since verification");
        expect(pe).toContain(what);
        expect(pe).toContain("preview refused");
        const e = await exportIt();
        expect(e.status).toBe(409);
        expect(await errorOf(e)).toContain("export refused");
        // Prefer refusing: an already-sealed zip is not handed out under a drifted configuration.
        expect((await ctx.app.request(grant.url, { headers: { cookie: op } })).status).toBe(409);
      };
      const previewsBefore = ctx.supervisor.invocations.filter((i) => i.role === "preview").length;

      await writeFile(adapterPath, "# a different adapter\n");
      await expectRefused("adapter");
      await writeFile(adapterPath, original);

      const loaded = ctx.deps.profiles.get("fx-1")!;
      ctx.deps.profiles.set("fx-1", { ...loaded, contractDigest: "f".repeat(64) });
      await expectRefused("contract");
      ctx.deps.profiles.set("fx-1", loaded);

      const host = ctx.supervisor.hostCheck;
      ctx.supervisor.hostCheck = { ...host, selectedRuntime: "runsc" };
      await expectRefused("runtime runsc");
      ctx.supervisor.hostCheck = { ...host, runtimeImageId: "sha256:rebuilt" };
      await expectRefused("runtime image");
      // Refused before dispatch: no sandbox ran for any of these.
      expect(ctx.supervisor.invocations.filter((i) => i.role === "preview")).toHaveLength(previewsBefore);

      // The verified image id reported by the host check is not drift.
      ctx.supervisor.hostCheck = { ...host, runtimeImageId: "sha256:fakeimage" };
      expect((await preview()).status).toBe(200);
      expect((await exportIt()).status).toBe(200);
      expect((await ctx.app.request(grant.url, { headers: { cookie: op } })).status).toBe(200);
    } finally {
      await writeFile(adapterPath, original);
      await ctx.close();
    }
  });

  test("a preview sandbox that reports a different image than the verification is refused after the run", async () => {
    const supervisor = new DriftingSupervisor({ profile: fixture.profile, observe: fixtureObserve });
    const ctx = await makeCtx({ withWorker: true, supervisor });
    try {
      const op = await login(ctx.app, OPERATOR);
      const task = await completedTask(ctx, op);
      supervisor.previewImage = "sha256:swapped";
      const res = await ctx.app.request(`/api/tasks/${task.id}/preview`, json({ candidateDigest: task.candidateDigest, input: { x: 5 } }, op));
      expect(res.status).toBe(409);
      const error = await errorOf(res);
      expect(error).toContain("configuration changed since verification");
      expect(error).toContain("sha256:swapped");
      expect(error).not.toContain("valueCanonical");
    } finally {
      await ctx.close();
    }
  });
});

describe("hostile panel (D10, U3)", () => {
  test("the card carries control-plane health measured before and after the run", async () => {
    const ctx = await makeCtx({ withWorker: true });
    try {
      await ctx.harness!.waitUntil(async () => !!(await ctx.store.get("system", "worker-status", "tasks")));
      const judge = await login(ctx.app, JUDGE);
      const res = await ctx.app.request("/api/hostile", json({ command: "rm -rf / --no-preserve-root" }, judge));
      expect(res.status).toBe(200);
      const card = (await res.json()) as { survived: { controlPlane?: { healthyBefore: boolean; healthyAfter: boolean; checkedAt: string } } };
      expect(card.survived.controlPlane?.healthyBefore).toBe(true);
      expect(card.survived.controlPlane?.healthyAfter).toBe(true);
      expect(Number.isFinite(Date.parse(card.survived.controlPlane!.checkedAt))).toBe(true);
    } finally {
      await ctx.close();
    }
  });

  test("a stopped worker reads as an unhealthy control plane on the card", async () => {
    const ctx = await makeCtx({ withWorker: true });
    try {
      await ctx.harness!.worker.stop();
      const judge = await login(ctx.app, JUDGE);
      const card = (await (await ctx.app.request("/api/hostile", json({ command: "true" }, judge))).json()) as { survived: { controlPlane?: { healthyBefore: boolean; healthyAfter: boolean } } };
      expect(card.survived.controlPlane).toMatchObject({ healthyBefore: false, healthyAfter: false });
    } finally {
      await ctx.close();
    }
  });

  test("different clients are also held to a global interval between hostile runs", async () => {
    let t = 2_000_000;
    const ctx = await makeCtx({ now: () => t, trustedProxies: ["loopback"], extra: { hostileGlobalMinIntervalMs: 3000 } });
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: ctx.app.fetch });
    const post = async (client: string, path: string, body: unknown, cookie?: string) =>
      fetch(`http://127.0.0.1:${server.port}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": client, ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
    try {
      const loginAs = async (client: string) => ((await post(client, "/api/session", { password: JUDGE })).headers.get("set-cookie") ?? "").split(";")[0]!;
      const a = await loginAs("198.51.100.1");
      const b = await loginAs("198.51.100.2");
      expect((await post("198.51.100.1", "/api/hostile", { command: "true" }, a)).status).toBe(200);
      const blocked = await post("198.51.100.2", "/api/hostile", { command: "true" }, b);
      expect(blocked.status).toBe(429);
      expect(await errorOf(blocked)).toContain("overall");
      t += 3001;
      expect((await post("198.51.100.2", "/api/hostile", { command: "true" }, b)).status).toBe(200);
      // Client A is still inside its own per-client interval.
      t += 3001;
      expect((await post("198.51.100.1", "/api/hostile", { command: "true" }, a)).status).toBe(429);
    } finally {
      server.stop(true);
      await ctx.close();
    }
  });
});

describe("repair availability (U5/G1) and diagnostics (G6)", () => {
  const receipt = (overrides: Record<string, unknown> = {}) => ({
    schemaVersion: 1,
    // Never in the future (a receipt dated more than 5 minutes ahead is refused).
    recordedAt: new Date(Date.now() - 3_600_000).toISOString(),
    revision: "c7580dc",
    profileId: "fx-1",
    contractDigest: fixture.profile.contractDigest,
    driver: "vultr",
    model: "glm-5.3-normalize",
    inferenceHost: "api.vultrinference.com",
    runtime: "kata",
    devUnsafe: false,
    runtimeImageId: GATE_IMAGE,
    adapterDigest: overrides.adapterDigest ?? "0".repeat(64),
    attempts: ["a", "b", "c"].map((id, i) => ({ taskId: `task-gate-${id}`, outcome: i < 2 ? "CANDIDATE_PASSED_CHECKS" : "CHECKS_FAILED", candidateDigest: "1".repeat(64), modelCalls: 5, modelHosts: ["api.vultrinference.com"], durationMs: 1000 })),
    passed: 2,
    total: 3,
    ...overrides,
  });
  const GATE_IMAGE = `sha256:${"a".repeat(64)}`;
  const liveHost = () => fakeHost({ selectedRuntime: "kata", devUnsafe: false, availableRuntimes: ["runc", "kata"], instanceId: "vm-b-123", runtimeImageId: GATE_IMAGE });
  /** The gate run's tasks, as this control plane recorded them. */
  const seedGateTasks = async (store: Store) => {
    for (const [i, id] of ["a", "b", "c"].entries()) {
      const at = new Date().toISOString();
      await store.put("operator", "tasks", { id: `task-gate-${id}`, owner: "operator", profileId: "fx-1", issueText: "x", status: "done", phase: "ready", outcome: i < 2 ? "CANDIDATE_PASSED_CHECKS" : "CHECKS_FAILED", candidateDigest: "1".repeat(64), liveGate: true, generation: 1, leaseId: null, leaseUntil: null, attempts: 1, budget: { modelCallsUsed: 5, repairAttemptsUsed: 1 }, createdAt: at, updatedAt: at } satisfies Task);
    }
  };

  test("signed-out readers see availability; a live task created without evidence is marked repair-disabled; a passing receipt enables repair", async () => {
    const evidenceDir = await mkdtemp(join(tmpdir(), "airlock-gate-"));
    const supervisor = new FakeSupervisor({ profile: fixture.profile, observe: fixtureObserve, host: liveHost() });
    const ctx = await makeCtx({ supervisor, extra: { scriptedDrivers: ["slow"], diagnostics: [{ name: "slow", title: "Runaway command", description: "sleeps" }] } });
    const availability = new RepairAvailabilityService({ driver: "vultr", model: "glm-5.3", evidenceDir, repoRoot: tmpdir(), controlInstanceId: "vm-a-456", adapterDigestOf: (p) => computeAdapterDigest(fixture.runtimeDir, p), tasks: ctx.store });
    ctx.deps.availability = availability;
    const app = createApp(ctx.deps);
    ctx.app = app;
    try {
      const none = (await (await ctx.app.request("/api/repair-availability")).json()) as RepairAvailability;
      expect(none.available).toBe(false);
      expect(none.reason).toContain("no valid live-gate receipt");
      // Signed out: no instance ids and no model name.
      expect(none.instances).toBeUndefined();
      expect(none.model).toBeUndefined();
      expect(none.driver).toBe("vultr");
      const op = await login(ctx.app, OPERATOR);
      const signedIn = (await (await ctx.app.request("/api/repair-availability", { headers: { cookie: op } })).json()) as RepairAvailability;
      expect(signedIn.instances).toEqual({ control: "vm-a-456", execution: "vm-b-123" });
      expect(signedIn.model).toBe("glm-5.3");
      const created = (await (await ctx.app.request("/api/tasks", json({ profileId: "fx-1", issueText: "compute(0) raises" }, op))).json()) as Task;
      expect(created.repairDisabledReason).toContain("live repair unavailable");
      expect(created.scriptedDriver).toBeUndefined();
      // A labelled diagnostic is never repair-disabled (and never a model repair).
      const judge = await login(ctx.app, JUDGE);
      const diag = await ctx.app.request("/api/tasks", json({ profileId: "fx-1", issueText: "x", scriptedDriver: "slow" }, judge));
      expect(diag.status).toBe(201);
      const diagTask = (await diag.json()) as Task;
      expect(diagTask.scriptedDriver).toBe("slow");
      expect(diagTask.repairDisabledReason).toBeUndefined();
      // The operator running the gate itself is exempt; a judge may not claim to.
      const gate = (await (await ctx.app.request("/api/tasks", json({ profileId: "fx-1", issueText: "x", liveGate: true }, op))).json()) as Task;
      expect(gate.repairDisabledReason).toBeUndefined();
      expect((await ctx.app.request("/api/tasks", json({ profileId: "fx-1", issueText: "x", liveGate: true }, judge))).status).toBe(403);

      await seedGateTasks(ctx.store);
      const adapterDigest = await computeAdapterDigest(fixture.runtimeDir, fixture.profile);
      await writeFile(join(evidenceDir, "2026-09-27T10-00-00Z.json"), JSON.stringify(receipt({ adapterDigest })));
      const ok = (await (await ctx.app.request("/api/repair-availability?profileId=fx-1")).json()) as RepairAvailability;
      expect(ok.available).toBe(true);
      expect(ok.evidence).toMatchObject({ passed: 2, attempts: 3, model: "glm-5.3-normalize", runtime: "kata", profileId: "fx-1" });
      expect(ok.evidence!.path.startsWith("/")).toBe(false);
      const live = (await (await ctx.app.request("/api/tasks", json({ profileId: "fx-1", issueText: "compute(0) raises" }, op))).json()) as Task;
      expect(live.repairDisabledReason).toBeUndefined();
      expect((await ctx.app.request("/api/repair-availability?profileId=nope")).status).toBe(404);
    } finally {
      await ctx.close();
      await rm(evidenceDir, { recursive: true, force: true });
    }
  });

  test("the diagnostics catalog is operator/judge only and lists only launchable scripts", async () => {
    const ctx = await makeCtx({ extra: { scriptedDrivers: ["forged-log", "slow"], diagnostics: [{ name: "forged-log", title: "Forged success log", description: "d" }, { name: "slow", title: "slow", description: "" }, { name: "gone", title: "gone", description: "" }] } });
    try {
      expect((await ctx.app.request("/api/diagnostics")).status).toBe(401);
      const judge = await login(ctx.app, JUDGE);
      const res = await ctx.app.request("/api/diagnostics", { headers: { cookie: judge } });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ scripts: [{ name: "forged-log", title: "Forged success log", description: "d" }, { name: "slow", title: "slow", description: "" }] });
      expect((await ctx.app.request("/api/tasks", json({ profileId: "fx-1", issueText: "x", scriptedDriver: "gone" }, judge))).status).toBe(422);
      // Without a catalog the list is empty and every scriptedDriver is refused.
      const bare = await makeCtx();
      try {
        const op = await login(bare.app, OPERATOR);
        expect(await (await bare.app.request("/api/diagnostics", { headers: { cookie: op } })).json()).toEqual({ scripts: [] });
      } finally {
        await bare.close();
      }
    } finally {
      await ctx.close();
    }
  });

  test("a scripted-driver control plane labels every task with its script and reports repair as unavailable", async () => {
    const availability = new RepairAvailabilityService({ driver: "scripted", model: null, evidenceDir: "/nonexistent", repoRoot: tmpdir() });
    const ctx = await makeCtx({ extra: { availability, scriptedDrivers: ["default"], defaultScriptedDriver: "default" } });
    try {
      const a = (await (await ctx.app.request("/api/repair-availability")).json()) as RepairAvailability;
      expect(a).toMatchObject({ available: false, reason: SCRIPTED_REASON, driver: "scripted" });
      const op = await login(ctx.app, OPERATOR);
      const task = (await (await ctx.app.request("/api/tasks", json({ profileId: "fx-1", issueText: "x" }, op))).json()) as Task;
      expect(task.scriptedDriver).toBe("default");
      expect(task.repairDisabledReason).toBeUndefined();
    } finally {
      await ctx.close();
    }
  });
});

describe("security headers (U6)", () => {
  const expectHeaders = (res: Response) => {
    expect(res.headers.get("content-security-policy")).toBe(CONTENT_SECURITY_POLICY);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  };

  test("the policy forbids inline and foreign scripts, framing and foreign connections", () => {
    const directives = Object.fromEntries(CONTENT_SECURITY_POLICY.split(";").map((d) => d.trim().split(/\s+/)).map(([k, ...v]) => [k, v.join(" ")]));
    expect(directives["script-src"]).toBe("'self'");
    expect(directives["connect-src"]).toBe("'self'");
    expect(directives["frame-ancestors"]).toBe("'none'");
    expect(directives["base-uri"]).toBe("'none'");
    expect(directives["default-src"]).toBe("'self'");
  });

  test("API responses, errors, 404s, the SPA, SSE and the export download all carry the headers", async () => {
    const repoDist = resolve(import.meta.dir, "../../web/dist");
    const hasRepoDist = await Bun.file(join(repoDist, "index.html")).exists();
    const dist = hasRepoDist ? repoDist : await mkdtemp(join(tmpdir(), "airlock-dist-"));
    if (!hasRepoDist) await writeFile(join(dist, "index.html"), "<!doctype html><title>Airlock</title><script type=\"module\" src=\"/assets/app.js\"></script>");
    const ctx = await makeCtx({ withWorker: true, webDist: dist });
    try {
      expectHeaders(await ctx.app.request("/api/health"));
      expectHeaders(await ctx.app.request("/api/host"));
      expectHeaders(await ctx.app.request("/api/nope"));
      expectHeaders(await ctx.app.request("/api/tasks", { method: "POST", headers: { "content-type": "application/json" }, body: "{oops" }));
      const index = await ctx.app.request("/");
      expect(index.status).toBe(200);
      expectHeaders(index);
      const html = await index.text();
      // The built UI must run under script-src 'self': no inline <script> bodies, only same-origin src.
      for (const tag of html.match(/<script\b[^>]*>[\s\S]*?<\/script>/g) ?? []) {
        expect(tag).toMatch(/src="\/[^/]/);
        expect(tag.replace(/<script\b[^>]*>/, "").replace("</script>", "").trim()).toBe("");
      }
      const op = await login(ctx.app, OPERATOR);
      const task = await completedTask(ctx, op);
      const sse = await ctx.app.request(`/api/tasks/${task.id}/events`, { headers: { cookie: op } });
      expect(sse.status).toBe(200);
      expect(sse.headers.get("content-type")).toContain("text/event-stream");
      expectHeaders(sse);
      const text = await sse.text();
      expect(text).toContain("event: end");
      expect(text).toContain("event: phase");
      const grant = (await (await ctx.app.request(`/api/tasks/${task.id}/export`, json({}, op))).json()) as { url: string };
      const dl = await ctx.app.request(grant.url, { headers: { cookie: op } });
      expect(dl.status).toBe(200);
      expect(dl.headers.get("content-type")).toBe("application/zip");
      expectHeaders(dl);
    } finally {
      await ctx.close();
      if (!hasRepoDist) await rm(dist, { recursive: true, force: true });
    }
  });
});

// ---- milestone 2 review fixes ---------------------------------------------------------------------

describe("should-fix 1: a judge's hostile card names none of another client's tasks", () => {
  class SiblingSupervisor extends FakeSupervisor {
    ownTaskId = "";
    override async hostile(input: { profileId: string; command: string }): Promise<BlastRadiusCard> {
      const card = await super.hostile(input);
      const mine = this.ownTaskId;
      return {
        ...card,
        survived: {
          ...card.survived,
          otherAttemptsRunning: 2,
          siblings: [
            { attemptId: "att-mine", taskId: mine, runningBefore: true, runningAfter: true },
            { attemptId: "att-secret", taskId: "task-secret", runningBefore: true, runningAfter: true },
          ],
        },
        teardown: {
          ...card.teardown,
          host: {
            listedAt: new Date().toISOString(),
            scope: "host",
            containers: [
              { name: `airlock-author-${mine}-att-mine`, taskId: mine, role: "author", state: "running" },
              { name: "airlock-author-task-secret-att-secret", taskId: "task-secret", role: "author", state: "running" },
            ],
            volumes: [`airlock-ws-${mine}-att-mine`, "airlock-ws-task-secret-att-secret"],
          },
        },
      };
    }
  }

  test("siblings and host listing entries of other tasks keep role, state and counts but lose their ids and names", async () => {
    const supervisor = new SiblingSupervisor({ profile: fixture.profile, observe: fixtureObserve });
    const ctx = await makeCtx({ supervisor });
    try {
      const judge = await login(ctx.app, JUDGE);
      const created = (await (await ctx.app.request("/api/tasks", json({ profileId: "fx-1", issueText: "x" }, judge))).json()) as Task;
      supervisor.ownTaskId = created.id;
      const res = await ctx.app.request("/api/hostile", json({ command: "true" }, judge));
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).not.toContain("task-secret");
      expect(text).not.toContain("att-secret");
      const card = JSON.parse(text) as BlastRadiusCard;
      expect(card.survived.otherAttemptsRunning).toBe(2);
      expect(card.survived.siblings).toEqual([
        { attemptId: "att-mine", taskId: created.id, runningBefore: true, runningAfter: true },
        { attemptId: "other", taskId: "other", runningBefore: true, runningAfter: true },
      ]);
      expect(card.teardown.host!.containers).toEqual([
        { name: `airlock-author-${created.id}-att-mine`, taskId: created.id, role: "author", state: "running" },
        { name: "other-task container", taskId: "other", role: "author", state: "running" },
      ]);
      expect(card.teardown.host!.volumes).toEqual([`airlock-ws-${created.id}-att-mine`, "other-task volume"]);
    } finally {
      await ctx.close();
    }
  });
});

describe("should-fix 5: image identity binds preview and export", () => {
  /** A supervisor whose sandboxes report the given inspection fields. */
  class ImageSupervisor extends FakeSupervisor {
    invokeImage: { imageDigest?: string; imageId?: string | null } = {};
    previewImageId: string | null = null;
    override async invoke(input: Parameters<FakeSupervisor["invoke"]>[0], opts?: Parameters<FakeSupervisor["invoke"]>[1]) {
      const result = await super.invoke(input, opts);
      const inspection = { ...result.inspection };
      if (this.invokeImage.imageDigest) inspection.imageDigest = this.invokeImage.imageDigest;
      if (this.invokeImage.imageId === null) delete inspection.imageId;
      else if (this.invokeImage.imageId) inspection.imageId = this.invokeImage.imageId;
      if (input.role === "preview" && this.previewImageId) inspection.imageId = this.previewImageId;
      return { ...result, inspection };
    }
  }

  test("a record's imageId is compared with the host's enforced image id", async () => {
    const supervisor = new ImageSupervisor({ profile: fixture.profile, observe: fixtureObserve });
    const ctx = await makeCtx({ withWorker: true, supervisor });
    try {
      const op = await login(ctx.app, OPERATOR);
      const task = await completedTask(ctx, op);
      supervisor.hostCheck = { ...supervisor.hostCheck, runtimeImageId: `sha256:${"9".repeat(64)}` };
      const p = await ctx.app.request(`/api/tasks/${task.id}/preview`, json({ candidateDigest: task.candidateDigest, input: { x: 5 } }, op));
      expect(p.status).toBe(409);
      expect(await errorOf(p)).toContain("runtime image");
      supervisor.hostCheck = { ...supervisor.hostCheck, runtimeImageId: "sha256:fakeimage" };
      expect((await ctx.app.request(`/api/tasks/${task.id}/preview`, json({ candidateDigest: task.candidateDigest, input: { x: 5 } }, op))).status).toBe(200);
    } finally {
      await ctx.close();
    }
  });

  test("a record that carries only a repo digest cannot be compared: new grants and previews are refused, an issued grant still downloads", async () => {
    const supervisor = new ImageSupervisor({ profile: fixture.profile, observe: fixtureObserve });
    supervisor.invokeImage = { imageDigest: `airlock/python@sha256:${"7".repeat(64)}`, imageId: null };
    const ctx = await makeCtx({ withWorker: true, supervisor });
    try {
      const op = await login(ctx.app, OPERATOR);
      const task = await completedTask(ctx, op);
      // Before the supervisor pins an image id, nothing is comparable and the grant is issued.
      const grant = (await (await ctx.app.request(`/api/tasks/${task.id}/export`, json({}, op))).json()) as { url: string };
      supervisor.hostCheck = { ...supervisor.hostCheck, runtimeImageId: "sha256:fakeimage" };
      const p = await ctx.app.request(`/api/tasks/${task.id}/preview`, json({ candidateDigest: task.candidateDigest, input: { x: 5 } }, op));
      expect(p.status).toBe(409);
      expect(await errorOf(p)).toContain(PREDATES_IMAGE_IDENTITY);
      // Another session asks for a new grant: refused.
      const judgeGrant = await ctx.app.request(`/api/tasks/${task.id}/export`, json({}, op));
      expect(judgeGrant.status).toBe(409);
      expect(await errorOf(judgeGrant)).toContain(PREDATES_IMAGE_IDENTITY);
      expect((await ctx.app.request(grant.url, { headers: { cookie: op } })).status).toBe(200);
    } finally {
      await ctx.close();
    }
  });

  test("a preview sandbox reporting another image id than the verification is refused after the run", async () => {
    const supervisor = new ImageSupervisor({ profile: fixture.profile, observe: fixtureObserve });
    const ctx = await makeCtx({ withWorker: true, supervisor });
    try {
      const op = await login(ctx.app, OPERATOR);
      const task = await completedTask(ctx, op);
      supervisor.previewImageId = `sha256:${"5".repeat(64)}`;
      const res = await ctx.app.request(`/api/tasks/${task.id}/preview`, json({ candidateDigest: task.candidateDigest, input: { x: 5 } }, op));
      expect(res.status).toBe(409);
      expect(await errorOf(res)).toContain("5555555555");
    } finally {
      await ctx.close();
    }
  });
});

describe("D4/D11/M6 production mode", () => {
  test("a dev-unsafe supervisor refuses new tasks in production", async () => {
    const ctx = await makeCtx({ extra: { production: true } });
    try {
      const op = await login(ctx.app, OPERATOR);
      const res = await ctx.app.request("/api/tasks", json({ profileId: "fx-1", issueText: "x" }, op));
      expect(res.status).toBe(503);
      expect(await errorOf(res)).toContain("gVisor or Kata required");
    } finally {
      await ctx.close();
    }
  });

  test("records measured on runc are never previewed or exported in production", async () => {
    const ctx = await makeCtx({ withWorker: true });
    try {
      const op = await login(ctx.app, OPERATOR);
      const task = await completedTask(ctx, op);
      ctx.deps.production = true;
      const app = createApp(ctx.deps);
      const p = await app.request(`/api/tasks/${task.id}/preview`, json({ candidateDigest: task.candidateDigest, input: { x: 5 } }, op));
      expect(p.status).toBe(409);
      expect(await errorOf(p)).toContain("does not serve it");
      const e = await app.request(`/api/tasks/${task.id}/export`, json({}, op));
      expect(e.status).toBe(409);
      expect(await errorOf(e)).toContain("does not serve it");
    } finally {
      await ctx.close();
    }
  });

  test("export in production requires a fully BLOCKED probe on both records (a resumed verification without one is refused)", async () => {
    const kata = { host: fakeHost({ selectedRuntime: "kata", devUnsafe: false, availableRuntimes: ["kata"], runtimeImageId: "sha256:fakeimage" }), inspection: { runtime: "kata" as const, devUnsafe: false } };
    // A full run: the baseline and the candidate records both carry the author probe.
    const full = await makeCtx({ withWorker: true, supervisor: new FakeSupervisor({ profile: fixture.profile, observe: fixtureObserve, ...kata }), extra: { production: true } });
    try {
      const op = await login(full.app, OPERATOR);
      const task = await completedTask(full, op);
      expect((await full.app.request(`/api/tasks/${task.id}/export`, json({}, op))).status).toBe(201);
    } finally {
      await full.close();
    }
    // A verification resumed with no stored probe: neither record has checkpoint 4.
    const resumed = await makeCtx({ withWorker: true, supervisor: new FakeSupervisor({ profile: fixture.profile, observe: fixtureObserve, ...kata }), extra: { production: true } });
    try {
      const h = resumed.harness!;
      const bytes = Buffer.from(FX_FIXED_SOURCE, "utf8");
      const file = { path: "lib/mod.py", byteLength: bytes.byteLength, sha256: sha(bytes), contentBase64: bytes.toString("base64") };
      const { buildManifestDouble } = await import("./helpers/doubles.ts");
      const { candidateDigestOf } = await import("@airlock/contracts");
      const manifest = buildManifestDouble(fixture.profile.manifest, [file]);
      const candidateDigest = await candidateDigestOf(manifest);
      await h.artifacts.putBlob(bytes);
      await h.artifacts.putImmutableJson("bundle", candidateDigest, { manifest, candidateDigest, files: [file] });
      const t = await h.newTask({ phase: "verify", attemptId: "att-gone", generation: 1, candidateDigest, candidates: [{ attemptId: "att-gone", candidateDigest }], budget: { modelCallsUsed: 4, repairAttemptsUsed: 1 } });
      const done = await h.waitFor(t.id);
      expect(done.outcome).toBe("CANDIDATE_PASSED_CHECKS");
      const op = await login(resumed.app, OPERATOR);
      const res = await resumed.app.request(`/api/tasks/${t.id}/export`, json({}, op));
      expect(res.status).toBe(409);
      expect(await errorOf(res)).toContain("no fully BLOCKED isolation probe");
    } finally {
      await resumed.close();
    }
  });
});

describe("rate-limit memory is bounded without resetting every client", () => {
  test("past the cap, expired entries are evicted first and a client inside its interval keeps its limit", () => {
    const map = new Map<string, number>();
    rememberRateKeys(map, ["active"], 5_000, 10_000, 3);
    rememberRateKeys(map, ["stale-1"], 0, 10_000, 3);
    rememberRateKeys(map, ["stale-2"], 0, 10_000, 3);
    // Two more keys at t=12 000: the stale ones (older than the interval) go, "active" stays.
    rememberRateKeys(map, ["new-1"], 12_000, 10_000, 3);
    rememberRateKeys(map, ["new-2"], 12_000, 10_000, 3);
    expect(map.size).toBe(3);
    expect(map.has("active")).toBe(true);
    expect(map.has("stale-1") || map.has("stale-2")).toBe(false);
    // Never cleared wholesale: with every entry live, only the least recently used goes.
    rememberRateKeys(map, ["new-3"], 12_500, 10_000, 3);
    expect([...map.keys()]).toEqual(["new-1", "new-2", "new-3"]);
  });
});

describe("cross-site request forgery", () => {
  test("state-changing requests with a foreign Origin or a cross-site Sec-Fetch-Site are refused; same-origin and non-browser clients pass", async () => {
    const ctx = await makeCtx();
    try {
      const op = await login(ctx.app, OPERATOR);
      const body = JSON.stringify({ profileId: "fx-1", issueText: "x" });
      const post = (headers: Record<string, string>) =>
        ctx.app.request("http://airlock.test/api/tasks", { method: "POST", headers: { "content-type": "application/json", cookie: op, host: "airlock.test", ...headers }, body });
      expect((await post({ origin: "https://evil.example" })).status).toBe(403);
      expect((await post({ origin: "null" })).status).toBe(403);
      expect((await post({ "sec-fetch-site": "cross-site" })).status).toBe(403);
      expect((await post({ "sec-fetch-site": "same-site" })).status).toBe(403);
      expect((await post({ origin: "http://airlock.test", "sec-fetch-site": "same-origin" })).status).toBe(201);
      expect((await post({})).status).toBe(201);
      // Reads are unaffected.
      expect((await ctx.app.request("http://airlock.test/api/tasks", { headers: { cookie: op, origin: "https://evil.example" } })).status).toBe(200);
      // Login is a state change too.
      expect((await ctx.app.request("http://airlock.test/api/session", { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example", host: "airlock.test" }, body: JSON.stringify({ password: OPERATOR }) })).status).toBe(403);
    } finally {
      await ctx.close();
    }
  });
});
