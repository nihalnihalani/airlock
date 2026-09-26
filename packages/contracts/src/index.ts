/**
 * Airlock shared contracts.
 *
 * Every boundary in the system speaks these schemas: web ↔ control API, control ↔ supervisor,
 * supervisor ↔ runtime adapter, comparator ↔ verification record. They are the fixed seam that lets
 * the packages be built independently; change them deliberately and bump `SCHEMA_VERSION`.
 *
 * Trust reminder (CLAUDE.md §3): anything produced inside a sandbox — adapter output, author
 * stdout, collected file bytes — is *untrusted data* even after it validates against a schema here.
 * Validation bounds shape and size; it never grants authority.
 */
import { z } from "zod";

export const SCHEMA_VERSION = 1 as const;

// ---------------------------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------------------------

/** Plain identifier: what OpenBot's `names.ts` accepts. Never becomes a path or a Docker option. */
export const plainId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, "letters, digits, hyphen and underscore only");

export const sha256Hex = z.string().regex(/^[a-f0-9]{64}$/, "sha256 hex");
export const gitSha = z.string().regex(/^[a-f0-9]{40}$/, "40-hex git sha");
export const isoDate = z.string().datetime({ offset: true });

/** Relative POSIX path inside a source tree. No traversal, no absolute, no empty segments. */
export const relPath = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (p) =>
      !p.startsWith("/") &&
      !p.includes("\\") &&
      !p.includes("\0") &&
      p.split("/").every((seg) => seg !== "" && seg !== "." && seg !== ".."),
    "relative path without traversal",
  );

// ---------------------------------------------------------------------------------------------
// Phases, statuses, outcomes
// ---------------------------------------------------------------------------------------------

/** Controller phases (37 §"The end-to-end run"). Separate from worker status. */
export const Phase = z.enum([
  "prepare",
  "reproduce",
  "baseline",
  "repair",
  "freeze",
  "verify",
  "ready",
]);
export type Phase = z.infer<typeof Phase>;

/** Terminal outcomes (35 §3). "CANDIDATE_PASSED_CHECKS" means exactly the frozen cases passed. */
export const Outcome = z.enum([
  "NOT_REPRODUCED",
  "REPRODUCED_UNRESOLVED",
  "CANDIDATE_PASSED_CHECKS",
  "CHECKS_FAILED",
  "INCONCLUSIVE",
  "STOPPED_LIMIT",
]);
export type Outcome = z.infer<typeof Outcome>;

/** Worker status, adapted from OpenMuse `AgentTask.status` plus explicit cancellation states. */
export const TaskStatus = z.enum([
  "queued",
  "running",
  "cancelling",
  "cancelled",
  "done",
  "failed",
]);
export type TaskStatus = z.infer<typeof TaskStatus>;

/** Container roles the supervisor may create. Each is disposable and per attempt. */
export const SandboxRole = z.enum(["author", "baseline", "candidate", "preview", "hostile"]);
export type SandboxRole = z.infer<typeof SandboxRole>;

// ---------------------------------------------------------------------------------------------
// Runtime tier, host check, isolation probe (the five checkpoints)
// ---------------------------------------------------------------------------------------------

export const RuntimeName = z.enum(["kata", "runsc", "runc"]);
export type RuntimeName = z.infer<typeof RuntimeName>;

/** Checkpoint 1: what the supervisor found on its host. Recorded per supervisor start, echoed per run. */
export const HostCheck = z.object({
  checkedAt: isoDate,
  dockerVersion: z.string(),
  cpuVirtualization: z.boolean(),
  kvmPresent: z.boolean(),
  kvmReadWrite: z.boolean(),
  availableRuntimes: z.array(z.string()),
  selectedRuntime: RuntimeName,
  /** True only for local development on plain runc. Never true in a deployment. */
  devUnsafe: z.boolean(),
});
export type HostCheck = z.infer<typeof HostCheck>;

