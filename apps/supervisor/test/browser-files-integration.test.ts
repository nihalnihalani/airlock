/**
 * Real-Docker browser downloads and uploads (runc, dev-unsafe: mechanics only).
 *
 * 1. Downloads through the supervisor. Needs outbound internet and these PUBLIC hosts on the
 *    attempt's allowlist (the egress proxy refuses non-public addresses by design):
 *      people.sc.fsu.edu     a 328-byte text/csv file (Chromium downloads text/csv)
 *      speed.cloudflare.com  a 20 MB application/octet-stream body (in-progress size abort)
 * 2. Upload, hermetic: an in-image harness (the built image's Chromium, the runner's launch flags,
 *    upload resolution (uploads.mjs) and mutation guard (mutation.mjs); an HTTPS server on the
 *    container's loopback, network "none") sets a placed file on a file input, submits the multipart
 *    form to an origin configured as a mutation origin, and the server's sha256 of the received file
 *    must equal the artifact sha256; the same form posted to a non-configured origin is refused.
 * 3. Upload through the supervisor to a public test form (optional): pre-checks
 *    https://the-internet.herokuapp.com/upload and skips, with the reason printed, unless it answers 200.
 * Each test skips, with the reason printed, when Docker, the images or outbound internet are unavailable.
 * Build the browser image with the current runner first:  docker build -t airlock-browser:dev runtime/browser
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import Docker from "dockerode";
import type { AttemptRef, AttemptState, BrowserObserveResult, BrowserOpResult } from "@airlock/contracts";
import type { SupervisorBrowserOp } from "../src/browser-files";
import { resolveDockerSocket } from "../src/config";
import { checkHost } from "../src/host";
import { Supervisor } from "../src/lifecycle";
import { Journal } from "../src/operations";
import { createDockerode } from "../src/runtime";
import type { DestroyResult } from "../src/types";
import { future, operationFor, tempDir, testConfig } from "./helpers";

const REPO = resolve(import.meta.dir, "../../..");
const socket = resolveDockerSocket(process.env);
const api = createDockerode(socket);
const raw = new Docker(socket ? { socketPath: socket } : undefined);
const dockerUp = await api.ping();
const browserImage = dockerUp ? await api.inspectImage("airlock-browser:dev") : null;
const egressImage = dockerUp ? await api.inspectImage("airlock-egress:dev") : null;

async function reachable(): Promise<{ ok: boolean; detail: string }> {
  if (!egressImage) return { ok: false, detail: "no egress image" };
  const name = `airlock-it-netcheck-f${Date.now().toString(36)}`;
  try {
    const c = await raw.createContainer({ name, Image: "airlock-egress:dev", Entrypoint: ["bun", "-e", "const s=require('net').connect(443,'people.sc.fsu.edu');s.setTimeout(8000,()=>process.exit(1));s.on('connect',()=>process.exit(0));s.on('error',()=>process.exit(1))"] });
    await c.start();
    const r = (await c.wait()) as { StatusCode: number };
    return { ok: r.StatusCode === 0, detail: `exit ${r.StatusCode}` };
  } catch (error) {
    return { ok: false, detail: String(error).slice(0, 200) };
  } finally {
    await raw.getContainer(name).remove({ force: true }).catch(() => {});
  }
}
const internet = dockerUp && browserImage && egressImage ? await reachable() : { ok: false, detail: "n/a" };
const available = dockerUp && browserImage !== null && egressImage !== null && internet.ok;
if (!available) console.info(`[browser-files-integration] SKIPPED: docker=${dockerUp} browserImage=${browserImage !== null} egressImage=${egressImage !== null} outboundInternet=${internet.ok} (${internet.detail})`);

const seccompPath = join(REPO, "runtime/browser/seccomp/chromium.json");

/** One supervisor with the browser plane, one browser attempt, destroyed (and checked clean) afterwards. */
async function withAttempt(
  tag: string,
  egressAllow: string[],
  mutationOrigins: string[],
  body: (run: (request: SupervisorBrowserOp) => Promise<BrowserOpResult>) => Promise<void>,
): Promise<void> {
  const dir = tempDir();
  const namespace = `airlockbf${tag}${Date.now().toString(36)}`;
  const config = {
    ...testConfig(dir),
    namespace,
    profilesDir: join(REPO, "profiles"),
    browser: {
      image: "airlock-browser:dev", imageId: browserImage!.id, egressImage: "airlock-egress:dev", egressImageId: egressImage!.id, seccompPath,
      seccompJson: JSON.stringify(JSON.parse(readFileSync(seccompPath, "utf8"))),
      memoryBytes: Number(process.env.AIRLOCK_IT_BROWSER_MEMORY_BYTES ?? 1024 ** 3), pidsLimit: 256, shmBytes: 256 * 1024 ** 2, tmpBytes: 512 * 1024 ** 2, cpus: 1,
      egressMemoryBytes: 128 * 1024 ** 2, egressPidsLimit: 64, egressCpus: 0.5, attemptTimeoutMs: 10 * 60_000,
      mutationOrigins,
    },
  };
  const journal = new Journal(config.journalPath);
  const core = new Supervisor({ api, journal, config, profiles: new Map(), host: await checkHost(api, config), log: (l) => (process.env.AIRLOCK_IT_VERBOSE ? console.info(`[browser-files-integration] ${l}`) : undefined) });
  await core.start();
  const ref: AttemptRef = { taskId: `bf${tag}`, attemptId: `f${tag}${Date.now().toString(36)}`, generation: 1 };
  let n = 0;
  const run = async (request: SupervisorBrowserOp): Promise<BrowserOpResult> => {
    const result = (await core.browserOp(ref, await operationFor(`op${++n}-${ref.attemptId}`, { ref, request }), request)).body as BrowserOpResult;
    console.info(`[browser-files-integration] ${request.op} → ${result.status} ${JSON.stringify(result.response).slice(0, 240)} (${result.durationMs} ms)`);
    return result;
  };
  try {
    const createBody = { ref, profileId: "browser", role: "browser" as const, absoluteDeadline: future(8 * 60_000), egressAllow };
    const state = (await core.createAttempt({ ...createBody, operation: await operationFor(`create-${ref.attemptId}`, createBody) })).body as AttemptState;
    expect(state.status).toBe("running");
    expect(state.probe?.allBlocked).toBe(true);
    await body(run);
  } finally {
    const destroyed = (await core.destroy(ref, await operationFor(`destroy-${ref.attemptId}`, { ref }))).body as DestroyResult;
    const listing = await core.hostListing();
    const ours = listing.containers.filter((c) => c.name.startsWith(namespace));
    console.info(`[browser-files-integration] after destroy: ${destroyed.teardown.clean && ours.length === 0 ? "(no sandboxes)" : JSON.stringify(destroyed.teardown)}`);
    expect(destroyed.teardown.clean).toBe(true);
    core.stop();
    journal.close();
  }
}

