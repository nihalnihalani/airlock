/**
 * General tasks (doc 40 Stage 3 / §6): pure projections of the Task record and its RunEvents into
 * what the task page renders. Nothing here decides a result: tones restate recorded fields
 * (`data.opState`, `task.outcome`, `task.cleanup`, `task.result.checks`).
 *
 * Event `data` keys read here, as apps/control/src/general-handler.ts writes them:
 *   tool/exec   tool, opState (started|completed|failed|unknown), operationId, attemptId,
 *               requestedUrl, finalUrl, status, egressDenied, policy, host, visitedUrl, title,
 *               textChars, controls, pendingReview, errorCode, artifactId, sha256, byteLength,
 *               result (ExecResult), exitCode, files, outputs, sources, unsupportedCapability
 *   model       model, host, durationMs, usage, toolCalls[].name, finishReason, imageAttached,
 *               imageArtifactId, imageSha256, reasoning
 *   artifact    artifactId, kind, sha256, url, width, height, capturedAt, step, path, byteLength,
 *               frame (screenshot frames), actor (agent|human|observer|controller), downloadId
 *   lifecycle   control { holder, humanOwner, since, reason }, proposalId, status, waitingForReview,
 *               proposal { … }, receipt { receiptId, payloadDigest, at }
 *
 * Milestone 5 tools: browser_download_list / browser_download_save / browser_propose_submit (the
 * model's), approved_submit (the controller's, after an approval), live_view (a read-only frame) and
 * human_* (a person holding control). Their tool events carry `actor`.
 */
import { ExecResult, type Artifact, type Outcome, type Phase, type RunEvent, type Task, type TaskResult, type TaskStatus } from "@airlock/contracts";
import { toModelCallRow, type ModelCallRow } from "./eventViews";
import { isTerminalStatus, OUTCOME_HINT, OUTCOME_LABEL, outcomeTone, PHASE_LABEL, type Tone } from "./format";

type Data = Record<string, unknown>;

function rec(value: unknown): Data | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Data) : null;
}
function str(value: unknown, max = 2048): string | null {
  return typeof value === "string" ? (value.length > max ? `${value.slice(0, max)}…` : value) : null;
}
function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function isGeneral(task: Pick<Task, "kind"> | null | undefined): boolean {
  return task?.kind === "general";
}

// --- Task profiles (GET /api/task-profiles) --------------------------------------------------------

/** Short display names for the sidebar; the API's displayName wins wherever the profile list is loaded. */
export const GENERAL_PROFILE_SHORT: Record<string, string> = {
  analysis: "File analysis",
  "web-research": "Web research",
  "web-analysis": "Web data analysis",
};

export function profileShortName(profileId: string): string {
  return GENERAL_PROFILE_SHORT[profileId] ?? profileId;
}

// --- Destination allowlist (mirrors apps/control/src/task-profiles.ts validateEgressAllow) --------

const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
const RESERVED_SUFFIXES = ["localhost", "local", "internal", "localdomain", "lan", "home", "corp", "intranet", "private", "arpa", "onion", "test", "invalid", "example"];

function looksLikeIp(host: string): boolean {
  if (host.includes(":")) return true; // IPv6 literal (also refused by the hostname pattern)
  const labels = host.split(".");
  return labels.every((l) => /^\d+$/.test(l)) || /^\d+$/.test(labels.at(-1) ?? "");
}