/** Effective container configuration, inspected before dispatch (OpenMuse computer.ts pattern). */
export const RuntimeInspection = z.object({
  inspectedAt: isoDate,
  container: z.string(),
  runtime: RuntimeName,
  devUnsafe: z.boolean(),
  imageDigest: z.string(),
  /** Checkpoint 3: read from inside the sandbox. Untrusted text, bounded. */
  guestUname: z.string().max(512),
  guestHostname: z.string().max(128),
  checks: z.object({
    networkNone: z.boolean(),
    nonRootUser: z.boolean(),
    readOnlyRootfs: z.boolean(),
    capDropAll: z.boolean(),
    noNewPrivileges: z.boolean(),
    pidsLimited: z.boolean(),
    memoryLimited: z.boolean(),
    cpuLimited: z.boolean(),
    noHostBinds: z.boolean(),
    noPorts: z.boolean(),
    privateIpc: z.boolean(),
    restartDisabled: z.boolean(),
    ownedLabels: z.boolean(),
  }),
  allPassed: z.boolean(),
});
export type RuntimeInspection = z.infer<typeof RuntimeInspection>;

export const ProbeResult = z.enum(["BLOCKED", "REACHED", "UNKNOWN"]);

/** Checkpoint 4: run inside every author sandbox before agent work. Anything not BLOCKED refuses the run. */
export const IsolationProbe = z.object({
  probedAt: isoDate,
  metadataEndpoint: ProbeResult,
  dns: ProbeResult,
  outboundTcp: ProbeResult,
  dockerSocket: ProbeResult,
  hostMounts: ProbeResult,
  allBlocked: z.boolean(),
});
export type IsolationProbe = z.infer<typeof IsolationProbe>;

/** Checkpoint 5: after teardown, what the supervisor still owns for this attempt. Must be empty. */
export const TeardownRecord = z.object({
  destroyedAt: isoDate,
  containersRemaining: z.array(z.string()),
  volumesRemaining: z.array(z.string()),
  clean: z.boolean(),
});
export type TeardownRecord = z.infer<typeof TeardownRecord>;

// ---------------------------------------------------------------------------------------------
// Bounded execution results (borrowed shape from OpenBot agent-computer shell.ts)
// ---------------------------------------------------------------------------------------------

export const ExecStatus = z.enum(["succeeded", "failed", "timed_out", "interrupted", "refused"]);

export const ExecResult = z.object({
  status: ExecStatus,
  exitCode: z.number().int().nullable(),
  stdout: z.string(),
  stderr: z.string(),
  truncated: z.boolean(),
  timedOut: z.boolean(),
  durationMs: z.number().int().nonnegative(),
});
export type ExecResult = z.infer<typeof ExecResult>;

// ---------------------------------------------------------------------------------------------
// Profiles: the supported repository/runtime combinations
// ---------------------------------------------------------------------------------------------

export const Caps = z.object({
  cpus: z.number().positive(),
  memoryBytes: z.number().int().positive(),
  pidsLimit: z.number().int().positive(),
  commandTimeoutMs: z.number().int().positive(),
  attemptTimeoutMs: z.number().int().positive(),
  outputBytes: z.number().int().positive(),
  maxRepairAttempts: z.number().int().positive(),
  maxModelCalls: z.number().int().positive(),
  maxFileBytes: z.number().int().positive(),
  maxTotalBytes: z.number().int().positive(),
  maxFiles: z.number().int().positive(),
});
export type Caps = z.infer<typeof Caps>;

