/**
 * General task profiles (C18, C31): the controller's registry of what a general task may do.
 *
 * The controller, not the model, selects the profile, the sandbox images (supervisor runtime
 * profiles "browser", "analysis", "node"), the tool inventory, the budgets, the network policy and
 * the completion checks. A task names a profile id at creation; nothing in a profile is taken from
 * the request except the owner's destination list (egressAllow), which is validated here and
 * bounded by the profile, and the owner's own uploads.
 *
 * Code repair keeps its own profile directories (`profiles/<id>`, RepairHandler); these ids never
 * collide with them.
 */
import { isIP } from "node:net";

export const GENERAL_TOOL_NAMES = [
  "browser_navigate",
  "browser_observe",
  "browser_click",
  "browser_type",
  "browser_key",
  "browser_scroll",
  "browser_screenshot",
  "browser_tabs",
  "browser_save_text",
  "browser_download_list",
  "browser_download_save",
  "browser_propose_submit",
  "code_write",
  "code_run",
  "code_read",
  "files_list",
  "submit_result",
] as const;
export type GeneralToolName = (typeof GENERAL_TOOL_NAMES)[number];

/** Completion checks the controller runs after submit_result (C32). The model never sets success. */
export type CompletionCheckName =
  /** At least one output under outputs/ was claimed. */
  | "outputs-claimed"
  /** Every claimed output was collected (not rejected) and passes its format check (JSON, CSV, PNG). */
  | "outputs-valid"
  /** Each `requiredOutputs` file was claimed, collected and valid. */
  | "required-outputs"
  /** outputs/summary.json, when present or required, is an object with a non-empty `answer`. */
  | "summary-schema"
  /** At least one screenshot artifact was stored for the task. */
  | "screenshot-evidence"
  /** At least one source URL is cited. */
  | "sources-cited"
  /** Every cited source URL was actually visited by this task's browser (from its own events). */
  | "sources-visited"
  /** Every cited source URL's host is inside the task's egressAllow. */
  | "sources-in-policy";

export interface TaskProfileBudgets {
  modelCalls: number;
  tokens: number;
  /** Wall clock for the whole task, across recoveries. */
  wallClockMs: number;
  browserOps: number;
  codeRuns: number;
  /** Browser sessions (a lost runner closes one; the next browser tool starts a fresh one). */
  browserSessions: number;
  /** Code sandboxes (a lost one is replaced once, with inputs re-placed). */
  codeSandboxes: number;
  recoveries: number;
  /** Absolute deadline of each sandbox, capped by the task wall clock. */
  attemptMs: number;
}

export interface TaskProfile {
  id: "analysis" | "web-research" | "web-analysis";
  version: string;
  displayName: string;
  description: string;
  tools: GeneralToolName[];
  browser: boolean;
  /** Code languages this profile may run; the first code tool picks the task's one code sandbox. */
  codeLanguages: ("python" | "node")[];
  /** A browser profile needs a non-empty owner destination list; at most this many entries. */
  maxEgressHosts: number;
  budgets: TaskProfileBudgets;
  checks: CompletionCheckName[];
  /** Paths under outputs/ that must be claimed and valid. */
  requiredOutputs: string[];
  acceptsUploads: boolean;
}

const MINUTE = 60_000;

