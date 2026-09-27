import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { connect, createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { createEgressProxy, parseAuthority, type LogLine } from "../src/proxy.ts";
import { isPublicIp, normalizeHost, parsePolicy, type ResolvedAddress, type Resolver } from "../src/policy.ts";

// ---------------------------------------------------------------------------------------------
// Harness: a real proxy on loopback. DNS is a fake resolver; dialing is redirected to a local
// upstream (the proxy would refuse loopback itself), while recording which validated address the
// proxy asked to dial. That record is what proves "connect to the validated IP, never re-resolve".
// ---------------------------------------------------------------------------------------------

let upstream: Server;
let upstreamPort = 0;
let proxy: Server;
let proxyPort = 0;
const dialed: Array<{ address: string; port: number }> = [];
const logs: LogLine[] = [];
let dnsTable: Record<string, ResolvedAddress[] | ResolvedAddress[][]> = {};
const dnsCalls: Record<string, number> = {};

const resolver: Resolver = async (hostname) => {
  dnsCalls[hostname] = (dnsCalls[hostname] ?? 0) + 1;
  const entry = dnsTable[hostname];
  if (!entry) throw new Error("NXDOMAIN");
  // A list of lists is a sequence of answers over successive lookups (rebinding simulation).
  if (Array.isArray(entry[0])) {
    const answers = entry as ResolvedAddress[][];
    return answers[Math.min(dnsCalls[hostname]! - 1, answers.length - 1)]!;
  }
  return entry as ResolvedAddress[];
};

const pub = (address: string): ResolvedAddress => ({ address, family: address.includes(":") ? 6 : 4 });

beforeAll(async () => {
  upstream = createServer((socket) => {
    let seen = "";
    socket.on("data", (chunk) => {
      seen += chunk.toString("latin1");
      if (seen.startsWith("PING")) socket.write("PONG");
      else if (seen.includes("\r\n\r\n")) {
        const body = JSON.stringify({ head: seen.split("\r\n\r\n")[0] });
        socket.end(`HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`);
      }
    });
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  upstreamPort = (upstream.address() as AddressInfo).port;

  const policy = parsePolicy(JSON.stringify(["example.com", ".wikipedia.org", "rebind.test.example", "93.184.215.14"]), undefined);
  proxy = createEgressProxy({
    policy,
    resolver,
    dial: (destination) => {
      dialed.push({ address: destination.address, port: destination.port });
      return connect({ host: "127.0.0.1", port: upstreamPort });
    },
    log: (line) => logs.push(line),
    limits: { maxTunnelBytes: 64 * 1024 },
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  proxyPort = (proxy.address() as AddressInfo).port;
});

afterAll(() => {
  proxy.close();
  upstream.close();
});

/** Send raw bytes to the proxy; resolve with everything received until close (or a short idle). */
function exchange(request: string, after?: (socket: Socket) => void, idleMs = 400): Promise<string> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port: proxyPort });
    let received = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(received);
    };
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(done, idleMs);
    };
    socket.on("data", (chunk) => {
      received += chunk.toString("latin1");
      if (after && received.includes("200 Connection Established") && !received.includes("PONG")) after(socket);
      arm();
    });
    socket.on("close", done);
    socket.on("error", done);
    socket.write(request);
    arm();
  });
}

const connectTo = (authority: string) => `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`;
const lastDecision = () => [...logs].reverse().find((line) => line.event === "decision")!;

describe("allowed destinations", () => {
  test("CONNECT to an allowlisted host tunnels to the validated address", async () => {
    dnsTable = { "example.com": [pub("93.184.215.14")] };
    dialed.length = 0;
    const reply = await exchange(connectTo("example.com:443"), (socket) => socket.write("PING"));
    expect(reply).toStartWith("HTTP/1.1 200 Connection Established");
    expect(reply).toContain("PONG");
    expect(dialed).toEqual([{ address: "93.184.215.14", port: 443 }]);
    expect(lastDecision()).toMatchObject({ host: "example.com", port: 443, decision: "allow" });
  });

  test("suffix entry allows subdomains but not the apex", async () => {
    dnsTable = { "en.wikipedia.org": [pub("198.35.26.96")], "wikipedia.org": [pub("198.35.26.96")] };
    expect(await exchange(connectTo("en.wikipedia.org:443"))).toStartWith("HTTP/1.1 200");
    const apex = await exchange(connectTo("wikipedia.org:443"));
    expect(apex).toStartWith("HTTP/1.1 403");
    expect(apex).toContain("reason=host_not_allowed");
  });

  test("absolute-URI GET is forwarded with origin-form, rebuilt Host, and hop-by-hop headers dropped", async () => {
    dnsTable = { "example.com": [pub("93.184.215.14")] };
    dialed.length = 0;
    const reply = await exchange(
      "GET http://example.com/path?q=1 HTTP/1.1\r\nHost: evil.internal\r\nProxy-Authorization: Basic x\r\nProxy-Connection: keep-alive\r\nConnection: keep-alive, X-Secret\r\nX-Secret: 1\r\nAccept: */*\r\n\r\n",
    );
    expect(reply).toStartWith("HTTP/1.1 200 OK");
    const head = JSON.parse(reply.slice(reply.indexOf("{"))).head as string;
    expect(head).toStartWith("GET /path?q=1 HTTP/1.1\r\nHost: example.com\r\n");
    expect(head).toContain("Accept: */*");
    expect(head).toContain("Connection: close");
    expect(head).not.toContain("Proxy-Authorization");
    expect(head).not.toContain("evil.internal");
    expect(head).not.toContain("X-Secret");
    expect(dialed).toEqual([{ address: "93.184.215.14", port: 80 }]);
  });
});

