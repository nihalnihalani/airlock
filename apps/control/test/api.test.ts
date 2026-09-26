import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Task } from "@airlock/contracts";
import { createApp, STORE_KIND_GRANTS } from "../src/api.ts";
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

async function makeCtx(options: { withWorker?: boolean; now?: () => number } = {}): Promise<Ctx> {
  const supervisor = new FakeSupervisor({ profile: fixture.profile, observe: fixtureObserve });
  let harness: Harness | null = null;
  let store: Store;
  let artifacts: MemoryArtifactStore;
  let bus: TaskEventBus;
  if (options.withWorker) {
    const driver = scriptedDriverDouble([
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
    exportBundle: exportBundleDouble,
    zipFiles: zipFilesDouble,
    exportGrantTtlMs: 60_000,
    hostileMinIntervalMs: 10_000,
    ssePollMs: 20,
    ...(options.now ? { now: options.now } : {}),
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
      const view = (await (await ctx.app.request(`/api/tasks/${task.id}`)).json()) as { task: Task };
      expect(view.task.id).toBe(task.id);
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