export const TASK_PROFILES: ReadonlyMap<string, TaskProfile> = new Map<string, TaskProfile>([
  [
    "analysis",
    {
      id: "analysis",
      version: "1",
      displayName: "File analysis (offline code)",
      description: "Analyse uploaded files with model-written Python (or Node) in an offline sandbox and return checked output files. No browser, no network.",
      tools: ["code_write", "code_run", "code_read", "files_list", "submit_result"],
      browser: false,
      codeLanguages: ["python", "node"],
      maxEgressHosts: 0,
      budgets: { modelCalls: 30, tokens: 1_500_000, wallClockMs: 20 * MINUTE, browserOps: 0, codeRuns: 20, browserSessions: 0, codeSandboxes: 2, recoveries: 2, attemptMs: 15 * MINUTE },
      checks: ["outputs-claimed", "outputs-valid", "required-outputs", "summary-schema"],
      requiredOutputs: [],
      acceptsUploads: true,
    },
  ],
  [
    "web-research",
    {
      id: "web-research",
      version: "1",
      displayName: "Web research (browser only)",
      description: "Read and interact with pages on the destinations you allow, with screenshot evidence and cited sources. No code execution.",
      tools: ["browser_navigate", "browser_observe", "browser_click", "browser_type", "browser_key", "browser_scroll", "browser_screenshot", "browser_tabs", "browser_download_list", "browser_download_save", "browser_propose_submit", "submit_result"],
      browser: true,
      codeLanguages: [],
      maxEgressHosts: 16,
      budgets: { modelCalls: 30, tokens: 1_500_000, wallClockMs: 20 * MINUTE, browserOps: 60, codeRuns: 0, browserSessions: 3, codeSandboxes: 0, recoveries: 2, attemptMs: 15 * MINUTE },
      checks: ["screenshot-evidence", "sources-cited", "sources-visited", "sources-in-policy"],
      requiredOutputs: [],
      acceptsUploads: false,
    },
  ],
  [
    "web-analysis",
    {
      id: "web-analysis",
      version: "1",
      displayName: "Web data analysis (browser + offline code)",
      description: "Collect data from pages on the destinations you allow, analyse it with offline Python (or Node), and return a checked summary, chart and sources.",
      tools: ["browser_navigate", "browser_observe", "browser_click", "browser_type", "browser_key", "browser_scroll", "browser_screenshot", "browser_tabs", "browser_save_text", "browser_download_list", "browser_download_save", "browser_propose_submit", "code_write", "code_run", "code_read", "files_list", "submit_result"],
      browser: true,
      codeLanguages: ["python", "node"],
      maxEgressHosts: 16,
      budgets: { modelCalls: 40, tokens: 2_000_000, wallClockMs: 25 * MINUTE, browserOps: 60, codeRuns: 20, browserSessions: 3, codeSandboxes: 2, recoveries: 2, attemptMs: 20 * MINUTE },
      checks: ["outputs-claimed", "outputs-valid", "required-outputs", "summary-schema", "screenshot-evidence", "sources-cited", "sources-visited", "sources-in-policy"],
      requiredOutputs: ["summary.json"],
      acceptsUploads: true,
    },
  ],
]);

/** Public view of a profile for `GET /api/task-profiles`. */
export function publicTaskProfile(p: TaskProfile) {
  return {
    id: p.id,
    version: p.version,
    displayName: p.displayName,
    description: p.description,
    tools: p.tools,
    browser: p.browser,
    codeLanguages: p.codeLanguages,
    maxEgressHosts: p.maxEgressHosts,
    budgets: p.budgets,
    checks: p.checks,
    requiredOutputs: p.requiredOutputs,
    acceptsUploads: p.acceptsUploads,
  };
}

/** Names that never reach a public destination: loopback, private-use and special-use suffixes. */
const RESERVED_SUFFIXES = ["localhost", "local", "internal", "localdomain", "lan", "home", "corp", "intranet", "private", "arpa", "onion", "test", "invalid", "example"];

/**
 * Wildcard-DNS services: any name under them resolves to an address encoded in the name (often a
 * private or loopback one, or the deployment itself), so an allowlist entry there is effectively an
 * IP literal. Refused as exact names and as `.suffix`, except a configured fixtures/forms hostname.
 */
export const WILDCARD_DNS_SUFFIXES = ["sslip.io", "nip.io", "xip.io", "traefik.me", "localtest.me", "lvh.me"];

export interface EgressPolicyOptions {
  /** The deployment's own public host(s) and the control plane's request host: never a destination. */
  ownHosts?: readonly string[];
  /** Hostnames of the configured fixtures/forms origins: allowed even under a wildcard-DNS suffix. */
  exemptHosts?: readonly string[];
}

const underOrAt = (host: string, suffix: string) => host === suffix || host.endsWith(`.${suffix}`);

