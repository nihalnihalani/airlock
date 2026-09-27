import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostCheck, Task } from "@airlock/contracts";
import { RepairAvailabilityService, SCRIPTED_REASON, describeDiagnostics, receiptProblem, type TaskLookup } from "../src/availability.ts";
import { makeFixture, type Fixture } from "./helpers/doubles.ts";
import { fakeHost } from "./helpers/fake-supervisor.ts";

let fixture: Fixture;
let dir: string;
beforeAll(async () => {
  fixture = await makeFixture();
});
afterAll(async () => {
  await fixture.cleanup();
});

const IMAGE = `sha256:${"a".repeat(64)}`;
const ADAPTER = "b".repeat(64);
const NOW = Date.parse("2026-09-30T00:00:00.000Z");
const liveHost = (overrides: Partial<HostCheck> = {}) => fakeHost({ selectedRuntime: "kata", devUnsafe: false, availableRuntimes: ["runc", "kata"], runtimeImageId: IMAGE, ...overrides });

/** This control plane's task records, as the gate run left them. */
function gateTasks(overrides: Record<string, Partial<Task>> = {}, count = 3, passed = 2): Map<string, Task> {
  const tasks = new Map<string, Task>();
  for (let i = 0; i < count; i++) {
    const id = `task-${i}`;
    tasks.set(id, {
      id,
      owner: "operator",
      profileId: "fx-1",
      issueText: "x",
      status: "done",
      phase: "ready",
      outcome: i < passed ? "CANDIDATE_PASSED_CHECKS" : "CHECKS_FAILED",
      candidateDigest: "1".repeat(64),
      liveGate: true,
      generation: 1,
      leaseId: null,
      leaseUntil: null,
      attempts: 1,
      budget: { modelCallsUsed: 4, repairAttemptsUsed: 1 },
      createdAt: "2026-09-27T09:00:00.000Z",
      updatedAt: "2026-09-27T09:30:00.000Z",
      ...(overrides[id] ?? {}),
    } as Task);
  }
  return tasks;
}
const lookup = (tasks: Map<string, Task>): TaskLookup => ({
  scanWhere: async <T,>(_kind: string, where: Record<string, unknown>) => {
    const t = tasks.get(String(where.id));
    return t ? [{ owner: t.owner, value: t as unknown as T }] : [];
  },
});
function receipt(overrides: Record<string, unknown> = {}) {
  const passed = (overrides.passed as number | undefined) ?? 2;
  const total = (overrides.total as number | undefined) ?? 3;
  return {
    schemaVersion: 1,
    recordedAt: "2026-09-27T10:00:00.000Z",
    revision: "c7580dc",
    profileId: "fx-1",
    contractDigest: fixture.profile.contractDigest,
    driver: "vultr",
    model: "glm-5.3-normalize",
    inferenceHost: "api.vultrinference.com",
    runtime: "kata",
    devUnsafe: false,
    runtimeImageId: IMAGE,
    adapterDigest: ADAPTER,
    attempts: Array.from({ length: total }, (_, i) => ({ taskId: `task-${i}`, outcome: i < passed ? "CANDIDATE_PASSED_CHECKS" : "CHECKS_FAILED", candidateDigest: "1".repeat(64), modelCalls: 4, modelHosts: ["api.vultrinference.com"], durationMs: 900 })),
    passed,
    total,
    ...overrides,
  };
}
async function fresh(files: Record<string, unknown>, model = "glm-5.3", tasks: Map<string, Task> = gateTasks(), adapter = ADAPTER) {
  dir = await mkdtemp(join(tmpdir(), "airlock-evidence-"));
  for (const [name, value] of Object.entries(files)) await writeFile(join(dir, name), typeof value === "string" ? value : JSON.stringify(value));
  return new RepairAvailabilityService({ driver: "vultr", model, evidenceDir: dir, repoRoot: tmpdir(), adapterDigestOf: async () => adapter, tasks: lookup(tasks), now: () => NOW });
}

