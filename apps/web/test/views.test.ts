import { describe, expect, test } from "bun:test";
import type { RunEvent } from "@airlock/contracts";
import { extractErrorMessage } from "../src/lib/api";
import { extractCheckpoints, runtimeTier, toExecRow, toModelCallRow } from "../src/lib/eventViews";
import { tail } from "../src/lib/format";
import { hrefFor, parseHash } from "../src/lib/router";

function ev(seq: number, kind: RunEvent["kind"], data?: Record<string, unknown>): RunEvent {
  return {
    id: `ev-${seq}`,
    taskId: "task-1",
    seq,
    at: "2026-01-01T00:00:00.000Z",
    kind,
    title: `event ${seq}`,
    detail: "",
    ...(data ? { data } : {}),
  };
}

describe("toModelCallRow", () => {
  test("reads model, host and usage with fallbacks", () => {
    const row = toModelCallRow(
      ev(1, "model", { model: "m", baseUrl: "https://api.vultrinference.com/v1", usage: { input: 10, output: 5 }, toolCalls: [{ name: "run" }] }),
    );
    expect(row.model).toBe("m");
    expect(row.host).toBe("api.vultrinference.com");
    expect(row.inputTokens).toBe(10);
    expect(row.outputTokens).toBe(5);
    expect(row.toolCalls).toEqual(["run"]);
  });

  test("defaults when data is missing or odd", () => {
    const row = toModelCallRow(ev(2, "model", { usage: "nope", toolCalls: "x" }));
    expect(row.model).toBeNull();
    expect(row.host).toBe("api.vultrinference.com");
    expect(row.inputTokens).toBeNull();
    expect(row.toolCalls).toEqual([]);
  });
});

describe("toExecRow", () => {
  test("parses a nested ExecResult and command", () => {
    const row = toExecRow(
      ev(3, "exec", {
        command: "python -m pytest",
        result: { status: "failed", exitCode: 1, stdout: "out", stderr: "err", truncated: true, timedOut: false, durationMs: 12 },
      }),
    );
    expect(row.command).toBe("python -m pytest");
    expect(row.result?.exitCode).toBe(1);
    expect(row.result?.truncated).toBe(true);
  });

  test("ignores an invalid result shape", () => {
    const row = toExecRow(ev(4, "tool", { args: { command: "ls" }, result: { status: "weird" } }));
    expect(row.command).toBe("ls");
    expect(row.result).toBeNull();
  });
});

describe("extractCheckpoints / runtimeTier", () => {
  const probe = {
    probedAt: "2026-01-01T00:00:01.000Z",
    metadataEndpoint: "BLOCKED",
    dns: "BLOCKED",
    outboundTcp: "BLOCKED",
    dockerSocket: "BLOCKED",
    hostMounts: "BLOCKED",
    allBlocked: true,
  };
  const teardown = { destroyedAt: "2026-01-01T00:00:02.000Z", containersRemaining: [], volumesRemaining: [], clean: true };
  const host = {
    checkedAt: "2026-01-01T00:00:00.000Z",
    dockerVersion: "27",
    cpuVirtualization: false,
    kvmPresent: false,
    kvmReadWrite: false,
    availableRuntimes: ["runc"],
    selectedRuntime: "runc",
    devUnsafe: true,
  };

  test("reads host from the prepare phase event and inspection/teardown from invocation exec events", () => {
    const inspection = {
      inspectedAt: "2026-01-01T00:00:03.000Z",
      container: "airlock-candidate-x",
      runtime: "runc",
      devUnsafe: true,
      imageDigest: "sha256:abc",
      guestUname: "Linux x 6.1",
      guestHostname: "abc",
      checks: {
        networkNone: true, nonRootUser: true, readOnlyRootfs: true, capDropAll: true, noNewPrivileges: true,
        pidsLimited: true, memoryLimited: true, cpuLimited: true, noHostBinds: true, noPorts: true,
        privateIpc: true, restartDisabled: true, ownedLabels: true,
      },
      allPassed: true,
    };
    const execResult = { status: "succeeded", exitCode: 0, stdout: "", stderr: "", truncated: false, timedOut: false, durationMs: 5 };
    const events = [ev(1, "phase", { host }), ev(2, "exec", { tool: "candidate", command: "adapter", result: execResult, inspection, teardown })];
    const cp = extractCheckpoints(null, events);
    expect(cp.hostSource).toBe("event #1");
    expect(cp.inspections.map((i) => i.inspection.container)).toEqual(["airlock-candidate-x"]);
    expect(cp.teardowns.length).toBe(1);
    expect(cp.execCount).toBe(1);
    expect(runtimeTier(cp)).toEqual({ runtime: "runc", devUnsafe: true, source: "inspected" });
  });

  test("collects probe, teardown and host from check events and dedupes", () => {
    const events = [ev(1, "check", { host, probe }), ev(2, "check", { probe }), ev(3, "lifecycle", { teardown }), ev(4, "exec", { command: "x" })];
    const cp = extractCheckpoints(null, events);
    expect(cp.host?.selectedRuntime).toBe("runc");
    expect(cp.probes.length).toBe(1);
    expect(cp.teardowns.length).toBe(1);
    expect(cp.execCount).toBe(1);
    const tier = runtimeTier(cp);
    expect(tier.runtime).toBe("runc");
    expect(tier.devUnsafe).toBe(true);
    expect(tier.source).toBe("host check");
  });

  test("reports nothing when no data exists", () => {
    const cp = extractCheckpoints(null, []);
    expect(cp.host).toBeNull();
    expect(runtimeTier(cp).runtime).toBeNull();
  });
});

describe("router", () => {
  test("parses known routes and validates task ids", () => {
    expect(parseHash("")).toEqual({ name: "home" });
    expect(parseHash("#/")).toEqual({ name: "home" });
    expect(parseHash("#/new")).toEqual({ name: "new" });
    expect(parseHash("#/tasks")).toEqual({ name: "tasks" });
    expect(parseHash("#/tasks/abc-123")).toEqual({ name: "task", id: "abc-123" });
    expect(parseHash("#/tasks/../etc").name).toBe("notfound");
    expect(parseHash("#/tasks/a/b").name).toBe("notfound");
    expect(parseHash("#/tasks/%ZZ").name).toBe("notfound");
    expect(parseHash("#/nope").name).toBe("notfound");
  });

  test("hrefFor round-trips", () => {
    expect(parseHash(hrefFor({ name: "task", id: "t_1" }))).toEqual({ name: "task", id: "t_1" });
  });
});

describe("extractErrorMessage", () => {
  test("prefers JSON error fields and bounds text", () => {
    expect(extractErrorMessage(409, JSON.stringify({ error: "stale generation" }))).toBe("stale generation");
    expect(extractErrorMessage(400, JSON.stringify({ issues: [{ message: "Required", path: ["issueText"] }] }))).toContain("Required");
    expect(extractErrorMessage(401, "")).toContain("Not signed in");
    expect(extractErrorMessage(500, "x".repeat(2000)).length).toBeLessThan(700);
  });
});

describe("tail", () => {
  test("keeps the last lines and flags clipping", () => {
    const t = tail("a\nb\nc\nd", 2);
    expect(t.text).toBe("c\nd");
    expect(t.clipped).toBe(true);
    expect(tail("", 2)).toEqual({ text: "", clipped: false });
  });
});
