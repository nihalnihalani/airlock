# apps/control — third-party attribution (partial, merged into THIRD_PARTY_NOTICES.md by the lead)

## OpenMuse — `205cc386b75aae1a862f3fdd43104b570c8d0911`
MIT License, Copyright (c) 2026 OpenMuse contributors. https://github.com/CopilotKit/openmuse

| Airlock file | Upstream path | Modifications |
|---|---|---|
| `apps/control/src/store/index.ts` | `apps/server/src/db.ts` | PGlite only (`pg` pool, `claim`, `recoverInterruptedActions`, `updateCredential` removed). Added `insertImmutable` (INSERT … ON CONFLICT DO NOTHING RETURNING → boolean), an append-only `events` table with `appendEvent` (per-task monotonic `seq` assigned in the INSERT) and `listEvents(taskId, afterSeq)`, `scanWhere`, and an `unset` key list on `compareAndSwap`. |
| `apps/control/src/worker/index.ts` | `apps/server/src/engine/worker.ts` | Typed to the contracts `Task`/`TaskStatus`; `scheduled`/`waiting_approval`/action-expiry branches removed. `cancelling` tasks are claimed only to run the cancellation path (`context.mode === "cancel"`, status stays `cancelling`); lost lease on `cancelling` releases the lease instead of requeueing. Events via `Store.appendEvent` plus an in-process bus; `splitPatch` for key removal; `backgroundFailure` moved in from `log.ts`. `LostLeaseError` semantics unchanged. |
| `apps/control/src/sessions.ts` | `apps/server/src/auth.ts` | Hashed-token idea only (store sha256(token), never the token). Rewritten for two role passwords + a viewer role, an HttpOnly cookie instead of a bearer header, a login rate limiter; HMAC-signed document links removed. |
| `apps/control/src/api.ts` | `apps/server/src/engine/routes.ts`, `apps/server/src/errors.ts` | `AppError` shape and task-route layout; all routes, role checks, ownership checks, SSE replay, preview/export/hostile are Airlock code. |
| `apps/control/src/repair-handler.ts` | `apps/server/src/engine/model.ts` | Pattern only (guard before every tool, serial tool dispatch, schema-validated arguments, tool errors fed back as results). No code copied: the tool inventory, AG-UI runtime and model-owned finish semantics are replaced by the deterministic phase machine. |

## OpenBot — `3c73cf00efba46122dfd0447485e2b61f1d6a2cd`
MIT License, Copyright (c) 2026 CopilotKit. https://github.com/CopilotKit/openbot

No files under `apps/control` copy OpenBot code. The `plainId` identifier discipline in
`supervisor-client.ts` follows the contracts package, which derives it from OpenBot `names.ts`.
