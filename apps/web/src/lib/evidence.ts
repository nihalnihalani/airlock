/**
 * Pure projections for the milestone-2 evidence views: Vultr instance ids, host vs guest kernel,
 * the blast-radius card's host-wide listing, workspace and siblings, cleanup status, candidates,
 * budget, repair availability and API refusals. Every function restates recorded fields; none of
 * them decides a verdict. Absent fields are reported as absent, never guessed.
 */
import {
  HostListing,
  TeardownRecord,
  type BlastRadiusCard,
  type HostCheck,
  type RepairAvailability,
  type RunEvent,
  type RuntimeInspection,
  type Task,
} from "@airlock/contracts";
import { isTerminalStatus, type Tone } from "./format";

// --- Diagnostics label ------------------------------------------------------------------------

export const DIAGNOSTIC_LABEL = "Diagnostic (scripted, not a model)";

/**
 * The issue text a diagnostic task is created with. It is a label, not an issue: the scripted
 * driver ignores it, and the roster title makes the run recognisable as a diagnostic.
 */
export function diagnosticIssueText(script: { name: string; title: string }): string {
  const title = script.title.trim().length > 0 ? script.title.trim() : script.name;
  return `Diagnostic: ${title}\n\n${DIAGNOSTIC_LABEL}. Scripted driver "${script.name}" replays fixed turns; no model is called and this is not a live repair.`;
}

export function isDiagnostic(task: Pick<Task, "scriptedDriver">): boolean {
  return typeof task.scriptedDriver === "string" && task.scriptedDriver.length > 0;
}

// --- U1: instance ids -------------------------------------------------------------------------

export const NOT_DEPLOYED = "not deployed (local)";

export interface InstanceIds {
  control: string | null;
  execution: string | null;
  /** True only when at least one Vultr instance id was reported. */
  deployed: boolean;
}

/**
 * The execution host's id comes from the supervisor's own host check when it has one (it is the
 * machine that ran the sandbox); the control plane's report is the fallback.
 */
export function instanceIds(availability: RepairAvailability | null | undefined, host: HostCheck | null | undefined): InstanceIds {
  const nonEmpty = (v: string | undefined | null): string | null => (typeof v === "string" && v.trim().length > 0 ? v.trim() : null);
  const control = nonEmpty(availability?.instances?.control);
  const execution = nonEmpty(host?.instanceId) ?? nonEmpty(availability?.instances?.execution);
  return { control, execution, deployed: control !== null || execution !== null };
}

// --- U2: host kernel beside the guest kernel --------------------------------------------------

/**
 * The kernel release out of a `uname -a` line (`Linux <host> <release> #<build> …`), or the text
 * itself when it is a bare release (`uname -r`). Null when nothing usable is there.
 */
export function kernelRelease(uname: string | null | undefined): string | null {
  if (typeof uname !== "string") return null;
  const parts = uname.trim().split(/\s+/).filter((p) => p.length > 0);
  if (parts.length === 0) return null;
  if (parts.length >= 3 && /^[A-Za-z]/.test(parts[0] ?? "")) return parts[2] ?? null;
  return parts[0] ?? null;
}

export type KernelVerdict = "differs" | "same" | "unknown";

export interface KernelComparison {
  hostRelease: string | null;
  guestRelease: string | null;
  verdict: KernelVerdict;
  tone: Tone;
  /** One sentence, shown next to the two unames. */
  note: string;
}

