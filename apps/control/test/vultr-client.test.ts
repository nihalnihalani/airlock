import { describe, expect, test } from "bun:test";
import {
  VultrError,
  createScriptedDriver,
  createVultrDriver,
  finishReasonOf,
  listModels,
  normalizeModelName,
  parseToolCalls,
  type ChatMessage,
  type ScriptedTurn,
  type ToolSpec,
} from "../src/vultr-client.ts";
import { formatTable, probeModel, probeModels, recommend } from "../src/vultr-probe.ts";

const KEY = "vultr-secret-key-DO-NOT-LEAK-0123456789";
const BASE = "https://api.vultrinference.com/v1";

type Call = { url: string; init: RequestInit };

/** A fake fetch that answers from a queue of responses and records every call. */
function fakeFetch(responses: (Response | Error | (() => Response | Error))[]) {
  const calls: Call[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift();
    if (next === undefined) throw new Error("fake fetch: no response queued");
    const r = typeof next === "function" ? next() : next;
    if (r instanceof Error) throw r;
    return r;
  }) as unknown as typeof fetch;
  return { fetch: f, calls };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const completion = (message: Record<string, unknown>, usage: Record<string, unknown> = { prompt_tokens: 11, completion_tokens: 7 }, finishReason = "stop") =>
  json({ id: "chatcmpl-1", choices: [{ index: 0, message: { role: "assistant", ...message }, finish_reason: finishReason }], usage });

const noSleep = async () => undefined;
const tools: ToolSpec[] = [{ name: "add", description: "adds", parameters: { type: "object", properties: { a: { type: "integer" }, b: { type: "integer" } }, required: ["a", "b"] } }];

describe("normalizeModelName", () => {
  test("appends -normalize once", () => {
    expect(normalizeModelName("glm-5.3")).toBe("glm-5.3-normalize");
    expect(normalizeModelName("glm-5.3-normalize")).toBe("glm-5.3-normalize");
    expect(normalizeModelName("  qwen3.8-flash-next ")).toBe("qwen3.8-flash-next-normalize");
    expect(() => normalizeModelName("   ")).toThrow(VultrError);
  });
});

describe("parseToolCalls", () => {
  test("arguments as JSON string, as object, empty and malformed", () => {
    const parsed = parseToolCalls([
      { id: "chatcmpl-tool-1", type: "function", function: { name: "add", arguments: '{"a": 1, "b": 2}' } },
      { id: "chatcmpl-tool-2", type: "function", function: { name: "add", arguments: { a: 3, b: 4 } } },
      { id: "chatcmpl-tool-3", type: "function", function: { name: "add", arguments: "" } },
      { type: "function", function: { name: "add", arguments: "{not json" } },
    ]);
    expect(parsed[0]).toEqual({ id: "chatcmpl-tool-1", name: "add", args: { a: 1, b: 2 } });
    expect(parsed[1]).toEqual({ id: "chatcmpl-tool-2", name: "add", args: { a: 3, b: 4 } });
    expect(parsed[2]?.args).toEqual({});
    expect(parsed[3]?.id).toBe("call_3");
    expect((parsed[3]?.args as { _parseError?: string })._parseError).toBeDefined();
    expect(parseToolCalls(undefined)).toEqual([]);
    expect(parseToolCalls(null)).toEqual([]);
    expect(() => parseToolCalls("x")).toThrow(/not an array/);
    expect(() => parseToolCalls([{ function: {} }])).toThrow(/no function name/);
  });
});

