# 36c — Airlock architecture: reuse the boundaries, not two complete agents

**Reviewer:** GPT-6 Astra, 2026-09-26. This is a source-backed architecture review of Airlock in 35, not a build or deployment claim. I reread selected actual source from OpenMuse `205cc38` and OpenBot `3c73cf0`; references below use paths relative to their respective checked-out repositories under `research/reference-repos/`. No source tests were run for this review. Existing audits 07/08 provide the wider coverage and limitations.

## Decision

Build **one Airlock controller, one small execution supervisor, and one deterministic comparator**. The model is an author inside a workflow, not the workflow's authority. Use OpenMuse's state/claim and command-stop patterns, and OpenBot's restricted supervisor vocabulary. Do not integrate the complete OpenMuse and OpenBot apps or use their existing adapter as the execution boundary.

The important simplification is that Airlock exports an artifact; it does **not** commit a business transaction or publish to GitHub. A normal authenticated download is not an exactly-once external mutation and does not need the full OpenMuse email/calendar approval machinery.

Two static Vultr VMs are a useful deployment choice, not an architectural requirement or a cloud lifecycle feature. They need not imply distributed queues, Kubernetes, a VM per task, or remote browser services. Preserve the logical boundaries first; select physical separation based on a short deployment gate.

## Mandatory invariants

1. **One authority per concern.** The controller owns user/task/attempt identities, contracts and state transitions. The supervisor owns process/container identity and enforced limits. The comparator owns test enumeration and verdict. The artifact service owns sealed bytes. The model owns none of those authorities.
2. **Untrusted code executes only in its assigned sandbox.** Repository setup hooks, generated code, library imports and preview calls are all untrusted execution. Neither the public API nor the comparator imports the candidate package.
3. **Candidate identity is immutable.** Verification, interactive calls and export use the same sealed source manifest, base commit, adapter/runtime digest and contract digest. They never read the mutable author workspace after sealing.
4. **Cancellation has an execution effect.** A DB status change or aborted HTTP request is not proof of process termination. Revoke dispatch, stop the whole execution container/cgroup, confirm stop, and fence late results.
5. **The worker cannot declare success.** A model `finish_task` call means “candidate ready for checking.” It cannot set `CANDIDATE_PASSED_CHECKS`, modify the contract or create an authoritative result.
6. **Ownership is checked at every access.** Task UUIDs, container names and content digests are identifiers, not bearer authorization. A user/session must be entitled to the task, artifact or preview before the corresponding operation proceeds.
7. **Preview expiry does not erase evidence.** Execution access expires and is revoked independently of retained verified artifacts and downloads. Conversely, retaining an artifact does not retain permission to run it indefinitely.

## What the real code contributes

| Source observation | Reusable part | Airlock correction |
|---|---|---|
| OpenMuse `db.ts:47–59` implements compare-and-swap; `engine/worker.ts:116–153` claims tasks and guards/checkpoints by lease. | Small durable record and state-transition pattern. | Model one task/attempt explicitly; fence supervisor dispatch with the attempt identity. A CAS lease is not remote process cancellation. |
| OpenMuse `computer.ts:225–292` inspects the actual container: user, image, env, mounts, network, limits, restart policy and other flags. | **Inspect-before-attach is more valuable than copying a Docker flag list.** | Adapt to a per-task immutable image and resource profile; check actual runtime/image digest, not merely a mutable tag. |
| OpenMuse `computer.ts:591–747` records execution before dispatch, tracks uncertainty and stops the container when the Docker client is lost/aborted. | Command receipt, stop quarantine, preserving interruption against late success. | Move this responsibility behind the supervisor; key it by attempt and command, not owner. Test detached descendants and all timeout paths. |
| OpenBot `supervisor/src/index.ts:95–171` exposes ensure/stop/reset/list with validated server-derived names. | Tiny privileged vocabulary; no arbitrary Docker passthrough. | It does **not** itself implement exec/seal/verify. Airlock needs its own narrow operation set for offline code jobs. |
| OpenBot `supervisor/src/environment.ts:15–40` forwards a shared computer token and egress settings. | Explicit environment construction principle. | Do not inherit shared sandbox tokens. Use host-supervisor exec/stdin so no control-plane credential needs to enter the code container. |
| OpenMuse `actions.ts:39–95` binds proposals to prepared content and expires them. | Immutable proposal identity, server-created hash, stale-reference rejection. | Use for a frozen acceptance-contract review if needed. Do not copy its Google-shaped action schema or inline side-effect executor for downloads. |
| OpenMuse `auth.ts:19–30` creates sessions with owner `local-user`. | Hashed session-token storage and timing-safe access-key comparison. | This is a single-owner app, not per-user isolation. Use an explicit shared demo-operator model or issue distinct session owners; do not claim both. |
| OpenMuse `engine/model.ts:251–269` lets `finish_task` create a report and invoke completion. | Natural-language author completion signal. | In Airlock, route that signal to seal/verify; authoritative success must come from the comparator. |

