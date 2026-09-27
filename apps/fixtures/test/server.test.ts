/** End to end through the real entry point: env config, Bun.serve, sqlite under the data dir. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mintApprovalCode, receiptsReadToken } from "../src/approval.ts";
import { formPayloadDigest, normalizeFields } from "../src/forms.ts";

const SECRET = "server-test-secret-0123456789-abcdefghijkl";
const PORT = 20000 + Math.floor(Math.random() * 20000);
const BASE = `http://127.0.0.1:${PORT}`;
const ORIGIN = "https://forms.example.test";
let dir: string;
let proc: ReturnType<typeof Bun.spawn>;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "airlock-fixtures-srv-"));
  proc = Bun.spawn(["bun", join(import.meta.dir, "../src/index.ts")], {
    env: { ...process.env, AIRLOCK_FIXTURES_ORIGIN: `${ORIGIN}/`, AIRLOCK_FORMS_SECRET: SECRET, AIRLOCK_FIXTURES_DATA_DIR: join(dir, "data"), AIRLOCK_FIXTURES_LISTEN: `127.0.0.1:${PORT}` },
    stdout: "pipe",
    stderr: "pipe",
  });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${BASE}/healthz`)).ok) return;
    } catch {}
    await Bun.sleep(50);
  }
  throw new Error("fixtures server did not start");
});

afterAll(() => {
  proc?.kill();
  rmSync(dir, { recursive: true, force: true });
});

test("real server: data page, approved submission, receipt", async () => {
  expect((await fetch(`${BASE}/data/regional-sales`)).headers.get("content-security-policy")).toContain("default-src 'none'");
  const fields = { sku: "SKU-9", quantity: "2", address: "1 Demo Street\nNowhere" };
  const n = normalizeFields("order-sample", fields);
  if (!n.ok) throw new Error(n.reason);
  // The origin from env is normalized (trailing slash dropped) before it is bound into the digest.
  const payloadDigest = await formPayloadDigest(ORIGIN, "order-sample", n.fields);
  const code = mintApprovalCode({ secret: SECRET, proposalId: "srv_1", payloadDigest, expiresAtEpoch: Math.floor(Date.now() / 1000) + 300 });
  const body = new URLSearchParams({ sku: "SKU-9", quantity: "2", address: "1 Demo Street\r\nNowhere", airlock_approval: code }).toString();
  const post = () => fetch(`${BASE}/f/order-sample/submit`, { method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded" } });
  expect((await post()).status).toBe(200);
  expect((await post()).status).toBe(403);
  const receipt = await fetch(`${BASE}/api/receipts/srv_1`, { headers: { authorization: `Bearer ${receiptsReadToken(SECRET)}` } });
  expect(await receipt.json()).toMatchObject({ status: "confirmed", payloadDigest });
  expect(existsSync(join(dir, "data", "fixtures.sqlite"))).toBe(true);
});

test("refuses to start with a short secret", async () => {
  const bad = Bun.spawn(["bun", join(import.meta.dir, "../src/index.ts")], {
    env: { ...process.env, AIRLOCK_FIXTURES_ORIGIN: ORIGIN, AIRLOCK_FORMS_SECRET: "short", AIRLOCK_FIXTURES_DATA_DIR: join(dir, "d2") },
    stdout: "pipe",
  });
  expect(await bad.exited).toBe(2);
});
