import { describe, expect, test } from "bun:test";
import type { Task } from "@airlock/contracts";
import { TaskEventBus } from "../src/events.ts";
import { createStore } from "../src/store/index.ts";
import { LostLeaseError, TaskWorker, splitPatch, type TaskHandler } from "../src/worker/index.ts";

const OWNER = "operator";
function task(id: string, overrides: Partial<Task> = {}): Task {
  const at = new Date().toISOString();
  return { id, owner: OWNER, profileId: "fx-1", issueText: "x", status: "queued", phase: "prepare", generation: 0, leaseId: null, leaseUntil: null, attempts: 0, budget: { modelCallsUsed: 0, repairAttemptsUsed: 0 }, createdAt: at, updatedAt: at, ...overrides };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("task worker", () => {
  test("claims queued tasks with a lease, runs the handler, records events with monotonic seq, releases the lease", async () => {
    const store = await createStore();
    const bus = new TaskEventBus();
    const published: number[] = [];
    bus.subscribe("t1", (e) => published.push(e.seq));
    const handler: TaskHandler = async (_owner, t, ctx) => {
      expect(ctx.mode).toBe("run");
      expect(t.status).toBe("running");
      expect(t.leaseId).not.toBeNull();
      await ctx.event("phase", "prepare");
      await ctx.checkpoint({ phase: "baseline", attemptId: "att-1" });
      await ctx.event("phase", "baseline");
      await ctx.checkpoint({ attemptId: undefined } as Partial<Task>);
      return { status: "done", phase: "ready", outcome: "NOT_REPRODUCED" };
    };
    const worker = new TaskWorker(store, handler, { pollMs: 10, leaseMs: 500, bus });
    await store.put(OWNER, "tasks", task("t1"));
    worker.start();
    try {
      let final: Task | null = null;
      for (let i = 0; i < 200 && final?.status !== "done"; i++) {
        await sleep(10);
        final = await store.get<Task>(OWNER, "tasks", "t1");
      }
      expect(final?.status).toBe("done");
      expect(final?.outcome).toBe("NOT_REPRODUCED");
      expect(final?.leaseId).toBeNull();
      expect(final?.attempts).toBe(1);
      expect("attemptId" in (final ?? {})).toBe(false);
      const events = await store.listEvents("t1");
      expect(events.map((e) => e.seq)).toEqual([1, 2]);
      expect(published).toEqual([1, 2]);
    } finally {
      await worker.stop();
      await store.close();
    }
  });

  test("a handler failure marks the task failed with the error and an error event", async () => {
    const store = await createStore();
    const worker = new TaskWorker(store, async () => { throw new Error("sandbox exploded"); }, { pollMs: 10, leaseMs: 500 });
    await store.put(OWNER, "tasks", task("t2"));
    worker.start();
    try {
      let final: Task | null = null;
      for (let i = 0; i < 200 && final?.status !== "failed"; i++) {
        await sleep(10);
        final = await store.get<Task>(OWNER, "tasks", "t2");
      }
      expect(final?.status).toBe("failed");
      expect(final?.error).toBe("sandbox exploded");
      expect((await store.listEvents("t2")).at(-1)?.kind).toBe("error");
    } finally {
      await worker.stop();
      await store.close();
    }
  });

  test("guard throws LostLeaseError once the API moves the task to cancelling; the cancel path then runs and ends cancelled", async () => {
    const store = await createStore();
    const modes: string[] = [];
    let release: (() => void) | null = null;
    const started = new Promise<void>((r) => { release = r; });
    const handler: TaskHandler = async (_owner, t, ctx) => {
      modes.push(ctx.mode);
      if (ctx.mode === "cancel") {
        expect(t.status).toBe("cancelling");
        await ctx.event("lifecycle", "teardown done");
        return { status: "cancelled" };
      }
      release?.();
      for (let i = 0; i < 500; i++) {
        await sleep(10);
        await ctx.guard();
      }
      throw new Error("guard never fired");
    };
    const worker = new TaskWorker(store, handler, { pollMs: 10, leaseMs: 500 });
    await store.put(OWNER, "tasks", task("t3"));
    worker.start();
    try {
      await started;
      const moved = await store.compareAndSwap<Task>(OWNER, "tasks", "t3", { status: "running" }, { status: "cancelling" });
      expect(moved?.status).toBe("cancelling");
      let final: Task | null = null;
      for (let i = 0; i < 300 && final?.status !== "cancelled"; i++) {
        await sleep(10);
        final = await store.get<Task>(OWNER, "tasks", "t3");
      }
      expect(final?.status).toBe("cancelled");
      expect(modes).toEqual(["run", "cancel"]);
      expect(final?.leaseId).toBeNull();
    } finally {
      await worker.stop();
      await store.close();
    }
  });

  test("a running task with an expired lease is reclaimed; a live lease is not", async () => {
    const store = await createStore();
    const seen: string[] = [];
    const worker = new TaskWorker(store, async (_o, t) => { seen.push(t.id); return { status: "done" }; }, { pollMs: 10, leaseMs: 500 });
    await store.put(OWNER, "tasks", task("expired", { status: "running", leaseId: "old", leaseUntil: new Date(Date.now() - 1000).toISOString() }));
    await store.put(OWNER, "tasks", task("live", { status: "running", leaseId: "other", leaseUntil: new Date(Date.now() + 60_000).toISOString() }));
    await store.put(OWNER, "tasks", task("finished", { status: "done" }));
    worker.start();
    try {
      await sleep(150);
      expect(seen).toEqual(["expired"]);
      expect((await store.get<Task>(OWNER, "tasks", "live"))?.leaseId).toBe("other");
    } finally {
      await worker.stop();
      await store.close();
    }
  });

  test("stop() aborts active runs and requeues them", async () => {
    const store = await createStore();
    const worker = new TaskWorker(store, async (_o, _t, ctx) => {
      await new Promise<void>((_resolve, reject) => ctx.signal.addEventListener("abort", () => reject(new LostLeaseError()), { once: true }));
      return {};
    }, { pollMs: 10, leaseMs: 500 });
    await store.put(OWNER, "tasks", task("t5"));
    worker.start();
    try {
      await sleep(80);
      expect(worker.isActive("t5")).toBe(true);
    } finally {
      await worker.stop();
    }
    const final = await store.get<Task>(OWNER, "tasks", "t5");
    expect(final?.status).toBe("queued");
    expect(final?.leaseId).toBeNull();
    await store.close();
  });

  test("splitPatch separates undefined keys for removal", () => {
    expect(splitPatch({ a: 1, b: undefined, c: null })).toEqual({ set: { a: 1, c: null }, unset: ["b"] });
  });
});
