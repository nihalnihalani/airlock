import { describe, expect, test } from "bun:test";
import type { RunEvent, Task } from "@airlock/contracts";
import { buildThread, toolNameOf, type ThreadItem } from "../src/lib/thread";
import { OUTCOME_HINT } from "../src/lib/format";

function ev(seq: number, kind: RunEvent["kind"], title: string, detail = "", data?: Record<string, unknown>): RunEvent {
  return {
    id: `ev-${seq}`,
    taskId: "task-1",
    seq,
    at: `2026-01-01T00:00:${String(seq).padStart(2, "0")}.000Z`,
    kind,
    title,
    detail,
    ...(data ? { data } : {}),
  };
}

function task(patch: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    owner: "operator",
    profileId: "tabulate-365",
    issueText: "IndexError with maxheadercolwidths\n\nSteps: ...",
    status: "running",
    phase: "repair",
    generation: 1,
    leaseId: null,
    leaseUntil: null,
    attempts: 1,
    budget: { modelCallsUsed: 2, repairAttemptsUsed: 0 },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:30.000Z",
    ...patch,
  };
}

const execOk = { status: "succeeded", exitCode: 0, stdout: "ok", stderr: "", truncated: false, timedOut: false, durationMs: 40 };
const execFail = { status: "failed", exitCode: 1, stdout: "", stderr: "IndexError", truncated: true, timedOut: false, durationMs: 55 };

function types(items: ThreadItem[]): string[] {
  return items.map((i) => i.type);
}

