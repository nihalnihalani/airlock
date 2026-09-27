/**
 * Exclusive browser control (40 Stage 5; audit 42 C22–C24), in process on VM A.
 *
 * One `Channel` per general task whose run is live in this process: the general handler attaches
 * its browser executor (the only code that talks to the task's browser attempt, journaled through
 * the supervisor) and every browser operation — the agent's, a human holder's, a live-view frame,
 * the controller's approved submission — runs through one per-task lock, so two operations never
 * overlap and the supervisor sees one serial stream.
 *
 * Handover:
 *   agent ──take──▶ transferring ──(in-flight op settled within settleTimeoutMs)──▶ human
 *                        │ not settled: take fails 409, stays transferring (never dual control);
 *                        │ a retried take or a release resolves it; idle expiry returns it to agent
 *   human ──release / idle expiry (no action for idleMs) / run ended──▶ agent
 *
 * While the holder is not "agent" the agent's next browser op waits (bounded by the caller's
 * deadline, the task's wall clock keeps running) and does not dispatch. Every grant of human
 * control bumps `epoch`; the handler refuses a ref-bound agent action until the agent has observed
 * under the current epoch ("control returned; observe first"). A human action is never an
 * approval: final actions go through proposals (proposals.ts) whatever a human clicks.
 *
 * `Task.control` is the durable record of the state for the UI; this service writes it with a
 * field-level update (the worker's checkpoints never touch `control`). The in-memory channel is
 * the gate. A control plane restart ends the run; the next run starts with the agent in control.
 * A stored non-agent holder that no channel of this process holds is from a previous process: it
 * is reset to the agent at start (`recoverAtStart`) and on read (`reconcileStored`), so the API
 * never reports a human holder the current process does not know about (C41 O1).
 */
import { randomBytes } from "node:crypto";
import type { BrowserAnyOp, BrowserOpResult, ControlState, Task } from "@airlock/contracts";
import type { TaskEventBus } from "./events.ts";
import { log } from "./log.ts";
import type { Store } from "./store/index.ts";

export type Actor = "agent" | "human" | "observer" | "controller";

export type BrowserExecOutcome =
  | { ok: true; op: string; result: unknown; raw: BrowserOpResult; attemptId: string; operationId?: string; artifactId?: string }
  | { ok: false; error: string; payload: Record<string, unknown>; raw?: BrowserOpResult };

export interface BrowserExecutor {
  /** One op on the task's browser attempt. `create: false` refuses when no browser session is live. */
  exec(request: BrowserAnyOp, opts: { actor: Actor; tool: string; create: boolean; humanOwner?: string; humanRole?: string }): Promise<BrowserExecOutcome>;
  hasLiveBrowser(): boolean;
}

/** The reason recorded when a stale holder from a previous control-plane process is reset. */
export const RESTART_CONTROL_REASON = "control plane restarted; control returned to the agent";

export class ControlError extends Error {
  constructor(
    message: string,
    readonly status: 404 | 409 | 410 | 422 | 429,
  ) {
    super(message);
    this.name = "ControlError";
  }
}

interface Channel {
  taskId: string;
  owner: string;
  executor: BrowserExecutor;
  holder: ControlState["holder"];
  humanOwner?: string | undefined;
  since: string;
  fenceGeneration?: number | undefined;
  reason?: string | undefined;
  epoch: number;
  generation: number | null;
  tail: Promise<void>;
  inFlight: number;
  wakers: Set<() => void>;
  lastHumanAt: number;
  idleTimer?: ReturnType<typeof setTimeout> | undefined;
  taking: boolean;
  lastRefreshAt: number;
}

export interface ControlServiceOptions {
  store: Store;
  bus?: TaskEventBus;
  /** How long a take waits for the in-flight operation to settle (default 10 s). */
  settleTimeoutMs?: number;
  /** Human control returns to the agent after this long without a human action (default 5 min). */
  idleMs?: number;
  /** Minimum interval between live-view refreshes per task (default 2 s). */
  refreshMinIntervalMs?: number;
  /** Poll interval of a waiting agent op (a release wakes it sooner). */
  pollMs?: number;
  now?: () => number;
}

