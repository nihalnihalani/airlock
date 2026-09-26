# 28 — Astra devil's advocate: keep the rehearsal, reject the universal twin

**Reviewer:** GPT-6 Astra. **Date:** 2026-09-26. This is an independent design critique, not customer validation, a live infrastructure test, or a prediction of actual judges' scores. Inputs: 27, 25, 01, 07, 08, the supplied Gary-Yau Chan article, and a targeted read of 22's experiment results. The Recovery Desk variant below was proposed during this review by the product teammate through the lead agent; the objections and narrowed recommendation are my assessment. No product code was written for this review.

## Decision

**Build Dress Rehearsal as a narrow Recovery Desk for a broken reservation system. Do not build file 27's general production twin.**

The user-facing promise is: **“Let the agent fix the booking problem on a disposable copy. Review the actual changes. Apply them only if the live data still matches.”** End the demo with a customer successfully booking a slot that was unavailable at the start.

The product should support one useful repair: release expired reservation holds after a failed cleanup worker. It should support one database, one small known schema, one typed class of updates, one approval, and atomic whole-batch conflict refusal. Everything else in 27 is scope debt until this works.

This is my highest-upside choice **for a team with at least two effective builders and an early passing correctness gate**. Repro Receipts remains the better conservative choice for a solo builder, or if the repair/apply gate fails early. Neither currently has evidence of a complete working deployed product. File 22's real measurements improve Repro Receipts' odds, but they are native macOS verifier experiments, not an end-to-end Vultr agent deployment.

## Why I reject 27 as written

### 1. The signature judge interaction can silently do the wrong thing

27 says a judge books a rental for a customer on the purge list, then the product refuses that customer's row because its hash changed. **An inserted booking need not change the customer row.** The check can pass despite a relevant new booking. A cascade may then delete an unapproved child row, or a restrictive foreign key may fail the transaction instead of producing the promised partial result.

More generally, comparing only rows in the proposed write set misses changed rows that informed the decision and newly inserted rows satisfying a relevant predicate. “N−1 applied, one refused” also assumes the selected mutations are independent. They may encode one business operation whose partial execution is invalid.

**Correction:** reject the entire batch when any relevant state changed. For the tiny fixture, fingerprint every supported business table, then recheck under write-conflicting locks in the same transaction as apply. A tenant revision is acceptable only if every writer, including inserts, deletes and support operations, is guaranteed to increment it transactionally. A counter incremented by just the booking form is demo choreography, not a concurrency control boundary.

### 2. “Only that exact effect ever touches production” is much stronger than a diff

Replaying rows can fire database triggers, cascade into other tables, affect sequences, and invoke application behavior. Files plus SQL plus a mock cloud journal do not have a common transaction boundary. Children-first ordering does not solve arbitrary schema dependencies or business invariants.

**Correction:** accept only a declared schema with no application triggers or cascading writes and a tiny operation vocabulary. Detect unsupported schema or effects and refuse promotion. The independent verifier must calculate the changes and enforce their vocabulary; the model cannot write the verdict. Do not describe the resulting implementation as a general migration, infrastructure, or filesystem promotion engine.

### 3. Root on the twin also threatens the measurement

If the agent can rewrite the database server, the manifest generator, the agent-side audit log or the binary queried by the differ, a neat after-state card may just be attacker-controlled testimony. Hashing that testimony does not repair the trust boundary. A canary inside the same root-controlled VM is not a guaranteed detector.

**Correction:** for the useful workflow, the agent runs as an unprivileged user and accesses a clone through a limited DML role. The database service, observer and policy are outside agent-writable paths and identities. No database ownership, superuser access, DDL, extensions, trigger creation or privilege changes. Arbitrary workspace code remains sandboxed; it does not own the measuring apparatus. Host-side observation and the trusted apply worker are separate from the model. Cut the sentence “the agent had root.”

### 4. Cloning real production violates the design's own secret-hygiene story

27 alternates between “no keys anywhere on the twin” and acknowledging copied secrets and PII. Scrubbing known files in user-data is not evidence that a production disk contains no credentials, logs, database tokens or sensitive customer data. An allowlisted egress destination and model-visible output are also possible disclosure channels. A forensic snapshot preserves the same sensitive material.

