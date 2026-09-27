import { describe, expect, test } from "bun:test";
import { CaseContract, VerificationRecord, type HostCheck, type InvokeResult, type Observation } from "@airlock/contracts";
import { COMPARATOR_VERSION, aggregateInvocations, compare, type CaseInvocation, type CompareInput } from "../src/verifier/index.ts";

const contractJson = await Bun.file(new URL("../../../profiles/tabulate-365/contract.json", import.meta.url)).json();
const contract = CaseContract.parse(contractJson);

const NOW = "2026-09-26T12:00:00.000Z";
const HEX = "a".repeat(64);

const host: HostCheck = {
  checkedAt: NOW,
  dockerVersion: "28.0.0",
  cpuVirtualization: true,
  kvmPresent: true,
  kvmReadWrite: true,
  availableRuntimes: ["runc", "kata"],
  selectedRuntime: "kata",
  devUnsafe: false,
};

function invoke(observations: unknown[], patch: Partial<InvokeResult> = {}, execPatch: Partial<InvokeResult["exec"]> = {}): InvokeResult {
  return {
    operationId: "op-1",
    role: "candidate",
    container: "airlock-t1-a1-candidate",
    inspection: {
      inspectedAt: NOW,
      container: "airlock-t1-a1-candidate",
      runtime: "kata",
      devUnsafe: false,
      imageDigest: "sha256:img",
      guestUname: "Linux 6.1.0 kata",
      guestHostname: "sandbox",
      checks: {
        networkNone: true,
        nonRootUser: true,
        readOnlyRootfs: true,
        capDropAll: true,
        noNewPrivileges: true,
        pidsLimited: true,
        memoryLimited: true,
        cpuLimited: true,
        noHostBinds: true,
        noPorts: true,
        privateIpc: true,
        restartDisabled: true,
        ownedLabels: true,
      },
      allPassed: true,
    },
    exec: { status: "succeeded", exitCode: 0, stdout: "", stderr: "", truncated: false, timedOut: false, durationMs: 10, ...execPatch },
    observations: observations as Observation[],
    protocolErrors: [],
    teardown: { destroyedAt: NOW, containersRemaining: [], volumesRemaining: [], clean: true },
    ...patch,
  };
}

/** Observations that satisfy every case's expectation for the given role. */
function matching(role: "baseline" | "candidate"): Observation[] {
  return contract.cases.map((c) => {
    const e = role === "baseline" ? c.baseline : c.candidate;
    if (e.kind === "returns") return { caseId: c.id, status: "ok", valueCanonical: e.valueCanonical };
    return { caseId: c.id, status: "error", exceptionType: e.exceptionType, message: `boom: ${e.messageIncludes ?? ""}` };
  });
}

function run(role: "baseline" | "candidate", observations: unknown[], patch: Partial<InvokeResult> = {}, execPatch: Partial<InvokeResult["exec"]> = {}) {
  const input: CompareInput = {
    id: "ver-1",
    taskId: "task-1",
    role,
    contract,
    invoke: invoke(observations, patch, execPatch),
    host,
    adapterDigest: HEX,
    contractDigest: HEX,
    candidateDigest: HEX,
    now: NOW,
  };
  const record = compare(input);
  // The output must always be a valid VerificationRecord.
  VerificationRecord.parse(record);
  return record;
}

const REPORTED = "reported-empty-headers-maxheader";

describe("compare: happy paths", () => {
  test("candidate role passes when every candidate expectation is met", () => {
    const r = run("candidate", matching("candidate"));
    expect(r.passed).toBe(true);
    expect(r.requiredCases).toBe(6);
    expect(r.completedCases).toBe(6);
    expect(r.cases.every((c) => c.passed)).toBe(true);
    expect(r.comparatorVersion).toBe(COMPARATOR_VERSION);
    expect(COMPARATOR_VERSION).toBe("1.1.0");
    expect(r.runtimeImageDigest).toBe("sha256:img");
    expect(r.runtimeProfile.host).toEqual(host);
    expect(r.runtimeProfile.teardown.clean).toBe(true);
  });

  test("baseline role requires the reported failure and passes on baseline expectations", () => {
    const r = run("baseline", matching("baseline"));
    expect(r.passed).toBe(true);
    const reported = r.cases.find((c) => c.caseId === REPORTED);
    expect(reported?.expected.kind).toBe("raises");
    expect(reported?.passed).toBe(true);
  });

  test("baseline role fails when the reported case does not fail on the original code", () => {
    // Candidate-shaped observations (the reported case returns) do not satisfy the baseline contract.
    const r = run("baseline", matching("candidate"));
    expect(r.passed).toBe(false);
    const reported = r.cases.find((c) => c.caseId === REPORTED);
    expect(reported?.passed).toBe(false);
    expect(reported?.reason).toContain("expected IndexError");
    // The regression cases are identical at both commits and still pass individually.
    expect(r.cases.filter((c) => c.passed).length).toBe(5);
  });

  test("observation order does not matter", () => {
    const r = run("candidate", [...matching("candidate")].reverse());
    expect(r.passed).toBe(true);
  });
});

