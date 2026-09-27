import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { BrowserOpResult, RunEvent, Task } from "@airlock/contracts";
import { MAX_IDENTICAL_FAILURES, STORE_KIND_TASK_ATTEMPTS, STORE_KIND_GENERAL_USAGE, CODE_RUNNER, type GeneralUsage, type TaskAttemptRow } from "../src/general-handler.ts";
import { inspectPng } from "../src/png.ts";
import { openScriptedCatalog } from "../src/scripted.ts";
import { createScriptedDriver } from "../src/vultr-client.ts";
import { fixtureObserve, makeFixture, type Fixture } from "./helpers/doubles.ts";
import { FakeSupervisor, okExec } from "./helpers/fake-supervisor.ts";
import { makeGeneralHarness, OWNER, recordingDriver, type GeneralHarness, type Turn } from "./helpers/general.ts";
import { HERO_HOST, HERO_PAGES, HERO_TURNS, HERO_URL, heroExec } from "./helpers/hero.ts";

let fixture: Fixture;
beforeAll(async () => {
  fixture = await makeFixture();
});
afterAll(async () => {
  await fixture.cleanup();
});

const supervisorFor = (extra: Partial<ConstructorParameters<typeof FakeSupervisor>[0]> = {}) => new FakeSupervisor({ profile: fixture.profile, observe: fixtureObserve, pages: HERO_PAGES, exec: heroExec, ...extra });
const toolEvents = (events: RunEvent[]) => events.filter((e) => e.kind === "tool" || e.kind === "exec");
const toolMessages = (driver: ReturnType<typeof recordingDriver>) => driver.inputs.at(-1)!.messages.filter((m) => m.role === "tool").map((m) => m.content);

async function run(h: GeneralHarness, overrides: Partial<Task> = {}): Promise<Task> {
  const task = await h.newTask(overrides);
  h.worker.start();
  return h.waitFor(task.id);
}

describe("general tasks: hero combined flow", () => {
  test("navigate → observe → screenshot → save text → code → run → submit gives RESULT_VERIFIED with evidence and confirmed cleanup", async () => {
    const supervisor = supervisorFor();
    const driver = recordingDriver(HERO_TURNS);
    const h = await makeGeneralHarness(fixture, supervisor, driver);
    try {
      const done = await run(h, { egressAllow: [HERO_HOST] });
      expect(done.status).toBe("done");
      expect(done.outcome).toBe("RESULT_VERIFIED");
      expect(done.result!.checks.every((c) => c.passed)).toBe(true);
      expect(done.result!.checks.map((c) => c.name)).toEqual(expect.arrayContaining(["outputs-claimed", "outputs-valid", "required-outputs", "summary-schema", "screenshot-evidence", "sources-cited", "sources-visited", "sources-in-policy", "output:summary.json", "output:chart.png"]));
      expect(done.cleanup?.status).toBe("confirmed");
      expect(done.attemptId).toBeUndefined();
      // Both sandboxes were created with the right roles/policy and destroyed.
      const created = supervisor.operations.filter((o) => o.kind === "createAttempt").map((o) => o.attemptId!);
      expect(created).toHaveLength(2);
      expect(supervisor.destroyed.sort()).toEqual([...created].sort());
      expect(supervisor.collected).toHaveLength(1);
      // Inputs: the saved page text was put under inputs/ before the code ran.
      expect(supervisor.toolCalls.some((t) => t.args.kind === "put" && t.args.path === "inputs/regions.csv")).toBe(true);
      expect(supervisor.toolCalls.find((t) => t.args.kind === "exec")!.args).toEqual({ kind: "exec", command: `${CODE_RUNNER} code/analysis.py` });
      // Artifacts with provenance.
      const artifacts = await h.artifacts.listForTask(OWNER, done);
      expect(artifacts.map((a) => a.kind).sort()).toEqual(["output", "output", "page_text", "screenshot"]);
      const shot = artifacts.find((a) => a.kind === "screenshot")!;
      expect(shot.source).toMatchObject({ url: HERO_URL, tool: "browser_screenshot" });
      expect(done.result!.sources).toEqual([{ url: HERO_URL, screenshotArtifactId: shot.id }]);
      const chart = artifacts.find((a) => a.filename === "chart.png")!;
      expect(chart.mediaType).toBe("image/png");
      expect(inspectPng(await h.artifacts.bytes(chart)).ok).toBe(true);
      // Every tool event carries opState; a supervisor-backed one also its operationId, started before completed.
      const events = await h.events(done.id);
      const tools = toolEvents(events);
      expect(tools.every((e) => typeof (e.data as { opState?: unknown })?.opState === "string")).toBe(true);
      const started = tools.filter((e) => e.data?.opState === "started");
      expect(started.length).toBeGreaterThanOrEqual(6);
      for (const s of started) {
        // The completion is a tool/exec event, or the lifecycle event of collect-outputs.
        const completion = events.find((e) => e.seq > s.seq && e.data?.operationId === s.data?.operationId && e.data?.opState !== "started");
        expect(completion?.data?.opState).toBe("completed");
      }
      // The model sees a stale-free, bounded observation; the model events are labelled scripted.
      expect(events.filter((e) => e.kind === "model").every((e) => e.data?.model === "scripted:test-general" && e.data?.imageAttached === false)).toBe(true);
      expect(done.budget.modelCallsUsed).toBe(6);
      expect(done.budget.repairAttemptsUsed).toBe(0);
    } finally {
      await h.close();
    }
  });

  test("the labelled scripted-general fixtures load and the hero script runs end to end without a model", async () => {
    const catalog = await openScriptedCatalog(join(import.meta.dir, "fixtures/scripted-general"));
    expect(catalog.names).toEqual(["general-analysis", "general-hero"]);
    const hero = await catalog.load("general-hero");
    const url = "https://airlock-fixtures.example.com/regional-sales.html";
    const supervisor = supervisorFor({ pages: { [url]: HERO_PAGES[HERO_URL]! } });
    const h = await makeGeneralHarness(fixture, supervisor, () => createScriptedDriver(hero.turns, { name: hero.name }));
    try {
      const done = await run(h, { egressAllow: ["airlock-fixtures.example.com"], scriptedDriver: "general-hero" });
      expect(done.outcome).toBe("RESULT_VERIFIED");
      const write = supervisor.toolCalls.find((t) => t.args.kind === "write")!.args as { content: string };
      expect(write.content).toContain("NOT model-written");
      const models = (await h.events(done.id)).filter((e) => e.kind === "model");
      expect(models.every((e) => e.data?.model === "scripted:general-hero")).toBe(true);
    } finally {
      await h.close();
    }
  });
});

