// Airlock browser runner protocol, schemaVersion 1. Plain validation (no zod: this runs in the
// image with only playwright-core installed). The authoritative description is PROTOCOL.md; keep
// both in step. Imports nothing, so it is testable without a browser.

export const SCHEMA_VERSION = 1;
export const MAX_REQUEST_BYTES = 256 * 1024;
export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
export const MAX_SCREENSHOT_BYTES = 2 * 1024 * 1024;
export const MAX_TEXT_BYTES = 32 * 1024;
export const MAX_MESSAGE = 512;
export const MAX_TABS = 5;
export const VIEWPORT = Object.freeze({ width: 1280, height: 800 });

export const ALLOWED_KEYS = Object.freeze([
  "Enter", "Tab", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
  "PageUp", "PageDown", "Home", "End", "Backspace",
]);

export const ERROR_CODES = Object.freeze([
  "invalid_request", "unsupported_schema", "unknown_op", "stale_reference", "pending_review",
  "navigation_failed", "action_failed", "timeout", "screenshot_too_large", "tab_not_found",
  "last_tab", "request_too_large", "response_too_large", "runner_unavailable", "internal_error",
]);

const REF = /^[a-z0-9]{1,16}$/i;
const TAB_ID = /^tab-[0-9]{1,6}$/;
const REQUEST_ID = /^[A-Za-z0-9._:-]{1,64}$/;

class Invalid extends Error {}
const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const fail = (message) => { throw new Invalid(message); };

function only(args, allowed, required = []) {
  if (!isObject(args)) fail("args must be an object");
  for (const key of Object.keys(args)) if (!allowed.includes(key)) fail(`unexpected argument: ${key.slice(0, 40)}`);
  for (const key of required) if (!(key in args)) fail(`missing argument: ${key}`);
  return args;
}
const generation = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : fail("generation must be a non-negative integer"));
const ref = (v) => (typeof v === "string" && REF.test(v) ? v : fail("ref must match /^[a-z0-9]{1,16}$/i"));
const tabId = (v) => (typeof v === "string" && TAB_ID.test(v) ? v : fail("tabId must look like tab-<n>"));
const bool = (v, name) => (v === undefined ? false : typeof v === "boolean" ? v : fail(`${name} must be boolean`));
const delta = (v, name) =>
  v === undefined ? 0 : Number.isInteger(v) && Math.abs(v) <= 10000 ? v : fail(`${name} must be an integer in [-10000, 10000]`);

export function validateUrl(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) fail("url must be a string of 1..2048 chars");
  let url;
  try { url = new URL(value); } catch { fail("url is not a valid absolute URL"); }
  if (url.protocol !== "http:" && url.protocol !== "https:") fail("only http and https URLs are allowed");
  if (url.username || url.password) fail("credentials in URLs are not allowed");
  return url.href;
}

const OPS = {
  status: (a) => (only(a, []), {}),
  navigate: (a) => (only(a, ["url"], ["url"]), { url: validateUrl(a.url) }),
  observe: (a) => (only(a, []), {}),
  click: (a) => (only(a, ["ref", "generation"], ["ref", "generation"]), { ref: ref(a.ref), generation: generation(a.generation) }),
  type: (a) => {
    only(a, ["ref", "generation", "text", "submit"], ["ref", "generation", "text"]);
    if (typeof a.text !== "string" || a.text.length > 8192) fail("text must be a string of at most 8192 chars");
    return { ref: ref(a.ref), generation: generation(a.generation), text: a.text, submit: bool(a.submit, "submit") };
  },
  key: (a) => {
    only(a, ["key", "generation"], ["key", "generation"]);
    if (!ALLOWED_KEYS.includes(a.key)) fail(`key must be one of ${ALLOWED_KEYS.join(", ")}`);
    return { key: a.key, generation: generation(a.generation) };
  },
  scroll: (a) => (only(a, ["dx", "dy"]), { dx: delta(a.dx, "dx"), dy: delta(a.dy, "dy") }),
  screenshot: (a) => (only(a, ["fullPage"]), { fullPage: bool(a.fullPage, "fullPage") }),
  "tabs.list": (a) => (only(a, []), {}),
  "tabs.switch": (a) => (only(a, ["tabId"], ["tabId"]), { tabId: tabId(a.tabId) }),
  "tabs.close": (a) => (only(a, ["tabId"], ["tabId"]), { tabId: tabId(a.tabId) }),
};
export const OP_NAMES = Object.freeze(Object.keys(OPS));
/** Operations that can change page state; refused while a dismissed dialog awaits review. */
export const MUTATING_OPS = Object.freeze(new Set(["navigate", "click", "type", "key", "scroll", "tabs.switch", "tabs.close"]));