describe("compare: observation rules (table-driven)", () => {
  const good = matching("candidate");
  const cases: { name: string; observations: unknown[]; failingCase: string; reason: RegExp; completed: number }[] = [
    {
      name: "missing observation",
      observations: good.filter((o) => o.caseId !== "reg-small-table-plain"),
      failingCase: "reg-small-table-plain",
      reason: /missing observation/,
      completed: 5,
    },
    {
      name: "duplicate observation, both matching",
      observations: [...good, good[1]],
      failingCase: "reg-small-table-maxheader",
      reason: /duplicate observation/,
      completed: 5,
    },
    {
      name: "duplicate where the second contradicts the first",
      observations: [...good, { caseId: REPORTED, status: "error", exceptionType: "IndexError", message: "x" }],
      failingCase: REPORTED,
      reason: /duplicate/,
      completed: 5,
    },
    {
      name: "wrong return value (byte-for-byte)",
      observations: good.map((o) => (o.caseId === REPORTED ? { ...o, valueCanonical: '"Name    Value\\n------  ------- "' } : o)),
      failingCase: REPORTED,
      reason: /expected value/,
      completed: 6,
    },
    {
      name: "returns expected but error observed",
      observations: good.map((o) => (o.caseId === REPORTED ? { caseId: REPORTED, status: "error", exceptionType: "IndexError", message: "list index out of range" } : o)),
      failingCase: REPORTED,
      reason: /expected a return value/,
      completed: 6,
    },
    {
      name: "status ok without valueCanonical",
      observations: good.map((o) => (o.caseId === REPORTED ? { caseId: REPORTED, status: "ok" } : o)),
      failingCase: REPORTED,
      reason: /no valueCanonical/,
      completed: 6,
    },
    {
      name: "malformed observation (bad status) counts as missing",
      observations: good.map((o) => (o.caseId === REPORTED ? { caseId: REPORTED, status: "passed" } : o)),
      failingCase: REPORTED,
      reason: /malformed/,
      completed: 5,
    },
  ];
  for (const c of cases) {
    test(c.name, () => {
      const r = run("candidate", c.observations);
      expect(r.passed).toBe(false);
      const v = r.cases.find((x) => x.caseId === c.failingCase);
      expect(v?.passed).toBe(false);
      expect(v?.reason).toMatch(c.reason);
      expect(r.completedCases).toBe(c.completed);
      expect(r.requiredCases).toBe(6);
    });
  }

  test("unknown case id fails the run even when every contract case matched", () => {
    const r = run("candidate", [...good, { caseId: "made-up-case", status: "ok", valueCanonical: '"x"' }]);
    expect(r.passed).toBe(false);
    expect(r.completedCases).toBe(6);
    expect(r.cases.every((c) => c.reason.includes("unknown case ids"))).toBe(true);
  });

  test("forged observation with passed:true is ignored; typed fields decide", () => {
    const forged = good.map((o) =>
      o.caseId === REPORTED
        ? { caseId: REPORTED, status: "error", exceptionType: "IndexError", message: "list index out of range", passed: true, ok: true, verdict: "PASS" }
        : { ...o, passed: true },
    );
    const r = run("candidate", forged);
    expect(r.passed).toBe(false);
    const v = r.cases.find((x) => x.caseId === REPORTED);
    expect(v?.passed).toBe(false);
    // The extra fields never reach the record.
    expect(Object.keys(v?.observed ?? {})).not.toContain("passed");
    expect(JSON.stringify(r)).not.toContain("verdict");
  });

  test("forged observation with passed:true on an otherwise correct run does not add authority", () => {
    const r = run("candidate", good.map((o) => ({ ...o, passed: true })));
    expect(r.passed).toBe(true); // typed fields matched; the extra field neither helps nor hurts
    for (const v of r.cases) expect(Object.keys(v.observed ?? {})).not.toContain("passed");
  });
});