describe("real docker browser downloads (runc, dev-unsafe)", () => {
  test.skipIf(!available)(
    "download a public CSV → list → read (sha256/size re-verified) → 20 MB download aborted in progress → destroy leaves nothing",
    async () => {
      await withAttempt("d", ["people.sc.fsu.edu", "speed.cloudflare.com"], [], async (run) => {
        type Listed = { downloads: { downloadId: string; state: string; reason?: string; bytes?: number }[] };
        const waitFor = async (predicate: (l: Listed) => boolean, ms: number): Promise<Listed> => {
          const end = Date.now() + ms;
          for (;;) {
            const listed = (await run({ op: "download.list" })).response as { result: Listed };
            if (predicate(listed.result) || Date.now() > end) return listed.result;
            await new Promise((r) => setTimeout(r, 1000));
          }
        };
        // 1. a small CSV: navigating to it starts a download (Chromium does not render text/csv)
        const nav = await run({ op: "navigate", args: { url: "https://people.sc.fsu.edu/~jburkardt/data/csv/addresses.csv" } });
        expect(nav.status).toBe("completed");
        const listed = await waitFor((l) => l.downloads.some((d) => d.state === "completed"), 20_000);
        const csv = listed.downloads.find((d) => d.state === "completed");
        expect(csv).toBeDefined();
        const read = await run({ op: "download.read", args: { downloadId: csv!.downloadId } });
        expect(read.status).toBe("completed");
        const r = (read.response as { result: { bytes: number; sha256: string; contentBase64: string; mediaType: string; suggestedFilename: string } }).result;
        const bytes = Buffer.from(r.contentBase64, "base64");
        expect(bytes.length).toBe(r.bytes);
        expect(createHash("sha256").update(bytes).digest("hex")).toBe(r.sha256);
        expect(r.mediaType).toBe("text/csv");
        console.info(`[browser-files-integration] downloaded ${r.suggestedFilename} ${r.bytes} B sha256:${r.sha256.slice(0, 16)} ${r.mediaType}: ${bytes.toString("utf8").split("\n")[0]}`);

        // 2. a 20 MB body: cancelled while in progress once the partial file passes 10 MiB
        await run({ op: "navigate", args: { url: "https://speed.cloudflare.com/__down?bytes=20000000" } });
        const big = await waitFor((l) => l.downloads.some((d) => d.state !== "in_progress" && d.downloadId !== csv!.downloadId), 60_000);
        const aborted = big.downloads.find((d) => d.downloadId !== csv!.downloadId);
        console.info(`[browser-files-integration] large download: ${JSON.stringify(aborted)}`);
        expect(aborted?.state).toBe("cancelled");
        expect(aborted?.reason).toBe("size_limit");
        const refused = await run({ op: "download.read", args: { downloadId: aborted!.downloadId } });
        expect(refused.response).toMatchObject({ ok: false, error: "action_failed" });
      });
    },
    300_000,
  );
});

