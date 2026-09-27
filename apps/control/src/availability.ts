/**
 * Repair availability (37 §Build gates, last paragraph): the live repair promise is offered only
 * while a committed live-gate receipt backs it. The receipt must match what is running right now:
 * the profile id and contract digest, the configured model, and the supervisor's selected runtime
 * (never dev-unsafe). Anything else is "diagnosis only", with the precise reason.
 *
 * Receipts are `docs/evidence/live-gate/*.json` (AIRLOCK_LIVE_GATE_EVIDENCE_DIR), written by
 * `scripts/live-gate.ts` and validated here against contracts `LiveGateReceipt`. Only the newest
 * valid receipt counts: a later failing gate withdraws an earlier pass. Files are re-read only
 * when their mtime or size changes, so evaluating on every request is cheap.
 *
 * This module also reads the diagnostic script catalog metadata (`GET /api/diagnostics`).
 */
import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { LiveGateReceipt, type HostCheck, type RepairAvailability } from "@airlock/contracts";
import { log } from "./log.ts";
import type { LoadedProfile } from "./profiles.ts";

export const PINNED_INFERENCE_HOST = "api.vultrinference.com";
/** Gate thresholds (CLAUDE.md §4: 2 of 3 fresh hero attempts pass the external comparator). */
export const GATE_MIN_PASSED = 2;
export const GATE_MIN_TOTAL = 3;
const MAX_RECEIPT_BYTES = 256 * 1024;
const MAX_RECEIPTS = 500;

export const SCRIPTED_REASON = "scripted diagnostics driver: runs are diagnostics, not model repairs";

export interface AvailabilityOptions {
  driver: "vultr" | "scripted";
  /** Configured model id (AIRLOCK_MODEL); compared without the `-normalize` suffix. */
  model: string | null;
  evidenceDir: string;
  /** Receipt paths are reported relative to this directory (never an absolute server path). */
  repoRoot: string;
  /** AIRLOCK_INSTANCE_ID of this control-plane VM, when deployed. */
  controlInstanceId?: string | null;
}

export interface AvailabilityService {
  readonly driver: "vultr" | "scripted";
  evaluate(profile: LoadedProfile, host: HostCheck | null): Promise<RepairAvailability>;
}

type Cached = { mtimeMs: number; size: number; receipt: LiveGateReceipt | null; problem: string | null };

const bareModel = (model: string) => model.trim().replace(/-normalize$/, "");

/** Checks a receipt's internal consistency beyond its schema; returns a problem or null. */
export function receiptProblem(receipt: LiveGateReceipt): string | null {
  if (receipt.attempts.length !== receipt.total) return `total ${receipt.total} but ${receipt.attempts.length} attempts listed`;
  const passing = receipt.attempts.filter((a) => a.outcome === "CANDIDATE_PASSED_CHECKS").length;
  if (passing !== receipt.passed) return `passed ${receipt.passed} but ${passing} attempts are CANDIDATE_PASSED_CHECKS`;
  const ids = new Set(receipt.attempts.map((a) => a.taskId));
  if (ids.size !== receipt.attempts.length) return "an attempt is listed twice";
  for (const a of receipt.attempts) {
    if (a.modelHosts.some((h) => h !== PINNED_INFERENCE_HOST)) return `attempt ${a.taskId} has a model call outside ${PINNED_INFERENCE_HOST}`;
    if (a.outcome === "CANDIDATE_PASSED_CHECKS" && (a.modelCalls === 0 || !a.candidateDigest)) return `passing attempt ${a.taskId} has no model call or no candidate digest`;
  }
  return null;
}

export class RepairAvailabilityService implements AvailabilityService {
  private readonly cache = new Map<string, Cached>();

  constructor(private readonly options: AvailabilityOptions) {}

  get driver() {
    return this.options.driver;
  }

  /** The newest valid receipt in the evidence directory, or why there is none. */
  async newestReceipt(): Promise<{ receipt: LiveGateReceipt; path: string } | { receipt: null; reason: string }> {
    let names: string[];
    try {
      names = (await readdir(this.options.evidenceDir)).filter((n) => n.endsWith(".json") && !n.startsWith(".")).slice(0, MAX_RECEIPTS);
    } catch {
      return { receipt: null, reason: `no live-gate evidence directory (${this.displayPath(this.options.evidenceDir)}); run scripts/live-gate.ts against the deployed stack` };
    }
    let best: { receipt: LiveGateReceipt; path: string } | null = null;
    let invalid = 0;
    const seen = new Set<string>();
    for (const name of names) {
      const path = join(this.options.evidenceDir, name);
      seen.add(path);
      const entry = await this.read(path);
      if (!entry?.receipt) {
        if (entry) invalid++;
        continue;
      }
      if (!best || Date.parse(entry.receipt.recordedAt) > Date.parse(best.receipt.recordedAt)) best = { receipt: entry.receipt, path };
    }
    for (const key of this.cache.keys()) if (!seen.has(key)) this.cache.delete(key);
    if (!best) return { receipt: null, reason: `no valid live-gate receipt in ${this.displayPath(this.options.evidenceDir)}${invalid ? ` (${invalid} invalid file${invalid === 1 ? "" : "s"} ignored)` : ""}` };
    return best;
  }

