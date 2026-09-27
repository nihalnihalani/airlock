/**
 * Milestone 5 (40 Stage 5; audit 42 C22–C27): exclusive human browser control, live view, and
 * supported final actions through the airlock-forms-v1 adapter — plus the M4 download tools and
 * sandbox-refusal outcomes. Everything runs against the fake supervisor; the forms destination is
 * the real fixtures service (apps/fixtures) behind a simulated browser (helpers/forms.ts).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ActionProposal, BrowserAnyOp, BrowserOpResult, RunEvent, Task } from "@airlock/contracts";
import { APPROVAL_FIELD, verifyApprovalCode } from "@airlock/fixtures";
import { createApp, type ApiDeps } from "../src/api.ts";
import { zipFiles } from "../src/artifacts/index.ts";
import { ControlService } from "../src/browser-control.ts";
import { ConfigError, loadConfig } from "../src/config.ts";
import { approvalCodeFor, formPayloadDigest, normalizeFields, parseFormsOrigins, readReceipt, resolveFormUrl } from "../src/forms-adapter.ts";
import type { GeneralDeps } from "../src/general-handler.ts";
import { STORE_KIND_GENERAL_USAGE, type GeneralUsage } from "../src/general-handler.ts";
import { STORE_KIND_PROPOSALS } from "../src/proposals.ts";
import { DEFAULT_FIXTURES_ORIGIN, openScriptedCatalog } from "../src/scripted.ts";
import { SessionService } from "../src/sessions.ts";
import type { ChatInput } from "../src/vultr-client.ts";
import { exportBundleDouble, fixtureObserve, makeFixture, type Fixture } from "./helpers/doubles.ts";
import { FakeSupervisor, type FakeAttempt } from "./helpers/fake-supervisor.ts";
import { CONTACT_FIELDS, CONTACT_URL, FORMS_HOST, FORMS_ORIGIN, FORMS_SECRET, FakeFormsDestination } from "./helpers/forms.ts";
import { OWNER, makeGeneralHarness, recordingDriver, type GeneralHarness, type Turn } from "./helpers/general.ts";
import { HERO_HOST, HERO_PAGES, HERO_URL, heroExec } from "./helpers/hero.ts";

const OPERATOR = "operator-pass-123";
const JUDGE = "judge-pass-456";

let fixture: Fixture;
beforeAll(async () => {
  fixture = await makeFixture();
});
afterAll(async () => {
  await fixture.cleanup();
});

type Hook = (attempt: FakeAttempt, request: BrowserAnyOp, index: number) => Promise<BrowserOpResult | undefined> | BrowserOpResult | undefined;

interface Ctx {
  app: ReturnType<typeof createApp>;
  h: GeneralHarness;
  supervisor: FakeSupervisor;
  forms: FakeFormsDestination;
  control: ControlService;
  operator: string;
  task: Task;
  close: () => Promise<void>;
}

async function makeCtx(
  driver: ReturnType<typeof recordingDriver>,
  options: { control?: Partial<ConstructorParameters<typeof ControlService>[0]>; general?: Partial<GeneralDeps>; hook?: Hook; supervisor?: Partial<ConstructorParameters<typeof FakeSupervisor>[0]>; profile?: string; egressAllow?: string[] } = {},
): Promise<Ctx> {
  const forms = new FakeFormsDestination();
  const supervisor = new FakeSupervisor({
    profile: fixture.profile,
    observe: fixtureObserve,
    pages: HERO_PAGES,
    exec: heroExec,
    browserOp: async (attempt, request, index) => (await options.hook?.(attempt, request, index)) ?? (await forms.browserOp(attempt, request)),
    ...(options.supervisor ?? {}),
  });
  let control!: ControlService;
  const h = await makeGeneralHarness(fixture, supervisor, driver, {
    general: (store, bus) => {
      control = new ControlService({ store, bus, pollMs: 20, ...(options.control ?? {}) });
      return { control, forms: forms.config(), receiptRetryDelaysMs: [0, 20, 20], proposalPollMs: 20, ...(options.general ?? {}) };
    },
  });
  const sessions = new SessionService(h.store, { operatorPassword: OPERATOR, judgePassword: JUDGE, ttlMs: 60_000, secureCookies: false });
  const deps: ApiDeps = {
    store: h.store,
    sessions,
    profiles: new Map([[fixture.profile.manifest.id, fixture.profile]]),
    supervisor,
    artifacts: h.blobs,
    artifactService: h.artifacts,
    worker: h.worker,
    bus: h.bus,
    exportBundle: exportBundleDouble,
    zipFiles,
    exportGrantTtlMs: 60_000,
    hostileMinIntervalMs: 10_000,
    runtimeDir: fixture.runtimeDir,
    ssePollMs: 20,
    control,
  };
  const app = createApp(deps);
  const operator = await login(app, OPERATOR);
  const task = await h.newTask({ profileId: options.profile ?? "web-research", egressAllow: options.egressAllow ?? [HERO_HOST, FORMS_HOST] });
  return { app, h, supervisor, forms, control, operator, task, close: () => h.close() };
}

async function login(app: ReturnType<typeof createApp>, password: string): Promise<string> {
  const res = await app.request("/api/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }) });
  expect(res.status).toBe(200);
  return (res.headers.get("set-cookie") ?? "").split(";")[0]!;
}
const post = (ctx: Ctx, path: string, body: unknown = {}, cookie = ctx.operator) => ctx.app.request(`/api/tasks/${ctx.task.id}${path}`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) });
const get = (ctx: Ctx, path: string, cookie = ctx.operator) => ctx.app.request(`/api/tasks/${ctx.task.id}${path}`, { headers: { cookie } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};
/** The generation of the newest tool result that carries one (for scripted ref-bound turns). */
function lastGeneration(input: ChatInput): number {
  for (const m of [...input.messages].reverse()) {
    if (m.role !== "tool") continue;
    try {
      const g = (JSON.parse(m.content) as { generation?: unknown }).generation;
      if (typeof g === "number") return g;
    } catch {
      // not JSON
    }
  }
  return 0;
}
const toolResults = (driver: ReturnType<typeof recordingDriver>) => driver.inputs.at(-1)!.messages.filter((m) => m.role === "tool").map((m) => m.content);
const titled = (events: RunEvent[], title: string) => events.filter((e) => e.title.startsWith(title));
async function run(ctx: Ctx): Promise<Task> {
  ctx.h.worker.start();
  return ctx.h.waitFor(ctx.task.id, 20_000);
}
async function waitProposal(ctx: Ctx, status: ActionProposal["status"] = "pending"): Promise<ActionProposal> {
  let found: ActionProposal | undefined;
  await ctx.h.waitUntil(async () => {
    const res = await get(ctx, "/approvals");
    if (res.status !== 200) return false;
    found = ((await res.json()) as ActionProposal[]).find((p) => p.status === status);
    return !!found;
  });
  return found!;
}

