# @airlock/control — the control plane (VM A)

Owns task identity, contracts, phases, budgets and export authorization. Talks to the supervisor
(VM B) over its private HTTP API and to Vultr Serverless Inference for the repair model. It never
runs candidate code and never holds a Docker socket.

```
bun run --cwd apps/control dev      # watch mode
bun run --cwd apps/control start
bun test                            # from apps/control
bunx tsc --noEmit -p tsconfig.json  # from apps/control
```

## Environment

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `SUPERVISOR_TOKEN` | yes (≥16 chars) | — | Bearer secret for the supervisor API. Refuses to start without it. |
| `SUPERVISOR_URL` | no | `http://127.0.0.1:4300` | Supervisor base URL (VPC address in a deployment). |
| `AIRLOCK_MODEL_DRIVER` | no | `vultr` | `vultr` for live inference, or `scripted:<path>` to a JSON script file or a directory of `<name>.json` scripts for diagnostics and tests (see `src/scripted.ts`). Every task gets a fresh driver; with a directory a task may pick its script with `CreateTaskRequest.scriptedDriver` (422 in `vultr` mode). A scripted run is labelled `scripted:<name>` on every model event and is never a live repair. |
| `VULTR_INFERENCE_API_KEY` | with `vultr` | — | Never logged, never in an event, never in a sandbox. |
| `VULTR_INFERENCE_BASE_URL` | no | `https://api.vultrinference.com/v1` | Must be https. |
| `AIRLOCK_MODEL` | with `vultr` | — | Model name chosen by the measured tool-call probe. |
| `AIRLOCK_MODEL_MAX_TOKENS` | no | `16384` | `max_tokens` per model turn (256–131072). Reasoning tokens count against it: glm-5.3 spent a whole 4096-token turn thinking in the first live gate, so the default is generous. |
| `AIRLOCK_MODEL_REASONING_EFFORT` | no | unset | Sent as `reasoning_effort` only when set (e.g. `low`, `medium`, `high`); Vultr accepted it on 2026-09-26. |
| `AIRLOCK_DATA_DIR` | no | `./data` | PGlite database (`pglite/`) and content-addressed artifacts (`artifacts/`). |
| `AIRLOCK_PROFILES_DIR` | no | `<repo>/profiles` | Profiles; each needs a verified `base/` tree (see below). |
| `AIRLOCK_RUNTIME_DIR` | no | `<repo>/runtime/python` | Where `adapter.py` lives (part of the adapter digest). |
| `AIRLOCK_OPERATOR_PASSWORD` / `AIRLOCK_JUDGE_PASSWORD` | no (≥8 chars, must differ) | — | Role passwords. Without both, no one can sign in and no task data is readable. |
| `PORT` / `CONTROL_BIND` | no | `3000` / `0.0.0.0` | Listener. |
| `AIRLOCK_WEB_DIST` | no | `<repo>/apps/web/dist` | Built web UI served at `/` (SPA fallback to `index.html`); `/api/*` always takes precedence. Unset and missing → only `/api` is served (logged). `none` disables. |
| `AIRLOCK_INSECURE_COOKIES` | no | unset | `1` drops the cookie `Secure` flag for plain-http local development only. |
| `AIRLOCK_TRUST_PROXY` | no | unset | Set it when a reverse proxy fronts this process. `1` trusts a proxy on this host (loopback peer); otherwise a comma-separated list of the proxies' IP addresses as seen as socket peers. Only a request whose socket peer is a listed proxy has its `X-Forwarded-For` (rightmost hop) / `X-Real-IP` honoured by the login rate limit; a request from any other peer, or from an unknown peer, is keyed on its own peer address whatever headers it carries. Unset, every client behind a proxy collapses to the proxy's address, i.e. one shared 10/min login bucket. Bind or firewall port 3000 so that only the proxy reaches it. |
| `AIRLOCK_SESSION_TTL_MS`, `AIRLOCK_EXPORT_GRANT_TTL_MS`, `AIRLOCK_HOSTILE_MIN_INTERVAL_MS`, `AIRLOCK_PREVIEW_MIN_INTERVAL_MS` | no | 12 h, 24 h, 10 s, 2 s | Lifetimes and the per-session hostile-run and preview rate limits. |
| `AIRLOCK_LOG_LEVEL` | no | `info` | `error`, `warn`, `info` or `debug`. One JSON object per line (`{ts, level, app: "control", msg, ...}`) on stdout (warn/error on stderr). `debug` adds every HTTP request/response (method, path, status, duration, role, body sizes; never a body), worker lease claims/releases, phase transitions, every model call (model, host, finish_reason, prompt/completion/reasoning tokens, tool names, duration), every supervisor-client call (operation id, endpoint, status, duration, fence errors), SSE subscribe/replay/close and export grant creation. Field names that look like credentials are redacted; the supervisor token, inference key, passwords, session tokens and cookies are never logged. `./run.sh` defaults it to `debug`. |

