import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ProfileManifest,
  SourceManifest,
  candidateDigestOf,
  canonicalJson,
  type CandidateBundle,
  type CollectedFile,
  type FileEnvelope,
  type RunEvent,
  type Task,
  type VerificationRecord,
} from "@airlock/contracts";
import {
  ArtifactStore,
  buildManifest,
  crc32,
  decodeBase64Strict,
  exportBundle,
  unifiedDiff,
  validateEnvelope,
  zipFiles,
} from "../src/artifacts/index.ts";

const profileJson = await Bun.file(new URL("../../../profiles/tabulate-365/profile.json", import.meta.url)).json();
const profile = ProfileManifest.parse(profileJson);
const fixtureDir = new URL("./fixtures/diagnostic-candidate-tabulate-365/", import.meta.url);
const diagnosticInit = await Bun.file(new URL("tabulate/__init__.py", fixtureDir)).text();
const baseInitPath = await (async () => {
  const inProfile = new URL("../../../profiles/tabulate-365/base/tabulate/__init__.py", import.meta.url);
  if (await Bun.file(inProfile).exists()) return inProfile;
  return new URL("../../../research/reference-repos/python-tabulate/tabulate/__init__.py", import.meta.url);
})();
const baseInit = (await Bun.file(baseInitPath).exists()) ? await Bun.file(baseInitPath).text() : null;

const NOW = "2026-09-26T12:00:00.000Z";
const enc = new TextEncoder();
const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

function collected(path: string, content: string | Uint8Array): CollectedFile {
  const bytes = typeof content === "string" ? enc.encode(content) : content;
  return { path, byteLength: bytes.byteLength, sha256: sha(bytes), contentBase64: Buffer.from(bytes).toString("base64") };
}

function envelope(files: CollectedFile[], rejected: FileEnvelope["rejected"] = []): FileEnvelope {
  return { schemaVersion: 1, files, rejected };
}

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "airlock-artifacts-"));
}

describe("decodeBase64Strict", () => {
  test("accepts canonical encodings and rejects everything else", () => {
    expect(decodeBase64Strict("")).toEqual(new Uint8Array(0));
    expect(Array.from(decodeBase64Strict("aGk=") ?? [])).toEqual([104, 105]);
    for (const bad of ["aGk", "aGk==", "aG k=", "aGk=\n", "aGk-", "QR==", "=", "===="]) {
      expect(decodeBase64Strict(bad)).toBeNull();
    }
  });
});

