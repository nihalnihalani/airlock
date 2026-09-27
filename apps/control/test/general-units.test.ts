import { describe, expect, test } from "bun:test";
import { checkOutputFormat, checkSummarySchema, runCompletionChecks } from "../src/completion-checks.ts";
import { parseCsv } from "../src/csv.ts";
import { validateOutputEnvelope } from "../src/general-handler.ts";
import { encodePng, inspectPng } from "../src/png.ts";
import { TASK_PROFILES, hostAllowed, normalizeUrl, validateEgressAllow } from "../src/task-profiles.ts";
import { DIAGNOSTIC_LABEL, buildGeneralBundle } from "../src/general-export.ts";
import type { Task } from "@airlock/contracts";
import { VultrError, toWireMessages } from "../src/vultr-client.ts";
import { probeVision } from "../src/vultr-probe.ts";
import { createHash } from "node:crypto";

const enc = (s: string) => new TextEncoder().encode(s);
const profile = (id: string) => TASK_PROFILES.get(id)!;

describe("png", () => {
  test("encode → inspect round trip; malformed headers refused", () => {
    const png = encodePng(7, 5, [1, 2, 3]);
    expect(inspectPng(png)).toEqual({ ok: true, width: 7, height: 5 });
    const bad = new Uint8Array(png);
    bad[20] = bad[20]! ^ 0xff; // height byte → CRC mismatch
    expect(inspectPng(bad)).toMatchObject({ ok: false, reason: "IHDR CRC mismatch" });
    expect(inspectPng(enc("not a png at all, just text"))).toMatchObject({ ok: false });
  });
});

describe("csv", () => {
  test("quoted fields, CRLF, ragged rows", () => {
    expect(parseCsv('a,b\r\n"x, y","he said ""hi"""\r\n')).toEqual({ ok: true, rows: [["a", "b"], ["x, y", 'he said "hi"']] });
    expect(parseCsv("a,b\n1\n")).toMatchObject({ ok: false });
    expect(parseCsv('a\n"open')).toMatchObject({ ok: false, reason: "unterminated quoted field" });
  });
});

describe("egress policy", () => {
  test("validation and matching", () => {
    expect(validateEgressAllow(["Example.org", ".data.gov.uk"], profile("web-research"))).toEqual({ ok: true, hosts: ["example.org", ".data.gov.uk"] });
    for (const bad of ["1.2.3.4", "localhost", "foo.localhost", "db.internal", "nas.local", ".com", "intranet", "a.b.123"]) expect(validateEgressAllow([bad], profile("web-research")).ok).toBe(false);
    expect(validateEgressAllow(Array.from({ length: 17 }, (_, i) => `h${i}.example.org`), profile("web-research")).ok).toBe(false);
    expect(validateEgressAllow(["a.example.org", "a.example.org"], profile("web-research")).ok).toBe(false);
    expect(hostAllowed("example.org", ["example.org"])).toBe(true);
    expect(hostAllowed("sub.example.org", ["example.org"])).toBe(false);
    expect(hostAllowed("sub.example.org", [".example.org"])).toBe(true);
    expect(hostAllowed("example.org", [".example.org"])).toBe(false);
    expect(hostAllowed("evilexample.org", [".example.org"])).toBe(false);
    expect(normalizeUrl("https://A.example.org/x/#frag")).toBe("https://a.example.org/x");
  });
});

describe("egress policy: own host and wildcard DNS (L1)", () => {
  const p = profile("web-research");
  const opts = { ownHosts: ["airlock.example.org", "203-0-113-7.sslip.io"], exemptHosts: ["fixtures.203-0-113-7.sslip.io", "forms.203-0-113-7.sslip.io"] };
  test("the deployment's own host is refused, exactly or under a .suffix", () => {
    for (const bad of ["airlock.example.org", ".example.org", "203-0-113-7.sslip.io"]) {
      const r = validateEgressAllow([bad], p, opts);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reasons.join(" ")).toMatch(/own host|wildcard-DNS/);
    }
    expect(validateEgressAllow(["docs.example.org"], p, opts).ok).toBe(true);
    expect(validateEgressAllow(["airlock.example.org"], p).ok).toBe(true);
  });
  test("wildcard-DNS services are refused except the configured fixtures/forms hostnames", () => {
    for (const bad of ["127-0-0-1.sslip.io", "10.0.0.1.nip.io", "x.xip.io", "app.traefik.me", "localtest.me", "a.lvh.me", ".sslip.io", ".203-0-113-7.sslip.io", "nip.io"]) expect(validateEgressAllow([bad], p, opts).ok).toBe(false);
    expect(validateEgressAllow(["fixtures.203-0-113-7.sslip.io", "forms.203-0-113-7.sslip.io"], p, opts)).toEqual({ ok: true, hosts: ["fixtures.203-0-113-7.sslip.io", "forms.203-0-113-7.sslip.io"] });
    // An exemption is an exact hostname, never a suffix.
    expect(validateEgressAllow([".fixtures.203-0-113-7.sslip.io"], p, opts).ok).toBe(false);
    expect(validateEgressAllow(["sslip.io.example.org"], p, opts).ok).toBe(true);
  });
});

