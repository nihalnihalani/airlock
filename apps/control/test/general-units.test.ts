import { describe, expect, test } from "bun:test";
import { checkOutputFormat, checkSummarySchema, runCompletionChecks } from "../src/completion-checks.ts";
import { parseCsv } from "../src/csv.ts";
import { validateOutputEnvelope } from "../src/general-handler.ts";
import { encodePng, inspectPng } from "../src/png.ts";
import { TASK_PROFILES, hostAllowed, normalizeUrl, validateEgressAllow } from "../src/task-profiles.ts";
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
      screenshots: 0,
      sources: ["https://outside.example.net/"],
      visited: new Set(),
      egressAllow: ["stats.example.org"],
    });
    const failed = checks.filter((c) => !c.passed).map((c) => c.name);
    expect(failed.sort()).toEqual(["screenshot-evidence", "sources-in-policy", "sources-visited"]);
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