### Specific defaults that would regress this architecture

- OpenBot `supervisor/src/docker.ts:445–454`: `unless-stopped` restart policy, optional runtime, optional memory and optional network selection suit persistent computers, not finite secret-free runs. Airlock requires no automatic restart, mandatory limits, no network and a declared runtime.
- OpenMuse `computer.ts:113–126`: the computer is keyed by owner and keeps a workspace volume. Airlock must key by task **and attempt/phase**, with no writable author volume mounted into baseline or candidate verification.
- OpenBot `server/src/computer/gateway.ts:515–521`: browser frontend tools are the initiator of computer actions in that implementation. Airlock tool execution must survive closing the browser and remain controlled server-side.
- OpenMuse `computer-tools.ts:62–67`: operation IDs come from model-selected `operationId`. For Airlock, derive dispatch IDs from the persisted server-side step/attempt. The model must not accidentally duplicate work or suppress a different command by reusing an ID.

## Why both complete applications are the wrong integration unit

OpenMuse's application constructor wires Google, workspace, browser, computer and agent services, then constructs Intelligence (`apps/server/src/app.ts:25–45`). Its configuration requires an Intelligence key (`config.ts:108`). OpenBot's broader required Intelligence dependency and browser-mediated tool execution are established in 07. Porting both apps creates two sources of user identity, task state, approvals, computer lifetime and agent routing.

The OpenMuse OpenBot adapter does not solve that split. `packages/backends/src/openbot.ts:139–141` returns disabled/not configured unless explicitly enabled with a transport; its runtime contract is Intelligence-backed. It is not an already working secret-free execution adapter or a bridge that makes their approval models equivalent.

The integration risks are concrete:

- A single OpenMuse `local-user` could map to a shared OpenBot bot computer while the Airlock UI implies task isolation.
- Persistent bot cookies/workspaces and auto-restart behavior can outlive an Airlock job.
- A browser-side callback can become an alternate execution route that bypasses the task's active attempt and cancellation checks.
- Approval state in one app may have no authority at the other app's actual dispatch point.
- A model-provider setting in one layer does not establish that every runtime model call uses Vultr. OpenMuse's `tanstack-agent.ts:19–50` supports multiple providers; its OpenAI path imports an SDK whose actual Vultr behavior still needs testing.
- The reused application surface adds access to integrations and tools the repair agent does not need.

**Conclusion:** actual code reuse should be small extracted modules, with provenance and notices, behind Airlock-specific interfaces. “We integrated two entire frameworks” is not a product requirement or a safety advantage.

## Ownership and minimal service topology

| Component | Owns | Must not own |
|---|---|---|
| **Airlock controller** | Auth, trusted task scope, contract versions, agent loop, attempts, event log, user-visible state, artifact access grants | Docker socket, execution of package/generated Python, ability for model output to overwrite authoritative state |
| **Execution supervisor** | Fixed images, sandbox names, limits, no-network policy, execution/stop/freeze, bounded collection, resource inventory and janitor | Model API key, general user integrations, arbitrary caller-selected mounts/images/privileges, semantic pass verdict |
| **Deterministic comparator** | Expected cases/results, completion counts, strict parsing, matching observations to case IDs, timeout/error interpretation | Importing the target library, trusting emitted “passed” flags/JUnit, accepting a case set from the candidate |
| **Artifact service** | Sealed source manifest and bytes, base/runtime/adapter identities, result association, read authorization | Reading live author files during preview/export, executing collected code, extracting arbitrary candidate archives on the control-plane host |
| **Model author** | Source inspection, candidate edits, bounded run requests, hypotheses and explanatory text | Contracts, user identity, infrastructure, approval, authoritative result or publication |