/** Normalises one typed entry: trims, lower-cases, strips a scheme/path/port someone pasted. */
export function normalizeDomainInput(raw: string): string {
  let s = raw.trim().toLowerCase();
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  s = s.split(/[/?#]/)[0] ?? "";
  if (!s.startsWith("[")) s = s.replace(/:\d+$/, "");
  return s.replace(/\.$/, "");
}

/** One entry: an exact hostname or `.suffix` (subdomains only). Returns the reason it is refused, or null. */
export function domainProblem(entry: string): string | null {
  if (entry.length === 0) return "empty";
  const suffix = entry.startsWith(".");
  const host = suffix ? entry.slice(1) : entry;
  const labels = host.split(".");
  if (host.length > 253) return "too long";
  if (!HOST_RE.test(host)) return looksLikeIp(host) ? "IP literals are not allowed" : "not a hostname";
  if (looksLikeIp(host)) return "IP literals are not allowed";
  if (labels.length < 2) return suffix ? "a suffix must name a registrable domain, not a top-level domain" : "single-label names are not allowed";
  if (RESERVED_SUFFIXES.includes(labels.at(-1)!) || host === "home.arpa" || labels.includes("localhost") || host.startsWith("metadata.")) {
    return "special-use or internal names are not allowed";
  }
  return null;
}

/** The whole list against a profile, as the server will judge it. */
export function domainListProblems(entries: readonly string[], profile: { browser: boolean; maxEgressHosts: number; id: string }): string[] {
  if (!profile.browser) return entries.length === 0 ? [] : [`profile "${profile.id}" has no browser; no destinations may be set`];
  if (entries.length === 0) return [`profile "${profile.id}" needs at least one allowed destination`];
  const reasons: string[] = [];
  if (entries.length > profile.maxEgressHosts) reasons.push(`at most ${profile.maxEgressHosts} destinations`);
  const seen = new Set<string>();
  for (const e of entries) {
    if (seen.has(e)) reasons.push(`${e}: duplicate`);
    seen.add(e);
    const p = domainProblem(e);
    if (p) reasons.push(`${e}: ${p}`);
  }
  return reasons;
}

// --- Uploads ------------------------------------------------------------------------------------

export const UPLOAD_MAX_BYTES = 10 * 1024 * 1024;

/** Explains an upload refusal in plain words; the server's own message follows verbatim. */
export function uploadErrorMessage(status: number, serverMessage: string): string {
  switch (status) {
    case 413:
      return `Too large (HTTP 413): each file is limited to 10 MiB, and your uploads together to the quota shown. ${serverMessage}`;
    case 415:
      return `Unsupported type (HTTP 415): the server sniffs the bytes and accepts PNG, JPEG, PDF, JSON, CSV (a .csv that parses) or UTF-8 text only. ${serverMessage}`;
    case 401:
    case 403:
      return `Not allowed (HTTP ${status}): sign in as operator or judge to upload. ${serverMessage}`;
    default:
      return serverMessage;
  }
}

export function shaPrefix(sha: string, n = 12): string {
  return sha.length > n ? sha.slice(0, n) : sha;
}

// --- Operation state (40 §6: allowed / started / completed / failed / unknown) ---------------------

export type OpState = "allowed" | "started" | "completed" | "failed" | "unknown";
const OP_STATES: readonly string[] = ["allowed", "started", "completed", "failed", "unknown"];

export function parseOpState(value: unknown): OpState | null {
  return typeof value === "string" && OP_STATES.includes(value) ? (value as OpState) : null;
}

export interface OpStateView {
  label: string;
  tone: Tone;
  note: string;
}

/**
 * How one operation's recorded state is shown. `started` on a terminal task never became an
 * answer: it is shown as "no outcome recorded", never as success.
 */
export function opStateView(state: OpState | null, taskTerminal: boolean, tool?: string): OpStateView {
  if (tool === "approved_submit" && state === "started")
    return { label: "step sent", tone: "neutral", note: "A controller step of an approved submission. Its outcome is recorded on the proposal (receipt), not per step." };
  switch (state) {
    case "allowed":
      return { label: "allowed", tone: "neutral", note: "Permitted by policy; not yet dispatched. Permission is not execution." };
    case "started":
      return taskTerminal
        ? { label: "no outcome recorded", tone: "warn", note: "Dispatched, but the task ended before an answer was recorded." }
        : { label: "started", tone: "info", note: "Recorded before dispatch; waiting for the supervisor's answer." };
    case "completed":
      return { label: "completed", tone: "ok", note: "The supervisor answered; the observation below is what came back." };
    case "failed":
      return { label: "failed", tone: "bad", note: "Refused or failed with a definite answer." };
    case "unknown":
      return { label: "outcome unknown", tone: "warn", note: "Outcome unknown; not retried. Whether it took effect cannot be known, so it was never replayed." };
    default:
      return { label: "state not recorded", tone: "neutral", note: "This event carries no operation state." };
  }
}

// --- Cleanup (Task.cleanup), separate from workflow and result ---------------------------------

export interface CleanupView {
  label: string;
  tone: Tone;
  detail: string | null;
  /** True only when the supervisor confirmed removal of every sandbox. */
  environmentGone: boolean;
  /** One sentence for the header. */
  sentence: string;
}

export function cleanupView(cleanup: Task["cleanup"] | undefined, status: TaskStatus): CleanupView {
  const detail = cleanup?.detail ?? null;
  switch (cleanup?.status) {
    case undefined:
      return { label: "not reported", tone: "neutral", detail: null, environmentGone: false, sentence: "The control plane reported no cleanup state for this task." };
    case "none":
      return isTerminalStatus(status)
        ? { label: "no sandbox created", tone: "neutral", detail, environmentGone: false, sentence: "No sandbox was recorded for this task, so there was nothing to remove." }
        : { label: "no sandbox yet", tone: "neutral", detail, environmentGone: false, sentence: "No sandbox has been created yet." };
    case "pending":
      return {
        label: isTerminalStatus(status) ? "cleanup pending" : "sandbox live",
        tone: isTerminalStatus(status) ? "warn" : "info",
        detail,
        environmentGone: false,
        sentence: "At least one sandbox may still exist; removal is not confirmed.",
      };
    case "retrying":
      return { label: "cleanup retrying", tone: "warn", detail, environmentGone: false, sentence: "Teardown is being retried; the environment may still exist." };
    case "failed":
      return { label: "cleanup failed", tone: "bad", detail, environmentGone: false, sentence: "Teardown was not confirmed; the environment may still exist." };
    case "confirmed":
      return { label: "cleanup confirmed", tone: "ok", detail, environmentGone: true, sentence: "The supervisor confirmed every sandbox of this task was destroyed." };
  }
}

// --- Workflow and result dimensions ---------------------------------------------------------------

export const GENERAL_PHASES: readonly Phase[] = ["prepare", "execute", "freeze", "verify", "ready"];

/** General runs recorded before "execute" existed used "repair" for the model loop. */
export function generalPhase(phase: Phase): Phase {
  return phase === "repair" || phase === "reproduce" || phase === "baseline" ? "execute" : phase;
}

/**
 * `waiting`: what the running task is blocked on, from the control plane's answers (a pending
 * proposal, a person holding browser control). It never changes the recorded status.
 */
export function workflowView(task: Pick<Task, "status" | "phase">, waiting?: { review?: boolean; humanControl?: boolean }): { label: string; tone: Tone } {
  const phase = PHASE_LABEL[generalPhase(task.phase)];
  switch (task.status) {
    case "queued":
      return { label: "Queued", tone: "neutral" };
    case "running":
      if (waiting?.review) return { label: "Running · waiting for review", tone: "warn" };
      if (waiting?.humanControl) return { label: "Running · a person holds control", tone: "warn" };
      return { label: `Running · ${phase}`, tone: "info" };
    case "cancelling":
      return { label: "Cancelling", tone: "warn" };
    case "cancelled":
      return { label: "Cancelled", tone: "neutral" };
    case "done":
      return { label: `Finished · ${phase}`, tone: "neutral" };
    case "failed":
      return { label: "Failed", tone: "bad" };
  }
}

export function resultView(task: Pick<Task, "status" | "outcome">): { label: string; tone: Tone; hint: string | null; outcome: Outcome | null } {
  if (task.outcome) return { label: OUTCOME_LABEL[task.outcome], tone: outcomeTone(task.outcome), hint: OUTCOME_HINT[task.outcome], outcome: task.outcome };
  if (task.status === "cancelled") return { label: "No result (cancelled)", tone: "neutral", hint: null, outcome: null };
  if (task.status === "failed") return { label: "No result recorded", tone: "bad", hint: null, outcome: null };
  return { label: "Not decided yet", tone: "neutral", hint: null, outcome: null };
}

export function exportable(outcome: Outcome | undefined): boolean {
  return outcome === "RESULT_VERIFIED" || outcome === "RESULT_PARTIAL";
}

// --- Completion checks --------------------------------------------------------------------------

export function checkSummary(checks: TaskResult["checks"] | undefined): { passed: number; failed: number; total: number; label: string; tone: Tone } {
  const list = checks ?? [];
  const passed = list.filter((c) => c.passed).length;
  const failed = list.length - passed;
  if (list.length === 0) return { passed: 0, failed: 0, total: 0, label: "no completion checks recorded", tone: "neutral" };
  return {
    passed,
    failed,
    total: list.length,
    label: failed === 0 ? `all ${list.length} checks passed` : `${failed} of ${list.length} checks failed`,
    tone: failed === 0 ? "ok" : "bad",
  };
}

// --- CSV preview (client side, bounded) -----------------------------------------------------------

export interface CsvPreview {
  header: string[];
  rows: string[][];
  /** Data rows beyond the preview bound were not shown. */
  moreRows: boolean;
  /** Columns beyond the bound were not shown. */
  moreColumns: boolean;
  error: string | null;
}

export const CSV_PREVIEW_ROWS = 50;
export const CSV_PREVIEW_COLS = 20;
const CSV_CELL_CHARS = 200;
const CSV_SCAN_CHARS = 512 * 1024;

/**
 * RFC 4180-style parse of at most `maxRows` data rows (plus the header) and `maxCols` columns.
 * Quoted fields may contain commas, quotes ("") and newlines. Cells are bounded. Never throws.
 */
export function parseCsvPreview(text: string, maxRows = CSV_PREVIEW_ROWS, maxCols = CSV_PREVIEW_COLS): CsvPreview {
  const src = text.length > CSV_SCAN_CHARS ? text.slice(0, CSV_SCAN_CHARS) : text;
  const records: string[][] = [];
  let field = "";
  let row: string[] = [];
  let quoted = false;
  let i = 0;
  let moreRows = false;
  let moreColumns = false;
  const cell = (s: string) => (s.length > CSV_CELL_CHARS ? `${s.slice(0, CSV_CELL_CHARS)}…` : s);
  const endRow = (): boolean => {
    row.push(cell(field));
    field = "";
    const blank = row.length === 1 && row[0] === "";
    if (!blank) {
      if (row.length > maxCols) moreColumns = true;
      records.push(row.slice(0, maxCols));
    }
    row = [];
    if (records.length > maxRows + 1) {
      moreRows = true;
      return false;
    }
    return true;
  };
  let stopped = false;
  while (i < src.length) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
      } else field += ch;
      i += 1;
      continue;
    }
    if (ch === '"' && field.length === 0) quoted = true;
    else if (ch === ",") {
      row.push(cell(field));
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i += 1;
      if (!endRow()) {
        stopped = true;
        break;
      }
    } else field += ch;
    i += 1;
  }
  if (!stopped && (field.length > 0 || row.length > 0)) endRow();
  if (records.length > maxRows + 1) {
    moreRows = true;
    records.length = maxRows + 1;
  }
  if (text.length > CSV_SCAN_CHARS) moreRows = true;
  const error = quoted && !stopped && text.length <= CSV_SCAN_CHARS ? "unterminated quoted field" : records.length === 0 ? "no rows" : null;
  const [header = [], ...rows] = records;
  return { header, rows, moreRows, moreColumns, error };
}

