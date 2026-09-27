// Runner logic that needs no Chromium: protocol validation, ref/generation binding, tabs, events,
// ARIA snapshot parsing. Run with `node --test runtime/browser/test/` (Node >= 20).
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAriaSnapshot, splitItem, CONTROL_LIMIT } from "../src/aria.mjs";
import { MAX_REQUEST_BYTES, cutUtf8, encodeResponse, okResponse, parseRequest, pngSize } from "../src/protocol.mjs";
import { SessionState, StaleReference } from "../src/state.mjs";

const req = (body) => parseRequest(JSON.stringify(body));
const v1 = (op, args) => ({ schemaVersion: 1, id: "r1", op, ...(args === undefined ? {} : { args }) });

test("valid requests parse to normalized args", () => {
  assert.deepEqual(req(v1("navigate", { url: "https://example.com" })).request, {
    id: "r1", op: "navigate", args: { url: "https://example.com/" },
  });
  assert.deepEqual(req(v1("type", { ref: "e5", generation: 3, text: "hi" })).request.args, {
    ref: "e5", generation: 3, text: "hi", submit: false,
  });
  assert.deepEqual(req(v1("scroll", { dy: 400 })).request.args, { dx: 0, dy: 400 });
  assert.deepEqual(req(v1("screenshot")).request.args, { fullPage: false });
  assert.equal(req(v1("tabs.switch", { tabId: "tab-2" })).ok, true);
});

test("invalid requests are refused with bounded error codes", () => {
  const code = (body) => req(body).response?.error;
  assert.equal(code({ ...v1("observe"), schemaVersion: 2 }), "unsupported_schema");
  assert.equal(code(v1("evaluate", { expression: "1" })), "unknown_op");
  assert.equal(code(v1("__proto__")), "unknown_op");
  assert.equal(code(v1("navigate", { url: "file:///etc/passwd" })), "invalid_request");
  assert.equal(code(v1("navigate", { url: "javascript:alert(1)" })), "invalid_request");
  assert.equal(code(v1("navigate", { url: "https://u:p@example.com/" })), "invalid_request");
  assert.equal(code(v1("navigate", { url: "https://example.com", headers: {} })), "invalid_request");
  assert.equal(code(v1("click", { ref: "e1" })), "invalid_request");
  assert.equal(code(v1("click", { ref: "e1; x", generation: 1 })), "invalid_request");
  assert.equal(code(v1("click", { ref: "e1", generation: -1 })), "invalid_request");
  assert.equal(code(v1("key", { key: "Control+A", generation: 1 })), "invalid_request");
  assert.equal(code(v1("key", { key: "a", generation: 1 })), "invalid_request");
  assert.equal(code(v1("type", { ref: "e1", generation: 1, text: "x".repeat(8193) })), "invalid_request");
  assert.equal(code(v1("scroll", { dy: 1e9 })), "invalid_request");
  assert.equal(code(v1("tabs.close", { tabId: "../x" })), "invalid_request");
  assert.equal(code({ ...v1("observe"), extra: 1 }), "invalid_request");
  assert.equal(code({ ...v1("observe"), id: "bad id with spaces" }), "invalid_request");
  assert.equal(parseRequest("not json").response.error, "invalid_request");
  assert.equal(parseRequest("x".repeat(MAX_REQUEST_BYTES + 1)).response.error, "request_too_large");
  for (const response of [req(v1("evaluate")).response, parseRequest("{").response]) {
    assert.equal(response.schemaVersion, 1);
    assert.equal(response.ok, false);
    assert.ok(response.message.length <= 512);
  }
});