/** Parse and validate one raw request line. Returns { ok, request } or { ok:false, response }. */
export function parseRequest(line) {
  if (typeof line !== "string") return { ok: false, response: errorResponse(null, null, "invalid_request", "request must be text") };
  if (Buffer.byteLength(line, "utf8") > MAX_REQUEST_BYTES) {
    return { ok: false, response: errorResponse(null, null, "request_too_large", `request exceeds ${MAX_REQUEST_BYTES} bytes`) };
  }
  let body;
  try { body = JSON.parse(line); } catch { return { ok: false, response: errorResponse(null, null, "invalid_request", "request is not JSON") }; }
  const id = isObject(body) && typeof body.id === "string" && REQUEST_ID.test(body.id) ? body.id : null;
  const op = isObject(body) && typeof body.op === "string" && body.op.length <= 32 ? body.op : null;
  try {
    if (!isObject(body)) fail("request must be a JSON object");
    for (const key of Object.keys(body)) if (!["schemaVersion", "id", "op", "args"].includes(key)) fail(`unexpected field: ${key.slice(0, 40)}`);
    if (body.schemaVersion !== SCHEMA_VERSION) {
      return { ok: false, response: errorResponse(id, op, "unsupported_schema", `schemaVersion must be ${SCHEMA_VERSION}`) };
    }
    if (body.id !== undefined && id === null) fail("id must match /^[A-Za-z0-9._:-]{1,64}$/");
    if (op === null || !Object.hasOwn(OPS, op)) {
      return { ok: false, response: errorResponse(id, op, "unknown_op", `op must be one of ${OP_NAMES.join(", ")}`) };
    }
    const args = OPS[op](body.args === undefined ? {} : body.args);
    return { ok: true, request: { id, op, args } };
  } catch (error) {
    if (error instanceof Invalid) return { ok: false, response: errorResponse(id, op, "invalid_request", error.message) };
    throw error;
  }
}

export function boundMessage(value) {
  const text = String(value ?? "").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ");
  return text.length > MAX_MESSAGE ? `${text.slice(0, MAX_MESSAGE - 1)}…` : text;
}

export function okResponse(id, op, result) {
  return { schemaVersion: SCHEMA_VERSION, id, op, ok: true, result };
}

export function errorResponse(id, op, error, message) {
  return { schemaVersion: SCHEMA_VERSION, id, op, ok: false, error, message: boundMessage(message) };
}

/** Serialize a response as one line, refusing to emit more than MAX_RESPONSE_BYTES. */
export function encodeResponse(response) {
  const line = JSON.stringify(response);
  if (Buffer.byteLength(line, "utf8") + 1 > MAX_RESPONSE_BYTES) {
    return `${JSON.stringify(errorResponse(response.id ?? null, response.op ?? null, "response_too_large", "response exceeded 4 MiB"))}\n`;
  }
  return `${line}\n`;
}

/** Cut text to at most `maxBytes` UTF-8 bytes without splitting a character. */
export function cutUtf8(text, maxBytes = MAX_TEXT_BYTES) {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= maxBytes) return { text, truncated: false };
  let end = maxBytes;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
  return { text: buffer.subarray(0, end).toString("utf8"), truncated: true };
}

/** Width and height from a PNG's IHDR chunk, or null. */
export function pngSize(buffer) {
  if (buffer.length < 24 || buffer.readUInt32BE(0) !== 0x89504e47 || buffer.toString("latin1", 12, 16) !== "IHDR") return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}
