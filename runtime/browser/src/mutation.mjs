// Mutation guard: the browser may READ allowlisted sites, but it may not change state on them.
//
// The egress proxy only sees CONNECT host:port, so it cannot tell a GET from a form POST inside a
// TLS tunnel. This guard runs in the fixed runner (trusted code outside the page): every request the
// browser context makes is routed through Playwright's interception (the page cannot opt out), and
// any request whose method is not GET/HEAD/OPTIONS is aborted unless its origin is one of the exact
// https origins the supervisor configured in AIRLOCK_BROWSER_MUTATION_ORIGINS (the controlled form
// destination; empty = none). WebSockets are refused outright (no origin exception): a socket is a
// bidirectional channel whose frames the guard cannot classify.
//
// Covered by the route: form submissions (any target, including new tabs), fetch/XHR, fetch
// keepalive, navigator.sendBeacon, <a ping>, requests from dedicated workers, and upload
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
 * The decision for one HTTP(S) request: GET/HEAD/OPTIONS pass; every other method passes only to an
 * exact origin in `origins` over https. Returns { allowed, method } (method upper-cased, bounded).
 */
export function mutationDecision(method, rawUrl, origins) {
  const m = String(method ?? "").toUpperCase().slice(0, 16);
  if (SAFE_METHODS.has(m)) return { allowed: true, method: m };
  let url;
  try { url = new URL(rawUrl); } catch { return { allowed: false, method: m }; }
  return { allowed: url.protocol === "https:" && origins.has(url.origin), method: m };
}

/**
 * Install the guard on a Playwright BrowserContext. `onBlocked({ method, url, page })` is called for
 * each refusal (url already bounded; page null when unknown). Resolves once both routes are registered.
 */
export async function installMutationGuard(context, origins, onBlocked) {
  await context.route("**/*", async (route, request) => {
    const decision = mutationDecision(request.method(), request.url(), origins);
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
