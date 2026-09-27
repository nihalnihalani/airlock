import { describe, expect, test } from "bun:test";
import { type CandidateBundle, type InvokeResult, candidateDigestOf, sha256 } from "@airlock/contracts";
import { SupervisorError } from "../src/errors";
import { invoke, parseObservations, verifyBundle } from "../src/invoke";
import { FakeDocker, defaultHandler } from "./fake-docker";
import { PROFILE, future, makeCore, operationFor } from "./helpers";

async function bundleOf(content: string): Promise<CandidateBundle> {
  const bytes = new TextEncoder().encode(content);
  const digest = await sha256(bytes);
  const manifest = {
    schemaVersion: 1 as const,
    profileId: PROFILE.id,
    baselineCommit: PROFILE.baselineCommit,
    baselineTreeDigest: PROFILE.baselineTreeDigest,
    replacements: [{ path: "tabulate/__init__.py", byteLength: bytes.length, sha256: digest }],
  };
  return {
    manifest,
    candidateDigest: await candidateDigestOf(manifest),
    files: [{ path: "tabulate/__init__.py", byteLength: bytes.length, sha256: digest, contentBase64: Buffer.from(bytes).toString("base64") }],
  };
}

const REQUEST = { schemaVersion: 1 as const, cases: [{ id: "c1", input: { headers: ["a"], tabular_data: [] } }] };

