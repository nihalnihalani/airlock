# Third-party notices

Airlock adapts code and design from two MIT-licensed repositories. Every copied or adapted file is listed here with its upstream pin, path and what changed, so "built at the event vs reused" is reconstructible from this file plus git history. Upstream MIT notices are preserved in the headers of the adapted files.

- **OpenMuse** — pin `205cc386b75aae1a862f3fdd43104b570c8d0911` — MIT License, Copyright (c) 2026 OpenMuse contributors — https://github.com/CopilotKit/openmuse
- **OpenBot** — pin `3c73cf00efba46122dfd0447485e2b61f1d6a2cd` — MIT License, Copyright (c) 2026 CopilotKit — https://github.com/CopilotKit/openbot

Local clones at those pins live in `research/reference-repos/` (gitignored). Neither complete upstream application is deployed or used as a composition root; both require the hosted CopilotKit Intelligence service, which Airlock does not depend on.

## apps/supervisor (execution plane)

| Airlock file | Upstream path | Modifications |
|---|---|---|
| `apps/supervisor/src/names.ts` | OpenBot `supervisor/src/names.ts` | Bot id → (taskId, attemptId, role) triple and operation ids; derived container/volume/collector names; labels `airlock.supervisor/namespace/task/attempt/role/operation`; namespace from `AIRLOCK_NAMESPACE`; `ours()` requires the namespace label (no default-namespace adoption); `ownedFilter()` added. |
| `apps/supervisor/src/docker-api.ts` | OpenBot `supervisor/src/docker.ts` (design: narrow vocabulary, no passthrough) | Reduced to an interface over dockerode so the lifecycle can be tested against a fake; no ensure/reset/healthcheck/port publishing/SPIRE. |
| `apps/supervisor/src/runtime.ts` | OpenBot `supervisor/src/docker.ts` (dockerode verbs, tolerated 304/404/409, ownership on inspect); OpenMuse `apps/server/src/computer.ts` ~L200–320 (create flags and effective-config inspection, fail closed) | dockerode instead of the docker CLI; per-attempt disposable identity; `Runtime` set from `AIRLOCK_RUNTIME` and verified on inspection; guest `uname`/`hostname` read via exec; image digest recorded; caps from the profile; env allowlist widened for the python image; read-only `/candidate` mount variant for the collector; no `RestartPolicy unless-stopped`, no port bindings, no `ShmSize`. |
| `apps/supervisor/src/exec.ts` | OpenMuse `apps/server/src/computer.ts` ~L590–750 (`execute`: timeout wrapper argv, quarantine on timeout/interruption, receipt statuses) | Runs through the Docker exec API with a multiplexed-stream demuxer instead of spawning the docker CLI; combined output cap per profile with `truncated`; `controlLost` flag drives the caller's stop-and-quarantine; exit 124 → `timed_out`; unknown exit → `interrupted`, never a receipt. |
| `apps/supervisor/src/errors.ts` | OpenBot `supervisor/src/docker.ts` (`NameHeldError`, `DockerUnavailableError`) | Single `SupervisorError` with a code → HTTP status table. |
| `apps/supervisor/src/index.ts` | OpenBot `supervisor/src/index.ts` | Bun + Hono, bearer auth except `/health`, refusal to start without the token retained; routes replaced by the Airlock attempt/invoke/hostile API; constant-time token compare; body size bound and request-digest verification; runtime/dev-unsafe startup checks; graceful shutdown. |
| `apps/supervisor/src/lifecycle.ts` | OpenMuse `apps/server/src/computer.ts` (record-before-dispatch, lease re-check before exec, stop-and-quarantine on lost exec, stop `--time 2`) | New: per-attempt lock, revoke signal, absolute-deadline timer, freeze ordering (revoke → stop → settle → inspect stopped → collector), tombstones, janitor/reconcile, teardown listing. No DB lease/CAS; the sqlite journal replaces OpenMuse Store. |

Written from scratch (no upstream code): `config.ts`, `tar.ts`, `host.ts`, `probe.ts`, `profiles.ts`, `operations.ts`, `invoke.ts`, `hostile.ts`, `types.ts`, all of `apps/supervisor/test/`.

## apps/control (control plane)