  async evaluate(profile: LoadedProfile, host: HostCheck | null): Promise<RepairAvailability> {
    const instances = {
      ...(this.options.controlInstanceId ? { control: this.options.controlInstanceId } : {}),
      ...(host?.instanceId ? { execution: host.instanceId } : {}),
    };
    const base = {
      driver: this.options.driver,
      ...(this.options.driver === "vultr" && this.options.model ? { model: this.options.model } : {}),
      ...(host ? { runtime: host.selectedRuntime } : {}),
      ...(Object.keys(instances).length ? { instances } : {}),
    };
    const unavailable = (reason: string, evidence?: RepairAvailability["evidence"]): RepairAvailability => ({ available: false, reason: reason.slice(0, 1024), ...base, ...(evidence ? { evidence } : {}) });
    if (this.options.driver === "scripted") return unavailable(SCRIPTED_REASON);
    if (!this.options.model) return unavailable("no model configured (AIRLOCK_MODEL)");

    const newest = await this.newestReceipt();
    if (!newest.receipt) return unavailable(newest.reason);
    const { receipt, path } = newest;
    const evidence: NonNullable<RepairAvailability["evidence"]> = {
      path: this.displayPath(path),
      passed: receipt.passed,
      attempts: receipt.total,
      revision: receipt.revision,
      recordedAt: receipt.recordedAt,
      model: receipt.model,
      runtime: receipt.runtime,
      profileId: receipt.profileId,
      contractDigest: receipt.contractDigest,
    };
    if (receipt.profileId !== profile.manifest.id) return unavailable(`newest live-gate receipt is for profile ${receipt.profileId}, not ${profile.manifest.id}`, evidence);
    if (receipt.contractDigest !== profile.contractDigest) return unavailable(`newest live-gate receipt was measured under contract ${receipt.contractDigest.slice(0, 12)}; the running contract is ${profile.contractDigest.slice(0, 12)}`, evidence);
    if (bareModel(receipt.model) !== bareModel(this.options.model)) return unavailable(`newest live-gate receipt is for model ${receipt.model}; the configured model is ${this.options.model}`, evidence);
    if (!host) return unavailable("supervisor unreachable: the running sandbox runtime cannot be checked against the live-gate receipt", evidence);
    if (host.devUnsafe) return unavailable(`supervisor runs ${host.selectedRuntime} with AIRLOCK_DEV_UNSAFE: no live-gate receipt covers a dev-unsafe runtime`, evidence);
    if (receipt.runtime !== host.selectedRuntime) return unavailable(`newest live-gate receipt was measured on ${receipt.runtime}; the supervisor now selects ${host.selectedRuntime}`, evidence);
    if (receipt.runtimeImageId && host.runtimeImageId && receipt.runtimeImageId !== host.runtimeImageId)
      return unavailable(`newest live-gate receipt was measured on runtime image ${receipt.runtimeImageId}; the supervisor now enforces ${host.runtimeImageId}`, evidence);
    if (receipt.total < GATE_MIN_TOTAL || receipt.passed < GATE_MIN_PASSED)
      return unavailable(`newest live-gate receipt passed ${receipt.passed} of ${receipt.total}; the gate needs at least ${GATE_MIN_PASSED} of ${GATE_MIN_TOTAL} fresh attempts`, evidence);
    return { available: true, reason: `live gate passed ${receipt.passed} of ${receipt.total} on ${receipt.runtime} with ${receipt.model} (${receipt.recordedAt})`, ...base, evidence };
  }

  private displayPath(path: string): string {
    const rel = relative(this.options.repoRoot, path);
    if (rel && !rel.startsWith("..") && !rel.startsWith(sep)) return rel.split(sep).join("/");
    return path.split(sep).slice(-2).join("/");
  }

  private async read(path: string): Promise<Cached | null> {
    let info;
    try {
      info = await stat(path);
    } catch {
      return null;
    }
    if (!info.isFile()) return null;
    const cached = this.cache.get(path);
    if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached;
    let entry: Cached;
    if (info.size > MAX_RECEIPT_BYTES) entry = { mtimeMs: info.mtimeMs, size: info.size, receipt: null, problem: "too large" };
    else {
      try {
        const parsed = LiveGateReceipt.parse(JSON.parse(await readFile(path, "utf8")));
        const problem = receiptProblem(parsed);
        entry = { mtimeMs: info.mtimeMs, size: info.size, receipt: problem ? null : parsed, problem };
      } catch (error) {
        entry = { mtimeMs: info.mtimeMs, size: info.size, receipt: null, problem: error instanceof Error ? error.message.slice(0, 300) : "unreadable" };
      }
    }
    if (entry.problem) log.warn("live-gate receipt ignored", { path: this.displayPath(path), problem: entry.problem });
    this.cache.set(path, entry);
    return entry;
  }
}

// ---- diagnostic script catalog metadata ----------------------------------------------------------

export interface DiagnosticScript {
  name: string;
  title: string;
  description: string;
}

/**
 * Titles and descriptions for the named scripts under `dir`: a script file's own `title` /
 * `description` strings when present, else the name and its `_comment`. Never the turns.
 */
export async function describeDiagnostics(dir: string, names: string[]): Promise<DiagnosticScript[]> {
  const out: DiagnosticScript[] = [];
  for (const name of names) {
    let title = name;
    let description = "";
    try {
      const raw = JSON.parse(await readFile(join(dir, `${name}.json`), "utf8")) as Record<string, unknown>;
      if (raw && !Array.isArray(raw)) {
        if (typeof raw.title === "string" && raw.title.trim()) title = raw.title.trim().slice(0, 120);
        if (typeof raw.description === "string") description = raw.description.trim().slice(0, 600);
        else if (typeof raw._comment === "string") description = raw._comment.trim().slice(0, 600);
      }
    } catch {
      // A single-file catalog or an unreadable file keeps the name only.
    }
    out.push({ name, title, description });
  }
  return out;
}
