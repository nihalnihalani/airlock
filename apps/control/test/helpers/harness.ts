import type { Task } from "@airlock/contracts";
import { TaskEventBus } from "../../src/events.ts";
import { createRepairHandler, type ModelDriver } from "../../src/repair-handler.ts";
import { createStore, type Store } from "../../src/store/index.ts";
import { TaskWorker } from "../../src/worker/index.ts";
import { buildManifestDouble, compareDouble, MemoryArtifactStore, validateEnvelopeDouble, type Fixture } from "./doubles.ts";
import type { FakeSupervisor } from "./fake-supervisor.ts";

export interface Harness {
  store: Store;
  worker: TaskWorker;
  bus: TaskEventBus;
  artifacts: MemoryArtifactStore;
  settled: Map<string, Task>;
  waitFor: (taskId: string, timeoutMs?: number) => Promise<Task>;
  waitUntil: (predicate: () => Promise<boolean> | boolean, timeoutMs?: number) => Promise<void>;
  newTask: (overrides?: Partial<Task>) => Promise<Task>;
  close: () => Promise<void>;
}

export const OWNER = "operator";

export async function makeHarness(fixture: Fixture, supervisor: FakeSupervisor, driver: ModelDriver, options: { leaseMs?: number; cancelRetries?: number; cancelRetryDelayMs?: number } = {}): Promise<Harness> {
  const store = await createStore();
  const bus = new TaskEventBus();
  const artifacts = new MemoryArtifactStore();
  const settled = new Map<string, Task>();
  const waiters = new Map<string, ((task: Task) => void)[]>();
  const handler = createRepairHandler({
    profiles: new Map([[fixture.profile.manifest.id, fixture.profile]]),
    supervisor,
    driver,
    artifacts,
    store,
    compare: compareDouble,
    validateEnvelope: validateEnvelopeDouble,
    buildManifest: buildManifestDouble,
    runtimeDir: fixture.runtimeDir,
  });
  const terminal = new Set(["done", "failed", "cancelled"]);
  const worker = new TaskWorker(store, handler, {
    bus,
    pollMs: 15,
    leaseMs: options.leaseMs ?? 3000,
    ...(options.cancelRetries !== undefined ? { cancelRetries: options.cancelRetries } : {}),
    ...(options.cancelRetryDelayMs !== undefined ? { cancelRetryDelayMs: options.cancelRetryDelayMs } : {}),
    settled: async (_owner, task) => {
      if (!terminal.has(task.status)) return;
      settled.set(task.id, task);
      for (const w of waiters.get(task.id) ?? []) w(task);
      waiters.delete(task.id);
    },
  });
  let counter = 0;
  const newTask = async (overrides: Partial<Task> = {}) => {
    const at = new Date().toISOString();
    const task: Task = {
      id: `task-${++counter}`,
      owner: OWNER,
      profileId: fixture.profile.manifest.id,
      issueText: "compute(0) raises ValueError: zero not supported. Expected 0.",
      status: "queued",
      phase: "prepare",
      generation: 0,
      leaseId: null,
      leaseUntil: null,
      attempts: 0,
      budget: { modelCallsUsed: 0, repairAttemptsUsed: 0 },
      createdAt: at,
      updatedAt: at,
      ...overrides,
    };
    await store.put(OWNER, "tasks", task);
    return task;
  };
  const waitFor = (taskId: string, timeoutMs = 10_000) =>
    new Promise<Task>((resolve, reject) => {
      const existing = settled.get(taskId);
      if (existing) return resolve(existing);
      const timer = setTimeout(() => reject(new Error(`task ${taskId} did not settle within ${timeoutMs}ms`)), timeoutMs);
      const list = waiters.get(taskId) ?? [];
      list.push((task) => {
        clearTimeout(timer);
        resolve(task);
      });
      waiters.set(taskId, list);
    });
  const waitUntil = async (predicate: () => Promise<boolean> | boolean, timeoutMs = 10_000) => {
    const start = Date.now();
    while (!(await predicate())) {
      if (Date.now() - start > timeoutMs) throw new Error("condition not met in time");
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  return {
    store,
    worker,
    bus,
    artifacts,
    settled,
    waitFor,
    waitUntil,
    newTask,
    close: async () => {
      await worker.stop();
      await store.close();
    },
  };
}
