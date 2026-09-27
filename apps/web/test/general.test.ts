import { describe, expect, test } from "bun:test";
import type { RunEvent, Task } from "@airlock/contracts";
import { outcomeTone } from "../src/lib/format";
import {
  buildGeneralThread,
  checkSummary,
  cleanupView,
  CSV_PREVIEW_COLS,
  domainListProblems,
  domainProblem,
  exportable,
  generalBudgetRows,
  generalPhase,
  normalizeDomainInput,
  observationOf,
  opStateView,
  outcomeReason,
  parseCsvPreview,
  parseOpState,
  previewKind,
  prettyJson,
  resultView,
  uploadErrorMessage,
  HERO_EXAMPLE,
} from "../src/lib/general";
import { generalCleanupBadge, taskRowView } from "../src/lib/taskList";
import { DiagnosticScript, diagnosticKind } from "../src/lib/api";

function task(patch: Partial<Task> = {}): Task {
  return {
    id: "task-g1",
    owner: "judge-abc",
    profileId: "analysis",
    issueText: "Summarise the CSV",
    kind: "general",
    status: "running",
    phase: "execute",
    generation: 0,
    leaseId: null,
    leaseUntil: null,
    attempts: 0,
    budget: { modelCallsUsed: 0, repairAttemptsUsed: 0 },
    cleanup: { status: "none" },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...patch,
  };
}

let seq = 0;
function ev(kind: RunEvent["kind"], title: string, detail = "", data?: Record<string, unknown>): RunEvent {
  seq += 1;
  return { id: `evt-${seq}`, taskId: "task-g1", seq, at: "2026-01-01T00:00:01.000Z", kind, title, detail, ...(data ? { data } : {}) };
}

const browserProfile = { id: "web-research", browser: true, maxEgressHosts: 3 };

describe("allowed-site validation mirrors the server", () => {
  test("accepts hostnames and .suffix", () => {
    expect(domainProblem("data.example.org")).toBeNull();
    expect(domainProblem(".example.org")).toBeNull();
    expect(domainProblem(HERO_EXAMPLE.domains[0])).toBeNull();
  });
  test("refuses IPs, localhost, internal and special-use names, single labels and bare TLD suffixes", () => {
    expect(domainProblem("10.0.0.1")).toMatch(/IP/);
    expect(domainProblem("[::1]")).toMatch(/IP/);
    expect(domainProblem("1.2.3.4.5")).toMatch(/IP/);
    expect(domainProblem("localhost")).toMatch(/single-label/);
    expect(domainProblem("app.localhost")).toMatch(/special-use/);
    expect(domainProblem("db.internal")).toMatch(/special-use/);
    expect(domainProblem("printer.local")).toMatch(/special-use/);
    expect(domainProblem("metadata.google.com")).toMatch(/special-use/);
    expect(domainProblem("intranet")).toMatch(/single-label/);
    expect(domainProblem(".com")).toMatch(/top-level/);
    expect(domainProblem("exa mple.com")).toMatch(/not a hostname/);
    expect(domainProblem("-bad.com")).toMatch(/not a hostname/);
  });
  test("normalises pasted URLs to hostnames", () => {
    expect(normalizeDomainInput(" HTTPS://Data.Example.org:8443/path?q=1 ")).toBe("data.example.org");
    expect(normalizeDomainInput("example.org.")).toBe("example.org");
  });
  test("list rules: required for browser profiles, empty otherwise, bounded, no duplicates", () => {
    expect(domainListProblems([], browserProfile)[0]).toMatch(/at least one/);
    expect(domainListProblems(["a.example.org"], browserProfile)).toEqual([]);
    expect(domainListProblems(["a.example.org", "a.example.org"], browserProfile).join()).toMatch(/duplicate/);
    expect(domainListProblems(["a.io", "b.io", "c.io", "d.io"], browserProfile).join()).toMatch(/at most 3/);
    expect(domainListProblems(["a.io"], { id: "analysis", browser: false, maxEgressHosts: 0 })[0]).toMatch(/no browser/);
    expect(domainListProblems([], { id: "analysis", browser: false, maxEgressHosts: 0 })).toEqual([]);
  });
});

