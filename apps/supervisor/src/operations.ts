/**
 * The local execution journal: attempts, generations, operations and tombstones.
 *
 * A small durable SQLite journal on the supervisor (research/37 "Cancellation, recovery and
 * identity"). It is not a port of any upstream store. Guarantees it provides:
 *
 *  - An operation id binds one request digest. Same id + same digest after completion replays the
 *    recorded result; same id + different digest is a conflict; same id while still pending is
 *    "in progress" and is reconciled, never rerun.
 *  - Generation fencing: a request whose generation is lower than the recorded one, or whose
 *    attempt is revoked, destroyed or tombstoned, is fenced (409). Fences are re-checked immediately
 *    before every start/exec, not only at request acceptance.
 *  - A crash between intent and acknowledgement leaves a pending operation; on startup those become
 *    `interrupted` (409 on replay), never an invented receipt.
 */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { AttemptRef, AttemptState, IsolationProbe, Operation, RuntimeInspection, SandboxRole } from "@airlock/contracts";
import { SupervisorError } from "./errors";

export type AttemptStatus = AttemptState["status"];

export interface AttemptRecord {
  taskId: string;
  attemptId: string;
  generation: number;
  role: SandboxRole;
  profileId: string;
  container: string;
  volume: string;
  status: AttemptStatus;
  deadline: string;
  revoked: boolean;
  devUnsafe: boolean;
  inspection?: RuntimeInspection;
  probe?: IsolationProbe;
  createdAt: string;
  updatedAt: string;
}

export interface EphemeralRecord {
  container: string;
  volume: string | null;
  taskId: string;
  operationId: string;
  role: string;
  deadline: string;
  createdAt: string;
}

export type BeginOutcome =
  | { kind: "new" }
  | { kind: "replay"; httpStatus: number; result: unknown }
  | { kind: "conflict" }
  | { kind: "in_progress" };

interface AttemptRow {
  attempt_id: string;
  task_id: string;
  generation: number;
  role: string;
  profile_id: string;
  container: string;
  volume: string;
  status: string;
  deadline: string;
  revoked: number;
  dev_unsafe: number;
  inspection_json: string | null;
  probe_json: string | null;
  created_at: string;
  updated_at: string;
}

interface OperationRow {
  operation_id: string;
  request_digest: string;
  kind: string;
  status: string;
  http_status: number | null;
  result_json: string | null;
}

