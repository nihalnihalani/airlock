# Airlock browser runner protocol — schemaVersion 1

Transport: the supervisor runs `docker exec -i <browser-container> node /opt/airlock/client.mjs`, writes ONE JSON request (≤ 256 KiB) to stdin and reads ONE JSON line (≤ 4 MiB) from stdout. The client forwards the request over the unix socket `/run/airlock/runner.sock` (dir 0700, socket 0600, owner `pwuser`). The container exposes no TCP port, no CDP endpoint and holds no token. Operations run one at a time, in arrival order.

Client exit codes: `0` a well-formed runner response was written (`ok` may be true or false); `2` the client refused the input itself (an error line is still written); `3` transport failure (`runner_unavailable`, `timeout`, `response_too_large`). A lost runner (container exit, exit code 3 from every call) is an **interrupted attempt**; uncertain actions (`click`, `type`, `key`, `navigate`) must never be replayed.

Implementation: `src/protocol.mjs` (validation, bounds, media-type sniffing), `src/state.mjs` (generation/ref binding, tabs, events), `src/downloads.mjs` (download count/size/total ledger), `src/aria.mjs` (control snapshot), `src/runner.mjs`, `src/client.mjs`. Keep this file and `protocol.mjs` in step; the TypeScript below is the shape to lift into `packages/contracts`.

