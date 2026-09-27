/**
 * deploy/host/airlock-egress-guard.sh in --dry-run: the host-level rules for the browser plane's
 * per-attempt bridges (C8). This checks the generated rules only; they are NOT verified on the
 * Vultr host by this test (see the script header).
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { INTERNAL_BRIDGE_PREFIX, EGRESS_BRIDGE_PREFIX, attemptNames } from "../src/names";
import { tempDir } from "./helpers";

const SCRIPT = resolve(import.meta.dir, "../../../deploy/host/airlock-egress-guard.sh");

function dryRun(resolv: string): string[] {
  const dir = tempDir();
  const path = join(dir, "resolv.conf");
  writeFileSync(path, resolv);
  const out = spawnSync("bash", [SCRIPT, "--dry-run"], { env: { ...process.env, AIRLOCK_GUARD_RESOLV: path }, encoding: "utf8" });
  expect(out.status).toBe(0);
  return out.stdout.trim().split("\n");
}

describe("egress guard (dry run)", () => {
  test("bridge prefixes match the names the supervisor gives its networks", () => {
    const names = attemptNames("airlock", "t1", "a1", "browser");
    if (!names.ok) throw new Error(names.reason);
    expect(names.value.internalBridge).toMatch(new RegExp(`^${INTERNAL_BRIDGE_PREFIX}[0-9a-f]{12}$`));
    expect(names.value.egressBridge).toMatch(new RegExp(`^${EGRESS_BRIDGE_PREFIX}[0-9a-f]{12}$`));
    expect(names.value.internalBridge.length).toBeLessThanOrEqual(15);
    const script = require("node:fs").readFileSync(SCRIPT, "utf8") as string;
    expect(script).toContain(`${INTERNAL_BRIDGE_PREFIX}+`);
    expect(script).toContain(`${EGRESS_BRIDGE_PREFIX}+`);
  });

  test("metadata, RFC 1918 and host-bound traffic from the egress bridges is dropped; IPv6 dropped", () => {
    const rules = dryRun("nameserver 108.61.10.10\n");
    for (const net of ["169.254.0.0/16", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10", "127.0.0.0/8"]) {
      expect(rules).toContain(`iptables -A AIRLOCK-FWD -i ale+ -d ${net} -j DROP`);
    }
    expect(rules).toContain("iptables -A AIRLOCK-FWD -i ali+ ! -o ali+ -j DROP");
    expect(rules).toContain("iptables -A AIRLOCK-FWD -o ali+ ! -i ali+ -j DROP");
    expect(rules).toContain("iptables -I DOCKER-USER 1 -j AIRLOCK-FWD");
    expect(rules).toContain("iptables -A AIRLOCK-IN -i ale+ -j DROP");
    expect(rules).toContain("iptables -A AIRLOCK-IN -i ali+ -j DROP");
    expect(rules).toContain("iptables -I INPUT 1 -j AIRLOCK-IN");
    expect(rules).toContain("ip6tables -A AIRLOCK-FWD6 -i ale+ -j DROP");
    expect(rules).toContain("ip6tables -A AIRLOCK-IN6 -i ali+ -j DROP");
    // a public resolver needs no exception
    expect(rules.some((r) => r.includes("--dport 53"))).toBe(false);
    // the drops end in RETURN so Docker's own rules still apply to everything else
    expect(rules.indexOf("iptables -A AIRLOCK-FWD -j RETURN")).toBeGreaterThan(rules.indexOf("iptables -A AIRLOCK-FWD -i ale+ -d 169.254.0.0/16 -j DROP"));
  });

  test("a private upstream resolver is allowed on port 53 only, before the RFC 1918 drop", () => {
    const rules = dryRun("nameserver 10.1.96.3\nnameserver 127.0.0.53\n");
    const allow = rules.indexOf("iptables -A AIRLOCK-FWD -i ale+ -d 10.1.96.3 -p udp --dport 53 -j RETURN");
    expect(allow).toBeGreaterThanOrEqual(0);
    expect(allow).toBeLessThan(rules.indexOf("iptables -A AIRLOCK-FWD -i ale+ -d 10.0.0.0/8 -j DROP"));
    expect(rules.some((r) => r.includes("127.0.0.53"))).toBe(false);
  });

  test("an unknown argument is refused", () => {
    expect(spawnSync("bash", [SCRIPT, "--bogus"], { encoding: "utf8" }).status).toBe(2);
  });
});
