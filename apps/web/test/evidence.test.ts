import { describe, expect, test } from "bun:test";
import type { BlastRadiusCard, HostCheck, RepairAvailability, RunEvent, RuntimeInspection, Task } from "@airlock/contracts";
import {
  blastContained,
  budgetRows,
  candidateRows,
  cleanupStatus,
  compareKernels,
  DIAGNOSTIC_LABEL,
  diagnosticIssueText,
  hostListingSummary,
  instanceIds,
  isDiagnostic,
  kernelRelease,
  refusalLead,
  repairNotice,
  siblingRows,
  workspaceSummary,
} from "../src/lib/evidence";
import { buildThread, dispatchOf } from "../src/lib/thread";

const AT = "2026-01-01T00:00:00.000Z";
const D1 = "a".repeat(64);
const D2 = "b".repeat(64);

function host(patch: Partial<HostCheck> = {}): HostCheck {
  return {
    checkedAt: AT,
    dockerVersion: "27",
    cpuVirtualization: true,
    kvmPresent: true,
    kvmReadWrite: true,
    availableRuntimes: ["kata"],
    selectedRuntime: "kata",
    devUnsafe: false,
    ...patch,
  };
}

function inspection(patch: Partial<RuntimeInspection> = {}): Pick<RuntimeInspection, "guestUname" | "runtime" | "devUnsafe"> {
  return { guestUname: "Linux sandbox 6.1.62 #1 SMP x86_64 GNU/Linux", runtime: "kata", devUnsafe: false, ...patch };
}

function ev(seq: number, kind: RunEvent["kind"], title: string, detail = "", data?: Record<string, unknown>): RunEvent {
  return { id: `ev-${seq}`, taskId: "t1", seq, at: AT, kind, title, detail, ...(data ? { data } : {}) };
}

function task(patch: Partial<Task> = {}): Task {
  return {
    id: "t1",
    owner: "judge",
    profileId: "tabulate-365",
    issueText: "IndexError",
    status: "done",
    phase: "ready",
    generation: 1,
    leaseId: null,
    leaseUntil: null,
    attempts: 1,
    budget: { modelCallsUsed: 3, repairAttemptsUsed: 1 },
    createdAt: AT,
    updatedAt: AT,
    ...patch,
  };
}

describe("instance ids (U1)", () => {
  test("absent everywhere → not deployed", () => {
    expect(instanceIds(null, null)).toEqual({ control: null, execution: null, deployed: false });
    const avail: RepairAvailability = { available: false, reason: "x", driver: "scripted", instances: { control: "  " } };
    expect(instanceIds(avail, host()).deployed).toBe(false);
  });
  test("host check wins for the execution id; control from availability", () => {
    const avail: RepairAvailability = { available: true, reason: "ok", driver: "vultr", instances: { control: "ctl-1", execution: "exe-old" } };
    expect(instanceIds(avail, host({ instanceId: "exe-2" }))).toEqual({ control: "ctl-1", execution: "exe-2", deployed: true });
    expect(instanceIds(avail, host()).execution).toBe("exe-old");
  });
});

describe("kernel comparison (U2)", () => {
  test("parses uname -a and bare releases", () => {
    expect(kernelRelease("Linux vm-b 6.8.0-45-generic #45-Ubuntu SMP x86_64")).toBe("6.8.0-45-generic");
    expect(kernelRelease("4.4.0")).toBe("4.4.0");
    expect(kernelRelease("")).toBeNull();
    expect(kernelRelease(undefined)).toBeNull();
  });
  test("kata guest kernel differs from the host", () => {
    const c = compareKernels("Linux vm-b 6.8.0-45-generic #45 SMP", inspection());
    expect(c.verdict).toBe("differs");
    expect(c.tone).toBe("ok");
    expect(c.note).toContain("Kata");
  });
  test("runc shares the host kernel and says dev-unsafe", () => {
    const c = compareKernels("Linux mac 6.10.14-linuxkit #1 SMP", inspection({ runtime: "runc", devUnsafe: true, guestUname: "Linux abc 6.10.14-linuxkit #1 SMP" }));
    expect(c.verdict).toBe("same");
    expect(c.tone).toBe("bad");
    expect(c.note).toContain("dev-unsafe");
  });
  test("no host uname → unknown, never guessed", () => {
    expect(compareKernels(undefined, inspection()).verdict).toBe("unknown");
    // runc with a supervisor host that is not the Docker host (macOS + a Docker VM): different, but not isolation.
    const mac = compareKernels("Darwin mac 27.0.0 Darwin Kernel", inspection({ runtime: "runc", devUnsafe: true, guestUname: "Linux sandbox 6.8.0-64-generic #67" }));
    expect(mac.verdict).toBe("differs");
    expect(mac.tone).toBe("warn");
    expect(mac.note).toContain("not isolation");
  });
});

