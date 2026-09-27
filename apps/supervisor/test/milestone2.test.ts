/**
 * Milestone 2 supervisor guarantees against the fake Docker:
 *   M1 renewable execution authorization and no silent supersession,
 *   M2 atomic host admission (429 before any Docker call; release only on confirmed removal),
 *   M7 host-wide listing on every teardown,
 *   M12 runner readiness before the first dispatch,
 *   D2 pinned runtime image id at every inspection,
 *   D15 minimal /health, U1/U2 host identity, U3 blast radius.
 */
import { describe, expect, test } from "bun:test";
import { type AttemptRef, type AttemptState, type BlastRadiusCard, type HostCheck, type HostListing, requestDigestOf } from "@airlock/contracts";
import type { SupervisorConfig } from "../src/config";
import { SupervisorError } from "../src/errors";
import { checkHost } from "../src/host";
import { createSentinel, hostileRun } from "../src/hostile";
import { createApp } from "../src/index";
import { invoke } from "../src/invoke";
import type { DestroyResult } from "../src/types";
import { FakeDocker, defaultHandler } from "./fake-docker";
import { PROFILE, future, makeCore, operationFor, testConfig } from "./helpers";

const REF: AttemptRef = { taskId: "task1", attemptId: "att1", generation: 1 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function core(docker: FakeDocker, config: Partial<SupervisorConfig> = {}) {
  return makeCore(docker, undefined, { config });
}

async function create(c: ReturnType<typeof core>["core"], ref: AttemptRef, extra: { absoluteDeadline?: string; authorizedUntil?: string } = {}, opId = `create-${ref.attemptId}`) {
  const base = { ref, profileId: PROFILE.id, role: "author" as const, absoluteDeadline: extra.absoluteDeadline ?? future(60_000), ...(extra.authorizedUntil ? { authorizedUntil: extra.authorizedUntil } : {}) };
  return c.createAttempt({ ...base, operation: await operationFor(opId, base) });
}

async function renew(c: ReturnType<typeof core>["core"], ref: AttemptRef, authorizedUntil: string, opId: string) {
  const body = { ref, authorizedUntil };
  return c.renew(ref, await operationFor(opId, body), authorizedUntil);
}

function err(e: unknown): SupervisorError {
  if (!(e instanceof SupervisorError)) throw e;
  return e;
}

// -------------------------------------------------------------------------------------------------
// M1
// -------------------------------------------------------------------------------------------------

describe("M1 renewable execution authorization", () => {
  test("an authorization that is not renewed revokes dispatch and stops the whole container, like the deadline", async () => {
    const docker = new FakeDocker(defaultHandler());
    const { core: c, journal } = core(docker);
    const created = await create(c, REF, { authorizedUntil: future(250) });
    const state = created.body as AttemptState;
    expect(state.authorizedUntil).toBeDefined();
    expect(Date.parse(state.authorizedUntil ?? "")).toBeLessThan(Date.parse(state.deadline));
    await sleep(450);
    expect(journal.getAttempt("att1")?.revoked).toBe(true);
    expect(journal.getAttempt("att1")?.status).toBe("revoked");
    expect(docker.calls.some((x) => x.startsWith("stopContainer airlocktest-author-task1-att1"))).toBe(true);
    expect(docker.containers.get("airlocktest-author-task1-att1")?.running).toBe(false);
    const tool = await c.authorTool(REF, await operationFor("t-late", {}), { kind: "exec", command: "id" }).catch(err);
    expect((tool as SupervisorError).code).toBe("revoked");
    // never revived by a late renewal
    const late = await renew(c, REF, future(30_000), "renew-late").catch(err);
    expect((late as SupervisorError).status).toBe(409);
    c.stop();
  });

  test("a renewal before the lapse keeps the attempt live; the single timer moves to the new time", async () => {
    const docker = new FakeDocker(defaultHandler());
    const { core: c, journal } = core(docker);
    await create(c, REF, { authorizedUntil: future(300) });
    await sleep(120);
    const until = future(30_000);
    const renewed = await renew(c, REF, until, "renew-1");
    expect(renewed.status).toBe(200);
    expect(Date.parse((renewed.body as AttemptState).authorizedUntil ?? "")).toBeGreaterThan(Date.now() + 20_000);
    await sleep(350);
    expect(journal.getAttempt("att1")?.revoked).toBe(false);
    const tool = await c.authorTool(REF, await operationFor("t-ok", {}), { kind: "exec", command: "id" });
    expect(tool.status).toBe(200);
    // same id + same body replays the recorded receipt; same id + another body conflicts
    expect((await renew(c, REF, until, "renew-1")).body).toEqual(renewed.body);
    expect((await renew(c, REF, future(40_000), "renew-1").catch(err) as SupervisorError).code).toBe("operation_conflict");
    c.stop();
  });

  test("renewal is clamped to the absolute deadline; a past time is invalid", async () => {
    const docker = new FakeDocker(defaultHandler());
    const { core: c } = core(docker);
    const created = await create(c, REF, { absoluteDeadline: future(20_000), authorizedUntil: future(90_000) });
    const state = created.body as AttemptState;
    expect(state.authorizedUntil).toBe(state.deadline); // create clamps too
    const renewed = await renew(c, REF, future(3_600_000), "renew-far");
    expect((renewed.body as AttemptState).authorizedUntil).toBe(state.deadline);
    const past = await renew(c, REF, new Date(Date.now() - 1000).toISOString(), "renew-past").catch(err);
    expect((past as SupervisorError).code).toBe("invalid_body");
    const badCreate = await create(c, { taskId: "t9", attemptId: "a9", generation: 1 }, { authorizedUntil: new Date(Date.now() - 1).toISOString() }).catch(err);
    expect((badCreate as SupervisorError).code).toBe("invalid_body");
    c.stop();
  });

  test("renewal is refused for unknown, revoked, destroyed attempts and any generation but the recorded one", async () => {
    const docker = new FakeDocker(defaultHandler());
    const { core: c } = core(docker);
    await create(c, REF);
    expect((await renew(c, { ...REF, attemptId: "nope" }, future(5_000), "r-unknown").catch(err)).status).toBe(404);
    expect((await renew(c, { ...REF, generation: 0 }, future(5_000), "r-stale").catch(err) as SupervisorError).code).toBe("stale_generation");
    expect((await renew(c, { ...REF, generation: 2 }, future(5_000), "r-newer").catch(err) as SupervisorError).code).toBe("fenced");
    await c.revoke(REF, await operationFor("rv", { ref: REF }));
    expect((await renew(c, REF, future(5_000), "r-revoked").catch(err) as SupervisorError).code).toBe("revoked");
    await c.destroy(REF, await operationFor("ds", { ref: REF }));
    expect((await renew(c, REF, future(5_000), "r-destroyed").catch(err) as SupervisorError).code).toBe("revoked");
    c.stop();
  });

  test("a newer generation cannot create beside a live attempt of the same task; it revokes first. Older generations are stale", async () => {
    const docker = new FakeDocker(defaultHandler());
    const { core: c, journal } = core(docker);
    await create(c, REF);
    const next: AttemptRef = { taskId: "task1", attemptId: "att2", generation: 2 };
    const before = docker.calls.length;
    const refused = await create(c, next).catch(err);
    expect((refused as SupervisorError).code).toBe("fenced");
    expect((refused as SupervisorError).status).toBe(409);
    expect(docker.calls.slice(before).some((x) => /att2/.test(x))).toBe(false);
    expect(journal.getAttempt("att2")).toBeNull();
    expect(journal.isTombstoned("att2")).toBe(false);
    // tool calls with a higher generation do not take over the live attempt either
    const takeover = await c.authorTool({ ...REF, generation: 2 }, await operationFor("take", {}), { kind: "exec", command: "id" }).catch(err);
    expect((takeover as SupervisorError).code).toBe("fenced");
    // the newer owner revokes the old attempt (allowed at a higher generation), then creates its own
    await c.revoke({ ...REF, generation: 2 }, await operationFor("rv-old", { ref: { ...REF, generation: 2 } }));
    const second = await create(c, next, {}, "create-att2-again");
    expect((second.body as AttemptState).status).toBe("running");
    // the old owner is now stale on its own attempt
    const old = await c.authorTool(REF, await operationFor("old-tool", {}), { kind: "exec", command: "id" }).catch(err);
    expect((old as SupervisorError).code).toBe("stale_generation");
    const lower = await create(c, { taskId: "task1", attemptId: "att0", generation: 1 }).catch(err);
    expect((lower as SupervisorError).code).toBe("stale_generation");
    c.stop();
  });

  test("an expired or destroyed attempt id cannot restart", async () => {
    const docker = new FakeDocker(defaultHandler());
    const { core: c } = core(docker);
    await create(c, REF, { absoluteDeadline: future(200) });
    await sleep(350);
    expect((await c.authorTool(REF, await operationFor("x1", {}), { kind: "exec", command: "id" }).catch(err) as SupervisorError).code).toBe("revoked");
    const again = await create(c, REF, {}, "create-again").catch(err);
    expect((again as SupervisorError).status).toBe(409);
    await c.destroy(REF, await operationFor("d1", { ref: REF }));
    const resurrect = await create(c, REF, {}, "create-resurrect").catch(err);
    expect((resurrect as SupervisorError).code).toBe("revoked");
    c.stop();
  });

  test("HTTP: POST /attempts/:id/renew goes through the digest-checked operation journal", async () => {
    const docker = new FakeDocker(defaultHandler());
    const { core: c, dir } = core(docker);
    await create(c, REF, { authorizedUntil: future(5_000) });
    const app = createApp({ core: c, token: testConfig(dir).token, sentinel: await createSentinel(dir) });
    const auth = { authorization: `Bearer ${testConfig(dir).token}`, "content-type": "application/json" };
    const body = { ref: REF, authorizedUntil: future(20_000), operation: { operationId: "http-renew", requestDigest: "" } };
    body.operation.requestDigest = await requestDigestOf({ ...body, operation: { operationId: "http-renew" } });
    const ok = await app.request("/attempts/att1/renew", { method: "POST", headers: auth, body: JSON.stringify(body) });
    expect(ok.status).toBe(200);
    const state = (await ok.json()) as AttemptState;
    expect(state.authorizedUntil).toBe(new Date(Date.parse(body.authorizedUntil)).toISOString());
    const tampered = await app.request("/attempts/att1/renew", { method: "POST", headers: auth, body: JSON.stringify({ ...body, authorizedUntil: future(40_000) }) });
    expect(tampered.status).toBe(400);
    const wrongPath = await app.request("/attempts/other/renew", { method: "POST", headers: auth, body: JSON.stringify(body) });
    expect(wrongPath.status).toBe(400);
    const anonymous = await app.request("/attempts/att1/renew", { method: "POST", body: JSON.stringify(body) });
    expect(anonymous.status).toBe(401);
    c.stop();
  });
});

// -------------------------------------------------------------------------------------------------
// M2
// -------------------------------------------------------------------------------------------------

const TIGHT = (over: Partial<SupervisorConfig["capacity"]> = {}) => ({
  capacity: { memoryBytes: 64 * 1024 ** 3, pids: 4096, scratchBytes: 64 * 1024 ** 3, maxSandboxes: 1, vmOverheadBytes: 0, ...over },
});

describe("M2 host admission", () => {
  test("a sandbox that does not fit is refused with 429 before any Docker call, and the same operation can be retried later", async () => {
    const docker = new FakeDocker(defaultHandler());
    const { core: c, journal } = core(docker, TIGHT());
    await create(c, REF);
    expect(c.capacity.used().sandboxes).toBe(1);
    const other: AttemptRef = { taskId: "task2", attemptId: "b1", generation: 1 };
    const before = docker.calls.length;
    const refused = await create(c, other).catch(err);
    expect((refused as SupervisorError).code).toBe("capacity");
    expect((refused as SupervisorError).status).toBe(429);
    expect(docker.calls.length).toBe(before);
    expect(journal.getAttempt("b1")).toBeNull();
    expect(journal.isTombstoned("b1")).toBe(false);
    await c.destroy(REF, await operationFor("free", { ref: REF }));
    expect(c.capacity.used().sandboxes).toBe(0);
    const retried = await create(c, other); // same operation id: the refusal was not recorded as a receipt
    expect((retried.body as AttemptState).status).toBe("running");
    c.stop();
  });

  test("memory (with VM overhead), PIDs and scratch each bound admission; invoke and hostile are admitted too", async () => {
    const docker = new FakeDocker(defaultHandler());
    // one sandbox costs 512 MiB + 160 MiB overhead + 192 MiB of tmpfs (/tmp + workspace are RAM); the budget fits one
    const { core: c, dir } = core(docker, TIGHT({ maxSandboxes: 10, memoryBytes: 1024 ** 3, vmOverheadBytes: 160 * 1024 ** 2 }));
    await create(c, REF);
    expect(c.capacity.used().memoryBytes).toBe(PROFILE.caps.memoryBytes + 160 * 1024 ** 2 + 64 * 1024 ** 2 + 128 * 1024 ** 2);
    const before = docker.calls.length;
    const body = { taskId: "task1", profileId: PROFILE.id, role: "baseline" as const, request: { schemaVersion: 1 as const, cases: [{ id: "c1", input: {} }] }, absoluteDeadline: future(60_000) };
    const inv = await invoke(c, { ...body, operation: await operationFor("inv-full", body) }).catch(err);
    expect((inv as SupervisorError).code).toBe("capacity");
    const hostileBody = { profileId: PROFILE.id, command: "echo hi" };
    const hostile = await hostileRun(c, { ...hostileBody, operation: await operationFor("hostile-full", hostileBody) }, await createSentinel(dir)).catch(err);
    expect((hostile as SupervisorError).code).toBe("capacity");
    expect(docker.calls.slice(before).some((x) => /^(create|start)/.test(x))).toBe(false);
    c.stop();

    const pids = core(new FakeDocker(defaultHandler()), TIGHT({ maxSandboxes: 10, pids: PROFILE.caps.pidsLimit + 1 }));
    await create(pids.core, REF);
    expect((await create(pids.core, { taskId: "t2", attemptId: "p2", generation: 1 }).catch(err) as SupervisorError).message).toMatch(/pids/);
    pids.core.stop();
    const scratch = core(new FakeDocker(defaultHandler()), TIGHT({ maxSandboxes: 10, scratchBytes: 256 * 1024 ** 2 }));
    await create(scratch.core, REF);
    expect((await create(scratch.core, { taskId: "t2", attemptId: "s2", generation: 1 }).catch(err) as SupervisorError).message).toMatch(/scratch/);
    scratch.core.stop();
  });

  test("a one-shot sandbox releases its reservation once its removal is confirmed", async () => {
    const docker = new FakeDocker(defaultHandler({ adapter: { stdout: JSON.stringify({ caseId: "c1", status: "ok", valueCanonical: "1" }) + "\n" } }));
    const { core: c } = core(docker, TIGHT());
    const body = { taskId: "task1", profileId: PROFILE.id, role: "baseline" as const, request: { schemaVersion: 1 as const, cases: [{ id: "c1", input: {} }] }, absoluteDeadline: future(60_000) };
    const result = await invoke(c, { ...body, operation: await operationFor("inv-1", body) });
    expect(result.status).toBe(200);
    expect(c.capacity.used().sandboxes).toBe(0);
    c.stop();
  });

  test("an unconfirmed removal keeps the reservation until the janitor sees the container gone", async () => {
    const docker = new FakeDocker(defaultHandler());
    const { core: c } = core(docker, TIGHT());
    await create(c, REF);
    docker.removeError = (name) => (name.includes("author") ? Object.assign(new Error("device busy"), { statusCode: 500 }) : undefined);
    const destroyed = await c.destroy(REF, await operationFor("d-fail", { ref: REF }));
    expect((destroyed.body as DestroyResult).teardown.clean).toBe(false);
    expect(c.capacity.has("airlocktest-author-task1-att1")).toBe(true);
    expect((await create(c, { taskId: "t2", attemptId: "q2", generation: 1 }).catch(err) as SupervisorError).code).toBe("capacity");
    // The container finally goes away (operator or a later remove); the janitor confirms and releases.
    docker.removeError = undefined;
    docker.containers.delete("airlocktest-author-task1-att1");
    const report = await c.janitor();
    expect(report.released).toContain("airlocktest-author-task1-att1");
    expect(c.capacity.used().sandboxes).toBe(0);
    c.stop();
  });

  test("freeze admits its collector before revoking: a full host refuses the freeze and leaves the attempt live", async () => {
    const docker = new FakeDocker(defaultHandler());
    const { core: c, journal } = core(docker, TIGHT());
    await create(c, REF);
    const refused = await c.freeze(REF, await operationFor("fz", { ref: REF })).catch(err);
    expect((refused as SupervisorError).code).toBe("capacity");
    expect(journal.getAttempt("att1")?.revoked).toBe(false);
    expect(journal.getAttempt("att1")?.status).toBe("running");
    c.capacity.budget.maxSandboxes = 2;
    const frozen = await c.freeze(REF, await operationFor("fz", { ref: REF }));
    expect(frozen.status).toBe(200);
    expect(c.capacity.has("airlocktest-collector-task1-att1")).toBe(false);
    c.stop();
  });

  test("restart: containers that still exist count against the budget until removed", async () => {
    const docker = new FakeDocker(defaultHandler());
    const first = core(docker, TIGHT({ maxSandboxes: 4 }));
    await create(first.core, REF);
    first.core.stop();
    const { core: restarted } = makeCore(docker, first.journal, { dir: first.dir, config: TIGHT({ maxSandboxes: 4 }) });
    await restarted.start();
    expect(restarted.capacity.used().sandboxes).toBe(1);
    expect(restarted.capacity.usage().sandboxes[0]?.adopted).toBe(true);
    await restarted.destroy(REF, await operationFor("d-after", { ref: REF }));
    expect(restarted.capacity.used().sandboxes).toBe(0);
    restarted.stop();
  });

  test("HTTP: GET /capacity (authenticated) and 429 for a refused create", async () => {
    const docker = new FakeDocker(defaultHandler());
    const { core: c, dir } = core(docker, TIGHT());
    await create(c, REF);
    const token = testConfig(dir).token;
    const app = createApp({ core: c, token, sentinel: await createSentinel(dir) });
    expect((await app.request("/capacity")).status).toBe(401);
    const usage = (await (await app.request("/capacity", { headers: { authorization: `Bearer ${token}` } })).json()) as { used: { sandboxes: number }; budget: { maxSandboxes: number } };
    expect(usage.used.sandboxes).toBe(1);
    expect(usage.budget.maxSandboxes).toBe(1);
    const base = { ref: { taskId: "t2", attemptId: "h2", generation: 1 }, profileId: PROFILE.id, role: "author" as const, absoluteDeadline: future(60_000) };
    const operation = await operationFor("http-cap", base);
    const response = await app.request("/attempts", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ ...base, operation }) });
    expect(response.status).toBe(429);
    expect(((await response.json()) as { code: string }).code).toBe("capacity");
    c.stop();
  });
});