```ts
export const BROWSER_SCHEMA_VERSION = 1 as const;

// ---- limits -------------------------------------------------------------------------------
export const BROWSER_LIMITS = {
  requestBytes: 256 * 1024,
  responseBytes: 4 * 1024 * 1024,
  screenshotBytes: 2 * 1024 * 1024, // raw PNG, before base64
  textBytes: 32 * 1024,             // UTF-8, cut on a character boundary
  controls: 300,
  tabs: 5,
  events: 50,                        // per observe; overflow counted in droppedEvents
  errorMessageChars: 512,
  urlChars: 2048,
  typeTextChars: 8192,
  scrollDelta: 10_000,
  viewport: { width: 1280, height: 800 },
  downloadBytes: 10 * 1024 * 1024,      // per file: in-progress abort + completion re-check
  downloads: 10,                        // admitted (in progress or completed) per attempt
  downloadTotalBytes: 30 * 1024 * 1024, // completed + in-progress bytes per attempt
  downloadChunkBytes: 2 * 1024 * 1024,  // raw bytes per download.read reply
  uploadBytes: 10 * 1024 * 1024,
} as const;

export const ALLOWED_KEYS = [
  "Enter", "Tab", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
  "PageUp", "PageDown", "Home", "End", "Backspace",
] as const;

type Ref = string;         // /^[a-z0-9]{1,16}$/i  (Playwright aria ref, e.g. "e12", "f1e3")
type TabId = string;       // /^tab-[0-9]{1,6}$/
type Generation = number;  // non-negative safe integer
type RequestId = string;   // /^[A-Za-z0-9._:-]{1,64}$/
type DownloadId = string;  // /^dl-[0-9]{1,6}$/
type UploadId = string;    // /^up-[a-f0-9]{16}$/  (derived by the supervisor from its operation id)
type FileName = string;    // /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

// ---- requests (unknown top-level fields or args are rejected: invalid_request) --------------
export type BrowserRequest = { schemaVersion: 1; id?: RequestId } & (
  | { op: "status"; args?: {} }
  | { op: "navigate"; args: { url: string } }                      // http/https only, no userinfo
  | { op: "observe"; args?: {} }
  | { op: "click"; args: { ref: Ref; generation: Generation } }
  | { op: "type"; args: { ref: Ref; generation: Generation; text: string; submit?: boolean } } // fill (replace), then Enter if submit
  | { op: "key"; args: { key: (typeof ALLOWED_KEYS)[number]; generation: Generation } }
  | { op: "scroll"; args: { dx?: number; dy?: number } }             // integers, |d| <= 10000, default 0
  | { op: "screenshot"; args?: { fullPage?: boolean } }              // default false (viewport 1280x800)
  | { op: "tabs.list"; args?: {} }
  | { op: "tabs.switch"; args: { tabId: TabId } }
  | { op: "tabs.close"; args: { tabId: TabId } }
  | { op: "download.list"; args?: {} }
  | { op: "download.read"; args: { downloadId: DownloadId; offset?: number } }  // 0 <= offset <= 10 MiB
  | { op: "upload"; args: { ref: Ref; generation: Generation; uploadId: UploadId; filename: FileName; sha256: string } }
);

// ---- responses ----------------------------------------------------------------------------
export type BrowserResponse<R = unknown> =
  | { schemaVersion: 1; id: RequestId | null; op: string | null; ok: true; result: R }
  | { schemaVersion: 1; id: RequestId | null; op: string | null; ok: false; error: BrowserErrorCode; message: string };

export type BrowserErrorCode =
  | "invalid_request" | "unsupported_schema" | "unknown_op"
  | "stale_reference"      // ref/generation not from the latest observe of the active tab → observe again
  | "pending_review"       // a dismissed confirm/prompt/beforeunload has not been delivered by observe yet
  | "navigation_failed"    // e.g. net::ERR_TUNNEL_CONNECTION_FAILED when the egress proxy refuses a CONNECT
  | "action_failed" | "timeout" | "screenshot_too_large"
  | "tab_not_found" | "last_tab"
  | "request_too_large" | "response_too_large" | "runner_unavailable" | "internal_error";

export type Control = {
  ref: Ref; role: string; name: string;  // name/value cut to 200 UTF-16 units
  value?: string; disabled?: true; checked?: boolean;
  redacted?: true;   // value withheld: an approval input (name /approval code/i or DOM name airlock_approval)
};
export type Tab = { tabId: TabId; url: string; title: string; active: boolean };

export type BrowserEvent = { at: string } & (
  | { type: "dialog"; dialogType: "alert" | "confirm" | "prompt" | "beforeunload"; message: string;
      tabId: TabId | null; action: "dismissed"; status: "dismissed" | "pending_review" } // never accepted
  | { type: "filechooser"; action: "cancelled" | "uploaded"; multiple: boolean; tabId: TabId | null;
      uploadId?: UploadId; filename?: FileName; via?: "input" }                                // "uploaded" only while an upload op is pending
  | { type: "download"; action: "saved" | "cancelled" | "failed"; downloadId: DownloadId; suggestedFilename: string;
      tabId: TabId | null; reason?: string; bytes?: number; sha256?: string; mediaType?: string }
  | { type: "tab_opened"; tabId: TabId; url: string; active: false }                          // never auto-followed
  | { type: "tab_closed"; tabId: TabId; wasActive: boolean; activeTabId: TabId | null }
  | { type: "popup_blocked"; reason: "tab_limit"; url: string }
  | { type: "page_crashed"; tabId: TabId | null }
  | { type: "mutation_blocked"; method: string /* e.g. POST, PUT, WEBSOCKET */; url: string /* origin+path, ≤ 512 */;
      tabId: TabId | null; count: number }                                                   // repeats coalesce; ≤ 10 distinct per observe
);

export type StatusResult = {
  ready: true; browserVersion: string; generation: Generation; activeTabId: TabId | null;
  tabCount: number; uid: number; proxy: string;
  sandbox: { chromiumProcesses: number; anyNoSandboxFlag: boolean; zygotePresent: boolean;
             renderersInNestedPidNamespace: boolean; renderers: number };
  mutationGuard: { installed: true; origins: string[]; websockets: "blocked"; blocked: number }; // checked by the supervisor
};
export type NavigateResult = {
  generation: Generation; tabId: TabId; url: string; status: number | null;
  egressDenied?: true; egress?: string;   // present when the proxy answered with X-Airlock-Egress (plain-HTTP denial)
};
export type ObserveResult = {
  generation: Generation;                 // NEW generation; refs below are valid only for it
  tabId: TabId; url: string; title: string;
  text: string; textTruncated: boolean;   // visible body text, whitespace-collapsed, ≤ 32 KiB
  controls: Control[]; controlsTruncated: boolean; // interactive ARIA roles only, ≤ 300
  tabs: Tab[];
  events: BrowserEvent[]; droppedEvents: number;
  pendingReview: boolean;                 // true if any delivered event has status "pending_review"
};
export type ActionResult = { generation: Generation; invalidated: boolean; url: string }; // click/type/key
export type ScrollResult = { generation: Generation; url: string };
export type ScreenshotResult = {
  png: string /* base64 */; bytes: number; width: number; height: number;
  sha256: string /* hex of the PNG bytes */; url: string; tabId: TabId;
  generation: Generation; capturedAt: string /* ISO-8601 */;
};
export type TabsResult = { generation: Generation; activeTabId: TabId | null; tabs: Tab[] };

export type DownloadRecord = {
  downloadId: DownloadId; suggestedFilename: string /* untrusted, never a path */; url: string; tabId: TabId | null;
  state: "in_progress" | "completed" | "cancelled" | "failed";
  reason?: string;          // count_limit | size_limit | total_limit | monitor_error | <browser failure>
  bytes?: number; sha256?: string; mediaType?: string;   // when completed
  startedAt: string; finishedAt?: string;
};
export type DownloadListResult = {
  downloads: DownloadRecord[];   // <= 50 records; cancelled/failed ones are dropped first
  admitted: number; completedBytes: number;
  limits: { maxFileBytes: number; maxCount: number; maxTotalBytes: number };
};
export type DownloadChunkResult = {   // download.read
  downloadId: DownloadId; suggestedFilename: string; url: string; mediaType: string;
  bytes: number; sha256: string;       // of the whole file
  offset: number; chunkBytes: number; chunkBase64: string; eof: boolean;
};
export type UploadResult = {
  generation: Generation; invalidated: boolean; url: string;
  uploadId: UploadId; filename: FileName; bytes: number; sha256: string;
};
```

