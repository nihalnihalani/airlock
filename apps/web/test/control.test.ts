import { describe, expect, test } from "bun:test";
import type { ActionProposal, RunEvent, Task } from "@airlock/contracts";
import {
  actionOutcome,
  buildHumanRequest,
  checkNavigateUrl,
  controlErrorMessage,
  controlView,
  decisionBody,
  expiryCountdown,
  holderIsViewer,
  hostAllowed,
  humanActorLabel,
  humanHolderBySeq,
  latestFrame,
  parseObservation,
  pendingProposals,
  proposalChanged,
  proposalFieldRows,
  proposalLifecycle,
  proposalStatusView,
  PROPOSAL_STATUS,
  refreshWait,
  reviewCandidates,
  reviewWaitingFromEvents,
  staleReason,
  type ControlResponse,
  type Observation,
  type Viewer,
} from "../src/lib/control";
import { buildGeneralThread, observationOf, opStateView, workflowView, type Operation } from "../src/lib/general";

const T0 = "2026-01-01T00:00:00.000Z";
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);

function task(patch: Partial<Task> = {}): Task {
  return {
    id: "task-g1",
    owner: "judge-me",
    profileId: "web-research",
    issueText: "Fill the form",
    kind: "general",
    status: "running",
    phase: "execute",
    generation: 0,
    leaseId: null,
    leaseUntil: null,
    attempts: 0,
    budget: { modelCallsUsed: 0, repairAttemptsUsed: 0 },
    egressAllow: ["forms.example.org"],
    createdAt: T0,
    updatedAt: T0,
    ...patch,
  };
}

let seq = 0;
function ev(kind: RunEvent["kind"], title: string, data?: Record<string, unknown>, detail = ""): RunEvent {
  seq += 1;
  return { id: `evt-${seq}`, taskId: "task-g1", seq, at: `2026-01-01T00:00:${String(seq % 60).padStart(2, "0")}.000Z`, kind, title, detail, ...(data ? { data } : {}) };
}

function proposal(patch: Partial<ActionProposal> = {}): ActionProposal {
  return {
    schemaVersion: 1 as ActionProposal["schemaVersion"],
    id: "prop-1",
    owner: "judge-me",
    taskId: "task-g1",
    attemptId: "att-1",
    browserGeneration: 4,
    destination: "https://forms.example.org",
    adapter: "airlock-forms-v1",
    formId: "contact",
    fields: { name: "Ada", message: "x".repeat(4000) },
    payloadDigest: DIGEST_A,
    summary: "Send the contact form",
    createdAt: T0,
    expiresAt: "2026-01-01T00:15:00.000Z",
    status: "pending",
    ...patch,
  };
}

function resp(control: ControlResponse["control"], live: Partial<NonNullable<ControlResponse["live"]>> | null = {}): ControlResponse {
  return { control, live: live === null ? null : { ...control, epoch: 1, attached: true, liveBrowser: true, ...live }, idleMs: 300_000 };
}

const judge: Viewer = { ownerId: null, role: "judge", taskOwner: "judge-me" };
const operatorKnown: Viewer = { ownerId: "operator-me", role: "operator", taskOwner: "judge-x" };
const operatorUnknown: Viewer = { ownerId: null, role: "operator", taskOwner: "judge-x" };
const on = { running: true, canOperate: true };

