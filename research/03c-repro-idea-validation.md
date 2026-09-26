# 03c — "Repro-or-Reject" idea validation

Retrieved 2026-09-26. Evidence: `evidence-r.jsonl` (EV-R-0001…0025). Sources: `sources-r.jsonl`. Queries: `queries-r.jsonl`. Raw captures: `raw/repro-validation/`. All fetched content was treated as untrusted. No code from any issue was run.

## 1. Verdict on demand

**The pain is real and current, but the framing is off.** The pain is **triage volume**, which includes a growing share of plausible, detailed reports. It is not mainly "fake bugs that don't reproduce".

- **Real, last 30 days, firsthand:**
  - **Pallets:** labeled 88 items "rejected AI" between 2026-08-27 and 09-26 (13 issues, 75 PRs), against 46 in the previous 30 days (EV-R-0001).
  - **3DTilesRendererJS:** the maintainer says a "recent wave of overly-long AI-generated issues with no repros and false reports" makes the project "incredibly difficult" to manage (EV-R-0003).
  - **Little-CMS:** the owner ran an AI-generated ASan PoC by hand. It did not crash. He wrote "developers time is very valuable to spend it in war games" (EV-R-0004).
  - **Spring Boot:** a member closed an issue as "obviously AI generated… nonsense" (EV-R-0005).
  - **KDE:** contributors say slop merge requests are "burning people out" (EV-R-0009).
  - **Platform response in 2026:** GitHub shipped PR limits and restrict-issue-creation, and issue limits are in development (EV-R-0007, EV-R-0008).
- **Where the idea's framing misses:**
  - Several rejected reports describe behavior that **does** occur but is intended:
    - tomli #304 (BOM handling)
    - click #3841 ("current behavior makes sense too")
    - more-itertools #1263
    - semver #465 and #468

    A REPRODUCED verdict would have added no value here. The dispute was "is this a bug?", not "does this happen?" (EV-R-0006, EV-R-0001).
  - Pallets rejects on **origin**, whatever the validity (EV-R-0002). A receipt does not change that outcome.

### Strongest counterevidence
1. **Security slop was solved with policy, and the pain moved to volume.** curl says "The slop situation is not a problem anymore." Its confirmed-vulnerability rate is back to 15–16%, while volume is about 2x 2025. About 28 projects report the same shift (EV-R-0011). curl's best fix was a month-long intake pause (EV-R-0012). Torvalds' complaint is **duplicates of real bugs** and "that was already fixed" (EV-R-0010). HackerOne reports a steady 25% exploitable rate with submissions up 76% (EV-R-0013).
2. **In small libraries, self-contained reports are verified in minutes.** more-itertools #1284 and #1250, and parse #249, were each opened and fixed the same day (EV-R-0014). The tool adds least value exactly where the demo is easiest.
3. **Shifting the burden to the reporter works for honest reporters.** Examples: Vite's needs-reproduction label with a 3-day auto-close (EV-R-0018), and the 3DTiles reporter, whose own clean repro found the bug was in their app (EV-R-0003).

## 2. Competitors

