/**
 * Airlock external comparator (CLAUDE.md §3 invariant 4).
 *
 * A pure function: contract + supervisor InvokeResult + host check in, VerificationRecord out.
 * No I/O, no imports of candidate code, no trust in anything the sandbox printed beyond the
 * typed Observation fields (`status`, `valueCanonical`, `exceptionType`, `message`). An
 * observation carrying extra fields such as `passed: true` is treated exactly like one without.
 *
 * Rules (all enforced, all tested in test/verifier.test.ts):
 * - An observation counts only if its caseId is in the contract AND appears exactly once.
 * - role "baseline": every case's `baseline` expectation must be met (the reported case must
 *   show the failure). role "candidate": every case's `candidate` expectation must be met.
 * - "raises": exceptionType must match exactly; messageIncludes must be a substring of message.
 * - "returns": valueCanonical compared byte-for-byte (after re-canonicalization guard).
 * - Missing observation, duplicate, unknown id, exec.status !== "succeeded", exec.timedOut,
 *   truncated output or any protocolErrors → the affected case fails with a reason, passed=false.
 * - completedCases = cases with exactly one valid observation; requiredCases = contract length.
 * - Per-case mode (`invocations`, 37 §Execution bridge: a fresh one-shot sandbox per case): each
 *   case is judged ONLY against its own invocation; a failed/missing invocation, or run-level
 *   failure of that invocation, makes that case incomplete (it cannot pass). Invocations for ids
 *   outside the contract, or runs on different runtime images, invalidate the whole record.
 * - `outcome` (M11): baseline REPRODUCED | NOT_REPRODUCED | INCONCLUSIVE; candidate PASSED_CHECKS |
 *   CHECKS_FAILED | INCONCLUSIVE. Baseline NOT_REPRODUCED needs every reported case measured and
 *   at least one not showing its expected failure; a reproduced reported case with regression
 *   drift or incomplete regression cases is INCONCLUSIVE (D9). Candidate INCONCLUSIVE means no
 *   measured failure and an infrastructure fault (failed invocation, inspection, record-level).
 */
import {
  SCHEMA_VERSION,
  type CaseContract,
  type CaseVerdict,
  type ContractCase,
  type Expectation,
  type HostCheck,
  type InvokeResult,
  type IsolationProbe,
  type Observation,
  type TeardownRecord,
  type VerificationRecord,
  Observation as ObservationSchema,
  canonicalJson,
} from "@airlock/contracts";
import type { z } from "zod";

export const COMPARATOR_VERSION = "1.1.0";

export interface CompareInput {
  id: string;
  taskId: string;
  role: "baseline" | "candidate";
  contract: CaseContract;
  invoke: InvokeResult;
  host: HostCheck;
  adapterDigest: string;
  contractDigest: string;
  candidateDigest: string;
  now: string;
  /** Checkpoint 4 from the author attempt of this run, recorded in `runtimeProfile.probe` (M6). */
  probe?: IsolationProbe;
  /** Per-case one-shot invocations (D3). When present, `invoke` is their aggregate (`aggregateInvocations`). */
  invocations?: CaseInvocation[];
}

/** One contract case's own invocation; `invoke` null when the supervisor call itself failed. */
export interface CaseInvocation {
  caseId: string;
  invoke: InvokeResult | null;
  error?: string;
}

type Verdict = z.infer<typeof CaseVerdict>;

const REASON_MAX = 1024;

function clip(text: string, max = REASON_MAX): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Short, bounded description of one observed value for a reason string. */
function describeObserved(obs: Observation): string {
  if (obs.status === "ok") {
    const v = obs.valueCanonical ?? "";
    return `ok ${clip(v, 200)}`;
  }
  return `error ${obs.exceptionType ?? "<no type>"}: ${clip(obs.message ?? "", 200)}`;
}

/**
 * Re-validate an observation through the contract schema and keep ONLY the typed fields.
 * Anything else the sandbox printed (e.g. `passed`, `ok`, `verdict`) is dropped here.
 */
function sanitize(raw: unknown): Observation | null {
  const parsed = ObservationSchema.safeParse(raw);
  if (!parsed.success) return null;
  const o = parsed.data;
  const out: Observation = { caseId: o.caseId, status: o.status };
  if (o.valueCanonical !== undefined) out.valueCanonical = o.valueCanonical;
  if (o.exceptionType !== undefined) out.exceptionType = o.exceptionType;
  if (o.message !== undefined) out.message = o.message;
  if (o.tracebackTail !== undefined) out.tracebackTail = o.tracebackTail;
  return out;
}