describe("validateEnvelope", () => {
  const goodFile = collected("tabulate/__init__.py", "print('candidate')\n");

  test("accepts a well-formed envelope and returns sorted files", () => {
    const r = validateEnvelope(envelope([goodFile]), profile);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.files).toEqual([goodFile]);
  });

  test("accepts an empty envelope (no replacements)", () => {
    const r = validateEnvelope(envelope([]), profile);
    expect(r.ok).toBe(true);
  });

  const rejections: { name: string; env: () => FileEnvelope; reason: RegExp }[] = [
    { name: "extra path outside allowlist", env: () => envelope([goodFile, collected("tabulate/version.py", "x")]), reason: /not an allowed replacement path/ },
    { name: "traversal path", env: () => envelope([collected("tabulate/../setup.py", "x")]), reason: /invalid path/ },
    { name: "absolute path", env: () => envelope([collected("/etc/passwd", "x")]), reason: /invalid path/ },
    { name: "backslash path", env: () => envelope([collected("tabulate\\__init__.py", "x")]), reason: /invalid path/ },
    { name: "symlink-like duplicate (same path twice)", env: () => envelope([goodFile, collected("tabulate/__init__.py", "other")]), reason: /duplicate/ },
    { name: "case-variant duplicate", env: () => envelope([goodFile, { ...collected("tabulate/__INIT__.py", "x") }]), reason: /not an allowed|duplicate/ },
    { name: "bad sha256", env: () => envelope([{ ...goodFile, sha256: "0".repeat(64) }]), reason: /sha256 mismatch/ },
    { name: "malformed sha256", env: () => envelope([{ ...goodFile, sha256: "ZZ" }]), reason: /64 lowercase hex/ },
    { name: "byteLength does not match decoded length", env: () => envelope([{ ...goodFile, byteLength: goodFile.byteLength + 1 }]), reason: /byteLength/ },
    { name: "negative byteLength", env: () => envelope([{ ...goodFile, byteLength: -1 }]), reason: /non-negative integer/ },
    { name: "non-strict base64", env: () => envelope([{ ...goodFile, contentBase64: `${goodFile.contentBase64}\n` }]), reason: /strict base64/ },
    {
      name: "oversize file (declared)",
      env: () => envelope([{ ...goodFile, byteLength: profile.caps.maxFileBytes + 1 }]),
      reason: /exceeds per-file cap/,
    },
    {
      name: "oversize file (actual bytes, declared honestly)",
      env: () => envelope([collected("tabulate/__init__.py", new Uint8Array(profile.caps.maxFileBytes + 1))]),
      reason: /exceeds per-file cap/,
    },
    { name: "too many files", env: () => envelope(Array.from({ length: profile.caps.maxFiles + 1 }, (_, i) => collected(`f${i}.py`, "x"))), reason: /file count/ },
    { name: "wrong schemaVersion", env: () => ({ ...envelope([goodFile]), schemaVersion: 2 as unknown as 1 }), reason: /schemaVersion/ },
    { name: "rejected not an array", env: () => ({ ...envelope([goodFile]), rejected: null as unknown as [] }), reason: /rejected/ },
  ];
  for (const r of rejections) {
    test(`rejects: ${r.name}`, () => {
      const result = validateEnvelope(r.env(), profile);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reasons.join("\n")).toMatch(r.reason);
    });
  }

  test("rejects total bytes over cap with a wider profile", () => {
    const wide = { ...profile, allowedReplacementPaths: ["a.py", "b.py"], caps: { ...profile.caps, maxFileBytes: 10, maxTotalBytes: 15 } };
    const r = validateEnvelope(envelope([collected("a.py", "0123456789"), collected("b.py", "0123456789")]), wide);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons.join()).toMatch(/total .* exceeds cap/);
  });

  test("never decodes a payload longer than the per-file cap allows", () => {
    const huge = { ...goodFile, byteLength: 5, contentBase64: "A".repeat(Math.ceil(profile.caps.maxFileBytes / 3) * 4 + 4) };
    const r = validateEnvelope(envelope([huge]), profile);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons.join()).toMatch(/encoded content exceeds/);
  });

  test("garbage input does not throw", () => {
    expect(validateEnvelope(null as unknown as FileEnvelope, profile).ok).toBe(false);
    expect(validateEnvelope({ schemaVersion: 1, files: [null, 1, "x"] as unknown as CollectedFile[], rejected: [] }, profile).ok).toBe(false);
  });
});

describe("buildManifest and digest determinism", () => {
  test("replacements are sorted and profile identity is carried", async () => {
    const wide = { ...profile, allowedReplacementPaths: ["z.py", "a.py"] };
    const m = buildManifest(wide, [collected("z.py", "z"), collected("a.py", "a")]);
    SourceManifest.parse(m);
    expect(m.replacements.map((r) => r.path)).toEqual(["a.py", "z.py"]);
    expect(m.baselineCommit).toBe(profile.baselineCommit);
    expect(m.baselineTreeDigest).toBe(profile.baselineTreeDigest);
    expect(m.profileId).toBe(profile.id);
    expect(Object.keys(m.replacements[0] ?? {}).sort()).toEqual(["byteLength", "path", "sha256"]);
    // Order of input files does not change the digest.
    const m2 = buildManifest(wide, [collected("a.py", "a"), collected("z.py", "z")]);
    expect(await candidateDigestOf(m)).toBe(await candidateDigestOf(m2));
    expect(canonicalJson(m)).toBe(canonicalJson(m2));
  });

  test("a one-byte change to a file changes the candidate digest", async () => {
    const m1 = buildManifest(profile, [collected("tabulate/__init__.py", "a\n")]);
    const m2 = buildManifest(profile, [collected("tabulate/__init__.py", "b\n")]);
    expect(await candidateDigestOf(m1)).not.toBe(await candidateDigestOf(m2));
  });
});

