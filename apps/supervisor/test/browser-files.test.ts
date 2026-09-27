/**
 * Browser downloads (C16) and uploads (C17) at the supervisor, against the fake Docker and a scripted
 * runner: chunked download.read reassembly with sha256/size re-verification, lying runners, upload sha
 * mismatch refusal before any placement, bounded stdin placement, quotas, and the HTTP route schema.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { type AttemptRef, type BrowserOpResult, requestDigestOf } from "@airlock/contracts";
import { type SupervisorBrowserOp, SupervisorBrowserOpRequest, sniffMediaType, uploadIdFor } from "../src/browser-files";
import type { BrowserPlaneConfig } from "../src/config";
import { SupervisorError } from "../src/errors";
import { createSentinel } from "../src/hostile";
import { createApp } from "../src/index";
import { Supervisor } from "../src/lifecycle";
import { Journal } from "../src/operations";
import { FakeDocker, type RunnerRequest, type ScriptedExec, defaultHandler, fakeRunner } from "./fake-docker";
import { PROFILE, fakeHost, future, operationFor, tempDir, testConfig } from "./helpers";

const REF: AttemptRef = { taskId: "task1", attemptId: "b1", generation: 1 };
const BROWSER = "airlocktest-browser-task1-b1";
const MiB = 1024 * 1024;
const PLANE: BrowserPlaneConfig = {
  image: "airlock-browser:dev",
  imageId: undefined,
  egressImage: "airlock-egress:dev",
  egressImageId: undefined,
  seccompPath: "/x/chromium.json",
  seccompJson: JSON.stringify({ defaultAction: "SCMP_ACT_ERRNO", syscalls: [] }),
  memoryBytes: 2 * 1024 ** 3,
  pidsLimit: 256,
  shmBytes: 256 * 1024 ** 2,
  tmpBytes: 512 * 1024 ** 2,
  cpus: 1,
  egressMemoryBytes: 128 * 1024 ** 2,
  egressPidsLimit: 64,
  egressCpus: 0.5,
  attemptTimeoutMs: 30 * 60_000, mutationOrigins: [] as string[], egressResolvers: [] as string[],
};

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const ok = (req: RunnerRequest, result: unknown): ScriptedExec => ({ stdout: `${JSON.stringify({ schemaVersion: 1, id: req.id, op: req.op, ok: true, result })}\n` });

/** A runner whose download store and in-container /tmp/uploads are simulated. */
function world(files: Map<string, Buffer>, options: { lie?: (chunk: Record<string, unknown>) => Record<string, unknown>; uploadResult?: (req: RunnerRequest) => ScriptedExec } = {}) {
  const uploads = new Map<string, Buffer>();
  const execs: { script: string; args: string[]; stdinBytes: number }[] = [];
  const runner = fakeRunner({
    "download.read": (req) => {
      const id = String(req.args?.downloadId);
      const file = files.get(id);
      if (!file) return { stdout: `${JSON.stringify({ schemaVersion: 1, id: req.id, op: req.op, ok: false, error: "invalid_request", message: `no download ${id}` })}\n` };
      const offset = Number(req.args?.offset ?? 0);
      const chunk = file.subarray(offset, Math.min(offset + 2 * MiB, file.length));
      const body = { downloadId: id, suggestedFilename: "data.csv", url: "https://example.com/data.csv", mediaType: "text/csv", bytes: file.length, sha256: sha(file), offset, chunkBytes: chunk.length, chunkBase64: chunk.toString("base64"), eof: offset + chunk.length === file.length };
      return ok(req, options.lie ? options.lie(body) : body);
    },
    "download.list": (req) => ok(req, { downloads: [], admitted: 0, completedBytes: 0, limits: { maxFileBytes: 10 * MiB, maxCount: 10, maxTotalBytes: 30 * MiB } }),
    upload: options.uploadResult ?? ((req, generation) => ok(req, { generation: generation + 1, invalidated: true, url: "https://example.com/upload", uploadId: req.args?.uploadId, filename: req.args?.filename, bytes: uploads.get(String(req.args?.uploadId))?.length ?? 0, sha256: req.args?.sha256 })),
  });
  const inner = defaultHandler({ runner });
  const handler = (container: string, spec: { cmd: string[]; stdin?: Uint8Array }): ScriptedExec => {
    const i = spec.cmd.indexOf("airlock-upload");
    if (i > 0) {
      const script = spec.cmd[i - 1]!;
      const args = spec.cmd.slice(i + 1);
      execs.push({ script, args, stdinBytes: spec.stdin?.byteLength ?? 0 });
      if (script.includes('mkdir "$d"')) {
        if (uploads.has(args[1]!)) return { stderr: "mkdir: File exists", exitCode: 1 };
        uploads.set(args[1]!, Buffer.from(spec.stdin!));
        return { exitCode: 0 };
      }
      if (script.includes(">> ")) {
        uploads.set(args[1]!, Buffer.concat([uploads.get(args[1]!)!, Buffer.from(spec.stdin!)]));
        return { exitCode: 0 };
      }
      const placed = uploads.get(args[0]!)!;
      if (String(placed.length) !== args[1] || sha(placed) !== args[2]) return { stderr: "mismatch", exitCode: 5 };
      return { stdout: `${placed.length} ${sha(placed)}\n` };
    }
    return inner(container, spec as never);
  };
  return { handler, uploads, execs };
}