/**
 * Validates an owner-supplied destination list against the profile. Entries are exact hostnames
 * or `.suffix` (subdomains only). Refused: IP literals, single-label names, localhost, `.internal`
 * and other special-use suffixes, a bare public suffix as `.suffix` (e.g. `.com`), duplicates, and
 * more entries than the profile allows; the deployment's own host(s) (exactly, or covered by a
 * `.suffix` entry); and names under wildcard-DNS services (sslip.io, nip.io…) other than the
 * configured fixtures/forms hostnames. Returns the normalised list or the reasons.
 */
export function validateEgressAllow(list: string[] | undefined, profile: TaskProfile, options: EgressPolicyOptions = {}): { ok: true; hosts: string[] } | { ok: false; reasons: string[] } {
  const own = (options.ownHosts ?? []).map((h) => h.trim().toLowerCase().replace(/\.$/, "")).filter(Boolean);
  const exempt = new Set((options.exemptHosts ?? []).map((h) => h.trim().toLowerCase().replace(/\.$/, "")).filter(Boolean));
  const entries = (list ?? []).map((h) => h.trim().toLowerCase());
  if (!profile.browser) return entries.length === 0 ? { ok: true, hosts: [] } : { ok: false, reasons: [`profile "${profile.id}" has no browser; egressAllow must be empty`] };
  if (entries.length === 0) return { ok: false, reasons: [`profile "${profile.id}" needs at least one allowed destination (egressAllow)`] };
  const reasons: string[] = [];
  if (entries.length > profile.maxEgressHosts) reasons.push(`at most ${profile.maxEgressHosts} destinations`);
  const seen = new Set<string>();
  for (const entry of entries) {
    const suffix = entry.startsWith(".");
    const host = suffix ? entry.slice(1) : entry;
    const labels = host.split(".");
    if (seen.has(entry)) reasons.push(`${entry}: duplicate`);
    seen.add(entry);
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(host)) reasons.push(`${entry}: not a hostname`);
    else if (isIP(host) || labels.every((l) => /^\d+$/.test(l)) || /^\d+$/.test(labels.at(-1) ?? "")) reasons.push(`${entry}: IP literals are not allowed`);
    else if (labels.length < 2) reasons.push(`${entry}: ${suffix ? "a suffix must name a registrable domain, not a top-level domain" : "single-label names are not allowed"}`);
    else if (RESERVED_SUFFIXES.includes(labels.at(-1)!) || host === "home.arpa" || labels.includes("localhost") || host.startsWith("metadata.")) reasons.push(`${entry}: special-use or internal names are not allowed`);
    else if (host.length > 253) reasons.push(`${entry}: too long`);
    else if (own.some((o) => (suffix ? underOrAt(o, host) : o === host))) reasons.push(`${entry}: this Airlock deployment's own host is never a destination`);
    else if (WILDCARD_DNS_SUFFIXES.some((w) => underOrAt(host, w)) && (suffix || !exempt.has(host))) reasons.push(`${entry}: wildcard-DNS names (${WILDCARD_DNS_SUFFIXES.join(", ")}) resolve to any address and are not allowed`);
  }
  return reasons.length ? { ok: false, reasons } : { ok: true, hosts: entries };
}

/** Exact host match, or a `.suffix` entry matching a strict subdomain (the proxy's rule). */
export function hostAllowed(host: string, allow: readonly string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return allow.some((entry) => (entry.startsWith(".") ? h.endsWith(entry) && h.length > entry.length : h === entry));
}

/** The host of an http(s) URL without credentials, or null. */
export function urlHost(raw: string): string | null {
  try {
    const url = new URL(raw);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return null;
    return url.hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** URL identity for "was this source visited": scheme, host, port, path and query; no fragment; a lone trailing slash ignored. */
export function normalizeUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    const path = url.pathname.length > 1 && url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname;
    return `${url.protocol}//${url.host.toLowerCase()}${path}${url.search}`;
  } catch {
    return null;
  }
}
