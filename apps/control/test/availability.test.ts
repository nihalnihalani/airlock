import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostCheck } from "@airlock/contracts";
import { RepairAvailabilityService, SCRIPTED_REASON, describeDiagnostics, receiptProblem } from "../src/availability.ts";
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

const liveHost = (overrides: Partial<HostCheck> = {}) => fakeHost({ selectedRuntime: "kata", devUnsafe: false, availableRuntimes: ["runc", "kata"], ...overrides });
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
    attempts: Array.from({ length: total }, (_, i) => ({ taskId: `task-${i}`, outcome: i < passed ? "CANDIDATE_PASSED_CHECKS" : "CHECKS_FAILED", candidateDigest: "1".repeat(64), modelCalls: 4, modelHosts: ["api.vultrinference.com"], durationMs: 900 })),
    passed,
    total,
    ...overrides,
  };
}
async function fresh(files: Record<string, unknown>, model = "glm-5.3") {
  dir = await mkdtemp(join(tmpdir(), "airlock-evidence-"));
  for (const [name, value] of Object.entries(files)) await writeFile(join(dir, name), typeof value === "string" ? value : JSON.stringify(value));
  return new RepairAvailabilityService({ driver: "vultr", model, evidenceDir: dir, repoRoot: tmpdir() });
}

describe("repair availability from live-gate receipts", () => {
  test("a matching 2/3 receipt makes repair available; the model matches with or without -normalize", async () => {
    const service = await fresh({ "a.json": receipt() });
    try {
      const a = await service.evaluate(fixture.profile, liveHost({ runtimeImageId: "sha256:img" }));
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
    ["mismatched runtime image", { runtimeImageId: "sha256:old" }, { runtimeImageId: "sha256:new" }, "runtime image"],
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
      expect(await describeDiagnostics(d, ["a", "b", "c"])).toEqual([
        { name: "a", title: "Forged log", description: "writes a fake log" },
        { name: "b", title: "b", description: "runaway command" },
        { name: "c", title: "c", description: "" },
      ]);
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  });
});
