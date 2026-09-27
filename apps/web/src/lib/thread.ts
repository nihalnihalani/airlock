/**
 * The task as a conversation, built ONLY from the authoritative Task record and its RunEvents.
 *
 *   user       the issue text exactly as submitted (first message)
 *   assistant  one per `model` event: the turn's text, followed by the tool calls it made
 *   tool       a sandbox execution that no model turn made (baseline/candidate invocations)
 *   mark       phase changes, checkpoints, lifecycle, artifacts, errors: a row between messages
 *   result     the terminal outcome as recorded on the task, with the recorded reason
 *   working    the task can still change (queued/running/cancelling)
 *
 * Grouping rule: a `model` event opens a turn; `tool`/`exec` events, and `error` events naming a
 * failed tool, attach to the open turn; any other event closes it. Nothing here decides whether a
 * run passed: tones restate recorded fields (`data.passed`, `probe.allBlocked`, exec status).
 *
 * Dispatch trail (U4): each tool call carries plan → dispatch → observation → verification. The
 * plan is the model turn's requested tool; the dispatch is the supervisor operation the controller
 * made for it (or "not dispatched" when the controller refused it before any effect); the
 * observation is what came back (exit code and stdout tail, bytes, chars); a `submit_candidate` is
 * linked to the candidate sealed after it (by digest) and that candidate's verification record.
 */
import type { ExecResult, Outcome, Phase, RunEvent, Task, TaskStatus } from "@airlock/contracts";
import { candidateRows, type CandidateRow } from "./evidence";
import { toExecRow, toModelCallRow, type ModelCallRow } from "./eventViews";
import { isTerminalStatus, OUTCOME_HINT, OUTCOME_LABEL, outcomeTone, PHASE_LABEL, STATUS_LABEL, type Tone } from "./format";

export const MODEL_TOOLS = ["run", "read_file", "edit_file", "write_file", "submit_candidate"] as const;

export type ToolState = "ok" | "failed" | "refused" | "rejected" | "error";

export interface ToolCall {
  seq: number;
  at: string;
  /** Model tool name, or the invocation role (`baseline`, `candidate`) for system executions. */
  name: string;
  title: string;
  /** Command for `run`/invocations, path for file tools. */
  target: string | null;
  state: ToolState;
  result: ExecResult | null;
  /** The event detail (bounded by the contract): edit diff, submit summary, refusal reason. */
  detail: string;
  /** `read_file` reported a truncated read. */
  readTruncated: boolean;
  /** The supervisor operation made for this call, or null when nothing was dispatched. */
  operation: string | null;
  /** `data.operationId` when the control plane records it. */
  operationId: string | null;
  /** What came back, in one line. */
  observation: string;
  /** For `submit_candidate`: the sealed candidate and its verification record, in order. */
  verification: CandidateRow | null;
}

export type ThreadItem =
  | { type: "user"; key: string; at: string; text: string; profileId: string; scriptedDriver: string | null }
  | {
      type: "assistant";
      key: string;
      seq: number;
      at: string;
      text: string;
      turn: ModelCallRow;
      reasoning: string | null;
      tools: ToolCall[];
      /** Tool names the turn requested (plan), in order. */
      planned: string[];
    }
  | { type: "tool"; key: string; call: ToolCall }
  | { type: "mark"; key: string; seq: number; at: string; kind: RunEvent["kind"]; title: string; detail: string; tone: Tone; phase: Phase | null }
  | {
      type: "result";
      key: string;
      status: TaskStatus;
      outcome: Outcome | null;
      label: string;
      tone: Tone;
      /** The recorded reason: the `Outcome …` phase event detail, else `task.error`. */
      reason: string | null;
      /** What the outcome label means, verbatim from OUTCOME_HINT. */
      hint: string | null;
    }
  | { type: "working"; key: string; status: TaskStatus; phase: Phase };

type Data = Record<string, unknown>;

function record(value: unknown): Data | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Data) : null;
}

const PHASES: readonly string[] = ["prepare", "baseline", "reproduce", "repair", "execute", "freeze", "verify", "ready"];

function isPhase(value: string): value is Phase {
  return PHASES.includes(value);
}

/** `read_file refused` → read_file; `run: ls` → run; data.tool wins when present. */
export function toolNameOf(ev: RunEvent): string {
  const data = record(ev.data);
  const fromData = data?.["tool"];
  if (typeof fromData === "string" && fromData.length > 0) return fromData.slice(0, 64);
  const first = ev.title.trim().split(/\s+/)[0] ?? "";
  return first.replace(/:$/, "").slice(0, 64) || ev.kind;
}

