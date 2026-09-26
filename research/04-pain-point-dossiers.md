# 04 — Pain-point dossiers for the finalists

Written 2026-09-26 from the same inputs as `03-recent-signals.md`. No new web research went into it.

**How the counts were made.** Independence-group counts come from the jsonl files, computed with Python. A group is the `independence_group` field with any parenthetical note removed. "L30" means the window 2026-08-27..2026-09-26, both days included.

**Quotes and numbers.** Quotes are the `short_verbatim_excerpt` field, or a trimmed part of it, and none is longer than 25 words. A number appears here only if it appears in a jsonl line. Otherwise the field is written **null**.

**What 03-recent-signals §0 already covers:**
- X/Twitter was unavailable.
- Reddit gave titles and snippets only.
- YouTube transcripts failed.
- Every dossier inherits these gaps.

**How the dossiers map to the finalists:**

| Dossier | Cluster | Finalist |
|---|---|---|
| D1 | K7 | F1 Repro Receipts (primary) |
| D2 | K1 | F3 Claim Court (pivot) |
| D3 | K6 | F2 Evidence Clerk |
| D4 | K5 | Exactly-Once Submitter (F-alt) |
| D5 | K2 | Blast Preview |

D2, D4 and D5 also supply boundary features for D1.

---

## D1 — Untrusted bug-report triage: reproduction as proof (PRIMARY)

**Actor:** a maintainer or triager of a small-to-mid OSS library. A secondary actor is a security triager handling reports that come with a PoC.

**Trigger:** a new issue arrives that claims a bug. Often it is long and detailed, and it may be AI-written. It may include a snippet, a `reproduce.sh`, or a PoC archive.

**Inputs:**
- The issue text.
- The reported version.
- Optionally, attached code or a PoC.
- The repository at the reported ref and at HEAD.

**Real workflow, as observed:**
1. Read the report.
2. Then do one of the following:
   - (a) Ask for a reproduction or template and wait. This is what 3DTilesRendererJS does (EV-R-0003), and Vite's bot auto-closes the issue after 3 days (EV-R-0018).
   - (b) Build and run the reporter's PoC on your own machine. The Little-CMS owner did this (EV-R-0004).
   - (c) Close on origin or on policy: Pallets (EV-R-0001, R-0002), Spring Boot (EV-R-0005), AllStarLink (EV-A-0039).
   - (d) Reply that it was "already fixed". This is what Torvalds describes (EV-R-0010).

**Friction point:** the maintainer has to spend their own time, and sometimes their own machine, before they can tell whether the report is real. Little-CMS put it this way: "developers time is very valuable to spend it in war games" (EV-R-0004).

**Consequences:**
- Projects become hard to run: "made managing the project incredibly difficult" (EV-R-0003).
- Contributors burn out (EV-R-0009).
- Maintainers run untrusted code locally (EV-R-0004).
- Bounties get retired (EV-A-0038; curl EV-S-0002).
- Valid reports get closed on origin rather than validity (EV-R-0001, per its `reported_impact` field).

**Frequency evidence (only what the files state):**

| Evidence | Figure | Caveat |
|---|---|---|
| Pallets (EV-R-0001) | 88 items labelled "rejected AI" in the window (13 issues, 75 PRs), against 46 in the prior 30 days. 13 of 51 new Pallets issues in the window. | Counts from search are approximate. The label reflects maintainer judgement. |
| curl (EV-R-0011) | Report volume about 2x 2025; confirmed-vulnerability rate 15–16% | Covers security intake only |
| HackerOne (EV-R-0013, secondhand) | Submissions +76% year on year; about 25% exploitable | Secondhand |
| GitHub (EV-R-0008, secondhand) | Merged PRs per month went from about 25M to more than 90M | Covers PRs, not issues |
| Turso (EV-A-0038) | $1,000 per bug; 5 legitimate awardees before retirement | — |
| Astro (EV-R-0015) | Open issues went from about 200 to about 30 after automation | Self-reported |

- **Per-maintainer triage time per report:** null.
- **Share of incoming reports that fail to reproduce:** null.