test("every allowlisted key is accepted", () => {
  for (const key of ["Enter", "Tab", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End", "Backspace"]) {
    assert.equal(req(v1("key", { key, generation: 0 })).ok, true, key);
  }
});

test("refs are bound to generation and tab; stale or unknown refs are refused", () => {
  const s = new SessionState();
  const t1 = s.addTab("page1");
  const g = s.recordSnapshot(t1, ["e1", "e2"]);
  assert.equal(g, 1);
  s.checkRef("e1", g);
  assert.throws(() => s.checkRef("e9", g), StaleReference); // unknown ref
  assert.throws(() => s.checkRef("e1", g - 1), StaleReference); // old generation
  s.navigated(t1); // main-frame navigation of the active tab
  assert.equal(s.generation, 2);
  assert.throws(() => s.checkRef("e1", g), StaleReference);
  assert.throws(() => s.checkRef("e1", 2), StaleReference); // refs cleared, no observe yet
  const g3 = s.recordSnapshot(t1, ["e7"]);
  s.checkRef("e7", g3);
  assert.throws(() => s.checkGeneration(g), StaleReference);
});

test("a new observe invalidates refs from the previous observe", () => {
  const s = new SessionState();
  const t1 = s.addTab("p");
  const g1 = s.recordSnapshot(t1, ["e1"]);
  const g2 = s.recordSnapshot(t1, ["e1"]);
  assert.notEqual(g1, g2);
  assert.throws(() => s.checkRef("e1", g1), StaleReference);
  s.checkRef("e1", g2);
});

test("popups are tracked (max 5), never auto-followed; switch/close invalidate", () => {
  const s = new SessionState();
  const t1 = s.addTab("main");
  const g = s.recordSnapshot(t1, ["e1"]);
  const t2 = s.addTab("popup");
  assert.equal(s.activeTabId, t1);
  s.checkRef("e1", g); // opening a popup does not disturb the active tab
  s.navigated(t2); // navigation in a background tab does not invalidate
  assert.equal(s.generation, g);
  for (let i = 0; i < 3; i += 1) assert.ok(s.addTab(`p${i}`));
  assert.equal(s.addTab("sixth"), null);
  assert.equal(s.tabs.size, 5);
  assert.equal(s.switchTab(t2), true);
  assert.equal(s.activeTabId, t2);
  assert.throws(() => s.checkRef("e1", g), StaleReference);
  assert.equal(s.switchTab("tab-99"), false);
  const before = s.generation;
  const { wasActive } = s.removeTab(t2);
  assert.equal(wasActive, true);
  assert.equal(s.generation, before + 1);
  assert.notEqual(s.activeTabId, t2);
});

test("refs from another tab are refused even at the current generation", () => {
  const s = new SessionState();
  const t1 = s.addTab("a");
  const t2 = s.addTab("b");
  s.recordSnapshot(t1, ["e1"]);
  s.activeTabId = t2; // simulate the active tab changing without a switch (e.g. close of t1 elsewhere)
  assert.throws(() => s.checkRef("e1", s.generation), StaleReference);
});

test("dismissed confirm sets pending review until an observe delivers it; events bounded", () => {
  const s = new SessionState({ maxEvents: 3 });
  s.pushEvent({ type: "dialog", dialogType: "alert", status: "dismissed" });
  assert.equal(s.pendingReview, false);
  s.pushEvent({ type: "dialog", dialogType: "confirm", status: "pending_review" });
  assert.equal(s.pendingReview, true);
  s.pushEvent({ type: "filechooser", action: "cancelled" });
  s.pushEvent({ type: "extra" });
  const drained = s.drainEvents();
  assert.equal(drained.events.length, 3);
  assert.equal(drained.droppedEvents, 1);
  assert.equal(drained.pendingReview, true);
  assert.equal(s.pendingReview, false);
  assert.equal(s.drainEvents().events.length, 0);
});

const SNAPSHOT = `- generic [active] [ref=e1]:
  - heading "Hi" [level=1] [ref=e2]
  - 'link "Learn: \\"more\\"" [ref=e3] [cursor=pointer]':
    - /url: https://example.com/x
  - textbox "Name" [ref=e4]: bob
  - button "Go [x]" [disabled] [ref=e5]
  - checkbox "c" [ref=e6]
  - checkbox "d" [checked] [ref=e10]
  - combobox "s" [ref=e7]:
    - option "A" [selected]
  - textbox "t" [ref=e8]: 'a: b'
  - iframe [ref=e9]:
    - button "inner" [ref=f1e2]
  - text: plain words`;

test("aria snapshot parsing yields interactive controls only, with values and flags", () => {
  const { controls, truncated, refs } = parseAriaSnapshot(SNAPSHOT);
  assert.equal(truncated, false);
  assert.deepEqual(controls, [
    { ref: "e3", role: "link", name: 'Learn: "more"' },
    { ref: "e4", role: "textbox", name: "Name", value: "bob" },
    { ref: "e5", role: "button", name: "Go [x]", disabled: true },
    { ref: "e6", role: "checkbox", name: "c", checked: false },
    { ref: "e10", role: "checkbox", name: "d", checked: true },
    { ref: "e7", role: "combobox", name: "s" },
    { ref: "e8", role: "textbox", name: "t", value: "a: b" },
    { ref: "f1e2", role: "button", name: "inner" },
  ]);
  assert.ok(refs.has("f1e2") && !refs.has("e2"));
});

test("aria parsing is bounded and never throws", () => {
  const many = Array.from({ length: CONTROL_LIMIT + 50 }, (_, i) => `- button "b${i}" [ref=e${i}]`).join("\n");
  const parsed = parseAriaSnapshot(many);
  assert.equal(parsed.controls.length, CONTROL_LIMIT);
  assert.equal(parsed.truncated, true);
  assert.equal(parsed.refs.has(`e${CONTROL_LIMIT + 10}`), false); // unpublished refs are unusable
  assert.deepEqual(parseAriaSnapshot(undefined).controls, []);
  assert.deepEqual(parseAriaSnapshot("- 'unterminated").controls, []);
  assert.deepEqual(parseAriaSnapshot('- button "x" [ref=e1;rm]').controls, []);
  assert.equal(parseAriaSnapshot(`- button "${"x".repeat(1000)}" [ref=e1]`).controls[0].name.length, 200);
});

test("splitItem handles quoted keys and values", () => {
  assert.deepEqual(splitItem(`'a ''b'' [ref=e1]': 'v'`), { key: "a 'b' [ref=e1]", value: "v" });
  assert.deepEqual(splitItem(`"x \\"y\\" [ref=e2]": "z"`), { key: 'x "y" [ref=e2]', value: "z" });
  assert.deepEqual(splitItem(`button "a: b" [ref=e3]`), { key: `button "a: b" [ref=e3]`, value: undefined });
});

test("bounding helpers", () => {
  const cut = cutUtf8("é".repeat(40_000));
  assert.equal(cut.truncated, true);
  assert.ok(Buffer.byteLength(cut.text) <= 32 * 1024);
  assert.ok(!cut.text.includes("�"));
  const big = encodeResponse(okResponse("r", "screenshot", { png: "x".repeat(5 * 1024 * 1024) }));
  assert.equal(JSON.parse(big).error, "response_too_large");
  const png = Buffer.alloc(24);
  png.writeUInt32BE(0x89504e47, 0);
  png.write("IHDR", 12, "latin1");
  png.writeUInt32BE(1280, 16);
  png.writeUInt32BE(800, 20);
  assert.deepEqual(pngSize(png), { width: 1280, height: 800 });
  assert.equal(pngSize(Buffer.from("nope")), null);
});
