/**
 * Repair availability (37 §Build gates, last paragraph): the live repair promise is offered only
 * while a committed live-gate receipt backs it. The receipt must match what is running right now:
 * the profile id and contract digest, the configured model, and the supervisor's selected runtime
 * (never dev-unsafe). Anything else is "diagnosis only", with the precise reason.
 *
 * Receipts are `docs/evidence/live-gate/*.json` (AIRLOCK_LIVE_GATE_EVIDENCE_DIR), written by
 * `scripts/live-gate.ts` and validated here against contracts `LiveGateReceipt`. Only the newest
 * receipt counts: a later failing gate withdraws an earlier pass, and a later file that is invalid
 * (bad schema, inconsistent, dated in the future) is never silently skipped in favour of an older
 * pass. A receipt backs repair only for the exact runtime image id and adapter digest it was
 * measured under, and its passes are counted from this control plane's own task records, never
 * from the receipt's claims. Files are re-read only when their mtime or size changes.
 *
 * This module also reads the diagnostic script catalog metadata (`GET /api/diagnostics`).
 */
import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { LiveGateReceipt, type HostCheck, type RepairAvailability, type Task } from "@airlock/contracts";
import { log } from "./log.ts";
import type { LoadedProfile } from "./profiles.ts";

export const PINNED_INFERENCE_HOST = "api.vultrinference.com";
/** Gate thresholds (CLAUDE.md §4: 2 of 3 fresh hero attempts pass the external comparator). */
export const GATE_MIN_PASSED = 2;
export const GATE_MIN_TOTAL = 3;
const MAX_RECEIPT_BYTES = 256 * 1024;
const MAX_RECEIPTS = 500;
/** A receipt dated further than this into the future is refused (clock skew allowance). */
export const RECEIPT_FUTURE_SKEW_MS = 5 * 60_000;
const STORE_KIND_TASKS = "tasks";

/** The task lookup availability needs (a Store satisfies it). */
export interface TaskLookup {
  scanWhere<T>(kind: string, where: Record<string, unknown>): Promise<{ owner: string; value: T }[]>;
}

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
  /** The adapter digest that would run now (computeAdapterDigest). Absent: no receipt can be bound (fail closed). */
  adapterDigestOf?: (profile: LoadedProfile) => Promise<string>;
  /** This control plane's task records: every attempt a receipt lists must be one of them. Absent: fail closed. */
  tasks?: TaskLookup;
  now?: () => number;
}

export interface AvailabilityService {
  readonly driver: "vultr" | "scripted";
  evaluate(profile: LoadedProfile, host: HostCheck | null): Promise<RepairAvailability>;
}

