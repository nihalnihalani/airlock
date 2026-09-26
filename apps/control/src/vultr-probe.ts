/**
 * Measured tool-call round trip against Vultr Serverless Inference.
 *
 * CLAUDE.md §2: "Model choice is made by a measured tool-call round trip on the live /v1/models
 * list, never from a slide." For each candidate model this sends a prompt that must call
 * `add(a, b)`, feeds the tool result back, and records whether the follow-up turn used it,
 * with latency and token usage. `scripts/probe-model.ts` prints the table and a recommendation.
 */
import {
  VultrError,
  createVultrDriver,
  listModels,
  type ChatMessage,
  type ModelDriver,
  type ToolSpec,
} from "./vultr-client.ts";

export interface ProbeRow {
  model: string;
  /** Both round trips completed without a transport/auth error. */
  ok: boolean;
  /** A parsed `add` tool call with numeric a and b arrived on the first turn. */
  toolCallParsed: boolean;
  /** The second turn's text contains the tool result (the true sum). */
  usedToolResult: boolean;
  /** The first turn invented an answer without calling the tool. */
  answeredWithoutTool: boolean;
  firstTurnMs: number;
  secondTurnMs: number;
  totalMs: number;
  tokens: { input: number; output: number };
  error?: string;
}

export interface ProbeOptions {
  baseUrl: string;
  apiKey: string;
  /** Candidate model ids; when omitted, every /models entry advertising tools. */
  models?: string[];
  fetch?: typeof fetch;
  /** Per-model wall-clock budget for both turns (default 90 s). */
  timeoutMs?: number;
  /** Test seam: replaces createVultrDriver. */
  driverFactory?: (model: string) => ModelDriver;
}

const ADD_TOOL: ToolSpec = {
  name: "add",
  description: "Adds two integers and returns their exact sum. Always use this tool for addition.",
  parameters: {
    type: "object",
    properties: {
      a: { type: "integer", description: "first addend" },
      b: { type: "integer", description: "second addend" },
    },
    required: ["a", "b"],
    additionalProperties: false,
  },
};

const SYSTEM =
  "You are a calculator agent. You cannot do arithmetic yourself; you must call the `add` tool " +
  "for any addition and then report the tool's result verbatim in one short sentence.";

const MAX_MODELS = 64;

function pickOperands(): { a: number; b: number } {
  // Values large and odd enough that a model is unlikely to have the sum memorized, and whose
  // digits do not appear in the operands so "used the result" is not a substring accident.
  const a = 1000 + Math.floor(Math.random() * 8000);
  const b = 1000 + Math.floor(Math.random() * 8000);
  return { a, b };
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && /^-?\d+$/.test(v.trim())) return Number(v.trim());
  return null;
}