export class ControlService {
  private readonly channels = new Map<string, Channel>();
  private readonly notifyWakers = new Map<string, Set<() => void>>();
  readonly settleTimeoutMs: number;
  readonly idleMs: number;
  readonly refreshMinIntervalMs: number;
  private readonly pollMs: number;

  constructor(private readonly options: ControlServiceOptions) {
    this.settleTimeoutMs = options.settleTimeoutMs ?? 10_000;
    this.idleMs = options.idleMs ?? 5 * 60_000;
    this.refreshMinIntervalMs = options.refreshMinIntervalMs ?? 2000;
    this.pollMs = options.pollMs ?? 250;
  }

  private now() {
    return this.options.now?.() ?? Date.now();
  }
  private iso() {
    return new Date(this.now()).toISOString();
  }

  // ---- lifecycle (handler) -------------------------------------------------------------------

  /** Called by the general handler when its run starts; returns the detach function. */
  async attach(owner: string, taskId: string, executor: BrowserExecutor): Promise<() => Promise<void>> {
    const previous = this.channels.get(taskId);
    if (previous) this.clearIdle(previous);
    const ch: Channel = { taskId, owner, executor, holder: "agent", since: this.iso(), epoch: 0, generation: null, tail: Promise.resolve(), inFlight: 0, wakers: new Set(), lastHumanAt: 0, taking: false, lastRefreshAt: 0 };
    this.channels.set(taskId, ch);
    const stored = await this.options.store.get<Task>(owner, "tasks", taskId);
    if (stored?.control && stored.control.holder !== "agent") {
      await this.persist(ch, { holder: "agent", since: ch.since, reason: "the task's run restarted; the agent holds control" });
      await this.event(ch, "Control returned to the agent", `the previous holder (${stored.control.holder}) lost control when the run restarted`, { control: { holder: "agent" } });
    }
    return async () => {
      if (this.channels.get(taskId) !== ch) return;
      this.channels.delete(taskId);
      this.clearIdle(ch);
      if (ch.holder !== "agent") {
        ch.holder = "agent";
        await this.persist(ch, { holder: "agent", since: this.iso(), reason: "the task's run ended" }).catch((error) => log.warn("control reset failed", { taskId, error }));
      }
      this.wake(ch);
    };
  }

  /**
   * C41 O1: a stored holder other than the agent that no live channel of this process holds was
   * written by a previous control-plane process (channels are in memory only; a detach in this
   * process already resets it). Reset it to the agent with an event. The swap is conditioned on the
   * stored holder and `since`, so a take that started in this process after the read is never
   * clobbered. Returns the task as it is now stored.
   */
  async reconcileStored(owner: string, task: Task): Promise<Task> {
    const stale = task.control;
    if (!stale || stale.holder === "agent" || this.channels.has(task.id)) return task;
    const control: ControlState = { holder: "agent", since: this.iso(), reason: RESTART_CONTROL_REASON };
    const updated = await this.options.store.compareAndSwap<Task>(owner, "tasks", task.id, { id: task.id, control: { holder: stale.holder, since: stale.since } }, { control, updatedAt: this.iso() });
    if (!updated) return (await this.options.store.get<Task>(owner, "tasks", task.id)) ?? task;
    await this.recordEvent(owner, task.id, "Control returned to the agent", `${RESTART_CONTROL_REASON} (the previous holder, ${stale.holder}${stale.humanOwner ? ` ${stale.humanOwner}` : ""}, belonged to a control-plane process that no longer runs); the agent must observe the page before any ref-bound action`, { control, previous: { holder: stale.holder, since: stale.since } });
    return updated;
  }

  /** C41 O1: at control-plane start, reset every stored non-agent holder (none is live yet). */
  async recoverAtStart(): Promise<number> {
    let reset = 0;
    for (const { owner, value } of await this.options.store.scan<Task>("tasks")) {
      if (!value.control || value.control.holder === "agent") continue;
      const after = await this.reconcileStored(owner, value);
      if (after.control?.reason === RESTART_CONTROL_REASON && after.control.holder === "agent") reset += 1;
    }
    return reset;
  }

