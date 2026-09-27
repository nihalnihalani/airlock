/**
 * Regression tests for the independent review of the milestone-2 supervisor (and the contract
 * alignment that came with milestone 3):
 *   A  RuntimeInspection.imageId on every inspection; typed route outputs (HostListing.networks,
 *      DestroyResult); refusals for not-yet-supported milestone-4 vocabulary
 *   B2 no reservation leaks when preparation throws after create, or before freeze's collector exists
 *   B3 tmpfs sizes are charged to the memory budget
 *   B4 GET /operations/:operationId with the attempt binding (and the journal migration)
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { type AttemptRef, type AttemptState, DestroyResult, HostListing, requestDigestOf } from "@airlock/contracts";
import { sandboxCost } from "../src/capacity";
import { SupervisorError } from "../src/errors";
import type { ExecSpec } from "../src/docker-api";
import { createSentinel } from "../src/hostile";
import { createApp } from "../src/index";
import { Journal } from "../src/operations";
import { FakeDocker, defaultHandler } from "./fake-docker";
import { PROFILE, future, makeCore, operationFor, tempDir, testConfig } from "./helpers";

const REF: AttemptRef = { taskId: "task1", attemptId: "att1", generation: 1 };

async function create(core: ReturnType<typeof makeCore>["core"], ref: AttemptRef = REF, opId = `create-${ref.attemptId}`) {
  const base = { ref, profileId: PROFILE.id, role: "author" as const, absoluteDeadline: future(60_000) };
  return core.createAttempt({ ...base, operation: await operationFor(opId, base) });
}

function err(e: unknown): SupervisorError {
  if (!(e instanceof SupervisorError)) throw e;
  return e;
}

/** Make `exec` throw a Docker transport error (not "container not running") for matching commands. */
function execThrows(docker: FakeDocker, match: RegExp): void {
  const original = docker.exec.bind(docker);
  docker.exec = async (name: string, spec: ExecSpec, signal: AbortSignal) => {
    if (match.test(spec.cmd.join(" "))) throw Object.assign(new Error("connection reset by engine"), { statusCode: 500 });
    return original(name, spec, signal);
  };
}

describe("A: inspection image id and typed outputs", () => {
  test("every author inspection records the local image id", async () => {
    const { core } = makeCore(new FakeDocker());
    const state = (await create(core)).body as AttemptState;
    expect(state.inspection?.imageId).toBe(`sha256:${"0".repeat(64)}`);
    core.stop();
  });

  test("/listing and destroy outputs validate against contracts; networks are listed", async () => {
    const dir = tempDir();
    const { core } = makeCore(new FakeDocker(), undefined, { dir });
    await create(core);
    const app = createApp({ core, token: testConfig(dir).token, sentinel: await createSentinel(dir) });
    const auth = { authorization: `Bearer ${testConfig(dir).token}`, "content-type": "application/json" };
    const listing = await (await app.request("/listing", { headers: auth })).json();
    expect(HostListing.safeParse(listing).success).toBe(true);
    expect((listing as { networks: string[] }).networks).toEqual([]);
    const body = { ref: REF, operation: { operationId: "d1", requestDigest: await requestDigestOf({ ref: REF, operation: { operationId: "d1" } }) } };
    const destroyed = await app.request("/attempts/att1/destroy", { method: "POST", headers: auth, body: JSON.stringify(body) });
    expect(destroyed.status).toBe(200);
    const parsed = DestroyResult.safeParse(await destroyed.json());
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.teardown.networksRemaining).toEqual([]);
    core.stop();
  });

  test("milestone-4 vocabulary on a supervisor without code runtimes: put refused on repair attempts, analysis/node unsupported", async () => {
    const dir = tempDir();
    const { core } = makeCore(new FakeDocker(), undefined, { dir });
    await create(core);
    const app = createApp({ core, token: testConfig(dir).token, sentinel: await createSentinel(dir) });
    const auth = { authorization: `Bearer ${testConfig(dir).token}`, "content-type": "application/json" };
    const args = { kind: "put", path: "tabulate/__init__.py", contentBase64: "eA==" };
    const body = { ref: REF, args, operation: { operationId: "p1", requestDigest: await requestDigestOf({ ref: REF, args, operation: { operationId: "p1" } }) } };
    const put = await app.request("/attempts/att1/tool", { method: "POST", headers: auth, body: JSON.stringify(body) });
    expect(put.status).toBe(400);
    expect(((await put.json()) as { error: string }).error).toMatch(/analysis and node attempts only/);
    const analysis = { ref: { ...REF, attemptId: "an1" }, profileId: PROFILE.id, role: "analysis" as const, absoluteDeadline: future(60_000) };
    expect(err(await core.createAttempt({ ...analysis, operation: await operationFor("an1", analysis) }).catch((e) => e)).code).toBe("unsupported_profile");
    core.stop();
  });
});