describe("general tasks: browser semantics", () => {
  test("a stale ref is fed back as an observation and the model can recover", async () => {
    const supervisor = supervisorFor();
    const driver = recordingDriver([
      { toolCalls: [{ name: "browser_navigate", args: { url: HERO_URL } }] },
      { toolCalls: [{ name: "browser_click", args: { ref: "e1", generation: 0 } }] },
      { toolCalls: [{ name: "browser_observe", args: {} }] },
      (input) => {
        const last = JSON.parse(input.messages.at(-1)!.content) as { generation: number };
        return { toolCalls: [{ name: "browser_click", args: { ref: "e1", generation: last.generation } }] };
      },
      { toolCalls: [{ name: "submit_result", args: { summary: "clicked", outputs: [], sources: [] } }] },
    ]);
    const h = await makeGeneralHarness(fixture, supervisor, driver, { profiles: { "web-research": {} } });
    try {
      const done = await run(h, { profileId: "web-research", egressAllow: [HERO_HOST] });
      const messages = toolMessages(driver);
      expect(messages[1]).toContain("stale_reference");
      expect(messages[1]).toContain("browser_observe");
      expect(JSON.parse(messages[3]!)).toMatchObject({ invalidated: false, url: HERO_URL });
      const events = await h.events(done.id);
      expect(events.some((e) => e.title === "browser_click stale_reference" && e.data?.opState === "failed")).toBe(true);
      // No screenshot and no source: the web-research checks fail, nothing produced.
      expect(done.outcome).toBe("RESULT_FAILED");
      expect(done.cleanup?.status).toBe("confirmed");
    } finally {
      await h.close();
    }
  });

  test("an interrupted browser op is never replayed: the session is closed, counted, and the next tool starts a fresh one", async () => {
    let clicks = 0;
    const supervisor = supervisorFor({
      browserOp: (attempt, request): BrowserOpResult | undefined => {
        if (request.op !== "click") return undefined;
        clicks += 1;
        return { response: null, status: "interrupted", durationMs: 50, generationBefore: attempt.browser!.generation };
      },
    });
    const driver = recordingDriver([
      { toolCalls: [{ name: "browser_navigate", args: { url: HERO_URL } }] },
      { toolCalls: [{ name: "browser_observe", args: {} }] },
      (input) => ({ toolCalls: [{ name: "browser_click", args: { ref: "e1", generation: (JSON.parse(input.messages.at(-1)!.content) as { generation: number }).generation } }] }),
      { toolCalls: [{ name: "browser_navigate", args: { url: HERO_URL } }] },
      { toolCalls: [{ name: "browser_screenshot", args: {} }] },
      { toolCalls: [{ name: "submit_result", args: { summary: "done", outputs: [], sources: [HERO_URL] } }] },
    ]);
    const h = await makeGeneralHarness(fixture, supervisor, driver);
    try {
      const done = await run(h, { profileId: "web-research", egressAllow: [HERO_HOST] });
      expect(clicks).toBe(1);
      expect(supervisor.browserRequests.filter((r) => r.request.op === "click")).toHaveLength(1);
      const browsers = supervisor.operations.filter((o) => o.kind === "createAttempt");
      expect(browsers).toHaveLength(2);
      expect(supervisor.destroyed).toContain(browsers[0]!.attemptId!);
      const messages = toolMessages(driver);
      expect(messages[2]).toContain("browser_session_lost");
      expect(messages[2]).toContain("NOT replayed");
      const usage = await h.store.get<GeneralUsage>(OWNER, STORE_KIND_GENERAL_USAGE, done.id);
      expect(usage).toMatchObject({ browserInterruptions: 1, browserSessions: 2 });
      const events = await h.events(done.id);
      expect(events.some((e) => e.title === "browser_click outcome unknown" && e.data?.opState === "unknown")).toBe(true);
      expect(done.outcome).toBe("RESULT_VERIFIED");
      expect(done.cleanup?.status).toBe("confirmed");
    } finally {
      await h.close();
    }
  });

  test("navigation outside egressAllow is refused by the controller before any dispatch", async () => {
    const supervisor = supervisorFor();
    const driver = recordingDriver([
      { toolCalls: [{ name: "browser_navigate", args: { url: "https://evil.example.net/x" } }] },
      { toolCalls: [{ name: "submit_result", args: { summary: "nothing", outputs: [], sources: [] } }] },
    ]);
    const h = await makeGeneralHarness(fixture, supervisor, driver);
    try {
      const done = await run(h, { profileId: "web-research", egressAllow: [HERO_HOST] });
      expect(toolMessages(driver)[0]).toContain("not an allowed destination");
      expect(supervisor.operations.filter((o) => o.kind === "createAttempt")).toHaveLength(0);
      expect(done.cleanup?.status).toBe("none");
    } finally {
      await h.close();
    }
  });

  test("a cited source the browser never reached fails sources-visited (RESULT_PARTIAL with a screenshot)", async () => {
    const supervisor = supervisorFor();
    const other = `https://${HERO_HOST}/never-opened.html`;
    const driver = recordingDriver([
      { toolCalls: [{ name: "browser_navigate", args: { url: HERO_URL } }] },
      { toolCalls: [{ name: "browser_screenshot", args: {} }] },
      { toolCalls: [{ name: "submit_result", args: { summary: "x", outputs: [], sources: [HERO_URL, other] } }] },
    ]);
    const h = await makeGeneralHarness(fixture, supervisor, driver);
    try {
      const done = await run(h, { profileId: "web-research", egressAllow: [HERO_HOST] });
      expect(done.outcome).toBe("RESULT_PARTIAL");
      const visited = done.result!.checks.find((c) => c.name === "sources-visited")!;
      expect(visited.passed).toBe(false);
      expect(visited.detail).toContain(other);
    } finally {
      await h.close();
    }
  });
});

