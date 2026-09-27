/**
 * Human control, live view and supported final actions (40 Stage 5; audit 42 C22–C27): pure
 * projections of the control API's answers and the task's events into what the task page shows.
 * Nothing here grants anything: the control plane decides who holds the browser, the egress proxy
 * enforces the allowlist, and the destination enforces an approved payload. The UI restates.
 *
 * Routes (apps/control/src/api.ts, "human control, live view, supported final actions"):
 *   GET  /api/tasks/:id/control                 { control, live, idleMs }
 *   POST /api/tasks/:id/control/take|release    ControlState
 *   POST /api/tasks/:id/control/action          { request } → { ok, error?, artifactId?, result }
 *   GET  /api/tasks/:id/live                    { frame, frames, control, liveBrowser, refreshMinIntervalMs }
 *   POST /api/tasks/:id/live/refresh            { ok, artifactId, url }  (429 inside the rate limit)
 *   GET  /api/tasks/:id/approvals               ActionProposal[]
 *   POST /api/tasks/:id/approvals/:aid/decide   { decision, payloadDigest } → ActionProposal
 */
import { z } from "zod";
import { ActionProposal, BROWSER_KEYS, ControlState, sha256Hex, type RunEvent } from "@airlock/contracts";
import type { Tone } from "./format";

type Data = Record<string, unknown>;
function rec(value: unknown): Data | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Data) : null;
}
function str(value: unknown, max = 2048): string | null {
  return typeof value === "string" ? value.slice(0, max) : null;
}
function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// --- Response shapes ---------------------------------------------------------------------------------

export const LiveControlState = ControlState.extend({
  epoch: z.number().int().nonnegative(),
  attached: z.boolean(),
  liveBrowser: z.boolean(),
  idleExpiresAt: z.string().optional(),
});
export type LiveControlState = z.infer<typeof LiveControlState>;

export const ControlResponse = z.object({
  control: ControlState,
  /** null: the task's browser loop is not running in this control plane (nothing can be taken). */
  live: LiveControlState.nullable(),
  idleMs: z.number().nullable(),
});
export type ControlResponse = z.infer<typeof ControlResponse>;

export const LiveFrame = z.object({
  artifactId: z.string().max(128),
  url: z.string().max(2048),
  sourceUrl: z.string().max(4096).nullable(),
  tool: z.string().max(64).nullable(),
  createdAt: z.string(),
  sha256: sha256Hex,
  byteLength: z.number(),
});
export const LiveResponse = z.object({
  frame: LiveFrame.nullable(),
  frames: z.number().int().nonnegative(),
  control: ControlState,
  liveBrowser: z.boolean(),
  refreshMinIntervalMs: z.number().nullable(),
});
export type LiveResponse = z.infer<typeof LiveResponse>;

export const RefreshResponse = z.object({ ok: z.literal(true), artifactId: z.string().max(128), url: z.string().max(2048) });
export type RefreshResponse = z.infer<typeof RefreshResponse>;

/** The supervisor's reply to one human action, with png/contentBase64 removed by the control plane. */
export const ActionResponse = z.object({
  ok: z.boolean(),
  error: z.string().max(4096).optional(),
  artifactId: z.string().max(128).optional(),
  result: z
    .object({
      response: z
        .union([
          z.object({ ok: z.literal(true), op: z.string().nullable().optional(), result: z.unknown() }).passthrough(),
          z.object({ ok: z.literal(false), op: z.string().nullable().optional(), error: z.string(), message: z.string() }).passthrough(),
        ])
        .nullable(),
      status: z.enum(["completed", "interrupted", "refused"]),
      durationMs: z.number(),
      generationBefore: z.number().nullable().optional(),
    })
    .passthrough()
    .optional(),
});
export type ActionResponse = z.infer<typeof ActionResponse>;

export const ProposalList = z.array(ActionProposal).max(500);

// --- Who am I (the session's owner id is not published by GET /api/session) ------------------------------

const OWNER_KEY = "airlock-owner-id";

/**
 * The session's owner id as learned from a successful take (its `humanOwner` is the caller). Kept for
 * this browser tab only and cleared on sign-in/out; unknown until then.
 */
