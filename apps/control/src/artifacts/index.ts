/**
 * Airlock artifact service: canonical manifests, envelope validation, unified diff,
 * immutable content-addressed storage, export bundles and a pure-TS store-only zip writer.
 *
 * Trust position (CLAUDE.md §3 invariants 1, 3): this module owns canonical bytes and digests.
 * Everything in a FileEnvelope came out of a sandbox and is untrusted until validated here.
 * Nothing here executes, parses or imports candidate code; it only hashes, diffs and stores bytes.
 */
import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import {
  SCHEMA_VERSION,
  candidateDigestOf,
  canonicalJson,
  type CandidateBundle,
  type CollectedFile,
  type FileEnvelope,
  type ProfileManifest,
  type RunEvent,
  type SourceManifest,
  type Task,
  type VerificationRecord,
} from "@airlock/contracts";

// ---------------------------------------------------------------------------------------------
// Hashing helpers (sync; node:crypto is available in Bun)
// ---------------------------------------------------------------------------------------------

function sha256HexSync(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Strict base64 decode: rejects whitespace, url-safe alphabet, bad padding and length.
 * Returns null on any deviation so a lenient decoder can never "repair" a corrupted payload.
 */
export function decodeBase64Strict(text: string): Uint8Array | null {
  if (text.length % 4 !== 0 || !BASE64_RE.test(text)) return null;
  const pad = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0;
  if (pad > 0 && text.indexOf("=") !== text.length - pad) return null;
  const decoded = Buffer.from(text, "base64");
  const expected = (text.length / 4) * 3 - pad;
  if (decoded.length !== expected) return null;
  // Round-trip check catches non-canonical trailing bits (e.g. "QR==" vs "QQ==").
  if (decoded.toString("base64") !== text) return null;
  return new Uint8Array(decoded.buffer, decoded.byteOffset, decoded.byteLength);
}

// ---------------------------------------------------------------------------------------------
// validateEnvelope
// ---------------------------------------------------------------------------------------------

export type EnvelopeValidation =
  | { ok: true; files: CollectedFile[] }
  | { ok: false; reasons: string[] };

const MAX_ENVELOPE_ENTRIES = 1024;

/** Normalizes a path for duplicate detection: collapse case-only and NFC/NFD-only differences. */
function dedupeKey(path: string): string {
  return path.normalize("NFC").toLowerCase();
}

function isTraversal(path: string): boolean {
  if (path.length === 0 || path.startsWith("/") || path.includes("\\") || path.includes("\0")) return true;
  const segs = path.split("/");
  return segs.some((s) => s === "" || s === "." || s === "..");
}

export function validateEnvelope(envelope: FileEnvelope, profile: ProfileManifest): EnvelopeValidation {
  const reasons: string[] = [];
  const caps = profile.caps;
  const allowed = new Set(profile.allowedReplacementPaths);

  if (!envelope || typeof envelope !== "object" || !Array.isArray(envelope.files)) {
    return { ok: false, reasons: ["envelope is not an object with a files array"] };
  }
  if (envelope.schemaVersion !== SCHEMA_VERSION) {
    reasons.push(`envelope schemaVersion ${String(envelope.schemaVersion)} != ${SCHEMA_VERSION}`);
  }
  if (envelope.files.length > MAX_ENVELOPE_ENTRIES) {
    return { ok: false, reasons: [`envelope has ${envelope.files.length} entries (> ${MAX_ENVELOPE_ENTRIES})`] };
  }
  if (envelope.files.length > caps.maxFiles) {
    reasons.push(`file count ${envelope.files.length} exceeds cap ${caps.maxFiles}`);
  }

  const seen = new Map<string, string>();
  const out: CollectedFile[] = [];
  let total = 0;
  // Longest legal base64 for maxFileBytes; anything longer is rejected before decoding.
  const maxB64 = Math.ceil(caps.maxFileBytes / 3) * 4;

  envelope.files.forEach((file, index) => {
    const label = `files[${index}]`;
    if (!file || typeof file !== "object") {
      reasons.push(`${label}: not an object`);
      return;
    }
    const path = file.path;
    if (typeof path !== "string" || path.length === 0 || path.length > 512 || isTraversal(path)) {
      reasons.push(`${label}: invalid path ${JSON.stringify(String(path).slice(0, 80))}`);
      return;
    }
    if (!allowed.has(path)) {
      reasons.push(`${path}: not an allowed replacement path`);
      return;
    }
    const key = dedupeKey(path);
    const prior = seen.get(key);
    if (prior !== undefined) {
      reasons.push(`${path}: duplicate of ${prior}`);
      return;
    }
    seen.set(key, path);

    if (typeof file.byteLength !== "number" || !Number.isInteger(file.byteLength) || file.byteLength < 0) {
      reasons.push(`${path}: byteLength is not a non-negative integer`);
      return;
    }
    if (file.byteLength > caps.maxFileBytes) {
      reasons.push(`${path}: declared ${file.byteLength} bytes exceeds per-file cap ${caps.maxFileBytes}`);
      return;
    }
    if (typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256)) {
      reasons.push(`${path}: sha256 is not 64 lowercase hex chars`);
      return;
    }
    if (typeof file.contentBase64 !== "string") {
      reasons.push(`${path}: contentBase64 is not a string`);
      return;
    }
    if (file.contentBase64.length > maxB64) {
      reasons.push(`${path}: encoded content exceeds per-file cap ${caps.maxFileBytes}`);
      return;
    }
    const bytes = decodeBase64Strict(file.contentBase64);
    if (bytes === null) {
      reasons.push(`${path}: contentBase64 is not strict base64`);
      return;
    }
    if (bytes.byteLength !== file.byteLength) {
      reasons.push(`${path}: byteLength ${file.byteLength} != decoded length ${bytes.byteLength}`);
      return;
    }
    const actual = sha256HexSync(bytes);
    if (actual !== file.sha256) {
      reasons.push(`${path}: sha256 mismatch (declared ${file.sha256.slice(0, 12)}…, actual ${actual.slice(0, 12)}…)`);
      return;
    }
    total += bytes.byteLength;
    out.push({ path, byteLength: file.byteLength, sha256: file.sha256, contentBase64: file.contentBase64 });
  });

  if (total > caps.maxTotalBytes) {
    reasons.push(`total ${total} bytes exceeds cap ${caps.maxTotalBytes}`);
  }
  if (!Array.isArray(envelope.rejected)) {
    reasons.push("envelope.rejected is not an array");
  }

  if (reasons.length > 0) return { ok: false, reasons };
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { ok: true, files: out };
}