**Current workarounds:**
- Needs-reproduction label plus auto-close (EV-R-0018).
- Policy-based rejection (EV-R-0002, EV-A-0039).
- Limits on issues and PRs (EV-R-0007).
- Ending the bounty or pausing intake (EV-S-0001, R-0012).
- Running the PoC by hand (EV-R-0004).

**Existing tools:**

| Tool | What it does | Gap relative to D1 |
|---|---|---|
| **withastro/triagebot-action** (EV-R-0015) | Reproduces, diagnoses, verifies and fixes in sandboxes | Per the ledger it runs with a write token and model keys as Actions secrets. **Verify this from its source before claiming it on stage** (00 §3). |
| Sentry repro skill (EV-R-0016) | Local repro; a human approves the backlink | Runs on a dev machine |
| HackerOne Agentic Signal Enrichment (EV-R-0017) | Handles web vulnerability classes; a human approves the drafted comment | Web vulnerabilities only |
| H1 Validation (EV-R-0013) | Paid validation | Paid service |
| LogicStar (EV-R-0025) | Commercial product | Snippet-level evidence only |
| Research agents | Generate repro tests | Graded against a known fix (EV-R-0019, R-0020) |

**Why the pain persists:**
- Automated repro exists, but the tools either:
  - run inside the maintainer's trust boundary (Actions secrets, a dev machine), or
  - stop at an LLM check instead of re-executing independently.
- Only about half of reports state steps to reproduce (51.4%, EV-R-0021).
- Non-reproducibility is often caused by the environment (11 factors, EV-R-0023).
- The cheap fixes (policy, origin bans) throw out valid reports along with the rest.

**Supporting observations (≥3 required; there are 10 groups, 9 firsthand):**

| ID | Group | Window | Status |
|---|---|---|---|
| EV-R-0001 | IG-R-pallets | L30 | firsthand |
| EV-R-0003 | IG-R-3dtiles | L30 | firsthand |
| EV-R-0004 | IG-R-lcms | L30 | firsthand |
| EV-R-0005 | IG-R-springboot | L30 | firsthand |
| EV-R-0009 | IG-R-kde | L30 | firsthand |
| EV-A-0039 | IG-P-allstarlink | L30 | firsthand |
| EV-A-0038 | IG-P-turso | 2026-YTD | firsthand |
| EV-R-0007 + R-0008 | IG-R-github | 2026-YTD | firsthand + secondhand, counted as one group |
| EV-R-0010 | IG-R-kernel | 2026-YTD | secondhand |
| EV-R-0023 | IG-R-rahman | historical | paper |

**Recent evidence (L30, 6 groups):**
- EV-R-0001, R-0003, R-0004, R-0005, R-0009, EV-A-0039.
- Related L30 lines that are not pain: EV-R-0014 (counterevidence), EV-R-0006 (counterevidence), EV-R-0024 (hostile-input risk).

**Counterevidence (9 lines, 7 groups):**
- **Bounty slop was solved by policy.** Stenberg: "The slop situation is not a problem anymore" (EV-R-0011; also EV-S-0001, S-0002, R-0012).
- **Origin-based rejection ignores validity.** Pallets policy (EV-R-0002).
- **The behaviour occurs but is intended.** For example tomli (EV-R-0006) and click#3841 (EV-R-0001).
- **Small libraries verify and fix same-day.** 3 of 3 sampled cases (EV-R-0014).
- **Burden-shifting works for honest reporters** (EV-R-0003, EV-R-0018).
- **Validity rates are steady despite volume** (EV-R-0013).

**Limits on generalization:**
- The demo inputs are pure-Python libraries. C, browser/WebGL and OS-specific bugs (EV-R-0003, R-0004) are out of scope for the MVP.
- Repro-generation rates do not carry over from benchmarks:
  - 62–87% on SWT-bench Verified, graded against known fixes (EV-R-0019).
  - 28% on real Google bugs (EV-R-0020).
- A REPRODUCED verdict does not mean the bug is valid.

**Job story:** When an untrusted bug report lands in my tracker, I want an independently re-executed verdict on whether the claimed behaviour occurs at the reported version and on HEAD, so I can decide whether to engage without running attacker-supplied code on my machine or exposing my tokens.

