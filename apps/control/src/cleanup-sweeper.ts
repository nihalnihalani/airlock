/**
 * Cleanup-retry sweep for finished tasks (finding F3, 40 §6).
 *
 * A task can become terminal (done / failed / cancelled) while the teardown of one of its attempts
 * could not be confirmed, typically because the supervisor was unreachable at that moment. The
 * handlers record that honestly as `cleanup.status = "failed"` (or leave `retrying`/`pending` when
 * a cancel pass or a lost lease ended the run), and nothing retried it: the stopped container and
 * volume stayed until the supervisor's janitor removed them after its retention window.
 *
 * This sweep re-runs the same confirmed teardown (journal.ts `teardownAttempt`: revoke → destroy,
 * clean only on the supervisor's say-so, or when the supervisor reports the attempt `destroyed` or
 * unknown) for every attempt identity the task recorded, with exponential backoff:
 *
 *   - while retries are pending, `cleanup` is `retrying` (with the next time and count);
 *   - `confirmed` only once EVERY recorded attempt's teardown is confirmed clean;
 *   - after the configured number of retries it is `failed` with "retries exhausted…" and the
 *     sweep stops touching the task.
 *
 * Every change appends a `lifecycle` event. Only `cleanup` is ever written on the task (by CAS on a
 * terminal, unleased task): status, outcome and result are never touched. Retry counters live in
 * their own store kind so the Task contract is unchanged.
 */
import { randomUUID } from "node:crypto";
import type { AttemptRef, CleanupState, RunEvent, Task } from "@airlock/contracts";
import type { TaskEventBus } from "./events.ts";
import { STORE_KIND_TASK_ATTEMPTS, type TaskAttemptRow } from "./general-handler.ts";
import { STORE_KIND_OPERATIONS, createJournal, teardownAttempt, type OperationRecord, type TeardownOutcome } from "./journal.ts";
import { log } from "./log.ts";
import type { Store } from "./store/index.ts";
import { SupervisorNotFoundError, type SupervisorClient } from "./supervisor-client.ts";
import { backgroundFailure } from "./worker/index.ts";

export const STORE_KIND_CLEANUP_RETRIES = "cleanup-retries";

/** Backoff between retries: 15 s, 1 min, 5 min, then every 15 min. */
export const DEFAULT_CLEANUP_RETRY_DELAYS_MS = [15_000, 60_000, 5 * 60_000, 15 * 60_000];
export const DEFAULT_CLEANUP_RETRIES = 6;

/** Retry bookkeeping for one task (id = task id). */
export interface CleanupRetryRecord {
  id: string;
  taskId: string;
  /** Retries run so far. */
  retries: number;
  /** When the next retry is due; null once the record is settled. */
  nextAt: string | null;
  state: "retrying" | "confirmed" | "exhausted";
  /** Attempts whose teardown this sweep (or the supervisor journal) has confirmed. */
  confirmedAttempts: string[];
  lastDetail?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CleanupSweeperOptions {
  store: Store;
  supervisor: SupervisorClient;
  bus?: TaskEventBus;
  now?: () => number;
  /** Maximum retries before giving up (AIRLOCK_CLEANUP_RETRIES, default 6). */
  maxRetries?: number;
  /** Backoff before retry n (the last entry repeats). */
  delaysMs?: number[];
  /** How often the sweep looks for tasks (default 5 s). */
  pollMs?: number;
}

const TERMINAL = new Set<Task["status"]>(["done", "failed", "cancelled"]);
/** Cleanup states of a terminal task that mean "teardown not confirmed". */
const UNCONFIRMED: CleanupState["status"][] = ["failed", "retrying", "pending"];

export class CleanupSweeper {
  private timer: ReturnType<typeof setInterval> | undefined;
  private sweeping: Promise<void> | null = null;
  private readonly maxRetries: number;
  private readonly delaysMs: number[];

  constructor(private readonly options: CleanupSweeperOptions) {
    this.maxRetries = Math.max(0, options.maxRetries ?? DEFAULT_CLEANUP_RETRIES);
    this.delaysMs = options.delaysMs?.length ? options.delaysMs : DEFAULT_CLEANUP_RETRY_DELAYS_MS;
  }

  private now() {
    return this.options.now?.() ?? Date.now();
  }
  private iso(ms = this.now()) {
    return new Date(ms).toISOString();
  }
  private delayFor(retry: number) {
    return this.delaysMs[Math.min(retry, this.delaysMs.length - 1)]!;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.sweep().catch((error) => backgroundFailure("cleanup sweep", error)), this.options.pollMs ?? 5000);
    void this.sweep().catch((error) => backgroundFailure("initial cleanup sweep", error));
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.sweeping?.catch(() => undefined);
  }

  /** One pass over terminal tasks with unconfirmed cleanup. Serialised: a pass never overlaps another. */
  sweep(): Promise<void> {
    if (this.sweeping) return this.sweeping;
    this.sweeping = this.pass().finally(() => {
      this.sweeping = null;
    });
    return this.sweeping;
  }