describe("control-state display rules", () => {
  test("agent holder: Take available, Return not", () => {
    const v = controlView(resp({ holder: "agent", since: T0 }), judge, on);
    expect(v.holder).toBe("Agent");
    expect(v.canTake).toBe(true);
    expect(v.canRelease).toBe(false);
    expect(v.youHold).toBe(false);
  });
  test("transferring: nobody holds control; both take-again and return are offered", () => {
    const v = controlView(resp({ holder: "transferring", since: T0, reason: "the in-flight browser operation did not settle" }), judge, on);
    expect(v.holder).toBe("Transferring");
    expect(v.sentence).toMatch(/Nobody holds control/);
    expect(v.canTake && v.canRelease).toBe(true);
  });
  test("human holder that is this session (learned owner id) → You, with idle expiry", () => {
    const v = controlView(resp({ holder: "human", humanOwner: "operator-me", since: T0, reason: "taken by operator" }, { idleExpiresAt: "2026-01-01T00:05:00.000Z" }), operatorKnown, on);
    expect(v.holder).toBe("You");
    expect(v.youHold).toBe(true);
    expect(v.canRelease).toBe(true);
    expect(v.canTake).toBe(false);
    expect(v.idleExpiresAt).toBe("2026-01-01T00:05:00.000Z");
  });
  test("a judge only sees its own tasks: the task owner holding is the judge", () => {
    expect(holderIsViewer("judge-me", judge)).toBe(true);
    expect(controlView(resp({ holder: "human", humanOwner: "judge-me", since: T0 }), judge, on).holder).toBe("You");
  });
  test("another known session → Another person, no take (server would 409)", () => {
    const v = controlView(resp({ holder: "human", humanOwner: "judge-other", since: T0, reason: "taken by judge" }), operatorKnown, on);
    expect(v.holder).toBe("Another person");
    expect(v.sentence).toMatch(/\(judge\)/);
    expect(v.canTake).toBe(false);
    expect(v.canRelease).toBe(true); // operator may release another holder
    expect(v.youHold).toBe(false);
  });
  test("unknown identity → 'A person', honest that it cannot tell", () => {
    const v = controlView(resp({ holder: "human", humanOwner: "judge-other", since: T0 }), operatorUnknown, on);
    expect(v.holder).toBe("A person");
    expect(v.sentence).toMatch(/cannot tell/);
    expect(v.youHold).toBe(false);
  });
  test("not running, not attached, or not signed in: no buttons, a reason", () => {
    expect(controlView(resp({ holder: "agent", since: T0 }), judge, { running: false, canOperate: true }).canTake).toBe(false);
    const detached = controlView(resp({ holder: "agent", since: T0 }, null), judge, on);
    expect(detached.canTake).toBe(false);
    expect(detached.unavailable).toMatch(/not running in this control plane/);
    expect(controlView(resp({ holder: "agent", since: T0 }), judge, { running: true, canOperate: false }).unavailable).toMatch(/Sign in/);
  });
  test("409 on take that did not settle explains that nobody has control", () => {
    expect(controlErrorMessage(409, "the in-flight browser operation did not settle in time; control was not granted", "take")).toMatch(/nobody holds control/);
    expect(controlErrorMessage(404, "task not found", "take")).toMatch(/HTTP 404/);
    expect(controlErrorMessage(429, "live view refresh is limited", "refresh")).toMatch(/HTTP 429/);
  });
  test("workflow shows what a running task waits on without changing its status", () => {
    expect(workflowView({ status: "running", phase: "execute" }, { review: true }).label).toBe("Running · waiting for review");
    expect(workflowView({ status: "running", phase: "execute" }, { humanControl: true }).label).toMatch(/person holds control/);
    expect(workflowView({ status: "done", phase: "ready" }, { review: true }).label).toMatch(/^Finished/);
  });
});