## Semantics

- **Generation.** Increments on every `observe`, every main-frame navigation of the active tab (including one caused by `click`/`type`/`key`), every `tabs.switch`, and when the active tab closes. `click`/`type` require `ref` from the latest `observe` **of the current active tab** and `generation` equal to the current generation; `key` requires the current generation. Otherwise `stale_reference`. Playwright's `aria-ref` engine additionally resolves a ref only against the page's latest snapshot. `invalidated: true` in an action result means the model must observe before its next ref-bound action.
- **Tabs/popups.** Tracked up to 5; further popups are closed and reported (`popup_blocked`). A new tab never becomes active by itself. Every tab's traffic goes through the same egress proxy, so new pages are policy-checked there.
- **Dialogs.** Every dialog is dismissed, never accepted. `alert` is reported as `dismissed`; `confirm`/`prompt`/`beforeunload` as `pending_review`, and mutating ops (`navigate`, `click`, `type`, `key`, `scroll`, `tabs.switch`, `tabs.close`) return `pending_review` until an `observe` delivers the event. The controller decides whether to stop for human review; the runner never continues a destructive/unknown confirm on its own.
- **File chooser** is cancelled and reported, unless an `upload` op is in progress for that page: then that one chooser is answered with the placed file (`action: "uploaded"`). **Service workers** are blocked. No `evaluate`, CDP, script injection, cookie or storage operation exists (the runner's own fixed code checks whether a ref is an `<input type=file>`).
- **Downloads** (C16). Chromium writes partial files into a private tmpfs directory (`/tmp/airlock-downloads-raw-*`). The runner admits at most **10** downloads per attempt (later ones are cancelled at once: `count_limit`), polls the partial files every 100 ms and cancels every in-progress download when one exceeds **10 MiB** (`size_limit`) or completed + in-progress bytes exceed **30 MiB** (`total_limit`), and re-checks size and total on completion. A completed file is stored by id (never by its suggested name) with its sha256 and a media type sniffed from the bytes (never from a header). Navigating to a URL that downloads returns `navigation_failed` ("Download is starting"); `download.list` shows the result. `download.read` returns ≤ 2 MiB per reply (waits ≤ 10 s for an in-progress download); the supervisor reads every chunk, reassembles, re-verifies size and sha256, re-sniffs the media type, and treats any inconsistency as a lost runner (interrupted).
- **Uploads** (C17). Only a regular file the supervisor placed at `/tmp/uploads/<uploadId>/<filename>` (not a symlink, realpath inside `/tmp/uploads`, ≤ 10 MiB, sha256 re-checked) can be uploaded. `upload` needs `ref`+`generation` from the latest observe (it is a mutating op, refused while a dialog awaits review): an `<input type=file>` gets the file directly; any other control is clicked and the next file chooser on that page (≤ 10 s) gets the file, once. The supervisor verifies the control plane's bytes against their `artifactSha256` before anything is placed, places them through the bounded exec stdin path (≤ 256 KiB per exec), re-checks size and sha256 inside the container, and never forwards a host path.
- **Mutations** (Stage 5: generic arbitrary-site irreversible submissions are unsupported). The egress proxy only sees `CONNECT host:port`, so the runner enforces this: before any page loads it registers `context.route("**/*")` (fixed trusted code; a page cannot bypass Playwright's interception) and aborts (`blockedbyclient`) every request whose method is not `GET`/`HEAD`/`OPTIONS` unless its origin is one of the exact https origins in `AIRLOCK_BROWSER_MUTATION_ORIGINS` (JSON list set by the supervisor; unset/empty = none; a malformed value stops the runner). This covers form submissions (Enter, `type submit:true`, clicks, any target tab), fetch/XHR, fetch `keepalive`, `navigator.sendBeacon`, dedicated-worker requests, and `<a ping>` (each verified against a local server inside the image: none arrived). Every WebSocket is refused (`context.routeWebSocket`; closed 1008 without connecting). Each refusal is queued as a `mutation_blocked` event (origin+path only; repeats coalesce into `count`; at most 10 distinct per observe, the rest counted in `droppedEvents`) and delivered by the next `observe`; the action itself still returns `ok`; a refused form navigation leaves the tab on Chromium's error page (`chrome-error://chromewebdata/`), a refused fetch/XHR fails in the page. **Uploads:** `upload` only sets files on an input; the request that submits them is a mutation like any other and is refused unless it goes to a configured origin (intended). GET requests are not restricted beyond the egress allowlist, so data can still leave in a GET query string to an allowlisted host.
- **Approval values.** A control whose accessible name matches `/approval code/i`, or whose DOM `name` is `airlock_approval` (read by the runner; unreadable → withheld), never carries `value` in `observe` (it carries `redacted: true`), and `screenshot` masks such inputs (black box). Page text is `innerText`, which never includes input values.
- **Errors** are bounded (≤ 512 chars, control characters stripped).

## Browser launch (fixed in the runner, not caller-selectable)

`chromium.launchPersistentContext(<mkdtemp /tmp/airlock-profile-*>, { headless: true, chromiumSandbox: true, viewport: 1280x800, acceptDownloads: true, downloadsPath: <mkdtemp /tmp/airlock-downloads-raw-*>, serviceWorkers: "block" })` with `--proxy-server=$AIRLOCK_PROXY --proxy-bypass-list=<-loopback> --disable-quic --force-webrtc-ip-handling-policy=disable_non_proxied_udp --disable-extensions --disable-background-networking --disable-sync --disable-features=DnsOverHttps,AsyncDns`, and the mutation guard (above) installed before the first page loads. The runner refuses to start without `AIRLOCK_PROXY` and exits (container stops) if the browser context closes. On SIGTERM it closes the browser and deletes the profile, download and upload directories; tmpfs removal on container destroy is the backstop.
