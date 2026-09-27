# Airlock browser runner protocol — schemaVersion 1

Transport: the supervisor runs `docker exec -i <browser-container> node /opt/airlock/client.mjs`, writes ONE JSON request (≤ 256 KiB) to stdin and reads ONE JSON line (≤ 4 MiB) from stdout. The client forwards the request over the unix socket `/run/airlock/runner.sock` (dir 0700, socket 0600, owner `pwuser`). The container exposes no TCP port, no CDP endpoint and holds no token. Operations run one at a time, in arrival order.

Client exit codes: `0` a well-formed runner response was written (`ok` may be true or false); `2` the client refused the input itself (an error line is still written); `3` transport failure (`runner_unavailable`, `timeout`, `response_too_large`). A lost runner (container exit, exit code 3 from every call) is an **interrupted attempt**; uncertain actions (`click`, `type`, `key`, `navigate`) must never be replayed.

Implementation: `src/protocol.mjs` (validation, bounds), `src/state.mjs` (generation/ref binding, tabs, events), `src/aria.mjs` (control snapshot), `src/runner.mjs`, `src/client.mjs`. Keep this file and `protocol.mjs` in step; the TypeScript below is the shape to lift into `packages/contracts`.

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
} as const;

export const ALLOWED_KEYS = [
  "Enter", "Tab", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
  "PageUp", "PageDown", "Home", "End", "Backspace",
] as const;

type Ref = string;         // /^[a-z0-9]{1,16}$/i  (Playwright aria ref, e.g. "e12", "f1e3")
type TabId = string;       // /^tab-[0-9]{1,6}$/
type Generation = number;  // non-negative safe integer
type RequestId = string;   // /^[A-Za-z0-9._:-]{1,64}$/

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
};
export type Tab = { tabId: TabId; url: string; title: string; active: boolean };

export type BrowserEvent = { at: string } & (
  | { type: "dialog"; dialogType: "alert" | "confirm" | "prompt" | "beforeunload"; message: string;
      tabId: TabId | null; action: "dismissed"; status: "dismissed" | "pending_review" } // never accepted
  | { type: "filechooser"; action: "cancelled"; multiple: boolean; tabId: TabId | null }
  | { type: "download"; action: "cancelled"; suggestedFilename: string; tabId: TabId | null } // downloads disabled in M3
  | { type: "tab_opened"; tabId: TabId; url: string; active: false }                          // never auto-followed
  | { type: "tab_closed"; tabId: TabId; wasActive: boolean; activeTabId: TabId | null }
  | { type: "popup_blocked"; reason: "tab_limit"; url: string }
  | { type: "page_crashed"; tabId: TabId | null }
);

export type StatusResult = {
  ready: true; browserVersion: string; generation: Generation; activeTabId: TabId | null;
  tabCount: number; uid: number; proxy: string;
  sandbox: { chromiumProcesses: number; anyNoSandboxFlag: boolean; zygotePresent: boolean;
             renderersInNestedPidNamespace: boolean; renderers: number };
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
```

## Semantics

- **Generation.** Increments on every `observe`, every main-frame navigation of the active tab (including one caused by `click`/`type`/`key`), every `tabs.switch`, and when the active tab closes. `click`/`type` require `ref` from the latest `observe` **of the current active tab** and `generation` equal to the current generation; `key` requires the current generation. Otherwise `stale_reference`. Playwright's `aria-ref` engine additionally resolves a ref only against the page's latest snapshot. `invalidated: true` in an action result means the model must observe before its next ref-bound action.
- **Tabs/popups.** Tracked up to 5; further popups are closed and reported (`popup_blocked`). A new tab never becomes active by itself. Every tab's traffic goes through the same egress proxy, so new pages are policy-checked there.
- **Dialogs.** Every dialog is dismissed, never accepted. `alert` is reported as `dismissed`; `confirm`/`prompt`/`beforeunload` as `pending_review`, and mutating ops (`navigate`, `click`, `type`, `key`, `scroll`, `tabs.switch`, `tabs.close`) return `pending_review` until an `observe` delivers the event. The controller decides whether to stop for human review; the runner never continues a destructive/unknown confirm on its own.
- **File chooser** is cancelled and reported. **Downloads** are refused (`acceptDownloads: false`) and reported. **Service workers** are blocked. No `evaluate`, CDP, script injection, cookie or storage operation exists.
- **Errors** are bounded (≤ 512 chars, control characters stripped).

## Browser launch (fixed in the runner, not caller-selectable)

`chromium.launchPersistentContext(<mkdtemp /tmp/airlock-profile-*>, { headless: true, chromiumSandbox: true, viewport: 1280x800, acceptDownloads: false, serviceWorkers: "block" })` with `--proxy-server=$AIRLOCK_PROXY --proxy-bypass-list=<-loopback> --disable-quic --force-webrtc-ip-handling-policy=disable_non_proxied_udp --disable-extensions --disable-background-networking --disable-sync --disable-features=DnsOverHttps,AsyncDns`. The runner refuses to start without `AIRLOCK_PROXY` and exits (container stops) if the browser context closes. On SIGTERM it closes the browser and deletes the profile directory; tmpfs removal on container destroy is the backstop.
