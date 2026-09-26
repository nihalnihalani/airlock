# 03 — Recent signals (merged view of 03a, 03b, 03c)

Merged 2026-09-26 from `03a-signals-problems-a.md`, `03b-signals-problems-b.md`, `03c-repro-idea-validation.md`, `10-ideas-and-scorecards.md`, `00-executive-decision.md`, and the evidence ledgers `evidence-a/b/r/s/p.jsonl`. **No new web research was done for this file.** Every count below was computed with Python from the jsonl files; the script is not part of the repo (it lived in the session scratchpad). Where a number here differs from a number in 03a/03b, the reason is stated.

---

## 0. Window definitions and coverage limits

| Layer | Definition | Source of the label |
|---|---|---|
| **Last 30 days** | **2026-08-27 through 2026-09-26, both ends inclusive**. The research date is 2026-09-26 (Asia/Kolkata). | `window == "last30days"` in the jsonl files |
| **2026-YTD context** | 2026-01-01 through 2026-08-26 | `window == "2026-context"` |
| **Historical** | Before 2026 | `window in {"historical", "older"}` |
| **Static documents** | Papers and vendor docs in `evidence-p.jsonl`. These are not practitioner signals and are kept out of the pain counts. | `window == "n/a (static document)"` |
| **Undated** | No reliable date | `window == "unknown"` (all in evidence-b) |

**Boundary checks, computed.** No `last30days` line has a date outside 2026-08-27..09-26. Four lines are labelled `2026-context` but carry an in-window date:
- **EV-R-0002 (Pallets policy page):** the date is the retrieval date.
- **EV-R-0015 (Astro triagebot):** `event_at` is 2026-08-28, but the repo was published 2026-06-17.
- **EV-R-0018 (Vite workflow file):** the date is the retrieval date.
- **EV-R-0025 (LogicStar vendor page):** the date is the retrieval date.

These labels were left as they are, since each is a standing artifact and not an event inside the window. There are also two imprecise dates: EV-R-0009 has only the month (2026-09), and EV-A-0023 is approximate (2026-08).

**Coverage shortfalls (all three apply to every cluster below):**
- **X/Twitter was unavailable.** It was not queried, because cookie auth was not authorized (`--no-browser-cookies`). The only X-derived number (LoC Observatory counts, EV-A-0021) is secondhand and unverified.
- **Reddit gave titles and snippets only.** Thread fetches returned 403, Firecrawl reported "we do not support this site", and the last30days Reddit backend failed with HTTP 402 in the 03b run. Reddit contributes only 4 lines (EV-B-0037..0040), all `low` confidence and `unknown` window. None of them is used as firsthand evidence.
- **YouTube transcripts failed** (HTTP 402/429).
- **Also limited:** LinkedIn was snippet-only (EV-S-0001, EV-B-0035), and the Medium/Explyt article is paywalled after the TL;DR (EV-A-0009).

---

## 1. Ledger totals (computed)

**161 evidence lines** in total: A 44, B 46, R 25, S 2, P 44.

### 1a. Lines per file × window

| File | last30days | 2026-context | historical / older | undated | static doc (P) | Total |
|---|---|---|---|---|---|---|
| evidence-a.jsonl | 39 | 5 | 0 | 0 | 0 | 44 |
| evidence-b.jsonl | 9 | 27 | 2 | 8 | 0 | 46 |
| evidence-r.jsonl | 8 | 14 | 3 | 0 | 0 | 25 |
| evidence-s.jsonl | 0 | 2 | 0 | 0 | 0 | 2 |
| evidence-p.jsonl | 0 | 0 | 0 | 0 | 44 | 44 |
| **All** | **56** | **48** | **5** | **8** | **44** | **161** |

### 1b. Lines per file × firsthand_status (raw values)