**Correction:** the hackathon system uses seeded synthetic business data and clean sandbox images. Call it a live demo application, not a sanitized clone of an actual customer production system. No Vultr, inference, payment or customer credentials enter the execution environment. A broader production-import feature is future work, not a checkbox.

### 5. Five cloud API calls are not five demonstrated product advantages

Snapshot, boot, VPC, quarantine, forensic snapshot and deletion put several asynchronous systems on a three-minute path. Even 27 reports unknown boot, delete and hot-detach behavior. A warm VM is sensible engineering, but it is not evidence of a fresh current-state clone. Restoring a production snapshot can also discard legitimate writes that occurred afterward; it is not safe per-action undo.

**Correction:** a prewarmed clean image is allowed, followed by a fresh coherent database export at the start of each rehearsal. Say which is warm and which is fresh. Do not restore production as rollback. Use two Vultr VMs, inference, real per-run isolation and disposal first. Add a throwaway-instance implementation only after the product succeeds and timing is measured. Cloud feature count is not the objective.

### 6. The disaster theatre is partly mocked and overlong

27's `volumeDelete` is a mock API, yet the card counts a volume and backups alongside genuinely changed rows and files. That is easy to hear as a real cloud deletion demonstration. The frozen transcript, injected exfiltration, canary, forensic snapshot, URL death, failed SQL, judge interaction, receipt signature, replay, three model names and close compete for 180 seconds. The advertised core already totals about 39.5 estimated person-hours before the most sponsor-specific VM features.

**Correction:** show one actual unsafe operation contained in a disposable environment, clearly labeled a containment test. Spend the larger share of the demo on the useful repair and its visible result. No phantom god-token or mocked cloud counts. No manufactured live model error to obtain a scripted retry moment; show a real captured error/retry separately if the live run succeeds first time.

### 7. The panel numbers provide false precision

“Every judge already knows,” exact imagined reactions and a −0.3 evidence discount are not observations. The choice can reverse inside those arbitrary discounts. Adding three models does not create three units of technical merit. Acquisition values in other categories do not validate demand for this product.

**Correction:** use judge archetypes as questions to answer, not as invented votes. State the actual buyer hypothesis and actual limitations. Use measured task latency, changed records and completed bookings. Report interviews only if conducted, with the number of people and what they actually said.

## The exact working product

### Workload and visible result

A small booking application has inventory, reservation holds and completed bookings. Its normal inventory calculation counts holds with status `held`. An expiry worker has stopped, so expired holds remain `held`, making the application show “sold out.” This explicit failure mode makes the repair meaningful; do not quietly define availability to ignore expired holds and then claim releasing them fixes anything.

The operator asks: “Recover availability by releasing expired holds. Preserve current reservations.” The agent inspects the supplied schema/data, writes a repair script or SQL file, executes it on a fresh disposable copy and checks the resulting availability. A fixed UTC cutoff is supplied in the task and bound to the approval. It is not repeatedly regenerated with `now()` in different phases.

The observer produces a card such as “Release 3 expired holds; preserve 1 current hold; 0 bookings changed.” These are illustrative numbers until backed by the fixture. The preview shows the booking application against the repaired copy. After approved apply, the real demo application's availability changes and a customer can make a real synthetic booking.

This repairs the current backlog, not the stopped worker itself. Show “availability recovered; expiry worker still needs repair” if that remains true. Do not claim permanent incident resolution from a one-time data repair.

### Supported effects

- One PostgreSQL fixture schema, small enough to compare all business rows on every rehearsal/apply. Prefer hundreds of rows over 40,000 decorative rows.
- Promotion supports only `reservation_holds.status: held → released` on existing explicit IDs. Expiry, inventory identity and other fields remain unchanged. No arbitrary SQL is executed on the live demo database.
- A release is valid only when the authoritative before-row was held and expired at the approved cutoff. Existing bookings must be unchanged. Extra or unsupported effects make the whole proposal ineligible.
- The sandbox can execute unprivileged code and broader DML experiments within its declared permissions; promotion remains restricted. A wrong repair should visibly produce a rejected proposal, not be hidden by a narrow tool that cannot make any mistake.
- No file promotion, schema changes, customer erasure, refunds, email, payments, cloud deletion, shell on the live service, or snapshot rollback.

