import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mintApprovalCode, receiptsReadToken } from "../src/approval.ts";
import { createApp, CSP, MAX_BODY_BYTES } from "../src/app.ts";
import { DATASETS } from "../src/data.ts";
import { formPayloadDigest, normalizeFields } from "../src/forms.ts";
import { DISCLOSURE } from "../src/html.ts";
import { ReceiptStore } from "../src/store.ts";

const ORIGIN = "https://forms.203-0-113-7.sslip.io";
const SECRET = "test-secret-for-airlock-fixtures-0123456789";
const NOW = 1_790_000_000;
const logs: Array<Record<string, unknown>> = [];
let store: ReceiptStore;
let app: ReturnType<typeof createApp>;
let now = NOW;

beforeEach(() => {
  store?.close();
  store = new ReceiptStore(":memory:");
  now = NOW;
  logs.length = 0;
  app = createApp({ origin: ORIGIN, secret: SECRET, store, nowEpoch: () => now, log: (l) => logs.push(l) });
});
afterAll(() => store?.close());

const get = (path: string, headers: Record<string, string> = {}, ip = "198.51.100.1") => app.fetch(new Request(`${ORIGIN}${path}`, { headers }), ip);

/** What Chromium sends: urlencoded pairs in document order, textarea line breaks as CRLF. */
function post(formId: string, pairs: Array<[string, string]>, opts: { contentType?: string; ip?: string; rawBody?: string } = {}) {
  const body = opts.rawBody ?? new URLSearchParams(pairs.map(([k, v]) => [k, v.replace(/\r?\n/g, "\r\n")])).toString();
  return app.fetch(
    new Request(`${ORIGIN}/f/${formId}/submit`, { method: "POST", body, headers: { "content-type": opts.contentType ?? "application/x-www-form-urlencoded" } }),
    opts.ip ?? "198.51.100.1",
  );
}

/** What the control plane does at approval time. */
async function approve(formId: string, fields: Record<string, string>, proposalId = "prop_1", expiresAtEpoch = NOW + 600) {
  const n = normalizeFields(formId, fields);
  if (!n.ok) throw new Error(n.reason);
  const payloadDigest = await formPayloadDigest(ORIGIN, formId, n.fields);
  return { code: mintApprovalCode({ secret: SECRET, proposalId, payloadDigest, expiresAtEpoch }), payloadDigest, proposalId };
}

const contact = { name: "Ada Lovelace", email: "ada@example.org", message: "Hello,\nplease call me back." };
const pairs = (fields: Record<string, string>, code?: string): Array<[string, string]> => [
  ...Object.entries(fields),
  ...(code === undefined ? [] : ([["airlock_approval", code]] as Array<[string, string]>)),
];
const auth = { authorization: `Bearer ${receiptsReadToken(SECRET)}` };

function expectSecurityHeaders(r: Response) {
  expect(r.headers.get("content-security-policy")).toBe(CSP);
  expect(r.headers.get("x-content-type-options")).toBe("nosniff");
}