| File | firsthand | secondhand | vendor_claim | unknown | P: document-read¹ | P: abstract-only | P: secondhand |
|---|---|---|---|---|---|---|---|
| evidence-a | 38 | 2 | 4 | 0 | – | – | – |
| evidence-b | 30 | 2 | 9 | 5 | – | – | – |
| evidence-r | 20 | 5 | 0 | 0 | – | – | – |
| evidence-s | 2 | 0 | 0 | 0 | – | – | – |
| evidence-p | – | – | – | – | 36 | 7 | 1 |
| **All** | **90** | **9 (+1 P)** | **13** | **5** | **36** | **7** | **1** |

¹ The "document-read" column merges all `firsthand-read…` variants in evidence-p: full text, search highlight, dev-index passage and full scrape. For P, "firsthand" means *we read the document*, not *a practitioner experienced the pain*.

### 1c. Lines per file × confidence

| File | high | medium | low |
|---|---|---|---|
| evidence-a | 14 | 23 | 7 |
| evidence-b | 20 | 20 | 6 |
| evidence-r | 18 | 6 | 1 |
| evidence-s | 1 | 1 | 0 |
| evidence-p | 30 | 14 | 0 |
| **All** | **83** | **64** | **14** |

### 1d. Independence groups (A/B/R/S only)

Groups are the `independence_group` field, normalized by cutting off any parenthetical note.

| File | Distinct groups | Firsthand groups |
|---|---|---|
| evidence-a | 44 | 38 |
| evidence-b | 37 | 22 |
| evidence-r | 21 | 18 |
| evidence-s | 1 | 1 |
| **A/B/R/S combined** | **103** | — |

- 03b reported 38 groups for evidence-b. The difference is one group: EV-B-0001's label `openai-forum-agentmode (same author kadda …)` normalizes into the same `openai-forum-agentmode` group as EV-B-0002..0005, which is the grouping 03b's own text intends.
- **Group labels are file-local.** A reused label is always one group, for example `botcrawl-manus` for both EV-B-0023 and EV-B-0046. But the same repository under different labels is also possible, for example `daytona-gh` covering both EV-B-0017 and EV-B-0018. So these counts are **conservative within a file and possibly slightly generous across files**.

---

## 2. Clusters (merged)

Every A/B/R/S line is assigned to at least one cluster; a check found none left unassigned. Four lines sit in two clusters on purpose:
- **EV-A-0015:** K2, and cross-linked in K7.
- **EV-A-0030:** K1, and thematically K4.
- **EV-B-0023:** K1 and K2.
- **EV-B-0046:** K8. Same group as EV-B-0023.

Key to the counts below:
- **Lines:** evidence lines.
- **Groups:** independence groups.
- **FH groups:** groups with at least one firsthand line.
- **L30 groups:** groups with a line in the last-30-day window.

EV-P lines are listed as a separate *research layer* and are **not** counted as groups.

### Summary (computed)

| Cluster | Dossier | Lines | Groups | FH groups | L30 lines | L30 groups | L30 FH groups | Firsthand / secondhand / vendor / unknown (lines) |
|---|---|---|---|---|---|---|---|---|
| K1 "Done" is a claim; self-reported success is wrong | D2 | 16 | 16 | 14 | 10 | 10 | 8 | 14 / 0 / 2 / 0 |
| K2 Destructive out-of-scope side effects | D5 | 10 | 10 | 10 | 9 | 9 | 9 | 10 / 0 / 0 / 0 |
| K3 Approval gates forgeable or fatiguing | (control-plane feature) | 5 | 5 | 3 | 4 | 4 | 2 | 3 / 1 / 1 / 0 |
| K4 Authenticated / UI-only browser work | (F2 input) | 17 | 12 | 10 | 10 | 10 | 8 | 15 / 1 / 1 / 0 |
| K5 Crash/resume/duplicate side effects | D4 | 9 | 8 | 7 | 4 | 4 | 4 | 8 / 0 / 1 / 0 |
| K6 Audit evidence = screenshots without provenance | D3 | 8 | 8 | 4 | 2 | 2 | 0 | 4 / 0 / 1 / 3 |
| K7 Untrusted bug-report triage / reproduction | **D1** | 30 | 25 | 22 | 10 | 10 | 9 | 25 / 5 / 0 / 0 |
| K8 Runtime lifecycle, self-hosting, spend, access | — | 12 | 12 | 9 | 6 | 6 | 5 | 9 / 1 / 2 / 0 |
| K9 Scripts vs agents; no-API portals | — | 12 | 12 | 4 | 2 | 2 | 1 | 4 / 1 / 5 / 2 |