describe("CSV preview", () => {
  test("quoted commas, escaped quotes, embedded newlines and CRLF", () => {
    const p = parseCsvPreview('name,note\r\n"Smith, J","said ""hi""\nthen left"\r\nB,2\r\n');
    expect(p.header).toEqual(["name", "note"]);
    expect(p.rows).toEqual([
      ["Smith, J", 'said "hi"\nthen left'],
      ["B", "2"],
    ]);
    expect(p.moreRows).toBe(false);
    expect(p.error).toBeNull();
  });
  test("bounded to 50 data rows and the column cap", () => {
    const lines = ["h1,h2"];
    for (let i = 0; i < 500; i++) lines.push(`${i},x`);
    const p = parseCsvPreview(lines.join("\n"));
    expect(p.rows.length).toBe(50);
    expect(p.rows[49]).toEqual(["49", "x"]);
    expect(p.moreRows).toBe(true);
    const wide = parseCsvPreview(Array.from({ length: 40 }, (_, i) => `c${i}`).join(",") + "\n" + Array.from({ length: 40 }, () => "1").join(","));
    expect(wide.header.length).toBe(CSV_PREVIEW_COLS);
    expect(wide.moreColumns).toBe(true);
  });
  test("exactly 50 rows is not truncated; cells are bounded; odd input never throws", () => {
    const lines = ["h"];
    for (let i = 0; i < 50; i++) lines.push(String(i));
    expect(parseCsvPreview(lines.join("\n")).moreRows).toBe(false);
    const long = parseCsvPreview(`h\n${"x".repeat(5000)}`);
    expect(long.rows[0]![0]!.length).toBeLessThanOrEqual(201);
    expect(parseCsvPreview("").error).toBe("no rows");
    expect(parseCsvPreview('a\n"unterminated').error).toMatch(/unterminated/);
    expect(parseCsvPreview("<script>alert(1)</script>").header).toEqual(["<script>alert(1)</script>"]);
  });
});

describe("previews and uploads", () => {
  test("preview kinds by stored media type", () => {
    expect(previewKind({ mediaType: "image/png", filename: "a.png" })).toBe("image");
    expect(previewKind({ mediaType: "text/csv", filename: "a.csv" })).toBe("csv");
    expect(previewKind({ mediaType: "text/plain", filename: "regions.csv" })).toBe("csv");
    expect(previewKind({ mediaType: "application/json", filename: "s.json" })).toBe("json");
    expect(previewKind({ mediaType: "application/pdf", filename: "x.pdf" })).toBe("none");
    expect(previewKind({ mediaType: "text/html", filename: "x.html" })).toBe("text");
  });
  test("pretty JSON or the parse error, bounded", () => {
    expect(prettyJson('{"a":1}').text).toBe('{\n  "a": 1\n}');
    expect(prettyJson("{nope").error).not.toBeNull();
    expect(prettyJson(JSON.stringify({ s: "x".repeat(50000) })).clipped).toBe(true);
  });
  test("413 and 415 are explained", () => {
    expect(uploadErrorMessage(413, "upload exceeds")).toMatch(/10 MiB/);
    expect(uploadErrorMessage(415, "unsupported")).toMatch(/PNG, JPEG, PDF, JSON, CSV/);
    expect(uploadErrorMessage(500, "boom")).toBe("boom");
  });
  test("the server's words are attributed, not run on into ours; a local refusal is not", () => {
    const m = uploadErrorMessage(415, "unsupported file type: accepted are PNG, JPEG");
    expect(m).toContain("UTF-8 text only. Server: \u201cunsupported file type: accepted are PNG, JPEG\u201d");
    expect(uploadErrorMessage(413, "This file is 11.0 MiB; not sent.", true)).toMatch(/quota shown\. This file is 11\.0 MiB; not sent\.$/);
    expect(uploadErrorMessage(415, "")).toMatch(/text only\.$/);
  });
});