async function setup(docker: FakeDocker) {
  const dir = tempDir();
  const journal = new Journal(join(dir, "journal.sqlite"));
  const core = new Supervisor({ api: docker, journal, config: { ...testConfig(dir), browser: PLANE }, profiles: new Map([[PROFILE.id, PROFILE]]), host: fakeHost(), log: () => {}, browserWaits: { healthMs: 500, listeningMs: 500, pollMs: 10 } });
  const base = { ref: REF, profileId: "browser", role: "browser" as const, absoluteDeadline: future(60_000), egressAllow: ["example.com"] };
  await core.createAttempt({ ...base, operation: await operationFor("create-b1", base) });
  return { core, journal, dir };
}

async function op(core: Supervisor, opId: string, request: SupervisorBrowserOp) {
  const body = { ref: REF, request };
  return (await core.browserOp(REF, await operationFor(opId, body), request)).body as BrowserOpResult;
}

const err = (e: unknown) => e as SupervisorError;

describe("download.read", () => {
  test("a 9 MiB download is read in 2 MiB chunks, reassembled, sha256 and size re-verified, media type re-sniffed", async () => {
    const file = Buffer.alloc(9 * MiB);
    for (let i = 0; i < file.length; i++) file[i] = 0x61 + (i % 26);
    Buffer.from("a,b\n").copy(file, 0);
    const docker = new FakeDocker();
    const { core } = await setup(docker);
    const w = world(new Map([["dl-1", file]]));
    docker.handler = w.handler as never;
    const reads: number[] = [];
    const inner = docker.handler;
    docker.handler = (c, spec) => {
      if (spec.cmd.join(" ").includes("client.mjs")) {
        const req = JSON.parse(new TextDecoder().decode(spec.stdin)) as RunnerRequest;
        if (req.op === "download.read") reads.push(Number(req.args?.offset));
      }
      return inner(c, spec);
    };
    const result = await op(core, "dr1", { op: "download.read", args: { downloadId: "dl-1" } });
    expect(result.status).toBe("completed");
    expect(reads).toEqual([0, 2, 4, 6, 8].map((n) => n * MiB));
    const r = (result.response as { result: { bytes: number; sha256: string; contentBase64: string; mediaType: string; runnerMediaType: string; chunks: number } }).result;
    expect(r.bytes).toBe(file.length);
    expect(r.sha256).toBe(sha(file));
    expect(Buffer.from(r.contentBase64, "base64").equals(file)).toBe(true);
    expect(r.chunks).toBe(5);
    expect(r.runnerMediaType).toBe("text/csv");
    expect(r.mediaType).toBe(sniffMediaType(file, "data.csv"));
    core.stop();
  });

  test("an unknown download is a completed runner refusal (the attempt stays live)", async () => {
    const docker = new FakeDocker();
    const { core, journal } = await setup(docker);
    docker.handler = world(new Map()).handler as never;
    const result = await op(core, "dr2", { op: "download.read", args: { downloadId: "dl-9" } });
    expect(result.status).toBe("completed");
    expect(result.response).toMatchObject({ ok: false, error: "invalid_request" });
    expect(journal.getAttempt("b1")?.revoked).toBe(false);
    core.stop();
  });

  for (const [name, lie] of [
    ["bytes that do not hash to the claimed sha256", (c: Record<string, unknown>) => ({ ...c, sha256: "f".repeat(64) })],
    ["a chunk whose byte count is wrong", (c: Record<string, unknown>) => ({ ...c, chunkBytes: Number(c.chunkBytes) - 1, eof: false })],
    ["a size above 10 MiB", (c: Record<string, unknown>) => ({ ...c, bytes: 11 * MiB })],
    ["a chunk for another offset", (c: Record<string, unknown>) => ({ ...c, offset: 5 })],
  ] as const) {
    test(`a lying runner (${name}) is an interruption: attempt revoked, containers stopped, never replayed`, async () => {
      const docker = new FakeDocker();
      const { core, journal } = await setup(docker);
      docker.handler = world(new Map([["dl-1", Buffer.from("x,y\n1,2\n")]]), { lie }).handler as never;
      const result = await op(core, "dr3", { op: "download.read", args: { downloadId: "dl-1" } });
      expect(result.status).toBe("interrupted");
      expect(journal.getAttempt("b1")?.revoked).toBe(true);
      expect(docker.containers.get(BROWSER)?.running).toBe(false);
      core.stop();
    });
  }
});

