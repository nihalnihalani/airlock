import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Artifact, Task } from "@airlock/contracts";
import { ARTIFACT_CSP, createApp, type ApiDeps } from "../src/api.ts";
import { OWNER_QUOTA_FILES, UPLOAD_MAX_BYTES, sanitizeFilename, sniffMediaType } from "../src/artifact-service.ts";
import { zipFiles } from "../src/artifacts/index.ts";
import { encodePng } from "../src/png.ts";
import { SessionService } from "../src/sessions.ts";
import { exportBundleDouble, fixtureObserve, makeFixture, type Fixture } from "./helpers/doubles.ts";
import { FakeSupervisor } from "./helpers/fake-supervisor.ts";
import { makeGeneralHarness, recordingDriver, type GeneralHarness } from "./helpers/general.ts";
import { HERO_HOST, HERO_PAGES, HERO_TURNS, heroExec } from "./helpers/hero.ts";

const OPERATOR = "operator-pass-123";
const JUDGE = "judge-pass-456";

let fixture: Fixture;
beforeAll(async () => {
  fixture = await makeFixture();
});
afterAll(async () => {
  await fixture.cleanup();
});

async function makeCtx(): Promise<{ app: ReturnType<typeof createApp>; h: GeneralHarness; supervisor: FakeSupervisor; close: () => Promise<void> }> {
  const supervisor = new FakeSupervisor({ profile: fixture.profile, observe: fixtureObserve, pages: HERO_PAGES, exec: heroExec });
  const h = await makeGeneralHarness(fixture, supervisor, () => recordingDriver(HERO_TURNS));
  const sessions = new SessionService(h.store, { operatorPassword: OPERATOR, judgePassword: JUDGE, ttlMs: 60_000, secureCookies: false });
  const deps: ApiDeps = {
    store: h.store,
    sessions,
    profiles: new Map([[fixture.profile.manifest.id, fixture.profile]]),
    supervisor,
    artifacts: h.blobs,
    artifactService: h.artifacts,
    worker: h.worker,
    bus: h.bus,
    exportBundle: exportBundleDouble,
    zipFiles,
    exportGrantTtlMs: 60_000,
    hostileMinIntervalMs: 10_000,
    runtimeDir: fixture.runtimeDir,
    ssePollMs: 20,
  };
  return { app: createApp(deps), h, supervisor, close: () => h.close() };
}

async function login(app: ReturnType<typeof createApp>, password: string): Promise<string> {
  const res = await app.request("/api/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }) });
  expect(res.status).toBe(200);
  return (res.headers.get("set-cookie") ?? "").split(";")[0]!;
}
const upload = (app: ReturnType<typeof createApp>, cookie: string | null, filename: string, bytes: Uint8Array | string) =>
  app.request("/api/uploads", { method: "POST", headers: { ...(cookie ? { cookie } : {}), "x-filename": filename, "content-type": "application/octet-stream" }, body: typeof bytes === "string" ? bytes : new Uint8Array(bytes) });
const post = (app: ReturnType<typeof createApp>, cookie: string, path: string, body: unknown) => app.request(path, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) });

describe("upload sniffing and names", () => {
  test("media type comes from the bytes; the name follows it", () => {
    const png = encodePng(2, 2, [1, 2, 3]);
    expect(sniffMediaType(png, "notes.txt")).toBe("image/png");
    expect(sanitizeFilename("../../etc/notes.txt", "image/png")).toBe("notes.png");
    expect(sniffMediaType(new TextEncoder().encode("a,b\n1,2\n"), "d.csv")).toBe("text/csv");
    expect(sniffMediaType(new TextEncoder().encode("a,b\n1,2\n"), "d.txt")).toBe("text/plain");
    expect(sniffMediaType(new TextEncoder().encode('{"a":1}'), "x")).toBe("application/json");
    expect(sniffMediaType(new TextEncoder().encode("%PDF-1.7\n..."), "x.pdf")).toBe("application/pdf");
    expect(sniffMediaType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2]), "p.jpeg")).toBe("image/jpeg");
    expect(sniffMediaType(new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03]), "tool.exe")).toBeNull();
    expect(sniffMediaType(new TextEncoder().encode("<svg onload=alert(1)>"), "x.svg")).toBe("text/plain");
    expect(sanitizeFilename("<svg onload=alert(1)>.svg", "text/plain")).toBe("svg_onload_alert_1_.txt");
    expect(sanitizeFilename(".hidden", "text/plain")).toBe("hidden.txt");
  });
});