---

### K1 — "Done" is a claim, not evidence (→ D2)

**Evidence by window**
- **Last 30 days (10):** EV-A-0001, A-0004, A-0005, A-0006, A-0007, A-0008, A-0009 (vendor), A-0010 (vendor), A-0030, B-0018.
- **2026-YTD (6):** EV-A-0002, A-0003, B-0011, B-0012, B-0020, B-0023.
- **Historical:** none.
- **Research layer (P):**
  - EV-P-0012 and P-0013: "solved" SWE-bench patches that are wrong.
  - EV-P-0014: an LLM judge endorsed tests that Docker showed fail, 65/105 (61.9%).
  - EV-P-0016..0019: BenchJack, where agent and evaluator share an environment.
  - EV-P-0044: a harness re-runs tests when the transcript can't prove the claim.

**Counts:** 16 groups, of which 14 are firsthand. 10 groups are in the last 30 days, 8 of them firsthand.

**Already fixed or solved:**
- CI independently re-runs test suites (03a C1).
- EV-B-0020 (E2B silent deletion) was closed as completed.
- A crowded startup field sells claim verification: Canary, MaruCheck, Weftgate, Opslane, dos-kernel and Explyt (03a).

**Counterevidence:** EV-B-0008. Externally validated browser-use runs scored 45/45 on a small benchmark, so reliability can be high when success is checked by a validator.

**Sampling bias:**
- 9 of the 16 lines are anthropics/claude-code or openai/codex issues filed by self-selected, harmed power users.
- Several of those issues read as partly agent-written.
- Two lines are vendor posts (Explyt, Darktrace) from sellers of the fix.

### K2 — Destructive out-of-scope side effects (→ D5)

**Evidence by window**
- **Last 30 days (9):** EV-A-0011 through A-0019.
- **2026-YTD (1):** EV-B-0023.
- **Research layer:**
  - EV-P-0026: transactional rollback, which cannot un-send external API calls.
  - EV-P-0036: Netlify per-run DB branches.

**Counts:** 10 groups, all firsthand. 9 are in the last 30 days. This is the most recent-heavy cluster.

**Already solved:**
- Plain VM or container isolation for coding agents is commoditized (EV-A-0042: Coop, docker sbx, microsandbox, Enclave, cco, drydock, bubblewrap).
- PreToolUse deny-list hooks are the community's standard workaround.
- Per-run DB branches exist (EV-P-0036).

**Counterevidence:** most incidents ran in full-access or bypass mode (03a), so "use the sandbox you already have" is a fair objection. EV-A-0018 and A-0019 are low severity.

**Sampling bias:**
- Almost every line is a GitHub issue on two agent vendors' trackers. People file there after harm, so severity is skewed upward.
- No base rate exists: we don't know how many runs happen without incident.

### K3 — Approval gates forgeable, fatiguing, or keeping agents read-only

**Evidence by window**
- **Last 30 days (4):** EV-A-0020, A-0021 (secondhand, X-derived), A-0022, A-0024 (vendor survey).
- **2026-YTD (1):** EV-A-0023.
- **Research layer:**
  - EV-P-0021..0023: approval integrity.
  - EV-P-0034 and P-0035: hash-bound, single-use approvals.

**Counts:** 5 groups, 3 of them firsthand. 4 groups are in the last 30 days, 2 of them firsthand.

**Already solved (partly):** hash-bound approval tokens exist in OSS and research (EV-P-0034, P-0035, P-0021).

**Counterevidence:** an HN thread (03a) says human review of reviewable changes is tolerable.

