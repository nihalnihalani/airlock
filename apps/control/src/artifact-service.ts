/**
 * Task artifacts (C28): owner uploads, collected outputs, screenshots and saved page text.
 *
 * Bytes live content-addressed in the existing artifact blob store; each file is described by an
 * immutable contracts `Artifact` record in the Store (kind "artifacts", under its owner). A record
 * is never replaced (insertImmutable); its bytes are re-hashed whenever they are served.
 *
 * Uploads are untrusted input. The media type is sniffed from the bytes (never taken from the
 * client): PNG, JPEG, PDF, JSON, CSV (by a `.csv` name and a clean parse) and UTF-8 text; anything
 * else is refused (415). The filename is reduced to a safe basename. Per file ≤ 10 MiB; per owner
 * ≤ 50 MiB and ≤ 20 uploads. Nothing here parses documents beyond these structural checks; real
 * document/data work happens inside a sandbox.
 */
import { randomBytes } from "node:crypto";
import { SCHEMA_VERSION, sha256, type Artifact, type Task } from "@airlock/contracts";
import { parseCsv } from "./csv.ts";
import { hasPngSignature, inspectPng } from "./png.ts";
import type { ArtifactStoreLike } from "./repair-handler.ts";
import type { Store } from "./store/index.ts";

export const STORE_KIND_ARTIFACTS = "artifacts";
export const UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
export const OWNER_QUOTA_BYTES = 50 * 1024 * 1024;
export const OWNER_QUOTA_FILES = 20;

export const SNIFFED_TYPES = ["image/png", "image/jpeg", "application/pdf", "application/json", "text/csv", "text/plain"] as const;
export type SniffedType = (typeof SNIFFED_TYPES)[number];
const EXTENSION: Record<SniffedType, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "application/pdf": ".pdf",
  "application/json": ".json",
  "text/csv": ".csv",
  "text/plain": ".txt",
};

export class ArtifactError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 | 413 | 415 | 422 | 507,
  ) {
    super(message);
    this.name = "ArtifactError";
  }
}

const utf8Strict = new TextDecoder("utf-8", { fatal: true });

/** Valid UTF-8 without NUL or other C0 controls except tab/newline/carriage return. */
export function decodeText(bytes: Uint8Array): string | null {
  let text: string;
  try {
    text = utf8Strict.decode(bytes);
  } catch {
    return null;
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) return null;
  return text;
}

/**
 * The media type from the bytes alone, with the filename only to choose CSV over plain text for
 * text that also parses as CSV. Null: not an accepted type.
 */
export function sniffMediaType(bytes: Uint8Array, filename: string): SniffedType | null {
  if (bytes.byteLength === 0) return null;
  if (hasPngSignature(bytes)) return inspectPng(bytes).ok ? "image/png" : null;
  if (bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.byteLength >= 5 && String.fromCharCode(...bytes.subarray(0, 5)) === "%PDF-") return "application/pdf";
  const text = decodeText(bytes.subarray(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0));
  if (text === null) return null;
  const trimmed = text.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      JSON.parse(text);
      return "application/json";
    } catch {
      // not JSON: falls through to text
    }
  }
  if (/\.csv$/i.test(filename) && parseCsv(text).ok) return "text/csv";
  return "text/plain";
}

/** A safe basename: [A-Za-z0-9._-], no leading dot, ≤ 100 chars, extension matching the sniffed type. */
export function sanitizeFilename(raw: string, mediaType: SniffedType): string {
  const base = raw.split(/[\\/]/).pop() ?? "";
  let name = base.normalize("NFC").replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._-]+/, "").replace(/\.+$/, "");
  const ext = EXTENSION[mediaType];
  const current = /\.[A-Za-z0-9]{1,8}$/.exec(name)?.[0]?.toLowerCase();
  const matches = current === ext || (mediaType === "image/jpeg" && current === ".jpeg") || (mediaType === "text/plain" && (current === ".md" || current === ".txt"));
  if (!matches) name = `${current ? name.slice(0, -current.length) : name}${ext}`;
  if (name.length > 100) name = `${name.slice(0, 100 - ext.length)}${ext}`;
  if (name === ext || name.length === 0) name = `upload${ext}`;
  return name;
}

export interface RecordInput {
  taskId?: string;
  kind: Artifact["kind"];
  filename: string;
  mediaType: string;
  bytes: Uint8Array;
  source?: Artifact["source"];
}