describe("operation states", () => {
  test("parse only the five known states", () => {
    for (const s of ["allowed", "started", "completed", "failed", "unknown"]) expect(parseOpState(s)).toBe(s as never);
    expect(parseOpState("passed")).toBeNull();
    expect(parseOpState(undefined)).toBeNull();
  });
  test("unknown is a warning that says it was not retried", () => {
    const v = opStateView("unknown", false);
    expect(v.tone).toBe("warn");
    expect(v.note).toMatch(/not retried/);
  });
  test("started on a terminal task never reads as success", () => {
    expect(opStateView("started", false)).toMatchObject({ label: "started", tone: "info" });
    expect(opStateView("started", true)).toMatchObject({ label: "no outcome recorded", tone: "warn" });
    expect(opStateView("completed", true).tone).toBe("ok");
    expect(opStateView("failed", true).tone).toBe("bad");
    expect(opStateView("allowed", false).note).toMatch(/not execution/);
    expect(opStateView(null, false).label).toBe("state not recorded");
  });
});

describe("cleanup display", () => {
  test("the environment is gone only when cleanup is confirmed", () => {
    for (const s of ["none", "pending", "failed", "retrying"] as const) {
      expect(cleanupView({ status: s }, "done").environmentGone).toBe(false);
    }
    expect(cleanupView({ status: "confirmed" }, "done").environmentGone).toBe(true);
    expect(cleanupView(undefined, "done")).toMatchObject({ label: "not reported", environmentGone: false });
  });
  test("labels and tones", () => {
    expect(cleanupView({ status: "pending" }, "running")).toMatchObject({ label: "sandbox live", tone: "info" });
    expect(cleanupView({ status: "pending" }, "done")).toMatchObject({ label: "cleanup pending", tone: "warn" });
    expect(cleanupView({ status: "retrying", detail: "stop not confirmed" }, "cancelling")).toMatchObject({ tone: "warn", detail: "stop not confirmed" });
    expect(cleanupView({ status: "failed" }, "failed")).toMatchObject({ tone: "bad" });
    expect(cleanupView({ status: "none" }, "done").label).toBe("no sandbox created");
  });
  test("sidebar badge only for general tasks, once it matters", () => {
    expect(generalCleanupBadge(task({ cleanup: { status: "none" }, status: "running" }))).toBeNull();
    expect(generalCleanupBadge(task({ cleanup: { status: "pending" }, status: "running" }))?.label).toBe("sandbox live");
    expect(generalCleanupBadge(task({ cleanup: { status: "confirmed" }, status: "done" }))?.tone).toBe("ok");
    expect(generalCleanupBadge(task({ kind: undefined, status: "done" }))).toBeNull();
    const row = taskRowView(task({ profileId: "web-analysis", outcome: "RESULT_PARTIAL", status: "done", cleanup: { status: "failed" } }), Date.now());
    expect(row).toMatchObject({ kind: "general", profileLabel: "Web data analysis", badge: { label: "Partial result", tone: "warn" }, cleanup: { label: "cleanup failed", tone: "bad" } });
  });
});

