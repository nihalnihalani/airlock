/**
 * Entry point for "Airlock fixtures".
 *
 *   AIRLOCK_FIXTURES_ORIGIN    public origin, e.g. https://forms.144-202-21-168.sslip.io (required)
 *   AIRLOCK_FORMS_SECRET       shared HMAC secret with the control plane, >= 32 chars (required)
 *   AIRLOCK_FIXTURES_DATA_DIR  directory for fixtures.sqlite (required; must be writable)
 *   AIRLOCK_FIXTURES_LISTEN    host:port (default 127.0.0.1:3100)
 *   AIRLOCK_TRUST_PROXY        "1" = key the rate limiter on the LAST X-Forwarded-For hop (set only
 *                              behind a same-host reverse proxy such as Caddy)
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { MIN_SECRET_LENGTH } from "./approval.ts";
import { createApp } from "./app.ts";
import { destinationOrigin } from "./forms.ts";
import { ReceiptStore } from "./store.ts";

const emit = (line: Record<string, unknown>) =>
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), service: "airlock-fixtures", ...line })}\n`);

function fail(message: string): never {
  emit({ event: "config_error", message });
  process.exit(2);
}

const rawOrigin = process.env.AIRLOCK_FIXTURES_ORIGIN ?? fail("AIRLOCK_FIXTURES_ORIGIN is required");
let origin: string;
try {
  origin = destinationOrigin(rawOrigin);
} catch {
  fail("AIRLOCK_FIXTURES_ORIGIN must be an http(s) origin");
}
const secret = process.env.AIRLOCK_FORMS_SECRET ?? "";
if (secret.length < MIN_SECRET_LENGTH) fail(`AIRLOCK_FORMS_SECRET must be at least ${MIN_SECRET_LENGTH} characters`);
const dataDir = process.env.AIRLOCK_FIXTURES_DATA_DIR ?? fail("AIRLOCK_FIXTURES_DATA_DIR is required");
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const listen = process.env.AIRLOCK_FIXTURES_LISTEN ?? "127.0.0.1:3100";
const match = /^(.+):([0-9]{1,5})$/.exec(listen) ?? fail("AIRLOCK_FIXTURES_LISTEN must be host:port");
const trustProxy = process.env.AIRLOCK_TRUST_PROXY === "1";

const store = new ReceiptStore(join(dataDir, "fixtures.sqlite"));
const app = createApp({ origin, secret, store, log: emit });

const server = Bun.serve({
  hostname: match[1]!.replace(/^\[|\]$/g, ""),
  port: Number(match[2]),
  maxRequestBodySize: 64 * 1024,
  fetch(req, srv) {
    let ip = srv.requestIP(req)?.address ?? "unknown";
    if (trustProxy) {
      const hops = (req.headers.get("x-forwarded-for") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      if (hops.length > 0) ip = hops[hops.length - 1]!;
    }
    return app.fetch(req, ip).catch((error) => {
      emit({ event: "internal_error", message: String((error as Error)?.message ?? error).slice(0, 300) });
      return new Response("internal error", { status: 500, headers: { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" } });
    });
  },
});
emit({ event: "listening", listen, origin, trustProxy });

const stop = () => {
  emit({ event: "stopping" });
  server.stop();
  store.close();
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
