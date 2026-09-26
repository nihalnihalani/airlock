# 33b — Main-challenge product decision after the full research challenge

2026-09-26. Product teammate assessment for **Blast Radius Zero**, responding to the user's rejection of the booking-specific pivot. This is product research and build direction, not a claim that the product exists. It supersedes my product recommendation in 29.

## Decisive recommendation

**Build Airlock, with a Repro-to-Repair workflow: a contained maintainer agent that turns an incoming bug report into a runnable reproduction, a minimal patch, and independently observed before/after behavior.**

Stage line: **“Run the report. Return the patch and the proof.”**

It is one workflow for one real user job. A maintainer receives a plausible report, must execute unfamiliar code to understand it, and wants a reviewable fix rather than another confident paragraph. The product runs that work without giving the issue, repository, or coding agent the maintainer's machine, secrets, or write token.

The event MVP supports a pinned Python package/runtime. The hero is a **real historical public regression**, not a bespoke booking app: [python-tabulate #365](https://github.com/astanin/python-tabulate/issues/365), where an empty table crashes when `maxheadercolwidths` is set. Wrap the package in a small trusted report-export page. Before: a perfectly valid empty report fails. After: the same input exports a table, and normal reports still work. The agent edits the actual library source and returns a patch that can be inspected and rerun.

**Why add repair despite the existing Repro Receipts lab?** Because the user's priority is a useful working outcome. A patch plus an independently checked working result is a stronger main-stage finish than a diagnosis card. This is worth a bounded model-risk increase, but not an arbitrary-repository setup system or a general coding IDE. Reproduction remains the first useful artifact and the fallback if the repair gate fails.

**Confidence split:** high that the chosen workflow matches documented pain and challenge requirements; medium that the proposed limited architecture can be built; **unmeasured** that the available Vultr model can reliably generate the repair within the demo budget. No simulated panel score resolves that uncertainty. Measure it early.

## What I read and what changed my mind

This pass used 00, 01 rules/problem statements, 03 and the A/B/R/V evidence ledgers, all five dossiers in 04 (D3 through the earlier report), 06 competitive and meta, 10, 20, 21, 22, 23, 25, 26a/b/c, 27, my prior 29, the supplied hackathon-winning guide, and coordination with Astra and the architecture teammate.

Three conclusions survive the full folder, while several older conclusions do not:

1. **Containment must enable the user's task.** Running an untrusted report and repository makes isolation integral. A generic “Airlock” with safety cards has no independent user job; file 10 already recognized that.
2. **Useful output must survive outside our UI.** A minimal patch and a reproduction bundle are concrete deliverables. A repair app that only edits a toy counter or shows a green badge is weak. A frozen patch to actual package source, with replay instructions, is stronger.
3. **Novelty is modest and must be stated accurately.** Sandboxes, coding agents, approvals, fresh CI, previews, and durable execution all exist. The project's value is a specific workflow assembled with a credible boundary, not invention of one of those primitives.

My initial reassessment favored Repro Receipts because it has the strongest local experiments. That alone would be sunk-cost reasoning. The external-harness architecture makes a repair-first version credible without universal patch promotion; the added observable result changes the choice. Conversely, the prior booking product is not rescued by its correctness: its narrow incident and buyer were introduced for demo convenience rather than derived from the research.

## Evidence for the real job, with limits

| Evidence | What it actually supports | What it does not support |
|---|---|---|
| [Little-CMS #608](https://github.com/mm2/Little-CMS/issues/608), re-fetched through GitHub API this pass | Maintainer ran an attached reproduction package, observed no crash, and asked the reporter to check AI reports first. Executing reported code is a real part of the job. | One C-library incident does not establish Python demand, frequency, willingness to pay, or that the package was malicious. |
| [3DTilesRendererJS #1758](https://github.com/NASA-AMMOS/3DTilesRendererJS/issues/1758), re-fetched this pass | Maintainer demanded a minimal live reproduction; reporter's standalone test showed the library was not responsible. An executable answer prevented misdirected repair work. | This is browser/WebGL evidence; the MVP does not support that stack. It also shows that making reporters do the work can succeed. |
| [Datasette/Firefox/Chromium discussion](https://lobste.rs/s/re9wk8/we_have_year_fix_security_everywhere), re-fetched this pass | Practitioners describe fixing LLM-found vulnerabilities; a Firefox engineer advocates verifiers with invariants; the discussion includes demand for easy containment of untrusted processes. | These are not customer interviews for our product. A week spent fixing is not a week we could save. |
| 23: NLTK, NumPy, LangChain, Dify evidence (EV-V-0001–0004) | Python-specific reproduction, environment mismatch, proof-of-concept gates, controls, and cases that appear unresolved but are already fixed. | These are desk observations, not signups, purchase intent, or a validated revenue model. |
| 03 K1 and 04 D2 | Agent summaries can overstate success and omit configuration cases. Independent checking addresses a real failure mode. | Fresh testing is not novel; CI and other agent verification products already address part of this. |
| 22 feasibility lab | Handwritten tests for 8/10 public Python reports distinguished before/fix/latest in native macOS experiments; all 30 ref pairs ran deterministically twice. The tabulate hero reproduced. | This did not run a live Vultr model, repair code, Linux gVisor, the web wrapper, or a trusted external harness. “30/30 deterministic” is not 30 successful autonomous repairs. |

The evidence pool is intentionally biased toward reproduction because 03c was a dedicated validation pass. Counts across clusters are not market-size estimates. Use two recognizable stories and a measured build result on stage, not a wall of inflated statistics.

### Fresh source checks

- GitHub API confirmed Little-CMS owner output and the 3DTiles maintainer/reporter sequence.
- GitHub API confirmed tabulate #365's exact trigger: the implementation indexes the first row even though the list is empty when header-width handling runs.
- Current [triagebot-action README](https://github.com/withastro/triagebot-action) explicitly includes reproduce → diagnose → verify → fix, preview releases, reporter confirmation, and PR creation. It says its agent executes shell commands on the GitHub Actions runner. This directly rules out claiming that our end-to-end workflow is unprecedented.
- The earlier Jina GitHub requests returned an access block; the GitHub CLI/API retrievals succeeded. Lobsters succeeded through the agent-reach Jina route. Retrieval success is not independent validation of every user claim in those sources.

## Compare the serious candidates

No made-up win percentages or decimal judge scores. The question is which final product has the best combination of useful work, integral containment, recognizable differentiation, and demonstrable engineering.

| Candidate | Best useful payoff | Why containment is integral | Fatal or material objection | Decision |
|---|---|---|---|---|
| **Generic secretless coding repair with protected verification** | Working edited app plus patch | Agent executes untrusted repository code | OpenHands/CI/coding agents already cover much of this. “No keys + fresh tests” alone is not a product wedge. A readonly test file in the candidate interpreter is not an independent oracle. | Reject generic packaging; retain only the architecture under a concrete report-to-repair job. |
| **Repro Receipts** | Minimal runnable report; behavior at reported/latest refs; maintainer can act on evidence | Incoming PoC/report/repo are untrusted | Already-fixed verdict and receipt can feel like analysis, though they are real executed work. Repairless finish leaves main-stage value on the table if repair is feasible. | Best evidence-backed floor; same-product fallback. |
| **Browser operations with handoff and crash-safe submissions** | Authenticated task completed without repeated submissions | Untrusted pages and cookies; approvals on external writes | 03/04 found no firsthand production duplicate-side-effect incident. Handoff already exists. Exactly-once cannot be promised on arbitrary portals without target support or conclusive reconciliation. Live login/browser/vision adds failure points. | Do not choose for this event. |
| **Try Before You Trust / isolated MCP trial** | User installs and actually uses an unfamiliar tool before trusting it | Package install/server code is untrusted by definition | Broad “any repo” is an environment-setup project. A 90-second run cannot certify future safety; a green “safe” badge would overclaim. No equivalent lab work exists. | Strong alternate user job, weaker delivery confidence. |
| **Fresh candidate: Safe Backport** | Given a public upstream fix and a supported older branch, agent produces a minimal backport and an old/new regression demonstration | Untrusted patch/repo/toolchain and agent code execute | Direct backport buyer evidence is absent from this folder; cherry-pick plus CI already covers easy cases, while hard backports may exceed model/build budget. | Plausible follow-on, not today's core. |
| **Recommended Airlock: Repro-to-Repair** | Incoming report becomes executable repro, tested minimal patch, and visible corrected behavior | Same as Repro, plus candidate patch remains untrusted during validation | Similar workflow exists in Astro; live repair unmeasured. Must win on execution quality and separation of author from verifier, not invented originality. | **Choose as intended product, with explicit repair gate.** |

Safe Backport is a new synthesis rather than fresh validation: 23's already-fixed advisory evidence suggests version confusion, while 22 provides known fixed/old revisions. It might serve maintainers unable to upgrade immediately. Neither fact establishes that users want paid automated backporting. It is included to challenge the incumbent with a concrete alternative, not to pretend another named concept is proven.

Dependency-upgrade rescue is also attractive on paper but was already rejected in file 10 for weak pain evidence. Relabeling it “Dependency Rescue” would not make it a new insight.

## Single product and concrete hero task

**User:** maintainer or engineer responsible for a Python utility/library exposed through an application.

**Input:** a bug report URL or pasted text, a supported repository profile, and a pinned affected revision. For the hackathon the repository selector honestly lists supported profiles; it does not suggest arbitrary-language support.

**Hero:** “Report export crashes on empty results when column width is configured. Make empty exports work while preserving normal table formatting.” The underlying bug is public tabulate #365. Use the known pre-fix revision from 22, visibly label this a historical regression replay, and do not feed the model the upstream solution. Pin dependencies so package setup does not consume the demo. Historical base: `e13a4d0dd292cade200e653eb9155a1ca0f1dbea`; known upstream fix used only to validate the fixture offline: `87a9a4e07a5efb39b81fdb6ac513b1d345bb21fb`. The upstream fixed source and patch must not enter the agent context or sandbox.

**Executed path:**

1. Controller creates a fresh task sandbox with the pinned package and dependencies.
2. Vultr-inference agent inspects the report/source, writes a minimal reproduction, runs it, and receives actual stderr.
3. Agent makes a small source change and runs its own checks. This is advisory author feedback, not the pass criterion.
4. Trusted controller freezes an allowlisted source patch. It rejects changes to runtime launcher, test harness, lockfile, policy, and output evidence.
5. Fresh baseline and candidate sandboxes start from trusted runtime images. A **separate trusted external harness** supplies predefined normal, boundary, and regression inputs, observes responses, and assigns results. It never imports candidate Python into its own process or asks the model to grade success.
6. The trusted report-export page renders bounded plain-text/table results from those exact frozen artifacts. User repeats the empty export and a normal export. The candidate handles both.
7. User downloads patch + reproduction + environment IDs/hashes + observed case results + replay command. Any optional GitHub posting requires exact-content approval and targets only our demo repository.

**Final result:** actual patched package source and an independently exercised working behavior. It is neither a security dashboard nor an agent that merely says it fixed the issue.

Why this is not just an arbitrary narrow vertical: report reproduction and repair are the user job in the evidence. Tabulate is a supported demonstration target for that job, as one real email thread is a demonstration target for an email product. The product is not “empty-table software.” The MVP must be transparent about the one supported runtime and limited repository profile.

## Oracle and trust conditions that make the claim honest

The source patch remains untrusted after generation. Running it in a fresh container does not automatically make its own logs truthful.

- A trusted lightweight adapter exposes bounded requests to the package inside each candidate sandbox. The external harness decides expected results. A changed package cannot replace the harness, alter its expected cases, or write its result store.
- Correctness tests cover the observed bug and declared preserved behavior; they do **not** prove arbitrary correctness or absence of malicious code. Say “passes these independent checks,” not “proven safe.”
- Baseline must fail the bug case and pass relevant control cases. Candidate must pass both. This distinguishes a real fix signal from a broken test or a baseline that already worked.
- The trusted UI cannot render arbitrary candidate HTML/scripts under the control-plane origin. For the demo use text/table output with size limits; no general preview hosting is needed.
- The frozen source/patch tested must match the artifact offered for download and the interactive result. Any source change invalidates verification.
- Untrusted repositories cannot supply their own Dockerfile, test command, dependency lifecycle hooks, grader config, or host mounts for the hero. Later generic support would require a much larger ingestion boundary.
- An allowlisted registry with real secrets absent is weaker than zero egress. Use prepared dependencies and no-network execution for the hero; source acquisition/install belongs in a separately constrained preparation step.

**Important correction to old pitches:** CI can run before merge, use external protected checks, keep fork tokens readonly, and independently verify a patch. Never say “CI only runs after merge” or “CI always trusts the agent's environment.” Our advantage is the end-user report-to-evidence workflow and hosted containment, not a false definition of CI.

## A three-minute demo with two features

Primary feature 1: a report becomes a real repaired artifact. Primary feature 2: the same execution boundary contains a hostile report and protects the verdict.

| Time | What happens | Why judges should care |
|---|---|---|
| 0:00–0:15 | Trusted report-export UI receives empty data; baseline throws the real tabulate error. Open the public report URL beside it. | Immediate real failure and provenance; no invented customer story. |
| 0:15–0:55 | Start/continue genuine agent run; it reads code, writes a repro, executes, sees stderr, edits source. Show source diff and actual event stream. | The agent does work rather than a deterministic script wearing a chat UI. |
| 0:55–1:25 | Separate verification columns: baseline bug case fails, candidate bug case passes, normal/regression controls pass. Exact case counts are measured. | Authoring and grading are distinct; useful work survives fresh execution. |
| 1:25–1:45 | Operator runs empty export and a normal export using the frozen candidate. Downloads the minimal patch and reproducer. | Working product finish: a usable fix leaves the system. |
| 1:45–2:20 | Run a clearly labeled hostile-report fixture that attempts workspace destruction or a capped infinite loop inside another fresh sandbox. Trusted supervisor shows actual contained effect/timeout, fixture target outside sandbox unchanged, and teardown. | The same input channel that enables useful work can carry harmful code; boundary matters. |
| 2:20–2:40 | Optional judge selects a declared boundary input, or selects a supplied tampered candidate artifact with altered checks; external verifier controls the result. | Interactive proof without crowd queues or arbitrary network code. Do not rely on the model spontaneously cheating. |
| 2:40–3:00 | Compact artifact view: source SHA, test counts, sandbox identities, no-network run, teardown, Vultr model/host; one buyer sentence. | Verifiable deliverable, sponsor-central architecture, concise close. |

Use a prestarted live agent run if model latency requires it; expose its start time. Replaying a previously generated script is a valid fallback demonstration of execution, but it must say replay. Never label a hand-written patch as a model repair or quietly load the upstream fix. If the agent's first repair passes, do not manufacture a failure/retry; use actual stderr from the reproduction or a separately labeled real retry example.

For the 60-second submission: 0–8 broken export/public report; 8–22 live generation/execution (speed-up labeled if used); 22–35 independent baseline/candidate checks; 35–44 working export + patch; 44–56 real containment + teardown; 56–60 architecture/demo URL. Bonus integrations must fit without removing required useful work or containment.

## Early gate: the decision must meet reality

The project is chosen now; the **repair feature** is earned by measurement. Avoid another open-ended idea tournament after building starts.

1. **By coding start +2 hours, model owner:** on the actual Vultr inference endpoint, run the pinned tabulate report from fresh source with no upstream fix exposed. Require 3 of 3 fresh attempts to produce a patch passing protected baseline/candidate checks within 5 minutes, and at least 2 within the planned live-slot budget. Record all attempts, model IDs, time and outcomes. These are proposed acceptance thresholds, not existing results.
2. **In parallel, execution owner:** demonstrate a sandbox-contained destructive command, no execution-process secrets/host mounts, blocked unauthorized network access, limits, and actual teardown on Vultr.
3. **Verifier owner:** demonstrate a fake “all passed” log is ignored, changed evidence/test files cannot alter trusted verdict, artifact hash mismatch fails, and the displayed candidate equals the tested candidate.
4. **By coding start +4 hours:** the deployed core must join actual model repair, frozen-artifact verification, useful preview, download, and containment through the same application path. If it does not, freeze integrations and execute the fallback.
5. **If repair gate fails:** ship Repro Receipts using the same intake, sandbox loop, external observations, and artifact UI. Mark repair unavailable. This still completes real useful work; it is not a new pivot requiring another infrastructure stack.
6. **If reproduction generation also fails:** accept a provided minimal PoC and use the model for contained diagnosis/execution orchestration, with the frozen PoC independently rerun. Do not claim autonomous repro generation.

Public deployment, video, attribution and repeated full demos are mandatory scope. Drop automatic GitHub PR creation, arbitrary repositories, dependency install autonomy, multiprovider models, real production writes, filesystem promotion, universal rollback, parallel model swarms, multi-tenant onboarding, and forensic snapshots.

## How OpenBot and OpenMuse contribute

Reuse architecture intentionally rather than inherit either whole application:

- OpenBot: per-task supervisor concept, explicit policy boundary, opaque resource identifiers, audit before dispatch; replace permissive defaults and browser-owned tool execution.
- OpenMuse: durable task lifecycle, lease/heartbeat, action-bound approvals, atomic claims, and uncertain-outcome handling if publishing is added.
- New product contribution: report ingestion profile, source-patch freezing, fresh baseline/candidate execution, external behavior verification, cohesive repair/repro artifact, and useful report-export demonstration.

Inference keys stay on the control plane; all deployed agent LLM calls use Vultr Serverless Inference. The runtime is not GPT-6 Astra just because Astra critiques the design during development. Untrusted execution runs on a separate Vultr sandbox host. Vultr is control, execution, inference and resource lifecycle, not a logo on static hosting. Containers are the floor; per-task VM provisioning is optional only after measured startup and core success.

## Business and winning claims we can defend

User: maintainers/engineers handling actionable reports. Buyer hypothesis: enterprise SDK/platform/security teams needing contained report execution and evidence. Free public-repository usage could distribute the product; private repositories, controlled execution and retained evidence could be paid. No price or willingness to pay has been validated.

Astro is strong prior art, not an enemy to dismiss. Its current README demonstrates that the job is worth automating and that reproduction-to-fix is already available. Its runner placement differs from the separate execution/verification boundaries we intend to implement; cite code inspection for any security comparison, and do not generalize one deployment to all competitors.

The supplied winning guide says to optimize a small number of features, understand the panel, validate with actual users, and rehearse. It does not make speculative novelty or fake adoption acceptable. File 20's named judges are largely inferred from attendance/promotion; prepare API, engineering, buyer and business answers without claiming we know who will judge.

No one can guarantee a win. The strongest controllable submission is a **real public bug visibly repaired, an independently exercised patch someone can download, and an unsafe input demonstrably confined by the same system**. That is the product to build; every extra feature must improve one of those three facts.


## Source coverage ledger for this teammate

| Group | Files consulted | Coverage / limitation |
|---|---|---|
| Rules and original request | `00-participant-guide.md`, `01-event-and-problem-statements.md`, `01-rules-and-compliance.md`, supplied `Pasted text.txt` | Main challenge, gates, event/guide discrepancies, anti-project list, deliverables, judging, and supplied winning advice read. Some large combined tool responses truncated; relevant rules were re-read in targeted excerpts. |
| Pain evidence | `03-recent-signals.md`, `04-pain-point-dossiers.md`, `23-customer-validation.md` | All principal pain clusters and dossiers considered; evidence strength, counterevidence and sampling limits used rather than counting all mentions as demand. |
| Primary traceability | `evidence-r.jsonl`, `evidence-a.jsonl`, `evidence-v2.jsonl` | Targeted rows read for claims used here, not every line in all ledgers. Selected current primary sources re-fetched above. No new interviews or platform-wide search. |
| Existing alternatives and competition | `00-executive-decision.md`, `06-competitive-landscape.md`, `06-meta-winning-strategy.md`, `10-ideas-and-scorecards.md`, `20-judges-and-winning-patterns.md`, `21-winning-concept-options.md`, `25-WIN-PLAN.md`, `26a-ideas-relatable.md`, `26b-ideas-api-wow.md`, `26c-ideas-bold.md`, `27-final-pick-judge-panel.md` | Core recommendations, alternatives, limits, and demo/build tradeoffs examined across prior and current turns. Older hypothetical scores, unverified incident counts, and inferred judge identities are not adopted as facts. |
| Build and prior critique | `07-openbot-audit.md`, `08-openmuse-audit.md`, `22-feasibility-lab.md`, own `29-product-and-demo-challenge.md` | Audits used as static-inspection evidence, not a fresh upstream build. Local experiment caveats retained. Booking recommendation explicitly superseded. |
| Team coordination | Astra and architecture teammates; main agent's read of current official OpenHands material | Incorporated external oracle design, repair-first conditional choice, and stronger competitive challenge. Their external checks are team-reported unless independently retrieved above. |

This ledger does **not** claim every file in the research directory or every linked source was read line by line. The main agent owns the consolidated coverage record and final product brief.

Final coordination: Astra conditionally endorses the repair-first workflow while retaining pure Repro as the evidence-ranked floor. Input-case count must never be presented as repaired-bug count. A three-case verifier for one historical regression means one exercised repair, not three bugs fixed.
