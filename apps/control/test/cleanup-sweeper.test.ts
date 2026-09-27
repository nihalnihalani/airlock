import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AttemptRef, Task } from "@airlock/contracts";
import { CleanupSweeper, STORE_KIND_CLEANUP_RETRIES, type CleanupRetryRecord } from "../src/cleanup-sweeper.ts";
import { STORE_KIND_TASK_ATTEMPTS, type TaskAttemptRow } from "../src/general-handler.ts";
import { SupervisorUnavailableError } from "../src/supervisor-client.ts";
import { FX_FIXED_SOURCE, fixtureObserve, makeFixture, scriptedDriverDouble, type Fixture, type ScriptedTurn } from "./helpers/doubles.ts";
import { FakeSupervisor } from "./helpers/fake-supervisor.ts";
import { makeGeneralHarness, OWNER as GENERAL_OWNER, recordingDriver } from "./helpers/general.ts";
import { makeHarness, OWNER } from "./helpers/harness.ts";
import { HERO_HOST, HERO_PAGES, HERO_TURNS, heroExec } from "./helpers/hero.ts";

let fixture: Fixture;
beforeAll(async () => {
  fixture = await makeFixture();
});
afterAll(async () => {
  await fixture.cleanup();
});

const repairScript = (content: string): ScriptedTurn[] => [
  { toolCalls: [{ name: "read_file", args: { path: "lib/mod.py" } }] },
  { toolCalls: [{ name: "write_file", args: { path: "lib/mod.py", content } }] },
  { toolCalls: [{ name: "submit_candidate", args: { summary: "handle zero" } }] },
];

/** The supervisor becomes unreachable for revoke/destroy/getAttempt while `outage` is set. */
class OutageSupervisor extends FakeSupervisor {
  outage = false;
  private unavailable() {
    return new SupervisorUnavailableError("Supervisor call failed after retries (outage)");
  }
  override async revoke(input: { ref: AttemptRef }) {
    if (this.outage) throw this.unavailable();
    return super.revoke(input);
  }
  override async destroy(input: { ref: AttemptRef }) {
    if (this.outage) throw this.unavailable();
    return super.destroy(input);
  }
  override async getAttempt(attemptId: string) {
    if (this.outage) throw this.unavailable();
    return super.getAttempt(attemptId);
  }
}

/** A repair task whose author-sandbox teardown hits a supervisor outage: it ends with cleanup `failed`. */
async function repairWithOutage() {
  let supervisor!: OutageSupervisor;
  supervisor = new OutageSupervisor({
    profile: fixture.profile,
    observe: fixtureObserve,
    // The supervisor goes away right after the candidate is frozen, before its teardown.
    onDispatch: (kind) => {
      if (kind === "freeze") supervisor.outage = true;
    },
  });
  const h = await makeHarness(fixture, supervisor, scriptedDriverDouble(repairScript(FX_FIXED_SOURCE)));
  h.worker.start();
  const task = await h.newTask();
  const finished = await h.waitFor(task.id);
  await h.worker.stop();
  return { h, supervisor, finished };
}

function sweeperFor(store: ConstructorParameters<typeof CleanupSweeper>[0]["store"], supervisor: FakeSupervisor, maxRetries: number) {
  const clock = { t: Date.now() };
  const sweeper = new CleanupSweeper({ store, supervisor, now: () => clock.t, maxRetries, delaysMs: [15_000, 60_000, 300_000, 900_000] });
  return { sweeper, clock };
}

const titles = async (h: { store: { listEvents(id: string, after?: number, limit?: number): Promise<{ title: string }[]> } }, id: string) => (await h.store.listEvents(id, 0, 5000)).map((e) => e.title);

