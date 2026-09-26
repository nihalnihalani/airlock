import { describe, expect, test } from "bun:test";
import type { PreviewResult } from "../src/lib/types";
import { buildPreviewInput, coerceCell, defaultPreviewForm, previewText, PREVIEW_LIMITS } from "../src/lib/preview";

describe("buildPreviewInput", () => {
  test("empty table mirrors the reported case", () => {
    const built = buildPreviewInput({ ...defaultPreviewForm(), mode: "empty", headers: ["Name", "Value"], maxHeaderColWidth: "5" });
    expect(built).toEqual({ ok: true, input: { tabular_data: [], headers: ["Name", "Value"], maxheadercolwidths: 5 } });
  });

  test("rows mode coerces numeric cells and keeps text", () => {
    const built = buildPreviewInput({
      mode: "rows",
      headers: ["Name", "Value"],
      rows: [
        ["alpha", "1"],
        ["beta", "2.5"],
      ],
      maxHeaderColWidth: "",
    });
    expect(built.ok).toBe(true);
    if (built.ok) {
      expect(built.input["tabular_data"]).toEqual([
        ["alpha", 1],
        ["beta", 2.5],
      ]);
      expect("maxheadercolwidths" in built.input).toBe(false);
    }
  });

  test("rejects too many columns, empty headers, ragged rows and bad widths", () => {
    const base = defaultPreviewForm();
    expect(buildPreviewInput({ ...base, headers: Array.from({ length: PREVIEW_LIMITS.maxColumns + 1 }, (_, i) => `h${i}`) }).ok).toBe(false);
    expect(buildPreviewInput({ ...base, headers: ["", "x"] }).ok).toBe(false);
    expect(buildPreviewInput({ ...base, headers: ["a\u0001", "x"] }).ok).toBe(false);
    expect(buildPreviewInput({ ...base, mode: "rows", rows: [["only-one"]] }).ok).toBe(false);
    expect(buildPreviewInput({ ...base, mode: "rows", rows: [] }).ok).toBe(false);
    expect(buildPreviewInput({ ...base, maxHeaderColWidth: "0" }).ok).toBe(false);
    expect(buildPreviewInput({ ...base, maxHeaderColWidth: "abc" }).ok).toBe(false);
    expect(buildPreviewInput({ ...base, maxHeaderColWidth: String(PREVIEW_LIMITS.maxHeaderWidth + 1) }).ok).toBe(false);
    expect(buildPreviewInput({ ...base, mode: "rows", rows: [["x".repeat(PREVIEW_LIMITS.maxCellChars + 1), "1"]] }).ok).toBe(false);
  });

  test("coerceCell", () => {
    expect(coerceCell("42")).toBe(42);
    expect(coerceCell("-3.5")).toBe(-3.5);
    expect(coerceCell("4e2")).toBe("4e2");
    expect(coerceCell(" hi ")).toBe(" hi ");
  });
});

function result(partial: Partial<PreviewResult>): PreviewResult {
  return {
    candidateDigest: "a".repeat(64),
    exec: { status: "succeeded", exitCode: 0, stdout: "", stderr: "", truncated: false, timedOut: false, durationMs: 10 },
    inspection: {
      inspectedAt: "2026-01-01T00:00:00.000Z",
      container: "c",
      runtime: "runc",
      devUnsafe: true,
      imageDigest: "sha256:x",
      guestUname: "Linux",
      guestHostname: "h",
      checks: {
        networkNone: true,
        nonRootUser: true,
        readOnlyRootfs: true,
        capDropAll: true,
        noNewPrivileges: true,
        pidsLimited: true,
        memoryLimited: true,
        cpuLimited: true,
        noHostBinds: true,
        noPorts: true,
        privateIpc: true,
        restartDisabled: true,
        ownedLabels: true,
      },
      allPassed: true,
    },
    ...partial,
  };
}

describe("previewText", () => {
  test("renders a string value as text", () => {
    const r = result({ observation: { caseId: "preview", status: "ok", valueCanonical: JSON.stringify("Name    Value\n------  -------") } });
    expect(previewText(r)).toEqual({ kind: "text", text: "Name    Value\n------  -------" });
  });

  test("renders an error observation", () => {
    const r = result({ observation: { caseId: "preview", status: "error", exceptionType: "IndexError", message: "list index out of range" } });
    const t = previewText(r);
    expect(t.kind).toBe("error");
    if (t.kind === "error") expect(t.exceptionType).toBe("IndexError");
  });

  test("explains a missing observation using the exec status", () => {
    const r = result({ exec: { status: "timed_out", exitCode: null, stdout: "", stderr: "", truncated: false, timedOut: true, durationMs: 30000 } });
    const t = previewText(r);
    expect(t.kind).toBe("none");
    if (t.kind === "none") expect(t.reason).toContain("timed_out");
  });

  test("does not throw on a non-JSON canonical value", () => {
    const r = result({ observation: { caseId: "preview", status: "ok", valueCanonical: "{not json" } });
    expect(previewText(r)).toEqual({ kind: "value", text: "{not json" });
  });
});
