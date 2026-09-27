/**
 * A fake forms destination for tests: the REAL airlock-forms-v1 service (apps/fixtures createApp +
 * an in-memory ReceiptStore) behind a simulated browser. The fake browser renders its form as
 * observe controls (one textbox per field labelled like the page, the "Approval code" input and a
 * "Submit" button), keeps typed values per ref, and on a click of Submit / Enter / type-with-submit
 * POSTs exactly what was typed to the service, so the destination's own normalization, approval
 * code check and one-use claim decide the result. Receipt reads go to the same service.
 */
import type { BrowserAnyOp, BrowserOpResult, BrowserResponse } from "@airlock/contracts";
import { APPROVAL_FIELD, getForm, type FormSpec } from "@airlock/fixtures";
import { createApp } from "../../../fixtures/src/app.ts";
import { ReceiptStore } from "../../../fixtures/src/store.ts";
import type { FormsConfig } from "../../src/forms-adapter.ts";
import { hostAllowed } from "../../src/task-profiles.ts";
import type { FakeAttempt } from "./fake-supervisor.ts";

export const FORMS_HOST = "forms.airlock-fixtures.org";
export const FORMS_ORIGIN = `https://${FORMS_HOST}`;
export const FORMS_SECRET = "test-forms-secret-0123456789-abcdefghijklmnop";
export const CONTACT_URL = `${FORMS_ORIGIN}/f/contact-request`;
export const CONTACT_FIELDS = { name: "Ada Lovelace", email: "ada@example.org", message: "Please call me back.\nThanks" };

type PageState = { url: string; formId: string | null; text: string; title: string; values: Map<string, string> };

