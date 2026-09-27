// Download/upload rules that need no Chromium: op validation, the download ledger (count, in-progress
// size abort, total bytes, completion re-check), and media-type sniffing. `node --test runtime/browser/test/`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DownloadLedger } from "../src/downloads.mjs";
import { MAX_DOWNLOADS, MAX_DOWNLOAD_BYTES, MAX_DOWNLOAD_TOTAL_BYTES, MUTATING_OPS, parseRequest, sniffMediaType } from "../src/protocol.mjs";

const req = (op, args) => parseRequest(JSON.stringify({ schemaVersion: 1, id: "r1", op, ...(args === undefined ? {} : { args }) }));
const MiB = 1024 * 1024;

test("download.list / download.read / upload requests validate strictly", () => {
  assert.deepEqual(req("download.list").request.args, {});
  assert.deepEqual(req("download.read", { downloadId: "dl-3" }).request.args, { downloadId: "dl-3", offset: 0 });
  assert.deepEqual(req("download.read", { downloadId: "dl-3", offset: 2 * MiB }).request.args, { downloadId: "dl-3", offset: 2 * MiB });
  const sha = "a".repeat(64);
  assert.deepEqual(req("upload", { ref: "e4", generation: 2, uploadId: "up-0123456789abcdef", filename: "report.csv", sha256: sha }).request.args, {
    ref: "e4", generation: 2, uploadId: "up-0123456789abcdef", filename: "report.csv", sha256: sha,
  });
  const code = (op, args) => req(op, args).response?.error;
  assert.equal(code("download.list", { all: true }), "invalid_request");
  assert.equal(code("download.read", { downloadId: "../etc/passwd" }), "invalid_request");
  assert.equal(code("download.read", { downloadId: "dl-1", offset: -1 }), "invalid_request");
  assert.equal(code("download.read", { downloadId: "dl-1", offset: MAX_DOWNLOAD_BYTES + 1 }), "invalid_request");
  assert.equal(code("upload", { ref: "e4", generation: 2, uploadId: "up-0123456789abcdef", filename: "../x", sha256: sha }), "invalid_request");
  assert.equal(code("upload", { ref: "e4", generation: 2, uploadId: "up-0123456789abcdef", filename: ".bashrc", sha256: sha }), "invalid_request");
  assert.equal(code("upload", { ref: "e4", generation: 2, uploadId: "/etc", filename: "x", sha256: sha }), "invalid_request");
  assert.equal(code("upload", { ref: "e4", generation: 2, uploadId: "up-0123456789abcdef", filename: "x", sha256: sha, path: "/etc/passwd" }), "invalid_request");
  assert.equal(code("upload", { ref: "e4", generation: 2, uploadId: "up-0123456789abcdef", filename: "x", sha256: "A".repeat(64) }), "invalid_request");
  assert.equal(MUTATING_OPS.has("upload"), true);
});

test("ledger: at most MAX_DOWNLOADS are admitted; later ones are cancelled at once (count_limit)", () => {
  const ledger = new DownloadLedger();
  for (let i = 0; i < MAX_DOWNLOADS; i++) {
    const r = ledger.begin({ suggestedFilename: `f${i}.csv`, url: "https://x/", tabId: "tab-1" });
    assert.equal(r.state, "in_progress");
    assert.equal(ledger.complete(r.downloadId, { bytes: 10, sha256: "0".repeat(64), mediaType: "text/csv" }), null);
  }
  const over = ledger.begin({ suggestedFilename: "late.csv", url: "https://x/", tabId: "tab-1" });
  assert.equal(over.state, "cancelled");
  assert.equal(over.reason, "count_limit");
  assert.equal(ledger.admitted, MAX_DOWNLOADS);
});

