/**
 * The control plane's side of the `airlock-forms-v1` adapter (40 Stage 5, audit 42 C25–C27).
 *
 * Supported final actions are form submissions to a destination that ENFORCES the approval: the
 * controlled form service (apps/fixtures) accepts `POST /f/:formId/submit` only with a one-use
 * approval code whose HMAC binds exactly the submitted, normalized values. The pure pieces
 * (normalization, payload digest, approval code, receipts read token) are imported from
 * `@airlock/fixtures`, so the controller normalizes exactly as the destination does.
 *
 * This module adds what only the control plane does: which origins are configured as adapter
 * destinations (AIRLOCK_FORMS_ORIGINS), minting the code (the secret AIRLOCK_FORMS_SECRET never
 * leaves VM A and is never shown to the model or the browser page before approval), and reading a
 * receipt back from the destination with a server-side fetch pinned to the configured origin
 * (no redirects, bounded time and size).
 *
 * Generic arbitrary-site irreversible actions are NOT supported: no semantic intent detection from
 * button labels is claimed. Only destinations configured here, which enforce the code themselves,
 * can receive an approved submission.
 */
import { ADAPTER, APPROVAL_FIELD, destinationOrigin, formPayloadDigest, getForm, mintApprovalCode, normalizeFields, receiptsReadToken, type FormSpec, type NormalizeResult } from "@airlock/fixtures";

export { ADAPTER, APPROVAL_FIELD, getForm, normalizeFields, formPayloadDigest };
export type { FormSpec, NormalizeResult };

export interface FormsConfig {
  /** Origins (URL.origin) of configured airlock-forms-v1 destinations. */
  origins: string[];
  /** Shared HMAC secret with the destination (≥ 32 chars). Never logged, never sent to the model. */
  secret: string;
  /** Transport for receipt reads (tests inject the fixture app). Always called with redirect "error". */
  fetch?: typeof fetch;
  /** Per-read timeout (default 5 s). */
  receiptTimeoutMs?: number;
}

/** Parse AIRLOCK_FORMS_ORIGINS (comma-separated http(s) origins) into normalized origins. */
export function parseFormsOrigins(raw: string | undefined): string[] {
  const out: string[] = [];
  for (const part of (raw ?? "").split(",").map((p) => p.trim()).filter(Boolean)) {
    const origin = destinationOrigin(part);
    const url = new URL(part);
    if (url.username || url.password) throw new Error(`AIRLOCK_FORMS_ORIGINS entry ${part} must not carry credentials`);
    if (url.pathname !== "/" || url.search || url.hash) throw new Error(`AIRLOCK_FORMS_ORIGINS entry ${part} must be an origin (scheme://host[:port])`);
    if (!out.includes(origin)) out.push(origin);
  }
  return out;
}

/** The configured origin a form URL belongs to, with its form id from `/f/:formId`, or a reason. */
export function resolveFormUrl(config: FormsConfig | null | undefined, formUrl: string, formId: string): { ok: true; origin: string; url: string; form: FormSpec } | { ok: false; reason: string } {
  if (!config || config.origins.length === 0) return { ok: false, reason: "no supported final-action destination is configured on this control plane (AIRLOCK_FORMS_ORIGINS); arbitrary-site submissions are not supported" };
  let url: URL;
  try {
    url = new URL(formUrl);
  } catch {
    return { ok: false, reason: "formUrl is not a URL" };
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) return { ok: false, reason: "formUrl must be an http(s) URL without credentials" };
  if (!config.origins.includes(url.origin)) return { ok: false, reason: `${url.origin} is not a supported final-action destination (supported: ${config.origins.join(", ")}); arbitrary-site submissions are not supported` };
  const form = getForm(formId);
  if (!form) return { ok: false, reason: `form "${formId.slice(0, 64)}" is not a form of the airlock-forms-v1 adapter` };
  if (url.pathname !== `/f/${encodeURIComponent(formId)}` || url.search || url.hash) return { ok: false, reason: `formUrl must be exactly ${url.origin}/f/${encodeURIComponent(formId)}` };
  return { ok: true, origin: url.origin, url: `${url.origin}/f/${encodeURIComponent(formId)}`, form };
}

/** Is this URL a page of a configured adapter form (`/f/:formId` or its submit path)? */
export function adapterPath(config: FormsConfig | null | undefined, rawUrl: string | null | undefined): { origin: string; formId: string; submit: boolean } | null {
  if (!config || !rawUrl) return null;
  try {
    const url = new URL(rawUrl);
    if (!config.origins.includes(url.origin)) return null;
    const m = /^\/f\/([^/]+)(\/submit)?\/?$/.exec(url.pathname);
    if (!m) return null;
    return { origin: url.origin, formId: decodeURIComponent(m[1]!), submit: m[2] !== undefined };
  } catch {
    return null;
  }
}

/** The approval code for one approved proposal (the controller types it; the model never sees it). */
export function approvalCodeFor(config: FormsConfig, p: { proposalId: string; payloadDigest: string; expiresAt: string }): string {
  return mintApprovalCode({ secret: config.secret, proposalId: p.proposalId, payloadDigest: p.payloadDigest, expiresAtEpoch: Math.floor(Date.parse(p.expiresAt) / 1000) });
}

export type ReceiptRead =
  | { kind: "confirmed"; receiptId: string; payloadDigest: string; at: string }
  | { kind: "none" }
  | { kind: "error"; detail: string };

const RECEIPT_MAX_BYTES = 8 * 1024;

/**
 * GET <origin>/api/receipts/:proposalId with the receipts read token. Pinned: the URL is built from
 * the configured origin and re-checked; redirects are errors; the body is bounded. A READ only:
 * reconciliation never re-submits anything.
 */
export async function readReceipt(config: FormsConfig, origin: string, proposalId: string, signal?: AbortSignal): Promise<ReceiptRead> {
  if (!config.origins.includes(origin)) return { kind: "error", detail: "origin is not a configured destination" };
  const url = new URL(`/api/receipts/${encodeURIComponent(proposalId)}`, origin);
  if (url.origin !== origin) return { kind: "error", detail: "receipt URL left the configured origin" };
  const timeout = AbortSignal.timeout(config.receiptTimeoutMs ?? 5000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let res: Response;
  try {
    res = await (config.fetch ?? fetch)(url.href, { method: "GET", redirect: "error", headers: { authorization: `Bearer ${receiptsReadToken(config.secret)}`, accept: "application/json" }, signal: combined });
  } catch (error) {
    return { kind: "error", detail: `receipt read failed: ${error instanceof Error ? error.message.slice(0, 200) : "network error"}` };
  }
  let text: string;
  try {
    text = await res.text();
  } catch {
    return { kind: "error", detail: "receipt body unreadable" };
  }
  if (text.length > RECEIPT_MAX_BYTES) return { kind: "error", detail: "receipt body too large" };
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { kind: "error", detail: `receipt response ${res.status} is not JSON` };
  }
  if (res.status === 404 && body.status === "none") return { kind: "none" };
  if (res.status === 200 && body.status === "confirmed" && body.proposalId === proposalId && typeof body.receiptId === "string" && typeof body.payloadDigest === "string" && /^[a-f0-9]{64}$/.test(body.payloadDigest) && typeof body.at === "string")
    return { kind: "confirmed", receiptId: body.receiptId.slice(0, 128), payloadDigest: body.payloadDigest, at: body.at.slice(0, 40) };
  return { kind: "error", detail: `unexpected receipt response ${res.status}${typeof body.status === "string" ? ` (${body.status.slice(0, 40)})` : ""}` };
}
