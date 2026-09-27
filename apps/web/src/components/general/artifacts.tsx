/**
 * Artifact views for general tasks. Images load from our own `/api/artifacts/:id` route (PNG/JPEG
 * are served inline, same origin, `img-src 'self'`); every other preview is fetched as bytes,
 * decoded and shown as text nodes: a bounded CSV table, pretty JSON, or plain text. Nothing is ever
 * rendered as HTML, framed or embedded.
 */
import { IconDownload, IconPhoto } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import type { Artifact } from "@airlock/contracts";
import { fetchArtifactText, describeError } from "../../lib/api";
import { formatBytes, formatDateTime } from "../../lib/format";
import { artifactHref, parseCsvPreview, prettyJson, previewKind, PREVIEW_MAX_BYTES, shaPrefix } from "../../lib/general";
import { Badge, Chip, Mono, Pre } from "../common";

export function Screenshot({
  artifactId,
  sha256,
  url,
  capturedAt,
  width,
  height,
  sentToModel,
  className,
  noun = "Screenshot",
}: {
  artifactId: string;
  sha256?: string | null | undefined;
  url?: string | null | undefined;
  capturedAt?: string | null | undefined;
  width?: number | null | undefined;
  height?: number | null | undefined;
  /** true: attached to the next model turn; false: evidence only; undefined: not known here. */
  sentToModel?: boolean | undefined;
  className?: string;
  /** "Screenshot" for browser captures; "Image" for an image the task produced (e.g. a chart). */
  noun?: "Screenshot" | "Image";
}) {
  const [failed, setFailed] = useState(false);
  return (
    <figure className={className ?? "flex flex-col gap-1.5"}>
      {failed ? (
        <div className="flex h-24 items-center justify-center gap-2 rounded-lg border border-dashed text-xs text-muted-foreground">
          <IconPhoto className="size-4" /> {noun} {artifactId} could not be loaded.
        </div>
      ) : (
        <a href={artifactHref(artifactId)} target="_blank" rel="noreferrer noopener" title={`Open the stored ${noun.toLowerCase()}`}>
          <img
            src={artifactHref(artifactId)}
            alt={`${noun} ${artifactId}${url ? ` of ${url}` : ""}`}
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
            className="max-h-80 w-full rounded-lg border border-border bg-muted/40 object-contain object-top"
            onError={() => setFailed(true)}
          />
        </a>
      )}
      <figcaption className="flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
        <Mono>{artifactId}</Mono>
        {sha256 ? <Chip title={sha256}>sha256 {shaPrefix(sha256)}</Chip> : null}
        {width && height ? <Chip>{width}×{height}</Chip> : null}
        {capturedAt ? <span>captured {formatDateTime(capturedAt)}</span> : null}
        {sentToModel === true ? <Badge tone="info">sent to the model</Badge> : sentToModel === false ? <Badge>evidence only, not sent to the model</Badge> : null}
        {url ? (
          <span className="w-full min-w-0 truncate" title={url}>
            {url}
          </span>
        ) : null}
      </figcaption>
    </figure>
  );
}

function useArtifactText(artifact: Artifact, enabled: boolean): { text: string | null; error: string | null } {
  const [state, setState] = useState<{ text: string | null; error: string | null }>({ text: null, error: null });
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    fetchArtifactText(artifact.id, PREVIEW_MAX_BYTES, controller.signal)
      .then((text) => setState({ text, error: null }))
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setState({ text: null, error: describeError(err) });
      });
    return () => controller.abort();
  }, [artifact.id, enabled]);
  return state;
}

export function CsvTable({ text }: { text: string }) {
  const p = parseCsvPreview(text);
  if (p.error && p.header.length === 0) return <p className="text-xs text-muted-foreground">Not previewable as CSV: {p.error}.</p>;
  return (
    <div className="flex flex-col gap-1">
      <div className="max-h-72 overflow-auto rounded-lg border border-border">
        <table className="w-full border-collapse text-left font-mono text-[11px]">
          <thead className="sticky top-0 bg-muted">
            <tr>
              {p.header.map((h, i) => (
                <th key={i} className="border-b border-border px-2 py-1 font-medium whitespace-nowrap">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {p.rows.map((row, r) => (
              <tr key={r} className="odd:bg-muted/30">
                {row.map((c, i) => (
                  <td key={i} className="px-2 py-0.5 whitespace-nowrap">
                    {c}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-muted-foreground">
        {p.rows.length} row{p.rows.length === 1 ? "" : "s"} shown{p.moreRows ? " (more not shown)" : ""}
        {p.moreColumns ? "; extra columns not shown" : ""}
        {p.error ? `; ${p.error}` : ""}. Parsed in your browser for display only.
      </p>
    </div>
  );
}

export function ArtifactPreview({ artifact }: { artifact: Artifact }) {
  const kind = previewKind(artifact);
  const tooBig = artifact.byteLength > PREVIEW_MAX_BYTES;
  const { text, error } = useArtifactText(artifact, (kind === "csv" || kind === "json" || kind === "text") && !tooBig);
  if (kind === "image") return <Screenshot artifactId={artifact.id} sha256={artifact.sha256} url={artifact.source?.url ?? null} capturedAt={artifact.createdAt} noun={artifact.kind === "screenshot" ? "Screenshot" : "Image"} />;
  if (kind === "none") return null;
  if (tooBig) return <p className="text-xs text-muted-foreground">Too large to preview here ({formatBytes(artifact.byteLength)}); download it instead.</p>;
  if (error) return <p className="text-xs text-destructive">Preview unavailable: {error}</p>;
  if (text === null) return <p className="text-xs text-muted-foreground">Loading preview…</p>;
  if (kind === "csv") return <CsvTable text={text} />;
  if (kind === "json") {
    const j = prettyJson(text);
    return (
      <div className="flex flex-col gap-1">
        {j.error ? <p className="text-xs text-warning">Not valid JSON ({j.error}); shown as text.</p> : null}
        <Pre className="max-h-72">{j.text}</Pre>
      </div>
    );
  }
  return <Pre className="max-h-72">{text.length > 20000 ? `${text.slice(0, 20000)}…` : text}</Pre>;
}

const KIND_LABEL: Record<Artifact["kind"], string> = {
  upload: "input",
  output: "output",
  screenshot: "screenshot",
  download: "download",
  page_text: "page text",
};

export function ArtifactLine({ artifact, compact = false }: { artifact: Artifact; compact?: boolean }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs">
      <Badge tone={artifact.kind === "output" ? "info" : "neutral"}>{KIND_LABEL[artifact.kind]}</Badge>
      <span className="min-w-0 truncate font-medium" title={artifact.filename}>
        {artifact.filename}
      </span>
      <Chip>{artifact.mediaType}</Chip>
      <Chip>{formatBytes(artifact.byteLength)}</Chip>
      <Chip title={artifact.sha256}>sha256 {shaPrefix(artifact.sha256)}</Chip>
      {!compact && artifact.source?.url ? (
        <span className="w-full min-w-0 truncate text-[11px] text-muted-foreground" title={artifact.source.url}>
          from {artifact.source.url}
          {artifact.source.step !== undefined ? ` · step ${artifact.source.step}` : ""}
        </span>
      ) : null}
      <a
        className="ml-auto inline-flex items-center gap-1 text-[11px] underline underline-offset-4 hover:text-foreground"
        href={artifactHref(artifact.id, true)}
        download={artifact.filename}
        aria-label={`Download ${artifact.filename}`}
      >
        <IconDownload className="size-3" />
        download
      </a>
    </div>
  );
}
