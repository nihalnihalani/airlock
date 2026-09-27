/**
 * Harness for general tasks: an in-memory store and blob store, the fake supervisor (browser,
 * analysis and node roles), the dispatching handler (general + repair at the worker seam), and a
 * recording scripted driver. Everything is labelled scripted; nothing here is a model run.
 */
import type { RunEvent, Task } from "@airlock/contracts";
import { ArtifactService } from "../../src/artifact-service.ts";
import { TaskEventBus } from "../../src/events.ts";
import { createDispatchingHandler, createGeneralHandler, type GeneralDeps } from "../../src/general-handler.ts";
import { createRepairHandler } from "../../src/repair-handler.ts";
import { createStore, type Store } from "../../src/store/index.ts";
import type { TaskProfile } from "../../src/task-profiles.ts";
import { TASK_PROFILES } from "../../src/task-profiles.ts";
import type { ChatInput, ChatOutput, ModelDriver } from "../../src/vultr-client.ts";
import { TaskWorker } from "../../src/worker/index.ts";
import { buildManifestDouble, compareDouble, MemoryArtifactStore, validateEnvelopeDouble, type Fixture } from "./doubles.ts";
import type { FakeSupervisor } from "./fake-supervisor.ts";

export type Turn = { text?: string; toolCalls?: { name: string; args: unknown }[] } | ((input: ChatInput) => { text?: string; toolCalls?: { name: string; args: unknown }[] });

/** A scripted driver that records every request (messages as sent, images included). */
export function recordingDriver(turns: Turn[], options: { before?: (call: number, input: ChatInput) => Promise<void> } = {}): ModelDriver & { inputs: ChatInput[] } {
  const inputs: ChatInput[] = [];
  let cursor = 0;
  let id = 0;
  return {
    inputs,
    describe: () => ({ model: "scripted:test-general", host: "scripted" }),
    async chat(input: ChatInput): Promise<ChatOutput> {
      inputs.push({ ...input, messages: input.messages.map((m) => ({ ...m, ...(m.images ? { images: [...m.images] } : {}) })) });
      await options.before?.(inputs.length, input);
      if (input.signal?.aborted) throw new Error("aborted");
      const raw = turns[cursor];
      cursor = Math.min(cursor + 1, turns.length);
      const turn = typeof raw === "function" ? raw(input) : raw;
      if (!turn) return { text: "", toolCalls: [], finishReason: "stop", reasoning: "", usage: { input: 0, output: 0 } };
      const toolCalls = (turn.toolCalls ?? []).map((c) => ({ id: `call-${++id}`, name: c.name, args: c.args }));
      return { text: turn.text ?? "", toolCalls, finishReason: toolCalls.length ? "tool_calls" : "stop", reasoning: "", usage: { input: 100, output: 20 } };
    },
  };
}

export const OWNER = "judge-aaaaaaaaaaaaaaaaaaaaaaaa";

export interface GeneralHarness {
  store: Store;
  blobs: MemoryArtifactStore;
  artifacts: ArtifactService;
  worker: TaskWorker;
  bus: TaskEventBus;
  newTask: (overrides: Partial<Task>) => Promise<Task>;
  waitFor: (taskId: string, timeoutMs?: number) => Promise<Task>;
  waitUntil: (predicate: () => Promise<boolean> | boolean, timeoutMs?: number) => Promise<void>;
  events: (taskId: string) => Promise<RunEvent[]>;
  close: () => Promise<void>;
}

export async function makeGeneralHarness(
  fixture: Fixture,
  supervisor: FakeSupervisor,
  driver: GeneralDeps["driver"],
  options: { profiles?: Record<string, Partial<Omit<TaskProfile, "budgets">> & { budgets?: Partial<TaskProfile["budgets"]> }>; vision?: boolean; leaseMs?: number; cancelRetries?: number; cancelRetryDelayMs?: number; store?: Store } = {},
): Promise<GeneralHarness> {
  const store = options.store ?? (await createStore());
  const blobs = new MemoryArtifactStore();
  const artifacts = new ArtifactService(store, blobs);
  const bus = new TaskEventBus();
  const profiles = new Map(TASK_PROFILES);
  for (const [id, patch] of Object.entries(options.profiles ?? {})) {
    const base = profiles.get(id)!;
    profiles.set(id, { ...base, ...patch, budgets: { ...base.budgets, ...(patch.budgets ?? {}) } } as TaskProfile);
  }
  const general = createGeneralHandler({ supervisor, driver, store, artifacts, blobs, taskProfiles: profiles, vision: options.vision === true, capacityRetryDelaysMs: [], renewIntervalMs: 50, authorizationMs: 5000 });
  const repair = createRepairHandler({
    profiles: new Map([[fixture.profile.manifest.id, fixture.profile]]),
    supervisor,
    driver: driver as never,
    artifacts: blobs,
    store,
    compare: compareDouble,
    validateEnvelope: validateEnvelopeDouble,
    buildManifest: buildManifestDouble,
    runtimeDir: fixture.runtimeDir,
  });
  const settled = new Map<string, Task>();
  const waiters = new Map<string, ((t: Task) => void)[]>();
  const worker = new TaskWorker(store, createDispatchingHandler({ repair, general }), {
    bus,
    pollMs: 15,
    leaseMs: options.leaseMs ?? 3000,
    ...(options.cancelRetries !== undefined ? { cancelRetries: options.cancelRetries } : {}),
    ...(options.cancelRetryDelayMs !== undefined ? { cancelRetryDelayMs: options.cancelRetryDelayMs } : {}),
    settled: async (_owner, task) => {
      if (!["done", "failed", "cancelled"].includes(task.status)) return;
      settled.set(task.id, task);
      for (const w of waiters.get(task.id) ?? []) w(task);
      waiters.delete(task.id);
    },
  });
  let counter = 0;
  return {
    store,
    blobs,
    artifacts,
    worker,
    bus,
    async newTask(overrides) {
      const at = new Date().toISOString();
      const task: Task = {
        id: `gtask-${++counter}`,
        owner: OWNER,
        profileId: "web-analysis",
        issueText: "Open the regional sales page, find the worst-performing region and give me a chart with sources.",
        kind: "general",
        status: "queued",
        phase: "prepare",
        generation: 0,
        leaseId: null,
        leaseUntil: null,
        attempts: 0,
        budget: { modelCallsUsed: 0, repairAttemptsUsed: 0, tokensUsed: 0 },
        createdAt: at,
        updatedAt: at,
        ...overrides,
      };
      await store.put(OWNER, "tasks", task);
      return task;
    },
    waitFor(taskId, timeoutMs = 10_000) {
      return new Promise<Task>((resolve, reject) => {
        const existing = settled.get(taskId);
        if (existing) return resolve(existing);
        const timer = setTimeout(() => reject(new Error(`task ${taskId} did not settle within ${timeoutMs}ms`)), timeoutMs);
        const list = waiters.get(taskId) ?? [];
        list.push((t) => {
          clearTimeout(timer);
          resolve(t);
        });
        waiters.set(taskId, list);
      });
    },
    async waitUntil(predicate, timeoutMs = 10_000) {
      const start = Date.now();
      while (!(await predicate())) {
        if (Date.now() - start > timeoutMs) throw new Error("condition not met in time");
        await new Promise((r) => setTimeout(r, 10));
      }
    },
    events: (taskId) => store.listEvents(taskId, 0, 5000),
    async close() {
      await worker.stop();
      if (!options.store) await store.close();
    },
  };
}