/** `profiles/<id>/profile.json`. The reference commit is maintainer-only and never reaches the agent. */
export const ProfileManifest = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  id: plainId,
  displayName: z.string(),
  issueUrl: z.string().url(),
  repository: z.string().url(),
  baselineCommit: gitSha,
  /** Never supplied to any sandbox. Exists so maintainers can validate the exercise. */
  referenceCommitMaintainerOnly: gitSha.optional(),
  runtimeImage: z.string(),
  language: z.literal("python"),
  /** Directory inside the sandbox where the pinned source tree is mounted/copied. */
  sourceRoot: z.string(),
  /** The only files the agent may change and the collector may accept. */
  allowedReplacementPaths: z.array(relPath).min(1),
  /** Files the model may read (glob-free; exact paths). */
  readablePaths: z.array(relPath),
  adapterModule: z.string(),
  contractPath: z.string(),
  caps: Caps,
});
export type ProfileManifest = z.infer<typeof ProfileManifest>;

// ---------------------------------------------------------------------------------------------
// Acceptance contract: owned by the controller/comparator, never by the model
// ---------------------------------------------------------------------------------------------

/** Typed input passed to the adapter for one case. JSON, bounded. */
export const CaseInput = z.record(z.string(), z.unknown());

export const Expectation = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("raises"),
    exceptionType: z.string(),
    messageIncludes: z.string().optional(),
  }),
  z.object({
    kind: z.literal("returns"),
    /** Canonical JSON of the expected value, compared byte-for-byte after canonicalization. */
    valueCanonical: z.string(),
  }),
]);
export type Expectation = z.infer<typeof Expectation>;

export const ContractCase = z.object({
  id: plainId,
  kind: z.enum(["reported", "regression"]),
  title: z.string(),
  input: CaseInput,
  /** Behavior the ORIGINAL code must show (for `reported`: the failure). */
  baseline: Expectation,
  /** Behavior a passing CANDIDATE must show. */
  candidate: Expectation,
});
export type ContractCase = z.infer<typeof ContractCase>;

export const CaseContract = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  profileId: plainId,
  cases: z.array(ContractCase).min(1),
});
export type CaseContract = z.infer<typeof CaseContract>;

// ---------------------------------------------------------------------------------------------
// Adapter protocol: JSON in on stdin, one JSON object per line out. Untrusted output.
// ---------------------------------------------------------------------------------------------

export const AdapterRequest = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  cases: z.array(z.object({ id: plainId, input: CaseInput })),
});
export type AdapterRequest = z.infer<typeof AdapterRequest>;

/** One line of adapter stdout. Bounded on parse; the comparator decides what it means. */
export const Observation = z.object({
  caseId: plainId,
  status: z.enum(["ok", "error"]),
  /** Canonical JSON of the returned value when status=ok. */
  valueCanonical: z.string().max(65536).optional(),
  exceptionType: z.string().max(256).optional(),
  message: z.string().max(4096).optional(),
  tracebackTail: z.string().max(8192).optional(),
});
export type Observation = z.infer<typeof Observation>;

// ---------------------------------------------------------------------------------------------
// Files, manifests, digests
// ---------------------------------------------------------------------------------------------

/** One regular file collected from a stopped workspace by the fixed collector. */
export const CollectedFile = z.object({
  path: relPath,
  byteLength: z.number().int().nonnegative(),
  sha256: sha256Hex,
  contentBase64: z.string(),
});
export type CollectedFile = z.infer<typeof CollectedFile>;

/** What the collector returns. Validated by the controller against the profile bounds. */
export const FileEnvelope = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  files: z.array(CollectedFile),
  rejected: z.array(z.object({ path: z.string().max(512), reason: z.string().max(256) })),
});
export type FileEnvelope = z.infer<typeof FileEnvelope>;

export const Replacement = z.object({
  path: relPath,
  byteLength: z.number().int().nonnegative(),
  sha256: sha256Hex,
});

/**
 * SourceManifest = schemaVersion + profile + baselineCommit + baselineTreeDigest
 *                + sorted(path, byteLength, sha256) replacements
 * CandidateDigest = SHA256(canonical JSON of SourceManifest)
 */