**Sampling bias:** the "60 issues since March 2026" figure comes from a single commenter's own collection (EV-A-0020). EV-A-0021's counts come from X, which we could not verify.

### K4 — Authenticated / UI-only browser work

**Evidence by window**
- **Last 30 days (10):** EV-A-0025, A-0026, A-0027, A-0028 (secondhand audit), A-0029 (vendor proposal), A-0031, A-0032, B-0013, B-0015, B-0030.
- **2026-YTD (7):** EV-B-0001..0005 (one group), B-0014, B-0029.

**Counts:** 12 groups, 10 of them firsthand. 10 groups are in the last 30 days, 8 of them firsthand. The OpenAI-forum group alone contributes 5 lines, which is why there are 17 lines but only 12 groups.

**Already solved:**
- Browserbase-class session persistence and 2FA handoff (EV-A-0031).
- Hermes desktop takeover/hand-back, merged 2026-09-23 (EV-B-0015).
- Session replay (EV-P-0041).

**Counterevidence:**
- EV-B-0004: driving the user's local Chrome gives access, at the cost of isolation.
- EV-A-0043, A-0044, B-0045.

**Sampling bias:** mostly developer-tool GitHub issues and paying-user forums. We found no firsthand stories of breakage from changed UIs (03a).

### K5 — Crash/resume/duplicate side effects (→ D4)

**Evidence by window**
- **Last 30 days (4):** EV-A-0033, A-0034, A-0035, A-0040.
- **2026-YTD (5):** EV-A-0036, B-0019, B-0021, B-0022 (vendor doc), B-0028.

**Counts:** 8 groups, 7 of them firsthand. 4 groups are in the last 30 days, all firsthand.

**Already fixed or solved:**
- EV-A-0034 (Inngest): fixed in 4.21.0 within a day.
- Durable-execution vendors (Temporal, Inngest, Restate) cover dedupe.
- Hermes lease model (EV-B-0015).

**Counterevidence:** **no firsthand production duplicate-side-effect incident was found** (03a C5). The lines are framework bugs, harness questions and one blog proposal.

**Sampling bias:** all lines are framework or SDK trackers, so this is builder pain, not end-user pain.

### K6 — Audit evidence is screenshots without provenance (→ D3)

**Evidence by window**
- **Last 30 days (2):**
  - EV-B-0035: LinkedIn post, firsthand status `unknown`.
  - EV-B-0036: vendor counterevidence.
- **2026-YTD (4):** EV-B-0031, B-0032, B-0033, B-0034 (all HN comments).
- **Undated (2):** EV-B-0037, B-0038 (Reddit snippets, low confidence).
- **Research layer:** EV-P-0025 (NovaFabric signed run capsule; abstract only).

**Counts:** 8 groups, 4 of them firsthand. 2 groups are in the last 30 days, and **0 of those are firsthand**. This is the weakest-recency dossier.

**Already solved:** Vanta, Drata and Scrut automate evidence for API-reachable controls (EV-B-0036, vendor claim).

**Sampling bias:**
- Every firsthand line is an HN comment by an engineer, not an auditor-side workflow observation. The exception is EV-B-0032, which comes from an auditor who is promoting their own open method.
- Reddit supplies snippets only.

### K7 — Untrusted bug-report triage / reproduction (→ D1)

**Evidence by window**
- **Last 30 days (10):** EV-A-0039, A-0015 (cross-link), R-0001, R-0003, R-0004, R-0005, R-0006, R-0009, R-0014, R-0024 (secondhand).
- **2026-YTD (17):** EV-A-0038, R-0002, R-0007, R-0008, R-0010, R-0011, R-0012, R-0013, R-0015, R-0016, R-0017, R-0018, R-0019, R-0020 (paper, dated 2025-02 but labelled 2026-context in the ledger), R-0025, S-0001, S-0002.
- **Historical (3):** EV-R-0021 (2017), R-0022 (2024), R-0023 (2021).

**Counts:** 25 groups, 22 of them firsthand. 10 groups are in the last 30 days, 9 of them firsthand.