// ---------------------------------------------------------------------------------------------
describe("exclusive control (C23/C24)", () => {
  test("take → human actions (egress still enforced) → release; the agent waits meanwhile and must observe before a ref-bound action", async () => {
    let ctx!: Ctx;
    const driver = recordingDriver(
      [
        { toolCalls: [{ name: "browser_navigate", args: { url: HERO_URL } }] },
        { toolCalls: [{ name: "browser_observe", args: {} }] },
        (input) => ({ toolCalls: [{ name: "browser_click", args: { ref: "e1", generation: lastGeneration(input) } }] }),
        { toolCalls: [{ name: "browser_observe", args: {} }] },
        (input) => ({ toolCalls: [{ name: "browser_click", args: { ref: "e1", generation: lastGeneration(input) } }] }),
        { toolCalls: [{ name: "submit_result", args: { summary: "done", sources: [HERO_URL] } }] },
      ],
      {
        before: async (call) => {
          if (call !== 3) return;
          const take = await post(ctx, "/control/take");
          expect(take.status).toBe(200);
          expect(((await take.json()) as { holder: string }).holder).toBe("human");
          const act = await post(ctx, "/control/action", { request: { op: "observe" } });
          expect(act.status).toBe(200);
          expect(((await act.json()) as { ok: boolean }).ok).toBe(true);
          const outside = await post(ctx, "/control/action", { request: { op: "navigate", args: { url: "https://evil.example.org/" } } });
          expect(outside.status).toBe(422);
          expect(((await outside.json()) as { error: string }).error).toContain("not an allowed destination");
          setTimeout(() => void post(ctx, "/control/release"), 250);
        },
      },
    );
    ctx = await makeCtx(driver);
    try {
      const done = await run(ctx);
      expect(done.status).toBe("done");
      expect(done.control?.holder).toBe("agent");
      // Serial, exclusive stream: the human's observe, never an agent click while the human held control,
      // and the refused navigation never reached the supervisor.
      expect(ctx.supervisor.browserRequests.map((r) => r.request.op)).toEqual(["navigate", "observe", "observe", "observe", "click"]);
      const results = toolResults(driver);
      expect(results[2]).toContain("control returned; observe first");
      expect(results[2]).toContain("stale_reference");
      expect(results[4]).toContain('"invalidated":false');
      const events = await ctx.h.events(done.id);
      const order = ["Human control requested", "Human took control", "Agent paused: human control", "Control returned to the agent"].map((t) => titled(events, t)[0]?.seq ?? -1);
      expect(order.every((s) => s > 0)).toBe(true);
      expect([...order].sort((a, b) => a - b)).toEqual(order);
      const human = events.find((e) => e.data?.actor === "human" && e.data?.opState === "completed")!;
      expect(human.data?.op).toBe("observe");
      // Who acted: the session's own opaque owner id and role (the actor kind stays "human").
      expect(human.data?.humanActor).toMatchObject({ role: "operator", owner: expect.stringMatching(/^operator-/) });
      expect(human.data?.visitedUrl).toBeUndefined();
      expect(events.some((e) => e.data?.opState === "allowed" && e.data?.policy === "egress")).toBe(true);
      expect(events.some((e) => e.data?.actor === "human" && e.data?.policy === "egress" && e.data?.opState === "failed")).toBe(true);
    } finally {
      await ctx.close();
    }
  });

  test("agent browser ops are not dispatched while a person holds control (bounded wait → human_control)", async () => {
    let ctx!: Ctx;
    const driver = recordingDriver(
      [
        { toolCalls: [{ name: "browser_navigate", args: { url: HERO_URL } }] },
        { toolCalls: [{ name: "browser_observe", args: {} }] },
        { toolCalls: [{ name: "submit_result", args: { summary: "gave up" } }] },
      ],
      {
        before: async (call) => {
          if (call === 2) expect((await post(ctx, "/control/take")).status).toBe(200);
        },
      },
    );
    ctx = await makeCtx(driver, { general: { controlHoldWaitMs: 150 } });
    try {
      const done = await run(ctx);
      expect(toolResults(driver)[1]).toContain("human_control");
      expect(ctx.supervisor.browserRequests.map((r) => r.request.op)).toEqual(["navigate"]);
      // The run ended while the person held control: control is handed back and recorded.
      expect(done.control?.holder).toBe("agent");
      expect(done.control?.reason).toContain("run ended");
    } finally {
      await ctx.close();
    }
  });

  test("a take while an agent op is in flight waits for it to settle, then grants", async () => {
    const started = deferred();
    const gate = deferred();
    const holdModel = deferred();
    let ctx!: Ctx;
    const driver = recordingDriver(
      [
        { toolCalls: [{ name: "browser_navigate", args: { url: HERO_URL } }] },
        { toolCalls: [{ name: "browser_screenshot", args: {} }] },
        { toolCalls: [{ name: "submit_result", args: { summary: "done" } }] },
      ],
      { before: async (call) => (call === 3 ? holdModel.promise : undefined) },
    );
    ctx = await makeCtx(driver, {
      hook: async (_a, request) => {
        if (request.op !== "screenshot") return undefined;
        started.resolve();
        await gate.promise;
        return undefined;
      },
    });
    try {
      ctx.h.worker.start();
      await started.promise;
      const takeAt = Date.now();
      const taking = post(ctx, "/control/take");
      await sleep(120);
      const mid = (await (await get(ctx, "/control")).json()) as { control: { holder: string } };
      expect(mid.control.holder).toBe("transferring");
      gate.resolve();
      const res = await taking;
      expect(res.status).toBe(200);
      expect(Date.now() - takeAt).toBeGreaterThanOrEqual(100);
      expect(((await res.json()) as { holder: string }).holder).toBe("human");
      const events = await ctx.h.events(ctx.task.id);
      const requested = titled(events, "Human control requested")[0]!.seq;
      const granted = titled(events, "Human took control")[0]!;
      expect(requested).toBeLessThan(granted.seq);
      // The screenshot operation was answered by the supervisor before control was granted.
      const shotOp = (await ctx.h.store.scanWhere<{ kind: string; state: string; settledAt?: string; createdAt: string }>("operations", { taskId: ctx.task.id, kind: "browserOp" })).map((r) => r.value).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1)!;
      expect(shotOp.state).toBe("acked");
      expect(Date.parse(shotOp.settledAt!)).toBeLessThanOrEqual(Date.parse(granted.at));
      expect((await post(ctx, "/control/release")).status).toBe(200);
      holdModel.resolve();
      await ctx.h.waitFor(ctx.task.id);
    } finally {
      gate.resolve();
      holdModel.resolve();
      await ctx.close();
    }
  });

  test("a take whose in-flight op does not settle fails 409 and never grants simultaneous control", async () => {
    const started = deferred();
    const gate = deferred();
    let ctx!: Ctx;
    const driver = recordingDriver([
      { toolCalls: [{ name: "browser_navigate", args: { url: HERO_URL } }] },
      { toolCalls: [{ name: "browser_screenshot", args: {} }] },
      { toolCalls: [{ name: "browser_observe", args: {} }] },
      { toolCalls: [{ name: "submit_result", args: { summary: "done" } }] },
    ]);
    ctx = await makeCtx(driver, {
      control: { settleTimeoutMs: 100 },
      hook: async (_a, request) => {
        if (request.op !== "screenshot") return undefined;
        started.resolve();
        await gate.promise;
        return undefined;
      },
    });
    try {
      ctx.h.worker.start();
      await started.promise;
      const res = await post(ctx, "/control/take");
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toContain("did not settle");
      const stored = (await ctx.h.store.get<Task>(OWNER, "tasks", ctx.task.id))!;
      expect(stored.control?.holder).toBe("transferring");
      // Nobody holds control: a human action is refused and the agent does not dispatch.
      expect((await post(ctx, "/control/action", { request: { op: "observe" } })).status).toBe(409);
      gate.resolve();
      await ctx.h.waitUntil(async () => (await ctx.h.events(ctx.task.id)).some((e) => e.title.startsWith("Agent paused")));
      expect(ctx.supervisor.browserRequests.map((r) => r.request.op)).toEqual(["navigate", "screenshot"]);
      expect((await post(ctx, "/control/release")).status).toBe(200);
      const done = await ctx.h.waitFor(ctx.task.id);
      expect(done.status).toBe("done");
      expect(ctx.supervisor.browserRequests.map((r) => r.request.op)).toEqual(["navigate", "screenshot", "observe"]);
      expect(titled(await ctx.h.events(ctx.task.id), "Control handover failed")).toHaveLength(1);
    } finally {
      gate.resolve();
      await ctx.close();
    }
  });

  test("idle human control expires back to the agent and is recorded", async () => {
    let ctx!: Ctx;
    const driver = recordingDriver(
      [
        { toolCalls: [{ name: "browser_navigate", args: { url: HERO_URL } }] },
        { toolCalls: [{ name: "browser_observe", args: {} }] },
        { toolCalls: [{ name: "submit_result", args: { summary: "done" } }] },
      ],
      {
        before: async (call) => {
          if (call === 2) expect((await post(ctx, "/control/take")).status).toBe(200);
        },
      },
    );
    ctx = await makeCtx(driver, { control: { idleMs: 200 } });
    try {
      const done = await run(ctx);
      expect(toolResults(driver)[1]).toContain('"url"');
      const events = await ctx.h.events(done.id);
      const returned = titled(events, "Control returned to the agent");
      expect(returned.length).toBeGreaterThanOrEqual(1);
      expect(returned[0]!.detail).toContain("idle timeout");
      expect(ctx.supervisor.browserRequests.map((r) => r.request.op)).toEqual(["navigate", "observe"]);
    } finally {
      await ctx.close();
    }
  });

  test("control routes: another owner reads 404; a repair task or a stopped task cannot be taken", async () => {
    const holdModel = deferred();
    let ctx!: Ctx;
    const driver = recordingDriver([{ toolCalls: [{ name: "browser_navigate", args: { url: HERO_URL } }] }, { toolCalls: [{ name: "submit_result", args: { summary: "done" } }] }], { before: async (call) => (call === 2 ? holdModel.promise : undefined) });
    ctx = await makeCtx(driver);
    try {
      ctx.h.worker.start();
      await ctx.h.waitUntil(() => ctx.control.isAttached(ctx.task.id));
      const judge = await login(ctx.app, JUDGE);
      expect((await post(ctx, "/control/take", {}, judge)).status).toBe(404);
      expect((await get(ctx, "/live", judge)).status).toBe(404);
      holdModel.resolve();
      await ctx.h.waitFor(ctx.task.id);
      expect((await post(ctx, "/control/take")).status).toBe(409);
    } finally {
      holdModel.resolve();
      await ctx.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------
describe("live view (C22)", () => {
  test("refresh stores a frame through the supervisor, is rate limited, works while a person holds control, and frames are not evidence", async () => {
    let ctx!: Ctx;
    const driver = recordingDriver(
      [
        { toolCalls: [{ name: "browser_navigate", args: { url: HERO_URL } }] },
        { toolCalls: [{ name: "submit_result", args: { summary: "done", sources: [HERO_URL] } }] },
      ],
      {
        before: async (call) => {
          if (call !== 2) return;
          const first = await post(ctx, "/live/refresh");
          expect(first.status).toBe(200);
          const { artifactId } = (await first.json()) as { artifactId: string };
          expect((await post(ctx, "/live/refresh")).status).toBe(429);
          const live = (await (await get(ctx, "/live")).json()) as { frame: { artifactId: string; tool: string }; liveBrowser: boolean };
          expect(live.frame.artifactId).toBe(artifactId);
          expect(live.frame.tool).toBe("live_view");
          expect(live.liveBrowser).toBe(true);
          expect((await post(ctx, "/control/take")).status).toBe(200);
          await sleep(170);
          expect((await post(ctx, "/live/refresh")).status).toBe(200);
          const shot = await post(ctx, "/control/action", { request: { op: "screenshot" } });
          const body = (await shot.json()) as { ok: boolean; artifactId: string; result: { response: { result: Record<string, unknown> } } };
          expect(body.ok).toBe(true);
          expect(body.artifactId).toMatch(/^art-/);
          expect(body.result.response.result.png).toBeUndefined();
          expect((await post(ctx, "/control/release")).status).toBe(200);
        },
      },
    );
    ctx = await makeCtx(driver, { control: { refreshMinIntervalMs: 150 } });
    try {
      const done = await run(ctx);
      const events = await ctx.h.events(done.id);
      expect(titled(events, "Live frame")).toHaveLength(2);
      expect(events.filter((e) => e.kind === "artifact" && e.data?.frame === true)).toHaveLength(3);
      // Each stored frame carries the operationId of the started screenshot operation it answers.
      for (const frame of events.filter((e) => e.kind === "artifact" && e.data?.frame === true)) {
        const started = events.find((e) => e.kind === "tool" && e.data?.opState === "started" && e.data?.operationId === frame.data?.operationId);
        expect(started && started.seq < frame.seq).toBe(true);
      }
      expect(events.find((e) => e.kind === "artifact" && e.data?.actor === "human")!.data?.humanActor).toMatchObject({ role: "operator" });
      // Frames and human screenshots are stored but are not the agent's screenshot evidence.
      expect(done.result!.checks.find((c) => c.name === "screenshot-evidence")!.passed).toBe(false);
      expect(ctx.supervisor.browserRequests.filter((r) => r.request.op === "screenshot")).toHaveLength(3);
    } finally {
      await ctx.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------
const proposeTurns = (extra: Turn[] = []): Turn[] => [
  { toolCalls: [{ name: "browser_navigate", args: { url: CONTACT_URL } }] },
  { toolCalls: [{ name: "browser_observe", args: {} }] },
  { toolCalls: [{ name: "browser_propose_submit", args: { formUrl: CONTACT_URL, formId: "contact-request", fields: CONTACT_FIELDS, summary: "Ask the demo team to call Ada back." } }] },
  ...extra,
  { toolCalls: [{ name: "submit_result", args: { summary: "done", sources: [CONTACT_URL] } }] },
];

describe("supported final actions (C25–C27)", () => {
  test("proposal → approve with the restated digest → the controller submits → receipt confirmed; a wrong digest and a replay are 409", async () => {
    let ctx!: Ctx;
    const driver = recordingDriver(proposeTurns());
    ctx = await makeCtx(driver, { egressAllow: [FORMS_HOST] });
    try {
      ctx.h.worker.start();
      const pending = await waitProposal(ctx);
      expect(pending.fields).toEqual(CONTACT_FIELDS);
      expect(pending.destination).toBe(FORMS_ORIGIN);
      expect(pending.payloadDigest).toBe(await formPayloadDigest(FORMS_ORIGIN, "contact-request", CONTACT_FIELDS));
      const events0 = await ctx.h.events(ctx.task.id);
      expect(titled(events0, "Waiting for review")[0]!.data?.waitingForReview).toBe(true);
      expect(((await ctx.h.store.get<Task>(OWNER, "tasks", ctx.task.id))!).status).toBe("running");
      const wrong = await post(ctx, `/approvals/${pending.id}/decide`, { decision: "approve", payloadDigest: "0".repeat(64) });
      expect(wrong.status).toBe(409);
      const ok = await post(ctx, `/approvals/${pending.id}/decide`, { decision: "approve", payloadDigest: pending.payloadDigest });
      expect(ok.status).toBe(200);
      expect(((await ok.json()) as ActionProposal).status).toBe("approved");
      const replay = await post(ctx, `/approvals/${pending.id}/decide`, { decision: "approve", payloadDigest: pending.payloadDigest });
      expect(replay.status).toBe(409);
      const done = await ctx.h.waitFor(ctx.task.id, 20_000);
      const final = (await ctx.h.store.get<ActionProposal>(OWNER, STORE_KIND_PROPOSALS, pending.id))!;
      expect(final.status).toBe("confirmed");
      expect(final.receipt?.payloadDigest).toBe(pending.payloadDigest);
      expect(final.decidedBy).toMatch(/^operator-/);
      const receipt = ctx.forms.receipts.get(pending.id)!;
      expect(receipt.payloadDigest).toBe(pending.payloadDigest);
      expect(receipt.receiptId).toBe(final.receipt!.receiptId);
      expect(ctx.forms.submissions).toHaveLength(1);
      expect(ctx.forms.submissions[0]!.status).toBe(200);
      const result = JSON.parse(toolResults(driver)[2]!) as { status: string; receiptId: string };
      expect(result.status).toBe("confirmed");
      // The approval code never reaches the model, the event log or the API.
      const code = approvalCodeFor(ctx.forms.config(), { proposalId: final.id, payloadDigest: final.payloadDigest, expiresAt: final.expiresAt });
      expect(verifyApprovalCode({ secret: FORMS_SECRET, code, payloadDigest: final.payloadDigest, nowEpoch: Math.floor(Date.now() / 1000) }).ok).toBe(true);
      const events = await ctx.h.events(done.id);
      expect(JSON.stringify(events)).not.toContain(code.split(".")[2]!);
      expect(JSON.stringify(driver.inputs)).not.toContain(code.split(".")[2]!);
      expect(titled(events, "Final action confirmed by the destination")).toHaveLength(1);
      // The controller typed the approval code into the airlock_approval input and clicked Submit itself.
      const ops = ctx.supervisor.browserRequests.map((r) => r.request.op);
      expect(ops.filter((o) => o === "type")).toHaveLength(4);
      expect(ops.filter((o) => o === "click")).toHaveLength(1);
    } finally {
      await ctx.close();
    }
  });

  test("reject: the model is told, nothing is submitted", async () => {
    let ctx!: Ctx;
    const driver = recordingDriver(proposeTurns());
    ctx = await makeCtx(driver, { egressAllow: [FORMS_HOST] });
    try {
      ctx.h.worker.start();
      const pending = await waitProposal(ctx);
      expect((await post(ctx, `/approvals/${pending.id}/decide`, { decision: "reject", payloadDigest: pending.payloadDigest })).status).toBe(200);
      await ctx.h.waitFor(ctx.task.id);
      expect(JSON.parse(toolResults(driver)[2]!).status).toBe("rejected");
      expect(ctx.forms.submissions).toHaveLength(0);
      expect(ctx.forms.receipts.get(pending.id)).toBeUndefined();
      expect(ctx.supervisor.browserRequests.map((r) => r.request.op)).toEqual(["navigate", "observe"]);
    } finally {
      await ctx.close();
    }
  });

  test("an expired proposal is 410 and nothing is submitted", async () => {
    const holdModel = deferred();
    let ctx!: Ctx;
    const driver = recordingDriver(proposeTurns(), { before: async (call) => (call === 4 ? holdModel.promise : undefined) });
    ctx = await makeCtx(driver, { egressAllow: [FORMS_HOST], general: { proposalTtlMs: 250 } });
    try {
      ctx.h.worker.start();
      const pending = await waitProposal(ctx);
      await waitProposal(ctx, "expired");
      const res = await post(ctx, `/approvals/${pending.id}/decide`, { decision: "approve", payloadDigest: pending.payloadDigest });
      expect(res.status).toBe(410);
      holdModel.resolve();
      await ctx.h.waitFor(ctx.task.id);
      expect(JSON.parse(toolResults(driver)[2]!).status).toBe("expired");
      expect(ctx.forms.submissions).toHaveLength(0);
    } finally {
      holdModel.resolve();
      await ctx.close();
    }
  });

  test("a lost submit response is outcome_unknown, never re-submitted, and reconciled from the receipt API", async () => {
    let ctx!: Ctx;
    const driver = recordingDriver(proposeTurns());
    ctx = await makeCtx(driver, { egressAllow: [FORMS_HOST] });
    ctx.forms.loseSubmitResponse = true;
    ctx.forms.receiptReadFailures = 1;
    try {
      ctx.h.worker.start();
      const pending = await waitProposal(ctx);
      expect((await post(ctx, `/approvals/${pending.id}/decide`, { decision: "approve", payloadDigest: pending.payloadDigest })).status).toBe(200);
      const done = await ctx.h.waitFor(ctx.task.id, 20_000);
      const final = (await ctx.h.store.get<ActionProposal>(OWNER, STORE_KIND_PROPOSALS, pending.id))!;
      expect(final.status).toBe("confirmed");
      expect(ctx.forms.submissions).toHaveLength(1);
      expect(ctx.forms.receiptReads.map((r) => r.status)).toEqual(["error", 200]);
      const events = await ctx.h.events(done.id);
      const unknown = titled(events, "Final action outcome unknown")[0]!;
      const confirmed = titled(events, "Final action confirmed by the destination")[0]!;
      expect(unknown.seq).toBeLessThan(confirmed.seq);
      expect(unknown.detail).toContain("NOT re-submitted");
      expect(events.some((e) => e.data?.tool === "approved_submit" && e.data?.opState === "unknown")).toBe(true);
    } finally {
      await ctx.close();
    }
  });

  test("S1: cancel during the receipt reads after a sent click → outcome_unknown, then confirmed only by reading the receipt (never re-submitted)", async () => {
    let ctx!: Ctx;
    let cancelled = false;
    const receiptFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (!cancelled) {
        cancelled = true;
        const res = await post(ctx, "/cancel");
        expect(res.status).toBe(200);
        throw new TypeError("connection reset during cancellation");
      }
      return ctx.forms.fetch(input, init);
    }) as typeof fetch;
    const driver = recordingDriver(proposeTurns());
    ctx = await makeCtx(driver, { egressAllow: [FORMS_HOST], general: { forms: { origins: [FORMS_ORIGIN], secret: FORMS_SECRET, fetch: receiptFetch, receiptTimeoutMs: 2000 } } });
    try {
      ctx.h.worker.start();
      const pending = await waitProposal(ctx);
      expect((await post(ctx, `/approvals/${pending.id}/decide`, { decision: "approve", payloadDigest: pending.payloadDigest })).status).toBe(200);
      const done = await ctx.h.waitFor(ctx.task.id, 20_000);
      expect(done.status).toBe("cancelled");
      const final = (await ctx.h.store.get<ActionProposal>(OWNER, STORE_KIND_PROPOSALS, pending.id))!;
      expect(final.status).toBe("confirmed");
      expect(final.receipt?.payloadDigest).toBe(pending.payloadDigest);
      expect(ctx.forms.submissions).toHaveLength(1);
      const events = await ctx.h.events(done.id);
      const unknown = titled(events, "Final action outcome unknown").find((e) => e.data?.proposalId === pending.id)!;
      expect(unknown.data).toMatchObject({ previousStatus: "submitted", status: "outcome_unknown" });
      expect(unknown.detail).toContain("NOT re-submitted");
      const confirmed = titled(events, "Final action confirmed by the destination")[0]!;
      expect(confirmed.data?.reconciled).toBe(true);
      expect(unknown.seq).toBeLessThan(confirmed.seq);
      expect(events.some((e) => e.data?.reconciliation === true && e.data?.receiptRead === "confirmed")).toBe(true);
    } finally {
      await ctx.close();
    }
  });

  test("S1: a controller restart after the click but before 'submitted': claimed → outcome_unknown, reconciled by receipt reads only; pending → expired", async () => {
    const driver = recordingDriver([{ toolCalls: [{ name: "submit_result", args: { summary: "recovered" } }] }]);
    const ctx = await makeCtx(driver, { egressAllow: [FORMS_HOST] });
    try {
      const digest = await formPayloadDigest(FORMS_ORIGIN, "contact-request", CONTACT_FIELDS);
      const at = new Date().toISOString();
      const proposal = (id: string, status: ActionProposal["status"]): ActionProposal => ({
        schemaVersion: 1,
        id,
        owner: OWNER,
        taskId: ctx.task.id,
        attemptId: "att-earlier",
        browserGeneration: 3,
        destination: FORMS_ORIGIN,
        adapter: "airlock-forms-v1",
        formId: "contact-request",
        fields: CONTACT_FIELDS,
        payloadDigest: digest,
        summary: "call Ada back",
        createdAt: at,
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        status,
        ...(status !== "pending" ? { decidedBy: "operator-x", decidedAt: at } : {}),
      });
      const clicked = proposal("prop-clicked0001", "claimed");
      const notClicked = proposal("prop-unclicked01", "claimed");
      const waiting = proposal("prop-waiting0001", "pending");
      for (const p of [clicked, notClicked, waiting]) expect(await ctx.h.store.insertImmutable(OWNER, STORE_KIND_PROPOSALS, p)).toBe(true);
      // The earlier run's click reached the destination (with the approval code) before it crashed.
      const body = new URLSearchParams({ ...CONTACT_FIELDS, [APPROVAL_FIELD]: approvalCodeFor(ctx.forms.config(), { proposalId: clicked.id, payloadDigest: clicked.payloadDigest, expiresAt: clicked.expiresAt }) });
      const res = await ctx.forms.app.fetch(new Request(`${FORMS_ORIGIN}/f/contact-request/submit`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: body.toString() }), "10.0.0.8");
      expect(res.status).toBe(200);
      // A recovering run: the earlier run's usage is on record.
      await ctx.h.store.put(OWNER, STORE_KIND_GENERAL_USAGE, { id: ctx.task.id, taskId: ctx.task.id, startedAtMs: Date.now(), browserOps: 5, codeRuns: 0, browserSessions: 1, browserInterruptions: 0, codeSandboxes: 0, unavailableToolCalls: 0 } satisfies GeneralUsage);
      const done = await run(ctx);
      expect(done.budget.recoveries).toBe(1);
      const get = async (id: string) => (await ctx.h.store.get<ActionProposal>(OWNER, STORE_KIND_PROPOSALS, id))!;
      expect((await get(clicked.id)).status).toBe("confirmed");
      expect((await get(clicked.id)).receipt?.payloadDigest).toBe(digest);
      expect((await get(notClicked.id)).status).toBe("outcome_unknown");
      expect((await get(waiting.id)).status).toBe("expired");
      // Reads only: nothing was (re-)submitted by the recovery, and no browser was started for it.
      expect(ctx.forms.submissions).toHaveLength(0);
      expect(ctx.forms.receipts.get(notClicked.id)).toBeUndefined();
      expect(ctx.supervisor.browserRequests).toHaveLength(0);
      const events = await ctx.h.events(done.id);
      const unknown = titled(events, "Final action outcome unknown");
      expect(unknown.map((e) => e.data?.proposalId).sort()).toEqual([clicked.id, notClicked.id].sort());
      expect(unknown.every((e) => e.data?.previousStatus === "claimed")).toBe(true);
      expect(titled(events, "Proposal expired")[0]!.data).toMatchObject({ proposalId: waiting.id, previousStatus: "pending" });
    } finally {
      await ctx.close();
    }
  });

  test("S2: a failure after the approval code was typed clears it before control returns; observations redact approval inputs", async () => {
    let ctx!: Ctx;
    const values = new Map<string, string>();
    let clicked = false;
    let typedCode = "";
    const hook: Hook = async (attempt, request) => {
      if (request.op === "navigate") values.clear();
      if (request.op === "type") {
        values.set(request.args.ref, request.args.text);
        if (request.args.ref === "fa") typedCode = request.args.text;
      }
      if (request.op === "click" && request.args.ref === "fs") {
        clicked = true;
        // The click never reaches the page: not sent.
        return { response: { schemaVersion: 1, id: null, op: "click", ok: false, error: "stale_reference", message: "ref/generation is not from the latest observe" }, status: "completed", durationMs: 1, generationBefore: null };
      }
      if (request.op === "observe") {
        const r = await ctx.forms.browserOp(attempt, request);
        if (!r?.response?.ok) return r;
        const result = r.response.result as { controls: { ref: string; role: string; name: string; value?: string }[] };
        // The page reports what is typed into its inputs; after the click, a second approval input
        // (named like the fixtures field) shows a value to test the controller's own redaction.
        result.controls = result.controls.map((c) => (values.has(c.ref) ? { ...c, value: values.get(c.ref)! } : c));
        if (clicked) result.controls.push({ ref: "zz", role: "textbox", name: APPROVAL_FIELD, value: "SENTINEL-APPROVAL-VALUE" });
        return r;
      }
      return undefined;
    };
    const driver = recordingDriver(proposeTurns([{ toolCalls: [{ name: "browser_observe", args: {} }] }]));
    ctx = await makeCtx(driver, { egressAllow: [FORMS_HOST], hook });
    try {
      ctx.h.worker.start();
      const pending = await waitProposal(ctx);
      expect((await post(ctx, `/approvals/${pending.id}/decide`, { decision: "approve", payloadDigest: pending.payloadDigest })).status).toBe(200);
      const done = await ctx.h.waitFor(ctx.task.id, 20_000);
      const final = (await ctx.h.store.get<ActionProposal>(OWNER, STORE_KIND_PROPOSALS, pending.id))!;
      expect(final.status).toBe("failed");
      const code = approvalCodeFor(ctx.forms.config(), { proposalId: final.id, payloadDigest: final.payloadDigest, expiresAt: final.expiresAt });
      expect(typedCode).toBe(code);
      expect(ctx.forms.submissions).toHaveLength(0);
      // The form was reloaded (inputs reset) after the failed click and before the model's next op.
      const ops = ctx.supervisor.browserRequests.map((r) => r.request.op);
      const click = ops.lastIndexOf("click");
      expect(ops.slice(click + 1)).toEqual(["navigate", "observe"]);
      const results = toolResults(driver);
      const observed = results[3]!;
      expect(observed).not.toContain(code);
      expect(observed).not.toContain(code.split(".")[2]!);
      expect(observed).not.toContain("SENTINEL-APPROVAL-VALUE");
      expect(observed).toContain("[redacted]");
      expect(observed).toContain('"ref":"fa","role":"textbox","name":"Approval code"}');
      const events = await ctx.h.events(done.id);
      expect(titled(events, "Approval code cleared")[0]!.data).toMatchObject({ proposalId: pending.id, scrub: "reloaded" });
      expect(JSON.stringify(events)).not.toContain(code.split(".")[2]!);
      expect(JSON.stringify(events)).not.toContain("SENTINEL-APPROVAL-VALUE");
      // Each approved-submission step's started intent is answered under the same operationId.
      for (const s of events.filter((e) => e.data?.tool === "approved_submit" && e.data?.opState === "started")) {
        const answer = events.find((e) => e.seq > s.seq && e.kind === "tool" && e.data?.operationId === s.data?.operationId && e.data?.opState !== "started");
        expect(answer).toBeDefined();
      }
    } finally {
      await ctx.close();
    }
  });

  test("the model cannot submit an adapter form itself: click on Submit, Enter and type-with-submit are refused before dispatch", async () => {
    let ctx!: Ctx;
    const driver = recordingDriver([
      { toolCalls: [{ name: "browser_navigate", args: { url: CONTACT_URL } }] },
      { toolCalls: [{ name: "browser_observe", args: {} }] },
      (input) => {
        const g = lastGeneration(input);
        return {
          toolCalls: [
            { name: "browser_type", args: { ref: "f0", generation: g, text: "Ada" } },
            { name: "browser_click", args: { ref: "fs", generation: g } },
            { name: "browser_key", args: { key: "Enter", generation: g } },
            { name: "browser_type", args: { ref: "f1", generation: g, text: "x", submit: true } },
          ],
        };
      },
      { toolCalls: [{ name: "submit_result", args: { summary: "could not submit" } }] },
    ]);
    ctx = await makeCtx(driver, { egressAllow: [FORMS_HOST] });
    try {
      const done = await run(ctx);
      const results = toolResults(driver);
      expect(results[2]).toContain('"invalidated":false');
      for (const r of results.slice(3, 6)) expect(r).toContain("final_action_requires_approval");
      expect(ctx.forms.submissions).toHaveLength(0);
      expect(ctx.supervisor.browserRequests.map((r) => r.request.op)).toEqual(["navigate", "observe", "type"]);
      expect(titled(await ctx.h.events(done.id), "browser_").filter((e) => e.data?.policy === "final-action")).toHaveLength(3);
    } finally {
      await ctx.close();
    }
  });

  test("a manual submission without a code is refused by the destination and recorded; a manual click is never an approval", async () => {
    let ctx!: Ctx;
    const driver = recordingDriver(
      [
        { toolCalls: [{ name: "browser_navigate", args: { url: CONTACT_URL } }] },
        { toolCalls: [{ name: "submit_result", args: { summary: "done" } }] },
      ],
      {
        before: async (call) => {
          if (call !== 2) return;
          expect((await post(ctx, "/control/take")).status).toBe(200);
          const obs = (await (await post(ctx, "/control/action", { request: { op: "observe" } })).json()) as { result: { response: { result: { generation: number } } } };
          const g = obs.result.response.result.generation;
          for (const [ref, text] of [["f0", "Ada"], ["f1", "ada@example.org"], ["f2", "hi"]] as const) expect((await post(ctx, "/control/action", { request: { op: "type", args: { ref, generation: g, text } } })).status).toBe(200);
          const click = (await (await post(ctx, "/control/action", { request: { op: "click", args: { ref: "fs", generation: g } } })).json()) as { ok: boolean };
          expect(click.ok).toBe(true);
          expect((await post(ctx, "/control/release")).status).toBe(200);
        },
      },
    );
    ctx = await makeCtx(driver, { egressAllow: [FORMS_HOST] });
    try {
      const done = await run(ctx);
      expect(ctx.forms.submissions.map((s) => s.status)).toEqual([403]);
      const refusal = (await ctx.h.events(done.id)).find((e) => e.data?.adapterRefusal === true)!;
      expect(refusal.data).toMatchObject({ actor: "human", formId: "contact-request", destination: FORMS_ORIGIN });
      expect(await ctx.h.store.scanWhere(STORE_KIND_PROPOSALS, { taskId: done.id })).toHaveLength(0);
    } finally {
      await ctx.close();
    }
  });

  test("decide on another owner's task is 404; a destination that is not configured or not allowed is refused", async () => {
    let ctx!: Ctx;
    const driver = recordingDriver([
      { toolCalls: [{ name: "browser_propose_submit", args: { formUrl: "https://elsewhere.example.org/f/contact-request", formId: "contact-request", fields: CONTACT_FIELDS, summary: "x" } }] },
      { toolCalls: [{ name: "browser_propose_submit", args: { formUrl: CONTACT_URL, formId: "contact-request", fields: { name: "Ada" }, summary: "x" } }] },
      ...proposeTurns().slice(2),
    ]);
    ctx = await makeCtx(driver, { egressAllow: [FORMS_HOST] });
    try {
      ctx.h.worker.start();
      const pending = await waitProposal(ctx);
      const judge = await login(ctx.app, JUDGE);
      expect((await post(ctx, `/approvals/${pending.id}/decide`, { decision: "approve", payloadDigest: pending.payloadDigest }, judge)).status).toBe(404);
      expect((await get(ctx, "/approvals", judge)).status).toBe(404);
      expect((await post(ctx, `/approvals/prop-unknown/decide`, { decision: "approve", payloadDigest: pending.payloadDigest })).status).toBe(404);
      expect((await post(ctx, `/approvals/${pending.id}/decide`, { decision: "reject", payloadDigest: pending.payloadDigest })).status).toBe(200);
      await ctx.h.waitFor(ctx.task.id);
      const results = toolResults(driver);
      expect(results[0]).toContain("not a supported final-action destination");
      expect(results[1]).toContain("missing_field");
    } finally {
      await ctx.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------
describe("browser downloads (M4 follow-up)", () => {
  const csv = "region,revenue,target\nNorth,120,100\nSouth,80,110\nEast,95,100\nWest,130,120\n";
  const bytes = new TextEncoder().encode(csv);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const csvUrl = `https://${HERO_HOST}/data/regional-sales.csv`;
  const hook: Hook = (_a, request) => {
    const ok = (result: unknown): BrowserOpResult => ({ response: { schemaVersion: 1, id: null, op: request.op, ok: true, result }, status: "completed", durationMs: 1, generationBefore: null });
    if (request.op === "download.list")
      return ok({ downloads: [{ downloadId: "dl-1", suggestedFilename: "../../regional-sales.csv", url: csvUrl, tabId: "tab-1", state: "completed", bytes: bytes.byteLength, sha256: digest, mediaType: "text/csv", startedAt: new Date().toISOString() }], admitted: 1, completedBytes: bytes.byteLength, limits: { maxFileBytes: 1, maxCount: 10, maxTotalBytes: 1 } });
    if (request.op === "download.read") return ok({ downloadId: "dl-1", suggestedFilename: "regional-sales.csv", url: csvUrl, mediaType: "text/csv", runnerMediaType: "text/csv", bytes: bytes.byteLength, sha256: digest, contentBase64: Buffer.from(bytes).toString("base64"), chunks: 1 });
    return undefined;
  };

  test("download_list → download_save stores a download artifact with its source URL and places it under inputs/ (lazily and immediately)", async () => {
    const driver = recordingDriver([
      { toolCalls: [{ name: "browser_navigate", args: { url: HERO_URL } }] },
      { toolCalls: [{ name: "browser_screenshot", args: {} }, { name: "browser_download_list", args: {} }] },
      { toolCalls: [{ name: "browser_download_save", args: { downloadId: "dl-1", name: "regions.csv" } }] },
      { toolCalls: [{ name: "code_write", args: { path: "code/analysis.py", content: "print('x')\n" } }] },
      { toolCalls: [{ name: "browser_download_save", args: { downloadId: "dl-1", name: "copy.csv" } }] },
      { toolCalls: [{ name: "code_run", args: { language: "python", file: "code/analysis.py" } }] },
      { toolCalls: [{ name: "submit_result", args: { summary: "South", outputs: ["outputs/summary.json", "outputs/chart.png"], sources: [HERO_URL] } }] },
    ]);
    const ctx = await makeCtx(driver, { profile: "web-analysis", egressAllow: [HERO_HOST], hook });
    try {
      const done = await run(ctx);
      expect(done.outcome).toBe("RESULT_VERIFIED");
      expect(toolResults(driver)[2]).toContain("../../regional-sales.csv");
      const downloads = (await ctx.h.artifacts.listForTask(OWNER, done)).filter((a) => a.kind === "download");
      expect(downloads.map((a) => a.filename).sort()).toEqual(["copy.csv", "regions.csv"]);
      for (const a of downloads) {
        expect(a.source).toMatchObject({ url: csvUrl, tool: "browser_download_save" });
        expect(a.sha256).toBe(digest);
      }
      const puts = ctx.supervisor.toolCalls.filter((t) => t.args.kind === "put").map((t) => t.args as { path: string; contentBase64: string });
      expect(puts.map((p) => p.path)).toEqual(["inputs/regions.csv", "inputs/copy.csv"]);
      expect(Buffer.from(puts[0]!.contentBase64, "base64").toString("utf8")).toBe(csv);
      // Both roles were live at once: the browser attempt stayed up while the code sandbox ran.
      const created = ctx.supervisor.operations.filter((o) => o.kind === "createAttempt");
      expect(created).toHaveLength(2);
      expect(done.cleanup?.status).toBe("confirmed");
    } finally {
      await ctx.close();
    }
  });

  test("a download whose bytes do not match their digest is not stored", async () => {
    const driver = recordingDriver([
      { toolCalls: [{ name: "browser_navigate", args: { url: HERO_URL } }] },
      { toolCalls: [{ name: "browser_download_save", args: { downloadId: "dl-1", name: "regions.csv" } }] },
      { toolCalls: [{ name: "submit_result", args: { summary: "x" } }] },
    ]);
    const bad: Hook = (a, request, i) => {
      const r = hook(a, request, i) as BrowserOpResult | undefined;
      if (request.op === "download.read" && r?.response?.ok) (r.response.result as Record<string, unknown>).sha256 = "f".repeat(64);
      return r;
    };
    const ctx = await makeCtx(driver, { profile: "web-analysis", egressAllow: [HERO_HOST], hook: bad });
    try {
      const done = await run(ctx);
      expect(toolResults(driver)[1]).toContain("did not match");
      expect((await ctx.h.artifacts.listForTask(OWNER, done)).filter((a) => a.kind === "download")).toHaveLength(0);
    } finally {
      await ctx.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------
describe("sandbox refusals and prepare evidence", () => {
  const turns = (): Turn[] => [
    { toolCalls: [{ name: "code_write", args: { path: "code/a.py", content: "print(1)\n" } }] },
    { toolCalls: [{ name: "code_write", args: { path: "code/b.py", content: "print(2)\n" } }] },
    { toolCalls: [{ name: "code_run", args: { language: "python", file: "code/a.py" } }] },
    { toolCalls: [{ name: "submit_result", args: { summary: "nothing ran", outputs: ["outputs/summary.json"] } }] },
  ];
  test("a role not configured on the supervisor (400 unsupported_profile) is requested once and ends UNSUPPORTED", async () => {
    const driver = recordingDriver(turns());
    const ctx = await makeCtx(driver, { profile: "analysis", egressAllow: [], supervisor: { createRefusal: (role) => (role === "analysis" ? { status: 400, code: "unsupported_profile", message: "The analysis runtime is not configured on this supervisor (AIRLOCK_ANALYSIS_IMAGE is not set)." } : undefined) } });
    try {
      const done = await run(ctx);
      expect(done.outcome).toBe("UNSUPPORTED");
      expect(ctx.supervisor.operations.filter((o) => o.kind === "createAttempt")).toHaveLength(1);
      const results = toolResults(driver);
      expect(results[0]).toContain("AIRLOCK_ANALYSIS_IMAGE");
      expect(results[1]).toContain("not retried");
      expect(results[2]).toContain("not retried");
      const prepare = (await ctx.h.events(done.id)).find((e) => e.kind === "phase" && e.title === "prepare")!;
      expect((prepare.data?.host as { selectedRuntime: string }).selectedRuntime).toBe("runc");
    } finally {
      await ctx.close();
    }
  });
  test("a probe refusal (409 probe_failed) ends INCONCLUSIVE, not RESULT_FAILED", async () => {
    const driver = recordingDriver(turns());
    const ctx = await makeCtx(driver, { profile: "analysis", egressAllow: [], supervisor: { createRefusal: (role) => (role === "analysis" ? { status: 409, code: "probe_failed", message: "Isolation probe not fully BLOCKED; sandbox destroyed and run refused." } : undefined) } });
    try {
      const done = await run(ctx);
      expect(done.outcome).toBe("INCONCLUSIVE");
      expect(ctx.supervisor.operations.filter((o) => o.kind === "createAttempt")).toHaveLength(1);
    } finally {
      await ctx.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------
describe("forms adapter, config and scripted fixtures origin", () => {
  test("normalization, payload digest and approval code match the destination's test vectors", async () => {
    const vectors = JSON.parse(await readFile(join(import.meta.dir, "../../fixtures/test/vectors.json"), "utf8")) as {
      destination: string;
      secret: string;
      normalization: { formId: string; raw: [string, unknown][]; ok: boolean; fields?: Record<string, string>; payloadDigest?: string }[];
      approval: { proposalId: string; payloadDigest: string; expiresAtEpoch: number; code: string }[];
    };
    for (const v of vectors.normalization) {
      const n = normalizeFields(v.formId, v.raw);
      expect(n.ok).toBe(v.ok);
      if (n.ok && v.payloadDigest) {
        expect(n.fields).toEqual(v.fields!);
        expect(await formPayloadDigest(vectors.destination, v.formId, n.fields)).toBe(v.payloadDigest);
      }
    }
    const a = vectors.approval[0]!;
    expect(approvalCodeFor({ origins: [vectors.destination], secret: vectors.secret }, { proposalId: a.proposalId, payloadDigest: a.payloadDigest, expiresAt: new Date(a.expiresAtEpoch * 1000).toISOString() })).toBe(a.code);
  });

  test("form URLs must be a configured origin's /f/<formId>; receipt reads are pinned and refuse redirects", async () => {
    const config = { origins: [FORMS_ORIGIN], secret: FORMS_SECRET };
    expect(resolveFormUrl(config, CONTACT_URL, "contact-request").ok).toBe(true);
    expect(resolveFormUrl(config, `${CONTACT_URL}?x=1`, "contact-request").ok).toBe(false);
    expect(resolveFormUrl(config, `${FORMS_ORIGIN}/f/order-sample`, "contact-request").ok).toBe(false);
    expect(resolveFormUrl(config, CONTACT_URL, "no-such-form").ok).toBe(false);
    expect(resolveFormUrl(null, CONTACT_URL, "contact-request").ok).toBe(false);
    const seen: { url: string; redirect?: RequestRedirect }[] = [];
    const read = await readReceipt({ ...config, fetch: (async (url: string, init?: RequestInit) => {
      seen.push({ url, ...(init?.redirect ? { redirect: init.redirect } : {}) });
      return new Response(JSON.stringify({ status: "none" }), { status: 404 });
    }) as typeof fetch }, FORMS_ORIGIN, "prop-1");
    expect(read.kind).toBe("none");
    expect(seen).toEqual([{ url: `${FORMS_ORIGIN}/api/receipts/prop-1`, redirect: "error" }]);
    expect((await readReceipt(config, "https://other.example.org", "prop-1")).kind).toBe("error");
  });

  test("AIRLOCK_FORMS_ORIGINS needs AIRLOCK_FORMS_SECRET; origins are normalized; the fixtures origin is validated", () => {
    expect(parseFormsOrigins(" https://Forms.Example.org , https://forms.example.org/ ")).toEqual(["https://forms.example.org"]);
    expect(() => parseFormsOrigins("https://forms.example.org/f/x")).toThrow();
    const base = { SUPERVISOR_TOKEN: "x".repeat(20), AIRLOCK_MODEL_DRIVER: `scripted:${join(import.meta.dir, "fixtures/scripted-general")}`, AIRLOCK_PROFILES_DIR: join(import.meta.dir, "../../../profiles"), AIRLOCK_WEB_DIST: "none" };
    expect(() => loadConfig({ ...base, AIRLOCK_FORMS_ORIGINS: "https://forms.example.org" })).toThrow(ConfigError);
    const config = loadConfig({ ...base, AIRLOCK_FORMS_ORIGINS: "https://forms.example.org", AIRLOCK_FORMS_SECRET: "s".repeat(40), AIRLOCK_FIXTURES_ORIGIN: "https://fixtures.example.org/" });
    expect(config.formsOrigins).toEqual(["https://forms.example.org"]);
    expect(config.fixturesOrigin).toBe("https://fixtures.example.org");
    expect(config.controlIdleMs).toBe(300_000);
    expect(() => loadConfig({ ...base, AIRLOCK_FIXTURES_ORIGIN: "ftp://x" })).toThrow(ConfigError);
  });

  test("scripted diagnostics substitute {{AIRLOCK_FIXTURES_ORIGIN}}", async () => {
    const dir = join(import.meta.dir, "fixtures/scripted-general");
    const hosted = await (await openScriptedCatalog(dir, { fixturesOrigin: "https://fixtures.example.org" })).load("general-hero");
    expect(JSON.stringify(hosted.turns)).toContain("https://fixtures.example.org/data/regional-sales");
    expect(JSON.stringify(hosted.turns)).not.toContain("{{");
    const local = await (await openScriptedCatalog(dir)).load("general-hero");
    expect(JSON.stringify(local.turns)).toContain(`${DEFAULT_FIXTURES_ORIGIN}/data/regional-sales`);
  });
});