describe("invoke", () => {
  test("verifyBundle accepts a consistent bundle", async () => {
    const bundle = await bundleOf("def tabulate(): pass\n");
    const result = await verifyBundle(bundle, PROFILE);
    expect(result.ok).toBe(true);
  });

  test("verifyBundle rejects a tampered file, a tampered manifest digest and a disallowed path", async () => {
    const bundle = await bundleOf("def tabulate(): pass\n");
    const tamperedFile = { ...bundle, files: [{ ...bundle.files[0]!, contentBase64: Buffer.from("def tabulate(): return 'evil'\n").toString("base64") }] };
    const r1 = await verifyBundle(tamperedFile, PROFILE);
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.reason).toMatch(/decodes to|sha256/);

    const tamperedDigest = { ...bundle, candidateDigest: "0".repeat(64) };
    const r2 = await verifyBundle(tamperedDigest, PROFILE);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reason).toMatch(/candidateDigest/);

    const badPath = await bundleOf("x");
    badPath.manifest.replacements[0]!.path = "setup.py";
    badPath.files[0]!.path = "setup.py";
    badPath.candidateDigest = await candidateDigestOf(badPath.manifest);
    const r3 = await verifyBundle(badPath, PROFILE);
    expect(r3.ok).toBe(false);
    if (!r3.ok) expect(r3.reason).toMatch(/not an allowed replacement path/);

    const extraFile = { ...bundle, files: [...bundle.files, { ...bundle.files[0]!, path: "tabulate/extra.py" }] };
    const r4 = await verifyBundle(extraFile, PROFILE);
    expect(r4.ok).toBe(false);
  });

  test("invoke with a tampered file is refused with 409 before any container is created", async () => {
    const docker = new FakeDocker(defaultHandler());
    const { core } = makeCore(docker);
    const bundle = await bundleOf("def tabulate(): pass\n");
    bundle.files[0]!.contentBase64 = Buffer.from("def tabulate(): return 'evil'\n").toString("base64");
    const base = { taskId: "task1", profileId: PROFILE.id, role: "candidate" as const, bundle, request: REQUEST, absoluteDeadline: future(60_000) };
    const operation = await operationFor("inv-tampered", base);
    const error = await invoke(core, { ...base, operation }).catch((e) => e as SupervisorError);
    expect((error as SupervisorError).code).toBe("bundle_mismatch");
    expect((error as SupervisorError).status).toBe(409);
    expect(docker.calls.filter((c) => c.startsWith("createContainer") || c.startsWith("createVolume"))).toEqual([]);
    core.stop();
  });

  test("a replay of a completed invoke after its deadline passed returns the recorded InvokeResult, not 400", async () => {
    const docker = new FakeDocker(defaultHandler({ adapter: { stdout: `${JSON.stringify({ caseId: "c1", status: "ok", valueCanonical: '"x"' })}\n` } }));
    const { core } = makeCore(docker);
    const bundle = await bundleOf("def tabulate(): pass\n");
    const base = { taskId: "task1", profileId: PROFILE.id, role: "candidate" as const, bundle, request: REQUEST, absoluteDeadline: future(300) };
    const operation = await operationFor("inv-replay-late", base);
    const first = await invoke(core, { ...base, operation });
    expect(first.status).toBe(200);
    await new Promise((r) => setTimeout(r, 500));
    const calls = docker.calls.length;
    const replay = await invoke(core, { ...base, operation });
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(first.body);
    expect(docker.calls.length).toBe(calls);
    core.stop();
  });

  test("invoke delivers replacements + request by tar, runs materialize then adapter, parses observations, tears down", async () => {
    const adapterOut = `${JSON.stringify({ caseId: "c1", status: "ok", valueCanonical: '"x"' })}\nnot json\n${JSON.stringify({ caseId: "bad id!", status: "ok" })}\n`;
    const docker = new FakeDocker(defaultHandler({ adapter: { stdout: adapterOut } }));
    const { core } = makeCore(docker);
    const bundle = await bundleOf("def tabulate(): pass\n");
    const base = { taskId: "task1", profileId: PROFILE.id, role: "candidate" as const, bundle, request: REQUEST, absoluteDeadline: future(60_000) };
    const response = await invoke(core, { ...base, operation: await operationFor("inv-ok", base) });
    const result = response.body as InvokeResult;
    expect(result.observations).toEqual([{ caseId: "c1", status: "ok", valueCanonical: '"x"' }]);
    expect(result.protocolErrors.length).toBe(2);
    expect(result.exec.status).toBe("succeeded");
    expect(result.teardown.clean).toBe(true);
    expect(result.container).toBe("airlocktest-candidate-task1-op-inv-ok");
    const seq = docker.calls;
    const put = seq.findIndex((c) => c.startsWith("putArchive airlocktest-candidate-task1-op-inv-ok /workspace"));
    const mat = seq.findIndex((c) => c.includes("materialize.py"));
    const adapter = seq.findIndex((c) => c.includes("adapter.py"));
    const remove = seq.findIndex((c) => c.startsWith("removeContainer airlocktest-candidate-task1-op-inv-ok"));
    expect(put).toBeGreaterThan(0);
    expect(mat).toBeGreaterThan(put);
    expect(adapter).toBeGreaterThan(mat);
    expect(remove).toBeGreaterThan(adapter);
    expect(docker.containers.size).toBe(0);
    expect(docker.volumes.size).toBe(0);
    core.stop();
  });

  test("baseline takes no bundle; candidate requires one", async () => {
    const docker = new FakeDocker(defaultHandler());
    const { core } = makeCore(docker);
    const bundle = await bundleOf("x");
    const b1 = { taskId: "task1", profileId: PROFILE.id, role: "baseline" as const, bundle, request: REQUEST, absoluteDeadline: future(60_000) };
    const e1 = await invoke(core, { ...b1, operation: await operationFor("i1", b1) }).catch((e) => e as SupervisorError);
    expect((e1 as SupervisorError).status).toBe(400);
    const b2 = { taskId: "task1", profileId: PROFILE.id, role: "candidate" as const, request: REQUEST, absoluteDeadline: future(60_000) };
    const e2 = await invoke(core, { ...b2, operation: await operationFor("i2", b2) }).catch((e) => e as SupervisorError);
    expect((e2 as SupervisorError).status).toBe(400);
    core.stop();
  });

  test("materialize failure yields no observations and a protocol error, and still tears down", async () => {
    const docker = new FakeDocker(defaultHandler({ materialize: { stderr: "refused", exitCode: 2 } }));
    const { core } = makeCore(docker);
    const base = { taskId: "task1", profileId: PROFILE.id, role: "baseline" as const, request: REQUEST, absoluteDeadline: future(60_000) };
    const response = await invoke(core, { ...base, operation: await operationFor("i3", base) });
    const result = response.body as InvokeResult;
    expect(result.observations).toEqual([]);
    expect(result.exec.status).toBe("failed");
    expect(result.protocolErrors[0]).toMatch(/materialize failed/);
    expect(docker.calls.some((c) => c.includes("adapter.py"))).toBe(false);
    expect(result.teardown.clean).toBe(true);
    core.stop();
  });

  test("parseObservations bounds count and reports bad lines", () => {
    const good = JSON.stringify({ caseId: "a", status: "error", exceptionType: "IndexError" });
    const parsed = parseObservations(`${good}\n${good}\n{"caseId":"a"}\n`, 1);
    expect(parsed.observations.length).toBe(1);
    expect(parsed.protocolErrors.length).toBe(2);
  });
});