describe("B2: reservations never leak", () => {
  for (const [name, pattern] of [
    ["materialize throws", /materialize\.py/],
    ["the isolation probe throws", /probe\.sh/],
  ] as const) {
    test(`${name}: the sandbox is removed, the reservation released, the attempt revoked, the next create proceeds`, async () => {
      const docker = new FakeDocker(defaultHandler());
      execThrows(docker, pattern);
      const { core, journal } = makeCore(docker);
      const failed = err(await create(core).catch((e) => e));
      expect(failed.code).toBe("docker_unavailable");
      expect(docker.containers.size).toBe(0);
      expect(docker.volumes.size).toBe(0);
      expect(core.capacity.used().sandboxes).toBe(0);
      const record = journal.getAttempt("att1");
      expect(record?.revoked).toBe(true);
      expect(record?.status).toBe("destroyed");
      expect(journal.isTombstoned("att1")).toBe(true);
      // the failed attempt no longer fences its task
      docker.exec = FakeDocker.prototype.exec.bind(docker);
      const next = (await create(core, { taskId: "task1", attemptId: "att2", generation: 2 })).body as AttemptState;
      expect(next.status).toBe("running");
      core.stop();
    });
  }

  test("a removal that cannot be confirmed after a throw leaves the attempt unknown (revoked) for the janitor, reservation kept", async () => {
    const docker = new FakeDocker(defaultHandler());
    execThrows(docker, /probe\.sh/);
    docker.removeError = (n) => (n.includes("author") ? Object.assign(new Error("device busy"), { statusCode: 500 }) : undefined);
    const { core, journal } = makeCore(docker);
    await create(core).catch(() => {});
    expect(journal.getAttempt("att1")?.status).toBe("unknown");
    expect(journal.getAttempt("att1")?.revoked).toBe(true);
    expect(core.capacity.has("airlocktest-author-task1-att1")).toBe(true);
    docker.removeError = undefined;
    docker.containers.delete("airlocktest-author-task1-att1");
    const report = await core.janitor();
    expect(report.released).toContain("airlocktest-author-task1-att1");
    core.stop();
  });

  test("freeze: a throw after the collector is admitted but before it exists releases the collector reservation", async () => {
    const docker = new FakeDocker(defaultHandler());
    const { core, journal } = makeCore(docker);
    await create(core);
    const before = core.capacity.used().sandboxes;
    const revoke = journal.revoke.bind(journal);
    journal.revoke = () => {
      throw new Error("disk I/O error");
    };
    await core.freeze(REF, await operationFor("f1", { ref: REF })).catch(() => {});
    journal.revoke = revoke;
    expect(core.capacity.has("airlocktest-collector-task1-att1")).toBe(false);
    expect(core.capacity.used().sandboxes).toBe(before);

    const insert = journal.insertEphemeral.bind(journal);
    journal.insertEphemeral = () => {
      throw new Error("disk I/O error");
    };
    await core.freeze(REF, await operationFor("f2", { ref: REF })).catch(() => {});
    journal.insertEphemeral = insert;
    expect(core.capacity.has("airlocktest-collector-task1-att1")).toBe(false);
    core.stop();
  });
});

