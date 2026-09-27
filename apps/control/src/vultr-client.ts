/**
 * Airlock model driver for Vultr Serverless Inference (CLAUDE.md §3 invariant 10).
 *
 * A thin OpenAI-compatible chat-completions client: `POST {baseUrl}/chat/completions` with tools.
 * Vultr quirks handled here (research/13 §2):
 * - the `-normalize` model suffix gives standard tool-call ids and `content: ""` next to tool calls;
 * - `tool_calls[].function.arguments` may arrive as a JSON string or as an object;
 * - HTTP 401 (missing key) and 422 (invalid key) are both authentication failures.
 *
 * The API key never appears in any error message, log line or thrown value.
 */

export type ChatMessage = {
  role: "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  toolCalls?: { id: string; name: string; args: unknown }[];
};

export type ToolSpec = { name: string; description: string; parameters: object };

export type ScriptedTurn = { toolCalls?: { name: string; args: unknown }[]; text?: string };

export interface ChatInput {
  system: string;
  messages: ChatMessage[];
  tools: ToolSpec[];
  signal?: AbortSignal;
  maxTokens?: number;
}

export interface ChatOutput {
  text: string;
  toolCalls: { id: string; name: string; args: unknown }[];
  usage: { input: number; output: number };
}

export interface ModelDriver {
  chat(input: ChatInput): Promise<ChatOutput>;
  /** Identity recorded on every model event: the model name and the host it is served from. */
  describe?(): { model: string; host: string };
}

export type VultrErrorKind = "auth" | "http" | "network" | "aborted" | "protocol" | "config";

export class VultrError extends Error {
  readonly kind: VultrErrorKind;
  readonly status: number | undefined;
  constructor(kind: VultrErrorKind, message: string, status?: number) {
    super(message);
    this.name = "VultrError";
    this.kind = kind;
    this.status = status;
  }
}

export interface VultrDriverOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  /** Test seam: defaults to globalThis.fetch. */
  fetch?: typeof fetch;
  /** Test seam: defaults to a real timer. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Total request timeout per HTTP call (default 120 s). */
  requestTimeoutMs?: number;
}

const NORMALIZE_SUFFIX = "-normalize";
const MAX_RETRIES = 3;
const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 8000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_ERROR_BODY_CHARS = 512;
const DEFAULT_MAX_TOKENS = 4096;
const MAX_MAX_TOKENS = 65536;
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

export function normalizeModelName(model: string): string {
  const trimmed = model.trim();
  if (trimmed.length === 0) throw new VultrError("config", "model name is empty");
  return trimmed.endsWith(NORMALIZE_SUFFIX) ? trimmed : `${trimmed}${NORMALIZE_SUFFIX}`;
}

function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new VultrError("config", "baseUrl is not a valid URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new VultrError("config", "baseUrl must be http(s)");
  }
  return trimmed;
}

/** Removes every occurrence of the key from text that might reach a log or an error. */
function scrub(text: string, apiKey: string): string {
  if (apiKey.length === 0) return text;
  return text.split(apiKey).join("[redacted]");
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    if (signal?.aborted) {
      reject(new VultrError("aborted", "request aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolvePromise();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new VultrError("aborted", "request aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function isRetryable(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

function toWireMessages(system: string, messages: ChatMessage[]): unknown[] {
  const out: unknown[] = [];
  if (system.length > 0) out.push({ role: "system", content: system });
  for (const m of messages) {
    if (m.role === "tool") {
      if (!m.toolCallId) throw new VultrError("config", "tool message requires toolCallId");
      out.push({ role: "tool", tool_call_id: m.toolCallId, content: m.content });
    } else if (m.role === "assistant") {
      const wire: Record<string, unknown> = { role: "assistant", content: m.content };
      if (m.toolCalls && m.toolCalls.length > 0) {
        wire.tool_calls = m.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: typeof tc.args === "string" ? tc.args : JSON.stringify(tc.args ?? {}) },
        }));
      }
      out.push(wire);
    } else {
      out.push({ role: "user", content: m.content });
    }
  }
  return out;
}

function toWireTools(tools: ToolSpec[]): unknown[] | undefined {
  if (tools.length === 0) return undefined;
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

/**
 * Parses the tool_calls array from a chat completion message. Accepts `arguments` as a JSON
 * string or an object; an unparseable string is kept as `{ _raw: string }` so the caller's schema
 * validation rejects it with a useful message instead of the driver inventing arguments.
 */
export function parseToolCalls(raw: unknown): { id: string; name: string; args: unknown }[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new VultrError("protocol", "tool_calls is not an array");
  const out: { id: string; name: string; args: unknown }[] = [];
  raw.forEach((call, index) => {
    if (!call || typeof call !== "object") throw new VultrError("protocol", `tool_calls[${index}] is not an object`);
    const c = call as { id?: unknown; function?: { name?: unknown; arguments?: unknown } };
    const fn = c.function;
    if (!fn || typeof fn !== "object" || typeof fn.name !== "string" || fn.name.length === 0) {
      throw new VultrError("protocol", `tool_calls[${index}] has no function name`);
    }
    const id = typeof c.id === "string" && c.id.length > 0 ? c.id : `call_${index}`;
    let args: unknown;
    if (typeof fn.arguments === "string") {
      const text = fn.arguments.trim();
      if (text.length === 0) args = {};
      else {
        try {
          args = JSON.parse(text);
        } catch {
          args = { _raw: text.slice(0, 4096), _parseError: "arguments were not valid JSON" };
        }
      }
    } else if (fn.arguments === undefined || fn.arguments === null) {
      args = {};
    } else {
      args = fn.arguments;
    }
    out.push({ id, name: fn.name.slice(0, 128), args });
  });
  return out;
}

async function readBounded(res: Response, apiKey: string): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new VultrError("protocol", `response exceeded ${MAX_RESPONSE_BYTES} bytes`);
      }
      chunks.push(value);
    }
  }
  const merged = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) {
    merged.set(c, pos);
    pos += c.byteLength;
  }
  return scrub(new TextDecoder().decode(merged), apiKey);
}

