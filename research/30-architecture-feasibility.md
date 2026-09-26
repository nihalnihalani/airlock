# 30 — Dress Rehearsal: buildable architecture and executed feasibility checks

Written 2026-09-26. Architecture teammate assessment for the current multi-agent review. This narrows and corrects the broad design in `27-final-pick-judge-panel.md`; it is not a claim that a product or Vultr deployment exists. Source audits were rechecked against the local OpenBot and OpenMuse clones. Temporary logic probes were authored and executed outside this repository; they are research, not submission code.

**Recommendation:** build a rehearsal-and-approval product for one operation: **release expired booking holds in a synthetic reservation service**. The result is useful: previously reserved inventory becomes available and a customer completes a persisted synthetic booking. Agent-written SQL executes against a disposable data twin. A trusted observer measures the changes. A person approves a typed effect set. A fixed executor applies that set only if the entire relevant database state is still identical. A judge renewing a hold invalidates the whole approval; a new rehearsal preserves that renewed hold.

Do not build generic production cloning, root-agent access, file reconciliation, arbitrary SQL replay into the live target, real payments, or partial application. Those are the largest sources of implementation risk and misleading safety claims in file 27.

**Decision precedence:** this is the architecture teammate report. Use [31](31-WINNING-PRODUCT-BRIEF.md) for the final staffing assumptions, earlier failure cutoffs and actual-schema validation requirement; those override the provisional schedule below.

## 1. What was actually measured

Two throwaway probes ran on macOS arm64. No cloud requests, model calls, third-party code execution, production access, or infrastructure spend occurred. An isolated temporary PostgreSQL cluster listened only on a Unix socket and was stopped afterward.

| Probe | Executed evidence | Limits |
|---|---|---|
| Python 3.14.3 / SQLite 3.53.4 logic stand-in | 11 assertions passed: actual release of two holds followed by persisted booking; renewal and phantom refusal; rollback after first update; retry after rollback; one effect across eight concurrent approvals; approval hash, target, expiry and effect-type rejection; counterexample to existing-row hashes | Database-wide SQLite write lock; not PostgreSQL or sandbox proof |
| PostgreSQL 17.11 (Homebrew) | 11 assertions passed, detailed below | Tiny three-hold fixture; fixed trusted test SQL; no LLM, gVisor, public UI, cloud latency or broker |
| PostgreSQL latency | 10 apply calls: min 11.927 ms, median **13.107 ms**, max 14.177 ms, **including a fresh `psql` process each time** | This is a local mechanism timing, not a service SLA or full rehearsal timing |
| SQLite latency | 30 clone/diff/apply logic runs: median 0.487 ms | Three records, no container overhead; not a product performance claim |

PostgreSQL checks:

1. Release two expired holds and persist a customer booking.
2. Renew a hold after baseline: **stale**, zero batch changes.
3. Insert an additional row after baseline: **stale**, zero batch changes, even though previously existing rows are unchanged.
4. Change capacity after baseline: **stale**, zero batch changes.
5. Inject failure immediately after the first row update: all effects and receipt insertion roll back.
6. Retry that rolled-back operation: applies once.
7. Eight parallel apply connections: exactly one `applied`, seven `already_applied` responses.
8. Hold `SHARE ROW EXCLUSIVE` locks during comparison/application: an ordinary concurrent `UPDATE` hits its 100 ms lock timeout without mutation.
9. Rehearse after renewal: release the other expired hold; keep the renewed hold `held`.
10. A restricted role cannot drop the holds table.
11. That role cannot mutate the expiry column when granted only `UPDATE(status)`.

A persistent copy of the raw result data is saved in [feasibility-results-2026-09-26.json](feasibility-results-2026-09-26.json).

Temporary artifacts: `/tmp/dress-rehearsal-feasibility/probe.py`, `pg_probe.py`, `pg-results.json`; the SQLite result path was `/var/folders/3k/bfy_yh4s0z5bv5d9g_hp3f9m0000gn/T/dress-logic-emjy_9t_/results.json`. These files are not part of the proposed submission. PostgreSQL probe functions were test helpers, not production-hardened authorization endpoints; approval digest/expiry validation was measured in the separate SQLite probe. No single integrated service has yet passed all tests.

