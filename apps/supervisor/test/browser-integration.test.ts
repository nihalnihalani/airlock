/**
 * Real-Docker browser plane through the supervisor (runc, dev-unsafe: evidence of the mechanics,
 * never a deployment claim). Skips, with the reason printed, when Docker is unreachable, the images
 * airlock-browser:dev / airlock-egress:dev are absent, or the Docker host has no outbound internet
 * (example.com must be reachable for the allowlisted-navigation steps).
 *
 * Build the images first:  docker build -t airlock-egress:dev apps/egress
 *                          docker build -t airlock-browser:dev runtime/browser
 * On a small dev VM:        AIRLOCK_IT_BROWSER_MEMORY_BYTES=1073741824 (default 1 GiB here)
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import Docker from "dockerode";
import type { AttemptRef, AttemptState, BrowserObserveResult, BrowserOp, BrowserOpResult, BrowserScreenshotResult } from "@airlock/contracts";
import { resolveDockerSocket } from "../src/config";
import { checkHost } from "../src/host";
import { Supervisor } from "../src/lifecycle";
import { Journal } from "../src/operations";
import { createDockerode } from "../src/runtime";
import type { DestroyResult } from "../src/types";
import { future, operationFor, tempDir, testConfig } from "./helpers";

const REPO = resolve(import.meta.dir, "../../..");
const BROWSER_IMAGE = "airlock-browser:dev";
const EGRESS_IMAGE = "airlock-egress:dev";

const socket = resolveDockerSocket(process.env);
const api = createDockerode(socket);
const raw = new Docker(socket ? { socketPath: socket } : undefined);
const dockerUp = await api.ping();
const browserImage = dockerUp ? await api.inspectImage(BROWSER_IMAGE) : null;
const egressImage = dockerUp ? await api.inspectImage(EGRESS_IMAGE) : null;

/** Can a container on the default bridge resolve and reach example.com:443? (checked with the egress image's bun) */
async function outboundInternet(): Promise<{ ok: boolean; detail: string }> {
  if (!egressImage) return { ok: false, detail: "no egress image" };
  const name = `airlock-it-netcheck-${Date.now().toString(36)}`;
  try {
    const container = await raw.createContainer({
      name,
      Image: EGRESS_IMAGE,
      Entrypoint: ["bun", "-e", "const s=require('net').connect(443,'example.com');s.setTimeout(8000,()=>{console.log('TIMEOUT');process.exit(1)});s.on('connect',()=>{console.log('CONNECTED');process.exit(0)});s.on('error',e=>{console.log('ERROR '+e.code);process.exit(1)})"],
      HostConfig: { AutoRemove: false },
    });
    await container.start();
    const result = (await container.wait()) as { StatusCode: number };
    const logs = String(await container.logs({ stdout: true, stderr: true })).replace(/[\x00-\x08]/g, "").trim();
    return { ok: result.StatusCode === 0, detail: logs.slice(-200) };
  } catch (error) {
    return { ok: false, detail: String(error).slice(0, 200) };
  } finally {
    await raw.getContainer(name).remove({ force: true }).catch(() => {});
  }
}

const internet = dockerUp && browserImage && egressImage ? await outboundInternet() : { ok: false, detail: "n/a" };
const available = dockerUp && browserImage !== null && egressImage !== null && internet.ok;
if (!available) {
  console.info(`[browser-integration] SKIPPED: docker=${dockerUp} browserImage=${browserImage !== null} egressImage=${egressImage !== null} outboundInternet=${internet.ok} (${internet.detail})`);
}