// ---------------------------------------------------------------------------------------------
// buildManifest
// ---------------------------------------------------------------------------------------------

export function buildManifest(profile: ProfileManifest, files: CollectedFile[]): SourceManifest {
  const replacements = files
    .map((f) => ({ path: f.path, byteLength: f.byteLength, sha256: f.sha256 }))
    .sort((a, b) => a.path.localeCompare(b.path));
  return {
    schemaVersion: SCHEMA_VERSION,
    profileId: profile.id,
    baselineCommit: profile.baselineCommit,
    baselineTreeDigest: profile.baselineTreeDigest,
    replacements,
  };
}

// ---------------------------------------------------------------------------------------------
// unifiedDiff: line-based Myers O(ND) with prefix/suffix trimming; 3 lines of context
// ---------------------------------------------------------------------------------------------

interface Lines {
  lines: string[];
  /**
   * Comparison keys: identical to `lines` except that a final line without a trailing newline is
   * suffixed with "\0", so a change only in the trailing newline still produces a hunk.
   */
  keys: string[];
  /** True when the text does not end with "\n" (so the last line needs the no-newline marker). */
  missingNewline: boolean;
}

function splitLines(text: string): Lines {
  if (text.length === 0) return { lines: [], keys: [], missingNewline: false };
  const parts = text.split("\n");
  const missingNewline = parts[parts.length - 1] !== "";
  if (!missingNewline) parts.pop();
  const keys = [...parts];
  if (missingNewline && keys.length > 0) keys[keys.length - 1] = `${keys[keys.length - 1]}\0`;
  return { lines: parts, keys, missingNewline };
}

type Op = { t: " " | "-" | "+"; a?: number; b?: number };

/** Largest Myers D we trace exactly; beyond it we emit a whole-region replacement (still valid). */
const MYERS_MAX_D = 4000;

