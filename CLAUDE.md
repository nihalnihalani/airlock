# Airlock — development guideline

Airlock takes an untrusted bug report for a supported library, reproduces the failure in a disposable sandbox on Vultr, attempts a minimal repair, and returns a patch with **externally measured** before/after behavior. The agent can edit the candidate; it can never edit the acceptance contract, grant itself privileges, publish its work, or decide that it passed.

This file is the standing guideline for every session on this repo. The research that produced it lives in `research/`; the governing documents are [35](research/35-AIRLOCK-MAIN-CHALLENGE.md) (product, demo, gates), [37](research/37-AIRLOCK-OPENMUSE-OPENBOT-ARCHITECTURE.md) (architecture and reuse) and [38](research/38-kickoff-decks-and-netbird-clarification.md) (kickoff amendments). Where this file and those differ, this file wins for day-to-day work; update all three together when a decision changes.

## 1. The bar: a real product, not a demo simulation

Work continues until Airlock is usable in a real-world scenario. Concretely:

- Real inputs: a maintainer pastes an actual issue for a supported repository/runtime and gets a real result. No hardcoded demo path that the UI secretly follows, no prerecorded agent traces presented as live, no "happy path only" code.
- Every terminal state is reachable and correct: `NOT_REPRODUCED`, `REPRODUCED_UNRESOLVED`, `CANDIDATE_PASSED_CHECKS`, `CHECKS_FAILED`, `INCONCLUSIVE`, `STOPPED_LIMIT`. A failed repair returns the reproducible failure and an unresolved status; it never becomes green because the model sounded confident.
- Failure handling is a feature: timeouts, malformed model output, oversized output, launch failures, cancellation, supervisor/controller restarts and abandoned tasks all have tested behavior.
- Deployable from the README by someone who was not in the room: two Vultr VMs, pinned images, environment variables documented, no manual `docker exec` rescue.
- Supported scope is explicit in the UI and README. Unsupported repository/runtime combinations are rejected with a clear message; the v1 UI never promises "any GitHub repo". Add supported profiles as real adapters, not as special cases.
- Claims match evidence. "Passed these checks" means exactly the frozen cases passed; it never means safe, certified or correct. The recorded runtime tier is whatever the supervisor inspected, not what we hoped to ship.

## 2. Architecture: modeled on the OpenMuse / OpenBot reuse table

The system is one small application containing modules adapted from two audited upstream repositories. **Neither complete upstream app is the composition root.** Pins and paths are authoritative; the local clones are in `research/reference-repos/` (gitignored).

Audited pins: **OpenMuse `205cc386b75aae1a862f3fdd43104b570c8d0911`**, **OpenBot `3c73cf00efba46122dfd0447485e2b61f1d6a2cd`** (both MIT). Preserve MIT notices and record every copied file and its modifications in `THIRD_PARTY_NOTICES.md`.

| Capability | Actual upstream source | Integration decision |
|---|---|---|
| Durable orchestration | OpenMuse `apps/server/src/engine/worker.ts` | Adapt `TaskWorker`, its injected `TaskHandler`, lease/CAS claim, heartbeat, checkpoint and event interfaces. Implement `RepairHandler` at that seam. |
| Task storage | OpenMuse `apps/server/src/db.ts` | Adapt Store's PostgreSQL-compatible operations. Use PGlite in one controller process; add typed immutable-artifact and append-only-event methods. Use Postgres if API and worker are split later. SQLite is not a drop-in Store backend. |
| Guarded model tools | OpenMuse `apps/server/src/engine/model.ts` | Retain serial dispatch, schema validation, guard/checkpoint and tool-error feedback patterns. Replace its tool inventory and model-owned finish semantics. |
| Reviewed output identity | OpenMuse `apps/server/src/actions.ts` | Adapt content binding, expiry and idempotent proposal ideas into an artifact export grant. Do not carry Google email/calendar actions or uncertain external-write semantics into a repeatable download. |
| Sessions and task endpoints | OpenMuse `auth.ts`, `engine/routes.ts` | Adapt hashed session-token and task-route foundations. Upstream uses one `local-user`; explicit judge/operator permissions and task ownership checks are new work. |
| Narrow privileged service | OpenBot `supervisor/src/index.ts`, `names.ts`, `docker.ts` | Fork the standalone Bun/Hono + dockerode supervisor, derived resource names, ownership checks and lifecycle errors. Replace persistent per-bot computers with disposable task-attempt roles. |
| Offline container hardening | OpenMuse `apps/server/src/computer.ts` | Move/adapt create-and-inspect checks and stop/quarantine behavior **inside VM B's supervisor**. Preserve no-network/non-root/read-only/resource checks; change per-owner identity to per-attempt. Do not copy its app-local Docker access into VM A. |
| Shell and file tools | OpenBot `agent-computer/src/shell.ts`, `workspace.ts` | Borrow bounded result schemas and validation cases. Implement execution through the supervisor's container API. Do not import `createShell()` into a host service. Strengthen file reads and collection bounds. |
| Policy before effects | OpenBot `server/src/computer/gateway.ts`, `policy.ts` | Retain resolve resource → enforce policy → record intent → dispatch ordering. Use a small typed task/phase registry; the full browser gateway is unnecessary. |