Start-up refuses on a missing token, a missing key for the vultr driver, an unreadable profiles
directory, or zero usable profiles. An unreachable supervisor is logged; tasks fail until it is up.

## Profiles

`loadProfiles(dir)` reads `profiles/<id>/profile.json` and `contract.json`, computes
`contractDigest = sha256(canonicalJson(contract))`, and verifies `profiles/<id>/base/` against
`profile.baselineTreeDigest` with the same recipe as `runtime/python/tree_digest.py`
(`path sha256\n` lines ordered by `(casefold, path)`, symlinks to regular files included by their
target bytes). A profile whose base is missing or tampered is skipped with the reason logged;
tasks cannot be created for it. `baseFiles` holds the text of the allowed and readable base files
and is the diff base for export. The adapter digest is
`sha256(runtime/python/adapter.py ++ profiles/<id>/<adapterModule>.py)`.

## Routes (`/api`)

Cookie `airlock_session` (HttpOnly, SameSite=Strict, sha256 of the token stored). Roles:
`operator`, `judge`, and `viewer` (signed out: profiles, host check and login only; no task data).
A role is never an owner: every login is its own principal (`<role>-<random>`), so two judges who
share the judge password cannot read each other's cases; after logout or expiry that principal's
cases stay readable to the operator only. A task that is not the caller's reads as 404. Sessions
written before this rule (owner equal to the role) are refused. Errors are JSON `{error}`.
`referenceCommitMaintainerOnly` is stripped from every response.