The comparator and artifact service are modules in the controller process, not necessarily separate microservices. They parse bounded data only. The supervisor is a separate small process with a private authenticated interface or local Unix socket. A single controller worker with a concurrency limit is enough for the hackathon. SSE is a rendering transport; the durable DB is the task-state authority, not the browser timeline.

### One VM versus two

**One-VM minimum:** serve the app/controller under an unprivileged identity, keep the supervisor separate, and put all candidate execution in hardened containers. The app has no Docker group/socket and no untrusted code in-process. This is consistent with 01's container-based separation requirement; 01 explicitly labels a second VM as our safeguard, not the organizer's rule. For a single controller process, an embedded durable store can be sufficient; PostgreSQL is not mandatory merely because the reference has a Postgres adapter.

**Residual risk:** supervisor compromise or a container escape to that shared host can reach the controller and its credentials. “No secrets inside the sandbox” remains a configuration property, not immunity to host compromise. Say this if choosing the single-host design.

**Two-static-VM recommendation when straightforward:** controller/comparator/artifacts on VM A; supervisor/sandboxes on VM B over a private authenticated channel. Nothing else in the application has to become distributed. A tiny controller store can remain on A. This keeps the code host separate from model keys and public API. It still does not make observations cryptographically trustworthy after a supervisor/host compromise.

Use a bounded infrastructure spike. If two VMs and their private route are already available, retain them. If their setup is consuming the whole useful-work gate, one VM with explicitly reduced trust claims is a reasonable demo scope decision. Never use a silent one-VM fallback while retaining a diagram or claim of separate host trust. Do not add per-task VM provisioning, VPC attach/detach, snapshots, Kubernetes or a message broker just to satisfy this boundary.

## A smaller orchestration design than the generic TaskWorker

Suggested durable states are `queued → reproducing → awaiting_contract → repairing → sealing → verifying → ready`, with explicit unresolved/failure/cancelled outcomes. The maintained contract may be approved before the run for the fixed demo case, so no live dialog is required merely to exercise the state name. `ready` carries a verification result, not a model judgment.

Keep separate records for:

- `task_id` and owner: user job and authorization;
- `attempt_id`/generation: one execution authority lifetime;
- `sandbox_id` and phase: author, baseline, candidate or interactive call;
- `command_id`: server-generated dispatch deduplication;
- `contract_digest`: fixed case semantics and expected results;
- `artifact_digest`: immutable candidate identity;
- `verification_id`: observation record tied to contract, artifact and runtime;
- `preview_id`/expiry: temporary execution permission, not the artifact itself.

Do not collapse these into one “session.” Persistent IDs can be opaque random values; no sophisticated distributed identity system is needed. Every lookup still checks the owning user/task.

For the smallest single-worker build, a crash can mark the active attempt interrupted, reconcile and stop its sandboxes, and offer a fresh explicit retry from a known checkpoint. That is easier to prove than transparent continuation of arbitrary shell work. OpenMuse's CAS/lease model is useful if multiple workers or recovery are actually required, but its full recurring-task/waiting-approval loop is unnecessary.

### Lease is not cancellation

OpenMuse `engine/worker.ts:136–153` checks DB identity/status at guards and checkpoints; its heartbeat at `166–179` aborts the local controller on failure. The task handler or remote service must observe that abort. The lost-lease branch can requeue (`205–212`). None of this independently terminates a remote command that has already started.

Airlock dispatch must therefore bind to a server-issued active attempt generation and deadline. The supervisor checks them at acceptance, rejects revoked generations, and owns an absolute task TTL even when the controller disappears. Revocation cannot rely on the next model/tool turn.

