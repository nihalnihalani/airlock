import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AttemptRef, RunEvent, Task } from "@airlock/contracts";
import { SupervisorFenceError, SupervisorUnavailableError } from "../src/supervisor-client.ts";
import { STORE_KIND_VERIFICATIONS, countOccurrences, sliceLines } from "../src/repair-handler.ts";
import { FX_FIXED_SOURCE, FX_BROKEN_SOURCE, fixtureObserve, makeFixture, scriptedDriverDouble, type Fixture, type ScriptedTurn } from "./helpers/doubles.ts";
import { FakeSupervisor, okExec } from "./helpers/fake-supervisor.ts";
import { makeHarness, OWNER, type Harness } from "./helpers/harness.ts";

let fixture: Fixture;
beforeAll(async () => {
  fixture = await makeFixture();
});
afterAll(async () => {
  await fixture.cleanup();
});

const repairScript = (content: string): ScriptedTurn[] => [
  { toolCalls: [{ name: "read_file", args: { path: "lib/mod.py" } }] },
  { toolCalls: [{ name: "run", args: { command: "python -c 'from lib.mod import compute; compute(0)'" } }] },
  { toolCalls: [{ name: "write_file", args: { path: "lib/mod.py", content } }] },
  { toolCalls: [{ name: "submit_candidate", args: { summary: "handle zero" } }] },
];

async function runScenario(script: ScriptedTurn[], supervisorOverrides: ConstructorParameters<typeof FakeSupervisor>[0] extends infer O ? Partial<O> : never = {}, caps: Parameters<typeof makeFixture>[0] = {}) {
  const fx = Object.keys(caps).length ? await makeFixture(caps) : fixture;
  const supervisor = new FakeSupervisor({ profile: fx.profile, observe: fixtureObserve, ...supervisorOverrides });
  const driver = scriptedDriverDouble(script);
  const h = await makeHarness(fx, supervisor, driver);
  h.worker.start();
  const task = await h.newTask();
  const result = await h.waitFor(task.id);
  const events = await h.store.listEvents(task.id);
  return { h, supervisor, driver, task: result, events, fx, close: async () => { await h.close(); if (fx !== fixture) await fx.cleanup(); } };
}

const phases = (events: RunEvent[]) => events.filter((e) => e.kind === "phase").map((e) => e.title);