  private async pass() {
    for (const status of UNCONFIRMED) {
      const rows = await this.options.store.scanWhere<Task>("tasks", { cleanup: { status } });
      for (const { owner, value: task } of rows) {
        if (!TERMINAL.has(task.status) || task.leaseId !== null) continue;
        try {
          await this.handle(owner, task);
        } catch (error) {
          log.warn("cleanup sweep: task not processed", { taskId: task.id, error });
        }
      }
    }
  }

  private async handle(owner: string, task: Task) {
    const store = this.options.store;
    const existing = await store.get<CleanupRetryRecord>(owner, STORE_KIND_CLEANUP_RETRIES, task.id);
    if (existing && existing.state !== "retrying") return; // settled: exhausted (or confirmed) — never again
    const refs = await this.attemptsOf(owner, task);
    if (refs.length === 0) return; // no recorded attempt identity: nothing this sweep can confirm
    const now = this.now();

    if (!existing) {
      // First sighting: schedule the first retry and say so on the task.
      if (this.maxRetries === 0) return this.exhaust(owner, task, null, refs.map((r) => r.ref.attemptId), task.cleanup?.detail ?? "teardown unconfirmed");
      const nextAt = this.iso(now + this.delayFor(0));
      const record: CleanupRetryRecord = { id: task.id, taskId: task.id, retries: 0, nextAt, state: "retrying", confirmedAttempts: [], ...(task.cleanup?.detail ? { lastDetail: task.cleanup.detail } : {}), createdAt: this.iso(now), updatedAt: this.iso(now) };
      if (!(await store.insertImmutable(owner, STORE_KIND_CLEANUP_RETRIES, record))) return;
      const detail = `teardown unconfirmed for ${refs.length} attempt(s); retry 1 of ${this.maxRetries} at ${nextAt}${task.cleanup?.detail ? ` (${task.cleanup.detail})` : ""}`;
      await this.setCleanup(owner, task, { status: "retrying", at: this.iso(now), detail: detail.slice(0, 1024) }, "Cleanup retry scheduled", detail, { nextAt, retry: 1, of: this.maxRetries });
      return;
    }
    if (existing.nextAt && Date.parse(existing.nextAt) > now) return;

    const retry = existing.retries + 1;
    const confirmed = new Set(existing.confirmedAttempts);
    const failures: string[] = [];
    const results: Record<string, unknown>[] = [];
    for (const { ref, row } of refs) {
      if (confirmed.has(ref.attemptId)) continue;
      const result = await this.teardown(owner, task, ref, row);
      results.push({ attemptId: ref.attemptId, ...(row ? { role: row.role } : {}), clean: result.clean, detail: result.detail.slice(0, 300), ...(result.data ?? {}) });
      if (result.clean) confirmed.add(ref.attemptId);
      else failures.push(`${ref.attemptId}: ${result.detail}`);
    }
    const at = this.iso();
    if (failures.length === 0) {
      await store.put(owner, STORE_KIND_CLEANUP_RETRIES, { ...existing, retries: retry, nextAt: null, state: "confirmed", confirmedAttempts: [...confirmed], updatedAt: at } satisfies CleanupRetryRecord);
      const detail = `supervisor confirmed teardown of ${confirmed.size} attempt(s) on cleanup retry ${retry}`;
      await this.setCleanup(owner, task, { status: "confirmed", at, detail }, "Cleanup confirmed on retry", detail, { retry, attempts: results });
      return;
    }
    const lastDetail = failures.join("; ").slice(0, 900);
    if (retry >= this.maxRetries) return this.exhaust(owner, task, { ...existing, retries: retry, confirmedAttempts: [...confirmed] }, refs.filter((r) => !confirmed.has(r.ref.attemptId)).map((r) => r.ref.attemptId), lastDetail, results);
    const nextAt = this.iso(this.now() + this.delayFor(retry));
    await store.put(owner, STORE_KIND_CLEANUP_RETRIES, { ...existing, retries: retry, nextAt, confirmedAttempts: [...confirmed], lastDetail, updatedAt: at } satisfies CleanupRetryRecord);
    const detail = `cleanup retry ${retry} of ${this.maxRetries} incomplete; next at ${nextAt}: ${lastDetail}`;
    await this.setCleanup(owner, task, { status: "retrying", at, detail: detail.slice(0, 1024) }, "Cleanup retry incomplete", detail, { retry, of: this.maxRetries, nextAt, attempts: results });
  }

