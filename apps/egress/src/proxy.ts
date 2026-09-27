/**
 * Airlock egress proxy: the only network destination of a browser attempt container.
 *
 * Structure (validate, then connect to the validated address, never re-resolve) follows OpenMuse
 * `apps/worker/src/proxy.ts` (commit 34b15bc80340e582fb8c25573646cfb0bbc5184d, MIT License,
 * Copyright (c) 2026 OpenMuse contributors; full notice in THIRD_PARTY_NOTICES.md). Rewritten on a
 * raw `node:net` server so that the request head is size-bounded, hop-by-hop headers are rebuilt,
 * every connection is `Connection: close` (one destination decision per client connection),
 * tunnels are bounded in lifetime/bytes, and every decision is logged as one JSON line. The policy is
 * an explicit hostname allowlist fixed at start (controller-supplied), not "any public host".
 */

import { connect, createServer, type Server, type Socket } from "node:net";
import { lookup } from "node:dns/promises";
import {
  PolicyError,
  resolveDestination,
  type DenyReason,
  type Destination,
  type EgressPolicy,
  type Resolver,
} from "./policy.ts";

export type Dialer = (destination: Destination) => Socket;
export type LogLine = Record<string, string | number | boolean | undefined>;

export type ProxyLimits = {
  maxHeaderBytes: number;
  headerTimeoutMs: number;
  connectTimeoutMs: number;
  idleTimeoutMs: number;
  maxTunnelMs: number;
  maxTunnelBytes: number;
  maxConnections: number;
  dnsTimeoutMs: number;
};

export const DEFAULT_LIMITS: ProxyLimits = {
  maxHeaderBytes: 16 * 1024,
  headerTimeoutMs: 10_000,
  connectTimeoutMs: 10_000,
  idleTimeoutMs: 60_000,
  maxTunnelMs: 5 * 60_000,
  maxTunnelBytes: 64 * 1024 * 1024,
  maxConnections: 128,
  dnsTimeoutMs: 5_000,
};

export type ProxyOptions = {
  policy: EgressPolicy;
  resolver?: Resolver;
  dial?: Dialer;
  log?: (line: LogLine) => void;
  limits?: Partial<ProxyLimits>;
};

export const systemResolver: Resolver = async (hostname) => {
  const entries = await lookup(hostname, { all: true, verbatim: true });
  return entries.map((entry) => ({ address: entry.address, family: entry.family === 6 ? 6 : 4 }));
};

const systemDialer: Dialer = (destination) =>
  connect({ host: destination.address, port: destination.port, family: destination.family });

const STATUS_TEXT: Record<number, string> = {
  400: "Bad Request",
  403: "Forbidden",
  405: "Method Not Allowed",
  431: "Request Header Fields Too Large",
  502: "Bad Gateway",
  503: "Service Unavailable",
};

const HOP_BY_HOP = new Set([
  "connection",
  "proxy-connection",
  "keep-alive",
  "proxy-authorization",
  "proxy-authenticate",
  "te",
  "trailer",
  "upgrade",
  "transfer-encoding",
]);