describe("upload", () => {
  test("bytes are placed through bounded stdin (≤ 256 KiB per exec), finalized with size+sha256, then set by the runner", async () => {
    const bytes = Buffer.alloc(600 * 1024, 0x42);
    const docker = new FakeDocker();
    const { core } = await setup(docker);
    const w = world(new Map());
    docker.handler = w.handler as never;
    await op(core, "obs0", { op: "observe" });
    const result = await op(core, "up1", { op: "upload", args: { ref: "e1", generation: 1, filename: "report.csv", artifactSha256: sha(bytes), contentBase64: bytes.toString("base64") } });
    expect(result.status).toBe("completed");
    const uploadId = uploadIdFor("up1");
    expect(result.response).toMatchObject({ ok: true, op: "upload", result: { uploadId, filename: "report.csv", sha256: sha(bytes), bytes: bytes.length } });
    expect(w.execs.map((e) => e.stdinBytes)).toEqual([256 * 1024, 256 * 1024, 88 * 1024, 0]);
    expect(w.execs.at(-1)!.args).toEqual([uploadId, String(bytes.length), sha(bytes), "report.csv"]);
    expect(w.uploads.get(uploadId)!.equals(bytes)).toBe(true);
    // placement ran as the runner user in the browser container, never through a host path
    expect(docker.calls.filter((c) => c.includes("airlock-upload")).every((c) => c.startsWith(`exec ${BROWSER} /usr/bin/timeout`))).toBe(true);
    core.stop();
  });

  test("sha256 mismatch is refused (400) before anything is placed", async () => {
    const docker = new FakeDocker();
    const { core } = await setup(docker);
    const w = world(new Map());
    docker.handler = w.handler as never;
    const bytes = Buffer.from("secret,data\n");
    const e = err(await op(core, "up2", { op: "upload", args: { ref: "e1", generation: 0, filename: "a.csv", artifactSha256: "0".repeat(64), contentBase64: bytes.toString("base64") } }).catch((x) => x));
    expect(e.code).toBe("invalid_body");
    expect(e.status).toBe(400);
    expect(e.message).toMatch(/nothing was placed/);
    expect(w.execs.length).toBe(0);
    expect(docker.calls.some((c) => c.includes("airlock-upload"))).toBe(false);
    core.stop();
  });

  test("upload refusals: empty, non-strict base64, over 10 MiB, per-attempt count quota", async () => {
    const docker = new FakeDocker();
    const { core } = await setup(docker);
    docker.handler = world(new Map()).handler as never;
    const up = (id: string, bytes: Buffer, over: Record<string, unknown> = {}) =>
      op(core, id, { op: "upload", args: { ref: "e1", generation: 0, filename: "f.bin", artifactSha256: sha(bytes), contentBase64: bytes.toString("base64"), ...over } } as SupervisorBrowserOp);
    expect(err(await up("u-empty", Buffer.alloc(0)).catch((x) => x)).message).toMatch(/empty/);
    expect(err(await up("u-b64", Buffer.from("x"), { contentBase64: "eA" }).catch((x) => x)).message).toMatch(/strict/);
    expect(err(await up("u-big", Buffer.alloc(10 * MiB + 1)).catch((x) => x)).message).toMatch(/limit is 10485760/);
    for (let i = 0; i < 10; i++) expect((await up(`u${i}`, Buffer.from(`file ${i}`))).status).toBe("completed");
    expect(err(await up("u10", Buffer.from("one more")).catch((x) => x)).message).toMatch(/limits are 10 uploads/);
    core.stop();
  });

  test("a failed placement exec is a refusal (not a runner op); lost control during placement is an interruption", async () => {
    const docker = new FakeDocker();
    const { core, journal } = await setup(docker);
    const w = world(new Map());
    docker.handler = (c, spec) => (spec.cmd.includes("airlock-upload") ? { stderr: "No space left on device", exitCode: 1 } : (w.handler as never as typeof docker.handler)(c, spec));
    const bytes = Buffer.from("abc");
    const refused = await op(core, "uf1", { op: "upload", args: { ref: "e1", generation: 0, filename: "a.txt", artifactSha256: sha(bytes), contentBase64: bytes.toString("base64") } });
    expect(refused.status).toBe("refused");
    expect(refused.response).toMatchObject({ ok: false, error: "action_failed" });
    expect(journal.getAttempt("b1")?.revoked).toBe(false);
    docker.handler = (c, spec) => (spec.cmd.includes("airlock-upload") ? { exitCode: null } : (w.handler as never as typeof docker.handler)(c, spec));
    const lost = await op(core, "uf2", { op: "upload", args: { ref: "e1", generation: 0, filename: "b.txt", artifactSha256: sha(bytes), contentBase64: bytes.toString("base64") } });
    expect(lost.status).toBe("interrupted");
    expect(journal.getAttempt("b1")?.revoked).toBe(true);
    core.stop();
  });
});