// -------------------------------------------------------------------------------------------------
// M7, M12, D2, D15, U1/U2
// -------------------------------------------------------------------------------------------------

describe("M7 host-wide listing", () => {
  test("every teardown carries the host listing taken after it; GET /listing returns it", async () => {
    const docker = new FakeDocker(defaultHandler());
    const { core: c, dir } = core(docker);
    await create(c, REF);
    const other: AttemptRef = { taskId: "task2", attemptId: "b1", generation: 1 };
    await create(c, other);
    const destroyed = (await c.destroy(REF, await operationFor("d1", { ref: REF }))).body as DestroyResult;
    expect(destroyed.teardown.clean).toBe(true);
    const host = destroyed.teardown.host as HostListing;
    expect(host.scope).toBe("host");
    expect(host.containers).toEqual([{ name: "airlocktest-author-task2-b1", taskId: "task2", role: "author", state: "running" }]);
    expect(host.volumes).toEqual(["airlocktest-ws-task2-b1"]);
    await c.destroy(other, await operationFor("d2", { ref: other }));
    const token = testConfig(dir).token;
    const app = createApp({ core: c, token, sentinel: await createSentinel(dir) });
    expect((await app.request("/listing")).status).toBe(401);
    const listing = (await (await app.request("/listing", { headers: { authorization: `Bearer ${token}` } })).json()) as HostListing;
    expect(listing.containers).toEqual([]);
    expect(listing.volumes).toEqual([]);
    c.stop();
  });
});

