/**
 * Approval codes and the receipts read token for `airlock-forms-v1`. Pure functions of the shared
 * secret (AIRLOCK_FORMS_SECRET, held by the control plane and this destination only).
 *
 *   mac  = base64url_nopad(HMAC-SHA256(secret, `${proposalId}.${payloadDigest}.${expiresAtEpoch}`))
 *   code = `${proposalId}.${expiresAtEpoch}.${mac}`
 *
 * proposalId: plainId (letters, digits, "-", "_"; 1..64; first char alphanumeric; never contains ".").
 * payloadDigest: 64 lowercase hex (formPayloadDigest). expiresAtEpoch: integer seconds since the Unix
 * epoch, decimal without leading zeros. The destination refuses a code when now >= expiresAtEpoch, or
 * when expiresAtEpoch is more than MAX_APPROVAL_LIFETIME_SECONDS in the future.
 *
 *   readToken = base64url_nopad(HMAC-SHA256(secret, "airlock-forms-v1 receipts-read"))
 *
 * The read-token label contains no "." while every MAC input contains two, so the two HMAC domains
 * cannot collide; a receipts read token can never be replayed as an approval code or vice versa.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const MAX_APPROVAL_LIFETIME_SECONDS = 24 * 60 * 60;
export const RECEIPTS_READ_LABEL = "airlock-forms-v1 receipts-read";
export const MIN_SECRET_LENGTH = 32;

const PLAIN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const CODE = /^([A-Za-z0-9][A-Za-z0-9_-]{0,63})\.([1-9][0-9]{0,11})\.([A-Za-z0-9_-]{43})$/;

function hmac(secret: string, input: string): string {
  return createHmac("sha256", secret).update(input, "utf8").digest("base64url");
}

/** Constant-time string equality (hashes both sides first so lengths never leak or throw). */
export function constantTimeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
}

export function approvalMac(secret: string, proposalId: string, payloadDigest: string, expiresAtEpoch: number): string {
  return hmac(secret, `${proposalId}.${payloadDigest}.${expiresAtEpoch}`);
}

export function mintApprovalCode(p: { secret: string; proposalId: string; payloadDigest: string; expiresAtEpoch: number }): string {
  if (p.secret.length < MIN_SECRET_LENGTH) throw new Error("secret too short");
  if (!PLAIN_ID.test(p.proposalId)) throw new Error("proposalId must be a plainId");
  if (!DIGEST.test(p.payloadDigest)) throw new Error("payloadDigest must be 64 lowercase hex");
  if (!Number.isSafeInteger(p.expiresAtEpoch) || p.expiresAtEpoch <= 0) throw new Error("expiresAtEpoch must be a positive integer (seconds)");
  return `${p.proposalId}.${p.expiresAtEpoch}.${approvalMac(p.secret, p.proposalId, p.payloadDigest, p.expiresAtEpoch)}`;
}

export type ParsedCode = { proposalId: string; expiresAtEpoch: number; mac: string };

export function parseApprovalCode(code: string): ParsedCode | null {
  const m = CODE.exec(code);
  if (!m) return null;
  const expiresAtEpoch = Number(m[2]);
  if (!Number.isSafeInteger(expiresAtEpoch)) return null;
  return { proposalId: m[1]!, expiresAtEpoch, mac: m[3]! };
}

export type VerifyFailure = "missing" | "malformed" | "mismatch" | "expired" | "expiry_too_far";
export type VerifyResult = { ok: true; proposalId: string; expiresAtEpoch: number } | { ok: false; reason: VerifyFailure };

/**
 * Verify a code against the digest recomputed from the SUBMITTED fields. A code minted for any other
 * payload, destination, form, proposal id or expiry fails with `mismatch`.
 */
export function verifyApprovalCode(p: { secret: string; code: string | undefined; payloadDigest: string; nowEpoch: number }): VerifyResult {
  if (p.code === undefined || p.code === "") return { ok: false, reason: "missing" };
  const parsed = parseApprovalCode(p.code);
  if (!parsed) return { ok: false, reason: "malformed" };
  const expected = approvalMac(p.secret, parsed.proposalId, p.payloadDigest, parsed.expiresAtEpoch);
  if (!constantTimeEqual(expected, parsed.mac)) return { ok: false, reason: "mismatch" };
  if (p.nowEpoch >= parsed.expiresAtEpoch) return { ok: false, reason: "expired" };
  if (parsed.expiresAtEpoch - p.nowEpoch > MAX_APPROVAL_LIFETIME_SECONDS) return { ok: false, reason: "expiry_too_far" };
  return { ok: true, proposalId: parsed.proposalId, expiresAtEpoch: parsed.expiresAtEpoch };
}

/** Bearer token for GET /api/receipts/:proposalId. */
export function receiptsReadToken(secret: string): string {
  return hmac(secret, RECEIPTS_READ_LABEL);
}
