/**
 * Sidebar rows for the task list: a title from the issue's first line, the profile, a status dot,
 * an outcome badge and a relative time. Pure, so the derivation is testable without a DOM.
 *
 * The dot and badge restate `Task.status` / `Task.outcome` exactly as the control plane recorded
 * them; nothing here infers success from anything else.
 */
import type { Task } from "@airlock/contracts";
import { isTerminalStatus, OUTCOME_LABEL, outcomeTone, PHASE_LABEL, STATUS_LABEL, type Tone } from "./format";
import { cleanupView, profileShortName } from "./general";

export const TITLE_MAX = 120;

export type TaskDot = "queued" | "running" | "cancelling" | "ok" | "warn" | "bad" | "neutral";

export interface TaskRowView {
  id: string;
  title: string;
  profileId: string;
  dot: TaskDot;
  /** True while the worker may still change the task (the dot pulses). */
  live: boolean;
  badge: { label: string; tone: Tone };
  /** ISO time the row's relative time is computed from (last update). */
  at: string;
  relative: string;
  /** Set on diagnostic runs driven by a scripted model (never a live repair). */
  scripted: string | null;
  kind: "repair" | "general";
  /** What the row names as its profile: the id for repair, a short profile name for general tasks. */
  profileLabel: string;
  /** General tasks only: the cleanup dimension, shown beside the result once it matters. */
  cleanup: { label: string; tone: Tone } | null;
}

/**
 * The issue's first non-empty line, as plain text: leading Markdown heading/quote markers and
 * surrounding whitespace are stripped (the text is never rendered as Markdown), runs of whitespace
 * collapse, and the result is bounded.
 */
export function issueTitle(issueText: string, max = TITLE_MAX): string {
  const line = issueText
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*(?:#{1,6}\s+|>\s*)+/, "").replace(/\s+/g, " ").trim())
    .find((l) => l.length > 0);
  if (!line) return "(empty issue)";
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/** Compact relative time like a chat roster: "now", "42s", "5m", "3h", "2d", then a date. */
export function relativeTime(iso: string, nowMs: number): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const seconds = Math.max(0, Math.round((nowMs - t) / 1000));
  if (seconds < 10) return "now";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function taskDot(task: Pick<Task, "status" | "outcome">): TaskDot {
  switch (task.status) {
    case "queued":
      return "queued";
    case "running":
      return "running";
    case "cancelling":
      return "cancelling";
    case "cancelled":
      return "neutral";
    case "failed":
      return "bad";
    case "done": {
      if (!task.outcome) return "neutral";
      const tone = outcomeTone(task.outcome);
      return tone === "info" ? "neutral" : tone;
    }
  }
}

export function taskBadge(task: Pick<Task, "status" | "outcome" | "phase">): { label: string; tone: Tone } {
  if (task.outcome) return { label: OUTCOME_LABEL[task.outcome], tone: outcomeTone(task.outcome) };
  if (task.status === "running") return { label: PHASE_LABEL[task.phase], tone: "info" };
  if (task.status === "failed") return { label: STATUS_LABEL.failed, tone: "bad" };
  if (task.status === "cancelling") return { label: STATUS_LABEL.cancelling, tone: "warn" };
  return { label: STATUS_LABEL[task.status], tone: "neutral" };
}

export function taskRowView(task: Task, nowMs: number): TaskRowView {
  const at = task.updatedAt || task.createdAt;
  return {
    id: task.id,
    title: issueTitle(task.issueText),
    profileId: task.profileId,
    dot: taskDot(task),
    live: task.status === "queued" || task.status === "running" || task.status === "cancelling",
    badge: taskBadge(task),
    at,
    relative: relativeTime(at, nowMs),
    scripted: task.scriptedDriver ?? null,
    kind: task.kind === "general" ? "general" : "repair",
    profileLabel: task.kind === "general" ? profileShortName(task.profileId) : task.profileId,
    cleanup: generalCleanupBadge(task),
  };
}

/** Shown once a sandbox existed or the task ended; hidden for repair tasks (their cleanup lives in events). */
export function generalCleanupBadge(task: Pick<Task, "kind" | "cleanup" | "status">): { label: string; tone: Tone } | null {
  if (task.kind !== "general") return null;
  if ((task.cleanup === undefined || task.cleanup.status === "none") && !isTerminalStatus(task.status)) return null;
  const c = cleanupView(task.cleanup, task.status);
  return { label: c.label, tone: c.tone };
}

/** Newest first by creation time, id as a stable tie-break. */
export function sortTasks(tasks: readonly Task[]): Task[] {
  return tasks.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
}

/** A roster request pending this many poll intervals is treated as stalled and restarted. */
export const ROSTER_STALE_POLLS = 3;

export type PollAction = "fetch" | "skip" | "restart";

/**
 * What a poll tick does. Nothing in flight: fetch. A request still pending: skip the tick, so a slow
 * API is allowed to answer instead of being aborted every interval. Pending for
 * ROSTER_STALE_POLLS intervals: restart it, and the caller says the list is stale.
 */
export function pollAction(inflightSinceMs: number | null, nowMs: number, pollMs: number): PollAction {
  if (inflightSinceMs === null) return "fetch";
  return nowMs - inflightSinceMs >= pollMs * ROSTER_STALE_POLLS ? "restart" : "skip";
}

export function staleRosterMessage(inflightSinceMs: number, nowMs: number): string {
  const seconds = Math.max(0, Math.round((nowMs - inflightSinceMs) / 1000));
  return `The case list has not refreshed for ${seconds} s (the API has not answered); retrying.`;
}
