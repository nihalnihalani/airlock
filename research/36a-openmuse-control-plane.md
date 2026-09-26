# 36a — OpenMuse as Airlock's control plane

**Design only; no implementation, installs or deployment.** Fresh read of the actual local OpenMuse source at `205cc386b75aae1a862f3fdd43104b570c8d0911`, checked with `git rev-parse HEAD`. The source paths below are relative to `research/reference-repos/openmuse`. This is a selective subsystem architecture for Airlock / Blast Radius Zero, not another product comparison.

**Use OpenMuse for durable task orchestration and human-controlled artifact release. Use an OpenBot-derived supervisor for isolated execution. Build Airlock's verifier and artifact contract as new domain services.** The best path is a small TypeScript/Hono application containing adapted OpenMuse modules, not two full applications communicating through a bridge.

The distinction matters: OpenMuse's `TaskWorker` and `Store` are genuinely small reusable modules. Its `AgentService`, `createApp`, conversation runtime and model tool inventory are a personal-assistant application with substantial Google/workspace/browser coupling. Extracting those whole would be slower and riskier than providing a new Airlock task handler behind the existing worker seam.

## 1. Source-backed reuse decision

| Source checked | What is actually implemented | Airlock decision |
|---|---|---|
| `apps/server/src/db.ts:1-163` | `Store` CRUD, JSONB compare-and-swap, insert-if-absent, action claim, interrupted-action recovery; PGlite or `pg` adapter | **Direct selective reuse with attribution.** Keep generic record and CAS operations. Adapt action claim; omit Google `updateCredential`. Add immutable artifact methods and append-only event operations. |
| `apps/server/src/engine/worker.ts:1-248` | Injected `TaskHandler`, task polling, CAS lease claim, heartbeat, abort signal, guard/checkpoint/event context, lease loss recovery | **Direct adaptation.** Replace domain types, configure concurrency and budgets, add supervisor fencing/reconciliation. Preserve lease/CAS structure. |
| `apps/server/src/actions.ts:1-205` | Proposal lifecycle, hashing, expiry, idempotent proposal insertion, approve/deny, atomic claim, definite versus unknown execution outcome | **Extract lifecycle, replace action domain.** Google connection/account logic and `CalendarEvent` are not generic. Replace with artifact identity, candidate digest and verification state. |
| `apps/server/src/auth.ts:1-89` | Constant-time access-key comparison, random session token stored by hash, 24-hour session, owner `local-user`, HMAC path links | **Adapt session foundation.** Not RBAC or multi-user identity. Do not carry signed console access into Airlock. |
| `apps/server/src/engine/model.ts:1-106,225-340` | Serial tool queue, schema parsing, guard before tool, error result feedback, cached operations, model finishes tasks | **Reuse wrapper patterns, not the inventory.** New tools call the supervisor; model cannot mark a candidate verified/succeeded. |
| `apps/server/src/engine/service.ts:1-125,180-308` | Instantiates worker but also personal workspace, files, actions, browser, computer, finance/ideas/monitors; task control CAS | **New small `AirlockService`.** Adapt create/control semantics only. Do not import this class wholesale. |
| `apps/server/src/engine/routes.ts:1-68` | Thin Hono task create/detail/control/input routes | **Adapt first task routes.** Exclude goals, ideas, memories, monitors, sample page and personal identity API. |
| `packages/domain/src/agent.ts` | Task/step/event types, generic `input/state`, many personal-agent domains | **Replace with Airlock schemas.** Avoid bringing arbitrary mutable state and irrelevant task kinds across the boundary. |
| `apps/server/src/app.ts:24-45,126-146,166-190,210-238` | Constructs Google/workspace/browser/computer, Intelligence and runtime; authenticated routes; decisions; thread creation | **Replace composition root.** Merely deleting one key check does not remove SaaS dependencies. |
| `apps/server/src/agent.ts` | CopilotRuntime, `ConversationAgent`, optional external AG-UI agent and required Intelligence argument | **Omit initially.** Use Airlock REST/SSE and local task/message storage. AG-UI can be added later as an interface. |
| `apps/server/src/engine/tanstack-agent.ts:1-141` | CopilotKit `BuiltInAgent`, TanStack loop, three provider adapters, automatic model-editable UI-state tools | **Do not make it the first integration seam.** Use a small Vultr-specific driver. It is more than a provider URL switch. |
| `apps/server/src/config.ts:58-75,86-132` | Intelligence key required in `readConfig` and asserted again by app construction; provider env and live-mode settings | **New narrow config.** No `CPK_INTELLIGENCE_API_KEY`, Google keys, arbitrary provider selection or external agent URL. |
| `apps/server/src/index.ts`, `worker-entry.ts` | Boot/recovery/shutdown; separate worker requires Postgres but still calls full `createApp` | **Adapt startup order; replace composition.** Do not use the worker entrypoint unchanged. |