| Solution (date) | Runs the report in isolation? | Independent re-execution evidence? | Notes |
|---|---|---|---|
| **withastro/triagebot-action + Cloudflare/Flue** (repo Jun 2026; blog 2026) EV-R-0015 | **No (corrected, rev. after 18 §A1).** Reproduce, diagnose, verify and fix run as agent sessions with `sandbox: local()`, i.e. `child_process.exec` directly on the GitHub Actions runner with unrestricted network. Its only isolation is the ephemeral runner VM. | Partly. A separate "verification model" (an LLM check) plus reporter confirmation. There is no fresh-sandbox re-run and no receipt. | **Closest competitor.** Runs inside GitHub Actions; the write token and model key are in the parent process on the same runner, **not** in the agent shell's env (allowlisted), per 18 §A1 at `51d30da`. Posts automatically. Its LLM verify step addresses bug-vs-intended. Open issues went from 200 to about 30. |
| Sentry `repro` skill (2026) EV-R-0016 | Yes, on a dev machine. It bails if the repro is too complex. | No. Output is a PR in a repro repo. | A human approves the backlink. Engineers fear bot noise. |
| HackerOne Hai / Agentic Signal Enrichment (docs 2026-08-25) EV-R-0017 | Yes, but only for web vuln classes (XSS, injection, credential exposure), with screenshots. | Screenshot proof. A human approves. | Drafts a reporter comment for human approval, which is the same pattern as ours. Does not cover OSS library bugs. |
| H1 Validation (2026-04-21) EV-R-0013 | Agentic plus human validation. | Service-level only. | Enterprise, paid. |
| Vite/Vue-style `needs reproduction` bots EV-R-0018 | No. | No. | Pushes the work to the reporter and auto-closes after 3 days. |
| GitHub PR/issue limits, collaborator-only issues EV-R-0007/0008 | No. | No. | Access gating instead of verification. |
| LogicStar (commercial) EV-R-0025 | Yes. Sandbox repro, then a validated PR. | Its own validation. | Targets private backlogs. Snippet-level evidence only. |
| SWE-agent / OpenHands / Otter / AssertFlip / TEX-T (research) EV-R-0019 | They generate repro tests. The harness executes them. | SWT-bench re-executes submissions independently. | Graded against a **known fix**. |
| Google BRT Agent (2025) EV-R-0020 | Internal. | No. | 28% plausible BRT rate on real internal bugs. |

**Classification:** mostly **stronger boundary + packaging**, not a new capability. Automated reproduction exists and is open source (Astro), so it is not a new capability. The defensible differences:
- No secrets in the execution sandbox. Astro keeps its tokens in the same runner.
- Egress-limited gVisor.
- A **second fresh-sandbox re-execution** with an environment hash and a signed receipt.
- A human approval bound to the exact comment text.
- A HOSTILE verdict for PoCs that try to escape or phone home. EV-R-0024 shows agents running repo-supplied git config commands outside their sandbox.

## 3. Demo inputs (all pure-Python, no services)

For every row: "before" = first parent of the fix, "after" = the fix commit. Install time is an **estimate, not measured**: roughly 5–20 s with `uv pip install -e .` plus pytest, needing egress to PyPI and GitHub only.

| # | Issue | Fix | Before → after | Why suitable |
|---|---|---|---|---|
| 1 | python-humanize/humanize#333 (4.15.1.dev) | PR #334, merge `b48b37b` | `b48b37b^` → `b48b37b` | Two-line snippet; `naturaldelta(inf)` raises OverflowError |
| 2 | more-itertools#1284 | PR #1285, `3ea9b00` | parent → merge | Deterministic `bucket` phantom key, assert-able |
| 3 | more-itertools#1250 | PR #1251, `d92f081` | parent → merge | `value_chain` swallows TypeError; one line |
| 4 | astanin/python-tabulate#365 | commit `87a9a4e` | `87a9a4e^` → `87a9a4e` | IndexError on empty table with `maxheadercolwidths` |
| 5 | tkem/cachetools#395 (6.2.6) | commit `c624ceb` | parent → commit | FIFOCache eviction order; full repro in issue |
| 6 | r1chardj0n3s/parse#249 | PR #250, `529dc2e` | parent → merge | `parse("{:F}","-2.5")` returns None |
| 7 | pypa/packaging#1315 (26.2) | PR #1316, `0a85b41` | parent → merge | Marker str drops parentheses; evaluation flips |
| 8 | pypa/packaging#1154 (26.0) | PR #1155, `06c6555` | parent → merge | Raw ValueError instead of InvalidVersion |
| 9 | python-semver#460 | commit `d8813b6` | parent → commit | `bump_prerelease('1.0.0-rc9')` sorts lower |
| 10 | marshmallow#2891 | PR #2892, `39e7c83` | parent → merge | `FILE://` scheme rejected |

**Negative and "not a bug" cases.** Honest finding: in small Python libraries, closed not-planned issues are mostly *"behavior reproduces but is intended"*, not *"doesn't reproduce"*.
- **Behavior observed, claim contradicted** (pure Python, fast):
  - semver#465: rejects leading zeros, per spec item 9.
  - semver#468: `1.0.0--alpha` is valid per the spec.
  - click#3841: `count` with a default. The maintainer called it intended.