  isAttached(taskId: string): boolean {
    return this.channels.has(taskId);
  }
  state(taskId: string): (ControlState & { epoch: number; attached: boolean; liveBrowser: boolean; idleExpiresAt?: string }) | null {
    const ch = this.channels.get(taskId);
    if (!ch) return null;
    return {
      holder: ch.holder,
      ...(ch.humanOwner ? { humanOwner: ch.humanOwner } : {}),
      since: ch.since,
      ...(ch.fenceGeneration !== undefined ? { fenceGeneration: ch.fenceGeneration } : {}),
      ...(ch.reason ? { reason: ch.reason } : {}),
      epoch: ch.epoch,
      attached: true,
      liveBrowser: ch.executor.hasLiveBrowser(),
      ...(ch.holder === "human" ? { idleExpiresAt: new Date(ch.lastHumanAt + this.idleMs).toISOString() } : {}),
    };
  }
  holderOf(taskId: string): ControlState["holder"] {
    return this.channels.get(taskId)?.holder ?? "agent";
  }
  epochOf(taskId: string): number {
    return this.channels.get(taskId)?.epoch ?? 0;
  }
  generationOf(taskId: string): number | null {
    return this.channels.get(taskId)?.generation ?? null;
  }
  noteGeneration(taskId: string, generation: unknown) {
    const ch = this.channels.get(taskId);
    if (ch && typeof generation === "number" && Number.isInteger(generation) && generation >= 0) ch.generation = generation;
  }

  // ---- the agent's side ------------------------------------------------------------------------

  /**
   * Runs `fn` under the task's browser lock while the agent holds control. When a human holds (or
   * is taking) control, waits — bounded by `deadlineMs`, checking `guard` (cancellation, lease) —
   * and reports `paused`. Never dispatches while the holder is not the agent.
   */
  async runAgent<T>(taskId: string, fn: () => Promise<T>, wait: { deadlineMs: number; guard: () => Promise<void>; onPaused?: (holder: ControlState["holder"]) => Promise<void> }): Promise<{ ran: true; value: T; paused: boolean } | { ran: false; paused: true; reason: string }> {
    const ch = this.channels.get(taskId);
    if (!ch) return { ran: true, value: await fn(), paused: false };
    let paused = false;
    for (;;) {
      if (ch.holder !== "agent") {
        if (!paused) {
          paused = true;
          await wait.onPaused?.(ch.holder);
        }
        const left = wait.deadlineMs - this.now();
        if (left <= 0) return { ran: false, paused: true, reason: ch.holder === "human" ? "a person holds control of this task's browser" : "browser control is being handed over" };
        await wait.guard();
        await this.sleep(ch, Math.min(this.pollMs, left));
        continue;
      }
      const out = await this.lock(ch, async () => (ch.holder === "agent" ? { value: await fn() } : null));
      if (out) return { ran: true, value: out.value, paused };
    }
  }

  // ---- the human's side (API) ----------------------------------------------------------------