// ---------------------------------------------------------------------------------------------
// Hermetic upload (in-image harness). The harness plays the supervisor's placement step (writes the
// artifact bytes to /tmp/uploads/<uploadId>/<filename>), then uses the runner's own resolution
// (placedUpload: regular file, no symlink, sha256 re-check) and the same setInputFiles call as the
// runner's `upload` op. The form's origin is configured as a mutation origin; a second origin
// (https://localhost:18443, same server) is not, so its submission must be refused by the guard.
// ---------------------------------------------------------------------------------------------

const UPLOAD_HARNESS = String.raw`
import https from "node:https";
import { execFileSync } from "node:child_process";
import { createHash, createPublicKey } from "node:crypto";
import fs from "node:fs";
import { chromium } from "playwright-core";
import { chromiumLaunchArgs } from "/opt/airlock/launch.mjs";
import { installMutationGuard, parseMutationOrigins } from "/opt/airlock/mutation.mjs";
import { placedUpload } from "/opt/airlock/uploads.mjs";

const { uploadId, filename, sha256, contentBase64 } = JSON.parse(process.env.UPLOAD);
fs.mkdirSync("/tmp/uploads/" + uploadId, { recursive: true, mode: 0o700 });
fs.writeFileSync("/tmp/uploads/" + uploadId + "/" + filename, Buffer.from(contentBase64, "base64"), { mode: 0o600 });

execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "/tmp/k.pem", "-out", "/tmp/c.pem", "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost"], { stdio: "ignore" });
const cert = fs.readFileSync("/tmp/c.pem");
const spki = createHash("sha256").update(createPublicKey(cert).export({ type: "spki", format: "der" })).digest("base64");

const received = [];
const seen = [];
const server = https.createServer({ key: fs.readFileSync("/tmp/k.pem"), cert }, (req, res) => {
  const chunks = [];
  req.on("data", (d) => chunks.push(d));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    seen.push(req.method + " " + req.headers.host + req.url);
    if (req.method === "POST" && req.url === "/upload") {
      // multipart/form-data: the part carrying filename="..." is the file.
      const boundary = "--" + /boundary=([^;]+)/.exec(req.headers["content-type"] ?? "")?.[1];
      const start = body.indexOf("filename=");
      const dataStart = body.indexOf("\r\n\r\n", start) + 4;
      const dataEnd = body.indexOf("\r\n" + boundary, dataStart);
      const file = body.subarray(dataStart, dataEnd);
      const name = /filename="([^"]*)"/.exec(body.subarray(start, dataStart).toString("latin1"))?.[1];
      received.push({ host: req.headers.host, name, bytes: file.length, sha256: createHash("sha256").update(file).digest("hex") });
      res.setHeader("content-type", "text/html");
      return res.end("<title>uploaded</title><p>Received " + name + "</p>");
    }
    res.setHeader("content-type", "text/html");
    res.end('<!doctype html><title>form</title><form method="post" action="/upload" enctype="multipart/form-data"><label>File <input type="file" name="file"></label><button>Upload</button></form>');
  });
});
await new Promise((r) => server.listen(18443, "127.0.0.1", r));

const allowed = "https://127.0.0.1:18443";
const context = await chromium.launchPersistentContext("/tmp/profile", {
  headless: true, chromiumSandbox: false, serviceWorkers: "block",
  args: [...chromiumLaunchArgs(null), "--ignore-certificate-errors-spki-list=" + spki], // harness-only: trust the loopback test certificate
});
const blocked = [];
await installMutationGuard(context, parseMutationOrigins(JSON.stringify([allowed])), (e) => blocked.push(e.method + " " + e.url));
const page = context.pages()[0] ?? (await context.newPage());
const results = {};
for (const [label, origin] of [["configured", allowed], ["notConfigured", "https://localhost:18443"]]) {
  await page.goto(origin + "/form");
  const { file } = placedUpload(uploadId, filename, sha256);
  await page.getByLabel("File").setInputFiles(file);
  await page.getByRole("button", { name: "Upload" }).click();
  await page.waitForTimeout(1500);
  results[label] = { url: page.url(), title: await page.title().catch(() => "") };
}
await context.close();
server.close();
console.log("HARNESS " + JSON.stringify({ results, received, blocked, seen }));
`;