describe("M12 runner readiness", () => {
  test("a runner that does not print ready fails inspection closed before any materialize, probe or dispatch", async () => {
    const docker = new FakeDocker(defaultHandler({ ready: { stdout: "nope\n" } }));
    const { core: c } = core(docker);
    const e = await create(c, REF).catch(err);
    expect((e as SupervisorError).code).toBe("inspection_failed");
    expect((e as SupervisorError).message).toMatch(/readiness/);
    expect(docker.calls.some((x) => /materialize|probe\.sh/.test(x))).toBe(false);
    expect(docker.containers.size).toBe(0);
    expect(c.capacity.used().sandboxes).toBe(0);
    const hung = new FakeDocker(defaultHandler({ ready: { hang: true } }));
    const h = core(hung);
    const started = Date.now();
    expect((await create(h.core, REF).catch(err) as SupervisorError).code).toBe("inspection_failed");
    expect(Date.now() - started).toBeLessThan(9_000);
    h.core.stop();
    c.stop();
  }, 15_000);

  test("the readiness exec is fixed, isolated and runs as the sandbox user", async () => {
    const docker = new FakeDocker(defaultHandler());
    const { core: c } = core(docker);
    await create(c, REF);
    const ready = docker.calls.find((x) => x.includes("sys.stdout.write('ready"));
    expect(ready).toContain("/usr/local/bin/python3 -I -S -c");
    const readyIndex = docker.calls.indexOf(ready ?? "");
    expect(readyIndex).toBeLessThan(docker.calls.findIndex((x) => x.includes("materialize.py")));
    c.stop();
  });
});

