/**
 * Airlock TaskWorker: durable lease/CAS orchestration.
 *
 * Adapted from OpenMuse `apps/server/src/engine/worker.ts` at 205cc386b75aae1a862f3fdd43104b570c8d0911.
 * MIT License, Copyright (c) 2026 OpenMuse contributors. https://github.com/CopilotKit/openmuse
 *
 * Modifications for Airlock:
 *  - Typed to the contracts `Task` / `TaskStatus` (queued|running|cancelling|cancelled|done|failed);
 *    `scheduled`, `waiting_approval` and the action-expiry branch are removed.
 *  - A task in `cancelling` is claimed only to run the cancellation path: the handler is invoked with
 *    `context.mode === "cancel"` while the status stays `cancelling` (the UI never sees `running`
 *    again). A lost lease on a `cancelling` task releases the lease so the next tick retries teardown.
 *  - Events go through `Store.appendEvent` (append-only, per-task seq) and an in-process bus.
 *  - Worker status/run bookkeeping records are kept under owner "system".
 *  - `LostLeaseError` semantics are unchanged.
 */
import { randomUUID } from "node:crypto";
import type { RunEvent, Task } from "@airlock/contracts";
import type { Store } from "../store/index.ts";
import type { TaskEventBus } from "../events.ts";
import { log } from "../log.ts";

export class LostLeaseError extends Error {
  constructor() {
    super("Task was cancelled, expired or taken over by another worker");
    this.name = "LostLeaseError";
  }
}

/**
 * Thrown by the cancel-mode handler when revoke/destroy could not be confirmed. The worker keeps the
 * task in `cancelling` and retries the teardown on a later tick (bounded); it never records
 * `cancelled` on the strength of a DB write alone (CLAUDE.md §3.5).
 */
export class TeardownIncompleteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TeardownIncompleteError";
  }
}

export type WorkerMode = "run" | "cancel";

export interface TaskContext {
  /** "run" for queued/expired-lease tasks, "cancel" for tasks in `cancelling`. */
  mode: WorkerMode;
  signal: AbortSignal;
  /** Throws LostLeaseError when this worker no longer owns the task. Call between steps. */
  guard(): Promise<void>;
  /** CAS patch under the current lease. Throws LostLeaseError when the lease is gone. */
  checkpoint(patch: Partial<Task>): Promise<Task>;
  /** Append a RunEvent (bounded by the caller). Guarded. */
  event(kind: RunEvent["kind"], title: string, detail?: string, data?: Record<string, unknown>): Promise<void>;
}

export type TaskHandler = (owner: string, task: Task, context: TaskContext) => Promise<Partial<Task>>;

export function backgroundFailure(phase: string, error: unknown) {
  const rawCode = error instanceof Error && "code" in error ? (error as Error & { code?: unknown }).code : undefined;
  const code = typeof rawCode === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(rawCode) ? rawCode : undefined;
  log.error("background operation failed", { phase, error: error instanceof Error ? error : "Background operation failed", ...(code ? { code } : {}) });
}

const EVENT_TITLE_MAX = 256;
const EVENT_DETAIL_MAX = 65536;

export class TaskWorker {
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking = false;
  private stopping = false;
  private active = new Map<string, AbortController>();
  lastTickAt?: string;

  constructor(
    private readonly db: Store,
    private readonly execute: TaskHandler,
    private readonly options: {
      now?: () => number;
      leaseMs?: number;
      pollMs?: number;
      concurrency?: number;
      /** Cancel passes retried after an unconfirmed teardown before the task is recorded `failed` (default 5). */
      cancelRetries?: number;
      /** Wait before re-claiming a `cancelling` task whose teardown was not confirmed (default 5 s). */
      cancelRetryDelayMs?: number;
      bus?: TaskEventBus;
      settled?: (owner: string, task: Task) => Promise<void>;
    } = {},
  ) {}

  private now() {
    return this.options.now?.() ?? Date.now();
  }
  get running() {
    return Boolean(this.timer);
  }
  get activeCount() {
    return this.active.size;
  }

  start() {
    if (this.timer) return;
    this.stopping = false;
    this.timer = setInterval(() => {
      // Timer callbacks cannot await runs; each run owns its durable error state.
      void this.tick().catch((error) => backgroundFailure("task worker tick", error));
    }, this.options.pollMs ?? 1000);
    void this.tick().catch((error) => backgroundFailure("initial task worker tick", error));
  }

