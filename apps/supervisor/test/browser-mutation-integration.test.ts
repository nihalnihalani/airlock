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
    const status = core.browserEvidence(ref.attemptId)!.status as unknown as { mutationGuard: { installed: boolean; origins: string[]; websockets: string; workers: string } };
    expect(status.mutationGuard).toMatchObject({ installed: true, origins: mutationOrigins, websockets: "blocked", workers: "blocked" });
    expect((status as unknown as { disabledFeatures: { failures: string[] } }).disabledFeatures.failures).toEqual([]);
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

// ---------------------------------------------------------------------------------------------
// In-image harness (evidence category: the built airlock-browser image's Chromium, the runner's own
// launch flags (launch.mjs, proxy flags omitted) and its guard module (mutation.mjs), against an HTTPS
// server on the container's loopback, network "none"). Needed because these cases require page
// script and response headers no public allowlisted page provides, and the egress proxy refuses
// private addresses. Three contexts run side by side, each under its own path prefix:
//   guard      runner flags + installMutationGuard (as the runner does)
//   routeonly  runner flags + the request/WebSocket routes WITHOUT the worker block (shows the gap)
//   control    Playwright defaults, no guard (shows the server would see these requests)
// ---------------------------------------------------------------------------------------------

const HARNESS = String.raw`
import https from "node:https";
import { execFileSync } from "node:child_process";
import { createHash, createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { chromium } from "playwright-core";
import { chromiumLaunchArgs } from "/opt/airlock/launch.mjs";
import { installMutationGuard } from "/opt/airlock/mutation.mjs";

execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "/tmp/k.pem", "-out", "/tmp/c.pem", "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1"], { stdio: "ignore" });
const cert = readFileSync("/tmp/c.pem");
const spki = createHash("sha256").update(createPublicKey(cert).export({ type: "spki", format: "der" })).digest("base64");
const O = "https://127.0.0.1:18443";
const seen = { guard: [], routeonly: [], control: [] };
const prefixOf = (url) => url.split("/")[1];
const page = (p) => '<!doctype html><title>h</title><script>' +
  'window.run = async () => { const out = {}; const wait = (ms) => new Promise((r) => setTimeout(r, ms));' +
  'const worker = (make) => new Promise((resolve) => { let w; try { w = make(); } catch (e) { return resolve("throws " + e.name); } const got = []; (w.port ?? w).onmessage = (e) => { got.push(e.data); if (got.length === 2) resolve(got.sort().join(" | ")); }; w.port?.start(); setTimeout(() => resolve("timeout " + got.join(" | ")), 5000); });' +
  'out.dedicatedWorker = await worker(() => new Worker("worker.js"));' +
  'out.blobWorker = await worker(() => new Worker(URL.createObjectURL(new Blob([' + JSON.stringify("importScripts('" + O + "/" + p + "/worker.js')") + '], { type: "text/javascript" }))));' +
  'out.sharedWorker = await worker(() => new SharedWorker("shared.js"));' +
  'const f = document.createElement("iframe"); document.body.appendChild(f); out.iframeRealmWorker = await worker(() => new f.contentWindow.Worker("worker.js"));' +
  'out.optionsWithBody = await fetch("options-body", { method: "OPTIONS", body: "secret" }).then((r) => "status " + r.status, () => "failed");' +
  'out.optionsNoBody = await fetch("options-nobody", { method: "OPTIONS" }).then((r) => "status " + r.status, () => "failed");' +
  'const legacy = document.createElement("iframe"); legacy.src = "legacy"; document.body.appendChild(legacy);' +
  'await fetch("missing-404").catch(() => {}); await wait(1000); return out; };</script><img src="x.png">';
const workerJs = (p) => 'const ws = new WebSocket("wss://127.0.0.1:18443/' + p + '/worker-ws"); ws.onopen = () => post("ws open"); ws.onerror = () => post("ws error"); ws.onclose = (e) => post("ws close " + e.code);' +
  'fetch("' + O + '/' + p + '/worker-post", { method: "POST", body: "from-worker" }).then((r) => post("post " + r.status), () => post("post failed"));' +
  'let sent = new Set(); function post(m) { const k = m.split(" ")[0]; if (sent.has(k)) return; sent.add(k); if (self.postMessage && !self.onconnect) self.postMessage(m); else ports.forEach((p) => p.postMessage(m)); }';
const sharedJs = (p) => 'const ports = []; onconnect = (e) => { ports.push(e.ports[0]); importScripts("' + O + '/' + p + '/worker.js"); };';
const server = https.createServer({ key: readFileSync("/tmp/k.pem"), cert }, (req, res) => {
  let body = ""; req.on("data", (d) => (body += d)); req.on("end", () => {
    const p = prefixOf(req.url); const rest = req.url.slice(p.length + 2);
    (seen[p] ?? []).push(req.method + " /" + rest + (body ? " body=" + body.slice(0, 30) : ""));
    if (rest === "") {
      res.setHeader("content-type", "text/html");
      res.setHeader("Reporting-Endpoints", 'default="' + O + '/' + p + '/reports-endpoints"');
      res.setHeader("Report-To", JSON.stringify({ group: "g", max_age: 3600, endpoints: [{ url: O + "/" + p + "/report-to" }] }));
      res.setHeader("NEL", JSON.stringify({ report_to: "g", max_age: 3600, success_fraction: 1.0, failure_fraction: 1.0 }));
      res.setHeader("Content-Security-Policy", "img-src 'none'; report-to default");
      return res.end(page(p));
    }
    if (rest === "legacy") { res.setHeader("content-type", "text/html"); res.setHeader("Content-Security-Policy", "img-src 'none'; report-uri /" + p + "/csp-report-uri"); return res.end('<img src="y.png">'); }
    if (rest === "worker.js") { res.setHeader("content-type", "text/javascript"); return res.end(workerJs(p)); }
    if (rest === "shared.js") { res.setHeader("content-type", "text/javascript"); return res.end(sharedJs(p)); }
    res.statusCode = rest === "missing-404" ? 404 : 200; res.end("ok");
  });
});
server.on("upgrade", (req, socket) => { (seen[prefixOf(req.url)] ?? []).push("UPGRADE /" + req.url.slice(prefixOf(req.url).length + 2)); socket.destroy(); });
await new Promise((r) => server.listen(18443, "127.0.0.1", r));

async function run(p) {
  const trust = "--ignore-certificate-errors-spki-list=" + spki; // harness-only: trust the loopback test certificate
  const args = p === "control" ? [trust] : [...chromiumLaunchArgs(null), trust];
  const context = await chromium.launchPersistentContext("/tmp/profile-" + p, { headless: true, chromiumSandbox: false, serviceWorkers: "block", args });
  const blocked = [];
  if (p !== "control") await installMutationGuard(context, new Set(), (e) => blocked.push(e.method + " " + e.url.replace(O, "")), { blockWorkers: p === "guard" });
  const tab = context.pages()[0] ?? (await context.newPage());
  await tab.goto(O + "/" + p + "/");
  const outcomes = await tab.evaluate(() => window.run());
  await tab.waitForTimeout(Number(process.env.REPORT_WAIT_MS ?? 70000)); // Reporting API batches deliveries (~1 min)
  await context.close();
  return { outcomes, blocked };
}
const results = Object.fromEntries(await Promise.all(["guard", "routeonly", "control"].map(async (p) => [p, await run(p)])));
for (const p of Object.keys(results)) results[p].serverSaw = seen[p];
server.close();
console.log("HARNESS " + JSON.stringify(results));
`;