describe("data page (hero task)", () => {
  const preText = (html: string) => /<pre id="csv">([\s\S]*?)<\/pre>/.exec(html)![1]!;
  /** The hero analysis (apps/control/test/fixtures/scripted-general/analysis.py) in TS. */
  const worst = (csv: string) => {
    const [, ...rows] = csv.trim().split("\n").map((l) => l.split(","));
    return rows.map(([r, rev, tgt]) => [r!, Number(rev) / Number(tgt)] as const).sort((a, b) => a[1] - b[1])[0]![0];
  };

  test("variant a matches the scripted-general fixture and is deterministic", async () => {
    const r1 = await get("/data/regional-sales");
    const body = await r1.text();
    expect(r1.status).toBe(200);
    expectSecurityHeaders(r1);
    expect(body).toContain(DISCLOSURE);
    expect(body).toContain("Synthetic data");
    expect(body).not.toMatch(/<script/i);
    expect(await (await get("/data/regional-sales")).text()).toBe(body);
    expect(await (await get("/data/regional-sales?variant=a")).text()).toBe(body);
    expect(preText(body)).toBe(DATASETS.a);
    const scripted = readFileSync(join(import.meta.dir, "../../control/test/fixtures/scripted-general/regional-sales.html"), "utf8");
    expect(preText(scripted)).toBe(DATASETS.a);
    expect(worst(DATASETS.a)).toBe("South");
    // Legacy path used by the scripted hero.
    expect(await (await get("/regional-sales.html")).text()).toBe(body);
  });

  test("variant b changes the numbers and the answer", async () => {
    const body = await (await get("/data/regional-sales?variant=b")).text();
    expect(preText(body)).toBe(DATASETS.b);
    expect(DATASETS.b).not.toBe(DATASETS.a);
    expect(DATASETS.b.split("\n")[0]).toBe("region,revenue,target");
    expect(worst(DATASETS.b)).toBe("North");
    expect(await (await get("/data/regional-sales?variant=b")).text()).toBe(body);
  });

  test("no line after the CSV block looks like a CSV row", async () => {
    const body = await (await get("/data/regional-sales"));
    const after = (await body.text()).split("</pre>")[1]!.replace(/<[^>]+>/g, "");
    for (const line of after.split("\n")) expect(line.split(",").length - 1).not.toBe(2);
  });

  test("CSV endpoint and unknown variant", async () => {
    const r = await get("/data/regional-sales.csv?variant=b");
    expect(r.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expectSecurityHeaders(r);
    expect(await r.text()).toBe(DATASETS.b);
    expect(await (await get("/data/regional-sales.csv")).text()).toBe(DATASETS.a);
    expect((await get("/data/regional-sales?variant=c")).status).toBe(400);
  });

  test("index, stylesheet, 404", async () => {
    const index = await get("/");
    expect(await index.text()).toContain(DISCLOSURE);
    const css = await get("/static/fixtures.css");
    expect(css.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect((await get("/nope")).status).toBe(404);
  });
});

describe("controlled form (airlock-forms-v1)", () => {
  test("form page: labelled plain inputs, approval code input, no script", async () => {
    const r = await get("/f/contact-request");
    const body = await r.text();
    expect(r.status).toBe(200);
    expectSecurityHeaders(r);
    expect(body).toContain(DISCLOSURE);
    expect(body).toContain('<form method="post" action="/f/contact-request/submit"');
    for (const name of ["name", "email", "airlock_approval"]) expect(body).toContain(`<input type="text" id="field-${name}" name="${name}"`);
    expect(body).toContain('<textarea id="field-message" name="message"');
    expect(body).toContain('<label for="field-airlock_approval">Approval code</label>');
    expect(body).not.toMatch(/<script|required/i);
    const order = await (await get("/f/order-sample")).text();
    for (const name of ["sku", "quantity"]) expect(order).toContain(`name="${name}"`);
    expect(order).toContain('<textarea id="field-address" name="address"');
    expect((await get("/f/unknown")).status).toBe(404);
  });

  test("exactly the approved values are accepted once; replay is refused", async () => {
    const { code, payloadDigest } = await approve("contact-request", contact);
    const r = await post("contact-request", pairs(contact, code));
    const body = await r.text();
    expect(r.status).toBe(200);
    expect(body).toContain("Submission accepted");
    expect(body).toContain(payloadDigest);
    const receiptId = /id="receipt-id">([^<]+)</.exec(body)![1]!;
    expect(receiptId).toMatch(/^rcpt_[A-Za-z0-9_-]{22}$/);

    const api = await get("/api/receipts/prop_1", auth);
    expect(api.status).toBe(200);
    expect(await api.json()).toEqual({ status: "confirmed", proposalId: "prop_1", formId: "contact-request", receiptId, payloadDigest, at: new Date(NOW * 1000).toISOString() });

    const replay = await post("contact-request", pairs(contact, code));
    expect(replay.status).toBe(403);
    expect(await replay.text()).toContain("approval:already_used");
    expect(store.get("prop_1")!.receiptId).toBe(receiptId);
  });

  test("any changed field is refused and nothing is stored", async () => {
    const { code } = await approve("contact-request", contact);
    for (const changed of [
      { ...contact, email: "attacker@example.org" },
      { ...contact, message: contact.message + " " },
      { ...contact, name: " Ada Lovelace" },
    ]) {
      const r = await post("contact-request", pairs(changed, code));
      expect(r.status).toBe(403);
      const body = await r.text();
      expect(body).toContain("Submission refused: no valid approval for exactly these values");
      expect(body).toContain("approval:mismatch");
      expect(body).not.toContain("attacker@example.org");
    }
    // Same values to a different form (same field names do not exist, but a code minted for another form fails).
    const other = await approve("order-sample", { sku: "a", quantity: "1", address: "x" }, "prop_2");
    expect((await post("contact-request", pairs(contact, other.code))).status).toBe(403);
    expect((await get("/api/receipts/prop_1", auth)).status).toBe(404);
    expect(store.get("prop_2")).toBeUndefined();
  });

  test("a refused attempt does not burn the approval", async () => {
    const { code } = await approve("contact-request", contact);
    expect((await post("contact-request", pairs({ ...contact, name: "x" }, code))).status).toBe(403);
    expect((await post("contact-request", pairs(contact, code))).status).toBe(200);
  });

  test("expired and too-far-future codes are refused", async () => {
    const { code } = await approve("contact-request", contact, "prop_exp", NOW + 60);
    now = NOW + 60;
    const r = await post("contact-request", pairs(contact, code));
    expect(r.status).toBe(403);
    expect(await r.text()).toContain("approval:expired");
    now = NOW;
    const far = await approve("contact-request", contact, "prop_far", NOW + 2 * 24 * 3600);
    expect(await (await post("contact-request", pairs(contact, far.code))).text()).toContain("approval:expiry_too_far");
    expect(store.get("prop_exp")).toBeUndefined();
  });

  test("missing, empty, malformed or duplicated approval code is refused (click, Enter and type-with-submit all land here)", async () => {
    const { code } = await approve("contact-request", contact);
    const cases: Array<[Array<[string, string]>, string]> = [
      [pairs(contact), "approval:missing"],
      [pairs(contact, ""), "approval:missing"],
      [pairs(contact, "not-a-code"), "approval:malformed"],
      [pairs(contact, `${code} `), "approval:malformed"],
      [[...pairs(contact, code), ["airlock_approval", code]], "duplicate_approval_field"],
    ];
    for (const [p, reason] of cases) {
      const r = await post("contact-request", p);
      expect(r.status).toBe(403);
      expect(await r.text()).toContain(reason);
    }
    expect(store.get("prop_1")).toBeUndefined();
    expect(logs.every((l) => l.event === "submission_refused")).toBe(true);
  });

  test("undeclared, missing or duplicate fields are refused even with a valid code", async () => {
    const { code } = await approve("contact-request", contact);
    const bad: Array<[Array<[string, string]>, string]> = [
      [[...pairs(contact, code), ["extra", "1"]], "fields:unknown_field"],
      [pairs({ name: contact.name, email: contact.email }, code), "fields:missing_field"],
      [[["name", "a"], ...pairs(contact, code)], "fields:duplicate_field"],
    ];
    for (const [p, reason] of bad) expect(await (await post("contact-request", p)).text()).toContain(reason);
  });

  test("submitted values are escaped on the confirmation page", async () => {
    const hostile = { name: `<script>alert(1)</script>`, email: `"'><img src=x onerror=alert(1)>`, message: "a & b\n</dd><h1>x</h1>" };
    const { code } = await approve("contact-request", hostile);
    const r = await post("contact-request", pairs(hostile, code));
    const body = await r.text();
    expect(r.status).toBe(200);
    expect(body).not.toContain("<script>alert");
    expect(body).not.toContain("<img");
    expect(body).not.toContain("</dd><h1>");
    expect(body).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(body).toContain("&quot;&#39;&gt;&lt;img src=x onerror=alert(1)&gt;");
    expect(body).toContain("a &amp; b\n&lt;/dd&gt;&lt;h1&gt;x&lt;/h1&gt;");
  });

  test("bounded body, content type, method", async () => {
    const big = `name=${"a".repeat(MAX_BODY_BYTES)}`;
    expect((await post("contact-request", [], { rawBody: big })).status).toBe(413);
    expect((await post("contact-request", pairs(contact), { contentType: "multipart/form-data; boundary=x" })).status).toBe(415);
    expect((await post("contact-request", pairs(contact), { contentType: "application/x-www-form-urlencoded; charset=UTF-8" })).status).toBe(403);
    expect((await get("/f/contact-request/submit")).status).toBe(405);
    expect((await post("unknown", pairs(contact))).status).toBe(404);
  });

  test("rate limit per IP", async () => {
    app = createApp({ origin: ORIGIN, secret: SECRET, store, nowEpoch: () => now, rateLimit: { windowMs: 60_000, general: 100, sensitive: 3 } });
    for (let i = 0; i < 3; i++) expect((await post("contact-request", pairs(contact), { ip: "192.0.2.9" })).status).toBe(403);
    const limited = await post("contact-request", pairs(contact), { ip: "192.0.2.9" });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect((await post("contact-request", pairs(contact), { ip: "192.0.2.10" })).status).toBe(403);
  });
});

describe("receipts API", () => {
  test("requires the derived read token", async () => {
    const { code } = await approve("contact-request", contact);
    await post("contact-request", pairs(contact, code));
    expect((await get("/api/receipts/prop_1")).status).toBe(401);
    expect((await get("/api/receipts/prop_1", { authorization: `Bearer ${SECRET}` })).status).toBe(401);
    expect((await get("/api/receipts/prop_1", { authorization: `Bearer ${receiptsReadToken(SECRET)}x` })).status).toBe(401);
    expect((await get("/api/receipts/prop_1", { authorization: receiptsReadToken(SECRET) })).status).toBe(401);
    expect((await get("/api/receipts/prop_1", auth)).status).toBe(200);
    const none = await get("/api/receipts/prop_never", auth);
    expect(none.status).toBe(404);
    expect(await none.json()).toEqual({ status: "none" });
    expect((await get("/api/receipts/bad.id", auth)).status).toBe(400);
  });
});

describe("persistence", () => {
  test("one-use claims survive a restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "airlock-fixtures-"));
    const path = join(dir, "fixtures.sqlite");
    const s1 = new ReceiptStore(path);
    const a1 = createApp({ origin: ORIGIN, secret: SECRET, store: s1, nowEpoch: () => NOW });
    const { code } = await approve("contact-request", contact);
    const req = () => new Request(`${ORIGIN}/f/contact-request/submit`, { method: "POST", body: new URLSearchParams(pairs(contact, code)).toString(), headers: { "content-type": "application/x-www-form-urlencoded" } });
    expect((await a1.fetch(req(), "x")).status).toBe(200);
    s1.close();
    const s2 = new ReceiptStore(path);
    const a2 = createApp({ origin: ORIGIN, secret: SECRET, store: s2, nowEpoch: () => NOW });
    expect((await a2.fetch(req(), "x")).status).toBe(403);
    s2.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