| Airlock file | Upstream path | Modifications |
|---|---|---|
| `apps/control/src/store/index.ts` | OpenMuse `apps/server/src/db.ts` | PGlite only (`pg` pool, `claim`, `recoverInterruptedActions`, `updateCredential` removed). Added `insertImmutable` (INSERT … ON CONFLICT DO NOTHING RETURNING → boolean), an append-only `events` table with `appendEvent` (per-task monotonic `seq` assigned in the INSERT) and `listEvents(taskId, afterSeq)`, `scanWhere`, and an `unset` key list on `compareAndSwap`. |
| `apps/control/src/worker/index.ts` | OpenMuse `apps/server/src/engine/worker.ts` | Typed to the contracts `Task`/`TaskStatus`; `scheduled`/`waiting_approval`/action-expiry branches removed. `cancelling` tasks are claimed only to run the cancellation path; lost lease on `cancelling` releases the lease instead of requeueing. Events via `Store.appendEvent` plus an in-process bus; `splitPatch` for key removal; `backgroundFailure` moved in from `log.ts`. `LostLeaseError` semantics unchanged. |
| `apps/control/src/sessions.ts` | OpenMuse `apps/server/src/auth.ts` | Hashed-token idea only (store sha256(token), never the token). Rewritten for two role passwords + a viewer role, an HttpOnly cookie instead of a bearer header, a login rate limiter; HMAC-signed document links removed. |
| `apps/control/src/api.ts` | OpenMuse `apps/server/src/engine/routes.ts`, `apps/server/src/errors.ts` | `AppError` shape and task-route layout; all routes, role checks, ownership checks, SSE replay, preview/export/hostile are Airlock code. |
| `apps/control/src/repair-handler.ts` | OpenMuse `apps/server/src/engine/model.ts` | Pattern only (guard before every tool, serial tool dispatch, schema-validated arguments, tool errors fed back as results). No code copied: the tool inventory, AG-UI runtime and model-owned finish semantics are replaced by the deterministic phase machine. |

No files under `apps/control` copy OpenBot code. `verifier/`, `artifacts/`, `vultr-client.ts`, `vultr-probe.ts`, `profiles.ts`, `config.ts`, `events.ts`, `prompts.ts`, `supervisor-client.ts` and `scripts/probe-model.ts` are new Airlock code (OpenMuse `engine/model.ts` is built on CopilotKit/AG-UI and was not reusable for a chat-completions driver).

## apps/web

All new Airlock code; nothing copied or adapted from either upstream.

## runtime/python and profile adapters

No source code in `runtime/python/` or `profiles/tabulate-365/airlock_adapter_tabulate.py` is copied from either upstream. Design ideas taken, with no code carried over:

| Airlock file | Upstream path | Modifications |
|---|---|---|
| `runtime/python/collector.py` | OpenBot `agent-computer/src/workspace.ts` (three-layer path confinement idea; bounded read limits) | Re-implemented in Python. Exact allowlist instead of workspace-relative resolution; symlink check at every component via `lstat`; hard-link, special-file and TOCTOU (`fstat` inode match) checks added; reads stream in 64 KiB chunks with a cap instead of reading the whole file before truncating. |
| `runtime/python/materialize.py` | OpenBot `agent-computer/src/workspace.ts` (write confinement idea) | Re-implemented in Python for a fixed base → target copy plus allowlisted overlay; no code reused. |
| `runtime/python/Dockerfile` | OpenMuse `apps/server/src/computer.ts` (idle `sleep infinity` sandbox process, non-root / read-only expectations) | Different image and layout; no code reused. |

## packages/contracts

New Airlock code. The `plainId` identifier discipline derives from OpenBot `supervisor/src/names.ts` (letters, digits, hyphen, underscore; identifiers are validated before they become any kind of name).

## python-tabulate (profile `tabulate-365`)

MIT License, Copyright (c) 2011-2020 Sergey Astanin and contributors. https://github.com/astanin/python-tabulate

`profiles/tabulate-365/base/` is the pristine tracked tree at `e13a4d0dd292cade200e653eb9155a1ca0f1dbea`, produced by `runtime/python/prepare-profile.sh` (`git archive`, no `.git`) and verified against `baselineTreeDigest`. It is the untrusted candidate base for the historical replay and is copied unchanged into the runtime image at `/opt/airlock/base/`. It is not part of Airlock's codebase; its `LICENSE` file is included in the tree. The maintainer reference commit `87a9a4e07a5efb39b81fdb6ac513b1d345bb21fb` was used only to measure the acceptance contract and is never supplied to any sandbox.

## Runtime base image

`python:3.12-slim` (Docker Official Image; Python is PSF-licensed, Debian components under their respective licenses). The digest observed at build time is recorded in `runtime/python/Dockerfile`.