describe("repair availability from live-gate receipts", () => {
  test("a matching 2/3 receipt makes repair available; the model matches with or without -normalize", async () => {
    const service = await fresh({ "a.json": receipt() });
    try {
      const a = await service.evaluate(fixture.profile, liveHost());
      expect(a.available).toBe(true);
      expect(a.evidence?.passed).toBe(2);
      expect(a.runtime).toBe("kata");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  const cases: [string, Record<string, unknown>, Partial<HostCheck> | null, string, string?][] = [
    ["mismatched model", {}, {}, "configured model is other-model", "other-model"],
    ["mismatched contract", { contractDigest: "e".repeat(64) }, {}, "running contract"],
    ["mismatched profile", { profileId: "other" }, {}, "not fx-1"],
    ["mismatched runtime", { runtime: "runsc" }, {}, "supervisor now selects kata"],
    ["mismatched runtime image", { runtimeImageId: `sha256:${"c".repeat(64)}` }, {}, "the supervisor now enforces"],
    ["a supervisor that reports no image id", {}, { runtimeImageId: undefined }, "no enforced runtime image id"],
    ["dev-unsafe supervisor", {}, { devUnsafe: true, selectedRuntime: "runc" }, "dev-unsafe"],
    ["supervisor unreachable", {}, null, "supervisor unreachable"],
    ["1 of 3", { passed: 1, total: 3 }, {}, "passed 1 of 3"],
    ["2 of 2", { passed: 2, total: 2 }, {}, "passed 2 of 2"],
  ];
  for (const [name, overrides, host, reason, model] of cases) {
    test(`unavailable with a precise reason: ${name}`, async () => {
      const service = await fresh({ "a.json": receipt(overrides) }, model);
      try {
        const a = await service.evaluate(fixture.profile, host === null ? null : liveHost(host));
        expect(a.available).toBe(false);
        expect(a.reason).toContain(reason);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  }

  test("only the newest valid receipt counts: a later failing gate withdraws an earlier pass", async () => {
    const service = await fresh({ "old.json": receipt(), "new.json": receipt({ recordedAt: "2026-09-28T10:00:00.000Z", passed: 0 }) });
    try {
      const a = await service.evaluate(fixture.profile, liveHost());
      expect(a.available).toBe(false);
      expect(a.reason).toContain("passed 0 of 3");
      expect(a.evidence?.recordedAt).toBe("2026-09-28T10:00:00.000Z");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a receipt measured under another adapter does not back repair", async () => {
    const service = await fresh({ "a.json": receipt() }, "glm-5.3", gateTasks(), "f".repeat(64));
    try {
      const a = await service.evaluate(fixture.profile, liveHost());
      expect(a.available).toBe(false);
      expect(a.reason).toContain("measured under adapter bbbbbbbbbbbb");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("passes are counted from this control plane's task records, not the receipt: a claimed pass the store does not back fails the gate", async () => {
    const service = await fresh({ "a.json": receipt() }, "glm-5.3", gateTasks({ "task-1": { outcome: "CHECKS_FAILED" } }));
    try {
      const a = await service.evaluate(fixture.profile, liveHost());
      expect(a.available).toBe(false);
      expect(a.reason).toContain("the task records confirm 1 passing attempt");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  for (const [name, tasks, reason] of [
    ["an attempt unknown to this store", (() => { const t = gateTasks(); t.delete("task-2"); return t; })(), "task-2 is not a task of this control plane"],
    ["an attempt that was not a live-gate task", gateTasks({ "task-0": { liveGate: undefined } }), "task-0 is not a live-gate task"],
    ["an attempt that was a scripted diagnostic", gateTasks({ "task-0": { scriptedDriver: "forged-log" } }), "task-0 is not a live-gate task"],
  ] as [string, Map<string, Task>, string][]) {
    test(`a receipt listing ${name} does not back repair`, async () => {
      const service = await fresh({ "a.json": receipt() }, "glm-5.3", tasks);
      try {
        const a = await service.evaluate(fixture.profile, liveHost());
        expect(a.available).toBe(false);
        expect(a.reason).toContain(reason);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  }

  test("a receipt dated in the future is refused, and it does not hide behind an older pass either", async () => {
    const onlyFuture = await fresh({ "future.json": receipt({ recordedAt: "2026-10-30T00:00:00.000Z" }) });
    try {
      const a = await onlyFuture.evaluate(fixture.profile, liveHost());
      expect(a.available).toBe(false);
      expect(a.reason).toContain("1 invalid file ignored");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    // Within the 5-minute skew allowance it is accepted.
    const skewed = await fresh({ "a.json": receipt({ recordedAt: new Date(NOW + 60_000).toISOString() }) });
    try {
      expect((await skewed.evaluate(fixture.profile, liveHost())).available).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a newer invalid receipt is not silently skipped: an older pass does not back repair", async () => {
    // Newer by its own recordedAt (schema-invalid: a scripted driver).
    const byDate = await fresh({ "old.json": receipt(), "new.json": receipt({ driver: "scripted", recordedAt: "2026-09-28T10:00:00.000Z" }) });
    try {
      const a = await byDate.evaluate(fixture.profile, liveHost());
      expect(a.available).toBe(false);
      expect(a.reason).toContain("new.json is invalid");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    // Unreadable, newer by file mtime.
    const byMtime = await fresh({ "old.json": receipt(), "zz.json": "{not json" });
    try {
      await utimes(join(dir, "old.json"), new Date(NOW - 60_000), new Date(NOW - 60_000));
      await utimes(join(dir, "zz.json"), new Date(NOW), new Date(NOW));
      const a = await byMtime.evaluate(fixture.profile, liveHost());
      expect(a.available).toBe(false);
      expect(a.reason).toContain("zz.json is invalid");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    // An OLDER invalid file does not withdraw a newer valid pass.
    const older = await fresh({ "new.json": receipt(), "aa.json": receipt({ driver: "scripted", recordedAt: "2026-09-01T00:00:00.000Z" }) });
    try {
      expect((await older.evaluate(fixture.profile, liveHost())).available).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("invalid or inconsistent receipts are ignored: wrong schema, a scripted driver, an inflated pass count, a foreign model host", async () => {
    const service = await fresh({
      "garbage.json": "{not json",
      "scripted.json": receipt({ driver: "scripted", recordedAt: "2026-09-29T00:00:00.000Z" }),
      "inflated.json": receipt({ passed: 3, total: 3, attempts: receipt().attempts, recordedAt: "2026-09-29T00:00:01.000Z" }),
      "foreign.json": receipt({ recordedAt: "2026-09-29T00:00:02.000Z", attempts: receipt().attempts.map((a) => ({ ...a, modelHosts: ["api.openai.com"] })) }),
    });
    try {
      const a = await service.evaluate(fixture.profile, liveHost());
      expect(a.available).toBe(false);
      expect(a.reason).toContain("4 invalid files ignored");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a changed file is re-read (cache keyed by mtime and size)", async () => {
    const service = await fresh({ "a.json": receipt({ passed: 1 }) });
    try {
      expect((await service.evaluate(fixture.profile, liveHost())).available).toBe(false);
      await writeFile(join(dir, "a.json"), JSON.stringify(receipt()));
      await utimes(join(dir, "a.json"), new Date(), new Date(Date.now() + 5000));
      expect((await service.evaluate(fixture.profile, liveHost())).available).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("the scripted driver is never a model repair; no model or no directory is a clear reason", async () => {
    const scripted = new RepairAvailabilityService({ driver: "scripted", model: null, evidenceDir: "/nonexistent", repoRoot: tmpdir() });
    expect(await scripted.evaluate(fixture.profile, liveHost())).toMatchObject({ available: false, reason: SCRIPTED_REASON, driver: "scripted" });
    const noModel = new RepairAvailabilityService({ driver: "vultr", model: null, evidenceDir: "/nonexistent", repoRoot: tmpdir() });
    expect((await noModel.evaluate(fixture.profile, liveHost())).reason).toContain("AIRLOCK_MODEL");
    const noDir = new RepairAvailabilityService({ driver: "vultr", model: "m", evidenceDir: join(tmpdir(), "airlock-no-such-dir"), repoRoot: tmpdir() });
    expect((await noDir.evaluate(fixture.profile, liveHost())).reason).toContain("no live-gate evidence directory");
  });

  test("receiptProblem flags internal inconsistency", () => {
    const r = receipt() as never;
    expect(receiptProblem(r)).toBeNull();
    expect(receiptProblem({ ...(receipt() as object), total: 4 } as never)).toContain("attempts listed");
  });
});

describe("diagnostic catalog metadata", () => {
  test("titles and descriptions come from the script file, else the name and its _comment", async () => {
    const d = await mkdtemp(join(tmpdir(), "airlock-diag-"));
    try {
      await writeFile(join(d, "a.json"), JSON.stringify({ title: "Forged log", description: "writes a fake log", turns: [] }));
      await writeFile(join(d, "b.json"), JSON.stringify({ _comment: "runaway command", turns: [] }));
      await writeFile(join(d, "c.json"), JSON.stringify([]));
      expect(await describeDiagnostics(d, ["a", "b", "c"], "repair")).toEqual([
        { name: "a", title: "Forged log", description: "writes a fake log", kind: "repair" },
        { name: "b", title: "b", description: "runaway command", kind: "repair" },
        { name: "c", title: "c", description: "", kind: "repair" },
      ]);
      // kind is the catalog's, never guessed from the name.
      expect((await describeDiagnostics(d, ["a"], "general"))[0]?.kind).toBe("general");
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  });
});
