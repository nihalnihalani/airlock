/**
 * Real-Docker mutation guard (research/40 Stage 5: generic arbitrary-site irreversible submissions
 * are unsupported). On an allowlisted public HTTPS page with a POST form (https://httpbin.org/forms/post):
 *   - with AIRLOCK_BROWSER_MUTATION_ORIGINS empty, clicking submit and `type submit:true` never
 *     reach the POST target (no navigation to /post; observe delivers `mutation_blocked`), while GET
 *     navigation on the same site works;
 *   - with the site's origin configured, the same click submits and the POST result loads.
 * runc, dev-unsafe: evidence of the mechanics only. Skips, with the reason printed, when Docker,
 * the images, or outbound access to httpbin.org:443 is missing.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import Docker from "dockerode";
import type { AttemptRef, AttemptState, BrowserObserveResult, BrowserOp, BrowserOpResult } from "@airlock/contracts";
import { resolveDockerSocket } from "../src/config";
import { checkHost } from "../src/host";
import { Supervisor } from "../src/lifecycle";
import { Journal } from "../src/operations";
import { createDockerode } from "../src/runtime";
import { future, operationFor, tempDir, testConfig } from "./helpers";

const REPO = resolve(import.meta.dir, "../../..");
const BROWSER_IMAGE = "airlock-browser:dev";
const EGRESS_IMAGE = "airlock-egress:dev";
const SITE = "httpbin.org";
const ORIGIN = `https://${SITE}`;

const socket = resolveDockerSocket(process.env);
const api = createDockerode(socket);
const raw = new Docker(socket ? { socketPath: socket } : undefined);
const dockerUp = await api.ping();
const browserImage = dockerUp ? await api.inspectImage(BROWSER_IMAGE) : null;
const egressImage = dockerUp ? await api.inspectImage(EGRESS_IMAGE) : null;

async function reachable(host: string): Promise<{ ok: boolean; detail: string }> {
  if (!egressImage) return { ok: false, detail: "no egress image" };
  const name = `airlock-it-netcheck-m${Date.now().toString(36)}`;
  try {
    const container = await raw.createContainer({
      name,
      Image: EGRESS_IMAGE,
      Entrypoint: ["bun", "-e", `const s=require('net').connect(443,'${host}');s.setTimeout(8000,()=>{console.log('TIMEOUT');process.exit(1)});s.on('connect',()=>{console.log('CONNECTED');process.exit(0)});s.on('error',e=>{console.log('ERROR '+e.code);process.exit(1)})`],
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

const internet = dockerUp && browserImage && egressImage ? await reachable(SITE) : { ok: false, detail: "n/a" };
const available = dockerUp && browserImage !== null && egressImage !== null && internet.ok;
if (!available) {
  console.info(`[browser-mutation] SKIPPED: docker=${dockerUp} browserImage=${browserImage !== null} egressImage=${egressImage !== null} ${SITE}=${internet.ok} (${internet.detail})`);
}

type Event = { type: string; method?: string; url?: string; count?: number };

/** One supervisor + one browser attempt allowlisting SITE, with the given mutation origins. */
async function withAttempt(tag: string, mutationOrigins: string[], body: (run: (request: BrowserOp) => Promise<BrowserOpResult>, core: Supervisor, ref: AttemptRef) => Promise<void>) {
  const dir = tempDir();
  const namespace = `airlockbm${tag}${Date.now().toString(36)}`;
  const seccompPath = join(REPO, "runtime/browser/seccomp/chromium.json");
  const config = {
    ...testConfig(dir),
    namespace,
    browser: {
      image: BROWSER_IMAGE, imageId: browserImage!.id, egressImage: EGRESS_IMAGE, egressImageId: egressImage!.id, seccompPath,
      seccompJson: JSON.stringify(JSON.parse(readFileSync(seccompPath, "utf8"))),
      memoryBytes: Number(process.env.AIRLOCK_IT_BROWSER_MEMORY_BYTES ?? 1024 ** 3), pidsLimit: 256, shmBytes: 256 * 1024 ** 2, tmpBytes: 512 * 1024 ** 2, cpus: 1,
      egressMemoryBytes: 128 * 1024 ** 2, egressPidsLimit: 64, egressCpus: 0.5, attemptTimeoutMs: 10 * 60_000,
      mutationOrigins,
    },
  };
  const journal = new Journal(config.journalPath);
  const core = new Supervisor({ api, journal, config, profiles: new Map(), host: await checkHost(api, config), log: () => {} });
  await core.start();
  const ref: AttemptRef = { taskId: `bm${tag}`, attemptId: `m${tag}${Date.now().toString(36)}`, generation: 1 };
  let n = 0;
  const run = async (request: BrowserOp): Promise<BrowserOpResult> => {
    const result = (await core.browserOp(ref, await operationFor(`op${++n}-${ref.attemptId}`, { ref, request }), request)).body as BrowserOpResult;
    console.info(`[browser-mutation:${tag}] ${request.op} → ${result.status} ${JSON.stringify(result.response).slice(0, 240)}`);
    return result;
  };
  try {
    const createBody = { ref, profileId: "browser", role: "browser" as const, absoluteDeadline: future(8 * 60_000), egressAllow: [SITE] };
    const created = await core.createAttempt({ ...createBody, operation: await operationFor(`create-${ref.attemptId}`, createBody) });
    expect((created.body as AttemptState).status).toBe("running");
    const b = await raw.getContainer(`${namespace}-browser-bm${tag}-${ref.attemptId}`).inspect();
    expect(b.Config.Env).toContain(`AIRLOCK_BROWSER_MUTATION_ORIGINS=${JSON.stringify(mutationOrigins)}`);
    const status = core.browserEvidence(ref.attemptId)!.status as unknown as { mutationGuard: { installed: boolean; origins: string[]; websockets: string } };
    expect(status.mutationGuard).toMatchObject({ installed: true, origins: mutationOrigins, websockets: "blocked" });
    await body(run, core, ref);
  } finally {
    const destroy = await core.destroy(ref, await operationFor(`destroy-${ref.attemptId}`, { ref })).catch(() => null);
    core.stop();
    journal.close();
    expect((destroy?.body as { teardown?: { clean?: boolean } } | undefined)?.teardown?.clean).toBe(true);
  }
}

