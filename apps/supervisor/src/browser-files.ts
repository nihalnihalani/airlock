/**
 * Browser downloads (C16) and uploads (C17) at the supervisor.
 *
 * Supervisor-facing operations (the control plane sends these in POST /attempts/:id/browser; they
 * extend contracts `BrowserOp`, validated here with a local schema until the contracts carry them):
 *
 *   download.list  {}                                      → the runner's ledger (pass-through)
 *   download.read  { downloadId }                           → the whole file, assembled from bounded
 *                                                             runner chunks, sha256 and size re-verified
 *                                                             here, media type re-sniffed here
 *   upload         { ref, generation, filename,             → bytes checked against artifactSha256
 *                    artifactSha256, contentBase64 }          BEFORE anything is placed; placed through
 *                                                             the bounded stdin path into the browser
 *                                                             container's /tmp/uploads/<uploadId>/,
 *                                                             re-verified there, then set on the control
 *
 * The runner never sees a host path and the control plane never names one: the upload location is
 * derived from the operation id, the filename is a plain name.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { AttemptRef, BrowserOp, Operation } from "@airlock/contracts";

export const MAX_DOWNLOAD_BYTES = 10 * 1024 * 1024;
export const MAX_DOWNLOAD_TOTAL_BYTES = 30 * 1024 * 1024;
export const MAX_DOWNLOADS = 10;
export const DOWNLOAD_CHUNK_BYTES = 2 * 1024 * 1024;
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
/** Per browser attempt: uploads placed and their total bytes. */
export const MAX_UPLOADS = 10;
export const MAX_UPLOAD_TOTAL_BYTES = 30 * 1024 * 1024;
/** Raw bytes per placement exec: exactly the stdin cap (MAX_STDIN_BYTES). */
export const UPLOAD_CHUNK_BYTES = 256 * 1024;
export const UPLOAD_DIR = "/tmp/uploads";

const browserRef = z.string().regex(/^[a-z0-9]{1,16}$/i);
const browserGeneration = z.number().int().nonnegative();
const sha256Hex = z.string().regex(/^[a-f0-9]{64}$/);
export const downloadId = z.string().regex(/^dl-[0-9]{1,6}$/);
export const uploadFilename = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/, "a plain file name: letters, digits, dot, underscore, hyphen");

/** The file-transfer operations and the full request union now live in @airlock/contracts. */
export { BrowserFileOp, BrowserAnyOp as SupervisorBrowserOp, BrowserOpRequest as SupervisorBrowserOpRequest } from "@airlock/contracts";
export type { BrowserFileOp as BrowserFileOpT } from "@airlock/contracts";

/** What the supervisor sends the runner (runtime/browser/PROTOCOL.md). */
export type RunnerFileOp =
  | { op: "download.list"; args?: Record<string, never> }
  | { op: "download.read"; args: { downloadId: string; offset: number } }
  | { op: "upload"; args: { ref: string; generation: number; uploadId: string; filename: string; sha256: string } };

// ---- runner results (untrusted) ------------------------------------------------------------

const DownloadRecord = z
  .object({
    downloadId,
    suggestedFilename: z.string().max(1024),
    url: z.string().max(4096),
    tabId: z.string().nullable(),
    state: z.enum(["in_progress", "completed", "cancelled", "failed"]),
    reason: z.string().max(256).optional(),
    bytes: z.number().int().nonnegative().max(MAX_DOWNLOAD_BYTES).optional(),
    sha256: sha256Hex.optional(),
    mediaType: z.string().max(64).optional(),
    startedAt: z.string().max(40),
    finishedAt: z.string().max(40).optional(),
  })
  .strict();
export const DownloadListResult = z
  .object({
    downloads: z.array(DownloadRecord).max(50),
    admitted: z.number().int().nonnegative().max(MAX_DOWNLOADS),
    completedBytes: z.number().int().nonnegative().max(MAX_DOWNLOAD_TOTAL_BYTES),
    limits: z.object({ maxFileBytes: z.number().int(), maxCount: z.number().int(), maxTotalBytes: z.number().int() }).strict(),
  })
  .strict();
export const DownloadChunkResult = z
  .object({
    downloadId,
    suggestedFilename: z.string().max(1024),
    url: z.string().max(4096),
    mediaType: z.string().max(64),
    bytes: z.number().int().nonnegative().max(MAX_DOWNLOAD_BYTES),
    sha256: sha256Hex,
    offset: z.number().int().nonnegative().max(MAX_DOWNLOAD_BYTES),
    chunkBytes: z.number().int().nonnegative().max(DOWNLOAD_CHUNK_BYTES),
    chunkBase64: z.string().max(Math.ceil(DOWNLOAD_CHUNK_BYTES / 3) * 4),
    eof: z.boolean(),
  })
  .strict();
export type DownloadChunkResult = z.infer<typeof DownloadChunkResult>;
export const UploadResult = z
  .object({
    generation: browserGeneration,
    invalidated: z.boolean(),
    url: z.string(),
    uploadId: z.string().regex(/^up-[a-f0-9]{16}$/),
    filename: uploadFilename,
    bytes: z.number().int().nonnegative().max(MAX_UPLOAD_BYTES),
    sha256: sha256Hex,
  })
  .strict();

