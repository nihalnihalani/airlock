import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { SupervisorError } from "../src/errors";
import { type AttemptRecord, Journal } from "../src/operations";
import { tempDir } from "./helpers";

function record(overrides: Partial<AttemptRecord> = {}): AttemptRecord {
  const now = new Date().toISOString();
  return {
    taskId: "t1",
    attemptId: "a1",
    generation: 1,
    role: "author",
    profileId: "tabulate-365",
    container: "airlock-author-t1-a1",
    volume: "airlock-ws-t1-a1",
    status: "running",
    deadline: new Date(Date.now() + 60_000).toISOString(),
    authorizedUntil: new Date(Date.now() + 60_000).toISOString(),
    revoked: false,
    devUnsafe: true,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

const digestA = "a".repeat(64);
const digestB = "b".repeat(64);

describe("operations journal", () => {
  test("idempotent replay: same id + same digest returns the recorded result; different digest conflicts", () => {
    const journal = new Journal(join(tempDir(), "j.sqlite"));
    expect(journal.beginOperation({ operationId: "op1", requestDigest: digestA }, "freeze")).toEqual({ kind: "new" });
    expect(journal.beginOperation({ operationId: "op1", requestDigest: digestA }, "freeze")).toEqual({ kind: "in_progress" });
    journal.completeOperation("op1", 200, { hello: "world" });
    expect(journal.beginOperation({ operationId: "op1", requestDigest: digestA }, "freeze")).toEqual({ kind: "replay", httpStatus: 200, result: { hello: "world" } });
    expect(journal.beginOperation({ operationId: "op1", requestDigest: digestB }, "freeze")).toEqual({ kind: "conflict" });
    // Same digest but a different verb is also a conflict: an id binds one request.
    expect(journal.beginOperation({ operationId: "op1", requestDigest: digestA }, "destroy")).toEqual({ kind: "conflict" });
    journal.close();
  });

  test("pending operations become interrupted after a restart and replay as 409", () => {
    const path = join(tempDir(), "j.sqlite");
    const first = new Journal(path);
    first.beginOperation({ operationId: "op-crash", requestDigest: digestA }, "createAttempt");
    first.close();
    const second = new Journal(path);
    expect(second.interruptPendingOperations()).toBe(1);
    const replay = second.beginOperation({ operationId: "op-crash", requestDigest: digestA }, "createAttempt");
    expect(replay.kind).toBe("replay");
    if (replay.kind === "replay") expect(replay.httpStatus).toBe(409);
    second.close();
  });

  test("fence: unknown → 404, stale generation → 409, revoked → 409, destroyed → 409, newer generation never dispatches", () => {
    const journal = new Journal(join(tempDir(), "j.sqlite"));
    expect(() => journal.fence({ taskId: "t1", attemptId: "nope", generation: 1 })).toThrow(SupervisorError);
    try {
      journal.fence({ taskId: "t1", attemptId: "nope", generation: 1 });
    } catch (error) {
      expect((error as SupervisorError).status).toBe(404);
    }
    journal.insertAttempt(record({ generation: 2 }));
    expect(journal.fence({ taskId: "t1", attemptId: "a1", generation: 2 }).generation).toBe(2);
    expect(() => journal.fence({ taskId: "t1", attemptId: "a1", generation: 1 })).toThrow(/older than the recorded/);
    // wrong task for a known attempt: identifiers are not bearer tokens
    expect(() => journal.fence({ taskId: "other", attemptId: "a1", generation: 2 })).toThrow(/does not belong/);
    // M1: a newer generation no longer silently takes over a live attempt. It cannot dispatch or
    // freeze (fenced, 409) and the recorded generation is unchanged ...
    expect(() => journal.fence({ taskId: "t1", attemptId: "a1", generation: 3 })).toThrow(/must revoke/);
    expect(() => journal.fenceLifecycle({ taskId: "t1", attemptId: "a1", generation: 3 })).toThrow(/must revoke/);
    expect(journal.getAttempt("a1")?.generation).toBe(2);
    // ... it may revoke/destroy it (allowNewer), which records the newer generation and fences the previous owner.
    expect(journal.fenceLifecycle({ taskId: "t1", attemptId: "a1", generation: 3 }, { allowNewer: true }).generation).toBe(3);
    expect(() => journal.fence({ taskId: "t1", attemptId: "a1", generation: 2 })).toThrow(/older than the recorded/);
    journal.revoke("a1", "revoked");
    expect(() => journal.fence({ taskId: "t1", attemptId: "a1", generation: 3 })).toThrow(/revoked/);
    // lifecycle verbs still see a revoked attempt
    expect(journal.fenceLifecycle({ taskId: "t1", attemptId: "a1", generation: 3 }).revoked).toBe(true);
    journal.updateAttempt("a1", { status: "destroyed" });
    expect(() => journal.fenceLifecycle({ taskId: "t1", attemptId: "a1", generation: 3 })).toThrow(/destroyed/);
    journal.close();
  });

  test("fence: dispatch closes once the execution authorization lapses, even before any timer fires", () => {
    const journal = new Journal(":memory:");
    journal.insertAttempt(record({ authorizedUntil: new Date(Date.now() - 1).toISOString() }));
    expect(() => journal.fence({ taskId: "t1", attemptId: "a1", generation: 1 })).toThrow(/past its execution authorization/);
    // lifecycle verbs (destroy) still reach it
    expect(journal.fenceLifecycle({ taskId: "t1", attemptId: "a1", generation: 1 }).attemptId).toBe("a1");
    journal.close();
  });

  test("migration: a journal written before authorized_until gets the column; old rows are authorized until their deadline", () => {
    const path = join(tempDir(), "old.sqlite");
    const old = new Database(path, { create: true });
    old.exec(`CREATE TABLE attempts (attempt_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, generation INTEGER NOT NULL, role TEXT NOT NULL, profile_id TEXT NOT NULL, container TEXT NOT NULL, volume TEXT NOT NULL, status TEXT NOT NULL, deadline TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, dev_unsafe INTEGER NOT NULL DEFAULT 0, inspection_json TEXT, probe_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
    const deadline = new Date(Date.now() + 60_000).toISOString();
    old.query("INSERT INTO attempts (attempt_id, task_id, generation, role, profile_id, container, volume, status, deadline, created_at, updated_at) VALUES ('a1','t1',1,'author','p','c','v','running',?, 'x','x')").run(deadline);
    old.close();
    const journal = new Journal(path);
    expect(journal.getAttempt("a1")?.authorizedUntil).toBe(deadline);
    expect(journal.fence({ taskId: "t1", attemptId: "a1", generation: 1 }).attemptId).toBe("a1");
    journal.updateAttempt("a1", { authorizedUntil: new Date(Date.now() + 5_000).toISOString() });
    expect(journal.getAttempt("a1")?.authorizedUntil).not.toBe(deadline);
    journal.close();
    // reopening is idempotent
    expect(new Journal(path).getAttempt("a1")?.status).toBe("running");
  });

  test("abandonOperation forgets only a pending operation", () => {
    const journal = new Journal(":memory:");
    journal.beginOperation({ operationId: "op1", requestDigest: digestA }, "invoke:baseline");
    journal.abandonOperation("op1");
    expect(journal.beginOperation({ operationId: "op1", requestDigest: digestA }, "invoke:baseline")).toEqual({ kind: "new" });
    journal.completeOperation("op1", 200, {});
    journal.abandonOperation("op1");
    expect(journal.beginOperation({ operationId: "op1", requestDigest: digestA }, "invoke:baseline").kind).toBe("replay");
    journal.close();
  });

  test("tombstones block resurrection and survive reopen", () => {
    const path = join(tempDir(), "j.sqlite");
    const journal = new Journal(path);
    journal.tombstone("gone", "t1", "destroyed");
    expect(() => journal.insertAttempt(record({ attemptId: "gone" }))).toThrow(/resurrected/);
    journal.close();
    const again = new Journal(path);
    expect(again.isTombstoned("gone")).toBe(true);
    try {
      again.fence({ taskId: "t1", attemptId: "gone", generation: 1 });
    } catch (error) {
      expect((error as SupervisorError).status).toBe(409);
    }
    again.close();
  });

  test("expired and running counts", () => {
    const journal = new Journal(":memory:");
    journal.insertAttempt(record({ attemptId: "live" }));
    journal.insertAttempt(record({ attemptId: "old", deadline: new Date(Date.now() - 1000).toISOString() }));
    journal.insertAttempt(record({ attemptId: "dead", status: "destroyed", deadline: new Date(Date.now() - 1000).toISOString() }));
    expect(journal.expiredAttempts(new Date().toISOString()).map((a) => a.attemptId)).toEqual(["old"]);
    expect(journal.countRunning()).toBe(2);
    expect(journal.countRunning("live")).toBe(1);
    journal.close();
  });
});