On cancel/lease loss: atomically mark cancel intent or advance/revoke generation; reject new dispatch; ask the supervisor to stop the entire container/cgroup; confirm termination; then finalize the attempt. If stop cannot be confirmed, keep the execution quarantined and do not reuse its volume or call it stopped. Late outputs from the old attempt cannot transition the task to ready.

**Useful actual reuse:** OpenMuse already recognizes that killing the Docker CLI is insufficient (`computer.ts:677–710`) and stops the whole container on a lost/aborted client. Its explicit stop path records interruption before issuing stop (`514–567`). Port that ordering. Also inspect the distinction at `676–679`: exit code 124 is marked timed out, but the whole-container cleanup branch is entered for client timeout/interruption, not every inner timeout exit. This is a source-level observation, not an exploited bug. Airlock must test detached child processes and enforce complete cleanup for every timeout, rather than assuming `timeout` killed all possible descendants.

## Immutable artifacts: the real handoff boundary

The candidate is not a folder path and not a tarball supplied by the model. It is a server-owned manifest plus exact bounded file bytes collected from a stopped author environment.

1. Revoke author writes and all new dispatch for that phase.
2. Confirm the entire author container is stopped, preserving its writable volume for collection. Killing one shell/process group is not enough if it left detached children.
3. Collect through a trusted minimal collector with the author volume read-only. The collector has no inference key/network and does not import the candidate. Enumerate allowed paths and regular files; reject symlinks, special nodes, traversal, excessive file counts/lengths and unsupported deletions/mode changes. Treat unusual hardlinks conservatively too.
4. Build a deterministic manifest of the allowed source paths/content hashes and bind it to the pristine base, runtime/adapter identity and contract. Copy bytes into controller-owned immutable storage. Do not execute generated extraction commands or parse arbitrary archive layouts on the API host.
5. Reconstruct verification and interactive environments from these immutable bytes. Do not reattach the author volume. Verify the reconstruction's manifest.
6. Generate the downloadable patch from this same base/manifest. Export is not `git diff` run later in a mutable workspace. Clearly include or separately label any agent-authored repro that is not itself the authoritative acceptance contract.

Filesystem immutability need not mean object storage or signatures. An append-only content-addressed directory owned by the controller, written atomically and never mounted writable into sandboxes, is enough for the supported demo. Authorization must still be checked before returning a known digest.

## Verification: deterministic authority, optional model advice

The strongest minimal adapter is the one already proposed in 35: fixed typed request into a fresh untrusted library sandbox; bounded returned text/JSON; supervisor-owned exit/signal/deadline observations; expected cases and comparison outside that sandbox. Candidate code can influence the response because producing the response is its job. It cannot choose which cases are required or author the record that says they all passed.

Baseline and candidate need not run simultaneously. Running them sequentially under the same fixed harness/runtime reduces orchestration. A fresh candidate process/container per case avoids hidden mutable state between cases where startup time permits; otherwise explicitly define case ordering and reset semantics, and test stateful cheating as a limitation.

A separate “verifier agent” can explain a diff or suggest extra cases, but it must not be the pass/fail authority. If model-suggested cases change the contract, that is a new trusted review/version and requires rerunning both baseline and candidate. The finite case set still cannot establish general semantic correctness.

An agent-written JUnit report, fabricated stdout pass count, model-authored screenshot or successful package import is not the verdict. The controller must know expected case IDs and reject missing/duplicate/unknown IDs, malformed/oversized data, exceptions, timeout and incomplete runs. Late output after deadline is not a successful observation.

## Approvals: retain the useful binding, remove the wrong transaction

OpenMuse's `ActionService` is designed for irreversible email/calendar actions. It checks account/connection, prepares a target, hashes it, claims execution, calls the adapter inline and records unknown outcomes. Its linked task must still be `running` or `waiting_approval` (`actions.ts:114–124`; `db.ts:82–87`). Airlock should export artifacts **after** verification finishes, so copying that lifecycle would reject legitimate completed-task exports or force an artificial task status.

For Airlock:

- **Acceptance review:** the maintainer selects/confirms expected behavior and permitted source scope. Store approver, contract digest and version. The model cannot approve or mutate that contract.
- **Task permission:** the user authorizes the contained reproduction/repair run. Do not prompt on every local shell command; enforce the sandbox and narrow scope structurally.
- **Export:** the authorized user downloads an already prepared immutable artifact. This should be repeatable and resumable. It is an authenticated read, not an uncertain external write, so no artificial `outcome_unknown` or single-use “approve download” workflow is needed.
- **If a visible review button helps:** bind it to the artifact/result/contract digests and label it accurately. “Reviewed” records a human decision; it is not the source of the deterministic pass verdict.
- **Future publish/PR feature:** only then adapt the full approval/claim/uncertain-outcome pattern, with exact destination/body/artifact binding. It is out of v1.

This change removes an entire adapter class without reducing the safety of the actual current user action.

## Authentication and secret handling

The simplest truthful public demo is an authenticated operator identity plus explicitly scoped viewer access. If multiple operators are supported, assign stable distinct owners. Never use OpenMuse's hardcoded `local-user` for everyone and call the result user isolation. Never expose OpenBot single-user admin behavior on the public app.

The model key stays in the controller. Agent tools send code/input through supervisor-mediated exec/stdin; the sandbox needs no server API token. A supervisor token authenticates controller-to-supervisor traffic only and is never forwarded into candidate environments. Supervisor calls choose server-owned runtime IDs, not caller-controlled Docker options, shell commands on the host, image registries or mounts.

Restrict the runtime provider at construction, not only by UI configuration. OpenMuse's generic provider adapter supports non-Vultr providers; retaining that entire router creates an unnecessary route around the challenge constraint. A tiny tested Vultr client is less integration work. Logs and error responses must not serialize credentials.

OpenMuse signed links bind owner/path/expiry but not the HTTP method (`auth.ts:42–71`); its signed-route matcher covers console routes regardless of method (`app.ts:127–137`). Do not inherit those semantics for Airlock. A signed download link, if used, needs narrow method/resource scope. An expiring link is authorization, not proof a sandbox has been destroyed.

## Preview lifecycle without a second product

For this plain-text library, prefer **a bounded typed invocation in a fresh short-lived sandbox on each Try call**. There is no need for a web server inside the candidate, an iframe, per-task DNS, a browser cookie jar or an agent-computer API. The trusted UI escapes the resulting text. Rate, concurrency, input and output limits apply before dispatch.

A preview grant binds owner, verified artifact/contract/runtime identity, expiry and invocation budget. The supervisor receives an invocation deadline no later than that grant's expiry. Expiration revokes new calls and terminates active calls according to the declared deadline; it is not only a countdown in the browser. If a persistent preview container is chosen for measured latency reasons, give it an absolute TTL and a separate End session operation that revokes dispatch before destruction.

Completed results and downloadable artifacts survive preview expiry. Retrying Try after expiry requires a new authorized preview grant; it must still use the same verified artifact. Reopening a preview is not reopening the author workspace. Cancelling an unfinished author attempt creates no verified artifact; ending a completed preview need not invalidate its historical result.

## Minimum build and tests

**Build first:** a direct controller → supervisor → fixed runtime path; one actual Vultr tool loop; one contract; a bounded state store; freeze/collect; baseline/candidate comparator; digest-bound text invocation and download. Reuse only source pieces that simplify this path. A general queue engine, complete Actions service, browser subsystem, database cluster, signed receipt infrastructure, distributed identity service and NetBird are not prerequisites.

Tests that earn the architecture claims:

1. A model completion claim or forged JUnit/pass field cannot turn broken source into a pass.
2. Changed author workspace after sealing has no effect on verification, Try or download; forbidden paths/symlinks are rejected.
3. One task/session cannot read, execute, export or stop another's sandbox/artifact by guessing an ID or digest.
4. An old attempt sends a late exec/result after cancellation: dispatch refused and ready state unchanged.
5. Detached descendants, client disconnect, inner timeout, supervisor/control-plane restart and TTL expiry do not leave unlimited jobs running. Unconfirmed cleanup remains quarantined.
6. Preview grant expiry stops new calls and bounds existing execution, while retained evidence remains readable to its owner.
7. Duplicate download succeeds safely without executing code again. Try consumes its own invocation budget and never mutates sealed bytes.
8. Actual inspected container flags/runtime/network match the declared profile; no model/control-plane key is present in candidate files/env; the private supervisor is unreachable from code containers.