export function compareKernels(hostUname: string | null | undefined, inspection: Pick<RuntimeInspection, "guestUname" | "runtime" | "devUnsafe">): KernelComparison {
  const hostRelease = kernelRelease(hostUname);
  const guestRelease = kernelRelease(inspection.guestUname);
  if (!hostRelease || !guestRelease) {
    return {
      hostRelease,
      guestRelease,
      verdict: "unknown",
      tone: "neutral",
      note: hostRelease ? "The guest did not report a kernel release." : "The execution host has not reported its own uname, so the kernels cannot be compared.",
    };
  }
  if (hostRelease !== guestRelease) {
    const why =
      inspection.runtime === "kata"
        ? "the sandbox boots its own guest kernel in a Kata VM"
        : inspection.runtime === "runsc"
          ? "gVisor answers syscalls from its user-space kernel"
          : null;
    // runc shares the Docker daemon's kernel: a different release only means the supervisor's own
    // host is not the Docker host (e.g. macOS with Docker in a VM). It is not an isolation boundary.
    if (why === null)
      return { hostRelease, guestRelease, verdict: "differs", tone: "warn", note: "Kernels differ only because the supervisor's host is not the Docker host; runc shares the Docker host's kernel, so this is not isolation (dev-unsafe)." };
    return { hostRelease, guestRelease, verdict: "differs", tone: "ok", note: `Kernels differ: ${why}.` };
  }
  return {
    hostRelease,
    guestRelease,
    verdict: "same",
    tone: "bad",
    note:
      inspection.runtime === "runc" || inspection.devUnsafe
        ? "Same kernel: plain runc shares the host kernel (dev-unsafe, local development only)."
        : `Same kernel release as the host although the runtime is ${inspection.runtime}.`,
  };
}

// --- U3 / checkpoint 5: host-wide listing -------------------------------------------------------

export type ListingState = "empty" | "remaining" | "not-recorded";

export interface ListingSummary {
  state: ListingState;
  containers: HostListing["containers"];
  volumes: string[];
  listedAt: string | null;
  /** "(no sandboxes)" appears ONLY when the host-wide listing exists and is empty. */
  label: string;
  tone: Tone;
}

export function hostListingSummary(teardown: Pick<TeardownRecord, "host"> | null | undefined): ListingSummary {
  const host = teardown?.host;
  if (!host) {
    return { state: "not-recorded", containers: [], volumes: [], listedAt: null, label: "host-wide listing not recorded", tone: "warn" };
  }
  if (host.containers.length === 0 && host.volumes.length === 0) {
    return { state: "empty", containers: [], volumes: [], listedAt: host.listedAt, label: "(no sandboxes)", tone: "ok" };
  }
  const n = host.containers.length;
  const v = host.volumes.length;
  const parts = [n > 0 ? `${n} container${n === 1 ? "" : "s"}` : null, v > 0 ? `${v} volume${v === 1 ? "" : "s"}` : null].filter(Boolean);
  return { state: "remaining", containers: host.containers, volumes: host.volumes, listedAt: host.listedAt, label: `${parts.join(" and ")} still on the host`, tone: "warn" };
}

/** The attempt's own teardown: whatever the supervisor still owns for this attempt. */
export function attemptTeardownClean(teardown: Pick<TeardownRecord, "clean" | "containersRemaining" | "volumesRemaining">): boolean {
  return teardown.clean && teardown.containersRemaining.length === 0 && teardown.volumesRemaining.length === 0;
}

// --- U3: blast radius ---------------------------------------------------------------------------

export function workspaceSummary(workspace: BlastRadiusCard["workspace"]): { text: string; tone: Tone } {
  if (!workspace) return { text: "not recorded", tone: "neutral" };
  if (workspace.filesAfter === null) return { text: `${workspace.filesBefore} → unreadable after the command`, tone: "neutral" };
  const destroyed = Math.max(0, workspace.filesBefore - workspace.filesAfter);
  return {
    text: `${workspace.filesBefore} → ${workspace.filesAfter} (${destroyed} destroyed)`,
    tone: destroyed > 0 ? "bad" : "neutral",
  };
}

export interface SiblingRow {
  attemptId: string;
  taskId: string;
  runningBefore: boolean;
  runningAfter: boolean;
  /** Was running before and still is after the hostile run. */
  survived: boolean;
}

export function siblingRows(survived: BlastRadiusCard["survived"]): SiblingRow[] | null {
  if (!survived.siblings) return null;
  return survived.siblings.map((s) => ({ ...s, survived: !s.runningBefore || s.runningAfter }));
}

/** Everything the card says survived; control-plane health counts only when recorded. */
export function blastContained(card: BlastRadiusCard): boolean {
  const s = card.survived;
  const siblingsOk = (siblingRows(s) ?? []).every((r) => r.survived);
  const controlOk = !s.controlPlane || (s.controlPlane.healthyBefore ? s.controlPlane.healthyAfter : true);
  return s.supervisorHealthy && s.hostSentinelUnchanged && siblingsOk && controlOk;
}

