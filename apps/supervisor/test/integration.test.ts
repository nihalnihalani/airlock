/**
 * The one real-docker integration test. Runs on runc with AIRLOCK_DEV_UNSAFE semantics (dev-unsafe,
 * never a deployment default). Skipped automatically when Docker is unreachable or the runtime
 * image airlock-runtime-python:tabulate-365 is absent.
 */
import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import type { AttemptRef, AttemptState, FreezeResult } from "@airlock/contracts";
import { resolveDockerSocket } from "../src/config";
import { checkHost } from "../src/host";
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
});
