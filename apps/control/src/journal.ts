/**
 * Supervisor operation journal (M8) and confirmed teardown, shared by the repair and general
 * handlers. Moved out of repair-handler.ts unchanged in behaviour:
 *
 * - every supervisor mutation is written to the store (kind "operations") by the client's
 *   `beforeSend` hook, i.e. after its Operation is built and before a byte leaves the process, then
 *   settled from the response (4xx → "failed"; anything else uncertain → "unknown");
 * - a 429 (admission control, nothing ran) is retried as a fresh journaled operation after a
 *   bounded backoff;
 * - teardown is revoke → destroy, and is "clean" only when the supervisor says so (or its own
 *   journal says the attempt is already `destroyed`).
 *
 * Journal writes are unguarded store writes on purpose: they must land even while a lost-lease run
 * tears its attempts down.
 */
import type { AttemptRef, Operation } from "@airlock/contracts";
import { log } from "./log.ts";
import { redactTeardown } from "./redact.ts";
import type { Store } from "./store/index.ts";
import { SupervisorCapacityError, SupervisorError, SupervisorFenceError, SupervisorNotFoundError, type CallOptions, type SupervisorClient } from "./supervisor-client.ts";

/** Supervisor operation journal (M8): one row per dispatched mutation, written before it is sent. */
export const STORE_KIND_OPERATIONS = "operations";

/** A journaled supervisor operation (M8). */
export interface OperationRecord {
  id: string;
  operationId: string;
  requestDigest: string;
  kind: "createAttempt" | "authorTool" | "freeze" | "revoke" | "destroy" | "invoke" | "renew" | "browserOp" | "collectOutputs";
  taskId: string;
  attemptId?: string;
  generation?: number;
  /** intent: recorded, not yet answered; acked: answered; failed: definitively refused (4xx); unknown: outcome uncertain. */
  state: "intent" | "acked" | "failed" | "unknown";
  createdAt: string;
  settledAt?: string;
  error?: string;
  /** Set by a recovering run: what the supervisor reported for this operation's attempt. */
  reconciledAt?: string;
  reconciliation?: string;
}

/** Called right after the intent row is written and before the request is sent. */
export type JournalHooks = { onIntent?: (operation: Operation) => Promise<void> | void };

export type Journal = <T>(kind: OperationRecord["kind"], ref: AttemptRef | null, call: (opts: CallOptions) => Promise<T>, hooks?: JournalHooks) => Promise<T>;

export interface JournalOptions {
  store: Store;
  owner: string;
  taskId: string;
  now: () => number;
  /** Backoff before each retry of a call refused with 429 (capacity); its length is the retry count. */
  capacityRetryDelaysMs: number[];
}

export function createJournal(options: JournalOptions): Journal {
  const once = journalOnce(options);
  return async (kind, ref, call, hooks) => {
    for (let i = 0; ; i++) {
      try {
        return await once(kind, ref, call, hooks);
      } catch (error) {
        const delay = options.capacityRetryDelaysMs[i];
        if (!(error instanceof SupervisorCapacityError) || delay === undefined) throw error;
        log.warn("supervisor at capacity; retrying", { taskId: options.taskId, kind, retry: i + 1, delayMs: delay });
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  };
}

function journalOnce({ store, owner, taskId, now }: JournalOptions): Journal {
  const iso = () => new Date(now()).toISOString();
  return async (kind, ref, call, hooks) => {
    let row: OperationRecord | null = null;
    const opts: CallOptions = {
      beforeSend: async (operation: Operation) => {
        row = {
          id: operation.operationId,
          operationId: operation.operationId,
          requestDigest: operation.requestDigest,
          kind,
          taskId,
          ...(ref ? { attemptId: ref.attemptId, generation: ref.generation } : {}),
          state: "intent",
          createdAt: iso(),
        };
        await store.put(owner, STORE_KIND_OPERATIONS, row);
        await hooks?.onIntent?.(operation);
      },
    };
    try {
      const result = await call(opts);
      const settled = row as OperationRecord | null;
      if (settled) await store.put(owner, STORE_KIND_OPERATIONS, { ...settled, state: "acked", settledAt: iso() }).catch((e) => log.warn("operation journal update failed", { taskId, kind, error: e }));
      return result;
    } catch (error) {
      const settled = row as OperationRecord | null;
      if (settled) {
        const definitive = error instanceof SupervisorError && error.status >= 400 && error.status < 500;
        await store
          .put(owner, STORE_KIND_OPERATIONS, { ...settled, state: definitive ? "failed" : "unknown", settledAt: iso(), error: errorMessage(error).slice(0, 500) })
          .catch((e) => log.warn("operation journal update failed", { taskId, kind, error: e }));
      }
      throw error;
    }
  };
}

export type TeardownOutcome = { clean: boolean; detail: string; data?: Record<string, unknown>; egressSummary?: { allowed: number; denied: number } };

/**
 * Best-effort teardown of an attempt: revoke then destroy. Unknown attempts count as gone.
 * Teardown may run twice on cancellation (the aborted run's failure path, then the worker's cancel
 * pass): the supervisor fences the repeat with 409 because the identity is tombstoned. That is
 * only "clean" when the supervisor's own journal says the attempt is `destroyed` (which it sets
 * only after a clean teardown); any other fenced state stays visible as incomplete.
 */
export async function teardownAttempt(supervisor: SupervisorClient, ref: AttemptRef, journal: Journal): Promise<TeardownOutcome> {
  const confirmedDestroyed = async (): Promise<boolean> => {
    try {
      const state = await supervisor.getAttempt(ref.attemptId);
      return state.ref.taskId === ref.taskId && state.status === "destroyed";
    } catch (error) {
      return error instanceof SupervisorNotFoundError;
    }
  };
  let revoked = "revoked";
  try {
    await journal("revoke", ref, (opts) => supervisor.revoke({ ref }, opts));
  } catch (error) {
    if (error instanceof SupervisorNotFoundError) return { clean: true, detail: "attempt unknown to supervisor (already destroyed)" };
    if (error instanceof SupervisorFenceError && (await confirmedDestroyed())) return { clean: true, detail: "attempt already destroyed (supervisor journal status: destroyed)" };
    revoked = `revoke failed: ${errorMessage(error)}`;
  }
  try {
    const result = await journal("destroy", ref, (opts) => supervisor.destroy({ ref }, opts));
    return {
      clean: result.teardown.clean,
      detail: `${revoked}; destroyed; remaining containers=${result.teardown.containersRemaining.length} volumes=${result.teardown.volumesRemaining.length}`,
      // Other tasks' containers and volumes in the host-wide listing are anonymised before storing.
      data: { teardown: redactTeardown(result.teardown, new Set([ref.taskId])), ...(result.egressSummary ? { egressSummary: result.egressSummary } : {}) },
      ...(result.egressSummary ? { egressSummary: result.egressSummary } : {}),
    };
  } catch (error) {
    if (error instanceof SupervisorNotFoundError) return { clean: true, detail: `${revoked}; attempt unknown to supervisor (already destroyed)` };
    if (error instanceof SupervisorFenceError && (await confirmedDestroyed())) return { clean: true, detail: `${revoked}; attempt already destroyed (supervisor journal status: destroyed)` };
    return { clean: false, detail: `${revoked}; destroy failed: ${errorMessage(error)}` };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