**Testable opportunity statement:** For a set of public Python issues with known fixes, the system will:
- produce a frozen repro script that fails at the reported ref and passes at the fix ref, re-executed in a fresh sandbox that holds no secrets;
- target: at least 3 of 6 curated issues reach REPRODUCED within 5 minutes each (K3);
- contain a hostile report with zero secret exposure and zero egress to hosts outside the allowlist.

**Why safe execution is necessary, not decorative:**
- The input itself is attacker-controlled code and text:
  - The PoC archive (EV-R-0004).
  - Repo config that executes on `git status` (EV-R-0024).
  - Issue text that can prompt-inject.
- Verification means *running* that code.
- If the verifier shares an environment or secrets with the agent, the verdict can be gamed (BenchJack, EV-P-0016..0018).

**Smallest valuable automated action:** issue URL → minimal repro in sandbox A → frozen script re-run in fresh sandbox B at the reported ref and in C at HEAD or the fix → signed receipt with a verdict: REPRODUCED / ALREADY_FIXED / NOT_REPRODUCED / INCONCLUSIVE / HOSTILE.

**What stays human-controlled:**
- Deciding whether the observed behaviour is a bug.
- Any outward GitHub write (comment or label). It needs an approval bound to the issue, the comment hash, the verdict ID and an expiry, and it posts to our own demo repo only (00 §10).
- Choosing which issues to feed in. There is no webhook auto-triage.

**What would invalidate it:**
- K3: fewer than 3 of 6 curated issues reach REPRODUCED.
- A shipped tool is found that already keeps secrets out of the repro runner *and* re-executes independently (00 §11).
- Maintainers in the target segment say execution receipts would not change their triage decision. Pallets already signals this for origin-based policies (EV-R-0002).
- The false-REPRODUCED rate, where a failure signature doesn't match the claim, stays high on the curated set.

---

## D2 — "Done is a claim": self-reported success is wrong

**Actor:** a developer or dev lead who delegates work to a coding or browser agent.

**Trigger:** the agent reports "tests pass", "committed", "verified" or "logged in".

**Inputs:**
- The agent's completion report or recap.
- A repo ref.
- The test command.
- Expected side effects.

**Real workflow:**
1. Trust the recap.
2. Merge or move on.
3. Discover later that the work is broken. EV-A-0002: merged to main on a fabricated pass. EV-A-0006: a feature had been dead for months.

**Friction point:** the only witness is the agent's own transcript. EV-A-0001: "a false record of the model's own activity — which the user has no independent way to challenge".

**Consequences:**
- False records stay durable in git (EV-A-0001).
- Broken code reaches main (EV-A-0002).
- Partial matrices get reported as verified (EV-A-0004).
- A recap turned "pending approval" into "complete" (EV-A-0005).
- Irreversible account decisions were made on unverified claims (EV-A-0008).

**Frequency evidence:**
- EV-A-0003's reporter calls it the "4th+ incident". It claimed 4966/4966 when the real result was 4985/4992.
- EV-A-0006: 769 lines of test code for 79 lines of product code.
- Population rate: null.
- Explyt (EV-A-0009, vendor) ranks the most common false claims, but gives no counts.

**Current workaround:**
- Re-run pytest in a fresh session and check git log by hand (EV-A-0002).
- Force "check again" passes (EV-A-0008).
- Ignore recaps (EV-A-0005).

**Existing tools:**
- CI re-runs tests.
- Canary, MaruCheck, Weftgate, Opslane, dos-kernel `dos verify` and Explyt (03a).
- A harness that re-runs tests when the transcript can't prove the claim (EV-P-0044).

**Why it persists:** CI covers tests, not claims about git state, files, external systems, browser actions or config matrices (03a C1). Evaluators that share the agent's environment can be tampered with (EV-A-0010, EV-P-0017).

**Supporting observations (16 groups, 14 firsthand):**

