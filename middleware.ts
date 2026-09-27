/**
 * Vercel Routing Middleware for the hosted web UI: forwards /api/* to the Airlock control plane
 * (AIRLOCK_API_ORIGIN, e.g. https://<control host>) so the browser stays same-origin and the
 * SameSite=Strict session cookie is first-party to this site.
 *
 * The control plane refuses a state-changing request whose Origin host differs from its Host.
 * Behind this proxy those differ by construction, so the same check is applied here against this
 * site's own host, and only a request that passes it is forwarded with Origin set to the
 * upstream's origin. A cross-site request is refused here exactly as the control plane would.
 */
import { rewrite } from "@vercel/functions";

export const config = { matcher: "/api/:path*" };

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function refuse(error: string): Response {
  return new Response(JSON.stringify({ error }), { status: 403, headers: { "content-type": "application/json" } });
}

export default function middleware(request: Request): Response {
  let upstream: URL;
  try {
    upstream = new URL(process.env.AIRLOCK_API_ORIGIN ?? "");
    if (upstream.protocol !== "https:") throw new Error("not https");
  } catch {
    return new Response(JSON.stringify({ error: "AIRLOCK_API_ORIGIN is not configured" }), { status: 503, headers: { "content-type": "application/json" } });
  }
  const url = new URL(request.url);
  const headers = new Headers(request.headers);
  if (!SAFE_METHODS.has(request.method.toUpperCase())) {
    const site = headers.get("sec-fetch-site");
    if (site !== null && site !== "same-origin" && site !== "none") return refuse("cross-site request refused");
    const origin = headers.get("origin");
    if (origin !== null) {
      let originHost: string | null = null;
      try {
        originHost = origin === "null" ? null : new URL(origin).host;
      } catch {
        originHost = null;
      }
      if (!originHost || originHost !== url.host) return refuse("cross-origin request refused");
      headers.set("origin", upstream.origin);
    }
  }
  return rewrite(new URL(url.pathname + url.search, upstream.origin), { request: { headers } });
}