export function rememberOwnerId(id: string | undefined) {
  try {
    if (id) window.sessionStorage.setItem(OWNER_KEY, id);
    else window.sessionStorage.removeItem(OWNER_KEY);
  } catch {
    // not remembered
  }
}
export function knownOwnerId(): string | null {
  try {
    return window.sessionStorage.getItem(OWNER_KEY);
  } catch {
    return null;
  }
}

export interface Viewer {
  /** Owner id learned from a take in this tab (null: unknown). */
  ownerId: string | null;
  role: string;
  /** The task's owner. A judge only ever sees tasks its own session owns. */
  taskOwner: string;
}

/** true: the holder is this session; false: someone else; null: cannot tell from what the API gave us. */
export function holderIsViewer(humanOwner: string | undefined, viewer: Viewer): boolean | null {
  if (!humanOwner) return null;
  if (viewer.ownerId) return humanOwner === viewer.ownerId;
  if (viewer.role === "judge") return humanOwner === viewer.taskOwner;
  return null;
}

/** The session role recorded in the control reason ("taken by judge"), when present. */
export function roleFromReason(reason: string | undefined | null): string | null {
  const m = reason ? /\bby (operator|judge)\b/.exec(reason) : null;
  return m ? m[1]! : null;
}

// --- Control state display ---------------------------------------------------------------------------------

export interface ControlView {
  /** "Agent" | "Transferring" | "You" | "Another person" | "A person" */
  holder: string;
  tone: Tone;
  sentence: string;
  since: string;
  reason: string | null;
  /** Human control returns to the agent at this time without an action (holder human only). */
  idleExpiresAt: string | null;
  youHold: boolean;
  canTake: boolean;
  canRelease: boolean;
  /** Why take/release is unavailable, when it is. */
  unavailable: string | null;
  fenceGeneration: number | null;
}

export function controlView(resp: Pick<ControlResponse, "control" | "live"> | null, viewer: Viewer, opts: { running: boolean; canOperate: boolean }): ControlView {
  const c = resp?.live ?? resp?.control ?? null;
  const base = { since: c?.since ?? "", reason: c?.reason ?? null, fenceGeneration: c?.fenceGeneration ?? null, idleExpiresAt: null as string | null };
  const attached = resp?.live?.attached === true;
  let unavailable: string | null = null;
  if (!opts.canOperate) unavailable = "Sign in as operator or judge to control the browser.";
  else if (!opts.running) unavailable = "The task is not running; control applies only while it runs.";
  else if (!attached) unavailable = "The task's browser loop is not running in this control plane yet (or any more); control can be taken only while it runs.";
  const usable = unavailable === null;
  if (!c || c.holder === "agent") {
    return { ...base, holder: "Agent", tone: "neutral", sentence: "The agent drives the browser.", youHold: false, canTake: usable, canRelease: false, unavailable };
  }
  if (c.holder === "transferring") {
    return {
      ...base,
      holder: "Transferring",
      tone: "warn",
      sentence: "Nobody holds control: agent dispatch is revoked and the in-flight browser operation is settling. If it does not settle, take again or return control to the agent.",
      youHold: false,
      canTake: usable,
      canRelease: usable,
      unavailable,
    };
  }
  const me = holderIsViewer(c.humanOwner, viewer);
  const role = roleFromReason(c.reason);
  const idle = resp?.live && "idleExpiresAt" in resp.live ? (resp.live.idleExpiresAt ?? null) : null;
  if (me === true) {
    return { ...base, idleExpiresAt: idle, holder: "You", tone: "info", sentence: "You hold control; the agent is paused.", youHold: true, canTake: false, canRelease: usable, unavailable };
  }
  const who = me === false ? "Another person" : "A person";
  return {
    ...base,
    idleExpiresAt: idle,
    holder: who,
    tone: "warn",
    sentence: `${who}${role ? ` (${role})` : ""} holds control; the agent is paused.${me === null ? " This page cannot tell whether that is this session." : ""}`,
    youHold: false,
    // Taking again as the same session is idempotent; as another session the server answers 409.
    canTake: usable && me === null,
    canRelease: usable && (me === null || viewer.role === "operator"),
    unavailable,
  };
}

export const TAKE_EXPLANATION =
  "Taking control pauses the agent after its current browser step. Your actions keep the same allowed sites, deadline and budgets as the agent's, are recorded as yours, and a click is never an approval: a form on a supported destination is submitted only through a reviewed proposal.";