describe("repair handler", () => {
  test("happy path: baseline reproduces, model fixes, candidate passes external checks", async () => {
    const s = await runScenario(repairScript(FX_FIXED_SOURCE));
    try {
      expect(s.task.status).toBe("done");
      expect(s.task.phase).toBe("ready");
      expect(s.task.outcome).toBe("CANDIDATE_PASSED_CHECKS");
      expect(s.task.candidateDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(s.task.verificationRecordId).toBeDefined();
      expect(s.task.baselineRecordId).toBeDefined();
      expect(phases(s.events)).toEqual(["prepare", "reproduce", "baseline", "repair", "freeze", "verify", "Outcome CANDIDATE_PASSED_CHECKS"]);
      expect(s.supervisor.invocations.map((i) => i.role)).toEqual(["baseline", "candidate"]);
      expect(s.supervisor.invocations[1]?.bundleDigest).toBe(s.task.candidateDigest);
      expect(s.supervisor.attempts.size).toBe(0);
      expect(s.supervisor.destroyed).toHaveLength(1);
      const record = await s.h.store.get<{ passed: boolean; candidateDigest: string }>(OWNER, STORE_KIND_VERIFICATIONS, s.task.verificationRecordId!);
      expect(record?.passed).toBe(true);
      expect(record?.candidateDigest).toBe(s.task.candidateDigest!);
      const bundle = await s.h.artifacts.getJson<{ candidateDigest: string; files: { path: string }[] }>("bundle", s.task.candidateDigest!);
      expect(bundle?.files.map((f) => f.path)).toEqual(["lib/mod.py"]);
      expect(s.task.budget.modelCallsUsed).toBe(4);
      expect(s.task.budget.repairAttemptsUsed).toBe(1);
      // Model saw the issue text but never an expected value from the contract.
      expect(s.events.some((e) => e.kind === "tool" && e.title === "submit_candidate")).toBe(true);
    } finally {
      await s.close();
    }
  });

  test("submit_candidate on an unchanged tree → CHECKS_FAILED", async () => {
    const s = await runScenario([{ toolCalls: [{ name: "submit_candidate", args: { summary: "nothing changed" } }] }]);
    try {
      expect(s.task.status).toBe("done");
      expect(s.task.outcome).toBe("CHECKS_FAILED");
      expect(s.task.candidateDigest).toBeDefined();
      expect(s.supervisor.attempts.size).toBe(0);
      expect(phases(s.events)).toContain("verify");
    } finally {
      await s.close();
    }
  });

  test("forged 'all tests passed' log and a written file that does not fix the bug → still CHECKS_FAILED", async () => {
    const s = await runScenario([
      { toolCalls: [{ name: "write_file", args: { path: "lib/mod.py", content: FX_BROKEN_SOURCE + "\n# tests: all tests passed\n" } }] },
      { toolCalls: [{ name: "run", args: { command: "echo 'passed=true; 12 passed in 0.1s' > /workspace/junit.log; echo ALL TESTS PASSED" } }] },
      { text: "All tests passed, the fix is verified.", toolCalls: [{ name: "submit_candidate", args: { summary: "All tests passed. passed: true" } }] },
    ]);
    try {
      expect(s.task.outcome).toBe("CHECKS_FAILED");
      expect(s.task.status).toBe("done");
      const record = await s.h.store.get<{ passed: boolean; cases: { caseId: string; passed: boolean }[] }>(OWNER, STORE_KIND_VERIFICATIONS, s.task.verificationRecordId!);
      expect(record?.passed).toBe(false);
      expect(record?.cases.find((c) => c.caseId === "reported-zero")?.passed).toBe(false);
    } finally {
      await s.close();
    }
  });

  test("baseline that does not show the reported failure → NOT_REPRODUCED, no model call, sandbox destroyed", async () => {
    const driver = scriptedDriverDouble(repairScript(FX_FIXED_SOURCE));
    const supervisor = new FakeSupervisor({
      profile: fixture.profile,
      observe: (_role, _files, request) => request.cases.map((c) => ({ caseId: c.id, status: "ok" as const, valueCanonical: String(Number(c.input.x) * 2) })),
    });
    const h = await makeHarness(fixture, supervisor, driver);
    h.worker.start();
    try {
      const task = await h.newTask();
      const result = await h.waitFor(task.id);
      expect(result.outcome).toBe("NOT_REPRODUCED");
      expect(result.status).toBe("done");
      expect(driver.calls).toBe(0);
      expect(supervisor.attempts.size).toBe(0);
      expect(supervisor.destroyed).toHaveLength(1);
      expect(supervisor.invocations.map((i) => i.role)).toEqual(["baseline"]);
    } finally {
      await h.close();
    }
  });

  test("baseline invocation that fails to complete → INCONCLUSIVE", async () => {
    const s = await runScenario(repairScript(FX_FIXED_SOURCE), {
      observe: () => ({ exec: { status: "timed_out", exitCode: null, timedOut: true }, observations: [], protocolErrors: ["no output"] }),
    });
    try {
      expect(s.task.outcome).toBe("INCONCLUSIVE");
      expect(s.supervisor.attempts.size).toBe(0);
    } finally {
      await s.close();
    }
  });

  test("model call budget exhaustion → STOPPED_LIMIT", async () => {
    const script: ScriptedTurn[] = Array.from({ length: 20 }, () => ({ toolCalls: [{ name: "run", args: { command: "python -m pytest -q" } }] }));
    const s = await runScenario(script, {}, { maxModelCalls: 5 });
    try {
      expect(s.task.outcome).toBe("STOPPED_LIMIT");
      expect(s.task.status).toBe("done");
      expect(s.task.budget.modelCallsUsed).toBe(5);
      expect(s.supervisor.attempts.size).toBe(0);
      expect(s.task.candidateDigest).toBeUndefined();
    } finally {
      await s.close();
    }
  });

  test("model gives up without submitting → REPRODUCED_UNRESOLVED", async () => {
    const s = await runScenario([
      { toolCalls: [{ name: "read_file", args: { path: "lib/mod.py" } }] },
      { text: "I cannot fix this." },
      { text: "Still cannot." },
      { text: "Giving up." },
    ]);
    try {
      expect(s.task.outcome).toBe("REPRODUCED_UNRESOLVED");
      expect(s.supervisor.attempts.size).toBe(0);
    } finally {
      await s.close();
    }
  });

  test("a tool call cut off by the output limit gets the cut-off explanation, not a validation error, and the loop continues", async () => {
    const seen: string[] = [];
    const driver = scriptedDriverDouble(
      [
        // max_tokens ran out while the arguments were being written: `command` is missing.
        { finishReason: "length", toolCalls: [{ name: "run", args: {} }] },
        { toolCalls: [{ name: "write_file", args: { path: "lib/mod.py", content: FX_FIXED_SOURCE } }] },
        { toolCalls: [{ name: "submit_candidate", args: { summary: "done" } }] },
      ],
      { onChat: (messages) => { const last = messages[messages.length - 1]; if (last?.role === "tool") seen.push(last.content); } },
    );
    const supervisor = new FakeSupervisor({ profile: fixture.profile, observe: fixtureObserve });
    const h = await makeHarness(fixture, supervisor, driver, {}, { maxTokens: 512 });
    h.worker.start();
    try {
      const task = await h.newTask();
      const result = await h.waitFor(task.id);
      expect(result.outcome).toBe("CANDIDATE_PASSED_CHECKS");
      expect(seen[0]).toContain("cut off by the output limit of 512 tokens");
      expect(seen[0]).toContain("smaller command or edit");
      expect(seen[0]).not.toContain("invalid tool call");
      const events = await h.store.listEvents(task.id);
      expect(events.some((e) => e.kind === "tool" && /cut off by output limit/.test(e.title))).toBe(true);
      // Nothing reached the supervisor for the truncated call.
      expect(supervisor.toolCalls.filter((c) => c.args.kind === "exec")).toHaveLength(0);
    } finally {
      await h.close();
    }
  });

  test("turns cut by the output limit with no action are nudged, not counted as giving up; three in a row → STOPPED_LIMIT", async () => {
    const seenUser: string[] = [];
    const driver = scriptedDriverDouble(
      [
        { toolCalls: [{ name: "read_file", args: { path: "lib/mod.py" } }] },
        { finishReason: "length", reasoning: "thinking...", reasoningTokens: 512 },
        { finishReason: "length", reasoning: "still thinking...", reasoningTokens: 512 },
        { finishReason: "length", reasoning: "and more...", reasoningTokens: 512 },
        { toolCalls: [{ name: "submit_candidate", args: { summary: "never reached" } }] },
      ],
      { onChat: (messages) => { const last = messages[messages.length - 1]; if (last?.role === "user") seenUser.push(last.content); } },
    );
    const supervisor = new FakeSupervisor({ profile: fixture.profile, observe: fixtureObserve });
    const h = await makeHarness(fixture, supervisor, driver);
    h.worker.start();
    try {
      const task = await h.newTask();
      const result = await h.waitFor(task.id);
      expect(result.outcome).toBe("STOPPED_LIMIT");
      expect(result.status).toBe("done");
      expect(result.budget.modelCallsUsed).toBe(4);
      expect(seenUser.filter((m) => m.includes("hit the output limit before any action"))).toHaveLength(2);
      const events = await h.store.listEvents(task.id);
      const outcome = events.find((e) => e.kind === "phase" && e.title === "Outcome STOPPED_LIMIT");
      expect(outcome?.detail).toContain("output limit hit on 3 consecutive turns");
      const cut = events.filter((e) => e.kind === "model" && (e.data as { finishReason?: string })?.finishReason === "length");
      expect(cut).toHaveLength(3);
      expect(cut[0]?.detail).toContain("output limit hit");
      expect(supervisor.attempts.size).toBe(0);
    } finally {
      await h.close();
    }
  });

  test("a text-only turn gets one nudge before the gave-up logic; the reasoning excerpt and finish reason are on the model event", async () => {
    const seenUser: string[] = [];
    const longReasoning = "r".repeat(4000);
    const driver = scriptedDriverDouble(
      [
        { text: "I have applied the fix.", reasoning: longReasoning, reasoningTokens: 900 },
        { toolCalls: [{ name: "write_file", args: { path: "lib/mod.py", content: FX_FIXED_SOURCE } }], reasoning: "short" },
        { toolCalls: [{ name: "submit_candidate", args: { summary: "done" } }] },
      ],
      { onChat: (messages) => { const last = messages[messages.length - 1]; if (last?.role === "user") seenUser.push(last.content); } },
    );
    const supervisor = new FakeSupervisor({ profile: fixture.profile, observe: fixtureObserve });
    const h = await makeHarness(fixture, supervisor, driver);
    h.worker.start();
    try {
      const task = await h.newTask();
      const result = await h.waitFor(task.id);
      expect(result.outcome).toBe("CANDIDATE_PASSED_CHECKS");
      expect(seenUser[1]).toBe("If the fix is applied, call submit_candidate; otherwise continue or say why you cannot fix it.");
      const events = await h.store.listEvents(task.id);
      const model = events.filter((e) => e.kind === "model");
      const first = model[0]?.data as { finishReason: string; reasoning: string; reasoningTruncated: boolean; reasoningTokens: number; maxTokens: number };
      expect(first.finishReason).toBe("stop");
      expect(first.reasoning).toBe("r".repeat(600));
      expect(first.reasoningTruncated).toBe(true);
      expect(first.reasoningTokens).toBe(900);
      expect(first.maxTokens).toBe(16384);
      const second = model[1]?.data as { finishReason: string; reasoning: string; reasoningTruncated: boolean; reasoningTokens?: number };
      expect(second.finishReason).toBe("tool_calls");
      expect(second.reasoning).toBe("short");
      expect(second.reasoningTruncated).toBe(false);
      expect(second.reasoningTokens).toBeUndefined();
    } finally {
      await h.close();
    }
  });

  test("edit_file replaces a unique old_text through the supervisor; not-found, ambiguous and disallowed edits are refused", async () => {
    const seen: string[] = [];
    const driver = scriptedDriverDouble(
      [
        { toolCalls: [{ name: "edit_file", args: { path: "README.md", old_text: "fixture", new_text: "x" } }] },
        { toolCalls: [{ name: "edit_file", args: { path: "lib/mod.py", old_text: "raise RuntimeError('nope')", new_text: "return 0" } }] },
        { toolCalls: [{ name: "edit_file", args: { path: "lib/mod.py", old_text: "    ", new_text: "  " } }] },
        { toolCalls: [{ name: "edit_file", args: { path: "lib/mod.py", old_text: "        raise ValueError('zero not supported')", new_text: "        return 0  # FIXED" } }] },
        { toolCalls: [{ name: "submit_candidate", args: { summary: "edited" } }] },
      ],
      { onChat: (messages) => { const last = messages[messages.length - 1]; if (last?.role === "tool") seen.push(last.content); } },
    );
    const supervisor = new FakeSupervisor({ profile: fixture.profile, observe: fixtureObserve });
    const h = await makeHarness(fixture, supervisor, driver);
    h.worker.start();
    try {
      const task = await h.newTask();
      const result = await h.waitFor(task.id);
      expect(result.outcome).toBe("CANDIDATE_PASSED_CHECKS");
      expect(seen[0]).toContain("may not be changed");
      expect(seen[1]).toContain("old_text not found");
      expect(seen[2]).toContain("old_text is not unique");
      expect(JSON.parse(seen[3]!)).toEqual({ path: "lib/mod.py", replaced: true, byteLength: Buffer.byteLength(FX_FIXED_SOURCE) });
      // The disallowed path never reached the supervisor; the refused edits wrote nothing.
      expect(supervisor.toolCalls.filter((c) => c.args.kind === "write").map((c) => c.args)).toEqual([{ kind: "write", path: "lib/mod.py", content: FX_FIXED_SOURCE }]);
      expect(supervisor.toolCalls.some((c) => c.args.kind !== "exec" && c.args.path === "README.md")).toBe(false);
      const events = await h.store.listEvents(task.id);
      expect(events.filter((e) => e.kind === "tool" && e.title === "edit_file lib/mod.py rejected")).toHaveLength(2);
      expect(events.some((e) => e.kind === "tool" && e.title === "edit_file lib/mod.py" && e.detail.includes("--- old"))).toBe(true);
    } finally {
      await h.close();
    }
  });

  test("read_file returns a line range with the total line count; an oversized read is cut on a line boundary with a paging note", async () => {
    const seen: string[] = [];
    const big = Array.from({ length: 3000 }, (_, i) => `line ${i + 1} ${"x".repeat(20)}`).join("\n") + "\n";
    const driver = scriptedDriverDouble(
      [
        { toolCalls: [{ name: "read_file", args: { path: "lib/mod.py", start_line: 2, end_line: 3 } }] },
        { toolCalls: [{ name: "read_file", args: { path: "lib/mod.py" } }] },
        { toolCalls: [{ name: "read_file", args: { path: "lib/mod.py", start_line: 4, end_line: 2 } }] },
        { toolCalls: [{ name: "write_file", args: { path: "lib/mod.py", content: big } }] },
        { toolCalls: [{ name: "read_file", args: { path: "lib/mod.py" } }] },
        { toolCalls: [{ name: "read_file", args: { path: "lib/mod.py", start_line: 2990 } }] },
        { toolCalls: [{ name: "write_file", args: { path: "lib/mod.py", content: FX_FIXED_SOURCE } }] },
        { toolCalls: [{ name: "submit_candidate", args: { summary: "done" } }] },
      ],
      { onChat: (messages) => { const last = messages[messages.length - 1]; if (last?.role === "tool") seen.push(last.content); } },
    );
    const supervisor = new FakeSupervisor({ profile: fixture.profile, observe: fixtureObserve });
    const h = await makeHarness(fixture, supervisor, driver);
    h.worker.start();
    try {
      const task = await h.newTask();
      const result = await h.waitFor(task.id);
      expect(result.outcome).toBe("CANDIDATE_PASSED_CHECKS");
      expect(JSON.parse(seen[0]!)).toEqual({ path: "lib/mod.py", content: "    if x == 0:\n        raise ValueError('zero not supported')\n", start_line: 2, end_line: 3, total_lines: 4, truncated: false });
      expect(JSON.parse(seen[1]!)).toMatchObject({ content: FX_BROKEN_SOURCE, start_line: 1, end_line: 4, total_lines: 4, truncated: false });
      expect(seen[2]).toContain("end_line must be >= start_line");
      const cut = JSON.parse(seen[4]!) as { content: string; start_line: number; end_line: number; total_lines: number; truncated: boolean; note: string };
      expect(cut.truncated).toBe(true);
      expect(cut.start_line).toBe(1);
      expect(cut.total_lines).toBe(3000);
      expect(cut.end_line).toBeLessThan(3000);
      expect(cut.content.length).toBeLessThanOrEqual(16 * 1024);
      expect(cut.content.endsWith(`line ${cut.end_line} ${"x".repeat(20)}\n`)).toBe(true);
      expect(cut.note).toContain("start_line/end_line");
      expect(seen[4]!.length).toBeLessThanOrEqual(24 * 1024);
      expect(JSON.parse(seen[5]!)).toMatchObject({ start_line: 2990, end_line: 3000, total_lines: 3000, truncated: false });
    } finally {
      await h.close();
    }
  });

  test("tool errors are fed back to the model as results, not fatal", async () => {
    const seen: string[] = [];
    const driver = scriptedDriverDouble(
      [
        { toolCalls: [{ name: "read_file", args: { path: "secrets/../../etc/passwd" } }] },
        { toolCalls: [{ name: "write_file", args: { path: "README.md", content: "x" } }] },
        { toolCalls: [{ name: "bogus_tool", args: {} }] },
        { toolCalls: [{ name: "write_file", args: { path: "lib/mod.py", content: FX_FIXED_SOURCE } }] },
        { toolCalls: [{ name: "submit_candidate", args: { summary: "done" } }] },
      ],
      { onChat: (messages) => { const last = messages[messages.length - 1]; if (last?.role === "tool") seen.push(last.content); } },
    );
    const supervisor = new FakeSupervisor({ profile: fixture.profile, observe: fixtureObserve });
    const h = await makeHarness(fixture, supervisor, driver);
    h.worker.start();
    try {
      const task = await h.newTask();
      const result = await h.waitFor(task.id);
      expect(result.outcome).toBe("CANDIDATE_PASSED_CHECKS");
      expect(seen[0]).toContain("error");
      expect(seen[1]).toContain("may not be changed");
      expect(seen[2]).toContain("invalid tool call");
      // Refused writes never reached the supervisor.
      expect(supervisor.toolCalls.filter((c) => c.args.kind === "write").map((c) => (c.args as { path: string }).path)).toEqual(["lib/mod.py"]);
    } finally {
      await h.close();
    }
  });

  test("cancel mid-repair → cancelled, attempt revoked and destroyed", async () => {
    let releaseExec: (() => void) | null = null;
    const execStarted = new Promise<void>((resolve) => { releaseExec = resolve; });
    const supervisor = new FakeSupervisor({
      profile: fixture.profile,
      observe: fixtureObserve,
      exec: (command, _files, signal) =>
        new Promise((resolve, reject) => {
          releaseExec?.();
          const timer = setTimeout(() => resolve(okExec({ stdout: `ran ${command}` })), 20_000);
          signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("exec aborted")); }, { once: true });
        }),
    });
    const driver = scriptedDriverDouble([{ toolCalls: [{ name: "run", args: { command: "sleep 100" } }] }, ...repairScript(FX_FIXED_SOURCE)]);
    const h = await makeHarness(fixture, supervisor, driver);
    h.worker.start();
    try {
      const task = await h.newTask();
      await execStarted;
      const attemptId = [...supervisor.attempts.keys()][0]!;
      // The API path: running → cancelling, then abort the in-process run.
      const next = await h.store.compareAndSwap<Task>(OWNER, "tasks", task.id, { status: "running" }, { status: "cancelling" });
      expect(next?.status).toBe("cancelling");
      h.worker.abort(task.id);
      const result = await h.waitFor(task.id);
      expect(result.status).toBe("cancelled");
      expect(result.outcome).toBeUndefined();
      expect(supervisor.attempts.size).toBe(0);
      expect(supervisor.destroyed).toContain(attemptId);
      expect(supervisor.revoked).toContain(attemptId);
      const events = await h.store.listEvents(task.id);
      expect(events.some((e) => e.title === "Task cancelled")).toBe(true);
      // The aborted run already destroyed the attempt; the cancel pass's repeat is fenced (409) by the
      // tombstone and must be reported clean because the journal says `destroyed`, never "incomplete".
      expect(events.some((e) => e.title === "Attempt destroyed after cancellation")).toBe(true);
      expect(events.some((e) => /incomplete/i.test(e.title))).toBe(false);
    } finally {
      await h.close();
    }
  });

  /** A FakeSupervisor whose teardown verbs fail while `outage` is set (supervisor restart, VPC blip). */
  class OutageSupervisor extends FakeSupervisor {
    outage = false;
    private unavailable() {
      return new SupervisorUnavailableError("Supervisor call failed after retries (outage)");
    }
    override async revoke(input: { ref: AttemptRef }) {
      if (this.outage) throw this.unavailable();
      return super.revoke(input);
    }
    override async destroy(input: { ref: AttemptRef }) {
      if (this.outage) throw this.unavailable();
      return super.destroy(input);
    }
    override async getAttempt(attemptId: string) {
      if (this.outage) throw this.unavailable();
      return super.getAttempt(attemptId);
    }
  }

  async function cancelDuringOutage(options: { cancelRetries: number }) {
    let releaseExec: (() => void) | null = null;
    const execStarted = new Promise<void>((resolve) => { releaseExec = resolve; });
    const supervisor = new OutageSupervisor({
      profile: fixture.profile,
      observe: fixtureObserve,
      exec: (command, _files, signal) =>
        new Promise((resolve, reject) => {
          releaseExec?.();
          const timer = setTimeout(() => resolve(okExec({ stdout: `ran ${command}` })), 20_000);
          signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("exec aborted")); }, { once: true });
        }),
    });
    const driver = scriptedDriverDouble([{ toolCalls: [{ name: "run", args: { command: "sleep 100" } }] }, ...repairScript(FX_FIXED_SOURCE)]);
    const h = await makeHarness(fixture, supervisor, driver, { leaseMs: 300, cancelRetries: options.cancelRetries, cancelRetryDelayMs: 40 });
    h.worker.start();
    const task = await h.newTask();
    await execStarted;
    const attemptId = [...supervisor.attempts.keys()][0]!;
    supervisor.outage = true;
    const next = await h.store.compareAndSwap<Task>(OWNER, "tasks", task.id, { status: "running" }, { status: "cancelling" });
    expect(next?.status).toBe("cancelling");
    h.worker.abort(task.id);
    return { h, supervisor, task, attemptId };
  }

  test("a lost lease whose teardown cannot be confirmed leaves that on the record, and the attempt is never forgotten", async () => {
    let releaseExec: (() => void) | null = null;
    const execStarted = new Promise<void>((resolve) => { releaseExec = resolve; });
    const supervisor = new OutageSupervisor({
      profile: fixture.profile,
      observe: fixtureObserve,
      exec: (command, _files, signal) =>
        new Promise((resolve, reject) => {
          releaseExec?.();
          const timer = setTimeout(() => resolve(okExec({ stdout: `ran ${command}` })), 20_000);
          signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("exec aborted")); }, { once: true });
        }),
    });
    const driver = scriptedDriverDouble([{ toolCalls: [{ name: "run", args: { command: "sleep 100" } }] }, ...repairScript(FX_FIXED_SOURCE)]);
    const h = await makeHarness(fixture, supervisor, driver);
    h.worker.start();
    try {
      const task = await h.newTask();
      await execStarted;
      const attemptId = [...supervisor.attempts.keys()][0]!;
      supervisor.outage = true;
      // Abort without a status change: the run loses its lease and the task is requeued.
      h.worker.abort(task.id);
      const result = await h.waitFor(task.id);
      const events = await h.store.listEvents(task.id);
      expect(events.some((e) => e.title === "Teardown incomplete after the lease was lost")).toBe(true);
      // The next claim cannot confirm the teardown either, so it fails honestly and keeps the attempt.
      expect(result.status).toBe("failed");
      expect(result.attemptId).toBe(attemptId);
      expect(supervisor.attempts.has(attemptId)).toBe(true);
    } finally {
      await h.close();
    }
  });

  test("cancel while the supervisor is unreachable stays `cancelling` and the teardown is retried until it is confirmed", async () => {
    const { h, supervisor, task, attemptId } = await cancelDuringOutage({ cancelRetries: 50 });
    try {
      // The first cancel pass cannot revoke or destroy: the task must NOT be recorded as terminal.
      await h.waitUntil(async () => (await h.store.listEvents(task.id)).filter((e) => e.title === "Teardown incomplete after cancellation").length >= 2);
      const during = await h.store.get<Task>(OWNER, "tasks", task.id);
      expect(during?.status).toBe("cancelling");
      expect(during?.attemptId).toBe(attemptId);
      expect(supervisor.attempts.has(attemptId)).toBe(true);
      expect(supervisor.destroyed).not.toContain(attemptId);
      // The supervisor comes back: the next pass revokes + destroys and only then records `cancelled`.
      supervisor.outage = false;
      const result = await h.waitFor(task.id);
      expect(result.status).toBe("cancelled");
      expect(supervisor.revoked).toContain(attemptId);
      expect(supervisor.destroyed).toContain(attemptId);
      expect(supervisor.attempts.size).toBe(0);
      const events = await h.store.listEvents(task.id);
      expect(events.some((e) => e.title === "Attempt destroyed after cancellation")).toBe(true);
      expect(events.some((e) => e.title === "Task cancelled")).toBe(true);
    } finally {
      await h.close();
    }
  });

  test("cancel whose teardown never completes ends `failed` (never a `cancelled` receipt) with the attempt still visible", async () => {
    const { h, supervisor, task, attemptId } = await cancelDuringOutage({ cancelRetries: 2 });
    try {
      const result = await h.waitFor(task.id);
      expect(result.status).toBe("failed");
      expect(result.attemptId).toBe(attemptId);
      expect(result.error).toMatch(/teardown/i);
      expect(result.error).toMatch(/incomplete/i);
      expect(supervisor.attempts.has(attemptId)).toBe(true);
      const events = await h.store.listEvents(task.id);
      // one initial pass + 2 retries, each visible
      expect(events.filter((e) => e.title === "Teardown incomplete after cancellation").length).toBe(3);
      expect(events.some((e) => e.title === "Task cancelled")).toBe(false);
    } finally {
      await h.close();
    }
  });

  test("cancel during verify: `cancelled` is recorded only after the one-shot invocation returned, with its teardown on record", async () => {
    let harness: Harness | null = null;
    let invokeFinished = false;
    const supervisor = new FakeSupervisor({
      profile: fixture.profile,
      observe: fixtureObserve,
      beforeInvoke: async (role, input) => {
        if (role !== "candidate") return;
        // The operator cancels while the candidate container is executing on VM B.
        const next = await harness!.store.compareAndSwap<Task>(OWNER, "tasks", input.taskId, { status: "running" }, { status: "cancelling" });
        expect(next?.status).toBe("cancelling");
        harness!.worker.abort(input.taskId);
        await new Promise((r) => setTimeout(r, 400));
        invokeFinished = true;
      },
    });
    const driver = scriptedDriverDouble(repairScript(FX_FIXED_SOURCE));
    const h = await makeHarness(fixture, supervisor, driver, { leaseMs: 300 });
    harness = h;
    h.worker.start();
    try {
      const task = await h.newTask();
      const result = await h.waitFor(task.id);
      expect(result.status).toBe("cancelled");
      // Recorded only once the candidate invocation had actually finished (CLAUDE.md §3.5).
      expect(invokeFinished).toBe(true);
      expect(result.outcome).toBeUndefined();
      expect(result.verificationRecordId).toBeUndefined();
      const events = await h.store.listEvents(task.id);
      const finished = events.find((e) => /candidate invocation finished after cancellation/i.test(e.title));
      expect(finished).toBeDefined();
      expect((finished?.data as { teardown?: { clean: boolean } })?.teardown?.clean).toBe(true);
      expect(events.some((e) => e.title === "Task cancelled")).toBe(true);
      expect(supervisor.attempts.size).toBe(0);
    } finally {
      await h.close();
    }
  });

  test("sandbox creation refused by the supervisor → task failed, nothing left behind", async () => {
    const s = await runScenario(repairScript(FX_FIXED_SOURCE), { probeBlocked: false });
    try {
      expect(s.task.status).toBe("failed");
      expect(s.task.error).toContain("refused");
      expect(s.supervisor.attempts.size).toBe(0);
    } finally {
      await s.close();
    }
  });

  test("freeze without a confirmed stop → INCONCLUSIVE", async () => {
    const s = await runScenario(repairScript(FX_FIXED_SOURCE), { freezeConfirmed: false });
    try {
      expect(s.task.outcome).toBe("INCONCLUSIVE");
      expect(s.task.candidateDigest).toBeUndefined();
      expect(s.supervisor.attempts.size).toBe(0);
    } finally {
      await s.close();
    }
  });

  test("a freeze the supervisor refuses (unsettled operations) → INCONCLUSIVE, nothing sealed, sandbox destroyed", async () => {
    class RefusingFreeze extends FakeSupervisor {
      override async freeze(): Promise<never> {
        throw new SupervisorFenceError("Outstanding operations did not settle; the workspace is uncertain and will not be collected.");
      }
    }
    const supervisor = new RefusingFreeze({ profile: fixture.profile, observe: fixtureObserve });
    const h = await makeHarness(fixture, supervisor, scriptedDriverDouble(repairScript(FX_FIXED_SOURCE)));
    h.worker.start();
    try {
      const task = await h.waitFor((await h.newTask()).id);
      expect(task.status).toBe("done");
      expect(task.outcome).toBe("INCONCLUSIVE");
      expect(task.candidateDigest).toBeUndefined();
      expect(supervisor.attempts.size).toBe(0);
      expect((await h.store.listEvents(task.id)).some((e) => e.title === "Freeze refused by the supervisor")).toBe(true);
    } finally {
      await h.close();
    }
  });

  test("a requeued task discards its stale attempt and STOPPED_LIMIT when repair attempts are exhausted", async () => {
    const supervisor = new FakeSupervisor({ profile: fixture.profile, observe: fixtureObserve });
    const driver = scriptedDriverDouble(repairScript(FX_FIXED_SOURCE));
    const h = await makeHarness(fixture, supervisor, driver);
    // Pretend a previous process created attempt "att-old" and died mid-repair with the budget used up.
    await supervisor.createAttempt({ ref: { taskId: "task-1", attemptId: "att-old", generation: 1 }, profileId: "fx-1", role: "author", absoluteDeadline: new Date(Date.now() + 60_000).toISOString() });
    h.worker.start();
    try {
      const task = await h.newTask({ attemptId: "att-old", generation: 1, phase: "repair", budget: { modelCallsUsed: 3, repairAttemptsUsed: 2 } });
      const result = await h.waitFor(task.id);
      expect(supervisor.destroyed).toContain("att-old");
      expect(result.outcome).toBe("STOPPED_LIMIT");
      expect(supervisor.attempts.size).toBe(0);
    } finally {
      await h.close();
    }
  });

  test("every phase change and tool call is an event with bounded detail", async () => {
    const big = "x".repeat(200_000);
    const s = await runScenario([
      { toolCalls: [{ name: "run", args: { command: `echo ${"y".repeat(3000)}` } }] },
      { text: big, toolCalls: [{ name: "write_file", args: { path: "lib/mod.py", content: FX_FIXED_SOURCE } }] },
      { toolCalls: [{ name: "submit_candidate", args: { summary: "s".repeat(3999) } }] },
    ]);
    try {
      expect(s.task.outcome).toBe("CANDIDATE_PASSED_CHECKS");
      for (const e of s.events) {
        expect(e.detail.length).toBeLessThanOrEqual(65536);
        expect(e.title.length).toBeLessThanOrEqual(256);
      }
      expect(s.events.filter((e) => e.kind === "model")).toHaveLength(3);
      expect(s.events.some((e) => e.kind === "check" && e.title === "Isolation checkpoints")).toBe(true);
      expect(s.events.some((e) => e.kind === "artifact" && e.title === "Candidate sealed")).toBe(true);
    } finally {
      await s.close();
    }
  });
});

