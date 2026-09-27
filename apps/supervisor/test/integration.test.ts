/**
 * Real-docker integration tests. Run on runc with AIRLOCK_DEV_UNSAFE semantics (dev-unsafe, never a
 * deployment default). Skipped automatically when Docker is unreachable or the runtime image
 * airlock-runtime-python:tabulate-365 is absent.
 */
import { describe, expect, test } from "bun:test";
import Docker from "dockerode";
import { join, resolve } from "node:path";
import type { AttemptRef, AttemptState, BlastRadiusCard, FreezeResult } from "@airlock/contracts";
import { SupervisorError } from "../src/errors";
import { resolveDockerSocket } from "../src/config";
import { checkHost } from "../src/host";
import { createSentinel, hostileRun } from "../src/hostile";
import { Supervisor } from "../src/lifecycle";
import { Journal } from "../src/operations";
import { loadProfiles } from "../src/profiles";
import { createDockerode } from "../src/runtime";
import type { DestroyResult } from "../src/types";
import { future, operationFor, tempDir, testConfig } from "./helpers";

const IMAGE = "airlock-runtime-python:tabulate-365";
const REPO = resolve(import.meta.dir, "../../..");

const api = createDockerode(resolveDockerSocket(process.env));
const dockerUp = await api.ping();
const imagePresent = dockerUp ? (await api.inspectImage(IMAGE)) !== null : false;
const available = dockerUp && imagePresent;
const imageId = imagePresent ? ((await api.inspectImage(IMAGE))?.id ?? "") : "";
const raw = new Docker(resolveDockerSocket(process.env) ? { socketPath: resolveDockerSocket(process.env) } : undefined);

/** Processes Docker reports inside the container, or why it cannot (stopped: 409, gone: 404). */
async function top(name: string): Promise<{ processes: string[] } | { error: number | string }> {
  try {
    const result = (await raw.getContainer(name).top({ ps_args: "-eo pid,args" })) as { Processes?: string[][] };
    return { processes: (result.Processes ?? []).map((p) => p.join(" ")) };
  } catch (error) {
    return { error: (error as { statusCode?: number }).statusCode ?? String(error) };
  }
}

async function until(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return predicate();
}
if (!available) {
  console.info(`[integration] skipped: docker=${dockerUp} image=${imagePresent}`);
}