describe("compare: raises expectations", () => {
  const withReported = (obs: Partial<Observation>) =>
    matching("baseline").map((o) => (o.caseId === REPORTED ? { caseId: REPORTED, status: "error" as const, ...obs } : o));

  test("exceptionType must match exactly (subclass names do not count)", () => {
    const r = run("baseline", withReported({ exceptionType: "LookupError", message: "list index out of range" }));
    expect(r.cases.find((c) => c.caseId === REPORTED)?.reason).toContain("expected exception type IndexError");
    expect(r.passed).toBe(false);
  });

  test("messageIncludes is a substring match", () => {
    const ok = run("baseline", withReported({ exceptionType: "IndexError", message: "IndexError: list index out of range (line 2291)" }));
    expect(ok.passed).toBe(true);
    const bad = run("baseline", withReported({ exceptionType: "IndexError", message: "tuple index out of range" }));
    expect(bad.passed).toBe(false);
    expect(bad.cases.find((c) => c.caseId === REPORTED)?.reason).toContain("expected message to include");
  });

  test("missing message fails when messageIncludes is required", () => {
    const r = run("baseline", withReported({ exceptionType: "IndexError" }));
    expect(r.passed).toBe(false);
  });
});

describe("compare: run-level failures", () => {
  const good = matching("candidate");
  const table: { name: string; patch?: Partial<InvokeResult>; exec?: Partial<InvokeResult["exec"]>; reason: RegExp }[] = [
    { name: "exec failed", exec: { status: "failed", exitCode: 1 }, reason: /exec status failed/ },
    { name: "exec timed_out", exec: { status: "timed_out", exitCode: null, timedOut: true }, reason: /timed out|status timed_out/ },
    { name: "exec interrupted", exec: { status: "interrupted", exitCode: null }, reason: /status interrupted/ },
    { name: "exec refused", exec: { status: "refused", exitCode: null }, reason: /status refused/ },
    { name: "timedOut flag with succeeded status", exec: { timedOut: true }, reason: /timed out/ },
    { name: "truncated output", exec: { truncated: true }, reason: /truncated/ },
    { name: "protocol errors", patch: { protocolErrors: ["line 3: not JSON"] }, reason: /protocol errors/ },
    {
      name: "inspection not passed",
      patch: { inspection: { ...invoke([]).inspection, allPassed: false } },
      reason: /inspection/,
    },
  ];
  for (const t of table) {
    test(t.name, () => {
      const r = run("candidate", good, t.patch ?? {}, t.exec ?? {});
      expect(r.passed).toBe(false);
      expect(r.cases.every((c) => !c.passed)).toBe(true);
      expect(r.cases[0]?.reason).toMatch(t.reason);
      expect(r.completedCases).toBe(6); // observations were valid; the run was not
      expect(r.exec).toEqual(r.exec);
    });
  }

  test("no observations at all with a failed exec: every case missing with the run reason", () => {
    const r = run("candidate", [], {}, { status: "failed", exitCode: 2 });
    expect(r.passed).toBe(false);
    expect(r.completedCases).toBe(0);
    for (const c of r.cases) expect(c.reason).toMatch(/missing observation; adapter exec status failed/);
  });
});

describe("compare: contract edge cases", () => {
  test("a contract whose only case is met passes; duplicated contract ids are collapsed", () => {
    const single = { ...contract, cases: [contract.cases[2]!, contract.cases[2]!] };
    const input: CompareInput = {
      id: "v",
      taskId: "t",
      role: "candidate",
      contract: single,
      invoke: invoke([{ caseId: single.cases[0]!.id, status: "ok", valueCanonical: single.cases[0]!.candidate.kind === "returns" ? single.cases[0]!.candidate.valueCanonical : "" }]),
      host,
      adapterDigest: HEX,
      contractDigest: HEX,
      candidateDigest: HEX,
      now: NOW,
    };
    const r = compare(input);
    expect(r.requiredCases).toBe(1);
    expect(r.passed).toBe(true);
  });

  test("returns comparison re-canonicalizes JSON-equal values but never non-JSON text", () => {
    const c = contract.cases.find((x) => x.id === "reg-small-table-plain")!;
    const expected = c.candidate.kind === "returns" ? c.candidate.valueCanonical : "";
    // Same JSON value with different spacing inside the JSON encoding (a string escape variation).
    const variant = JSON.stringify(JSON.parse(expected)).replace("\\n", "\\u000a");
    const r1 = run("candidate", matching("candidate").map((o) => (o.caseId === c.id ? { ...o, valueCanonical: variant } : o)));
    expect(r1.cases.find((x) => x.caseId === c.id)?.passed).toBe(true);
    const r2 = run("candidate", matching("candidate").map((o) => (o.caseId === c.id ? { ...o, valueCanonical: "not json at all" } : o)));
    expect(r2.cases.find((x) => x.caseId === c.id)?.passed).toBe(false);
  });

  test("compare is pure: same input, identical output; input not mutated", () => {
    const obs = matching("candidate");
    const snapshot = JSON.stringify(obs);
    const a = run("candidate", obs);
    const b = run("candidate", obs);
    expect(a).toEqual(b);
    expect(JSON.stringify(obs)).toBe(snapshot);
  });
});