describe("host-wide listing (U3, checkpoint 5)", () => {
  test("(no sandboxes) only when the host listing exists and is empty", () => {
    expect(hostListingSummary({ host: { listedAt: AT, scope: "host", containers: [], volumes: [] } }).label).toBe("(no sandboxes)");
    const missing = hostListingSummary({});
    expect(missing.state).toBe("not-recorded");
    expect(missing.label).not.toContain("no sandboxes");
    const left = hostListingSummary({ host: { listedAt: AT, scope: "host", containers: [{ name: "airlock-x", taskId: "t2", role: "author" }], volumes: ["v1", "v2"] } });
    expect(left.state).toBe("remaining");
    expect(left.label).toBe("1 container and 2 volumes still on the host");
    expect(left.containers[0]?.name).toBe("airlock-x");
  });
});

describe("blast radius (U3)", () => {
  const base: BlastRadiusCard = {
    operationId: "op1",
    container: "c1",
    inspection: { inspectedAt: AT, container: "c1", runtime: "kata", devUnsafe: false, imageDigest: "sha256:x", guestUname: "Linux g 6.1", guestHostname: "g", checks: { networkNone: true, nonRootUser: true, readOnlyRootfs: true, capDropAll: true, noNewPrivileges: true, pidsLimited: true, memoryLimited: true, cpuLimited: true, noHostBinds: true, noPorts: true, privateIpc: true, restartDisabled: true, ownedLabels: true }, allPassed: true },
    exec: { status: "failed", exitCode: 1, stdout: "", stderr: "", truncated: false, timedOut: false, durationMs: 5 },
    died: { container: "c1", runtime: "kata", guestUname: "Linux g 6.1", reason: "destroyed after the run" },
    survived: { supervisorHealthy: true, hostSentinelUnchanged: true, otherAttemptsRunning: 1, hostUptimeSeconds: 100 },
    teardown: { destroyedAt: AT, containersRemaining: [], volumesRemaining: [], clean: true },
  };
  test("workspace files before → after", () => {
    expect(workspaceSummary({ filesBefore: 5, filesAfter: 0 }).text).toBe("5 → 0 (5 destroyed)");
    expect(workspaceSummary({ filesBefore: 5, filesAfter: null }).text).toContain("unreadable");
    expect(workspaceSummary(undefined).text).toBe("not recorded");
  });
  test("siblings: each attempt before/after; absent list stays null", () => {
    expect(siblingRows(base.survived)).toBeNull();
    const rows = siblingRows({ ...base.survived, siblings: [{ attemptId: "a1", taskId: "t2", runningBefore: true, runningAfter: true }, { attemptId: "a2", taskId: "t3", runningBefore: true, runningAfter: false }] });
    expect(rows?.map((r) => r.survived)).toEqual([true, false]);
  });
  test("contained only when control plane, supervisor, sentinel and siblings all survived", () => {
    expect(blastContained(base)).toBe(true);
    expect(blastContained({ ...base, survived: { ...base.survived, controlPlane: { healthyBefore: true, healthyAfter: false, checkedAt: AT } } })).toBe(false);
    expect(blastContained({ ...base, survived: { ...base.survived, siblings: [{ attemptId: "a", taskId: "t", runningBefore: true, runningAfter: false }] } })).toBe(false);
  });
});

