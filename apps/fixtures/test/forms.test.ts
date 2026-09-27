/** Shared test vectors (test/vectors.json) for the control plane and this destination. */
import { describe, expect, test } from "bun:test";
import { createHash, createHmac } from "node:crypto";
import { canonicalJson } from "@airlock/contracts";
import {
  constantTimeEqual,
  MAX_APPROVAL_LIFETIME_SECONDS,
  mintApprovalCode,
  parseApprovalCode,
  receiptsReadToken,
  verifyApprovalCode,
} from "../src/approval.ts";
import { ADAPTER, destinationOrigin, formPayloadDigest, normalizeFields } from "../src/forms.ts";
import vectors from "./vectors.json";

type NormVector = { name: string; formId: string; raw: Array<[string, string]>; ok: boolean; fields?: Record<string, string>; canonical?: string; payloadDigest?: string; reason?: string; field?: string };

describe("airlock-forms-v1 normalization vectors", () => {
  for (const v of vectors.normalization as unknown as NormVector[]) {
    test(v.name, async () => {
      const r = normalizeFields(v.formId, v.raw);
      expect(r.ok).toBe(v.ok);
      if (!r.ok) {
        expect(r.reason).toBe(v.reason as typeof r.reason);
        if (v.field) expect(r.field).toBe(v.field);
        return;
      }
      expect(r.fields).toEqual(v.fields!);
      const canonical = canonicalJson({ adapter: ADAPTER, destination: vectors.destination, formId: v.formId, fields: r.fields });
      expect(canonical).toBe(v.canonical!);
      // Independent of contracts' sha256 helper.
      expect(createHash("sha256").update(canonical, "utf8").digest("hex")).toBe(v.payloadDigest!);
      expect(await formPayloadDigest(vectors.destination, v.formId, r.fields)).toBe(v.payloadDigest!);
      // Record input (control plane) and pair input (destination) normalize identically; key order is irrelevant.
      expect(normalizeFields(v.formId, Object.fromEntries([...v.raw].reverse()))).toEqual(r);
      // Idempotent: normalizing normalized fields changes nothing.
      expect(normalizeFields(v.formId, r.fields)).toEqual(r);
    });
  }

  test("a single changed character changes the digest", async () => {
    const base = vectors.normalization[0] as unknown as NormVector;
    const changed = { ...base.fields!, message: base.fields!.message + " " };
    expect(await formPayloadDigest(vectors.destination, base.formId, changed)).not.toBe(base.payloadDigest!);
    expect(await formPayloadDigest("https://other.example", base.formId, base.fields!)).not.toBe(base.payloadDigest!);
  });

  test("destination origin serialization", () => {
    expect(destinationOrigin("HTTPS://Forms.Example.ORG:443/some/path?q")).toBe("https://forms.example.org");
    expect(destinationOrigin("http://127.0.0.1:3100/")).toBe("http://127.0.0.1:3100");
    expect(() => destinationOrigin("ftp://x")).toThrow();
  });

  test("non-string values are refused (control-plane record input)", () => {
    expect(normalizeFields("contact-request", { name: "a", email: "b", message: 3 as unknown as string })).toEqual({ ok: false, reason: "not_a_string", field: "message" });
  });
});

describe("approval code vectors", () => {
  for (const a of vectors.approval) {
    test(`${a.proposalId} @ ${a.expiresAtEpoch}`, () => {
      const mac = createHmac("sha256", vectors.secret).update(a.macInput, "utf8").digest("base64url");
      expect(a.macInput).toBe(`${a.proposalId}.${a.payloadDigest}.${a.expiresAtEpoch}`);
      expect(a.code).toBe(`${a.proposalId}.${a.expiresAtEpoch}.${mac}`);
      expect(mintApprovalCode({ secret: vectors.secret, proposalId: a.proposalId, payloadDigest: a.payloadDigest, expiresAtEpoch: a.expiresAtEpoch })).toBe(a.code);
      expect(parseApprovalCode(a.code)).toEqual({ proposalId: a.proposalId, expiresAtEpoch: a.expiresAtEpoch, mac });
      expect(verifyApprovalCode({ secret: vectors.secret, code: a.code, payloadDigest: a.payloadDigest, nowEpoch: a.expiresAtEpoch - 60 })).toEqual({ ok: true, proposalId: a.proposalId, expiresAtEpoch: a.expiresAtEpoch });
    });
  }

  test("receipts read token", () => {
    expect(receiptsReadToken(vectors.secret)).toBe(vectors.receiptsReadToken);
    expect(vectors.receiptsReadToken).toBe(createHmac("sha256", vectors.secret).update("airlock-forms-v1 receipts-read").digest("base64url"));
  });

  test("verification failures", () => {
    const a = vectors.approval[0]!;
    const v = (code: string | undefined, nowEpoch = a.expiresAtEpoch - 60, payloadDigest = a.payloadDigest, secret = vectors.secret) =>
      verifyApprovalCode({ secret, code, payloadDigest, nowEpoch });
    expect(v(undefined)).toEqual({ ok: false, reason: "missing" });
    expect(v("")).toEqual({ ok: false, reason: "missing" });
    expect(v("garbage")).toEqual({ ok: false, reason: "malformed" });
    expect(v(` ${a.code}`)).toEqual({ ok: false, reason: "malformed" });
    expect(v(a.code, a.expiresAtEpoch)).toEqual({ ok: false, reason: "expired" });
    expect(v(a.code, a.expiresAtEpoch - MAX_APPROVAL_LIFETIME_SECONDS - 1)).toEqual({ ok: false, reason: "expiry_too_far" });
    expect(v(a.code, undefined, "0".repeat(64))).toEqual({ ok: false, reason: "mismatch" });
    expect(v(a.code, undefined, undefined, "a-different-secret-that-is-long-enough-xx")).toEqual({ ok: false, reason: "mismatch" });
    // Moving the expiry or the proposal id invalidates the MAC.
    const [id, exp, mac] = a.code.split(".");
    expect(v(`${id}.${Number(exp) + 1}.${mac}`)).toEqual({ ok: false, reason: "mismatch" });
    expect(v(`${id}x.${exp}.${mac}`)).toEqual({ ok: false, reason: "mismatch" });
    // The read token is not an approval code.
    expect(v(vectors.receiptsReadToken)).toEqual({ ok: false, reason: "malformed" });
  });

  test("mint refuses bad inputs", () => {
    const ok = { secret: vectors.secret, proposalId: "p1", payloadDigest: "a".repeat(64), expiresAtEpoch: 1 };
    expect(() => mintApprovalCode({ ...ok, secret: "short" })).toThrow();
    expect(() => mintApprovalCode({ ...ok, proposalId: "a.b" })).toThrow();
    expect(() => mintApprovalCode({ ...ok, payloadDigest: "A".repeat(64) })).toThrow();
    expect(() => mintApprovalCode({ ...ok, expiresAtEpoch: 1.5 })).toThrow();
  });

  test("constantTimeEqual", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
    expect(constantTimeEqual("", "")).toBe(true);
  });
});