function usageOf(raw: unknown): { input: number; output: number } {
  const u = (raw ?? {}) as { prompt_tokens?: unknown; completion_tokens?: unknown };
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
  return { input: n(u.prompt_tokens), output: n(u.completion_tokens) };
}

function linkSignals(external: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new VultrError("network", `request timed out after ${timeoutMs} ms`)), timeoutMs);
  const onAbort = () => controller.abort(new VultrError("aborted", "request aborted"));
  if (external) {
    if (external.aborted) onAbort();
    else external.addEventListener("abort", onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      external?.removeEventListener("abort", onAbort);
    },
  };
}

/**
 * Performs one HTTP call with retries for 429/5xx and transient network errors (max 3 retries,
 * exponential backoff capped at 8 s). Auth failures (401/422) and other 4xx never retry.
 */
async function requestJson(
  opts: Required<Pick<VultrDriverOptions, "apiKey" | "fetch" | "sleep" | "requestTimeoutMs">>,
  url: string,
  init: { method: "GET" | "POST"; body?: string; signal?: AbortSignal },
): Promise<unknown> {
  const { apiKey } = opts;
  let attempt = 0;
  for (;;) {
    if (init.signal?.aborted) throw new VultrError("aborted", "request aborted");
    const link = linkSignals(init.signal, opts.requestTimeoutMs);
    let res: Response;
    try {
      const headers: Record<string, string> = { accept: "application/json" };
      if (apiKey.length > 0) headers.authorization = `Bearer ${apiKey}`;
      if (init.body !== undefined) headers["content-type"] = "application/json";
      const requestInit: RequestInit = { method: init.method, headers, signal: link.signal };
      if (init.body !== undefined) requestInit.body = init.body;
      res = await opts.fetch(url, requestInit);
    } catch (err) {
      link.dispose();
      if (init.signal?.aborted) throw new VultrError("aborted", "request aborted");
      const reason = link.signal.reason;
      if (reason instanceof VultrError && reason.kind === "aborted") throw reason;
      const message = scrub(err instanceof Error ? err.message : String(err), apiKey);
      if (attempt < MAX_RETRIES) {
        attempt += 1;
        await opts.sleep(Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1)), init.signal);
        continue;
      }
      throw new VultrError("network", `network error after ${attempt + 1} attempts: ${message.slice(0, 256)}`);
    }

    let text: string;
    try {
      text = await readBounded(res, apiKey);
    } finally {
      link.dispose();
    }

    if (res.status === 401 || res.status === 422) {
      throw new VultrError(
        "auth",
        `Vultr Inference rejected the API key (HTTP ${res.status}). Check VULTR_INFERENCE_API_KEY and the key's allowed IPs.`,
        res.status,
      );
    }
    if (isRetryable(res.status)) {
      if (attempt < MAX_RETRIES) {
        attempt += 1;
        const retryAfter = Number(res.headers.get("retry-after"));
        const wait = Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(BACKOFF_CAP_MS, retryAfter * 1000)
          : Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1));
        await opts.sleep(wait, init.signal);
        continue;
      }
      throw new VultrError("http", `HTTP ${res.status} after ${attempt + 1} attempts: ${text.slice(0, MAX_ERROR_BODY_CHARS)}`, res.status);
    }
    if (res.status < 200 || res.status >= 300) {
      throw new VultrError("http", `HTTP ${res.status}: ${text.slice(0, MAX_ERROR_BODY_CHARS)}`, res.status);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new VultrError("protocol", `response is not JSON: ${text.slice(0, 200)}`);
    }
  }
}

function resolved(opts: VultrDriverOptions): Required<Pick<VultrDriverOptions, "apiKey" | "fetch" | "sleep" | "requestTimeoutMs">> {
  const f = opts.fetch ?? globalThis.fetch;
  if (typeof f !== "function") throw new VultrError("config", "no fetch implementation available");
  return {
    apiKey: opts.apiKey,
    fetch: f,
    sleep: opts.sleep ?? defaultSleep,
    requestTimeoutMs: opts.requestTimeoutMs && opts.requestTimeoutMs > 0 ? opts.requestTimeoutMs : DEFAULT_REQUEST_TIMEOUT_MS,
  };
}

