/**
 * Real-Docker analysis and node attempts through the supervisor (runc, dev-unsafe: evidence of the
 * mechanics, never a deployment claim). Skipped, with the reason printed, when Docker is unreachable
 * or the images are absent. Build them first:
 *   runtime/analysis/build.sh        (airlock-runtime-analysis:dev)
 *   runtime/node/build.sh            (airlock-runtime-node:dev)
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AttemptRef, AttemptState, CollectOutputsResult, ExecResult } from "@airlock/contracts";
import { type CodeRuntimeConfig, resolveDockerSocket } from "../src/config";
import { checkHost } from "../src/host";
import { Supervisor } from "../src/lifecycle";
import { Journal } from "../src/operations";
import { createDockerode } from "../src/runtime";
import type { DestroyResult } from "../src/types";
import { future, operationFor, tempDir, testConfig } from "./helpers";

const REPO = resolve(import.meta.dir, "../../..");
const ANALYSIS_IMAGE = "airlock-runtime-analysis:dev";
const NODE_IMAGE = "airlock-runtime-node:dev";

const api = createDockerode(resolveDockerSocket(process.env));
const dockerUp = await api.ping();
const analysisImage = dockerUp ? await api.inspectImage(ANALYSIS_IMAGE) : null;
const nodeImage = dockerUp ? await api.inspectImage(NODE_IMAGE) : null;
const available = dockerUp && analysisImage !== null;
if (!available) console.info(`[code-integration] SKIPPED: docker=${dockerUp} analysisImage=${analysisImage !== null} (build with runtime/analysis/build.sh)`);
if (available && !nodeImage) console.info("[code-integration] node test SKIPPED: airlock-runtime-node:dev absent (build with runtime/node/build.sh)");

function plane(role: "analysis" | "node", image: string, imageId: string): CodeRuntimeConfig {
  return {
    role,
    image,
    imageId,
    cpus: 1,
    memoryBytes: role === "analysis" ? 1024 ** 3 : 512 * 1024 ** 2,
    pidsLimit: 128,
    commandTimeoutMs: 60_000,
    attemptTimeoutMs: 10 * 60_000,
    workspaceBytes: 256 * 1024 ** 2,
    outputBytes: 65_536,
    maxFileBytes: 1024 * 1024,
    maxInputFileBytes: 8 * 1024 * 1024,
    maxInputTotalBytes: 32 * 1024 * 1024,
  };
}

async function setup(tag: string) {
  const dir = tempDir();
  const namespace = `airlockcit${tag}${Date.now().toString(36)}`;
  const config = {
    ...testConfig(dir),
    namespace,
    profilesDir: join(REPO, "profiles"),
    code: {
      analysis: plane("analysis", ANALYSIS_IMAGE, analysisImage!.id),
      node: nodeImage ? plane("node", NODE_IMAGE, nodeImage.id) : undefined,
    },
  };
  const host = await checkHost(api, config);
  const journal = new Journal(config.journalPath);
  const core = new Supervisor({ api, journal, config, profiles: new Map(), host, log: (m) => process.env.AIRLOCK_IT_VERBOSE && console.info(`[code-integration] ${m}`) });
  await core.start();
  let n = 0;
  const op = async (body: Record<string, unknown>) => operationFor(`${tag}op${++n}`, body);
  return { core, namespace, op };
}

async function exec(core: Supervisor, ref: AttemptRef, op: (b: Record<string, unknown>) => Promise<{ operationId: string; requestDigest: string }>, command: string): Promise<ExecResult> {
  const args = { kind: "exec" as const, command };
  const res = await core.authorTool(ref, await op({ ref, args }), args);
  return (res.body as { result: ExecResult }).result;
}

describe("real docker analysis/node sandboxes (runc, dev-unsafe)", () => {
  test.skipIf(!available)(
    "analysis: create → put inputs/regions.csv → write code/analyze.py → exec python3 → collect-outputs (summary.json + valid chart.png) → destroy leaves nothing",
    async () => {
      const { core, namespace, op } = await setup("a");
      const ref: AttemptRef = { taskId: "cit", attemptId: `an${Date.now().toString(36)}`, generation: 1 };
      try {
        const body = { ref, profileId: "analysis", role: "analysis" as const, absoluteDeadline: future(300_000) };
        const state = (await core.createAttempt({ ...body, operation: await op(body) })).body as AttemptState;
        expect(state.status).toBe("running");
        expect(state.inspection?.allPassed).toBe(true);
        expect(state.inspection?.imageId).toBe(analysisImage!.id);
        expect(state.inspection?.devUnsafe).toBe(true);
        expect(state.probe?.allBlocked).toBe(true);
        console.info(`[code-integration] analysis running: runtime=${state.inspection?.runtime} guest=${state.inspection?.guestUname.slice(0, 60)} probe=${JSON.stringify(state.probe)}`);

        const csv = readFileSync(join(REPO, "runtime/analysis/fixtures/regions.csv"));
        const putArgs = { kind: "put" as const, path: "inputs/regions.csv", contentBase64: csv.toString("base64") };
        const put = (await core.authorTool(ref, await op({ ref, args: putArgs }), putArgs)).body;
        expect(put).toEqual({ kind: "put", byteLength: csv.length, sha256: createHash("sha256").update(csv).digest("hex") });
        const writeArgs = { kind: "write" as const, path: "code/analyze.py", content: readFileSync(join(REPO, "runtime/analysis/fixtures/analyze_regions.py"), "utf8") };
        expect((await core.authorTool(ref, await op({ ref, args: writeArgs }), writeArgs)).body).toMatchObject({ kind: "write" });

        // Inputs are root-owned and read-only for the sandbox user.
        const ls = await exec(core, ref, op, "stat -c '%U %a %n' inputs inputs/regions.csv code outputs");
        console.info(`[code-integration] layout: ${ls.stdout.trim().replace(/\n/g, " | ")}`);
        expect(ls.stdout).toContain("root 444 inputs/regions.csv");
        const tamper = await exec(core, ref, op, "echo x > inputs/regions.csv; echo x > inputs/new.csv; chmod 666 inputs/regions.csv; echo done");
        expect(tamper.stderr).toMatch(/Permission denied|Operation not permitted/);
        expect((await exec(core, ref, op, "sha256sum inputs/regions.csv")).stdout).toContain(createHash("sha256").update(csv).digest("hex"));

        const run = await exec(core, ref, op, "python3 code/analyze.py");
        console.info(`[code-integration] python3 code/analyze.py → ${run.status} exit ${run.exitCode} ${run.durationMs} ms: ${run.stdout.trim().slice(0, 200)} ${run.stderr.trim().slice(0, 200)}`);
        expect(run.status).toBe("succeeded");
        const offline = await exec(core, ref, op, "python3 -c \"import urllib.request as u; u.urlopen('https://pypi.org/simple/', timeout=3)\"");
        expect(offline.status).toBe("failed");

        const collected = (await core.collectOutputs(ref, await op({ ref }))).body as CollectOutputsResult;
        expect(collected.stopConfirmed).toBe(true);
        const paths = collected.envelope.files.map((f) => f.path);
        console.info(`[code-integration] collected: ${collected.envelope.files.map((f) => `${f.path} ${f.mediaType} ${f.byteLength}B`).join(", ")}; rejected: ${JSON.stringify(collected.envelope.rejected)}`);
        expect(paths).toEqual(["chart.png", "summary.json"]);
        const png = Buffer.from(collected.envelope.files.find((f) => f.path === "chart.png")!.contentBase64, "base64");
        expect(png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true);
        expect(png.toString("latin1", 12, 16)).toBe("IHDR");
        expect(png.readUInt32BE(16)).toBeGreaterThan(0);
        const summary = JSON.parse(Buffer.from(collected.envelope.files.find((f) => f.path === "summary.json")!.contentBase64, "base64").toString("utf8")) as { worstRegion?: string };
        expect(summary.worstRegion).toBe("Synthetic-West");
        expect(core.getAttempt(ref.attemptId)?.status).toBe("stopped");
      } finally {
        const destroyed = (await core.destroy(ref, await op({ ref }))).body as DestroyResult;
        expect(destroyed.teardown.clean).toBe(true);
        const listing = await core.teardownRecord([`airlock.namespace=${namespace}`]);
        console.info(`[code-integration] after destroy: ${listing.containersRemaining.length + listing.volumesRemaining.length === 0 ? "(no sandboxes)" : JSON.stringify(listing)}`);
        expect(listing.containersRemaining).toEqual([]);
        expect(listing.volumesRemaining).toEqual([]);
        core.stop();
      }
    },
    240_000,
  );

  test.skipIf(!available || !nodeImage)(
    "node: create → put inputs/x.csv → write code/a.mjs → exec node → collect-outputs (analysis-image collector) → destroy leaves nothing",
    async () => {
      const { core, namespace, op } = await setup("n");
      const ref: AttemptRef = { taskId: "cit", attemptId: `nd${Date.now().toString(36)}`, generation: 1 };
      try {
        const body = { ref, profileId: "node", role: "node" as const, absoluteDeadline: future(300_000) };
        const state = (await core.createAttempt({ ...body, operation: await op(body) })).body as AttemptState;
        expect(state.status).toBe("running");
        expect(state.inspection?.imageId).toBe(nodeImage!.id);
        expect(state.probe?.allBlocked).toBe(true);
        const csv = "region,revenue\nA,10\nB,3\nC,7\n";
        const putArgs = { kind: "put" as const, path: "inputs/x.csv", contentBase64: Buffer.from(csv).toString("base64") };
        expect((await core.authorTool(ref, await op({ ref, args: putArgs }), putArgs)).body).toMatchObject({ kind: "put", byteLength: csv.length });
        const code = [
          'import { readFileSync, writeFileSync } from "node:fs";',
          'const rows = readFileSync("inputs/x.csv", "utf8").trim().split("\\n").slice(1).map((l) => l.split(","));',
          "const worst = rows.reduce((a, b) => (Number(b[1]) < Number(a[1]) ? b : a));",
          'writeFileSync("outputs/result.json", JSON.stringify({ worst: worst[0], rows: rows.length }));',
          'console.log("done", worst[0]);',
        ].join("\n");
        const writeArgs = { kind: "write" as const, path: "code/a.mjs", content: code };
        await core.authorTool(ref, await op({ ref, args: writeArgs }), writeArgs);
        const run = await exec(core, ref, op, "node code/a.mjs");
        console.info(`[code-integration] node code/a.mjs → ${run.status} exit ${run.exitCode}: ${run.stdout.trim()} ${run.stderr.trim().slice(0, 200)}`);
        expect(run.status).toBe("succeeded");
        expect(run.stdout).toContain("done B");
        const collected = (await core.collectOutputs(ref, await op({ ref }))).body as CollectOutputsResult;
        expect(collected.envelope.files.map((f) => [f.path, f.mediaType])).toEqual([["result.json", "application/json"]]);
        expect(JSON.parse(Buffer.from(collected.envelope.files[0]!.contentBase64, "base64").toString("utf8"))).toEqual({ worst: "B", rows: 3 });
      } finally {
        const destroyed = (await core.destroy(ref, await op({ ref }))).body as DestroyResult;
        expect(destroyed.teardown.clean).toBe(true);
        const listing = await core.teardownRecord([`airlock.namespace=${namespace}`]);
        expect(listing.containersRemaining).toEqual([]);
        expect(listing.volumesRemaining).toEqual([]);
        core.stop();
      }
    },
    240_000,
  );
});