describe("B3: tmpfs is RAM", () => {
  test("a sandbox's memory charge includes its /tmp and workspace tmpfs sizes", () => {
    const budget = testConfig("/x").capacity;
    const withWorkspace = sandboxCost(PROFILE.caps, { ...budget, vmOverheadBytes: 0 }, true);
    expect(withWorkspace.memoryBytes).toBe(PROFILE.caps.memoryBytes + 64 * 1024 ** 2 + 128 * 1024 ** 2);
    const collector = sandboxCost(PROFILE.caps, { ...budget, vmOverheadBytes: 0 }, false);
    expect(collector.memoryBytes).toBe(PROFILE.caps.memoryBytes + 64 * 1024 ** 2);
  });

  test("a host whose memory fits the caps but not the tmpfs refuses (429) before any Docker call", async () => {
    const docker = new FakeDocker(defaultHandler());
    const { core } = makeCore(docker, undefined, { config: { capacity: { ...testConfig("/x").capacity, memoryBytes: PROFILE.caps.memoryBytes + 100 * 1024 ** 2 } } });
    expect(err(await create(core).catch((e) => e)).code).toBe("capacity");
    expect(docker.calls.some((c) => c.startsWith("create"))).toBe(false);
    core.stop();
  });
});

describe("B4: GET /operations/:operationId", () => {
  test("reports kind, state, status, receipt and the attempt binding; 404 for unknown; bad ids refused", async () => {
    const dir = tempDir();
    const { core } = makeCore(new FakeDocker(), undefined, { dir });
    await create(core, REF, "create-op");
    const app = createApp({ core, token: testConfig(dir).token, sentinel: await createSentinel(dir) });
    const auth = { authorization: `Bearer ${testConfig(dir).token}` };
    const found = await app.request("/operations/create-op", { headers: auth });
    expect(found.status).toBe(200);
    expect(await found.json()).toMatchObject({ operationId: "create-op", kind: "createAttempt", state: "completed", httpStatus: 200, resultRecorded: true, interruptedByRestart: false, taskId: "task1", attemptId: "att1", generation: 1 });
    expect((await app.request("/operations/nope", { headers: auth })).status).toBe(404);
    expect((await app.request("/operations/..%2Fx", { headers: auth })).status).toBe(400);
    expect((await app.request("/operations/create-op")).status).toBe(401);
    core.stop();
  });

  test("a pending operation reads as pending; after a restart it is interrupted, never re-run", async () => {
    const dir = tempDir();
    const journal = new Journal(join(dir, "j.sqlite"));
    journal.beginOperation({ operationId: "inflight", requestDigest: "a".repeat(64) }, "browserOp", { taskId: "t", attemptId: "b1", generation: 3 });
    expect(journal.getOperation("inflight")).toMatchObject({ state: "pending", httpStatus: null, resultRecorded: false, attemptId: "b1", generation: 3 });
    journal.interruptPendingOperations();
    expect(journal.getOperation("inflight")).toMatchObject({ state: "completed", httpStatus: 409, resultRecorded: true, interruptedByRestart: true, attemptId: "b1" });
    journal.close();
  });

  test("an older journal without the binding columns is migrated; its rows read with null bindings", () => {
    const dir = tempDir();
    const path = join(dir, "old.sqlite");
    const db = new Database(path, { create: true });
    db.exec(`CREATE TABLE operations (operation_id TEXT PRIMARY KEY, request_digest TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, http_status INTEGER, result_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
             INSERT INTO operations VALUES ('old1', '${"b".repeat(64)}', 'invoke:baseline', 'completed', 200, '{}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');`);
    db.close();
    const journal = new Journal(path);
    expect(journal.getOperation("old1")).toMatchObject({ kind: "invoke:baseline", state: "completed", taskId: null, attemptId: null, generation: null });
    journal.close();
  });

  test("invoke operations are bound to their task", async () => {
    const docker = new FakeDocker(defaultHandler({ adapter: { stdout: `${JSON.stringify({ caseId: "c1", status: "ok", valueCanonical: "1" })}\n` } }));
    const { core, journal } = makeCore(docker);
    const { invoke } = await import("../src/invoke");
    const body = { taskId: "task7", profileId: PROFILE.id, role: "baseline" as const, request: { schemaVersion: 1 as const, cases: [{ id: "c1", input: {} }] }, absoluteDeadline: future(60_000) };
    await invoke(core, { ...body, operation: await operationFor("inv-bound", body) });
    expect(journal.getOperation("inv-bound")).toMatchObject({ kind: "invoke:baseline", taskId: "task7", attemptId: null });
    core.stop();
  });
});