/** Pretty-printed JSON, or the reason it could not be parsed. Bounded. */
export function prettyJson(text: string, maxChars = 20000): { text: string; error: string | null; clipped: boolean } {
  try {
    const out = JSON.stringify(JSON.parse(text), null, 2);
    return { text: out.length > maxChars ? `${out.slice(0, maxChars)}…` : out, error: null, clipped: out.length > maxChars };
  } catch (err) {
    const t = text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
    return { text: t, error: err instanceof Error ? err.message : "not valid JSON", clipped: text.length > maxChars };
  }
}

export type PreviewKind = "image" | "csv" | "json" | "text" | "none";

export function previewKind(a: Pick<Artifact, "mediaType" | "filename">): PreviewKind {
  const t = a.mediaType.toLowerCase().split(";")[0]!.trim();
  if (t === "image/png" || t === "image/jpeg") return "image";
  if (t === "text/csv" || (t === "text/plain" && a.filename.toLowerCase().endsWith(".csv"))) return "csv";
  if (t === "application/json") return "json";
  if (t.startsWith("text/")) return "text";
  return "none";
}

/** Byte cap for fetching an artifact to preview it as text. */
export const PREVIEW_MAX_BYTES = 512 * 1024;

export function artifactHref(id: string, download = false): string {
  return `/api/artifacts/${encodeURIComponent(id)}${download ? "?download=1" : ""}`;
}

