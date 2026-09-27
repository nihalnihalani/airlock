/**
 * "Airlock fixtures": a disclosed demo destination with
 *   - the hero-task data page (GET /data/regional-sales[.csv]?variant=a|b),
 *   - controlled forms for the airlock-forms-v1 adapter (GET /f/:formId, POST /f/:formId/submit),
 *   - the reconciliation API for the control plane (GET /api/receipts/:proposalId).
 *
 * Every submission route a browser can take (button click, Enter in a field, type-with-submit) ends
 * at POST /f/:formId/submit, which accepts ONLY a valid, unexpired, unused approval code whose MAC
 * binds exactly the submitted (normalized) values. Anything else is 403 with no stored effect.
 */
import { randomBytes } from "node:crypto";
import { verifyApprovalCode, constantTimeEqual, receiptsReadToken } from "./approval.ts";
import { DATASETS, parseCsv, parseVariant, type Variant } from "./data.ts";
import { APPROVAL_FIELD, getForm, formPayloadDigest, normalizeFields, MAX_VALUE_LENGTH, type FormSpec } from "./forms.ts";
import { esc, page, STYLESHEET } from "./html.ts";
import type { ReceiptStore } from "./store.ts";

export const MAX_BODY_BYTES = 16 * 1024;
const PLAIN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export const CSP =
  "default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

export type AppConfig = {
  /** Public origin (destinationOrigin(AIRLOCK_FIXTURES_ORIGIN)); bound into every payload digest. */
  origin: string;
  secret: string;
  store: ReceiptStore;
  /** Seconds since epoch (injectable for tests). */
  nowEpoch?: () => number;
  /** Requests per window per IP: general and submit/API buckets. */
  rateLimit?: { windowMs: number; general: number; sensitive: number };
  log?: (line: Record<string, unknown>) => void;
};

type Bucket = { windowStart: number; count: number };

class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  constructor(private readonly windowMs: number, private readonly maxKeys = 10_000) {}

  allow(key: string, limit: number, nowMs: number): boolean {
    let bucket = this.buckets.get(key);
    if (!bucket || nowMs - bucket.windowStart >= this.windowMs) {
      if (!bucket && this.buckets.size >= this.maxKeys) this.sweep(nowMs);
      if (!bucket && this.buckets.size >= this.maxKeys) return false; // table full of live keys: fail closed
      bucket = { windowStart: nowMs, count: 0 };
      this.buckets.set(key, bucket);
    }
    bucket.count += 1;
    return bucket.count <= limit;
  }

  private sweep(nowMs: number): void {
    for (const [key, bucket] of this.buckets) if (nowMs - bucket.windowStart >= this.windowMs) this.buckets.delete(key);
  }
}

const baseHeaders = (contentType: string): Record<string, string> => ({
  "content-type": contentType,
  "content-security-policy": CSP,
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "cross-origin-resource-policy": "same-origin",
  "cache-control": "no-store",
});

const html = (body: string, status = 200) => new Response(body, { status, headers: baseHeaders("text/html; charset=utf-8") });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: baseHeaders("application/json; charset=utf-8") });

function errorPage(status: number, title: string, message: string): Response {
  return html(page(title, `<h1>${esc(title)}</h1>\n<p>${esc(message)}</p>\n<p><a href="/">Fixture index</a></p>`), status);
}

class BodyTooLarge extends Error {}