describe("general tasks: outcomes", () => {
  test("a claimed output that was never written gives RESULT_PARTIAL; a rejected one is reported", async () => {
    const supervisor = supervisorFor({
      exec: async (_c, _f, _s, attempt) => {
        attempt!.files.set("outputs/summary.json", JSON.stringify({ answer: "3 rows" }));
        attempt!.files.set("outputs/evil.svg", "<svg/>");
        return okExec();
      },
      collectRejected: () => [{ path: "evil.svg", reason: "extension .svg is not allowed" }],
    });
    const driver = recordingDriver([
      { toolCalls: [{ name: "code_write", args: { path: "code/a.py", content: "print(1)" } }] },
      { toolCalls: [{ name: "code_run", args: { language: "python", file: "code/a.py" } }] },
      { toolCalls: [{ name: "submit_result", args: { summary: "x", outputs: ["outputs/summary.json", "outputs/chart.png", "outputs/evil.svg"], sources: [] } }] },
    ]);
    const h = await makeGeneralHarness(fixture, supervisor, driver);
    try {
      const done = await run(h, { profileId: "analysis" });
      expect(done.outcome).toBe("RESULT_PARTIAL");
      const checks = Object.fromEntries(done.result!.checks.map((c) => [c.name, c]));
      expect(checks["output:summary.json"]!.passed).toBe(true);
      expect(checks["output:chart.png"]!.passed).toBe(false);
      expect(checks["output:chart.png"]!.detail).toContain("not found");
      expect(checks["output:evil.svg"]!.detail).toContain("rejected by the collector");
      expect(checks["outputs-valid"]!.passed).toBe(false);
      expect(done.result!.outputArtifactIds).toHaveLength(1);
    } finally {
      await h.close();
    }
  });

  test("uploaded inputs are put under inputs/ before code runs, digests checked", async () => {
    const supervisor = supervisorFor({
      exec: async (_c, _f, _s, attempt) => {
        const csv = attempt!.files.get("inputs/data.csv") ?? "";
        attempt!.files.set("outputs/summary.json", JSON.stringify({ answer: `${csv.trim().split("\n").length - 1} rows` }));
        attempt!.files.set("outputs/copy.csv", csv);
        return okExec();
      },
    });
    const driver = recordingDriver([
      { toolCalls: [{ name: "files_list", args: {} }] },
      { toolCalls: [{ name: "code_write", args: { path: "code/a.py", content: "print(1)" } }] },
      { toolCalls: [{ name: "code_run", args: { language: "python", file: "code/a.py" } }] },
      { toolCalls: [{ name: "submit_result", args: { summary: "x", outputs: ["outputs/summary.json", "outputs/copy.csv"], sources: [] } }] },
    ]);
    const h = await makeGeneralHarness(fixture, supervisor, driver);
    try {
      const upload = await h.artifacts.ingestUpload(OWNER, "data.csv", new TextEncoder().encode("a,b\n1,2\n3,4\n"));
      const done = await run(h, { profileId: "analysis", inputArtifactIds: [upload.id] });
      expect(done.outcome).toBe("RESULT_VERIFIED");
      const put = supervisor.toolCalls.find((t) => t.args.kind === "put")!;
      expect(put.args).toMatchObject({ kind: "put", path: "inputs/data.csv" });
      expect(JSON.parse(toolMessages(driver)[0]!)).toMatchObject({ inputs: [{ path: "inputs/data.csv", bytes: 12, mediaType: "text/csv" }], sandbox: "not started" });
    } finally {
      await h.close();
    }
  });

  test("a tool outside the profile is refused as an observation; declaring the capability missing gives UNSUPPORTED", async () => {
    const supervisor = supervisorFor();
    const driver = recordingDriver([
      { toolCalls: [{ name: "browser_navigate", args: { url: HERO_URL } }] },
      { toolCalls: [{ name: "submit_result", args: { summary: "I need a browser.", outputs: [], sources: [], unsupported_capability: "web browsing is not available in the analysis profile" } }] },
    ]);
    const h = await makeGeneralHarness(fixture, supervisor, driver);
    try {
      const done = await run(h, { profileId: "analysis" });
      expect(toolMessages(driver)[0]).toContain("not available in the analysis profile");
      expect(supervisor.operations).toHaveLength(0);
      expect(done.outcome).toBe("UNSUPPORTED");
      expect(done.result!.checks[0]).toMatchObject({ name: "capability", passed: false });
      const events = await h.events(done.id);
      expect(events.some((e) => e.data?.unavailable === true && e.data?.opState === "failed")).toBe(true);
    } finally {
      await h.close();
    }
  });

  test("budgets: the model-call limit ends STOPPED_LIMIT and tears the sandbox down", async () => {
    const supervisor = supervisorFor();
    const driver = recordingDriver(Array.from({ length: 10 }, () => ({ toolCalls: [{ name: "browser_observe", args: {} }] })));
    const h = await makeGeneralHarness(fixture, supervisor, driver, { profiles: { "web-research": { budgets: { modelCalls: 3 } } } });
    try {
      const done = await run(h, { profileId: "web-research", egressAllow: [HERO_HOST] });
      expect(done.outcome).toBe("STOPPED_LIMIT");
      expect(done.budget.modelCallsUsed).toBe(3);
      expect(driver.inputs).toHaveLength(3);
      expect(done.cleanup?.status).toBe("confirmed");
      expect(supervisor.attempts.size).toBe(0);
    } finally {
      await h.close();
    }
  });

  test("budgets: an exhausted code-run budget is an observation, and a repeated identical failure ends the run", async () => {
    const supervisor = supervisorFor();
    const driver = recordingDriver(Array.from({ length: 10 }, () => ({ toolCalls: [{ name: "code_run", args: { language: "python", file: "code/a.py" } }] })));
    const h = await makeGeneralHarness(fixture, supervisor, driver, { profiles: { analysis: { budgets: { codeRuns: 1 } } } });
    try {
      const done = await run(h, { profileId: "analysis" });
      expect(done.outcome).toBe("STOPPED_LIMIT");
      expect(supervisor.toolCalls.filter((t) => t.args.kind === "exec")).toHaveLength(1);
      expect(toolMessages(driver)[1]).toContain("code run budget exhausted");
      expect(driver.inputs).toHaveLength(1 + MAX_IDENTICAL_FAILURES);
      const end = (await h.events(done.id)).find((e) => e.title === "Outcome STOPPED_LIMIT")!;
      expect(end.detail).toContain("repeated identical failure");
    } finally {
      await h.close();
    }
  });
});

