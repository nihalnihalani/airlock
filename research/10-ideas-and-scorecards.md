# 10 — Ideas, gates and scorecards

Synthesis owner: research director. Written 2026-09-26 (IST), from evidence files `evidence-a.jsonl` (EV-A), `evidence-b.jsonl` (EV-B), `evidence-p.jsonl` (EV-P) and `evidence-r.jsonl` (EV-R, the repro-idea validation). It also draws on the repo audits (07, 08) and the Vultr/rules docs (01, 13).

Scores are **our decision model**. Only the weights (Technicality 40 / Creativity 25 / Live demo 20 / Future potential 15 in round 1; equal weights in round 2) come from the organizer guide. Build-risk and product-confidence are kept separate and are not organizer criteria.

## 1. Concept generation (18 distinct concepts)

Each concept states: user/job · supporting evidence · current alternative · why containment matters.

| # | Concept | User and job | Evidence | Current alternative | Why a sandbox is essential (not decoration) |
|---|---|---|---|---|---|
| 1 | **Repro-or-Reject** | OSS maintainer: "tell me if this incoming bug report is real before I spend an hour on it" | EV-A-0038/0039/0015; EV-P (1 in 5 "solved" SWE-bench patches are wrong; the 61.9% LLM-judge error); curl bounty end (EV-S-0001) | Manual triage; "needs reproduction" label + StackBlitz link requirement; closing issues | The report and its PoC are attacker-controlled code/text. They run against an untrusted dependency tree |
| 2 | Security-PoC detonation chamber | Security triager: run a reported PoC safely, get verdict | curl/Turso (EV-S-0001/0002, EV-A-0038) | HackerOne/Bugcrowd human triage (AI triage claims: see 03c) | The PoC is literally hostile by design |
| 3 | Claim Court (Proof-of-Run) | Dev lead: verify a coding agent's "all tests pass / committed / done" | EV-A-0001..0010, EV-B C2 | CI re-run + human diff review; startups Canary/MaruCheck/Weftgate/Opslane | Re-executing agent output must not share the agent's environment (BenchJack lesson, EV-P) |
| 4 | Evidence Clerk | Compliance engineer: capture provenance-stamped evidence for UI-only controls | EV-B-0031..0038 | Screenshots by hand; Vanta/Drata for API-reachable controls | Authenticated session plus untrusted pages; provenance must come from the controller |
| 5 | Handoff Desk | Ops user: the agent hits MFA, a human completes it, the agent resumes in the same session | EV-B-0001..0005, 0013..0015, 0029 | Drive the user's own Chrome (no isolation); Browserbase live view | Cookies must stay in a disposable VM, not the user's browser |
| 6 | Exactly-Once Submitter | Ops: submit N records to a portal, survive crashes with no duplicates | EV-B-0019/0022/0028, EV-A-0033..0035 | Durable-execution frameworks (Temporal/Inngest); manual re-check | The sandbox kill/restore is both the recovery test and the containment moment |
| 7 | Portal statement puller | AP clerk: pull invoices from no-API portals with totals checked | EV-B C8, EV-B-0043 | ≥6 vendors | Untrusted downloads and portal JS |
| 8 | Explore-then-replay compiler | Automation engineer: agent explores once and emits a script verified in a clean box | EV-B C4 (EV-B-0006/0010) | Browserbase Autobrowse, BrowserBook | Runs model-written code |
| 9 | Blast Preview (destructive-op rehearsal) | Dev/DBA: see exactly what a migration or cleanup would delete before running it | EV-A-0011/0012/0014/0015/0019 | Netlify per-run DB branches; staging; `--dry-run` | Executes destructive operations on a disposable clone |
| 10 | Matrix verifier | Maintainer: run an agent change across OS/flag combos | EV-A-0004/0037/0006 | CI matrices | Parallel disposable environments |
| 11 | Airlock + Tripwire | Platform eng: sandboxes hold only placeholder creds; honeytokens auto-kill | Prior 04 file; EV-P (d commoditized, e better workflow) | Vercel/Cloudflare/Docker Sandboxes egress proxies, 6+ OSS proxies | *Is* the boundary, but lacks a user job on its own |
| 12 | Isolation ladder | Platform eng: route each step to gVisor/microVM/VM by risk | Prior 04 file | Vendors pick one tier | Infrastructure feature; no user job |
| 13 | Time Machine | Dev: snapshot per step, rewind | Prior 04 file; EV-B (Daytona snapshot bugs) | E2B/Daytona snapshots | Snapshots are commodity |
| 14 | Dependency-upgrade rehearsal | Maintainer: bump a dependency, run tests, report breakage | weak (gap in 03a) | Dependabot/Renovate + CI | Runs untrusted package code |
| 15 | Scope-diff reporter | Dev: list what an agent run touched outside scope | EV-A-0011/0017/0018 | git diff | Low severity per incident |
| 16 | Site QA sweep | QA: crawl an app for broken flows | Vultr starter idea | Playwright suites, many tools | Crowded (Vultr's own list) |
| 17 | Browser flight recorder | Agent developer: receipts and post-conditions for each browser action | EV-A-0025/0026/0030/0032, EV-B-0007 (browser-use #5361/#5438) | Playwright Trace Viewer (scripted only) | Component, not a product |
| 18 | Research with receipts | Analyst: every claim backed by a screenshot | Vultr starter idea | Many tools | Crowded; close to banned "basic RAG" |

Removed without scoring: anything in the banned list (basic RAG, Streamlit, dashboard-as-main-feature, screeners, and the rest). #18 is kept only as a crowded-idea reference.

## 2. Hard gates (pass ✅ / risk ⚠️ / fail ❌)

Gates: G1 rules-compliant · G2 real execution · G3 Vultr VM backend · G4 Vultr inference only · G5 credible isolation · G6 demo inputs obtainable without secrets · G7 buildable in about 24h · G8 identifiable new work · G9 a real user job with evidence.

| # | G1 | G2 | G3 | G4 | G5 | G6 | G7 | G8 | G9 | Survives? |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 Repro-or-Reject | ✅ | ✅ | ✅ | ⚠️ probe not run | ✅ | ✅ public issues | ✅ | ✅ | ✅ | **yes** |
| 2 PoC chamber | ✅ | ✅ | ✅ | ⚠️ | ✅ | ⚠️ real PoCs are risky; use synthetic | ✅ | ✅ | ⚠️ curl counterevidence | merged into #1 as the "hostile report" mode |
| 3 Claim Court | ✅ | ✅ | ✅ | ⚠️ | ✅ | ✅ | ✅ | ✅ | ✅ but crowded | yes |
| 4 Evidence Clerk | ✅ | ✅ | ✅ | ⚠️ | ✅ | ✅ seeded Gitea/Keycloak | ⚠️ browser + login + grading | ✅ | ✅ | yes |
| 5 Handoff Desk | ✅ | ✅ | ✅ | ⚠️ | ✅ | ✅ | ⚠️ live-view streaming | ✅ | ✅ | yes |
| 6 Exactly-Once | ✅ | ✅ | ✅ | ⚠️ | ✅ | ✅ mock portal | ✅ | ✅ | ⚠️ weak production pain | yes |
| 7 Portal puller | ✅ | ✅ | ✅ | ⚠️ | ✅ | ✅ | ✅ | ✅ | ⚠️ saturated | no: no differentiation |
| 8 Explore/replay | ✅ | ✅ | ✅ | ⚠️ | ✅ | ✅ | ✅ | ⚠️ | ⚠️ owned by vendors | no |
| 9 Blast Preview | ✅ | ✅ | ✅ | ⚠️ | ✅ | ✅ | ✅ | ✅ | ✅ | yes |
| 10 Matrix | ✅ | ✅ | ✅ | ⚠️ | ✅ | ✅ | ✅ | ⚠️ | ⚠️ CI covers it | no |
| 11 Airlock+Tripwire | ✅ | ⚠️ needs a host workflow | ✅ | ⚠️ | ✅ | ✅ | ✅ | ✅ | ❌ no user job | **folded in as #1's containment layer** |
| 12 Ladder | ✅ | ⚠️ | ✅ | ⚠️ | ✅ | ✅ | ⚠️ | ✅ | ❌ | no (post-hackathon) |
| 13 Time Machine | ✅ | ✅ | ✅ | ⚠️ | ✅ | ✅ | ⚠️ | ⚠️ | ⚠️ | no |
| 14 Dep rehearsal | ✅ | ✅ | ✅ | ⚠️ | ✅ | ✅ | ✅ | ⚠️ | ❌ weak evidence | no |
| 15 Scope diff | ✅ | ✅ | ✅ | ⚠️ | ✅ | ✅ | ✅ | ⚠️ | ⚠️ low severity | no |
| 16 Site QA | ✅ | ✅ | ✅ | ⚠️ | ✅ | ✅ | ✅ | ❌ crowded | ⚠️ | no |
| 17 Flight recorder | ✅ | ✅ | ✅ | ⚠️ | ✅ | ✅ | ✅ | ✅ | ⚠️ component | folded into #4/#5 |
| 18 Receipts research | ⚠️ near banned RAG | ✅ | ✅ | ⚠️ | ✅ | ✅ | ✅ | ❌ | ⚠️ | no |

G4 is ⚠️ for **every** concept. The Vultr inference probe (`raw/vultr/probe_inference.sh`) has not been run because we have no key. It is the first kill test (§5).

## 3. Scorecards (6 shortlisted concepts, 0–10)

Round-1 score = 0.40·T + 0.25·C + 0.20·D + 0.15·F. Round-2 score = equal weights (mean of the four).

| Concept | Technicality | Creativity | Live demo | Future/AI impact | R1 | R2 | Build risk (ours, 1 = low) |
|---|---|---|---|---|---|---|---|
| **1 Repro Receipts (adjusted Repro-or-Reject; + hostile-report mode, + tripwire layer)** | 8: two-sandbox independent re-execution, reported-ref vs latest-ref check, approval-bound outward action, honeytoken tripwire | 5 (corrected after 18 DA-05): triagebot-action auto-reproduces (on the runner, not sandboxed), and ClusterFuzz/syzbot already re-run reproducers on latest/fix refs, so ours is a stronger boundary plus packaging | 8: real public issue live; hostile PoC absorbed; verify-only replay as a fallback | 8: current demand (Pallets 13 issues + 75 PRs 'rejected AI' in 30 days; GitHub's June 2026 anti-spam features; EV-R); generalizes to security-PoC triage and agent-claim verification | **7.25** | **7.25** | 2 |
| 4 Evidence Clerk | 8 | 7 | 6: a login plus a seeded app is fragile live | 7 | 7.20 | 7.00 | 4 |
| 6 Exactly-Once Submitter | 8 | 6 | 8: the kill-mid-run moment is strong | 5 | 7.05 | 6.75 | 2 |
| 9 Blast Preview | 7 | 6 | 8 | 6 | 6.80 | 6.75 | 3 |
| 5 Handoff Desk | 7 | 6 | 6 | 6 | 6.40 | 6.25 | 4 |
| 3 Claim Court | 7 | 5: crowded | 7 | 6 | 6.35 | 6.25 | 2 |

Score rationale, including evidence for each number: Technicality counts executed steps plus independent verification plus a real boundary (gVisor, egress policy, no secrets). Creativity is discounted wherever 06-competitive-landscape found the mechanism shipping. Live demo is discounted for dependence on logins or third-party sites. Future is weighted by breadth of adjacent demand.

### Sensitivity
- **Equal weighting (round 2):** the order is unchanged. #1 (7.50) leads #4 (7.00) by 0.50.
- **Modest uncertainty (±1 on any single criterion):** #1 falls to 7.10 if Live demo drops to 6. That is **below #4 (7.20)** and about equal to #6 (7.05). The recommendation is therefore sensitive to demo reliability. We hedge by pre-validating the 10 curated issues in 03c during the K3 spike, and by keeping a recorded fallback.
- **What flips it:** if K3a (the model-only spike, rev. after 18) yields fewer than 3 of 6 fail-before/pass-after, or if a shipped product is found that independently re-verifies in a fresh sandbox *and* keeps secrets out of the repro runner (Creativity → 5, R1 → 7.25). See 00-executive-decision for the pivot rule.

### Adjustment after validation (03c, EV-R)
03c's verdict was 'adjust, then go', and the concept is reframed as **Repro Receipts: verified reproduction receipts for untrusted bug reports**.

- **Two checks:** (1) Does the report reproduce at the reported version? (2) Does it still reproduce on latest/main? The second check answers the 'already fixed' duplicate problem Torvalds describes (EV-R).
- **Separate outputs:** the receipt reports *observed behaviour* separately from the *bug claim*, because several rejected reports describe real but intended behaviour (tomli #304, click #3841, semver #465/#468).
- **Pitch, not 'catch AI slop':** Pallets rejects by AI origin, not validity, and curl's slop problem ended with its bounty (EV-S-0001). The pitch is 'untrusted repro code never shares a runner with your write token or model keys, and the verdict is independently re-executed'. *(rev. after 18: "never shares" holds only while the two VMs stay separate, a hard gate per DA-17; and the receipt proves the frozen script behaves differently at these refs, not that the bug is real.)*
- **Expect many INCONCLUSIVE results:** only about 51% of bug reports include steps (FSE'17, via 03c), so INCONCLUSIVE is a first-class, honest outcome.

## 4. Three finalists (full specification)

### F1 — Repro Receipts (recommended; the adjusted Repro-or-Reject)
- **User/job:** a maintainer of a small or medium OSS library gets a bug report, possibly AI-written. Job: "before I invest time, tell me whether this is real, with evidence I can re-run myself."
- **Evidence:**
  - Turso retired its bounty over non-reproducing AI reports (EV-A-0038).
  - An OSS policy that rejects unreproduced reports (EV-A-0039, last 30 days).
  - Trackers flooded with reports that have no reproduction (dev.to, Sep 24).
  - LLM judges approve broken tests unless they are executed (EV-P).
- **Counterevidence:** curl's slop stopped once the bounty ended (EV-S-0001), so for *bounties* the incentive fix works. Reports often lack runnable steps (03a C6). Repro-test generation is well studied (EV-P).
- **Input:** GitHub issue URL (+ optional version/commit override).
- **Workflow (executed):**
  1. Fetch the issue via GitHub API on the control plane.
  2. Plan with Vultr inference.
  3. Sandbox A (gVisor, no secrets, egress allowlisted to PyPI + GitHub): clone at the reported version, install, write `test_repro.py`, run it, iterate on stderr (≤ N attempts).
  4. The verifier takes the frozen repro script and runs it in fresh sandbox B at the reported version, where it must fail with the matching signature. If a fix commit is known, it also runs in sandbox C at the fix commit, where it must pass. *(rev. after 18: plus sandbox D at HEAD, always, giving ALREADY_FIXED; an AST static gate on the script; and B/C/D with no network, installing from a hashed lock built in a separate prep sandbox. See 12 §5.)*
  5. Verdict, receipt, artifacts.
  6. Optional draft GitHub comment, gated by an approval bound to its content hash.
- **Final artifact:** verdict + minimal repro script + logs + environment manifest (Python version, `pip freeze` hash, commit SHA) + signed receipt + a copy-paste command anyone can run (rev. after 18: a two-step command, fetch with network then `docker run --network none`; 12 §8).
- **Containment matters because:** the issue text can prompt-inject, and the PoC or repo code is untrusted. The demo "hostile report" tries `rm -rf`, a fork bomb, reading env/metadata, and exfiltration to an unlisted host, and plants a honeytoken read.
- **Approval boundary:** the only outward action is posting a comment or label, and it needs human approval bound to (issue, comment hash, verdict ID, expiry). Execution inside the sandbox is automatic because it is contained.
- **Verification:** deterministic. The same frozen script is re-executed in a fresh sandbox; exit code and failure-signature match; fail→pass across the fix commit. The model is never the judge of success.
- **Vultr role:** control-plane VM (API, DB, UI, supervisor client); sandbox-host VM (Docker + gVisor runsc, supervisor daemon); Serverless Inference for plan/repro-writing/summary; Vultr Object Storage for artifacts (optional; local disk fallback).
- **Reuse:** patterns only. From OpenMuse: approval hash binding, atomic claim, `outcome_unknown`, task leases, container flags. From OpenBot: supervisor container hardening, deny-before-allow policy, audit-before-action. See 09.
- **Original contribution:** the whole application, plus the two-sandbox independent-verification protocol, the hostile-report containment layer, and the approval-bound GitHub action.
- **MVP:** Python repos only, pytest only, single user plus judge accounts, 1 sandbox host.
- **Demo moment:** paste a real issue; watch the agent write a repro; the fresh sandbox confirms it fails on vX and passes on the fix commit. Then paste the hostile report, and the tripwire fires. *(rev. after 18, DA-18: the demo now leads with the hostile issue PoC and the stderr→retry loop, and shows the fresh re-run second; 16 §1.)*
- **Biggest uncertainty:** Vultr inference tool-calling quality for writing a correct repro within 3–5 iterations.
- **Rejection criterion:** in the K3a model-only spike (hours 0–2.5, rev. after 18), fewer than 3 of 6 curated issues fail at the before-ref and pass at the after-ref.

### F2 — Evidence Clerk (fallback if a browser pattern is preferred)
- **User/job:** a compliance engineer needs audit evidence for controls that can only be checked in a UI (for example branch protection, MFA enforcement), with tenant, time and scope provenance.
- **Evidence:** EV-B-0031..0038. **Counterevidence:** Vanta/Drata automate API-reachable controls (EV-B-0036).
- **Workflow:**
  1. Take a control statement.
  2. The agent plans the checks, then drives Playwright in a gVisor sandbox against a seeded Gitea.
  3. It captures a screenshot, DOM/JSON state, URL and tenant, and the controller hashes and signs them.
  4. A deterministic grader compares the captured state with the control criteria (Chiaro CC BY 4.0 method).
- **Containment:** the session cookie lives only in the disposable browser. The login is a human handoff or a broker-injected credential, and the model never sees it.
- **Why not first:** login and seeded-app fragility live; the extra browser streaming work (live view) adds 4–8h.

### F3 — Claim Court (secondary pivot option only; rev. after 18 the primary pivot is Exactly-Once Submitter, §6)
- **User/job:** a dev lead verifies a coding agent's completion claim ("PR #12: all 4,966 tests pass").
- **Evidence:** EV-A-0001..0010 (fabricated passes).
- **Workflow:** parse the claim, re-run in a fresh sandbox, and record expected vs discovered vs executed vs skipped tests, with a verdict per claim.
- **Why not first:** crowded startup field and CI overlap (03a "already solved").
- **Why keep it:** it shares 80% of F1's engine (sandbox run + independent re-execution + receipt). If F1's repro generation proves unreliable, pivot here by swapping only the planner prompt and the input parser. *(rev. after 18: the reviewer's scores give Claim Court no advantage, so the default pivot is Exactly-Once Submitter; Claim Court only if the team values engine reuse over demo reliability.)*

## 5. Kill tests, in order

1. **K1 inference (≤30 min after the key arrives):** run `raw/vultr/probe_inference.sh`, which needs tool calls plus multi-step tool results on the chosen model. Fail → try the next tool-capable model; if all fail, move structured output to a forced single tool call.
2. **K2 sandbox (≤1h):** `runsc` container on the sandbox VM. It must pass:
   - `pip install` from an allowlisted proxy;
   - blocked `curl 169.254.169.254`;
   - blocked arbitrary egress;
   - a fork bomb capped by pids-limit;
   - wall-clock kill.
3. **K3 repro, split (rev. after 18, DA-10):** **K3a (hours 0–2.5, decides the pivot):** the Vultr model writes repros for the 6 curated issues (03c), run in plain `docker run --network none` against pre-installed checkouts. ≥3 fail-before/pass-after → continue F1. Else → **Exactly-Once Submitter** (Claim Court secondary). **K3b (by ~hour 6):** the same through the real supervisor, sandboxes and proxy; a miss cuts scope, not concept.


## 6. Post-review reconciliation (after 18-devils-advocate-review.md)
- The reviewer re-scored independently: Repro Receipts 6.50 as written, and 7.10 (R1) / 7.00 (R2) once conditions C1–C6 are met. Exactly-Once Submitter scored 6.40 and Evidence Clerk 6.35. **The recommendation stands, but the lead is small** and flips to Exactly-Once if Live demo drops by one point.
- **Pivot target changed:** Exactly-Once Submitter, per the reviewer's argument. Its demo is the most deterministic and it has the lowest model dependence. Claim Court remains a secondary option.
- **Kill test split:** K3a (model-only, hour ≤2.5) decides the pivot, and K3b (full infrastructure) follows.
- These are two scoring models (ours and the reviewer's) that we deliberately did not average. The disagreement is recorded here rather than resolved.