### State and promotion contract

1. A trusted component captures a coherent baseline of all relevant tables and the schema. Export and fingerprint must refer to the same database snapshot. A copied running Postgres data directory is not an acceptable substitute unless its consistency is established.
2. A per-task execution environment receives only synthetic rows, schema, task text and a fixed cutoff. It contains no production/provider secrets. If local database authentication is needed, use a sandbox-only constrained identity; never a live-system credential.
3. The agent writes and runs the repair in that environment. The observer compares authoritative before/after state; schema deviations and unsupported mutations refuse promotion. SQL output and agent-authored JSON are not authoritative effect manifests.
4. The approved immutable object binds task ID, baseline fingerprint, schema fingerprint, cutoff, sorted typed effects, policy version and expiry. The approval endpoint accepts a reference/hash; it never accepts replacement effects from the browser.
5. A trusted apply worker claims the proposal once, locks the supported business tables in a consistent order against concurrent writers, rechecks their complete fingerprints and schema, and validates every typed effect. Any mismatch rolls back the whole batch. Set a short lock timeout and show “busy, rehearse again” rather than hanging the product.
6. The worker runs parameterized explicit updates, checks affected row counts, checks postconditions, and writes an apply-ledger row in the **same database transaction**. A connection lost around commit becomes an unresolved outcome until reconciled from that ledger; it is never blindly dispatched again.
7. Dispose of the rehearsal environment after results are collected. The receipt records actual IDs, code hash, baseline, effects, approval, outcome, timestamps and observed final state. A signature is optional; integrity of the transaction is not.

Full-table fingerprinting and short write locks are intentionally blunt and appropriate only for this tiny workload. They make the guarantee explainable and testable. Do not claim large-database scalability or O(rows touched). A mature product needs carefully scoped dependency tracking, different concurrency strategies and workload-specific connectors.

### Challenge compliance

The web UI, orchestration and state run on Vultr. All agent model calls use Vultr Serverless Inference. Every agent tool executes in its task sandbox; the agent has no “apply to production” tool. The human-approved typed apply is a separate trusted path.

For the event, keep the target demo business service in an isolated workload as well. The broad wording “every action contained inside a sandbox” in 01 C1-06 is a real interpretation question for promotion to external production. Confirm that boundary with organizers before claiming an external-production capability; no approval is needed to build the fully isolated synthetic demonstration. The public browser flow, real code execution, stderr feedback, limits, lifecycle cleanup and recorded containment moment remain required. A replay-only collection of frozen scripts is a fallback demonstration, not a satisfactory substitute for the agent requirement.

## Best alternatives, assessed without pretend scores

| Candidate | Strongest case for it | Why it loses / when it wins |
|---|---|---|
| **Narrow Recovery Desk / Dress Rehearsal** | A comprehensible problem becomes a visible working service. Concurrency refusal and successful recovery demonstrate more than narration. A plausible platform/support-team buyer. | New apply engine and no customer validation. Wins only if a deployed useful loop plus adversarial gate pass early. |
| **Repro Receipts, curated PoC lane** | The only candidate here with directly recorded component experiments: 30 deterministic issue/ref pairs and working offline installs in 22. Small untrusted-code workflow; no live business-state promotion. | Less intuitive product payoff and real deployed/model work remains. **Wins for solo scope or early Recovery Desk failure.** Do not call the existing lab a completed product. |
| **Try Before You Trust, MCP/package rehearsal** | Clear developer pain and a meaningful install/use preview. | A short execution cannot certify package safety. Network interception and preview plumbing expand the unknowns. A safe-looking result may be the least informative one. Prefer only if an actually working package-preview path already exists; none is established by the inputs read. |
| **Tap In / human browser handoff** | Easy to understand and NetBird can be directly relevant. | Browser reliability and competitive differentiation are weak in this comparison. It is not the strongest main-prize bet unless a working browser product is already available. |
| **Honeypot Hire / agent certification** | Catching a real violation can be dramatic. | The meaningful negative result is ambiguous, and the interesting failure is stochastic. Poor fit for a reliable three-minute main demo. |

