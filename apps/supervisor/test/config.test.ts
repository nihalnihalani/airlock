/**
 * D4 (production refuses dev-only configurations), D5 (bind address), D2 (pinned image id required
 * outside dev-unsafe), U1 (instance id) and M2 (host budget) configuration.
 */
import { describe, expect, test } from "bun:test";
import { totalmem } from "node:os";
import { classifyBind, loadConfig, parseMutationOrigins } from "../src/config";

const TOKEN = { SUPERVISOR_TOKEN: "test-token-0123456789abcdef" };
const IMAGE_ID = `sha256:${"b".repeat(64)}`;
const KATA = { ...TOKEN, AIRLOCK_RUNTIME: "kata", AIRLOCK_RUNTIME_IMAGE_ID: IMAGE_ID };
const DEV = { ...TOKEN, AIRLOCK_RUNTIME: "runc", AIRLOCK_DEV_UNSAFE: "1" };

function reason(env: Record<string, string>): string {
  const loaded = loadConfig(env, "/tmp");
  return loaded.ok ? "" : loaded.reason;
}

describe("classifyBind (D5)", () => {
  test("loopback, private, public and invalid", () => {
    for (const b of ["127.0.0.1", "127.1.2.3", "::1", "[::1]", "localhost"]) expect(classifyBind(b)).toBe("loopback");
    for (const b of ["10.0.0.5", "172.16.0.1", "172.31.255.254", "192.168.1.10", "100.64.0.1", "100.127.255.255", "fd00::1", "fc00::5", "fe80::1", "[fe80::1]", "::ffff:10.1.2.3"]) {
      expect(classifyBind(b)).toBe("private");
    }
    for (const b of ["0.0.0.0", "::", "8.8.8.8", "172.32.0.1", "100.128.0.1", "192.169.0.1", "2001:db8::1", "::ffff:8.8.8.8"]) expect(classifyBind(b)).toBe("public");
    for (const b of ["example.com", "sandbox", "1.2.3", "1::2::3"]) expect(classifyBind(b)).toBe("invalid");
  });

  test("loadConfig refuses a wildcard, public or hostname bind and accepts private ones", () => {
    expect(reason({ ...KATA, SUPERVISOR_BIND: "0.0.0.0" })).toMatch(/wildcard or public/);
    expect(reason({ ...KATA, SUPERVISOR_BIND: "::" })).toMatch(/wildcard or public/);
    expect(reason({ ...KATA, SUPERVISOR_BIND: "45.76.1.2" })).toMatch(/wildcard or public/);
    expect(reason({ ...KATA, SUPERVISOR_BIND: "sandbox.internal" })).toMatch(/not an IP address/);
    expect(loadConfig({ ...KATA, SUPERVISOR_BIND: "10.1.96.4" }, "/tmp").ok).toBe(true);
    expect(loadConfig({ ...KATA, SUPERVISOR_BIND: "100.100.1.1" }, "/tmp").ok).toBe(true);
    expect(loadConfig({ ...KATA }, "/tmp").ok).toBe(true); // default 127.0.0.1
  });
});

describe("production and dev-unsafe (D4)", () => {
  test("dev-unsafe is allowed only on a loopback bind", () => {
    expect(loadConfig({ ...DEV }, "/tmp").ok).toBe(true);
    expect(reason({ ...DEV, SUPERVISOR_BIND: "10.1.96.4" })).toMatch(/only with a loopback/);
  });

  test("AIRLOCK_PRODUCTION=1 refuses dev-unsafe, runc and a missing image id", () => {
    expect(reason({ ...DEV, AIRLOCK_PRODUCTION: "1", AIRLOCK_RUNTIME_IMAGE_ID: IMAGE_ID })).toMatch(/AIRLOCK_PRODUCTION=1 refuses AIRLOCK_DEV_UNSAFE/);
    expect(reason({ ...TOKEN, AIRLOCK_RUNTIME: "runc", AIRLOCK_PRODUCTION: "1", AIRLOCK_RUNTIME_IMAGE_ID: IMAGE_ID })).toMatch(/refuses AIRLOCK_RUNTIME=runc/);
    expect(reason({ ...TOKEN, AIRLOCK_RUNTIME: "kata", AIRLOCK_PRODUCTION: "1" })).toMatch(/AIRLOCK_RUNTIME_IMAGE_ID is not set/);
    const ok = loadConfig({ ...KATA, AIRLOCK_PRODUCTION: "1", SUPERVISOR_BIND: "10.1.96.4" }, "/tmp");
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.config.production).toBe(true);
      expect(ok.config.devUnsafe).toBe(false);
    }
  });
});