function denial(status: number, reason: DenyReason | "header_too_large" | "timeout"): string {
  const body = `Airlock egress denied: ${reason}\n`;
  return (
    `HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? "Error"}\r\n` +
    `Content-Type: text/plain; charset=utf-8\r\n` +
    `X-Airlock-Egress: denied; reason=${reason}\r\n` +
    `Connection: close\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
  );
}

type Head = { method: string; target: string; version: string; headers: Array<[string, string]> };

export function parseHead(text: string): Head | null {
  const lines = text.split("\r\n");
  const requestLine = lines.shift() ?? "";
  const match = /^([A-Z]{1,16}) (\S{1,8192}) (HTTP\/1\.[01])$/.exec(requestLine);
  if (!match) return null;
  const headers: Array<[string, string]> = [];
  for (const line of lines) {
    if (line === "") continue;
    // obs-fold and header lines without a token name are refused (request-smuggling hygiene).
    const colon = line.indexOf(":");
    if (colon <= 0 || /^[ \t]/.test(line)) return null;
    const name = line.slice(0, colon);
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) return null;
    headers.push([name, line.slice(colon + 1).trim()]);
  }
  return { method: match[1]!, target: match[2]!, version: match[3]!, headers };
}

/** `host:port` or `[v6]:port` from a CONNECT request target. */
export function parseAuthority(target: string): { host: string; port: number } | null {
  const match = /^(?:\[([0-9a-fA-F:.]+)\]|([^:\[\]]+)):([0-9]{1,5})$/.exec(target);
  if (!match) return null;
  const port = Number(match[3]);
  if (port < 1 || port > 65535) return null;
  return { host: (match[1] ?? match[2])!, port };
}

export function createEgressProxy(options: ProxyOptions): Server {
  const limits: ProxyLimits = { ...DEFAULT_LIMITS, ...options.limits };
  const resolver = options.resolver ?? systemResolver;
  const dial = options.dial ?? systemDialer;
  const log = options.log ?? ((line: LogLine) => process.stdout.write(`${JSON.stringify(line)}\n`));
  let active = 0;

  const decide = (fields: LogLine) => log({ ts: new Date().toISOString(), event: "decision", ...fields });

  const server = createServer({ pauseOnConnect: false }, (client) => {
    active += 1;
    let settled = false;
    let buffered = Buffer.alloc(0);
    client.on("error", () => client.destroy());
    client.on("close", () => {
      active -= 1;
    });

    const refuse = (
      status: number,
      reason: DenyReason | "header_too_large" | "timeout",
      fields: LogLine = {},
    ) => {
      decide({ ...fields, decision: "deny", reason, status });
      if (!client.destroyed) client.end(denial(status, reason));
    };

    if (active > limits.maxConnections) {
      settled = true;
      refuse(503, "capacity");
      return;
    }

    client.setTimeout(limits.headerTimeoutMs, () => {
      if (!settled) {
        settled = true;
        refuse(400, "timeout");
      }
    });

    const onData = (chunk: Buffer) => {
      if (settled) return;
      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf("\r\n\r\n");
      if (end === -1) {
        if (buffered.length > limits.maxHeaderBytes) {
          settled = true;
          client.off("data", onData);
          refuse(431, "header_too_large");
        }
        return;
      }
      if (end > limits.maxHeaderBytes) {
        settled = true;
        client.off("data", onData);
        refuse(431, "header_too_large");
        return;
      }
      settled = true;
      client.off("data", onData);
      client.pause();
      client.setTimeout(0);
      const head = parseHead(buffered.subarray(0, end).toString("latin1"));
      const rest = buffered.subarray(end + 4);
      void handle(client, head, rest).catch(() => client.destroy());
    };
    client.on("data", onData);
  });

  async function handle(client: Socket, head: Head | null, rest: Buffer): Promise<void> {
    const refuse = (status: number, reason: DenyReason, fields: LogLine) => {
      decide({ ...fields, decision: "deny", reason, status });
      if (!client.destroyed) client.end(denial(status, reason));
    };
    if (!head) return refuse(400, "bad_request", {});

    let host: string;
    let port: number;
    let kind: "connect" | "http";
    let path = "/";
    let hostHeader = "";
    if (head.method === "CONNECT") {
      const authority = parseAuthority(head.target);
      if (!authority) return refuse(400, "bad_request", { method: "CONNECT" });
      ({ host, port } = authority);
      kind = "connect";
    } else if (head.method === "GET" || head.method === "HEAD") {
      let url: URL;
      try {
        if (!/^http:\/\//i.test(head.target)) throw new Error("not absolute http");
        url = new URL(head.target);
      } catch {
        return refuse(400, "bad_request", { method: head.method });
      }
      if (url.username || url.password) return refuse(400, "bad_request", { method: head.method });
      const bodyHeader = head.headers.find(([name, value]) => {
        const lower = name.toLowerCase();
        return lower === "transfer-encoding" || (lower === "content-length" && value !== "0");
      });
      if (bodyHeader) return refuse(400, "bad_request", { method: head.method });
      host = url.hostname;
      port = url.port ? Number(url.port) : 80;
      path = `${url.pathname}${url.search}`;
      hostHeader = url.host;
      kind = "http";
    } else {
      return refuse(405, "method_not_allowed", { method: head.method.slice(0, 16) });
    }

    const logged = { method: head.method, host: host.slice(0, 255), port };
    let destination: Destination;
    try {
      destination = await resolveDestination(options.policy, host, port, resolver, limits.dnsTimeoutMs);
    } catch (error) {
      if (error instanceof PolicyError) return refuse(error.status, error.reason, logged);
      return refuse(502, "dns_failed", logged);
    }
    if (client.destroyed) return;

    const upstream = dial(destination);
    const startedAt = Date.now();
    let bytesUp = 0;
    let bytesDown = 0;
    let endReason = "closed";
    let connected = false;
    let closedLogged = false;
    const finish = (reason?: string) => {
      if (reason && endReason === "closed") endReason = reason;
      upstream.destroy();
      client.destroy();
    };
    const connectTimer = setTimeout(() => {
      if (!connected) {
        upstream.destroy();
        refuse(502, "upstream_failed", { ...logged, address: destination.address, detail: "connect_timeout" });
      }
    }, limits.connectTimeoutMs);
    const lifetime = setTimeout(() => finish("max_lifetime"), limits.maxTunnelMs);
    upstream.on("error", () => {
      if (!connected) {
        clearTimeout(connectTimer);
        refuse(502, "upstream_failed", { ...logged, address: destination.address });
      } else finish("upstream_error");
    });
    upstream.on("close", () => {
      clearTimeout(connectTimer);
      clearTimeout(lifetime);
      if (connected && !closedLogged) {
        closedLogged = true;
        log({
          ts: new Date().toISOString(),
          event: "closed",
          ...logged,
          address: destination.address,
          bytesUp,
          bytesDown,
          durationMs: Date.now() - startedAt,
          endReason,
        });
      }
      if (!client.destroyed) client.end();
    });
    client.on("close", () => upstream.destroy());

    const relay = (from: Socket, to: Socket, direction: "up" | "down") => {
      from.on("data", (chunk: Buffer) => {
        if (direction === "up") bytesUp += chunk.length;
        else bytesDown += chunk.length;
        if (bytesUp + bytesDown > limits.maxTunnelBytes) return finish("max_bytes");
        if (!to.write(chunk)) from.pause();
      });
      to.on("drain", () => from.resume());
      from.on("end", () => {
        if (direction === "down") to.end();
        else if (kind === "connect") to.end();
      });
    };

    upstream.once("connect", () => {
      connected = true;
      clearTimeout(connectTimer);
      decide({ ...logged, decision: "allow", reason: "allowlisted", address: destination.address });
      upstream.setTimeout(limits.idleTimeoutMs, () => finish("idle_timeout"));
      client.setTimeout(limits.idleTimeoutMs, () => finish("idle_timeout"));
      if (kind === "connect") {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (rest.length) {
          bytesUp += rest.length;
          upstream.write(rest);
        }
        relay(client, upstream, "up");
        relay(upstream, client, "down");
        client.resume();
      } else {
        const connectionTokens = new Set(
          head.headers
            .filter(([name]) => name.toLowerCase() === "connection")
            .flatMap(([, value]) => value.split(",").map((token) => token.trim().toLowerCase())),
        );
        const lines = [`${head.method} ${path} HTTP/1.1`, `Host: ${hostHeader}`];
        for (const [name, value] of head.headers) {
          const lower = name.toLowerCase();
          if (lower === "host" || HOP_BY_HOP.has(lower) || connectionTokens.has(lower)) continue;
          lines.push(`${name}: ${value}`);
        }
        lines.push("Connection: close", "", "");
        const requestHead = lines.join("\r\n");
        bytesUp += Buffer.byteLength(requestHead);
        upstream.write(requestHead);
        // One request per connection: anything the client pipelines after the head is discarded.
        relay(upstream, client, "down");
      }
    });
  }

  return server;
}