interface EphemeralRow {
  container: string;
  volume: string | null;
  task_id: string;
  operation_id: string;
  role: string;
  deadline: string;
  created_at: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS attempts (
  attempt_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  role TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  container TEXT NOT NULL,
  volume TEXT NOT NULL,
  status TEXT NOT NULL,
  deadline TEXT NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0,
  dev_unsafe INTEGER NOT NULL DEFAULT 0,
  inspection_json TEXT,
  probe_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS attempts_task ON attempts(task_id);
CREATE TABLE IF NOT EXISTS operations (
  operation_id TEXT PRIMARY KEY,
  request_digest TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  http_status INTEGER,
  result_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tombstones (
  attempt_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ephemerals (
  container TEXT PRIMARY KEY,
  volume TEXT,
  task_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  role TEXT NOT NULL,
  deadline TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

function rowToAttempt(row: AttemptRow): AttemptRecord {
  const record: AttemptRecord = {
    taskId: row.task_id,
    attemptId: row.attempt_id,
    generation: row.generation,
    role: row.role as SandboxRole,
    profileId: row.profile_id,
    container: row.container,
    volume: row.volume,
    status: row.status as AttemptStatus,
    deadline: row.deadline,
    revoked: row.revoked === 1,
    devUnsafe: row.dev_unsafe === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.inspection_json) record.inspection = JSON.parse(row.inspection_json) as RuntimeInspection;
  if (row.probe_json) record.probe = JSON.parse(row.probe_json) as IsolationProbe;
  return record;
}

export function attemptStateOf(record: AttemptRecord): AttemptState {
  return {
    ref: { taskId: record.taskId, attemptId: record.attemptId, generation: record.generation },
    role: record.role,
    container: record.container,
    status: record.status,
    ...(record.inspection ? { inspection: record.inspection } : {}),
    ...(record.probe ? { probe: record.probe } : {}),
    deadline: record.deadline,
  };
}

export class Journal {
  private readonly db: Database;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  // ---------------------------------------------------------------------------------------------
  // Operations
  // ---------------------------------------------------------------------------------------------

  beginOperation(operation: Operation, kind: string): BeginOutcome {
    const now = new Date().toISOString();
    const tx = this.db.transaction((): BeginOutcome => {
      const existing = this.db
        .query<OperationRow, [string]>("SELECT * FROM operations WHERE operation_id = ?")
        .get(operation.operationId);
      if (!existing) {
        this.db
          .query("INSERT INTO operations (operation_id, request_digest, kind, status, created_at, updated_at) VALUES (?, ?, ?, 'pending', ?, ?)")
          .run(operation.operationId, operation.requestDigest, kind, now, now);
        return { kind: "new" };
      }
      if (existing.request_digest !== operation.requestDigest || existing.kind !== kind) return { kind: "conflict" };
      if (existing.status !== "completed") return { kind: "in_progress" };
      return {
        kind: "replay",
        httpStatus: existing.http_status ?? 500,
        result: existing.result_json ? JSON.parse(existing.result_json) : null,
      };
    });
    return tx();
  }

  completeOperation(operationId: string, httpStatus: number, result: unknown): void {
    this.db
      .query("UPDATE operations SET status = 'completed', http_status = ?, result_json = ?, updated_at = ? WHERE operation_id = ?")
      .run(httpStatus, JSON.stringify(result), new Date().toISOString(), operationId);
  }

  /** Startup: every operation still pending was cut off by a crash. It is interrupted, not rerun. */
  interruptPendingOperations(): number {
    const result = this.db
      .query(
        "UPDATE operations SET status = 'completed', http_status = 409, result_json = ?, updated_at = ? WHERE status = 'pending'",
      )
      .run(JSON.stringify({ error: "Operation was interrupted by a supervisor restart; its effect is unknown. Start a fresh attempt." }), new Date().toISOString());
    return result.changes;
  }

  // ---------------------------------------------------------------------------------------------
  // Attempts and fencing
  // ---------------------------------------------------------------------------------------------

  insertAttempt(record: AttemptRecord): void {
    if (this.isTombstoned(record.attemptId)) {
      throw new SupervisorError("revoked", `Attempt ${record.attemptId} was destroyed earlier and cannot be resurrected.`);
    }
    const existing = this.getAttempt(record.attemptId);
    if (existing) throw new SupervisorError("operation_conflict", `Attempt ${record.attemptId} already exists.`);
    this.db
      .query(
        `INSERT INTO attempts (attempt_id, task_id, generation, role, profile_id, container, volume, status, deadline, revoked, dev_unsafe, inspection_json, probe_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.attemptId,
        record.taskId,
        record.generation,
        record.role,
        record.profileId,
        record.container,
        record.volume,
        record.status,
        record.deadline,
        record.revoked ? 1 : 0,
        record.devUnsafe ? 1 : 0,
        record.inspection ? JSON.stringify(record.inspection) : null,
        record.probe ? JSON.stringify(record.probe) : null,
        record.createdAt,
        record.updatedAt,
      );
  }

  getAttempt(attemptId: string): AttemptRecord | null {
    const row = this.db.query<AttemptRow, [string]>("SELECT * FROM attempts WHERE attempt_id = ?").get(attemptId);
    return row ? rowToAttempt(row) : null;
  }

  listAttempts(): AttemptRecord[] {
    return this.db.query<AttemptRow, []>("SELECT * FROM attempts ORDER BY created_at").all().map(rowToAttempt);
  }

  updateAttempt(
    attemptId: string,
    patch: Partial<Pick<AttemptRecord, "status" | "revoked" | "generation" | "inspection" | "probe">>,
  ): void {
    const sets: string[] = [];
    const values: (string | number | null)[] = [];
    if (patch.status !== undefined) {
      sets.push("status = ?");
      values.push(patch.status);
    }
    if (patch.revoked !== undefined) {
      sets.push("revoked = ?");
      values.push(patch.revoked ? 1 : 0);
    }
    if (patch.generation !== undefined) {
      sets.push("generation = ?");
      values.push(patch.generation);
    }
    if (patch.inspection !== undefined) {
      sets.push("inspection_json = ?");
      values.push(JSON.stringify(patch.inspection));
    }
    if (patch.probe !== undefined) {
      sets.push("probe_json = ?");
      values.push(JSON.stringify(patch.probe));
    }
    if (sets.length === 0) return;
    sets.push("updated_at = ?");
    values.push(new Date().toISOString());
    values.push(attemptId);
    this.db.query(`UPDATE attempts SET ${sets.join(", ")} WHERE attempt_id = ?`).run(...values);
  }

  /**
   * The fence. Throws a SupervisorError (404/409) unless the ref may still act on the attempt.
   * A higher generation than recorded is accepted and recorded, which fences the older one.
   */
  fence(ref: AttemptRef): AttemptRecord {
    const record = this.getAttempt(ref.attemptId);
    if (!record) {
      if (this.isTombstoned(ref.attemptId)) throw new SupervisorError("revoked", `Attempt ${ref.attemptId} was destroyed.`);
      throw new SupervisorError("not_found", `Attempt ${ref.attemptId} is unknown to this supervisor.`);
    }
    if (record.taskId !== ref.taskId) throw new SupervisorError("not_found", `Attempt ${ref.attemptId} does not belong to task ${ref.taskId}.`);
    if (record.status === "destroyed") throw new SupervisorError("revoked", `Attempt ${ref.attemptId} was destroyed.`);
    if (ref.generation < record.generation) {
      throw new SupervisorError("stale_generation", `Generation ${ref.generation} is older than the recorded ${record.generation}; a newer attempt owns this task.`);
    }
    if (ref.generation > record.generation) {
      this.updateAttempt(ref.attemptId, { generation: ref.generation });
      record.generation = ref.generation;
    }
    if (record.revoked) throw new SupervisorError("revoked", `Attempt ${ref.attemptId} is revoked; dispatch is closed.`);
    return record;
  }

  /** Like fence, but a revoked attempt is still returned (freeze/destroy act on revoked attempts). */
  fenceLifecycle(ref: AttemptRef): AttemptRecord {
    try {
      return this.fence(ref);
    } catch (error) {
      if (error instanceof SupervisorError && error.code === "revoked") {
        const record = this.getAttempt(ref.attemptId);
        if (record && record.status !== "destroyed" && record.taskId === ref.taskId) return record;
      }
      throw error;
    }
  }

  revoke(attemptId: string, status: AttemptStatus): void {
    this.updateAttempt(attemptId, { revoked: true, status });
  }

  tombstone(attemptId: string, taskId: string, reason: string): void {
    this.db
      .query("INSERT OR REPLACE INTO tombstones (attempt_id, task_id, reason, at) VALUES (?, ?, ?, ?)")
      .run(attemptId, taskId, reason.slice(0, 256), new Date().toISOString());
  }

  isTombstoned(attemptId: string): boolean {
    return this.db.query<{ attempt_id: string }, [string]>("SELECT attempt_id FROM tombstones WHERE attempt_id = ?").get(attemptId) !== null;
  }

  /** Live (not destroyed) attempts whose deadline has passed. */
  expiredAttempts(nowIso: string): AttemptRecord[] {
    return this.listAttempts().filter((a) => a.status !== "destroyed" && a.deadline < nowIso);
  }

  countRunning(excludeAttemptId?: string): number {
    return this.listAttempts().filter((a) => a.status === "running" && a.attemptId !== excludeAttemptId).length;
  }

  // ---------------------------------------------------------------------------------------------
  // Ephemerals (one-shot containers in flight)
  // ---------------------------------------------------------------------------------------------

  insertEphemeral(record: EphemeralRecord): void {
    this.db
      .query("INSERT OR REPLACE INTO ephemerals (container, volume, task_id, operation_id, role, deadline, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(record.container, record.volume, record.taskId, record.operationId, record.role, record.deadline, record.createdAt);
  }

  deleteEphemeral(container: string): void {
    this.db.query("DELETE FROM ephemerals WHERE container = ?").run(container);
  }

  listEphemerals(): EphemeralRecord[] {
    return this.db
      .query<EphemeralRow, []>("SELECT * FROM ephemerals")
      .all()
      .map((r) => ({ container: r.container, volume: r.volume, taskId: r.task_id, operationId: r.operation_id, role: r.role, deadline: r.deadline, createdAt: r.created_at }));
  }
}