// --- Item 9: cleanup status, separate from the result -----------------------------------------

export type CleanupState = "none" | "active" | "pending" | "confirmed" | "incomplete" | "unconfirmed";

export interface CleanupStatus {
  state: CleanupState;
  label: string;
  tone: Tone;
  detail: string | null;
  /** Host-wide listing recorded with the last teardown, when there was one. */
  listing: ListingSummary | null;
}

const CREATED = /^Author sandbox created/i;
const DESTROYED = /^(Attempt destroyed|Discarded attempt)/i;
const INCOMPLETE = /^Teardown incomplete/i;

/**
 * From the lifecycle events: was the author sandbox created, and was its teardown confirmed? The
 * one-shot baseline/candidate sandboxes carry their own teardown in checkpoint 5.
 */
export function cleanupStatus(task: Pick<Task, "status">, events: readonly RunEvent[]): CleanupStatus {
  let state: "none" | "live" | "destroyed" | "incomplete" = "none";
  let last: RunEvent | null = null;
  for (const ev of events) {
    if (ev.kind !== "lifecycle") continue;
    if (CREATED.test(ev.title)) {
      state = "live";
      last = ev;
    } else if (INCOMPLETE.test(ev.title)) {
      state = "incomplete";
      last = ev;
    } else if (DESTROYED.test(ev.title)) {
      state = "destroyed";
      last = ev;
    }
  }
  const teardown = last ? TeardownRecord.safeParse((last.data as Record<string, unknown> | undefined)?.["teardown"]) : null;
  const listing = teardown?.success ? hostListingSummary(teardown.data) : null;
  const detail = last?.detail ? last.detail : null;
  switch (state) {
    case "none":
      return task.status === "cancelling"
        ? { state: "pending", label: "cleanup pending", tone: "warn", detail: null, listing: null }
        : { state: "none", label: "no sandbox to clean up", tone: "neutral", detail: null, listing: null };
    case "incomplete":
      return { state: "incomplete", label: "teardown incomplete", tone: "bad", detail, listing };
    case "destroyed":
      return { state: "confirmed", label: "cleanup confirmed", tone: "ok", detail, listing };
    case "live":
      if (task.status === "cancelling") return { state: "pending", label: "cleanup pending", tone: "warn", detail: null, listing: null };
      if (isTerminalStatus(task.status)) return { state: "unconfirmed", label: "teardown not confirmed", tone: "bad", detail: null, listing: null };
      return { state: "active", label: "sandbox live", tone: "info", detail: null, listing: null };
  }
}

// --- U4: candidates and budget ----------------------------------------------------------------

export interface CandidateRow {
  index: number;
  attemptId: string;
  candidateDigest: string;
  verificationRecordId: string | null;
  outcome: string;
  tone: Tone;
  current: boolean;
}

const CANDIDATE_OUTCOME: Record<string, { label: string; tone: Tone }> = {
  PASSED_CHECKS: { label: "passed these checks", tone: "ok" },
  CHECKS_FAILED: { label: "checks failed", tone: "bad" },
  INCONCLUSIVE: { label: "inconclusive", tone: "warn" },
};

/** Task.candidates, or (older records) the single sealed candidate. */
export function candidateRows(task: Pick<Task, "candidates" | "candidateDigest" | "verificationRecordId" | "attemptId">): CandidateRow[] {
  const list =
    task.candidates && task.candidates.length > 0
      ? task.candidates
      : task.candidateDigest
        ? [{ attemptId: task.attemptId ?? "—", candidateDigest: task.candidateDigest, ...(task.verificationRecordId ? { verificationRecordId: task.verificationRecordId } : {}) }]
        : [];
  return list.map((c, i) => {
    const o = "outcome" in c && c.outcome ? CANDIDATE_OUTCOME[c.outcome] : undefined;
    return {
      index: i + 1,
      attemptId: c.attemptId,
      candidateDigest: c.candidateDigest,
      verificationRecordId: c.verificationRecordId ?? null,
      outcome: o ? o.label : c.verificationRecordId ? "verified (see record)" : "not verified yet",
      tone: o ? o.tone : "neutral",
      current: c.candidateDigest === task.candidateDigest,
    };
  });
}