describe("general tasks: cancellation and cleanup", () => {
  test("cancel tears down both attempts; cleanup is confirmed only after both teardowns are clean", async () => {
    let failBrowserDestroy = true;
    const supervisor = supervisorFor({ destroyFails: (a) => a.role === "browser" && failBrowserDestroy });
    let release: () => void = () => undefined;
    const blocked = new Promise<void>((r) => (release = r));
    const driver = recordingDriver(
      [
        { toolCalls: [{ name: "browser_navigate", args: { url: HERO_URL } }] },
        { toolCalls: [{ name: "code_write", args: { path: "code/a.py", content: "print(1)" } }] },
        { toolCalls: [{ name: "browser_observe", args: {} }] },
      ],
      { before: async (call) => (call === 3 ? blocked : undefined) },
    );
    const h = await makeGeneralHarness(fixture, supervisor, driver, { cancelRetryDelayMs: 30, cancelRetries: 20 });
    try {
      const task = await h.newTask({ egressAllow: [HERO_HOST] });
      h.worker.start();
      await h.waitUntil(() => driver.inputs.length >= 3);
      expect(supervisor.attempts.size).toBe(2);
      const running = (await h.store.get<Task>(OWNER, "tasks", task.id))!;
      expect(running.cleanup?.status).toBe("pending");
      await h.store.compareAndSwap(OWNER, "tasks", task.id, { status: "running" }, { status: "cancelling" });
      h.worker.abort(task.id);
      release();
      await h.waitUntil(async () => ((await h.store.get<Task>(OWNER, "tasks", task.id))?.cleanup?.status ?? "") === "retrying");
      const midway = (await h.store.get<Task>(OWNER, "tasks", task.id))!;
      expect(midway.status).toBe("cancelling");
      const rows = (await h.store.scanWhere<TaskAttemptRow>(STORE_KIND_TASK_ATTEMPTS, { taskId: task.id })).map((r) => r.value);
      expect(rows.find((r) => r.role === "analysis")!.state).toBe("destroyed");
      expect(rows.find((r) => r.role === "browser")!.state).toBe("teardown-failed");
      failBrowserDestroy = false;
      const done = await h.waitFor(task.id);
      expect(done.status).toBe("cancelled");
      expect(done.cleanup?.status).toBe("confirmed");
      expect(supervisor.attempts.size).toBe(0);
      expect(done.attemptId).toBeUndefined();
    } finally {
      release();
      await h.close();
    }
  });

  test("a recovered task (earlier run's usage on record) discards earlier attempts, counts the recovery and tells the model", async () => {
    const supervisor = supervisorFor();
    const driver = recordingDriver([{ toolCalls: [{ name: "submit_result", args: { summary: "x", outputs: [], sources: [] } }] }]);
    const h = await makeGeneralHarness(fixture, supervisor, driver);
    try {
      const task = await h.newTask({ profileId: "web-research", egressAllow: [HERO_HOST] });
      // An earlier run left a live browser attempt row (the sandbox itself is gone from the host).
      await h.store.put(OWNER, STORE_KIND_TASK_ATTEMPTS, { id: "att-old", taskId: task.id, role: "browser", generation: 1, state: "live", createdAt: new Date().toISOString() } satisfies TaskAttemptRow);
      await h.store.put(OWNER, STORE_KIND_GENERAL_USAGE, { id: task.id, taskId: task.id, startedAtMs: Date.now(), browserOps: 0, codeRuns: 0, browserSessions: 1, browserInterruptions: 0, codeSandboxes: 0, unavailableToolCalls: 0 } satisfies GeneralUsage);
      h.worker.start();
      const done = await h.waitFor(task.id);
      expect(done.budget.recoveries).toBe(1);
      expect(driver.inputs[0]!.messages[0]!.content).toContain("earlier run of this task was interrupted");
      const rows = (await h.store.scanWhere<TaskAttemptRow>(STORE_KIND_TASK_ATTEMPTS, { taskId: task.id })).map((r) => r.value);
      expect(rows[0]!.state).toBe("destroyed");
      expect(done.cleanup?.status).toBe("confirmed");
    } finally {
      await h.close();
    }
  });
});

