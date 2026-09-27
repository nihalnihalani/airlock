/**
 * General code sandboxes (milestone 4): the `analysis` (offline Python data image) and `node`
 * (offline Node image) roles.
 *
 * Workspace layout (runtime/analysis/run.sh, runtime/node/run.sh, runtime/outputs/collect_outputs.py):
 *
 *   /workspace/inputs/   placed by the supervisor only (`put`), root-owned, files 0444, dir 0755:
 *                        the sandbox user (uid 1000) can read but never change or add inputs
 *   /workspace/code/     model code (`write`, text), owned by uid 1000
 *   /workspace/outputs/  results; the ONLY directory collected, by collect_outputs.py in a fresh
 *                        analysis-image container with the stopped volume mounted read-only
 *
 * Everything here is pure (no Docker): path rules, strict base64, the runtime profiles derived from
 * configuration, and the supervisor's re-validation of the collector's envelope. The envelope is
 * untrusted data even after it validates.
 */
import { createHash } from "node:crypto";
import { type Caps, OutputEnvelope, relPath, workspaceBytesOf } from "@airlock/contracts";
import type { CodeRole, CodeRuntimeConfig } from "./config";
import { NODE_READINESS_ARGV, READINESS_ARGV } from "./runtime";

export const CODE_ROLES = ["analysis", "node"] as const;
export function isCodeRole(role: string): role is CodeRole {
  return role === "analysis" || role === "node";
}

/** What provisioning needs from a profile: repository profiles (ProfileManifest) satisfy it structurally. */
export interface SandboxProfile {
  id: string;
  runtimeImage: string;
  caps: Caps;
  /** Own image pin (code runtimes); absent = the repository runtime pin (AIRLOCK_RUNTIME_IMAGE_ID). */
  imagePin?: { imageId: string | undefined };
  readinessArgv?: string[];
  extraEnvPrefixes?: string[];
}

/** Variables the code images set themselves (docker image inspect), on top of runtime.ts ENV_ALLOWED_PREFIXES. */
export const CODE_ENV_PREFIXES: Record<CodeRole, string[]> = {
  analysis: ["MPLBACKEND=", "MPLCONFIGDIR="],
  node: ["NODE_VERSION=", "YARN_VERSION=", "NODE_ENV=", "NO_UPDATE_NOTIFIER="],
};

/** collect_outputs.py ceilings (arguments may only lower them). */
export const OUTPUT_LIMITS = { maxFileBytes: 5 * 1024 * 1024, maxTotalBytes: 20 * 1024 * 1024, maxFiles: 50, maxRejected: 200 } as const;
/** The media types collect_outputs.py assigns; anything else in an envelope is a protocol error. */
export const OUTPUT_MEDIA_TYPES = new Set(["text/csv", "application/json", "text/plain", "text/markdown", "image/png", "text/x-python", "text/javascript"]);

export const OUTPUTS_COLLECTOR = "/opt/airlock/collect_outputs.py";
export const CODE_WORKSPACE = "/workspace";

export function codeCaps(plane: CodeRuntimeConfig): Caps {
  return {
    cpus: plane.cpus,
    memoryBytes: plane.memoryBytes,
    pidsLimit: plane.pidsLimit,
    commandTimeoutMs: plane.commandTimeoutMs,
    attemptTimeoutMs: plane.attemptTimeoutMs,
    outputBytes: plane.outputBytes,
    maxRepairAttempts: 1,
    maxModelCalls: 1,
    maxFileBytes: plane.maxFileBytes,
    maxTotalBytes: OUTPUT_LIMITS.maxTotalBytes,
    maxFiles: OUTPUT_LIMITS.maxFiles,
    workspaceBytes: plane.workspaceBytes,
  };
}

export function codeProfile(plane: CodeRuntimeConfig): SandboxProfile {
  return {
    id: plane.role,
    runtimeImage: plane.image,
    caps: codeCaps(plane),
    imagePin: { imageId: plane.imageId },
    readinessArgv: plane.role === "node" ? NODE_READINESS_ARGV : READINESS_ARGV,
    extraEnvPrefixes: CODE_ENV_PREFIXES[plane.role],
  };
}

/**
 * The output collector for an analysis OR node attempt: the analysis image (it carries
 * collect_outputs.py and Python), the analysis caps, but the attempt's own workspace size, because
 * provisioning re-checks the mounted volume is exactly the bounded tmpfs that attempt created.
 */
export function outputsCollectorProfile(analysis: CodeRuntimeConfig, attemptCaps: Caps): SandboxProfile {
  const base = codeProfile(analysis);
  return { ...base, id: "outputs-collector", caps: { ...base.caps, workspaceBytes: workspaceBytesOf(attemptCaps) } };
}

// ---------------------------------------------------------------------------------------------
// Path rules
// ---------------------------------------------------------------------------------------------

/** One path component: what run.sh accepts for code/, applied to inputs/ and outputs/ reads too. */
const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const MAX_SEGMENTS = 6;

/**
 * Why `path` is not a file path under one of `tops` (e.g. `inputs/regions.csv`), or undefined.
 * Components are plain names (no dot-files, no traversal, no spaces or control characters).
 */
