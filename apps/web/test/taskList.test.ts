import { describe, expect, test } from "bun:test";
import type { Task } from "@airlock/contracts";
import { issueTitle, pollAction, relativeTime, ROSTER_STALE_POLLS, sortTasks, staleRosterMessage, taskBadge, taskDot, taskRowView, TITLE_MAX } from "../src/lib/taskList";

function task(patch: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    owner: "operator",
    profileId: "tabulate-365",
    issueText: "Empty table with maxheadercolwidths raises IndexError",
    status: "queued",
    phase: "prepare",
    generation: 0,
    leaseId: null,
    leaseUntil: null,
    attempts: 0,
    budget: { modelCallsUsed: 0, repairAttemptsUsed: 0 },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...patch,
  };
}

describe("issueTitle", () => {
  test("first non-empty line, markdown markers stripped, whitespace collapsed", () => {
    expect(issueTitle("\n\n  ## IndexError   when  empty\nbody")).toBe("IndexError when empty");
    expect(issueTitle("> quoted title\nmore")).toBe("quoted title");
    expect(issueTitle("   \n\t\n")).toBe("(empty issue)");
  });

  test("bounded with an ellipsis", () => {
    const t = issueTitle("x".repeat(500));
    expect(t.length).toBe(TITLE_MAX);
    expect(t.endsWith("…")).toBe(true);
  });

  test("keeps markup characters as text", () => {
    expect(issueTitle("<script>alert(1)</script>")).toBe("<script>alert(1)</script>");
  });
});

describe("relativeTime", () => {
  const now = Date.parse("2026-01-10T12:00:00.000Z");
  test("roster-style buckets", () => {
    expect(relativeTime("2026-01-10T11:59:58.000Z", now)).toBe("now");
    expect(relativeTime("2026-01-10T11:59:30.000Z", now)).toBe("30s");
    expect(relativeTime("2026-01-10T11:55:00.000Z", now)).toBe("5m");
    expect(relativeTime("2026-01-10T09:00:00.000Z", now)).toBe("3h");
    expect(relativeTime("2026-01-08T12:00:00.000Z", now)).toBe("2d");
    expect(relativeTime("not a date", now)).toBe("");
    // Clock skew: a time ahead of this browser is "now", never negative.
    expect(relativeTime("2026-01-10T12:05:00.000Z", now)).toBe("now");
  });
});

describe("status dot and badge", () => {
  test("restate status and outcome", () => {
    expect(taskDot(task({ status: "queued" }))).toBe("queued");
    expect(taskDot(task({ status: "running" }))).toBe("running");
    expect(taskDot(task({ status: "done", outcome: "CANDIDATE_PASSED_CHECKS" }))).toBe("ok");
    expect(taskDot(task({ status: "done", outcome: "CHECKS_FAILED" }))).toBe("bad");
    expect(taskDot(task({ status: "done", outcome: "REPRODUCED_UNRESOLVED" }))).toBe("bad");
    expect(taskDot(task({ status: "done", outcome: "NOT_REPRODUCED" }))).toBe("warn");
    expect(taskDot(task({ status: "done", outcome: "INCONCLUSIVE" }))).toBe("warn");
    expect(taskDot(task({ status: "failed" }))).toBe("bad");
    expect(taskDot(task({ status: "cancelled" }))).toBe("neutral");

    expect(taskBadge(task({ status: "done", outcome: "CANDIDATE_PASSED_CHECKS" }))).toEqual({ label: "Passed these checks", tone: "ok" });
    expect(taskBadge(task({ status: "running", phase: "repair" }))).toEqual({ label: "Repair", tone: "info" });
    expect(taskBadge(task({ status: "failed" }))).toEqual({ label: "Failed", tone: "bad" });
    expect(taskBadge(task({ status: "queued" }))).toEqual({ label: "Queued", tone: "neutral" });
  });
});

describe("taskRowView / sortTasks", () => {
  test("row derivation", () => {
    const now = Date.parse("2026-01-01T00:10:00.000Z");
    const row = taskRowView(task({ status: "running", phase: "baseline", updatedAt: "2026-01-01T00:05:00.000Z", scriptedDriver: "diagnostic" }), now);
    expect(row).toMatchObject({
      id: "task-1",
      title: "Empty table with maxheadercolwidths raises IndexError",
      profileId: "tabulate-365",
      dot: "running",
      live: true,
      badge: { label: "Baseline", tone: "info" },
      relative: "5m",
      scripted: "diagnostic",
    });
    expect(taskRowView(task({ status: "done", outcome: "CHECKS_FAILED" }), now).live).toBe(false);
  });

  test("newest first, stable", () => {
    const a = task({ id: "a", createdAt: "2026-01-01T00:00:00.000Z" });
    const b = task({ id: "b", createdAt: "2026-01-02T00:00:00.000Z" });
    const c = task({ id: "c", createdAt: "2026-01-02T00:00:00.000Z" });
    expect(sortTasks([a, c, b]).map((t) => t.id)).toEqual(["b", "c", "a"]);
  });
});

describe("pollAction", () => {
  test("a slow request is not aborted by the next tick; a stalled one is restarted", () => {
    const poll = 3000;
    expect(pollAction(null, 10_000, poll)).toBe("fetch");
    expect(pollAction(10_000, 10_000 + poll, poll)).toBe("skip");
    expect(pollAction(10_000, 10_000 + poll * ROSTER_STALE_POLLS - 1, poll)).toBe("skip");
    expect(pollAction(10_000, 10_000 + poll * ROSTER_STALE_POLLS, poll)).toBe("restart");
    expect(staleRosterMessage(10_000, 19_000)).toContain("9 s");
  });
});