describe("cleanup sweep (F3)", () => {
  test("teardown fails while the supervisor is down; after it recovers the sweep confirms cleanup without touching status or outcome", async () => {
    const { h, supervisor, finished } = await repairWithOutage();
    try {
      expect(TERMINAL(finished.status)).toBe(true);
      expect(finished.cleanup?.status).toBe("failed");
      const attemptId = finished.attemptId!;
      expect(attemptId).toBeDefined();
      expect(supervisor.attempts.has(attemptId)).toBe(true);

      const { sweeper, clock } = sweeperFor(h.store, supervisor, 6);
      await sweeper.sweep();
      let task = (await h.store.get<Task>(OWNER, "tasks", finished.id))!;
      expect(task.cleanup?.status).toBe("retrying");
      expect(await titles(h, task.id)).toContain("Cleanup retry scheduled");

      // Not due yet: nothing is sent.
      const opsBefore = supervisor.operations.length;
      await sweeper.sweep();
      expect(supervisor.operations.length).toBe(opsBefore);

      // Due, supervisor still down: incomplete, rescheduled with backoff.
      clock.t += 15_000;
      await sweeper.sweep();
      task = (await h.store.get<Task>(OWNER, "tasks", finished.id))!;
      expect(task.cleanup?.status).toBe("retrying");
      expect(task.cleanup?.detail).toMatch(/retry 1 of 6 incomplete/);
      let record = (await h.store.get<CleanupRetryRecord>(OWNER, STORE_KIND_CLEANUP_RETRIES, task.id))!;
      expect(record.retries).toBe(1);
      expect(Date.parse(record.nextAt!)).toBe(clock.t + 60_000);

      // The supervisor recovers; the next due retry revokes → destroys and confirms.
      supervisor.outage = false;
      clock.t += 30_000;
      await sweeper.sweep();
      expect(supervisor.destroyed).not.toContain(attemptId); // not due yet
      clock.t += 30_000;
      await sweeper.sweep();
      expect(supervisor.destroyed).toContain(attemptId);
      expect(supervisor.attempts.has(attemptId)).toBe(false);
      task = (await h.store.get<Task>(OWNER, "tasks", finished.id))!;
      expect(task.cleanup?.status).toBe("confirmed");
      expect(task.status).toBe(finished.status);
      expect(task.outcome).toBe(finished.outcome);
      expect(task.phase).toBe(finished.phase);
      record = (await h.store.get<CleanupRetryRecord>(OWNER, STORE_KIND_CLEANUP_RETRIES, task.id))!;
      expect(record.state).toBe("confirmed");
      const events = await titles(h, task.id);
      expect(events).toContain("Cleanup retry incomplete");
      expect(events).toContain("Cleanup confirmed on retry");

      // Confirmed: never retried again.
      const count = events.length;
      const ops = supervisor.operations.length;
      clock.t += 3_600_000;
      await sweeper.sweep();
      expect((await titles(h, task.id)).length).toBe(count);
      expect(supervisor.operations.length).toBe(ops);
    } finally {
      await h.close();
    }
  });

  test("retries are bounded: after exhaustion cleanup stays `failed` with a janitor/operator note and the sweep stops", async () => {
    const { h, supervisor, finished } = await repairWithOutage();
    try {
      const { sweeper, clock } = sweeperFor(h.store, supervisor, 2);
      await sweeper.sweep(); // scheduled
      clock.t += 15_000;
      await sweeper.sweep(); // retry 1 incomplete
      clock.t += 60_000;
      await sweeper.sweep(); // retry 2 incomplete → exhausted
      const task = (await h.store.get<Task>(OWNER, "tasks", finished.id))!;
      expect(task.cleanup?.status).toBe("failed");
      expect(task.cleanup?.detail).toMatch(/^retries exhausted/);
      expect(task.cleanup?.detail).toMatch(/supervisor janitor or an operator must remove/);
      expect(task.cleanup?.detail).toContain(finished.attemptId!);
      expect(task.status).toBe(finished.status);
      expect(task.outcome).toBe(finished.outcome);
      const record = (await h.store.get<CleanupRetryRecord>(OWNER, STORE_KIND_CLEANUP_RETRIES, task.id))!;
      expect(record.state).toBe("exhausted");
      expect(record.retries).toBe(2);
      const events = await titles(h, task.id);
      expect(events.filter((t) => t === "Cleanup retry incomplete").length).toBe(1);
      expect(events).toContain("Cleanup retries exhausted");

      // Even once the supervisor is back, an exhausted task is left alone.
      supervisor.outage = false;
      const ops = supervisor.operations.length;
      clock.t += 24 * 3_600_000;
      await sweeper.sweep();
      expect(supervisor.operations.length).toBe(ops);
      expect((await titles(h, task.id)).length).toBe(events.length);
      expect((await h.store.get<Task>(OWNER, "tasks", finished.id))!.cleanup?.status).toBe("failed");
    } finally {
      await h.close();
    }
  });

  test("a task whose cleanup is already confirmed is never retried", async () => {
    const supervisor = new FakeSupervisor({ profile: fixture.profile, observe: fixtureObserve });
    const h = await makeHarness(fixture, supervisor, scriptedDriverDouble(repairScript(FX_FIXED_SOURCE)));
    h.worker.start();
    try {
      const task = await h.newTask();
      const finished = await h.waitFor(task.id);
      await h.worker.stop();
      expect(finished.cleanup?.status).toBe("confirmed");
      const { sweeper, clock } = sweeperFor(h.store, supervisor, 6);
      const count = (await titles(h, task.id)).length;
      const ops = supervisor.operations.length;
      for (let i = 0; i < 3; i++) {
        await sweeper.sweep();
        clock.t += 3_600_000;
      }
      expect(supervisor.operations.length).toBe(ops);
      expect((await titles(h, task.id)).length).toBe(count);
      expect(await h.store.get(OWNER, STORE_KIND_CLEANUP_RETRIES, task.id)).toBeNull();
    } finally {
      await h.close();
    }
  });

  test("general task: both the browser and the code attempt are retried, and cleanup is confirmed only when both are clean", async () => {
    let failDestroy = true;
    let failCode = true;
    const supervisor = new FakeSupervisor({ profile: fixture.profile, observe: fixtureObserve, pages: HERO_PAGES, exec: heroExec, destroyFails: (a) => (a.role === "browser" ? failDestroy : failCode) });
    const h = await makeGeneralHarness(fixture, supervisor, recordingDriver(HERO_TURNS));
    try {
      const task = await h.newTask({ egressAllow: [HERO_HOST] });
      h.worker.start();
      const finished = await h.waitFor(task.id);
      await h.worker.stop();
      expect(TERMINAL(finished.status)).toBe(true);
      expect(finished.cleanup?.status).toBe("failed");
      const rows = async () => (await h.store.scanWhere<TaskAttemptRow>(STORE_KIND_TASK_ATTEMPTS, { taskId: task.id })).map((r) => r.value);
      expect((await rows()).map((r) => r.role).sort()).toEqual(["analysis", "browser"]);
      expect((await rows()).every((r) => r.state === "teardown-failed")).toBe(true);
      expect(supervisor.attempts.size).toBe(2);

      const { sweeper, clock } = sweeperFor(h.store, supervisor, 6);
      await sweeper.sweep();
      // Only the code sandbox can be removed at first: still retrying, not confirmed.
      failCode = false;
      clock.t += 15_000;
      await sweeper.sweep();
      let t = (await h.store.get<Task>(GENERAL_OWNER, "tasks", task.id))!;
      expect(t.cleanup?.status).toBe("retrying");
      expect((await rows()).find((r) => r.role === "analysis")!.state).toBe("destroyed");
      expect((await rows()).find((r) => r.role === "browser")!.state).toBe("teardown-failed");
      expect(supervisor.attempts.size).toBe(1);

      failDestroy = false;
      clock.t += 60_000;
      await sweeper.sweep();
      t = (await h.store.get<Task>(GENERAL_OWNER, "tasks", task.id))!;
      expect(t.cleanup?.status).toBe("confirmed");
      expect(t.cleanup?.detail).toMatch(/2 attempt\(s\)/);
      expect(t.status).toBe(finished.status);
      expect(t.outcome).toBe(finished.outcome);
      expect((await rows()).every((r) => r.state === "destroyed")).toBe(true);
      expect(supervisor.attempts.size).toBe(0);
      const events = (await h.events(task.id)).map((e) => e.title);
      expect(events).toContain("Cleanup confirmed on retry");
    } finally {
      await h.close();
    }
  });
});

function TERMINAL(status: Task["status"]) {
  return status === "done" || status === "failed" || status === "cancelled";
}
