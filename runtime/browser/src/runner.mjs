// Airlock browser runner: the container's main process.
//
// Owns ONE persistent headless Chromium context for the container's lifetime, with a transient
// profile under /tmp (tmpfs) that dies with the container. Chromium's own sandbox is enabled
// (`chromiumSandbox: true`; the runner refuses to start if Playwright would add --no-sandbox).
// All traffic goes to $AIRLOCK_PROXY with no bypass (not even loopback); QUIC is disabled and WebRTC
// may not use non-proxied UDP. Service workers are blocked, extensions disabled. Downloads are accepted
// into a bounded tmpfs directory (count, per-file in-progress and total limits; downloads.mjs) and read
// back in chunks; uploads are set only from files the supervisor placed under /tmp/uploads.
// Every request passes the mutation guard (mutation.mjs): only GET/HEAD/OPTIONS leave, except to the
// exact https origins in AIRLOCK_BROWSER_MUTATION_ORIGINS; WebSockets are refused. Approval-input
// values are withheld from observations and masked in screenshots.
//
// The only interface is a unix socket (default /run/airlock/runner.sock, dir 0700, socket 0600)
// that accepts ONE bounded JSON request line per connection and answers ONE bounded JSON line.
// The supervisor reaches it through `docker exec … node /opt/airlock/client.mjs`. There is no TCP
// listener, no CDP endpoint, no token and no arbitrary-JS operation.
//
// Browser lifecycle ideas (persistent context, page tracking, aria-ref locators, launch flags) are
// adapted from OpenBot `agent-computer/src/profiles.ts` and `index.ts`
// (https://github.com/CopilotKit/OpenBot, commit 1ac9c35b393152e8d7e76c2331b8d5b584ba0e13),
// MIT License, Copyright (c) 2026 CopilotKit. Permission is hereby granted, free of charge, to any
// person obtaining a copy of this software and associated documentation files (the "Software"), to
// deal in the Software without restriction, including without limitation the rights to use, copy,
// modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the following conditions: The above
// copyright notice and this permission notice shall be included in all copies or substantial portions
// of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.
// Airlock changes: single credential-free context per container (no bot ids, no HTTP API, no
// COMPUTER_TOKEN), sandbox forced on, proxy-only networking, popups tracked but never followed,
// explicit dialog refusal, file choosers cancelled unless a supervisor-placed upload is pending for
// that control, bounded downloads, generation-bound refs, unix-socket framing.

import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { chromium } from "playwright-core";
import { APPROVAL_INPUT_NAME, APPROVAL_NAME, isApprovalInputName, isApprovalName, parseAriaSnapshot, cutAtCodeUnits } from "./aria.mjs";
import { DownloadLedger } from "./downloads.mjs";
import { installMutationGuard, parseMutationOrigins } from "./mutation.mjs";
import {
  DOWNLOAD_CHUNK_BYTES,
  MAX_DOWNLOAD_BYTES,
  MAX_REQUEST_BYTES,
  MAX_UPLOAD_BYTES,
  UPLOAD_DIR,
  MAX_SCREENSHOT_BYTES,
  MUTATING_OPS,
  VIEWPORT,
  boundMessage,
  cutUtf8,
  encodeResponse,
  errorResponse,
  okResponse,
  parseRequest,
  pngSize,
  sniffMediaType,
} from "./protocol.mjs";
import { SessionState, StaleReference } from "./state.mjs";

const SOCKET_PATH = process.env.AIRLOCK_RUNNER_SOCKET ?? "/run/airlock/runner.sock";
const PROXY = process.env.AIRLOCK_PROXY ?? "";
/** Exact https origins that may receive non-GET/HEAD/OPTIONS requests (mutation.mjs); empty = none. */
let MUTATION_ORIGINS;
const ACTION_TIMEOUT_MS = 10_000;
const NAVIGATION_TIMEOUT_MS = 30_000;