describe("uploads and artifacts API", () => {
  test("auth, type refusal, size and per-owner quota", async () => {
    const ctx = await makeCtx();
    try {
      expect((await upload(ctx.app, null, "a.csv", "a,b\n1,2\n")).status).toBe(401);
      const judge = await login(ctx.app, JUDGE);
      const missingName = await ctx.app.request("/api/uploads", { method: "POST", headers: { cookie: judge }, body: "x" });
      expect(missingName.status).toBe(400);
      const exe = await upload(ctx.app, judge, "tool.exe", new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0xff]));
      expect(exe.status).toBe(415);
      const big = await upload(ctx.app, judge, "big.txt", new Uint8Array(UPLOAD_MAX_BYTES + 1).fill(0x61));
      expect(big.status).toBe(413);
      const ok = await upload(ctx.app, judge, "sales%20data.csv", "a,b\n1,2\n");
      expect(ok.status).toBe(201);
      const artifact = (await ok.json()) as Artifact;
      expect(artifact).toMatchObject({ kind: "upload", filename: "sales_data.csv", mediaType: "text/csv", byteLength: 8 });
      for (let i = 1; i < OWNER_QUOTA_FILES; i++) expect((await upload(ctx.app, judge, `f${i}.txt`, `file ${i}`)).status).toBe(201);
      const over = await upload(ctx.app, judge, "one-too-many.txt", "x");
      expect(over.status).toBe(413);
      expect(((await over.json()) as { error: string }).error).toContain("quota");
      const list = (await (await ctx.app.request("/api/uploads", { headers: { cookie: judge } })).json()) as { artifacts: Artifact[]; quota: { usedFiles: number } };
      expect(list.quota.usedFiles).toBe(OWNER_QUOTA_FILES);
      // Another session has its own quota.
      const judge2 = await login(ctx.app, JUDGE);
      expect((await upload(ctx.app, judge2, "mine.txt", "hello")).status).toBe(201);
    } finally {
      await ctx.close();
    }
  });

  test("artifact bytes: owner or operator only (404 otherwise), safe headers, inline only for png/jpeg", async () => {
    const ctx = await makeCtx();
    try {
      const a = await login(ctx.app, JUDGE);
      const b = await login(ctx.app, JUDGE);
      const op = await login(ctx.app, OPERATOR);
      const csv = (await (await upload(ctx.app, a, "d.csv", "a,b\n1,2\n")).json()) as Artifact;
      const png = (await (await upload(ctx.app, a, "chart.png", encodePng(3, 3, [9, 9, 9]))).json()) as Artifact;
      const own = await ctx.app.request(`/api/artifacts/${csv.id}`, { headers: { cookie: a } });
      expect(own.status).toBe(200);
      expect(await own.text()).toBe("a,b\n1,2\n");
      expect(own.headers.get("content-disposition")).toBe('attachment; filename="d.csv"');
      expect(own.headers.get("content-type")).toBe("text/csv");
      expect(own.headers.get("x-content-type-options")).toBe("nosniff");
      expect(own.headers.get("cache-control")).toBe("private, no-store");
      expect(own.headers.get("content-security-policy")).toBe(ARTIFACT_CSP);
      const image = await ctx.app.request(`/api/artifacts/${png.id}`, { headers: { cookie: a } });
      expect(image.headers.get("content-disposition")).toBe('inline; filename="chart.png"');
      expect((await ctx.app.request(`/api/artifacts/${png.id}?download=1`, { headers: { cookie: a } })).headers.get("content-disposition")).toStartWith("attachment");
      expect((await ctx.app.request(`/api/artifacts/${csv.id}`, { headers: { cookie: b } })).status).toBe(404);
      expect((await ctx.app.request(`/api/artifacts/${csv.id}`)).status).toBe(401);
      expect((await ctx.app.request(`/api/artifacts/${csv.id}`, { headers: { cookie: op } })).status).toBe(200);
      // Another owner's upload cannot be a task input.
      const refused = await post(ctx.app, b, "/api/tasks", { kind: "general", profileId: "analysis", issueText: "summarise", inputArtifactIds: [csv.id] });
      expect(refused.status).toBe(422);
      expect(((await refused.json()) as { error: string }).error).toContain("not found among your uploads");
    } finally {
      await ctx.close();
    }
  });

  test("general task creation validates profile, egressAllow and inputs", async () => {
    const ctx = await makeCtx();
    try {
      const j = await login(ctx.app, JUDGE);
      const create = (body: Record<string, unknown>) => post(ctx.app, j, "/api/tasks", { kind: "general", issueText: "find the worst region", ...body });
      const expect422 = async (body: Record<string, unknown>, fragment: string) => {
        const res = await create(body);
        expect(res.status).toBe(422);
        expect(((await res.json()) as { error: string }).error).toContain(fragment);
      };
      await expect422({ profileId: "no-such" }, "not supported");
      await expect422({ profileId: "web-research" }, "needs at least one allowed destination");
      await expect422({ profileId: "web-research", egressAllow: ["10.0.0.1"] }, "IP literals");
      await expect422({ profileId: "web-research", egressAllow: ["localhost"] }, "single-label");
      await expect422({ profileId: "web-research", egressAllow: ["metadata.google.internal"] }, "special-use");
      await expect422({ profileId: "web-research", egressAllow: [".com"] }, "top-level domain");
      await expect422({ profileId: "web-research", egressAllow: ["printer.local"] }, "special-use");
      await expect422({ profileId: "analysis", egressAllow: ["example.org"] }, "egressAllow must be empty");
      const png = (await (await upload(ctx.app, j, "c.png", encodePng(2, 2, [1, 1, 1]))).json()) as Artifact;
      await expect422({ profileId: "web-research", egressAllow: ["example.org"], inputArtifactIds: [png.id] }, "does not accept input files");
      // Repair tasks do not take general fields.
      const repair = await post(ctx.app, j, "/api/tasks", { profileId: fixture.profile.manifest.id, issueText: "x", egressAllow: ["example.org"] });
      expect(repair.status).toBe(422);
      const ok = await create({ profileId: "web-analysis", egressAllow: [HERO_HOST, ".data.example.org"], inputArtifactIds: [png.id] });
      expect(ok.status).toBe(201);
      const task = (await ok.json()) as Task;
      expect(task).toMatchObject({ kind: "general", profileId: "web-analysis", egressAllow: [HERO_HOST, ".data.example.org"], inputArtifactIds: [png.id], cleanup: { status: "none" } });
      const profiles = (await (await ctx.app.request("/api/task-profiles")).json()) as { id: string }[];
      expect(profiles.map((p) => p.id)).toEqual(["analysis", "web-research", "web-analysis"]);
    } finally {
      await ctx.close();
    }
  });

  test("hero through the API: artifacts listed and served, evidence bundle sealed once and repeatable", async () => {
    const ctx = await makeCtx();
    try {
      const j = await login(ctx.app, JUDGE);
      const other = await login(ctx.app, JUDGE);
      const created = await post(ctx.app, j, "/api/tasks", { kind: "general", profileId: "web-analysis", issueText: "Open the data page, find the worst region, chart it with sources.", egressAllow: [HERO_HOST] });
      expect(created.status).toBe(201);
      const task = (await created.json()) as Task;
      ctx.h.worker.start();
      const done = await ctx.h.waitFor(task.id);
      expect(done.outcome).toBe("RESULT_VERIFIED");
      const list = (await (await ctx.app.request(`/api/tasks/${task.id}/artifacts`, { headers: { cookie: j } })).json()) as Artifact[];
      expect(list.map((a) => a.kind).sort()).toEqual(["download", "output", "output", "screenshot"]);
      expect((await ctx.app.request(`/api/tasks/${task.id}/artifacts`, { headers: { cookie: other } })).status).toBe(404);
      const chart = list.find((a) => a.filename === "chart.png")!;
      const scoped = await ctx.app.request(`/api/tasks/${task.id}/artifacts/${chart.id}`, { headers: { cookie: j } });
      expect(scoped.status).toBe(200);
      expect(scoped.headers.get("x-airlock-sha256")).toBe(chart.sha256);
      const exp = await post(ctx.app, j, `/api/tasks/${task.id}/export`, {});
      expect(exp.status).toBe(201);
      const grant = (await exp.json()) as { grantId: string; url: string; zipDigest: string; partial: boolean };
      expect(grant.partial).toBe(false);
      const again = await post(ctx.app, j, `/api/tasks/${task.id}/export`, {});
      expect(again.status).toBe(200);
      expect(((await again.json()) as { zipDigest: string }).zipDigest).toBe(grant.zipDigest);
      const zip1 = new Uint8Array(await (await ctx.app.request(grant.url, { headers: { cookie: j } })).arrayBuffer());
      const zip2 = await ctx.app.request(grant.url, { headers: { cookie: j } });
      expect(zip2.headers.get("x-airlock-zip-sha256")).toBe(grant.zipDigest);
      expect(new Uint8Array(await zip2.arrayBuffer())).toEqual(zip1);
      const names = new TextDecoder().decode(zip1);
      for (const f of ["task.json", "result.json", "outputs/summary.json", "outputs/chart.png", "code/analysis.py", "screenshots.json", "events.jsonl", "identity.json", "egress.json", "cleanup.json", "manifest.json", "README.txt"]) expect(names).toContain(f);
      expect((await ctx.app.request(grant.url, { headers: { cookie: other } })).status).toBe(404);
    } finally {
      await ctx.close();
    }
  });
});
