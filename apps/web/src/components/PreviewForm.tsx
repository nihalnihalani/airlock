import { useState } from "react";
import type { PreviewResult } from "../lib/types";
import { describeError, previewTask } from "../lib/api";
import {
  buildPreviewInput,
  defaultPreviewForm,
  previewText,
  PREVIEW_LIMITS,
  type PreviewFormState,
  type PreviewMode,
} from "../lib/preview";
import { Badge, Chip, Digest, ErrorBox, Mono, Pre, Section } from "./ui";

export function PreviewForm({ taskId, candidateDigest }: { taskId: string; candidateDigest: string }) {
  const [form, setForm] = useState<PreviewFormState>(defaultPreviewForm);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ digest: string; value: PreviewResult } | null>(null);

  const build = buildPreviewInput(form);

  const setMode = (mode: PreviewMode) => setForm((f) => ({ ...f, mode }));
  const setHeader = (i: number, value: string) =>
    setForm((f) => ({ ...f, headers: f.headers.map((h, j) => (j === i ? value : h)) }));
  const setCell = (r: number, c: number, value: string) =>
    setForm((f) => ({ ...f, rows: f.rows.map((row, i) => (i === r ? row.map((cell, j) => (j === c ? value : cell)) : row)) }));
  const addColumn = () =>
    setForm((f) =>
      f.headers.length >= PREVIEW_LIMITS.maxColumns
        ? f
        : { ...f, headers: [...f.headers, `Col${f.headers.length + 1}`], rows: f.rows.map((row) => [...row, ""]) },
    );
  const removeColumn = () =>
    setForm((f) =>
      f.headers.length <= 1 ? f : { ...f, headers: f.headers.slice(0, -1), rows: f.rows.map((row) => row.slice(0, -1)) },
    );
  const addRow = () =>
    setForm((f) => (f.rows.length >= PREVIEW_LIMITS.maxRows ? f : { ...f, rows: [...f.rows, f.headers.map(() => "")] }));
  const removeRow = () => setForm((f) => (f.rows.length <= PREVIEW_LIMITS.minRows ? f : { ...f, rows: f.rows.slice(0, -1) }));

  const submit = async () => {
    if (!build.ok) {
      setError(build.error);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const value = await previewTask(taskId, candidateDigest, build.input);
      setResult({ digest: candidateDigest, value });
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const rendered = result ? previewText(result.value) : null;

  return (
    <Section title="Report Export preview" aside={<Digest label="candidate" value={candidateDigest} />}>
      <p className="muted">
        A trusted form that calls the real <Mono>tabulate.tabulate</Mono> inside a fresh preview sandbox built from the
        sealed candidate. The result is shown as plain text.
      </p>
      <div className="form-grid">
        <fieldset className="fieldset">
          <legend>Table data</legend>
          <label className="radio">
            <input type="radio" name="mode" checked={form.mode === "empty"} onChange={() => setMode("empty")} />
            Empty table (the reported case)
          </label>
          <label className="radio">
            <input type="radio" name="mode" checked={form.mode === "rows"} onChange={() => setMode("rows")} />
            Small table ({PREVIEW_LIMITS.minRows}–{PREVIEW_LIMITS.maxRows} rows)
          </label>
        </fieldset>

        <fieldset className="fieldset">
          <legend>Headers ({form.headers.length}/{PREVIEW_LIMITS.maxColumns})</legend>
          <div className="row-inputs">
            {form.headers.map((h, i) => (
              <input
                key={i}
                type="text"
                value={h}
                maxLength={PREVIEW_LIMITS.maxHeaderChars}
                aria-label={`Header ${i + 1}`}
                onChange={(e) => setHeader(i, e.target.value)}
              />
            ))}
          </div>
          <div className="btn-row">
            <button type="button" className="btn btn-small" onClick={addColumn} disabled={form.headers.length >= PREVIEW_LIMITS.maxColumns}>
              + column
            </button>
            <button type="button" className="btn btn-small" onClick={removeColumn} disabled={form.headers.length <= 1}>
              − column
            </button>
          </div>
        </fieldset>

        {form.mode === "rows" ? (
          <fieldset className="fieldset">
            <legend>Rows ({form.rows.length}/{PREVIEW_LIMITS.maxRows})</legend>
            {form.rows.map((row, r) => (
              <div className="row-inputs" key={r}>
                {row.map((cell, c) => (
                  <input
                    key={c}
                    type="text"
                    value={cell}
                    maxLength={PREVIEW_LIMITS.maxCellChars}
                    aria-label={`Row ${r + 1} cell ${c + 1}`}
                    onChange={(e) => setCell(r, c, e.target.value)}
                  />
                ))}
              </div>
            ))}
            <div className="btn-row">
              <button type="button" className="btn btn-small" onClick={addRow} disabled={form.rows.length >= PREVIEW_LIMITS.maxRows}>
                + row
              </button>
              <button type="button" className="btn btn-small" onClick={removeRow} disabled={form.rows.length <= PREVIEW_LIMITS.minRows}>
                − row
              </button>
            </div>
            <p className="muted">Whole and decimal numbers are passed as numbers; everything else as text.</p>
          </fieldset>
        ) : null}

        <fieldset className="fieldset">
          <legend>maxheadercolwidths</legend>
          <input
            type="text"
            inputMode="numeric"
            value={form.maxHeaderColWidth}
            maxLength={3}
            aria-label="Header width"
            placeholder="leave empty to omit"
            onChange={(e) => setForm((f) => ({ ...f, maxHeaderColWidth: e.target.value }))}
          />
          <p className="muted">1–{PREVIEW_LIMITS.maxHeaderWidth}; empty omits the keyword argument.</p>
        </fieldset>
      </div>

      <div className="btn-row">
        <button type="button" className="btn btn-primary" onClick={() => void submit()} disabled={busy || !build.ok}>
          {busy ? "Running preview…" : "Run preview"}
        </button>
        {!build.ok ? <span className="field-error">{build.error}</span> : null}
      </div>
      {build.ok ? (
        <details className="details">
          <summary>Request input (tabulate kwargs)</summary>
          <Pre className="pre-small">{JSON.stringify(build.input, null, 2)}</Pre>
        </details>
      ) : null}

      {error ? <ErrorBox message={error} /> : null}

      {result && rendered ? (
        <div className="preview-result">
          <div className="list-head">
            <strong>Result</strong>
            <Digest label="ran against" value={result.digest} />
            <Chip>{result.value.inspection.runtime}</Chip>
            <Chip>exec {result.value.exec.status}</Chip>
            {result.value.exec.exitCode !== null ? <Chip>exit {result.value.exec.exitCode}</Chip> : null}
            {result.value.candidateDigest !== result.digest ? (
              <Badge tone="bad">API reported a different digest</Badge>
            ) : null}
          </div>
          {rendered.kind === "text" ? <Pre className="pre-output">{rendered.text}</Pre> : null}
          {rendered.kind === "value" ? (
            <>
              <p className="muted">The call returned a non-string value:</p>
              <Pre className="pre-output">{rendered.text}</Pre>
            </>
          ) : null}
          {rendered.kind === "error" ? (
            <>
              <Badge tone="bad">{rendered.exceptionType}</Badge>
              {rendered.message ? <Pre className="pre-small">{rendered.message}</Pre> : null}
              {rendered.tracebackTail ? <Pre className="pre-small">{rendered.tracebackTail}</Pre> : null}
            </>
          ) : null}
          {rendered.kind === "none" ? <p className="field-error">No output: {rendered.reason}.</p> : null}
          {result.value.exec.stderr.length > 0 && rendered.kind !== "error" ? (
            <details className="details">
              <summary>stderr</summary>
              <Pre className="pre-small">{result.value.exec.stderr.slice(-4000)}</Pre>
            </details>
          ) : null}
        </div>
      ) : null}
    </Section>
  );
}