describe("real docker browser plane (runc, dev-unsafe)", () => {
  test.skipIf(!available)(
    "create (sandbox evidence) → status → navigate example.com → observe → click → observe (new generation) → stale click refused → screenshot → disallowed host → metadata refused → destroy leaves nothing",
    async () => {
      const dir = tempDir();
      const namespace = `airlockbit${Date.now().toString(36)}`;
      const base = testConfig(dir);
      const seccompPath = join(REPO, "runtime/browser/seccomp/chromium.json");
      const config = {
        ...base,
        namespace,
        profilesDir: join(REPO, "profiles"),
        browser: {
          image: BROWSER_IMAGE,
          imageId: browserImage!.id,
          egressImage: EGRESS_IMAGE,
          egressImageId: egressImage!.id,
          seccompPath,
          seccompJson: JSON.stringify(JSON.parse(readFileSync(seccompPath, "utf8"))),
          memoryBytes: Number(process.env.AIRLOCK_IT_BROWSER_MEMORY_BYTES ?? 1024 ** 3),
          pidsLimit: 256,
          shmBytes: 256 * 1024 ** 2,
          tmpBytes: 512 * 1024 ** 2,
          cpus: 1,
          egressMemoryBytes: 128 * 1024 ** 2,
          egressPidsLimit: 64,
          egressCpus: 0.5,
          attemptTimeoutMs: 10 * 60_000, mutationOrigins: [] as string[],
        },
      };
      const host = await checkHost(api, config);
      const journal = new Journal(config.journalPath);
      const core = new Supervisor({ api, journal, config, profiles: new Map(), host, log: (line) => (process.env.AIRLOCK_IT_VERBOSE ? console.info(`[browser-integration] ${line}`) : undefined) });
      await core.start();
      const ref: AttemptRef = { taskId: "bit", attemptId: `b${Date.now().toString(36)}`, generation: 1 };
      let destroyed = false;
      let n = 0;
      const run = async (request: BrowserOp): Promise<BrowserOpResult> => {
        const body = { ref, request };
        const response = await core.browserOp(ref, await operationFor(`op${++n}-${ref.attemptId}`, body), request);
        const result = response.body as BrowserOpResult;
        console.info(`[browser-integration] ${request.op} → ${result.status} ${JSON.stringify(result.response).slice(0, 220)} (${result.durationMs} ms)`);
        return result;
      };
      try {
        const createBody = { ref, profileId: "browser", role: "browser" as const, absoluteDeadline: future(8 * 60_000), egressAllow: ["example.com", ".iana.org"] };
        const created = await core.createAttempt({ ...createBody, operation: await operationFor(`create-${ref.attemptId}`, createBody) });
        const state = created.body as AttemptState;
        expect(state.status).toBe("running");
        expect(state.inspection?.allPassed).toBe(true);
        expect(state.inspection?.runtime).toBe("runc");
        expect(state.inspection?.devUnsafe).toBe(true);
        expect(state.inspection?.guestUname).toMatch(/Linux/);
        expect(state.probe?.allBlocked).toBe(true);
        const evidence = core.browserEvidence(ref.attemptId)!;
        console.info(`[browser-integration] ${evidence.status.browserVersion} sandbox=${JSON.stringify(evidence.status.sandbox)} probe=${JSON.stringify(state.probe)}`);
        expect(evidence.status.sandbox.anyNoSandboxFlag).toBe(false);
        expect(evidence.status.sandbox.zygotePresent).toBe(true);
        expect(evidence.status.sandbox.renderersInNestedPidNamespace).toBe(true);
        expect(evidence.egressInspection.allPassed).toBe(true);

        // Docker's own view of what the supervisor created.
        const browserName = `${namespace}-browser-bit-${ref.attemptId}`;
        const b = await raw.getContainer(browserName).inspect();
        expect(Object.keys(b.NetworkSettings.Networks)).toEqual([`${namespace}-bnet-bit-${ref.attemptId}`]);
        expect(b.HostConfig.SecurityOpt?.some((o: string) => o.startsWith("seccomp="))).toBe(true);
        expect(b.HostConfig.ReadonlyRootfs).toBe(true);
        expect(b.Config.User).toBe("1001:1001");
        const internal = await raw.getNetwork(`${namespace}-bnet-bit-${ref.attemptId}`).inspect();
        expect(internal.Internal).toBe(true);

        const status = await run({ op: "status" });
        expect(status.status).toBe("completed");
        expect(status.response?.ok).toBe(true);

        const nav = await run({ op: "navigate", args: { url: "https://example.com/" } });
        expect(nav.status).toBe("completed");
        expect(nav.response).toMatchObject({ ok: true, result: { status: 200 } });

        const obs1 = await run({ op: "observe" });
        const o1 = (obs1.response as { result: BrowserObserveResult }).result;
        const link = o1.controls.find((c) => c.role === "link");
        expect(link).toBeDefined();

        const click = await run({ op: "click", args: { ref: link!.ref, generation: o1.generation } });
        expect(click.status).toBe("completed");
        expect(click.response?.ok).toBe(true);

        const obs2 = await run({ op: "observe" });
        const o2 = (obs2.response as { result: BrowserObserveResult }).result;
        expect(o2.generation).toBeGreaterThan(o1.generation);
        // The link's destination is decided by the proxy under the controller's allowlist
        // ["example.com", ".iana.org"]: a subdomain (www.iana.org) loads; the apex iana.org is not
        // covered by ".iana.org" and must be refused (host_not_allowed) — either way, by policy.
        const afterClick = (await core.egressEvidence(ref.attemptId))!.decisions.filter((d) => d.host?.endsWith("iana.org"));
        console.info(`[browser-integration] link "${link!.name}" → ${o2.url}; iana decisions: ${afterClick.map((d) => `${d.decision}:${d.host}:${d.reason}`).join(" ")}`);
        expect(afterClick.length).toBeGreaterThan(0);
        for (const d of afterClick) {
          if (d.host === "iana.org") expect(d).toMatchObject({ decision: "deny", reason: "host_not_allowed" });
          else expect(d.decision).toBe("allow");
        }
        if (afterClick.some((d) => d.decision === "allow")) expect(o2.url).toContain("iana.org");

        const stale = await run({ op: "click", args: { ref: link!.ref, generation: o1.generation } });
        expect(stale.status).toBe("completed");
        expect(stale.response).toMatchObject({ ok: false, error: "stale_reference" });

        const shot = await run({ op: "screenshot" });
        expect(shot.status).toBe("completed");
        const s = (shot.response as { result: BrowserScreenshotResult }).result;
        const png = Buffer.from(s.png, "base64");
        expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
        expect(createHash("sha256").update(png).digest("hex")).toBe(s.sha256);
        expect(`${s.width}x${s.height}`).toBe("1280x800");

        const denied = await run({ op: "navigate", args: { url: "https://www.wikipedia.org/" } });
        expect(denied.status).toBe("completed");
        expect(denied.response).toMatchObject({ ok: false, error: "navigation_failed" });

        const metadata = await run({ op: "navigate", args: { url: "http://169.254.169.254/" } });
        expect(metadata.status).toBe("completed");
        expect(metadata.response).toMatchObject({ ok: true, result: { status: 403, egressDenied: true } });

        const egress = (await core.egressEvidence(ref.attemptId))!;
        console.info(`[browser-integration] egress summary=${JSON.stringify(egress.summary)} decisions=${egress.decisions.map((d) => `${d.decision}:${d.host}:${d.reason}`).join(" ")}`);
        expect(egress.decisions.some((d) => d.decision === "allow" && d.host === "example.com")).toBe(true);
        expect(egress.decisions.some((d) => d.decision === "deny" && d.host === "www.wikipedia.org" && d.reason === "host_not_allowed")).toBe(true);
        expect(egress.decisions.some((d) => d.decision === "deny" && d.host === "169.254.169.254")).toBe(true);

        const destroy = await core.destroy(ref, await operationFor(`destroy-${ref.attemptId}`, { ref }));
        destroyed = true;
        const teardown = (destroy.body as DestroyResult).teardown as DestroyResult["teardown"] & { networksRemaining: string[] };
        expect(teardown.clean).toBe(true);
        expect(teardown.containersRemaining).toEqual([]);
        expect(teardown.networksRemaining).toEqual([]);
        const left = [
          ...(await raw.listContainers({ all: true, filters: { label: [`airlock.namespace=${namespace}`] } })).map((c) => c.Names[0]),
          ...(await raw.listNetworks({ filters: { label: [`airlock.namespace=${namespace}`] } })).map((x) => x.Name),
        ];
        console.info(`[browser-integration] after destroy: ${left.length === 0 ? "(no sandboxes)" : left.join(", ")}`);
        expect(left).toEqual([]);
        expect(core.capacity.used().sandboxes).toBe(0);
      } finally {
        if (!destroyed) await core.destroy(ref, await operationFor(`cleanup-${ref.attemptId}`, { ref })).catch(() => {});
        core.stop();
        journal.close();
      }
    },
    300_000,
  );
  test.skipIf(!available)(
    "a lost runner (browser container killed) is an interrupted attempt: dispatch closed, both containers stopped, nothing left after destroy",
    async () => {
      const dir = tempDir();
      const namespace = `airlockbik${Date.now().toString(36)}`;
      const seccompPath = join(REPO, "runtime/browser/seccomp/chromium.json");
      const config = {
        ...testConfig(dir),
        namespace,
        browser: {
          image: BROWSER_IMAGE, imageId: browserImage!.id, egressImage: EGRESS_IMAGE, egressImageId: egressImage!.id, seccompPath,
          seccompJson: JSON.stringify(JSON.parse(readFileSync(seccompPath, "utf8"))),
          memoryBytes: Number(process.env.AIRLOCK_IT_BROWSER_MEMORY_BYTES ?? 1024 ** 3), pidsLimit: 256, shmBytes: 256 * 1024 ** 2, tmpBytes: 512 * 1024 ** 2, cpus: 1,
          egressMemoryBytes: 128 * 1024 ** 2, egressPidsLimit: 64, egressCpus: 0.5, attemptTimeoutMs: 10 * 60_000, mutationOrigins: [] as string[],
        },
      };
      const journal = new Journal(config.journalPath);
      const core = new Supervisor({ api, journal, config, profiles: new Map(), host: await checkHost(api, config), log: () => {} });
      await core.start();
      const ref: AttemptRef = { taskId: "bik", attemptId: `k${Date.now().toString(36)}`, generation: 1 };
      try {
        const createBody = { ref, profileId: "browser", role: "browser" as const, absoluteDeadline: future(5 * 60_000), egressAllow: [] as string[] };
        await core.createAttempt({ ...createBody, operation: await operationFor(`create-${ref.attemptId}`, createBody) });
        await raw.getContainer(`${namespace}-browser-bik-${ref.attemptId}`).kill();
        const request: BrowserOp = { op: "observe" };
        const result = (await core.browserOp(ref, await operationFor(`obs-${ref.attemptId}`, { ref, request }), request)).body as BrowserOpResult;
        console.info(`[browser-integration] after kill: ${result.status} ${JSON.stringify(result.response)}`);
        expect(result.status).toBe("interrupted");
        expect(journal.getAttempt(ref.attemptId)?.revoked).toBe(true);
        const egressState = await raw.getContainer(`${namespace}-egress-bik-${ref.attemptId}`).inspect();
        expect(egressState.State.Running).toBe(false);
        const destroy = await core.destroy(ref, await operationFor(`destroy-${ref.attemptId}`, { ref }));
        expect((destroy.body as DestroyResult).teardown.clean).toBe(true);
        const left = [
          ...(await raw.listContainers({ all: true, filters: { label: [`airlock.namespace=${namespace}`] } })).map((c) => c.Names[0]),
          ...(await raw.listNetworks({ filters: { label: [`airlock.namespace=${namespace}`] } })).map((x) => x.Name),
        ];
        expect(left).toEqual([]);
      } finally {
        await core.destroy(ref, await operationFor(`cleanup-${ref.attemptId}`, { ref })).catch(() => {});
        core.stop();
        journal.close();
      }
    },
    300_000,
  );
});