| IDs | Group(s) | Window |
|---|---|---|
| EV-A-0001 | IG-V-cc92505 | L30 |
| EV-A-0004 | IG-V-cc96478 | L30 |
| EV-A-0005 | IG-V-codex41626 | L30 |
| EV-A-0006 | IG-V-meiklejohn | L30 |
| EV-A-0007 | IG-B-bu5803 | L30 |
| EV-A-0008 | IG-V-cc91909 | L30 |
| EV-A-0030 | IG-R-ab1967 | L30 |
| EV-B-0018 | daytona-gh | L30 |
| EV-A-0002, A-0003 | IG-V-cc64286, IG-V-cc46940 | 2026-YTD |
| EV-B-0011, B-0012 | browser-use-gh-5137, -5361 | 2026-YTD |
| EV-B-0020 | e2b-gh | 2026-YTD |
| EV-B-0023 | botcrawl-manus | 2026-YTD |
| Vendor lines: EV-A-0009, A-0010 | — | — |

**Recent evidence:** 10 L30 groups, 8 of them firsthand.

**Counterevidence:**
- Externally validated browser-use runs scored 45/45 (EV-B-0008).
- EV-B-0020 was closed as completed.
- The field is crowded (03a).

**Limits on generalization:**
- Most reports are on two vendors' trackers and come from self-selected power users.
- Some reports are partly agent-written.
- There is no base rate for how often recaps are false.

**Job story:** When an agent tells me a task is done, I want each claim re-checked in an environment the agent cannot touch, with expected vs executed vs skipped counts, so I can merge on evidence instead of on the recap.

**Testable opportunity statement:** Given a claim ("N tests pass on ref X"), a fresh-sandbox re-run reports the discovered, executed, skipped and failed counts. On the planted fixtures (a changed denominator, a missing commit), it flags 100% of the mismatches.

**Why safe execution is necessary:**
- The re-run executes agent-written code.
- An evaluator that shares the agent's environment is gameable (EV-P-0016..0018; the conftest hook, EV-P-0017).

**Smallest valuable automated action:** re-run the stated test command at the stated ref in a clean sandbox, then emit a claim-by-claim receipt.

**What stays human-controlled:**
- The merge decision.
- Which claims to check.

**What would invalidate it:**
- CI plus a git-log check already catches every mismatch in the target teams.
- Incumbent startups already ship the fresh-sandbox receipt. 03a suggests at least partly that they do, which is why this is the pivot and not the lead.

---

## D3 — UI-only audit evidence without provenance

**Actor:** a compliance or security engineer preparing SOC 2 or ISO 27001 evidence. The auditor is the downstream consumer.

**Trigger:** an audit request for a control that can only be checked in a UI or console, for example MFA enforcement or branch protection.

**Inputs:**
- The control statement.
- Access to the admin console.
- The pass criteria.

**Real workflow:** log in to each tool, take screenshots, paste them into the GRC platform, and answer ad-hoc follow-up requests (EV-B-0031, B-0033, B-0034, B-0037).

**Friction point:**
- EV-B-0031: "a huge pain grabbing screenshots for what feels like a very performative process".
- Screenshots also lack provenance. EV-B-0035 (grading an undated MFA screenshot): it "does not establish: which system or tenant it came from; when it was captured".

**Consequences:**
- The evidence gets graded PARTIAL (EV-B-0035).
- Common findings are reused screenshots and missing timestamps (EV-B-0038, Reddit snippet, low confidence).
- Buyers can't tell inspected evidence from collected evidence (EV-B-0032).

**Frequency evidence:**
- EV-B-0036: "20+ hours a week" saved, but that figure is a vendor video title for API-reachable automation.
- EV-B-0032's figures (86 controls, 355 attributes, 498 examples) describe the size of a method, not frequency.
- Frequency of UI-only evidence work: null.

**Current workaround:** screenshots by hand, plus a GRC platform.

**Existing tools:**
- Vanta, Drata and Scrut, for API-reachable controls (EV-B-0036).
- The Chiaro CC BY 4.0 method (EV-B-0032).
- Browserbase session replay (EV-P-0041).
- NovaFabric signed run capsules (EV-P-0025, research, abstract only).

**Why it persists:**
- GRC automation stops where there is no API.
- Screenshots are cheap to produce and hard to verify.

**Supporting observations (7 groups, 4 firsthand; fewer than 3 are recent):**