describe("proposal lifecycle labels", () => {
  test("every status has a label, tone and note", () => {
    for (const s of Object.keys(PROPOSAL_STATUS) as ActionProposal["status"][]) {
      const v = proposalStatusView(s);
      expect(v.label.length).toBeGreaterThan(0);
      expect(v.note.length).toBeGreaterThan(0);
    }
  });
  test("happy path strip ends at confirmed", () => {
    expect(proposalLifecycle("confirmed").map((s) => s.status)).toEqual(["pending", "approved", "claimed", "submitted", "confirmed"]);
    expect(proposalLifecycle("confirmed").every((s) => s.reached)).toBe(true);
    expect(proposalLifecycle("approved").filter((s) => s.reached).map((s) => s.status)).toEqual(["pending", "approved"]);
  });
  test("side states end the strip where they happened", () => {
    expect(proposalLifecycle("rejected").map((s) => s.status)).toEqual(["pending", "rejected"]);
    expect(proposalLifecycle("expired").map((s) => s.status)).toEqual(["pending", "expired"]);
    expect(proposalLifecycle("failed").map((s) => s.status)).toEqual(["pending", "approved", "claimed", "failed"]);
    expect(proposalLifecycle("outcome_unknown").map((s) => s.status)).toEqual(["pending", "approved", "claimed", "submitted", "outcome_unknown"]);
  });
  test("outcome_unknown says not retried and reconciled by reading the receipt", () => {
    const note = proposalStatusView("outcome_unknown").note;
    expect(note).toMatch(/not retried/);
    expect(note).toMatch(/receipt/);
    expect(proposalStatusView("outcome_unknown").tone).toBe("warn");
    expect(proposalStatusView("confirmed").tone).toBe("ok");
  });
  test("pending filter respects expiry; countdown", () => {
    const now = Date.parse("2026-01-01T00:14:30.000Z");
    expect(pendingProposals([proposal(), proposal({ id: "p2", status: "approved" })], now).map((p) => p.id)).toEqual(["prop-1"]);
    expect(pendingProposals([proposal()], Date.parse("2026-01-01T00:15:00.000Z"))).toEqual([]);
    expect(expiryCountdown("2026-01-01T00:15:00.000Z", now)).toEqual({ text: "30 s left", expired: false, urgent: true });
    expect(expiryCountdown("2026-01-01T00:15:00.000Z", Date.parse(T0)).text).toBe("15 min 00 s left");
    expect(expiryCountdown("2026-01-01T00:15:00.000Z", Date.parse("2026-01-01T00:16:00.000Z")).expired).toBe(true);
  });
  test("fields are listed in full, in a stable order", () => {
    const rows = proposalFieldRows(proposal().fields);
    expect(rows.map((r) => r.name)).toEqual(["message", "name"]);
    expect(rows[0]!.value.length).toBe(4000);
  });
});

describe("the digest sent equals the digest shown", () => {
  test("decisionBody carries the shown card's digest, whatever a later fetch says", () => {
    const shown = proposal({ payloadDigest: DIGEST_A });
    const latest = proposal({ payloadDigest: DIGEST_B, fields: { name: "Eve", message: "changed" } });
    expect(decisionBody(shown, "approve")).toEqual({ decision: "approve", payloadDigest: DIGEST_A });
    expect(decisionBody(shown, "reject").payloadDigest).toBe(shown.payloadDigest);
    // …and the card detects the change so it can refuse to send until re-reviewed.
    expect(proposalChanged(shown, latest)).toBe(true);
    expect(proposalChanged(shown, proposal({ status: "approved" }))).toBe(false);
    expect(proposalChanged(shown, proposal({ fields: { name: "Ada", message: "y" } }))).toBe(true);
  });
});