describe("runtime image pin (D2) and instance id (U1)", () => {
  test("the image id is required outside dev-unsafe and must be a sha256 image id", () => {
    expect(reason({ ...TOKEN, AIRLOCK_RUNTIME: "runsc" })).toMatch(/AIRLOCK_RUNTIME_IMAGE_ID is not set/);
    expect(reason({ ...KATA, AIRLOCK_RUNTIME_IMAGE_ID: "airlock-runtime-python:tabulate-365" })).toMatch(/sha256/);
    const dev = loadConfig({ ...DEV }, "/tmp");
    expect(dev.ok && dev.config.runtimeImageId).toBe(undefined);
    const pinned = loadConfig({ ...KATA, AIRLOCK_INSTANCE_ID: "cb676a46-66fd-4dfb-b839-443f2e6c0b60" }, "/tmp");
    expect(pinned.ok && pinned.config.runtimeImageId).toBe(IMAGE_ID);
    expect(pinned.ok && pinned.config.instanceId).toBe("cb676a46-66fd-4dfb-b839-443f2e6c0b60");
    expect(reason({ ...KATA, AIRLOCK_INSTANCE_ID: "bad id;rm" })).toMatch(/AIRLOCK_INSTANCE_ID/);
  });
});

describe("host budget (M2)", () => {
  test("defaults: total memory minus 1 GiB, 4096 PIDs, 4 GiB scratch, 8 sandboxes, 160 MiB VM overhead under kata only", () => {
    const kata = loadConfig({ ...KATA }, "/tmp");
    if (!kata.ok) throw new Error(kata.reason);
    expect(kata.config.capacity).toEqual({ memoryBytes: totalmem() - 1024 ** 3, pids: 4096, scratchBytes: 4 * 1024 ** 3, maxSandboxes: 8, vmOverheadBytes: 160 * 1024 ** 2 });
    const dev = loadConfig({ ...DEV }, "/tmp");
    expect(dev.ok && dev.config.capacity.vmOverheadBytes).toBe(0);
  });

  test("overrides and validation", () => {
    const env = { ...KATA, AIRLOCK_HOST_MEMORY_BYTES: "8589934592", AIRLOCK_HOST_PIDS: "512", AIRLOCK_HOST_SCRATCH_BYTES: "1073741824", AIRLOCK_MAX_SANDBOXES: "3", AIRLOCK_VM_OVERHEAD_BYTES: "0" };
    const loaded = loadConfig(env, "/tmp");
    expect(loaded.ok && loaded.config.capacity).toEqual({ memoryBytes: 8589934592, pids: 512, scratchBytes: 1073741824, maxSandboxes: 3, vmOverheadBytes: 0 });
    expect(reason({ ...KATA, AIRLOCK_MAX_SANDBOXES: "0" })).toMatch(/AIRLOCK_MAX_SANDBOXES/);
    expect(reason({ ...KATA, AIRLOCK_HOST_PIDS: "-1" })).toMatch(/AIRLOCK_HOST_PIDS/);
    expect(reason({ ...KATA, AIRLOCK_HOST_HEADROOM_BYTES: String(totalmem() + 1) })).toMatch(/AIRLOCK_HOST_MEMORY_BYTES/);
  });
});

describe("AIRLOCK_BROWSER_MUTATION_ORIGINS (40 Stage 5: only the controlled form destination may receive mutations)", () => {
  test("default is empty; exact https origins are accepted; anything else is refused", () => {
    expect(parseMutationOrigins(undefined)).toEqual([]);
    expect(parseMutationOrigins("  ")).toEqual([]);
    expect(parseMutationOrigins("[]")).toEqual([]);
    expect(parseMutationOrigins('["https://forms.airlock.example","https://a.test:8443"]')).toEqual(["https://forms.airlock.example", "https://a.test:8443"]);
    for (const bad of ["nope", "{}", '"https://a.test"', '["http://a.test"]', '["https://a.test/"]', '["https://a.test/x"]', '["https://a.test:443"]', '["https://u@a.test"]', '["*"]', "[1]", '["https://a.test","https://a.test"]', '["HTTPS://A.TEST"]']) {
      expect(typeof parseMutationOrigins(bad)).toBe("string");
    }
    expect(typeof parseMutationOrigins(JSON.stringify(Array.from({ length: 17 }, (_, i) => `https://h${i}.test`)))).toBe("string");
  });

  test("loadConfig carries the origins into the browser plane and refuses a malformed value", () => {
    const env = { ...DEV, AIRLOCK_BROWSER_IMAGE: "airlock-browser:dev", AIRLOCK_BROWSER_SECCOMP: `${import.meta.dir}/../../../runtime/browser/seccomp/chromium.json` };
    const plain = loadConfig(env, "/tmp");
    expect(plain.ok && plain.config.browser?.mutationOrigins).toEqual([]);
    const forms = loadConfig({ ...env, AIRLOCK_BROWSER_MUTATION_ORIGINS: '["https://forms.airlock.example"]' }, "/tmp");
    expect(forms.ok && forms.config.browser?.mutationOrigins).toEqual(["https://forms.airlock.example"]);
    expect(reason({ ...env, AIRLOCK_BROWSER_MUTATION_ORIGINS: '["http://forms.airlock.example"]' })).toMatch(/AIRLOCK_BROWSER_MUTATION_ORIGINS/);
  });
});