export const SourceManifest = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  profileId: plainId,
  baselineCommit: gitSha,
  baselineTreeDigest: sha256Hex,
  replacements: z.array(Replacement),
});
export type SourceManifest = z.infer<typeof SourceManifest>;

/** Manifest plus bytes, as sent to the supervisor for pristine reconstruction. Digests re-verified there. */
export const CandidateBundle = z.object({
  manifest: SourceManifest,
  candidateDigest: sha256Hex,
  files: z.array(CollectedFile),
});
export type CandidateBundle = z.infer<typeof CandidateBundle>;

// ---------------------------------------------------------------------------------------------
// Supervisor operation API (control → supervisor). Proposed contract from 37, made concrete.
// Every mutating call carries an AttemptRef and an Operation; duplicates with a different digest are rejected.
// ---------------------------------------------------------------------------------------------

export const AttemptRef = z.object({
  taskId: plainId,
  attemptId: plainId,
  generation: z.number().int().nonnegative(),
});
export type AttemptRef = z.infer<typeof AttemptRef>;

export const Operation = z.object({
  operationId: plainId,
  /** sha256 of the canonical request body minus this field; binds an operation id to one request. */
  requestDigest: sha256Hex,
});
export type Operation = z.infer<typeof Operation>;

export const CreateAttemptRequest = z.object({
  ref: AttemptRef,
  operation: Operation,
  profileId: plainId,
  role: SandboxRole,
  absoluteDeadline: isoDate,
});
export const AttemptState = z.object({
  ref: AttemptRef,
  role: SandboxRole,
  container: z.string(),
  status: z.enum(["created", "running", "stopped", "revoked", "destroyed", "unknown"]),
  inspection: RuntimeInspection.optional(),
  probe: IsolationProbe.optional(),
  deadline: isoDate,
});
export type AttemptState = z.infer<typeof AttemptState>;

export const AuthorToolArgs = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("read"), path: relPath }),
  z.object({ kind: z.literal("write"), path: relPath, content: z.string().max(1_048_576) }),
  z.object({ kind: z.literal("exec"), command: z.string().min(1).max(4096) }),
]);
export type AuthorToolArgs = z.infer<typeof AuthorToolArgs>;

export const AuthorToolRequest = z.object({
  ref: AttemptRef,
  operation: Operation,
  args: AuthorToolArgs,
});
export const AuthorToolResult = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("read"), content: z.string(), truncated: z.boolean() }),
  z.object({ kind: z.literal("write"), byteLength: z.number().int().nonnegative() }),
  z.object({ kind: z.literal("exec"), result: ExecResult }),
  z.object({ kind: z.literal("refused"), reason: z.string() }),
]);
export type AuthorToolResult = z.infer<typeof AuthorToolResult>;

export const FreezeRequest = z.object({ ref: AttemptRef, operation: Operation });
export const FreezeResult = z.object({
  stoppedAt: isoDate,
  stopConfirmed: z.boolean(),
  outstandingOperationsSettled: z.boolean(),
  envelope: FileEnvelope,
});
export type FreezeResult = z.infer<typeof FreezeResult>;

/** Baseline: pristine tree. Candidate/preview: pristine tree plus the bundle's replacements. */
export const InvokeRequest = z.object({
  operation: Operation,
  taskId: plainId,
  profileId: plainId,
  role: z.enum(["baseline", "candidate", "preview"]),
  bundle: CandidateBundle.optional(),
  request: AdapterRequest,
  absoluteDeadline: isoDate,
});
export const InvokeResult = z.object({
  operationId: plainId,
  role: z.enum(["baseline", "candidate", "preview"]),
  container: z.string(),
  inspection: RuntimeInspection,
  exec: ExecResult,
  /** Parsed lines that validated; the comparator also receives `exec` to judge completeness. */
  observations: z.array(Observation),
  protocolErrors: z.array(z.string().max(512)),
  teardown: TeardownRecord,
});
export type InvokeResult = z.infer<typeof InvokeResult>;