**What this establishes:** full-state comparison and atomic typed application are tractable, including real database concurrency. **What it does not establish:** safe code execution, model reliability, deployed latency, snapshot boot speed, database transport isolation, or challenge compliance of an unbuilt deployment.

## 2. The exact product boundary

Use an explicitly synthetic venue with three seats, two expired holds and one active hold. The app treats a `held` record as an allocated seat until explicitly released. This is an intentional allocation-ledger model: otherwise simply excluding expired holds in every availability query would free the seats already and make the demo's cleanup action pointless. Expired holds cannot be confirmed without a fresh availability transaction.

Required state:

- `capacity`: event identifier and seat count.
- `holds`: stable integer identifier, event identifier, `held|released|booked`, expiry timestamp. No real customer data.
- `bookings`: stable identifier and unique hold reference; no money movement.
- Approval/receipt metadata: target identity, schema version, task identity, immutable typed effects, baseline fingerprint, frozen cutoff, approver, expiry, outcome and transaction receipt identifier.

The only promotable operation is `ReleaseHold{id, before, after}` where `after` changes exactly `status: held → released`, `expires_at <= cutoff`, and no confirmed booking references that hold. SQL generated by the agent never becomes an apply instruction. The executor's SQL is fixed, parameterized application code.

The policy also checks `held_count + booking_count <= capacity`, valid foreign keys, unique booking references, no mutations to bookings/capacity, and no unsupported columns/tables. A valid rehearsal may still be unsuitable to approve; measured effects and policy eligibility are different fields in the card.

The cutoff is sampled from the trusted database when exporting the baseline and is immutable for that rehearsal. Time advancing cannot make a hold already expired at that cutoff become valid again; a renewal writes the database and changes the fingerprint. A fresh rehearsal samples a fresh cutoff. UI countdowns do not authorize an operation. Approval expiry uses a trusted server clock, with a short demo TTL, and is checked inside the transaction after lock acquisition.

This is one useful adapter, not a general database safety system. It does not establish GDPR compliance or suitability for a customer production database.

## 3. Trust placement and transport

```text
Public browser on HTTPS
  ├── synthetic booking page: normal application operations
  └── rehearsal page: request / review / human approve
                    |
Vultr VM A: control plane
  agent loop → Vultr Serverless Inference
  durable events, authentication, immutable proposals
  no model-written code execution; no Docker socket
                    |
          narrow authenticated supervisor API
                    |
Vultr VM B: execution host, supervisor is the only runtime manager
  ├── per-task unprivileged code container: files + Python, network none
  ├── per-task trusted PostgreSQL companion: synthetic logical clone
  │     separate DB data volume, never mounted into code container
  │     fixed SQL runner with restricted database role
  ├── trusted observer: before/after data export and policy validation
  └── sanctioned live-demo target sandbox
        synthetic live DB + fixed atomic apply/booking executors
```

The agent holds no infrastructure, inference, control-plane or live-target credentials. It is **not root**. The PostgreSQL server and the trusted observer are outside its writable filesystem. A malicious command can destroy its own workspace; that does not modify the observer, baseline, proposals, live target or controller.

**Explicit SQL transport:** the agent requests `run_sql(sql)` as a tool. The control plane validates task ownership/state and sends it to the supervisor with a server-derived task ID. The supervisor selects the task's PostgreSQL companion internally and dispatches a fixed SQL runner **inside that sandbox**, as a dedicated unprivileged database client identity. Use a database driver with parameterized transport, not `psql` meta-command interpretation and not shell interpolation. The runner passes SQL to its own companion database only. `run_sql` has no caller-selectable hostname, port, database name, role, Docker ID, mount, or credential field.

Peer authentication over a companion-local Unix socket maps that fixed OS identity to the restricted rehearsal role; no password or API key needs to enter the agent's code container. The code container has no network route to PostgreSQL, the supervisor or any live target; it does not receive the supervisor authentication token. This peer mapping and the dispatch placement are **planned and must be tested**, not validated by the local SQL probe. If peer mapping fails, fix the companion runner rather than putting a broad database password into the agent workspace.

Grant the rehearsal role only schema usage, selection of the three synthetic tables and status-column updates on holds. It is neither owner nor superuser and cannot create functions, alter schema, grant roles, change capacities/expiries, invoke server programs or access live databases. Set statement/lock/transaction timeouts and result-size caps. The trusted role creates baseline data and reads final state through a separate path. Infrastructure keys stay on VM A; the supervisor needs only local container authority for the MVP.