async function readBounded(req: Request, limit: number): Promise<string> {
  const declared = req.headers.get("content-length");
  if (declared !== null && (!/^[0-9]+$/.test(declared) || Number(declared) > limit)) throw new BodyTooLarge();
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      throw new BodyTooLarge();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

function indexPage(): Response {
  const forms = ["contact-request", "order-sample"]
    .map((id) => `<li><a href="/f/${esc(id)}">${esc(getForm(id)!.title)}</a> <span class="muted">(form id <code>${esc(id)}</code>)</span></li>`)
    .join("\n");
  return html(
    page(
      "Airlock fixtures",
      `<h1>Airlock fixtures</h1>
<p>Test destinations for the Airlock agent demo. They exist so that the agent's browsing and the human approval of final actions can be demonstrated against a service whose behaviour is known and inspectable.</p>
<h2>Data</h2>
<ul>
<li><a href="/data/regional-sales">Regional sales (synthetic)</a> and the <a href="/data/regional-sales?variant=b">changed-inputs variant</a></li>
</ul>
<h2>Controlled forms (adapter airlock-forms-v1)</h2>
<p>These forms accept a submission only with a one-use approval code issued by the Airlock control plane for exactly the submitted values.</p>
<ul>
${forms}
</ul>`,
    ),
  );
}

function dataPage(variant: Variant): Response {
  const csv = DATASETS[variant];
  const [header, ...rows] = parseCsv(csv);
  const th = header!.map((h) => `<th scope="col">${esc(h)}</th>`).join("");
  const trs = rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("\n");
  const variantNote =
    variant === "a"
      ? `<p class="muted">Variant A (default). A second variant with changed numbers is at <a href="/data/regional-sales?variant=b">?variant=b</a>.</p>`
      : `<p class="muted">Variant B: the same regions with changed numbers (to show that changing the inputs changes the results). The default is <a href="/data/regional-sales">variant A</a>.</p>`;
  const csvHref = variant === "a" ? "/data/regional-sales.csv" : "/data/regional-sales.csv?variant=b";
  // Nothing after the <pre> may contain exactly two commas on one line (the hero analysis stops at
  // the first blank or non-CSV line after the header).
  return html(
    page(
      "Regional sales, Q3 2026",
      `<h1>Regional sales, Q3 2026</h1>
<p><strong>Synthetic data</strong> made up for the Airlock demo. It describes no real company.</p>
<p>Revenue and target per region, in thousands of dollars. The table and the CSV below hold the same values; the CSV block is the whole dataset.</p>
${variantNote}
<table>
<caption class="muted">Revenue and target by region (synthetic)</caption>
<thead><tr>${th}</tr></thead>
<tbody>
${trs}
</tbody>
</table>
<h2>CSV</h2>
<pre id="csv">${esc(csv)}</pre>
<p class="muted">End of dataset. Download it as <a href="${esc(csvHref)}">regional-sales.csv</a></p>`,
    ),
  );
}

function formPage(form: FormSpec): Response {
  const inputs = form.fields
    .map((f) => {
      const id = `field-${f.name}`;
      const hint = f.hint ? `\n<p class="muted" id="${esc(id)}-hint">${esc(f.hint)}</p>` : "";
      const described = f.hint ? ` aria-describedby="${esc(id)}-hint"` : "";
      const control = f.multiline
        ? `<textarea id="${esc(id)}" name="${esc(f.name)}" maxlength="${MAX_VALUE_LENGTH}" autocomplete="off"${described}></textarea>`
        : `<input type="text" id="${esc(id)}" name="${esc(f.name)}" maxlength="${MAX_VALUE_LENGTH}" autocomplete="off" spellcheck="false"${described}>`;
      return `<label for="${esc(id)}">${esc(f.label)}</label>\n${control}${hint}`;
    })
    .join("\n");
  return html(
    page(
      form.title,
      `<h1>${esc(form.title)}</h1>
<p>${esc(form.description)}</p>
<p class="muted">Controlled destination (adapter airlock-forms-v1, form id <code>${esc(form.id)}</code>). A submission is accepted only with a one-use approval code that the Airlock control plane issues after a person approves exactly these values. Changed values, an expired code or a reused code are refused.</p>
<form method="post" action="/f/${esc(form.id)}/submit" accept-charset="utf-8">
${inputs}
<label for="field-${APPROVAL_FIELD}">Approval code</label>
<input type="text" id="field-${APPROVAL_FIELD}" name="${APPROVAL_FIELD}" maxlength="256" autocomplete="off" spellcheck="false">
<button type="submit">Submit</button>
</form>`,
    ),
  );
}

export function createApp(config: AppConfig) {
  const nowEpoch = config.nowEpoch ?? (() => Math.floor(Date.now() / 1000));
  const limits = config.rateLimit ?? { windowMs: 60_000, general: 240, sensitive: 60 };
  const limiter = new RateLimiter(limits.windowMs);
  const log = config.log ?? (() => {});
  const readToken = receiptsReadToken(config.secret);

  function refuse(formId: string, reason: string, proposalId?: string): Response {
    log({ event: "submission_refused", formId, reason, ...(proposalId ? { proposalId } : {}) });
    return html(
      page(
        "Submission refused",
        `<h1 class="bad">Submission refused: no valid approval for exactly these values</h1>
<p>Nothing was recorded. This destination accepts a submission only with an unexpired, unused approval code issued for exactly the submitted values.</p>
<p class="muted">Reason code: <code>${esc(reason)}</code></p>
<p><a href="/f/${esc(formId)}">Back to the form</a></p>`,
      ),
      403,
    );
  }

  async function submit(req: Request, form: FormSpec): Promise<Response> {
    const type = (req.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (type !== "application/x-www-form-urlencoded") return errorPage(415, "Unsupported content type", "Submit the form as application/x-www-form-urlencoded.");
    let body: string;
    try {
      body = await readBounded(req, MAX_BODY_BYTES);
    } catch (error) {
      if (error instanceof BodyTooLarge) return errorPage(413, "Submission too large", `The body limit is ${MAX_BODY_BYTES} bytes.`);
      throw error;
    }
    const params = new URLSearchParams(body);
    const codes = params.getAll(APPROVAL_FIELD);
    if (codes.length > 1) return refuse(form.id, "duplicate_approval_field");
    const payloadEntries = [...params].filter(([name]) => name !== APPROVAL_FIELD);
    const normalized = normalizeFields(form.id, payloadEntries);
    if (!normalized.ok) return refuse(form.id, `fields:${normalized.reason}`);
    const payloadDigest = await formPayloadDigest(config.origin, form.id, normalized.fields);
    const verdict = verifyApprovalCode({ secret: config.secret, code: codes[0], payloadDigest, nowEpoch: nowEpoch() });
    if (!verdict.ok) return refuse(form.id, `approval:${verdict.reason}`);
    const receipt = {
      proposalId: verdict.proposalId,
      formId: form.id,
      payloadDigest,
      receiptId: `rcpt_${randomBytes(16).toString("base64url")}`,
      at: new Date(nowEpoch() * 1000).toISOString(),
    };
    if (config.store.claim(receipt) === "replay") return refuse(form.id, "approval:already_used", verdict.proposalId);
    log({ event: "submission_accepted", formId: form.id, proposalId: receipt.proposalId, payloadDigest, receiptId: receipt.receiptId });
    const values = form.fields
      .map((f) => `<dt>${esc(f.label)}</dt><dd>${esc(normalized.fields[f.name]!)}</dd>`)
      .join("\n");
    return html(
      page(
        "Submission accepted",
        `<h1 class="ok">Submission accepted</h1>
<p>Receipt <code id="receipt-id">${esc(receipt.receiptId)}</code> for approval <code>${esc(receipt.proposalId)}</code>. (Demo fixture: recorded here only; nothing is sent anywhere.)</p>
<dl>
${values}
</dl>
<p class="muted">Payload digest <code id="payload-digest">${esc(payloadDigest)}</code> at ${esc(receipt.at)}</p>`,
      ),
    );
  }

  function receipts(req: Request, proposalId: string): Response {
    const auth = req.headers.get("authorization") ?? "";
    const presented = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!constantTimeEqual(presented, readToken)) return json({ status: "unauthorized" }, 401);
    if (!PLAIN_ID.test(proposalId)) return json({ status: "bad_request" }, 400);
    const r = config.store.get(proposalId);
    if (!r) return json({ status: "none" }, 404);
    return json({ status: "confirmed", proposalId: r.proposalId, formId: r.formId, receiptId: r.receiptId, payloadDigest: r.payloadDigest, at: r.at });
  }

  async function fetch(req: Request, clientIp: string): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;
    const nowMs = Date.now();
    const sensitive = path.startsWith("/api/") || method === "POST";
    if (!limiter.allow(`g:${clientIp}`, limits.general, nowMs) || (sensitive && !limiter.allow(`s:${clientIp}`, limits.sensitive, nowMs))) {
      const r = errorPage(429, "Too many requests", "Slow down and try again in a minute.");
      r.headers.set("retry-after", String(Math.ceil(limits.windowMs / 1000)));
      return r;
    }

    const submitMatch = /^\/f\/([^/]+)\/submit$/.exec(path);
    if (submitMatch) {
      const form = getForm(decodeURIComponentSafe(submitMatch[1]!));
      if (!form) return errorPage(404, "Unknown form", "There is no form with that id.");
      if (method !== "POST") return errorPage(405, "Method not allowed", "Submit the form with POST.");
      return submit(req, form);
    }
    const receiptMatch = /^\/api\/receipts\/([^/]+)$/.exec(path);
    if (receiptMatch) {
      if (method !== "GET") return json({ status: "method_not_allowed" }, 405);
      return receipts(req, decodeURIComponentSafe(receiptMatch[1]!));
    }
    if (method !== "GET" && method !== "HEAD") return errorPage(405, "Method not allowed", "Only GET is supported here.");

    if (path === "/") return indexPage();
    if (path === "/healthz") return json({ status: "ok" });
    if (path === "/static/fixtures.css")
      return new Response(STYLESHEET, { headers: { ...baseHeaders("text/css; charset=utf-8"), "cache-control": "public, max-age=300" } });
    if (path === "/data/regional-sales" || path === "/regional-sales.html" || path === "/data/regional-sales.csv") {
      const variant = parseVariant(url.searchParams.get("variant"));
      if (!variant) return errorPage(400, "Unknown variant", "Use ?variant=a (default) or ?variant=b.");
      if (path.endsWith(".csv"))
        return new Response(DATASETS[variant], {
          headers: { ...baseHeaders("text/csv; charset=utf-8"), "content-disposition": `inline; filename="regional-sales-${variant}.csv"` },
        });
      return dataPage(variant);
    }
    const formMatch = /^\/f\/([^/]+)$/.exec(path);
    if (formMatch) {
      const form = getForm(decodeURIComponentSafe(formMatch[1]!));
      if (!form) return errorPage(404, "Unknown form", "There is no form with that id.");
      return formPage(form);
    }
    return errorPage(404, "Not found", "Nothing lives at this path.");
  }

  return { fetch };
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return "";
  }
}