/** Judge a single well-formed observation against one expectation. */
function judge(expected: Expectation, obs: Observation): { passed: boolean; reason: string } {
  if (expected.kind === "raises") {
    if (obs.status !== "error") {
      return {
        passed: false,
        reason: `expected ${expected.exceptionType} to be raised; observed ${describeObserved(obs)}`,
      };
    }
    if (obs.exceptionType !== expected.exceptionType) {
      return {
        passed: false,
        reason: `expected exception type ${expected.exceptionType}; observed ${obs.exceptionType ?? "<none>"}`,
      };
    }
    if (expected.messageIncludes !== undefined) {
      const msg = obs.message ?? "";
      if (!msg.includes(expected.messageIncludes)) {
        return {
          passed: false,
          reason: `expected message to include ${JSON.stringify(expected.messageIncludes)}; observed ${JSON.stringify(clip(msg, 200))}`,
        };
      }
    }
    return { passed: true, reason: `raised ${expected.exceptionType} as expected` };
  }

  // kind === "returns"
  if (obs.status !== "ok") {
    return {
      passed: false,
      reason: `expected a return value; observed ${describeObserved(obs)}`,
    };
  }
  if (obs.valueCanonical === undefined) {
    return { passed: false, reason: "observation status ok but no valueCanonical" };
  }
  // Guard against a non-canonical (but JSON-equal) emission from the adapter: re-canonicalize when
  // the value parses as JSON; on parse failure compare the raw bytes so a corrupt line cannot pass.
  let observedCanonical = obs.valueCanonical;
  try {
    observedCanonical = canonicalJson(JSON.parse(obs.valueCanonical));
  } catch {
    observedCanonical = obs.valueCanonical;
  }
  let expectedCanonical = expected.valueCanonical;
  try {
    expectedCanonical = canonicalJson(JSON.parse(expected.valueCanonical));
  } catch {
    expectedCanonical = expected.valueCanonical;
  }
  if (observedCanonical !== expectedCanonical) {
    return {
      passed: false,
      reason: `expected value ${clip(expectedCanonical, 300)}; observed ${clip(observedCanonical, 300)}`,
    };
  }
  return { passed: true, reason: "returned the expected value" };
}

/** Reasons that invalidate the whole run regardless of what individual observations say. */
function runLevelFailures(invoke: InvokeResult): string[] {
  const reasons: string[] = [];
  const exec = invoke.exec;
  if (exec.status !== "succeeded") {
    reasons.push(`adapter exec status ${exec.status} (exit ${exec.exitCode ?? "null"})`);
  }
  if (exec.timedOut) reasons.push("adapter exec timed out");
  if (exec.truncated) reasons.push("adapter output truncated");
  if (invoke.protocolErrors.length > 0) {
    reasons.push(
      `protocol errors (${invoke.protocolErrors.length}): ${clip(invoke.protocolErrors.slice(0, 3).join(" | "), 400)}`,
    );
  }
  if (!invoke.inspection.allPassed) reasons.push("runtime inspection did not pass");
  return reasons;
}

type Judged = { verdicts: Verdict[]; measured: boolean[]; completed: number; runFailures: string[] };

/** Judge `cases` against ONE invocation's observations (the original single-run rules). */
function judgeRun(contractCases: ContractCase[], role: "baseline" | "candidate", invoke: InvokeResult): Judged {
  const contractIds = new Set(contractCases.map((c) => c.id));
  // Bucket sanitized observations by caseId; count raw occurrences (including unparseable ones
  // that still carry a caseId string) so duplicates cannot hide behind a malformed twin.
  const byCase = new Map<string, Observation[]>();
  const rawCount = new Map<string, number>();
  const unknownIds: string[] = [];
  const malformed: number[] = [];
  invoke.observations.forEach((raw, index) => {
    const idCandidate =
      raw && typeof raw === "object" && typeof (raw as { caseId?: unknown }).caseId === "string"
        ? (raw as { caseId: string }).caseId
        : undefined;
    if (idCandidate !== undefined) rawCount.set(idCandidate, (rawCount.get(idCandidate) ?? 0) + 1);
    const obs = sanitize(raw);
    if (!obs) {
      malformed.push(index);
      return;
    }
    if (!contractIds.has(obs.caseId)) {
      unknownIds.push(obs.caseId);
      return;
    }
    const list = byCase.get(obs.caseId) ?? [];
    list.push(obs);
    byCase.set(obs.caseId, list);
  });

  const runFailures = runLevelFailures(invoke);
  if (unknownIds.length > 0) {
    runFailures.push(`unknown case ids observed: ${clip(unknownIds.slice(0, 5).join(", "), 300)}`);
  }
  if (malformed.length > 0) {
    runFailures.push(`${malformed.length} malformed observation(s) at index ${malformed.slice(0, 5).join(",")}`);
  }

  let completed = 0;
  const measured: boolean[] = [];
  const verdicts: Verdict[] = contractCases.map((c) => {
    const expected = role === "baseline" ? c.baseline : c.candidate;
    const list = byCase.get(c.id) ?? [];
    const seen = rawCount.get(c.id) ?? 0;
    const base = { caseId: c.id, kind: c.kind, expected };

    if (list.length === 0) {
      measured.push(false);
      const reason =
        seen > 0
          ? "observation for this case was malformed"
          : runFailures.length > 0
            ? `missing observation; ${runFailures[0]}`
            : "missing observation";
      return { ...base, passed: false, reason: clip(reason) };
    }
    if (list.length > 1 || seen > 1) {
      measured.push(false);
      return {
        ...base,
        observed: list[0],
        passed: false,
        reason: `duplicate observation: case reported ${Math.max(list.length, seen)} times`,
      };
    }
    const observed = list[0] as Observation;
    completed += 1;
    measured.push(runFailures.length === 0);
    const j = judge(expected, observed);
    if (j.passed && runFailures.length > 0) {
      return {
        ...base,
        observed,
        passed: false,
        reason: clip(`observation matched but run is invalid: ${runFailures.join("; ")}`),
      };
    }
    return { ...base, observed, passed: j.passed, reason: clip(j.reason) };
  });
  return { verdicts, measured, completed, runFailures };
}