describe("result dimension and checks", () => {
  test("general outcomes have their own tones (verified is not red)", () => {
    expect(outcomeTone("RESULT_VERIFIED")).toBe("ok");
    expect(outcomeTone("RESULT_PARTIAL")).toBe("warn");
    expect(outcomeTone("UNSUPPORTED")).toBe("warn");
    expect(outcomeTone("RESULT_FAILED")).toBe("bad");
    expect(outcomeTone("CANDIDATE_PASSED_CHECKS")).toBe("ok");
  });
  test("result view without an outcome", () => {
    expect(resultView({ status: "running" }).label).toBe("Not decided yet");
    expect(resultView({ status: "cancelled" }).label).toMatch(/cancelled/);
    expect(resultView({ status: "done", outcome: "INCONCLUSIVE" }).tone).toBe("warn");
  });
  test("check summary", () => {
    expect(checkSummary(undefined)).toMatchObject({ total: 0, tone: "neutral" });
    expect(checkSummary([{ name: "a", passed: true, detail: "" }, { name: "b", passed: true, detail: "" }])).toMatchObject({ passed: 2, failed: 0, label: "all 2 checks passed", tone: "ok" });
    expect(checkSummary([{ name: "a", passed: true, detail: "" }, { name: "b", passed: false, detail: "missing" }])).toMatchObject({ failed: 1, label: "1 of 2 checks failed", tone: "bad" });
  });
  test("export only for verified or partial", () => {
    expect(exportable("RESULT_VERIFIED")).toBe(true);
    expect(exportable("RESULT_PARTIAL")).toBe(true);
    expect(exportable("RESULT_FAILED")).toBe(false);
    expect(exportable("INCONCLUSIVE")).toBe(false);
    expect(exportable(undefined)).toBe(false);
  });
  test("phases and budget rows", () => {
    expect(generalPhase("repair")).toBe("execute");
    expect(generalPhase("freeze")).toBe("freeze");
    const rows = generalBudgetRows({ modelCallsUsed: 3, repairAttemptsUsed: 0, browserOps: 5, codeRuns: 2, sessions: 1 }, { modelCalls: 30, tokens: 1000, wallClockMs: 1, browserOps: 60, codeRuns: 20, browserSessions: 3, codeSandboxes: 2, recoveries: 2, attemptMs: 1 });
    expect(rows.find((r) => r.key === "browser ops")?.value).toBe("5 / 60");
    expect(rows.find((r) => r.key === "code runs")?.value).toBe("2 / 20");
    expect(rows.find((r) => r.key === "sessions")?.value).toBe("1 / 5");
  });
  test("checkpointed zero counters are real counts, not 'not reported'", () => {
    const limits = { modelCalls: 30, tokens: 1000, wallClockMs: 1, browserOps: 60, codeRuns: 20, browserSessions: 3, codeSandboxes: 2, recoveries: 2, attemptMs: 1 };
    const rows = generalBudgetRows({ modelCallsUsed: 2, repairAttemptsUsed: 0, tokensUsed: 0, browserOps: 0, codeRuns: 0, sessions: 1 }, limits);
    expect(rows.find((r) => r.key === "browser ops")?.value).toBe("0 / 60");
    expect(rows.find((r) => r.key === "code runs")?.value).toBe("0 / 20");
    expect(rows.find((r) => r.key === "sessions")?.value).toBe("1 / 5");
    expect(rows.find((r) => r.key === "tokens")?.value).toBe("0 / 1,000");
  });
  test("diagnostic scripts are sorted by the catalog's kind; the name prefix is only a fallback", () => {
    expect(diagnosticKind({ name: "general-hero", title: "t", description: "", kind: "repair" })).toBe("repair");
    expect(diagnosticKind({ name: "web-walkthrough", title: "t", description: "", kind: "general" })).toBe("general");
    expect(diagnosticKind({ name: "general-hero", title: "t", description: "" })).toBe("general");
    expect(diagnosticKind({ name: "forged-log", title: "t", description: "" })).toBe("repair");
    expect(DiagnosticScript.parse({ name: "x", title: "x", description: "", kind: "general" }).kind).toBe("general");
  });
  test("budget counters the control plane does not report are not shown as 0", () => {
    const limits = { modelCalls: 30, tokens: 1000, wallClockMs: 1, browserOps: 60, codeRuns: 20, browserSessions: 3, codeSandboxes: 2, recoveries: 2, attemptMs: 1 };
    const rows = generalBudgetRows({ modelCallsUsed: 4, repairAttemptsUsed: 0 }, limits);
    expect(rows.find((r) => r.key === "model calls")?.value).toBe("4 / 30");
    expect(rows.find((r) => r.key === "code runs")?.value).toBe("not reported (limit 20)");
    expect(rows.find((r) => r.key === "browser ops")?.value).toBe("not reported (limit 60)");
    expect(rows.find((r) => r.key === "sessions")?.value).toBe("not reported (limit 5)");
    // recoveries is written only once one happens
    expect(rows.find((r) => r.key === "recoveries")?.value).toBe("0 / 2");
  });
});

