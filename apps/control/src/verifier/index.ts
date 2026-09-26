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
 */
import {
  SCHEMA_VERSION,
  type CaseContract,
  type CaseVerdict,
  type ContractCase,
  type Expectation,
  type HostCheck,
  type InvokeResult,
  type Observation,
  type VerificationRecord,
  Observation as ObservationSchema,
  canonicalJson,
} from "@airlock/contracts";
import type { z } from "zod";

export const COMPARATOR_VERSION = "1.0.0";

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

export function compare(input: CompareInput): VerificationRecord {
  const { contract, invoke, role } = input;
  const contractIds = new Set<string>();
  const contractCases: ContractCase[] = [];
  for (const c of contract.cases) {
    // A contract with a duplicated id is malformed; only the first definition is required and any
    // observation for it is ambiguous, so the case is marked failed below via the duplicate path.
    if (!contractIds.has(c.id)) {
      contractIds.add(c.id);
      contractCases.push(c);
    }
  }

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

  let completedCases = 0;
  const verdicts: Verdict[] = contractCases.map((c) => {
    const expected = role === "baseline" ? c.baseline : c.candidate;
    const list = byCase.get(c.id) ?? [];
    const seen = rawCount.get(c.id) ?? 0;
    const base = { caseId: c.id, kind: c.kind, expected };

    if (list.length === 0) {
      const reason =
        seen > 0
          ? "observation for this case was malformed"
          : runFailures.length > 0
            ? `missing observation; ${runFailures[0]}`
            : "missing observation";
      return { ...base, passed: false, reason: clip(reason) };
    }
    if (list.length > 1 || seen > 1) {
      return {
        ...base,
        observed: list[0],
        passed: false,
        reason: `duplicate observation: case reported ${Math.max(list.length, seen)} times`,
      };
    }
    const observed = list[0] as Observation;
    completedCases += 1;
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

  const requiredCases = contractCases.length;
  const passed =
    runFailures.length === 0 &&
    requiredCases > 0 &&
    verdicts.length === requiredCases &&
    verdicts.every((v) => v.passed) &&
    completedCases === requiredCases;

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
    cases: verdicts,
    requiredCases,
    completedCases,
    exec: invoke.exec,
    runtimeProfile: {
      host: input.host,
      inspection: invoke.inspection,
      teardown: invoke.teardown,
    },
    passed,
    createdAt: input.now,
  };
}