export const RELEASE_EXPLANATION = "Returning control resumes the agent. Every page snapshot from before is invalid: the agent must observe the page afresh before it clicks or types.";

/** A plain explanation for a refused control call; the server's own words follow. */
export function controlErrorMessage(status: number, serverMessage: string, action: "take" | "release" | "action" | "refresh" | "decide"): string {
  switch (status) {
    case 404:
      return `Not found (HTTP 404): this task or item is not visible to this session. ${serverMessage}`;
    case 409:
      if (action === "take" && /settle/i.test(serverMessage))
        return `Control was not granted (HTTP 409): the agent's in-flight browser step did not settle in time, so nobody holds control now. Take again, or return control to the agent. ${serverMessage}`;
      if (action === "action") return `Not done (HTTP 409): ${serverMessage}`;
      return `Conflict (HTTP 409): ${serverMessage}`;
    case 410:
      return `Expired (HTTP 410): ${serverMessage}. Nothing was submitted.`;
    case 422:
      return `Refused (HTTP 422): ${serverMessage}`;
    case 429:
      return action === "refresh" ? `Rate limited (HTTP 429): live view refresh is limited per task. ${serverMessage}` : `Rate limited (HTTP 429): ${serverMessage}`;
    default:
      return serverMessage;
  }
}

// --- Human actions --------------------------------------------------------------------------------------------

export const HUMAN_KEYS = BROWSER_KEYS;
export type HumanKey = (typeof BROWSER_KEYS)[number];

export interface ObservedControl {
  ref: string;
  role: string;
  name: string;
  value?: string | undefined;
  disabled?: boolean | undefined;
}
export interface Observation {
  generation: number;
  url: string;
  title: string;
  controls: ObservedControl[];
  controlsTruncated: boolean;
  pendingReview: boolean;
}

export function parseObservation(result: unknown): Observation | null {
  const r = rec(result);
  const generation = num(r?.["generation"]);
  if (!r || generation === null || !Array.isArray(r["controls"])) return null;
  const controls: ObservedControl[] = [];
  for (const c of r["controls"].slice(0, 300)) {
    const o = rec(c);
    const ref = str(o?.["ref"], 16);
    if (!o || !ref || !/^[a-z0-9]{1,16}$/i.test(ref)) continue;
    controls.push({ ref, role: str(o["role"], 64) ?? "", name: str(o["name"], 200) ?? "", value: str(o["value"], 200) ?? undefined, disabled: o["disabled"] === true ? true : undefined });
  }
  return { generation, url: str(r["url"]) ?? "", title: str(r["title"], 512) ?? "", controls, controlsTruncated: r["controlsTruncated"] === true, pendingReview: r["pendingReview"] === true };
}

/** The page generation and whether refs were invalidated, from any action result. */
export function generationAfter(result: unknown): { generation: number | null; invalidated: boolean } {
  const r = rec(result);
  return { generation: num(r?.["generation"]), invalidated: r?.["invalidated"] === true };
}

/**
 * Whether the controls of `obs` may still be used: the browser must be at the same generation and
 * nothing may have invalidated the refs since. Returns the reason they are stale, or null.
 */
export function staleReason(obs: Observation | null, latest: { generation: number | null; invalidated: boolean } | null): string | null {
  if (!obs) return "Observe the page first: clicks and typing need a control from the latest observation.";
  if (latest?.invalidated) return "The last action changed the page, so the observed controls are no longer valid. Observe again.";
  if (latest && latest.generation !== null && latest.generation !== obs.generation)
    return `The page moved on (generation ${obs.generation} → ${latest.generation}) since this observation. Observe again.`;
  return null;
}

export type UrlCheck = { ok: true; url: string; host: string; allowed: boolean } | { ok: false; problem: string };

/** Mirrors apps/control/src/task-profiles.ts hostAllowed: exact host, or `.suffix` for subdomains only. */
export function hostAllowed(host: string, allow: readonly string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return allow.some((entry) => (entry.startsWith(".") ? h.endsWith(entry) && h.length > entry.length : h === entry));
}