/** Myers shortest edit script over a[a0..a1) and b[b0..b1). Returns ops in order. */
function myers(a: string[], b: string[]): Op[] {
  // Trim common prefix/suffix; the middle is what Myers sees.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const ops: Op[] = [];
  for (let i = 0; i < start; i++) ops.push({ t: " ", a: i, b: i });

  const n = endA - start;
  const m = endB - start;
  const middle: Op[] = [];
  if (n === 0 && m === 0) {
    // nothing
  } else if (n === 0) {
    for (let j = 0; j < m; j++) middle.push({ t: "+", b: start + j });
  } else if (m === 0) {
    for (let i = 0; i < n; i++) middle.push({ t: "-", a: start + i });
  } else {
    const max = Math.min(n + m, MYERS_MAX_D);
    const offset = max;
    const trace: Int32Array[] = [];
    let v = new Int32Array(2 * max + 2);
    let found = false;
    outer: for (let d = 0; d <= max; d++) {
      const snapshot = new Int32Array(v);
      trace.push(snapshot);
      for (let k = -d; k <= d; k += 2) {
        let x: number;
        if (k === -d || (k !== d && (v[offset + k - 1] as number) < (v[offset + k + 1] as number))) {
          x = v[offset + k + 1] as number;
        } else {
          x = (v[offset + k - 1] as number) + 1;
        }
        let y = x - k;
        while (x < n && y < m && a[start + x] === b[start + y]) {
          x++;
          y++;
        }
        v[offset + k] = x;
        if (x >= n && y >= m) {
          found = true;
          break outer;
        }
      }
    }
    if (!found) {
      // Edit distance exceeded the traced budget: replace the whole middle. Valid, just not minimal.
      for (let i = 0; i < n; i++) middle.push({ t: "-", a: start + i });
      for (let j = 0; j < m; j++) middle.push({ t: "+", b: start + j });
    } else {
      // Backtrack.
      let x = n;
      let y = m;
      const rev: Op[] = [];
      for (let d = trace.length - 1; d >= 0; d--) {
        const vd = trace[d] as Int32Array;
        const k = x - y;
        let prevK: number;
        if (k === -d || (k !== d && (vd[offset + k - 1] as number) < (vd[offset + k + 1] as number))) {
          prevK = k + 1;
        } else {
          prevK = k - 1;
        }
        const prevX = vd[offset + prevK] as number;
        const prevY = prevX - prevK;
        while (x > prevX && y > prevY) {
          x--;
          y--;
          rev.push({ t: " ", a: start + x, b: start + y });
        }
        if (d > 0) {
          if (x === prevX) {
            y--;
            rev.push({ t: "+", b: start + y });
          } else {
            x--;
            rev.push({ t: "-", a: start + x });
          }
        }
      }
      rev.reverse();
      middle.push(...rev);
    }
  }
  ops.push(...middle);
  const tail = a.length - endA;
  for (let i = 0; i < tail; i++) ops.push({ t: " ", a: endA + i, b: endB + i });
  return ops;
}

const CONTEXT = 3;
const NO_NEWLINE = "\\ No newline at end of file";

/**
 * Unified diff with `a/<path>` and `b/<path>` headers, 3 lines of context, and the standard
 * "\ No newline at end of file" markers. Returns "" when the texts are identical.
 * A file that did not exist in the base is emitted against /dev/null so `patch -p1` creates it.
 */