describe("edit/read helpers", () => {
  test("countOccurrences counts non-overlapping matches", () => {
    expect(countOccurrences("aaa", "a")).toBe(3);
    expect(countOccurrences("aaaa", "aa")).toBe(2);
    expect(countOccurrences("abc", "d")).toBe(0);
  });
  test("sliceLines clamps ranges, ignores a trailing newline and cuts on a line boundary", () => {
    expect(sliceLines("a\nb\nc\n", undefined, undefined, 100)).toEqual({ content: "a\nb\nc\n", startLine: 1, endLine: 3, totalLines: 3, truncated: false });
    expect(sliceLines("a\nb\nc", 2, 99, 100)).toEqual({ content: "b\nc\n", startLine: 2, endLine: 3, totalLines: 3, truncated: false });
    expect(sliceLines("a\nb\nc\n", 99, undefined, 100)).toEqual({ content: "c\n", startLine: 3, endLine: 3, totalLines: 3, truncated: false });
    expect(sliceLines("aaaa\nbbbb\ncccc\n", 1, 3, 10)).toEqual({ content: "aaaa\nbbbb\n", startLine: 1, endLine: 2, totalLines: 3, truncated: true });
    expect(sliceLines("x".repeat(50), 1, 1, 10)).toEqual({ content: "x".repeat(10) + "\n", startLine: 1, endLine: 1, totalLines: 1, truncated: true });
    expect(sliceLines("", undefined, undefined, 10)).toEqual({ content: "\n", startLine: 1, endLine: 1, totalLines: 1, truncated: false });
  });
});