export function createVultrDriver(opts: VultrDriverOptions): ModelDriver {
  if (typeof opts.apiKey !== "string" || opts.apiKey.trim().length === 0) {
    throw new VultrError("config", "VULTR_INFERENCE_API_KEY is required");
  }
  const baseUrl = normalizeBaseUrl(opts.baseUrl);
  const model = normalizeModelName(opts.model);
  const io = resolved(opts);
  const endpoint = `${baseUrl}/chat/completions`;

  return {
    describe: () => ({ model, host: baseUrl }),
    async chat(input: ChatInput): Promise<ChatOutput> {
      const maxTokens = Math.min(MAX_MAX_TOKENS, Math.max(1, Math.floor(input.maxTokens ?? DEFAULT_MAX_TOKENS)));
      const body: Record<string, unknown> = {
        model,
        messages: toWireMessages(input.system, input.messages),
        max_tokens: maxTokens,
        stream: false,
      };
      const tools = toWireTools(input.tools);
      if (tools) {
        body.tools = tools;
        body.tool_choice = "auto";
      }
      const init: { method: "POST"; body: string; signal?: AbortSignal } = { method: "POST", body: JSON.stringify(body) };
      if (input.signal) init.signal = input.signal;
      const json = await requestJson(io, endpoint, init);

      const choices = (json as { choices?: unknown }).choices;
      if (!Array.isArray(choices) || choices.length === 0) {
        throw new VultrError("protocol", "response has no choices");
      }
      const first = choices[0] as { message?: { content?: unknown; tool_calls?: unknown } };
      const message = first?.message;
      if (!message || typeof message !== "object") throw new VultrError("protocol", "response choice has no message");
      const text = typeof message.content === "string" ? message.content : "";
      const toolCalls = parseToolCalls(message.tool_calls);
      return { text, toolCalls, usage: usageOf((json as { usage?: unknown }).usage) };
    },
  };
}

/** Replays scripted turns in order; once exhausted, returns an empty text turn forever. */
export function createScriptedDriver(script: ScriptedTurn[], options: { name?: string } = {}): ModelDriver {
  const turns = [...script];
  let cursor = 0;
  let counter = 0;
  return {
    // Labelled so no UI or export can mistake a replayed script for a live Vultr repair.
    describe: () => ({ model: `scripted:${options.name ?? "script"}`, host: "scripted" }),
    async chat(input: ChatInput): Promise<ChatOutput> {
      if (input.signal?.aborted) throw new VultrError("aborted", "request aborted");
      const turn = turns[cursor];
      cursor = Math.min(cursor + 1, turns.length);
      if (!turn) return { text: "", toolCalls: [], usage: { input: 0, output: 0 } };
      const toolCalls = (turn.toolCalls ?? []).map((tc) => {
        counter += 1;
        return { id: `scripted-${counter}`, name: tc.name, args: tc.args };
      });
      return { text: turn.text ?? "", toolCalls, usage: { input: 0, output: 0 } };
    },
  };
}

export interface ModelEntry {
  id: string;
  /** True when the catalog advertises tool calling for this model. */
  tools: boolean;
  raw: Record<string, unknown>;
}

/** Reads `supported_parameters` in either its array or object form. */
function advertisesTools(entry: Record<string, unknown>): boolean {
  const sp = entry.supported_parameters;
  if (Array.isArray(sp)) return sp.some((v) => v === "tools" || v === "tool_choice");
  if (sp && typeof sp === "object") {
    const o = sp as Record<string, unknown>;
    return o.tools === true || o.tool_choice === true;
  }
  const caps = entry.capabilities;
  if (Array.isArray(caps)) return caps.some((v) => v === "tools" || v === "function_calling");
  if (caps && typeof caps === "object") return (caps as Record<string, unknown>).tools === true;
  return entry.tools === true;
}

/** GET {baseUrl}/models → the `data` array with a normalized `tools` flag. The key is optional. */
export async function listModels(
  baseUrl: string,
  apiKey?: string,
  extra?: { fetch?: typeof fetch; signal?: AbortSignal },
): Promise<ModelEntry[]> {
  const base = normalizeBaseUrl(baseUrl);
  const io = resolved({ apiKey: apiKey ?? "", baseUrl: base, model: "unused", ...(extra?.fetch ? { fetch: extra.fetch } : {}) });
  const init: { method: "GET"; signal?: AbortSignal } = { method: "GET" };
  if (extra?.signal) init.signal = extra.signal;
  const json = await requestJson(io, `${base}/models`, init);
  const data = (json as { data?: unknown }).data;
  if (!Array.isArray(data)) throw new VultrError("protocol", "/models response has no data array");
  const out: ModelEntry[] = [];
  for (const item of data.slice(0, 1000)) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    if (typeof entry.id !== "string" || entry.id.length === 0) continue;
    out.push({ id: entry.id.slice(0, 128), tools: advertisesTools(entry), raw: entry });
  }
  return out;
}