// --- Thread ---------------------------------------------------------------------------------------

export interface Operation {
  key: string;
  /** Seq of the first event of this operation. */
  seq: number;
  at: string;
  tool: string;
  operationId: string | null;
  attemptId: string | null;
  state: OpState | null;
  /** Title and detail of the latest event (the answer when one arrived, else the intent). */
  title: string;
  detail: string;
  data: Data;
  eventKind: RunEvent["kind"];
  seqs: number[];
}

export type GeneralItem =
  | { type: "goal"; key: string; at: string; text: string; profileId: string; scriptedDriver: string | null }
  | {
      type: "turn";
      key: string;
      seq: number;
      at: string;
      text: string;
      turn: ModelCallRow;
      reasoning: string | null;
      planned: string[];
      finishReason: string | null;
      image: { attached: boolean; artifactId: string | null; sha256: string | null };
      scripted: boolean;
      ops: Operation[];
      /** Operations and the lifecycle/error rows recorded while this turn's tools ran, in order. */
      rows: ({ type: "op"; key: string; op: Operation } | GeneralMarkItem)[];
      notes: { seq: number; title: string; detail: string }[];
    }
  | { type: "op"; key: string; op: Operation }
  | GeneralMarkItem
  | { type: "working"; key: string; status: TaskStatus; phase: Phase }
  | { type: "result"; key: string };

export type GeneralMarkItem = { type: "mark"; key: string; seq: number; at: string; kind: RunEvent["kind"]; title: string; detail: string; tone: Tone; state: OpState | null };

export const GENERAL_TOOLS = [
  "browser_navigate",
  "browser_observe",
  "browser_click",
  "browser_type",
  "browser_key",
  "browser_scroll",
  "browser_screenshot",
  "browser_tabs",
  "browser_save_text",
  "code_write",
  "code_run",
  "code_read",
  "files_list",
  "submit_result",
  "browser_download_list",
  "browser_download_save",
  "browser_propose_submit",
  "approved_submit",
  "live_view",
] as const;

/** A person's action while holding control (`human_navigate`, `human_click`, `human_upload`, …). */
export function isHumanTool(tool: string): boolean {
  return /^human_[a-z_]{1,40}$/.test(tool);
}

function isThreadTool(tool: string): boolean {
  return (GENERAL_TOOLS as readonly string[]).includes(tool) || isHumanTool(tool);
}

function toolOf(ev: RunEvent): string {
  const t = str(rec(ev.data)?.["tool"], 64);
  if (t) return t;
  const first = ev.title.trim().split(/\s+/)[0] ?? "";
  return first.replace(/:$/, "").slice(0, 64) || ev.kind;
}

