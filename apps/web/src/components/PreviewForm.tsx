import { IconPlayerPlay } from "@tabler/icons-react";
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
import { cn } from "../lib/utils";
import { Badge, Chip, Digest, ErrorBox, Mono, Pre } from "./common";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

function Legend({ children }: { children: string }) {
  return <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">{children}</span>;
}

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
  const cellClass = "h-8 min-w-0 px-2 text-xs md:text-xs";

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">
        A trusted form that calls the real <Mono>tabulate.tabulate</Mono> inside a fresh preview sandbox built from the sealed
        candidate <Digest value={candidateDigest} />. The result is shown as plain text.
      </p>

      <div className="flex flex-col gap-1.5">
        <Legend>Table data</Legend>
        <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1" role="radiogroup" aria-label="Table data">
          {(
            [
              ["empty", "Empty table (reported)"],
              ["rows", `${PREVIEW_LIMITS.minRows}–${PREVIEW_LIMITS.maxRows} rows`],
            ] as const
          ).map(([mode, label]) => (
            <button
              key={mode}
              type="button"
              role="radio"
              aria-checked={form.mode === mode}
              onClick={() => setMode(mode)}
              className={cn(
                "h-7 rounded-md px-2 text-xs font-medium transition-colors",
                form.mode === mode ? "bg-background text-foreground shadow-sm dark:bg-input/60" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <Legend>{`Headers (${form.headers.length}/${PREVIEW_LIMITS.maxColumns})`}</Legend>
          <div className="flex gap-1">
            <Button size="xs" variant="ghost" onClick={removeColumn} disabled={form.headers.length <= 1}>
              − column
            </Button>
            <Button size="xs" variant="ghost" onClick={addColumn} disabled={form.headers.length >= PREVIEW_LIMITS.maxColumns}>
              + column
            </Button>
          </div>
        </div>
        <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${Math.min(form.headers.length, 4)}, minmax(0, 1fr))` }}>
          {form.headers.map((h, i) => (
            <Input
              key={i}
              className={cellClass}
              value={h}
              maxLength={PREVIEW_LIMITS.maxHeaderChars}
              aria-label={`Header ${i + 1}`}
              onChange={(e) => setHeader(i, e.target.value)}
            />
          ))}
        </div>
      </div>

      {form.mode === "rows" ? (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <Legend>{`Rows (${form.rows.length}/${PREVIEW_LIMITS.maxRows})`}</Legend>
            <div className="flex gap-1">
              <Button size="xs" variant="ghost" onClick={removeRow} disabled={form.rows.length <= PREVIEW_LIMITS.minRows}>
                − row
              </Button>
              <Button size="xs" variant="ghost" onClick={addRow} disabled={form.rows.length >= PREVIEW_LIMITS.maxRows}>
                + row
              </Button>
            </div>
          </div>
          {form.rows.map((row, r) => (
            <div key={r} className="grid gap-1" style={{ gridTemplateColumns: `repeat(${Math.min(row.length, 4)}, minmax(0, 1fr))` }}>
              {row.map((cell, c) => (
                <Input
                  key={c}
                  className={cellClass}
                  value={cell}
                  maxLength={PREVIEW_LIMITS.maxCellChars}
                  aria-label={`Row ${r + 1} cell ${c + 1}`}
                  onChange={(e) => setCell(r, c, e.target.value)}
                />
              ))}
            </div>
          ))}
          <p className="text-[11px] text-muted-foreground">Whole and decimal numbers are passed as numbers; everything else as text.</p>
        </div>
      ) : null}

      <div className="flex flex-col gap-1.5">
        <Legend>maxheadercolwidths</Legend>
        <Input
          className={cn(cellClass, "w-28")}
          inputMode="numeric"
          value={form.maxHeaderColWidth}
          maxLength={3}
          aria-label="Header width"
          placeholder="omit"
          onChange={(e) => setForm((f) => ({ ...f, maxHeaderColWidth: e.target.value }))}
        />
        <p className="text-[11px] text-muted-foreground">1–{PREVIEW_LIMITS.maxHeaderWidth}; empty omits the keyword argument.</p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={() => void submit()} disabled={busy || !build.ok}>
          <IconPlayerPlay />
          {busy ? "Running preview…" : "Run preview"}
        </Button>
        {!build.ok ? <span className="text-xs text-destructive">{build.error}</span> : null}
      </div>
      {build.ok ? (
        <details className="tool-line text-xs">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 text-muted-foreground [&::-webkit-details-marker]:hidden">
            <span aria-hidden className="tool-line-chevron transition-transform">
              ▸
            </span>
            Request input (tabulate kwargs)
          </summary>
          <Pre className="mt-1.5">{JSON.stringify(build.input, null, 2)}</Pre>
        </details>
      ) : null}

      {error ? <ErrorBox message={error} /> : null}

      {result && rendered ? (
        <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3 dark:border-transparent">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-sm font-medium">Result</span>
            <Chip>
              <Digest label="ran against" value={result.digest} />
            </Chip>
            <Chip>{result.value.inspection.runtime}</Chip>
            <Chip>exec {result.value.exec.status}</Chip>
            {result.value.exec.exitCode !== null ? <Chip>exit {result.value.exec.exitCode}</Chip> : null}
            {result.value.candidateDigest !== result.digest ? <Badge tone="bad">API reported a different digest</Badge> : null}
          </div>
          {rendered.kind === "text" ? <Pre className="bg-background">{rendered.text}</Pre> : null}
          {rendered.kind === "value" ? (
            <>
              <p className="text-xs text-muted-foreground">The call returned a non-string value:</p>
              <Pre>{rendered.text}</Pre>
            </>
          ) : null}
          {rendered.kind === "error" ? (
            <>
              <Badge tone="bad">{rendered.exceptionType}</Badge>
              {rendered.message ? <Pre>{rendered.message}</Pre> : null}
              {rendered.tracebackTail ? <Pre>{rendered.tracebackTail}</Pre> : null}
            </>
          ) : null}
          {rendered.kind === "none" ? <p className="text-xs text-destructive">No output: {rendered.reason}.</p> : null}
          {result.value.exec.stderr.length > 0 && rendered.kind !== "error" ? (
            <details className="text-xs">
              <summary className="cursor-pointer text-muted-foreground">stderr</summary>
              <Pre className="mt-1.5">{result.value.exec.stderr.slice(-4000)}</Pre>
            </details>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
