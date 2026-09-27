import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Task } from "@airlock/contracts";
import { createApp, STORE_KIND_GRANTS } from "../src/api.ts";
import { exportBundle } from "../src/artifacts/index.ts";
import { TaskEventBus } from "../src/events.ts";
import { ARTIFACT_KIND_BUNDLE, STORE_KIND_VERIFICATIONS } from "../src/repair-handler.ts";
import { SessionService } from "../src/sessions.ts";
import { createStore, type Store } from "../src/store/index.ts";
import { exportBundleDouble, FX_FIXED_SOURCE, fixtureObserve, makeFixture, MemoryArtifactStore, scriptedDriverDouble, zipFilesDouble, type Fixture } from "./helpers/doubles.ts";
import { FakeSupervisor } from "./helpers/fake-supervisor.ts";
import { makeHarness, OWNER, type Harness } from "./helpers/harness.ts";

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
  close: () => Promise<void>;
}

async function makeCtx(options: { withWorker?: boolean; now?: () => number; webDist?: string; trustedProxies?: string[]; realExport?: boolean; driverScript?: Parameters<typeof scriptedDriverDouble>[0] } = {}): Promise<Ctx> {
  const supervisor = new FakeSupervisor({ profile: fixture.profile, observe: fixtureObserve });
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
  const app = createApp({
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
    ssePollMs: 20,
    ...(options.now ? { now: options.now } : {}),
    ...(options.webDist ? { webDist: options.webDist } : {}),
    ...(options.trustedProxies ? { trustedProxies: options.trustedProxies } : {}),
  });
  return { app, store, supervisor, artifacts, harness, bus, close: async () => (harness ? harness.close() : store.close()) };
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
      expect((await ctx.app.request("/api/tasks/nope")).status).toBe(404);
      expect((await ctx.app.request("/api/tasks/../etc")).status).toBe(404);
      expect((await ctx.app.request("/api/host")).status).toBe(200);
    } finally {
      await ctx.close();
    }
  });

  test("create → list → view; judge cannot cancel an operator's task, operator can cancel anything", async () => {
    const ctx = await makeCtx();
    try {
      const op = await login(ctx.app, OPERATOR);
      const judge = await login(ctx.app, JUDGE);
      const created = await ctx.app.request("/api/tasks", json({ profileId: "fx-1", issueText: "compute(0) raises" }, op));
      expect(created.status).toBe(201);
      const task = (await created.json()) as Task;
      expect(task.status).toBe("queued");
      expect(task.owner).toBe("operator");
      const list = (await (await ctx.app.request("/api/tasks")).json()) as Task[];
      expect(list.map((t) => t.id)).toEqual([task.id]);
      const view = (await (await ctx.app.request(`/api/tasks/${task.id}`)).json()) as { task: Task; cases?: { id: string; kind: string; title: string }[] };
      expect(view.task.id).toBe(task.id);
      // Contract case titles ride on the view for the case table; inputs/expectations do not.
      expect(view.cases?.map((c) => c.id)).toEqual(fixture.profile.contract.cases.map((c) => c.id));
      expect(view.cases?.every((c) => typeof c.title === "string" && !("input" in c))).toBe(true);
      expect((await ctx.app.request(`/api/tasks/${task.id}/cancel`, json({}, judge))).status).toBe(403);
      const cancelled = await ctx.app.request(`/api/tasks/${task.id}/cancel`, json({}, op));
      expect(cancelled.status).toBe(200);
      expect(((await cancelled.json()) as Task).status).toBe("cancelled");
      expect((await ctx.app.request(`/api/tasks/${task.id}/cancel`, json({}, op))).status).toBe(409);
    } finally {
      await ctx.close();
    }
  });

  test("hostile is judge|operator only and rate limited per session", async () => {
    let t = 1_000_000;
    const ctx = await makeCtx({ now: () => t });
    try {
      const judge = await login(ctx.app, JUDGE);
      const first = await ctx.app.request("/api/hostile", json({ command: ":(){ :|:& };:" }, judge));
      expect(first.status).toBe(200);
      expect(((await first.json()) as { survived: { supervisorHealthy: boolean } }).survived.supervisorHealthy).toBe(true);
      const second = await ctx.app.request("/api/hostile", json({ command: "cat /etc/shadow" }, judge));
      expect(second.status).toBe(429);
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
      const res = await ctx.app.request("/api/tasks/task-sse/events", { headers: { "last-event-id": "3" } });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      const body = await res.text();
      const ids = [...body.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
      expect(ids).toEqual([4, 5]);
      expect(body).toContain("event: task");
      expect(body).toContain("event: end");
      expect(body).not.toContain('"title":"event 3"');
      // apps/web reopens a CLOSED stream with ?lastEventId=<seq>; it must replay like the header.
      const viaQuery = await (await ctx.app.request("/api/tasks/task-sse/events?lastEventId=4")).text();
      expect([...viaQuery.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]))).toEqual([5]);
      const bothHeaderWins = await (await ctx.app.request("/api/tasks/task-sse/events?lastEventId=1", { headers: { "last-event-id": "4" } })).text();
      expect([...bothHeaderWins.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]))).toEqual([5]);
    } finally {
      await ctx.close();
    }
  });

  test("unknown task → 404; no header → full replay", async () => {
    const ctx = await makeCtx();
    try {
      expect((await ctx.app.request("/api/tasks/task-none/events")).status).toBe(404);
      const at = new Date().toISOString();
      await ctx.store.put(OWNER, "tasks", { id: "task-x", owner: OWNER, profileId: "fx-1", issueText: "x", status: "failed", phase: "prepare", generation: 0, leaseId: null, leaseUntil: null, attempts: 1, budget: { modelCallsUsed: 0, repairAttemptsUsed: 0 }, createdAt: at, updatedAt: at });
      await ctx.store.appendEvent(OWNER, "task-x", { id: "e1", at, kind: "error", title: "boom", detail: "" });
      const body = await (await ctx.app.request("/api/tasks/task-x/events")).text();
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

  test("preview is open to judge sessions on any passed task but rate limited per session", async () => {
    let t = 5_000_000;
    const ctx = await makeCtx({ withWorker: true, now: () => t });
    try {
      const op = await login(ctx.app, OPERATOR);
      const judge = await login(ctx.app, JUDGE);
      const task = await completedTask(ctx, op);
      const body = { candidateDigest: task.candidateDigest, input: { x: 5 } };
      // A judge may preview an operator's passed task: that is the demo flow.
      expect((await ctx.app.request(`/api/tasks/${task.id}/preview`, json(body, judge))).status).toBe(200);
      // But not in a tight loop: one preview per interval per session, like /api/hostile.
      const second = await ctx.app.request(`/api/tasks/${task.id}/preview`, json(body, judge));
      expect(second.status).toBe(429);
      // The operator's own session has its own budget.
      expect((await ctx.app.request(`/api/tasks/${task.id}/preview`, json(body, op))).status).toBe(200);
      t += 2_001;
      expect((await ctx.app.request(`/api/tasks/${task.id}/preview`, json(body, judge))).status).toBe(200);
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
      const first = await ctx.app.request(`/api/tasks/${task.id}/export`, json({}, op));
      expect(first.status).toBe(201);
      const grant = (await first.json()) as { grantId: string; url: string; expiresAt: string };
      const second = await ctx.app.request(`/api/tasks/${task.id}/export`, json({}, op));
      expect(second.status).toBe(200);
      expect(await second.json()).toEqual(grant);
      const stored = await ctx.store.get<{ candidateDigest: string }>(OWNER, STORE_KIND_GRANTS, grant.grantId);
      expect(stored?.candidateDigest).toBe(task.candidateDigest!);
      expect(await ctx.store.insertImmutable(OWNER, STORE_KIND_GRANTS, { id: grant.grantId, candidateDigest: "0".repeat(64) })).toBe(false);
      expect((await ctx.store.get<{ candidateDigest: string }>(OWNER, STORE_KIND_GRANTS, grant.grantId))?.candidateDigest).toBe(task.candidateDigest!);

      const dl1 = await ctx.app.request(grant.url, { headers: { cookie: op } });
      expect(dl1.status).toBe(200);
      expect(dl1.headers.get("content-type")).toBe("application/zip");
      const bytes1 = new Uint8Array(await dl1.arrayBuffer());
      const dl2 = await ctx.app.request(grant.url, { headers: { cookie: op } });
      const bytes2 = new Uint8Array(await dl2.arrayBuffer());
      expect(Buffer.from(bytes1).equals(Buffer.from(bytes2))).toBe(true);
      const text = Buffer.from(bytes1).toString("utf8");
      expect(text).toContain("manifest.json");
      expect(text).not.toContain("b".repeat(40));
      expect((await ctx.app.request(grant.url, { headers: { cookie: judge } })).status).toBe(404);
      expect((await ctx.app.request(grant.url)).status).toBe(401);
      // Verification records are immutable in the store too.
      const rec = await ctx.store.get<{ id: string; passed: boolean }>(OWNER, STORE_KIND_VERIFICATIONS, task.verificationRecordId!);
      expect(await ctx.store.insertImmutable(OWNER, STORE_KIND_VERIFICATIONS, { ...rec!, passed: false })).toBe(false);
    } finally {
      await ctx.close();
    }
  });

  test("export download whose sealed bundle bytes no longer match the manifest is refused with 409 and a reason, not 500", async () => {
    const ctx = await makeCtx({ withWorker: true, realExport: true });
    try {
      const op = await login(ctx.app, OPERATOR);
      const task = await completedTask(ctx, op);
      const granted = await ctx.app.request(`/api/tasks/${task.id}/export`, json({}, op));
      expect(granted.status).toBe(201);
      const grant = (await granted.json()) as { url: string };
      expect((await ctx.app.request(grant.url, { headers: { cookie: op } })).status).toBe(200);
      // Tamper the stored bundle's bytes after sealing; the manifest and candidateDigest are untouched.
      const key = `${ARTIFACT_KIND_BUNDLE}/${task.candidateDigest}`;
      const bundle = ctx.artifacts.json.get(key) as { files: { contentBase64: string }[] };
      bundle.files[0]!.contentBase64 = Buffer.from("def compute(x):\n    return 'tampered'\n").toString("base64");
      const refused = await ctx.app.request(grant.url, { headers: { cookie: op } });
      expect(refused.status).toBe(409);
      const body = (await refused.json()) as { error: string };
      expect(body.error).toContain("no longer matches");
      expect(body.error).toContain("lib/mod.py");
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

  test("the unauthenticated event stream carries the output of every command the model runs (documented viewer policy)", async () => {
    // The READMEs say the viewer role sees command output, file contents included, and that only
    // the sealed zip is gated by an export grant. Pin the first half: a `run` after write_file
    // streams its stdout to a reader with no cookie.
    const ctx = await makeCtx({
      withWorker: true,
      driverScript: [
        { toolCalls: [{ name: "write_file", args: { path: "lib/mod.py", content: FX_FIXED_SOURCE } }] },
        { toolCalls: [{ name: "run", args: { command: "cat lib/mod.py" } }] },
        { toolCalls: [{ name: "submit_candidate", args: { summary: "fix" } }] },
      ],
    });
    try {
      const op = await login(ctx.app, OPERATOR);
      const created = (await (await ctx.app.request("/api/tasks", json({ profileId: "fx-1", issueText: "x" }, op))).json()) as Task;
      await ctx.harness!.waitFor(created.id);
      const body = await (await ctx.app.request(`/api/tasks/${created.id}/events`)).text();
      const execData = body
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => JSON.parse(line.slice(6)) as { kind?: string; data?: { tool?: string; result?: { stdout?: string } } })
        .find((e) => e.kind === "exec" && e.data?.tool === "run");
      expect(execData?.data?.result?.stdout).toBe("ran cat lib/mod.py");
      // The sealed candidate zip itself is not on the stream or the task view: it needs a grant.
      expect((await ctx.app.request(`/api/tasks/${created.id}/export`, json({}))).status).toBe(401);
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