  async take(taskId: string, by: { owner: string; role: string }): Promise<ControlState> {
    const ch = this.channels.get(taskId);
    if (!ch) throw new ControlError("the task's browser loop is not running in this control plane; control can be taken only while the task runs", 409);
    if (ch.holder === "human") {
      if (ch.humanOwner === by.owner) return this.public(ch);
      throw new ControlError("another session holds control of this task's browser", 409);
    }
    if (ch.taking) throw new ControlError("a control handover is already in progress", 409);
    ch.taking = true;
    try {
      ch.holder = "transferring";
      ch.humanOwner = undefined;
      ch.since = this.iso();
      ch.reason = `requested by ${by.role}`;
      this.clearIdle(ch);
      await this.persist(ch, this.public(ch));
      await this.event(ch, "Human control requested", `agent dispatch revoked; waiting up to ${Math.round(this.settleTimeoutMs / 1000)} s for the in-flight browser operation to settle`, { control: this.public(ch) });
      const settled = await this.settle(ch);
      if (!settled) {
        ch.reason = "the in-flight browser operation did not settle; control stays with nobody until it is released or retried";
        await this.persist(ch, this.public(ch));
        await this.event(ch, "Control handover failed", `the in-flight browser operation did not settle within ${Math.round(this.settleTimeoutMs / 1000)} s; the take was refused (no simultaneous control)`, { control: this.public(ch) });
        this.armIdle(ch);
        throw new ControlError("the in-flight browser operation did not settle in time; control was not granted (retry, or release to return it to the agent)", 409);
      }
      if (this.channels.get(taskId) !== ch) throw new ControlError("the task's run ended during the handover; control was not granted", 409);
      ch.holder = "human";
      ch.humanOwner = by.owner;
      ch.epoch += 1;
      ch.since = this.iso();
      ch.lastHumanAt = this.now();
      ch.fenceGeneration = ch.generation ?? undefined;
      ch.reason = `taken by ${by.role}`;
      await this.persist(ch, this.public(ch));
      await this.event(ch, "Human took control", `the agent is paused; every earlier page snapshot is invalid after release${ch.fenceGeneration !== undefined ? ` (fence generation ${ch.fenceGeneration})` : ""}; control returns after ${Math.round(this.idleMs / 1000)} s without an action`, { control: this.public(ch) });
      this.armIdle(ch);
      return this.public(ch);
    } finally {
      ch.taking = false;
    }
  }

  async release(taskId: string, by: { owner: string; role: string }, reason = "released"): Promise<ControlState> {
    const ch = this.channels.get(taskId);
    if (!ch) throw new ControlError("the task's browser loop is not running", 409);
    if (ch.holder === "agent") return this.public(ch);
    if (ch.taking) throw new ControlError("a control handover is in progress", 409);
    if (ch.holder === "human" && ch.humanOwner !== by.owner && by.role !== "operator") throw new ControlError("another session holds control of this task's browser", 409);
    await this.toAgent(ch, `${reason} by ${by.role}`);
    return this.public(ch);
  }

  /** One human browser action (the caller must hold control); serialized with every other op. */
  async humanAction(taskId: string, by: { owner: string; role?: string }, request: BrowserAnyOp, tool: string): Promise<BrowserExecOutcome> {
    const ch = this.channels.get(taskId);
    const holds = () => ch !== undefined && ch.holder === "human" && ch.humanOwner === by.owner;
    if (!ch || !holds()) throw new ControlError("you do not hold control of this task's browser (take control first)", 409);
    ch.lastHumanAt = this.now();
    this.armIdle(ch);
    const out = await this.lock(ch, async () => (holds() ? await ch.executor.exec(request, { actor: "human", tool, create: true, humanOwner: by.owner, ...(by.role ? { humanRole: by.role } : {}) }) : null));
    if (!out) throw new ControlError("control changed before the action ran; nothing was done", 409);
    ch.lastHumanAt = this.now();
    this.armIdle(ch);
    return out;
  }

  /**
   * A read-only live-view frame: allowed whoever holds control, serialized with the other ops,
   * rate limited per task, never starts a browser session.
   */
  async liveRefresh(taskId: string): Promise<BrowserExecOutcome> {
    const ch = this.channels.get(taskId);
    if (!ch) throw new ControlError("the task's browser loop is not running", 409);
    if (!ch.executor.hasLiveBrowser()) throw new ControlError("the task has no live browser session", 409);
    const at = this.now();
    if (at - ch.lastRefreshAt < this.refreshMinIntervalMs) throw new ControlError(`live view refresh is limited to one per ${this.refreshMinIntervalMs} ms per task`, 429);
    ch.lastRefreshAt = at;
    return this.lock(ch, () => ch.executor.exec({ op: "screenshot" }, { actor: "observer", tool: "live_view", create: false }));
  }

  // ---- proposal wake-ups -----------------------------------------------------------------------

  notify(taskId: string) {
    for (const w of this.notifyWakers.get(taskId) ?? []) w();
  }
  waitNotify(taskId: string, ms: number): Promise<void> {
    return new Promise((resolve) => {
      const set = this.notifyWakers.get(taskId) ?? new Set<() => void>();
      this.notifyWakers.set(taskId, set);
      const done = () => {
        clearTimeout(timer);
        set.delete(done);
        if (set.size === 0) this.notifyWakers.delete(taskId);
        resolve();
      };
      const timer = setTimeout(done, Math.max(1, ms));
      set.add(done);
    });
  }

