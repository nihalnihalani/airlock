/**
 * Real-Docker browser downloads and uploads through the supervisor (runc, dev-unsafe: mechanics only).
 * Needs outbound internet from the Docker host and these PUBLIC hosts on the attempt's allowlist
 * (the egress proxy refuses non-public addresses by design, so a local fixture cannot be used):
 *   people.sc.fsu.edu           a 328-byte text/csv file (Chromium downloads text/csv)
 *   speed.cloudflare.com        a 20 MB application/octet-stream body (in-progress size abort)
 *   the-internet.herokuapp.com  a public upload test form (receives a synthetic 40-byte text file)
 * Skipped, with the reason printed, when Docker, the images or outbound internet are unavailable.
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

describe("real docker browser downloads and uploads (runc, dev-unsafe)", () => {
  test.skipIf(!available)(
    "download a public CSV → list → read (sha256/size re-verified) → 20 MB download aborted in progress → upload a synthetic file to a public test form → destroy leaves nothing",
    async () => {
      const dir = tempDir();
      const namespace = `airlockbfit${Date.now().toString(36)}`;
      const seccompPath = join(REPO, "runtime/browser/seccomp/chromium.json");
      const config = {
        ...testConfig(dir),
        namespace,
        profilesDir: join(REPO, "profiles"),
        browser: {
          image: "airlock-browser:dev",
          imageId: browserImage!.id,
          egressImage: "airlock-egress:dev",
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
          attemptTimeoutMs: 10 * 60_000,
          // The upload form's submit is a POST: refused by the runner's mutation guard unless its origin is configured.
          mutationOrigins: ["https://the-internet.herokuapp.com"],
        },
      };
      const host = await checkHost(api, config);
      const journal = new Journal(config.journalPath);
      const core = new Supervisor({ api, journal, config, profiles: new Map(), host, log: (l) => (process.env.AIRLOCK_IT_VERBOSE ? console.info(`[browser-files-integration] ${l}`) : undefined) });
      await core.start();
      const ref: AttemptRef = { taskId: "bfit", attemptId: `f${Date.now().toString(36)}`, generation: 1 };
      let n = 0;
      const run = async (request: SupervisorBrowserOp): Promise<BrowserOpResult> => {
        const body = { ref, request };
        const result = (await core.browserOp(ref, await operationFor(`op${++n}-${ref.attemptId}`, body), request)).body as BrowserOpResult;
        console.info(`[browser-files-integration] ${request.op} → ${result.status} ${JSON.stringify(result.response).slice(0, 240)} (${result.durationMs} ms)`);
        return result;
      };
      type Listed = { downloads: { downloadId: string; state: string; reason?: string; bytes?: number }[] };
      const waitFor = async (predicate: (l: Listed) => boolean, ms: number): Promise<Listed> => {
        const end = Date.now() + ms;
        for (;;) {
          const listed = (await run({ op: "download.list" })).response as { result: Listed };
          if (predicate(listed.result) || Date.now() > end) return listed.result;
          await new Promise((r) => setTimeout(r, 1000));
        }
      };
      try {
        const createBody = { ref, profileId: "browser", role: "browser" as const, absoluteDeadline: future(8 * 60_000), egressAllow: ["people.sc.fsu.edu", "speed.cloudflare.com", "the-internet.herokuapp.com"] };
        const state = (await core.createAttempt({ ...createBody, operation: await operationFor(`create-${ref.attemptId}`, createBody) })).body as AttemptState;
        expect(state.status).toBe("running");
        expect(state.probe?.allBlocked).toBe(true);

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

        // 3. upload: a supervisor-placed synthetic file set on the form's file input, then submitted
        const content = Buffer.from("airlock synthetic upload test fixture\n");
        await run({ op: "navigate", args: { url: "https://the-internet.herokuapp.com/upload" } });
        const obs = (await run({ op: "observe" })).response as { result: BrowserObserveResult };
        console.info(`[browser-files-integration] upload page controls: ${JSON.stringify(obs.result.controls.slice(0, 8))}`);
        const chooser = obs.result.controls.find((c) => /choose file|browse|file/i.test(c.name) || c.role === "button" && /file/i.test(c.name));
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
      } finally {
        const destroyed = (await core.destroy(ref, await operationFor(`destroy-${ref.attemptId}`, { ref }))).body as DestroyResult;
        const listing = await core.hostListing();
        const ours = listing.containers.filter((c) => c.name.startsWith(namespace));
        console.info(`[browser-files-integration] after destroy: ${destroyed.teardown.clean && ours.length === 0 ? "(no sandboxes)" : JSON.stringify(destroyed.teardown)}`);
        expect(destroyed.teardown.clean).toBe(true);
        core.stop();
      }
    },
    300_000,
  );
});