const log = (event, fields = {}) =>
  process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), component: "browser-runner", event, ...fields })}\n`);

function fatal(message) {
  log("fatal", { message: boundMessage(message) });
  process.exit(1);
}

if (!/^http:\/\/[A-Za-z0-9.-]{1,253}:[0-9]{1,5}$/.test(PROXY)) {
  fatal("AIRLOCK_PROXY must be set to http://<host>:<port>; the runner will not start without an egress proxy");
}
try {
  MUTATION_ORIGINS = parseMutationOrigins(process.env.AIRLOCK_BROWSER_MUTATION_ORIGINS);
} catch (error) {
  fatal(error?.message ?? "invalid AIRLOCK_BROWSER_MUTATION_ORIGINS");
}

// ---------------------------------------------------------------------------------------------
// Browser
// ---------------------------------------------------------------------------------------------

const profileDir = fs.mkdtempSync(path.join("/tmp", "airlock-profile-"));
// Chromium writes partial downloads here (named by GUID); completed files move to DOWNLOAD_DIR by id.
const DOWNLOAD_RAW_DIR = fs.mkdtempSync(path.join("/tmp", "airlock-downloads-raw-"));
const DOWNLOAD_DIR = fs.mkdtempSync(path.join("/tmp", "airlock-downloads-"));
fs.mkdirSync(UPLOAD_DIR, { recursive: true, mode: 0o700 });
const DOWNLOAD_POLL_MS = 100;
const UPLOAD_CHOOSER_WAIT_MS = 10_000;
const LAUNCH_ARGS = [
  `--proxy-server=${PROXY}`,
  // Chromium bypasses the proxy for loopback implicitly; `<-loopback>` removes that bypass.
  "--proxy-bypass-list=<-loopback>",
  "--disable-quic",
  "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
  "--webrtc-ip-handling-policy=disable_non_proxied_udp",
  "--disable-extensions",
  "--disable-component-extensions-with-background-pages",
  "--disable-background-networking",
  "--disable-sync",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-features=DnsOverHttps,AsyncDns",
];
if (LAUNCH_ARGS.some((arg) => arg.startsWith("--no-sandbox"))) fatal("refusing to launch without the Chromium sandbox");

const state = new SessionState();
let context;
try {
  context = await chromium.launchPersistentContext(profileDir, {
    headless: true,
    chromiumSandbox: true,
    args: LAUNCH_ARGS,
    viewport: VIEWPORT,
    acceptDownloads: true,
    downloadsPath: DOWNLOAD_RAW_DIR,
    serviceWorkers: "block",
    ignoreHTTPSErrors: false,
    bypassCSP: false,
    permissions: [],
    // Chromium's environment carries nothing beyond what it needs; the container has no secrets,
    // and this keeps it that way even if one were added by mistake.
    env: { HOME: profileDir, PATH: "/usr/local/bin:/usr/bin:/bin", TZ: "UTC" },
  });
} catch (error) {
  fatal(`chromium launch failed: ${error?.message ?? error}`);
}
// Before any page loads: every request is routed through the mutation guard, every WebSocket refused.
try {
  await installMutationGuard(context, MUTATION_ORIGINS, ({ method, url, page }) => {
    const tabId = page ? state.tabIdOf(page) : null;
    if (state.pushMutationBlocked({ method, url, tabId })) log("page_event", { type: "mutation_blocked", method, tabId });
  });
} catch (error) {
  fatal(`mutation guard could not be installed: ${error?.message ?? error}`);
}
const browserVersion = context.browser()?.version() ?? "unknown";
let stopping = false;
context.on("close", () => stopping || fatal("browser context closed; runner lost (attempt must be treated as interrupted)"));

function event(fields) {
  state.pushEvent(fields);
  log("page_event", { type: fields.type, status: fields.status, tabId: fields.tabId });
}

function track(page, initial) {
  const tabId = state.addTab(page);
  if (!tabId) {
    event({ type: "popup_blocked", reason: "tab_limit", url: cutAtCodeUnits(page.url(), 512) });
    page.close().catch(() => {});
    return;
  }
  if (!initial) event({ type: "tab_opened", tabId, url: cutAtCodeUnits(page.url(), 512), active: false });
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) state.navigated(state.tabIdOf(page));
  });
  page.on("close", () => {
    const id = state.tabIdOf(page);
    if (!id) return;
    const { wasActive } = state.removeTab(id);
    event({ type: "tab_closed", tabId: id, wasActive, activeTabId: state.activeTabId });
    if (state.tabs.size === 0 && !stopping) context.newPage().catch(() => fatal("could not reopen a tab"));
  });
  page.on("dialog", (dialog) => {
    const dialogType = dialog.type();
    // Never accepted. An alert is informational; confirm/prompt/beforeunload are decisions the
    // page wanted a person to make, so they are dismissed AND reported for review.
    event({
      type: "dialog",
      dialogType,
      message: cutAtCodeUnits(dialog.message(), 1024),
      tabId: state.tabIdOf(page),
      action: "dismissed",
      status: dialogType === "alert" ? "dismissed" : "pending_review",
    });
    dialog.dismiss().catch(() => {});
  });
  page.on("filechooser", (chooser) => {
    // Only an `upload` op in progress for THIS page may answer a chooser, once, with the file the
    // supervisor placed. Every other chooser gets nothing set, so the selection is cancelled.
    const pending = pendingUpload;
    if (pending && pending.page === page && !pending.used) {
      pending.used = true;
      event({ type: "filechooser", action: "uploaded", multiple: chooser.isMultiple(), tabId: state.tabIdOf(page), uploadId: pending.uploadId, filename: pending.filename });
      chooser.setFiles(pending.file, { timeout: ACTION_TIMEOUT_MS }).then(pending.resolve, pending.reject);
      return;
    }
    event({ type: "filechooser", action: "cancelled", multiple: chooser.isMultiple(), tabId: state.tabIdOf(page) });
  });
  page.on("download", (download) => handleDownload(download, page));
  page.on("crash", () => event({ type: "page_crashed", tabId: state.tabIdOf(page) }));
}

// ---------------------------------------------------------------------------------------------
// Downloads (C16): admitted up to the count limit, watched while in progress, checked on completion.
// ---------------------------------------------------------------------------------------------

const ledger = new DownloadLedger();
const inFlight = new Map(); // downloadId -> Playwright Download
let downloadMonitor = null;
/** Set while an `upload` op waits for a file chooser on one page. */
let pendingUpload = null;

function partialSizes() {
  const sizes = [];
  for (const name of fs.readdirSync(DOWNLOAD_RAW_DIR)) {
    try {
      const st = fs.lstatSync(path.join(DOWNLOAD_RAW_DIR, name));
      if (st.isFile()) sizes.push(st.size);
    } catch {}
  }
  return sizes;
}

function cancelInFlight(reason) {
  for (const [downloadId, download] of inFlight) {
    if (ledger.cancel(downloadId, reason)) {
      const record = ledger.get(downloadId);
      event({ type: "download", action: "cancelled", downloadId, reason, suggestedFilename: record.suggestedFilename, tabId: record.tabId });
      log("download_cancelled", { downloadId, reason });
    }
    download.cancel().catch(() => {});
  }
}

function watchDownloads() {
  if (downloadMonitor) return;
  downloadMonitor = setInterval(() => {
    if (inFlight.size === 0) {
      clearInterval(downloadMonitor);
      downloadMonitor = null;
      return;
    }
    let reason = null;
    try { reason = ledger.progress(partialSizes()); } catch (error) { reason = "monitor_error"; }
    if (reason) cancelInFlight(reason);
  }, DOWNLOAD_POLL_MS);
}

function handleDownload(download, page) {
  const record = ledger.begin({
    suggestedFilename: boundMessage(cutAtCodeUnits(download.suggestedFilename(), 200)),
    url: cutAtCodeUnits(download.url(), 2048),
    tabId: state.tabIdOf(page),
  });
  const { downloadId } = record;
  if (record.state !== "in_progress") {
    event({ type: "download", action: "cancelled", downloadId, reason: record.reason, suggestedFilename: record.suggestedFilename, tabId: record.tabId });
    download.cancel().catch(() => {});
    download.delete().catch(() => {});
    return;
  }
  inFlight.set(downloadId, download);
  watchDownloads();
  log("download_started", { downloadId, url: record.url.slice(0, 200) });
  record.done = (async () => {
    const failure = await download.failure().catch((error) => error?.message ?? "failed");
    inFlight.delete(downloadId);
    try {
      if (ledger.get(downloadId)?.state !== "in_progress") return; // cancelled by the monitor
      if (failure) {
        ledger.fail(downloadId, failure);
        event({ type: "download", action: "failed", downloadId, reason: boundMessage(failure).slice(0, 200), suggestedFilename: record.suggestedFilename, tabId: record.tabId });
        return;
      }
      const raw = await download.path();
      const st = fs.lstatSync(raw);
      if (!st.isFile() || st.size > MAX_DOWNLOAD_BYTES) {
        ledger.cancel(downloadId, "size_limit");
        event({ type: "download", action: "cancelled", downloadId, reason: "size_limit", suggestedFilename: record.suggestedFilename, tabId: record.tabId });
        return;
      }
      const bytes = fs.readFileSync(raw);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const mediaType = sniffMediaType(bytes, record.suggestedFilename);
      const refusal = ledger.complete(downloadId, { bytes: bytes.length, sha256, mediaType });
      if (refusal) {
        event({ type: "download", action: "cancelled", downloadId, reason: refusal, suggestedFilename: record.suggestedFilename, tabId: record.tabId });
        return;
      }
      fs.writeFileSync(path.join(DOWNLOAD_DIR, downloadId), bytes, { mode: 0o600, flag: "wx" });
      event({ type: "download", action: "saved", downloadId, bytes: bytes.length, sha256, mediaType, suggestedFilename: record.suggestedFilename, tabId: record.tabId });
      log("download_saved", { downloadId, bytes: bytes.length, mediaType });
    } catch (error) {
      ledger.fail(downloadId, error?.message ?? "download handling failed");
    } finally {
      await download.delete().catch(() => {});
    }
  })();
}

for (const page of context.pages()) track(page, true);
if (state.tabs.size === 0) track(await context.newPage(), true);
context.on("page", (page) => track(page, false));

// ---------------------------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------------------------

class OpError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function activePage() {
  const page = state.activeHandle();
  if (!page || page.isClosed()) throw new OpError("tab_not_found", "no active tab");
  return page;
}

async function tabsList() {
  const tabs = [];
  for (const [tabId, page] of state.tabs) {
    let title = "";
    try { title = await page.title(); } catch {}
    tabs.push({ tabId, url: cutAtCodeUnits(page.url(), 2048), title: cutAtCodeUnits(title, 512), active: tabId === state.activeTabId });
  }
  return tabs;
}

async function settle(page) {
  await page.waitForTimeout(250);
  await page.waitForLoadState("domcontentloaded", { timeout: 5_000 }).catch(() => {});
}

function locate(page, ref) {
  return page.locator(`aria-ref=${ref}`);
}

function sandboxEvidence() {
  const processes = [];
  for (const pid of fs.readdirSync("/proc").filter((entry) => /^[0-9]+$/.test(entry))) {
    try {
      // Chromium children rewrite their title, so argv may be space- rather than NUL-separated.
      const argv = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split(/[\0 ]+/).filter(Boolean);
      if (!argv[0]?.includes("chrom")) continue;
      const type = argv.find((a) => a.startsWith("--type="))?.slice(7) ?? "browser";
      const nspid = /NSpid:\s*(.*)/.exec(fs.readFileSync(`/proc/${pid}/status`, "utf8"))?.[1]?.trim().split(/\s+/) ?? [];
      processes.push({ type, noSandboxFlag: argv.includes("--no-sandbox"), pidNamespaceDepth: nspid.length });
    } catch {}
  }
  return {
    chromiumProcesses: processes.length,
    anyNoSandboxFlag: processes.some((p) => p.noSandboxFlag),
    zygotePresent: processes.some((p) => p.type === "zygote"),
    // A renderer inside Chromium's namespace sandbox lives in a nested PID namespace.
    renderersInNestedPidNamespace:
      processes.some((p) => p.type === "renderer") &&
      processes.filter((p) => p.type === "renderer").every((p) => p.pidNamespaceDepth > 1),
    renderers: processes.filter((p) => p.type === "renderer").length,
  };
}

/** Controls that hold an approval code: by accessible name, or by DOM name attribute (redaction). */
function approvalLocators(page) {
  return [page.locator(`[name="${APPROVAL_INPUT_NAME}" i]`), page.getByLabel(APPROVAL_NAME)];
}

/**
 * Drop `value` (and set `redacted: true`) on every control that is, or may be, an approval input:
 * its accessible name matches /approval code/i, or its DOM `name` is airlock_approval. The DOM name is
 * read by the runner's fixed code; if it cannot be read the value is dropped (fail closed).
 */
async function redactApprovalValues(page, controls) {
  await Promise.all(controls.map(async (control) => {
    if (control.value === undefined) return;
    let redact = isApprovalName(control.name);
    if (!redact) {
      try {
        const name = await locate(page, control.ref).getAttribute("name", { timeout: 2_000 });
        redact = isApprovalInputName(name);
      } catch {
        redact = true;
      }
    }
    if (redact) {
      delete control.value;
      control.redacted = true;
    }
  }));
}

const handlers = {
  async status() {
    return {
      ready: true,
      browserVersion,
      generation: state.generation,
      activeTabId: state.activeTabId,
      tabCount: state.tabs.size,
      uid: process.getuid(),
      proxy: PROXY,
      sandbox: sandboxEvidence(),
      mutationGuard: { installed: true, origins: [...MUTATION_ORIGINS], websockets: "blocked", blocked: state.mutationsBlocked },
    };
  },

  async navigate({ url }) {
    const page = activePage();
    let response;
    try {
      response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS });
    } catch (error) {
      state.navigated(state.activeTabId);
      throw new OpError("navigation_failed", error?.message?.split("\n")[0] ?? "navigation failed");
    }
    const egress = response?.headers()["x-airlock-egress"];
    return {
      generation: state.generation,
      tabId: state.activeTabId,
      url: cutAtCodeUnits(page.url(), 2048),
      status: response?.status() ?? null,
      ...(egress ? { egressDenied: true, egress: cutAtCodeUnits(egress, 200) } : {}),
    };
  },

  async observe() {
    const page = activePage();
    await page.waitForLoadState("domcontentloaded", { timeout: 5_000 }).catch(() => {});
    let snapshot = "";
    let before = -1;
    // If the page navigates while the snapshot is taken, take it again so refs match the page.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      before = state.generation;
      snapshot = await page.ariaSnapshot({ mode: "ai", timeout: ACTION_TIMEOUT_MS });
      if (state.generation === before) break;
    }
    const parsed = parseAriaSnapshot(snapshot);
    await redactApprovalValues(page, parsed.controls);
    let raw = "";
    try { raw = await page.locator("body").innerText({ timeout: 5_000 }); } catch {}
    const collapsed = raw.replace(/[ \t\f\v ]+/g, " ").replace(/\n\s*\n+/g, "\n\n").trim();
    const text = cutUtf8(collapsed);
    const generation = state.recordSnapshot(state.activeTabId, parsed.refs);
    const title = cutAtCodeUnits(await page.title().catch(() => ""), 512);
    const delivered = state.drainEvents();
    return {
      generation,
      tabId: state.activeTabId,
      url: cutAtCodeUnits(page.url(), 2048),
      title,
      text: text.text,
      textTruncated: text.truncated,
      controls: parsed.controls,
      controlsTruncated: parsed.truncated,
      tabs: await tabsList(),
      events: delivered.events,
      droppedEvents: delivered.droppedEvents,
      pendingReview: delivered.pendingReview,
    };
  },

  async click({ ref, generation }) {
    state.checkRef(ref, generation);
    const page = activePage();
    await locate(page, ref).click({ timeout: ACTION_TIMEOUT_MS });
    await settle(page);
    return { generation: state.generation, invalidated: state.generation !== generation, url: cutAtCodeUnits(page.url(), 2048) };
  },

  async type({ ref, generation, text, submit }) {
    state.checkRef(ref, generation);
    const page = activePage();
    const target = locate(page, ref);
    await target.fill(text, { timeout: ACTION_TIMEOUT_MS });
    if (submit) {
      await target.press("Enter", { timeout: ACTION_TIMEOUT_MS });
      await settle(page);
    }
    return { generation: state.generation, invalidated: state.generation !== generation, url: cutAtCodeUnits(page.url(), 2048) };
  },

  async key({ key, generation }) {
    state.checkGeneration(generation);
    const page = activePage();
    await page.keyboard.press(key);
    await settle(page);
    return { generation: state.generation, invalidated: state.generation !== generation, url: cutAtCodeUnits(page.url(), 2048) };
  },

  async scroll({ dx, dy }) {
    const page = activePage();
    await page.mouse.move(VIEWPORT.width / 2, VIEWPORT.height / 2);
    await page.mouse.wheel(dx, dy);
    await page.waitForTimeout(150);
    return { generation: state.generation, url: cutAtCodeUnits(page.url(), 2048) };
  },

  async screenshot({ fullPage }) {
    const page = activePage();
    // The approval field's value is never shown to the model, in pixels either.
    const png = await page.screenshot({ type: "png", fullPage, timeout: 15_000, animations: "disabled", mask: approvalLocators(page), maskColor: "#000000" });
    if (png.length > MAX_SCREENSHOT_BYTES) {
      throw new OpError("screenshot_too_large", `screenshot is ${png.length} bytes; limit ${MAX_SCREENSHOT_BYTES}`);
    }
    const size = pngSize(png);
    if (!size) throw new OpError("action_failed", "screenshot did not produce a PNG");
    return {
      png: png.toString("base64"),
      bytes: png.length,
      width: size.width,
      height: size.height,
      sha256: createHash("sha256").update(png).digest("hex"),
      url: cutAtCodeUnits(page.url(), 2048),
      tabId: state.activeTabId,
      generation: state.generation,
      capturedAt: new Date().toISOString(),
    };
  },

  async "tabs.list"() {
    return { generation: state.generation, activeTabId: state.activeTabId, tabs: await tabsList() };
  },

  async "tabs.switch"({ tabId }) {
    if (!state.switchTab(tabId)) throw new OpError("tab_not_found", `no tab ${tabId}`);
    await activePage().bringToFront().catch(() => {});
    return { generation: state.generation, activeTabId: state.activeTabId, tabs: await tabsList() };
  },

  async "download.list"() {
    return ledger.list();
  },

  async "download.read"({ downloadId, offset }) {
    const record = ledger.get(downloadId);
    if (!record) throw new OpError("invalid_request", `no download ${downloadId}`);
    if (record.state === "in_progress" && record.done) {
      // Give a download that is still arriving a bounded moment to finish.
      await Promise.race([record.done, new Promise((r) => setTimeout(r, 10_000))]);
    }
    if (record.state !== "completed") {
      throw new OpError("action_failed", `download ${downloadId} is ${record.state}${record.reason ? ` (${record.reason})` : ""}`);
    }
    if (offset > record.bytes) throw new OpError("invalid_request", `offset ${offset} is past the end (${record.bytes} bytes)`);
    const length = Math.min(DOWNLOAD_CHUNK_BYTES, record.bytes - offset);
    const chunk = Buffer.alloc(length);
    const fd = fs.openSync(path.join(DOWNLOAD_DIR, downloadId), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      let read = 0;
      while (read < length) {
        const n = fs.readSync(fd, chunk, read, length - read, offset + read);
        if (n === 0) break;
        read += n;
      }
      if (read !== length) throw new OpError("action_failed", `download ${downloadId} is shorter than recorded`);
    } finally {
      fs.closeSync(fd);
    }
    return {
      downloadId,
      suggestedFilename: record.suggestedFilename,
      url: record.url,
      mediaType: record.mediaType,
      bytes: record.bytes,
      sha256: record.sha256,
      offset,
      chunkBytes: length,
      chunkBase64: chunk.toString("base64"),
      eof: offset + length === record.bytes,
    };
  },

  async upload({ ref, generation, uploadId, filename, sha256 }) {
    state.checkRef(ref, generation);
    // Only a regular file the supervisor placed under /tmp/uploads/<uploadId>/, never through a symlink.
    const dir = path.join(UPLOAD_DIR, uploadId);
    const file = path.join(dir, filename);
    let st;
    try { st = fs.lstatSync(file); } catch { throw new OpError("action_failed", `upload ${uploadId} has not been placed`); }
    if (!st.isFile() || fs.lstatSync(dir).isSymbolicLink() || fs.realpathSync(file) !== file) throw new OpError("action_failed", "upload is not a regular file under /tmp/uploads");
    if (st.size > MAX_UPLOAD_BYTES) throw new OpError("action_failed", `upload is ${st.size} bytes; limit ${MAX_UPLOAD_BYTES}`);
    const actual = createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    if (actual !== sha256) throw new OpError("action_failed", "upload bytes do not match their sha256");
    const page = activePage();
    const target = locate(page, ref);
    const isFileInput = await target.evaluate((el) => el instanceof HTMLInputElement && el.type === "file", undefined, { timeout: ACTION_TIMEOUT_MS });
    if (isFileInput) {
      await target.setInputFiles(file, { timeout: ACTION_TIMEOUT_MS });
      event({ type: "filechooser", action: "uploaded", multiple: false, tabId: state.activeTabId, uploadId, filename, via: "input" });
    } else {
      // A button that opens a chooser: the chooser handler answers it with this file, once.
      let settleUpload;
      const answered = new Promise((resolve, reject) => { settleUpload = { resolve, reject }; });
      answered.catch(() => {}); // a late setFiles failure after the wait gave up must not crash the runner
      pendingUpload = { page, file, uploadId, filename, used: false, resolve: settleUpload.resolve, reject: settleUpload.reject };
      try {
        await target.click({ timeout: ACTION_TIMEOUT_MS });
        const outcome = await Promise.race([answered.then(() => "set"), new Promise((r) => setTimeout(() => r("none"), UPLOAD_CHOOSER_WAIT_MS))]);
        if (outcome !== "set") throw new OpError("action_failed", "no file chooser opened for this control");
      } finally {
        pendingUpload = null;
      }
    }
    await settle(page);
    return { generation: state.generation, invalidated: state.generation !== generation, url: cutAtCodeUnits(page.url(), 2048), uploadId, filename, bytes: st.size, sha256 };
  },

  async "tabs.close"({ tabId }) {
    const page = state.tabs.get(tabId);
    if (!page) throw new OpError("tab_not_found", `no tab ${tabId}`);
    if (state.tabs.size === 1) throw new OpError("last_tab", "the last tab cannot be closed");
    await page.close({ runBeforeUnload: false });
    state.removeTab(tabId); // idempotent with the close handler
    return { generation: state.generation, activeTabId: state.activeTabId, tabs: await tabsList() };
  },
};

async function execute(line) {
  const parsed = parseRequest(line);
  if (!parsed.ok) return parsed.response;
  const { id, op, args } = parsed.request;
  if (MUTATING_OPS.has(op) && state.pendingReview) {
    return errorResponse(id, op, "pending_review", "a dismissed dialog awaits review; observe first");
  }
  try {
    return okResponse(id, op, await handlers[op](args));
  } catch (error) {
    if (error instanceof StaleReference) return errorResponse(id, op, "stale_reference", error.message);
    if (error instanceof OpError) return errorResponse(id, op, error.code, error.message);
    const message = error?.message?.split("\n")[0] ?? String(error);
    return errorResponse(id, op, /Timeout/i.test(error?.name ?? "") || /timeout/i.test(message) ? "timeout" : "action_failed", message);
  }
}

// One operation at a time, in arrival order.
let queue = Promise.resolve();
const serialize = (fn) => {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
};

// ---------------------------------------------------------------------------------------------
// Unix socket transport: one bounded request line in, one bounded response line out.
// ---------------------------------------------------------------------------------------------

const socketDir = path.dirname(SOCKET_PATH);
fs.mkdirSync(socketDir, { recursive: true, mode: 0o700 });
const dirStat = fs.statSync(socketDir);
if (dirStat.uid !== process.getuid()) fatal(`${socketDir} is not owned by the runner user`);
if ((dirStat.mode & 0o077) !== 0) fs.chmodSync(socketDir, 0o700);
fs.rmSync(SOCKET_PATH, { force: true });

const server = net.createServer((socket) => {
  let buffered = Buffer.alloc(0);
  let done = false;
  socket.setTimeout(10_000, () => socket.destroy());
  socket.on("error", () => socket.destroy());
  const reply = (response) => {
    if (socket.destroyed) return;
    socket.end(encodeResponse(response));
  };
  socket.on("data", (chunk) => {
    if (done) return;
    buffered = Buffer.concat([buffered, chunk]);
    const newline = buffered.indexOf(0x0a);
    if (newline === -1 && buffered.length <= MAX_REQUEST_BYTES) return;
    done = true;
    if (newline === -1 || newline > MAX_REQUEST_BYTES) {
      reply(errorResponse(null, null, "request_too_large", `request exceeds ${MAX_REQUEST_BYTES} bytes`));
      return;
    }
    socket.setTimeout(0);
    const line = buffered.subarray(0, newline).toString("utf8");
    serialize(() => execute(line)).then(reply, (error) => reply(errorResponse(null, null, "internal_error", error?.message)));
  });
});

const previousUmask = process.umask(0o177);
server.listen(SOCKET_PATH, () => {
  process.umask(previousUmask);
  fs.chmodSync(SOCKET_PATH, 0o600);
  log("ready", { socket: SOCKET_PATH, browserVersion, uid: process.getuid(), proxy: PROXY });
});

const shutdown = async (signal) => {
  if (stopping) return;
  stopping = true;
  log("stopping", { signal });
  server.close();
  await context.close().catch(() => {});
  for (const dir of [profileDir, DOWNLOAD_RAW_DIR, DOWNLOAD_DIR, UPLOAD_DIR]) fs.rmSync(dir, { recursive: true, force: true });
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
