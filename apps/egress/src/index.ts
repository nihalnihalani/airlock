/**
 * Entry point: one egress proxy process per browser attempt. Policy comes only from the
 * environment the supervisor sets at container create (controller-selected), never from page content.
 *
 *   AIRLOCK_EGRESS_ALLOW   JSON array of hostnames / ".suffix" / public IP literals ([] = deny all)
 *   AIRLOCK_EGRESS_PORTS   JSON array of ports (default [443, 80])
 *   AIRLOCK_EGRESS_LISTEN  host:port to listen on (default 0.0.0.0:3128)
 *   AIRLOCK_EGRESS_RESOLVERS  comma-separated upstream DNS server IPs; when set, names are resolved
 *                          there instead of via resolv.conf (required under Kata, whose guest cannot
 *                          reach Docker's embedded DNS)
 */
import { createEgressProxy, upstreamResolver } from "./proxy.ts";
import { parsePolicy } from "./policy.ts";

const emit = (line: Record<string, unknown>) =>
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), ...line })}\n`);

let policy;
try {
  policy = parsePolicy(process.env.AIRLOCK_EGRESS_ALLOW, process.env.AIRLOCK_EGRESS_PORTS);
} catch (error) {
  emit({ event: "config_error", message: String((error as Error).message).slice(0, 300) });
  process.exit(2);
}

const listen = process.env.AIRLOCK_EGRESS_LISTEN ?? "0.0.0.0:3128";
const match = /^(.+):([0-9]{1,5})$/.exec(listen);
if (!match) {
  emit({ event: "config_error", message: "AIRLOCK_EGRESS_LISTEN must be host:port" });
  process.exit(2);
}

const resolversRaw = process.env.AIRLOCK_EGRESS_RESOLVERS?.trim();
let resolver;
try {
  resolver = resolversRaw ? upstreamResolver(resolversRaw.split(",").map((s) => s.trim()).filter(Boolean)) : undefined;
} catch (error) {
  emit({ event: "config_error", message: error instanceof Error ? error.message : "bad AIRLOCK_EGRESS_RESOLVERS" });
  process.exit(2);
}
const server = createEgressProxy({ policy, ...(resolver ? { resolver } : {}) });
server.listen(Number(match[2]), match[1]!.replace(/^\[|\]$/g, ""), () => {
  emit({
    event: "listening",
    listen,
    allowExact: [...policy.exact],
    allowSuffixes: policy.suffixes,
    ports: [...policy.ports],
  });
});

const stop = () => {
  emit({ event: "stopping" });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