type HarnessRun = { outcomes: Record<string, string>; blocked: string[]; serverSaw: string[] };

async function runHarness(): Promise<Record<"guard" | "routeonly" | "control", HarnessRun>> {
  const name = `airlock-it-mutharness-${Date.now().toString(36)}`;
  try {
    const container = await raw.createContainer({
      name,
      Image: BROWSER_IMAGE,
      User: "1001:1001",
      WorkingDir: "/opt/airlock",
      Entrypoint: ["node", "--input-type=module", "-e", HARNESS],
      HostConfig: { NetworkMode: "none", ShmSize: 256 * 1024 ** 2, Memory: 2 * 1024 ** 3, AutoRemove: false },
    });
    await container.start();
    const result = (await container.wait()) as { StatusCode: number };
    const logs = String(await container.logs({ stdout: true, stderr: true })).replace(/[\x00-\x08]/g, "");
    const line = logs.split("\n").find((l) => l.includes("HARNESS {"));
    if (result.StatusCode !== 0 || !line) throw new Error(`harness exited ${result.StatusCode}: ${logs.slice(-1500)}`);
    return JSON.parse(line.slice(line.indexOf("HARNESS ") + 8));
  } finally {
    await raw.getContainer(name).remove({ force: true }).catch(() => {});
  }
}