function inferState(ev: RunEvent): OpState | null {
  const s = parseOpState(rec(ev.data)?.["opState"]);
  if (s) return s;
  if (ev.kind === "error" || /\b(refused|rejected|failed)\b/i.test(ev.title)) return "failed";
  return null;
}

function markTone(ev: RunEvent, state: OpState | null): Tone {
  if (ev.kind === "error") return "bad";
  if (state === "failed") return "bad";
  if (state === "unknown") return "warn";
  if (ev.kind === "check") {
    const passed = rec(ev.data)?.["passed"];
    if (typeof passed === "boolean") return passed ? "ok" : "bad";
    if (/dev-unsafe/i.test(ev.title)) return "warn";
  }
  if (ev.kind === "artifact") return "info";
  if (ev.kind === "lifecycle" && /incomplete|not confirmed/i.test(ev.title)) return "bad";
  const d = rec(ev.data);
  if (d?.["waitingForReview"] === true) return "warn";
  switch (d?.["status"]) {
    case "confirmed":
      return "ok";
    case "failed":
      return "bad";
    case "outcome_unknown":
      return "warn";
    case "approved":
    case "claimed":
      return "info";
  }
  const control = rec(d?.["control"]);
  if (control?.["holder"] === "human" || control?.["holder"] === "transferring") return "warn";
  if (ev.kind === "check" && d?.["adapterRefusal"] === true) return "warn";
  return "neutral";
}

const OUTCOME_TITLE = /^Outcome ([A-Z_]+)$/;

/** The recorded reason for the outcome: the `Outcome X` phase event's detail. */
export function outcomeReason(events: readonly RunEvent[], outcome: Outcome | undefined): string | null {
  if (!outcome) return null;
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]!;
    if (ev.kind === "phase" && OUTCOME_TITLE.exec(ev.title)?.[1] === outcome) return ev.detail;
  }
  return null;
}

/**
 * The general task as a conversation. A `model` event opens a turn; tool/exec events of the
 * general tools attach to it as operations, merged by `operationId` (the `started` intent and the
 * answer are one card whose state is the latest recorded); artifact events inside a turn become
 * notes on it; everything else is a row between messages.
 */
