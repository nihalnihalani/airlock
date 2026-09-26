# 29 — Product and demo challenge: make Dress Rehearsal finish a job

Written 2026-09-26. Product/demo teammate's independent recommendation, using the supplied Gary-Yau Chan hackathon guide and research 01, 07, 08, 23, 25, 26a–c, and 27. This is a proposal, not an implemented or customer-validated product. Prior simulated judge scores are opinions, not evidence of judges' preferences or win probabilities.

## Decision

**Build Dress Rehearsal, narrowed to repairing a booking system whose expired reservations still consume inventory.** A customer must successfully book something at the end. The product is a supervised operations agent with an executed preview; the sandbox is the mechanism that lets it do the work.

Pitch: **“Let an agent fix the booking outage on a disposable copy. Review the actual change, then reopen bookings without losing a current reservation.”**

Keep the name. Change the default task from “GDPR purge” to “restore bookable inventory.” Do not build a universal production twin, arbitrary cloud-change promotion, or generalized migration engine. The audience should understand the product without knowing what a hash, VPC, or database transaction is.

The first useful customer is a platform/on-call engineer maintaining a booking, scheduling, or inventory application. The broader buyer hypothesis is a platform team introducing agent-written data repairs. This is a hypothesis to validate, not a proven market. We are **not** claiming that the seeded outage is an observed customer incident.

## Why this beats the current demo

File 27 contains strong engineering ideas but opens with a long destruction sequence, puts useful work second, and ends with receipt cryptography. That risks leaving judges with “a security dashboard that prevented a catastrophe.” Its hardest success moment is also unsound as written: a customer can gain a related booking without changing the customer row's hash.

Our opening is a familiar broken product: “Sold out,” although inventory is held by expired reservations. The agent investigates, executes a repair on the copy, verifies that current reservations survive, and creates a concrete proposed patch. The operator approves it. The real demo application begins accepting bookings. This answers “what does it actually do?” immediately.

Two main features only, following the supplied guide:

1. **Preview the repair by doing it:** same small booking dataset in an isolated execution environment, real code, actual SQL execution, concrete before/after availability, and invariant results.
2. **Publish the reviewed repair safely:** a deterministic approval/apply service refuses stale baselines and applies an allowed patch atomically after renewed review.

Containment appears as one short, real adversarial replay. Sponsor infrastructure and the receipt are supporting evidence, not additional product features.

## Compare three serious choices

These are qualitative judgments about build and demo risk, not numerical forecasts.

| Dimension | Dress Rehearsal: booking repair | Repro Receipts | Try Before You Trust |
|---|---|---|---|
| User's job | Restore inventory without disturbing valid bookings | Determine whether a reported bug actually reproduces | Try an unfamiliar package/server without exposing a workstation |
| Useful final state | Customer makes a new booking; current bookings remain | Executable repro and evidence across revisions | User successfully uses the installed tool in a preview |
| First 15 seconds | Broken customer flow everyone can see | Requires explaining why the bug report needs independent reproduction | Familiar fear of installing unknown code |
| Strongest distinction we can demonstrate | Executed repair, approval tied to effects, stale-baseline refusal, atomic promotion | Frozen reproduction rerun offline across refs | Actual tool experience, isolated and disposable |
| Main prior-art challenge | “Database branching plus an approval button” | “CI/syzbot with an LLM” | “Dynamic package analysis with a preview” |
| Work already supported by local evidence | Local SQL mechanism was subsequently probed in 30; deployed end-to-end flow remains unproven | Local 22 contains real deterministic reproduction experiments, though Vultr timing remains unmeasured | No equivalent end-to-end proof of package setup plus usable preview |
| Greatest implementation risk | Generalized diff/apply and cloning become a platform project | Model-generated repro quality and environment setup | Arbitrary repositories do not reliably install; proxy/preview support and delayed payloads complicate results |
| Live variance | Low for fixed schema and deterministic patch path; moderate for agent diagnosis | Moderate; can drop to PoC-only verified mode | High if “any GitHub repo” is promised |
| Decision | **Winner if narrowed and useful path passes an early gate** | **Fallback if narrow repair cannot work end to end** | Do not build for this submission |

Why not choose Repro Receipts immediately? It has the strongest local engineering evidence and should remain the fallback. But the payoff is developer evidence, while the booking repair gives a visible service recovery. The latter fits the user's “actually work, do something” instruction more directly. If we cannot make that payoff real, the advantage disappears.

Why not Try Before You Trust? The user must actually use the tool at the end; an installation score or “safe” label is insufficient. Supporting a broad input class creates build variance. A single curated package is feasible but narrows differentiation. Its preview infrastructure can become harder than the product value it demonstrates.

## Strongest competition objection — acknowledge it

