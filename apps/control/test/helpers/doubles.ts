/**
 * Thin local doubles for the modules owned by the other control agent (verifier, artifacts,
 * vultr-client) plus a temp profile fixture. They implement the documented signatures with the
 * minimum semantics the handler and API tests need; the real modules have their own tests.
 */
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalJson,
  type CandidateBundle,
  type CaseContract,
  type CollectedFile,
  type Expectation,
  type FileEnvelope,
  type Observation,
  type ProfileManifest,
  type RunEvent,
  type SourceManifest,
  type Task,
  type VerificationRecord,
} from "@airlock/contracts";
import { baselineTreeDigest, loadProfile, type LoadedProfile } from "../../src/profiles.ts";
import type { ArtifactStoreLike, BuildManifestFn, ChatMessage, CompareFn, ModelDriver, ValidateEnvelopeFn } from "../../src/repair-handler.ts";
import type { ExportBundleFn, ZipFilesFn } from "../../src/api.ts";

const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

// ---- verifier double ---------------------------------------------------------------------------
function matches(expected: Expectation, observed: Observation | undefined): { passed: boolean; reason: string } {
  if (!observed) return { passed: false, reason: "no observation" };
  if (expected.kind === "raises") {
    if (observed.status !== "error") return { passed: false, reason: `expected ${expected.exceptionType}, got status ok` };
    if (observed.exceptionType !== expected.exceptionType) return { passed: false, reason: `expected ${expected.exceptionType}, got ${observed.exceptionType}` };
    if (expected.messageIncludes && !(observed.message ?? "").includes(expected.messageIncludes)) return { passed: false, reason: "message mismatch" };
    return { passed: true, reason: "raised as expected" };
  }
  if (observed.status !== "ok") return { passed: false, reason: `expected return, got ${observed.exceptionType ?? "error"}` };
  if (observed.valueCanonical !== expected.valueCanonical) return { passed: false, reason: `value mismatch: ${observed.valueCanonical}` };
  return { passed: true, reason: "returned expected value" };
}

export const compareDouble: CompareFn = (input) => {
  const seen = new Map<string, number>();
  for (const o of input.invoke.observations) seen.set(o.caseId, (seen.get(o.caseId) ?? 0) + 1);
  const cases = input.contract.cases.map((c) => {
    const expected = input.role === "baseline" ? c.baseline : c.candidate;
    const observed = seen.get(c.id) === 1 ? input.invoke.observations.find((o) => o.caseId === c.id) : undefined;
    const verdict = matches(expected, observed);
    return { caseId: c.id, kind: c.kind, expected, ...(observed ? { observed } : {}), passed: verdict.passed, reason: seen.get(c.id) === undefined ? "missing" : (seen.get(c.id) ?? 0) > 1 ? "duplicate" : verdict.reason };
  });
  const completed = cases.filter((c) => c.observed !== undefined).length;
  const passed = input.invoke.exec.status === "succeeded" && input.invoke.protocolErrors.length === 0 && completed === cases.length && cases.every((c) => c.passed);
  return {
    schemaVersion: 1,
    id: input.id,
    taskId: input.taskId,
    role: input.role,
    candidateDigest: input.candidateDigest,
    runtimeImageDigest: input.invoke.inspection.imageDigest,
    adapterDigest: input.adapterDigest,
    contractDigest: input.contractDigest,
    comparatorVersion: "double-1",
    cases,
    requiredCases: cases.length,
    completedCases: completed,
    exec: input.invoke.exec,
    runtimeProfile: { host: input.host, inspection: input.invoke.inspection, teardown: input.invoke.teardown },
    passed,
    createdAt: input.now,
  };
};

// ---- artifacts doubles ----------------------------------------------------------------------------
export const validateEnvelopeDouble: ValidateEnvelopeFn = (envelope: FileEnvelope, profile: ProfileManifest) => {
  const reasons: string[] = [];
  const seen = new Set<string>();
  for (const f of envelope.files) {
    if (!profile.allowedReplacementPaths.includes(f.path)) reasons.push(`${f.path}: not allowed`);
    if (seen.has(f.path)) reasons.push(`${f.path}: duplicate`);
    seen.add(f.path);
    const bytes = Buffer.from(f.contentBase64, "base64");
    if (bytes.byteLength !== f.byteLength) reasons.push(`${f.path}: length mismatch`);
    if (sha(bytes) !== f.sha256) reasons.push(`${f.path}: digest mismatch`);
    if (f.byteLength > profile.caps.maxFileBytes) reasons.push(`${f.path}: too large`);
  }
  if (envelope.files.length > profile.caps.maxFiles) reasons.push("too many files");
  return reasons.length ? { ok: false, reasons } : { ok: true, files: envelope.files };
};

