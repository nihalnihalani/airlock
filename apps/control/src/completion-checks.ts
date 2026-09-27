/**
 * Completion checks for general tasks (C32). Run by the controller after submit_result, on bytes
 * collected by the supervisor from a stopped sandbox and on the task's own recorded events. The
 * model's claims (summary, "done", the list of outputs) are inputs to be checked, never results.
 *
 * Structural checks only: JSON parses, CSV parses with at least one data row, PNG has a valid
 * header and sane dimensions, summary.json has an `answer`. A screenshot or a vision reading is
 * evidence, not authority; nothing here judges whether an answer is correct.
 */
import type { TaskResult } from "@airlock/contracts";
import { decodeText } from "./artifact-service.ts";
import { parseCsv } from "./csv.ts";
import { inspectPng } from "./png.ts";
import { hostAllowed, normalizeUrl, urlHost, type CompletionCheckName, type TaskProfile } from "./task-profiles.ts";

export type Check = TaskResult["checks"][number];

export interface CollectedOutput {
  /** Path relative to outputs/. */
  path: string;
  bytes: Uint8Array;
  mediaType: string;
}

export interface CheckInput {
  profile: TaskProfile;
  /** Paths as the model claimed them ("outputs/…"). */
  claimed: string[];
  /** Null when no collection happened (no code sandbox, or it could not be collected); `reason` says why. */
  collected: { files: CollectedOutput[]; rejected: { path: string; reason: string }[] } | null;
  collectionProblem?: string;
  /**
   * The agent's own stored screenshots, with the page URL each one recorded. A screenshot counts as
   * evidence only when it shows a cited source (same origin and path, query/hash ignored), so a
   * screenshot of about:blank or of an unrelated page never satisfies the check (C41 O3).
   */
  screenshots: { url?: string | null | undefined }[];
  sources: string[];
  /** Normalised URLs this task's browser actually reached (navigate/observe results in its events). */
  visited: Set<string>;
  egressAllow: string[];
}

const detail = (text: string) => (text.length > 1024 ? `${text.slice(0, 1020)}…` : text);

/** The format check of one collected output, by extension. */
export function checkOutputFormat(path: string, bytes: Uint8Array): { ok: boolean; detail: string } {
  const lower = path.toLowerCase();
  if (lower.endsWith(".png")) {
    const png = inspectPng(bytes);
    return png.ok ? { ok: true, detail: `PNG ${png.width}x${png.height}, ${bytes.byteLength} bytes` } : { ok: false, detail: `not a valid PNG: ${png.reason}` };
  }
  const text = decodeText(bytes);
  if (lower.endsWith(".json")) {
    if (text === null) return { ok: false, detail: "not UTF-8 text" };
    try {
      JSON.parse(text);
      return { ok: true, detail: `valid JSON, ${bytes.byteLength} bytes` };
    } catch (error) {
      return { ok: false, detail: `JSON does not parse: ${error instanceof Error ? error.message.slice(0, 200) : "invalid"}` };
    }
  }
  if (lower.endsWith(".csv")) {
    if (text === null) return { ok: false, detail: "not UTF-8 text" };
    const csv = parseCsv(text);
    if (!csv.ok) return { ok: false, detail: `CSV does not parse: ${csv.reason}` };
    if (csv.rows.length < 2) return { ok: false, detail: "CSV has a header but no data row" };
    return { ok: true, detail: `CSV with ${csv.rows.length - 1} data row(s) and ${csv.rows[0]!.length} column(s)` };
  }
  if ([".txt", ".md", ".py", ".js", ".mjs"].some((e) => lower.endsWith(e))) {
    if (text === null) return { ok: false, detail: "not UTF-8 text" };
    if (text.trim().length === 0) return { ok: false, detail: "empty file" };
    return { ok: true, detail: `text, ${bytes.byteLength} bytes` };
  }
  return { ok: false, detail: "unsupported output type" };
}

/** summary.json: a JSON object with a non-empty `answer` (string or number). */
export function checkSummarySchema(bytes: Uint8Array): { ok: boolean; detail: string } {
  const text = decodeText(bytes);
  if (text === null) return { ok: false, detail: "summary.json is not UTF-8 text" };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, detail: "summary.json does not parse" };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, detail: "summary.json is not a JSON object" };
  const answer = (value as Record<string, unknown>).answer;
  if (typeof answer === "string" && answer.trim().length > 0) return { ok: true, detail: `answer: ${answer.slice(0, 200)}` };
  if (typeof answer === "number" && Number.isFinite(answer)) return { ok: true, detail: `answer: ${answer}` };
  return { ok: false, detail: 'summary.json has no non-empty "answer" field' };
}

/** Origin + path of an http(s) URL (trailing slash, query and hash ignored); null otherwise. */
export function documentKey(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const path = url.pathname.length > 1 && url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname;
    // The query is part of the document (?variant=a and ?variant=b are different data); parameters are
    // sorted so their order does not matter. The fragment is not sent to the server and is ignored.
    url.searchParams.sort();
    const query = url.searchParams.toString();
    return `${url.protocol}//${url.host.toLowerCase()}${path}${query ? `?${query}` : ""}`;
  } catch {
    return null;
  }
}

