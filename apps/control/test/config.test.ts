import { describe, expect, test } from "bun:test";
import { ConfigError, parseReasoningEffort, parseTrustedProxies } from "../src/config.ts";

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