export const buildManifestDouble: BuildManifestFn = (profile: ProfileManifest, files: CollectedFile[]): SourceManifest => ({
  schemaVersion: 1,
  profileId: profile.id,
  baselineCommit: profile.baselineCommit,
  baselineTreeDigest: profile.baselineTreeDigest,
  replacements: [...files].sort((a, b) => a.path.localeCompare(b.path)).map((f) => ({ path: f.path, byteLength: f.byteLength, sha256: f.sha256 })),
});

export class MemoryArtifactStore implements ArtifactStoreLike {
  readonly blobs = new Map<string, Uint8Array>();
  readonly json = new Map<string, unknown>();
  async putBlob(bytes: Uint8Array) {
    const d = sha(bytes);
    this.blobs.set(d, bytes);
    return d;
  }
  async getBlob(digest: string) {
    return this.blobs.get(digest) ?? null;
  }
  async putImmutableJson(kind: string, id: string, value: unknown) {
    const key = `${kind}/${id}`;
    if (this.json.has(key)) return false;
    this.json.set(key, JSON.parse(JSON.stringify(value)));
    return true;
  }
  async getJson<T>(kind: string, id: string) {
    return (this.json.get(`${kind}/${id}`) as T | undefined) ?? null;
  }
}

export const exportBundleDouble: ExportBundleFn = async (input: {
  profile: ProfileManifest;
  baseFiles: Record<string, string>;
  bundle: CandidateBundle;
  verification: VerificationRecord;
  baseline: VerificationRecord;
  task: Task;
  events: RunEvent[];
}) => {
  const enc = new TextEncoder();
  return {
    files: [
      { path: "manifest.json", bytes: enc.encode(canonicalJson(input.bundle.manifest)) },
      { path: "verification.json", bytes: enc.encode(canonicalJson(input.verification)) },
      { path: "baseline.json", bytes: enc.encode(canonicalJson(input.baseline)) },
      { path: "README.txt", bytes: enc.encode(`task ${input.task.id} events ${input.events.length} profile ${JSON.stringify(input.profile)}`) },
    ],
  };
};

export const zipFilesDouble: ZipFilesFn = (files) => {
  const enc = new TextEncoder();
  const parts = files.map((f) => `${f.path}\n${Buffer.from(f.bytes).toString("base64")}\n`);
  return enc.encode(`FAKEZIP\n${parts.join("")}`);
};

// ---- scripted driver double ------------------------------------------------------------------------
export type ScriptedTurn = {
  toolCalls?: { name: string; args: unknown }[];
  text?: string;
  /** Default: "tool_calls" when calls are present, else "stop". "length" models a turn cut by max_tokens. */
  finishReason?: "stop" | "tool_calls" | "length" | "other";
  reasoning?: string;
  reasoningTokens?: number;
};

export function scriptedDriverDouble(script: ScriptedTurn[], options: { onChat?: (messages: ChatMessage[]) => void; repeatLast?: boolean } = {}): ModelDriver & { calls: number } {
  let cursor = 0;
  let counter = 0;
  const driver = {
    calls: 0,
    async chat(input: { system: string; messages: ChatMessage[]; signal?: AbortSignal }) {
      driver.calls++;
      if (input.signal?.aborted) throw new Error("aborted");
      options.onChat?.(input.messages);
      const turn = script[cursor] ?? (options.repeatLast ? script[script.length - 1] : undefined);
      cursor = Math.min(cursor + 1, script.length);
      if (!turn) return { text: "", toolCalls: [], finishReason: "stop" as const, reasoning: "", usage: { input: 0, output: 0 } };
      const toolCalls = (turn.toolCalls ?? []).map((tc) => ({ id: `call-${++counter}`, name: tc.name, args: tc.args }));
      return {
        text: turn.text ?? "",
        toolCalls,
        finishReason: turn.finishReason ?? (toolCalls.length > 0 ? ("tool_calls" as const) : ("stop" as const)),
        reasoning: turn.reasoning ?? "",
        usage: { input: 10, output: 5, ...(turn.reasoningTokens !== undefined ? { reasoning: turn.reasoningTokens } : {}) },
      };
    },
  };
  return driver;
}