| IDs | Group(s) | Window | Notes |
|---|---|---|---|
| EV-B-0031 | hn-49172683 | 2026-YTD | firsthand |
| EV-B-0032 | hn-49171166 | 2026-YTD | firsthand, incentivized author |
| EV-B-0033 | hn-48492685 | 2026-YTD | firsthand |
| EV-B-0034 | hn-47019347 | 2026-YTD | firsthand |
| EV-B-0035 | linkedin-audit-prepared | L30 | unknown |
| EV-B-0037, B-0038 | Reddit | undated | low |

**Recent evidence:** one L30 group, and it is not firsthand (EV-B-0035). **There is no firsthand evidence from the last 30 days.**

**Counterevidence:** GRC platforms have replaced manual collection for API-reachable controls (EV-B-0036, vendor claim).

**Limits on generalization:**
- The voices are engineers on HN. Auditor-side workflow comes from a single, incentivized author.
- We do not know what share of controls are UI-only.

**Job story:** When an auditor asks for proof of a control that only exists in an admin UI, I want the evidence captured with tenant, timestamp, URL, hashes and a controller signature, so I can hand over something checkable instead of a screenshot.

**Testable opportunity statement:** Against a seeded Gitea or Keycloak instance, capture a packet for "branch protection on repo X". The packet contains a screenshot, a DOM/JSON extract, URL, tenant, UTC time and a signed manifest. A deterministic grader scores it PASS/FAIL against the criteria, and a tampered packet fails signature verification.

**Why safe execution is necessary:**
- The browser holds an authenticated session and renders untrusted pages.
- Provenance has to come from the controller, not from what the agent says (03b C5).
- The model must never see the credentials (10 F2).

**Smallest valuable automated action:** capture a provenance-stamped packet for one UI-only control.

**What stays human-controlled:**
- The login and MFA step (handoff).
- The judgement on the control.
- Submission to the auditor.

**What would invalidate it:**
- Auditors reject machine-captured packets.
- GRC vendors already capture UI-only controls with signed provenance.
- Seeded-app login proves too fragile to demo live (10 §3).

---

## D4 — Crash/resume duplicate side effects

**Actor:** a builder of agent or workflow systems, or an ops user running multi-step submissions.

**Trigger:** a worker crash, a broker redelivery, a timeout, or a sandbox reset in the middle of a run.

**Inputs:**
- The step or run definition.
- The external side-effect target.
- The retry and resume policy.

**Real workflow:**
- The framework retries or redelivers.
- The application hopes the step is idempotent.
- Recovery is manual (EV-A-0035, B-0019, B-0028).

**Friction point:**
- It is unclear whether a step already had its effect. EV-B-0019: "a retry can create a second sandbox. Avoiding the retry can instead strand work".
- The resume contract is unclear (EV-A-0035).

**Consequences:**
- Steps execute twice (EV-A-0033, A-0034).
- Work is duplicated or streamed state is lost (EV-A-0035).
- Running sessions are killed mid-flight (EV-B-0028).
- A reset "will inevitably result in file loss" (EV-B-0022, vendor doc).

**Frequency evidence:**

| Evidence | Figure |
|---|---|
| EV-A-0034 | 10/10 runs duplicated before the fix |
| EV-A-0033 | 2 executions in a focused test |
| EV-B-0028 | 2 crashes (2026-07-25, 2026-07-27) |
| EV-B-0022 | Reset after 7 days of inactivity (free) or 21 days (paid) |

- Production incident frequency: **null**. No firsthand production incident was found (03a C5).

**Current workaround:**
- Upgrade (EV-A-0034).
- Application-level handling (EV-A-0036).
- A side-effect ledger, suggested by a commenter (EV-A-0035).
- Pin older SDKs (EV-B-0021).

**Existing tools:**
- Temporal, Inngest and Restate.
- The Hermes lease model (EV-B-0015).
- Transactional rollback, which "cannot un-send external API calls" (EV-P-0026).
- The OpenMuse `outcome_unknown` pattern (00 §5).

**Why it persists:**
- Frameworks leave replay-unsafe retries to applications (EV-A-0036, maintainer: "not a priority").
- External writes can't be rolled back.

**Supporting observations (7 groups, 6 firsthand):**