**Final recommendation:** use the offline-computer correctness ideas from OpenMuse inside a new task-scoped supervisor shaped like OpenBot's privileged vocabulary. Keep orchestration small, grading deterministic, artifacts immutable and downloads simple. Choose one or two physical VMs honestly; neither topology excuses a missing process stop, identity check or verifier boundary.

## Addendum — stress test of the lead's concrete minimal design

The lead proposes one controller process with PGlite, a Bun supervisor with a small **new** SQLite operation/fence journal, network-none fixed exec runners without HTTP/token servers inside them, a read-only regular-file collector, a pristine candidate reconstruction, a fresh runner per comparator case, and repeatable immutable GET downloads. This is consistent with the recommendation above. SQLite on the supervisor is new Airlock code; do not describe it as an existing OpenMuse Store backend.

The key issue is the gap between the two durable stores. Avoid creating a distributed transaction system. Instead, define which component is authoritative for each fact:

- **Controller PGlite:** owner authorization, task/contract, desired cancellation, artifact/result association and UI state.
- **Supervisor SQLite:** active/revoked attempt generation, accepted command IDs and payload hashes, fixed profile, absolute deadlines, actual container identity and cleanup status.
- **Runtime inspection:** current process/container existence and effective configuration. A journal entry alone cannot prove a process stopped.

Use one attempt/sandbox table and a small operation table. Each operation can have `accepted`, `running`, `finished` or `unknown` with a bounded result, rather than a generic event-sourcing platform. Bind `operation_id` to an immutable request hash; reusing it with different arguments is a conflict. Task/user IDs received from the controller remain server-owned mapping inputs, never arbitrary host paths or Docker configuration.

**Cancellation ordering:** the controller records intent and stops dispatch; the supervisor durably revokes the generation before attempting stop; only after confirming all sandbox processes stopped does it acknowledge stopped. If the response is lost, query that operation/state rather than claiming success. A cancelled UI may immediately say “cancelling”; “stopped” waits for evidence. The supervisor's absolute TTL applies even if the controller never returns.

**Restart recovery:** inspect labeled containers against journal records, expire/revoke old attempts, and stop or quarantine unknown work. Do not blindly replay an accepted/running exec whose effect is uncertain. A safe new attempt may start from the pristine input after cleanup; it does not inherit a half-written source tree as though execution resumed exactly where it stopped.

**Freeze ordering:** prohibit new exec/write operations, confirm the author and every other writer to its volume are stopped, then attach that volume read-only to the collector. Validate all path components, not only the final filename. Bound per-file bytes, file count and total output; reject malformed metadata, duplicate paths, symlinks and unusual nodes. The author needs a retained task volume through collection; automatic removal must not destroy it before sealing. Delete it afterward under the janitor.

**Metadata and privileges:** `network=none` with no mounted host/supervisor sockets or inherited credentials removes the direct cloud-metadata and control-API routes for the code process. Prove that actual profile after creation. The supervisor itself remains privileged host authority: its exec request must mean “run inside this already assigned sandbox,” never “run this host command,” “use this image/mount,” or “fetch this arbitrary URL.” Do not forward its environment into runners or collectors.

**Fresh verification/preview:** each case invocation reconstructs from the sealed candidate plus the fixed runtime/adapter; temporary files are disposable and no interpreter state is shared across cases. Preview invokes the same digest with a typed bounded input and its own budget, then destroys that invocation. The trusted UI escapes text. The exported patch and evidence are ordinary authorized immutable reads and remain available after preview expiration.

These measures require a small explicit state machine, not another orchestration framework. Preserve that restraint: no runtime multi-agent coordinator, no browser computer service, no approval saga for a download, and no extra database server merely to connect the two stores.