describe("general thread", () => {
  test("started and answer merge by operationId; the answer's state wins", () => {
    const events = [
      ev("phase", "execute", "model loop"),
      ev("model", "Model turn 1", "Opening the page.", { model: "m", toolCalls: [{ name: "browser_navigate" }] }),
      ev("tool", "browser_navigate started", "", { tool: "browser_navigate", opState: "started", operationId: "op-1", attemptId: "att-b" }),
      ev("tool", "browser_navigate https://a.example.org/", "status 200", { tool: "browser_navigate", opState: "completed", operationId: "op-1", finalUrl: "https://a.example.org/", status: 200, visitedUrl: "https://a.example.org/" }),
      ev("tool", "browser_click started", "", { tool: "browser_click", opState: "started", operationId: "op-2" }),
      ev("tool", "browser_click outcome unknown", "lost", { tool: "browser_click", opState: "unknown", operationId: "op-2", interrupted: true }),
      ev("tool", "browser_navigate refused by policy", "evil.com is outside", { tool: "browser_navigate", opState: "failed", policy: "egress", host: "evil.com" }),
      ev("phase", "Outcome RESULT_FAILED", "nothing acceptable", { outcome: "RESULT_FAILED" }),
    ];
    const items = buildGeneralThread(task({ status: "done", outcome: "RESULT_FAILED" }), events);
    const turn = items.find((i) => i.type === "turn");
    expect(turn?.type).toBe("turn");
    if (turn?.type !== "turn") return;
    expect(turn.ops.length).toBe(3);
    expect(turn.ops[0]).toMatchObject({ tool: "browser_navigate", state: "completed", operationId: "op-1", attemptId: "att-b" });
    expect(turn.ops[0]!.seqs.length).toBe(2);
    expect(observationOf(turn.ops[0]!)).toMatchObject({ summary: "status 200", url: "https://a.example.org/" });
    expect(turn.ops[1]).toMatchObject({ state: "unknown" });
    expect(observationOf(turn.ops[1]!).explain).toMatch(/not replayed/);
    expect(turn.ops[2]).toMatchObject({ state: "failed", operationId: null });
    expect(observationOf(turn.ops[2]!).explain).toMatch(/outside the destinations you allowed/);
    expect(items[items.length - 1]!.type).toBe("result");
    expect(outcomeReason(events, "RESULT_FAILED")).toBe("nothing acceptable");
  });

  test("observe, screenshot, code, run and submit observations", () => {
    const events = [
      ev("model", "Model turn 1", "Work.", { model: "scripted:hero", imageAttached: true, imageArtifactId: "art-s1", imageSha256: "a".repeat(64) }),
      ev("tool", "browser_observe https://a.example.org/", "Sales — 120 chars, 4 controls, 1 tab(s)\n\nRegion,Revenue\nNorth,10", { tool: "browser_observe", opState: "completed", operationId: "op-3", visitedUrl: "https://a.example.org/", title: "Sales", textChars: 120, controls: 4 }),
      ev("tool", "browser_click stale_reference", "ref gone", { tool: "browser_click", opState: "failed", errorCode: "stale_reference" }),
      ev("artifact", "Screenshot stored art-s1", "https://a.example.org/", { artifactId: "art-s1", kind: "screenshot", sha256: "a".repeat(64), capturedAt: "2026-01-01T00:00:02.000Z", width: 800, height: 600 }),
      ev("tool", "browser_screenshot https://a.example.org/", "stored as art-s1", { tool: "browser_screenshot", opState: "completed", artifactId: "art-s1", sha256: "a".repeat(64), visitedUrl: "https://a.example.org/" }),
      ev("tool", "code_write code/a.py", "12 bytes (sha256 abc)\nprint('<b>')\n", { tool: "code_write", opState: "completed", path: "code/a.py" }),
      ev("exec", "code_run code/a.py: succeeded", "…", { tool: "code_run", opState: "completed", result: { status: "succeeded", exitCode: 0, stdout: "<b>\n", stderr: "", truncated: false, timedOut: false, durationMs: 12 } }),
      ev("tool", "submit_result", "Lowest is North\noutputs: outputs/summary.json\nsources: https://a.example.org/", { tool: "submit_result", opState: "completed", outputs: ["outputs/summary.json"], sources: ["https://a.example.org/"] }),
    ];
    const items = buildGeneralThread(task(), events);
    const turn = items.find((i) => i.type === "turn");
    if (turn?.type !== "turn") throw new Error("no turn");
    expect(turn.image).toEqual({ attached: true, artifactId: "art-s1", sha256: "a".repeat(64) });
    expect(turn.scripted).toBe(true);
    expect(turn.notes.length).toBe(1);
    const [observe, stale, shot, write, run, submit] = turn.ops.map(observationOf);
    expect(observe).toMatchObject({ pageTitle: "Sales", summary: "120 chars of text · 4 controls", excerpt: "Region,Revenue\nNorth,10" });
    expect(stale!.explain).toMatch(/Stale reference/);
    expect(shot!.screenshot).toEqual({ artifactId: "art-s1", sha256: "a".repeat(64) });
    expect(write!.code).toBe("print('<b>')\n");
    expect(run!.exec?.exitCode).toBe(0);
    expect(submit!.claim).toEqual({ summary: "Lowest is North", outputs: ["outputs/summary.json"], sources: ["https://a.example.org/"], unsupported: null });
    expect(items[items.length - 1]).toMatchObject({ type: "working" });
  });

  test("the freeze collection answers the submit_result op recorded under the same operationId", () => {
    const items = buildGeneralThread(task({ status: "done", outcome: "RESULT_VERIFIED" }), [
      ev("model", "Model turn 4", "Submitting.", { model: "scripted:x", toolCalls: [{ name: "submit_result" }] }),
      ev("tool", "submit_result", "claim\noutputs: outputs/summary.json\nsources: (none)", { tool: "submit_result", opState: "completed", outputs: ["outputs/summary.json"], sources: [] }),
      ev("phase", "freeze", "stopping the sandboxes and collecting outputs/ read-only"),
      ev("tool", "submit_result started", "", { tool: "submit_result", opState: "started", attemptId: "att-1", operationId: "op-freeze" }),
      ev("lifecycle", "Code sandbox stopped and outputs collected", "stopConfirmed=true files=1", { tool: "collect-outputs", opState: "completed", operationId: "op-freeze", attemptId: "att-1", stopConfirmed: true }),
      ev("phase", "Outcome RESULT_VERIFIED", "all checks passed", { outcome: "RESULT_VERIFIED" }),
    ]);
    const ops = items.flatMap((i) => (i.type === "op" ? [i.op] : i.type === "turn" ? i.ops : []));
    const freeze = ops.find((o) => o.operationId === "op-freeze");
    expect(freeze?.state).toBe("completed");
    expect(freeze?.seqs.length).toBe(2);
    expect(opStateView(freeze!.state, true, freeze!.tool).label).not.toBe("no outcome recorded");
    // The collection is still shown as its own row.
    expect(items.some((i) => i.type === "mark" && i.title.startsWith("Code sandbox stopped"))).toBe(true);
  });

  test("tool events before any model turn are standalone; lifecycle rows keep their op state", () => {
    const items = buildGeneralThread(task(), [
      ev("tool", "files_list", "1 input(s)", { tool: "files_list", opState: "completed" }),
      ev("lifecycle", "analysis sandbox teardown incomplete (end)", "stop not confirmed", { opState: "failed" }),
      ev("error", "analysis sandbox refused", "unsupported role", { opState: "unknown" }),
    ]);
    expect(items.map((i) => i.type)).toEqual(["goal", "op", "mark", "mark", "working"]);
    // Inside a turn, lifecycle and error rows stay in the turn, in order with its operations.
    const inTurn = buildGeneralThread(task(), [
      ev("model", "Model turn 1", "Write.", {}),
      ev("lifecycle", "Creating analysis sandbox", ""),
      ev("error", "analysis sandbox refused", "not configured", { opState: "failed" }),
      ev("tool", "code_write code/a.py failed", "could not start", { tool: "code_write", opState: "failed" }),
      ev("phase", "freeze", ""),
    ]);
    expect(inTurn.map((i) => i.type)).toEqual(["goal", "turn", "mark", "working"]);
    const t = inTurn[1];
    if (t?.type !== "turn") throw new Error("no turn");
    expect(t.rows.map((r) => r.type)).toEqual(["mark", "mark", "op"]);
    expect(items[2]).toMatchObject({ tone: "bad" });
    expect(items[3]).toMatchObject({ tone: "bad", state: "unknown" });
  });
});