/** A typed URL: http(s), no credentials, bounded; and whether the allowlist admits it (the server decides). */
export function checkNavigateUrl(raw: string, allow: readonly string[]): UrlCheck {
  const s = raw.trim();
  if (s.length === 0) return { ok: false, problem: "Enter a URL." };
  if (s.length > 2048) return { ok: false, problem: "At most 2048 characters." };
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return { ok: false, problem: "Not a URL (include https://)." };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, problem: "Only http:// and https:// URLs." };
  if (u.username || u.password) return { ok: false, problem: "URLs with credentials are not allowed." };
  const host = u.hostname.toLowerCase();
  return { ok: true, url: s, host, allowed: hostAllowed(host, allow) };
}

export type HumanRequest =
  | { op: "navigate"; args: { url: string } }
  | { op: "observe" }
  | { op: "click"; args: { ref: string; generation: number } }
  | { op: "type"; args: { ref: string; generation: number; text: string; submit?: boolean } }
  | { op: "key"; args: { key: HumanKey; generation: number } }
  | { op: "scroll"; args: { dx?: number; dy?: number } }
  | { op: "screenshot"; args?: { fullPage?: boolean } }
  | { op: "download.list" }
  | { op: "download.read"; args: { downloadId: string } }
  | { op: "upload"; args: { ref: string; generation: number; artifactId: string } };

export type ActionForm =
  | { kind: "navigate"; url: string }
  | { kind: "observe" }
  | { kind: "click"; ref: string }
  | { kind: "type"; ref: string; text: string; submit: boolean }
  | { kind: "key"; key: string }
  | { kind: "scroll"; dy: string }
  | { kind: "screenshot"; fullPage: boolean }
  | { kind: "download.list" }
  | { kind: "download.read"; downloadId: string }
  | { kind: "upload"; ref: string; artifactId: string };

/**
 * Validate one action form against the latest observation and build the request body. Ref-bound
 * actions (click, type, key, upload) use the observation's generation; the server re-checks.
 */
export function buildHumanRequest(
  form: ActionForm,
  ctx: { observation: Observation | null; latest: { generation: number | null; invalidated: boolean } | null; allow: readonly string[] },
): { ok: true; request: HumanRequest } | { ok: false; problem: string } {
  const needsControl = (ref: string): { ok: true; generation: number } | { ok: false; problem: string } => {
    const stale = staleReason(ctx.observation, ctx.latest);
    if (stale) return { ok: false, problem: stale };
    if (!ref) return { ok: false, problem: "Pick a control from the latest observation." };
    const c = ctx.observation!.controls.find((x) => x.ref === ref);
    if (!c) return { ok: false, problem: `Control ${ref} is not in the latest observation. Observe again.` };
    if (c.disabled) return { ok: false, problem: `Control ${ref} is disabled on the page.` };
    return { ok: true, generation: ctx.observation!.generation };
  };
  switch (form.kind) {
    case "navigate": {
      const u = checkNavigateUrl(form.url, ctx.allow);
      if (!u.ok) return { ok: false, problem: u.problem };
      return { ok: true, request: { op: "navigate", args: { url: u.url } } };
    }
    case "observe":
      return { ok: true, request: { op: "observe" } };
    case "click": {
      const c = needsControl(form.ref);
      return c.ok ? { ok: true, request: { op: "click", args: { ref: form.ref, generation: c.generation } } } : c;
    }
    case "type": {
      const c = needsControl(form.ref);
      if (!c.ok) return c;
      if (form.text.length > 8192) return { ok: false, problem: "At most 8192 characters." };
      return { ok: true, request: { op: "type", args: { ref: form.ref, generation: c.generation, text: form.text, ...(form.submit ? { submit: true } : {}) } } };
    }
    case "key": {
      if (!(HUMAN_KEYS as readonly string[]).includes(form.key)) return { ok: false, problem: `Only these keys: ${HUMAN_KEYS.join(", ")}.` };
      const stale = staleReason(ctx.observation, ctx.latest);
      if (stale) return { ok: false, problem: stale };
      return { ok: true, request: { op: "key", args: { key: form.key as HumanKey, generation: ctx.observation!.generation } } };
    }
    case "scroll": {
      const s = form.dy.trim();
      if (!/^-?\d{1,5}$/.test(s)) return { ok: false, problem: "Scroll by a whole number of pixels between -10000 and 10000." };
      const dy = Number(s);
      if (dy < -10000 || dy > 10000 || dy === 0) return { ok: false, problem: "Scroll by a non-zero number of pixels between -10000 and 10000." };
      return { ok: true, request: { op: "scroll", args: { dy } } };
    }
    case "screenshot":
      return { ok: true, request: { op: "screenshot", ...(form.fullPage ? { args: { fullPage: true } } : {}) } };
    case "download.list":
      return { ok: true, request: { op: "download.list" } };
    case "download.read":
      if (!/^dl-[0-9]{1,6}$/.test(form.downloadId)) return { ok: false, problem: "Pick a completed download from the list." };
      return { ok: true, request: { op: "download.read", args: { downloadId: form.downloadId } } };
    case "upload": {
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(form.artifactId)) return { ok: false, problem: "Pick one of your uploaded files." };
      const c = needsControl(form.ref);
      return c.ok ? { ok: true, request: { op: "upload", args: { ref: form.ref, generation: c.generation, artifactId: form.artifactId } } } : c;
    }
  }
}

