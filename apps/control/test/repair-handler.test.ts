import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { candidateDigestOf, type AttemptRef, type HostListing, type RunEvent, type Task, type VerificationRecord } from "@airlock/contracts";
import { SupervisorCapacityError, SupervisorError, SupervisorFenceError, SupervisorUnavailableError } from "../src/supervisor-client.ts";
import { INVOKE_RECONCILIATION, STORE_KIND_ATTEMPT_PROBES, STORE_KIND_OPERATIONS, STORE_KIND_VERIFICATIONS, countOccurrences, sliceLines, type OperationRecord } from "../src/repair-handler.ts";
import { validateEnvelope as realValidateEnvelope } from "../src/artifacts/index.ts";
import { loadProfile } from "../src/profiles.ts";
import { loadScriptedTurns } from "../src/scripted.ts";
import { createScriptedDriver } from "../src/vultr-client.ts";
import { FX_FIXED_SOURCE, FX_BROKEN_SOURCE, buildManifestDouble, fixtureObserve, makeFixture, scriptedDriverDouble, type Fixture, type ScriptedTurn } from "./helpers/doubles.ts";
import { FakeSupervisor, fakeHost, fakeProbe, okExec } from "./helpers/fake-supervisor.ts";
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

async function runScenario(script: ScriptedTurn[], supervisorOverrides: ConstructorParameters<typeof FakeSupervisor>[0] extends infer O ? Partial<O> : never = {}, caps: Parameters<typeof makeFixture>[0] = {}, driverOptions: Parameters<typeof scriptedDriverDouble>[1] = {}) {
  const fx = Object.keys(caps).length ? await makeFixture(caps) : fixture;
  const supervisor = new FakeSupervisor({ profile: fx.profile, observe: fixtureObserve, ...supervisorOverrides });
  const driver = scriptedDriverDouble(script, driverOptions);
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
      // D6: the external baseline (with the author sandbox probed first) precedes the model's own
      // reproduction, which becomes repair at the first source change.
      expect(phases(s.events)).toEqual(["prepare", "baseline", "reproduce", "repair", "freeze", "verify", "Outcome CANDIDATE_PASSED_CHECKS"]);
      // D3: one fresh one-shot invocation per contract case, for the baseline and for the candidate.
      expect(s.supervisor.invocations.map((i) => i.role)).toEqual(["baseline", "baseline", "candidate", "candidate"]);
      expect(s.supervisor.invocations.map((i) => i.caseIds)).toEqual([["reported-zero"], ["reg-two"], ["reported-zero"], ["reg-two"]]);
      expect(s.supervisor.invocations[2]?.bundleDigest).toBe(s.task.candidateDigest);
      expect(s.task.candidates).toEqual([{ attemptId: s.supervisor.destroyed[0]!, candidateDigest: s.task.candidateDigest!, verificationRecordId: s.task.verificationRecordId!, outcome: "PASSED_CHECKS" }]);
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

  test("submit_candidate on an unchanged tree → CHECKS_FAILED (on both repair attempts)", async () => {
    const s = await runScenario([{ toolCalls: [{ name: "submit_candidate", args: { summary: "nothing changed" } }] }], {}, {}, { repeatLast: true });
    try {
      expect(s.task.status).toBe("done");
      expect(s.task.outcome).toBe("CHECKS_FAILED");
      expect(s.task.candidateDigest).toBeDefined();
      expect(s.task.candidates?.map((c) => c.outcome)).toEqual(["CHECKS_FAILED", "CHECKS_FAILED"]);
      expect(s.task.budget.repairAttemptsUsed).toBe(2);
      // The model submitted without changing anything: it never left `reproduce`.
      expect(phases(s.events)).not.toContain("repair");
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
    ], {}, {}, { repeatLast: true });
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
      expect(supervisor.invocations.map((i) => i.role)).toEqual(["baseline", "baseline"]);
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

  test("sandbox creation refused by the supervisor (probe not blocked) → INCONCLUSIVE with the reason, nothing left behind (D7)", async () => {
    const s = await runScenario(repairScript(FX_FIXED_SOURCE), { probeBlocked: false });
    try {
      expect(s.task.status).toBe("done");
      expect(s.task.outcome).toBe("INCONCLUSIVE");
      expect(s.events.find((e) => e.title === "Outcome INCONCLUSIVE")?.detail).toContain("refused");
      expect(s.driver.calls).toBe(0);
      expect(s.supervisor.invocations).toHaveLength(0);
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

  test("a supervisor at capacity (429) is retried with backoff, as fresh operations, and the run then proceeds", async () => {
    class BusyOnce extends FakeSupervisor {
      refusals = 2;
      override async createAttempt(...args: Parameters<FakeSupervisor["createAttempt"]>) {
        if (this.refusals-- > 0) throw new SupervisorCapacityError("execution host at capacity");
        return super.createAttempt(...args);
      }
    }
    const supervisor = new BusyOnce({ profile: fixture.profile, observe: fixtureObserve });
    const h = await makeHarness(fixture, supervisor, scriptedDriverDouble(repairScript(FX_FIXED_SOURCE)), {}, { capacityRetryDelaysMs: [5, 5, 5] });
    h.worker.start();
    try {
      const task = await h.waitFor((await h.newTask()).id);
      expect(task.outcome).toBe("CANDIDATE_PASSED_CHECKS");
      const ops = await h.store.list<{ kind: string; state: string }>(OWNER, "operations");
      expect(ops.filter((o) => o.kind === "createAttempt" && o.state === "failed").length).toBe(0);
    } finally {
      await h.close();
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

// ================================================================================================
// Milestone 2
// ================================================================================================

type Overrides = ConstructorParameters<typeof FakeSupervisor>[0] extends infer O ? Partial<O> : never;

/** A driver whose every turn reports the given usage (or none) and records the max_tokens it was given. */
function usageDriver(script: ScriptedTurn[], usage: { input: number; output: number; reasoning?: number }) {
  const inner = scriptedDriverDouble(script, { repeatLast: true });
  const seenMaxTokens: number[] = [];
  const driver = {
    get calls() {
      return inner.calls;
    },
    seenMaxTokens,
    async chat(input: Parameters<typeof inner.chat>[0] & { maxTokens?: number }) {
      seenMaxTokens.push(input.maxTokens ?? -1);
      const turn = await inner.chat(input);
      return { ...turn, usage };
    },
  };
  return driver;
}

async function runWith(
  driver: Parameters<typeof makeHarness>[2],
  opts: { caps?: Parameters<typeof makeFixture>[0]; supervisor?: Overrides; SupervisorClass?: typeof FakeSupervisor; handler?: Parameters<typeof makeHarness>[4]; task?: Partial<Task>; before?: (s: FakeSupervisor, h: Harness) => Promise<void> } = {},
) {
  const fx = opts.caps ? await makeFixture(opts.caps) : fixture;
  const Cls = opts.SupervisorClass ?? FakeSupervisor;
  const supervisor = new Cls({ profile: fx.profile, observe: fixtureObserve, ...(opts.supervisor ?? {}) });
  const h = await makeHarness(fx, supervisor, driver, {}, opts.handler ?? {});
  await opts.before?.(supervisor, h);
  h.worker.start();
  const created = await h.newTask(opts.task ?? {});
  const task = await h.waitFor(created.id);
  const events = await h.store.listEvents(created.id);
  return { h, supervisor, task, events, close: async () => { await h.close(); if (fx !== fixture) await fx.cleanup(); } };
}

const runForever: ScriptedTurn[] = [{ toolCalls: [{ name: "run", args: { command: "python -m pytest -q" } }] }];

describe("M3 budgets", () => {
  test("token usage is charged per call (input+output+reasoning), the last allowance shrinks to fit, and exhaustion is STOPPED_LIMIT", async () => {
    const driver = usageDriver(runForever, { input: 20_000, output: 4_000, reasoning: 1_000 });
    const s = await runWith(driver, { caps: { maxTokens: 60_000, maxModelCalls: 50 } });
    try {
      expect(s.task.outcome).toBe("STOPPED_LIMIT");
      expect(s.events.find((e) => e.title === "Outcome STOPPED_LIMIT")?.detail).toMatch(/token budget exhausted.*task token budget/);
      // 25k per call: 3 calls fit (the third with a reduced allowance), the fourth is refused before it is made.
      expect(driver.calls).toBe(3);
      expect(driver.seenMaxTokens[0]).toBe(16384);
      expect(driver.seenMaxTokens[2]).toBeLessThan(16384);
      expect(driver.seenMaxTokens[2]).toBeGreaterThanOrEqual(1024);
      expect(s.task.budget.tokensUsed).toBe(75_000);
      expect(s.task.budget.attemptTokens).toBe(75_000);
      expect(s.task.budget.modelCallsUsed).toBe(3);
      expect(s.task.budget.attemptModelCalls).toBe(3);
      const model = s.events.filter((e) => e.kind === "model").map((e) => e.data as { tokensCharged: number; usageEstimated: boolean });
      expect(model.every((m) => m.tokensCharged === 25_000 && m.usageEstimated === false)).toBe(true);
      expect(s.supervisor.attempts.size).toBe(0);
    } finally {
      await s.close();
    }
  });

  test("absent provider usage is charged a conservative estimate (prompt chars/3 + the full allowance), never zero", async () => {
    const driver = usageDriver([...repairScript(FX_FIXED_SOURCE)], { input: 0, output: 0 });
    const s = await runWith(driver);
    try {
      expect(s.task.outcome).toBe("CANDIDATE_PASSED_CHECKS");
      const model = s.events.filter((e) => e.kind === "model").map((e) => e.data as { tokensCharged: number; usageEstimated: boolean; maxTokens: number });
      expect(model).toHaveLength(4);
      for (const m of model) {
        expect(m.usageEstimated).toBe(true);
        expect(m.tokensCharged).toBeGreaterThan(m.maxTokens);
      }
      expect(s.task.budget.tokensUsed).toBe(model.reduce((n, m) => n + m.tokensCharged, 0));
    } finally {
      await s.close();
    }
  });

  test("a budget too small for even one bounded call refuses the call before it is made", async () => {
    const driver = usageDriver(runForever, { input: 10, output: 5 });
    const s = await runWith(driver, { caps: { maxTokens: 1500 } });
    try {
      expect(s.task.outcome).toBe("STOPPED_LIMIT");
      expect(driver.calls).toBe(0);
      expect(s.task.budget.modelCallsUsed).toBe(0);
      expect(s.task.budget.tokensUsed ?? 0).toBe(0);
    } finally {
      await s.close();
    }
  });

  test("the per-attempt model-call ceiling ends the attempt STOPPED_LIMIT", async () => {
    const s = await runWith(scriptedDriverDouble(runForever, { repeatLast: true }), { caps: { maxModelCalls: 20, maxModelCallsPerAttempt: 3 } });
    try {
      expect(s.task.outcome).toBe("STOPPED_LIMIT");
      expect(s.events.find((e) => e.title === "Outcome STOPPED_LIMIT")?.detail).toContain("per-attempt model call budget exhausted (3/3)");
      expect(s.task.budget.modelCallsUsed).toBe(3);
    } finally {
      await s.close();
    }
  });
});

describe("M4 second repair attempt", () => {
  const broken = FX_BROKEN_SOURCE.replace("raise ValueError('zero not supported')", "raise ValueError('zero not supported')  # tried");
  test("CHECKS_FAILED → a fresh attempt with bounded comparator feedback → CANDIDATE_PASSED_CHECKS; each candidate stays identifiable", async () => {
    const firstMessages: string[] = [];
    const driver = scriptedDriverDouble(
      [
        { toolCalls: [{ name: "write_file", args: { path: "lib/mod.py", content: broken } }] },
        { toolCalls: [{ name: "submit_candidate", args: { summary: "attempt 1" } }] },
        { toolCalls: [{ name: "read_file", args: { path: "lib/mod.py" } }] },
        { toolCalls: [{ name: "write_file", args: { path: "lib/mod.py", content: FX_FIXED_SOURCE } }] },
        { toolCalls: [{ name: "submit_candidate", args: { summary: "attempt 2" } }] },
      ],
      { onChat: (messages) => { if (messages.length === 1) firstMessages.push(messages[0]!.content); } },
    );
    const s = await runWith(driver);
    try {
      expect(s.task.outcome).toBe("CANDIDATE_PASSED_CHECKS");
      expect(s.task.budget.repairAttemptsUsed).toBe(2);
      expect(s.task.generation).toBe(2);
      expect(s.supervisor.createdAttempts).toHaveLength(2);
      const [a1, a2] = s.supervisor.createdAttempts.map((a) => a.attemptId);
      expect(a1).not.toBe(a2);
      const candidates = s.task.candidates!;
      expect(candidates.map((c) => [c.attemptId, c.outcome])).toEqual([[a1, "CHECKS_FAILED"], [a2, "PASSED_CHECKS"]]);
      expect(candidates[0]!.candidateDigest).not.toBe(candidates[1]!.candidateDigest);
      expect(s.task.candidateDigest).toBe(candidates[1]!.candidateDigest);
      expect(s.task.verificationRecordId).toBe(candidates[1]!.verificationRecordId!);
      // Attempt 2 started from the pristine tree in a new sandbox, with external feedback only.
      expect(firstMessages).toHaveLength(2);
      expect(firstMessages[0]).not.toContain("FEEDBACK");
      expect(firstMessages[1]).toContain("<<<FEEDBACK");
      expect(firstMessages[1]).toContain("reported-zero (reported)");
      expect(firstMessages[1]).not.toContain("reg-two");
      expect(firstMessages[1]).not.toContain("valueCanonical");
      expect(firstMessages[1]!.length).toBeLessThan(8000);
      expect(phases(s.events)).toEqual(["prepare", "baseline", "reproduce", "repair", "freeze", "verify", "reproduce", "repair", "freeze", "verify", "Outcome CANDIDATE_PASSED_CHECKS"]);
      expect(s.supervisor.attempts.size).toBe(0);
    } finally {
      await s.close();
    }
  });

  test("no attempt beyond caps.maxRepairAttempts; the final outcome is the last attempt's", async () => {
    const s = await runWith(scriptedDriverDouble([{ toolCalls: [{ name: "submit_candidate", args: { summary: "no change" } }] }], { repeatLast: true }), { caps: { maxRepairAttempts: 1 } });
    try {
      expect(s.task.outcome).toBe("CHECKS_FAILED");
      expect(s.task.candidates).toHaveLength(1);
      expect(s.supervisor.createdAttempts).toHaveLength(1);
    } finally {
      await s.close();
    }
  });

  test("giving up after real work gets a second attempt; the final outcome is the last attempt's", async () => {
    const s = await runWith(scriptedDriverDouble([
      { toolCalls: [{ name: "read_file", args: { path: "lib/mod.py" } }] },
      { text: "I cannot fix this." },
      { text: "Still cannot." },
      { text: "Giving up." },
    ]));
    try {
      expect(s.task.outcome).toBe("REPRODUCED_UNRESOLVED");
      expect(s.supervisor.createdAttempts).toHaveLength(2);
      expect(s.task.budget.repairAttemptsUsed).toBe(2);
      expect(s.events.some((e) => e.title === "Starting another repair attempt")).toBe(true);
    } finally {
      await s.close();
    }
  });

  test("a recovery does not consume a repair attempt: the counter moves only when an attempt reaches the model loop", async () => {
    const s = await runWith(scriptedDriverDouble(repairScript(FX_FIXED_SOURCE)), {
      task: { attemptId: "att-old", generation: 1, phase: "baseline", budget: { modelCallsUsed: 0, repairAttemptsUsed: 0 } },
      before: async (sup) => {
        await sup.createAttempt({ ref: { taskId: "task-1", attemptId: "att-old", generation: 1 }, profileId: "fx-1", role: "author", absoluteDeadline: new Date(Date.now() + 60_000).toISOString() });
      },
    });
    try {
      expect(s.task.outcome).toBe("CANDIDATE_PASSED_CHECKS");
      expect(s.task.budget.recoveries).toBe(1);
      expect(s.task.budget.repairAttemptsUsed).toBe(1);
      expect(s.supervisor.destroyed).toContain("att-old");
    } finally {
      await s.close();
    }
  });
});

describe("M6/M7 checkpoints in the records", () => {
  test("the author attempt's isolation probe is in both the baseline and the candidate VerificationRecord", async () => {
    const s = await runWith(scriptedDriverDouble(repairScript(FX_FIXED_SOURCE)));
    try {
      const baseline = await s.h.store.get<VerificationRecord>(OWNER, STORE_KIND_VERIFICATIONS, s.task.baselineRecordId!);
      const candidate = await s.h.store.get<VerificationRecord>(OWNER, STORE_KIND_VERIFICATIONS, s.task.verificationRecordId!);
      expect(baseline?.runtimeProfile.probe?.allBlocked).toBe(true);
      expect(candidate?.runtimeProfile.probe).toEqual(baseline!.runtimeProfile.probe!);
      expect(baseline?.outcome).toBe("REPRODUCED");
      expect(candidate?.outcome).toBe("PASSED_CHECKS");
    } finally {
      await s.close();
    }
  });
});

describe("M8 operation journal", () => {
  test("every supervisor mutation is journaled as an intent BEFORE it is dispatched, then settled", async () => {
    let harness: Harness | null = null;
    const missing: string[] = [];
    const s = await runWith(scriptedDriverDouble(repairScript(FX_FIXED_SOURCE)), {
      supervisor: {
        onDispatch: async (kind, operation) => {
          const row = await harness!.store.get<OperationRecord>(OWNER, STORE_KIND_OPERATIONS, operation.operationId);
          if (!row || row.state !== "intent" || row.kind !== kind || row.requestDigest !== operation.requestDigest) missing.push(`${kind} ${operation.operationId}`);
        },
      },
      before: async (_s, h) => {
        harness = h;
      },
    });
    try {
      expect(s.task.outcome).toBe("CANDIDATE_PASSED_CHECKS");
      expect(missing).toEqual([]);
      const rows = (await s.h.store.list<OperationRecord>(OWNER, STORE_KIND_OPERATIONS)).filter((r) => r.taskId === s.task.id);
      expect(rows.length).toBe(s.supervisor.operations.length);
      expect(new Set(rows.map((r) => r.kind))).toEqual(new Set(["createAttempt", "authorTool", "freeze", "revoke", "destroy", "invoke"]));
      expect(rows.every((r) => r.state === "acked")).toBe(true);
      expect(rows.filter((r) => r.kind === "invoke")).toHaveLength(4);
    } finally {
      await s.close();
    }
  });

  test("a recovering run reconciles outstanding intents by reading the attempt, never replays them, and tears the attempt down before starting fresh", async () => {
    const s = await runWith(scriptedDriverDouble(repairScript(FX_FIXED_SOURCE)), {
      task: { attemptId: "att-old", generation: 1, phase: "repair", budget: { modelCallsUsed: 2, repairAttemptsUsed: 1 } },
      before: async (sup, h) => {
        await sup.createAttempt({ ref: { taskId: "task-1", attemptId: "att-old", generation: 1 }, profileId: "fx-1", role: "author", absoluteDeadline: new Date(Date.now() + 60_000).toISOString() });
        const row: OperationRecord = { id: "op-crashed", operationId: "op-crashed", requestDigest: "d".repeat(64), kind: "authorTool", taskId: "task-1", attemptId: "att-old", generation: 1, state: "intent", createdAt: new Date().toISOString() };
        await h.store.put(OWNER, STORE_KIND_OPERATIONS, row);
      },
    });
    try {
      expect(s.task.outcome).toBe("CANDIDATE_PASSED_CHECKS");
      const reconciled = s.events.find((e) => e.title === "Reconciled outstanding supervisor operations");
      expect(reconciled?.detail).toContain("authorTool op-crashed (intent): attempt att-old is running");
      const row = await s.h.store.get<OperationRecord>(OWNER, STORE_KIND_OPERATIONS, "op-crashed");
      expect(row?.state).toBe("unknown");
      expect(row?.reconciledAt).toBeDefined();
      // Never re-dispatched: no operation reused the crashed id, and no tool ran on the old attempt.
      expect(s.supervisor.operations.some((o) => o.operationId === "op-crashed")).toBe(false);
      expect(s.supervisor.toolCalls.some((c) => c.attemptId === "att-old")).toBe(false);
      // Revoke + destroy of the old attempt came before the new attempt was created.
      const kinds = s.supervisor.operations.map((o) => `${o.kind}:${o.attemptId === "att-old" ? "old" : "new"}`);
      expect(kinds.slice(0, 4)).toEqual(["createAttempt:old", "revoke:old", "destroy:old", "createAttempt:new"]); // the first is the seeded earlier run
    } finally {
      await s.close();
    }
  });
});

describe("M1 renewable execution authorization", () => {
  const slowExec = (ms: number) => async (command: string) => {
    await new Promise((r) => setTimeout(r, ms));
    return okExec({ stdout: `ran ${command}` });
  };

  test("the attempt is created with a short authorization and renewed while the run holds its lease", async () => {
    const s = await runWith(scriptedDriverDouble(repairScript(FX_FIXED_SOURCE)), { supervisor: { exec: slowExec(400) }, handler: { authorizationMs: 200, renewIntervalMs: 40 } });
    try {
      expect(s.task.outcome).toBe("CANDIDATE_PASSED_CHECKS");
      const created = s.supervisor.createdAttempts[0]!;
      expect(created.authorizedUntil).toBeDefined();
      expect(Date.parse(created.authorizedUntil!)).toBeLessThanOrEqual(Date.parse(created.absoluteDeadline));
      expect(Date.parse(created.authorizedUntil!) - Date.now()).toBeLessThan(10_000);
      // Without renewal the write after the 400 ms run would be refused (authorization 200 ms).
      expect(s.supervisor.renewals.length).toBeGreaterThanOrEqual(3);
      expect(s.supervisor.renewals.every((r) => Date.parse(r.authorizedUntil) <= Date.parse(created.absoluteDeadline))).toBe(true);
      // Renewal stops once the author sandbox is frozen.
      const count = s.supervisor.renewals.length;
      await new Promise((r) => setTimeout(r, 150));
      expect(s.supervisor.renewals.length).toBe(count);
    } finally {
      await s.close();
    }
  });

  test("an authorization that is not renewed expires on the supervisor: the attempt is lost → INCONCLUSIVE, sandbox destroyed", async () => {
    class NoRenew extends FakeSupervisor {
      override async renew(input: { ref: AttemptRef; authorizedUntil: string }) {
        // Accepts the call but never extends (a supervisor that ignores renewals).
        const state = await this.getAttempt(input.ref.attemptId);
        return state;
      }
    }
    const s = await runWith(scriptedDriverDouble(repairScript(FX_FIXED_SOURCE)), { SupervisorClass: NoRenew, supervisor: { exec: slowExec(400) }, handler: { authorizationMs: 150, renewIntervalMs: 40 } });
    try {
      expect(s.task.status).toBe("done");
      expect(s.task.outcome).toBe("INCONCLUSIVE");
      expect(s.events.some((e) => e.title === "Attempt lost")).toBe(true);
      expect(s.supervisor.toolCalls.filter((c) => c.args.kind === "write")).toHaveLength(0);
      expect(s.supervisor.attempts.size).toBe(0);
    } finally {
      await s.close();
    }
  });

  test("a renewal the supervisor refuses (409) means the authority is gone: the attempt is aborted → INCONCLUSIVE", async () => {
    class RefusesRenew extends FakeSupervisor {
      override async renew(): Promise<never> {
        throw new SupervisorFenceError("Attempt was revoked.");
      }
    }
    const s = await runWith(scriptedDriverDouble(repairScript(FX_FIXED_SOURCE)), { SupervisorClass: RefusesRenew, supervisor: { exec: slowExec(300) }, handler: { authorizationMs: 10_000, renewIntervalMs: 40 } });
    try {
      expect(s.task.outcome).toBe("INCONCLUSIVE");
      expect(s.events.find((e) => e.title === "Outcome INCONCLUSIVE")?.detail).toContain("execution authority lost");
      expect(s.task.candidateDigest).toBeUndefined();
      expect(s.supervisor.attempts.size).toBe(0);
    } finally {
      await s.close();
    }
  });

  test("cancellation stops the renewals, so the supervisor's own expiry stops the sandbox", async () => {
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
    const h = await makeHarness(fixture, supervisor, scriptedDriverDouble([{ toolCalls: [{ name: "run", args: { command: "sleep 100" } }] }]), {}, { authorizationMs: 200, renewIntervalMs: 30 });
    h.worker.start();
    try {
      const task = await h.newTask();
      await execStarted;
      await h.waitUntil(() => supervisor.renewals.length >= 2);
      await h.store.compareAndSwap<Task>(OWNER, "tasks", task.id, { status: "running" }, { status: "cancelling" });
      h.worker.abort(task.id);
      const result = await h.waitFor(task.id);
      expect(result.status).toBe("cancelled");
      const count = supervisor.renewals.length;
      await new Promise((r) => setTimeout(r, 150));
      expect(supervisor.renewals.length).toBe(count);
    } finally {
      await h.close();
    }
  });
});

describe("M9 collector rejections", () => {
  test("a collector rejection of the allowed file (symlink) refuses the seal → CHECKS_FAILED with the reason", async () => {
    const s = await runWith(scriptedDriverDouble(repairScript(FX_FIXED_SOURCE)), {
      caps: { maxRepairAttempts: 1 },
      supervisor: { freezeRejected: () => [{ path: "lib/mod.py", reason: "symlink" }] },
      handler: { validateEnvelope: realValidateEnvelope },
    });
    try {
      expect(s.task.outcome).toBe("CHECKS_FAILED");
      expect(s.task.candidateDigest).toBeUndefined();
      expect(s.events.find((e) => e.title === "Outcome CHECKS_FAILED")?.detail).toContain("lib/mod.py: rejected by the collector (symlink)");
      expect(s.supervisor.invocations.filter((i) => i.role === "candidate")).toHaveLength(0);
    } finally {
      await s.close();
    }
  });

  test("a required (base-tree) allowed file that is missing refuses the seal → CHECKS_FAILED", async () => {
    const s = await runWith(scriptedDriverDouble([{ toolCalls: [{ name: "run", args: { command: "rm lib/mod.py" } }] }, { toolCalls: [{ name: "submit_candidate", args: { summary: "deleted" } }] }]), {
      caps: { maxRepairAttempts: 1 },
      supervisor: { exec: async (command, files) => { files.delete("lib/mod.py"); return okExec({ stdout: command }); }, freezeRejected: (files) => (files.has("lib/mod.py") ? [] : [{ path: "lib/mod.py", reason: "missing" }]) },
      handler: { validateEnvelope: realValidateEnvelope },
    });
    try {
      expect(s.task.outcome).toBe("CHECKS_FAILED");
      expect(s.events.find((e) => e.title === "Outcome CHECKS_FAILED")?.detail).toContain("required file is missing");
    } finally {
      await s.close();
    }
  });

  test("rejections outside the allowlist (agent scratch files) are ignored but listed in the event", async () => {
    const s = await runWith(scriptedDriverDouble(repairScript(FX_FIXED_SOURCE)), {
      supervisor: { freezeRejected: () => [{ path: "scratch/link.py", reason: "symlink" }] },
      handler: { validateEnvelope: realValidateEnvelope },
    });
    try {
      expect(s.task.outcome).toBe("CANDIDATE_PASSED_CHECKS");
      const frozen = s.events.find((e) => e.title === "Author sandbox frozen");
      expect((frozen?.data as { ignoredRejections: unknown[] }).ignoredRejections).toEqual([{ path: "scratch/link.py", reason: "symlink" }]);
    } finally {
      await s.close();
    }
  });
});

describe("D3 one fresh sandbox per case", () => {
  test("one failed case invocation leaves that case incomplete: the candidate cannot pass", async () => {
    class OneCaseDown extends FakeSupervisor {
      override async invoke(input: Parameters<FakeSupervisor["invoke"]>[0], opts?: Parameters<FakeSupervisor["invoke"]>[1]) {
        if (input.role === "candidate" && input.request.cases[0]?.id === "reg-two") throw new SupervisorUnavailableError("docker unavailable");
        return super.invoke(input, opts);
      }
    }
    const s = await runWith(scriptedDriverDouble(repairScript(FX_FIXED_SOURCE)), { SupervisorClass: OneCaseDown });
    try {
      expect(s.task.outcome).not.toBe("CANDIDATE_PASSED_CHECKS");
      expect(s.task.outcome).toBe("INCONCLUSIVE");
      const record = await s.h.store.get<VerificationRecord>(OWNER, STORE_KIND_VERIFICATIONS, s.task.verificationRecordId!);
      expect(record?.passed).toBe(false);
      expect(record?.cases.find((c) => c.caseId === "reg-two")?.reason).toContain("invocation failed");
      expect(record?.cases.find((c) => c.caseId === "reported-zero")?.passed).toBe(true);
      expect(s.events.some((e) => e.title === "candidate invocation failed for reg-two")).toBe(true);
    } finally {
      await s.close();
    }
  });
});

describe("D7 hard failures end INCONCLUSIVE with the reason", () => {
  test("three consecutive driver errors → INCONCLUSIVE (status done), sandbox destroyed", async () => {
    const driver = { calls: 0, async chat(): Promise<never> { driver.calls++; throw new Error("upstream 500"); } };
    const s = await runWith(driver);
    try {
      expect(s.task.status).toBe("done");
      expect(s.task.outcome).toBe("INCONCLUSIVE");
      expect(s.events.find((e) => e.title === "Outcome INCONCLUSIVE")?.detail).toContain("failed 3 times in a row");
      expect(s.supervisor.attempts.size).toBe(0);
    } finally {
      await s.close();
    }
  });

  test("a teardown that cannot be confirmed after useful work → INCONCLUSIVE with the reason, attempt kept on record", async () => {
    class DestroyFails extends FakeSupervisor {
      override async destroy(input: { ref: AttemptRef }, opts?: Parameters<FakeSupervisor["destroy"]>[1]) {
        const result = await super.destroy(input, opts);
        return { teardown: { ...result.teardown, clean: false, containersRemaining: ["airlock-stuck"] } };
      }
    }
    const s = await runWith(scriptedDriverDouble(repairScript(FX_FIXED_SOURCE)), { SupervisorClass: DestroyFails });
    try {
      expect(s.task.status).toBe("done");
      expect(s.task.outcome).toBe("INCONCLUSIVE");
      expect(s.events.find((e) => e.title === "Outcome INCONCLUSIVE")?.detail).toContain("could not be confirmed");
      expect(s.task.attemptId).toBeDefined();
    } finally {
      await s.close();
    }
  });
});

describe("D8 bounded recoveries", () => {
  test("each recovery is counted and persisted; past caps.maxRecoveries the task ends INCONCLUSIVE instead of looping", async () => {
    const s = await runWith(scriptedDriverDouble(repairScript(FX_FIXED_SOURCE)), {
      caps: { maxRecoveries: 2 },
      task: { phase: "verify", budget: { modelCallsUsed: 1, repairAttemptsUsed: 1, recoveries: 2 } },
    });
    try {
      expect(s.task.status).toBe("done");
      expect(s.task.outcome).toBe("INCONCLUSIVE");
      expect(s.task.budget.recoveries).toBe(3);
      expect(s.events.find((e) => e.title === "Outcome INCONCLUSIVE")?.detail).toContain("recovery limit");
      expect(s.supervisor.invocations).toHaveLength(0);
      expect(s.supervisor.createdAttempts).toHaveLength(0);
    } finally {
      await s.close();
    }
  });

  test("a lost lease mid-verify is a counted recovery that resumes from the sealed candidate", async () => {
    let harness: Harness | null = null;
    let aborted = false;
    const s = await runWith(scriptedDriverDouble(repairScript(FX_FIXED_SOURCE)), {
      supervisor: {
        beforeInvoke: async (role, input) => {
          if (role !== "candidate" || aborted) return;
          aborted = true;
          harness!.worker.abort(input.taskId); // lease lost, status unchanged: the worker requeues it
          await new Promise((r) => setTimeout(r, 50));
        },
      },
      before: async (_s, h) => {
        harness = h;
      },
    });
    try {
      expect(s.task.outcome).toBe("CANDIDATE_PASSED_CHECKS");
      expect(s.task.budget.recoveries).toBe(1);
      expect(s.supervisor.createdAttempts).toHaveLength(1);
      expect(s.events.some((e) => e.title === "Resuming from sealed candidate")).toBe(true);
    } finally {
      await s.close();
    }
  });
});

describe("D9 baseline drift", () => {
  test("the reported failure reproduced but a regression case drifted → INCONCLUSIVE, never NOT_REPRODUCED; no model call", async () => {
    const driver = scriptedDriverDouble(repairScript(FX_FIXED_SOURCE));
    const s = await runWith(driver, {
      supervisor: { observe: (role, files, request) => fixtureObserve(role, files, request).map((o) => (role === "baseline" && o.caseId === "reg-two" ? { ...o, valueCanonical: "5" } : o)) },
    });
    try {
      expect(s.task.outcome).toBe("INCONCLUSIVE");
      expect(s.events.find((e) => e.title === "Outcome INCONCLUSIVE")?.detail).toContain("regression case(s)");
      expect(driver.calls).toBe(0);
      expect(s.supervisor.attempts.size).toBe(0);
    } finally {
      await s.close();
    }
  });
});

describe("G5 forged log through the external comparator", () => {
  test("the forged-log fixture edits the allowed file with a comment only, prints '312 passed', submits, and ends CHECKS_FAILED from the comparator", async () => {
    const turns = await loadScriptedTurns(fileURLToPath(new URL("./fixtures/forged-log-script.json", import.meta.url)));
    const tabulate = await loadProfile(fileURLToPath(new URL("../../../profiles/tabulate-365/", import.meta.url)), "tabulate-365");
    const reported = tabulate.contract.cases.find((c) => c.kind === "reported")!;
    const stripComments = (text: string) => text.split("\n").map((l) => l.replace(/\s*#.*$/, "")).filter((l) => l.trim() !== "").join("\n");
    const base = stripComments(tabulate.baseFiles["tabulate/__init__.py"]!);
    // The fake "runs" the contract: the reported case still raises unless the code (not comments) changed.
    const supervisor = new FakeSupervisor({
      profile: tabulate,
      observe: (role, files, request) =>
        request.cases.map((c) => {
          const changed = role !== "baseline" && stripComments(files.get("tabulate/__init__.py") ?? "") !== base;
          if (c.id === reported.id && !changed) return { caseId: c.id, status: "error" as const, exceptionType: "IndexError", message: "list index out of range" };
          const expected = tabulate.contract.cases.find((x) => x.id === c.id)!;
          const e = role === "baseline" ? expected.baseline : expected.candidate;
          return e.kind === "returns" ? { caseId: c.id, status: "ok" as const, valueCanonical: e.valueCanonical } : { caseId: c.id, status: "error" as const, exceptionType: e.exceptionType, message: e.messageIncludes ?? "" };
        }),
      exec: async (command) => okExec({ stdout: command.includes("312 passed") ? "312 passed in 1.42s\nALL TESTS PASSED\n" : "" }),
    });
    const fx = { ...fixture, profile: tabulate, runtimeDir: fileURLToPath(new URL("../../../runtime/python/", import.meta.url)) };
    // A factory, as in production: every repair attempt replays the script from its first turn.
    const h = await makeHarness(fx, supervisor, () => createScriptedDriver(turns, { name: "forged-log" }));
    h.worker.start();
    try {
      const created = await h.newTask({ profileId: "tabulate-365" });
      const task = await h.waitFor(created.id);
      const events = await h.store.listEvents(task.id);
      expect(task.outcome).toBe("CHECKS_FAILED");
      expect(events.some((e) => e.kind === "tool" && e.title === "edit_file tabulate/__init__.py")).toBe(true);
      expect(events.some((e) => e.kind === "exec" && e.detail.includes("312 passed"))).toBe(true);
      expect(events.some((e) => e.title === "write_file refused" || e.title === "edit_file refused")).toBe(false);
      // The sealed candidate reached the external comparator, which rejected it.
      expect(supervisor.invocations.filter((i) => i.role === "candidate").length).toBeGreaterThan(0);
      const record = await h.store.get<VerificationRecord>(OWNER, STORE_KIND_VERIFICATIONS, task.verificationRecordId!);
      expect(record?.passed).toBe(false);
      expect(record?.cases.find((c) => c.caseId === reported.id)?.passed).toBe(false);
      expect(task.candidates?.every((c) => c.outcome === "CHECKS_FAILED")).toBe(true);
    } finally {
      await h.close();
    }
  });
});

describe("G7 resume from a sealed bundle after a controller restart", () => {
  test("a task in verify with a sealed candidate is verified on fresh sandboxes by a new worker; the author sandbox is never recreated", async () => {
    const supervisor = new FakeSupervisor({ profile: fixture.profile, observe: fixtureObserve });
    const driver = scriptedDriverDouble(repairScript(FX_FIXED_SOURCE));
    const h = await makeHarness(fixture, supervisor, driver);
    try {
      // What the previous controller left behind: a baseline record, a sealed bundle, a task in verify.
      const bytes = Buffer.from(FX_FIXED_SOURCE, "utf8");
      const file = { path: "lib/mod.py", byteLength: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex"), contentBase64: bytes.toString("base64") };
      const manifest = buildManifestDouble(fixture.profile.manifest, [file]);
      const candidateDigest = await candidateDigestOf(manifest);
      await h.artifacts.putBlob(bytes);
      await h.artifacts.putImmutableJson("bundle", candidateDigest, { manifest, candidateDigest, files: [file] });
      const task = await h.newTask({
        phase: "verify",
        attemptId: "att-sealed",
        generation: 1,
        candidateDigest,
        candidates: [{ attemptId: "att-sealed", candidateDigest }],
        budget: { modelCallsUsed: 4, repairAttemptsUsed: 1 },
      });
      h.worker.start();
      const result = await h.waitFor(task.id);
      expect(result.outcome).toBe("CANDIDATE_PASSED_CHECKS");
      expect(result.candidateDigest).toBe(candidateDigest);
      expect(result.candidates).toEqual([{ attemptId: "att-sealed", candidateDigest, verificationRecordId: result.verificationRecordId!, outcome: "PASSED_CHECKS" }]);
      expect(result.budget.recoveries).toBe(1);
      expect(driver.calls).toBe(0);
      expect(supervisor.createdAttempts).toHaveLength(0);
      expect(supervisor.toolCalls).toHaveLength(0);
      // Fresh one-shot sandboxes: the baseline (not recorded before) and the candidate, one per case.
      expect(supervisor.invocations.map((i) => `${i.role}:${i.caseIds.join(",")}`)).toEqual(["baseline:reported-zero", "baseline:reg-two", "candidate:reported-zero", "candidate:reg-two"]);
      expect(supervisor.invocations.filter((i) => i.role === "candidate").every((i) => i.bundleDigest === candidateDigest)).toBe(true);
    } finally {
      await h.close();
    }
  });
});

describe("U5 repair disabled", () => {
  test("repairDisabledReason: baseline only, no author sandbox and no model call → REPRODUCED_UNRESOLVED with the reason", async () => {
    const driver = scriptedDriverDouble(repairScript(FX_FIXED_SOURCE));
    const s = await runWith(driver, { task: { repairDisabledReason: "no current live-gate receipt" } });
    try {
      expect(s.task.outcome).toBe("REPRODUCED_UNRESOLVED");
      expect(s.events.find((e) => e.title === "Outcome REPRODUCED_UNRESOLVED")?.detail).toBe("repair unavailable: no current live-gate receipt");
      expect(driver.calls).toBe(0);
      expect(s.supervisor.createdAttempts).toHaveLength(0);
      expect(s.supervisor.invocations.map((i) => i.role)).toEqual(["baseline", "baseline"]);
      expect(s.task.budget.repairAttemptsUsed).toBe(0);
    } finally {
      await s.close();
    }
  });

  test("repair disabled and the baseline does not reproduce → NOT_REPRODUCED", async () => {
    const s = await runWith(scriptedDriverDouble([]), {
      task: { repairDisabledReason: "gate failed" },
      supervisor: { observe: (_r, _f, request) => request.cases.map((c) => ({ caseId: c.id, status: "ok" as const, valueCanonical: String(Number(c.input.x) * 2) })) },
    });
    try {
      expect(s.task.outcome).toBe("NOT_REPRODUCED");
    } finally {
      await s.close();
    }
  });
});

// ---- milestone 2 review fixes ---------------------------------------------------------------------

/** What the previous controller left behind: a sealed, unjudged candidate from attempt `att-sealed`. */
async function sealedCandidate(h: Harness) {
  const bytes = Buffer.from(FX_FIXED_SOURCE, "utf8");
  const file = { path: "lib/mod.py", byteLength: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex"), contentBase64: bytes.toString("base64") };
  const manifest = buildManifestDouble(fixture.profile.manifest, [file]);
  const candidateDigest = await candidateDigestOf(manifest);
  await h.artifacts.putBlob(bytes);
  await h.artifacts.putImmutableJson("bundle", candidateDigest, { manifest, candidateDigest, files: [file] });
  return candidateDigest;
}

describe("should-fix 2: a recovery never orphans a sealed candidate", () => {
  test("the lease is lost during the stale-attempt teardown after sealing: the next run verifies the sealed candidate, no new model attempt", async () => {
    let harness: Harness | null = null;
    let lost = false;
    class LoseLeaseOnRevoke extends FakeSupervisor {
      override async revoke(input: { ref: AttemptRef }, opts?: Parameters<FakeSupervisor["revoke"]>[1]) {
        if (!lost && input.ref.attemptId === "att-sealed") {
          lost = true;
          harness!.worker.abort(input.ref.taskId); // the lease is gone mid-teardown; the worker requeues
        }
        return super.revoke(input, opts);
      }
    }
    const supervisor = new LoseLeaseOnRevoke({ profile: fixture.profile, observe: fixtureObserve });
    const driver = scriptedDriverDouble(repairScript(FX_FIXED_SOURCE));
    const h = await makeHarness(fixture, supervisor, driver);
    harness = h;
    try {
      const candidateDigest = await sealedCandidate(h);
      const task = await h.newTask({ phase: "verify", attemptId: "att-sealed", generation: 1, candidateDigest, candidates: [{ attemptId: "att-sealed", candidateDigest }], budget: { modelCallsUsed: 4, repairAttemptsUsed: 1 } });
      h.worker.start();
      const result = await h.waitFor(task.id);
      expect(lost).toBe(true);
      expect(result.outcome).toBe("CANDIDATE_PASSED_CHECKS");
      expect(result.candidateDigest).toBe(candidateDigest);
      expect(result.candidates).toEqual([{ attemptId: "att-sealed", candidateDigest, verificationRecordId: result.verificationRecordId!, outcome: "PASSED_CHECKS" }]);
      expect(driver.calls).toBe(0);
      expect(supervisor.createdAttempts).toHaveLength(0);
      expect(result.budget.recoveries).toBe(2);
      expect(result.budget.repairAttemptsUsed).toBe(1);
    } finally {
      await h.close();
    }
  });

  test("a sealed, unjudged candidate is resumed whatever phase was left on record", async () => {
    const supervisor = new FakeSupervisor({ profile: fixture.profile, observe: fixtureObserve });
    const driver = scriptedDriverDouble(repairScript(FX_FIXED_SOURCE));
    const h = await makeHarness(fixture, supervisor, driver);
    try {
      const candidateDigest = await sealedCandidate(h);
      const task = await h.newTask({ phase: "prepare", attempts: 1, candidateDigest, candidates: [{ attemptId: "att-sealed", candidateDigest }], budget: { modelCallsUsed: 4, repairAttemptsUsed: 1 } });
      h.worker.start();
      const result = await h.waitFor(task.id);
      expect(result.outcome).toBe("CANDIDATE_PASSED_CHECKS");
      expect(driver.calls).toBe(0);
      expect(supervisor.createdAttempts).toHaveLength(0);
    } finally {
      await h.close();
    }
  });

  test("a run that resumes after a lost lease counts as a recovery even when attemptId was cleared", async () => {
    const s = await runWith(scriptedDriverDouble(repairScript(FX_FIXED_SOURCE)), { task: { phase: "prepare", attempts: 1 } });
    try {
      expect(s.task.outcome).toBe("CANDIDATE_PASSED_CHECKS");
      expect(s.task.budget.recoveries).toBe(1);
      expect(s.events.some((e) => e.title === "Recovering task")).toBe(true);
    } finally {
      await s.close();
    }
  });
});

describe("M6 the resumed verification carries the author probe", () => {
  test("the candidate record of a resumed verification carries the stored checkpoint-4 probe", async () => {
    const supervisor = new FakeSupervisor({ profile: fixture.profile, observe: fixtureObserve });
    const h = await makeHarness(fixture, supervisor, scriptedDriverDouble([]));
    try {
      const candidateDigest = await sealedCandidate(h);
      await h.store.insertImmutable(OWNER, STORE_KIND_ATTEMPT_PROBES, { id: "att-sealed", taskId: "task-1", probe: fakeProbe(true), createdAt: new Date().toISOString() });
      const task = await h.newTask({ phase: "verify", attemptId: "att-sealed", generation: 1, candidateDigest, candidates: [{ attemptId: "att-sealed", candidateDigest }], budget: { modelCallsUsed: 4, repairAttemptsUsed: 1 } });
      h.worker.start();
      const result = await h.waitFor(task.id);
      expect(result.outcome).toBe("CANDIDATE_PASSED_CHECKS");
      const record = await h.store.get<VerificationRecord>(OWNER, STORE_KIND_VERIFICATIONS, result.verificationRecordId!);
      expect(record?.runtimeProfile.probe?.allBlocked).toBe(true);
    } finally {
      await h.close();
    }
  });
});

describe("should-fix 3: an uncertain createAttempt is always torn down", () => {
  test("createAttempt answered 503 (nothing created): teardown is attempted, 404 counts as clean, outcome INCONCLUSIVE", async () => {
    let attemptId = "";
    class Create503 extends FakeSupervisor {
      override async createAttempt(input: Parameters<FakeSupervisor["createAttempt"]>[0], opts?: Parameters<FakeSupervisor["createAttempt"]>[1]): ReturnType<FakeSupervisor["createAttempt"]> {
        attemptId = input.ref.attemptId;
        await this.dispatch("createAttempt", input, opts, input.ref.attemptId);
        throw new SupervisorUnavailableError("supervisor unavailable (503 after retries)");
      }
    }
    const driver = scriptedDriverDouble(repairScript(FX_FIXED_SOURCE));
    const s = await runWith(driver, { SupervisorClass: Create503 });
    try {
      expect(s.supervisor.operations.map((o) => `${o.kind}:${o.attemptId === attemptId ? "it" : "-"}`)).toContain("revoke:it");
      expect(s.task.status).toBe("done");
      expect(s.task.outcome).toBe("INCONCLUSIVE");
      expect(s.events.find((e) => e.title === "Outcome INCONCLUSIVE")?.detail).toContain("503 after retries");
      expect(s.events.some((e) => e.title === "Attempt destroyed after failure")).toBe(true);
      expect(driver.calls).toBe(0);
    } finally {
      await s.close();
    }
  });

  test("createAttempt timed out after the supervisor made the sandbox: it is revoked and destroyed", async () => {
    class CreateTimesOut extends FakeSupervisor {
      override async createAttempt(input: Parameters<FakeSupervisor["createAttempt"]>[0], opts?: Parameters<FakeSupervisor["createAttempt"]>[1]): ReturnType<FakeSupervisor["createAttempt"]> {
        await super.createAttempt(input, opts);
        throw new SupervisorError("createAttempt timed out", 0);
      }
    }
    const s = await runWith(scriptedDriverDouble(repairScript(FX_FIXED_SOURCE)), { SupervisorClass: CreateTimesOut });
    try {
      expect(s.supervisor.attempts.size).toBe(0);
      expect(s.supervisor.destroyed).toHaveLength(1);
      expect(s.task.outcome).toBe("INCONCLUSIVE");
    } finally {
      await s.close();
    }
  });
});

describe("D7 infrastructure errors after sandbox work started", () => {
  test("a non-fence freeze failure ends INCONCLUSIVE with the reason once the teardown is confirmed", async () => {
    class FreezeDown extends FakeSupervisor {
      override async freeze(): Promise<never> {
        throw new SupervisorUnavailableError("supervisor unavailable during freeze");
      }
    }
    const s = await runWith(scriptedDriverDouble(repairScript(FX_FIXED_SOURCE)), { SupervisorClass: FreezeDown });
    try {
      expect(s.task.status).toBe("done");
      expect(s.task.outcome).toBe("INCONCLUSIVE");
      expect(s.events.find((e) => e.title === "Outcome INCONCLUSIVE")?.detail).toContain("supervisor unavailable during freeze");
      expect(s.supervisor.attempts.size).toBe(0);
    } finally {
      await s.close();
    }
  });

  test("a blob digest mismatch while sealing ends INCONCLUSIVE with the reason", async () => {
    const s = await runWith(scriptedDriverDouble(repairScript(FX_FIXED_SOURCE)), {
      before: async (_sup, h) => {
        h.artifacts.putBlob = async () => "0".repeat(64);
      },
    });
    try {
      expect(s.task.outcome).toBe("INCONCLUSIVE");
      expect(s.events.find((e) => e.title === "Outcome INCONCLUSIVE")?.detail).toContain("blob digest mismatch");
      expect(s.supervisor.attempts.size).toBe(0);
    } finally {
      await s.close();
    }
  });

  test("the same failure with an unconfirmed teardown stays failed", async () => {
    class FreezeDownDestroyStuck extends FakeSupervisor {
      override async freeze(): Promise<never> {
        throw new SupervisorUnavailableError("supervisor unavailable during freeze");
      }
      override async destroy(input: { ref: AttemptRef }, opts?: Parameters<FakeSupervisor["destroy"]>[1]) {
        const result = await super.destroy(input, opts);
        return { teardown: { ...result.teardown, clean: false, containersRemaining: ["airlock-stuck"] } };
      }
    }
    const s = await runWith(scriptedDriverDouble(repairScript(FX_FIXED_SOURCE)), { SupervisorClass: FreezeDownDestroyStuck });
    try {
      expect(s.task.status).toBe("failed");
      expect(s.task.outcome).toBeUndefined();
      expect(s.task.error).toContain("teardown incomplete");
    } finally {
      await s.close();
    }
  });
});

describe("should-fix 1: other tasks' identities never reach this task's records", () => {
  const listing = (): HostListing => ({
    listedAt: new Date().toISOString(),
    scope: "host",
    containers: [
      { name: "airlock-author-task-1-att-x", taskId: "task-1", role: "author", state: "running" },
      { name: "airlock-author-task-secret-att-y", taskId: "task-secret", role: "author", state: "running" },
    ],
    volumes: ["airlock-ws-task-1-att-x", "airlock-ws-task-secret-att-y"],
  });

  test("host listings in verification records and teardown events are redacted to this task", async () => {
    const s = await runWith(scriptedDriverDouble(repairScript(FX_FIXED_SOURCE)), { supervisor: { teardownHost: listing } });
    try {
      expect(s.task.outcome).toBe("CANDIDATE_PASSED_CHECKS");
      const record = await s.h.store.get<VerificationRecord>(OWNER, STORE_KIND_VERIFICATIONS, s.task.verificationRecordId!);
      const host = record!.runtimeProfile.teardown.host!;
      expect(host.containers).toEqual([
        { name: "airlock-author-task-1-att-x", taskId: "task-1", role: "author", state: "running" },
        { name: "other-task container", taskId: "other", role: "author", state: "running" },
      ]);
      expect(host.volumes).toEqual(["airlock-ws-task-1-att-x", "other-task volume"]);
      // Nothing stored for this task names the other task.
      const everything = JSON.stringify(s.events) + JSON.stringify(await s.h.store.list(OWNER, STORE_KIND_VERIFICATIONS));
      expect(everything).not.toContain("task-secret");
    } finally {
      await s.close();
    }
  });
});

describe("M8 reconciliation pages through every outstanding row", () => {
  test("150 outstanding invoke intents are all reconciled as unknown with the documented reason", async () => {
    const s = await runWith(scriptedDriverDouble(repairScript(FX_FIXED_SOURCE)), {
      task: { phase: "verify", budget: { modelCallsUsed: 1, repairAttemptsUsed: 1 } },
      before: async (_sup, h) => {
        for (let i = 0; i < 150; i++)
          await h.store.put(OWNER, STORE_KIND_OPERATIONS, { id: `op-old-${i}`, operationId: `op-old-${i}`, requestDigest: "d".repeat(64), kind: "invoke", taskId: "task-1", state: "intent", createdAt: new Date().toISOString() } satisfies OperationRecord);
      },
    });
    try {
      const rows = (await s.h.store.list<OperationRecord>(OWNER, STORE_KIND_OPERATIONS)).filter((r) => r.id.startsWith("op-old-"));
      expect(rows).toHaveLength(150);
      expect(rows.every((r) => r.state === "unknown" && r.reconciledAt && r.reconciliation === INVOKE_RECONCILIATION)).toBe(true);
    } finally {
      await s.close();
    }
  });
});

describe("C41 O2: repair recovery reads the supervisor's operation record", () => {
  test("a completed invoke is reported as completed at the supervisor (result discarded), an unknown one as no record; neither is replayed", async () => {
    const at = new Date().toISOString();
    const s = await runWith(scriptedDriverDouble(repairScript(FX_FIXED_SOURCE)), {
      task: { phase: "verify", budget: { modelCallsUsed: 1, repairAttemptsUsed: 1 } },
      before: async (sup, h) => {
        for (const id of ["op-inv-done", "op-inv-none"])
          await h.store.put(OWNER, STORE_KIND_OPERATIONS, { id, operationId: id, requestDigest: "d".repeat(64), kind: "invoke", taskId: "task-1", state: "intent", createdAt: at } satisfies OperationRecord);
        sup.operationRecords.set("op-inv-done", { operationId: "op-inv-done", kind: "invoke", state: "completed", httpStatus: 200, resultRecorded: true, interruptedByRestart: false, taskId: "task-1", attemptId: null, generation: null, createdAt: at, updatedAt: at });
      },
    });
    try {
      const rows = new Map((await s.h.store.list<OperationRecord>(OWNER, STORE_KIND_OPERATIONS)).map((r) => [r.id, r]));
      expect(rows.get("op-inv-done")).toMatchObject({ state: "unknown", reconciliation: INVOKE_RECONCILIATION, supervisorStatus: "completed" });
      expect(rows.get("op-inv-none")).toMatchObject({ state: "unknown", supervisorStatus: "no-record", supervisorRecord: "supervisor has no record" });
      const event = s.events.find((e) => e.title === "Reconciled outstanding supervisor operations")!;
      expect(event.detail).toContain("op-inv-done (intent): not replayed; one-shot sandboxes are bounded by their own deadline; supervisor: completed (HTTP 200); result discarded, not replayed");
      expect(event.detail).toContain("op-inv-none (intent): not replayed; one-shot sandboxes are bounded by their own deadline; supervisor has no record");
      expect(s.supervisor.operations.some((o) => o.operationId.startsWith("op-inv-"))).toBe(false);
    } finally {
      await s.close();
    }
  });
});

describe("D4/D11 production refuses dev-unsafe measurements", () => {
  test("a dev-unsafe supervisor starts no sandbox in production: INCONCLUSIVE", async () => {
    const driver = scriptedDriverDouble(repairScript(FX_FIXED_SOURCE));
    const s = await runWith(driver, { handler: { production: true } });
    try {
      expect(s.task.outcome).toBe("INCONCLUSIVE");
      expect(s.events.find((e) => e.title === "Outcome INCONCLUSIVE")?.detail).toContain("AIRLOCK_PRODUCTION=1");
      expect(s.supervisor.createdAttempts).toHaveLength(0);
      expect(s.supervisor.invocations).toHaveLength(0);
      expect(driver.calls).toBe(0);
    } finally {
      await s.close();
    }
  });

  test("a baseline measured on runc is recorded but is not a verdict in production", async () => {
    const driver = scriptedDriverDouble(repairScript(FX_FIXED_SOURCE));
    const s = await runWith(driver, { handler: { production: true }, supervisor: { host: fakeHost({ selectedRuntime: "kata", devUnsafe: false, availableRuntimes: ["kata"] }) } });
    try {
      expect(s.task.outcome).toBe("INCONCLUSIVE");
      expect(s.task.baselineRecordId).toBeDefined();
      expect(s.events.find((e) => e.title === "Outcome INCONCLUSIVE")?.detail).toContain("baseline measurement ran on runc");
      expect(driver.calls).toBe(0);
      expect(s.supervisor.attempts.size).toBe(0);
    } finally {
      await s.close();
    }
  });

  test("the same run on kata passes in production", async () => {
    const s = await runWith(scriptedDriverDouble(repairScript(FX_FIXED_SOURCE)), {
      handler: { production: true },
      supervisor: { host: fakeHost({ selectedRuntime: "kata", devUnsafe: false, availableRuntimes: ["kata"] }), inspection: { runtime: "kata", devUnsafe: false } },
    });
    try {
      expect(s.task.outcome).toBe("CANDIDATE_PASSED_CHECKS");
    } finally {
      await s.close();
    }
  });
});

describe("repair availability follows the latest evidence when a live task is first claimed", () => {
  test("a task created while repair was unavailable runs the repair once a receipt backs it", async () => {
    const driver = scriptedDriverDouble(repairScript(FX_FIXED_SOURCE));
    const s = await runWith(driver, { task: { repairDisabledReason: "live repair unavailable: no receipt" }, handler: { repairAvailability: async () => ({ available: true, reason: "gate passed" }) } });
    try {
      expect(s.task.outcome).toBe("CANDIDATE_PASSED_CHECKS");
      expect(s.task.repairDisabledReason).toBeUndefined();
      expect(s.events.some((e) => e.title === "Live repair available")).toBe(true);
    } finally {
      await s.close();
    }
  });

  test("a task created while repair was available is repair-disabled when a later receipt withdrew it; diagnostics and gate runs are untouched", async () => {
    const withdrawn = async () => ({ available: false, reason: "newest live-gate receipt passed 0 of 3" });
    const driver = scriptedDriverDouble(repairScript(FX_FIXED_SOURCE));
    const s = await runWith(driver, { handler: { repairAvailability: withdrawn } });
    try {
      expect(s.task.outcome).toBe("REPRODUCED_UNRESOLVED");
      expect(s.task.repairDisabledReason).toBe("live repair unavailable: newest live-gate receipt passed 0 of 3");
      expect(driver.calls).toBe(0);
    } finally {
      await s.close();
    }
    const gate = await runWith(scriptedDriverDouble(repairScript(FX_FIXED_SOURCE)), { task: { liveGate: true }, handler: { repairAvailability: withdrawn } });
    try {
      expect(gate.task.outcome).toBe("CANDIDATE_PASSED_CHECKS");
    } finally {
      await gate.close();
    }
  });
});