describe("buildThread", () => {
  const events: RunEvent[] = [
    ev(1, "phase", "prepare", "profile tabulate-365", { host: {} }),
    ev(2, "check", "Isolation checkpoints", "probe all BLOCKED", { probe: { allBlocked: true } }),
    ev(3, "exec", "baseline invocation succeeded", "exit=0", { tool: "baseline", command: "adapter", result: execOk }),
    ev(4, "check", "Baseline reproduces the reported failure", "", { passed: true }),
    ev(5, "phase", "repair", "model loop started"),
    ev(6, "model", "Model turn 1", "Let me reproduce it.", { model: "m", host: "api.vultrinference.com", usage: { input: 100, output: 20 }, toolCalls: [{ name: "run" }, { name: "read_file" }] }),
    ev(7, "exec", "run: python repro.py", "failed exit=1", { tool: "run", command: "python repro.py", result: execFail }),
    ev(8, "tool", "read_file tabulate/__init__.py", "100 chars", { tool: "read_file", path: "tabulate/__init__.py", truncated: true }),
    ev(9, "model", "Model turn 2", "Fixing.", { model: "m", toolCalls: [{ name: "edit_file" }, { name: "write_file" }, { name: "run" }] }),
    ev(10, "tool", "edit_file tabulate/__init__.py rejected", "old_text not found", { tool: "edit_file", path: "tabulate/__init__.py", occurrences: 0 }),
    ev(11, "tool", "write_file refused", "setup.py is not an allowed replacement path"),
    ev(12, "error", "run failed", "supervisor unreachable"),
    ev(13, "tool", "submit_candidate", "Fixed the empty-table case."),
    ev(14, "phase", "freeze", "revoking dispatch"),
    ev(15, "artifact", "Candidate sealed", "candidateDigest abc", { candidateDigest: "abc" }),
    ev(16, "exec", "candidate invocation succeeded", "exit=0", { tool: "candidate", command: "adapter", result: execOk }),
    ev(17, "check", "Candidate passed these checks", "3/3", { passed: true }),
    ev(18, "phase", "Outcome CANDIDATE_PASSED_CHECKS", "all 3 frozen cases passed on the sealed candidate"),
  ];

  test("user issue first, turns with their tools, marks between, result last", () => {
    const items = buildThread(task({ status: "done", phase: "ready", outcome: "CANDIDATE_PASSED_CHECKS" }), events);
    expect(types(items)).toEqual([
      "user",
      "mark", // prepare
      "mark", // isolation checkpoints
      "tool", // baseline invocation (no model turn made it)
      "mark", // baseline reproduces
      "mark", // repair
      "assistant",
      "assistant",
      "mark", // freeze
      "mark", // candidate sealed
      "tool", // candidate invocation
      "mark", // candidate passed
      "result",
    ]);
    const user = items[0];
    expect(user?.type === "user" && user.text).toBe("IndexError with maxheadercolwidths\n\nSteps: ...");
  });

  test("tool calls are grouped under the turn that called them, with their states", () => {
    const items = buildThread(task(), events);
    const turns = items.filter((i): i is Extract<ThreadItem, { type: "assistant" }> => i.type === "assistant");
    expect(turns.length).toBe(2);
    const [first, second] = turns;
    expect(first?.text).toBe("Let me reproduce it.");
    expect(first?.turn.inputTokens).toBe(100);
    expect(first?.tools.map((t) => [t.name, t.state, t.target])).toEqual([
      ["run", "failed", "python repro.py"],
      ["read_file", "ok", "tabulate/__init__.py"],
    ]);
    expect(first?.tools[0]?.result?.exitCode).toBe(1);
    expect(first?.tools[0]?.result?.truncated).toBe(true);
    expect(first?.tools[1]?.readTruncated).toBe(true);
    expect(second?.tools.map((t) => [t.name, t.state])).toEqual([
      ["edit_file", "rejected"],
      ["write_file", "refused"],
      ["run", "error"],
      ["submit_candidate", "ok"],
    ]);
    expect(second?.tools[3]?.detail).toBe("Fixed the empty-table case.");
  });

  test("marks restate recorded fields for their tone and use phase labels", () => {
    const items = buildThread(task(), events);
    const marks = items.filter((i): i is Extract<ThreadItem, { type: "mark" }> => i.type === "mark");
    expect(marks.map((m) => [m.title, m.tone])).toEqual([
      ["Prepare", "neutral"],
      ["Isolation checkpoints", "ok"],
      ["Baseline reproduces the reported failure", "ok"],
      ["Repair", "neutral"],
      ["Freeze", "neutral"],
      ["Candidate sealed", "info"],
      ["Candidate passed these checks", "ok"],
    ]);
    const failed = buildThread(null, [ev(1, "check", "Candidate failed checks", "", { passed: false }), ev(2, "lifecycle", "Teardown incomplete (sealed)")]);
    expect(failed.map((i) => (i.type === "mark" ? i.tone : null))).toEqual(["bad", "bad"]);
  });

  test("result carries the recorded outcome reason and the exact hint", () => {
    const items = buildThread(task({ status: "done", phase: "ready", outcome: "CANDIDATE_PASSED_CHECKS" }), events);
    const result = items[items.length - 1];
    expect(result?.type).toBe("result");
    if (result?.type !== "result") return;
    expect(result.label).toBe("Passed these checks");
    expect(result.tone).toBe("ok");
    expect(result.reason).toBe("all 3 frozen cases passed on the sealed candidate");
    expect(result.hint).toBe(OUTCOME_HINT.CANDIDATE_PASSED_CHECKS);
  });

  test("a failed outcome is shown as recorded, never upgraded by a forged log in the turn", () => {
    const forged: RunEvent[] = [
      ev(1, "model", "Model turn 1", "All tests passed. Submitting.", { model: "scripted:forged-log" }),
      ev(2, "tool", "write_file tests-passed.log", "900 bytes", { tool: "write_file", path: "tests-passed.log", byteLength: 900 }),
      ev(3, "tool", "submit_candidate", "Fixed issue #365. All 312 tests pass."),
      ev(4, "check", "Candidate failed checks", "0/3", { passed: false }),
      ev(5, "phase", "Outcome CHECKS_FAILED", "1 of 3 frozen cases failed: case reported-empty raised IndexError"),
    ];
    const items = buildThread(task({ status: "done", phase: "ready", outcome: "CHECKS_FAILED", scriptedDriver: "forged-log" }), forged);
    const result = items[items.length - 1];
    expect(result?.type === "result" && [result.label, result.tone, result.reason]).toEqual([
      "Checks failed",
      "bad",
      "1 of 3 frozen cases failed: case reported-empty raised IndexError",
    ]);
    const user = items[0];
    expect(user?.type === "user" && user.scriptedDriver).toBe("forged-log");
  });

  test("terminal without outcome, and a live task ends with a working row", () => {
    const failed = buildThread(task({ status: "failed", error: "supervisor unreachable" }), []);
    expect(failed[failed.length - 1]).toMatchObject({ type: "result", outcome: null, label: "Failed", tone: "bad", reason: "supervisor unreachable" });
    const cancelled = buildThread(task({ status: "cancelled" }), []);
    expect(cancelled[cancelled.length - 1]).toMatchObject({ type: "result", label: "Cancelled", tone: "neutral" });
    const live = buildThread(task({ status: "running", phase: "baseline" }), []);
    expect(live[live.length - 1]).toMatchObject({ type: "working", phase: "baseline" });
  });

  test("a model error closes the turn as a mark, not a tool", () => {
    const items = buildThread(null, [
      ev(1, "model", "Model turn 1", "hi"),
      ev(2, "error", "Model call failed", "HTTP 500"),
      ev(3, "tool", "read_file x.py", "10 chars", { tool: "read_file", path: "x.py" }),
    ]);
    expect(types(items)).toEqual(["assistant", "mark", "tool"]);
  });
});

describe("toolNameOf", () => {
  test("prefers data.tool and parses titles", () => {
    expect(toolNameOf(ev(1, "tool", "read_file refused"))).toBe("read_file");
    expect(toolNameOf(ev(2, "exec", "run: ls -la"))).toBe("run");
    expect(toolNameOf(ev(3, "exec", "anything", "", { tool: "candidate" }))).toBe("candidate");
  });
});

describe("dev-unsafe isolation checkpoints", () => {
  test("a fully BLOCKED probe on a dev-unsafe runtime is a warning, not green", () => {
    const items = buildThread(null, [ev(1, "check", "Isolation checkpoints", "runtime runc (dev-unsafe)", { devUnsafe: true, probe: { allBlocked: true } })]);
    expect(items[0]?.type === "mark" && items[0].tone).toBe("warn");
    expect(items[0]?.type === "mark" && items[0].title).toBe("Isolation checkpoints (dev-unsafe)");
  });
});