describe("human action form validation", () => {
  const obs: Observation = { generation: 7, url: "https://forms.example.org/f/contact", title: "Contact", controls: [{ ref: "e1", role: "textbox", name: "Name" }, { ref: "e2", role: "button", name: "Submit", disabled: true }], controlsTruncated: false, pendingReview: false };
  const ctx = { observation: obs, latest: { generation: 7, invalidated: false }, allow: ["forms.example.org", ".example.net"] };

  test("navigate: http(s) only, no credentials, allowlist shown (server enforces)", () => {
    expect(checkNavigateUrl("ftp://forms.example.org/", ctx.allow)).toEqual({ ok: false, problem: "Only http:// and https:// URLs." });
    expect(checkNavigateUrl("https://u:p@forms.example.org/", ctx.allow).ok).toBe(false);
    expect(checkNavigateUrl("forms.example.org", ctx.allow).ok).toBe(false);
    expect(checkNavigateUrl("", ctx.allow).ok).toBe(false);
    expect(checkNavigateUrl("https://forms.example.org/f/contact", ctx.allow)).toEqual({ ok: true, url: "https://forms.example.org/f/contact", host: "forms.example.org", allowed: true });
    const other = checkNavigateUrl("https://evil.example.com/", ctx.allow);
    expect(other.ok && other.allowed).toBe(false);
    // a disallowed host is still sent: the server's refusal is the authority, and it is shown
    expect(buildHumanRequest({ kind: "navigate", url: "https://evil.example.com/" }, ctx)).toEqual({ ok: true, request: { op: "navigate", args: { url: "https://evil.example.com/" } } });
  });
  test("hostAllowed mirrors the server: exact, or .suffix for subdomains only", () => {
    expect(hostAllowed("a.example.net", ctx.allow)).toBe(true);
    expect(hostAllowed("example.net", ctx.allow)).toBe(false);
    expect(hostAllowed("FORMS.example.org.", ctx.allow)).toBe(true);
  });
  test("click/type use the observation's generation; unknown/disabled refs are refused", () => {
    expect(buildHumanRequest({ kind: "click", ref: "e1" }, ctx)).toEqual({ ok: true, request: { op: "click", args: { ref: "e1", generation: 7 } } });
    expect(buildHumanRequest({ kind: "type", ref: "e1", text: "Ada", submit: true }, ctx)).toEqual({ ok: true, request: { op: "type", args: { ref: "e1", generation: 7, text: "Ada", submit: true } } });
    expect(buildHumanRequest({ kind: "type", ref: "e1", text: "Ada", submit: false }, ctx)).toEqual({ ok: true, request: { op: "type", args: { ref: "e1", generation: 7, text: "Ada" } } });
    expect(buildHumanRequest({ kind: "click", ref: "e9" }, ctx).ok).toBe(false);
    expect(buildHumanRequest({ kind: "click", ref: "e2" }, ctx).ok).toBe(false);
    expect(buildHumanRequest({ kind: "click", ref: "" }, ctx).ok).toBe(false);
    expect(buildHumanRequest({ kind: "type", ref: "e1", text: "x".repeat(8193), submit: false }, ctx).ok).toBe(false);
  });
  test("stale observation: no observation, a newer generation, or invalidated refs → observe again", () => {
    expect(buildHumanRequest({ kind: "click", ref: "e1" }, { ...ctx, observation: null })).toEqual({ ok: false, problem: staleReason(null, null)! });
    const moved = buildHumanRequest({ kind: "click", ref: "e1" }, { ...ctx, latest: { generation: 9, invalidated: false } });
    expect(moved.ok).toBe(false);
    expect(!moved.ok && moved.problem).toMatch(/generation 7 → 9/);
    expect(buildHumanRequest({ kind: "key", key: "Enter" }, { ...ctx, latest: { generation: 7, invalidated: true } }).ok).toBe(false);
  });
  test("keys are the runner's allowlist only", () => {
    expect(buildHumanRequest({ kind: "key", key: "Enter" }, ctx)).toEqual({ ok: true, request: { op: "key", args: { key: "Enter", generation: 7 } } });
    expect(buildHumanRequest({ kind: "key", key: "F12" }, ctx).ok).toBe(false);
    expect(buildHumanRequest({ kind: "key", key: "Control+w" }, ctx).ok).toBe(false);
  });
  test("scroll, screenshot, downloads and upload bodies", () => {
    expect(buildHumanRequest({ kind: "scroll", dy: "-600" }, ctx)).toEqual({ ok: true, request: { op: "scroll", args: { dy: -600 } } });
    expect(buildHumanRequest({ kind: "scroll", dy: "10001" }, ctx).ok).toBe(false);
    expect(buildHumanRequest({ kind: "scroll", dy: "1.5" }, ctx).ok).toBe(false);
    expect(buildHumanRequest({ kind: "scroll", dy: "0" }, ctx).ok).toBe(false);
    expect(buildHumanRequest({ kind: "screenshot", fullPage: false }, ctx)).toEqual({ ok: true, request: { op: "screenshot" } });
    expect(buildHumanRequest({ kind: "download.list" }, ctx)).toEqual({ ok: true, request: { op: "download.list" } });
    expect(buildHumanRequest({ kind: "download.read", downloadId: "dl-3" }, ctx)).toEqual({ ok: true, request: { op: "download.read", args: { downloadId: "dl-3" } } });
    expect(buildHumanRequest({ kind: "download.read", downloadId: "../x" }, ctx).ok).toBe(false);
    expect(buildHumanRequest({ kind: "upload", ref: "e1", artifactId: "art-9" }, ctx)).toEqual({ ok: true, request: { op: "upload", args: { ref: "e1", generation: 7, artifactId: "art-9" } } });
    expect(buildHumanRequest({ kind: "upload", ref: "e1", artifactId: "" }, ctx).ok).toBe(false);
  });
  test("observation parsing drops malformed refs", () => {
    const o = parseObservation({ generation: 3, url: "u", title: "t", controls: [{ ref: "e1", role: "link", name: "Home" }, { ref: "../x", role: "link", name: "bad" }], controlsTruncated: false, pendingReview: false });
    expect(o?.controls.map((c) => c.ref)).toEqual(["e1"]);
    expect(parseObservation({ controls: [] })).toBeNull();
  });
});