Neon's current official branching documentation explicitly describes isolated copy-on-write clones, testing potentially destructive queries, and temporary branches with expiration, including AI development workflows. **“Agents have no way to test changes on copies” is therefore false.** [Neon branching documentation](https://neon.com/docs/introduction/branching), retrieved 2026-09-26 through agent-reach's Jina route.

Our differentiator is an integration we must actually demonstrate: the agent investigates a real symptom on an isolated copy, the control plane extracts and checks an allowed business repair, and the application accepts only the approved patch against the unchanged baseline. Do not claim that no incumbent offers any of these components, or that a Vultr snapshot alone is a novel product.

Temporal already documents durable workflows and replay based on recorded event history. Reusing a lease/state-machine pattern from OpenMuse does not make our durable execution novel. Our receipt's independent rerun, when implemented, means executing frozen work on a fresh copy; that is distinct from reconstructing workflow state by consuming recorded events. [Temporal workflow documentation](https://docs.temporal.io/workflows), retrieved 2026-09-26 through agent-reach's Jina route.

## Exact product fixture and resulting work

Call this first workflow **Recovery Desk**, under the Dress Rehearsal product. Use a tiny, clearly labeled synthetic booking application. For example:

- One event or equipment pool with capacity 3.
- One valid hold and two expired holds, all still marked `held`.
- Existing availability calculation counts `held` and `confirmed`, leaving zero bookable units.
- A failed hold-expiry job caused the incident; fixing its recurrence is outside the hero task.
- Task: “Recover inventory held by expired unpaid reservations as of [fixed cutoff]. Keep every confirmed or newly renewed reservation.”

The agent inspects schema and reservation states, writes a repair script, runs it on the copy, and runs independent acceptance queries supplied by the product. It changes only the approved status transition `held → released` for expired, unpaid rows. Availability changes as a consequence of those actual row changes. It cannot propose an arbitrary production SQL command as its apply artifact.

With the exact seed above: 2 expired holds can initially be released. If the judge renews one before approval, the first approval becomes stale and applies **zero** changes. A fresh rehearsal sees 1 expired hold, produces a new approval, and releases it. A new customer books that unit, leaving 0 available and all valid reservations intact. These are target fixture numbers; display actual measurements if implementation uses another seed.

This task is useful even though the fixture is synthetic: the implementation executes a real data repair and booking transaction. We must not call the fixture a customer production deployment, claim revenue saved, or invent pilot users.

## Three-minute live demo

No sign-up sequence. Land directly in an authenticated run page with a customer preview alongside it. Big text, one action per state, no raw logs occupying the primary screen. A detail drawer holds SQL, instance IDs, network restrictions, and receipts.

| Time | Product action and proof | Spoken line |
|---|---|---|
| 0:00–0:15 | Open booking app: “Sold out.” Show 2 expired holds next to 1 valid hold. | “Customers can't book. Old holds still consume all the stock. Would you give an agent production database access to fix it?” |
| 0:15–0:50 | Submit the recovery task. Live Vultr model plans, inspects the isolated copy, writes/runs repair code, then executes checks. Actual events stream. | “It gets a disposable copy on Vultr. It investigates and runs the repair there.” |
| 0:50–1:10 | Show result: 2 releases, 1 valid hold unchanged, copy now bookable; review exact allowed changes. | “This preview is the result of executed code. Here are the reservations that would change.” |
| 1:10–1:30 | One judge or operator renews a hold in the fixture customer app. Click approve: stale baseline, 0 changes committed. | “Someone just renewed a reservation. The reviewed repair is now stale, so nothing is applied.” |
| 1:30–2:05 | Rehearse the frozen repair at a fresh baseline and cutoff, show 1 release, approve the new patch, commit it, book one unit in the customer app. | “Rehearse again, approve the updated result. Existing reservations survive, and customers can book again.” |
| 2:05–2:35 | Separate clearly marked hostile replay executes `DROP` or destructive workspace deletion inside a fresh copy. Trusted host confirms deletion in the copy; fixture database and booking service stay intact; destroy sandbox. | “If an agent goes wrong, this is where the damage happens. This replay really destroyed the copy. The booking app is still serving.” |
| 2:35–3:00 | Open compact receipt with effect list, checks, approval, actual committed change count, model endpoint, sandbox ID, and teardown status. Show separate Vultr control/execution nodes. | “An operations agent that finishes the job, with an executed preview and a controlled apply. Built on Vultr compute and inference.” |

The rerehearsal may replay the frozen agent-produced script deterministically; label it “re-running generated repair.” It is not a new live model diagnosis. The first hero run must visibly use the model and execute at least two tool rounds; showing only scripted replay would weaken compliance and technical judging.