export function buildGeneralThread(task: Task | null, events: readonly RunEvent[]): GeneralItem[] {
  const items: GeneralItem[] = [];
  if (task) {
    items.push({ type: "goal", key: "goal", at: task.createdAt, text: task.issueText, profileId: task.profileId, scriptedDriver: task.scriptedDriver ?? null });
  }
  const byOperation = new Map<string, Operation>();
  let open: Extract<GeneralItem, { type: "turn" }> | null = null;
  /** The latest operation of each tool, for artifact events that name no operation. */
  const lastOfTool = new Map<string, Operation>();
  const lastRow = (): { type: string; op?: Operation } | undefined => (open ? open.rows[open.rows.length - 1] : items[items.length - 1]);

  for (const ev of events) {
    const data = rec(ev.data) ?? {};
    if (ev.kind === "phase" && OUTCOME_TITLE.test(ev.title)) {
      open = null;
      continue;
    }
    if (ev.kind === "model") {
      const turn = toModelCallRow(ev);
      open = {
        type: "turn",
        key: `turn-${ev.seq}`,
        seq: ev.seq,
        at: ev.at,
        text: ev.detail,
        turn,
        reasoning: str(data["reasoning"], 4000),
        planned: turn.toolCalls,
        finishReason: str(data["finishReason"], 32),
        image: { attached: data["imageAttached"] === true, artifactId: str(data["imageArtifactId"], 64), sha256: str(data["imageSha256"], 64) },
        scripted: /^scripted/i.test(turn.model ?? "") || /^scripted/i.test(str(data["host"], 256) ?? ""),
        ops: [],
        rows: [],
        notes: [],
      };
      items.push(open);
      continue;
    }
    const tool = toolOf(ev);
    if ((ev.kind === "tool" || ev.kind === "exec") && isThreadTool(tool)) {
      const state = inferState(ev);
      const operationId = str(data["operationId"], 128);
      const existing = operationId ? byOperation.get(operationId) : undefined;
      if (existing) {
        existing.seqs.push(ev.seq);
        existing.state = state ?? existing.state;
        // The started intent carries no observation; any later event is the answer.
        existing.title = ev.title;
        existing.detail = ev.detail;
        existing.data = { ...existing.data, ...data };
        existing.eventKind = ev.kind;
        continue;
      }
      const op: Operation = {
        key: `op-${ev.seq}`,
        seq: ev.seq,
        at: ev.at,
        tool,
        operationId,
        attemptId: str(data["attemptId"], 128),
        state,
        title: ev.title,
        detail: ev.detail,
        data: { ...data },
        eventKind: ev.kind,
        seqs: [ev.seq],
      };
      // Consecutive live-view frames collapse into one compact row (the newest wins).
      const prev = lastRow();
      if (tool === "live_view" && prev?.type === "op" && prev.op?.tool === "live_view") {
        const merged = prev.op;
        merged.seqs.push(ev.seq);
        merged.state = state;
        merged.at = ev.at;
        merged.title = ev.title;
        merged.detail = ev.detail;
        merged.operationId = operationId;
        merged.data = { ...data, frames: (num(merged.data["frames"]) ?? 1) + 1 };
        if (operationId) byOperation.set(operationId, merged);
        lastOfTool.set(tool, merged);
        continue;
      }
      if (operationId) byOperation.set(operationId, op);
      lastOfTool.set(tool, op);
      if (open) {
        open.ops.push(op);
        open.rows.push({ type: "op", key: op.key, op });
      } else items.push({ type: "op", key: op.key, op });
      continue;
    }
    if (ev.kind === "artifact") {
      // A frame or a saved download names no operation: attach it to the operation that produced it.
      const actor = str(data["actor"], 32);
      const kind = data["kind"];
      const target =
        kind === "screenshot" && actor === "observer"
          ? lastOfTool.get("live_view")
          : kind === "screenshot" && actor === "human"
            ? lastOfTool.get("human_screenshot")
            : kind === "download" && actor === "human"
              ? lastOfTool.get("human_download_read")
              : kind === "download" && actor === "agent"
                ? lastOfTool.get("browser_download_save")
                : undefined;
      const artifactId = str(data["artifactId"], 64);
      if (target && artifactId && !target.data["savedArtifactId"]) {
        target.seqs.push(ev.seq);
        if (target.state === "started" || target.state === null) target.state = "completed";
        target.data = {
          ...target.data,
          savedArtifactId: artifactId,
          savedKind: kind,
          savedSha256: str(data["sha256"], 64),
          ...(typeof data["url"] === "string" ? { visitedUrl: data["url"] } : {}),
          ...(typeof data["capturedAt"] === "string" ? { capturedAt: data["capturedAt"] } : {}),
          ...(typeof data["byteLength"] === "number" ? { byteLength: data["byteLength"] } : {}),
          ...(typeof data["mediaType"] === "string" ? { mediaType: data["mediaType"] } : {}),
          ...(typeof data["path"] === "string" ? { path: data["path"] } : {}),
        };
        continue;
      }
    }
    if (ev.kind === "artifact" && open) {
      open.notes.push({ seq: ev.seq, title: ev.title, detail: ev.detail });
      continue;
    }
    const state = parseOpState(data["opState"]);
    const mark: GeneralMarkItem = { type: "mark", key: `mark-${ev.seq}`, seq: ev.seq, at: ev.at, kind: ev.kind, title: ev.kind === "phase" && ev.title in PHASE_LABEL ? `${PHASE_LABEL[ev.title as Phase]} phase` : ev.title, detail: ev.detail, tone: markTone(ev, state), state };
    // Sandbox lifecycle and errors raised while a turn's tools run stay inside that turn.
    if (open && (ev.kind === "lifecycle" || ev.kind === "error" || ev.kind === "info")) {
      open.rows.push(mark);
      continue;
    }
    open = null;
    items.push(mark);
  }
  if (task) {
    if (task.outcome || isTerminalStatus(task.status)) items.push({ type: "result", key: "result" });
    else items.push({ type: "working", key: "working", status: task.status, phase: task.phase });
  }
  return items;
}

// --- Per-tool observation ---------------------------------------------------------------------------

export interface Observation {
  /** One line for the card's summary. */
  summary: string;
  /** Plain-language explanation of a special refusal (stale reference, pending review, egress). */
  explain: string | null;
  url: string | null;
  pageTitle: string | null;
  /** Page text excerpt (browser_observe). */
  excerpt: string | null;
  /** Code as written (code_write). */
  code: string | null;
  exec: ExecResult | null;
  screenshot: { artifactId: string; sha256: string | null } | null;
  /** submit_result's claim. */
  claim: { summary: string; outputs: string[]; sources: string[]; unsupported: string | null } | null;
  files: string[] | null;
  /** browser_download_list: what the runner listed (names and URLs are untrusted). */
  downloads: { downloadId: string; suggestedFilename: string; url: string; state: string; bytes: number | null; reason: string | null }[] | null;
  /** browser_propose_submit: the proposal this call recorded. */
  proposal: { id: string; destination: string | null; formId: string | null } | null;
  /** A stored artifact this operation produced (saved download, frame). */
  saved: { artifactId: string; kind: string | null; sha256: string | null; path: string | null; byteLength: number | null } | null;
}

function afterFirstLine(text: string): string {
  const i = text.indexOf("\n");
  return i < 0 ? "" : text.slice(i + 1);
}

function strList(value: unknown, max = 100): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string").slice(0, max).map((v) => (v.length > 2048 ? `${v.slice(0, 2048)}…` : v)) : [];
}