  // ---- internals ---------------------------------------------------------------------------------

  private public(ch: Channel): ControlState {
    return {
      holder: ch.holder,
      ...(ch.holder === "human" && ch.humanOwner ? { humanOwner: ch.humanOwner } : {}),
      since: ch.since,
      ...(ch.fenceGeneration !== undefined ? { fenceGeneration: ch.fenceGeneration } : {}),
      ...(ch.reason ? { reason: ch.reason.slice(0, 512) } : {}),
    };
  }

  private async toAgent(ch: Channel, reason: string) {
    this.clearIdle(ch);
    ch.holder = "agent";
    ch.humanOwner = undefined;
    ch.since = this.iso();
    ch.fenceGeneration = ch.generation ?? undefined;
    ch.reason = reason.slice(0, 512);
    await this.persist(ch, this.public(ch));
    await this.event(ch, "Control returned to the agent", `${reason}; the agent must observe the page before any ref-bound action`, { control: this.public(ch) });
    this.wake(ch);
  }

  private async lock<T>(ch: Channel, fn: () => Promise<T>): Promise<T> {
    const previous = ch.tail;
    let release!: () => void;
    const mine = new Promise<void>((resolve) => (release = resolve));
    ch.tail = previous.then(() => mine);
    await previous;
    ch.inFlight += 1;
    try {
      return await fn();
    } finally {
      ch.inFlight -= 1;
      release();
    }
  }

  /** Wait for everything queued on the lock so far to finish, bounded. */
  private async settle(ch: Channel): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settled = await Promise.race([ch.tail.then(() => true), new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), this.settleTimeoutMs)))]);
    if (timer) clearTimeout(timer);
    return settled;
  }

  private sleep(ch: Channel, ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        ch.wakers.delete(done);
        resolve();
      };
      const timer = setTimeout(done, Math.max(1, ms));
      ch.wakers.add(done);
    });
  }
  private wake(ch: Channel) {
    for (const w of [...ch.wakers]) w();
  }

  private clearIdle(ch: Channel) {
    if (ch.idleTimer) clearTimeout(ch.idleTimer);
    ch.idleTimer = undefined;
  }
  private armIdle(ch: Channel) {
    this.clearIdle(ch);
    const due = ch.holder === "human" ? ch.lastHumanAt + this.idleMs - this.now() : this.idleMs;
    const timer = setTimeout(() => {
      if (this.channels.get(ch.taskId) !== ch) return;
      if (ch.holder === "human") {
        if (this.now() - ch.lastHumanAt >= this.idleMs) void this.toAgent(ch, `idle timeout: no human action for ${Math.round(this.idleMs / 1000)} s`).catch((error) => log.warn("control idle expiry failed", { taskId: ch.taskId, error }));
        else this.armIdle(ch);
      } else if (ch.holder === "transferring" && !ch.taking) {
        void this.toAgent(ch, "control handover abandoned").catch((error) => log.warn("control expiry failed", { taskId: ch.taskId, error }));
      }
    }, Math.max(1, due));
    (timer as { unref?: () => void }).unref?.();
    ch.idleTimer = timer;
  }

  private async persist(ch: Channel, control: ControlState) {
    await this.options.store.compareAndSwap<Task>(ch.owner, "tasks", ch.taskId, { id: ch.taskId }, { control, updatedAt: this.iso() });
  }

  private async event(ch: Channel, title: string, detail: string, data: Record<string, unknown>) {
    await this.recordEvent(ch.owner, ch.taskId, title, detail, data);
  }

  private async recordEvent(owner: string, taskId: string, title: string, detail: string, data: Record<string, unknown>) {
    try {
      const event = await this.options.store.appendEvent(owner, taskId, { id: `evt-${randomBytes(8).toString("hex")}`, at: this.iso(), kind: "lifecycle", title, detail, data });
      this.options.bus?.publish(event);
    } catch (error) {
      log.warn("control event not recorded", { taskId, error });
    }
  }
}