const harnessAvailable = dockerUp && browserImage !== null;

describe("mutation guard, in-image harness (built image's Chromium + runner flags + guard module; loopback HTTPS server, network none)", () => {
  test.skipIf(!harnessAvailable)(
    "worker POST, worker/shared-worker WebSocket, Reporting API / NEL / CSP reports, OPTIONS with a body: nothing reaches the server under the guard",
    async () => {
      const r = await runHarness();
      for (const p of ["guard", "routeonly", "control"] as const) console.info(`[browser-mutation:harness:${p}] ${JSON.stringify(r[p])}`);
      const leaks = (saw: string[]) => saw.filter((l) => !/^(GET|OPTIONS) \/\S*$/.test(l) || /report|worker-post|UPGRADE/.test(l));

      // Under the runner's guard: only body-less GET/OPTIONS reach the server.
      expect(leaks(r.guard.serverSaw)).toEqual([]);
      expect(r.guard.serverSaw).not.toContainEqual(expect.stringContaining("worker.js"));
      for (const k of ["dedicatedWorker", "blobWorker", "sharedWorker", "iframeRealmWorker"]) expect(r.guard.outcomes[k]).toBe("throws SecurityError");
      expect(r.guard.outcomes.optionsWithBody).toBe("failed");
      expect(r.guard.outcomes.optionsNoBody).toBe("status 200");
      expect(r.guard.blocked).toContain("OPTIONS+BODY /guard/options-body");
      expect(r.guard.blocked).toContain("POST /guard/csp-report-uri");

      // Routes alone (why workers are removed): a dedicated worker's POST is caught by the route, but
      // every worker's WebSocket reaches the server, and so does a SHARED worker's POST.
      expect(r.routeonly.outcomes.dedicatedWorker).toContain("post failed");
      expect(r.routeonly.blocked.filter((l) => l === "POST /routeonly/worker-post").length).toBeGreaterThanOrEqual(2);
      expect(r.routeonly.serverSaw).toContain("UPGRADE /worker-ws");
      expect(r.routeonly.outcomes.sharedWorker).toContain("post 200");
      expect(r.routeonly.serverSaw).toContainEqual(expect.stringMatching(/^POST \/worker-post/));
      expect(leaks(r.routeonly.serverSaw).filter((l) => !/^UPGRADE|^POST \/worker-post/.test(l))).toEqual([]);

      // Control (no guard): the harness does observe these requests when nothing stops them.
      expect(r.control.serverSaw).toContain("UPGRADE /worker-ws");
      expect(r.control.serverSaw).toContainEqual(expect.stringMatching(/^POST \/worker-post body=from-worker/));
      expect(r.control.serverSaw).toContainEqual(expect.stringMatching(/^OPTIONS \/options-body body=secret/));
      expect(r.control.serverSaw).toContainEqual(expect.stringMatching(/^POST \/csp-report-uri/));
      const reportingApi = r.control.serverSaw.filter((l) => /reports-endpoints|report-to/.test(l));
      console.info(`[browser-mutation:harness] Reporting API / NEL deliveries without any guard: ${reportingApi.length ? reportingApi.join(", ") : "none within the wait"}`);
    },
    300_000,
  );
});