export function unifiedDiff(path: string, baseText: string, candidateText: string): string {
  if (baseText === candidateText) return "";
  const A = splitLines(baseText);
  const B = splitLines(candidateText);
  const ops = myers(A.keys, B.keys);

  // Group ops into hunks separated by more than 2*CONTEXT unchanged lines.
  const changeIdx: number[] = [];
  ops.forEach((op, i) => {
    if (op.t !== " ") changeIdx.push(i);
  });
  if (changeIdx.length === 0) return "";

  const hunks: { from: number; to: number }[] = [];
  let hs = Math.max(0, (changeIdx[0] as number) - CONTEXT);
  let he = Math.min(ops.length, (changeIdx[0] as number) + CONTEXT + 1);
  for (let i = 1; i < changeIdx.length; i++) {
    const c = changeIdx[i] as number;
    if (c - CONTEXT <= he) {
      he = Math.min(ops.length, c + CONTEXT + 1);
    } else {
      hunks.push({ from: hs, to: he });
      hs = Math.max(0, c - CONTEXT);
      he = Math.min(ops.length, c + CONTEXT + 1);
    }
  }
  hunks.push({ from: hs, to: he });

  const aLast = A.lines.length - 1;
  const bLast = B.lines.length - 1;
  const out: string[] = [];
  out.push(baseText.length === 0 ? "--- /dev/null" : `--- a/${path}`);
  out.push(candidateText.length === 0 ? "+++ /dev/null" : `+++ b/${path}`);

  for (const h of hunks) {
    let aStart = -1;
    let bStart = -1;
    let aCount = 0;
    let bCount = 0;
    const body: string[] = [];
    for (let i = h.from; i < h.to; i++) {
      const op = ops[i] as Op;
      if (op.t === " ") {
        if (aStart < 0) aStart = op.a as number;
        if (bStart < 0) bStart = op.b as number;
        aCount++;
        bCount++;
        body.push(` ${A.lines[op.a as number]}`);
        if (op.a === aLast && A.missingNewline) body.push(NO_NEWLINE);
      } else if (op.t === "-") {
        if (aStart < 0) aStart = op.a as number;
        aCount++;
        body.push(`-${A.lines[op.a as number]}`);
        if (op.a === aLast && A.missingNewline) body.push(NO_NEWLINE);
      } else {
        if (bStart < 0) bStart = op.b as number;
        bCount++;
        body.push(`+${B.lines[op.b as number]}`);
        if (op.b === bLast && B.missingNewline) body.push(NO_NEWLINE);
      }
    }
    // A hunk with only insertions needs the a-position of the line it follows.
    if (aStart < 0) {
      aStart = 0;
      for (let i = h.from - 1; i >= 0; i--) {
        const op = ops[i] as Op;
        if (op.a !== undefined) {
          aStart = op.a + 1;
          break;
        }
      }
    }
    if (bStart < 0) {
      bStart = 0;
      for (let i = h.from - 1; i >= 0; i--) {
        const op = ops[i] as Op;
        if (op.b !== undefined) {
          bStart = op.b + 1;
          break;
        }
      }
    }
    const aHdr = aCount === 0 ? `${aStart},0` : aCount === 1 ? `${aStart + 1}` : `${aStart + 1},${aCount}`;
    const bHdr = bCount === 0 ? `${bStart},0` : bCount === 1 ? `${bStart + 1}` : `${bStart + 1},${bCount}`;
    out.push(`@@ -${aHdr} +${bHdr} @@`);
    out.push(...body);
  }
  return `${out.join("\n")}\n`;
}

// ---------------------------------------------------------------------------------------------
// ArtifactStore: content-addressed blobs + immutable JSON (open with "wx", never overwritten)
// ---------------------------------------------------------------------------------------------

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

function assertSegment(name: string, what: string): void {
  if (!SAFE_SEGMENT.test(name) || name === "." || name === "..") {
    throw new Error(`ArtifactStore: invalid ${what} ${JSON.stringify(name.slice(0, 64))}`);
  }
}

export class ArtifactStore {
  private readonly root: string;

  constructor(dir: string) {
    if (typeof dir !== "string" || dir.length === 0) throw new Error("ArtifactStore: dir required");
    this.root = resolve(dir);
  }

  private inside(...parts: string[]): string {
    const p = resolve(this.root, ...parts);
    if (p !== this.root && !p.startsWith(this.root + sep)) {
      throw new Error("ArtifactStore: path escapes store root");
    }
    return p;
  }