  private async exhaust(owner: string, task: Task, record: Pick<CleanupRetryRecord, "retries" | "confirmedAttempts" | "createdAt"> | null, remaining: string[], lastDetail: string, results: Record<string, unknown>[] = []) {
    const at = this.iso();
    const retries = record?.retries ?? 0;
    await this.options.store.put(owner, STORE_KIND_CLEANUP_RETRIES, {
      id: task.id,
      taskId: task.id,
      retries,
      nextAt: null,
      state: "exhausted",
      confirmedAttempts: record?.confirmedAttempts ?? [],
      lastDetail,
      createdAt: record?.createdAt ?? at,
      updatedAt: at,
    } satisfies CleanupRetryRecord);
    const detail = `retries exhausted (${retries} of ${this.maxRetries}); the supervisor janitor or an operator must remove attempt(s) ${remaining.join(", ")}: ${lastDetail}`;
    await this.setCleanup(owner, task, { status: "failed", at, detail: detail.slice(0, 1024) }, "Cleanup retries exhausted", detail, { retries, remaining, attempts: results });
  }

  /** Every attempt identity the task recorded: the task's attemptId, general attempt rows, the operation journal. */
  private async attemptsOf(owner: string, task: Task): Promise<{ ref: AttemptRef; row?: TaskAttemptRow }[]> {
    const store = this.options.store;
    const out = new Map<string, { ref: AttemptRef; row?: TaskAttemptRow }>();
    const destroyedRows = new Set<string>();
    const rows = (await store.scanWhere<TaskAttemptRow>(STORE_KIND_TASK_ATTEMPTS, { taskId: task.id })).filter((r) => r.owner === owner).map((r) => r.value);
    for (const row of rows) {
      if (row.state === "destroyed") destroyedRows.add(row.id);
      else out.set(row.id, { ref: { taskId: task.id, attemptId: row.id, generation: row.generation }, row });
    }
    if (task.attemptId && !destroyedRows.has(task.attemptId) && !out.has(task.attemptId)) out.set(task.attemptId, { ref: { taskId: task.id, attemptId: task.attemptId, generation: task.generation } });
    const ops = (await store.scanWhere<OperationRecord>(STORE_KIND_OPERATIONS, { taskId: task.id })).filter((r) => r.owner === owner).map((r) => r.value);
    for (const op of ops) {
      if (!op.attemptId || op.generation === undefined || destroyedRows.has(op.attemptId) || out.has(op.attemptId)) continue;
      out.set(op.attemptId, { ref: { taskId: task.id, attemptId: op.attemptId, generation: op.generation } });
    }
    return [...out.values()];
  }

  /** Confirmed teardown of one attempt; a general attempt row records the outcome as the handler does. */
  private async teardown(owner: string, task: Task, ref: AttemptRef, row?: TaskAttemptRow): Promise<TeardownOutcome> {
    const { store, supervisor } = this.options;
    try {
      const state = await supervisor.getAttempt(ref.attemptId);
      if (state.status === "destroyed" && state.ref.taskId === task.id) return this.recordRow(owner, row, { clean: true, detail: "attempt already destroyed (supervisor journal status: destroyed)" });
    } catch (error) {
      if (error instanceof SupervisorNotFoundError) return this.recordRow(owner, row, { clean: true, detail: "attempt unknown to supervisor (already destroyed)" });
      // Unreachable or another error: the teardown below is the authoritative attempt.
    }
    let egress: unknown;
    if (row?.role === "browser") {
      try {
        const l = await supervisor.egressLog(ref.attemptId);
        egress = { summary: l.summary, decisions: l.decisions.slice(-50) };
      } catch {
        // best effort, as in the general handler
      }
    }
    const journal = createJournal({ store, owner, taskId: task.id, now: () => this.now(), capacityRetryDelaysMs: [] });
    const result = await teardownAttempt(supervisor, ref, journal).catch((error): TeardownOutcome => ({ clean: false, detail: `teardown error: ${error instanceof Error ? error.message : String(error)}` }));
    return this.recordRow(owner, row, egress !== undefined ? { ...result, data: { ...(result.data ?? {}), egress } } : result);
  }

  private async recordRow(owner: string, row: TaskAttemptRow | undefined, result: TeardownOutcome): Promise<TeardownOutcome> {
    if (row)
      await this.options.store.put(owner, STORE_KIND_TASK_ATTEMPTS, { ...row, state: result.clean ? "destroyed" : "teardown-failed", settledAt: this.iso(), detail: result.detail.slice(0, 500) } satisfies TaskAttemptRow);
    return result;
  }

  /** Writes only `cleanup`, and only while the task is still terminal and unleased; then appends the event. */
  private async setCleanup(owner: string, task: Task, cleanup: CleanupState, title: string, detail: string, data: Record<string, unknown>) {
    const next = await this.options.store.compareAndSwap<Task>(owner, "tasks", task.id, { status: task.status, leaseId: null }, { cleanup });
    if (!next) {
      log.warn("cleanup sweep: task changed underneath; cleanup not recorded", { taskId: task.id });
      return;
    }
    const event = await this.options.store.appendEvent(owner, task.id, {
      id: randomUUID(),
      at: this.iso(),
      kind: "lifecycle" satisfies RunEvent["kind"],
      title,
      detail: detail.slice(0, 65536),
      data: { cleanup: cleanup.status, ...data },
    });
    this.options.bus?.publish(event);
    log.info("cleanup sweep", { taskId: task.id, cleanup: cleanup.status, title });
  }
}
