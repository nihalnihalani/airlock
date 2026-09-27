import { describe, expect, test } from "bun:test";
import type { AttemptRef, FreezeResult } from "@airlock/contracts";
import { SupervisorError } from "../src/errors";
import { FakeDocker, defaultHandler } from "./fake-docker";
import { PROFILE, future, makeCore, operationFor } from "./helpers";

const REF: AttemptRef = { taskId: "task1", attemptId: "att1", generation: 1 };
const ENVELOPE = JSON.stringify({
  schemaVersion: 1,
  files: [{ path: "tabulate/__init__.py", byteLength: 3, sha256: "a".repeat(64), contentBase64: "YWJj" }],
  rejected: [],
});

async function createAuthor(docker: FakeDocker) {
  const { core, journal } = makeCore(docker);
  const base = { ref: REF, profileId: PROFILE.id, role: "author" as const, absoluteDeadline: future(60_000) };
  const operation = await operationFor("create1", base);
  const response = await core.createAttempt({ ...base, operation });
  return { core, journal, response };
}

describe("lifecycle", () => {
  test("createAttempt records before dispatch, provisions, materializes, probes and returns running", async () => {
    const docker = new FakeDocker(defaultHandler());
    const { core, response } = await createAuthor(docker);
    expect(response.status).toBe(200);
    const state = response.body as { status: string; container: string; inspection?: { allPassed: boolean; devUnsafe: boolean; runtime: string }; probe?: { allBlocked: boolean } };
    expect(state.status).toBe("running");
    expect(state.container).toBe("airlocktest-author-task1-att1");
    expect(state.inspection?.allPassed).toBe(true);
    expect(state.inspection?.devUnsafe).toBe(true);
    expect(state.inspection?.runtime).toBe("runc");
    expect(state.probe?.allBlocked).toBe(true);
    const order = docker.calls.filter((c) => /^(createVolume|createContainer|startContainer|exec)/.test(c)).map((c) => c.split(" ").slice(0, 2).join(" "));
    expect(order.slice(0, 3)).toEqual(["createVolume airlocktest-ws-task1-att1", "createContainer airlocktest-author-task1-att1", "startContainer airlocktest-author-task1-att1"]);
    // The workspace is a size-capped tmpfs volume (caps.workspaceBytes), never unbounded host disk.
    expect(docker.calls[0]).toBe("createVolume airlocktest-ws-task1-att1 type=tmpfs,device=tmpfs,o=size=134217728,uid=1000,gid=1000,mode=0755");
    expect(docker.volumes.get("airlocktest-ws-task1-att1")?.options).toEqual({ type: "tmpfs", device: "tmpfs", o: "size=134217728,uid=1000,gid=1000,mode=0755" });
    expect(docker.calls.some((c) => c.includes("materialize.py"))).toBe(true);
    expect(docker.calls.some((c) => c.includes("probe.sh"))).toBe(true);
    core.stop();
  });

  test("createAttempt refuses (409) and destroys when the probe is not fully blocked", async () => {
    const docker = new FakeDocker(defaultHandler({ probe: { stdout: JSON.stringify({ metadataEndpoint: "REACHED", dns: "BLOCKED", outboundTcp: "BLOCKED", dockerSocket: "BLOCKED", hostMounts: "BLOCKED", allBlocked: true }) } }));
    const { core } = makeCore(docker);
    const base = { ref: REF, profileId: PROFILE.id, role: "author" as const, absoluteDeadline: future(60_000) };
    const operation = await operationFor("create-probe", base);
    let error: SupervisorError | undefined;
    try {
      await core.createAttempt({ ...base, operation });
    } catch (e) {
      error = e as SupervisorError;
    }
    expect(error?.status).toBe(409);
    expect(error?.code).toBe("probe_failed");
    expect(docker.containers.size).toBe(0);
    expect(docker.volumes.size).toBe(0);
    expect(core.journal.isTombstoned("att1")).toBe(true);
    // replay of the same operation returns the recorded 409
    const again = await core.createAttempt({ ...base, operation }).catch((e) => e as SupervisorError);
    expect((again as SupervisorError).status).toBe(409);
    core.stop();
  });

  test("createAttempt fails closed on a tampered effective config", async () => {
    const docker = new FakeDocker(defaultHandler());
    docker.tamper = (d) => ({ ...d, hostConfig: { ...d.hostConfig, NetworkMode: "bridge" } });
    const { core } = makeCore(docker);
    const base = { ref: REF, profileId: PROFILE.id, role: "author" as const, absoluteDeadline: future(60_000) };
    const operation = await operationFor("create-tamper", base);
    const error = await core.createAttempt({ ...base, operation }).catch((e) => e as SupervisorError);
    expect((error as SupervisorError).code).toBe("inspection_failed");
    expect(docker.containers.size).toBe(0);
    core.stop();
  });

  test("freeze orders revoke → collector holds the volume (read-only) → stop → settle → inspect stopped → collect", async () => {
    const docker = new FakeDocker(defaultHandler({ collector: { stdout: ENVELOPE } }));
    const { core, journal } = await createAuthor(docker);
    // A long-running author exec is in flight when freeze arrives.
    docker.handler = (container, spec) => {
      if (spec.cmd.join(" ").includes("sleep 100")) return { stdout: "", hang: true };
      return defaultHandler({ collector: { stdout: ENVELOPE } })(container, spec);
    };
    const toolBody = { ref: REF, args: { kind: "exec" as const, command: "sleep 100" } };
    const toolOp = await operationFor("tool1", toolBody);
    const toolPromise = core.authorTool(REF, toolOp, toolBody.args);
    await new Promise((r) => setTimeout(r, 30));
    docker.calls.length = 0;

    const freezeOp = await operationFor("freeze1", { ref: REF });
    const response = await core.freeze(REF, freezeOp);
    const result = response.body as FreezeResult;
    expect(result.stopConfirmed).toBe(true);
    expect(result.outstandingOperationsSettled).toBe(true);
    expect(result.envelope.files[0]?.path).toBe("tabulate/__init__.py");

    const tool = await toolPromise;
    expect(tool.body).toMatchObject({ kind: "exec", result: { status: "interrupted" } });

    const seq = docker.calls;
    const idx = (pattern: RegExp) => seq.findIndex((c) => pattern.test(c));
    const stop = idx(/^stopContainer airlocktest-author-task1-att1 t=2/);
    const inspectStopped = seq.findIndex((c, i) => i > stop && /^inspectContainer airlocktest-author-task1-att1/.test(c));
    const collectorCreate = idx(/^createContainer airlocktest-collector-task1-att1/);
    const collectorExec = idx(/^exec airlocktest-collector-task1-att1 .*collector\.py/);
    const collectorRemove = idx(/^removeContainer airlocktest-collector-task1-att1/);
    expect(stop).toBeGreaterThanOrEqual(0);
    expect(inspectStopped).toBeGreaterThan(stop);
    // The collector container is created (holding the tmpfs-backed workspace) BEFORE the author is
    // stopped, and runs only after the stop is confirmed.
    expect(collectorCreate).toBeGreaterThanOrEqual(0);
    expect(collectorCreate).toBeLessThan(stop);
    expect(collectorExec).toBeGreaterThan(inspectStopped);
    expect(collectorRemove).toBeGreaterThan(collectorExec);
    // no createVolume during freeze: the collector reuses the stopped volume, read-only
    expect(seq.some((c) => c.startsWith("createVolume"))).toBe(false);
    // the collector ran with cwd / and the fixed argv, and is gone afterwards
    expect(seq.some((c) => c.startsWith("exec airlocktest-collector-task1-att1 ") && c.includes("-I -S /opt/airlock/collector.py --root /candidate/src"))).toBe(true);
    expect(docker.containers.has("airlocktest-collector-task1-att1")).toBe(false);
    const record = journal.getAttempt("att1");
    expect(record?.status).toBe("stopped");
    expect(record?.revoked).toBe(true);
    // dispatch is closed: a later tool call is fenced
    // a completed tool operation still replays its recorded result after the freeze
    const replayed = await core.authorTool(REF, toolOp, toolBody.args);
    expect(replayed).toEqual(tool);
    const lateOp = await operationFor("tool2", { ref: REF, args: { kind: "exec" as const, command: "echo hi" } });
    const late = await core.authorTool(REF, lateOp, { kind: "exec", command: "echo hi" }).catch((e) => e as SupervisorError);
    expect((late as SupervisorError).code).toBe("revoked");
    core.stop();
  });

  test("freeze replays idempotently and the same id with another digest conflicts", async () => {
    const docker = new FakeDocker(defaultHandler({ collector: { stdout: ENVELOPE } }));
    const { core } = await createAuthor(docker);
    const freezeOp = await operationFor("freeze-x", { ref: REF });
    const first = await core.freeze(REF, freezeOp);
    const calls = docker.calls.length;
    const second = await core.freeze(REF, freezeOp);
    expect(second).toEqual(first);
    expect(docker.calls.length).toBe(calls);
    const conflict = await core.freeze(REF, { operationId: "freeze-x", requestDigest: "f".repeat(64) }).catch((e) => e as SupervisorError);
    expect((conflict as SupervisorError).code).toBe("operation_conflict");
    core.stop();
  });

  test("author tools: path allowlists, write via tar upload, exec result; stale generation fenced", async () => {
    const docker = new FakeDocker(defaultHandler());
    const { core } = await createAuthor(docker);
    const read = await core.authorTool(REF, await operationFor("r1", {}), { kind: "read", path: "setup.py" });
    expect(read.body).toMatchObject({ kind: "refused" });
    const readOk = await core.authorTool(REF, await operationFor("r2", {}), { kind: "read", path: "README.md" });
    expect(readOk.body).toMatchObject({ kind: "read", content: "file contents", truncated: false });
    const write = await core.authorTool(REF, await operationFor("w1", {}), { kind: "write", path: "README.md", content: "x" });
    expect(write.body).toMatchObject({ kind: "refused" });
    const writeOk = await core.authorTool(REF, await operationFor("w2", {}), { kind: "write", path: "tabulate/__init__.py", content: "print(1)\n" });
    expect(writeOk.body).toEqual({ kind: "write", byteLength: 9 });
    expect(docker.calls.some((c) => c.startsWith("putArchive airlocktest-author-task1-att1 /workspace/src"))).toBe(true);
    const exec = await core.authorTool(REF, await operationFor("e1", {}), { kind: "exec", command: "python -c 'print(1)'" });
    expect(exec.body).toMatchObject({ kind: "exec", result: { status: "succeeded", stdout: "1\n" } });
    const stale = await core.authorTool({ ...REF, generation: 0 }, await operationFor("e2", {}), { kind: "exec", command: "id" }).catch((e) => e as SupervisorError);
    expect((stale as SupervisorError).code).toBe("stale_generation");
    core.stop();
  });

  test("lost control during exec quarantines: container stopped, attempt revoked", async () => {
    const docker = new FakeDocker(defaultHandler({ author: { error: "socket hang up" } }));
    const { core, journal } = await createAuthor(docker);
    const exec = await core.authorTool(REF, await operationFor("e1", {}), { kind: "exec", command: "true" });
    expect(exec.body).toMatchObject({ kind: "exec", result: { status: "interrupted" } });
    expect(docker.calls.some((c) => c.startsWith("stopContainer airlocktest-author-task1-att1"))).toBe(true);
    expect(journal.getAttempt("att1")?.revoked).toBe(true);
    core.stop();
  });

  test("destroy removes container and volume, records a clean teardown and tombstones", async () => {
    const docker = new FakeDocker(defaultHandler());
    const { core, journal } = await createAuthor(docker);
    const response = await core.destroy(REF, await operationFor("d1", { ref: REF }));
    expect(response.body).toMatchObject({ teardown: { clean: true, containersRemaining: [], volumesRemaining: [] } });
    expect(docker.containers.size).toBe(0);
    expect(docker.volumes.size).toBe(0);
    expect(journal.getAttempt("att1")?.status).toBe("destroyed");
    expect(journal.isTombstoned("att1")).toBe(true);
    const base = { ref: REF, profileId: PROFILE.id, role: "author" as const, absoluteDeadline: future(60_000) };
    const resurrect = await core.createAttempt({ ...base, operation: await operationFor("create2", base) }).catch((e) => e as SupervisorError);
    expect((resurrect as SupervisorError).code).toBe("revoked");
    core.stop();
  });

  test("one attempt over its deadline is stopped while another attempt's command completes and dispatch stays open (CLAUDE.md §4)", async () => {
    const REF2: AttemptRef = { taskId: "task2", attemptId: "att2", generation: 1 };
    const docker = new FakeDocker((container, spec) => {
      if (spec.cmd.join(" ").includes("slow-work")) return { stdout: "done\n", delayMs: 500 };
      return defaultHandler()(container, spec);
    });
    const { core, journal } = makeCore(docker);
    // att1 expires in 250 ms; att2 has a long deadline and a 500 ms command in flight across att1's expiry.
    const base1 = { ref: REF, profileId: PROFILE.id, role: "author" as const, absoluteDeadline: future(250) };
    const base2 = { ref: REF2, profileId: PROFILE.id, role: "author" as const, absoluteDeadline: future(60_000) };
    await core.createAttempt({ ...base2, operation: await operationFor("create-b", base2) });
    await core.createAttempt({ ...base1, operation: await operationFor("create-a", base1) });
    const toolBody = { ref: REF2, args: { kind: "exec" as const, command: "slow-work" } };
    const inFlight = core.authorTool(REF2, await operationFor("tool-b", toolBody), toolBody.args);
    await new Promise((r) => setTimeout(r, 400));
    // att1 is over its limit: revoked and stopped; att2 is untouched.
    expect(journal.getAttempt("att1")?.revoked).toBe(true);
    expect(docker.calls.some((c) => c.startsWith("stopContainer airlocktest-author-task1-att1"))).toBe(true);
    expect(docker.calls.some((c) => c.startsWith("stopContainer airlocktest-author-task2-att2"))).toBe(false);
    expect(journal.getAttempt("att2")?.revoked).toBe(false);
    expect(journal.getAttempt("att2")?.status).toBe("running");
    const outcome = await inFlight;
    expect(outcome.body).toMatchObject({ kind: "exec", result: { status: "succeeded", exitCode: 0, stdout: "done\n" } });
    // att2 still accepts commands; att1 does not.
    const later = await core.authorTool(REF2, await operationFor("tool-b2", { ref: REF2, args: { kind: "exec" as const, command: "echo hi" } }), { kind: "exec", command: "echo hi" });
    expect(later.body).toMatchObject({ kind: "exec", result: { status: "succeeded" } });
    const fenced = await core.authorTool(REF, await operationFor("tool-a", { ref: REF, args: { kind: "exec" as const, command: "echo hi" } }), { kind: "exec", command: "echo hi" }).catch((e) => e as SupervisorError);
    expect((fenced as SupervisorError).code).toBe("revoked");
    expect(journal.countRunning()).toBe(1);
    core.stop();
  });

  test("a deadline stop that fails is recorded `unknown` (not a completed revoke) and the janitor retries the stop", async () => {
    const docker = new FakeDocker(defaultHandler());
    const { core, journal } = makeCore(docker);
    const base = { ref: REF, profileId: PROFILE.id, role: "author" as const, absoluteDeadline: future(250) };
    await core.createAttempt({ ...base, operation: await operationFor("create-deadline-fail", base) });
    docker.stopError = (name) => (name === "airlocktest-author-task1-att1" ? Object.assign(new Error("docker unavailable"), { statusCode: 500 }) : undefined);
    await new Promise((r) => setTimeout(r, 500));
    const failed = journal.getAttempt("att1");
    expect(failed?.revoked).toBe(true);
    expect(failed?.status).toBe("unknown");
    expect(docker.containers.get("airlocktest-author-task1-att1")?.running).toBe(true);
    expect(docker.calls.filter((c) => c.startsWith("stopContainer airlocktest-author-task1-att1")).length).toBe(1);
    // Dispatch is closed either way.
    const late = await core.authorTool(REF, await operationFor("tool-late", { ref: REF, args: { kind: "exec" as const, command: "echo hi" } }), { kind: "exec", command: "echo hi" }).catch((e) => e as SupervisorError);
    expect((late as SupervisorError).code).toBe("revoked");
    // Docker is back: the janitor re-stops the container and only then records the stop as confirmed.
    docker.stopError = undefined;
    await core.janitor();
    expect(docker.calls.filter((c) => c.startsWith("stopContainer airlocktest-author-task1-att1")).length).toBe(2);
    expect(docker.containers.get("airlocktest-author-task1-att1")?.running).toBe(false);
    expect(journal.getAttempt("att1")?.status).toBe("stopped");
    expect(journal.getAttempt("att1")?.revoked).toBe(true);
    core.stop();
  });

  test("a replay of a completed createAttempt after its deadline passed returns the recorded receipt, not 400", async () => {
    const docker = new FakeDocker(defaultHandler());
    const { core } = makeCore(docker);
    const base = { ref: REF, profileId: PROFILE.id, role: "author" as const, absoluteDeadline: future(300) };
    const operation = await operationFor("create-replay-late", base);
    const first = await core.createAttempt({ ...base, operation });
    expect(first.status).toBe(200);
    await new Promise((r) => setTimeout(r, 500));
    const calls = docker.calls.length;
    const replay = await core.createAttempt({ ...base, operation });
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(first.body);
    expect(docker.calls.length).toBe(calls);
    core.stop();
  });

  test("the absolute deadline revokes and stops regardless of the caller", async () => {
    const docker = new FakeDocker(defaultHandler());
    const { core, journal } = makeCore(docker);
    const base = { ref: REF, profileId: PROFILE.id, role: "author" as const, absoluteDeadline: future(400) };
    await core.createAttempt({ ...base, operation: await operationFor("create-deadline", base) });
    expect(journal.getAttempt("att1")?.status).toBe("running");
    await new Promise((r) => setTimeout(r, 600));
    const record = journal.getAttempt("att1");
    expect(record?.revoked).toBe(true);
    expect(docker.calls.some((c) => c.startsWith("stopContainer airlocktest-author-task1-att1"))).toBe(true);
    core.stop();
  });

  test("janitor removes owned containers the journal does not know and tombstones them", async () => {
    const docker = new FakeDocker(defaultHandler());
    const { core, journal } = makeCore(docker);
    await docker.createContainer({
      name: "airlocktest-author-ghost-g1",
      image: "x",
      labels: { "airlock.supervisor": "true", "airlock.namespace": "airlocktest", "airlock.task": "ghost", "airlock.attempt": "g1", "airlock.role": "author" },
      env: [],
      user: "1000:1000",
      workingDir: "/workspace",
      entrypoint: ["/usr/bin/sleep"],
      cmd: ["infinity"],
      hostname: "sandbox",
      hostConfig: { runtime: "runc", networkMode: "none", readonlyRootfs: true, capDrop: ["ALL"], securityOpt: ["no-new-privileges"], pidsLimit: 1, memory: 1, memorySwap: 1, nanoCpus: 1, ipcMode: "private", restartPolicy: { Name: "no" }, tmpfs: {}, mounts: [] },
    });
    await docker.createVolume("airlocktest-ws-ghost-g1", { "airlock.supervisor": "true", "airlock.namespace": "airlocktest", "airlock.task": "ghost", "airlock.attempt": "g1" }, {});
    const report = await core.janitor();
    expect(report.removedUnknown).toContain("airlocktest-author-ghost-g1");
    expect(report.removedUnknown).toContain("airlocktest-ws-ghost-g1");
    expect(docker.containers.size).toBe(0);
    expect(docker.volumes.size).toBe(0);
    expect(journal.isTombstoned("g1")).toBe(true);
    core.stop();
  });
});