export function budgetRows(budget: Task["budget"]): { key: string; value: string }[] {
  const rows = [
    { key: "model calls", value: String(budget.modelCallsUsed) },
    { key: "repair attempts", value: String(budget.repairAttemptsUsed) },
  ];
  if (budget.tokensUsed !== undefined) rows.push({ key: "tokens", value: budget.tokensUsed.toLocaleString("en-US") });
  if (budget.attemptModelCalls !== undefined || budget.attemptTokens !== undefined)
    rows.push({
      key: "this attempt",
      value: `${budget.attemptModelCalls ?? "?"} calls · ${budget.attemptTokens !== undefined ? budget.attemptTokens.toLocaleString("en-US") : "?"} tokens`,
    });
  if (budget.recoveries !== undefined) rows.push({ key: "recoveries", value: String(budget.recoveries) });
  return rows;
}

// --- U5: repair availability ------------------------------------------------------------------

export interface RepairNotice {
  tone: Tone;
  title: string;
  body: string;
}

/** A server reason as a sentence: capitalised, ending in punctuation. */
export function sentence(text: string): string {
  const t = text.trim();
  if (!t) return t;
  const cap = t[0]!.toUpperCase() + t.slice(1);
  return /[.!?:]$/.test(cap) ? cap : `${cap}.`;
}

export function repairNotice(availability: RepairAvailability | null, error: string | null): RepairNotice {
  if (!availability) {
    return {
      tone: "warn",
      title: "Repair availability unknown",
      body: error
        ? `The control plane did not say whether live repair is backed by evidence (${error}). A new case may run reproduction and baseline only.`
        : "Checking whether live repair is backed by evidence…",
    };
  }
  if (!availability.available && availability.driver !== "vultr") {
    return {
      tone: "warn",
      title: "Diagnostics driver",
      body: `${sentence(availability.reason)} This control plane runs scripted diagnostics: a case replays a labelled fixed script through the real sandbox, freeze and comparator; no model is called.`,
    };
  }
  if (!availability.available) {
    return {
      tone: "warn",
      title: "Live repair is disabled",
      body: `${sentence(availability.reason)} A case started now reproduces the issue and measures the baseline only; no repair is attempted.`,
    };
  }
  const ev = availability.evidence;
  const parts = [availability.model ? `model ${availability.model}` : null, availability.runtime ? `runtime ${availability.runtime}` : null].filter(Boolean);
  return {
    tone: "ok",
    title: "Live repair available",
    body: `${parts.length > 0 ? `${parts.join(" on ")}. ` : ""}${ev ? `Live gate: ${ev.passed}/${ev.attempts} fresh attempts passed the external comparator (${ev.revision}, ${ev.recordedAt.slice(0, 10)}).` : availability.reason}`,
  };
}

// --- Item 8/9: refusals -----------------------------------------------------------------------

export type Refusal = "signin" | "forbidden" | "notfound" | "capacity" | "unavailable" | "other";

export function refusalOf(status: number): Refusal {
  if (status === 401) return "signin";
  if (status === 403) return "forbidden";
  if (status === 404) return "notfound";
  if (status === 429) return "capacity";
  if (status === 0 || status === 502 || status === 503) return "unavailable";
  return "other";
}

/**
 * A short lead in front of the server's own message; the message itself is always kept. A 429 is
 * either a per-session rate limit (the message says "limited to …") or the execution host at its
 * concurrent-sandbox capacity.
 */
export function refusalLead(status: number, message = ""): string | null {
  switch (refusalOf(status)) {
    case "signin":
      return "Sign in first.";
    case "forbidden":
      return "Not allowed for this role.";
    case "notfound":
      return "Not found, or not yours to read.";
    case "capacity":
      if (/\blimited to\b|rate.?limit|too many/i.test(message)) return "Rate limited, try again shortly.";
      // "a hostile run is already in progress": the server's words say it; this is not capacity.
      if (/in progress/i.test(message)) return null;
      // The server already said so: do not repeat it.
      return /capacity/i.test(message) ? null : "Execution host at capacity, try again shortly.";
    case "unavailable":
      return "The control plane or execution host is unreachable.";
    default:
      return null;
  }
}