export class ArtifactService {
  /** Serialises quota checks per owner so two concurrent uploads cannot both pass the last slot. */
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly store: Store,
    private readonly blobs: ArtifactStoreLike,
    private readonly now: () => number = Date.now,
  ) {}

  /** Stores bytes and an immutable Artifact record under `owner`. */
  async record(owner: string, input: RecordInput): Promise<Artifact> {
    const digest = await this.blobs.putBlob(input.bytes);
    const expected = await sha256(input.bytes);
    if (digest !== expected) throw new Error(`artifact blob digest mismatch (${digest} ≠ ${expected})`);
    const artifact: Artifact = {
      schemaVersion: SCHEMA_VERSION,
      id: `art-${randomBytes(10).toString("hex")}`,
      owner,
      ...(input.taskId ? { taskId: input.taskId } : {}),
      kind: input.kind,
      filename: input.filename.slice(0, 255) || "file",
      mediaType: input.mediaType.slice(0, 128),
      byteLength: input.bytes.byteLength,
      sha256: digest,
      createdAt: new Date(this.now()).toISOString(),
      ...(input.source ? { source: boundedSource(input.source) } : {}),
    };
    if (!(await this.store.insertImmutable(owner, STORE_KIND_ARTIFACTS, artifact))) throw new ArtifactError("artifact id collision; retry", 409);
    return artifact;
  }

  /** An owner upload: sniff, sanitise, enforce size and quota, store. */
  async ingestUpload(owner: string, rawFilename: string, bytes: Uint8Array): Promise<Artifact> {
    if (bytes.byteLength === 0) throw new ArtifactError("empty upload", 400);
    if (bytes.byteLength > UPLOAD_MAX_BYTES) throw new ArtifactError(`upload exceeds ${UPLOAD_MAX_BYTES} bytes`, 413);
    const mediaType = sniffMediaType(bytes, rawFilename);
    if (!mediaType) throw new ArtifactError("unsupported file type: accepted are PNG, JPEG, PDF, JSON, CSV and UTF-8 text (sniffed from the bytes)", 415);
    const filename = sanitizeFilename(rawFilename, mediaType);
    return this.withOwnerLock(owner, async () => {
      const usage = await this.uploadUsage(owner);
      if (usage.files + 1 > OWNER_QUOTA_FILES) throw new ArtifactError(`upload quota reached: at most ${OWNER_QUOTA_FILES} uploads per session`, 413);
      if (usage.bytes + bytes.byteLength > OWNER_QUOTA_BYTES) throw new ArtifactError(`upload quota reached: at most ${OWNER_QUOTA_BYTES} bytes per session`, 413);
      return this.record(owner, { kind: "upload", filename, mediaType, bytes });
    });
  }

  async uploadUsage(owner: string): Promise<{ files: number; bytes: number }> {
    const uploads = await this.listUploads(owner);
    return { files: uploads.length, bytes: uploads.reduce((n, a) => n + a.byteLength, 0) };
  }

  async listUploads(owner: string): Promise<Artifact[]> {
    return (await this.store.list<Artifact>(owner, STORE_KIND_ARTIFACTS)).filter((a) => a.kind === "upload").sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** Every artifact produced for the task plus the owner's input uploads it names, oldest first. */
  async listForTask(owner: string, task: Task): Promise<Artifact[]> {
    const inputs = new Set(task.inputArtifactIds ?? []);
    const own = await this.store.list<Artifact>(owner, STORE_KIND_ARTIFACTS);
    return own.filter((a) => a.taskId === task.id || inputs.has(a.id)).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  /** The record and its owner, or null. Ownership is the caller's check. */
  async find(id: string): Promise<{ owner: string; artifact: Artifact } | null> {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id)) return null;
    const row = (await this.store.scanWhere<Artifact>(STORE_KIND_ARTIFACTS, { id })).find((r) => r.value.id === id);
    return row ? { owner: row.owner, artifact: row.value } : null;
  }

  /** The bytes, re-hashed against the record (the blob store re-hashes on read too). */
  async bytes(artifact: Artifact): Promise<Uint8Array> {
    const bytes = await this.blobs.getBlob(artifact.sha256);
    if (!bytes) throw new ArtifactError("artifact bytes missing", 409);
    if (bytes.byteLength !== artifact.byteLength || (await sha256(bytes)) !== artifact.sha256) throw new ArtifactError("artifact bytes no longer match their digest", 409);
    return bytes;
  }

  private async withOwnerLock<T>(owner: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(owner) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(fn);
    const tail = run.catch(() => undefined);
    this.locks.set(owner, tail);
    try {
      return await run;
    } finally {
      if (this.locks.get(owner) === tail) this.locks.delete(owner);
    }
  }
}

function boundedSource(source: NonNullable<Artifact["source"]>): NonNullable<Artifact["source"]> {
  return {
    ...(source.url !== undefined ? { url: source.url.slice(0, 2048) } : {}),
    ...(source.step !== undefined ? { step: source.step } : {}),
    ...(source.tool !== undefined ? { tool: source.tool.slice(0, 64) } : {}),
    ...(source.attemptId !== undefined ? { attemptId: source.attemptId } : {}),
  };
}

/** `content-disposition` value with an ASCII-only quoted filename. */
export function dispositionFor(artifact: Artifact, inline: boolean): string {
  const safe = artifact.filename.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "file";
  return `${inline ? "inline" : "attachment"}; filename="${safe}"`;
}

/** Only PNG and JPEG may be shown inline (as images under the app CSP); everything else downloads. */
export function inlineAllowed(artifact: Artifact): boolean {
  return artifact.mediaType === "image/png" || artifact.mediaType === "image/jpeg";
}