  async stop() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const controller of this.active.values()) controller.abort();
    while (this.active.size || this.ticking) await new Promise((r) => setTimeout(r, 10));
  }

  /** Abort the in-process run of a task (used by the cancel route). The durable state change is separate. */
  abort(taskId: string) {
    this.active.get(taskId)?.abort();
  }
  isActive(taskId: string) {
    return this.active.has(taskId);
  }

  async tick() {
    if (this.stopping) return;
    if (this.running)
      await this.db.put("system", "worker-status", { id: "tasks", lastTickAt: new Date(this.now()).toISOString() });
    if (this.ticking) return;
    this.ticking = true;
    this.lastTickAt = new Date(this.now()).toISOString();
    try {
      const now = this.now();
      // A released task (leaseId null) may still carry a `leaseUntil` in the future: a retry-after
      // set by an unconfirmed cancel teardown. It is not due until then.
      const leaseExpired = (t: Task) => (t.leaseId === null ? t.leaseUntil === null || Date.parse(t.leaseUntil) <= now : Date.parse(t.leaseUntil ?? "") <= now);
      const candidates = [
        ...(await this.db.scanWhere<Task>("tasks", { status: "queued" })),
        ...(await this.db.scanWhere<Task>("tasks", { status: "running" })),
        ...(await this.db.scanWhere<Task>("tasks", { status: "cancelling" })),
      ];
      const due = candidates.filter(
        ({ value: t }) =>
          !this.active.has(t.id) &&
          (t.status === "queued" ||
            (t.status === "running" && leaseExpired(t)) ||
            (t.status === "cancelling" && leaseExpired(t))),
      );
      const limit = Math.max(1, (this.options.concurrency ?? 3) - this.active.size);
      const eligible = due.slice(0, limit);
      await Promise.all(eligible.map(({ owner, value }) => this.run(owner, value)));
    } finally {
      this.ticking = false;
    }
  }

  private async run(owner: string, previous: Task) {
    if (this.stopping) return;
    const leaseId = randomUUID();
    const leaseMs = this.options.leaseMs ?? 60000;
    const mode: WorkerMode = previous.status === "cancelling" ? "cancel" : "run";
    const claimedStatus: Task["status"] = mode === "cancel" ? "cancelling" : "running";
    const expected: Record<string, unknown> = { status: previous.status, leaseId: previous.leaseId ?? null };
    if (previous.status !== "queued") expected.leaseUntil = previous.leaseUntil;
    let task = await this.db.compareAndSwap<Task>(owner, "tasks", previous.id, expected, {
      status: claimedStatus,
      leaseId,
      leaseUntil: new Date(this.now() + leaseMs).toISOString(),
      updatedAt: new Date(this.now()).toISOString(),
      attempts: previous.attempts + 1,
    });
    if (!task) {
      log.debug("worker: claim lost the race", { taskId: previous.id, status: previous.status });
      return;
    }
    const controller = new AbortController();
    this.active.set(task.id, controller);
    const taskId = task.id;
    const claimedAt = this.now();
    log.debug("worker: lease claimed", { taskId, leaseId, mode, attempt: task.attempts, leaseMs, active: this.active.size });

    const guard = async () => {
      const latest = await this.db.get<Task>(owner, "tasks", taskId);
      if (controller.signal.aborted || latest?.leaseId !== leaseId || latest.status !== claimedStatus)
        throw new LostLeaseError();
    };
    const checkpoint = async (patch: Partial<Task>) => {
      if (controller.signal.aborted) throw new LostLeaseError();
      const { set, unset } = splitPatch(patch as Record<string, unknown>);
      const next = await this.db.compareAndSwap<Task>(
        owner,
        "tasks",
        taskId,
        { leaseId, status: claimedStatus },
        { ...set, updatedAt: new Date(this.now()).toISOString() },
        unset,
      );
      if (!next) throw new LostLeaseError();
      task = next;
      return next;
    };
    const event = async (kind: RunEvent["kind"], title: string, detail = "", data?: Record<string, unknown>) => {
      await guard();
      await this.appendEvent(owner, taskId, kind, title, detail, data);
    };

    const startedAt = new Date(this.now()).toISOString();
    const heartbeat = setInterval(
      () => {
        void this.db
          .compareAndSwap(
            owner,
            "tasks",
            taskId,
            { leaseId, status: claimedStatus },
            { leaseUntil: new Date(this.now() + leaseMs).toISOString() },
          )
          .then((value) => {
            if (!value) {
              log.warn("worker: heartbeat lost the lease; aborting the run", { taskId, leaseId });
              controller.abort();
            }
          })
          .catch((error) => {
            log.warn("worker: heartbeat failed; aborting the run", { taskId, leaseId, error });
            controller.abort();
          });
      },
      Math.max(10, Math.floor(leaseMs / 3)),
    );

    try {
      await this.db.put("system", "runs", { id: leaseId, taskId, owner, mode, startedAt, status: "running" });
      const result = await this.execute(owner, task, { mode, signal: controller.signal, guard, checkpoint, event });
      await checkpoint({ ...result, leaseId: null, leaseUntil: null } as Partial<Task>);
      log.debug("worker: lease released", { taskId, leaseId, mode, status: result.status ?? task.status, outcome: result.outcome ?? null, durationMs: this.now() - claimedAt });
      await this.db.put("system", "runs", {
        id: leaseId,
        taskId,
        owner,
        mode,
        startedAt,
        finishedAt: new Date(this.now()).toISOString(),
        status: result.status ?? task.status,
      });
    } catch (error) {
      if (error instanceof LostLeaseError || controller.signal.aborted) {
        log.debug("worker: lease lost or run aborted; releasing", { taskId, leaseId, mode, aborted: controller.signal.aborted, durationMs: this.now() - claimedAt });
        // Lost the lease while running: requeue so a fresh claim resumes (the handler discards any
        // uncertain workspace). Lost the lease while cancelling: release so the next tick retries.
        const released =
          (await this.db.compareAndSwap(
            owner,
            "tasks",
            taskId,
            { leaseId, status: "running" },
            { status: "queued", leaseId: null, leaseUntil: null, updatedAt: new Date(this.now()).toISOString() },
          )) ??
          (await this.db.compareAndSwap(
            owner,
            "tasks",
            taskId,
            { leaseId, status: "cancelling" },
            { leaseId: null, leaseUntil: null, updatedAt: new Date(this.now()).toISOString() },
          ));
        if (!released) {
          // Someone else already moved the task (e.g. running → cancelling by the API). Nothing to undo.
        }
      } else if (mode === "cancel" && error instanceof TeardownIncompleteError) {
        log.warn("worker: cancel pass could not confirm teardown", { taskId, leaseId, error });
        // Revoke/destroy not confirmed: the sandbox may still be running. Stay in `cancelling`,
        // release the lease with a retry-after so a later tick tries again, bounded by the number
        // of cancel passes recorded durably in `runs`. Past the bound the task is `failed` (an
        // honest record of an unconfirmed teardown), never `cancelled`, and keeps its attemptId.
        const passes = (await this.db.scanWhere<{ taskId: string; mode: WorkerMode }>("runs", { taskId, mode: "cancel" })).length;
        const retries = Math.max(0, this.options.cancelRetries ?? 5);
        if (passes <= retries) {
          const retryAt = new Date(this.now() + (this.options.cancelRetryDelayMs ?? 5000)).toISOString();
          await this.appendEvent(owner, taskId, "lifecycle", "Teardown will be retried", `${error.message} (cancel pass ${passes} of ${retries + 1}; next at ${retryAt})`).catch((e) =>
            backgroundFailure("record teardown retry", e),
          );
          await this.db.compareAndSwap(
            owner,
            "tasks",
            taskId,
            { leaseId, status: "cancelling" },
            { leaseId: null, leaseUntil: retryAt, updatedAt: new Date(this.now()).toISOString() },
          );
        } else {
          const detail = `${error.message} (teardown still unconfirmed after ${passes} cancel passes; the attempt stays recorded)`;
          await this.appendEvent(owner, taskId, "error", "Task failed", detail).catch((e) => backgroundFailure("record task error", e));
          await this.db.compareAndSwap(
            owner,
            "tasks",
            taskId,
            { leaseId, status: "cancelling" },
            { status: "failed", error: detail.slice(0, 2000), leaseId: null, leaseUntil: null, updatedAt: new Date(this.now()).toISOString() },
          );
        }
      } else {
        const detail = error instanceof Error ? error.message : "Task execution failed";
        log.error("worker: task failed", { taskId, leaseId, mode, error, durationMs: this.now() - claimedAt });
        await this.appendEvent(owner, taskId, "error", "Task failed", detail).catch((e) =>
          backgroundFailure("record task error", e),
        );
        await this.db.compareAndSwap(
          owner,
          "tasks",
          taskId,
          { leaseId, status: claimedStatus },
          {
            status: mode === "cancel" ? "cancelled" : "failed",
            error: detail.slice(0, 2000),
            leaseId: null,
            leaseUntil: null,
            updatedAt: new Date(this.now()).toISOString(),
          },
        );
      }
      await this.db.compareAndSwap(
        "system",
        "runs",
        leaseId,
        { status: "running" },
        { status: controller.signal.aborted ? "interrupted" : "failed", finishedAt: new Date(this.now()).toISOString() },
      );
    } finally {
      clearInterval(heartbeat);
      this.active.delete(taskId);
    }
    const settled = await this.db.get<Task>(owner, "tasks", taskId);
    if (settled && this.options.settled) await this.options.settled(owner, settled);
  }

  private async appendEvent(
    owner: string,
    taskId: string,
    kind: RunEvent["kind"],
    title: string,
    detail: string,
    data?: Record<string, unknown>,
  ) {
    const event = await this.db.appendEvent(owner, taskId, {
      id: randomUUID(),
      at: new Date(this.now()).toISOString(),
      kind,
      title: title.slice(0, EVENT_TITLE_MAX),
      detail: detail.slice(0, EVENT_DETAIL_MAX),
      ...(data ? { data } : {}),
    });
    this.options.bus?.publish(event);
  }
}

/** Split a patch into JSON-carriable values and keys whose `undefined` value means "remove". */
export function splitPatch(patch: Record<string, unknown>): { set: Record<string, unknown>; unset: string[] } {
  const set: Record<string, unknown> = {};
  const unset: string[] = [];
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) unset.push(key);
    else set[key] = value;
  }
  return { set, unset };
}
