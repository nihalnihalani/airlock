// Mutation guard policy and approval-value redaction (no Chromium needed).
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAriaSnapshot, isApprovalInputName, isApprovalName } from "../src/aria.mjs";
import {
  MAX_MUTATION_ORIGINS,
  MUTATION_URL_CHARS,
  boundedRequestUrl,
  checkMutationOrigin,
  mutationDecision,
  parseMutationOrigins,
} from "../src/mutation.mjs";
import { SessionState } from "../src/state.mjs";
import vm from "node:vm";
import { AIRLOCK_DISABLED_FEATURES, PLAYWRIGHT_DISABLED_FEATURES, chromiumLaunchArgs, featureFlagFailures } from "../src/launch.mjs";
import { WORKER_BLOCK_SCRIPT } from "../src/mutation.mjs";

const FORMS = "https://forms.airlock.example";

test("GET/HEAD/OPTIONS always pass; every other method is refused unless its exact https origin is configured", () => {
  const none = parseMutationOrigins(undefined);
  const forms = parseMutationOrigins(JSON.stringify([FORMS]));
  for (const method of ["GET", "HEAD", "OPTIONS", "get", "options"]) {
    assert.equal(mutationDecision(method, "https://example.com/x?q=1", none).allowed, true, method);
  }
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "post", "PROPFIND", "", undefined]) {
    assert.equal(mutationDecision(method, "https://example.com/submit", none).allowed, false, String(method));
    assert.equal(mutationDecision(method, "https://example.com/submit", forms).allowed, false, String(method));
  }
  assert.deepEqual(mutationDecision("post", `${FORMS}/f/contact-request`, forms), { allowed: true, method: "POST" });
  assert.equal(mutationDecision("POST", `${FORMS}/f/contact-request`, none).allowed, false);
  // Exact origin: no subdomain, no other port, no plain http, no look-alike host.
  assert.equal(mutationDecision("POST", "https://x.forms.airlock.example/f", forms).allowed, false);
  assert.equal(mutationDecision("POST", "https://forms.airlock.example:8443/f", forms).allowed, false);
  assert.equal(mutationDecision("POST", "http://forms.airlock.example/f", forms).allowed, false);
  assert.equal(mutationDecision("POST", "https://forms.airlock.example.evil.test/f", forms).allowed, false);
  assert.equal(mutationDecision("POST", "https://forms.airlock.example:443/f", forms).allowed, true); // default port is the same origin
  assert.equal(mutationDecision("POST", "not a url", forms).allowed, false);
});

test("AIRLOCK_BROWSER_MUTATION_ORIGINS accepts only exact https origins; malformed values throw (runner refuses to start)", () => {
  assert.equal(parseMutationOrigins("").size, 0);
  assert.equal(parseMutationOrigins("[]").size, 0);
  assert.deepEqual([...parseMutationOrigins(JSON.stringify([FORMS, "https://a.test:8443"]))], [FORMS, "https://a.test:8443"]);
  for (const bad of ["{}", "nope", '"https://a.test"', '["http://a.test"]', '["https://a.test/"]', '["https://a.test/path"]',
    '["https://u@a.test"]', '["https://a.test:443"]', '["*"]', "[1]", '["wss://a.test"]', '["HTTPS://A.test"]']) {
    assert.throws(() => parseMutationOrigins(bad), undefined, bad);
  }
  assert.throws(() => parseMutationOrigins(JSON.stringify(Array.from({ length: MAX_MUTATION_ORIGINS + 1 }, (_, i) => `https://h${i}.test`))));
  assert.equal(checkMutationOrigin(FORMS), undefined);
});

test("refusal URLs keep origin + path only (no query or fragment) and are bounded", () => {
  assert.equal(boundedRequestUrl("https://example.com/post?token=secret#x"), "https://example.com/post");
  assert.equal(boundedRequestUrl("wss://example.com/socket?session=1"), "wss://example.com/socket");
  assert.equal(boundedRequestUrl("data:text/plain,hi"), "data:");
  assert.equal(boundedRequestUrl("::"), "");
  assert.equal(boundedRequestUrl(`https://example.com/${"a".repeat(5000)}`).length, MUTATION_URL_CHARS);
});

test("mutation_blocked events coalesce, are capped per observe, counted, and never displace review gating", () => {
  const s = new SessionState({ maxEvents: 50, maxMutationEvents: 3 });
  assert.equal(s.pushMutationBlocked({ method: "POST", url: "https://example.com/a", tabId: "tab-1" }), true);
  assert.equal(s.pushMutationBlocked({ method: "POST", url: "https://example.com/a", tabId: "tab-1" }), false);
  s.pushMutationBlocked({ method: "POST", url: "https://example.com/b" });
  s.pushMutationBlocked({ method: "WEBSOCKET", url: "wss://example.com/ws" });
  s.pushMutationBlocked({ method: "PUT", url: "https://example.com/c" }); // over the per-observe cap
  s.pushEvent({ type: "dialog", dialogType: "confirm", status: "pending_review" });
  const d = s.drainEvents();
  const blocked = d.events.filter((e) => e.type === "mutation_blocked");
  assert.equal(blocked.length, 3);
  assert.deepEqual({ ...blocked[0], at: undefined }, { at: undefined, type: "mutation_blocked", method: "POST", url: "https://example.com/a", tabId: "tab-1", count: 2 });
  assert.equal(d.droppedEvents, 1);
  assert.equal(d.pendingReview, true);
  assert.equal(d.events.at(-1).type, "dialog");
  assert.equal(s.mutationsBlocked, 5);
  // A pending_review dialog that overflows the queue still gates mutating ops.
  const full = new SessionState({ maxEvents: 1 });
  full.pushEvent({ type: "tab_opened" });
  full.pushEvent({ type: "dialog", dialogType: "confirm", status: "pending_review" });
  assert.equal(full.pendingReview, true);
});