- **True NOT_REPRODUCED:**
  - Little-CMS#608: the maintainer ran the PoC and got no crash. It is C, so it needs a compiler, not pip. Only open the attached zip inside the sandbox.
  - 3DTilesRendererJS#1758: 0 errors in 9 standalone loads, but it is browser/WebGL.
- **Synthetic NOT_REPRODUCED (recommended):** run any of rows 1–10 against the *fixed* commit or HEAD. The verdict is "not reproducible on HEAD, reproducible at the reported version", which means already fixed. This matches Torvalds' duplicate pain.

## 4. Feasibility risks

- **Missing steps.** Only 51.4% of ~3k reports explicitly give steps to reproduce, and 35.2% give expected behavior (Chaparro FSE'17, EV-R-0021). 38.3% of SWE-bench issues were judged underspecified (EV-R-0022). Expect many INCONCLUSIVE results.
- **Generation success rates. Do not transplant these numbers.** SWT-bench Verified reaches 62–87%, but it is graded against a known fix on 433 pre-filtered solvable issues from popular repos (EV-R-0019). Google's BRT Agent reaches 28% on real internal bugs (EV-R-0020). Without a fix, "the test fails on version X" can fail for the wrong reason. This is the main false-REPRODUCED risk. Mitigations: the verifier must check that the failure signature matches the claim, and the fail→pass run needs a fix.
- **REPRODUCED ≠ bug.** See §1. The verdict must say "claimed behavior observed" and must not claim the bug is valid.
- **Non-reproducibility causes are often environmental** (OS, timing, hardware). Rahman et al. found 11 factors (EV-R-0023), and a Linux gVisor box will miss them. INCONCLUSIVE has to be first-class.
- **Egress.** Needs PyPI (pypi.org, files.pythonhosted.org), github.com and codeload, and possibly build-backend downloads (hatchling, flit, setuptools-scm needs git tags, so use a full clone or set `SETUPTOOLS_SCM_PRETEND_VERSION`). C or Node targets widen the allowlist.
- **Hostile input.** PoC zips and repo configs can execute code (EV-R-0024). Run with no secrets and treat everything as untrusted.
- **Adoption.** Sentry engineers fear bot noise (EV-R-0016). The human-bound comment approval addresses this.

## 5. Recommendation: **ADJUST (go, with narrowed scope)**

Do not pitch it as "catching AI slop". That problem was largely solved by removing incentives, and some projects reject by origin anyway. Pitch it as **"verifiable reproduction receipts for maintainers who must run untrusted repros"**, with two sharpened verdict axes:
1. **"Does it reproduce at the reported version, and does it still reproduce on HEAD?"** This gives REPRODUCED / ALREADY_FIXED / NOT_REPRODUCED / INCONCLUSIVE / HOSTILE, and targets the duplicate and already-fixed pain.
2. **"Behavior observed" kept separate from "bug claim"**, with expected behavior quoted for the human to judge.

Optional wedge: **PoC-bearing reports**, like the Little-CMS case, where maintainers currently run attacker-supplied code on their own machines. Position it against Astro's triagebot on the boundary: no secrets in the sandbox, egress-limited, a fresh-sandbox re-run, and a signed receipt. Do not position it on the capability itself. Use the 10 Python cases above for the fail→pass demo, and HEAD runs for ALREADY_FIXED.


## Erratum (added after 18-devils-advocate-review.md)
- §2 row 1: triagebot-action does **not** run repro in an isolated sandbox. Its commands run on the GitHub Actions runner with unrestricted network; the write token and model key live in the parent process on that runner (18 §A1, SHA `51d30da`).
- EV-R-0001: the reviewer re-queried the Pallets count and got 88 (08-27..09-26) vs 45 (prior window). **13 issues + 75 PRs**, not 88 issues.
- Additional prior art: ClusterFuzz and syzbot re-run reproducers on latest/fix commits (18 §A5).