describe("refusals", () => {
  test("disallowed host gets 403 and is never resolved or dialed", async () => {
    dnsTable = { "evil.example.net": [pub("93.184.215.99")] };
    dialed.length = 0;
    const reply = await exchange(connectTo("evil.example.net:443"));
    expect(reply).toStartWith("HTTP/1.1 403 Forbidden");
    expect(reply).toContain("X-Airlock-Egress: denied; reason=host_not_allowed");
    expect(dnsCalls["evil.example.net"]).toBeUndefined();
    expect(dialed).toEqual([]);
    expect(lastDecision()).toMatchObject({ host: "evil.example.net", decision: "deny", reason: "host_not_allowed" });
  });

  test("plain-HTTP GET to a disallowed host is refused with 403", async () => {
    const reply = await exchange("GET http://evil.example.net/ HTTP/1.1\r\nHost: evil.example.net\r\n\r\n");
    expect(reply).toStartWith("HTTP/1.1 403");
  });

  for (const [label, address] of [
    ["loopback", "127.0.0.1"],
    ["RFC1918 10/8", "10.1.2.3"],
    ["RFC1918 172.16/12", "172.20.0.5"],
    ["RFC1918 192.168/16", "192.168.1.1"],
    ["metadata 169.254.169.254", "169.254.169.254"],
    ["CGNAT 100.64/10", "100.100.100.200"],
    ["unspecified", "0.0.0.0"],
    ["multicast", "224.0.0.1"],
    ["IPv6 loopback", "::1"],
    ["IPv6 ULA", "fd00::1"],
    ["IPv6 link-local", "fe80::1"],
    ["IPv4-mapped private (hex)", "::ffff:a00:1"],
    ["IPv4-mapped metadata (dotted)", "::ffff:169.254.169.254"],
    ["NAT64 of private", "64:ff9b::a00:1"],
    ["6to4", "2002:a00:1::1"],
  ] as const) {
    test(`allowlisted host resolving to ${label} is refused`, async () => {
      dnsTable = { "example.com": [pub(address)] };
      dialed.length = 0;
      const reply = await exchange(connectTo("example.com:443"));
      expect(reply).toStartWith("HTTP/1.1 403");
      expect(reply).toContain("reason=non_public_address");
      expect(dialed).toEqual([]);
    });
  }

  test("any private address in a mixed answer refuses the request", async () => {
    dnsTable = { "example.com": [pub("93.184.215.14"), pub("10.0.0.1")] };
    dialed.length = 0;
    expect(await exchange(connectTo("example.com:443"))).toContain("reason=non_public_address");
    expect(dialed).toEqual([]);
  });

  test("DNS rebinding: public then private; each request resolves once and dials only its validated address", async () => {
    dnsTable = { "rebind.test.example": [[pub("93.184.215.20")], [pub("169.254.169.254")]] };
    delete dnsCalls["rebind.test.example"];
    dialed.length = 0;
    const first = await exchange(connectTo("rebind.test.example:443"));
    expect(first).toStartWith("HTTP/1.1 200");
    expect(dnsCalls["rebind.test.example"]).toBe(1); // the tunnel did not trigger a second lookup
    expect(dialed).toEqual([{ address: "93.184.215.20", port: 443 }]);
    const second = await exchange(connectTo("rebind.test.example:443"));
    expect(second).toStartWith("HTTP/1.1 403");
    expect(second).toContain("reason=non_public_address");
    expect(dnsCalls["rebind.test.example"]).toBe(2);
    expect(dialed).toEqual([{ address: "93.184.215.20", port: 443 }]);
  });

  test("port outside AIRLOCK_EGRESS_PORTS is refused before DNS", async () => {
    dnsTable = { "example.com": [pub("93.184.215.14")] };
    delete dnsCalls["example.com"];
    const reply = await exchange(connectTo("example.com:22"));
    expect(reply).toContain("reason=port_not_allowed");
    expect(dnsCalls["example.com"]).toBeUndefined();
    expect(await exchange("GET http://example.com:8080/ HTTP/1.1\r\n\r\n")).toContain("reason=port_not_allowed");
  });

  test("CONNECT to a raw IP is refused unless that IP is allowlisted and public", async () => {
    dialed.length = 0;
    expect(await exchange(connectTo("1.1.1.1:443"))).toContain("reason=ip_literal_not_allowed");
    expect(await exchange(connectTo("169.254.169.254:443"))).toContain("reason=ip_literal_not_allowed");
    expect(await exchange(connectTo("[::1]:443"))).toContain("reason=ip_literal_not_allowed");
    expect(await exchange("GET http://169.254.169.254/latest/meta-data/ HTTP/1.1\r\n\r\n")).toContain(
      "reason=ip_literal_not_allowed",
    );
    expect(dialed).toEqual([]);
    expect(await exchange(connectTo("93.184.215.14:443"))).toStartWith("HTTP/1.1 200");
    expect(dialed).toEqual([{ address: "93.184.215.14", port: 443 }]);
  });

  test("numeric-shorthand hostnames are not treated as names", async () => {
    expect(await exchange(connectTo("2130706433:443"))).toContain("reason=bad_request");
    expect(await exchange(connectTo("example.com.127:443"))).toContain("reason=bad_request");
  });

  test("DNS failure is a 502, not an allow", async () => {
    dnsTable = {};
    expect(await exchange(connectTo("example.com:443"))).toStartWith("HTTP/1.1 502");
  });

  test("methods other than CONNECT/GET/HEAD, https absolute URIs, bodies and userinfo are refused", async () => {
    dnsTable = { "example.com": [pub("93.184.215.14")] };
    expect(await exchange("POST http://example.com/ HTTP/1.1\r\nContent-Length: 1\r\n\r\nx")).toContain(
      "reason=method_not_allowed",
    );
    expect(await exchange("GET https://example.com/ HTTP/1.1\r\n\r\n")).toContain("reason=bad_request");
    expect(await exchange("GET http://example.com/ HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n")).toContain(
      "reason=bad_request",
    );
    expect(await exchange("GET http://u:p@example.com/ HTTP/1.1\r\n\r\n")).toContain("reason=bad_request");
    expect(await exchange("GET / HTTP/1.1\r\nHost: example.com\r\n\r\n")).toContain("reason=bad_request");
  });

  test("oversized request head is refused", async () => {
    const reply = await exchange(`CONNECT example.com:443 HTTP/1.1\r\nX: ${"a".repeat(20_000)}\r\n\r\n`);
    expect(reply).toStartWith("HTTP/1.1 431");
  });

  test("tunnel byte budget closes the tunnel", async () => {
    dnsTable = { "example.com": [pub("93.184.215.14")] };
    const reply = await exchange(connectTo("example.com:443"), (socket) => socket.write(Buffer.alloc(70 * 1024)));
    expect(reply).toStartWith("HTTP/1.1 200");
    await Bun.sleep(50);
    const closed = [...logs].reverse().find((line) => line.event === "closed");
    expect(closed).toMatchObject({ host: "example.com", endReason: "max_bytes" });
  });

  test("log lines carry decisions only, never bodies or paths", () => {
    const text = logs.map((line) => JSON.stringify(line)).join("\n");
    expect(text).not.toContain("PING");
    expect(text).not.toContain("/path?q=1");
    expect(text).not.toContain("meta-data");
  });
});