test("approval inputs never carry their value in an observation", () => {
  const snapshot = [
    '- textbox "Name" [ref=e1]: Ada',
    '- textbox "Approval code" [ref=e2]: 7f3a-secret-code',
    '- textbox "approval_code for this order" [ref=e3]: other',
    '- textbox "Approval code" [ref=e4]',
    '- textbox "Message" [ref=e5]: hello',
  ].join("\n");
  const { controls } = parseAriaSnapshot(snapshot);
  const byRef = Object.fromEntries(controls.map((c) => [c.ref, c]));
  assert.equal(byRef.e1.value, "Ada");
  assert.deepEqual(byRef.e2, { ref: "e2", role: "textbox", name: "Approval code", redacted: true });
  assert.equal(byRef.e3.value, undefined);
  assert.equal(byRef.e3.redacted, true);
  assert.deepEqual(byRef.e4, { ref: "e4", role: "textbox", name: "Approval code" }); // nothing to redact
  assert.equal(byRef.e5.value, "hello");
  assert.ok(!JSON.stringify(controls).includes("7f3a-secret-code"));
  assert.equal(isApprovalName("APPROVAL CODE"), true);
  assert.equal(isApprovalName("Approval status"), false);
  assert.equal(isApprovalInputName("airlock_approval"), true);
  assert.equal(isApprovalInputName("AIRLOCK_APPROVAL "), true);
  assert.equal(isApprovalInputName("approval"), false);
  assert.equal(isApprovalInputName(null), false);
});

test("a GET/HEAD/OPTIONS request carrying a body is a mutation", () => {
  const none = new Set();
  const forms = new Set([FORMS]);
  assert.deepEqual(mutationDecision("OPTIONS", "https://example.com/x", none, true), { allowed: false, method: "OPTIONS+BODY" });
  assert.equal(mutationDecision("options", "https://example.com/x", none, true).allowed, false);
  assert.equal(mutationDecision("GET", "https://example.com/x", none, true).allowed, false);
  assert.equal(mutationDecision("OPTIONS", "https://example.com/x", none, false).allowed, true);
  assert.equal(mutationDecision("OPTIONS", `${FORMS}/f`, forms, true).allowed, true);
});

test("Worker and SharedWorker are removed from a document, non-configurably", () => {
  const sandbox = vm.createContext({ DOMException, Worker: class {}, SharedWorker: class {} });
  vm.runInContext(WORKER_BLOCK_SCRIPT, sandbox);
  for (const name of ["Worker", "SharedWorker"]) {
    assert.throws(() => vm.runInContext(`new ${name}("/w.js")`, sandbox), /Workers are disabled/);
    assert.throws(() => vm.runInContext(`"use strict"; globalThis.${name} = function () {}`, sandbox));
    assert.throws(() => vm.runInContext(`Object.defineProperty(globalThis, "${name}", { value: 1 })`, sandbox));
  }
});

test("one merged --disable-features list: Playwright's plus Airlock's; overrides are detected", () => {
  const args = chromiumLaunchArgs("http://egress:3128");
  const lists = args.filter((a) => a.startsWith("--disable-features="));
  assert.equal(lists.length, 1);
  const features = lists[0].slice("--disable-features=".length).split(",");
  for (const f of [...PLAYWRIGHT_DISABLED_FEATURES, ...AIRLOCK_DISABLED_FEATURES, "Reporting", "NetworkErrorLogging"]) assert.ok(features.includes(f), f);
  assert.ok(args.includes("--proxy-server=http://egress:3128"));
  assert.ok(!chromiumLaunchArgs(null).some((a) => a.startsWith("--proxy")));
  assert.ok(!args.some((a) => a.startsWith("--no-sandbox")));
  // Browser argv as Playwright builds it: its own list first, then ours (last wins in Chromium).
  const playwright = `--disable-features=${PLAYWRIGHT_DISABLED_FEATURES.join(",")}`;
  assert.deepEqual(featureFlagFailures(["chrome", playwright, ...args]), []);
  assert.deepEqual(featureFlagFailures(["chrome", playwright, "--disable-features=DnsOverHttps,AsyncDns,Reporting,NetworkErrorLogging"]).filter((f) => f.startsWith("overridden:")).length, PLAYWRIGHT_DISABLED_FEATURES.length);
  assert.deepEqual(featureFlagFailures(["chrome", ...args, "--disable-features=Translate"]).includes("missing:Reporting"), true);
  assert.deepEqual(featureFlagFailures(["chrome"]), ["noDisableFeatures"]);
});
