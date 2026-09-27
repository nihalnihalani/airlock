/**
 * Destination policy for the per-attempt browser egress proxy.
 *
 * `isPublicIp` is adapted from OpenMuse `apps/worker/src/network.ts`
 * (https://github.com/openmuse, commit 34b15bc80340e582fb8c25573646cfb0bbc5184d), MIT License,
 * Copyright (c) 2026 OpenMuse contributors. Changes: IPv6 parsing hardened (hex validation,
 * embedded-IPv4 and zone forms refused explicitly), classification returns a reason, and the
 * URL-level validation is replaced by an explicit hostname allowlist plus per-request DNS pinning
 * (see `resolveDestination`). The full MIT notice is reproduced in THIRD_PARTY_NOTICES.md.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
 * associated documentation files (the "Software"), to deal in the Software without restriction,
 * including without limitation the rights to use, copy, modify, merge, publish, distribute,
 * sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions: The above copyright notice and this
 * permission notice shall be included in all copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.
 */

import { isIP } from "node:net";

export type ResolvedAddress = { address: string; family: 4 | 6 };
/** Injected so tests can simulate rebinding; production uses node:dns `lookup(all, verbatim)`. */
export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;

export type DenyReason =
  | "bad_request"
  | "method_not_allowed"
  | "host_not_allowed"
  | "ip_literal_not_allowed"
  | "port_not_allowed"
  | "dns_failed"
  | "non_public_address"
  | "upstream_failed"
  | "capacity";

export class PolicyError extends Error {
  constructor(
    readonly reason: DenyReason,
    readonly status: number,
  ) {
    super(reason);
  }
}

/** The per-attempt policy, fixed at proxy start from controller-supplied configuration. */
export type EgressPolicy = {
  /** Exact hostnames, `.suffix` entries (subdomains only, not the apex), or public IP literals. */
  exact: Set<string>;
  suffixes: string[];
  ports: Set<number>;
};

const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** Lowercase, strip one trailing dot and IPv6 brackets; returns null for anything malformed. */
export function normalizeHost(raw: string): string | null {
  let host = raw.trim().toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (!host) return null;
  if (isIP(host)) return host.includes("%") ? null : host;
  if (!HOSTNAME.test(host)) return null;
  // A final all-numeric label is not a real TLD; resolvers may read it as an IPv4 shorthand
  // (`2130706433`, `127.1`), so it is refused before any lookup.
  const last = host.slice(host.lastIndexOf(".") + 1);
  if (/^[0-9]+$/.test(last) || /^0x[0-9a-f]*$/.test(last)) return null;
  return host;
}

export function parsePolicy(allowJson: string | undefined, portsJson: string | undefined): EgressPolicy {
  const allow: unknown = allowJson === undefined || allowJson.trim() === "" ? [] : JSON.parse(allowJson);
  if (!Array.isArray(allow) || allow.length > 256) throw new Error("AIRLOCK_EGRESS_ALLOW must be a JSON array (<= 256 entries)");
  const exact = new Set<string>();
  const suffixes: string[] = [];
  for (const entry of allow) {
    if (typeof entry !== "string") throw new Error("AIRLOCK_EGRESS_ALLOW entries must be strings");
    const isSuffix = entry.startsWith(".");
    const host = normalizeHost(isSuffix ? entry.slice(1) : entry);
    if (!host) throw new Error(`invalid allowlist entry: ${JSON.stringify(entry.slice(0, 100))}`);
    if (isIP(host)) {
      if (isSuffix) throw new Error("an IP literal cannot be a suffix entry");
      if (!isPublicIp(host)) throw new Error(`allowlisted IP is not public: ${host}`);
      exact.add(host);
    } else if (isSuffix) {
      if (!host.includes(".")) throw new Error(`suffix entry too broad: .${host}`);
      suffixes.push(`.${host}`);
    } else {
      exact.add(host);
    }
  }
  const portsRaw: unknown = portsJson === undefined || portsJson.trim() === "" ? [443, 80] : JSON.parse(portsJson);
  if (!Array.isArray(portsRaw)) throw new Error("AIRLOCK_EGRESS_PORTS must be a JSON array");
  const ports = new Set<number>();
  for (const port of portsRaw) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`invalid port: ${String(port)}`);
    ports.add(port as number);
  }
  return { exact, suffixes, ports };
}