describe("hermetic upload (in-image harness: built image's Chromium + runner flags, upload resolution and guard; loopback HTTPS, network none)", () => {
  test.skipIf(!(dockerUp && browserImage !== null))(
    "a placed file is submitted to a configured mutation origin and arrives byte-identical (sha256 = artifact sha256); a non-configured origin is refused",
    async () => {
      const content = Buffer.from(`airlock synthetic upload test fixture ${Date.now()}\n`);
      const artifactSha256 = createHash("sha256").update(content).digest("hex");
      const upload = { uploadId: "up-00000000000000aa", filename: "airlock-test.txt", sha256: artifactSha256, contentBase64: content.toString("base64") };
      const name = `airlock-it-upharness-${Date.now().toString(36)}`;
      let out: { results: Record<string, { url: string; title: string }>; received: { host: string; name: string; bytes: number; sha256: string }[]; blocked: string[]; seen: string[] };
      try {
        const container = await raw.createContainer({
          name, Image: "airlock-browser:dev", User: "1001:1001", WorkingDir: "/opt/airlock",
          Entrypoint: ["node", "--input-type=module", "-e", UPLOAD_HARNESS],
          Env: [`UPLOAD=${JSON.stringify(upload)}`],
          HostConfig: { NetworkMode: "none", ShmSize: 256 * 1024 ** 2, Memory: 2 * 1024 ** 3, AutoRemove: false },
        });
        await container.start();
        const result = (await container.wait()) as { StatusCode: number };
        const logs = String(await container.logs({ stdout: true, stderr: true })).replace(/[\x00-\x08]/g, "");
        const line = logs.split("\n").find((l) => l.includes("HARNESS {"));
        if (result.StatusCode !== 0 || !line) throw new Error(`upload harness exited ${result.StatusCode}: ${logs.slice(-1500)}`);
        out = JSON.parse(line.slice(line.indexOf("HARNESS ") + 8));
      } finally {
        await raw.getContainer(name).remove({ force: true }).catch(() => {});
      }
      console.info(`[browser-files-integration:upload-harness] ${JSON.stringify(out)}`);
      expect(out.received).toEqual([{ host: "127.0.0.1:18443", name: "airlock-test.txt", bytes: content.length, sha256: artifactSha256 }]);
      expect(out.results.configured).toEqual({ url: "https://127.0.0.1:18443/upload", title: "uploaded" });
      expect(out.results.notConfigured?.url).toBeDefined();
      expect(out.results.notConfigured?.url).not.toBe("https://localhost:18443/upload");
      expect(out.blocked).toEqual(["POST https://localhost:18443/upload"]);
      expect(out.seen).not.toContain("POST localhost:18443/upload");
    },
    300_000,
  );
});