The correction is not “rehearsal is entirely new.” Database copies, staging, previews, dry runs, approval workflows and optimistic concurrency are familiar ideas. **The entry point worth building is the whole incident-to-repair workflow:** an agent performs useful work on a disposable copy, a human sees actual supported changes, and a constrained promotion step refuses stale state. That is a product integration claim, not a novelty or moat proof. If a judge says a database branch plus an approval could do this, agree and show the working workflow. Do not spend the slot arguing terminology.

## Reuse OpenMuse and OpenBot selectively

The audits support code/pattern reuse, not a full fork. OpenMuse's action-bound approval, atomic claim, expiry and uncertainty states are the best existing ingredients. Adapt its task lease/guard/checkpoint loop only if needed for the bounded workflow. Use a small web UI with an approval card and event stream.

From OpenBot, borrow the narrow supervisor API, default-deny policy structure, audit-before-act and server-owned references. Key environments by task. Keep the Docker socket and infrastructure authority in the supervisor, not the public API. Explicitly enable hardening instead of assuming opt-in defaults are active.

Do not inherit the audited OpenBot allow-all default, browser-mediated tool execution, shared bot environments, single-container trust boundary or public development tokens. Do not inherit either application's mandatory Intelligence dependency, the disabled OpenMuse/OpenBot adapter, Expo app or uncertain model transport wholesale. Both audits are static inspections; upstream tests and claimed capabilities are not local validation. Declare reused source and preserve its license notices. Check the actual transport with Vultr before choosing an adapter.

## Gates that can actually kill the idea

Use times relative to the official permitted hacking start. These are proposed gates, not measured durations. The point is to stop before spending the night polishing a false promise.

| Gate | Required evidence | Failure decision |
|---|---|---|
| **T+45 min: substrate** | Vultr inference returns a real parsed tool call; sandbox runs code on Vultr with limits and teardown; public skeleton URL exists. | Fix the shared substrate. Switching product names cannot fix a missing required inference/deployment path. |
| **T+2 h: useful path headless** | Fresh coherent clone → repair execution → observer-generated typed effects → approval → transaction → successful booking. Repeat three times from clean fixture. | Choose Repro Receipts immediately if the path is fundamentally incomplete; no VM snapshot work first. |
| **T+3 h: adversarial promotion** | Judge-like hold renewal, a newly inserted booking, unsupported changes, duplicate approval and commit-uncertainty handling all pass the cases below on the deployed stack. | Repair within a strict short budget or pivot. No partial-apply workaround and no UI hiding failed cases. |
| **T+5 h: actual agent** | At least 4/5 fresh supported tasks complete the useful loop with the real Vultr model inside the chosen latency budget; at least one genuine stderr→retry path is observed and retained. | Simplify task/tool descriptions or model choice. A labeled stored-code fallback is fine for a bad stage call but cannot be the entire product. |
| **T+8 h: public product** | A different browser user can start a bounded task, see the preview, approve, encounter a conflict and complete a booking. No terminal rescue. | Freeze feature scope; concentrate on the flow and deployment. Cut every optional cloud/API feature. |
| **Final morning** | Two timed rehearsals, reset procedure, model-failure fallback, ≤60 s recorded video with actual containment, public repo/setup, live URL. | Submit the working supported scope; do not manufacture evidence for missing behavior. |

Adversarial cases the apply gate must pass:

1. Renew a candidate hold after rehearsal: **zero updates applied**.
2. Insert a booking or a relevant hold without changing the candidate rows: **zero updates applied**. This defeats 27's write-set-only mistake.
3. Change one supported row while a batch has multiple effects: the result is all-or-nothing, never “some applied.”
4. Run a write concurrently with fingerprint verification: it is serialized by the lock or causes refusal; it cannot slip between verification and commit.
5. Modify expiry/inventory as well as status in the twin, or tamper with the submitted approval payload: promotion refused.
6. Submit the same approval concurrently: at most one database apply, same ledger result afterward.
7. Lose the connection around commit: reconcile the ledger; never issue an unproven second mutation.
8. Kill or exhaust the sandbox: the demo target and control-plane sentinel are unchanged, and the environment is disposed of.