describe("general evidence bundle labels (S3)", () => {
  const base = { id: "task-0123456789abcdef", owner: "judge-x", profileId: "web-research", issueText: "goal", kind: "general", status: "done", phase: "ready", outcome: "RESULT_VERIFIED", generation: 1, leaseId: null, leaseUntil: null, attempts: 1, budget: { modelCallsUsed: 1, repairAttemptsUsed: 0, tokensUsed: 10 }, createdAt: "2026-09-27T00:00:00.000Z", updatedAt: "2026-09-27T00:00:00.000Z", result: { summary: "s", outputArtifactIds: [], sources: [], checks: [] } } as unknown as Task;
  const files = (task: Task) => {
    const out = buildGeneralBundle({ task, profile: profile("web-research"), inputs: [], artifacts: [], codeFiles: [], events: [] }).files;
    const text = (path: string) => new TextDecoder().decode(out.find((f) => f.path === path)!.bytes);
    return { result: JSON.parse(text("result.json")) as Record<string, unknown>, readme: text("README.txt") };
  };
  test("a scripted run is labelled DIAGNOSTIC in result.json and on the README's first line", () => {
    const d = files({ ...base, scriptedDriver: "general-hero" } as Task);
    expect(d.result).toMatchObject({ label: DIAGNOSTIC_LABEL, diagnostic: true, scriptedDriver: "general-hero", outcome: "RESULT_VERIFIED" });
    expect(d.readme.split("\n")[0]).toStartWith(DIAGNOSTIC_LABEL);
    const m = files(base);
    expect(m.result.diagnostic).toBeUndefined();
    expect(String(m.result.label)).toStartWith("VERIFIED");
    expect(m.readme.split("\n")[0]).toStartWith("Airlock evidence bundle");
  });
});

describe("completion checks", () => {
  test("formats and summary schema", () => {
    expect(checkOutputFormat("a.json", enc("{")).ok).toBe(false);
    expect(checkOutputFormat("a.csv", enc("h\n")).ok).toBe(false);
    expect(checkOutputFormat("a.csv", enc("h\n1\n")).ok).toBe(true);
    expect(checkOutputFormat("a.png", enc("fake png")).ok).toBe(false);
    expect(checkOutputFormat("a.png", encodePng(2, 2, [0, 0, 0])).ok).toBe(true);
    expect(checkOutputFormat("a.exe", enc("MZ")).ok).toBe(false);
    expect(checkSummarySchema(enc('{"answer":"South"}')).ok).toBe(true);
    expect(checkSummarySchema(enc('{"answer":""}')).ok).toBe(false);
    expect(checkSummarySchema(enc("[1]")).ok).toBe(false);
  });
  test("model claims are checked, not trusted", () => {
    const checks = runCompletionChecks({
      profile: profile("web-analysis"),
      claimed: ["outputs/summary.json"],
      collected: { files: [{ path: "summary.json", bytes: enc('{"answer":"x"}'), mediaType: "application/json" }], rejected: [] },
      screenshots: [],
      sources: ["https://outside.example.net/"],
      visited: new Set(),
      egressAllow: ["stats.example.org"],
    });
    const failed = checks.filter((c) => !c.passed).map((c) => c.name);
    expect(failed.sort()).toEqual(["screenshot-evidence", "sources-in-policy", "sources-visited"]);
  });
  // C41 O3: a screenshot is evidence only when it shows a cited source.
  const webResearch = (screenshots: { url?: string | null }[], sources = ["https://stats.example.org/table?year=2024"]) =>
    runCompletionChecks({ profile: profile("web-research"), claimed: [], collected: null, screenshots, sources, visited: new Set(sources.map((s) => normalizeUrl(s)!)), egressAllow: ["stats.example.org"] });
  const shotCheck = (checks: ReturnType<typeof runCompletionChecks>) => checks.find((c) => c.name === "screenshot-evidence")!;
  test("an about:blank screenshot does not satisfy screenshot-evidence", () => {
    const checks = webResearch([{ url: "about:blank" }, { url: null }]);
    expect(shotCheck(checks).passed).toBe(false);
    expect(shotCheck(checks).detail).toContain("about:blank");
    expect(checks.filter((c) => !c.passed).map((c) => c.name)).toEqual(["screenshot-evidence"]);
  });
  test("a screenshot of an unrelated page, or another path on the source's origin, does not count", () => {
    expect(shotCheck(webResearch([{ url: "https://stats.example.org/other" }])).passed).toBe(false);
    expect(shotCheck(webResearch([{ url: "http://stats.example.org/table" }])).passed).toBe(false);
    expect(shotCheck(webResearch([{ url: "https://example.com/table" }])).passed).toBe(false);
  });
  test("a screenshot of a cited source passes (hash, trailing slash, host case and parameter order ignored)", () => {
    const checks = webResearch([{ url: "about:blank" }, { url: "https://STATS.example.org/table/?year=2024#top" }]);
    expect(shotCheck(checks).passed).toBe(true);
    expect(shotCheck(checks).detail).toContain("https://stats.example.org/table?year=2024");
    expect(checks.every((c) => c.passed)).toBe(true);
  });
  test("a screenshot of the same path with a different query is a different document and does not count", () => {
    const checks = webResearch([{ url: "https://stats.example.org/table?year=2023" }]);
    expect(shotCheck(checks).passed).toBe(false);
  });
});