  /** Stores bytes under blobs/<sha256>; idempotent. Returns the hex digest. */
  async putBlob(bytes: Uint8Array): Promise<string> {
    const digest = sha256HexSync(bytes);
    const dir = this.inside("blobs");
    await mkdir(dir, { recursive: true });
    const final = join(dir, digest);
    try {
      const st = await stat(final);
      if (st.isFile()) {
        if (st.size !== bytes.byteLength) throw new Error(`ArtifactStore: blob ${digest} exists with a different size`);
        return digest;
      }
      throw new Error(`ArtifactStore: blob path ${digest} exists and is not a regular file`);
    } catch (err) {
      if (!isEnoent(err)) throw err;
    }
    // Write to a unique temp name then rename: a partially written blob never appears under its digest.
    const tmp = join(dir, `.tmp-${digest}-${process.pid}-${Math.random().toString(36).slice(2)}`);
    const fh = await open(tmp, "wx", 0o600);
    try {
      await fh.writeFile(bytes);
      await fh.sync();
    } finally {
      await fh.close();
    }
    try {
      await rename(tmp, final);
    } catch (err) {
      // Lost a race with an identical write; the winner's content has the same digest.
      const st = await stat(final).catch(() => null);
      if (!st) throw err;
    }
    return digest;
  }

  async getBlob(sha256: string): Promise<Uint8Array | null> {
    if (!/^[a-f0-9]{64}$/.test(sha256)) return null;
    try {
      const buf = await readFile(this.inside("blobs", sha256));
      const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
      if (sha256HexSync(bytes) !== sha256) throw new Error(`ArtifactStore: blob ${sha256} is corrupt on disk`);
      return bytes;
    } catch (err) {
      if (isEnoent(err)) return null;
      throw err;
    }
  }

  /** Writes <dir>/<kind>/<id>.json with O_EXCL. Returns false (and writes nothing) if it exists. */
  async putImmutableJson(kind: string, id: string, value: unknown): Promise<boolean> {
    assertSegment(kind, "kind");
    assertSegment(id, "id");
    const dir = this.inside(kind);
    await mkdir(dir, { recursive: true });
    const text = canonicalJson(value);
    if (text === undefined) throw new Error("ArtifactStore: value is not JSON-serializable");
    let fh;
    try {
      fh = await open(join(dir, `${id}.json`), "wx", 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw err;
    }
    try {
      await fh.writeFile(text, "utf8");
      await fh.sync();
    } finally {
      await fh.close();
    }
    return true;
  }

  async getJson<T>(kind: string, id: string): Promise<T | null> {
    assertSegment(kind, "kind");
    assertSegment(id, "id");
    try {
      const text = await readFile(this.inside(kind, `${id}.json`), "utf8");
      return JSON.parse(text) as T;
    } catch (err) {
      if (isEnoent(err)) return null;
      throw err;
    }
  }
}

function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === "ENOENT";
}

// ---------------------------------------------------------------------------------------------
// exportBundle
// ---------------------------------------------------------------------------------------------

export interface ExportBundleInput {
  profile: ProfileManifest;
  baseFiles: Record<string, string>;
  bundle: CandidateBundle;
  verification: VerificationRecord;
  baseline: VerificationRecord;
  task: Task;
  events: RunEvent[];
}

export interface BundleFile {
  path: string;
  bytes: Uint8Array;
}

const enc = new TextEncoder();
const utf8Strict = new TextDecoder("utf-8", { fatal: true });

function utf8(text: string): Uint8Array {
  return enc.encode(text);
}

/**
 * The sealed candidate no longer matches its own identity (manifest, digest, records, bytes).
 * Thrown by `exportBundle`'s identity checks only, so the API can answer 409 with the reason while
 * any other failure stays an internal error.
 */
export class ExportIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExportIntegrityError";
  }
}

