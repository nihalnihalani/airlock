# apps/supervisor — third-party attribution (partial; merged into THIRD_PARTY_NOTICES.md by the lead)

Both upstreams are MIT. Notices are preserved in the file headers listed below.

- OpenBot — pin `3c73cf00efba46122dfd0447485e2b61f1d6a2cd` — MIT, Copyright (c) 2026 CopilotKit
- OpenMuse — pin `205cc386b75aae1a862f3fdd43104b570c8d0911` — MIT, Copyright (c) 2026 OpenMuse contributors

| Airlock file | Upstream path | Modifications |
|---|---|---|
| `apps/supervisor/src/names.ts` | OpenBot `supervisor/src/names.ts` | Bot id → (taskId, attemptId, role) triple and operation ids; derived container/volume/collector names; labels `airlock.supervisor/namespace/task/attempt/role/operation`; namespace from `AIRLOCK_NAMESPACE`; `ours()` requires the namespace label (no default-namespace adoption); `ownedFilter()` added. |
| `apps/supervisor/src/docker-api.ts` | OpenBot `supervisor/src/docker.ts` (design: narrow vocabulary, no passthrough) | Reduced to an interface over dockerode so the lifecycle can be tested against a fake; no ensure/reset/healthcheck/port publishing/SPIRE. |
| `apps/supervisor/src/runtime.ts` | OpenBot `supervisor/src/docker.ts` (dockerode verbs, tolerated 304/404/409, ownership on inspect); OpenMuse `apps/server/src/computer.ts` ~L200–320 (create flags and effective-config inspection, fail closed) | dockerode instead of the docker CLI; per-attempt disposable identity; `Runtime` set from `AIRLOCK_RUNTIME` and verified on inspection; guest `uname`/`hostname` read via exec; image digest recorded; caps from the profile; env allowlist widened for the python image; read-only `/candidate` mount variant for the collector; no `RestartPolicy unless-stopped`, no port bindings, no `ShmSize`. |
| `apps/supervisor/src/exec.ts` | OpenMuse `apps/server/src/computer.ts` ~L590–750 (`execute`: timeout wrapper argv, quarantine on timeout/interruption, receipt statuses) | Runs through the Docker exec API with a multiplexed-stream demuxer instead of spawning the docker CLI; combined output cap per profile with `truncated`; `controlLost` flag drives the caller's stop-and-quarantine; exit 124 → `timed_out`; unknown exit → `interrupted`, never a receipt. |
| `apps/supervisor/src/errors.ts` | OpenBot `supervisor/src/docker.ts` (`NameHeldError`, `DockerUnavailableError`) | Single `SupervisorError` with a code → HTTP status table. |
| `apps/supervisor/src/index.ts` | OpenBot `supervisor/src/index.ts` | Bun + Hono, bearer auth except `/health`, refusal to start without the token retained; routes replaced by the Airlock attempt/invoke/hostile API; constant-time token compare; body size bound and request-digest verification; runtime/dev-unsafe startup checks; graceful shutdown. |
| `apps/supervisor/src/lifecycle.ts` | OpenMuse `apps/server/src/computer.ts` (record-before-dispatch, lease re-check before exec, stop-and-quarantine on lost exec, stop `--time 2`) | New: per-attempt lock, revoke signal, absolute-deadline timer, freeze ordering (revoke → stop → settle → inspect stopped → collector), tombstones, janitor/reconcile, teardown listing. No DB lease/CAS; the sqlite journal replaces OpenMuse Store. |

Files written from scratch (no upstream code): `config.ts`, `tar.ts`, `host.ts`, `probe.ts`, `profiles.ts`, `operations.ts`, `invoke.ts`, `hostile.ts`, `types.ts`, all of `test/`.
