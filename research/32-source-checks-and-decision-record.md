> **Historical booking-recovery decision, superseded after the user requested a stronger main-challenge project.** The current project is [Airlock in 35](35-AIRLOCK-MAIN-CHALLENGE.md). This document preserves the earlier analysis; it is not the current build scope.

# Fresh checks and decision record — 26 September 2026

This is the evidence record for the new decision in `31-WINNING-PRODUCT-BRIEF.md`. It does not revalidate every claim in the older research folder.

## Sources checked this pass

| Source | Method and result | What it supports |
|---|---|---|
| [Organizer Challenge 1](https://docs.google.com/document/d/1cca0kJZSraBDNfE_gFCRovpgRnlD2m613WLebd2ApN4/edit) | Public text export fetched successfully using curl; temporary capture `/tmp/arena-c1-fresh.txt`. Web reader could not fetch the export. | VM backend, agent reasoning through Vultr Serverless Inference, execution in a separate sandbox on Vultr, actual multistep work, public web app, recorded containment moment. Containers are permitted; per-task VMs are optional. |
| [Cerebral Valley event page](https://cerebralvalley.ai/e/vultr-the-agent-arena) | Public page read using web search/open. | September 26–27 event in San Francisco; in-person; teams up to four. It does not reveal the judge roster or authenticate the earlier simulated panel. |
| [Vultr events](https://discover.vultr.com/events) | Official listing read. | Confirms the September 26–27 Agent Arena event. |
| [Neon branching](https://neon.com/branching) and [practical branching guide](https://neon.com/blog/practical-guide-to-database-branching) | Official product/docs read. | Disposable branches and agent checkpoint/promotion workflows are established prior art. Do not claim inventing twins, staging, or agent database branching. The narrower proposed differentiation is an executed repair with a bounded approval contract and conflict refusal. |
| [PostgreSQL 17 explicit locking](https://www.postgresql.org/docs/17/explicit-locking.html) | Official documentation read. | Row locks do not cover new rows; table locks can exclude concurrent writes. Acquire the relevant locks before capturing the current comparison state, with a bounded transaction and consistent lock ordering. |
| [PostgreSQL pg_dump](https://www.postgresql.org/docs/17/app-pgdump.html) | Official documentation search result read. | A logical dump can be consistent under concurrent use. Do not independently capture a baseline later and assume it describes that dump. |
| OpenBot / OpenMuse local reference clones | `git rev-parse HEAD` checked, matching the audits; architecture teammate inspects selected actual source files. | OpenBot `3c73cf00efba46122dfd0447485e2b61f1d6a2cd`; OpenMuse `205cc386b75aae1a862f3fdd43104b570c8d0911`. These are pinned reference versions, not a claim about latest upstream HEAD. |
| User's pasted Gary-Yau Chan guide | Full pasted file read locally. | Team roles, judge-oriented presentation, one or two primary features, real validation, interactive demo, rehearsal. Its prototype-only advice is deliberately not followed because the user requires a working product and the challenge requires executed work. |

Agent Reach was selected as the research routing skill. Its prescribed Exa command failed because the `exa` MCP server is not configured; the CLI itself is also not on PATH. The available web tool and direct organizer export were used as fallback. No social-platform or customer-interview evidence was added. No installation, account connection, outbound messages, or cloud provisioning occurred in this pass.

## Decisions and reasons

1. Keep Dress Rehearsal as the product concept; make expired reservation recovery the first concrete workflow. This gives the audience a visible successful outcome: a slot becomes bookable.
2. Cut generic production VM cloning, root agents, file/cloud diffs, refunds, GDPR deletion, and snapshot rollback. These multiply unproven safety and implementation assumptions.
3. Replace row-by-row partial promotion with whole-plan refusal on relevant baseline drift. A new related row can invalidate a plan without changing any originally selected row.
4. Use a small, synthetic booking application. All credentials and real personal/customer data stay outside the agent environment. The implementation must describe this as a real running application with synthetic data, not an actual customer deployment.
5. Choose a bounded database adapter with trusted verification and a fixed apply routine. The agent writes and executes code in rehearsal; approval never grants it a live database credential or permission to run its arbitrary SQL on the live application.
6. Prefer full relevant-table fingerprints under short write-conflicting locks for the tiny fixture. Revision counters are an optimization only after proving that every writer participates. This deliberately sacrifices concurrent throughput for a tractable hackathon contract.
7. Use OpenMuse approval/claim/outcome semantics and OpenBot supervisor/policy/audit patterns. Both wholesale apps add dependencies and security assumptions that are unnecessary here.
8. No numerical winning probability, invented judge roster, customer-validation count, incident statistic, or deployment claim. Candidate ranking is team judgment, not measured judging evidence.

## Evidence boundaries

Read `30-architecture-feasibility.md` for the precise local experiments and their outputs. Local SQL tests cannot demonstrate Vultr deployment, Linux containment, inference reliability, public access, or a complete end-to-end product. Those remain build gates. Research probes are pre-event feasibility work and must be disclosed separately from event-built product code; do not copy them into a submission while claiming they were written at the event.

The noon PDT submission target, 60-second video guidance, judging weights, and new-work requirements are inherited from the earlier participant-guide capture and rules matrix (`01-rules-and-compliance.md`). They were not independently reconfirmed through the logged-in organizer interface in this pass. Keep the conservative deadline; confirm discrepancies with the organizers.
