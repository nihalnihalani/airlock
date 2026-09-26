/**
 * Report Export preview: a trusted form that builds `tabulate.tabulate` keyword arguments.
 * Everything here is bounded before it becomes a PreviewRequest; the sandbox is still the only
 * place the candidate code runs, and the returned text is rendered as text.
 */
import type { CaseInput, PreviewResult } from "./types";

export const PREVIEW_LIMITS = {
  maxColumns: 8,
  minRows: 1,
  maxRows: 3,
  maxCellChars: 64,
  maxHeaderChars: 64,
  maxHeaderWidth: 200,
} as const;

export type PreviewMode = "empty" | "rows";

export interface PreviewFormState {
  mode: PreviewMode;
  headers: string[];
  rows: string[][];
  /** Raw text from the input; empty means "omit maxheadercolwidths". */
  maxHeaderColWidth: string;
}

export function defaultPreviewForm(): PreviewFormState {
  return {
    mode: "empty",
    headers: ["Name", "Value"],
    rows: [
      ["alpha", "1"],
      ["beta", "2"],
    ],
    maxHeaderColWidth: "5",
  };
}

export type PreviewBuild = { ok: true; input: CaseInput } | { ok: false; error: string };

/** Numeric-looking cells become numbers (what a caller of tabulate would pass); others stay strings. */
export function coerceCell(raw: string): string | number {
  const text = raw.trim();
  if (/^-?\d{1,15}$/.test(text)) return Number.parseInt(text, 10);
  if (/^-?\d{1,15}\.\d{1,15}$/.test(text)) return Number.parseFloat(text);
  return raw;
}

export function buildPreviewInput(state: PreviewFormState): PreviewBuild {
  const headers = state.headers.map((h) => h.trim());
  if (headers.length === 0) return { ok: false, error: "At least one header is required." };
  if (headers.length > PREVIEW_LIMITS.maxColumns)
    return { ok: false, error: `At most ${PREVIEW_LIMITS.maxColumns} columns are allowed.` };
  for (const h of headers) {
    if (h.length === 0) return { ok: false, error: "Header names cannot be empty." };
    if (h.length > PREVIEW_LIMITS.maxHeaderChars)
      return { ok: false, error: `Header names are limited to ${PREVIEW_LIMITS.maxHeaderChars} characters.` };
    if (/[\u0000-\u001f]/.test(h)) return { ok: false, error: "Header names cannot contain control characters." };
  }

  let tabularData: (string | number)[][] = [];
  if (state.mode === "rows") {
    if (state.rows.length < PREVIEW_LIMITS.minRows || state.rows.length > PREVIEW_LIMITS.maxRows)
      return { ok: false, error: `Between ${PREVIEW_LIMITS.minRows} and ${PREVIEW_LIMITS.maxRows} rows are allowed.` };
    tabularData = [];
    for (const row of state.rows) {
      if (row.length !== headers.length)
        return { ok: false, error: "Every row must have exactly one cell per header." };
      const cells: (string | number)[] = [];
      for (const cell of row) {
        if (cell.length > PREVIEW_LIMITS.maxCellChars)
          return { ok: false, error: `Cells are limited to ${PREVIEW_LIMITS.maxCellChars} characters.` };
        if (/[\u0000-\u0008\u000b-\u001f]/.test(cell))
          return { ok: false, error: "Cells cannot contain control characters." };
        cells.push(coerceCell(cell));
      }
      tabularData.push(cells);
    }
  }

  const input: CaseInput = { tabular_data: tabularData, headers };
  const widthText = state.maxHeaderColWidth.trim();
  if (widthText.length > 0) {
    if (!/^\d{1,3}$/.test(widthText)) return { ok: false, error: "Header width must be a whole number." };
    const width = Number.parseInt(widthText, 10);
    if (width < 1 || width > PREVIEW_LIMITS.maxHeaderWidth)
      return { ok: false, error: `Header width must be between 1 and ${PREVIEW_LIMITS.maxHeaderWidth}.` };
    input["maxheadercolwidths"] = width;
  }
  return { ok: true, input };
}

export type PreviewText =
  | { kind: "text"; text: string }
  | { kind: "value"; text: string }
  | { kind: "error"; exceptionType: string; message: string; tracebackTail: string }
  | { kind: "none"; reason: string };

const MAX_RENDER_CHARS = 65536;

function clip(text: string): string {
  return text.length > MAX_RENDER_CHARS ? `${text.slice(0, MAX_RENDER_CHARS)}\n… (clipped)` : text;
}

/** Turn a PreviewResult into something renderable. Never throws on odd sandbox output. */
export function previewText(result: PreviewResult): PreviewText {
  const obs = result.observation;
  if (!obs) {
    const why =
      result.exec.status === "succeeded"
        ? "the adapter produced no observation for the preview case"
        : `execution ${result.exec.status}${result.exec.exitCode !== null ? ` (exit ${result.exec.exitCode})` : ""}`;
    return { kind: "none", reason: why };
  }
  if (obs.status === "error") {
    return {
      kind: "error",
      exceptionType: obs.exceptionType ?? "Error",
      message: obs.message ?? "",
      tracebackTail: obs.tracebackTail ?? "",
    };
  }
  if (obs.valueCanonical === undefined) return { kind: "none", reason: "the observation carried no value" };
  try {
    const value: unknown = JSON.parse(obs.valueCanonical);
    if (typeof value === "string") return { kind: "text", text: clip(value) };
    return { kind: "value", text: clip(JSON.stringify(value, null, 2)) };
  } catch {
    return { kind: "value", text: clip(obs.valueCanonical) };
  }
}