Code tools (`write_file`, `run_python`) execute inside the code container. SQL execution occurs inside the companion sandbox, not in the API process. The model is the only agent decision-maker; neither the compiler nor human approval is exposed as an agent tool. Agent narration cannot set the effect count or claim success.

**C1 interpretation:** all agent code and SQL actions are sandbox-dispatched on Vultr, satisfying the intended C1-04/06 separation. The live target is itself a separate, sanctioned synthetic sandbox; Apply is a human-triggered fixed application transaction, not an agent with production access. This is a conservative implementation reading of the organizer requirements recorded in `01-rules-and-compliance.md`, not a newly verified organizer exemption. Never label this as executing safely against real production.

## 4. Snapshot → observed effects → atomic approval

1. **Capture a consistent logical snapshot.** In one trusted `REPEATABLE READ` transaction, export capacity, holds and bookings, record schema/target identity and cutoff, and compute a canonical SHA-256 fingerprint over the exact exported rows. Seed the twin from that very export. Never compute a fingerprint in one transaction and clone data in another.
2. **Execute the actual task.** The agent reads schema/sample data, writes SQL/code in its workspace, executes it against the twin and handles stderr through at most two retries. A proposal cannot be created until execution completed and the observer measured the result.
3. **Freeze observation.** Stop admitting tool requests; revoke task dispatch; wait for or terminate all task SQL sessions and roll back unfinished transactions. Kill the code container before accepting an after-image. The trusted observer reads the companion in a read-only consistent transaction. An observer failure or malformed schema means `inconclusive`, never safe. Do not trust a JSON report written by the agent.
4. **Compile a bounded effect set.** Compare stable rows before/after, sort effects by key, validate the limited operation and business invariants. Every observed data change must either map to a permitted effect or make the whole run non-applicable. Keep stdout as evidence only. Hash a canonical envelope containing target, schema version, baseline hash, cutoff, effects, policy version, task ID and expiry.
5. **Approve from the browser.** A server-authenticated human approves `{proposalId, digest}`. Look up immutable stored effects; never accept replacement effects from the browser. Require that identity to have the approver role, protect against CSRF, and record the approval durably.
6. **Apply in one database transaction.** Lock the proposal/receipt identity first, then all relevant tables in one documented order using a write-conflicting mode such as `SHARE ROW EXCLUSIVE`; all executor paths use the same ordering. After locks are acquired, recheck proposal hash, status, target, policy version and expiry. Hash current capacity/holds/bookings under the locks and require equality with the baseline. Then validate and execute all fixed typed updates, check invariants again, and write the receipt/idempotency record in the **same transaction**. Commit once.
7. **Recover honestly.** A duplicate request returns the committed receipt. A lost HTTP response is resolved by reading that receipt. If the commit outcome cannot yet be established, show `outcome_unknown` and reconcile; do not blindly run again. Task teardown failure is a separate failure field even if business apply succeeded.

Why whole relevant-table hashing: per-row preconditions miss rows inserted after rehearsal, predicate membership, capacity changes and related-table state. A tenant revision can be efficient later but requires proof that every write path increments it. The tiny fixture makes full-table hashing and a brief global table lock simpler and more defensible. This conservative approach rejects unrelated writes too and serializes writers; it is intentionally not presented as a scalable multi-tenant design.

Why whole-batch refusal: a valid-looking subset can violate relationships or the user's intended action. Do not silently apply unaffected rows. Display **“Nothing applied: reservation state changed. Rehearse again.”** The next real rehearsal should release only the still-expired hold, allowing the booking page to show the useful result.

The PostgreSQL probe measured fingerprint comparison, lock behavior, typed updates, transactional receipts and rollback. It did not measure the integrated immutable-proposal service or snapshot export/seed pipeline; those remain explicit build gates.

## 5. OpenBot / OpenMuse reuse ledger

Rechecked source commits:

- OpenBot `3c73cf00efba46122dfd0447485e2b61f1d6a2cd` at `research/reference-repos/openbot`.
- OpenMuse `205cc386b75aae1a862f3fdd43104b570c8d0911` at `research/reference-repos/openmuse`.

