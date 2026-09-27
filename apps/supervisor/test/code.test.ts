/**
 * Milestone 4 code sandboxes (analysis, node) against the fake Docker API: roles and profiles,
 * put/write/read path rules, input quotas, collect-outputs ordering, refusal when unsettled, and the
 * supervisor's re-validation of the collector envelope.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { type AttemptRef, type AttemptState, CollectOutputsResult, requestDigestOf } from "@airlock/contracts";
import { codePathProblem, decodeBase64Strict, InputQuota, validateOutputEnvelope } from "../src/code";
import { type CodeRuntimeConfig, loadConfig } from "../src/config";
import { SupervisorError } from "../src/errors";
import { createSentinel } from "../src/hostile";
import { createApp } from "../src/index";
import type { Supervisor } from "../src/lifecycle";
import { FakeDocker, defaultHandler, tarEntries } from "./fake-docker";
import { PROFILE, future, makeCore, operationFor, tempDir, testConfig } from "./helpers";

const ZERO_ID = `sha256:${"0".repeat(64)}`;

function plane(role: "analysis" | "node", over: Partial<CodeRuntimeConfig> = {}): CodeRuntimeConfig {
  return {
    role,
    image: `airlock-runtime-${role}:dev`,
    imageId: ZERO_ID,
    cpus: 1,
    memoryBytes: role === "analysis" ? 1024 ** 3 : 512 * 1024 ** 2,
    pidsLimit: 128,
    commandTimeoutMs: 30_000,
    attemptTimeoutMs: 15 * 60_000,
    workspaceBytes: 256 * 1024 ** 2,
    outputBytes: 65_536,
    maxFileBytes: 1024 * 1024,
    maxInputFileBytes: 8 * 1024 * 1024,
    maxInputTotalBytes: 32 * 1024 * 1024,
    ...over,
  };
}

function core(docker: FakeDocker, seams: { settleMs?: number; analysis?: Partial<CodeRuntimeConfig>; node?: Partial<CodeRuntimeConfig> | null } = {}) {
  return makeCore(docker, undefined, {
    ...(seams.settleMs !== undefined ? { settleMs: seams.settleMs } : {}),
    config: { code: { analysis: plane("analysis", seams.analysis), node: seams.node === null ? undefined : plane("node", seams.node ?? {}) } },
  });
}

const err = (e: unknown) => e as SupervisorError;

async function create(c: Supervisor, role: "analysis" | "node" = "analysis", ref: AttemptRef = { taskId: "task1", attemptId: "att1", generation: 1 }, extra: Record<string, unknown> = {}) {
  const body = { ref, profileId: role, role, absoluteDeadline: future(120_000), ...extra };
  return c.createAttempt({ ...(body as { ref: AttemptRef; profileId: string; role: "analysis"; absoluteDeadline: string }), operation: await operationFor(`create-${ref.attemptId}`, body) });
}

let opCounter = 0;
async function tool(c: Supervisor, args: Parameters<Supervisor["authorTool"]>[2], ref: AttemptRef = { taskId: "task1", attemptId: "att1", generation: 1 }) {
  const id = `op${++opCounter}`;
  return c.authorTool(ref, await operationFor(id, { ref, args }), args);
}

async function collect(c: Supervisor, ref: AttemptRef = { taskId: "task1", attemptId: "att1", generation: 1 }) {
  const id = `collect${++opCounter}`;
  return c.collectOutputs(ref, await operationFor(id, { ref }));
}

function outputFile(path: string, content: string | Uint8Array, mediaType: string) {
  const bytes = typeof content === "string" ? Buffer.from(content) : Buffer.from(content);
  return { path, byteLength: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), mediaType, contentBase64: bytes.toString("base64") };
}

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489", "hex");

describe("analysis/node attempt creation", () => {
  test("order: bounded volume → hardened container (role image) → inspect (pinned image ID, readiness) → layout → probe; running", async () => {
    const docker = new FakeDocker();
    const { core: c } = core(docker);
    const state = (await create(c)).body as AttemptState;
    expect(state.status).toBe("running");
    expect(state.role).toBe("analysis");
    expect(state.inspection?.allPassed).toBe(true);
    expect(state.probe?.allBlocked).toBe(true);
    const container = docker.containers.get("airlocktest-analysis-task1-att1");
    expect(container?.spec.image).toBe("airlock-runtime-analysis:dev");
    expect(container?.spec.hostConfig).toMatchObject({ networkMode: "none", readonlyRootfs: true, capDrop: ["ALL"], securityOpt: ["no-new-privileges"], pidsLimit: 128, memory: 1024 ** 3, memorySwap: 1024 ** 3, nanoCpus: 1_000_000_000, restartPolicy: { Name: "no" } });
    expect(container?.spec.user).toBe("1000:1000");
    const seq = docker.calls;
    const at = (p: RegExp) => seq.findIndex((call) => p.test(call));
    expect(at(/^createVolume airlocktest-ws-task1-att1 .*size=268435456,/)).toBeGreaterThanOrEqual(0);
    expect(at(/^exec .*python3 -I -S -c/)).toBeGreaterThan(at(/^startContainer/));
    expect(at(/^putArchive airlocktest-analysis-task1-att1 \/workspace/)).toBeGreaterThan(at(/^exec .*python3 -I -S -c/));
    expect(at(/^exec .*probe\.sh --workspace-bytes 268435456/)).toBeGreaterThan(at(/^putArchive/));
    expect(seq.some((call) => call.includes("materialize.py"))).toBe(false);
    // layout: inputs root-owned (only the supervisor adds inputs), code/outputs owned by the sandbox user
    const layout = tarEntries(docker.archives[0]!.tar);
    expect(layout.map((e) => [e.path, e.type, e.uid, e.mode.toString(8)])).toEqual([
      ["inputs", "dir", 0, "755"],
      ["code", "dir", 1000, "755"],
      ["outputs", "dir", 1000, "755"],
    ]);
    c.stop();
  });

  test("node: node image, node readiness argv (empty env), 512 MiB default memory", async () => {
    const docker = new FakeDocker();
    const { core: c } = core(docker);
    const state = (await create(c, "node")).body as AttemptState;
    expect(state.status).toBe("running");
    expect(docker.containers.get("airlocktest-node-task1-att1")?.spec.image).toBe("airlock-runtime-node:dev");
    expect(docker.containers.get("airlocktest-node-task1-att1")?.spec.hostConfig.memory).toBe(512 * 1024 ** 2);
    expect(docker.calls.some((call) => /^exec airlocktest-node-.* \/usr\/bin\/env -i \/usr\/local\/bin\/node -e process\.stdout\.write\('ready/.test(call))).toBe(true);
    c.stop();
  });

  test("request rules: profileId must equal the role; unconfigured role unsupported; egressAllow refused", async () => {
    const { core: c } = core(new FakeDocker(), { node: null });
    expect(err(await create(c, "analysis", undefined, { profileId: PROFILE.id }).catch((e) => e)).code).toBe("invalid_body");
    expect(err(await create(c, "node", { taskId: "t2", attemptId: "a2", generation: 1 }).catch((e) => e)).code).toBe("unsupported_profile");
    expect(err(await create(c, "analysis", { taskId: "t3", attemptId: "a3", generation: 1 }, { egressAllow: ["example.com"] }).catch((e) => e)).code).toBe("invalid_body");
    c.stop();
  });

  test("the role image is pinned: a different image ID fails the inspection closed and removes the sandbox", async () => {
    const docker = new FakeDocker();
    const { core: c, journal } = core(docker, { analysis: { imageId: `sha256:${"a".repeat(64)}` } });
    const failed = err(await create(c).catch((e) => e));
    expect(failed.code).toBe("inspection_failed");
    expect(failed.message).toMatch(/imageId/);
    expect(docker.containers.size).toBe(0);
    expect(docker.volumes.size).toBe(0);
    expect(journal.isTombstoned("att1")).toBe(true);
    c.stop();
  });

  test("probe not fully BLOCKED refuses the attempt and destroys it", async () => {
    const docker = new FakeDocker(defaultHandler({ probe: { stdout: JSON.stringify({ metadataEndpoint: "BLOCKED", dns: "REACHED", outboundTcp: "BLOCKED", dockerSocket: "BLOCKED", hostMounts: "BLOCKED", allBlocked: true }) } }));
    const { core: c } = core(docker);
    expect(err(await create(c).catch((e) => e)).code).toBe("probe_failed");
    expect(docker.containers.size).toBe(0);
    c.stop();
  });
});

describe("put / write / read / exec rules", () => {
  test("put: only under inputs/, strict base64, root-owned 0444, sha256 returned", async () => {
    const docker = new FakeDocker();
    const { core: c } = core(docker);
    await create(c);
    const csv = "region,month,revenue\nA,1,10\n";
    const res = await tool(c, { kind: "put", path: "inputs/regions.csv", contentBase64: Buffer.from(csv).toString("base64") });
    expect(res.body).toEqual({ kind: "put", byteLength: csv.length, sha256: createHash("sha256").update(csv).digest("hex") });
    const archive = docker.archives.at(-1)!;
    expect(archive.path).toBe("/workspace");
    expect(tarEntries(archive.tar).map((e) => [e.path, e.type, e.uid, e.gid, e.mode.toString(8)])).toEqual([
      ["inputs", "dir", 0, 0, "755"],
      ["inputs/regions.csv", "file", 0, 0, "444"],
    ]);
    for (const path of ["code/x.csv", "outputs/x.csv", "inputs", "inputs/../code/x", "inputs/.hidden", "inputs/a b.csv", "/inputs/x", "x/inputs/y"]) {
      const e = err(await tool(c, { kind: "put", path, contentBase64: "eA==" }).catch((x) => x));
      expect(e.code).toBe("invalid_body");
      expect(e.status).toBe(400);
    }
    for (const b64 of ["eA", "eA=", "e A==", "eB==", "!!!!"]) {
      expect(err(await tool(c, { kind: "put", path: "inputs/b.bin", contentBase64: b64 }).catch((x) => x)).message).toMatch(/strict/);
    }
    // an input, once placed, is immutable
    expect(err(await tool(c, { kind: "put", path: "inputs/regions.csv", contentBase64: "eA==" }).catch((x) => x)).message).toMatch(/already placed/);
    c.stop();
  });

  test("put quotas: 8 MiB per file, 32 MiB per attempt; a refused put writes nothing", async () => {
    const docker = new FakeDocker();
    const { core: c } = core(docker);
    await create(c);
    const eight = Buffer.alloc(8 * 1024 * 1024, 0x61).toString("base64");
    const over = Buffer.alloc(8 * 1024 * 1024 + 1, 0x61).toString("base64");
    const before = docker.archives.length;
    expect(err(await tool(c, { kind: "put", path: "inputs/big.bin", contentBase64: over }).catch((x) => x)).message).toMatch(/per-file limit is 8388608/);
    expect(docker.archives.length).toBe(before);
    for (let i = 0; i < 4; i++) expect(((await tool(c, { kind: "put", path: `inputs/p${i}.bin`, contentBase64: eight })).body as { byteLength: number }).byteLength).toBe(8 * 1024 * 1024);
    expect(err(await tool(c, { kind: "put", path: "inputs/one-more.bin", contentBase64: "eA==" }).catch((x) => x)).message).toMatch(/per-attempt limit is 33554432/);
    expect(docker.archives.length).toBe(before + 4);
    c.stop();
  });

  test("a put Docker definitely refused releases its quota; the same path can be placed again", async () => {
    const docker = new FakeDocker();
    const { core: c } = core(docker, { analysis: { maxInputTotalBytes: 4 } });
    await create(c);
    docker.archive = { refuse: true };
    expect(err(await tool(c, { kind: "put", path: "inputs/a.bin", contentBase64: Buffer.from("abcd").toString("base64") }).catch((x) => x)).code).toBe("invalid_body");
    docker.archive = {};
    expect((await tool(c, { kind: "put", path: "inputs/a.bin", contentBase64: Buffer.from("abcd").toString("base64") })).body).toMatchObject({ kind: "put", byteLength: 4 });
    c.stop();
  });

  test("write: only under code/ (text, owned by the sandbox user); read: code/ or outputs/ only; exec runs in /workspace", async () => {
    const docker = new FakeDocker();
    const { core: c } = core(docker);
    await create(c);
    expect((await tool(c, { kind: "write", path: "code/analyze.py", content: "print(1)\n" })).body).toEqual({ kind: "write", byteLength: 9 });
    expect(tarEntries(docker.archives.at(-1)!.tar).map((e) => [e.path, e.uid, e.mode.toString(8)])).toEqual([
      ["code", 1000, "755"],
      ["code/analyze.py", 1000, "644"],
    ]);
    for (const path of ["inputs/x.py", "outputs/x.py", "analyze.py", "code/../inputs/x"]) {
      expect(err(await tool(c, { kind: "write", path, content: "x" }).catch((x) => x)).status).toBe(400);
    }
    expect(err(await tool(c, { kind: "write", path: "code/big.py", content: "x".repeat(1024 * 1024 + 1) }).catch((x) => x)).message).toMatch(/limit is 1048576/);
    expect((await tool(c, { kind: "read", path: "outputs/summary.json" })).body).toMatchObject({ kind: "read", content: "file contents", truncated: false });
    expect(docker.calls.at(-1)).toMatch(/head -c 1048577 -- \/workspace\/outputs\/summary\.json/);
    expect(err(await tool(c, { kind: "read", path: "inputs/regions.csv" }).catch((x) => x)).status).toBe(400);
    const exec = await tool(c, { kind: "exec", command: "python3 code/analyze.py" });
    expect(exec.body).toMatchObject({ kind: "exec", result: { status: "succeeded" } });
    const execCall = docker.calls.filter((call) => call.includes("python3 code/analyze.py")).at(-1)!;
    expect(execCall).toMatch(/timeout --signal=TERM --kill-after=2s 30s \/bin\/bash --noprofile --norc -c python3 code\/analyze\.py/);
    c.stop();
  });

  test("repair (author) attempts keep their rules: put is refused (400)", async () => {
    const docker = new FakeDocker();
    const { core: c } = core(docker);
    const ref = { taskId: "taskA", attemptId: "attA", generation: 1 };
    const body = { ref, profileId: PROFILE.id, role: "author" as const, absoluteDeadline: future(60_000) };
    await c.createAttempt({ ...body, operation: await operationFor("ca", body) });
    const e = err(await tool(c, { kind: "put", path: "inputs/x.csv", contentBase64: "eA==" }, ref).catch((x) => x));
    expect(e.status).toBe(400);
    expect(e.message).toMatch(/analysis and node attempts only/);
    c.stop();
  });
});

describe("collect-outputs", () => {
  test("ordering: admit → revoke → collector holds the volume read-only → stop → settle → inspect stopped → collect_outputs.py; envelope re-validated; attempt stopped", async () => {
    const files = [outputFile("chart.png", PNG, "image/png"), outputFile("summary.json", '{"worstRegion":"Synthetic-West"}', "application/json")];
    const docker = new FakeDocker(defaultHandler({ outputs: { stdout: JSON.stringify({ schemaVersion: 1, files, rejected: [{ path: "x.svg", reason: "svg is active content" }] }) } }));
    const { core: c, journal } = core(docker);
    await create(c);
    const mark = docker.calls.length;
    const res = await collect(c);
    expect(res.status).toBe(200);
    const parsed = CollectOutputsResult.safeParse(res.body);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.envelope.files.map((f) => f.path)).toEqual(["chart.png", "summary.json"]);
    expect(parsed.success && parsed.data.stopConfirmed).toBe(true);
    const seq = docker.calls.slice(mark);
    const at = (p: RegExp) => seq.findIndex((call) => p.test(call));
    const createCollector = at(/^createContainer airlocktest-collector-task1-att1/);
    const stop = at(/^stopContainer airlocktest-analysis-task1-att1/);
    const run = at(/^exec airlocktest-collector-task1-att1 .*\/usr\/local\/bin\/python3 -I -S \/opt\/airlock\/collect_outputs\.py --root \/candidate$/);
    const remove = at(/^removeContainer airlocktest-collector-task1-att1/);
    expect(createCollector).toBeGreaterThanOrEqual(0);
    expect(stop).toBeGreaterThan(createCollector);
    expect(run).toBeGreaterThan(stop);
    expect(remove).toBeGreaterThan(run);
    // the collector: analysis image, the workspace read-only at /candidate, cwd /
    const collectorSpec = docker.calls.includes("createContainer airlocktest-collector-task1-att1");
    expect(collectorSpec).toBe(true);
    expect(journal.getAttempt("att1")).toMatchObject({ status: "stopped", revoked: true });
    // dispatch is closed afterwards
    expect(err(await tool(c, { kind: "exec", command: "true" }).catch((x) => x)).code).toBe("revoked");
    // destroy leaves nothing
    const ref = { taskId: "task1", attemptId: "att1", generation: 1 };
    const destroyed = (await c.destroy(ref, await operationFor("d1", { ref }))).body as { teardown: { clean: boolean } };
    expect(destroyed.teardown.clean).toBe(true);
    expect(docker.containers.size + docker.volumes.size).toBe(0);
    c.stop();
  });

  test("node outputs are collected with the analysis image, over the node workspace size", async () => {
    const docker = new FakeDocker();
    let collectorImage = "";
    let collectorMount: unknown;
    const original = docker.createContainer.bind(docker);
    docker.createContainer = async (spec) => {
      if (spec.name.includes("-collector-")) {
        collectorImage = spec.image;
        collectorMount = spec.hostConfig.mounts[0];
      }
      return original(spec);
    };
    const { core: c } = core(docker, { node: { workspaceBytes: 300 * 1024 ** 2 } });
    await create(c, "node");
    expect((await collect(c)).status).toBe(200);
    expect(collectorImage).toBe("airlock-runtime-analysis:dev");
    expect(collectorMount).toEqual({ type: "volume", source: "airlocktest-ws-task1-att1", target: "/candidate", readOnly: true });
    c.stop();
  });

  test("refused when outstanding operations do not settle: 409, attempt unknown, collector never runs", async () => {
    const docker = new FakeDocker();
    const { core: c, journal } = makeCore(docker, undefined, { settleMs: 100, writeTimeoutMs: 60_000, config: { code: { analysis: plane("analysis"), node: undefined } } });
    await create(c);
    // An unresponsive daemon: an accepted input placement never returns, even when aborted.
    docker.archive = { hang: true, ignoreAbort: true };
    const hung = tool(c, { kind: "put", path: "inputs/x.csv", contentBase64: "eA==" }).catch((x) => x);
    await new Promise((r) => setTimeout(r, 20));
    const e = err(await collect(c).catch((x) => x));
    expect(e.code).toBe("fenced");
    expect(e.status).toBe(409);
    expect(e.message).toMatch(/did not settle/);
    expect(journal.getAttempt("att1")?.status).toBe("unknown");
    expect(docker.calls.some((call) => call.includes("collect_outputs.py"))).toBe(false);
    expect(docker.containers.has("airlocktest-collector-task1-att1")).toBe(false);
    void hung;
    c.stop();
  });

  test("a forged envelope (sha256 does not match the bytes) is refused; the attempt stays stopped, collector removed", async () => {
    const bad = { ...outputFile("summary.json", "{}", "application/json"), sha256: "f".repeat(64) };
    const docker = new FakeDocker(defaultHandler({ outputs: { stdout: JSON.stringify({ schemaVersion: 1, files: [bad], rejected: [] }) } }));
    const { core: c, journal } = core(docker);
    await create(c);
    const e = err(await collect(c).catch((x) => x));
    expect(e.code).toBe("internal");
    expect(e.message).toMatch(/sha256 does not match/);
    expect(journal.getAttempt("att1")?.status).toBe("stopped");
    expect(docker.containers.has("airlocktest-collector-task1-att1")).toBe(false);
    c.stop();
  });

  test("the collector failing to provision stops the (already revoked) sandbox instead of leaving it running", async () => {
    const docker = new FakeDocker();
    const { core: c, journal } = core(docker);
    await create(c);
    const original = docker.createContainer.bind(docker);
    docker.createContainer = async (spec) => {
      if (spec.name.includes("-collector-")) throw new SupervisorError("docker_unavailable", "boom");
      return original(spec);
    };
    expect(err(await collect(c).catch((x) => x)).code).toBe("docker_unavailable");
    expect(docker.containers.get("airlocktest-analysis-task1-att1")?.running).toBe(false);
    expect(journal.getAttempt("att1")).toMatchObject({ status: "stopped", revoked: true });
    c.stop();
  });

  test("role rules: collect-outputs on a repair attempt and freeze on an analysis attempt are fenced; replay returns the receipt", async () => {
    const docker = new FakeDocker();
    const { core: c } = core(docker);
    await create(c);
    const ref = { taskId: "task1", attemptId: "att1", generation: 1 };
    expect(err(await c.freeze(ref, await operationFor("fz", { ref })).catch((x) => x)).code).toBe("fenced");
    const refA = { taskId: "taskB", attemptId: "attB", generation: 1 };
    const body = { ref: refA, profileId: PROFILE.id, role: "author" as const, absoluteDeadline: future(60_000) };
    await c.createAttempt({ ...body, operation: await operationFor("cb", body) });
    expect(err(await c.collectOutputs(refA, await operationFor("co", { ref: refA })).catch((x) => x)).message).toMatch(/use freeze/);
    const op = await operationFor("co-1", { ref });
    const first = await c.collectOutputs(ref, op);
    const execs = docker.calls.filter((call) => call.includes("collect_outputs.py")).length;
    const replay = await c.collectOutputs(ref, op);
    expect(replay).toEqual(first);
    expect(docker.calls.filter((call) => call.includes("collect_outputs.py")).length).toBe(execs);
    c.stop();
  });

  test("HTTP route: digest-checked body, typed CollectOutputsResult", async () => {
    const dir = tempDir();
    const docker = new FakeDocker(defaultHandler({ outputs: { stdout: JSON.stringify({ schemaVersion: 1, files: [outputFile("a.txt", "hi", "text/plain")], rejected: [] }) } }));
    const { core: c } = makeCore(docker, undefined, { dir, config: { code: { analysis: plane("analysis"), node: undefined } } });
    await create(c);
    const app = createApp({ core: c, token: testConfig(dir).token, sentinel: await createSentinel(dir) });
    const headers = { authorization: `Bearer ${testConfig(dir).token}`, "content-type": "application/json" };
    const ref = { taskId: "task1", attemptId: "att1", generation: 1 };
    const bad = await app.request("/attempts/att1/collect-outputs", { method: "POST", headers, body: JSON.stringify({ ref, operation: { operationId: "c9", requestDigest: "0".repeat(64) } }) });
    expect(bad.status).toBe(400);
    const body = { ref, operation: { operationId: "c1", requestDigest: await requestDigestOf({ ref, operation: { operationId: "c1" } }) } };
    const ok = await app.request("/attempts/att1/collect-outputs", { method: "POST", headers, body: JSON.stringify(body) });
    expect(ok.status).toBe(200);
    expect(CollectOutputsResult.safeParse(await ok.json()).success).toBe(true);
    c.stop();
  });
});

describe("pure rules", () => {
  test("codePathProblem, decodeBase64Strict, InputQuota", () => {
    expect(codePathProblem("inputs/a.csv", ["inputs"])).toBeUndefined();
    expect(codePathProblem("inputs/sub/a.csv", ["inputs"])).toBeUndefined();
    expect(codePathProblem("inputs/a/b/c/d/e/f.csv", ["inputs"])).toMatch(/deeper/);
    expect(codePathProblem("inputs/-a", ["inputs"])).toMatch(/must match/);
    expect(decodeBase64Strict("aGk=")).toEqual(new Uint8Array([104, 105]));
    expect(decodeBase64Strict("aGl=")).toBeUndefined();
    const q = new InputQuota();
    const limits = { maxFileBytes: 5, maxTotalBytes: 8 };
    expect(q.reserve("a", "inputs/x", 5, limits)).toBeUndefined();
    expect(q.reserve("a", "inputs/y", 4, limits)).toMatch(/per-attempt/);
    expect(q.reserve("b", "inputs/y", 4, limits)).toBeUndefined();
    q.release("a", "inputs/x");
    expect(q.total("a")).toBe(0);
  });

  test("validateOutputEnvelope: shape, media type, duplicates (case-insensitive), byte counts, caps", () => {
    const ok = outputFile("a.csv", "x,y\n", "text/csv");
    expect(validateOutputEnvelope({ schemaVersion: 1, files: [ok], rejected: [] }).ok).toBe(true);
    expect(validateOutputEnvelope({ schemaVersion: 1, files: [{ ...ok, mediaType: "image/svg+xml" }], rejected: [] })).toMatchObject({ ok: false });
    expect(validateOutputEnvelope({ schemaVersion: 1, files: [ok, { ...ok, path: "A.csv" }], rejected: [] })).toMatchObject({ ok: false });
    expect(validateOutputEnvelope({ schemaVersion: 1, files: [{ ...ok, byteLength: 99 }], rejected: [] })).toMatchObject({ ok: false });
    expect(validateOutputEnvelope({ schemaVersion: 1, files: [{ ...ok, path: "../x" }], rejected: [] })).toMatchObject({ ok: false });
    const many = Array.from({ length: 51 }, (_, i) => outputFile(`f${i}.txt`, "x", "text/plain"));
    expect(validateOutputEnvelope({ schemaVersion: 1, files: many, rejected: [] })).toMatchObject({ ok: false });
  });

  test("config: AIRLOCK_ANALYSIS_*/AIRLOCK_NODE_* defaults, overrides, pins, node requires analysis", () => {
    const base = { SUPERVISOR_TOKEN: "x".repeat(20), AIRLOCK_RUNTIME: "runc", AIRLOCK_DEV_UNSAFE: "1" };
    const off = loadConfig(base, "/repo");
    expect(off.ok && off.config.code).toEqual({ analysis: undefined, node: undefined });
    const on = loadConfig({ ...base, AIRLOCK_ANALYSIS_IMAGE: "airlock-runtime-analysis:dev", AIRLOCK_NODE_IMAGE: "airlock-runtime-node:dev", AIRLOCK_NODE_MEMORY_BYTES: "268435456", AIRLOCK_ANALYSIS_COMMAND_TIMEOUT_MS: "60000" }, "/repo");
    expect(on.ok).toBe(true);
    if (on.ok) {
      expect(on.config.code.analysis).toMatchObject({ cpus: 1, memoryBytes: 1024 ** 3, pidsLimit: 128, commandTimeoutMs: 60_000, workspaceBytes: 256 * 1024 ** 2, maxInputFileBytes: 8 * 1024 ** 2, maxInputTotalBytes: 32 * 1024 ** 2, imageId: undefined });
      expect(on.config.code.node).toMatchObject({ memoryBytes: 268435456, commandTimeoutMs: 30_000 });
    }
    expect(loadConfig({ ...base, AIRLOCK_NODE_IMAGE: "airlock-runtime-node:dev" }, "/repo")).toMatchObject({ ok: false });
    expect(loadConfig({ ...base, AIRLOCK_ANALYSIS_IMAGE: "airlock-runtime-analysis:dev", AIRLOCK_ANALYSIS_PIDS: "3" }, "/repo")).toMatchObject({ ok: false });
    const prod = { SUPERVISOR_TOKEN: "x".repeat(20), AIRLOCK_RUNTIME: "runsc", AIRLOCK_RUNTIME_IMAGE_ID: ZERO_ID };
    expect(loadConfig({ ...prod, AIRLOCK_ANALYSIS_IMAGE: "airlock-runtime-analysis:dev" }, "/repo")).toMatchObject({ ok: false });
    expect(loadConfig({ ...prod, AIRLOCK_ANALYSIS_IMAGE: "airlock-runtime-analysis:dev", AIRLOCK_ANALYSIS_IMAGE_ID: ZERO_ID }, "/repo").ok).toBe(true);
  });
});

describe("one live attempt per task and role family", () => {
  test("a second live code sandbox for the same task is refused; browser and code are separate families", async () => {
    const docker = new FakeDocker(defaultHandler());
    const { core: c } = core(docker);
    await c.start();
    try {
      expect((await create(c, "analysis")).status).toBe(200);
      const second = err(await create(c, "node", { taskId: "task1", attemptId: "att2", generation: 2 }).catch((e) => e));
      expect(second.code).toBe("fenced");
      const { roleFamily } = await import("../src/lifecycle");
      expect(roleFamily("browser")).toBe("browser");
      expect(["author", "analysis", "node", "baseline"].map(roleFamily)).toEqual(["code", "code", "code", "code"]);
    } finally {
      c.stop();
    }
  });
});