const observe = async (run: (r: BrowserOp) => Promise<BrowserOpResult>) => ((await run({ op: "observe" })).response as { result: BrowserObserveResult }).result;

describe("mutation guard on an allowlisted public site (runc, dev-unsafe)", () => {
  test.skipIf(!available)(
    "no mutation origins: submit click and type submit:true are refused (mutation_blocked, no POST result); GET navigation works",
    async () => {
      await withAttempt("b", [], async (run) => {
        expect((await run({ op: "navigate", args: { url: `${ORIGIN}/forms/post` } })).response).toMatchObject({ ok: true, result: { status: 200 } });
        let o = await observe(run);
        const name = o.controls.find((c) => c.role === "textbox" && /customer name/i.test(c.name))!;
        expect(name).toBeDefined();
        expect((await run({ op: "type", args: { ref: name.ref, generation: o.generation, text: "Ada Lovelace" } })).response?.ok).toBe(true);
        o = await observe(run);
        const submit = o.controls.find((c) => c.role === "button" && /submit order/i.test(c.name))!;
        expect(submit).toBeDefined();
        expect((await run({ op: "click", args: { ref: submit.ref, generation: o.generation } })).response?.ok).toBe(true);
        o = await observe(run);
        console.info(`[browser-mutation:b] after click url=${o.url} events=${JSON.stringify(o.events)}`);
        expect(o.url).not.toBe(`${ORIGIN}/post`);
        expect(o.text).not.toContain("Ada Lovelace");
        const blocked = (o.events as Event[]).filter((e) => e.type === "mutation_blocked");
        expect(blocked).toContainEqual(expect.objectContaining({ type: "mutation_blocked", method: "POST", url: `${ORIGIN}/post` }));

        // Enter in a field (type submit:true) is the same submission and is refused the same way.
        expect((await run({ op: "navigate", args: { url: `${ORIGIN}/forms/post` } })).response?.ok).toBe(true);
        o = await observe(run);
        const again = o.controls.find((c) => c.role === "textbox" && /customer name/i.test(c.name))!;
        expect((await run({ op: "type", args: { ref: again.ref, generation: o.generation, text: "Grace Hopper", submit: true } })).response?.ok).toBe(true);
        o = await observe(run);
        expect(o.url).not.toBe(`${ORIGIN}/post`);
        expect(o.text).not.toContain("Grace Hopper");
        expect((o.events as Event[]).some((e) => e.type === "mutation_blocked" && e.method === "POST" && e.url === `${ORIGIN}/post`)).toBe(true);

        // Reading is unaffected: GET navigation on the same allowlisted site.
        const get = await run({ op: "navigate", args: { url: `${ORIGIN}/get?probe=1` } });
        expect(get.response).toMatchObject({ ok: true, result: { status: 200 } });
        o = await observe(run);
        expect(o.text).toContain("probe");
        expect(o.events.filter((e) => e.type === "mutation_blocked")).toEqual([]);
      });
    },
    300_000,
  );

  test.skipIf(!available)(
    "the site's origin configured in AIRLOCK_BROWSER_MUTATION_ORIGINS: the same submit reaches the POST target",
    async () => {
      await withAttempt("a", [ORIGIN], async (run) => {
        expect((await run({ op: "navigate", args: { url: `${ORIGIN}/forms/post` } })).response).toMatchObject({ ok: true, result: { status: 200 } });
        let o = await observe(run);
        const name = o.controls.find((c) => c.role === "textbox" && /customer name/i.test(c.name))!;
        expect((await run({ op: "type", args: { ref: name.ref, generation: o.generation, text: "Ada Lovelace" } })).response?.ok).toBe(true);
        o = await observe(run);
        const submit = o.controls.find((c) => c.role === "button" && /submit order/i.test(c.name))!;
        expect((await run({ op: "click", args: { ref: submit.ref, generation: o.generation } })).response?.ok).toBe(true);
        o = await observe(run);
        console.info(`[browser-mutation:a] after click url=${o.url} text=${o.text.slice(0, 160)}`);
        expect(o.url).toBe(`${ORIGIN}/post`);
        expect(o.text).toContain("Ada Lovelace");
        expect(o.events.filter((e) => e.type === "mutation_blocked")).toEqual([]);
      });
    },
    300_000,
  );
});