Fallbacks: if the judge declines, operator renews the hold. If model output fails, show a labeled prerecorded agent-generation segment followed by live execution of its frozen repair; disclose the failure and retain a recorded successful end-to-end submission. Do not quietly substitute a hardcoded repair while labeling it model generated. If response latency consistently exceeds the slot, pre-start a genuine run and show its timestamp, then drive fresh apply and containment live.

## Sixty-second submission cut

| Seconds | Shot |
|---|---|
| 0–7 | Customer sees sold out; expired holds explain the concrete problem |
| 7–20 | Live plan/code/tool results on disposable Vultr copy; actual before/after availability |
| 20–31 | Hold renewed → stale approval commits zero → new review |
| 31–43 | Updated repair applied, current reservations intact, new booking succeeds |
| 43–55 | Destructive command truly runs in isolated copy, fixture remains intact, sandbox destroyed |
| 55–60 | Architecture/attribution card and public demo URL |

If claiming NetBird bonus tiers, the required firewall/URL/auth/expiry evidence needs its own measurable allocation inside the one-minute cut. Do not add three bonus claims that cannot be demonstrated in the video. Confirm submission wording with the organizer; local 01 records the one-minute guide requirement and possible discrepancy.

## Correct the dangerous promise in 27

**Do not ship or pitch “311 applied, 1 refused” based only on target-row hashes.** A purge can depend on related tables and on absence of rows. A new booking may leave the customer row unchanged. Partial application can also violate the dependencies of an approved effect set. These are correctness issues, not presentation details.

Hackathon-safe bounded implementation:

1. Support only this fixed schema and allowlisted repair operation. No arbitrary schema changes, filesystem promotion, cloud APIs, email, payments, or external production mutations.
2. Export the protected fixture tables from one consistent database snapshot. Include every table read by the eligibility/invariant checks and a pinned schema version. Use a fixed task cutoff rather than a changing `now()` inside replay.
3. A trusted verifier outside the agent's writable environment compares canonical baseline and final table data. The agent's self-reported release count is not trusted. Allowed effects are explicitly enumerated and all protected-row invariants are checked independently.
4. Bind approval to baseline digest, cutoff, allowed effect set, schema version, tests, run, and expiry. Changing any requires new approval.
5. During apply, a trusted narrow service locks the protected tables against concurrent writes, recomputes the small dataset digest, and compares it with the approved baseline. On any mismatch, roll back and mark stale. Otherwise, apply the exact allowlisted updates and run invariants in the same transaction. Readers may continue; app writers must obey the same database locks.
6. Persist apply result/idempotency record transactionally. A repeated approve returns the same result. An uncertain remote outcome is reconciled, not blindly rerun.
7. Rehearse again after any drift; never claim that arbitrary concurrent production changes can be merged safely.

This is deliberately conservative and only suitable for the tiny supported fixture. Global table hashing/locking is not the scaling story for large production databases. Future adapters need dependency-aware concurrency control. Row hashes alone are not that control.

A trusted importer must treat all sandbox files/manifests as untrusted, cap their size, avoid executing them, and reject invalid schemas/extra effects. An untrusted agent can falsify writable local logs; a green badge based only on those logs is not containment proof.

## Architecture reuse: extract the good parts

Use the existing local audits, not a full OpenBot/OpenMuse deployment:

- **OpenMuse:** action-bound approval, hash/expiry, atomic claim, explicit `outcome_unknown`, durable task lease and restart recovery. Put deterministic apply in a trusted worker, not a model tool with production credentials.
- **OpenBot:** separate computer/sandbox supervisor, server-side opaque identifiers, audit before action, explicit default-deny gateway, and per-run lifecycle. The API does not receive a Docker socket.
- **Replace:** mandatory hosted Intelligence transport, frontend-dispatched execution, per-owner long-lived computers, permissive defaults, unrelated connectors and desktop/mobile UI. Use a thin web interface and SSE.
- **Runtime:** all agent reasoning goes through Vultr Serverless Inference. Development-time GPT-6 Astra criticism is separate from the deployed product's model routing.

The agent runs as a non-root user with a database role bounded to the sandbox fixture; it never receives VM root. The product API/control worker lives on Vultr; untrusted work lives on a separate Vultr sandbox host, in a constrained per-task container. No model/provider/app credentials enter that container. Isolated local Postgres and repair execution can share the sandbox boundary; use no external egress for the hero scenario. The narrow trusted apply service alone can reach the synthetic live database.

Vultr VM snapshot twins are a stretch. First prove fresh export → isolated database → code run → trusted diff → approval → commit. A prewarmed empty sandbox can speed setup; it must still receive a current consistent dataset and baseline. Never advertise a warm stale fixture as a current production twin.

## Build cut line and measurable gates

