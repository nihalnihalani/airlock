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

// Downloads (C16) and uploads (C17). Downloads land in a per-container tmpfs directory; the limits
// are enforced while bytes arrive (in-progress abort), on completion, and again by the supervisor.
export const MAX_DOWNLOAD_BYTES = 10 * 1024 * 1024;
export const MAX_DOWNLOADS = 10;
export const MAX_DOWNLOAD_TOTAL_BYTES = 30 * 1024 * 1024;
/** download.read returns at most this many raw bytes per call (base64 stays well under 4 MiB). */
export const DOWNLOAD_CHUNK_BYTES = 2 * 1024 * 1024;
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
/** Where the supervisor places upload bytes (never an arbitrary host path; tmpfs inside this container). */
export const UPLOAD_DIR = "/tmp/uploads";

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
export const DOWNLOAD_ID = /^dl-[0-9]{1,6}$/;
export const UPLOAD_ID = /^up-[a-f0-9]{16}$/;
export const UPLOAD_FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;

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
  "download.list": (a) => (only(a, []), {}),
  "download.read": (a) => {
    only(a, ["downloadId", "offset"], ["downloadId"]);
    if (typeof a.downloadId !== "string" || !DOWNLOAD_ID.test(a.downloadId)) fail("downloadId must look like dl-<n>");
    const offset = a.offset === undefined ? 0 : a.offset;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > MAX_DOWNLOAD_BYTES) fail(`offset must be an integer in [0, ${MAX_DOWNLOAD_BYTES}]`);
    return { downloadId: a.downloadId, offset };
  },
  upload: (a) => {
    only(a, ["ref", "generation", "uploadId", "filename", "sha256"], ["ref", "generation", "uploadId", "filename", "sha256"]);
    if (typeof a.uploadId !== "string" || !UPLOAD_ID.test(a.uploadId)) fail("uploadId must look like up-<16 hex>");
    if (typeof a.filename !== "string" || !UPLOAD_FILENAME.test(a.filename)) fail("filename must match /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/");
    if (typeof a.sha256 !== "string" || !SHA256.test(a.sha256)) fail("sha256 must be 64 lowercase hex");
    return { ref: ref(a.ref), generation: generation(a.generation), uploadId: a.uploadId, filename: a.filename, sha256: a.sha256 };
  },
};
export const OP_NAMES = Object.freeze(Object.keys(OPS));
/** Operations that can change page state; refused while a dismissed dialog awaits review. */
export const MUTATING_OPS = Object.freeze(new Set(["navigate", "click", "type", "key", "scroll", "tabs.switch", "tabs.close", "upload"]));

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

/**
 * Media type from the bytes (never from a server header or the page): a few binary signatures, then
 * UTF-8 text (JSON if it parses as an object/array, CSV/TSV by extension or by a consistent delimiter),
 * else application/octet-stream. Keep in step with apps/supervisor/src/browser-files.ts.
 */
export function sniffMediaType(buffer, filename = "") {
  const b = buffer;
  const starts = (sig) => b.length >= sig.length && sig.every((v, i) => b[i] === v);
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (starts([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (starts([0x47, 0x49, 0x46, 0x38])) return "image/gif";
  if (starts([0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf";
  if (starts([0x50, 0x4b, 0x03, 0x04]) || starts([0x50, 0x4b, 0x05, 0x06])) return "application/zip";
  if (starts([0x1f, 0x8b])) return "application/gzip";
  if (b.includes(0)) return "application/octet-stream";
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(b);
  } catch {
    return "application/octet-stream";
  }
  const trimmed = text.trim();
  if (/^[\[{]/.test(trimmed)) {
    try { JSON.parse(trimmed); return "application/json"; } catch {}
  }
  const ext = String(filename).toLowerCase().match(/\.([a-z0-9]{1,8})$/)?.[1] ?? "";
  if (ext === "csv") return "text/csv";
  if (ext === "tsv") return "text/tab-separated-values";
  const lines = trimmed.split(/\r?\n/).slice(0, 20).filter((l) => l.length > 0);
  for (const [delimiter, type] of [[",", "text/csv"], ["\t", "text/tab-separated-values"]]) {
    const counts = lines.map((l) => l.split(delimiter).length - 1);
    if (lines.length >= 2 && counts[0] > 0 && counts.every((c) => c === counts[0])) return type;
  }
  return "text/plain";
}