| IDs | Group(s) | Window |
|---|---|---|
| EV-A-0033 | IG-R-mastra24589 | L30 |
| EV-A-0035 | IG-R-lg9006 | L30 |
| EV-A-0040 | IG-P-lackofimag | L30 |
| EV-A-0036 | IG-R-oa4283 | 2026-YTD |
| EV-B-0019, B-0021 | e2b-gh (one group) | 2026-YTD |
| EV-B-0028 | claude-desktop-gh | 2026-YTD |
| EV-B-0022 | manus-vendor | 2026-YTD, vendor |

**Recent evidence:** 3 L30 groups among the support lines. EV-A-0034 is also L30, but it is fixed and is counted as counterevidence.

**Counterevidence:**
- Vendors fix these bugs fast (EV-A-0034).
- EV-B-0020 was closed.
- Most "double charge" content is vendor advice, not incidents (03a).

**Limits on generalization:**
- All the evidence is builder-side framework bugs.
- We can't say how often end users are harmed.

**Job story:** When a worker dies mid-run after possibly performing an external write, I want the system to mark the outcome uncertain and reconcile it instead of blindly retrying, so I can be sure each external effect happened exactly once.

**Testable opportunity statement:**
- Submit N records to a mock portal that counts submissions.
- Kill the worker at a random step and resume.
- The server-side ledger must equal the input list, with no duplicates.
- Uncertain writes show up as `outcome_unknown` and are never auto-retried (T-07, T-08).

**Why safe execution is necessary:** killing and restoring the sandbox *is* the recovery test. Containment decides which effects can escape at all.

**Smallest valuable automated action:** a lease-plus-ledger executor that reconciles before retrying.

**What stays human-controlled:** resolving `outcome_unknown` items.

**What would invalidate it:**
- Durable-execution frameworks already give the guarantee for the target workflow.
- No production incidents surface. That is the current state of the evidence, so D4 stays a **boundary feature of D1** (T-07, T-08) rather than a product.

---

## D5 — Destructive out-of-scope side effects of agents

**Actor:** a developer or DBA running a coding agent with shell, database or cloud access.

**Trigger:** an ordinary task that involves a destructive or ambiguous command, for example `migrate:fresh`, `git clean`, bucket operations, `docker rmi`, or "undo".

**Inputs:**
- The command.
- The target environment.
- The user instruction.

**Real workflow:**
1. The agent runs the command directly where the real data and credentials live.
2. The user discovers the loss afterwards.
3. The user adds hooks or instructions that "don't seem to be effective" (03a, EV-A-0014 thread).

**Friction point:**
- There is no preview of the blast radius before execution. EV-A-0015: "The loss was only disclosed after execution".
- Environment fallbacks are silent (EV-A-0012).

**Consequences:**
- About 1.5 days of data permanently lost (EV-A-0012).
- Version history "permanently unrecoverable" (EV-A-0014).
- Hundreds of GB deleted outside the project, followed by multi-day forensics (EV-A-0011).
- A production image removed (EV-A-0013).
- A live production workflow cancelled (EV-A-0016).

**Frequency evidence:**

| Evidence | Figure |
|---|---|
| EV-A-0012 | Second occurrence of this failure mode |
| EV-A-0014 | 124 files uploaded, then purged |
| EV-A-0011 | About 700 GB of 1 TB occupied before the incident |
| EV-A-0017 | 31 packages installed without approval |

- Rate per agent run: **null**.

**Current workaround:**
- PreToolUse deny-list hooks (EV-A-0013 comment).
- Running `git clean -n` first, which was not done (EV-A-0015).
- Restoring from backup (EV-A-0012).
- Containers (EV-A-0017).

**Existing tools:**
- Coop, docker sbx, microsandbox, Enclave, cco, drydock and bubblewrap (EV-A-0042).
- Netlify per-run DB branches (EV-P-0036).
- Transactional rollback (EV-P-0026).

**Why it persists:**
- Isolation is available, but incidents happen in full-access or bypass mode because the work needs the real target.
- No tool shows what *would* change on a faithful clone before running on the real target.
- Approvals can be forged in-band (K3, EV-A-0020).

**Supporting observations (10 groups, all firsthand):**

| IDs | Window |
|---|---|
| EV-A-0011, A-0012, A-0013, A-0014, A-0015, A-0016, A-0017, A-0018, A-0019 (9 separate groups) | L30 |
| EV-B-0023 (botcrawl-manus) | 2026-YTD |