describe("policy parsing", () => {
  test("empty allowlist denies everything", async () => {
    const policy = parsePolicy("[]", undefined);
    expect(policy.exact.size + policy.suffixes.length).toBe(0);
    expect([...policy.ports]).toEqual([443, 80]);
  });
  test("rejects private IP literals, over-broad suffixes and junk", () => {
    expect(() => parsePolicy('["10.0.0.1"]', undefined)).toThrow();
    expect(() => parsePolicy('[".com"]', undefined)).toThrow();
    expect(() => parsePolicy('["exa mple.com"]', undefined)).toThrow();
    expect(() => parsePolicy('{"a":1}', undefined)).toThrow();
    expect(() => parsePolicy("[]", "[0]")).toThrow();
  });
  test("normalizes case and trailing dot", () => {
    expect(normalizeHost("Example.COM.")).toBe("example.com");
    expect(normalizeHost("[::1]")).toBe("::1");
    expect(normalizeHost("fe80::1%eth0")).toBeNull();
  });
  test("isPublicIp", () => {
    expect(isPublicIp("93.184.215.14")).toBe(true);
    expect(isPublicIp("2606:4700::6810:84e5")).toBe(true);
    expect(isPublicIp("198.18.0.1")).toBe(false);
    expect(isPublicIp("255.255.255.255")).toBe(false);
    expect(isPublicIp("2001:db8::1")).toBe(false);
    expect(isPublicIp("::")).toBe(false);
  });
  test("parseAuthority", () => {
    expect(parseAuthority("example.com:443")).toEqual({ host: "example.com", port: 443 });
    expect(parseAuthority("[2606:4700::1]:443")).toEqual({ host: "2606:4700::1", port: 443 });
    expect(parseAuthority("example.com")).toBeNull();
    expect(parseAuthority("a:b:443")).toBeNull();
  });
});