/** What `download.read` returns to the control plane (proposed contracts BrowserDownloadResult). */
export interface DownloadReadResult {
  downloadId: string;
  suggestedFilename: string;
  url: string;
  /** Sniffed by the supervisor from the bytes (authoritative); the runner's claim is `runnerMediaType`. */
  mediaType: string;
  runnerMediaType: string;
  bytes: number;
  sha256: string;
  contentBase64: string;
  chunks: number;
}

/** Check one chunk against the ones before it; returns the problem or undefined. */
export function chunkProblem(chunk: DownloadChunkResult, expected: { downloadId: string; offset: number; first?: DownloadChunkResult }): string | undefined {
  if (chunk.downloadId !== expected.downloadId) return "chunk is for another download";
  if (chunk.offset !== expected.offset) return `chunk offset ${chunk.offset} is not ${expected.offset}`;
  const bytes = Buffer.from(chunk.chunkBase64, "base64");
  if (bytes.length !== chunk.chunkBytes || bytes.toString("base64") !== chunk.chunkBase64) return "chunk bytes do not match chunkBytes";
  if (chunk.offset + chunk.chunkBytes > chunk.bytes) return "chunk runs past the recorded size";
  if (chunk.eof !== (chunk.offset + chunk.chunkBytes === chunk.bytes)) return "chunk eof flag is inconsistent";
  if (!chunk.eof && chunk.chunkBytes === 0) return "empty chunk before eof";
  const first = expected.first;
  if (first && (first.bytes !== chunk.bytes || first.sha256 !== chunk.sha256 || first.suggestedFilename !== chunk.suggestedFilename || first.mediaType !== chunk.mediaType)) {
    return "chunk metadata changed between reads";
  }
  return undefined;
}

export function sha256Of(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Upload location inside the browser container, derived from the operation (never caller-named). */
export function uploadIdFor(operationId: string): string {
  return `up-${sha256Of(new TextEncoder().encode(operationId)).slice(0, 16)}`;
}

/**
 * Placement scripts (fixed; every value is a positional argument, never interpolated). The first
 * chunk creates the per-upload directory (0700; `mkdir` fails if it exists) and the part file; each
 * later chunk appends exactly N stdin bytes; finalize re-checks size and sha256 inside the container
 * and moves the part file to its plain name.
 */
export const UPLOAD_FIRST_CHUNK = 'set -eu; umask 077; mkdir -p /tmp/uploads; d="/tmp/uploads/$2"; mkdir "$d"; head -c "$1" > "$d/.part"; test "$(stat -c %s "$d/.part")" = "$1"';
export const UPLOAD_NEXT_CHUNK = 'set -eu; umask 077; f="/tmp/uploads/$2/.part"; test -f "$f" && test ! -L "$f"; b=$(stat -c %s "$f"); head -c "$1" >> "$f"; test "$(stat -c %s "$f")" = "$((b + $1))"';
export const UPLOAD_FINALIZE = 'set -eu; d="/tmp/uploads/$1"; test -f "$d/.part" && test ! -L "$d/.part"; s=$(stat -c %s "$d/.part"); h=$(sha256sum "$d/.part" | cut -d" " -f1); if [ "$s" != "$2" ] || [ "$h" != "$3" ]; then echo "mismatch $s $h" >&2; exit 5; fi; mv -n "$d/.part" "$d/$4"; test -f "$d/$4" && test ! -e "$d/.part"; echo "$s $h"';

/** Same rules as runtime/browser/src/protocol.mjs sniffMediaType (bytes, never headers). */
export function sniffMediaType(bytes: Uint8Array, filename = ""): string {
  const starts = (sig: number[]) => bytes.length >= sig.length && sig.every((v, i) => bytes[i] === v);
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (starts([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (starts([0x47, 0x49, 0x46, 0x38])) return "image/gif";
  if (starts([0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf";
  if (starts([0x50, 0x4b, 0x03, 0x04]) || starts([0x50, 0x4b, 0x05, 0x06])) return "application/zip";
  if (starts([0x1f, 0x8b])) return "application/gzip";
  if (bytes.includes(0)) return "application/octet-stream";
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return "application/octet-stream";
  }
  const trimmed = text.trim();
  if (/^[[{]/.test(trimmed)) {
    try {
      JSON.parse(trimmed);
      return "application/json";
    } catch {
      // not JSON
    }
  }
  const ext = filename.toLowerCase().match(/\.([a-z0-9]{1,8})$/)?.[1] ?? "";
  if (ext === "csv") return "text/csv";
  if (ext === "tsv") return "text/tab-separated-values";
  const lines = trimmed.split(/\r?\n/).slice(0, 20).filter((l) => l.length > 0);
  for (const [delimiter, type] of [[",", "text/csv"], ["\t", "text/tab-separated-values"]] as const) {
    const counts = lines.map((l) => l.split(delimiter).length - 1);
    if (lines.length >= 2 && (counts[0] ?? 0) > 0 && counts.every((c) => c === counts[0])) return type;
  }
  return "text/plain";
}