export type OpState = "completed" | "failed" | "unknown";

export interface ActionOutcomeView {
  opState: OpState;
  tone: Tone;
  label: string;
  /** Error code and message, verbatim. */
  error: string | null;
  /** A plain explanation of a special error. */
  explain: string | null;
}

/** How one action's answer is shown: completed / failed / unknown (interrupted), never guessed. */
export function actionOutcome(resp: ActionResponse): ActionOutcomeView {
  const raw = resp.result;
  const response = raw?.response ?? null;
  const code = response && response.ok === false ? String((response as { error: string }).error) : null;
  const message = response && response.ok === false ? String((response as { message: string }).message) : null;
  if (raw?.status === "interrupted")
    return {
      opState: "unknown",
      tone: "warn",
      label: "outcome unknown",
      error: resp.error ?? "browser_session_lost",
      explain: "The browser runner was lost during this action. Whether it took effect is unknown; it was not replayed, and the browser session is closed.",
    };
  if (resp.ok) return { opState: "completed", tone: "ok", label: "completed", error: null, explain: null };
  const error = code ? `${code}: ${message ?? ""}`.trim() : (resp.error ?? "refused");
  let explain: string | null = null;
  if (code === "stale_reference") explain = "Stale reference: the page changed since your observation, so that control no longer exists. Nothing was clicked or typed. Observe again.";
  else if (code === "pending_review") explain = "A dialog on the page needs a decision; the browser refuses mutating actions until it is handled.";
  else if (code === "navigation_failed") explain = "The page could not be loaded. A site outside the allowed list is refused by the egress proxy; a link that downloads a file shows up in the downloads list.";
  else if (/not an allowed destination/i.test(error)) explain = "Refused before dispatch: the site is outside this task's allowed list. Nothing reached the network.";
  return { opState: "failed", tone: "bad", label: "failed", error, explain };
}

export interface DownloadRow {
  downloadId: string;
  suggestedFilename: string;
  url: string;
  state: string;
  reason: string | null;
  bytes: number | null;
  mediaType: string | null;
}
export function parseDownloads(result: unknown): DownloadRow[] {
  const r = rec(result);
  const list = Array.isArray(r?.["downloads"]) ? (r!["downloads"] as unknown[]) : [];
  const out: DownloadRow[] = [];
  for (const d of list.slice(0, 50)) {
    const o = rec(d);
    const id = str(o?.["downloadId"], 16);
    if (!o || !id || !/^dl-[0-9]{1,6}$/.test(id)) continue;
    out.push({ downloadId: id, suggestedFilename: str(o["suggestedFilename"], 200) ?? "", url: str(o["url"]) ?? "", state: str(o["state"], 32) ?? "unknown", reason: str(o["reason"], 100), bytes: num(o["bytes"]), mediaType: str(o["mediaType"], 100) });
  }
  return out;
}

// --- Proposals ------------------------------------------------------------------------------------------

export type ProposalStatus = ActionProposal["status"];