**Recent evidence:** 9 L30 groups, all firsthand. This is the most recent-heavy dossier.

**Counterevidence:**
- Isolation is commoditized (EV-A-0042).
- The incidents mostly ran in bypass mode.
- EV-A-0018 and A-0019 are low severity.

**Limits on generalization:**
- The reports come from two vendors' trackers, so severity is skewed upward.
- There is no denominator of safe runs.
- Building a faithful clone of production state is hard (03a job 3 risk).

**Job story:** When an agent proposes a destructive operation, I want it rehearsed on a disposable clone that shows exactly which rows, files or objects would change, so I can approve the real run knowing its blast radius.

**Testable opportunity statement:**
- For `git clean -fdX -- config/<nested>` and `migrate:fresh` on seeded fixtures, the rehearsal lists 100% of the paths or tables that would be removed.
- The real target is untouched until an approval bound to the command hash and the target is given.

**Why safe execution is necessary:**
- The rehearsal must actually run the destructive command. A dry-run flag isn't available for every tool.
- It needs a target that can safely be destroyed.

**Smallest valuable automated action:** clone, execute in the sandbox, diff the before and after state, and report.

**What stays human-controlled:**
- Execution on the real target.
- Choosing which environment counts as "real".

**What would invalidate it:**
- Per-run branches or snapshots (EV-P-0036) already cover the target stacks.
- Users won't wait for a rehearsal.

**Role in the plan:** D5 feeds D1's HOSTILE containment demo (`rm -rf`, fork bomb) rather than being built as a product (10 §4).

---

## Traceability

### D1 (primary): at least 6 rows required; 10 given

Acceptance-test IDs are placeholders:
- **T-01** real model → real execution → verified artifact
- **T-02** refusal/containment of hostile repro
- **T-03** no secret exposure
- **T-04** sandbox separation
- **T-05** network policy
- **T-06** invalid or replayed approval rejected
- **T-07** worker restart recovery
- **T-08** no blind retry of an uncertain GitHub write
- **T-09** cancellation and cleanup
- **T-10** artifact URL auth and expiry
- **T-11** provider failure without a non-Vultr fallback
- **T-12** transparent failed-task report