export function observationOf(op: Operation): Observation {
  const d = op.data;
  const out: Observation = { summary: "", explain: null, url: null, pageTitle: null, excerpt: null, code: null, exec: null, screenshot: null, claim: null, files: null, downloads: null, proposal: null, saved: null };
  const savedId = str(d["savedArtifactId"], 64);
  if (savedId) out.saved = { artifactId: savedId, kind: str(d["savedKind"], 32), sha256: str(d["savedSha256"], 64), path: str(d["path"], 512), byteLength: num(d["byteLength"]) };
  const errorCode = str(d["errorCode"], 64);
  if (errorCode === "stale_reference") out.explain = "Stale reference: the page changed since the last observation, so the element reference no longer points at anything. The model must observe again; nothing was clicked or typed.";
  else if (errorCode === "pending_review") out.explain = "Pending review: the page opened a dialog that needs a human decision, so the action was not taken. A person can take control of the browser to handle it.";
  else if (errorCode === "navigation_failed") out.explain = "Navigation failed: the page could not be loaded. A destination outside the allowed list is refused by the egress proxy.";
  if (d["policy"] === "egress") out.explain = `Refused before dispatch: ${str(d["host"], 253) ?? "the host"} is outside the destinations you allowed. Nothing reached the network.`;
  if (d["interrupted"] === true) out.explain = "The browser session was lost during this operation. Whether it took effect is unknown; it was not replayed, and the next browser tool starts a fresh session.";

  if (op.tool === "approved_submit") {
    out.summary = "a step of an approved submission, driven by Airlock (not the model); the approval code is never shown or recorded";
    out.explain ??= "Airlock fills in exactly the approved values and a one-use approval code, then clicks Submit. The result is recorded on the proposal (confirmed with a receipt, failed, or outcome unknown), not per step. There is nothing else to display: the code itself is never recorded.";
    return out;
  }
  if (op.state === "started" && !out.saved) {
    out.summary = "dispatched; waiting for the answer";
    return out;
  }
  if (out.saved && (op.tool === "live_view" || op.tool === "human_screenshot")) out.screenshot = { artifactId: out.saved.artifactId, sha256: out.saved.sha256 };
  switch (op.tool) {
    case "browser_navigate": {
      out.url = str(d["finalUrl"]) ?? str(d["requestedUrl"]);
      if (d["egressDenied"] === true) {
        out.summary = "egress denied by the proxy";
        out.explain ??= "The egress proxy refused this destination: it is not on the allowed list.";
      } else if (op.state === "completed") out.summary = `status ${num(d["status"]) ?? "none"}`;
      else out.summary = op.detail.split("\n")[0] ?? "";
      break;
    }
    case "browser_observe": {
      out.url = str(d["visitedUrl"]);
      out.pageTitle = str(d["title"], 512);
      if (op.state === "completed") {
        const chars = num(d["textChars"]);
        const controls = num(d["controls"]);
        out.summary = `${chars ?? "?"} chars of text · ${controls ?? "?"} controls${d["pendingReview"] === true ? " · dialog pending review" : ""}`;
        const i = op.detail.indexOf("\n\n");
        out.excerpt = i >= 0 ? op.detail.slice(i + 2) : null;
      } else out.summary = op.detail.split("\n")[0] ?? "";
      break;
    }
    case "browser_screenshot": {
      out.url = str(d["visitedUrl"]);
      const id = str(d["artifactId"], 64);
      if (id && op.state === "completed") out.screenshot = { artifactId: id, sha256: str(d["sha256"], 64) };
      out.summary = id ? `stored as ${id}` : op.detail.split("\n")[0] ?? "";
      break;
    }
    case "code_write": {
      out.summary = op.detail.split("\n")[0] ?? "";
      if (op.state === "completed" && op.title.startsWith("code_write")) out.code = afterFirstLine(op.detail);
      break;
    }
    case "code_run": {
      const parsed = ExecResult.safeParse(d["result"]);
      out.exec = parsed.success ? parsed.data : null;
      out.summary = out.exec ? `${out.exec.status} · exit ${out.exec.exitCode ?? "—"}${out.exec.timedOut ? " · timed out" : ""}` : op.detail.split("\n")[0] ?? "";
      break;
    }
    case "browser_download_list": {
      const list = Array.isArray(d["downloads"]) ? (d["downloads"] as unknown[]) : [];
      out.downloads = list
        .map((x) => rec(x))
        .filter((x): x is Data => !!x && typeof x["downloadId"] === "string")
        .slice(0, 50)
        .map((x) => ({ downloadId: str(x["downloadId"], 16)!, suggestedFilename: str(x["suggestedFilename"], 200) ?? "", url: str(x["url"]) ?? "", state: str(x["state"], 32) ?? "?", bytes: num(x["bytes"]), reason: str(x["reason"], 100) }));
      out.summary = op.state === "completed" ? `${out.downloads.length} download(s)` : (op.detail.split("\n")[0] ?? "");
      break;
    }
    case "browser_download_save":
    case "human_download_read": {
      out.url = str(d["visitedUrl"]);
      out.summary = out.saved ? `stored as ${out.saved.artifactId}${out.saved.path ? ` · ${out.saved.path}` : ""}` : (op.detail.split("\n")[0] ?? "");
      break;
    }
    case "browser_propose_submit": {
      const id = str(d["proposalId"], 128);
      if (id) out.proposal = { id, destination: str(d["destination"], 512), formId: str(d["formId"], 128) };
      out.summary = id ? `proposal ${id} recorded; waiting for a person's review` : (op.detail.split("\n")[0] ?? "");
      if (d["policy"] === "final-action" && op.state === "failed") out.explain ??= "Refused: only forms on a supported destination can be proposed, with every field of the form exactly once.";
      break;
    }
    case "live_view": {
      const frames = num(d["frames"]);
      out.url = str(d["visitedUrl"]);
      out.summary = `${out.saved ? `frame ${out.saved.artifactId}` : (op.detail.split("\n")[0] ?? "")}${frames && frames > 1 ? ` · ${frames} frames` : ""}`;
      break;
    }
    case "files_list": {
      out.files = strList(d["files"]);
      out.summary = op.detail.split("\n")[0] ?? "";
      break;
    }
    case "submit_result": {
      const lines = op.detail.split("\n");
      const summaryText = lines.filter((l) => !/^(outputs|sources|unsupported): /.test(l)).join("\n");
      out.claim = { summary: summaryText, outputs: strList(d["outputs"]), sources: strList(d["sources"]), unsupported: str(d["unsupportedCapability"], 1000) };
      out.summary = "claim recorded; the controller checks it";
      break;
    }
    default: {
      out.url = str(d["visitedUrl"]);
      out.summary = op.detail.split("\n")[0] ?? "";
    }
  }
  if (out.summary.length > 200) out.summary = `${out.summary.slice(0, 200)}…`;
  return out;
}