const stripTags = (html: string) =>
  html
    .replace(/<style[\s\S]*?<\/style>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();

export class FakeFormsDestination {
  readonly receipts = new ReceiptStore(":memory:");
  readonly app = createApp({ origin: FORMS_ORIGIN, secret: FORMS_SECRET, store: this.receipts, rateLimit: { windowMs: 60_000, general: 100_000, sensitive: 100_000 } });
  /** Every POST the fake browser made to the submit path, with the destination's status. */
  readonly submissions: { formId: string; status: number; body: string }[] = [];
  readonly receiptReads: { status: number | "error" }[] = [];
  /** The next N receipt reads fail at the transport. */
  receiptReadFailures = 0;
  /** The next submit POST happens, but the runner reply is lost (interrupted). */
  loseSubmitResponse = false;
  private readonly pages = new Map<string, PageState>();

  readonly fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (init?.redirect !== "error") throw new Error("receipt reads must refuse redirects");
    if (this.receiptReadFailures > 0) {
      this.receiptReadFailures -= 1;
      this.receiptReads.push({ status: "error" });
      throw new TypeError("fetch failed: connection reset");
    }
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const res = await this.app.fetch(new Request(url, { method: init?.method ?? "GET", headers: init?.headers ?? {} }), "10.0.0.9");
    this.receiptReads.push({ status: res.status });
    return res;
  }) as typeof fetch;

  config(): FormsConfig {
    return { origins: [FORMS_ORIGIN], secret: FORMS_SECRET, fetch: this.fetch, receiptTimeoutMs: 2000 };
  }

  private state(attempt: FakeAttempt): PageState | undefined {
    return this.pages.get(attempt.ref.attemptId);
  }

  private controls(form: FormSpec) {
    return [
      ...form.fields.map((f, i) => ({ ref: `f${i}`, role: "textbox", name: f.label })),
      { ref: "fa", role: "textbox", name: "Approval code" },
      { ref: "fs", role: "button", name: "Submit" },
    ];
  }

  private async submit(attempt: FakeAttempt, page: PageState): Promise<number> {
    const form = getForm(page.formId!)!;
    const params = new URLSearchParams();
    form.fields.forEach((f, i) => params.append(f.name, page.values.get(`f${i}`) ?? ""));
    params.append(APPROVAL_FIELD, page.values.get("fa") ?? "");
    const body = params.toString();
    const res = await this.app.fetch(new Request(`${FORMS_ORIGIN}/f/${form.id}/submit`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body }), "10.0.0.8");
    this.submissions.push({ formId: form.id, status: res.status, body });
    const html = await res.text();
    const next: PageState = { url: `${FORMS_ORIGIN}/f/${form.id}/submit`, formId: null, title: res.status === 200 ? "Submission accepted" : "Submission refused", text: stripTags(html), values: new Map() };
    this.pages.set(attempt.ref.attemptId, next);
    attempt.browser!.generation += 1;
    attempt.browser!.url = next.url;
    return res.status;
  }

  /** FakeSupervisor `browserOp` hook: handles the forms origin, falls through for everything else. */
  readonly browserOp = async (attempt: FakeAttempt, request: BrowserAnyOp): Promise<BrowserOpResult | undefined> => {
    const b = attempt.browser!;
    const generationBefore = b.generation;
    const ok = (result: unknown): BrowserOpResult => ({ response: { schemaVersion: 1, id: null, op: request.op, ok: true, result }, status: "completed", durationMs: 2, generationBefore });
    const fail = (error: Extract<BrowserResponse, { ok: false }>["error"], message: string): BrowserOpResult => ({ response: { schemaVersion: 1, id: null, op: request.op, ok: false, error, message }, status: "completed", durationMs: 2, generationBefore });
    if (request.op === "navigate") {
      const url = new URL(request.args.url);
      if (url.origin !== FORMS_ORIGIN) {
        this.pages.delete(attempt.ref.attemptId);
        return undefined;
      }
      if (!hostAllowed(url.hostname, attempt.egressAllow ?? [])) return undefined;
      const res = await this.app.fetch(new Request(url.href), "10.0.0.8");
      const html = await res.text();
      const m = /^\/f\/([^/]+)$/.exec(url.pathname);
      const form = m ? getForm(decodeURIComponent(m[1]!)) : undefined;
      this.pages.set(attempt.ref.attemptId, { url: url.href, formId: form && res.status === 200 ? form.id : null, title: form?.title ?? "", text: stripTags(html), values: new Map() });
      b.allowed += 1;
      b.generation += 1;
      b.url = url.href;
      return ok({ generation: b.generation, tabId: "tab-1", url: url.href, status: res.status });
    }
    const page = this.state(attempt);
    if (!page || b.url !== page.url) return undefined;
    const form = page.formId ? getForm(page.formId) : undefined;
    switch (request.op) {
      case "observe":
        b.generation += 1;
        return ok({ generation: b.generation, tabId: "tab-1", url: page.url, title: page.title, text: page.text, textTruncated: false, controls: form ? this.controls(form) : [], controlsTruncated: false, tabs: [{ tabId: "tab-1", url: page.url, title: page.title, active: true }], events: [], droppedEvents: 0, pendingReview: false });
      case "type":
      case "click":
      case "key": {
        if (request.args.generation !== b.generation) return fail("stale_reference", "ref/generation is not from the latest observe of the active tab");
        if (!form) return ok({ generation: b.generation, invalidated: false, url: page.url });
        const submits = request.op === "click" ? request.args.ref === "fs" : request.op === "key" ? request.args.key === "Enter" : request.args.submit === true;
        if (request.op === "type") page.values.set(request.args.ref, request.args.text);
        if (!submits) return ok({ generation: b.generation, invalidated: false, url: page.url });
        await this.submit(attempt, page);
        if (this.loseSubmitResponse) {
          this.loseSubmitResponse = false;
          return { response: null, status: "interrupted", durationMs: 5, generationBefore };
        }
        return ok({ generation: b.generation, invalidated: true, url: b.url });
      }
      default:
        return undefined;
    }
  };
}