describe("route", () => {
  test("POST /attempts/:id/browser accepts the file ops and refuses unknown fields, host paths and bad ids", async () => {
    const parse = (request: unknown) => SupervisorBrowserOpRequest.safeParse({ ref: REF, operation: { operationId: "x", requestDigest: "0".repeat(64) }, request }).success;
    expect(parse({ op: "download.list" })).toBe(true);
    expect(parse({ op: "download.read", args: { downloadId: "dl-1" } })).toBe(true);
    expect(parse({ op: "download.read", args: { downloadId: "dl-1", offset: 0 } })).toBe(false);
    expect(parse({ op: "download.read", args: { downloadId: "/etc/passwd" } })).toBe(false);
    expect(parse({ op: "upload", args: { ref: "e1", generation: 0, filename: "a.csv", artifactSha256: "0".repeat(64), contentBase64: "eA==" } })).toBe(true);
    expect(parse({ op: "upload", args: { ref: "e1", generation: 0, filename: "../../etc/passwd", artifactSha256: "0".repeat(64), contentBase64: "eA==" } })).toBe(false);
    expect(parse({ op: "upload", args: { ref: "e1", generation: 0, filename: "a.csv", artifactSha256: "0".repeat(64), contentBase64: "eA==", path: "/etc/passwd" } })).toBe(false);
    expect(parse({ op: "navigate", args: { url: "https://example.com/" } })).toBe(true);

    const docker = new FakeDocker();
    const { core, dir } = await setup(docker);
    docker.handler = world(new Map([["dl-1", Buffer.from("a,b\n1,2\n")]])).handler as never;
    const app = createApp({ core, token: testConfig(dir).token, sentinel: await createSentinel(dir) });
    const request = { op: "download.read", args: { downloadId: "dl-1" } };
    const body = { ref: REF, request, operation: { operationId: "http1", requestDigest: await requestDigestOf({ ref: REF, request, operation: { operationId: "http1" } }) } };
    const res = await app.request("/attempts/b1/browser", { method: "POST", headers: { authorization: `Bearer ${testConfig(dir).token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    expect(res.status).toBe(200);
    const json = (await res.json()) as BrowserOpResult;
    expect(json.status).toBe("completed");
    expect((json.response as { result: { mediaType: string } }).result.mediaType).toBe("text/csv");
    core.stop();
  });
});