| Pattern to adapt | Exact source files / locations | Required change for this product |
|---|---|---|
| Human approval lifecycle, hash binding, expiry, unknown outcome | OpenMuse `apps/server/src/actions.ts:39-191` | Replace Google write types with immutable `ReleaseHold` envelope. Bind tenant/target/policy/cutoff. Recheck digest and expiry in the final atomic claim, not just earlier request reads. |
| Atomic claim and crash recovery | OpenMuse `apps/server/src/db.ts:78-105` | Claim/receipt and target mutations must share a target-side transaction; separate control-plane DB commits cannot confer exactly-once effects. |
| Worker lease + guard before effect + CAS checkpoint | OpenMuse `apps/server/src/engine/worker.ts:116-248` | Lease controls dispatch; add supervisor task revocation/fencing so an already submitted tool cannot continue writing after observation begins. A controller heartbeat alone cannot enforce this. |
| Inspect before attach | OpenMuse `apps/server/src/computer.ts:225-294` | Verify per-task identity, immutable image digest, mandatory limits/runtime, no privileges/host binds, expected network and volumes. Do not reuse an old container with mismatched controls. |
| Narrow supervisor vocabulary and server-derived identity | OpenBot `supervisor/src/index.ts:19-134`; `supervisor/src/names.ts:67-90` | Implement task-scoped create/dispatch/freeze/destroy/status, fixed images and limits. No arbitrary Docker API passthrough or user-specified mounts. |
| Container isolation flags | OpenBot `supervisor/src/docker.ts:418-457` | Make `runsc`, memory/CPU/PID caps mandatory; change restart policy from `unless-stopped` to `no`; network none for code containers; no browser or persistent profile volumes. |
| Audit before action | OpenBot `server/src/computer/gateway.ts:532-620`; `server/src/audit.ts:557-586` | Write dispatch intent before supervisor call; an audit failure blocks dispatch. Output remains bounded, untrusted data. |
| Deny-before-allow evaluator | OpenBot `server/src/computer/policy.ts:285-340` | Keep the ordering principle; a tiny typed policy suffices here. Do not inherit allow-all startup defaults from `policy-store.ts:52-56`. |

Prefer a small new service implementing these patterns. Both full applications require CopilotKit Intelligence at startup in the audited versions (`07`/`08`); OpenBot routes computer tools through a browser, while OpenMuse runs Docker control in its API process. Integrating both whole apps adds unnecessary runtime, identity and external-service dependencies. No need for their disabled bridge, browser automation, voice, integrations or full chat UI.

These are static source checks plus our own database experiments, not upstream tests executed locally. Preserve MIT attribution for copied/adapted code and list original event-built components separately. The strongest reusable asset is the lifecycle discipline, not a claim that inheriting their code automatically makes this system secure.

## 6. Failure injection and demo truth

| Injected condition | Required visible behavior | Evidence to retain |
|---|---|---|
| Judge renews a hold | Entire approval rejected; zero changes; fresh rehearsal excludes renewed hold | Before/after fingerprint, target rows, receipt status |
| Phantom row or capacity change | Same whole-batch refusal | Relevant-table fingerprint change |
| Duplicate approval / concurrent clicks | One committed effect, repeated receipt | Unique plan receipt in target transaction |
| Executor fails after first update | No partial release and no success receipt | Rolled-back target state |
| Malicious SQL attempts DDL or expiry mutation | DB role refusal; stderr returned; no promotion | SQL error, unchanged trusted data |
| Agent deletes workspace | Only per-task workspace lost; live booking page remains healthy; task destroyed | Host/live sentinel checked outside task |
| Agent infinite loop | Supervisor timeout kills task, bounded resource use, lifecycle completes | Measured elapsed timeout and independent teardown evidence |
| Agent outputs forged “2 released” text | Observer's actual row diff wins | Diff computed from trusted DB |
| Controller restart or lost response | Reconcile known receipt or show unknown, never replay indiscriminately | Stable proposal ID and durable receipt |
| LLM unavailable | Clearly labelled fixed-runbook replay can demonstrate engine; separate live-agent requirement remains unpassed | `mode: replay`, no invented model transcript |