export const PROPOSAL_STATUS: Record<ProposalStatus, { label: string; tone: Tone; note: string }> = {
  pending: { label: "waiting for review", tone: "warn", note: "Nothing is submitted until a person approves exactly these values." },
  approved: { label: "approved", tone: "info", note: "Approved; Airlock (not the model) will fill in exactly these values and submit." },
  rejected: { label: "rejected", tone: "neutral", note: "Rejected; nothing was submitted." },
  expired: { label: "expired", tone: "neutral", note: "No decision in time; nothing was submitted." },
  claimed: { label: "claimed", tone: "info", note: "The one-use approval was claimed; Airlock is filling in the form." },
  submitted: { label: "submitted", tone: "info", note: "The submit click was sent; waiting for the destination's receipt." },
  confirmed: { label: "confirmed", tone: "ok", note: "The destination's receipt matches the approved payload digest." },
  failed: { label: "failed", tone: "bad", note: "Not completed; nothing was re-submitted." },
  outcome_unknown: {
    label: "outcome unknown",
    tone: "warn",
    note: "Whether the destination recorded the submission is unknown. It was not retried; it is reconciled by reading the destination's receipt.",
  },
};

export function proposalStatusView(status: ProposalStatus) {
  return PROPOSAL_STATUS[status];
}

const LIFECYCLE: readonly ProposalStatus[] = ["pending", "approved", "claimed", "submitted", "confirmed"];

/**
 * The steps a proposal went through, for the lifecycle strip. A terminal side state (rejected,
 * expired, failed, outcome_unknown) ends the strip at the step where it happened.
 */
export function proposalLifecycle(status: ProposalStatus): { status: ProposalStatus; label: string; reached: boolean; current: boolean }[] {
  const side: Partial<Record<ProposalStatus, ProposalStatus>> = { rejected: "pending", expired: "pending", failed: "claimed", outcome_unknown: "submitted" };
  const at = side[status] ?? status;
  const idx = LIFECYCLE.indexOf(at);
  const steps = LIFECYCLE.map((s, i) => ({ status: s, label: PROPOSAL_STATUS[s].label, reached: i <= idx, current: s === status }));
  if (side[status]) return [...steps.slice(0, idx + 1), { status, label: PROPOSAL_STATUS[status].label, reached: true, current: true }];
  return steps;
}

export function isOpenProposal(p: Pick<ActionProposal, "status" | "expiresAt">, nowMs: number): boolean {
  return p.status === "pending" && Date.parse(p.expiresAt) > nowMs;
}

export function pendingProposals<T extends Pick<ActionProposal, "status" | "expiresAt">>(list: readonly T[], nowMs: number): T[] {
  return list.filter((p) => isOpenProposal(p, nowMs));
}

/** "4 min 05 s left" / "expired". */
export function expiryCountdown(expiresAt: string, nowMs: number): { text: string; expired: boolean; urgent: boolean } {
  const left = Date.parse(expiresAt) - nowMs;
  if (!Number.isFinite(left)) return { text: "expiry unknown", expired: false, urgent: false };
  if (left <= 0) return { text: "expired", expired: true, urgent: true };
  const s = Math.ceil(left / 1000);
  const m = Math.floor(s / 60);
  return { text: m > 0 ? `${m} min ${String(s % 60).padStart(2, "0")} s left` : `${s} s left`, expired: false, urgent: s <= 60 };
}

/**
 * The body of a decision: exactly the digest the reviewer was shown on the card. Never re-read from
 * the server before sending; the server compares it with the stored proposal (409 if different).
 */
export function decisionBody(shown: Pick<ActionProposal, "payloadDigest">, decision: "approve" | "reject"): { decision: "approve" | "reject"; payloadDigest: string } {
  return { decision, payloadDigest: shown.payloadDigest };
}

/** Field names in a stable order (code point), so the card lists them the same way every time. */
export function proposalFieldRows(fields: Record<string, string>): { name: string; value: string }[] {
  return Object.keys(fields)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((name) => ({ name, value: fields[name] ?? "" }));
}

/** A newer copy of a shown proposal that differs in what would be submitted (should never happen: proposals are immutable). */
export function proposalChanged(shown: Pick<ActionProposal, "payloadDigest" | "destination" | "formId" | "fields">, latest: Pick<ActionProposal, "payloadDigest" | "destination" | "formId" | "fields">): boolean {
  if (shown.payloadDigest !== latest.payloadDigest || shown.destination !== latest.destination || shown.formId !== latest.formId) return true;
  const a = proposalFieldRows(shown.fields);
  const b = proposalFieldRows(latest.fields);
  return a.length !== b.length || a.some((r, i) => r.name !== b[i]!.name || r.value !== b[i]!.value);
}