| Route | Role | Notes |
|---|---|---|
| `POST /api/session {password}` → `{role}` | any | Login; rate limited per client (10/min), keyed on the socket peer address, or on the proxy's `X-Forwarded-For` hop when the peer is a proxy listed in `AIRLOCK_TRUST_PROXY`; a client-supplied header never opens a fresh budget, including on a direct connection that bypasses the proxy. `DELETE` logs out; `GET` returns the current role. |
| `GET /api/profiles` | any | `ProfileManifest[]` without the maintainer commit. |
| `GET /api/host` | any | Supervisor `HostCheck`. |
| `POST /api/tasks` `CreateTaskRequest` → `Task` (201) | operator, judge | Profile must be loaded (422 otherwise). |
| `GET /api/tasks`, `GET /api/tasks/:id` | owner or operator | List (a judge gets its own session's tasks, the operator all) / `TaskView` (task, baseline and candidate records, sealed manifest, host). |
| `GET /api/tasks/:id/events` | owner or operator | SSE of `RunEvent` (`id` = seq, `event` = kind), replayed after `Last-Event-ID` (or `?after=`), plus `task` snapshots and a final `end`. Carries every model turn and each `run` command's stdout/stderr (bounded). The session is re-checked before every delivery; a stream closes when its session is logged out or expires. |
| `POST /api/tasks/:id/cancel` → `Task` | owner or operator | queued with no attempt → cancelled; queued that still names an attempt (requeued after a lost lease), or running → cancelling (the worker's cancel pass revokes and confirms teardown); terminal → 409. |
| `POST /api/tasks/:id/preview` `PreviewRequest` → `PreviewResult` | owner or operator | Refused (409) unless `candidateDigest` equals the task's sealed digest, the verification record passed, and the stored bundle still carries that digest. Runs a fresh `preview` invocation on the sealed bundle; writes nothing. One per 2 s per session (429). |
| `POST /api/tasks/:id/export` → `{grantId,url,expiresAt,zipDigest}` | owner or operator | Only for `CANDIDATE_PASSED_CHECKS` with a passing candidate record for the sealed digest and a passing baseline record under the same contract and adapter (409 otherwise). The first export seals the zip once (`ExportSeal`: zip sha256, verification and baseline record digests, events through a fixed seq; grant events excluded) and stores it content-addressed. The immutable `ExportGrant` binds the verification record digest and the sealed zip digest; repeated calls return the same unexpired grant. |
| `GET /api/exports/:grantId` | the granting owner | Re-checks eligibility, then serves the sealed zip byte for byte (re-hashed on read; `x-airlock-zip-sha256`): `patch.diff`, `manifest.json`, `verification.json`, `baseline.json`, `task.json` (the task record with lease fields removed: owner, issue text, budget, `scriptedDriver` on diagnostic runs), `events.jsonl` (the run event log through the seal, including every model turn's text and every command run), `reproduction/`, `README.txt`. Repeatable, identical across grants and restarts; 410 when expired or when the grant predates sealed exports. |
| `POST /api/hostile {command, profileId?}` → `BlastRadiusCard` | judge, operator | One per 10 s per session. |

## Phases and outcomes

The `TaskWorker` (adapted from OpenMuse) leases a `queued` task by compare-and-swap, heartbeats the
lease, and runs the `RepairHandler`:

1. **prepare** — load profile + contract, compute contract and adapter digests, fetch the host check.
   A stale attempt from an earlier run is destroyed; a sealed candidate resumes at verify.
2. **reproduce** — create the author sandbox (`repairAttemptsUsed` +1, bounded by
   `caps.maxRepairAttempts`). Inspection must pass and the isolation probe must be fully BLOCKED.
3. **baseline** — invoke all contract cases on the pristine tree; `compare()` must show the
   reported failure. Otherwise **NOT_REPRODUCED** (measured, different behaviour) or
   **INCONCLUSIVE** (incomplete measurement) and stop.
4. **repair** — one model loop with `read_file` (whole file or a `start_line`/`end_line` range, with
   the total line count; a large file is cut on a line boundary with a paging note), `edit_file`
   (replace exactly one occurrence of `old_text`; the current bytes are read back through the
   supervisor, 0 or >1 matches are refused), `write_file`, `run`, `submit_candidate`, each bound to
   the attempt through the supervisor. Tool errors return to the model as tool results. Ends on
   `submit_candidate`, `caps.maxModelCalls` / `attemptTimeoutMs` (**STOPPED_LIMIT**), or the model
   giving up (**REPRODUCED_UNRESOLVED**). The driver's `finish_reason` steers the loop: a turn cut
   by `max_tokens` (`length`) with no tool call is answered with "take the next action now" and is
   not counted as giving up, but three such turns in a row end as **STOPPED_LIMIT**; a tool call
   whose arguments were cut off gets a tool result saying so (not a schema error); an ordinary
   text-only turn gets one nudge to call `submit_candidate` before the gave-up count starts. Every
   model event records `finishReason`, `maxTokens`, `reasoningTokens` and a 600-char `reasoning`
   excerpt so the UI can show why a turn produced nothing.
5. **freeze** — supervisor freeze (revoke → stop → settle → collect), `validateEnvelope`,
   `buildManifest`, `candidateDigestOf`; bundle stored immutably; `task.candidateDigest` set;
   author sandbox destroyed. An unconfirmed stop is **INCONCLUSIVE**; a rejected envelope is
   **CHECKS_FAILED**.
6. **verify** — fresh `candidate` invocation with the bundle, `compare()`, immutable verification
   record → **CANDIDATE_PASSED_CHECKS** or **CHECKS_FAILED**.
7. **ready**.

The model never sets the outcome; only `compare()` results and budget/deadline logic do. Every
phase change, tool call, exec, model turn and lifecycle step is an appended `RunEvent` with bounded
detail. Cancellation moves the task to `cancelling` and aborts the in-process run; the worker then
claims it in cancel mode and revokes + destroys the attempt before recording `cancelled`. If the
supervisor cannot confirm the teardown (unreachable, stop not confirmed) the task **stays
`cancelling`**: the lease is released with a retry-after (5 s) and a later tick runs the cancel
pass again, up to 5 retries counted from the durable `runs` records. Only a confirmed teardown
records `cancelled`; past the bound the task is recorded `failed` with the incomplete-teardown
error and its `attemptId` kept, never a `cancelled` receipt. A cancel that arrives while a one-shot
`baseline`/`candidate` invocation is running does not abort the supervisor call (that would drop
only the client side): the invocation finishes within its own deadline, its teardown is recorded as
"<role> invocation finished after cancellation", its observations are discarded, and only then does
the cancel pass run. Any failure destroys the attempt; incomplete teardown stays visible on the task.

## Driver modes

- `vultr` — `createVultrDriver` against Serverless Inference (chat completions with forced tools).
- `scripted:<path>` — `createScriptedDriver` replays a JSON `[{ "text"?, "toolCalls"?: [{name,args}] }]`
  file. Used by the vertical-slice diagnostic and by tests; never a claim of a live repair.

## Tests

`bun test` uses an in-memory PGlite store, an in-memory fake supervisor and thin doubles for the
verifier/artifacts modules. Covered: happy path, unchanged-tree submit, forged "all tests passed"
log, NOT_REPRODUCED, INCONCLUSIVE, STOPPED_LIMIT, REPRODUCED_UNRESOLVED, cancel mid-repair with
destroy, sandbox refusal, freeze without confirmed stop, stale-attempt discard, event bounds, SSE
replay, preview refusals (digest mismatch, unverified, tampered bundle), immutable and repeatable
export grants, hostile rate limit, session roles, supervisor-client operation replay and fence
errors, profile digest verification, worker lease/cancel semantics.