Plan relative to the actual start of coding; old wall-clock gates in earlier files may already be stale. Estimates below are planning judgments, not measured effort.

**Must ship:**

1. Tiny booking fixture and real booking/renewal paths; clear reset for demo data.
2. Fresh, consistent fixture export and isolated execution on Vultr; limits, no real credentials, teardown on success/failure/timeout.
3. Vultr-only agent loop: inspect, generate repair, execute, consume stderr, reattempt if needed. Do not deliberately manufacture a retry on stage; use a real recorded example for that proof if the successful hero run does not fail.
4. Trusted allowlisted diff and independent invariants; no direct agent-to-production access.
5. Approval binding, all-or-nothing stale refusal, transactionally idempotent apply.
6. One task page with actual lifecycle/result events, customer preview, approve button, and downloadable evidence.
7. Destructive copy replay with independently checked fixture survival.
8. Public deployment, README/setup/architecture/attribution, 60-second recorded demo, and rehearsed three-minute demo.

**Cut:** volume-delete mock API, fake god-token, root bragging, multiple malicious vectors, arbitrary migrations, GDPR claims, uploads manifest, generalized filesystem diff, two-model guard/vision stack, insurance story, three buyer segments, billing, signup/onboarding, mobile clients, chat-platform integrations, forensic VM snapshots, full receipt signing CLI, per-task public URLs until core is stable.

**Optional after core:** Vultr VM provider, measured cost, NetBird simplest eligible tier, signature verification. Adding these must not displace customer success, reliable isolation, or the submission video.

| Gate | Evidence required | Consequence if it fails |
|---|---|---|
| First 90 minutes | Deterministic clone→repair→diff→atomic apply changes inventory and a new booking succeeds; no model/UI needed | Narrow schema/data further immediately; do not add VM snapshots |
| First 3 hours | Judge renewal race causes zero commit; fresh review/approval succeeds; destructive command cannot change fixture data | Fix trust/concurrency boundary before anything else; retain Repro Receipts fallback |
| First 5 hours | A real Vultr model runs supported task end to end twice; script/output survive worker restart without duplicate apply | If core remains broken, choose the validated fallback rather than creating another idea |
| Mid-build | Public UI performs complete task; repeat apply, tampered patch, expired approval, timeout and teardown cases pass | Freeze scope and fix only blockers |
| At least 3 hours before submission | Three complete rehearsals from a reset, plus successful recorded useful/containment runs | Stop feature work, record and submit known-working build |

Target three teammates: execution/isolation; trusted apply/data integrity; product/UI/demo. A fourth can own deploy/NetBird/validation. With two, drop VM twins, signing, bonus integrations, and generalized adapters immediately. Actual human team size remains unknown; agents helping build do not create extra stage presenters or venue validation capacity.

## Validation that would change this recommendation

Research 23 validates concerns around reproducing reports; it does **not** validate willingness to pay for this booking repair product. No customer interviews were conducted in this pass.

Ask three platform/on-call engineers, before pitching: “What was the last manual data repair you did? How did you test it? What made you comfortable applying it? What changes between test and apply? Could an agent help if the change were bounded?” Then show the working flow and ask what is still missing for a real trial.

Record exact role, date, actual answer, and permission to quote. Useful disconfirming answers include “we already have a reliable single-purpose job,” “cloning our data is unacceptable,” and “most effects involve external payments.” If most target users say this, narrow the buyer to teams already doing bespoke SQL repairs or return to Repro Receipts. Do not turn compliments into demand or a trial commitment.

## Judge answers worth practicing

- **Isn't this staging?** “The copy is a known baseline for one action. We execute the repair, independently measure allowed changes, then apply only that reviewed patch if the baseline is still current. You just invalidated it with a new reservation.”
- **Why use an agent for a simple SQL update?** “This example is intentionally inspectable. The agent does the schema inspection and writes/runs the repair; the reusable product is the contained execution and governed apply around bespoke repairs. A fixed recurring expiry job should remain deterministic.”
- **Can it fix arbitrary production systems?** “No. Today it supports this database schema and status transition. Other systems need explicit adapters and invariants.”
- **What happens if the agent deletes everything?** “The disposable copy is lost. A trusted verifier sees effects outside the allowed repair and produces no applicable proposal. Production credentials are never available to that agent.”
- **What is original versus reused?** “We adapted approval/lifecycle patterns from OpenMuse and OpenBot. The executed repair preview, trusted effect validator, stale-baseline gate, booking workflow, and Vultr deployment are the event-built contribution. The README lists exact reused code and licenses.”
- **What wins the prize?** We cannot know. The strongest controllable case is a real customer-facing outcome, a demonstrable containment boundary, a correct narrow promotion path, and a polished demo whose numbers come from execution.
