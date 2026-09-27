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
| `VULTR_INFERENCE_BASE_URL` | no | `https://api.vultrinference.com/v1` | Pinned: any other value is refused at start-up, unless `AIRLOCK_ALLOW_TEST_INFERENCE_URL=1` (https only, logged as not Vultr), and never with `AIRLOCK_PRODUCTION=1`. The live driver's transport never follows a redirect (`redirect: "error"`) and refuses any URL outside this base. Tests inject a fake driver or transport instead. |
| `AIRLOCK_ALLOW_TEST_INFERENCE_URL` | no | unset | `1` permits a non-Vultr https inference URL for testing. Refused in production. |
| `AIRLOCK_PRODUCTION` | no | unset (deploy.sh: `1`) | `1` marks a deployment: test-only overrides are refused; new tasks are refused (503) while the supervisor is dev-unsafe or on `runc`; a record measured dev-unsafe or on `runc` is never a verdict, previewed or exported; export also requires a fully BLOCKED isolation probe on both records. A scripted default driver is still allowed (labelled diagnostics). |
| `AIRLOCK_DIAGNOSTIC_SCRIPTS_DIR` | no | unset (dev-up: `apps/control/test/fixtures/scripted`) | Directory of labelled diagnostic scripts (`<name>.json`, optional `title`/`description`) that an operator or judge may launch with `scriptedDriver` **whatever the model driver**. Such tasks carry `task.scriptedDriver`, are labelled diagnostic in their events, and never count as model repairs. |
| `AIRLOCK_GENERAL_DIAGNOSTIC_SCRIPTS_DIR` | no | unset | Labelled scripted diagnostics for **general** tasks (e.g. `apps/control/test/fixtures/scripted-general`), merged into the diagnostics catalog; a general task selects one with `scriptedDriver`. Never a model run. |
| `AIRLOCK_MODEL_VISION` | no | unset | `1` marks the configured model as vision-capable: general tasks attach each screenshot (PNG) to the next model turn as an `image_url` content part. Set it only after `bun scripts/probe-model.ts --vision <model>` passed (an actual image round trip). Unset: no image is ever sent. |
| `AIRLOCK_FORMS_ORIGINS` | no | unset | Comma-separated origins (`https://host[:port]`) of **supported final-action destinations**: services implementing the `airlock-forms-v1` adapter (apps/fixtures). Only forms there can be submitted, only through `browser_propose_submit` and a person's approval. Unset: every final action is unsupported. |
| `AIRLOCK_FORMS_SECRET` | with `AIRLOCK_FORMS_ORIGINS` | — | ≥ 32 chars, shared with the destination. The control plane mints one-use approval codes and the receipts read token from it; never logged, never in an event, never shown to the model or a page before approval. |
| `AIRLOCK_FIXTURES_ORIGIN` | no | unset | Public origin of the fixtures service; replaces `{{AIRLOCK_FIXTURES_ORIGIN}}` in scripted diagnostics (default `https://airlock-fixtures.example.com`). Its hostname, like each `AIRLOCK_FORMS_ORIGINS` hostname, is exempt from the wildcard-DNS refusal of `egressAllow` (below). |
| `AIRLOCK_PUBLIC_HOST` | no (set it in a deployment) | unset | Comma-separated hostname(s) (or origins) of this Airlock deployment. A general task's `egressAllow` may never name them, exactly or through a covering `.suffix`; the host a task-creating request was addressed to (URL host, `Host`, `X-Forwarded-Host`) is refused the same way even when this is unset. |
| `AIRLOCK_CONTROL_IDLE_MS` / `AIRLOCK_CONTROL_SETTLE_MS` / `AIRLOCK_PROPOSAL_TTL_MS` | no | 5 min / 10 s / 15 min | Human control returns to the agent after this long without a human action; how long a take waits for the in-flight browser op; lifetime of an action proposal and its approval code. |
| `AIRLOCK_LIVE_GATE_EVIDENCE_DIR` | no | `<repo>/docs/evidence/live-gate` | Committed `LiveGateReceipt` files. See *Repair availability*. |
| `AIRLOCK_INSTANCE_ID` | no | unset | Vultr instance id of this VM, reported by `GET /api/repair-availability` beside the execution host's. |
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
| `AIRLOCK_SESSION_TTL_MS`, `AIRLOCK_EXPORT_GRANT_TTL_MS`, `AIRLOCK_HOSTILE_MIN_INTERVAL_MS`, `AIRLOCK_HOSTILE_GLOBAL_MIN_INTERVAL_MS`, `AIRLOCK_PREVIEW_MIN_INTERVAL_MS` | no | 12 h, 24 h, 10 s, 3 s, 2 s | Lifetimes; the hostile-run limit per client key (the login limiter's key, so a re-login does not reset it) and between any two runs (plus one run at a time); the preview limit per session and per client key. |
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
`operator`, `judge`, and `viewer` (signed out: health, profiles, repair availability and login
only; no task data, no host check).
A role is never an owner: every login is its own principal (`<role>-<random>`), so two judges who
share the judge password cannot read each other's cases; after logout or expiry that principal's
cases stay readable to the operator only. A task that is not the caller's reads as 404. Sessions
written before this rule (owner equal to the role) are refused. Errors are JSON `{error}`.
`referenceCommitMaintainerOnly` is stripped from every response. Every response (API, errors,
SSE, export download, the static UI) carries `Content-Security-Policy: default-src 'self'; script-src
'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self';
object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`,
`X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`. The built UI has no inline
script; `'unsafe-inline'` for styles covers the `<style>` element Radix injects at runtime.

| Route | Role | Notes |
|---|---|---|
| `POST /api/session {password}` → `{role}` | any | Login; rate limited per client (10/min), keyed on the socket peer address, or on the proxy's `X-Forwarded-For` hop when the peer is a proxy listed in `AIRLOCK_TRUST_PROXY`; a client-supplied header never opens a fresh budget, including on a direct connection that bypasses the proxy. `DELETE` logs out; `GET` returns the current role and, when signed in, the caller's own opaque `owner` id (never anyone else's). |
| `GET /api/health` → `{ok:true}` | any | Liveness only; nothing else. |
| `GET /api/profiles` | any | `ProfileManifest[]` without the maintainer commit. |
| `GET /api/host` | operator, judge | Supervisor `HostCheck`. |
| `GET /api/repair-availability[?profileId=]` → `RepairAvailability` | any | Whether live repair is backed by evidence now, with the precise reason and the receipt summary; `instances {control, execution}` and `model` only to a signed-in session. Default profile: the first loaded. Re-evaluated per request. |
| `GET /api/diagnostics` → `{scripts:[{name,title,description}]}` | operator, judge | The labelled diagnostic scripts a task may name with `scriptedDriver`. |
| `POST /api/tasks` `CreateTaskRequest` → `Task` (201) | operator, judge | **`kind: "general"`**: `profileId` must be a general task profile (`analysis`, `web-research`, `web-analysis`; 422 otherwise); `issueText` is the goal; `inputArtifactIds` must be the caller's own uploads and the profile must accept uploads; `egressAllow` is required and non-empty for a browser profile (≤ 16 exact hosts or `.suffix`; IP literals, single-label names, `localhost`, `.internal`/`.local`/other special-use names and a bare TLD suffix are refused) and must be empty otherwise; `scriptedDriver` may name a labelled diagnostic. `egressAllow` also refuses this deployment's own host(s) (`AIRLOCK_PUBLIC_HOST` and the request's own host, exactly or under a `.suffix` entry) and names under wildcard-DNS services (`sslip.io`, `nip.io`, `xip.io`, `traefik.me`, `localtest.me`, `lvh.me`, exact or `.suffix`), except the exact hostnames of the configured `AIRLOCK_FIXTURES_ORIGIN` / `AIRLOCK_FORMS_ORIGINS` (an own-host match is refused even then). The task starts with `cleanup: {status: "none"}`. **Repair** (kind absent or `"repair"`, no general fields): profile must be loaded (422 otherwise). `scriptedDriver` must name a script in the diagnostics catalog (422 otherwise). With the live driver and repair unavailable, the task gets `repairDisabledReason` (reproduction and baseline only). A scripted-driver control plane labels every task with the script it runs. `liveGate: true` (operator only, never with a script; recorded on the task) exempts the task from the repair-disabled state: it is how `scripts/live-gate.ts` produces the evidence. |
| `GET /api/tasks`, `GET /api/tasks/:id` | owner or operator | List (a judge gets its own session's tasks, the operator all) / `TaskView` (task, baseline and candidate records, sealed manifest, host). |
| `GET /api/tasks/:id/events` | owner or operator | SSE of `RunEvent` (`id` = seq, `event` = kind), replayed after `Last-Event-ID` (or `?after=`), plus `task` snapshots and a final `end`. Carries every model turn and each `run` command's stdout/stderr (bounded). The session is re-checked before every delivery; a stream closes when its session is logged out or expires. |
| `POST /api/tasks/:id/cancel` → `Task` | owner or operator | queued with no attempt → cancelled; queued that still names an attempt (requeued after a lost lease), or running → cancelling (the worker's cancel pass revokes and confirms teardown); terminal → 409. |
| `POST /api/tasks/:id/preview` `PreviewRequest` → `PreviewResult` | owner or operator | Refused (409) unless `candidateDigest` equals the task's sealed digest, the verification record passed, and the stored bundle still carries that digest. Refused (409, "configuration changed since verification; preview refused") when the adapter digest recomputed from disk, the loaded contract digest, the supervisor's selected runtime, or its enforced runtime image id (when comparable) differs from the verification record; checked again after the run against the preview sandbox's own inspection (image digest and runtime). Runs a fresh `preview` invocation on the sealed bundle; writes nothing. One per 2 s per session and per client (429). |
| `POST /api/tasks/:id/export` (general) → `{grantId,url,expiresAt,zipDigest,outcome,partial}` | owner or operator | General tasks: only `RESULT_VERIFIED` or `RESULT_PARTIAL` (409 otherwise; `partial: true` and a `-partial.zip` name label the latter). Sealed once per (task, result digest) into a local `GeneralExportSeal`; grants are `GeneralExportGrant` records (the contract `ExportSeal`/`ExportGrant` are candidate-bound). Download via the same `GET /api/exports/:grantId`. Zip: `task.json` (profile id/version/tools/checks/budgets, input digests), `result.json`, `outputs/`, `code/`, `screenshots/` + `screenshots.json` (sha256, source URL, step), `page-text/`, `events.jsonl`, `identity.json` (model/host per turn, tools, sandbox runtimes), `egress.json`, `cleanup.json` (teardown receipts), `manifest.json`, `README.txt` with the completion checks. |
| `POST /api/tasks/:id/export` → `{grantId,url,expiresAt,zipDigest}` | owner or operator | Only for `CANDIDATE_PASSED_CHECKS` with a passing candidate record for the sealed digest and a passing baseline record under the same contract, adapter and runtime image, and no configuration drift since verification (same checks as preview; 409 otherwise). The first export seals the zip once (`ExportSeal`: zip sha256, verification and baseline record digests, events through a fixed seq; grant events excluded) and stores it content-addressed. The immutable `ExportGrant` binds the verification record digest and the sealed zip digest; repeated calls return the same unexpired grant. |
| `GET /api/exports/:grantId` | the granting owner | Re-checks eligibility, including drift (a sealed zip is not served while the running configuration differs from the verified one; restoring it makes the grant usable again), then serves the sealed zip byte for byte (re-hashed on read; `x-airlock-zip-sha256`): `patch.diff`, `manifest.json`, `verification.json`, `baseline.json`, `task.json` (the task record with lease fields removed: owner, issue text, budget, `scriptedDriver` on diagnostic runs), `events.jsonl` (the run event log through the seal, including every model turn's text and every command run), `reproduction/`, `README.txt`. Repeatable, identical across grants and restarts; 410 when expired or when the grant predates sealed exports. |
| `GET /api/task-profiles` | any | The general task profiles: tools, budgets, completion checks, whether uploads are accepted, max destinations. |
| `POST /api/uploads` (raw body, header `x-filename`) → `Artifact` (201) | operator, judge | The file bytes are the body (no multipart); `x-filename` carries the name (URI-encoding allowed). Media type sniffed from the bytes: PNG, JPEG, PDF, JSON, CSV (a `.csv` name that parses) or UTF-8 text; anything else 415. Name reduced to a safe basename with the sniffed extension. ≤ 10 MiB per file (413, streamed; never buffered past the cap); per session owner ≤ 20 uploads and ≤ 50 MiB (413). |
| `GET /api/uploads` → `{artifacts, quota}` | operator, judge | The caller's own uploads and quota use. |
| `GET /api/artifacts/:id` | owner or operator | Bytes of one artifact (404 for anyone else). Re-hashed on read; `content-type` = the stored type, `x-content-type-options: nosniff`, `cache-control: private, no-store`, `x-airlock-sha256`, and a stricter `content-security-policy` (`default-src 'none'; … sandbox`). `inline` disposition only for PNG/JPEG (`?download=1` forces attachment); everything else `attachment`. |
| `GET /api/tasks/:id/artifacts` → `Artifact[]` | owner or operator | The task's inputs, screenshots, saved page text (`download`) and collected outputs, with provenance (`source.url/step/tool/attemptId`). |
| `GET /api/tasks/:id/artifacts/:artifactId` | owner or operator | The same bytes, scoped to the task. |
| `GET /api/tasks/:id/control` → `{control, live, idleMs}` | owner or operator | General browser tasks. `control` is `Task.control` (`holder` agent/human/transferring, `humanOwner`, `since`, `fenceGeneration`, `reason`); `live` adds `epoch`, `liveBrowser`, `idleExpiresAt` while the run is attached. |
| `POST /api/tasks/:id/control/take` → `ControlState` | owner or operator | Running general browser task. `transferring` → agent dispatch revoked → waits ≤ `AIRLOCK_CONTROL_SETTLE_MS` for the in-flight op → `human` (caller's session owner, fence = current browser generation). Not settled: **409**, stays `transferring` (never dual control) until retried, released or idle-expired. Another session holding: 409. |
| `POST /api/tasks/:id/control/release` → `ControlState` | holder or operator | Back to `agent`; the agent must `browser_observe` before any ref-bound action. |
| `POST /api/tasks/:id/control/action {request}` → `{ok, artifactId?, result: BrowserOpResult}` | the human holder | `request` is a contracts `BrowserOp` (`HumanBrowserAction`) or `download.list` / `download.read {downloadId}` / `upload {ref, generation, artifactId}` (the caller's own artifact, sent as its recorded bytes). Same egress policy (422 before dispatch), deadline and browser-op budget as the agent; journaled through the supervisor; screenshots and downloads become artifacts (bytes stripped from `result`). Not the holder: 409. Never an approval. |
| `GET /api/tasks/:id/live` → `{frame, frames, control, liveBrowser, refreshMinIntervalMs}` | owner or operator | The newest screenshot artifact of the task (`frame.url` serves it). New frames are announced on the event stream (`artifact` events with `data.frame: true`). No debugger/CDP endpoint exists. |
| `POST /api/tasks/:id/live/refresh` → `{artifactId, url}` | owner or operator | A fresh read-only screenshot through the supervisor, serialized with the other browser ops, allowed whoever holds control, never starts a browser (409 without one); 1 per 2 s per task (429). Not counted against the agent's budget; not screenshot evidence. |
| `GET /api/tasks/:id/approvals` → `ActionProposal[]` | owner or operator | The task's proposals with status and receipt. |
| `POST /api/tasks/:id/approvals/:aid/decide {decision, payloadDigest}` → `ActionProposal` | owner or operator | Running task. `payloadDigest` must restate the proposal's digest (409 otherwise); one-use compare-and-swap `pending → approved/rejected` (a second decision: 409); expired: 410; another owner's task or an unknown id: 404. |
| `POST /api/hostile {command, profileId?}` → `BlastRadiusCard` | judge | One per 10 s per client key, one per 3 s overall, one at a time (429; the per-client memory is bounded by evicting expired, then least recently used keys, never by clearing it). The control plane fills `survived.controlPlane {healthyBefore, healthyAfter, checkedAt}`: a store query plus the worker heartbeat record being fresh (≤ 15 s), checked right before and after the supervisor call. `survived.siblings` and `teardown.host` entries that are not the caller's own tasks keep role, state and counts but read `taskId: "other"`, `"other-task container"` / `"other-task volume"` (operators see them unredacted). Host listings stored in verification records and teardown events are redacted the same way to the task's own entries. |

## Repair availability

`src/availability.ts` reads `AIRLOCK_LIVE_GATE_EVIDENCE_DIR/*.json`, validates each file as a
contracts `LiveGateReceipt` plus internal consistency (passed equals the passing attempts, total
equals the attempts listed, every model host `api.vultrinference.com`), and caches by mtime and
size. A receipt dated more than 5 minutes in the future is invalid. The newest valid receipt (by
`recordedAt`) counts, and an invalid file newer than it (by its own `recordedAt`, else by mtime) is
never skipped: repair is then unavailable. Live repair is available when the driver is `vultr` and
that receipt matches the profile id and contract digest, the configured model (ignoring
`-normalize`), the supervisor's selected runtime (never dev-unsafe), exactly the supervisor's
enforced `runtimeImageId` and the adapter digest recomputed from disk, with ≥ 2 passed of ≥ 3,
where passes are counted from this control plane's own task records (each listed attempt must be a
`liveGate` task here, not a diagnostic; a pass counts only when the task is done with
`CANDIDATE_PASSED_CHECKS` for the listed digest), never from the receipt. A live task re-evaluates
availability when it is first claimed and sets or clears `repairDisabledReason` before any repair. Otherwise the reason says which of these failed. The
scripted driver is always unavailable: "scripted diagnostics driver: runs are diagnostics, not model
repairs" (its tasks still run, labelled diagnostic). Receipts come from `bun scripts/live-gate.ts`
(default issue: the tracked `profiles/tabulate-365/issue.md`).

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

## General tasks (doc 40 Stages 2–4)

`task.kind === "general"` runs `createGeneralHandler` (`src/general-handler.ts`) at the same
TaskWorker seam (`createDispatchingHandler`); every other task runs the unchanged RepairHandler.

**Profiles** (`src/task-profiles.ts`; the controller, not the model, picks images, tools, limits,
network policy and checks):

| Profile | Sandboxes | Tools | Checks | Uploads |
|---|---|---|---|---|
| `analysis` | code (`analysis` Python image, or `node`) | code_write, code_run, code_read, files_list, submit_result | outputs-claimed, outputs-valid, required-outputs, summary-schema | yes |
| `web-research` | browser (task `egressAllow`) | browser_navigate/observe/click/type/key/scroll/screenshot/tabs, browser_download_list/save, browser_propose_submit, submit_result | screenshot-evidence, sources-cited, sources-visited, sources-in-policy | no |
| `web-analysis` | browser + code | all of the above + browser_save_text, files_list | all eight; `outputs/summary.json` required | yes |

Budgets per profile: model calls, tokens (M3 reserve/settle), wall clock (persisted across
recoveries), browser operations, code runs, browser sessions, code sandboxes, recoveries,
per-sandbox deadline.

**Tools** (serial, zod-validated; a tool outside the profile is refused as an observation). Browser
tools create the browser attempt lazily (supervisor `profileId`/`role` `"browser"`, `egressAllow`
from the task); navigation outside `egressAllow` is refused before dispatch. Code tools create one
code attempt lazily (`analysis` for Python, `node` for Node; one per task), `put` the task's inputs
under `inputs/` (digest-checked) and then write/run under `code/`; `code_run` executes
`/opt/airlock/run.sh code/<file>` (the image's fixed runner), never a model command line.
`browser_save_text` copies the latest observation's text (≤ 32 KiB) into `inputs/<name>` as a
`page_text` artifact; `browser_download_list` lists the browser's downloads (untrusted names) and
`browser_download_save {downloadId, name}` reads one (`download.read`; bytes re-checked against size
and sha256), stores it as a `download` artifact with its source URL and `put`s it at `inputs/<name>`
(now if the code sandbox runs, else when it starts). These are the only things that cross from the
browser to code, done by the controller. A task may hold one live browser attempt and one live code
attempt at once (the supervisor allows one per role family).
`browser_screenshot` validates the PNG and its sha256, stores it as a `screenshot` artifact
(`source.url/step/tool/attemptId`) and, with `AIRLOCK_MODEL_VISION=1`, attaches it to the next turn
(only the newest image stays in the history). `stale_reference` and `pending_review` come back as
observations (dialogs are never accepted: the model is told to continue without the action or submit).
A browser op that ends `interrupted` (or whose supervisor call did not complete) is never replayed:
the browser attempt is torn down, counted (`general-usage.browserInterruptions`), and the next
browser tool starts a fresh session within the session budget.

**Result.** `submit_result {summary, outputs[], sources[], unsupported_capability?}` never sets
success: the controller stops the code sandbox through `collect-outputs`, re-validates the envelope
(strict base64, length, sha256, safe unique paths), stores every collected file as an `output`
artifact, tears everything down, then runs the profile's completion checks (`src/completion-checks.ts`:
claimed outputs present and not rejected; JSON parses; CSV parses with ≥ 1 data row; PNG header,
CRC and 1..8192 dimensions; `summary.json` is an object with a non-empty `answer`; ≥ 1 screenshot;
every cited URL reached by this task's own browser per its events; every cited host inside
`egressAllow`). Outcome: all pass → `RESULT_VERIFIED`; some fail with outputs/screenshots →
`RESULT_PARTIAL`; nothing acceptable → `RESULT_FAILED`; declared missing capability (or only
unavailable tools and nothing produced) → `UNSUPPORTED`; budget/wall clock/repeated identical
failure (3×) → `STOPPED_LIMIT`; driver failures, unconfirmed stop, malformed envelope or an
infrastructure error → `INCONCLUSIVE`. A sandbox the supervisor refused (create 4xx/409, or a failed
inspection/probe) is an infrastructure outcome, never `RESULT_FAILED`: when no acceptable result
exists the task ends `UNSUPPORTED` if the role is not configured on this deployment (400
`unsupported_profile`) and `INCONCLUSIVE` otherwise; after a definitive refusal
(`unsupported_profile`, `probe_failed`, `inspection_failed`) that role is not requested again in
the task and its tools answer "not retried" (the attempt counts against the session budget).
`Task.result` carries the checks with detail.

**State dimensions (C35/C36).** Workflow = `status`/`phase` (general runs record `prepare → execute`
(the model loop) `→ freeze → verify → ready`); result =
`outcome` + `result`; cleanup = `Task.cleanup` (`none` → `pending` while any attempt lives →
`confirmed` only after every attempt's destroy returned a clean teardown; `failed`, or `retrying`
while a cancel pass retries). The repair handler maintains `cleanup` the same way. Every tool event
carries `data.opState` (`allowed` when a policy check passed, `started` before dispatch with its
`operationId`, then `completed`, `failed` or `unknown`); `completed` is written only from the
supervisor's answer. The prepare event records the supervisor host check (`data.host`).

**Records.** `task-attempts` (one row per attempt: role, generation, live/destroyed/teardown-failed;
the cancel pass and recoveries tear down from these), `general-usage` (browser ops, code runs,
sessions, interruptions, unavailable-tool calls, start time), `general-code` (code files, content
addressed, for the evidence bundle), `artifacts` (immutable `Artifact` records). A recovery (lost
lease/restart) reconciles journaled operations, tears down every earlier attempt, counts the
recovery and restarts the model loop with a note; nothing uncertain is replayed.

**Supervisor calls used** (all journaled, M8): `POST /attempts` (roles browser/analysis/node),
`/attempts/:id/tool` (`put` under `inputs/`, `read`, `write`, `exec`), `/attempts/:id/browser`,
`/attempts/:id/collect-outputs`, `/renew`, `/revoke`, `/destroy`; reads `GET /attempts/:id/browser`
(evidence, recorded on the lifecycle event) and `/attempts/:id/egress` (recorded before teardown).

## Human control, live view and supported final actions (doc 40 Stage 5)

**Exclusive control** (`src/browser-control.ts`, one `ControlService` per process shared by the
handler and the API). A running general task's handler attaches its browser executor; the agent's
browser ops, a human holder's actions, live-view frames and the controller's approved submission
all run through one per-task lock, so the supervisor sees one serial stream.

```
agent ──take──▶ transferring ──(in-flight op settled ≤ settle timeout)──▶ human
                     └─ not settled: take 409, stays transferring (nobody dispatches) until a retried
                        take, a release or the idle expiry
human ──release / idle (no action for AIRLOCK_CONTROL_IDLE_MS) / run ended──▶ agent
```

While the holder is not the agent, the agent's next browser op waits (bounded by the task's wall
clock, which keeps running) and never dispatches; a `lifecycle` event says the agent is paused.
Every grant bumps a control epoch: after release a ref-bound agent action (click/type/key/upload)
is refused as `stale_reference` with "control returned; observe first" until the agent observes, and
the next tool result carries that note (`control_note`). Human actions keep egress policy,
deadline and budgets, are journaled, and are recorded as `tool` events with `data.actor: "human"`
(not counted as visited sources). Task.control is the durable record for the UI; a restart hands
control back to the agent.

**Supported final actions (C25–C27).** Only form submissions to a configured `airlock-forms-v1`
destination (`AIRLOCK_FORMS_ORIGINS`, also inside the task's `egressAllow`), whose server enforces
the approval, are supported. Generic irreversible actions on arbitrary sites (purchases, messages,
account changes) are **not** supported and no semantic intent detection from button labels is
claimed.

1. The model calls `browser_propose_submit {formUrl, formId, fields, summary}`. The controller
   checks the URL is exactly `<origin>/f/<formId>` on a configured origin, normalizes the fields
   with the destination's own `normalizeFields` (`@airlock/fixtures`; refusal reasons go back to
   the model), computes `payloadDigestOf({adapter, destination, formId, fields})`, and inserts an
   immutable `ActionProposal` (owner, task, browser attempt, browser generation, destination,
   adapter, form, fields, digest, 15-min expiry, `pending`). The run waits (status stays `running`;
   a `Waiting for review` event carries the proposal).
2. `decide` restates the digest; the one-use CAS makes it `approved` or `rejected`. Rejected,
   expired (or the wall clock ran out) → the model is told; nothing is submitted.
3. Approved → the **controller** claims it (`claimed`), navigates to the form, observes, types each
   approved value into the single control whose accessible name is the field's label (refuses if a
   field, the "Approval code" input or the "Submit" button is not matched uniquely), types the
   approval code (`${proposalId}.${expiresAtEpoch}.${HMAC}` minted here from
   `AIRLOCK_FORMS_SECRET`; never shown to the model, never in an event), clicks Submit
   (`submitted`) and observes the result page.
4. Verification reads `GET <origin>/api/receipts/:proposalId` from VM A (URL built from the
   configured origin, bearer read token, `redirect: "error"`, bounded time and size): a receipt
   with the approved digest → `confirmed` (receipt stored on the proposal); no receipt after a
   refusal page → `failed`; a lost click response or unreadable receipt → `outcome_unknown`,
   reconciled by **reads only** (bounded retries, and once more when the run ends). The
   submission is never repeated.
5. **However a run stops** (normal end, error, cancellation, lost lease) and again when a
   recovery or cancel pass starts after a controller restart, the task's open proposals are
   settled: `pending`/`approved` → `expired` (the event carries the reason); `claimed`/`submitted`
   → `outcome_unknown` (the click may or may not have been sent), then reconciled by bounded
   receipt reads only: a receipt with the approved digest → `confirmed`, anything else stays
   `outcome_unknown`. Nothing is ever re-submitted.
6. Once the approval code has been typed, any end short of a confirmed submission (click not sent,
   lost, refused, unreadable) reloads the form (resetting every input) before control returns to
   the model or a person; if the reload fails the browser session is closed. Every observation the
   controller passes on (to the model, a person or an event) redacts the value of a control named
   like `Approval code` / `airlock_approval` and any code minted in the run (the browser runner
   redacts too).

The model may fill fields of an adapter form, but a click on a button, Enter, or type-with-submit
there is refused before dispatch (`final_action_requires_approval`, best effort). Whatever reaches
the destination without the code (a person's manual click included) is refused there (403, nothing
recorded); the controller records such arrivals as `check` events with `data.adapterRefusal`.

**What the web UI renders:** `Task.control` (holder, since, reason) and take/release buttons; a
live panel from `GET /live` with refresh; human actions through `/control/action`; proposals from
`GET /approvals` and the `Waiting for review` event (fields, destination, digest, expiry) with
approve/reject that send the displayed digest; proposal status transitions and receipt.
Artifact events that answer a started tool operation (live frames, a person's screenshots and
saved downloads, the agent's screenshots and downloads) carry the same `data.operationId`, and each
approved-submission step's started intent is answered by an `approved_submit <op>` tool event under
that id (never with the typed text). Human actions keep `data.actor: "human"` and add
`data.humanActor: {owner, role}` (the acting session's opaque owner id and role).

**Diagnostic exports:** a task run by a scripted driver is labelled in its sealed bundle: the
general bundle's `result.json` carries `label: "DIAGNOSTIC (scripted, not a model)"`,
`diagnostic: true` and `scriptedDriver` (the outcome label moves to `outcomeLabel`), and the first
line of `README.txt` says so; a repair export's `README.txt` starts with the same label.

**Limitations:** the fixtures/forms service rate-limits per client IP, and every task's browser
reaches it through VM B's egress, so all task browsers share one bucket there: one busy task can
exhaust the limit for the others (the destination answers 429), and Airlock retries nothing on
its behalf. A per-task key would need the destination to see something other than the client IP.

## Model call sites (C21)

Every runtime model call goes through `createVultrDriver` (`src/vultr-client.ts`) against the
pinned base URL (`https://api.vultrinference.com/v1`, `inferenceFetch`: no redirects, nothing
outside the base). There is no alternate provider and no fallback.

| Call site | Purpose | Images |
|---|---|---|
| `src/repair-handler.ts` `modelLoop` → `driver.chat` | repair agent turns | never |
| `src/general-handler.ts` model loop → `driver.chat` | general task planning/acting, including screenshot reasoning (the image rides on the next turn; there is no separate vision or summarization call) | only with `AIRLOCK_MODEL_VISION=1` |
| `src/vultr-probe.ts` `probeModel` / `probeVision` (via `scripts/probe-model.ts`, operator-run, not in the task path) | measured tool-call and image round trips | the probe's generated PNG |
| `src/vultr-client.ts` `listModels` (probe only) | `/v1/models` catalog | — |

A scripted driver (`scripted:<name>`) replaces the model only for labelled diagnostics and tests.

## Driver modes

- `vultr` — `createVultrDriver` against Serverless Inference (chat completions with forced tools).
- `scripted:<path>` — `createScriptedDriver` replays a JSON `[{ "text"?, "toolCalls"?: [{name,args}] }]`
  file. Used by the vertical-slice diagnostic and by tests; never a claim of a live repair.

The driver is chosen per task (`index.ts`): a task with `scriptedDriver` runs that script from the
diagnostics catalog (or the scripted driver's own directory), whatever the configured driver; every
other task runs the configured driver.

## Tests

General tasks (`test/general*.test.ts`, fake supervisor with browser/analysis/node roles, `put`,
collect-outputs and a simulated browser runner): the hero combined flow (navigate → observe →
screenshot → save text → code_write → code_run → submit → `RESULT_VERIFIED`, artifacts with
provenance, `started`→`completed` per operation id, both attempts destroyed, cleanup confirmed);
the labelled `test/fixtures/scripted-general/` scripts load and the hero script runs end to end;
stale ref fed back; interrupted click never replayed (fresh session, counted); navigation outside
`egressAllow` refused before dispatch; an unvisited cited source; a missing claimed output and a
collector-rejected one → `RESULT_PARTIAL`; inputs `put` before code; an unavailable tool refused and
a declared missing capability → `UNSUPPORTED`; model-call budget → `STOPPED_LIMIT`; code-run budget
as an observation and repeated identical failure → `STOPPED_LIMIT`; cancel tears down both attempts
and `cleanup` stays `retrying` until the browser teardown is clean; a recovery; vision attached only
when enabled (and recorded on the model event); repair still dispatched next to general tasks.
API: upload auth/type (415)/size/quota (413), sniffing and names, cross-owner artifact 404, safe
headers, general task validation (profile, egressAllow, inputs), and the evidence bundle sealed
once and served byte for byte. Units: PNG, CSV, egress policy, completion checks, envelope
re-validation, `image_url` wire format and the vision probe.

Milestone 5 (`test/control.test.ts`; the forms destination is the real fixtures service behind a
simulated browser, `test/helpers/forms.ts`): take → human actions (outside egress refused) →
release with the agent paused meanwhile and stale refs refused until it observes; bounded wait →
`human_control`; take while an op is in flight waits for its supervisor answer; take whose op does
not settle → 409, `transferring`, no dispatch by anyone until release; idle expiry; cross-owner
404s; live view rate limit, frames while a person holds control and frames not counted as
evidence; proposal → wrong digest 409 → approve → controller submission → receipt confirmed →
replay 409, code never in events or model input; reject; expiry 410; lost submit response →
`outcome_unknown` → receipt reconciliation → confirmed with exactly one POST; model click/Enter/
type-submit on an adapter form refused before dispatch; a manual submission refused by the
destination and recorded; unconfigured destination and missing field refused; downloads →
`download` artifacts → `inputs/` lazily and immediately, digest mismatch refused; sandbox refusal
→ `UNSUPPORTED`/`INCONCLUSIVE` with a single create; normalization/digest/approval-code vectors
from `apps/fixtures/test/vectors.json`; config and the scripted fixtures-origin placeholder.

`bun test` uses an in-memory PGlite store, an in-memory fake supervisor and thin doubles for the
verifier/artifacts modules. Covered: happy path, unchanged-tree submit, forged "all tests passed"
log, NOT_REPRODUCED, INCONCLUSIVE, STOPPED_LIMIT, REPRODUCED_UNRESOLVED, cancel mid-repair with
destroy, sandbox refusal, freeze without confirmed stop, stale-attempt discard, event bounds, SSE
replay, preview refusals (digest mismatch, unverified, tampered bundle), immutable and repeatable
export grants, preview/export refusal on adapter, contract, runtime and runtime-image drift (before
and after the run; the record's `inspection.imageId` against the host's image id, and a record
with only a repo digest refused new grants and previews: "verification record predates image
identity; re-run verification"), judge-only hostile with per-client and global limits across re-login and the
control-plane health on the card, `/api/health` and `/api/host` access, repair availability from
fixture receipts (matching and mismatched model/runtime/contract/profile, dev-unsafe, 1 of 3, newest
wins, invalid receipts ignored), the diagnostics catalog, the CSP on API/error/static/SSE/zip
responses, the pinned inference URL and no-redirect transport, session roles, supervisor-client operation replay and fence
errors, profile digest verification, worker lease/cancel semantics.