Dependencies needed for the extraction: Node/TypeScript, Hono, Zod, PGlite **or** Postgres, and the small error/log helpers. No CopilotKit Intelligence, Expo client, Google integrations, browser worker, financial analysis or external OpenBot adapter is needed for these extracted modules.

These are static source observations. No OpenMuse test suite was executed in this pass. Existing tests such as `tests/actions.test.ts`, `model-worker.test.ts`, `agent-api.test.ts` and `model-retry.test.ts` are candidate material for adapted regression tests, not proof that Airlock works.

## 2. Service boundaries

```text
Browser: task page / escaped preview / Export tested patch
                         |
Vultr VM A: Airlock control plane (OpenMuse-derived)
  Hono API + session/role checks
  AirlockService: create/cancel/retry/read task
  Store: tasks, runs, tool operations, events, artifacts, export decisions
  TaskWorker: lease and lifecycle
  RepairHandler: deterministic phases and model-assisted authoring
  VultrModelClient: reasoning only, API key remains here
  ArtifactService + independent ReferenceVerifier + ExportActionService
                         |
        narrow private authenticated supervisor client
                         |
Vultr VM B: execution plane (OpenBot-derived)
  supervisor is the only Docker/runtime authority
  task-scoped author / collector / candidate / preview sandboxes
```

OpenMuse-derived code on VM A never executes model-written code. Its tools send a typed request to the VM B supervisor. The supervisor does not become a second planner and receives no inference key. The controller owns task phases, artifact identities, budgets and test expectations. The model owns proposed source edits inside its author workspace only.

The verifier is a controller service that compares bounded observations to reference expectations. It does not import the candidate package or trust candidate `passed` output. Supervisor process metadata reports execution, not correctness. Neither the model nor a model-editable UI-state object controls verified status.

## 3. Store and process choice

OpenMuse's storage contract uses Postgres syntax: JSONB, `data @> expected`, JSONB concatenation, `RETURNING` and timestamp casts. **Do not describe SQLite as a drop-in backend.** Porting to SQLite would mean rewriting and retesting atomic behavior.

For the smallest deployment, keep API and `TaskWorker` in one Node process on VM A and use **PGlite with a persistent data directory**. Logical separation between API/worker is sufficient; isolation from untrusted execution comes from VM B. One process avoids cross-process embedded-database ownership issues.

If separate API/worker processes are desired, use **Postgres on VM A** and the `pg` adapter. The source `worker-entry.ts` explicitly requires `DATABASE_URL` for this reason. A separate worker process can be useful later; it is not necessary to demonstrate the runtime boundary.

Retain the record table for bounded task data, but use explicit domain methods:

- `createTaskIfAbsent(owner, requestKey, validatedSpec)`.
- `claimTaskLease(taskId, expectedState, nextLease)`.
- `checkpointTask(taskId, leaseId, expectedPhase, patch)`.
- `appendEvent(taskId, sequence, typedEvent)` with unique sequence identity; never overwrite existing events through generic `put`.
- `insertImmutableArtifact(manifestDigest, manifest)`; reject replacing bytes under an existing digest.
- `claimExport(owner, proposalId, approvedDigest, expectedArtifactDigest)` with status/expiry/authorization predicates in the same atomic operation.

Keep large blobs out of mutable JSON task records. Store bounded metadata plus content-addressed artifact bytes. `Store.put` is an upsert, not an immutability or append-only guarantee. Likewise `list` ordering by update time is not a durable event sequence; add an explicit monotonic per-task sequence for SSE/replay.

## 4. Durable task semantics

Keep the worker's high-level status separate from a validated Airlock phase:

```text
queued → running → succeeded
            ├── waiting_input → queued
            ├── failed
            └── cancelling → cancelled

running phase:
prepare → author → freeze → verify → ready
```

`ready` means a frozen artifact passed the selected external checks, not that production deployment is safe. Model completion means only “candidate submitted”; it advances the controller to `freeze`, never to `succeeded` directly. Repair success is the verifier-owned outcome. Failed checks may create a bounded new author attempt; each attempt has a distinct candidate artifact and sandbox generation.

The source `TaskWorker` is close to this need: its constructor accepts `(owner, task, context) => Promise<Partial<AgentTask>>`, and `TaskContext` provides `guard`, `checkpoint`, `event` and an abort signal. Implement the new deterministic `RepairHandler` at this seam.

Important adaptations:

- Add schema validation to task state/phase, not just TypeScript interfaces.
- Use controller-assigned tool operation IDs. Persist dispatch intent before sending a tool; record the supervisor operation/result after it. Do not trust model-chosen IDs.
- A durable cached result alone is not exactly-once dispatch. In source `model.ts`, execution occurs before the operation cache checkpoint, leaving a crash window. Supervisor idempotency and read-after-restart reconciliation close this gap for known operations.
- Worker `guard()` checks ownership/status, but a running remote shell does not stop because a database lease expired. Include a task generation/fencing token in supervisor requests; cancellation/replacement revokes the generation and stops all its processes.
- Record `cancelling` first, revoke tools, stop workloads, observe teardown, then record `cancelled`. Preserve teardown failure visibly and let the janitor reconcile it. Do not equate `AbortController.abort()` with a destroyed sandbox.
- On startup, inspect unfinished tasks and supervisor workloads. Reconcile known `op_id`s rather than blindly repeating a write/exec. If the artifact digest was committed, continue from the frozen phase; if author state is uncertain, discard that workspace and retry explicitly.
- Clamp concurrency to the resource budget. The upstream worker admits up to three eligible jobs per tick; this is a convenience default, not an Airlock capacity decision.
- Task TTL and per-call timeouts are enforced by the supervisor even if the API process dies. Lease/heartbeat logic is availability coordination, not the sandbox boundary.

## 5. Model loop: retain the discipline, replace the provider coupling

Source `engine/model.ts` serializes tool execution even when a model emits multiple calls, validates arguments, runs `ctx.guard()` before effects and returns errors as tool feedback. Reuse those behaviors.

Airlock's initial model tools should be small:

- `read_source(path)` — controller allowlisted source in author sandbox.
- `write_source(path, contents)` — allowlisted source only, bounded size.
- `run_author_check()` or bounded `exec_author(...)` — runs only inside that author sandbox with controller limits.
- `submit_candidate()` — signals readiness to the controller; cannot choose its hash, test verdict or export target.
- `ask_user(question)` — only for missing task input, not safety status or tool authorization.

The precise `exec_author` flexibility is a supervisor policy decision. Whatever commands the author can run, it never receives freeze/verify/export/runtime-management capabilities. The controller's verifier runs outside the model tool loop.

A new `VultrModelClient` is the simplest provider seam: `next(messages, toolSchemas, budget, abortSignal) → normalized tool calls/text/usage`. Keep tool messages and observations in local storage. Pin the outbound inference host to Vultr; validate returned tool arguments; preserve tool-call IDs; bound retries, completion tokens, calls and total elapsed time. Handle a request timeout without assuming no tool effect happened—tools and inference calls are separate operations.

Why not use `tanstack-agent.ts` unchanged:

1. It imports `BuiltInAgent` and converters from CopilotKit plus TanStack, RxJS and three provider SDKs.
2. Its OpenAI adapter honors `OPENAI_BASE_URL`, but `tests/helpers/model.ts` emits Responses protocol events such as `response.created`. This supports a Responses-oriented integration assumption; it is **not** evidence that Vultr's streamed function calling works with this exact dependency version. Probe before adopting it.
3. It automatically adds `AGUISendStateSnapshot` / `AGUISendStateDelta` tools. Airlock's verification/budget/lifecycle UI must never become model-editable state.
4. It merges application context and state into the model prompt. Our protected test oracle, supervisor details and auth data must not enter that path.

If the existing TanStack adapter passes a real Vultr tool-roundtrip test quickly, keeping it is possible after removing other providers, UI-state tools and runtime coupling. That is an alternate implementation choice, not a prerequisite. The reusable capability is server-side tool execution with durable guard/checkpoint semantics.

## 6. Intelligence dependency removal: exact cut

The complete OpenMuse app cannot currently boot without a CopilotKit Intelligence key:

- `config.ts:108` calls `required(...)` while reading the key.
- `assertApiDeploymentConfig` checks it again.
- `app.ts:44` constructs `CopilotKitIntelligence` and passes it to `makeRuntime`.
- `agent.ts` constructs `CopilotRuntime` with that Intelligence object.
- `/api/main-thread` creates a remote thread through `intelligence.getOrCreateThread`.

Therefore do **not** patch the missing-key check and assume conversations are now local. Use a new composition root that imports the extracted Store/worker/actions/session modules, wires `RepairHandler` and provides REST/SSE. Persist task inputs, tool observations and user-visible events in the local Store; there is no remote conversation service to initialize.

An AG-UI-shaped event schema can remain useful for later frontend integration. It does not require adopting the full CopilotKit runtime or off-box thread service now. No side-by-side OpenMuse and OpenBot application deployments are needed.

## 7. Export actions and human control

OpenMuse's ActionService is useful but not generic as written. Its `ProposalInput` is email/calendar-specific; `prepare` returns a `CalendarEvent`; connection checks and titles name Google. Its source hash is computed with `JSON.stringify`; use an explicitly canonical Airlock envelope instead.