/** Screenshot metadata from artifact events (capture time, dimensions), keyed by artifact id. */
export function screenshotMeta(events: readonly RunEvent[]): Map<string, { url: string | null; capturedAt: string | null; width: number | null; height: number | null; sha256: string | null }> {
  const m = new Map<string, { url: string | null; capturedAt: string | null; width: number | null; height: number | null; sha256: string | null }>();
  for (const ev of events) {
    if (ev.kind !== "artifact") continue;
    const d = rec(ev.data);
    const id = str(d?.["artifactId"], 64);
    if (!d || !id || d["kind"] !== "screenshot") continue;
    m.set(id, { url: str(d["url"]), capturedAt: str(d["capturedAt"], 64) ?? ev.at, width: num(d["width"]), height: num(d["height"]), sha256: str(d["sha256"], 64) });
  }
  return m;
}

// --- Budget -------------------------------------------------------------------------------------

export interface ProfileBudgets {
  modelCalls: number;
  tokens: number;
  wallClockMs: number;
  browserOps: number;
  codeRuns: number;
  browserSessions: number;
  codeSandboxes: number;
  recoveries: number;
  attemptMs: number;
}

export function generalBudgetRows(budget: Task["budget"], limits: ProfileBudgets | null): { key: string; value: string }[] {
  const of = (used: number | undefined, limit: number | undefined) => `${used ?? 0}${limit !== undefined ? ` / ${limit.toLocaleString("en-US")}` : ""}`;
  return [
    { key: "model calls", value: of(budget.modelCallsUsed, limits?.modelCalls) },
    { key: "tokens", value: `${(budget.tokensUsed ?? 0).toLocaleString("en-US")}${limits ? ` / ${limits.tokens.toLocaleString("en-US")}` : ""}` },
    { key: "browser ops", value: of(budget.browserOps, limits?.browserOps) },
    { key: "code runs", value: of(budget.codeRuns, limits?.codeRuns) },
    { key: "sessions", value: of(budget.sessions, limits ? limits.browserSessions + limits.codeSandboxes : undefined) },
    { key: "recoveries", value: of(budget.recoveries, limits?.recoveries) },
  ];
}

// --- Hero example (docs only) ----------------------------------------------------------------------

/**
 * The web-analysis hero from the labelled scripted fixture
 * (apps/control/test/fixtures/scripted-general/general-hero.json). It only fills the form; nothing is
 * sent until the user presses Start. For a live run the fixture page must be hosted at that domain.
 */
export const HERO_EXAMPLE = {
  profileId: "web-analysis",
  goal:
    "Open https://airlock-fixtures.example.com/regional-sales.html, read the regional sales table, and find the region with the lowest revenue-to-target ratio. " +
    "Save the table as inputs/regions.csv, analyse it with Python, and return outputs/summary.json (an object with a non-empty \"answer\") and outputs/chart.png (a bar chart of the ratio per region). " +
    "Cite the page as the source and take a screenshot of it as evidence.",
  domains: ["airlock-fixtures.example.com"],
  source: "apps/control/test/fixtures/scripted-general/general-hero.json",
} as const;

