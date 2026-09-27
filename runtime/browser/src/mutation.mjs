// Mutation guard: the browser may READ allowlisted sites, but it may not change state on them.
//
// The egress proxy only sees CONNECT host:port, so it cannot tell a GET from a form POST inside a
// TLS tunnel. This guard runs in the fixed runner (trusted code outside the page): every request the
// browser context makes is routed through Playwright's interception (the page cannot opt out), and
// any request whose method is not GET/HEAD/OPTIONS is aborted unless its origin is one of the exact
// https origins the supervisor configured in AIRLOCK_BROWSER_MUTATION_ORIGINS (the controlled form
// destination; empty = none). A GET/HEAD/OPTIONS request that carries a body (e.g. `fetch(url,
// { method: "OPTIONS", body })`) is treated as a mutation too. WebSockets are refused outright (no
// origin exception): a socket is a bidirectional channel whose frames the guard cannot classify.
//
// Workers: Playwright's WebSocket routing (like every init script) reaches documents only, not
// workers, and CDP URL blocking does not apply to WebSockets; and a SHARED worker's HTTP requests are
// not seen by the context route at all (a dedicated worker's are). All verified in the image
// (apps/supervisor/test/browser-mutation-integration.test.ts, in-image harness). So `Worker` and
// `SharedWorker` are removed from every document by an init script (constructing one throws a
// SecurityError); service workers are blocked at launch. No worker can start.
//
// Covered by the route: form submissions (any target, including new tabs), fetch/XHR, fetch
// keepalive, navigator.sendBeacon, <a ping>, CSP report-uri reports, and upload
// submissions (an `upload` op only sets files on an input; the POST that submits them is a mutation
// like any other). Service workers are blocked at launch, so none can bypass the context route.
//
// The policy functions import nothing, so they are unit-testable without a browser.

export const SAFE_METHODS = Object.freeze(new Set(["GET", "HEAD", "OPTIONS"]));
export const MAX_MUTATION_ORIGINS = 16;
/** Longest request URL (origin + path, query and fragment dropped) recorded in an event. */
export const MUTATION_URL_CHARS = 512;

/**
 * Parse AIRLOCK_BROWSER_MUTATION_ORIGINS: a JSON list of exact https origins (scheme://host[:port],
 * no path, no trailing slash, no userinfo). Unset or empty means no origin may receive a mutation.
 * Throws on anything else, so a malformed value stops the runner instead of widening the policy.
 */
export function parseMutationOrigins(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return new Set();
  let list;
  try { list = JSON.parse(String(raw)); } catch { throw new Error("AIRLOCK_BROWSER_MUTATION_ORIGINS is not JSON"); }
  if (!Array.isArray(list)) throw new Error("AIRLOCK_BROWSER_MUTATION_ORIGINS must be a JSON array");
  if (list.length > MAX_MUTATION_ORIGINS) throw new Error(`AIRLOCK_BROWSER_MUTATION_ORIGINS has more than ${MAX_MUTATION_ORIGINS} entries`);
  const origins = new Set();
  for (const entry of list) {
    const reason = checkMutationOrigin(entry);
    if (reason) throw new Error(`AIRLOCK_BROWSER_MUTATION_ORIGINS: ${reason}`);
    origins.add(entry);
  }
  return origins;
}

/** Why `entry` is not an exact https origin, or undefined when it is. */
export function checkMutationOrigin(entry) {
  if (typeof entry !== "string" || entry.length === 0 || entry.length > 300) return "each entry must be a string of 1..300 chars";
  let url;
  try { url = new URL(entry); } catch { return `${JSON.stringify(entry.slice(0, 80))} is not a URL`; }
  if (url.protocol !== "https:") return `${JSON.stringify(entry.slice(0, 80))} is not https`;
  if (url.origin !== entry) return `${JSON.stringify(entry.slice(0, 80))} is not an exact origin (expected ${JSON.stringify(url.origin)})`;
  return undefined;
}

/** origin + path of a request URL (query and fragment dropped: they can carry page data), bounded. */
export function boundedRequestUrl(raw) {
  let text;
  try {
    const url = new URL(raw);
    text = url.protocol === "http:" || url.protocol === "https:" || url.protocol === "ws:" || url.protocol === "wss:"
      ? `${url.origin}${url.pathname}`
      : `${url.protocol}`;
  } catch {
    text = "";
  }
  return text.length > MUTATION_URL_CHARS ? text.slice(0, MUTATION_URL_CHARS) : text;
}

/**
 * The decision for one HTTP(S) request: GET/HEAD/OPTIONS without a body pass; anything else (another
 * method, or a safe method carrying a body) passes only to an exact origin in `origins` over https.
 * Returns { allowed, method } (method upper-cased, bounded; `+BODY` marks a safe method with a body).
 */
export function mutationDecision(method, rawUrl, origins, hasBody = false) {
  const upper = String(method ?? "").toUpperCase().slice(0, 16);
  if (SAFE_METHODS.has(upper) && !hasBody) return { allowed: true, method: upper };
  const m = SAFE_METHODS.has(upper) ? `${upper}+BODY` : upper;
  let url;
  try { url = new URL(rawUrl); } catch { return { allowed: false, method: m }; }
  return { allowed: url.protocol === "https:" && origins.has(url.origin), method: m };
}

/**
 * Install the guard on a Playwright BrowserContext. `onBlocked({ method, url, page })` is called for
 * each refusal (url already bounded; page null when unknown). Resolves once the worker block and
 * both routes are registered.
 */
/**
 * Runs before any page script in every document (all frames, including about:blank children):
 * removes the Worker and SharedWorker constructors, non-configurably.
 */
export const WORKER_BLOCK_SCRIPT = `(() => {
  const refuse = function Worker() { throw new DOMException("Workers are disabled in this browser (Airlock)", "SecurityError"); };
  for (const name of ["Worker", "SharedWorker"]) {
    try { Object.defineProperty(globalThis, name, { value: refuse, writable: false, configurable: false, enumerable: false }); } catch {}
  }
})();`;

export async function installMutationGuard(context, origins, onBlocked, { blockWorkers = true } = {}) {
  // blockWorkers:false exists only for the in-image harness's control run (proves the block is needed).
  if (blockWorkers) await context.addInitScript({ content: WORKER_BLOCK_SCRIPT });
  await context.route("**/*", async (route, request) => {
    let hasBody = false;
    try { hasBody = (request.postDataBuffer()?.length ?? 0) > 0; } catch { hasBody = true; } // unreadable body: treat as present
    const decision = mutationDecision(request.method(), request.url(), origins, hasBody);
    if (decision.allowed) {
      await route.continue().catch(() => {});
      return;
    }
    let page = null;
    try { page = request.frame().page(); } catch {} // worker requests have no frame
    try { onBlocked({ method: decision.method, url: boundedRequestUrl(request.url()), page }); } catch {}
    await route.abort("blockedbyclient").catch(() => {});
  });
  await context.routeWebSocket(() => true, (ws) => {
    try { onBlocked({ method: "WEBSOCKET", url: boundedRequestUrl(ws.url()), page: null }); } catch {}
    // Never connectToServer(): the socket is closed without any frame reaching the network.
    Promise.resolve().then(() => ws.close({ code: 1008, reason: "blocked by Airlock" })).catch(() => {});
  });
}