export async function exportBundle(input: ExportBundleInput): Promise<{ files: BundleFile[] }> {
  const { profile, baseFiles, bundle, verification, baseline, task, events } = input;

  // Re-verify identity before producing anything downloadable (invariant 3).
  const recomputed = await candidateDigestOf(bundle.manifest);
  if (recomputed !== bundle.candidateDigest) {
    throw new ExportIntegrityError("bundle.candidateDigest does not match its manifest");
  }
  if (verification.candidateDigest !== bundle.candidateDigest) {
    throw new ExportIntegrityError("verification record is for a different candidate");
  }
  if (verification.role !== "candidate" || baseline.role !== "baseline") {
    throw new ExportIntegrityError("records have the wrong roles");
  }
  if (verification.taskId !== task.id || baseline.taskId !== task.id) {
    throw new ExportIntegrityError("records belong to a different task");
  }
  if (bundle.manifest.profileId !== profile.id) {
    throw new ExportIntegrityError("manifest profile does not match");
  }
  const allowed = new Set(profile.allowedReplacementPaths);
  const byPath = new Map<string, CollectedFile>();
  for (const f of bundle.files) {
    if (!allowed.has(f.path)) throw new ExportIntegrityError(`file outside allowed paths: ${f.path}`);
    if (byPath.has(f.path)) throw new ExportIntegrityError(`duplicate file ${f.path}`);
    byPath.set(f.path, f);
  }
  for (const r of bundle.manifest.replacements) {
    const f = byPath.get(r.path);
    if (!f) throw new ExportIntegrityError(`manifest lists ${r.path} but bundle has no bytes for it`);
    const bytes = decodeBase64Strict(f.contentBase64);
    if (!bytes || bytes.byteLength !== r.byteLength || sha256HexSync(bytes) !== r.sha256 || f.sha256 !== r.sha256) {
      throw new ExportIntegrityError(`bytes for ${r.path} do not match the manifest`);
    }
  }

  // patch.diff: one unified diff per replacement, in manifest (sorted) order.
  const diffs: string[] = [];
  const notes: string[] = [];
  for (const r of [...bundle.manifest.replacements].sort((a, b) => a.path.localeCompare(b.path))) {
    const f = byPath.get(r.path) as CollectedFile;
    const bytes = decodeBase64Strict(f.contentBase64) as Uint8Array;
    let candidateText: string;
    try {
      candidateText = utf8Strict.decode(bytes);
    } catch {
      notes.push(`${r.path}: candidate bytes are not valid UTF-8; no text diff produced (bytes are in reproduction/files/)`);
      continue;
    }
    const baseText = baseFiles[r.path] ?? "";
    if (!(r.path in baseFiles)) notes.push(`${r.path}: not present in the base tree; diff is against /dev/null`);
    const d = unifiedDiff(r.path, baseText, candidateText);
    if (d.length === 0) {
      notes.push(`${r.path}: identical to the base tree (listed as a replacement but unchanged)`);
      continue;
    }
    diffs.push(`diff --git a/${r.path} b/${r.path}\n${d}`);
  }

  const files: BundleFile[] = [];
  files.push({ path: "patch.diff", bytes: utf8(diffs.join("")) });
  files.push({ path: "manifest.json", bytes: utf8(`${canonicalJson(bundle.manifest)}\n`) });
  files.push({ path: "verification.json", bytes: utf8(`${canonicalJson(verification)}\n`) });
  files.push({ path: "baseline.json", bytes: utf8(`${canonicalJson(baseline)}\n`) });
  files.push({ path: "task.json", bytes: utf8(`${canonicalJson(redactTask(task))}\n`) });
  files.push({
    path: "events.jsonl",
    bytes: utf8(events.map((e) => canonicalJson(e)).join("\n") + (events.length ? "\n" : "")),
  });
  for (const r of bundle.manifest.replacements) {
    const f = byPath.get(r.path) as CollectedFile;
    files.push({ path: `reproduction/files/${r.path}`, bytes: decodeBase64Strict(f.contentBase64) as Uint8Array });
  }
  files.push({ path: "reproduction/README.txt", bytes: utf8(reproductionReadme(profile, bundle, verification)) });
  files.push({ path: "README.txt", bytes: utf8(topReadme(profile, bundle, verification, baseline, task, notes)) });

  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files };
}

function redactTask(task: Task): Omit<Task, "leaseId" | "leaseUntil"> {
  const { leaseId: _l, leaseUntil: _u, ...rest } = task;
  return rest;
}