async function withTimeout<T>(p: Promise<T>, ms: number, controller: AbortController): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new VultrError("network", `probe exceeded ${ms} ms`));
    }, ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function probeModel(model: string, opts: ProbeOptions): Promise<ProbeRow> {
  const row: ProbeRow = {
    model,
    ok: false,
    toolCallParsed: false,
    usedToolResult: false,
    answeredWithoutTool: false,
    firstTurnMs: 0,
    secondTurnMs: 0,
    totalMs: 0,
    tokens: { input: 0, output: 0 },
  };
  const budget = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : 90_000;
  const controller = new AbortController();
  const started = performance.now();
  try {
    const driver =
      opts.driverFactory?.(model) ??
      createVultrDriver({
        apiKey: opts.apiKey,
        baseUrl: opts.baseUrl,
        model,
        ...(opts.fetch ? { fetch: opts.fetch } : {}),
        requestTimeoutMs: budget,
      });
    const { a, b } = pickOperands();
    const sum = a + b;
    const messages: ChatMessage[] = [{ role: "user", content: `What is ${a} + ${b}? Use the add tool.` }];

    const t0 = performance.now();
    const first = await withTimeout(
      driver.chat({ system: SYSTEM, messages, tools: [ADD_TOOL], signal: controller.signal, maxTokens: 512 }),
      budget,
      controller,
    );
    row.firstTurnMs = Math.round(performance.now() - t0);
    row.tokens.input += first.usage.input;
    row.tokens.output += first.usage.output;

    const call = first.toolCalls.find((c) => c.name === "add");
    const args = (call?.args ?? {}) as Record<string, unknown>;
    const ca = num(args.a);
    const cb = num(args.b);
    row.toolCallParsed = Boolean(call) && ca === a && cb === b;
    if (!call) {
      row.answeredWithoutTool = first.text.includes(String(sum));
      row.ok = true;
      row.totalMs = Math.round(performance.now() - started);
      return row;
    }

    // Feed back the true result even if the arguments were off, so we still measure turn two.
    const toolResult = ca !== null && cb !== null ? ca + cb : sum;
    messages.push({ role: "assistant", content: first.text, toolCalls: first.toolCalls });
    messages.push({ role: "tool", toolCallId: call.id, content: JSON.stringify({ result: toolResult }) });

    const remaining = Math.max(1000, budget - (performance.now() - started));
    const t1 = performance.now();
    const second = await withTimeout(
      driver.chat({ system: SYSTEM, messages, tools: [ADD_TOOL], signal: controller.signal, maxTokens: 256 }),
      remaining,
      controller,
    );
    row.secondTurnMs = Math.round(performance.now() - t1);
    row.tokens.input += second.usage.input;
    row.tokens.output += second.usage.output;
    row.usedToolResult = second.text.replace(/[,\s]/g, "").includes(String(toolResult));
    row.ok = true;
  } catch (err) {
    row.error = err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200);
    if (err instanceof VultrError && err.kind === "auth") throw err;
  }
  row.totalMs = Math.round(performance.now() - started);
  return row;
}

export async function probeModels(opts: ProbeOptions): Promise<ProbeRow[]> {
  let models = opts.models?.filter((m) => m.trim().length > 0).map((m) => m.trim());
  if (!models || models.length === 0) {
    const catalog = await listModels(opts.baseUrl, opts.apiKey, opts.fetch ? { fetch: opts.fetch } : undefined);
    models = catalog.filter((m) => m.tools).map((m) => m.id);
    if (models.length === 0) throw new VultrError("protocol", "no model in /models advertises tools");
  }
  models = [...new Set(models)].slice(0, MAX_MODELS);
  const rows: ProbeRow[] = [];
  for (const model of models) rows.push(await probeModel(model, opts));
  return rows;
}

/** Fastest model that parsed the tool call and used its result; null when none qualifies. */
export function recommend(rows: ProbeRow[]): ProbeRow | null {
  const good = rows.filter((r) => r.ok && r.toolCallParsed && r.usedToolResult);
  if (good.length === 0) return null;
  good.sort((x, y) => x.totalMs - y.totalMs);
  return good[0] as ProbeRow;
}

export function formatTable(rows: ProbeRow[]): string {
  const headers = ["model", "ok", "tool_call", "used_result", "no_tool_answer", "turn1_ms", "turn2_ms", "in_tok", "out_tok", "error"];
  const data = rows.map((r) => [
    r.model,
    r.ok ? "yes" : "no",
    r.toolCallParsed ? "yes" : "no",
    r.usedToolResult ? "yes" : "no",
    r.answeredWithoutTool ? "yes" : "no",
    String(r.firstTurnMs),
    String(r.secondTurnMs),
    String(r.tokens.input),
    String(r.tokens.output),
    r.error ?? "",
  ]);
  const widths = headers.map((h, i) => Math.max(h.length, ...data.map((d) => (d[i] as string).length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i] as number)).join("  ");
  return [line(headers), line(widths.map((w) => "-".repeat(w))), ...data.map(line)].join("\n");
}