describe("output envelope re-validation", () => {
  const file = (path: string, bytes: Uint8Array, over: Record<string, unknown> = {}) => ({ path, byteLength: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex"), mediaType: "text/plain", contentBase64: Buffer.from(bytes).toString("base64"), ...over });
  test("digest, length, traversal and duplicates are refused", () => {
    expect(validateOutputEnvelope({ files: [file("a.txt", enc("hi"))] }).ok).toBe(true);
    expect(validateOutputEnvelope({ files: [file("a.txt", enc("hi"), { sha256: "0".repeat(64) })] }).ok).toBe(false);
    expect(validateOutputEnvelope({ files: [file("a.txt", enc("hi"), { byteLength: 3 })] }).ok).toBe(false);
    expect(validateOutputEnvelope({ files: [file("../a.txt", enc("hi"))] }).ok).toBe(false);
    expect(validateOutputEnvelope({ files: [file("A.txt", enc("hi")), file("a.txt", enc("hi"))] }).ok).toBe(false);
    expect(validateOutputEnvelope({ files: [file("a.txt", enc("hi"), { contentBase64: "aGk" })] }).ok).toBe(false);
  });
});

describe("vision wire format", () => {
  test("a user message with an image becomes OpenAI-compatible content parts", () => {
    const b64 = Buffer.from(encodePng(1, 1, [255, 0, 0])).toString("base64");
    const wire = toWireMessages("sys", [{ role: "user", content: "look", images: [{ mediaType: "image/png", base64: b64 }] }, { role: "user", content: "plain" }]) as { role: string; content: unknown }[];
    expect(wire[1]).toEqual({ role: "user", content: [{ type: "text", text: "look" }, { type: "image_url", image_url: { url: `data:image/png;base64,${b64}` } }] });
    expect(wire[2]).toEqual({ role: "user", content: "plain" });
    expect(() => toWireMessages("", [{ role: "user", content: "x", images: [{ mediaType: "image/png", base64: "not base64!" }] }])).toThrow(VultrError);
  });
  test("the vision probe passes only when the reply names the image's colour", async () => {
    const answer = (text: string) => ({ describe: () => ({ model: "m", host: "h" }), chat: async () => ({ text, toolCalls: [], usage: { input: 1, output: 1 } }) });
    let seen: unknown;
    const spy = { describe: () => ({ model: "m", host: "h" }), chat: async (input: { messages: unknown[] }) => ((seen = input.messages), { text: "Red.", toolCalls: [], usage: { input: 1, output: 1 } }) };
    expect(await probeVision("m", { baseUrl: "https://x", apiKey: "k", color: "red", driverFactory: () => spy })).toMatchObject({ ok: true, recognized: true, color: "red" });
    expect(JSON.stringify(seen)).toContain('"mediaType":"image/png"');
    expect((await probeVision("m", { baseUrl: "https://x", apiKey: "k", color: "red", driverFactory: () => answer("It is blue.") })).recognized).toBe(false);
    expect((await probeVision("m", { baseUrl: "https://x", apiKey: "k", color: "green", driverFactory: () => answer("red or green") })).recognized).toBe(false);
  });
});
