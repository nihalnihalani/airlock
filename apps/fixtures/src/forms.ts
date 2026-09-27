/**
 * Supported forms for the `airlock-forms-v1` adapter and the ONE field normalization shared by the
 * destination (this service) and the control plane (which computes `payloadDigest` for a proposal).
 *
 * Pure: no I/O, no clock, no secrets. The control plane must call `normalizeFields` on the model's
 * proposed fields and use the returned object (or refuse the proposal on `ok: false`), then compute
 * `formPayloadDigest(destination, formId, fields)`; the destination does the same on the submitted
 * body. Equal normalized fields <=> equal digest.
 *
 * Normalization rule (airlock-forms-v1), exactly:
 *   1. formId must be a declared form.
 *   2. Every input name must be a declared field of that form; each declared field must appear
 *      exactly once (missing, unknown or duplicate names are refused). The approval code field
 *      (`airlock_approval`) is NOT a payload field and must be removed before calling this.
 *   3. Line endings: every "\r\n" and every lone "\r" becomes "\n" (browsers submit textarea line
 *      breaks as CRLF; typed text uses LF). No other change: no trimming, no case folding, no
 *      Unicode normalization, no whitespace collapsing.
 *   4. Single-line fields (rendered as <input type=text>) must not contain "\n" after step 3
 *      (Chromium strips line breaks from such inputs, so such a value could never be submitted).
 *   5. Values must be well-formed UTF-16 (no lone surrogates) and at most 4096 UTF-16 code units
 *      after step 3 (the ActionProposal contract bound; the inputs carry maxlength=4096).
 *   6. Output: an object with exactly the declared field names, each mapped to its normalized
 *      value. (Key order is irrelevant: the digest uses canonicalJson, which sorts keys.)
 */
import { payloadDigestOf } from "@airlock/contracts";

export const ADAPTER = "airlock-forms-v1" as const;
/** Name of the approval-code input. Never part of the payload. */
export const APPROVAL_FIELD = "airlock_approval" as const;
export const MAX_VALUE_LENGTH = 4096;

export type FieldSpec = { name: string; label: string; multiline: boolean; hint?: string };
export type FormSpec = { id: string; title: string; description: string; fields: readonly FieldSpec[] };

export const FORMS: Readonly<Record<string, FormSpec>> = Object.freeze({
  "contact-request": {
    id: "contact-request",
    title: "Contact request",
    description: "Ask the (fictional) demo team to get in touch.",
    fields: [
      { name: "name", label: "Name", multiline: false },
      { name: "email", label: "Email", multiline: false, hint: "Not validated; kept exactly as typed." },
      { name: "message", label: "Message", multiline: true },
    ],
  },
  "order-sample": {
    id: "order-sample",
    title: "Order a sample",
    description: "Request a (fictional) product sample. Nothing is shipped.",
    fields: [
      { name: "sku", label: "SKU", multiline: false },
      { name: "quantity", label: "Quantity", multiline: false, hint: "Kept exactly as typed (not parsed)." },
      { name: "address", label: "Delivery address", multiline: true },
    ],
  },
});

export function getForm(formId: string): FormSpec | undefined {
  return Object.hasOwn(FORMS, formId) ? FORMS[formId] : undefined;
}

export type NormalizeFailure =
  | "unknown_form"
  | "unknown_field"
  | "duplicate_field"
  | "missing_field"
  | "not_a_string"
  | "newline_in_single_line_field"
  | "invalid_unicode"
  | "too_long";

export type NormalizeResult =
  | { ok: true; fields: Record<string, string> }
  | { ok: false; reason: NormalizeFailure; field?: string };

/** A plain record (control plane) or ordered name/value pairs, e.g. URLSearchParams (destination). */
export type RawFields = Readonly<Record<string, unknown>> | Iterable<readonly [string, unknown]>;

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function entriesOf(raw: RawFields): Array<readonly [string, unknown]> {
  if (raw && typeof (raw as Iterable<unknown>)[Symbol.iterator] === "function")
    return [...(raw as Iterable<readonly [string, unknown]>)];
  return Object.entries(raw as Record<string, unknown>);
}

export function normalizeFields(formId: string, raw: RawFields): NormalizeResult {
  const form = getForm(formId);
  if (!form) return { ok: false, reason: "unknown_form" };
  const specs = new Map(form.fields.map((f) => [f.name, f] as const));
  const out: Record<string, string> = {};
  const seen = new Set<string>();
  for (const [name, value] of entriesOf(raw)) {
    const spec = specs.get(name);
    if (!spec) return { ok: false, reason: "unknown_field", field: name };
    if (seen.has(name)) return { ok: false, reason: "duplicate_field", field: name };
    seen.add(name);
    if (typeof value !== "string") return { ok: false, reason: "not_a_string", field: name };
    const normalized = value.replace(/\r\n?/g, "\n");
    if (!spec.multiline && normalized.includes("\n"))
      return { ok: false, reason: "newline_in_single_line_field", field: name };
    if (LONE_SURROGATE.test(normalized)) return { ok: false, reason: "invalid_unicode", field: name };
    if (normalized.length > MAX_VALUE_LENGTH) return { ok: false, reason: "too_long", field: name };
    out[name] = normalized;
  }
  for (const spec of form.fields)
    if (!seen.has(spec.name)) return { ok: false, reason: "missing_field", field: spec.name };
  return { ok: true, fields: out };
}

/**
 * The destination value bound into the digest: the service's public origin, as `URL.origin`
 * serializes it (lowercase scheme/host, default port dropped, no trailing slash).
 */
export function destinationOrigin(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("destination must be http(s)");
  return parsed.origin;
}

/** payloadDigest for already-normalized fields (contracts' payloadDigestOf with this adapter). */
export function formPayloadDigest(destination: string, formId: string, fields: Record<string, string>): Promise<string> {
  return payloadDigestOf({ adapter: ADAPTER, destination, formId, fields });
}
