import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { ConfigError, PINNED_VULTR_BASE, inferenceFetch, loadConfig, parseInferenceBaseUrl, parseReasoningEffort, parseTrustedProxies } from "../src/config.ts";

describe("AIRLOCK_TRUST_PROXY", () => {
  test("unset, empty and 0 trust no proxy header", () => {
    expect(parseTrustedProxies(undefined)).toEqual([]);
    expect(parseTrustedProxies("")).toEqual([]);
    expect(parseTrustedProxies("0")).toEqual([]);
  });
  test("1 means a loopback proxy; otherwise a list of proxy IP addresses", () => {
    expect(parseTrustedProxies("1")).toEqual(["loopback"]);
    expect(parseTrustedProxies(" 10.0.0.2, ::1 ")).toEqual(["10.0.0.2", "::1"]);
  });
  test("a hostname or garbage is refused rather than silently trusting nothing or everything", () => {
    expect(() => parseTrustedProxies("proxy.internal")).toThrow(ConfigError);
    expect(() => parseTrustedProxies("true")).toThrow(ConfigError);
  });
});

describe("AIRLOCK_MODEL_REASONING_EFFORT", () => {
  test("unset or empty sends nothing; a short identifier passes through; anything else is refused", () => {
    expect(parseReasoningEffort(undefined)).toBeNull();
    expect(parseReasoningEffort("  ")).toBeNull();
    expect(parseReasoningEffort(" low ")).toBe("low");
    expect(() => parseReasoningEffort("Very High")).toThrow(ConfigError);
    expect(() => parseReasoningEffort("x".repeat(40))).toThrow(ConfigError);
  });
});

describe("VULTR_INFERENCE_BASE_URL is pinned (D11)", () => {
  const dev = { production: false, allowTestUrl: false };
  test("the Vultr endpoint (with or without a trailing slash) is the only default-accepted value", () => {
    expect(parseInferenceBaseUrl(undefined, dev)).toBe(PINNED_VULTR_BASE);
    expect(parseInferenceBaseUrl("https://api.vultrinference.com/v1/", dev)).toBe(PINNED_VULTR_BASE);
    expect(() => parseInferenceBaseUrl("https://evil.example/v1", dev)).toThrow(ConfigError);
    expect(() => parseInferenceBaseUrl("https://api.vultrinference.com.evil.example/v1", dev)).toThrow(ConfigError);
    expect(() => parseInferenceBaseUrl("https://api.vultrinference.com/v2", dev)).toThrow(ConfigError);
  });
  test("a test URL needs AIRLOCK_ALLOW_TEST_INFERENCE_URL=1, must be https, and is never accepted in production", () => {
    expect(parseInferenceBaseUrl("https://inference.test/v1", { production: false, allowTestUrl: true })).toBe("https://inference.test/v1");
    expect(() => parseInferenceBaseUrl("http://inference.test/v1", { production: false, allowTestUrl: true })).toThrow(ConfigError);
    expect(() => parseInferenceBaseUrl("https://inference.test/v1", { production: true, allowTestUrl: true })).toThrow(/production/);
  });
  test("loadConfig applies the pin and the production flag", () => {
    const base = { SUPERVISOR_TOKEN: "x".repeat(20), AIRLOCK_MODEL_DRIVER: "vultr", VULTR_INFERENCE_API_KEY: "k", AIRLOCK_MODEL: "m", AIRLOCK_WEB_DIST: "none" };
    const root = resolve(import.meta.dir, "../../..");
    expect(loadConfig(base, root).vultr.baseUrl).toBe(PINNED_VULTR_BASE);
    expect(() => loadConfig({ ...base, VULTR_INFERENCE_BASE_URL: "https://other.example/v1" }, root)).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, VULTR_INFERENCE_BASE_URL: "https://other.example/v1", AIRLOCK_ALLOW_TEST_INFERENCE_URL: "1", AIRLOCK_PRODUCTION: "1" }, root)).toThrow(ConfigError);
    const c = loadConfig({ ...base, AIRLOCK_PRODUCTION: "1", AIRLOCK_INSTANCE_ID: "vm-a-1" }, root);
    expect(c.production).toBe(true);
    expect(c.instanceId).toBe("vm-a-1");
    expect(c.liveGateEvidenceDir).toBe(join(root, "docs/evidence/live-gate"));
    expect(c.diagnosticScriptsDir).toBeNull();
    expect(() => loadConfig({ ...base, AIRLOCK_INSTANCE_ID: "../x" }, root)).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, AIRLOCK_DIAGNOSTIC_SCRIPTS_DIR: "/nonexistent-airlock" }, root)).toThrow(ConfigError);
    expect(loadConfig({ ...base, AIRLOCK_DIAGNOSTIC_SCRIPTS_DIR: join(root, "apps/control/test/fixtures/scripted") }, root).diagnosticScriptsDir).toBe(join(root, "apps/control/test/fixtures/scripted"));
  });
});

describe("inference transport", () => {
  test("never follows redirects and refuses URLs outside the configured base", async () => {
    const seen: { url: string; redirect?: RequestRedirect }[] = [];
    const fake = (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(input), ...(init?.redirect ? { redirect: init.redirect } : {}) });
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const f = inferenceFetch(PINNED_VULTR_BASE, fake);
    await f(`${PINNED_VULTR_BASE}/chat/completions`, { method: "POST" });
    expect(seen).toEqual([{ url: `${PINNED_VULTR_BASE}/chat/completions`, redirect: "error" }]);
    await expect(f("https://evil.example/v1/chat/completions")).rejects.toThrow(/refused/);
    await expect(f("https://api.vultrinference.com/v10/chat")).rejects.toThrow(/refused/);
    expect(seen).toHaveLength(1);
  });
  test("a real redirect response is an error, not a followed hop", async () => {
    const target = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("secret-sink") });
    const redirector = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.redirect(`http://127.0.0.1:${target.port}/`, 302) });
    try {
      const base = `http://127.0.0.1:${redirector.port}/v1`;
      await expect(inferenceFetch(base)(`${base}/chat/completions`)).rejects.toThrow();
    } finally {
      redirector.stop(true);
      target.stop(true);
    }
  });
});