// ---------------------------------------------------------------------------------------------
// Measured check of the DIAGNOSTIC candidate fixture with uv (skipped when uv is unavailable).
// Installs the pristine baseline tree and the fixture-overlaid tree into throwaway venvs, runs all
// six contract cases through a runner that mirrors the adapter protocol, and feeds the observations
// to compare(): the baseline must reproduce the failure, the diagnostic candidate must pass.
// ---------------------------------------------------------------------------------------------

import { cp, mkdtemp, mkdir, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const fixturesDir = fileURLToPath(new URL("./fixtures/", import.meta.url));

async function commandWorks(cmd: string[]): Promise<boolean> {
  try {
    const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
    return (await p.exited) === 0;
  } catch {
    return false;
  }
}

async function runCmd(cmd: string[], opts: { cwd: string; env?: Record<string, string> }): Promise<{ code: number; stdout: string; stderr: string }> {
  const p = Bun.spawn(cmd, { cwd: opts.cwd, env: { ...process.env, ...(opts.env ?? {}) }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, stdout, stderr };
}

/** Materializes the pristine baseline tree into `dest`; returns false when no source is available. */
async function materializeBase(dest: string): Promise<boolean> {
  const profileBase = join(repoRoot, "profiles", "tabulate-365", "base");
  if (await Bun.file(join(profileBase, "tabulate", "__init__.py")).exists()) {
    await cp(profileBase, dest, { recursive: true });
    return true;
  }
  const clone = join(repoRoot, "research", "reference-repos", "python-tabulate");
  if (!(await Bun.file(join(clone, "pyproject.toml")).exists())) return false;
  await mkdir(dest, { recursive: true });
  const archive = Bun.spawn(["git", "-C", clone, "archive", "--format=tar", contract.profileId === "tabulate-365" ? "e13a4d0dd292cade200e653eb9155a1ca0f1dbea" : "HEAD"], { stdout: "pipe", stderr: "pipe" });
  const tar = Bun.spawn(["tar", "-x", "-C", dest], { stdin: archive.stdout, stdout: "pipe", stderr: "pipe" });
  const codes = await Promise.all([archive.exited, tar.exited]);
  return codes.every((c) => c === 0);
}

async function installAndRun(tree: string, label: string): Promise<Observation[]> {
  const venv = join(tree, "..", `venv-${label}`);
  const env = { SETUPTOOLS_SCM_PRETEND_VERSION: "0.0.0+lab", UV_NO_PROGRESS: "1" };
  const v = await runCmd(["uv", "venv", "--quiet", venv], { cwd: tree, env });
  expect(v.code, v.stderr).toBe(0);
  const py = join(venv, "bin", "python");
  const i = await runCmd(["uv", "pip", "install", "--quiet", "--python", py, "--no-deps", tree], { cwd: tree, env });
  expect(i.code, i.stderr).toBe(0);
  const requestPath = join(tree, "..", `request-${label}.json`);
  await Bun.write(requestPath, JSON.stringify({ schemaVersion: 1, cases: contract.cases.map((c) => ({ id: c.id, input: c.input })) }));
  // cwd is outside the tree so only the installed package is importable.
  const r = await runCmd([py, "-I", join(fixturesDir, "run-cases.py"), requestPath], { cwd: join(tree, "..") });
  expect(r.code, r.stderr).toBe(0);
  return r.stdout
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Observation);
}

const uvAvailable = await commandWorks(["uv", "--version"]);

describe("diagnostic candidate fixture (measured with uv)", () => {
  test.skipIf(!uvAvailable)(
    "baseline tree reproduces the failure and the diagnostic candidate passes all six cases",
    async () => {
      const work = await mkdtemp(join(tmpdir(), "airlock-diag-"));
      const baseTree = join(work, "base", "src");
      if (!(await materializeBase(baseTree))) {
        throw new Error("no baseline tree available: neither profiles/tabulate-365/base nor research/reference-repos/python-tabulate");
      }
      expect((await readdir(baseTree)).includes("pyproject.toml")).toBe(true);
      const candTree = join(work, "cand", "src");
      await cp(baseTree, candTree, { recursive: true });
      await cp(join(fixturesDir, "diagnostic-candidate-tabulate-365", "tabulate", "__init__.py"), join(candTree, "tabulate", "__init__.py"));

      const baseObs = await installAndRun(baseTree, "base");
      const baseline = run("baseline", baseObs);
      expect(baseline.passed, JSON.stringify(baseline.cases.filter((c) => !c.passed), null, 1)).toBe(true);
      expect(baseline.cases.find((c) => c.caseId === REPORTED)?.observed?.exceptionType).toBe("IndexError");
      // The unrepaired tree must NOT satisfy the candidate contract.
      expect(run("candidate", baseObs).passed).toBe(false);

      const candObs = await installAndRun(candTree, "cand");
      const candidate = run("candidate", candObs);
      expect(candidate.passed, JSON.stringify(candidate.cases.filter((c) => !c.passed), null, 1)).toBe(true);
      expect(candidate.completedCases).toBe(6);
      // The repaired tree must NOT satisfy the baseline contract (it no longer raises).
      expect(run("baseline", candObs).passed).toBe(false);
    },
    180_000,
  );
});

describe("compare: outcome in words (M11, D9)", () => {
  const withObs = (role: "baseline" | "candidate", edit: (o: Observation) => Observation) => matching(role).map(edit);
  test("baseline: REPRODUCED when every baseline expectation holds", () => {
    expect(run("baseline", matching("baseline")).outcome).toBe("REPRODUCED");
  });
  test("baseline: NOT_REPRODUCED only when the measured reported case did not fail as expected", () => {
    const obs = withObs("baseline", (o) => (o.caseId === REPORTED ? { caseId: REPORTED, status: "ok", valueCanonical: '""' } : o));
    const r = run("baseline", obs);
    expect(r.passed).toBe(false);
    expect(r.outcome).toBe("NOT_REPRODUCED");
  });
  test("baseline: a reproduced reported case with regression drift is INCONCLUSIVE, not NOT_REPRODUCED", () => {
    const obs = withObs("baseline", (o) => (o.caseId === "reg-small-table-plain" ? { ...o, valueCanonical: '"drifted"' } : o));
    const r = run("baseline", obs);
    expect(r.cases.find((c) => c.caseId === REPORTED)?.passed).toBe(true);
    expect(r.outcome).toBe("INCONCLUSIVE");
  });
  test("baseline: an incomplete run is INCONCLUSIVE", () => {
    expect(run("baseline", matching("baseline"), {}, { status: "timed_out", timedOut: true, exitCode: null }).outcome).toBe("INCONCLUSIVE");
  });
  test("candidate: PASSED_CHECKS, CHECKS_FAILED on a measured failure, INCONCLUSIVE on an infrastructure fault", () => {
    expect(run("candidate", matching("candidate")).outcome).toBe("PASSED_CHECKS");
    const broken = withObs("candidate", (o) => (o.caseId === REPORTED ? { caseId: REPORTED, status: "error", exceptionType: "IndexError", message: "list index out of range" } : o));
    expect(run("candidate", broken).outcome).toBe("CHECKS_FAILED");
    // A candidate that hangs the adapter is its own failure, not infrastructure.
    expect(run("candidate", [], {}, { status: "timed_out", timedOut: true, exitCode: null }).outcome).toBe("CHECKS_FAILED");
    const badInspection = invoke(matching("candidate")).inspection;
    expect(run("candidate", [], { inspection: { ...badInspection, allPassed: false } }).outcome).toBe("INCONCLUSIVE");
  });
});

describe("compare: one fresh invocation per case (D3), probe and host listing (M6, M7)", () => {
  const probe = { probedAt: NOW, metadataEndpoint: "BLOCKED", dns: "BLOCKED", outboundTcp: "BLOCKED", dockerSocket: "BLOCKED", hostMounts: "BLOCKED", allBlocked: true } as const;
  const hostListing = { listedAt: NOW, scope: "host" as const, containers: [], volumes: [] };
  function perCase(role: "baseline" | "candidate", edit: (caseId: string, inv: InvokeResult) => InvokeResult | null = (_id, inv) => inv): CaseInvocation[] {
    return matching(role).map((o, i) => {
      const inv = edit(o.caseId, invoke([o], { operationId: `op-${i}`, container: `c-${i}`, teardown: { destroyedAt: NOW, containersRemaining: [], volumesRemaining: [], clean: true, host: hostListing } }));
      return inv ? { caseId: o.caseId, invoke: inv } : { caseId: o.caseId, invoke: null, error: "supervisor unavailable" };
    });
  }
  function runPerCase(role: "baseline" | "candidate", invocations: CaseInvocation[]) {
    const aggregate = aggregateInvocations(invocations);
    if (!aggregate) throw new Error("no aggregate");
    const record = compare({ id: "ver-2", taskId: "task-1", role, contract, invoke: aggregate, invocations, probe, host, adapterDigest: HEX, contractDigest: HEX, candidateDigest: HEX, now: NOW });
    VerificationRecord.parse(record);
    return { record, aggregate };
  }

  test("every case on its own invocation passes; the record carries the author probe and the host-wide listing", () => {
    const { record, aggregate } = runPerCase("candidate", perCase("candidate"));
    expect(record.passed).toBe(true);
    expect(record.outcome).toBe("PASSED_CHECKS");
    expect(record.completedCases).toBe(6);
    expect(record.runtimeProfile.probe).toEqual(probe);
    expect(record.runtimeProfile.teardown.host).toEqual(hostListing);
    expect(record.runtimeProfile.teardown.clean).toBe(true);
    expect(aggregate.observations).toHaveLength(6);
  });

  test("a failed invocation makes only its own case incomplete, and the record cannot pass", () => {
    const { record, aggregate } = runPerCase("candidate", perCase("candidate", (id, inv) => (id === "reg-small-table-plain" ? null : inv)));
    expect(record.passed).toBe(false);
    expect(record.completedCases).toBe(5);
    const failed = record.cases.filter((c) => !c.passed);
    expect(failed.map((c) => c.caseId)).toEqual(["reg-small-table-plain"]);
    expect(failed[0]?.reason).toContain("invocation failed");
    expect(record.outcome).toBe("INCONCLUSIVE");
    expect(aggregate.exec.status).toBe("failed");
    expect(aggregate.teardown.clean).toBe(false);
  });

  test("a timed-out invocation fails only its own case; the others still count", () => {
    const { record } = runPerCase("candidate", perCase("candidate", (id, inv) => (id === REPORTED ? { ...inv, exec: { ...inv.exec, status: "timed_out", timedOut: true, exitCode: null } } : inv)));
    expect(record.passed).toBe(false);
    expect(record.cases.filter((c) => !c.passed).map((c) => c.caseId)).toEqual([REPORTED]);
    expect(record.outcome).toBe("CHECKS_FAILED");
  });

  test("an observation for another case inside a case's invocation cannot pass that case", () => {
    const { record } = runPerCase("candidate", perCase("candidate", (id, inv) => (id === REPORTED ? { ...inv, observations: [...inv.observations, { caseId: "reg-small-table-plain", status: "ok", valueCanonical: "1" }] } : inv)));
    expect(record.cases.find((c) => c.caseId === REPORTED)?.passed).toBe(false);
    expect(record.passed).toBe(false);
  });

  test("invocations on different runtime images invalidate the record", () => {
    const { record } = runPerCase("candidate", perCase("candidate", (id, inv) => (id === REPORTED ? { ...inv, inspection: { ...inv.inspection, imageDigest: "sha256:other" } } : inv)));
    expect(record.passed).toBe(false);
    expect(record.outcome).toBe("INCONCLUSIVE");
  });

  test("baseline per case: the reported case reproduced but a regression drifted → INCONCLUSIVE", () => {
    const { record } = runPerCase("baseline", perCase("baseline", (id, inv) => (id === "reg-maxcolwidths-wrap" ? { ...inv, observations: [{ caseId: id, status: "ok", valueCanonical: '"drift"' }] } : inv)));
    expect(record.outcome).toBe("INCONCLUSIVE");
    expect(record.cases.find((c) => c.caseId === REPORTED)?.passed).toBe(true);
  });

  test("no invocation returned → no aggregate (no record can be made)", () => {
    expect(aggregateInvocations([{ caseId: REPORTED, invoke: null, error: "down" }])).toBeNull();
  });
});