describe("cleanup status (item 9)", () => {
  const created = ev(1, "lifecycle", "Author sandbox created");
  test("destroyed after creation → confirmed, with the host listing", () => {
    const destroyed = ev(2, "lifecycle", "Attempt destroyed (sealed)", "clean", { teardown: { destroyedAt: AT, containersRemaining: [], volumesRemaining: [], clean: true, host: { listedAt: AT, scope: "host", containers: [], volumes: [] } } });
    const s = cleanupStatus({ status: "done" }, [created, destroyed]);
    expect(s.state).toBe("confirmed");
    expect(s.listing?.label).toBe("(no sandboxes)");
  });
  test("cancelling with a live sandbox → pending; cancelled without destroy → unconfirmed", () => {
    expect(cleanupStatus({ status: "cancelling" }, [created]).state).toBe("pending");
    expect(cleanupStatus({ status: "cancelled" }, [created]).state).toBe("unconfirmed");
  });
  test("teardown incomplete is shown as incomplete, whatever the result", () => {
    const s = cleanupStatus({ status: "failed" }, [created, ev(2, "lifecycle", "Teardown incomplete after cancellation", "container still running")]);
    expect(s.state).toBe("incomplete");
    expect(s.detail).toBe("container still running");
  });
  test("no sandbox ever created → none", () => {
    expect(cleanupStatus({ status: "done" }, []).state).toBe("none");
  });
});

describe("candidates and budget (U4)", () => {
  test("one row per candidate with its outcome", () => {
    const rows = candidateRows(
      task({
        candidateDigest: D2,
        candidates: [
          { attemptId: "att1", candidateDigest: D1, verificationRecordId: "ver1", outcome: "CHECKS_FAILED" },
          { attemptId: "att2", candidateDigest: D2, verificationRecordId: "ver2", outcome: "PASSED_CHECKS" },
        ],
      }),
    );
    expect(rows.map((r) => [r.index, r.outcome, r.current])).toEqual([
      [1, "checks failed", false],
      [2, "passed these checks", true],
    ]);
  });
  test("older records fall back to the single sealed candidate", () => {
    expect(candidateRows(task({ candidateDigest: D1, verificationRecordId: "ver1", attemptId: "att1" }))).toHaveLength(1);
    expect(candidateRows(task())).toHaveLength(0);
  });
  test("budget rows include only recorded counters", () => {
    expect(budgetRows({ modelCallsUsed: 2, repairAttemptsUsed: 1 }).map((r) => r.key)).toEqual(["model calls", "repair attempts"]);
    const rows = budgetRows({ modelCallsUsed: 2, repairAttemptsUsed: 1, tokensUsed: 12000, attemptModelCalls: 1, attemptTokens: 500, recoveries: 0 });
    expect(rows.find((r) => r.key === "tokens")?.value).toBe("12,000");
    expect(rows.find((r) => r.key === "this attempt")?.value).toBe("1 calls · 500 tokens");
    expect(rows.find((r) => r.key === "recoveries")?.value).toBe("0");
  });
});

