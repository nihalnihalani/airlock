/**
 * Airlock control-plane Store.
 *
 * Adapted from OpenMuse `apps/server/src/db.ts` at 205cc386b75aae1a862f3fdd43104b570c8d0911.
 * MIT License, Copyright (c) 2026 OpenMuse contributors. https://github.com/CopilotKit/openmuse
 *
 * Modifications for Airlock:
 *  - PGlite only (the `pg` pool path, action `claim`, credential updates and interrupted-action
 *    recovery are removed; they belong to OpenMuse's personal-assistant runtime).
 *  - `insertImmutable`: INSERT ... ON CONFLICT DO NOTHING RETURNING → boolean. Used for verification
 *    records, manifests and export grants (CLAUDE.md §3.3: immutable inserts reject replacement).
 *  - `appendEvent` / `listEvents`: an append-only `events` table with a per-task monotonically
 *    increasing `seq` assigned in the same statement, replayable by `seq` (SSE Last-Event-ID).
 *  - `scanWhere`/`listWhere` helpers for worker polling without loading every record.
 */
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import type { RunEvent } from "@airlock/contracts";

type Row = { data: Record<string, unknown> };
interface Database {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Row[] }>;
  close: () => Promise<void>;
}

export class Store {
  constructor(private readonly db: Database) {}

  async get<T = Record<string, unknown>>(owner: string, kind: string, id: string): Promise<T | null> {
    const result = await this.db.query(
      "SELECT data FROM records WHERE owner=$1 AND kind=$2 AND id=$3",
      [owner, kind, id],
    );
    return (result.rows[0]?.data as T | undefined) ?? null;
  }

  async list<T = Record<string, unknown>>(owner: string, kind: string): Promise<T[]> {
    const result = await this.db.query(
      "SELECT data FROM records WHERE owner=$1 AND kind=$2 ORDER BY updated_at DESC,id",
      [owner, kind],
    );
    return result.rows.map((row) => row.data as T);
  }

  /** Generic upsert. NEVER use for artifacts, verification records or grants (see insertImmutable). */
  async put<T extends { id: string }>(owner: string, kind: string, value: T): Promise<T> {
    await this.db.query(
      "INSERT INTO records(owner,kind,id,data) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(owner,kind,id) DO UPDATE SET data=excluded.data,updated_at=now()",
      [owner, kind, value.id, JSON.stringify(value)],
    );
    return value;
  }

  async remove(owner: string, kind: string, id: string): Promise<void> {
    await this.db.query("DELETE FROM records WHERE owner=$1 AND kind=$2 AND id=$3", [owner, kind, id]);
  }

  /**
   * Atomic compare-and-swap: applies `patch` only when the stored JSON contains `expected`.
   * Keys listed in `unset` are removed before the patch is merged (JSON cannot carry `undefined`).
   */
  async compareAndSwap<T>(
    owner: string,
    kind: string,
    id: string,
    expected: Record<string, unknown>,
    patch: Record<string, unknown>,
    unset: string[] = [],
    /** Keys that must be absent for the swap to apply (containment cannot express absence). */
    absent: string[] = [],
  ): Promise<T | null> {
    const result = await this.db.query(
      "UPDATE records SET data=(data - $6::text[]) || $5::jsonb,updated_at=now() WHERE owner=$1 AND kind=$2 AND id=$3 AND data @> $4::jsonb AND NOT (data ?| $7::text[]) RETURNING data",
      [owner, kind, id, JSON.stringify(expected), JSON.stringify(patch), unset, absent],
    );
    return (result.rows[0]?.data as T | undefined) ?? null;
  }

  async insertIfAbsent<T extends { id: string }>(owner: string, kind: string, value: T): Promise<T | null> {
    const result = await this.db.query(
      "INSERT INTO records(owner,kind,id,data) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT DO NOTHING RETURNING data",
      [owner, kind, value.id, JSON.stringify(value)],
    );
    return (result.rows[0]?.data as T | undefined) ?? null;
  }

  /**
   * Immutable insert: returns false when a record with this identity already exists, without
   * touching it. This is the only write path for verification records, manifests and grants.
   */
  async insertImmutable<T extends { id: string }>(owner: string, kind: string, value: T): Promise<boolean> {
    const inserted = await this.insertIfAbsent(owner, kind, value);
    return inserted !== null;
  }

