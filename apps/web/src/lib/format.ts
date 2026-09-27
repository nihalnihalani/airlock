import type { Outcome, Phase, TaskStatus } from "@airlock/contracts";

export function shortSha(sha: string, length = 12): string {
  return sha.length > length ? sha.slice(0, length) : sha;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "?";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

export function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "?";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes} min ${seconds} s`;
}

export function formatSeconds(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "?";
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const parts: string[] = [];
  if (days > 0) parts.push(`${days} d`);
  if (hours > 0 || days > 0) parts.push(`${hours} h`);
  parts.push(`${minutes} min`);
  return parts.join(" ");
}

export function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString(undefined, { hour12: false });
}

export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { hour12: false });
}

/** Last `maxLines` lines, each bounded to `maxChars`. Never throws on odd input. */
export function tail(text: string, maxLines = 12, maxChars = 4000): { text: string; clipped: boolean } {
  if (typeof text !== "string" || text.length === 0) return { text: "", clipped: false };
  const lines = text.split("\n");
  const kept = lines.slice(Math.max(0, lines.length - maxLines));
  let out = kept.join("\n");
  let clipped = kept.length < lines.length;
  if (out.length > maxChars) {
    out = out.slice(out.length - maxChars);
    clipped = true;
  }
  return { text: out, clipped };
}

export const OUTCOME_LABEL: Record<Outcome, string> = {
  NOT_REPRODUCED: "Not reproduced",
  REPRODUCED_UNRESOLVED: "Reproduced, unresolved",
  CANDIDATE_PASSED_CHECKS: "Passed these checks",
  CHECKS_FAILED: "Checks failed",
  INCONCLUSIVE: "Inconclusive",
  STOPPED_LIMIT: "Stopped at limit",
  RESULT_VERIFIED: "Result verified",
  RESULT_PARTIAL: "Partial result",
  RESULT_FAILED: "No acceptable result",
  UNSUPPORTED: "Unsupported",
};

export const OUTCOME_HINT: Record<Outcome, string> = {
  NOT_REPRODUCED: "The baseline run did not show the reported failure, so there was nothing to repair.",
  REPRODUCED_UNRESOLVED: "The reported failure reproduced on the baseline, but no candidate passed the frozen cases.",
  CANDIDATE_PASSED_CHECKS:
    "Exactly the frozen contract cases passed on a fresh, sealed copy of the candidate. This is not a claim that the change is safe, certified or correct in general.",
  CHECKS_FAILED: "A candidate was sealed and verified, and at least one frozen case did not pass.",
  INCONCLUSIVE: "Verification could not complete (timeout, protocol error, launch failure or incomplete output). Nothing passed.",
  STOPPED_LIMIT: "The run stopped at a budget or deadline limit before a verdict.",
  RESULT_VERIFIED: "Every completion check of the task profile passed on the collected outputs and evidence. The checks are finite; this is not a guarantee of correctness.",
  RESULT_PARTIAL: "Outputs were produced, but at least one required completion check did not pass.",
  RESULT_FAILED: "No output met the task profile's completion checks.",
  UNSUPPORTED: "The goal needs a capability this deployment does not offer; nothing was simulated.",
};

export const PHASE_LABEL: Record<Phase, string> = {
  prepare: "Prepare",
  reproduce: "Reproduce",
  baseline: "Baseline",
  repair: "Repair",
  execute: "Execute",
  freeze: "Freeze",
  verify: "Verify",
  ready: "Ready",
};

export const STATUS_LABEL: Record<TaskStatus, string> = {
  queued: "Queued",
  running: "Running",
  cancelling: "Cancelling",
  cancelled: "Cancelled",
  done: "Done",
  failed: "Failed",
};

export function isTerminalStatus(status: TaskStatus): boolean {
  return status === "done" || status === "failed" || status === "cancelled";
}

export function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** Display tone for a chip or dot. Tones restate authoritative fields; they never decide anything. */
export type Tone = "neutral" | "ok" | "warn" | "bad" | "info";

export function outcomeTone(outcome: Outcome): Tone {
  if (outcome === "CANDIDATE_PASSED_CHECKS" || outcome === "RESULT_VERIFIED") return "ok";
  if (outcome === "INCONCLUSIVE" || outcome === "STOPPED_LIMIT" || outcome === "NOT_REPRODUCED" || outcome === "RESULT_PARTIAL" || outcome === "UNSUPPORTED") return "warn";
  return "bad";
}

export function statusTone(status: TaskStatus): Tone {
  if (status === "running" || status === "queued") return "info";
  if (status === "done") return "neutral";
  if (status === "cancelling") return "warn";
  return "bad";
}

/**
 * The URL, if and only if it is an absolute http(s) URL; null otherwise. Anything else (javascript:,
 * data:, relative paths) is shown as text, never used as an href.
 */
export function httpUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}