The 30 lines are not all pain. Splitting them by role (computed on the D1 subsets in 04):

| Role | Lines | Groups |
|---|---|---|
| Pain | 11 | 10 |
| Counterevidence | 9 | 7 |
| Existing tools | 7 | 6 |
| Feasibility literature | 5 | 5 |

**Already fixed or solved:**
- **Bounty-driven security slop was solved by policy:** curl ended its bounty (EV-S-0001, S-0002, R-0011) and paused intake (EV-R-0012).
- **Automated reproduction exists and is open source:** withastro/triagebot-action (EV-R-0015), the Sentry repro skill (EV-R-0016), HackerOne Hai (EV-R-0017) and LogicStar (EV-R-0025).
- **GitHub shipped platform gating:** PR limits and restrict-issue-creation (EV-R-0007, R-0008).
- **Burden-shift bots:** Vite's needs-reproduction bot (EV-R-0018).

**Counterevidence:**
- Many disputes are about intended behaviour (EV-R-0006, R-0001).
- Pallets rejects on origin (EV-R-0002).
- Small libraries fix clear reports the same day (EV-R-0014).

**Sampling bias:**
- The last-30-day lines were **found by a targeted validation pass (03c) searching for this exact pain**, so this cluster was over-sampled compared with the others.
- The Pallets count uses a label, which measures maintainer policy, not report validity.

### K8 — Runtime lifecycle, self-hosting, spend, temporary access (supporting only)

**Evidence by window**
- **Last 30 days (6):** EV-A-0037, A-0041, A-0042, A-0044, B-0016, B-0044 (vendor).
- **2026-YTD (5):** EV-B-0017, B-0024, B-0026, B-0027, B-0046 (secondhand).
- **Undated (1):** EV-B-0025 (vendor).

**Counts:** 12 groups, 9 of them firsthand. 6 groups are in the last 30 days, 5 of them firsthand.

**Already solved:** hosted sandboxes (EV-B-0044), OpenHands Enterprise (EV-B-0025), and the `--init` fix (EV-A-0044).

**Note:** the temporary-access sub-theme (EV-B-0016, B-0017) has only two sources. It is a supporting feature for T-10, not a pain to build around.

### K9 — Scripts vs agents; no-API portals (not shortlisted)

**Evidence by window**
- **Last 30 days (2):** EV-A-0043, B-0009 (vendor).
- **2026-YTD (3):** EV-B-0008, B-0010, B-0045.
- **Historical (2):** EV-B-0006, B-0007.
- **Undated (5):** EV-B-0039..0043.

**Counts:** 12 groups, 4 of them firsthand. 2 groups are in the last 30 days, 1 of them firsthand.

**Why it was not shortlisted:** it is vendor-saturated (EV-B-0043: at least six vendors) and owned by Browserbase and BrowserBook.

---

## 3. Cross-cluster reading

1. **Recency ranking (last-30-day firsthand groups):** K2 (9), K7 (9), K1 (8), K4 (8), K8 (5), K5 (4), K3 (2), K9 (1), K6 (0).
2. **Breadth ranking (all firsthand groups):** K7 (22), K1 (14), K2 (10), K4 (10), K8 (9), K5 (7), K6 (4), K9 (4), K3 (3).
3. **K7's lead is partly an artifact of effort.** It was the only cluster given a dedicated validation pass (03c, 25 extra lines). Its largest block of lines is also *counterevidence and competitors*, not pain.
4. **Where the ledgers agree across researchers** is the "independent execution record" theme:
   - K1: a denominator of expected vs executed.
   - K7: a re-runnable repro.
   - K6: provenance fields.
   - K5: a side-effect ledger.

   That common thread is why F1 and F3 share one engine (10 §4).
5. **Nothing here is quantitative about frequency per user or team.** The numbers that do exist are per incident (e.g. 124 files, ~1.5 days of data lost) or per project (Pallets 88/30d). No cluster has a population base rate.