describe("action results show opState plainly", () => {
  test("completed / failed with code / interrupted = unknown", () => {
    expect(actionOutcome({ ok: true, result: { response: { ok: true, op: "click", result: { generation: 8 } }, status: "completed", durationMs: 12 } }).opState).toBe("completed");
    const stale = actionOutcome({ ok: false, error: "stale_reference", result: { response: { ok: false, op: "click", error: "stale_reference", message: "ref e1 is stale" }, status: "completed", durationMs: 3 } });
    expect(stale.opState).toBe("failed");
    expect(stale.error).toBe("stale_reference: ref e1 is stale");
    expect(stale.explain).toMatch(/Observe again/);
    const lost = actionOutcome({ ok: false, error: "browser_session_lost", result: { response: null, status: "interrupted", durationMs: 30000 } });
    expect(lost.opState).toBe("unknown");
    expect(lost.explain).toMatch(/not replayed/);
    expect(actionOutcome({ ok: false, error: "forms.evil.com is not an allowed destination for this task" }).explain).toMatch(/allowed list/);
  });
});

describe("events: review, attribution, frames, new tool cards", () => {
  test("waiting-for-review ids from events, cleared by a decision", () => {
    const events = [ev("lifecycle", "Waiting for review", { proposalId: "prop-1", waitingForReview: true }), ev("lifecycle", "Waiting for review", { proposalId: "prop-2", waitingForReview: true }), ev("lifecycle", "Proposal approved", { proposalId: "prop-1", status: "approved" })];
    expect(reviewWaitingFromEvents(events)).toEqual(["prop-2"]);
  });
  test("human operations are attributed to the holder at that time", () => {
    const take = ev("lifecycle", "Human took control", { control: { holder: "human", humanOwner: "judge-me", since: T0, reason: "taken by judge" } });
    const act = ev("tool", "human_click click", { tool: "human_click", actor: "human", opState: "completed", operationId: "op-h1" });
    const release = ev("lifecycle", "Control returned to the agent", { control: { holder: "agent", since: T0 } });
    const holderAt = humanHolderBySeq([take, act, release]);
    expect(humanActorLabel(holderAt(act.seq), judge)).toBe("you (judge)");
    expect(humanActorLabel(holderAt(act.seq), operatorKnown)).toBe("a person (judge)");
    expect(holderAt(release.seq + 1)).toBeNull();
  });
  test("thread: human ops, collapsed live frames, saved downloads, proposals and the controller's steps", () => {
    const events = [
      ev("model", "Model call 1", { model: "m", toolCalls: [{ name: "browser_propose_submit" }] }, "plan"),
      ev("tool", "browser_propose_submit contact", { tool: "browser_propose_submit", opState: "allowed", policy: "final-action", proposalId: "prop-1", destination: "https://forms.example.org", formId: "contact" }),
      ev("tool", "live_view started", { tool: "live_view", opState: "started", operationId: "op-l1" }),
      ev("artifact", "Live frame art-1", { artifactId: "art-1", kind: "screenshot", sha256: DIGEST_A, url: "https://forms.example.org/", actor: "observer", frame: true }),
      ev("tool", "live_view started", { tool: "live_view", opState: "started", operationId: "op-l2" }),
      ev("artifact", "Live frame art-2", { artifactId: "art-2", kind: "screenshot", sha256: DIGEST_B, url: "https://forms.example.org/", actor: "observer", frame: true }),
      ev("tool", "human_download_read started", { tool: "human_download_read", opState: "started", operationId: "op-h2" }),
      ev("artifact", "Download stored art-3", { artifactId: "art-3", kind: "download", sha256: DIGEST_A, byteLength: 10, actor: "human" }),
      ev("tool", "approved_submit started", { tool: "approved_submit", opState: "started", operationId: "op-c1" }),
    ];
    const items = buildGeneralThread(task(), events);
    const turn = items.find((i) => i.type === "turn");
    if (!turn || turn.type !== "turn") throw new Error("no turn");
    const ops = turn.ops;
    expect(ops.map((o) => o.tool)).toEqual(["browser_propose_submit", "live_view", "human_download_read", "approved_submit"]);
    const live = ops[1]!;
    expect(live.data["frames"]).toBe(2);
    expect(observationOf(live).saved?.artifactId).toBe("art-2");
    expect(observationOf(live).screenshot?.artifactId).toBe("art-2");
    expect(turn.notes).toEqual([]);
    const saved = observationOf(ops[2]!);
    expect(ops[2]!.state).toBe("completed");
    expect(saved.saved?.artifactId).toBe("art-3");
    expect(observationOf(ops[0]!).proposal).toEqual({ id: "prop-1", destination: "https://forms.example.org", formId: "contact" });
    const ctrl: Operation = ops[3]!;
    expect(opStateView(ctrl.state, false, ctrl.tool).label).toBe("step sent");
    expect(observationOf(ctrl).summary).toMatch(/approval code is never shown/);
    // nothing in the controller step's recorded data could carry the code
    expect(JSON.stringify(ctrl.data)).not.toMatch(/code/i);
  });
});