  async scan<T>(kind: string): Promise<{ owner: string; value: T }[]> {
    const result = await this.db.query(
      "SELECT jsonb_build_object('owner',owner,'value',data) AS data FROM records WHERE kind=$1 ORDER BY updated_at ASC",
      [kind],
    );
    return result.rows.map((row) => row.data as { owner: string; value: T });
  }

  /** Scan a kind restricted to records whose JSON contains `filter` (uses the jsonb @> operator). */
  async scanWhere<T>(kind: string, filter: Record<string, unknown>): Promise<{ owner: string; value: T }[]> {
    const result = await this.db.query(
      "SELECT jsonb_build_object('owner',owner,'value',data) AS data FROM records WHERE kind=$1 AND data @> $2::jsonb ORDER BY updated_at ASC",
      [kind, JSON.stringify(filter)],
    );
    return result.rows.map((row) => row.data as { owner: string; value: T });
  }

  async take<T>(owner: string, kind: string, id: string): Promise<T | null> {
    const result = await this.db.query(
      "DELETE FROM records WHERE owner=$1 AND kind=$2 AND id=$3 RETURNING data",
      [owner, kind, id],
    );
    return (result.rows[0]?.data as T | undefined) ?? null;
  }

  /**
   * Append one run event. `seq` is assigned from MAX(seq)+1 for the task inside the INSERT
   * statement itself, so it is monotonic per task; the (task_id, seq) primary key makes a lost
   * race impossible to persist (the loser retries).
   */
  async appendEvent(owner: string, taskId: string, event: Omit<RunEvent, "seq" | "taskId">): Promise<RunEvent> {
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        const result = await this.db.query(
          `INSERT INTO events(owner,task_id,seq,id,data)
           SELECT $1,$2,COALESCE(MAX(seq),0)+1,$3,$4::jsonb FROM events WHERE task_id=$2
           RETURNING jsonb_set(data,'{seq}',to_jsonb(seq)) AS data`,
          [owner, taskId, event.id, JSON.stringify({ ...event, taskId, seq: 0 })],
        );
        const row = result.rows[0];
        if (!row) throw new Error("appendEvent returned no row");
        return row.data as RunEvent;
      } catch (error) {
        if (attempt === 7 || !isUniqueViolation(error)) throw error;
      }
    }
    throw new Error("appendEvent exhausted retries");
  }

  /** Events with seq > afterSeq, ascending, bounded by `limit` (default 1000). */
  async listEvents(taskId: string, afterSeq = 0, limit = 1000): Promise<RunEvent[]> {
    const bounded = Math.min(Math.max(1, Math.floor(limit)), 5000);
    const result = await this.db.query(
      "SELECT jsonb_set(data,'{seq}',to_jsonb(seq)) AS data FROM events WHERE task_id=$1 AND seq>$2 ORDER BY seq ASC LIMIT $3",
      [taskId, Math.max(0, Math.floor(afterSeq)), bounded],
    );
    return result.rows.map((row) => row.data as RunEvent);
  }

  close(): Promise<void> {
    return this.db.close();
  }
}

function isUniqueViolation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /duplicate key|unique constraint|23505/i.test(message);
}

/** `dataDir` undefined → in-memory database (tests). */
export async function createStore(options: { dataDir?: string } = {}): Promise<Store> {
  if (options.dataDir) await mkdir(dirname(options.dataDir), { recursive: true, mode: 0o700 });
  const embedded = options.dataDir ? new PGlite(options.dataDir) : new PGlite();
  await embedded.waitReady;
  const database: Database = {
    query: (sql, params) => embedded.query<Row>(sql, params),
    close: () => embedded.close(),
  };
  await database.query(
    "CREATE TABLE IF NOT EXISTS records(owner text NOT NULL,kind text NOT NULL,id text NOT NULL,data jsonb NOT NULL,updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(owner,kind,id))",
  );
  await database.query("CREATE INDEX IF NOT EXISTS records_kind_idx ON records(kind,updated_at)");
  await database.query(
    "CREATE TABLE IF NOT EXISTS events(owner text NOT NULL,task_id text NOT NULL,seq bigint NOT NULL,id text NOT NULL,data jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(task_id,seq))",
  );
  return new Store(database);
}