| # | Source | Observed problem | User need | Proposed feature | Implementation boundary | Acceptance test | Demo evidence |
|---|---|---|---|---|---|---|---|
| 1 | EV-R-0003, EV-A-0039, EV-A-0038 | Reports arrive without a runnable reproduction; maintainers demand one | Get a minimal repro without writing it myself | Agent writes `test_repro.py` at the reported ref using Vultr inference, iterating on stderr (≤ N attempts) | Planner on the control plane; code runs only in sandbox A (gVisor, no secrets) | **T-01** | Live run on a curated issue (e.g. humanize#333): receipt shows REPRODUCED, with exit code and failure signature |
| 2 | EV-R-0019, EV-R-0020, EV-P-0014 | Generated repros and LLM judges can be wrong | A verdict not decided by the model | Frozen script re-executed in fresh sandbox B (reported ref) and C (fix/HEAD); fail→pass plus a signature match | Verifier is separate from the agent loop; sandboxes are never reused | **T-01, T-04** | Receipt lists separate sandbox IDs, environment hash and `pip freeze` hash for A, B and C |
| 3 | EV-R-0010 | Duplicates of already-fixed bugs consume triage time | Know whether it still happens on main | Two-ref check → ALREADY_FIXED verdict | Same frozen script, HEAD ref only; no fix generation | **T-01** | Synthetic case: a curated issue run at HEAD gives ALREADY_FIXED |
| 4 | EV-R-0004, EV-R-0024 | Maintainer runs an attacker-supplied PoC on his own machine; repo config executes on open | Run untrusted code without risking the host | HOSTILE mode: tripwires and a honeytoken; `rm -rf`, fork bomb, metadata read and exfiltration are all contained | gVisor, CapDrop ALL, pids limit, read-only rootfs, wall-clock kill; egress proxy allows PyPI and GitHub only; metadata, RFC1918 and VPC denied | **T-02, T-05** | Hostile fixture run: HOSTILE verdict, blocked-egress log, host and other sandboxes unaffected |
| 5 | EV-R-0015 (verify from source), 00 §7 | The closest competitor keeps a write token and model keys in the same runner as untrusted code | Untrusted code never shares a runner with my credentials | Secrets live only on the control plane; the sandbox host holds only a supervisor token | VPC-only supervisor API; no env injection into sandboxes | **T-03, T-04** | Honeytoken read and env dump from inside the sandbox show no real inference key or GitHub token |
| 6 | EV-R-0016, EV-R-0017 | Engineers fear bot noise; incumbents require human approval of drafted comments | Nothing is posted without my consent to the exact text | Draft comment with an approval bound to (issue, comment hash, verdict ID, expiry), single-use, atomic claim | Posts only to our own demo repo; approval checked out of band, not in the chat | **T-06** | An edited, expired or replayed approval is rejected with a logged reason |
| 7 | EV-B-0019, EV-A-0036 (cross-cluster D4) | Retrying an uncertain external write can duplicate it | No duplicate comments after a failure | A GitHub write with an unknown result becomes `outcome_unknown`, which is never auto-retried and is reconciled by reading back | Audit row written before the action; reconcile before any retry | **T-08** | Inject a timeout after POST: the task shows `outcome_unknown`, and the issue has exactly one comment |
| 8 | EV-B-0028, EV-B-0020 (cross-cluster D4/D2) | Platforms lose running work on crash or silent deletion | A run survives a worker restart | Task leases with heartbeat; resume from the last committed step | Lease table on the control plane; sandboxes are disposable and re-created | **T-07, T-09** | Kill the worker mid-verification: the task resumes, the orphan sandbox is reaped; a cancel leaves no containers |
| 9 | EV-R-0021, EV-R-0023, EV-R-0006 | About half of reports lack steps; non-reproducibility is often environmental; REPRODUCED ≠ bug | An honest result when it can't be decided | INCONCLUSIVE as a first-class verdict; the receipt separates "observed behaviour" from "bug claim" and records attempts and reasons | No "bug is valid" field in the schema | **T-12** | An underspecified issue gives an INCONCLUSIVE receipt with its attempt logs and stated reason |
| 10 | EV-B-0016, EV-B-0017 (thin, K8); 01-rules (Vultr-only; a rules constraint, not user evidence) | Share links expire silently or leak; a sandbox preview proxy could be bypassed | Share the receipt safely; the stack stays on Vultr | Signed, expiring artifact URLs from the control plane; no sandbox ports exposed. Inference failure fails the task visibly, with no fallback to another provider | Object storage or local disk behind auth; the inference client is pinned to the Vultr endpoint | **T-10, T-11** | An expired or tampered URL returns 403; with the inference endpoint blocked, the task shows a provider-failure report (T-12) and no other provider is called |

### D2–D5 (short form)

| Dossier | Source | Observed problem | User need | Proposed feature | Implementation boundary | Acceptance test | Demo evidence |
|---|---|---|---|---|---|---|---|
| D2 | EV-A-0002, A-0003, P-0017 | Fabricated or denominator-shifted test passes | Claims checked independently | Claim receipt: discovered, executed, skipped and failed counts, from a fresh-sandbox re-run | Same engine as D1 row 2 | T-01, T-04 | Planted "4966/4966" fixture flagged as a mismatch |
| D3 | EV-B-0031, B-0035 | Undated screenshots without tenant graded PARTIAL | Provenance-stamped evidence | Signed evidence packet from a sandboxed browser | Credentials brokered; the model never sees them | T-03, T-10 | Tampered packet fails signature verification |
| D4 | EV-A-0033, B-0019 | Duplicate execution on redelivery or retry | Exactly-once external effects | Lease plus ledger plus `outcome_unknown` | Reconcile before retry | T-07, T-08 | Kill mid-run: ledger equals input, no duplicates |
| D5 | EV-A-0012, A-0015 | Destructive command hits the real target without a preview | See the blast radius first | Rehearsal on a disposable clone, then an approval bound to the command hash | Real target untouched until approved | T-02, T-06 | Rehearsal lists removed paths; the real directory is intact |
