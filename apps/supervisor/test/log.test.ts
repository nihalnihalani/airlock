import { describe, expect, test } from "bun:test";
import { createLogger, levelFromEnv, redact } from "../src/log.ts";

function capture(level: "error" | "warn" | "info" | "debug") {
  const lines: { line: string; level: string }[] = [];
  const logger = createLogger({ app: "supervisor", level, write: (line, lvl) => lines.push({ line, level: lvl }), now: () => new Date("2026-09-26T00:00:00.000Z") });
  return { logger, lines, records: () => lines.map((l) => JSON.parse(l.line) as Record<string, unknown>) };
}

describe("logger", () => {
  test("AIRLOCK_LOG_LEVEL parsing defaults to info and never throws", () => {
    expect(levelFromEnv(undefined)).toBe("info");
    expect(levelFromEnv(" DEBUG ")).toBe("debug");
    expect(levelFromEnv("verbose")).toBe("info");
    expect(levelFromEnv("nope", "debug")).toBe("debug");
  });

  test("filters by level and emits one JSON object per line with ts/level/app/msg", () => {
    const { logger, records } = capture("info");
    logger.debug("hidden");
    logger.info("shown", { taskId: "t-1" });
    logger.warn("careful");
    logger.error("bad", { error: new Error("boom") });
    expect(logger.enabled("debug")).toBe(false);
    expect(logger.enabled("warn")).toBe(true);
    const out = records();
    expect(out.map((r) => r.level)).toEqual(["info", "warn", "error"]);
    expect(out[0]).toEqual({ ts: "2026-09-26T00:00:00.000Z", level: "info", app: "supervisor", msg: "shown", taskId: "t-1" });
    expect(out[2]?.error).toEqual({ name: "Error", message: "boom" });
    const { records: all, logger: verbose } = capture("debug");
    verbose.debug("now visible");
    expect(all()[0]?.msg).toBe("now visible");
  });

  test("child loggers carry their base fields", () => {
    const { logger, records } = capture("debug");
    logger.child({ taskId: "t-9" }).debug("tick", { n: 1 });
    expect(records()[0]).toMatchObject({ taskId: "t-9", n: 1, msg: "tick" });
  });

  test("credential-like fields are redacted at any depth; bearer and cookie values too", () => {
    const TOKEN = "supersecret-token-0123456789abcdef";
    const { logger, lines } = capture("debug");
    logger.debug("request", {
      token: TOKEN,
      authorization: `Bearer ${TOKEN}`,
      cookie: `airlock_session=${TOKEN}`,
      password: TOKEN,
      VULTR_INFERENCE_API_KEY: TOKEN,
      headers: { Authorization: `Bearer ${TOKEN}`, "set-cookie": `airlock_session=${TOKEN}; HttpOnly`, accept: "application/json" },
      nested: { deeper: { supervisorToken: TOKEN, note: `Bearer ${TOKEN}` } },
      list: [{ apiKey: TOKEN }],
      safe: "kept",
      emptyToken: "",
      maxTokens: 16384,
      usage: { promptTokens: 10, reasoningTokens: 5 },
    });
    const line = lines[0]!.line;
    expect(line).not.toContain(TOKEN);
    const r = JSON.parse(line);
    expect(r.token).toBe("[redacted]");
    expect(r.authorization).toBe("[redacted]");
    expect(r.cookie).toBe("[redacted]");
    expect(r.headers.Authorization).toBe("[redacted]");
    expect(r.headers["set-cookie"]).toBe("[redacted]");
    expect(r.headers.accept).toBe("application/json");
    expect(r.nested.deeper.supervisorToken).toBe("[redacted]");
    expect(r.nested.deeper.note).toBe("[redacted]");
    expect(r.list[0].apiKey).toBe("[redacted]");
    expect(r.safe).toBe("kept");
    expect(r.emptyToken).toBe("");
    expect(r.maxTokens).toBe(16384);
    expect(r.usage).toEqual({ promptTokens: 10, reasoningTokens: 5 });
  });

  test("redact bounds strings, arrays and depth, and survives cycles", () => {
    expect((redact("x".repeat(5000)) as string).length).toBeLessThan(5000);
    expect((redact(Array.from({ length: 500 }, (_, i) => i)) as unknown[]).length).toBe(100);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(JSON.stringify(redact(cyclic))).toContain("[depth]");
  });
});