/** The screenshot-evidence check: at least one screenshot whose recorded URL is a cited source. */
export function checkScreenshotEvidence(screenshots: CheckInput["screenshots"], sources: string[], requireSource: boolean): { ok: boolean; detail: string } {
  if (screenshots.length === 0) return { ok: false, detail: "no screenshot was stored" };
  const pages = screenshots.map((s) => (typeof s.url === "string" ? documentKey(s.url) : null));
  const web = pages.filter((k): k is string => k !== null);
  if (web.length === 0) return { ok: false, detail: `${screenshots.length} screenshot(s) stored, none of an http(s) page (e.g. about:blank)` };
  const cited = new Map<string, string>();
  for (const src of sources) {
    const k = documentKey(src);
    if (k && !cited.has(k)) cited.set(k, src);
  }
  if (cited.size === 0) {
    if (requireSource) return { ok: false, detail: `${screenshots.length} screenshot(s) stored, but no cited source to bind a screenshot to` };
    return { ok: true, detail: `${web.length} screenshot(s) of an http(s) page stored` };
  }
  const matched = [...new Set(web.filter((k) => cited.has(k)))];
  if (matched.length === 0) return { ok: false, detail: `${screenshots.length} screenshot(s) stored, none shows a cited source (same origin and path)` };
  return { ok: true, detail: `${screenshots.length} screenshot(s) stored; cited source(s) shown: ${matched.map((k) => cited.get(k)).join(", ")}` };
}

const underOutputs = (claimed: string) => (claimed.startsWith("outputs/") ? claimed.slice("outputs/".length) : claimed);

export function runCompletionChecks(input: CheckInput): Check[] {
  const checks: Check[] = [];
  const want = new Set<CompletionCheckName>(input.profile.checks);
  const files = new Map((input.collected?.files ?? []).map((f) => [f.path, f]));
  const rejected = new Map((input.collected?.rejected ?? []).map((r) => [r.path, r.reason]));
  const claimed = [...new Set(input.claimed.map(underOutputs))];
  const perOutput = new Map<string, { ok: boolean; detail: string }>();
  for (const path of claimed) {
    const file = files.get(path);
    let verdict: { ok: boolean; detail: string };
    if (!input.collected) verdict = { ok: false, detail: `not collected: ${input.collectionProblem ?? "no code sandbox produced outputs"}` };
    else if (rejected.has(path)) verdict = { ok: false, detail: `rejected by the collector: ${rejected.get(path)}` };
    else if (!file) verdict = { ok: false, detail: "claimed but not found under outputs/" };
    else verdict = checkOutputFormat(path, file.bytes);
    perOutput.set(path, verdict);
  }

  if (want.has("outputs-claimed")) checks.push({ name: "outputs-claimed", passed: claimed.length > 0, detail: claimed.length > 0 ? `${claimed.length} output(s) claimed` : "no output under outputs/ was claimed" });
  if (want.has("outputs-valid")) {
    const bad = [...perOutput].filter(([, v]) => !v.ok);
    checks.push({
      name: "outputs-valid",
      passed: claimed.length > 0 && bad.length === 0,
      detail: detail(claimed.length === 0 ? "nothing to validate" : bad.length === 0 ? `all ${claimed.length} claimed output(s) collected and valid` : bad.map(([p, v]) => `outputs/${p}: ${v.detail}`).join("; ")),
    });
  }
  for (const [path, verdict] of [...perOutput].slice(0, 20)) checks.push({ name: `output:${path}`.slice(0, 128), passed: verdict.ok, detail: detail(verdict.detail) });
  if (want.has("required-outputs") && input.profile.requiredOutputs.length > 0) {
    const missing = input.profile.requiredOutputs.filter((p) => !perOutput.get(p)?.ok);
    checks.push({ name: "required-outputs", passed: missing.length === 0, detail: missing.length === 0 ? `present and valid: ${input.profile.requiredOutputs.join(", ")}` : `missing or invalid: ${missing.map((p) => `outputs/${p}`).join(", ")}` });
  }
  if (want.has("summary-schema")) {
    const required = input.profile.requiredOutputs.includes("summary.json");
    const file = files.get("summary.json");
    if (claimed.includes("summary.json") && file && !rejected.has("summary.json")) {
      const s = checkSummarySchema(file.bytes);
      checks.push({ name: "summary-schema", passed: s.ok, detail: detail(s.detail) });
    } else checks.push({ name: "summary-schema", passed: !required, detail: required ? "outputs/summary.json is required and was not claimed and collected" : "no summary.json (optional for this profile)" });
  }
  const sources = [...new Set(input.sources)];
  if (want.has("screenshot-evidence")) {
    const shot = checkScreenshotEvidence(input.screenshots, sources, want.has("sources-cited"));
    checks.push({ name: "screenshot-evidence", passed: shot.ok, detail: detail(shot.detail) });
  }
  if (want.has("sources-cited")) checks.push({ name: "sources-cited", passed: sources.length > 0, detail: sources.length > 0 ? `${sources.length} source(s) cited` : "no source URL was cited" });
  if (want.has("sources-visited")) {
    const unvisited = sources.filter((s) => {
      const n = normalizeUrl(s);
      return !n || !input.visited.has(n);
    });
    checks.push({
      name: "sources-visited",
      passed: sources.length > 0 && unvisited.length === 0,
      detail: detail(sources.length === 0 ? "no source to check" : unvisited.length === 0 ? "every cited source was reached by this task's browser" : `never reached by this task's browser: ${unvisited.join(", ")}`),
    });
  }
  if (want.has("sources-in-policy")) {
    const outside = sources.filter((s) => {
      const host = urlHost(s);
      return !host || !hostAllowed(host, input.egressAllow);
    });
    checks.push({
      name: "sources-in-policy",
      passed: sources.length > 0 && outside.length === 0,
      detail: detail(sources.length === 0 ? "no source to check" : outside.length === 0 ? "every cited source is inside the allowed destinations" : `outside the allowed destinations: ${outside.join(", ")}`),
    });
  }
  return checks;
}
