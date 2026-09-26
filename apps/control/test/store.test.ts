import { describe, expect, test } from "bun:test";
import { createStore } from "../src/store/index.ts";

describe("store", () => {
  test("insertImmutable returns false on duplicate and leaves the original untouched", async () => {
    const store = await createStore();
    try {
      expect(await store.insertImmutable("o", "verifications", { id: "v1", passed: true })).toBe(true);
      expect(await store.insertImmutable("o", "verifications", { id: "v1", passed: false })).toBe(false);
      expect(await store.get<{ id: string; passed: boolean }>("o", "verifications", "v1")).toEqual({ id: "v1", passed: true });
    } finally {
      await store.close();
    }
  });

  test("appendEvent assigns a monotonic per-task seq and listEvents replays after a seq", async () => {
    const store = await createStore();
    try {
      const mk = (i: number) => ({
        id: `e${i}`,
        at: new Date().toISOString(),
        kind: "info" as const,
        title: `t${i}`,
        detail: "",
      });
      const a = await Promise.all([1, 2, 3, 4, 5].map((i) => store.appendEvent("o", "task-a", mk(i))));
      const b = await store.appendEvent("o", "task-b", mk(9));
      const seqs = a.map((e) => e.seq).sort((x, y) => x - y);
      expect(seqs).toEqual([1, 2, 3, 4, 5]);
      expect(b.seq).toBe(1);
      expect(b.taskId).toBe("task-b");
      const replay = await store.listEvents("task-a", 3);
      expect(replay.map((e) => e.seq)).toEqual([4, 5]);
      expect((await store.listEvents("task-a")).length).toBe(5);
    } finally {
      await store.close();
    }
  });

  test("compareAndSwap only applies when expected matches", async () => {
    const store = await createStore();
    try {
      await store.put("o", "tasks", { id: "t", status: "queued", leaseId: null });
      expect(await store.compareAndSwap("o", "tasks", "t", { status: "running" }, { status: "done" })).toBeNull();
      const next = await store.compareAndSwap<{ status: string }>("o", "tasks", "t", { status: "queued", leaseId: null }, { status: "running", leaseId: "L" });
      expect(next?.status).toBe("running");
      expect(await store.scanWhere("tasks", { status: "running" })).toHaveLength(1);
      expect(await store.scanWhere("tasks", { status: "queued" })).toHaveLength(0);
    } finally {
      await store.close();
    }
  });
});
