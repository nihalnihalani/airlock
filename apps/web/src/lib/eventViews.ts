/**
 * Read-only projections of RunEvents and the TaskView into what the panels render.
 *
 * Event `data` is a free-form record owned by the control plane. These helpers read the keys the
 * control app documents (model, host, usage, command, result, probe, inspection, teardown, host)
 * and fall back gracefully; unknown shapes are surfaced as "unknown", never guessed.
 */
import {
  ExecResult,
  HostCheck,
  IsolationProbe,
  RuntimeInspection,
  TeardownRecord,
  type RunEvent,
  type TaskView,
} from "@airlock/contracts";
import { hostnameOf } from "./format";

const VULTR_HOST = "api.vultrinference.com";

type Data = Record<string, unknown>;

function asRecord(value: unknown): Data | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Data) : null;
}

function str(value: unknown, max = 512): string | null {
  if (typeof value !== "string") return null;
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function pickStr(data: Data | null, keys: string[], max?: number): string | null {
  if (!data) return null;
  for (const key of keys) {
    const v = str(data[key], max);
    if (v !== null) return v;
  }
  return null;
}

function pickNum(data: Data | null, keys: string[]): number | null {
  if (!data) return null;
  for (const key of keys) {
    const v = num(data[key]);
    if (v !== null) return v;
  }
  return null;
}

// --- Model calls ------------------------------------------------------------------------------

export interface ModelCallRow {
  seq: number;
  at: string;
  title: string;
  detail: string;
  model: string | null;
  host: string;
  inputTokens: number | null;
  outputTokens: number | null;
  toolCalls: string[];
  durationMs: number | null;
  isError: boolean;
}

export function toModelCallRow(ev: RunEvent): ModelCallRow {
  const data = asRecord(ev.data);
  const usage = asRecord(data?.["usage"]);
  const rawHost = pickStr(data, ["host", "baseUrl", "endpoint"], 256);
  const host = rawHost ? hostnameOf(rawHost) : VULTR_HOST;
  const toolCalls: string[] = [];
  const calls = data?.["toolCalls"];
  if (Array.isArray(calls)) {
    for (const call of calls.slice(0, 32)) {
      const rec = asRecord(call);
      const name = rec ? str(rec["name"], 64) : str(call, 64);
      if (name) toolCalls.push(name);
    }
  }
  return {
    seq: ev.seq,
    at: ev.at,
    title: ev.title,
    detail: ev.detail,
    model: pickStr(data, ["model", "modelId"], 128),
    host,
    inputTokens: pickNum(usage, ["input", "inputTokens", "prompt_tokens", "promptTokens"]) ?? pickNum(data, ["inputTokens"]),
    outputTokens:
      pickNum(usage, ["output", "outputTokens", "completion_tokens", "completionTokens"]) ??
      pickNum(data, ["outputTokens"]),
    toolCalls,
    durationMs: pickNum(data, ["durationMs", "latencyMs"]),
    isError: ev.kind === "error" || data?.["error"] === true || typeof data?.["error"] === "string",
  };
}

export function modelCallRows(events: readonly RunEvent[]): ModelCallRow[] {
  return events.filter((ev) => ev.kind === "model").map(toModelCallRow);
}

export function totalUsage(rows: readonly ModelCallRow[]): { input: number; output: number; calls: number } {
  let input = 0;
  let output = 0;
  for (const row of rows) {
    input += row.inputTokens ?? 0;
    output += row.outputTokens ?? 0;
  }
  return { input, output, calls: rows.length };
}

// --- Tool / exec log --------------------------------------------------------------------------

export interface ExecRow {
  seq: number;
  at: string;
  kind: RunEvent["kind"];
  title: string;
  detail: string;
  tool: string | null;
  command: string | null;
  path: string | null;
  result: ExecResult | null;
  /** Set when the event carries a status but no full ExecResult. */
  statusHint: string | null;
}

export function toExecRow(ev: RunEvent): ExecRow {
  const data = asRecord(ev.data);
  const args = asRecord(data?.["args"]);
  const nested = asRecord(data?.["result"]);
  let result: ExecResult | null = null;
  for (const candidate of [nested, data]) {
    if (!candidate) continue;
    const parsed = ExecResult.safeParse(candidate);
    if (parsed.success) {
      result = parsed.data;
      break;
    }
  }
  return {
    seq: ev.seq,
    at: ev.at,
    kind: ev.kind,
    title: ev.title,
    detail: ev.detail,
    tool: pickStr(data, ["tool", "name", "kind"], 64),
    command: pickStr(data, ["command"], 4096) ?? pickStr(args, ["command"], 4096),
    path: pickStr(data, ["path"], 512) ?? pickStr(args, ["path"], 512),
    result,
    statusHint: result ? null : pickStr(data, ["status"], 64),
  };
}

export function execRows(events: readonly RunEvent[]): ExecRow[] {
  return events.filter((ev) => ev.kind === "tool" || ev.kind === "exec").map(toExecRow);
}

// --- Five checkpoints -------------------------------------------------------------------------

export interface Checkpoints {
  host: HostCheck | null;
  hostSource: string;
  execCount: number;
  execFailures: number;
  inspections: { label: string; inspection: RuntimeInspection }[];
  probes: { label: string; probe: IsolationProbe }[];
  teardowns: { label: string; teardown: TeardownRecord }[];
}

/**
 * Prefer the immutable verification records (they are what the export carries); use `check`
 * events to show progress before those records exist.
 */
export function extractCheckpoints(view: TaskView | null, events: readonly RunEvent[]): Checkpoints {
  const out: Checkpoints = {
    host: null,
    hostSource: "",
    execCount: 0,
    execFailures: 0,
    inspections: [],
    probes: [],
    teardowns: [],
  };

  if (view?.host) {
    out.host = view.host;
    out.hostSource = "task view";
  }
  for (const [label, record] of [
    ["baseline", view?.baseline],
    ["candidate", view?.verification],
  ] as const) {
    if (!record) continue;
    if (!out.host) {
      out.host = record.runtimeProfile.host;
      out.hostSource = `${label} verification record`;
    }
    out.inspections.push({ label: `${label} run`, inspection: record.runtimeProfile.inspection });
    if (record.runtimeProfile.probe) out.probes.push({ label: `${label} run`, probe: record.runtimeProfile.probe });
    out.teardowns.push({ label: `${label} run`, teardown: record.runtimeProfile.teardown });
  }

  const seenInspections = new Set(out.inspections.map((i) => i.inspection.container + i.inspection.inspectedAt));
  const seenProbes = new Set(out.probes.map((p) => p.probe.probedAt));
  const seenTeardowns = new Set(out.teardowns.map((t) => t.teardown.destroyedAt));

  for (const ev of events) {
    if (ev.kind === "exec" || ev.kind === "tool") {
      const row = toExecRow(ev);
      if (row.result || row.command) {
        out.execCount += 1;
        if (row.result && row.result.status !== "succeeded") out.execFailures += 1;
      }
      continue;
    }
    if (ev.kind !== "check" && ev.kind !== "lifecycle" && ev.kind !== "info") continue;
    const data = asRecord(ev.data);
    if (!data) continue;
    const label = ev.title.length > 0 ? ev.title.slice(0, 80) : `event #${ev.seq}`;

    if (!out.host) {
      const host = HostCheck.safeParse(data["host"]);
      if (host.success) {
        out.host = host.data;
        out.hostSource = `event #${ev.seq}`;
      }
    }
    const inspection = RuntimeInspection.safeParse(data["inspection"]);
    if (inspection.success) {
      const key = inspection.data.container + inspection.data.inspectedAt;
      if (!seenInspections.has(key)) {
        seenInspections.add(key);
        out.inspections.push({ label, inspection: inspection.data });
      }
    }
    const probe = IsolationProbe.safeParse(data["probe"]);
    if (probe.success && !seenProbes.has(probe.data.probedAt)) {
      seenProbes.add(probe.data.probedAt);
      out.probes.push({ label, probe: probe.data });
    }
    const teardown = TeardownRecord.safeParse(data["teardown"]);
    if (teardown.success && !seenTeardowns.has(teardown.data.destroyedAt)) {
      seenTeardowns.add(teardown.data.destroyedAt);
      out.teardowns.push({ label, teardown: teardown.data });
    }
  }
  return out;
}

// --- Runtime tier -----------------------------------------------------------------------------

export interface RuntimeTier {
  runtime: "kata" | "runsc" | "runc" | null;
  devUnsafe: boolean;
  source: string;
}

export function runtimeTier(cp: Checkpoints): RuntimeTier {
  const latest = cp.inspections[cp.inspections.length - 1];
  if (latest) {
    return { runtime: latest.inspection.runtime, devUnsafe: latest.inspection.devUnsafe, source: "inspected" };
  }
  if (cp.host) return { runtime: cp.host.selectedRuntime, devUnsafe: cp.host.devUnsafe, source: "host check" };
  return { runtime: null, devUnsafe: false, source: "not yet inspected" };
}