**New Airlock code:** `RepairHandler`, direct Vultr model client, supervisor execution/freeze protocol, generation fencing and operation journal, bounded regular-file collector, pristine candidate materializer, external comparator, artifact manifests/export, and the task-specific UI.

Facts to keep in mind while adapting: OpenBot's upstream supervisor exposes only ensure/stop/reset/list and **has no command-execution endpoint**; adding a fixed supervisor-mediated runner is real integration work. Upstream OpenBot `reset` retains workspace storage. OpenBot's read-file method reads the whole file before truncating; the collector must stream capped reads. OpenMuse's action claim omits the approved hash from its atomic predicate; do not reuse it unchanged for export grants. Omit the full OpenMuse `createApp`/`AgentService`/conversation runtime and OpenBot app/bot/browser composition; both require hosted CopilotKit Intelligence, which Airlock must not depend on.

### Layout

```
apps/web/                         React/Vite task page and Report Export form
apps/control/
  api.ts                          Hono sessions, task endpoints, SSE, export
  repair-handler.ts               Deterministic phases around one model loop
  vultr-client.ts                 Serverless Inference only, normalized tools
  store/                          Adapted OpenMuse Store + typed repositories
  worker/                         Adapted OpenMuse TaskWorker
  verifier/                       Contract comparison, no candidate imports
  artifacts/                      Canonical manifests, diff, immutable storage
apps/supervisor/
  api.ts                          Adapted OpenBot narrow service
  runtime.ts                      Docker adapter + OpenMuse hardening checks
  operations.ts                   Fences, request digests and local journal
  lifecycle.ts                    Stop/freeze/destroy/reconciliation/janitor
packages/contracts/               Shared schemas, not secret/runtime config
runtime/python/
  Dockerfile                      Pinned supported runtime
  adapter.py                      Fixed JSON input / bounded output interface
  collector.py                    Fixed read-only bounded file-byte protocol
profiles/tabulate-365/            Base manifest and preapproved case contract
THIRD_PARTY_NOTICES.md            Copied source pins, licenses, modifications
```

Stack: Bun + TypeScript, Hono, PGlite, dockerode, React/Vite; Python 3.12 pinned runtime image. Direct chat-completions driver for Vultr Serverless Inference (`https://api.vultrinference.com/v1`); no JSON mode exists there, so structured output comes from forced tool calls. Model choice is made by a measured tool-call round trip on the live `/v1/models` list, never from a slide.

## 3. Trust invariants (never violate; every PR is checked against these)

1. **One authority per concern.** Controller owns identities, contracts, phases, budgets and export authorization. Supervisor owns container identity, actual execution, deadlines, termination and cleanup. Comparator owns required case IDs, expected behavior and the verdict. Artifact service owns canonical bytes and digests. The model owns none of these.
2. **Untrusted code executes only in its assigned sandbox.** Report text, generated code, candidate library, setup hooks and preview calls are all untrusted execution. Neither the control plane nor the comparator ever imports or executes candidate code. Nothing from a report runs on VM A.
3. **Candidate identity is immutable.** Verification, preview and export all use the same sealed `SourceManifest` digest, base commit, runtime/adapter digest and contract digest. Never read the mutable author workspace after sealing. Immutable inserts reject replacement; generic upsert is not allowed for artifacts.
4. **The worker cannot declare success.** `submit_candidate` advances only to freeze. An output field named `passed`, a forged JUnit file, pytest exit codes from inside the sandbox, or "all tests passed" in a log carry no authority. Timeouts, protocol errors, missing/duplicate/unknown case IDs and incomplete output cannot pass.
5. **Cancellation has an execution effect.** A DB status change or aborted HTTP request is not termination. Revoke dispatch → stop the whole container → confirm → fence late results. Failed teardown stays visible and blocks reuse. Crash between intent and acknowledgement yields `unknown/interrupted`, never an invented receipt.
6. **Ownership is checked at every access.** Task IDs, container names and digests are identifiers, not bearer tokens.
7. **No secrets, no network, no host in the sandbox.** `--network none` for every task role; no model key, provider credential, Docker socket, host mount or cloud-metadata route inside any container. Provider credentials live only on VM A.
8. **Runtime tier is inspected, never assumed.** gVisor (`runsc`) is the floor; Kata on the VX1 sandbox host is the target; plain `runc` is not an acceptable shipped runtime. The supervisor inspects the effective runtime before every dispatch and records runtime name and guest `uname` in the verification record. Local macOS development runs on `runc` and must be labelled `dev-unsafe`; it is never a deployment configuration.
9. **Every run record carries the five checkpoints:** host check (CPU virt, `/dev/kvm`, runtimes), execution log with exit codes, in-sandbox `hostname`/`uname` proof, an isolation probe that must be fully BLOCKED before agent work, and the "(no sandboxes)" teardown listing.
10. **All runtime model calls go through Vultr Serverless Inference.** No other provider anywhere in the runtime path. Development assistants are not runtime calls.