export function hostAllowed(policy: EgressPolicy, host: string): boolean {
  if (policy.exact.has(host)) return true;
  if (isIP(host)) return false;
  return policy.suffixes.some((suffix) => host.endsWith(suffix));
}

/** Expand an IPv6 textual address into eight 16-bit words, or null if malformed. */
function ipv6Words(address: string): number[] | null {
  if (address.includes(".") || address.includes("%")) return null;
  const halves = address.toLowerCase().split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const parts = halves.length === 1 ? left : [...left, ...Array<string>(missing).fill("0"), ...right];
  const words: number[] = [];
  for (const part of parts) {
    if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
    words.push(Number.parseInt(part, 16));
  }
  return words.length === 8 ? words : null;
}

/**
 * Conservative global-unicast allowlist. Loopback, RFC 1918, link-local (incl. 169.254.169.254
 * metadata), CGNAT, multicast, unspecified, benchmark/documentation, IPv6 ULA/link-local/loopback,
 * IPv4-mapped/compatible, NAT64, 6to4 and Teredo are never destinations.
 */
export function isPublicIp(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const [a = 0, b = 0, c = 0] = address.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (family !== 6) return false;
  const words = ipv6Words(address);
  if (!words) return false; // embedded-IPv4 notation (::ffff:10.0.0.1) and zones are refused outright
  const [first = 0, second = 0] = words;
  // Only 2000::/3 global unicast; this alone excludes ::1, ::, ::ffff:0:0/96, fc00::/7, fe80::/10,
  // ff00::/8 and 64:ff9b::/96. Within it, refuse Teredo/ORCHID/benchmark (2001:0000-01ff),
  // documentation (2001:db8, 3fff::/20) and 6to4 (2002::/16), which can embed private IPv4.
  return (
    first >= 0x2000 &&
    first <= 0x3fff &&
    !(first === 0x2001 && (second < 0x200 || second === 0xdb8)) &&
    first !== 0x2002 &&
    !(first === 0x3fff && second < 0x1000)
  );
}

export type Destination = { host: string; port: number; address: string; family: 4 | 6 };

/**
 * Policy check + DNS pinning for one request. Resolves exactly once; every returned address must be
 * public or the request is refused; the caller must connect to `address` and never re-resolve.
 */
export async function resolveDestination(
  policy: EgressPolicy,
  rawHost: string,
  port: number,
  resolver: Resolver,
  dnsTimeoutMs = 5000,
): Promise<Destination> {
  const host = normalizeHost(rawHost);
  if (!host) throw new PolicyError("bad_request", 400);
  if (!hostAllowed(policy, host)) {
    throw new PolicyError(isIP(host) ? "ip_literal_not_allowed" : "host_not_allowed", 403);
  }
  if (!policy.ports.has(port)) throw new PolicyError("port_not_allowed", 403);
  if (isIP(host)) {
    if (!isPublicIp(host)) throw new PolicyError("non_public_address", 403);
    return { host, port, address: host, family: isIP(host) as 4 | 6 };
  }
  let addresses: ResolvedAddress[];
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    addresses = await Promise.race([
      resolver(host),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("dns timeout")), dnsTimeoutMs);
      }),
    ]);
  } catch {
    throw new PolicyError("dns_failed", 502);
  } finally {
    clearTimeout(timer);
  }
  if (!Array.isArray(addresses) || addresses.length === 0) throw new PolicyError("dns_failed", 502);
  if (addresses.some((entry) => !isPublicIp(entry.address))) throw new PolicyError("non_public_address", 403);
  const selected = addresses.find((entry) => isIP(entry.address) === 4) ?? addresses[0]!;
  return { host, port, address: selected.address, family: isIP(selected.address) as 4 | 6 };
}