export function codePathProblem(path: string, tops: readonly string[]): string | undefined {
  if (!relPath.safeParse(path).success) return `Path ${JSON.stringify(path.slice(0, 80))} is not a relative path without traversal.`;
  const segments = path.split("/");
  if (segments.length < 2 || !tops.includes(segments[0]!)) return `Path ${path} must be a file under ${tops.map((t) => `${t}/`).join(" or ")}.`;
  if (segments.length > MAX_SEGMENTS) return `Path ${path} is deeper than ${MAX_SEGMENTS} components.`;
  const bad = segments.find((s) => !SEGMENT.test(s));
  if (bad !== undefined) return `Path component ${JSON.stringify(bad.slice(0, 80))} must match ${SEGMENT.source}.`;
  return undefined;
}

/** Strict base64 (standard alphabet, padded, canonical): anything else is refused, never "best effort". */
export function decodeBase64Strict(text: string): Uint8Array | undefined {
  if (text.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) return undefined;
  const bytes = Buffer.from(text, "base64");
  if (bytes.toString("base64") !== text) return undefined;
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Per-attempt input quota: `reserve` is synchronous (no await between the check and the record), so
 * two concurrent puts cannot both fit into the last bytes. A definite failure releases; an uncertain
 * one keeps the bytes counted (the write may have landed).
 */
export class InputQuota {
  private readonly placed = new Map<string, Map<string, number>>();

  reserve(attemptId: string, path: string, bytes: number, limits: { maxFileBytes: number; maxTotalBytes: number }): string | undefined {
    if (bytes > limits.maxFileBytes) return `Input is ${bytes} bytes; the per-file limit is ${limits.maxFileBytes}.`;
    const files = this.placed.get(attemptId) ?? new Map<string, number>();
    if (files.has(path)) return `Input ${path} was already placed; inputs are immutable once placed.`;
    const total = [...files.values()].reduce((n, b) => n + b, 0);
    if (total + bytes > limits.maxTotalBytes) return `Inputs would total ${total + bytes} bytes; the per-attempt limit is ${limits.maxTotalBytes}.`;
    files.set(path, bytes);
    this.placed.set(attemptId, files);
    return undefined;
  }

  release(attemptId: string, path: string): void {
    this.placed.get(attemptId)?.delete(path);
  }

  total(attemptId: string): number {
    return [...(this.placed.get(attemptId)?.values() ?? [])].reduce((n, b) => n + b, 0);
  }

  forget(attemptId: string): void {
    this.placed.delete(attemptId);
  }
}

// ---------------------------------------------------------------------------------------------
// Collector envelope re-validation
// ---------------------------------------------------------------------------------------------

/**
 * The supervisor does not trust the collector's arithmetic: shape (contracts OutputEnvelope), counts
 * and byte ceilings, unique paths, known media types, and every file's base64 re-decoded and checked
 * against its byteLength and sha256. Returns the envelope or why it is refused.
 */
export function validateOutputEnvelope(raw: unknown): { ok: true; envelope: OutputEnvelope } | { ok: false; reason: string } {
  const parsed = OutputEnvelope.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, reason: `envelope does not match OutputEnvelope (${issue ? `${issue.path.join(".")}: ${issue.message}` : "shape"})` };
  }
  const envelope = parsed.data;
  if (envelope.files.length > OUTPUT_LIMITS.maxFiles) return { ok: false, reason: `envelope lists ${envelope.files.length} files; the limit is ${OUTPUT_LIMITS.maxFiles}` };
  if (envelope.rejected.length > OUTPUT_LIMITS.maxRejected + 1) return { ok: false, reason: "envelope lists too many rejections" };
  const seen = new Set<string>();
  let total = 0;
  for (const file of envelope.files) {
    const key = file.path.normalize("NFC").toLowerCase();
    if (seen.has(key)) return { ok: false, reason: `duplicate output path ${file.path}` };
    seen.add(key);
    if (!OUTPUT_MEDIA_TYPES.has(file.mediaType)) return { ok: false, reason: `output ${file.path} has unexpected media type ${file.mediaType.slice(0, 64)}` };
    if (file.byteLength > OUTPUT_LIMITS.maxFileBytes) return { ok: false, reason: `output ${file.path} exceeds ${OUTPUT_LIMITS.maxFileBytes} bytes` };
    const bytes = decodeBase64Strict(file.contentBase64);
    if (!bytes) return { ok: false, reason: `output ${file.path} is not strict base64` };
    if (bytes.byteLength !== file.byteLength) return { ok: false, reason: `output ${file.path} byteLength does not match its bytes` };
    if (sha256Hex(bytes) !== file.sha256) return { ok: false, reason: `output ${file.path} sha256 does not match its bytes` };
    total += bytes.byteLength;
    if (total > OUTPUT_LIMITS.maxTotalBytes) return { ok: false, reason: `outputs exceed ${OUTPUT_LIMITS.maxTotalBytes} bytes in total` };
  }
  return { ok: true, envelope };
}

/** stdout bytes the collector may print: every accepted byte as base64 plus per-file and rejection framing. */
export const OUTPUTS_COLLECTOR_STDOUT_BYTES = Math.ceil((OUTPUT_LIMITS.maxTotalBytes * 4) / 3) + OUTPUT_LIMITS.maxFiles * 2048 + OUTPUT_LIMITS.maxRejected * 1024 + 65_536;