/**
 * Proposal ids announced as "Waiting for review" in the event stream and not yet decided or ended
 * there. Used for the banner even before (or without) the approvals list loading.
 */
export function reviewWaitingFromEvents(events: readonly RunEvent[]): string[] {
  const open = new Map<string, true>();
  for (const ev of events) {
    const d = rec(ev.data);
    const id = str(d?.["proposalId"], 128);
    if (!d || !id) continue;
    if (d["waitingForReview"] === true) open.set(id, true);
    else if (typeof d["status"] === "string" && d["status"] !== "pending") open.delete(id);
  }
  return [...open.keys()];
}

/** Roster tasks worth asking for proposals: running general tasks that have a browser (allowed sites), newest first, bounded. */
export function reviewCandidates(tasks: readonly { id: string; kind?: string | undefined; status: string; egressAllow?: readonly string[] | undefined }[], max = 8): string[] {
  return tasks
    .filter((t) => t.kind === "general" && t.status === "running" && (t.egressAllow?.length ?? 0) > 0)
    .slice(0, max)
    .map((t) => t.id);
}

// --- Human attribution in the thread ------------------------------------------------------------------

export interface ControlHolderAt {
  humanOwner: string | null;
  role: string | null;
}

/** Who held control after each control lifecycle event, by seq: used to attribute human_* operations. */
export function humanHolderBySeq(events: readonly RunEvent[]): (seq: number) => ControlHolderAt | null {
  const marks: { seq: number; holder: ControlHolderAt | null }[] = [];
  for (const ev of events) {
    const c = rec(rec(ev.data)?.["control"]);
    if (!c) continue;
    if (c["holder"] === "human") marks.push({ seq: ev.seq, holder: { humanOwner: str(c["humanOwner"], 128), role: roleFromReason(str(c["reason"], 512)) } });
    else if (typeof c["holder"] === "string") marks.push({ seq: ev.seq, holder: null });
  }
  return (seq: number) => {
    let found: ControlHolderAt | null = null;
    for (const m of marks) {
      if (m.seq > seq) break;
      found = m.holder;
    }
    return found;
  };
}

/** "you (judge)" / "a person (operator)" for a human operation's card. */
export function humanActorLabel(holder: ControlHolderAt | null, viewer: Viewer): string {
  const role = holder?.role ? ` (${holder.role})` : "";
  const me = holder?.humanOwner ? holderIsViewer(holder.humanOwner, viewer) : null;
  return me === true ? `you${role}` : `a person${role}`;
}

// --- Live frames ---------------------------------------------------------------------------------------------

export interface FrameView {
  artifactId: string;
  sha256: string | null;
  url: string | null;
  at: string;
  actor: string | null;
  seq: number | null;
}

/** The newest frame: the latest `artifact` event with `data.frame`, or the /live answer, whichever is newer. */
export function latestFrame(events: readonly RunEvent[], live: LiveResponse["frame"] | null): FrameView | null {
  let fromEvents: FrameView | null = null;
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]!;
    const d = rec(ev.data);
    if (ev.kind !== "artifact" || !d || d["kind"] !== "screenshot") continue;
    const id = str(d["artifactId"], 128);
    if (!id) continue;
    fromEvents = { artifactId: id, sha256: str(d["sha256"], 64), url: str(d["url"]), at: str(d["capturedAt"], 64) ?? ev.at, actor: str(d["actor"], 32), seq: ev.seq };
    break;
  }
  const fromLive: FrameView | null = live ? { artifactId: live.artifactId, sha256: live.sha256, url: live.sourceUrl, at: live.createdAt, actor: live.tool, seq: null } : null;
  if (!fromEvents) return fromLive;
  if (!fromLive) return fromEvents;
  if (fromLive.artifactId === fromEvents.artifactId) return fromEvents;
  return Date.parse(fromLive.at) > Date.parse(fromEvents.at) ? fromLive : fromEvents;
}

/** Milliseconds until another refresh is allowed (0: now). */
export function refreshWait(lastRefreshAtMs: number | null, minIntervalMs: number | null, nowMs: number): number {
  if (lastRefreshAtMs === null || !minIntervalMs) return 0;
  return Math.max(0, lastRefreshAtMs + minIntervalMs - nowMs);
}