describe("real docker (runc, dev-unsafe)", () => {
  test.skipIf(!available)(
    "author attempt: create → exec → freeze → envelope has tabulate/__init__.py → destroy clean",
    async () => {
      const dir = tempDir();
      const config = { ...testConfig(dir), profilesDir: join(REPO, "profiles"), namespace: `airlockit${Date.now().toString(36)}` };
      const profiles = loadProfiles(config.profilesDir);
      const host = await checkHost(api, config);
      expect(host.runtimeAvailable).toBe(true);
      const journal = new Journal(config.journalPath);
      const core = new Supervisor({ api, journal, config, profiles, host, log: (m) => console.info(`[integration] ${m}`) });
      await core.start();
      const ref: AttemptRef = { taskId: "it", attemptId: `a${Date.now().toString(36)}`, generation: 1 };
      try {
        const base = { ref, profileId: "tabulate-365", role: "author" as const, absoluteDeadline: future(120_000) };
        const created = await core.createAttempt({ ...base, operation: await operationFor("it-create", base) });
        const state = created.body as AttemptState;
        expect(state.status).toBe("running");
        expect(state.inspection?.allPassed).toBe(true);
        expect(state.inspection?.runtime).toBe("runc");
        expect(state.inspection?.devUnsafe).toBe(true);
        expect(state.inspection?.guestUname).toMatch(/Linux/);
        expect(state.probe?.allBlocked).toBe(true);

        const exec = await core.authorTool(ref, await operationFor("it-exec", {}), { kind: "exec", command: 'python -c "print(1)"' });
        expect(exec.body).toMatchObject({ kind: "exec", result: { status: "succeeded", exitCode: 0, stdout: "1\n" } });

        // The workspace is a size-capped tmpfs volume: a fill stops at caps.workspaceBytes with ENOSPC,
        // the sandbox is otherwise unaffected, and nothing reaches host disk.
        const workspaceBytes = profiles.get("tabulate-365")?.caps.workspaceBytes ?? 0;
        expect(workspaceBytes).toBeGreaterThan(0);
        const fill = await core.authorTool(ref, await operationFor("it-fill", {}), {
          kind: "exec",
          command: `dd if=/dev/zero of=/workspace/fill bs=1M count=${Math.ceil((workspaceBytes * 2) / 1048576)} 2>/dev/null; echo dd=$?; stat -c %s /workspace/fill; rm -f /workspace/fill; echo alive`,
        });
        const fillResult = (fill.body as { result: { status: string; stdout: string } }).result;
        expect(fillResult.status).toBe("succeeded");
        const lines = fillResult.stdout.trim().split("\n");
        expect(lines[0]).toBe("dd=1");
        expect(Number(lines[1])).toBeLessThanOrEqual(workspaceBytes);
        expect(Number(lines[1])).toBeGreaterThan(workspaceBytes / 2);
        expect(lines[2]).toBe("alive");
        const volume = await api.inspectVolume(`${config.namespace}-ws-it-${ref.attemptId}`);
        expect(volume?.driver).toBe("local");
        expect(volume?.options).toMatchObject({ type: "tmpfs", o: `size=${workspaceBytes},uid=1000,gid=1000,mode=0755` });

        const read = await core.authorTool(ref, await operationFor("it-read", {}), { kind: "read", path: "tabulate/__init__.py" });
        expect(read.body).toMatchObject({ kind: "read" });
        expect((read.body as { content: string }).content).toContain("def tabulate(");

        const freeze = await core.freeze(ref, await operationFor("it-freeze", { ref }));
        const result = freeze.body as FreezeResult;
        expect(result.stopConfirmed).toBe(true);
        expect(result.outstandingOperationsSettled).toBe(true);
        expect(result.envelope.files.map((f) => f.path)).toContain("tabulate/__init__.py");

        const destroyed = await core.destroy(ref, await operationFor("it-destroy", { ref }));
        expect((destroyed.body as DestroyResult).teardown.clean).toBe(true);
        expect((destroyed.body as DestroyResult).teardown.containersRemaining).toEqual([]);
      } finally {
        // Belt and braces: nothing may outlive the test whatever happened above.
        await core.destroy(ref, await operationFor("it-destroy-final", { ref })).catch(() => undefined);
        core.stop();
        journal.close();
      }
    },
    180_000,
  );

  test.skipIf(!available)(
    "one attempt over its limits (fork bomb, then deadline) is terminated while another attempt's command completes and the supervisor stays healthy",
    async () => {
      const dir = tempDir();
      const config = { ...testConfig(dir), profilesDir: join(REPO, "profiles"), namespace: `airlockcc${Date.now().toString(36)}` };
      const profiles = loadProfiles(config.profilesDir);
      const host = await checkHost(api, config);
      const journal = new Journal(config.journalPath);
      const core = new Supervisor({ api, journal, config, profiles, host, log: (m) => console.info(`[integration] ${m}`) });
      await core.start();
      const sentinel = await createSentinel(config.dataDir);
      const suffix = Date.now().toString(36);
      const refA: AttemptRef = { taskId: "cca", attemptId: `a${suffix}`, generation: 1 };
      const refB: AttemptRef = { taskId: "ccb", attemptId: `b${suffix}`, generation: 1 };
      try {
        const baseA = { ref: refA, profileId: "tabulate-365", role: "author" as const, absoluteDeadline: future(120_000) };
        await core.createAttempt({ ...baseA, operation: await operationFor("cc-create-a", baseA) });
        // A's long command is in flight while a hostile fork bomb runs in its own sandbox and B expires.
        const inFlight = core.authorTool(refA, await operationFor("cc-exec-a", {}), { kind: "exec", command: "sleep 12; echo done" });
        await new Promise((r) => setTimeout(r, 500));

        const hostileBody = { operation: { operationId: "cc-hostile", requestDigest: "" }, profileId: "tabulate-365", command: ":(){ :|:& };:; sleep 3; echo alive" };
        const hostile = await hostileRun(core, { ...hostileBody, operation: await operationFor("cc-hostile", { profileId: hostileBody.profileId, command: hostileBody.command }) }, sentinel);
        const card = hostile.body as BlastRadiusCard;
        expect(card.survived.supervisorHealthy).toBe(true);
        expect(card.survived.hostSentinelUnchanged).toBe(true);
        expect(card.survived.otherAttemptsRunning).toBe(1);
        expect(card.teardown.clean).toBe(true);

        // B: created with a short deadline; its command is cut by the deadline timer, not by A's or the hostile run.
        const baseB = { ref: refB, profileId: "tabulate-365", role: "author" as const, absoluteDeadline: future(6_000) };
        const createdB = await core.createAttempt({ ...baseB, operation: await operationFor("cc-create-b", baseB) });
        expect((createdB.body as AttemptState).status).toBe("running");
        const execB = await core.authorTool(refB, await operationFor("cc-exec-b", {}), { kind: "exec", command: "sleep 30; echo never" });
        const resultB = (execB.body as { result: { status: string } }).result;
        expect(resultB.status).not.toBe("succeeded");
        expect(journal.getAttempt(refB.attemptId)?.revoked).toBe(true);

        // A's command finished on its own, A is still running and dispatchable, the supervisor answers.
        const resultA = (await inFlight).body as { result: { status: string; exitCode: number | null; stdout: string } };
        expect(resultA.result.status).toBe("succeeded");
        expect(resultA.result.exitCode).toBe(0);
        expect(resultA.result.stdout).toBe("done\n");
        expect(journal.getAttempt(refA.attemptId)?.status).toBe("running");
        expect(journal.getAttempt(refA.attemptId)?.revoked).toBe(false);
        expect(await api.ping()).toBe(true);
        const again = await core.authorTool(refA, await operationFor("cc-exec-a2", {}), { kind: "exec", command: "echo still-here" });
        expect((again.body as { result: { stdout: string } }).result.stdout).toBe("still-here\n");

        const destroyedA = await core.destroy(refA, await operationFor("cc-destroy-a", { ref: refA }));
        expect((destroyedA.body as DestroyResult).teardown.clean).toBe(true);
        const destroyedB = await core.destroy(refB, await operationFor("cc-destroy-b", { ref: refB }));
        expect((destroyedB.body as DestroyResult).teardown.clean).toBe(true);
      } finally {
        await core.destroy(refA, await operationFor("cc-destroy-a-final", { ref: refA })).catch(() => undefined);
        await core.destroy(refB, await operationFor("cc-destroy-b-final", { ref: refB })).catch(() => undefined);
        core.stop();
        journal.close();
      }
    },
    240_000,
  );

  test.skipIf(!available)(
    "G3: a detached background child dies with its sandbox on expiry, revoke and destroy; none of those attempt ids can restart",
    async () => {
      const dir = tempDir();
      // D2 on real Docker: the pinned image ID is enforced on every inspection of this run.
      const config = { ...testConfig(dir), profilesDir: join(REPO, "profiles"), namespace: `airlockg3${Date.now().toString(36)}`, runtimeImageId: imageId };
      const profiles = loadProfiles(config.profilesDir);
      const host = await checkHost(api, config);
      const journal = new Journal(config.journalPath);
      const core = new Supervisor({ api, journal, config, profiles, host, log: (m) => console.info(`[integration] ${m}`) });
      await core.start();
      const suffix = Date.now().toString(36);
      const expiring: AttemptRef = { taskId: "g3x", attemptId: `x${suffix}`, generation: 1 };
      const revoked: AttemptRef = { taskId: "g3r", attemptId: `r${suffix}`, generation: 1 };
      const destroyed: AttemptRef = { taskId: "g3d", attemptId: `d${suffix}`, generation: 1 };
      const container = (ref: AttemptRef) => `${config.namespace}-author-${ref.taskId}-${ref.attemptId}`;
      const all = [expiring, revoked, destroyed];
      try {
        for (const ref of all) {
          // The expiring attempt gets a short renewable authorization that is never renewed (M1).
          const base = { ref, profileId: "tabulate-365", role: "author" as const, absoluteDeadline: future(120_000), ...(ref === expiring ? { authorizedUntil: future(15_000) } : {}) };
          const created = (await core.createAttempt({ ...base, operation: await operationFor(`g3-create-${ref.attemptId}`, base) })).body as AttemptState;
          expect(created.status).toBe("running");
          expect(created.inspection?.allPassed).toBe(true);
          const spawn = await core.authorTool(ref, await operationFor(`g3-spawn-${ref.attemptId}`, {}), { kind: "exec", command: "sh -c 'nohup sleep 1000 >/dev/null 2>&1 &'; echo spawned" });
          expect((spawn.body as { result: { status: string; stdout: string } }).result).toMatchObject({ status: "succeeded", stdout: "spawned\n" });
          // The detached child outlived the exec that started it.
          const before = await top(container(ref));
          expect("processes" in before && before.processes.some((p) => p.includes("sleep 1000"))).toBe(true);
        }

        // 1. expiry: the authorization lapses without renewal; the supervisor revokes and stops the whole container.
        // (the journal records the revocation before the stop; Docker's state is the evidence of the stop)
        expect(await until(() => journal.getAttempt(expiring.attemptId)?.revoked === true, 30_000)).toBe(true);
        let stopped = false;
        for (let i = 0; i < 50 && !stopped; i++) {
          stopped = (await api.inspectContainer(container(expiring)))?.state.running === false;
          if (!stopped) await new Promise((r) => setTimeout(r, 200));
        }
        expect(stopped).toBe(true);
        expect(journal.getAttempt(expiring.attemptId)?.status).toBe("revoked");
        expect(await top(container(expiring))).toEqual({ error: 409 });

        // 2. revoke
        await core.revoke(revoked, await operationFor("g3-revoke", { ref: revoked }));
        expect((await api.inspectContainer(container(revoked)))?.state.running).toBe(false);
        expect(await top(container(revoked))).toEqual({ error: 409 });

        // 3. destroy: the container is gone, and the host-wide listing no longer shows it.
        const teardown = ((await core.destroy(destroyed, await operationFor("g3-destroy", { ref: destroyed }))).body as DestroyResult).teardown;
        expect(teardown.clean).toBe(true);
        expect(await api.inspectContainer(container(destroyed))).toBeNull();
        expect(await top(container(destroyed))).toEqual({ error: 404 });
        expect(teardown.host?.containers.some((c) => c.name === container(destroyed))).toBe(false);
        expect(teardown.host?.containers.some((c) => c.name === container(expiring))).toBe(true);

        // None of them can restart: no tool call, no re-create under the same id.
        for (const ref of all) {
          const tool = await core.authorTool(ref, await operationFor(`g3-late-${ref.attemptId}`, {}), { kind: "exec", command: "echo alive" }).catch((e) => e as SupervisorError);
          expect(tool).toBeInstanceOf(SupervisorError);
          expect((tool as SupervisorError).code).toBe("revoked");
          const base = { ref, profileId: "tabulate-365", role: "author" as const, absoluteDeadline: future(120_000) };
          const again = await core.createAttempt({ ...base, operation: await operationFor(`g3-recreate-${ref.attemptId}`, base) }).catch((e) => e as SupervisorError);
          expect((again as SupervisorError).status).toBe(409);
        }
        expect(await top(container(expiring))).toEqual({ error: 409 });
        expect(await top(container(revoked))).toEqual({ error: 409 });
      } finally {
        for (const ref of all) await core.destroy(ref, await operationFor(`g3-final-${ref.attemptId}`, { ref })).catch(() => undefined);
        core.stop();
        journal.close();
      }
      const listing = await core.hostListing();
      expect(listing.containers.some((c) => c.name.startsWith(config.namespace))).toBe(false);
      expect(listing.volumes.some((v) => v.startsWith(config.namespace))).toBe(false);
    },
    180_000,
  );

  test.skipIf(!available)(
    "D2: a runtime image whose ID is not the pinned one (a retag) fails inspection and leaves nothing behind",
    async () => {
      const dir = tempDir();
      const config = { ...testConfig(dir), profilesDir: join(REPO, "profiles"), namespace: `airlockd2${Date.now().toString(36)}`, runtimeImageId: `sha256:${"f".repeat(64)}` };
      const profiles = loadProfiles(config.profilesDir);
      const host = await checkHost(api, config);
      const journal = new Journal(config.journalPath);
      const core = new Supervisor({ api, journal, config, profiles, host, log: () => {} });
      await core.start();
      const ref: AttemptRef = { taskId: "d2", attemptId: `a${Date.now().toString(36)}`, generation: 1 };
      try {
        const base = { ref, profileId: "tabulate-365", role: "author" as const, absoluteDeadline: future(60_000) };
        const error = await core.createAttempt({ ...base, operation: await operationFor("d2-create", base) }).catch((e) => e as SupervisorError);
        expect((error as SupervisorError).code).toBe("inspection_failed");
        expect((error as SupervisorError).message).toMatch(/imageId/);
        expect(core.capacity.used().sandboxes).toBe(0);
        const listing = await core.hostListing();
        expect(listing.containers.some((c) => c.name.startsWith(config.namespace))).toBe(false);
        expect(listing.volumes.some((v) => v.startsWith(config.namespace))).toBe(false);
      } finally {
        core.stop();
        journal.close();
      }
    },
    60_000,
  );
});