function toolState(ev: RunEvent, result: ExecResult | null): ToolState {
  const data = record(ev.data);
  if (ev.kind === "error") return "error";
  if (/\brefused\b/i.test(ev.title) || data?.["refused"] !== undefined) return "refused";
  if (/\brejected\b|\bcut off\b/i.test(ev.title)) return "rejected";
  if (result && result.status !== "succeeded") return "failed";
  return "ok";
}

const OPERATION: Record<string, string> = {
  run: "supervisor exec in the author sandbox",
  read_file: "supervisor read from the author sandbox",
  edit_file: "supervisor read + write in the author sandbox",
  write_file: "supervisor write in the author sandbox",
  submit_candidate: "controller: freeze, collect, seal, verify externally",
  baseline: "supervisor invoke: one-shot baseline sandbox",
  candidate: "supervisor invoke: one-shot candidate sandbox",
};

function firstLine(text: string, max = 160): string {
  const line = text.split("\n").find((l) => l.trim().length > 0)?.trim() ?? "";
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

function lastLine(text: string, max = 160): string {
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  const line = lines[lines.length - 1]?.trim() ?? "";
  return line.length > max ? `…${line.slice(line.length - max)}` : line;
}

/** Plan → dispatch → observation for one call; `state` decides whether anything was dispatched. */
export function dispatchOf(name: string, state: ToolState, ev: Pick<RunEvent, "detail" | "data">, result: ExecResult | null): { operation: string | null; observation: string } {
  const data = record(ev.data);
  if (state === "refused" || state === "rejected") {
    // A refused path or an invalid call is stopped by the controller before any sandbox effect;
    // a supervisor refusal carries `data.refused` and did reach the supervisor.
    const reachedSupervisor = typeof data?.["refused"] === "string";
    return {
      operation: reachedSupervisor ? (OPERATION[name] ?? "supervisor") : null,
      observation: `${state}: ${firstLine(typeof data?.["refused"] === "string" ? (data["refused"] as string) : ev.detail) || "no reason recorded"}`,
    };
  }
  if (state === "error") return { operation: OPERATION[name] ?? null, observation: `error: ${firstLine(ev.detail) || "no detail"}` };
  if (result) {
    const tailText = lastLine(result.stdout) || lastLine(result.stderr);
    const exit = result.exitCode === null ? result.status : `exit ${result.exitCode}`;
    return { operation: OPERATION[name] ?? "supervisor", observation: `${exit}${result.timedOut ? " (timed out)" : ""}${tailText ? ` · ${tailText}` : " · no output"}` };
  }
  if (name === "write_file" || name === "edit_file") {
    const bytes = typeof data?.["byteLength"] === "number" ? `${data["byteLength"] as number} bytes written` : firstLine(ev.detail);
    return { operation: OPERATION[name] ?? null, observation: bytes || "no detail" };
  }
  if (name === "submit_candidate") return { operation: OPERATION[name] ?? null, observation: "accepted; the model is told no result" };
  return { operation: OPERATION[name] ?? null, observation: firstLine(ev.detail) || "no detail" };
}

export function toToolCall(ev: RunEvent): ToolCall {
  const row = toExecRow(ev);
  const data = record(ev.data);
  const name = toolNameOf(ev);
  const state = toolState(ev, row.result);
  const trail = dispatchOf(name, state, ev, row.result);
  const operationId = typeof data?.["operationId"] === "string" ? (data["operationId"] as string).slice(0, 128) : null;
  return {
    seq: ev.seq,
    at: ev.at,
    name,
    title: ev.title,
    target: row.command ?? row.path,
    state,
    result: row.result,
    detail: ev.detail,
    readTruncated: data?.["truncated"] === true,
    operation: trail.operation,
    operationId,
    observation: trail.observation,
    verification: null,
  };
}

/** An `error` event raised by a tool call inside a turn: "<tool> failed". */
function isToolError(ev: RunEvent): boolean {
  if (ev.kind !== "error") return false;
  const m = /^(\S+) failed$/.exec(ev.title);
  return m !== null && (MODEL_TOOLS as readonly string[]).includes(m[1] ?? "");
}

function markTone(ev: RunEvent): Tone {
  const data = record(ev.data);
  switch (ev.kind) {
    case "error":
      return "bad";
    case "check": {
      if (/dev-unsafe/i.test(ev.title) || data?.["devUnsafe"] === true) return "warn";
      if (typeof data?.["passed"] === "boolean") return data["passed"] ? "ok" : "bad";
      const probe = record(data?.["probe"]);
      if (probe && typeof probe["allBlocked"] === "boolean") return probe["allBlocked"] ? "ok" : "bad";
      return "neutral";
    }
    case "lifecycle":
      return /^teardown incomplete/i.test(ev.title) ? "bad" : "neutral";
    case "artifact":
      return "info";
    default:
      return "neutral";
  }
}

function toMark(ev: RunEvent): Extract<ThreadItem, { type: "mark" }> {
  const phase = ev.kind === "phase" && isPhase(ev.title) ? ev.title : null;
  return {
    type: "mark",
    key: `mark-${ev.seq}`,
    seq: ev.seq,
    at: ev.at,
    kind: ev.kind,
    // A check recorded on a dev-unsafe runtime says so in its title, not only in its colour.
    title: phase ? PHASE_LABEL[phase] : ev.kind === "check" && record(ev.data)?.["devUnsafe"] === true && !/dev-unsafe/i.test(ev.title) ? `${ev.title} (dev-unsafe)` : ev.title,
    detail: ev.detail,
    tone: markTone(ev),
    phase,
  };
}

const OUTCOME_TITLE = /^Outcome ([A-Z_]+)$/;

export function buildThread(task: Task | null, events: readonly RunEvent[]): ThreadItem[] {
  const items: ThreadItem[] = [];
  if (task) {
    items.push({
      type: "user",
      key: "issue",
      at: task.createdAt,
      text: task.issueText,
      profileId: task.profileId,
      scriptedDriver: task.scriptedDriver ?? null,
    });
  }

  let open: Extract<ThreadItem, { type: "assistant" }> | null = null;
  const outcomeReasons = new Map<string, string>();
  const candidates = task ? candidateRows(task) : [];
  // A submission is linked to the candidate the controller sealed after it ("Candidate sealed"
  // carries data.candidateDigest), never by counting: attempts can end without a submission.
  let pendingSubmit: ToolCall | null = null;

  for (const ev of events) {
    if (ev.kind === "phase") {
      const m = OUTCOME_TITLE.exec(ev.title);
      if (m?.[1]) {
        outcomeReasons.set(m[1], ev.detail);
        open = null;
        continue;
      }
    }
    if (ev.kind === "model") {
      const data = record(ev.data);
      const reasoning = typeof data?.["reasoning"] === "string" ? (data["reasoning"] as string) : null;
      const turn = toModelCallRow(ev);
      open = {
        type: "assistant",
        key: `turn-${ev.seq}`,
        seq: ev.seq,
        at: ev.at,
        text: ev.detail,
        turn,
        reasoning,
        tools: [],
        planned: turn.toolCalls,
      };
      items.push(open);
      continue;
    }
    if (ev.kind === "tool" || ev.kind === "exec" || isToolError(ev)) {
      const call = toToolCall(ev);
      if (call.name === "submit_candidate" && call.state === "ok") pendingSubmit = call;
      if (open && (ev.kind !== "exec" || (MODEL_TOOLS as readonly string[]).includes(call.name))) {
        open.tools.push(call);
      } else {
        open = null;
        items.push({ type: "tool", key: `tool-${ev.seq}`, call });
      }
      continue;
    }
    if (ev.kind === "artifact" && pendingSubmit) {
      const digest = record(ev.data)?.["candidateDigest"];
      if (typeof digest === "string") {
        pendingSubmit.verification = candidates.find((c) => c.candidateDigest === digest) ?? null;
        pendingSubmit = null;
      }
    }
    open = null;
    items.push(toMark(ev));
  }

  if (task) {
    if (task.outcome) {
      items.push({
        type: "result",
        key: "result",
        status: task.status,
        outcome: task.outcome,
        label: OUTCOME_LABEL[task.outcome],
        tone: outcomeTone(task.outcome),
        reason: outcomeReasons.get(task.outcome) ?? task.error ?? null,
        hint: OUTCOME_HINT[task.outcome],
      });
    } else if (isTerminalStatus(task.status)) {
      items.push({
        type: "result",
        key: "result",
        status: task.status,
        outcome: null,
        label: STATUS_LABEL[task.status],
        tone: task.status === "cancelled" ? "neutral" : "bad",
        reason: task.error ?? null,
        hint: null,
      });
    } else {
      items.push({ type: "working", key: "working", status: task.status, phase: task.phase });
    }
  }
  return items;
}