type Cached = { mtimeMs: number; size: number; receipt: LiveGateReceipt | null; problem: string | null; recordedAtMs: number | null };
type Newest = { receipt: LiveGateReceipt; path: string } | { receipt: null; reason: string; path?: string };

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

  /**
   * The newest receipt in the evidence directory, or why none counts. The newest valid receipt is
   * chosen by `recordedAt` (never one dated in the future); any invalid file that is newer than it
   * (by its own `recordedAt` when it has a readable one, else by file mtime) makes the answer
   * "none": a broken newer receipt is not skipped in favour of an older pass.
   */
  async newestReceipt(): Promise<Newest> {
    let names: string[];
    try {
      names = (await readdir(this.options.evidenceDir)).filter((n) => n.endsWith(".json") && !n.startsWith(".")).sort().slice(0, MAX_RECEIPTS);
    } catch {
      return { receipt: null, reason: `no live-gate evidence directory (${this.displayPath(this.options.evidenceDir)}); run scripts/live-gate.ts against the deployed stack` };
    }
    const nowMs = this.options.now?.() ?? Date.now();
    let best: { receipt: LiveGateReceipt; path: string; mtimeMs: number } | null = null;
    const invalid: { path: string; problem: string; recordedAtMs: number | null; mtimeMs: number }[] = [];
    const seen = new Set<string>();
    for (const name of names) {
      const path = join(this.options.evidenceDir, name);
      seen.add(path);
      const entry = await this.read(path);
      if (!entry) continue;
      if (entry.receipt && Date.parse(entry.receipt.recordedAt) > nowMs + RECEIPT_FUTURE_SKEW_MS) {
        invalid.push({ path, problem: `recordedAt ${entry.receipt.recordedAt} is in the future`, recordedAtMs: null, mtimeMs: entry.mtimeMs });
        continue;
      }
      if (!entry.receipt) {
        invalid.push({ path, problem: entry.problem ?? "invalid", recordedAtMs: entry.recordedAtMs !== null && entry.recordedAtMs <= nowMs + RECEIPT_FUTURE_SKEW_MS ? entry.recordedAtMs : null, mtimeMs: entry.mtimeMs });
        continue;
      }
      const at = Date.parse(entry.receipt.recordedAt);
      if (!best || at > Date.parse(best.receipt.recordedAt) || (at === Date.parse(best.receipt.recordedAt) && entry.mtimeMs > best.mtimeMs)) best = { receipt: entry.receipt, path, mtimeMs: entry.mtimeMs };
    }
    for (const key of this.cache.keys()) if (!seen.has(key)) this.cache.delete(key);
    if (!best) return { receipt: null, reason: `no valid live-gate receipt in ${this.displayPath(this.options.evidenceDir)}${invalid.length ? ` (${invalid.length} invalid file${invalid.length === 1 ? "" : "s"} ignored)` : ""}` };
    const bestAt = Date.parse(best.receipt.recordedAt);
    const newer = invalid.find((i) => (i.recordedAtMs !== null ? i.recordedAtMs > bestAt : i.mtimeMs > best.mtimeMs));
    if (newer)
      return {
        receipt: null,
        path: newer.path,
        reason: `the newest live-gate receipt ${this.displayPath(newer.path)} is invalid (${newer.problem.slice(0, 300)}); an older receipt is not used in its place`,
      };
    return { receipt: best.receipt, path: best.path };
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
    if (!host.runtimeImageId) return unavailable("the supervisor reports no enforced runtime image id; a live-gate receipt is bound to one", evidence);
    if (receipt.runtimeImageId !== host.runtimeImageId)
      return unavailable(`newest live-gate receipt was measured on runtime image ${receipt.runtimeImageId}; the supervisor now enforces ${host.runtimeImageId}`, evidence);
    if (!this.options.adapterDigestOf) return unavailable("the running adapter digest is not known to repair availability; no receipt can be bound to it", evidence);
    let adapterDigest: string;
    try {
      adapterDigest = await this.options.adapterDigestOf(profile);
    } catch (error) {
      return unavailable(`the running adapter cannot be read (${error instanceof Error ? error.message.slice(0, 200) : "unknown"})`, evidence);
    }
    if (receipt.adapterDigest !== adapterDigest)
      return unavailable(`newest live-gate receipt was measured under adapter ${receipt.adapterDigest.slice(0, 12)}; the running adapter is ${adapterDigest.slice(0, 12)}`, evidence);
    if (receipt.total < GATE_MIN_TOTAL || receipt.passed < GATE_MIN_PASSED)
      return unavailable(`newest live-gate receipt passed ${receipt.passed} of ${receipt.total}; the gate needs at least ${GATE_MIN_PASSED} of ${GATE_MIN_TOTAL} fresh attempts`, evidence);
    // The receipt's pass count is a claim; this control plane's own task records are the evidence.
    const confirmed = await this.confirmedPasses(receipt);
    if ("problem" in confirmed) return unavailable(`newest live-gate receipt does not match this control plane's task records: ${confirmed.problem}`, evidence);
    if (confirmed.passed < GATE_MIN_PASSED)
      return unavailable(`newest live-gate receipt claims ${receipt.passed} of ${receipt.total}, but the task records confirm ${confirmed.passed} passing attempt${confirmed.passed === 1 ? "" : "s"}; the gate needs at least ${GATE_MIN_PASSED} of ${GATE_MIN_TOTAL}`, evidence);
    return { available: true, reason: `live gate passed ${confirmed.passed} of ${receipt.total} on ${receipt.runtime} with ${receipt.model} (${receipt.recordedAt})`, ...base, evidence: { ...evidence, passed: confirmed.passed } };
  }

  /**
   * Every attempt the receipt lists must be a live-gate task in this store (not a diagnostic), and
   * a pass counts only when that task is done with CANDIDATE_PASSED_CHECKS for the listed digest.
   */
  private async confirmedPasses(receipt: LiveGateReceipt): Promise<{ passed: number } | { problem: string }> {
    if (!this.options.tasks) return { problem: "no task store is available to confirm the attempts" };
    let passed = 0;
    for (const attempt of receipt.attempts) {
      let task: Task | undefined;
      try {
        task = (await this.options.tasks.scanWhere<Task>(STORE_KIND_TASKS, { id: attempt.taskId })).find((r) => r.value.id === attempt.taskId)?.value;
      } catch (error) {
        return { problem: `task lookup failed (${error instanceof Error ? error.message.slice(0, 200) : "unknown"})` };
      }
      if (!task) return { problem: `attempt ${attempt.taskId} is not a task of this control plane` };
      if (task.liveGate !== true || task.scriptedDriver !== undefined) return { problem: `attempt ${attempt.taskId} is not a live-gate task` };
      if (task.profileId !== receipt.profileId) return { problem: `attempt ${attempt.taskId} ran profile ${task.profileId}` };
      if (attempt.outcome === "CANDIDATE_PASSED_CHECKS" && task.status === "done" && task.outcome === "CANDIDATE_PASSED_CHECKS" && !!attempt.candidateDigest && task.candidateDigest === attempt.candidateDigest) passed++;
    }
    return { passed };
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
    if (info.size > MAX_RECEIPT_BYTES) entry = { mtimeMs: info.mtimeMs, size: info.size, receipt: null, problem: "too large", recordedAtMs: null };
    else {
      let raw: unknown = null;
      try {
        raw = JSON.parse(await readFile(path, "utf8"));
        const parsed = LiveGateReceipt.parse(raw);
        const problem = receiptProblem(parsed);
        entry = { mtimeMs: info.mtimeMs, size: info.size, receipt: problem ? null : parsed, problem, recordedAtMs: Date.parse(parsed.recordedAt) };
      } catch (error) {
        // An invalid file still sorts by its own recordedAt when it states a readable one.
        const at = raw && typeof raw === "object" && typeof (raw as { recordedAt?: unknown }).recordedAt === "string" ? Date.parse((raw as { recordedAt: string }).recordedAt) : Number.NaN;
        entry = { mtimeMs: info.mtimeMs, size: info.size, receipt: null, problem: error instanceof Error ? error.message.slice(0, 300) : "unreadable", recordedAtMs: Number.isFinite(at) ? at : null };
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