// ---------------------------------------------------------------------------------------------
// Optional: the same upload through the supervisor to a public test form (real placement over exec,
// real proxy). Runs only when the site answers 200 now.
// ---------------------------------------------------------------------------------------------

const PUBLIC_UPLOAD = "https://the-internet.herokuapp.com/upload";
async function publicUploadSite(): Promise<{ ok: boolean; detail: string }> {
  try {
    const response = await fetch(PUBLIC_UPLOAD, { signal: AbortSignal.timeout(10_000) });
    return { ok: response.status === 200, detail: `HTTP ${response.status}` };
  } catch (error) {
    return { ok: false, detail: String(error).slice(0, 160) };
  }
}
const publicSite = available ? await publicUploadSite() : { ok: false, detail: "n/a" };
if (available && !publicSite.ok) console.info(`[browser-files-integration] SKIPPED public upload: ${PUBLIC_UPLOAD} does not answer 200 (${publicSite.detail})`);

describe("optional: upload through the supervisor to a public test form (runc, dev-unsafe)", () => {
  test.skipIf(!(available && publicSite.ok))(
    "upload a synthetic file to the-internet.herokuapp.com (configured mutation origin) → the form reports it",
    async () => {
      await withAttempt("u", ["the-internet.herokuapp.com"], ["https://the-internet.herokuapp.com"], async (run) => {
        const content = Buffer.from("airlock synthetic upload test fixture\n");
        await run({ op: "navigate", args: { url: PUBLIC_UPLOAD } });
        const obs = (await run({ op: "observe" })).response as { result: BrowserObserveResult };
        const chooser = obs.result.controls.find((c) => /choose file|browse|file/i.test(c.name) || (c.role === "button" && /file/i.test(c.name)));
        expect(chooser).toBeDefined();
        const up = await run({ op: "upload", args: { ref: chooser!.ref, generation: obs.result.generation, filename: "airlock-test.txt", artifactSha256: createHash("sha256").update(content).digest("hex"), contentBase64: content.toString("base64") } });
        expect(up.status).toBe("completed");
        expect(up.response?.ok).toBe(true);
        const obs2 = (await run({ op: "observe" })).response as { result: BrowserObserveResult };
        const submit = obs2.result.controls.find((c) => c.role === "button" && /^upload$/i.test(c.name));
        expect(submit).toBeDefined();
        await run({ op: "click", args: { ref: submit!.ref, generation: obs2.result.generation } });
        const after = (await run({ op: "observe" })).response as { result: BrowserObserveResult };
        console.info(`[browser-files-integration] after submit: ${after.result.text.slice(0, 160).replace(/\n/g, " | ")}`);
        expect(after.result.text).toContain("airlock-test.txt");
      });
    },
    300_000,
  );
});