// ---- profile fixture ---------------------------------------------------------------------------------
export const FX_BROKEN_SOURCE = "def compute(x):\n    if x == 0:\n        raise ValueError('zero not supported')\n    return x * 2\n";
export const FX_FIXED_SOURCE = "def compute(x):\n    if x == 0:\n        return 0  # FIXED\n    return x * 2\n";

export interface Fixture {
  root: string;
  profilesDir: string;
  runtimeDir: string;
  profile: LoadedProfile;
  cleanup: () => Promise<void>;
}

/** Writes profiles/fx-1/{profile.json,contract.json,fx_adapter.py,base/...} and runtime/adapter.py under a temp dir. */
export async function makeFixture(overrides: Partial<ProfileManifest["caps"]> = {}): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "airlock-control-"));
  const profilesDir = join(root, "profiles");
  const runtimeDir = join(root, "runtime");
  const dir = join(profilesDir, "fx-1");
  await mkdir(join(dir, "base", "lib"), { recursive: true });
  await mkdir(runtimeDir, { recursive: true });
  await writeFile(join(dir, "base", "lib", "mod.py"), FX_BROKEN_SOURCE);
  await writeFile(join(dir, "base", "README.md"), "# fixture\n");
  await writeFile(join(dir, "fx_adapter.py"), "def run_case(input):\n    from lib.mod import compute\n    return compute(**input)\n");
  await writeFile(join(runtimeDir, "adapter.py"), "# fake adapter\n");
  const treeDigest = await baselineTreeDigest(join(dir, "base"));
  const manifest: ProfileManifest = {
    schemaVersion: 1,
    id: "fx-1",
    displayName: "Fixture: compute(0) raises",
    issueUrl: "https://example.com/issues/1",
    repository: "https://example.com/fixture",
    baselineCommit: "a".repeat(40),
    baselineTreeDigest: treeDigest,
    referenceCommitMaintainerOnly: "b".repeat(40),
    runtimeImage: "airlock-runtime-python:fx-1",
    language: "python",
    sourceRoot: "/workspace/src",
    allowedReplacementPaths: ["lib/mod.py"],
    readablePaths: ["lib/mod.py", "README.md"],
    adapterModule: "fx_adapter",
    contractPath: "contract.json",
    caps: {
      cpus: 1,
      memoryBytes: 536870912,
      pidsLimit: 64,
      commandTimeoutMs: 30000,
      attemptTimeoutMs: 300000,
      outputBytes: 65536,
      maxRepairAttempts: 2,
      maxModelCalls: 10,
      maxFileBytes: 1048576,
      maxTotalBytes: 4194304,
      maxFiles: 4,
      ...overrides,
    },
  };
  const contract: CaseContract = {
    schemaVersion: 1,
    profileId: "fx-1",
    cases: [
      {
        id: "reported-zero",
        kind: "reported",
        title: "compute(0) raises",
        input: { x: 0 },
        baseline: { kind: "raises", exceptionType: "ValueError", messageIncludes: "zero" },
        candidate: { kind: "returns", valueCanonical: "0" },
      },
      {
        id: "reg-two",
        kind: "regression",
        title: "compute(2) returns 4",
        input: { x: 2 },
        baseline: { kind: "returns", valueCanonical: "4" },
        candidate: { kind: "returns", valueCanonical: "4" },
      },
    ],
  };
  await writeFile(join(dir, "profile.json"), JSON.stringify(manifest, null, 2));
  await writeFile(join(dir, "contract.json"), JSON.stringify(contract, null, 2));
  const profile = await loadProfile(dir, "fx-1");
  return { root, profilesDir, runtimeDir, profile, cleanup: () => rm(root, { recursive: true, force: true }) };
}

/** Observations for the fixture: broken unless lib/mod.py contains "FIXED". */
export function fixtureObserve(role: string, files: Map<string, string>, request: { cases: { id: string; input: Record<string, unknown> }[] }): Observation[] {
  const fixed = role !== "baseline" && (files.get("lib/mod.py") ?? "").includes("FIXED");
  return request.cases.map((c) => {
    const x = Number(c.input.x);
    if (x === 0 && !fixed) return { caseId: c.id, status: "error", exceptionType: "ValueError", message: "zero not supported" };
    return { caseId: c.id, status: "ok", valueCanonical: String(x * 2) };
  });
}