function reproductionReadme(profile: ProfileManifest, bundle: CandidateBundle, verification: VerificationRecord): string {
  const lines = [
    `Reproduction instructions for candidate ${bundle.candidateDigest}`,
    "",
    `Profile:          ${profile.id} (${profile.displayName})`,
    `Repository:       ${profile.repository}`,
    `Issue:            ${profile.issueUrl}`,
    `Baseline commit:  ${profile.baselineCommit}`,
    `Baseline tree:    sha256 ${profile.baselineTreeDigest} over sorted "path sha256" lines`,
    `Runtime image:    ${profile.runtimeImage} (digest ${verification.runtimeImageDigest})`,
    `Adapter digest:   ${verification.adapterDigest}`,
    `Contract digest:  ${verification.contractDigest}`,
    `Comparator:       ${verification.comparatorVersion}`,
    "",
    "How to re-run the frozen cases yourself:",
    "",
    `1. Check out ${profile.repository} at ${profile.baselineCommit}.`,
    "   Verify the tree: sha256 of the sorted \"<path> <sha256>\" lines of every tracked file must equal",
    `   ${profile.baselineTreeDigest}.`,
    "2. Apply patch.diff from the repository root with:  patch -p1 < patch.diff",
    "   (equivalently, copy reproduction/files/<path> over the same paths). Only these paths change:",
    ...bundle.manifest.replacements.map((r) => `     - ${r.path}  (${r.byteLength} bytes, sha256 ${r.sha256})`),
    "3. Verify the candidate identity: build the SourceManifest exactly as manifest.json and check",
    `   sha256(canonical JSON) == ${bundle.candidateDigest}.`,
    `4. The frozen cases are in profiles/${profile.id}/${profile.contractPath} of the Airlock repository;`,
    `   verification.json lists each case id, its expected behavior and what was observed.`,
    "   Each case input is the keyword-argument dictionary handed to the profile adapter",
    `   (${profile.adapterModule}.run_case). Run it in a clean virtual environment with no network,`,
    "   from the patched tree, and compare against the expectation kind:",
    '     - "returns": canonical JSON (sorted keys, no whitespace) of the return value must match byte-for-byte',
    '     - "raises":  the exception type must match exactly and the message must contain messageIncludes',
    "5. Re-run the baseline (step 1 without the patch) to confirm the reported case fails there; baseline.json",
    "   records what Airlock observed.",
    "",
    "Airlock ran these cases in a fresh one-shot container per role, then destroyed it. The recorded",
    "runtime tier, guest uname, host check and teardown listing are in verification.json under runtimeProfile.",
    "",
  ];
  return lines.join("\n");
}