describe("general tasks: vision", () => {
  const turns: Turn[] = [
    { toolCalls: [{ name: "browser_navigate", args: { url: HERO_URL } }] },
    { toolCalls: [{ name: "browser_screenshot", args: {} }] },
    { toolCalls: [{ name: "submit_result", args: { summary: "x", outputs: [], sources: [HERO_URL] } }] },
  ];
  test("with vision enabled the screenshot is attached to the next turn and recorded on the model event", async () => {
    const supervisor = supervisorFor();
    const driver = recordingDriver(turns);
    const h = await makeGeneralHarness(fixture, supervisor, driver, { vision: true });
    try {
      const done = await run(h, { profileId: "web-research", egressAllow: [HERO_HOST] });
      const third = driver.inputs[2]!.messages;
      const withImage = third.filter((m) => m.images?.length);
      expect(withImage).toHaveLength(1);
      expect(withImage[0]!.role).toBe("user");
      expect(withImage[0]!.images![0]!.mediaType).toBe("image/png");
      expect(inspectPng(new Uint8Array(Buffer.from(withImage[0]!.images![0]!.base64, "base64"))).ok).toBe(true);
      const shot = (await h.artifacts.listForTask(OWNER, done)).find((a) => a.kind === "screenshot")!;
      const models = (await h.events(done.id)).filter((e) => e.kind === "model");
      expect(models[2]!.data).toMatchObject({ imageAttached: true, imageArtifactId: shot.id, imageSha256: shot.sha256 });
      expect(models[0]!.data?.imageAttached).toBe(false);
    } finally {
      await h.close();
    }
  });
  test("with vision disabled no image is ever sent", async () => {
    const supervisor = supervisorFor();
    const driver = recordingDriver(turns);
    const h = await makeGeneralHarness(fixture, supervisor, driver, { vision: false });
    try {
      const done = await run(h, { profileId: "web-research", egressAllow: [HERO_HOST] });
      expect(driver.inputs.flatMap((i) => i.messages).some((m) => m.images?.length)).toBe(false);
      expect(JSON.parse(toolMessages(driver)[1]!)).toMatchObject({ imageAttached: false });
      expect((await h.events(done.id)).filter((e) => e.kind === "model").every((e) => e.data?.imageAttached === false)).toBe(true);
    } finally {
      await h.close();
    }
  });
});

describe("dispatch at the worker seam", () => {
  test("a repair task still runs the RepairHandler next to general tasks", async () => {
    const supervisor = supervisorFor();
    const driver = recordingDriver([{ text: "I cannot fix it." }]);
    const h = await makeGeneralHarness(fixture, supervisor, driver);
    try {
      const task = await h.newTask({ kind: undefined, profileId: fixture.profile.manifest.id, issueText: "compute(0) raises" });
      h.worker.start();
      const done = await h.waitFor(task.id);
      expect(done.status).toBe("done");
      expect(done.outcome).toBe("REPRODUCED_UNRESOLVED");
      expect(supervisor.operations.find((o) => o.kind === "createAttempt")).toBeDefined();
      expect(done.cleanup?.status).toBe("confirmed");
    } finally {
      await h.close();
    }
  });
});