export const RevokeRequest = z.object({ ref: AttemptRef, operation: Operation });
export const DestroyRequest = z.object({ ref: AttemptRef, operation: Operation });
export const DestroyResult = z.object({ teardown: TeardownRecord });

/** Hostile-input panel: one-shot author-profile sandbox, no repair pipeline. Judge role only. */
export const HostileRunRequest = z.object({
  operation: Operation,
  profileId: plainId,
  command: z.string().min(1).max(4096),
});
export const BlastRadiusCard = z.object({
  operationId: plainId,
  container: z.string(),
  inspection: RuntimeInspection,
  exec: ExecResult,
  died: z.object({
    container: z.string(),
    runtime: RuntimeName,
    guestUname: z.string(),
    reason: z.string(),
  }),
  survived: z.object({
    supervisorHealthy: z.boolean(),
    hostSentinelUnchanged: z.boolean(),
    otherAttemptsRunning: z.number().int().nonnegative(),
    hostUptimeSeconds: z.number().nonnegative(),
  }),
  teardown: TeardownRecord,
});
export type BlastRadiusCard = z.infer<typeof BlastRadiusCard>;

// ---------------------------------------------------------------------------------------------
// Verification (comparator output). Immutable once written.
// ---------------------------------------------------------------------------------------------

export const CaseVerdict = z.object({
  caseId: plainId,
  kind: z.enum(["reported", "regression"]),
  expected: Expectation,
  observed: Observation.optional(),
  passed: z.boolean(),
  reason: z.string().max(1024),
});

export const RuntimeProfileRecord = z.object({
  host: HostCheck,
  inspection: RuntimeInspection,
  probe: IsolationProbe.optional(),
  teardown: TeardownRecord,
});

export const VerificationRecord = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  id: plainId,
  taskId: plainId,
  role: z.enum(["baseline", "candidate"]),
  candidateDigest: sha256Hex,
  runtimeImageDigest: z.string(),
  adapterDigest: sha256Hex,
  contractDigest: sha256Hex,
  comparatorVersion: z.string(),
  cases: z.array(CaseVerdict),
  requiredCases: z.number().int().nonnegative(),
  completedCases: z.number().int().nonnegative(),
  exec: ExecResult,
  runtimeProfile: RuntimeProfileRecord,
  /** For baseline: did the reported failure reproduce. For candidate: did all cases pass. */
  passed: z.boolean(),
  createdAt: isoDate,
});
export type VerificationRecord = z.infer<typeof VerificationRecord>;

/** Authorizes a repeatable download of exactly one verified candidate. */
export const ExportGrant = z.object({
  id: plainId,
  owner: z.string(),
  taskId: plainId,
  candidateDigest: sha256Hex,
  verificationRecordId: plainId,
  createdAt: isoDate,
  expiresAt: isoDate,
});
export type ExportGrant = z.infer<typeof ExportGrant>;

// ---------------------------------------------------------------------------------------------
// Task, attempt, events (control plane records; adapted from OpenMuse AgentTask/RunEvent)
// ---------------------------------------------------------------------------------------------

export const Budget = z.object({
  modelCallsUsed: z.number().int().nonnegative(),
  repairAttemptsUsed: z.number().int().nonnegative(),
});

export const Task = z.object({
  id: plainId,
  owner: z.string(),
  profileId: plainId,
  issueText: z.string().max(20000),
  status: TaskStatus,
  phase: Phase,
  outcome: Outcome.optional(),
  error: z.string().optional(),
  /** Current attempt identity; a newer attempt never inherits an older one's workspace. */
  attemptId: plainId.optional(),
  generation: z.number().int().nonnegative(),
  leaseId: z.string().nullable(),
  leaseUntil: isoDate.nullable(),
  attempts: z.number().int().nonnegative(),
  budget: Budget,
  baselineRecordId: plainId.optional(),
  candidateDigest: sha256Hex.optional(),
  verificationRecordId: plainId.optional(),
  createdAt: isoDate,
  updatedAt: isoDate,
});
export type Task = z.infer<typeof Task>;