async function patchAvailable(): Promise<boolean> {
  try {
    const p = Bun.spawn(["patch", "--version"], { stdout: "pipe", stderr: "pipe" });
    return (await p.exited) === 0;
  } catch {
    return false;
  }
}

/** Applies a unified diff with `patch -p1` in a temp dir and returns the resulting text. */
async function applyWithPatch(path: string, base: string, diff: string, dryRun: boolean): Promise<{ code: number; result: string; out: string }> {
  const dir = await tmp();
  const target = join(dir, path);
  await Bun.write(target, base);
  await Bun.write(join(dir, "p.diff"), diff);
  const args = ["patch", "-p1", ...(dryRun ? ["--dry-run"] : []), "-i", "p.diff"];
  const p = Bun.spawn(args, { cwd: dir, stdout: "pipe", stderr: "pipe" });
  const out = (await new Response(p.stdout).text()) + (await new Response(p.stderr).text());
  const code = await p.exited;
  const result = dryRun ? base : await readFile(target, "utf8");
  return { code, result, out };
}

const hasPatch = await patchAvailable();

describe("unifiedDiff", () => {
  test("identical inputs produce an empty diff", () => {
    expect(unifiedDiff("x.py", "a\nb\n", "a\nb\n")).toBe("");
  });

  test("headers and hunk format", () => {
    const d = unifiedDiff("dir/x.py", "one\ntwo\nthree\n", "one\n2\nthree\n");
    expect(d.startsWith("--- a/dir/x.py\n+++ b/dir/x.py\n@@ -1,3 +1,3 @@\n one\n-two\n+2\n three\n")).toBe(true);
  });

  test("marks missing trailing newline", () => {
    const d = unifiedDiff("x", "a\nb", "a\nc");
    expect(d).toContain("-b\n\\ No newline at end of file\n+c\n\\ No newline at end of file\n");
  });

  test("new file diff is against /dev/null", () => {
    const d = unifiedDiff("n.py", "", "hello\n");
    expect(d).toContain("--- /dev/null\n+++ b/n.py\n@@ -0,0 +1 @@\n+hello\n");
  });

  test("separate hunks for distant changes", () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i}`);
    const changed = [...lines];
    changed[3] = "changed 3";
    changed[35] = "changed 35";
    const d = unifiedDiff("x", `${lines.join("\n")}\n`, `${changed.join("\n")}\n`);
    expect(d.match(/^@@ /gm)?.length).toBe(2);
  });

  test("large edit distance still produces a valid replacement diff", () => {
    const a = Array.from({ length: 6000 }, (_, i) => `a${i}`).join("\n") + "\n";
    const b = Array.from({ length: 6000 }, (_, i) => `b${i}`).join("\n") + "\n";
    const d = unifiedDiff("x", a, b);
    expect(d.split("\n").filter((l) => l.startsWith("-a")).length).toBe(6000);
    expect(d.split("\n").filter((l) => l.startsWith("+b")).length).toBe(6000);
  });

  const roundTrips: { name: string; base: string; cand: string }[] = [
    { name: "single line change", base: "one\ntwo\nthree\n", cand: "one\n2\nthree\n" },
    { name: "insert at top", base: "b\nc\n", cand: "a\nb\nc\n" },
    { name: "delete at end", base: "a\nb\nc\n", cand: "a\nb\n" },
    { name: "no trailing newline both", base: "a\nb", cand: "a\nc" },
    { name: "add trailing newline", base: "a\nb", cand: "a\nb\n" },
    { name: "remove trailing newline", base: "a\nb\n", cand: "a\nb" },
    { name: "many hunks", base: Array.from({ length: 100 }, (_, i) => `l${i}`).join("\n") + "\n", cand: Array.from({ length: 100 }, (_, i) => (i % 17 === 0 ? `L${i}` : `l${i}`)).join("\n") + "\n" },
    { name: "insert block in middle", base: "a\nb\nc\nd\ne\nf\ng\nh\n", cand: "a\nb\nc\nd\nX\nY\nZ\ne\nf\ng\nh\n" },
    { name: "empty to content", base: "", cand: "x\ny\n" },
    { name: "moved lines", base: "1\n2\n3\n4\n5\n6\n7\n8\n9\n", cand: "4\n5\n6\n1\n2\n3\n7\n8\n9\n" },
    ...(baseInit ? [{ name: "tabulate diagnostic candidate vs base", base: baseInit, cand: diagnosticInit }] : []),
  ];
  for (const rt of roundTrips) {
    test.skipIf(!hasPatch)(`round-trips through patch -p1: ${rt.name}`, async () => {
      const d = unifiedDiff("tabulate/__init__.py", rt.base, rt.cand);
      const dry = await applyWithPatch("tabulate/__init__.py", rt.base, d, true);
      expect(dry.code, dry.out).toBe(0);
      const real = await applyWithPatch("tabulate/__init__.py", rt.base, d, false);
      expect(real.code, real.out).toBe(0);
      expect(real.result).toBe(rt.cand);
    });
  }
});

describe("ArtifactStore", () => {
  test("blobs are content-addressed and idempotent", async () => {
    const store = new ArtifactStore(await tmp());
    const bytes = enc.encode("hello");
    const id = await store.putBlob(bytes);
    expect(id).toBe(sha(bytes));
    expect(await store.putBlob(bytes)).toBe(id);
    expect(Array.from((await store.getBlob(id)) ?? [])).toEqual(Array.from(bytes));
    expect(await store.getBlob("f".repeat(64))).toBeNull();
    expect(await store.getBlob("../x")).toBeNull();
  });

  test("a corrupted blob on disk is detected on read", async () => {
    const dir = await tmp();
    const store = new ArtifactStore(dir);
    const id = await store.putBlob(enc.encode("data"));
    await writeFile(join(dir, "blobs", id), "tampered");
    await expect(store.getBlob(id)).rejects.toThrow(/corrupt/);
  });

  test("immutable JSON: first write wins, later writes are refused and leave bytes untouched", async () => {
    const dir = await tmp();
    const store = new ArtifactStore(dir);
    expect(await store.putImmutableJson("verification", "v-1", { passed: false, b: 1, a: 2 })).toBe(true);
    expect(await store.putImmutableJson("verification", "v-1", { passed: true })).toBe(false);
    const text = await readFile(join(dir, "verification", "v-1.json"), "utf8");
    expect(text).toBe('{"a":2,"b":1,"passed":false}');
    expect(await store.getJson<{ passed: boolean; a: number; b: number }>("verification", "v-1")).toEqual({ a: 2, b: 1, passed: false });
    expect(await store.getJson("verification", "missing")).toBeNull();
    const st = await stat(join(dir, "verification", "v-1.json"));
    expect(st.isFile()).toBe(true);
  });

  test("concurrent identical writers: exactly one succeeds", async () => {
    const store = new ArtifactStore(await tmp());
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => store.putImmutableJson("k", "same", { i })));
    expect(results.filter(Boolean).length).toBe(1);
  });

  test("kind and id are validated against traversal", async () => {
    const dir = await tmp();
    const store = new ArtifactStore(dir);
    await expect(store.putImmutableJson("../k", "x", {})).rejects.toThrow(/invalid kind/);
    await expect(store.putImmutableJson("k", "..", {})).rejects.toThrow(/invalid id/);
    await expect(store.putImmutableJson("k", "a/b", {})).rejects.toThrow(/invalid id/);
    await expect(store.getJson("k", "")).rejects.toThrow(/invalid id/);
    expect((await readdir(dir)).length).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------
// exportBundle + zipFiles
// ---------------------------------------------------------------------------------------------

function record(role: "baseline" | "candidate", candidateDigest: string, passed: boolean): VerificationRecord {
  return {
    schemaVersion: 1,
    id: role === "baseline" ? "rec-base" : "rec-cand",
    taskId: "task-1",
    role,
    candidateDigest,
    runtimeImageDigest: "sha256:img",
    adapterDigest: "b".repeat(64),
    contractDigest: "c".repeat(64),
    comparatorVersion: "1.0.0",
    cases: [
      { caseId: "reported-empty-headers-maxheader", kind: "reported", expected: { kind: "raises", exceptionType: "IndexError" }, passed, reason: "r" },
    ],
    requiredCases: 1,
    completedCases: 1,
    exec: { status: "succeeded", exitCode: 0, stdout: "", stderr: "", truncated: false, timedOut: false, durationMs: 1 },
    runtimeProfile: {
      host: { checkedAt: NOW, dockerVersion: "28", cpuVirtualization: true, kvmPresent: true, kvmReadWrite: true, availableRuntimes: ["kata"], selectedRuntime: "kata", devUnsafe: false },
      inspection: {
        inspectedAt: NOW,
        container: "c",
        runtime: "kata",
        devUnsafe: false,
        imageDigest: "sha256:img",
        guestUname: "Linux",
        guestHostname: "h",
        checks: { networkNone: true, nonRootUser: true, readOnlyRootfs: true, capDropAll: true, noNewPrivileges: true, pidsLimited: true, memoryLimited: true, cpuLimited: true, noHostBinds: true, noPorts: true, privateIpc: true, restartDisabled: true, ownedLabels: true },
        allPassed: true,
      },
      teardown: { destroyedAt: NOW, containersRemaining: [], volumesRemaining: [], clean: true },
    },
    passed,
    createdAt: NOW,
  };
}

const task: Task = {
  id: "task-1",
  owner: "operator",
  profileId: "tabulate-365",
  issueText: "empty table crash",
  status: "done",
  phase: "ready",
  outcome: "CANDIDATE_PASSED_CHECKS",
  generation: 1,
  leaseId: "lease-secret",
  leaseUntil: null,
  attempts: 1,
  budget: { modelCallsUsed: 3, repairAttemptsUsed: 1 },
  createdAt: NOW,
  updatedAt: NOW,
};

async function makeBundle(candidateText: string, baseText: string): Promise<{ bundle: CandidateBundle; baseFiles: Record<string, string> }> {
  const file = collected("tabulate/__init__.py", candidateText);
  const manifest = buildManifest(profile, [file]);
  const bundle: CandidateBundle = { manifest, candidateDigest: await candidateDigestOf(manifest), files: [file] };
  return { bundle, baseFiles: { "tabulate/__init__.py": baseText } };
}

const events: RunEvent[] = [
  { id: "ev-1", taskId: "task-1", seq: 0, at: NOW, kind: "phase", title: "prepare", detail: "" },
  { id: "ev-2", taskId: "task-1", seq: 1, at: NOW, kind: "check", title: "verify", detail: "passed" },
];

describe("exportBundle", () => {
  const baseText = "def f():\n    return [][0]\n";
  const candText = "def f():\n    return 0\n";

  test("produces the documented files with a patch that applies", async () => {
    const { bundle, baseFiles } = await makeBundle(candText, baseText);
    const out = await exportBundle({ profile, baseFiles, bundle, verification: record("candidate", bundle.candidateDigest, true), baseline: record("baseline", bundle.candidateDigest, true), task, events });
    const paths = out.files.map((f) => f.path);
    for (const p of ["patch.diff", "manifest.json", "verification.json", "baseline.json", "README.txt", "reproduction/README.txt", "reproduction/files/tabulate/__init__.py", "events.jsonl", "task.json"]) {
      expect(paths).toContain(p);
    }
    const text = (p: string) => new TextDecoder().decode(out.files.find((f) => f.path === p)?.bytes);
    expect(text("patch.diff")).toContain("--- a/tabulate/__init__.py\n+++ b/tabulate/__init__.py\n");
    expect(text("patch.diff").startsWith("diff --git a/tabulate/__init__.py b/tabulate/__init__.py\n")).toBe(true);
    expect(JSON.parse(text("manifest.json"))).toEqual(bundle.manifest);
    expect(JSON.parse(text("verification.json")).candidateDigest).toBe(bundle.candidateDigest);
    expect(text("README.txt")).toContain('"Passed these checks"');
    expect(text("README.txt")).toContain("does NOT mean");
    expect(text("README.txt")).toContain("not mean the change is safe");
    expect(text("reproduction/README.txt")).toContain("patch -p1");
    expect(text("reproduction/README.txt")).toContain(profile.baselineCommit);
    expect(text("task.json")).not.toContain("lease-secret");
    expect(text("events.jsonl").trim().split("\n").length).toBe(2);
    if (await patchAvailable()) {
      const applied = await applyWithPatch("tabulate/__init__.py", baseText, text("patch.diff"), false);
      expect(applied.code, applied.out).toBe(0);
      expect(applied.result).toBe(candText);
    }
  });

  test("output is byte-for-byte reproducible", async () => {
    const { bundle, baseFiles } = await makeBundle(candText, baseText);
    const input = { profile, baseFiles, bundle, verification: record("candidate", bundle.candidateDigest, true), baseline: record("baseline", bundle.candidateDigest, true), task, events };
    const a = zipFiles((await exportBundle(input)).files);
    const b = zipFiles((await exportBundle(input)).files);
    expect(sha(a)).toBe(sha(b));
  });

  test("refuses a bundle whose digest does not match its manifest", async () => {
    const { bundle, baseFiles } = await makeBundle(candText, baseText);
    const forged = { ...bundle, candidateDigest: "d".repeat(64) };
    await expect(exportBundle({ profile, baseFiles, bundle: forged, verification: record("candidate", forged.candidateDigest, true), baseline: record("baseline", forged.candidateDigest, true), task, events })).rejects.toThrow(/candidateDigest/);
  });

  test("refuses a verification record for another candidate", async () => {
    const { bundle, baseFiles } = await makeBundle(candText, baseText);
    await expect(exportBundle({ profile, baseFiles, bundle, verification: record("candidate", "e".repeat(64), true), baseline: record("baseline", bundle.candidateDigest, true), task, events })).rejects.toThrow(/different candidate/);
  });

  test("refuses bytes that changed after sealing", async () => {
    const { bundle, baseFiles } = await makeBundle(candText, baseText);
    const swapped = { ...bundle, files: [collected("tabulate/__init__.py", "def f():\n    return 1\n")] };
    await expect(exportBundle({ profile, baseFiles, bundle: swapped, verification: record("candidate", bundle.candidateDigest, true), baseline: record("baseline", bundle.candidateDigest, true), task, events })).rejects.toThrow(/do not match the manifest/);
  });

  test("refuses out-of-scope files even with a consistent manifest", async () => {
    const extra = collected("setup.py", "x");
    const file = collected("tabulate/__init__.py", candText);
    const manifest = { ...buildManifest(profile, [file]), replacements: [...buildManifest(profile, [file]).replacements, { path: extra.path, byteLength: extra.byteLength, sha256: extra.sha256 }] };
    const bundle: CandidateBundle = { manifest, candidateDigest: await candidateDigestOf(manifest), files: [file, extra] };
    await expect(exportBundle({ profile, baseFiles: { "tabulate/__init__.py": baseText }, bundle, verification: record("candidate", bundle.candidateDigest, true), baseline: record("baseline", bundle.candidateDigest, true), task, events })).rejects.toThrow(/outside allowed paths/);
  });
});

describe("zipFiles", () => {
  test("crc32 matches the reference value", () => {
    expect(crc32(enc.encode("123456789")).toString(16)).toBe("cbf43926");
    expect(crc32(new Uint8Array(0))).toBe(0);
  });

  test("writes a store-only archive with sorted entries, fixed timestamps and a valid EOCD", () => {
    const zip = zipFiles([
      { path: "b.txt", bytes: enc.encode("bee") },
      { path: "a/c.txt", bytes: enc.encode("sea") },
    ]);
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    expect(view.getUint32(0, true)).toBe(0x04034b50);
    expect(view.getUint16(8, true)).toBe(0); // store
    expect(view.getUint16(10, true)).toBe(0);
    expect(view.getUint16(12, true)).toBe(0x0021);
    const eocd = zip.byteLength - 22;
    expect(view.getUint32(eocd, true)).toBe(0x06054b50);
    expect(view.getUint16(eocd + 10, true)).toBe(2);
    const text = new TextDecoder("latin1").decode(zip);
    expect(text.indexOf("a/c.txt")).toBeLessThan(text.indexOf("b.txt"));
    expect(sha(zip)).toBe(sha(zipFiles([{ path: "a/c.txt", bytes: enc.encode("sea") }, { path: "b.txt", bytes: enc.encode("bee") }])));
  });

  test("rejects duplicate and traversal entries", () => {
    expect(() => zipFiles([{ path: "a", bytes: new Uint8Array(0) }, { path: "a", bytes: new Uint8Array(0) }])).toThrow(/duplicate/);
    expect(() => zipFiles([{ path: "../a", bytes: new Uint8Array(0) }])).toThrow(/invalid entry path/);
    expect(() => zipFiles([{ path: "/a", bytes: new Uint8Array(0) }])).toThrow(/invalid entry path/);
  });

  test("archive is readable by the system unzip when available", async () => {
    const dir = await tmp();
    const zip = zipFiles([{ path: "x/y.txt", bytes: enc.encode("payload\n") }, { path: "README.txt", bytes: enc.encode("hi") }]);
    await Bun.write(join(dir, "b.zip"), zip);
    let p;
    try {
      p = Bun.spawn(["unzip", "-t", "b.zip"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    } catch {
      return; // unzip not installed; the structural test above still ran
    }
    const out = await new Response(p.stdout).text();
    const code = await p.exited;
    if (code === 127) return;
    expect(code, out).toBe(0);
    expect(out).toContain("No errors detected");
  });
});

describe("validateEnvelope: collector rejections and required files (M9)", () => {
  const goodFile = collected("tabulate/__init__.py", "print('candidate')\n");
  const basePaths = ["tabulate/__init__.py", "README.md"];
  for (const reason of ["symlink", "hard link (st_nlink=2)", "not a regular file", "exceeds maxFileBytes (1048576)", "invalid path in allowlist", "duplicate", "unreadable: PermissionError"]) {
    test(`a rejection of the allowed file refuses the seal: ${reason}`, () => {
      const r = validateEnvelope(envelope([], [{ path: "tabulate/__init__.py", reason }]), profile, { basePaths });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.reasons.join("\n")).toContain(`tabulate/__init__.py: rejected by the collector (${reason}`);
        expect(r.inconclusive).toBeUndefined();
      }
    });
  }

  test("a rejection naming a case/normalization variant of the allowed path is a conflict and refuses the seal", () => {
    const r = validateEnvelope(envelope([goodFile], [{ path: "tabulate/__INIT__.py", reason: "conflicting" }]), profile, { basePaths });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons.join()).toMatch(/rejected by the collector \(conflicting; reported as/);
  });

  test("a missing allowed file that exists in the base tree is required: refused", () => {
    const r = validateEnvelope(envelope([], [{ path: "tabulate/__init__.py", reason: "missing" }]), profile, { basePaths });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons.join()).toContain("required file is missing from the candidate (present in the base tree)");
  });

  test("without the base tree a missing allowed file fails closed", () => {
    const r = validateEnvelope(envelope([], [{ path: "tabulate/__init__.py", reason: "missing" }]), profile);
    expect(r.ok).toBe(false);
  });

  test("a missing allowed path that is NOT in the base tree is an optional slot: accepted", () => {
    const wide = { ...profile, allowedReplacementPaths: ["tabulate/__init__.py", "tabulate/new_helper.py"] };
    const r = validateEnvelope(envelope([goodFile], [{ path: "tabulate/new_helper.py", reason: "missing" }]), wide, { basePaths });
    expect(r.ok).toBe(true);
  });

  test("a base-tree allowed file the collector neither returned nor rejected refuses the seal", () => {
    const r = validateEnvelope(envelope([]), profile, { basePaths });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons.join()).toContain("neither collected nor rejected");
  });

  test("rejections outside the allowlist (scratch files) are ignored and returned for the event", () => {
    const r = validateEnvelope(envelope([goodFile], [{ path: "scratch/repro.py", reason: "symlink" }, { path: "../../etc/passwd", reason: "invalid path" }]), profile, { basePaths });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.ignored).toEqual([{ path: "scratch/repro.py", reason: "symlink" }, { path: "../../etc/passwd", reason: "invalid path" }]);
  });

  test("a malformed envelope is a collector fault (inconclusive), not the candidate's failure", () => {
    const r = validateEnvelope({ ...envelope([goodFile]), rejected: [{ path: 3, reason: null }] as unknown as FileEnvelope["rejected"] }, profile, { basePaths });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.inconclusive).toBe(true);
    const v = validateEnvelope({ ...envelope([goodFile]), schemaVersion: 2 as unknown as 1 }, profile, { basePaths });
    expect(!v.ok && v.inconclusive).toBe(true);
  });
});

describe("digest ordering is locale-independent (D13)", () => {
  const paths = ["a.py", "B.py", "_.py", "ä.py", "z.py", "\u{1F600}.py", "�.py"];
  const codePointOrder = [...paths].sort((x, y) => {
    const a = [...x].map((c) => c.codePointAt(0)!);
    const b = [...y].map((c) => c.codePointAt(0)!);
    for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
    return a.length - b.length;
  });

  test("buildManifest orders by code point, never by the process collation", () => {
    const wide = { ...profile, allowedReplacementPaths: paths };
    const m = buildManifest(wide, paths.map((p) => collected(p, p)).reverse());
    expect(m.replacements.map((r) => r.path)).toEqual(codePointOrder);
    // localeCompare / a collator would order the same inputs differently, and differently per locale.
    const en = [...paths].sort(new Intl.Collator("en").compare);
    const sv = [...paths].sort(new Intl.Collator("sv").compare);
    expect(en).not.toEqual(codePointOrder);
    expect(sv).not.toEqual(en);
    expect([..."aB_"].sort((x, y) => x.localeCompare(y))).not.toEqual(["B", "_", "a"]);
    expect(m.replacements.slice(0, 3).map((r) => r.path)).toEqual(["B.py", "_.py", "a.py"]);
  });

  test("the digest is identical whatever the input order, and validateEnvelope sorts the same way", async () => {
    const wide = { ...profile, allowedReplacementPaths: paths, caps: { ...profile.caps, maxFiles: 16 } };
    const files = paths.map((p) => collected(p, p));
    const d1 = await candidateDigestOf(buildManifest(wide, files));
    const d2 = await candidateDigestOf(buildManifest(wide, [...files].reverse()));
    expect(d1).toBe(d2);
    const v = validateEnvelope(envelope([...files].reverse()), wide);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.files.map((f) => f.path)).toEqual(codePointOrder);
  });
});