For Airlock, the immutable decision object is:

`{action: "export_patch", owner, taskId, artifactDigest, baselineRef, verificationManifestDigest, verificationResultDigest, expiresAt}`.

The server prepares this object from the committed verified artifact. The user clicks **Export tested patch**. That click approves this object and downloads the fixed content. Do not add a second chat confirmation or a model “approve” tool. Export has no permission to push, deploy or run the patch elsewhere.

Adapt the lifecycle to `awaiting_review → granted|denied|expired`. A local repeatable download does not need the full Google-write `executing/outcome_unknown` machinery. Keep that richer lifecycle only if a genuine external write integration is later added. Do not claim exactly-once download delivery: the browser may retry; the immutable content is the same.

If directly adapting `ActionService.decide`, fix two seams:

- `Store.claim` currently checks status, expiry and related task status but **does not include the supplied approved hash in its atomic SQL predicate**. Airlock's grant must bind digest, current verified artifact and owner atomically, not rely only on a preceding read.
- Source claim accepts linked tasks in `running|waiting_approval`; a completed repair is `succeeded`. Do not keep repair artificially running until a user downloads it. Define a separate artifact-export predicate: completed verification, matching immutable artifact, non-revoked grant and allowed owner/role.

Human acceptance is separate from candidate correctness. An export click cannot turn a failed candidate into “verified.” An optional download of failed/debug artifacts must be separately labelled and cannot reuse the verified export status.

## 8. Auth and API seams

Source Auth is a reasonable single-owner starting point, not an identity system. It stores hashed random bearer tokens, checks expiry and compares access keys in constant time, but every session maps to `local-user`. Add explicit operator and judge/viewer role information if those are offered. Enforce ownership and role checks on every task, preview and export endpoint, not just in the UI.

Do not reuse the source signed URL scheme for mutable operations. It binds owner/path/expiry but not HTTP method, and app routing grants signed access to browser console paths. Airlock downloads are GET-only grants bound to an immutable digest; task execution, cancellation and export authorization require an authenticated user action. Keep trusted preview rendering escaped and bounded.

Minimal API:

| Route | Authority / purpose |
|---|---|
| `POST /api/session` | Operator/judge login; scoped session |
| `POST /api/tasks` | Validated supported task/issue, owner, idempotency key |
| `GET /api/tasks/:id` | Typed controller state, evidence and artifact IDs |
| `GET /api/tasks/:id/events` | Durable ordered events/SSE; bounded output |
| `POST /api/tasks/:id/cancel` | User cancellation through revocation + teardown workflow |
| `POST /api/tasks/:id/retry` | New bounded attempt; never silently repeats unknown work |
| `POST /api/artifacts/:digest/preview` | Bounded package input to fixed adapter in fresh preview sandbox |
| `POST /api/artifacts/:digest/export` | User grants export of the matching tested artifact |
| `GET /api/exports/:grantId` | Immutable attachment download, authorization/expiry checked |

A session cookie is possible with HttpOnly/Secure/SameSite settings and CSRF protection. Retaining bearer auth is also possible with strict origin policy and careful client storage. The choice must be explicit; don't mix source bearer assumptions with new cookie endpoints without adding CSRF checks.

## 9. Minimal integration sequence

1. Extract Store/error/log and task worker into an attributed internal module; replace domain types; boot a new Hono composition root with no Intelligence key or Google config.
2. Create a task and run a fixed no-op injected handler through claim/checkpoint/completion; verify restart recovery and stale-worker refusal.
3. Bind handler operations to the OpenBot-derived supervisor via a new `ExecutionPort`, not `ComputerService` or Docker CLI.
4. Add the Vultr-only model driver and serial schema-validated author tools; enforce call/time/resource budgets.
5. Add controller-owned freeze → reference verify → ready phases; artifact bytes and observations remain untrusted until structurally validated, and only external comparisons set check results.
6. Adapt artifact export grants from ActionService; add trusted task page, result strip and bounded preview.
7. Test duplicate dispatch, lease loss, cancel during execution, API restart, forged result text, stale artifact grant and role refusal against the actual integrated components.

**Feasibility judgment:** selective extraction is credible because Store and TaskWorker have small direct dependencies and clear injected interfaces. Extracting all of `AgentService` or `createApp` is not “free reuse”; their unrelated services and boot dependencies make them the wrong unit. A full blank-sheet rewrite of leases/claims would also discard useful audited logic. Choose the middle path: directly adapt the two clean modules and rewrite the application/domain seams.

No time-to-completion, passing tests or deployed behavior is claimed here. Preserve upstream MIT notices for copied code, list exact adapted files and distinguish OpenMuse-derived lifecycle code from new Airlock verification/artifact logic.