export const EventKind = z.enum([
  "phase",
  "model",
  "tool",
  "exec",
  "check",
  "artifact",
  "lifecycle",
  "error",
  "info",
]);

export const RunEvent = z.object({
  id: plainId,
  taskId: plainId,
  seq: z.number().int().nonnegative(),
  at: isoDate,
  kind: EventKind,
  title: z.string().max(256),
  detail: z.string().max(65536),
  data: z.record(z.string(), z.unknown()).optional(),
});
export type RunEvent = z.infer<typeof RunEvent>;

// ---------------------------------------------------------------------------------------------
// Model tools (what the repair agent may call). Bound to the current attempt by the controller.
// ---------------------------------------------------------------------------------------------

export const ModelToolName = z.enum(["read_file", "write_file", "run", "submit_candidate"]);

export const ModelToolCall = z.discriminatedUnion("name", [
  z.object({ name: z.literal("read_file"), args: z.object({ path: relPath }) }),
  z.object({
    name: z.literal("write_file"),
    args: z.object({ path: relPath, content: z.string().max(1_048_576) }),
  }),
  z.object({ name: z.literal("run"), args: z.object({ command: z.string().min(1).max(4096) }) }),
  z.object({
    name: z.literal("submit_candidate"),
    args: z.object({ summary: z.string().max(4000) }),
  }),
]);
export type ModelToolCall = z.infer<typeof ModelToolCall>;

// ---------------------------------------------------------------------------------------------
// Control API (web → control)
// ---------------------------------------------------------------------------------------------

export const Role = z.enum(["operator", "judge", "viewer"]);
export type Role = z.infer<typeof Role>;

export const Session = z.object({
  id: z.string(),
  owner: z.string(),
  role: Role,
  createdAt: isoDate,
  expiresAt: isoDate,
});

export const CreateTaskRequest = z.object({
  profileId: plainId,
  issueText: z.string().min(1).max(20000),
});

export const PreviewRequest = z.object({
  /** Must equal the task's verified candidate digest; refused otherwise. */
  candidateDigest: sha256Hex,
  input: CaseInput,
});
export const PreviewResult = z.object({
  candidateDigest: sha256Hex,
  observation: Observation.optional(),
  exec: ExecResult,
  inspection: RuntimeInspection,
});

export const TaskView = z.object({
  task: Task,
  baseline: VerificationRecord.optional(),
  verification: VerificationRecord.optional(),
  manifest: SourceManifest.optional(),
  host: HostCheck.optional(),
});
export type TaskView = z.infer<typeof TaskView>;

// ---------------------------------------------------------------------------------------------
// Helpers shared by both sides
// ---------------------------------------------------------------------------------------------

/** Deterministic JSON: sorted keys, no whitespace. Digests are computed over this. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object" && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort())
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    return out;
  }
  return value;
}

export async function sha256(text: string | Uint8Array): Promise<string> {
  const bytes = typeof text === "string" ? new TextEncoder().encode(text) : text;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** CandidateDigest = SHA256(canonical SourceManifest). Replacements are sorted by path first. */
export async function candidateDigestOf(manifest: SourceManifest): Promise<string> {
  const sorted: SourceManifest = {
    ...manifest,
    replacements: [...manifest.replacements].sort((a, b) => a.path.localeCompare(b.path)),
  };
  return sha256(canonicalJson(sorted));
}

/** requestDigest = SHA256(canonical body without `operation.requestDigest`). */
export async function requestDigestOf(body: Record<string, unknown>): Promise<string> {
  const { operation, ...rest } = body as { operation?: { operationId: string } };
  return sha256(canonicalJson({ ...rest, operation: { operationId: operation?.operationId } }));
}