/**
 * Aggregate per-case invocations into the one `exec`/`inspection`/`teardown` a VerificationRecord
 * carries: succeeded only if every invocation returned and succeeded; teardown clean only if every
 * invocation's was; the host-wide listing is the one taken after the LAST invocation (M7).
 * Returns null when no invocation returned at all (nothing was inspected; no record can be made).
 */
export function aggregateInvocations(invocations: CaseInvocation[]): InvokeResult | null {
  const returned = invocations.filter((i): i is CaseInvocation & { invoke: InvokeResult } => i.invoke !== null);
  const first = returned[0]?.invoke;
  if (!first) return null;
  const failed = invocations.filter((i) => i.invoke === null);
  const notOk = returned.find((i) => i.invoke.exec.status !== "succeeded");
  const cap = 8 * 1024;
  const join = (pick: (r: InvokeResult) => string) =>
    returned
      .map((i) => (pick(i.invoke) ? `[${i.caseId}] ${pick(i.invoke)}` : ""))
      .filter(Boolean)
      .join("\n");
  const stdout = join((r) => r.exec.stdout);
  const stderr = [join((r) => r.exec.stderr), ...failed.map((i) => `[${i.caseId}] invocation failed: ${i.error ?? "unknown error"}`)].filter(Boolean).join("\n");
  const teardowns = returned.map((i) => i.invoke.teardown);
  const last = teardowns[teardowns.length - 1] as TeardownRecord;
  const teardown: TeardownRecord = {
    destroyedAt: last.destroyedAt,
    containersRemaining: [...new Set(teardowns.flatMap((t) => t.containersRemaining))],
    volumesRemaining: [...new Set(teardowns.flatMap((t) => t.volumesRemaining))],
    clean: failed.length === 0 && teardowns.every((t) => t.clean),
    ...(last.host ? { host: last.host } : {}),
  };
  return {
    operationId: first.operationId,
    role: first.role,
    container: first.container,
    inspection: returned.every((i) => i.invoke.inspection.allPassed) ? first.inspection : (returned.find((i) => !i.invoke.inspection.allPassed)?.invoke.inspection ?? first.inspection),
    exec: {
      status: failed.length > 0 ? "failed" : (notOk?.invoke.exec.status ?? "succeeded"),
      exitCode: failed.length > 0 ? null : (notOk?.invoke.exec.exitCode ?? 0),
      stdout: stdout.slice(0, cap),
      stderr: stderr.slice(0, cap),
      truncated: returned.some((i) => i.invoke.exec.truncated) || stdout.length > cap || stderr.length > cap,
      timedOut: returned.some((i) => i.invoke.exec.timedOut),
      durationMs: returned.reduce((sum, i) => sum + i.invoke.exec.durationMs, 0),
    },
    observations: returned.flatMap((i) => i.invoke.observations),
    protocolErrors: [
      ...returned.flatMap((i) => i.invoke.protocolErrors.map((e) => clip(`[${i.caseId}] ${e}`, 512))),
      ...failed.map((i) => clip(`[${i.caseId}] invocation failed: ${i.error ?? "unknown error"}`, 512)),
    ],
    teardown,
  };
}

export type RecordOutcome = NonNullable<VerificationRecord["outcome"]>;

