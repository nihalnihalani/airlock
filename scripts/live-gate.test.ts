/**
 * scripts/live-gate.ts against a fake control API: a live run writes a schema-valid receipt from
 * the tasks' own events; a scripted (diagnostic) run, a model call from another host and a
 * dev-unsafe supervisor are provenance failures with no receipt.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { LiveGateReceipt } from "@airlock/contracts";

const ROOT = resolve(import.meta.dir, "..");
const CONTRACT = "c".repeat(64);

type Mode = { scripted?: boolean; foreignHost?: boolean; devUnsafe?: boolean; failing?: number };

function fakeControl(mode: Mode) {
  let n = 0;
  const createdBodies: string[] = [];
  const tasks = new Map<string, Record<string, unknown>>();
  const record = (taskId: string, role: string, passed: boolean) => ({
    role,
    taskId,
    passed,
    candidateDigest: "d".repeat(64),
    contractDigest: CONTRACT,
    runtimeProfile: { host: { devUnsafe: !!mode.devUnsafe }, inspection: { runtime: mode.devUnsafe ? "runc" : "kata", devUnsafe: !!mode.devUnsafe } },
  });
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/api/session") return new Response(JSON.stringify({ role: "operator" }), { headers: { "set-cookie": "airlock_session=abc; Path=/" } });
      if (url.pathname === "/api/host") return Response.json({ selectedRuntime: mode.devUnsafe ? "runc" : "kata", devUnsafe: !!mode.devUnsafe, runtimeImageId: "sha256:img" });
      if (url.pathname === "/api/tasks" && req.method === "POST") {
        if (url.searchParams.get("liveGate") !== "1") return Response.json({ error: "expected liveGate" }, { status: 400 });
        createdBodies.push(await req.text());
        const id = `task-${++n}`;
        const passed = n > (mode.failing ?? 0);
        const task = { id, status: "done", phase: "ready", outcome: passed ? "CANDIDATE_PASSED_CHECKS" : "CHECKS_FAILED", candidateDigest: "d".repeat(64), createdAt: new Date().toISOString(), ...(mode.scripted ? { scriptedDriver: "diagnostic" } : {}) };
        tasks.set(id, task);
        return Response.json(task, { status: 201 });
      }
      const view = /^\/api\/tasks\/([^/]+)$/.exec(url.pathname);
      if (view) {
        const task = tasks.get(view[1]!)!;
        return Response.json({ task, baseline: record(task.id as string, "baseline", true), verification: { ...record(task.id as string, "candidate", task.outcome === "CANDIDATE_PASSED_CHECKS") } });
      }
      const events = /^\/api\/tasks\/([^/]+)\/events$/.exec(url.pathname);
      if (events) {
        const taskId = events[1]!;
        const host = mode.foreignHost ? "https://api.openai.com/v1" : mode.scripted ? "scripted" : "https://api.vultrinference.com/v1";
        const model = mode.scripted ? "scripted:diagnostic" : "glm-5.3-normalize";
        const list = [
          { id: "e1", taskId, seq: 1, at: new Date().toISOString(), kind: "phase", title: "prepare", detail: "", data: { contractDigest: CONTRACT } },
          { id: "e2", taskId, seq: 2, at: new Date().toISOString(), kind: "model", title: "Model turn 1", detail: "", data: { model, host } },
          { id: "e3", taskId, seq: 3, at: new Date().toISOString(), kind: "model", title: "Model turn 2", detail: "", data: { model, host } },
        ];
        const body = list.map((e) => `id: ${e.seq}\nevent: ${e.kind}\ndata: ${JSON.stringify(e)}\n\n`).join("") + `event: end\ndata: {"status":"done"}\n\n`;
        return new Response(body, { headers: { "content-type": "text/event-stream" } });
      }
      return Response.json({ error: "not found" }, { status: 404 });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, createdBodies, stop: () => server.stop(true) };
}

// Async spawn: the fake control API runs in this process and must keep serving meanwhile.
async function runGate(controlUrl: string, out: string, extra: string[] = []) {
  const proc = Bun.spawn(["bun", join(ROOT, "scripts/live-gate.ts"), "--out", out, ...extra], {
    cwd: ROOT,
    env: { ...process.env, AIRLOCK_CONTROL_URL: controlUrl, AIRLOCK_OPERATOR_PASSWORD: "op-test-password" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, stdout, stderr };
}

describe("live gate", () => {
  test("a live run writes a sanitized, schema-valid receipt from the tasks' own events; the tracked issue is sent without its provenance note", async () => {
    const fake = fakeControl({ failing: 1 });
    const out = mkdtempSync(join(tmpdir(), "airlock-gate-out-"));
    try {
      const r = await runGate(fake.url, out);
      expect(r.stdout).toContain("LIVE GATE: 2/3");
      expect(r.code).toBe(0);
      const files = readdirSync(out);
      expect(files).toHaveLength(1);
      const text = readFileSync(join(out, files[0]!), "utf8");
      const receipt = LiveGateReceipt.parse(JSON.parse(text));
      expect(receipt).toMatchObject({ profileId: "tabulate-365", contractDigest: CONTRACT, model: "glm-5.3-normalize", runtime: "kata", passed: 2, total: 3, runtimeImageId: "sha256:img" });
      expect(receipt.attempts.every((a) => a.modelHosts.join() === "api.vultrinference.com" && a.modelCalls === 2)).toBe(true);
      // No issue text, cookie or password in the receipt.
      expect(text).not.toContain("maxheadercolwidths");
      expect(text).not.toContain("airlock_session");
      expect(text).not.toContain("op-test-password");
      const sent = JSON.parse(fake.createdBodies[0]!) as { profileId: string; issueText: string };
      expect(sent.profileId).toBe("tabulate-365");
      expect(sent.issueText).toContain("maxheadercolwidths");
      expect(sent.issueText).not.toContain("<!--");
      expect(sent.issueText).not.toContain("87a9a4e");
    } finally {
      fake.stop();
      rmSync(out, { recursive: true, force: true });
    }
  }, 60_000);

  for (const [name, mode, extra] of [
    ["scripted diagnostic tasks", { scripted: true }, ["--n", "1"]],
    ["a model call served from another host", { foreignHost: true }, ["--n", "1"]],
    ["a dev-unsafe supervisor", { devUnsafe: true }, ["--n", "1"]],
  ] as [string, Mode, string[]][]) {
    test(`refuses ${name}: exit 2, no receipt`, async () => {
      const fake = fakeControl(mode);
      const out = mkdtempSync(join(tmpdir(), "airlock-gate-out-"));
      try {
        const r = await runGate(fake.url, out, extra);
        expect(r.code).toBe(2);
        expect(r.stderr).toContain("provenance");
        expect(readdirSync(out)).toHaveLength(0);
      } finally {
        fake.stop();
        rmSync(out, { recursive: true, force: true });
      }
    }, 30_000);
  }
});