test("ledger: in-progress abort when a partial file exceeds 10 MiB, or completed + partial bytes exceed 30 MiB", () => {
  const ledger = new DownloadLedger();
  assert.equal(ledger.progress([MAX_DOWNLOAD_BYTES]), null);
  assert.equal(ledger.progress([MAX_DOWNLOAD_BYTES + 1]), "size_limit");
  for (let i = 0; i < 2; i++) {
    const r = ledger.begin({ suggestedFilename: "a", url: "u", tabId: null });
    assert.equal(ledger.complete(r.downloadId, { bytes: 10 * MiB, sha256: "0".repeat(64), mediaType: "application/octet-stream" }), null);
  }
  assert.equal(ledger.completedBytes, 20 * MiB);
  const r = ledger.begin({ suggestedFilename: "b", url: "u", tabId: null });
  assert.equal(ledger.progress([6 * MiB, 4 * MiB]), null);
  assert.equal(ledger.progress([6 * MiB, 4 * MiB + 1]), "total_limit");
  assert.equal(ledger.cancel(r.downloadId, "total_limit"), true);
  assert.equal(ledger.get(r.downloadId).state, "cancelled");
  assert.equal(ledger.cancel(r.downloadId, "again"), false);
});

test("ledger: completion re-checks the final size and the total", () => {
  const ledger = new DownloadLedger({ maxTotalBytes: 15 * MiB });
  const a = ledger.begin({ suggestedFilename: "a", url: "u", tabId: null });
  assert.equal(ledger.complete(a.downloadId, { bytes: MAX_DOWNLOAD_BYTES + 1, sha256: "0".repeat(64), mediaType: "x" }), "size_limit");
  const b = ledger.begin({ suggestedFilename: "b", url: "u", tabId: null });
  assert.equal(ledger.complete(b.downloadId, { bytes: 10 * MiB, sha256: "0".repeat(64), mediaType: "x" }), null);
  const c = ledger.begin({ suggestedFilename: "c", url: "u", tabId: null });
  assert.equal(ledger.complete(c.downloadId, { bytes: 6 * MiB, sha256: "0".repeat(64), mediaType: "x" }), "total_limit");
  assert.equal(ledger.list().downloads.map((d) => d.state).join(","), "cancelled,completed,cancelled");
  assert.equal(ledger.list().limits.maxTotalBytes, 15 * MiB);
  assert.equal(MAX_DOWNLOAD_TOTAL_BYTES, 30 * MiB);
});

test("ledger: records are bounded; cancelled ones are dropped first", () => {
  const ledger = new DownloadLedger({ maxCount: 1, maxRecords: 3 });
  const kept = ledger.begin({ suggestedFilename: "a", url: "u", tabId: null });
  for (let i = 0; i < 10; i++) ledger.begin({ suggestedFilename: `x${i}`, url: "u", tabId: null });
  assert.equal(ledger.records.size, 3);
  assert.equal(ledger.get(kept.downloadId).state, "in_progress");
});

test("sniffMediaType trusts bytes, not names", () => {
  const b = (s) => Buffer.from(s);
  assert.equal(sniffMediaType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]), "x.csv"), "image/png");
  assert.equal(sniffMediaType(b("%PDF-1.7"), "x.txt"), "application/pdf");
  assert.equal(sniffMediaType(Buffer.from([0x50, 0x4b, 0x03, 0x04]), "x.xlsx"), "application/zip");
  assert.equal(sniffMediaType(b('{"a":1}'), "x"), "application/json");
  assert.equal(sniffMediaType(b("a,b\n1,2\n"), "data"), "text/csv");
  assert.equal(sniffMediaType(b("a,b\n1,2\n"), "report.CSV"), "text/csv");
  assert.equal(sniffMediaType(b("a\tb\n1\t2\n"), "data"), "text/tab-separated-values");
  assert.equal(sniffMediaType(b("hello world"), "x.csv"), "text/csv");
  assert.equal(sniffMediaType(b("hello world"), "x"), "text/plain");
  assert.equal(sniffMediaType(Buffer.from([0xc3, 0x28]), "x.csv"), "application/octet-stream");
  assert.equal(sniffMediaType(b("a\0b"), "x.txt"), "application/octet-stream");
});