describe("dispatch trail (U4)", () => {
  test("run: dispatched to the supervisor, observation is exit code and stdout tail", () => {
    const r = { status: "failed" as const, exitCode: 1, stdout: "collected 3\n312 passed\n", stderr: "", truncated: false, timedOut: false, durationMs: 9 };
    const d = dispatchOf("run", "failed", { detail: "", data: {} }, r);
    expect(d.operation).toContain("supervisor exec");
    expect(d.observation).toBe("exit 1 · 312 passed");
  });
  test("controller refusal is not dispatched", () => {
    const d = dispatchOf("write_file", "refused", { detail: "setup.py is not an allowed replacement path" }, null);
    expect(d.operation).toBeNull();
    expect(d.observation).toContain("setup.py");
  });
  test("submit_candidate links to the candidate's verification record in order", () => {
    const items = buildThread(
      task({ candidateDigest: D1, candidates: [{ attemptId: "att1", candidateDigest: D1, verificationRecordId: "ver1", outcome: "CHECKS_FAILED" }] }),
      [
        ev(1, "model", "Model turn 1", "done", { toolCalls: [{ name: "submit_candidate" }] }),
        ev(2, "tool", "submit_candidate", "fixed"),
        ev(3, "artifact", "Candidate sealed", "", { candidateDigest: D1 }),
      ],
    );
    const turn = items.find((i) => i.type === "assistant");
    expect(turn?.type).toBe("assistant");
    if (turn?.type !== "assistant") return;
    expect(turn.planned).toEqual(["submit_candidate"]);
    expect(turn.tools[0]?.verification?.verificationRecordId).toBe("ver1");
    expect(turn.tools[0]?.verification?.outcome).toBe("checks failed");
  });
  test("a submission links by sealed digest, not by count", () => {
    const t = task({
      candidateDigest: D1,
      candidates: [
        { attemptId: "att1", candidateDigest: D2, verificationRecordId: "ver1", outcome: "INCONCLUSIVE" },
        { attemptId: "att2", candidateDigest: D1, verificationRecordId: "ver2", outcome: "CHECKS_FAILED" },
      ],
    });
    const unsealed = buildThread(t, [ev(1, "model", "m", "", {}), ev(2, "tool", "submit_candidate", "x")]);
    const first = unsealed.find((i) => i.type === "assistant");
    expect(first?.type === "assistant" ? first.tools[0]?.verification : "x").toBeNull();
    const sealed = buildThread(t, [ev(1, "model", "m", "", {}), ev(2, "tool", "submit_candidate", "x"), ev(3, "artifact", "Candidate sealed", "", { candidateDigest: D1 })]);
    const second = sealed.find((i) => i.type === "assistant");
    expect(second?.type === "assistant" ? second.tools[0]?.verification?.verificationRecordId : null).toBe("ver2");
  });
});

describe("repair availability (U5)", () => {
  test("disabled says why and that only the baseline is measured", () => {
    const n = repairNotice({ available: false, reason: "No live-gate receipt for glm-5.3 on kata.", driver: "vultr" }, null);
    expect(n.title).toBe("Live repair is disabled");
    expect(n.body).toContain("No live-gate receipt");
    expect(n.body).toContain("baseline only");
  });
  test("a scripted diagnostics driver is described as diagnostics, not as baseline-only live runs", () => {
    const n = repairNotice({ available: false, reason: "scripted diagnostics driver: runs are diagnostics, not model repairs", driver: "scripted" }, null);
    expect(n.title).toBe("Diagnostics driver");
    expect(n.body).toContain("no model is called");
    expect(n.body).not.toContain("baseline only");
  });
  test("unknown is never presented as available", () => {
    expect(repairNotice(null, "HTTP 500").title).toBe("Repair availability unknown");
  });
  test("available cites the gate evidence", () => {
    const n = repairNotice(
      { available: true, reason: "ok", driver: "vultr", model: "m", runtime: "kata", evidence: { path: "p", passed: 2, attempts: 3, revision: "abc", recordedAt: AT, model: "m", runtime: "kata", profileId: "tabulate-365", contractDigest: D1 } },
      null,
    );
    expect(n.tone).toBe("ok");
    expect(n.body).toContain("2/3");
  });
});

describe("diagnostics (G6) and refusals (item 9)", () => {
  test("diagnostic label and issue text", () => {
    expect(isDiagnostic({ scriptedDriver: "forged-log" })).toBe(true);
    expect(isDiagnostic({})).toBe(false);
    const text = diagnosticIssueText({ name: "forged-log", title: "Forged success log" });
    expect(text.split("\n")[0]).toBe("Diagnostic: Forged success log");
    expect(text).toContain(DIAGNOSTIC_LABEL);
  });
  test("429 capacity vs rate limit, 403 role", () => {
    expect(refusalLead(429, "no execution slot free")).toBe("Execution host at capacity, try again shortly.");
    expect(refusalLead(429, "execution host at capacity (4 sandboxes)")).toBeNull();
    expect(refusalLead(429, "hostile runs are limited to one per 10 s per session")).toBe("Rate limited, try again shortly.");
    expect(refusalLead(403)).toBe("Not allowed for this role.");
    expect(refusalLead(500)).toBeNull();
  });
});