These are tests of the product's central claim, not a broad security certification. No finite hackathon test suite proves arbitrary hostile software safe.

## The three-minute demo

| Time | Action and screen | Spoken point |
|---|---|---|
| **0:00–0:15** | Real demo booking page shows sold out; operations card shows expired holds left by a failed cleanup worker. | “The booking system is losing orders. The data cleanup is simple; doing it safely while customers keep booking is not.” |
| **0:15–0:55** | Start Recovery Desk. Show actual Vultr model tool events: inspect, write, execute, validate. Display the copy's preview and measured effect card. | “The agent repaired a disposable copy. These are the records it actually changed.” |
| **0:55–1:20** | A judge renews one candidate hold through the app. Click the existing approval. Full batch refuses, with zero applied and a concrete drift reason. | “The customer changed the live state. This approval is now stale.” |
| **1:20–1:55** | Fresh rehearsal of the same generated repair code against a new copy, explicitly labeled as such; new smaller effect card; approve; successful atomic apply. | “Rehearse the current state, approve the new changes. The renewed reservation survives.” |
| **1:55–2:20** | Refresh the booking page and book the recovered slot. Show the resulting booking record. | “The useful result is a booking that was impossible two minutes ago.” |
| **2:20–2:40** | Separate labeled containment test actually deletes disposable workspace files or hits a bounded infinite loop; supervisor destroys the run; live booking remains intact. | “Unsafe code can destroy its workspace. It cannot reach this service or our keys.” |
| **2:40–3:00** | Compact receipt: task, code/effect hashes, approved rows, conflict run, final booking, destroyed sandbox; one architecture strip and buyer line. | “A recovery desk for support and platform teams: agent execution on Vultr, measured changes, human approval, stale-state refusal.” |

All timings are targets pending measurement. Warm images are fine, but refresh task data live. If the initial live model call overruns, use a clearly labeled previously generated repair script on a fresh copy and continue; keep the real agent evidence accessible. If the judge declines, the operator uses the same public app action. Do not substitute a prerecorded card for a live database result. The 60-second submission cut prioritizes useful outcome plus the required containment moment; signatures, investor comparables and cloud console tours are dispensable.

## Hard judge questions and credible answers

| Objection | Answer the implementation must earn |
|---|---|
| “This is just staging.” | “The copy alone is familiar. We built the repair workflow, measured effect review and a promotion step that refused your intervening write. Here is the successful booking.” |
| “Your database is tiny.” | “Yes. We support this schema and whole-state validation today. Large or arbitrary databases need a different dependency/concurrency design.” |
| “Why not a stored procedure?” | “For this fixed incident, a stored procedure is a valid cheaper solution. Our hypothesis is that teams need the same review and containment workflow across varied support repairs. That expansion is unvalidated.” |
| “Can I give it arbitrary production root?” | “No. The useful path is an unprivileged sandbox and a constrained database role. Promotion supports one typed effect class.” |
| “Are you guaranteeing safety?” | “We guarantee only the implemented validation/transaction behavior for this supported fixture. We do not infer general safety from a successful rehearsal.” |
| “Who pays?” | “The hypothesis is platform/support teams operating SaaS systems with recurring manual data repairs. We have no paid demand evidence unless we have actually collected it.” |
| “What did you reuse?” | “Approval and supervisor patterns from the audited MIT projects, with exact copied files declared; our event contribution is the repair workflow, verifier, apply contract and working experience.” |

The supplied Chan article's useful lesson here is one or two memorable working features, a legible frontend, real validation and a rehearsed demonstration. Its prototype-only advice is not suitable for this user's requirement that the product truly work, nor for a challenge explicitly requiring real execution. **The decisive evidence is a recovered booking plus an adversarially tested refusal, not a more elaborate story about the judges.**