## 4. How we work

- **Evidence over claims.** A feature is done when its behavior is observed: a test, a recorded run, an inspected container. Nothing is described as deployed, isolated, measured or supported until it has been. Report failures with their output.
- **Time is never a constraint.** Hour targets in 35 §9 are loose ordering guidelines. Scope is reduced only when a gate fails on its evidence, never because of the clock, participant count or team size. Do not cut a feature "for time".
- **Tests tied to the central claim** (35 §9) are required, not optional: broken base fails and repaired candidate passes; empty/uncollected tests, malformed JSON, oversized output, launch failure and timeout cannot produce `CANDIDATE_PASSED_CHECKS`; changing a local test or claimed pass count cannot change the external result; an unchanged broken candidate with a forged success log still fails; snapshot bytes changed after verification refuse preview/export; export rejects out-of-scope files, symlinks and traversal; one task over its limits is terminated while another task and the control plane stay healthy; cancelled/expired work loses dispatch authority.
- **Vertical slice first.** Prove create → exec → stop → collect → fresh compare → preview → export with a labelled diagnostic candidate before wiring the live model repair; then replace the diagnostic with the real Vultr-driven repair and meet the live-repair gate (2 of 3 fresh hero attempts pass the external comparator).
- **Adapters, not special cases.** The first profile is `tabulate-365` (broken base `e13a4d0dd292cade200e653eb9155a1ca0f1dbea`; the later passing revision `87a9a4e07a5efb39b81fdb6ac513b1d345bb21fb` is maintainer reference only and is never supplied to the agent). Every new supported case is a profile directory, and the runtime image, dependency pins and contract are prepared explicitly; never `pip install` from issue text on any host.
- **Author and review are separate passes.** Whoever writes a module does not approve it; a reviewer pass checks it against §3 and the tests above.
- **Attribution.** Copied or adapted upstream code keeps its MIT notice and is listed in `THIRD_PARTY_NOTICES.md` with the pin, the path and what changed. "Built at the event vs reused" must be reconstructible from that file plus git history.
- **Secrets.** Never commit keys. `VULTR_INFERENCE_API_KEY` and supervisor tokens come from the environment; sandbox VM `user_data` carries no secrets. Scan before flipping the repo public.
- **Commits.** Small, one change each, imperative subject, body says what and why. Push after each.
- **NetBird** is an optional add-on attempted only after the core works end to end (peer-to-peer link for controller → supervisor first, then reverse proxy and judge-role gating). Nothing in the core may depend on it.
- **Prepared answers** live in 38 §3.6: why not OpenSandbox, why Kata rather than Microsandbox, why the two-VM layout is the baseline rather than the novelty.

## 5. Quick reference

- Hero issue: [python-tabulate #365](https://github.com/astanin/python-tabulate/issues/365), empty table plus `maxheadercolwidths` → `IndexError`. Demo wrapper: a trusted Report Export form calling the real library. Labelled historical replay, not a benchmark claim.
- Phases: `prepare → reproduce → baseline → repair → freeze → verify → ready`. Terminal outcomes as in §1.
- Proposed caps (measure before advertising): 1 CPU, 512 MiB, 64 PIDs, 30 s per author command, 64 KiB captured output, 5 min per author attempt, 2 repair attempts, 1 MiB per accepted source file, 4 MiB total candidate changes.
- Vultr: control plane on any plan; sandbox host on a VX1 plan (`/dev/kvm`); models served from `atl`. Inference API: no JSON mode, no embeddings; append `-normalize` for standard tool-call IDs; 401 and 422 are both auth failures.
- Research evidence on the reproducible cases: `research/22-feasibility-lab.md`. Rules: `research/01-rules-and-compliance.md`.