Containment is mandatory for the submission video. A workspace deletion or bounded infinite loop is sufficient and safer to implement than a fake cloud-volume deletion. Do not claim “root could do nothing,” “no exfiltration,” “tamper-proof,” generic rollback, or production safety. Planned network none and runsc controls need deployed checks. A receipt proves which bytes and transaction outcome the service recorded; it is not independent certification.

## 7. Twenty-four-hour implementation plan and gates

Relative hours are measured from the event's official start of hacking. This work is a research artifact; do not backdate pre-event probes as event-built product code.

| Hours | Engine teammate | Infrastructure teammate | Product/agent teammate | Gate |
|---|---|---|---|---|
| 0–2 | Schema, canonical export/hash, fixed typed executor, receipt transaction | Vultr backend + execution host; gVisor; sealed code/PG companion smoke test | Tiny reservation page + sold-out/booking states; inference forced tool-call probe | Actual Vultr inference tool call parses; companion role/network boundary tested |
| 2–5 | Whole-table locks, stale/phantom/rollback/duplicate tests | Task-scoped supervisor, fixed SQL runner, secret scan, resource caps | Agent read/write/run SQL loop, stderr retry, honest mode labels | Headless baseline→clone→execute→trusted diff→approve→apply→book completes |
| 5–8 | Freeze protocol, immutable proposal hash, target-side receipt reconciliation | Kill/revoke/terminate/teardown and supervisor restart behavior | Human approval card, SSE log, judge renew control | Drift causes zero writes; fresh rehearsal preserves renewal |
| 8–12 | Adversarial SQL, malformed after-image, expiry, role and invariant tests | Workspace deletion and timeout containment on Vultr | Three complete useful agent runs, error/retry case, browser flow | Live model completes useful flow at least 3/5 times; all deterministic safety tests pass |
| 12–16 | Harden integrated failures; stop adding effects | Public HTTPS/access + janitor; optional NetBird only if owned and proven | Stage demo, receipt download, clear synthetic-data labelling | All required C1 evidence captured on deployed stack |
| 16–20 | No new features; reproducible resets | Cost/cleanup check; warm task capacity if measured helpful | Five timed rehearsals, then record ≤60-second video | Mandatory containment and real completed booking fit recording |
| 20–24 | Fix only submission blockers | Verify judge URL remains accessible, no credentials leaked | README reuse table, architecture, limits, public repo, submit early | All deliverables open from a clean browser |

For two people, combine engine/infrastructure and product/agent. For solo, keep one event, one operation, one page, one code-container image, no NetBird or snapshot tier. Do not expand the number of adapters because the first run is green.

**Hard gates:**

- If SQL broker isolation/role enforcement is not green by hour 2, do not expose a credentialed direct DB connection to the agent. Fix transport and cut UI polish.
- If headless atomic end-to-end behavior fails by hour 5, cut cloud snapshots, custom networking, signing and bonus scope immediately. The core product is the actual reservation transaction.
- If deployed isolation/teardown fails, the app is not ready for the mandatory containment claim, however polished the demo looks.
- If the live agent cannot complete the task reliably by hour 12, simplify the task and tool schema. Label replay honestly; do not claim replay meets the live agent requirement by itself.
- A one-hour fallback to an unrelated product is not credible. Keep the same narrow adapter and reduce presentation scope; abandon only after an explicit evidence-based decision by the team.

Optional Vultr instance-per-task provisioning is a differentiator only after core correctness and recorded containment pass. A whole-machine production snapshot does not belong in this MVP: synthetic logical exports avoid copied secrets, PII, configuration drift and unmeasured restore semantics. Vultr remains the deployed control plane, inference provider and isolated execution fabric even without the optional snapshot spectacle.

## 8. Questions this architecture deliberately leaves open

Not yet measured: gVisor/PG companion operation on the chosen Vultr image, peer-authenticated SQL runner placement, task revocation and observer freeze races, inference model quality, logical clone latency with realistic data size, deployed memory/CPU costs, public-hosting access, or NetBird bonus integration. Those are concrete spike targets, not reasons to inflate the product scope.

The best next action at hacking start is to implement the narrow headless loop and rerun these failure tests against the actual deployed components. Winning depends on a judge watching inventory become bookable, seeing a changed reservation preserved, and seeing an unsafe command contained—not on the number of cloud features named in an architecture diagram.