describe("D2 pinned runtime image id", () => {
  test("a container whose effective image id is not the pinned one fails inspection (a retag fails)", async () => {
    const docker = new FakeDocker(defaultHandler());
    const { core: c } = core(docker, { runtimeImageId: `sha256:${"9".repeat(64)}`, devUnsafe: false });
    const e = await create(c, REF).catch(err);
    expect((e as SupervisorError).code).toBe("inspection_failed");
    expect((e as SupervisorError).message).toMatch(/imageId/);
    expect(docker.containers.size).toBe(0);
    c.stop();
    const match = core(new FakeDocker(defaultHandler()), { runtimeImageId: `sha256:${"0".repeat(64)}` });
    expect(((await create(match.core, REF)).body as AttemptState).inspection?.allPassed).toBe(true);
    match.core.stop();
  });

  test("dev-unsafe without a pin records the observed image id in the host check", async () => {
    const docker = new FakeDocker(defaultHandler());
    const { core: c } = core(docker);
    expect(c.host.check.runtimeImageId).toBeUndefined();
    await create(c, REF);
    expect(c.host.check.runtimeImageId).toBe(`sha256:${"0".repeat(64)}`);
    c.stop();
  });
});

describe("D15 /health, U1/U2 host identity", () => {
  test("GET /health is unauthenticated and says only ok; /host needs the token and carries host identity", async () => {
    const docker = new FakeDocker(defaultHandler());
    const { core: c, dir } = core(docker);
    const token = testConfig(dir).token;
    const app = createApp({ core: c, token, sentinel: await createSentinel(dir) });
    const health = await app.request("/health");
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true });
    expect((await app.request("/host")).status).toBe(401);
    expect((await app.request("/host", { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
    c.stop();
  });

  test("checkHost records the host uname and hostname beside the guest's, and the configured instance id", async () => {
    const docker = new FakeDocker(defaultHandler());
    const config = { ...testConfig("/tmp"), instanceId: "cb676a46-66fd-4dfb-b839-443f2e6c0b60", runtimeImageId: `sha256:${"0".repeat(64)}` };
    const report = await checkHost(docker, config);
    const check: HostCheck = report.check;
    expect(check.hostUname?.length ?? 0).toBeGreaterThan(0);
    expect(check.hostUname?.length ?? 0).toBeLessThanOrEqual(512);
    expect(check.hostHostname?.length ?? 0).toBeGreaterThan(0);
    expect(check.instanceId).toBe("cb676a46-66fd-4dfb-b839-443f2e6c0b60");
    expect(check.runtimeImageId).toBe(`sha256:${"0".repeat(64)}`);
  });
});

// -------------------------------------------------------------------------------------------------
// U3
// -------------------------------------------------------------------------------------------------

describe("U3 blast radius", () => {
  test("scratch files are counted before and after; every other live attempt is checked before and after", async () => {
    let counts = 0;
    const docker = new FakeDocker((container, spec) => {
      const cmd = spec.cmd.join(" ");
      if (cmd.includes("airlock-blast")) return { stdout: counts++ === 0 ? "16\n" : "0\n" };
      if (cmd.includes("rm -rf")) return { stdout: "", exitCode: 0 };
      return defaultHandler()(container, spec);
    });
    const { core: c, dir } = core(docker);
    await create(c, REF);
    const body = { profileId: PROFILE.id, command: "rm -rf /workspace/* /workspace/.[!.]*" };
    const card = (await hostileRun(c, { ...body, operation: await operationFor("h1", body) }, await createSentinel(dir))).body as BlastRadiusCard;
    expect(card.workspace).toEqual({ filesBefore: 16, filesAfter: 0 });
    expect(card.survived.siblings).toEqual([{ attemptId: "att1", taskId: "task1", runningBefore: true, runningAfter: true }]);
    expect(card.survived.otherAttemptsRunning).toBe(1);
    expect(card.teardown.clean).toBe(true);
    expect(card.teardown.host?.containers.map((x) => x.name)).toEqual(["airlocktest-author-task1-att1"]);
    const upload = docker.calls.find((x) => x.startsWith("putArchive airlocktest-hostile"));
    expect(upload).toMatch(/\/workspace/);
    c.stop();
  });

  test("a sandbox that is gone after the command reports filesAfter null", async () => {
    const docker = new FakeDocker((container, spec) => {
      const cmd = spec.cmd.join(" ");
      if (cmd.includes("kill-me")) {
        const entry = docker.containers.get(container);
        if (entry) entry.running = false;
        return { stdout: "", exitCode: 137 };
      }
      return defaultHandler()(container, spec);
    });
    const { core: c, dir } = core(docker);
    const body = { profileId: PROFILE.id, command: "kill-me" };
    const card = (await hostileRun(c, { ...body, operation: await operationFor("h2", body) }, await createSentinel(dir))).body as BlastRadiusCard;
    expect(card.workspace).toEqual({ filesBefore: 16, filesAfter: null });
    expect(card.survived.siblings).toEqual([]);
    c.stop();
  });
});