describe("createVultrDriver", () => {
  test("sends an OpenAI-compatible request with -normalize and parses the reply", async () => {
    const { fetch, calls } = fakeFetch([
      completion({ content: "", tool_calls: [{ id: "chatcmpl-tool-abc", type: "function", function: { name: "add", arguments: '{"a":2,"b":3}' } }] }),
    ]);
    const driver = createVultrDriver({ apiKey: KEY, baseUrl: `${BASE}/`, model: "glm-5.3", fetch, sleep: noSleep });
    const messages: ChatMessage[] = [
      { role: "user", content: "2+3?" },
      { role: "assistant", content: "", toolCalls: [{ id: "t0", name: "add", args: { a: 1, b: 1 } }] },
      { role: "tool", toolCallId: "t0", content: "2" },
    ];
    const out = await driver.chat({ system: "sys", messages, tools, maxTokens: 100 });
    expect(out.text).toBe("");
    expect(out.toolCalls).toEqual([{ id: "chatcmpl-tool-abc", name: "add", args: { a: 2, b: 3 } }]);
    expect(out.usage).toEqual({ input: 11, output: 7 });
    expect(out.finishReason).toBe("stop");
    expect(out.reasoning).toBe("");

    expect(calls.length).toBe(1);
    expect(calls[0]?.url).toBe(`${BASE}/chat/completions`);
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${KEY}`);
    const body = JSON.parse(calls[0]?.init.body as string);
    expect(body.model).toBe("glm-5.3-normalize");
    expect(body.max_tokens).toBe(100);
    expect(body.stream).toBe(false);
    expect(body.messages[0]).toEqual({ role: "system", content: "sys" });
    expect(body.messages[2].tool_calls[0]).toEqual({ id: "t0", type: "function", function: { name: "add", arguments: '{"a":1,"b":1}' } });
    expect(body.messages[3]).toEqual({ role: "tool", tool_call_id: "t0", content: "2" });
    expect(body.tools[0]).toEqual({ type: "function", function: { name: "add", description: "adds", parameters: tools[0]?.parameters } });
    expect(body.tool_choice).toBe("auto");
  });

  test("omits tools/tool_choice when no tools are given and defaults max_tokens", async () => {
    const { fetch, calls } = fakeFetch([completion({ content: "hi" })]);
    const driver = createVultrDriver({ apiKey: KEY, baseUrl: BASE, model: "x-normalize", fetch, sleep: noSleep });
    const out = await driver.chat({ system: "", messages: [{ role: "user", content: "hello" }], tools: [] });
    expect(out.text).toBe("hi");
    const body = JSON.parse(calls[0]?.init.body as string);
    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
    expect(body.max_tokens).toBe(16384);
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.messages[0].role).toBe("user");
  });

  test("max_tokens is bounded and reasoning_effort is sent only when set", async () => {
    const { fetch, calls } = fakeFetch([completion({ content: "a" }), completion({ content: "b" })]);
    const driver = createVultrDriver({ apiKey: KEY, baseUrl: BASE, model: "m", fetch, sleep: noSleep });
    const input = { system: "", messages: [{ role: "user" as const, content: "x" }], tools: [] };
    await driver.chat({ ...input, maxTokens: 10_000_000, reasoningEffort: "low" });
    await driver.chat({ ...input, maxTokens: 0 });
    expect(JSON.parse(calls[0]?.init.body as string)).toMatchObject({ max_tokens: 131072, reasoning_effort: "low" });
    const second = JSON.parse(calls[1]?.init.body as string);
    expect(second.max_tokens).toBe(1);
    expect("reasoning_effort" in second).toBe(false);
  });

  test("finish_reason is mapped and the reasoning text and token count are captured and bounded", async () => {
    // The live Vultr shape (observed 2026-09-26): thinking in message.reasoning, content null,
    // finish_reason "length" when the output limit cut the turn, reasoning_tokens in usage details.
    const longReasoning = "r".repeat(10_000);
    const { fetch } = fakeFetch([
      completion({ content: null, reasoning: longReasoning }, { prompt_tokens: 76, completion_tokens: 50, completion_tokens_details: { reasoning_tokens: 50 } }, "length"),
      completion({ content: "", reasoning_content: "thought", tool_calls: [{ id: "t1", type: "function", function: { name: "add", arguments: "{}" } }] }, { prompt_tokens: 1, completion_tokens: 2 }, "tool_calls"),
      completion({ content: "done" }, { prompt_tokens: 1, completion_tokens: 2, completion_tokens_details: { reasoning_tokens: "n/a" } }, "content_filter"),
    ]);
    const driver = createVultrDriver({ apiKey: KEY, baseUrl: BASE, model: "m", fetch, sleep: noSleep });
    const input = { system: "", messages: [{ role: "user" as const, content: "x" }], tools };
    const cut = await driver.chat(input);
    expect(cut.finishReason).toBe("length");
    expect(cut.text).toBe("");
    expect(cut.toolCalls).toEqual([]);
    expect(cut.reasoning?.length).toBe(4000);
    expect(cut.usage).toEqual({ input: 76, output: 50, reasoning: 50 });
    const called = await driver.chat(input);
    expect(called.finishReason).toBe("tool_calls");
    expect(called.reasoning).toBe("thought");
    expect(called.usage.reasoning).toBeUndefined();
    const other = await driver.chat(input);
    expect(other.finishReason).toBe("other");
    expect(other.usage.reasoning).toBeUndefined();
    expect(finishReasonOf(undefined)).toBe("other");
    expect(finishReasonOf("stop")).toBe("stop");
  });

  test.each([401, 422])("HTTP %i is an auth failure that never retries and never leaks the key", async (status) => {
    const { fetch, calls } = fakeFetch([json({ error: `bad key ${KEY}` }, status)]);
    const driver = createVultrDriver({ apiKey: KEY, baseUrl: BASE, model: "m", fetch, sleep: noSleep });
    let caught: unknown;
    try {
      await driver.chat({ system: "", messages: [{ role: "user", content: "x" }], tools });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(VultrError);
    const e = caught as VultrError;
    expect(e.kind).toBe("auth");
    expect(e.status).toBe(status);
    expect(e.message).toContain("VULTR_INFERENCE_API_KEY");
    expect(e.message).not.toContain(KEY);
    expect(JSON.stringify(e)).not.toContain(KEY);
    expect(calls.length).toBe(1);
  });

  test("retries 429 and 5xx with a cap of 3 retries, then fails with a scrubbed message", async () => {
    const { fetch, calls } = fakeFetch([
      json({ error: "rate" }, 429, { "retry-after": "1" }),
      json({ error: "boom" }, 500),
      json({ error: "boom" }, 503),
      json({ error: `boom ${KEY}` }, 502),
      completion({ content: "never reached" }),
    ]);
    const waits: number[] = [];
    const driver = createVultrDriver({ apiKey: KEY, baseUrl: BASE, model: "m", fetch, sleep: async (ms) => void waits.push(ms) });
    await expect(driver.chat({ system: "", messages: [{ role: "user", content: "x" }], tools })).rejects.toMatchObject({ kind: "http", status: 502 });
    expect(calls.length).toBe(4);
    expect(waits).toEqual([1000, 1000, 2000]);
    try {
      await createVultrDriver({ apiKey: KEY, baseUrl: BASE, model: "m", fetch: fakeFetch([json({ e: KEY }, 500), json({ e: KEY }, 500), json({ e: KEY }, 500), json({ e: KEY }, 500)]).fetch, sleep: noSleep }).chat({ system: "", messages: [{ role: "user", content: "x" }], tools });
    } catch (err) {
      expect((err as Error).message).not.toContain(KEY);
      expect((err as Error).message).toContain("[redacted]");
    }
  });

  test("recovers when a retry succeeds", async () => {
    const { fetch, calls } = fakeFetch([json({}, 500), completion({ content: "ok" })]);
    const driver = createVultrDriver({ apiKey: KEY, baseUrl: BASE, model: "m", fetch, sleep: noSleep });
    const out = await driver.chat({ system: "", messages: [{ role: "user", content: "x" }], tools });
    expect(out.text).toBe("ok");
    expect(calls.length).toBe(2);
  });

  test("retries transient network errors and scrubs the key from their messages", async () => {
    const { fetch } = fakeFetch([new Error(`ECONNRESET to ${KEY}`), new Error("x"), new Error("x"), new Error("x")]);
    const driver = createVultrDriver({ apiKey: KEY, baseUrl: BASE, model: "m", fetch, sleep: noSleep });
    await expect(driver.chat({ system: "", messages: [{ role: "user", content: "x" }], tools })).rejects.toMatchObject({ kind: "network" });
    const { fetch: f2 } = fakeFetch([new Error(`ECONNRESET to ${KEY}`), new Error(`x ${KEY}`), new Error(`x ${KEY}`), new Error(`x ${KEY}`)]);
    try {
      await createVultrDriver({ apiKey: KEY, baseUrl: BASE, model: "m", fetch: f2, sleep: noSleep }).chat({ system: "", messages: [{ role: "user", content: "x" }], tools });
    } catch (err) {
      expect((err as Error).message).not.toContain(KEY);
    }
  });

  test("other 4xx fail immediately without retry", async () => {
    const { fetch, calls } = fakeFetch([json({ error: "bad request" }, 400)]);
    const driver = createVultrDriver({ apiKey: KEY, baseUrl: BASE, model: "m", fetch, sleep: noSleep });
    await expect(driver.chat({ system: "", messages: [{ role: "user", content: "x" }], tools })).rejects.toMatchObject({ kind: "http", status: 400 });
    expect(calls.length).toBe(1);
  });

  test("honors an already-aborted signal and aborts a pending request", async () => {
    const { fetch, calls } = fakeFetch([completion({ content: "x" })]);
    const driver = createVultrDriver({ apiKey: KEY, baseUrl: BASE, model: "m", fetch, sleep: noSleep });
    const ac = new AbortController();
    ac.abort();
    await expect(driver.chat({ system: "", messages: [{ role: "user", content: "x" }], tools, signal: ac.signal })).rejects.toMatchObject({ kind: "aborted" });
    expect(calls.length).toBe(0);

    // A fetch that honours the signal: abort mid-flight.
    const ac2 = new AbortController();
    const hanging = (async (_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      })) as unknown as typeof fetch;
    const d2 = createVultrDriver({ apiKey: KEY, baseUrl: BASE, model: "m", fetch: hanging, sleep: noSleep });
    const p = d2.chat({ system: "", messages: [{ role: "user", content: "x" }], tools, signal: ac2.signal });
    setTimeout(() => ac2.abort(), 5);
    await expect(p).rejects.toMatchObject({ kind: "aborted" });
  });

  test("request timeout aborts a hanging fetch", async () => {
    const hanging = (async (_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      })) as unknown as typeof fetch;
    const d = createVultrDriver({ apiKey: KEY, baseUrl: BASE, model: "m", fetch: hanging, sleep: noSleep, requestTimeoutMs: 10 });
    await expect(d.chat({ system: "", messages: [{ role: "user", content: "x" }], tools })).rejects.toMatchObject({ kind: "network" });
  });

  test("protocol errors: non-JSON body, missing choices, oversized body", async () => {
    const d = (r: Response) => createVultrDriver({ apiKey: KEY, baseUrl: BASE, model: "m", fetch: fakeFetch([r]).fetch, sleep: noSleep });
    const input = { system: "", messages: [{ role: "user" as const, content: "x" }], tools };
    await expect(d(new Response("<html>", { status: 200 })).chat(input)).rejects.toMatchObject({ kind: "protocol" });
    await expect(d(json({ choices: [] })).chat(input)).rejects.toMatchObject({ kind: "protocol" });
    const big = new Uint8Array(8 * 1024 * 1024 + 1).fill(32);
    await expect(d(new Response(big, { status: 200 })).chat(input)).rejects.toMatchObject({ kind: "protocol" });
  });

  test("configuration errors", () => {
    expect(() => createVultrDriver({ apiKey: "", baseUrl: BASE, model: "m" })).toThrow(/VULTR_INFERENCE_API_KEY/);
    expect(() => createVultrDriver({ apiKey: KEY, baseUrl: "not a url", model: "m" })).toThrow(/baseUrl/);
    expect(() => createVultrDriver({ apiKey: KEY, baseUrl: "ftp://x", model: "m" })).toThrow(/http/);
  });

  test("a tool message without toolCallId is refused before any request", async () => {
    const { fetch, calls } = fakeFetch([]);
    const d = createVultrDriver({ apiKey: KEY, baseUrl: BASE, model: "m", fetch, sleep: noSleep });
    await expect(d.chat({ system: "", messages: [{ role: "tool", content: "x" }], tools })).rejects.toMatchObject({ kind: "config" });
    expect(calls.length).toBe(0);
  });
});

describe("createScriptedDriver", () => {
  test("replays turns in order then returns empty text forever", async () => {
    const script: ScriptedTurn[] = [
      { toolCalls: [{ name: "write_file", args: { path: "a", content: "b" } }], text: "writing" },
      { text: "done" },
    ];
    const d = createScriptedDriver(script);
    const input = { system: "", messages: [], tools: [] };
    const t1 = await d.chat(input);
    expect(t1.text).toBe("writing");
    expect(t1.finishReason).toBe("tool_calls");
    expect(t1.toolCalls).toEqual([{ id: "scripted-1", name: "write_file", args: { path: "a", content: "b" } }]);
    const t2 = await d.chat(input);
    expect(t2.text).toBe("done");
    expect(t2.finishReason).toBe("stop");
    expect(await d.chat(input)).toEqual({ text: "", toolCalls: [], finishReason: "stop", reasoning: "", usage: { input: 0, output: 0 } });
    expect(await d.chat(input)).toEqual({ text: "", toolCalls: [], finishReason: "stop", reasoning: "", usage: { input: 0, output: 0 } });
  });

  test("the forged-log fixture edits the allowed file with a comment only, prints a forged '312 passed' and submits", async () => {
    const fixture = await Bun.file(new URL("./fixtures/forged-log-script.json", import.meta.url)).json();
    const d = createScriptedDriver(fixture.turns as ScriptedTurn[]);
    const input = { system: "", messages: [], tools: [] };
    const first = await d.chat(input);
    expect(first.toolCalls[0]?.name).toBe("edit_file");
    const edit = first.toolCalls[0]?.args as { path: string; old_text: string; new_text: string };
    expect(edit.path).toBe("tabulate/__init__.py");
    // Only a comment line is added: the implementation stays broken, so the comparator must fail it.
    expect(edit.new_text.endsWith(edit.old_text)).toBe(true);
    expect(edit.new_text.slice(0, -edit.old_text.length).trim().startsWith("#")).toBe(true);
    const second = await d.chat(input);
    expect(second.toolCalls[0]?.name).toBe("run");
    expect((second.toolCalls[0]?.args as { command: string }).command).toContain("312 passed");
    const third = await d.chat(input);
    expect(third.toolCalls[0]?.name).toBe("submit_candidate");
  });
});

describe("listModels", () => {
  test("reads the data array and the tools flag in array or object form; key optional", async () => {
    const { fetch, calls } = fakeFetch([
      json({
        data: [
          { id: "glm-5.3", supported_parameters: ["tools", "max_tokens"] },
          { id: "other", supported_parameters: { tools: true } },
          { id: "bge-reranker-v2-m3", supported_parameters: ["top_n"] },
          { nope: true },
          { id: "z", capabilities: ["function_calling"] },
          // Live Vultr schema 2.4 (observed 2026-09-26): a parameter descriptor nested under output_modalities.
          {
            id: "live-glm",
            schema_version: "2.4",
            output_modalities: [{ type: "text", supported_parameters: { max_tokens: { type: "integer" }, tools: { type: "boolean" } } }],
          },
          { id: "live-reranker", schema_version: "2.4", output_modalities: [{ type: "text", supported_parameters: { top_n: { type: "integer" } } }] },
        ],
      }),
    ]);
    const models = await listModels(BASE, undefined, { fetch });
    expect(models.map((m) => [m.id, m.tools])).toEqual([
      ["glm-5.3", true],
      ["other", true],
      ["bge-reranker-v2-m3", false],
      ["z", true],
      ["live-glm", true],
      ["live-reranker", false],
    ]);
    expect(calls[0]?.url).toBe(`${BASE}/models`);
    expect((calls[0]?.init.headers as Record<string, string>).authorization).toBeUndefined();
    await expect(listModels(BASE, KEY, { fetch: fakeFetch([json({ nope: 1 })]).fetch })).rejects.toMatchObject({ kind: "protocol" });
  });
});

describe("vultr-probe", () => {
  function scriptedProbeDriver(behaviour: "good" | "no-tool" | "ignores-result" | "throws") {
    return (_model: string) => ({
      async chat(input: { messages: ChatMessage[] }) {
        if (behaviour === "throws") throw new VultrError("http", "HTTP 500", 500);
        const last = input.messages[input.messages.length - 1];
        if (last?.role === "tool") {
          const result = JSON.parse(last.content).result as number;
          return { text: behaviour === "ignores-result" ? "The answer is 42." : `The sum is ${result}.`, toolCalls: [], usage: { input: 5, output: 3 } };
        }
        const m = /(\d+) \+ (\d+)/.exec(input.messages[0]?.content ?? "");
        if (behaviour === "no-tool") return { text: `It is ${Number(m?.[1]) + Number(m?.[2])}.`, toolCalls: [], usage: { input: 5, output: 3 } };
        return { text: "", toolCalls: [{ id: "c1", name: "add", args: JSON.stringify({ a: Number(m?.[1]), b: Number(m?.[2]) }) }], usage: { input: 5, output: 3 } };
      },
    });
  }

  test("measures a full round trip and recommends the model that used the tool", async () => {
    const base = { baseUrl: BASE, apiKey: KEY, timeoutMs: 5000 };
    const good = await probeModel("good-model", { ...base, driverFactory: scriptedProbeDriver("good") });
    expect(good).toMatchObject({ ok: true, toolCallParsed: false, usedToolResult: true });
    // args arrived as a JSON string from the scripted driver: a real driver parses them; here we
    // exercise the numeric coercion path by wrapping the factory.
    const goodParsed = await probeModel("good-model", {
      ...base,
      driverFactory: (m) => {
        const inner = scriptedProbeDriver("good")(m);
        return {
          async chat(i: { messages: ChatMessage[] }) {
            const r = await inner.chat(i);
            return { ...r, toolCalls: r.toolCalls.map((c) => ({ ...c, args: JSON.parse(c.args as string) })) };
          },
        };
      },
    });
    expect(goodParsed).toMatchObject({ ok: true, toolCallParsed: true, usedToolResult: true });
    expect(goodParsed.tokens).toEqual({ input: 10, output: 6 });
    const noTool = await probeModel("no-tool", { ...base, driverFactory: scriptedProbeDriver("no-tool") });
    expect(noTool).toMatchObject({ ok: true, toolCallParsed: false, usedToolResult: false, answeredWithoutTool: true });
    const ignores = await probeModel("ignores", { ...base, driverFactory: scriptedProbeDriver("ignores-result") });
    expect(ignores.usedToolResult).toBe(false);
    const throws = await probeModel("throws", { ...base, driverFactory: scriptedProbeDriver("throws") });
    expect(throws.ok).toBe(false);
    expect(throws.error).toContain("HTTP 500");
    const rows = [noTool, ignores, throws, goodParsed];
    expect(recommend(rows)?.model).toBe("good-model");
    expect(recommend([noTool, throws])).toBeNull();
    const table = formatTable(rows);
    expect(table.split("\n").length).toBe(rows.length + 2);
    expect(table).toContain("good-model");
    expect(table).not.toContain(KEY);
  });

  test("auth failures propagate instead of being recorded as a row", async () => {
    const factory = () => ({ chat: async () => { throw new VultrError("auth", "rejected", 401); } });
    await expect(probeModel("m", { baseUrl: BASE, apiKey: KEY, driverFactory: factory })).rejects.toMatchObject({ kind: "auth" });
  });

  test("probeModels defaults to tool-capable catalog entries", async () => {
    const { fetch } = fakeFetch([json({ data: [{ id: "a", supported_parameters: ["tools"] }, { id: "b", supported_parameters: [] }] })]);
    const rows = await probeModels({ baseUrl: BASE, apiKey: KEY, fetch, driverFactory: scriptedProbeDriver("good") });
    expect(rows.map((r) => r.model)).toEqual(["a"]);
    await expect(probeModels({ baseUrl: BASE, apiKey: KEY, fetch: fakeFetch([json({ data: [{ id: "b", supported_parameters: [] }] })]).fetch })).rejects.toMatchObject({ kind: "protocol" });
  });
});