/** The comparator's verdict in words (see the file header for the rules). */
export function deriveOutcome(
  role: "baseline" | "candidate",
  verdicts: { kind: "reported" | "regression"; passed: boolean }[],
  measured: boolean[],
  passed: boolean,
  infrastructureFault: boolean,
): RecordOutcome {
  if (role === "baseline") {
    if (passed) return "REPRODUCED";
    const reported = verdicts.map((v, i) => ({ v, m: measured[i] === true })).filter((x) => x.v.kind === "reported");
    if (reported.length > 0 && reported.every((x) => x.m) && reported.some((x) => !x.v.passed)) return "NOT_REPRODUCED";
    return "INCONCLUSIVE";
  }
  if (passed) return "PASSED_CHECKS";
  if (verdicts.some((v, i) => measured[i] === true && !v.passed)) return "CHECKS_FAILED";
  return infrastructureFault ? "INCONCLUSIVE" : "CHECKS_FAILED";
}

export function compare(input: CompareInput): VerificationRecord {
  const { contract, invoke, role } = input;
  const contractIds = new Set<string>();
  const contractCases: ContractCase[] = [];
  for (const c of contract.cases) {
    // A contract with a duplicated id is malformed; only the first definition is required.
    if (!contractIds.has(c.id)) {
      contractIds.add(c.id);
      contractCases.push(c);
    }
  }

  let judged: Judged;
  const recordFailures: string[] = [];
  let infrastructureFault = !invoke.inspection.allPassed;
  if (input.invocations) {
    const invocations = input.invocations;
    const strays = invocations.filter((i) => !contractIds.has(i.caseId)).map((i) => i.caseId);
    if (strays.length > 0) recordFailures.push(`invocations for case ids outside the contract: ${clip(strays.slice(0, 5).join(", "), 300)}`);
    const images = new Set(invocations.flatMap((i) => (i.invoke ? [i.invoke.inspection.imageDigest] : [])));
    if (images.size > 1) recordFailures.push(`invocations ran on ${images.size} different runtime images`);
    const verdicts: Verdict[] = [];
    const measured: boolean[] = [];
    let completed = 0;
    for (const c of contractCases) {
      const expected = role === "baseline" ? c.baseline : c.candidate;
      const own = invocations.filter((i) => i.caseId === c.id);
      const only = own[0];
      if (own.length !== 1 || !only) {
        verdicts.push({ caseId: c.id, kind: c.kind, expected, passed: false, reason: own.length === 0 ? "not invoked" : `case invoked ${own.length} times` });
        measured.push(false);
        infrastructureFault = true;
        continue;
      }
      if (only.invoke === null) {
        verdicts.push({ caseId: c.id, kind: c.kind, expected, passed: false, reason: clip(`invocation failed: ${only.error ?? "unknown error"}`) });
        measured.push(false);
        infrastructureFault = true;
        continue;
      }
      if (!only.invoke.inspection.allPassed) infrastructureFault = true;
      const one = judgeRun([c], role, only.invoke);
      verdicts.push(one.verdicts[0] as Verdict);
      measured.push(one.measured[0] === true);
      completed += one.completed;
    }
    judged = { verdicts, measured, completed, runFailures: [] };
  } else {
    judged = judgeRun(contractCases, role, invoke);
  }
  if (recordFailures.length > 0) {
    infrastructureFault = true;
    judged = {
      ...judged,
      measured: judged.measured.map(() => false),
      verdicts: judged.verdicts.map((v) => (v.passed ? { ...v, passed: false, reason: clip(`observation matched but the record is invalid: ${recordFailures.join("; ")}`) } : v)),
    };
  }

  const requiredCases = contractCases.length;
  const passed =
    recordFailures.length === 0 &&
    judged.runFailures.length === 0 &&
    requiredCases > 0 &&
    judged.verdicts.length === requiredCases &&
    judged.verdicts.every((v) => v.passed) &&
    judged.completed === requiredCases;

  return {
    schemaVersion: SCHEMA_VERSION,
    id: input.id,
    taskId: input.taskId,
    role,
    candidateDigest: input.candidateDigest,
    runtimeImageDigest: invoke.inspection.imageDigest,
    adapterDigest: input.adapterDigest,
    contractDigest: input.contractDigest,
    comparatorVersion: COMPARATOR_VERSION,
    cases: judged.verdicts,
    requiredCases,
    completedCases: judged.completed,
    exec: invoke.exec,
    runtimeProfile: {
      host: input.host,
      inspection: invoke.inspection,
      ...(input.probe ? { probe: input.probe } : {}),
      teardown: invoke.teardown,
    },
    passed,
    outcome: deriveOutcome(role, judged.verdicts, judged.measured, passed, infrastructureFault),
    createdAt: input.now,
  };
}