describe("live frame and refresh rate limit", () => {
  test("the newest of the event stream and the /live answer wins", () => {
    const events = [ev("artifact", "Live frame art-5", { artifactId: "art-5", kind: "screenshot", sha256: DIGEST_A, url: "https://x/", capturedAt: "2026-01-01T00:01:00.000Z", actor: "observer", frame: true })];
    const liveOld = { artifactId: "art-4", url: "/api/tasks/t/artifacts/art-4", sourceUrl: "https://x/", tool: "live_view", createdAt: "2026-01-01T00:00:30.000Z", sha256: DIGEST_B, byteLength: 10 };
    expect(latestFrame(events, liveOld)?.artifactId).toBe("art-5");
    expect(latestFrame([], liveOld)?.artifactId).toBe("art-4");
    expect(latestFrame(events, { ...liveOld, artifactId: "art-6", createdAt: "2026-01-01T00:02:00.000Z" })?.artifactId).toBe("art-6");
    expect(latestFrame([], null)).toBeNull();
  });
  test("refresh waits out the minimum interval", () => {
    expect(refreshWait(null, 2000, 5000)).toBe(0);
    expect(refreshWait(4000, 2000, 5000)).toBe(1000);
    expect(refreshWait(1000, 2000, 5000)).toBe(0);
  });
  test("sidebar asks only running general browser tasks", () => {
    expect(reviewCandidates([task(), task({ id: "t2", status: "done" }), task({ id: "t3", egressAllow: [] }), task({ id: "t4", kind: "repair" })])).toEqual(["task-g1"]);
  });
});