function topReadme(
  profile: ProfileManifest,
  bundle: CandidateBundle,
  verification: VerificationRecord,
  baseline: VerificationRecord,
  task: Task,
  notes: string[],
): string {
  const passedCases = verification.cases.filter((c) => c.passed).length;
  const rt = verification.runtimeProfile;
  const lines = [
    "Airlock export bundle",
    "=====================",
    "",
    `Task:              ${task.id}`,
    `Outcome:           ${task.outcome ?? "(none recorded)"}`,
    `Profile:           ${profile.id}`,
    `Candidate digest:  ${bundle.candidateDigest}`,
    `Verification:      ${verification.id}  passed=${verification.passed}  (${passedCases}/${verification.requiredCases} cases, ${verification.completedCases} observed)`,
    `Baseline:          ${baseline.id}  reproduced=${baseline.passed}`,
    `Runtime:           ${rt.inspection.runtime}${rt.inspection.devUnsafe ? " (DEV-UNSAFE: local development runtime, not a deployment)" : ""}`,
    `Guest uname:       ${rt.inspection.guestUname}`,
    `Teardown clean:    ${rt.teardown.clean}`,
    "",
    "Contents",
    "--------",
    "patch.diff               unified diff of every replaced file against the baseline commit (apply with patch -p1)",
    "manifest.json            the sealed SourceManifest; sha256(canonical JSON) is the candidate digest above",
    "verification.json        the comparator's record for the candidate: per-case expected vs observed, exec log,",
    "                         runtime inspection, host check and teardown listing",
    "baseline.json            the same record for the unmodified baseline (proves the reported failure reproduced)",
    "task.json                the task as recorded by the control plane (lease fields removed)",
    "events.jsonl             the run's event log, one JSON object per line",
    "reproduction/README.txt  how to re-run the frozen cases without Airlock",
    "reproduction/files/      the exact candidate bytes for each replaced path",
    "",
    'What "Passed these checks" means',
    "--------------------------------",
    `It means exactly this: the ${verification.requiredCases} frozen cases in the profile's acceptance contract`,
    "(contract digest above) were executed against this exact candidate (digest above) in a fresh sandbox,",
    "and every case produced the contract's expected candidate behavior, as judged by the external comparator",
    `version ${verification.comparatorVersion} from typed observations plus the supervisor's own exit/timeout records.`,
    "The baseline record shows the same cases against the unmodified commit, where the reported case failed.",
    "",
    "What it does NOT mean",
    "---------------------",
    "- It does not mean the change is safe, certified, secure, complete or correct in general.",
    "- It does not mean any test suite passed. Nothing the agent printed, wrote or claimed inside the sandbox",
    "  (logs, exit codes, test files) carried any weight in the verdict.",
    "- It does not mean behavior outside the frozen cases is unchanged. A candidate can overfit finite checks.",
    "- It does not mean the runtime tier was stronger than what verification.json records under runtimeProfile.",
    "- This profile is a disclosed historical replay of a known issue; it is not a claim of solving unseen bugs.",
    "",
    "Review patch.diff as you would any external contribution before merging it.",
    "",
  ];
  if (notes.length > 0) {
    lines.push("Notes", "-----", ...notes.map((n) => `- ${n}`), "");
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------------------------
// zipFiles: store-only zip writer, pure TS, reproducible (sorted entries, fixed timestamps)
// ---------------------------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = (CRC_TABLE[(c ^ (bytes[i] as number)) & 0xff] as number) ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

// DOS date/time for 1980-01-01 00:00:00, the earliest representable zip timestamp.
const DOS_TIME = 0x0000;
const DOS_DATE = 0x0021;
const MAX_ENTRY_BYTES = 0xffffffff;
const MAX_ENTRIES = 0xffff;

export function zipFiles(files: { path: string; bytes: Uint8Array }[]): Uint8Array {
  if (files.length > MAX_ENTRIES) throw new Error(`zipFiles: ${files.length} entries exceeds ${MAX_ENTRIES}`);
  const entries = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const seen = new Set<string>();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  let total = 0;

  for (const f of entries) {
    if (isTraversal(f.path)) throw new Error(`zipFiles: invalid entry path ${JSON.stringify(f.path)}`);
    if (seen.has(f.path)) throw new Error(`zipFiles: duplicate entry ${f.path}`);
    seen.add(f.path);
    if (f.bytes.byteLength > MAX_ENTRY_BYTES) throw new Error(`zipFiles: ${f.path} too large for zip32`);
    const name = enc.encode(f.path);
    if (name.byteLength > 0xffff) throw new Error(`zipFiles: entry name too long: ${f.path.slice(0, 64)}`);
    const crc = crc32(f.bytes);
    const size = f.bytes.byteLength;

    const local = new Uint8Array(30 + name.byteLength + size);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(6, 0x0800, true); // flags: UTF-8 names
    lv.setUint16(8, 0, true); // method: store
    lv.setUint16(10, DOS_TIME, true);
    lv.setUint16(12, DOS_DATE, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true);
    lv.setUint32(22, size, true);
    lv.setUint16(26, name.byteLength, true);
    lv.setUint16(28, 0, true);
    local.set(name, 30);
    local.set(f.bytes, 30 + name.byteLength);
    locals.push(local);

    const central = new Uint8Array(46 + name.byteLength);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true); // version made by
    cv.setUint16(6, 20, true); // version needed
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, DOS_TIME, true);
    cv.setUint16(14, DOS_DATE, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, name.byteLength, true);
    cv.setUint16(30, 0, true); // extra
    cv.setUint16(32, 0, true); // comment
    cv.setUint16(34, 0, true); // disk
    cv.setUint16(36, 0, true); // internal attrs
    cv.setUint32(38, 0o100644 << 16, true); // external attrs: regular file 0644
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    centrals.push(central);

    offset += local.byteLength;
    total += local.byteLength + central.byteLength;
    if (offset > MAX_ENTRY_BYTES) throw new Error("zipFiles: archive exceeds zip32 limits");
  }

  const cdSize = centrals.reduce((n, c) => n + c.byteLength, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, 0, true);

  const out = new Uint8Array(total + 22);
  let pos = 0;
  for (const l of locals) {
    out.set(l, pos);
    pos += l.byteLength;
  }
  for (const c of centrals) {
    out.set(c, pos);
    pos += c.byteLength;
  }
  out.set(eocd, pos);
  return out;
}
