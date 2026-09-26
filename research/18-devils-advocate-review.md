# 18 — Devil's-advocate review of "Repro Receipts"

Reviewer role: independent disconfirmation. Written 2026-09-26. Files reviewed: 00, 01, 03a/03b/03c, 05, 06, 07, 08, 09, 10, 12, 13, 14 and 17, plus spot-checks of `evidence-*.jsonl`. Files 11, 15, 16 and 19 did not exist when this review finished.

**Verification budget used:**
- Firecrawl: about 9 credits (2 searches and 1 live scrape).
- `gh api`: read-only.
- `withastro/triagebot-action`: cloned into the scratchpad at `51d30da` (2026-08-28, current `main`).
- OpenBot and OpenMuse: read from `reference-repos/`.

## Verdict up front

**Endorse with conditions.** The concept still narrowly beats its runners-up on my independent scores:

| Concept | R1 | R2 |
|---|---|---|
| Repro Receipts | 6.50 | 6.50 |
| Exactly-Once Submitter | 6.40 | 6.25 |
| Evidence Clerk | 6.35 | 6.25 |

That lead is inside the noise. The plan as written has four problems:
- It over-claims novelty.
- Its executive summary and its architecture describe different verification protocols.
- Its fault-locality and "independent re-execution" guarantees are weaker than the pitch suggests against a *hostile* repro.
- Its schedule has no realistic margin.

Fix conditions C1 to C6 below, or the lead disappears.

---

## A. Verification results

### (1) triagebot-action: "write tokens + model keys in the same runner; no fresh-sandbox re-execution or receipts"

**Mostly TRUE, but the wording in 03c/00 is imprecise, and one 03c cell is wrong.** Pinned SHA: `51d30da13c0bd571a3822fc56882de40fead0086`.

**Confirmed:**
- **Both tokens and a model key are inputs to the same job.** `action.yml` declares `read-token`, `write-token` ("posting comments, pushing branches, creating PRs"), and `anthropic-api-key`/`openai-api-key`/`cloudflare-api-key`. The node process copies the model key into `process.env` (`src/index.ts:91-102`).
- **The repro "sandbox" is not a sandbox.** Every agent session uses `sandbox: local({...})` (`src/handlers/triage.ts:395-409`, `retriage.ts:30`, `verify-fix.ts:47`).
  - `local()` → `createLocalSessionEnv` → `promisify(child_process.exec)` (`dist/index.mjs:233440, 233553`).
  - So repro commands run directly on the Actions runner as the same OS user as the action process, with no network restriction.
  - The default Bash env even sets `network: { dangerouslyAllowFullInternetAccess: true }` (`src/flue.ts:17-21`).
- **No fresh re-execution.** "verify" is an LLM skill that decides *bug vs intended behaviour* inside the same session (`triage.ts` `runTriagePipeline`, `.agents/skills/triage/verify.md`). "verify-fix" is an LLM classification of the reporter's comment (`verify-fix.ts:56-120`).
  - There is no second clean-environment run and no receipt or signature.
- **Posts without human approval.** `postComment(..., ctx.writeToken)` runs after triage (`triage.ts`, around line 510). It also force-pushes fix branches (`gitPush ... force:true`) and opens PRs automatically when `auto-pr-on-fix` is set.

**Correction required:**
- The agent shell's **environment is allowlisted.**
  - `resolveBaseEnv` passes only `PATH, HOME, USER…` plus the explicit `env` (`dist/index.mjs:233441-233465`).
  - The explicit env holds `GH_TOKEN` = the **read** token plus `GITHUB_*` metadata. It does **not** hold the write token or the model key.
- So "write token and model keys in env" is **false**. "In the same runner, reachable" is **true**:
  - The parent node process carries `INPUT_WRITE-TOKEN` and `INPUT_ANTHROPIC-API-KEY` in its environment (`src/input.ts:2-3`).
  - That environment is readable via `/proc/<ppid>/environ` by the same user. GitHub-hosted runners also give passwordless sudo.
- 03c §2 says triagebot "Runs the report in isolation? **Yes**". That is **wrong**: it runs the report on the runner host. Its isolation is the ephemeral runner VM, not a sandbox.

**Stage-safe claim:** "triagebot runs repro code directly on the Actions runner that also holds its write token and model key, then lets an LLM judge the result and posts automatically. We run it on a separate secret-free VM, re-run the frozen script in fresh sandboxes, and a human approves every post." Do **not** say "keys in the sandbox env".

**Counterpoint the team must absorb:** triagebot's LLM "verify" step already addresses **bug vs intended behaviour**. 03c found that this, not "does it happen?", is the dominant dispute (EV-R-0006: tomli #304, click #3841, semver #465/#468). Our product deliberately does *not* answer it. On the more valuable question, the incumbent covers more ground.

### (2) Pallets "rejected AI" 88 vs 46 (EV-R-0001)

Re-queried now with `gh api search/issues`:

| Window | All items | Issues only |
|---|---|---|
| created 2026-08-27..09-26 | **88** | **13** |
| created 2026-07-28..08-26 | **45** (EV-R-0001 recorded 46; a label change or a boundary day) | **4** |
| All time | 425 | — |
| All new Pallets issues, 08-27..09-26 | — | 51 |

- **Method:** the search counts by item *creation* date, whenever the label was applied. Older items have had longer to collect labels, so the month-over-month growth is, if anything, understated. The method is reasonable.
- **Not one spammer.** The 88 items come from about 60 distinct authors, and the top author has 4.
- **Material problem:** **75 of the 88 (85%) are PRs.** The product ingests *issues*, and the relevant number is **13 issues/month across the whole org**.
- Pallets also rejects by *origin*, not validity (EV-R-0002). A receipt cannot change that outcome.
- **Using "88" as the headline demand number for an issue-repro tool is misleading.** Cite "13 issues (+75 PRs)" or drop Pallets from the pitch.

### (3) Random last-30-days spot checks: dates and quotes

| ID | Checked via | Date | Quote | Note |
|---|---|---|---|---|
| EV-R-0003 3DTilesRendererJS#1758 | gh api | ✅ opened 2026-09-25, maintainer comment 10:46Z | ✅ verbatim | JS/WebGL. The reporter self-resolved: it was an app bug, not a library bug |
| EV-R-0004 Little-CMS#608 | gh api | ✅ 2026-09-16 | ✅ verbatim | C + ASan PoC. Closed `completed`, not `not_planned`. The maintainer ran the PoC himself (Windows addresses in the output) |
| EV-R-0005 spring-boot#51836 | gh api | ✅ 2026-09-18 | ✅ verbatim | Java. Closed as duplicate |
| EV-A-0039 allstarlink.org/ai | firecrawl live scrape | ✅ "Effective Date: 2026-09-24" | ✅ verbatim | Policy puts the burden on the reporter |

- **Dates and quotes are accurate, and the sources are independent** (Pallets, NASA-AMMOS, mm2, Spring, KDE, AllStarLink, GitHub).
- **But none of the recent firsthand pain items is a Python/pytest case, and the MVP is Python/pytest only.** The evidence proves pain in a *different* population from the one the demo serves.

### (4) OpenBot and OpenMuse hard-require CopilotKit Intelligence at startup

**CONFIRMED for both.**

**OpenBot `3c73cf0`:**
- `server/src/config.ts:879-906` `runtimeCapabilities()` throws "CopilotKit Intelligence is required and is not configured" if `INTELLIGENCE_API_URL`, `INTELLIGENCE_GATEWAY_WS_URL` or `INTELLIGENCE_API_KEY` is missing.
- It is called unconditionally at `config.ts:1274`.
- `.env.example:110-128` says "There is no degraded mode" and that self-hosting is Enterprise-only.

**OpenMuse `205cc38`:**
- `apps/server/src/config.ts:108` has `required("CPK_INTELLIGENCE_API_KEY", …)`.
- `apps/server/src/app.ts:44` constructs `new CopilotKitIntelligence(...)` unconditionally.

Note: the *key* is free to obtain. "Hard-require" is correct; "cannot remove in 24 h" is the audits' estimate. The decision to reuse patterns only is sound.

### (5) Does a known product already do two-ref, fresh-sandbox re-execution with receipts?

**Yes, in fuzzing infrastructure.** 06 misses this, and it deflates the "still open" novelty claim.
- **ClusterFuzz / OSS-Fuzz:** "Once a day, ClusterFuzz re-runs testcases against the latest build until it detects them as fixed", then auto-verifies and closes the bug. It also bisects the regression and fixed ranges (google.github.io/clusterfuzz …/fixing-a-bug).
- **syzbot:** reproduces kernel bugs with a stored reproducer. `#syz test` re-runs the reproducer on a given tree or patch, "or to check if the bug is already fixed". It also does cause/fix bisection (syzkaller `docs/syzbot.md`).
- **SWT-bench harnesses** do fail-before/pass-after in fresh containers (EV-R-0019).

None of these takes a **natural-language, untrusted issue**, has an LLM **author** the reproducer, treats the input as hostile, or gates the outward post on a hash-bound approval. The defensible novelty is **"ClusterFuzz/syzbot-style verification for human-written (possibly AI-generated) issue reports, with the report treated as hostile code"**. Two-ref re-execution itself is not new, and the pitch must not imply it is.

---

## B. Findings table

Severity: **blocker** = must fix before build or pitch · **major** = materially affects score or safety claim · **minor** = cleanup.

*Status column updated by the synthesizer after the research director accepted all findings (rev. after 18). Finding text is unchanged.*

| ID | Sev | Claim challenged | Evidence | Recommended resolution | Status |
|---|---|---|---|---|---|
| DA-01 | **major** | 00 §1 promises check (b) "latest `main`: does it still occur, or was it already fixed?". 03c defines an ALREADY_FIXED verdict | 12 §5 Phase 5 runs sandbox C at the **fix commit only**. The 12 §5.1 verdict table has no ALREADY_FIXED and no HEAD run (grep for `ALREADY_FIXED\|HEAD\|latest` in 12 returns nothing) | Choose one. Recommended: C = fix ref when known, **plus** D = HEAD always. Add ALREADY_FIXED (B fails with the signature, D passes) to 12 §5.1 and the receipt schema. This is also the only fix-control available for **new** issues | resolved in 12 §5, §5.1, §8 (D = HEAD always; ALREADY_FIXED); tests 15 T-34 / 12 T-VER-07 |
| DA-02 | **major** | "Demo inputs are public: 10 curated issues with linked fixes" shows the product works | Every curated case is a *closed* issue with a *known* fix (03c §3). The real use case is a *new* issue with no fix, where REPRODUCED is at best `medium` confidence and relies on the spoofable fault-locality check (DA-04) | In the live demo, run at least one case in "no fix known" mode and show `medium` honestly. Or use HEAD-as-control per DA-01 and say so explicitly | resolved in 12 §5.1 (no-fix-known caps REPRODUCED at medium); 15 §6 E21; 16 §1 honesty beat |
| DA-03 | **major** | "The verdict is independently re-executed, so it's trustworthy" / "model never judges success" | Re-execution defends against the *agent* lying about results (the BenchJack class). It does not defend against a **deterministically lying script**. The frozen script comes from an LLM steered by attacker text, and it can: (a) sniff `pkg.__version__` and fail only at the reported ref, then pass at the fix/HEAD ref; (b) raise the "right" exception. Fail→pass across refs proves the *script* distinguishes the refs, not that the claimed bug exists. 12 residual #4/#5 admits part of this | Add a **static gate on the frozen script** (AST): reject or downgrade to INCONCLUSIVE on `exec/eval/compile`, `sys.settrace/setprofile`, `importlib.metadata`/`__version__` reads, `os._exit`, writes under the junit or `/opt/ror` paths, monkeypatching of the target package, and subprocess calls. Show the frozen script on the receipt page. Pitch wording: "receipt proves *this script* behaves differently at these refs", never "proves the bug is real" | resolved in 12 §5.2 (AST static gate) and §8 (wording); 15 T-30; 16 §3 Q18 |
| DA-04 | **major** | Fault-locality check "stops the trivial fake repro" (12 §5 item 4) | "Deepest frame under package path" is (a) **spoofable**: `exec(compile(src, pkg.__file__, "exec"))` gives a frame whose `co_filename` is in the package; and (b) **brittle**: many genuine bugs raise in stdlib or a C extension called *from* the package (`int(inf)`, `re`, `json`, `datetime`), so the deepest frame is outside the package → false INCONCLUSIVE | (a) Require that the flagged frame's `(filename, lineno)` maps to a real line in the pristine checkout, with a matching function name via AST. (b) Change the rule to "some frame on the raising stack is in the package, reached by a call from the test file". Add fixtures T-VER-05 (spoof) and T-VER-06 (stdlib-raise) | resolved in 12 §5 item 4 and §5.4 (pristine + AST match; some-frame rule); 15 T-31/T-32 (T-VER-05/06) |
| DA-05 | **major** | Novelty: "Independent re-execution in a fresh sandbox… exists only in niche OSS and papers" (06 TL;DR). Creativity scored 6 (10 §3) | ClusterFuzz and syzbot (§A5) do repro, re-run on latest/fix and auto-verify, at production scale. triagebot covers repro + bug-vs-intended (§A1) | Update 06 and 17 with this prior art. Reposition as "syzbot-style verification for untrusted human/AI issue text". Creativity 5, not 6 | resolved in 06 §4, 17 §2.1, 16 §3 Q17; Creativity 5 in 10 §6 / 00 §4 |
| DA-06 | **major** | Demand evidence supports a Python/pytest MVP | All recent firsthand pain (EV-R-0003 JS/WebGL, EV-R-0004 C/ASan, EV-R-0005 Java) is outside scope. Pallets is 85% PRs (§A2). Curl, AllStarLink and Vite show **policy/burden-shift** fixing it (EV-S-0001, EV-A-0039, EV-R-0018). Small Python libs fix clear reports the same day (EV-R-0014) | Re-scope the pitch to the **PoC-bearing report** wedge (Little-CMS pattern: the maintainer runs attacker code on his own machine). Keep Python as the demo language but say "language-agnostic runner; Python in MVP". Cite Pallets as "13 issues + 75 PRs" | resolved in 11 §1–§2 and 16 §1 (PoC-bearing wedge; "13 issues + 75 PRs"); Python-vs-JS/C/Java evidence gap accepted as residual risk (00 §3) |
| DA-07 | **major** | Containment beat = "curated hostile repo's `setup.py`" (12 §11, T-INJ-02) | The persona is the maintainer; the *repo* is theirs, and the *issue/PoC* is the hostile input. A hostile `setup.py` in the maintainer's own repo is an incoherent story, and judges may ask "why is your customer's repo malicious?" | Make the demo's hostile input an **issue whose PoC** does `rm -rf ~`, a fork bomb, `curl 169.254.169.254` and a honeytoken read. It then executes in sandbox A/B (post-seal for B). Keep the hostile-`setup.py` test as a supply-chain test only | resolved in 12 §11 and §5 Phase 1 (PoC-first); 15 C-14/T-02; 16 §1–§2 |
| DA-08 | **major** | Install-phase containment (install before seal) is handled | 12 installs **pre-seal** in B and C. So repo build hooks and PyPI code run with egress to pypi/github.com in the *verification* sandbox, and can plant a `.pth`/`sitecustomize` that tampers with the later sealed run (12 residual #2/#4). It is acknowledged but not mitigated. It also makes B's result depend on PyPI state at run time (the resolution may differ from A's) | In A, record `pip freeze` with hashes. B and C install with `--require-hashes --no-deps` from that lock, **or** from a pre-warmed wheelhouse (curated demo repos) with `egress none` from creation. Then B and C never have network, the seal becomes moot, and reproducibility improves. Put the lock hash in the receipt | resolved in 12 §5.3 (prep sandbox P, hashed lock, no-egress B/C/D); 15 C-06c/T-35; A/P build-hook egress accepted as residual risk (12 §10.3 #2) |
| DA-09 | **major** | Receipt `rerun_command` lets "judges re-run the command" (10 §3, Live demo 8) | 12:408: `docker run --rm --network none … sh -c 'git clone … && pip install -e . && pytest'`. **This cannot work**: there is no network for clone or install. `ror-py-3.12@sha256:…` is a locally built image that third parties can't pull | Two-step command: `git clone … && pip download -r lock` on the host, then `docker run --network none -v …`. Push the image to Vultr Container Registry (public) or publish its Dockerfile plus digest. Test the command from a clean laptop before the demo | resolved in 12 §8 (two-step command, Dockerfile + digest); 15 C-19/T-29 |
| DA-10 | **major** | Schedule: K3 (≥3/6 REPRODUCED) "by about hour 4", with a pivot otherwise | K3 needs K1, K2, the supervisor, the proxy, the agent loop and installs for 6 repos all working. 09's own component rows sum to **33–54 h** (14 rows), while 09's headline says "16–26 h core". At hour 4 the pivot would be at best a late guess | Decouple immediately. **K3a (hour 0-2):** model-only spike: the Vultr model writes repro scripts for 6 issues, run in plain `docker run --network none` on any VM, with no supervisor or proxy. **K3b** is the infra path. Decide the pivot on K3a by hour 2-3 | resolved in 15 §1 and B-00 (K3a hours 0–2.5 decides pivot; K3b infra); 00 §9; 11 ADR-02 |
| DA-11 | **major** | "Acceptable path when model / sandbox / GitHub fails" | ERROR and `outcome_unknown` exist (12 §5.1, §6.2), but there is **no live-demo degradation mode**. One full run is A (≤900 s TTL, ≤5 attempts) + B (install + 2 runs) + B′ + C, which is several minutes and won't fit a 3-min live slot even when everything works | Build a **"verify-only" mode** that replays a stored frozen tuple (script + lock + refs) through fresh sandboxes live, with no model and no GitHub. Add an issue-snapshot fallback (pasted text). Pre-run the full pipeline and show the stored receipt. Record the video early (by Sun 09:00) | resolved in 12 §5.5 (verify-only replay + issue snapshot); 15 C-18/T-28; 16 §1 fallback ladder; video Sun 08:00–09:00 (15 §1) |
| DA-12 | **major** | Stage-level claim about triagebot (00 §3; 10 §3 "Astro keeps its tokens in the same runner") | §A1: correct at the runner level, false at the env level. 03c says "runs in isolation: Yes", which is wrong the other way | Use the stage-safe sentence in §A1. Fix 03c §2 row 1 | resolved in 00 §3, 03c §2, 06 §4, 11 §1, 16 §3 Q1, 17 §2.1 |
| DA-13 | minor | HOSTILE is a safe label | `credential_endpoint` fires on CONNECT to `api.github.com` or `*.amazonaws.com`. A legitimate repro for a GitHub/AWS client library (PyGithub, boto-based) or model-written code touching the API → **false HOSTILE**. That label may go into a public comment about a real reporter | Rename the public-facing label to "CONTAINED: policy violation". Never put HOSTILE in the comment template without an explicit human edit. Allow per-run opt-in hosts for API-client repos | resolved in 12 §4 and §7 (public label; per-run opt-in hosts); 11 §7.8 |
| DA-14 | minor | "Network-dependent repro is out of scope" (12 §4) | Bugs in HTTP clients (requests, httpx, urllib3: very popular targets) are excluded, and it's unclear whether **loopback** works post-seal (local `http.server`/`pytest-httpserver` fixtures) | State that loopback stays allowed inside the netns post-seal. Add test T-NET-09 (`127.0.0.1` server reachable after seal) | resolved in 12 §3.1 and §4 (loopback allowed); 15 T-33 (T-NET-09) |
| DA-15 | minor | Codeload tarball install works | Tarballs lack `.git`, so hatch-vcs/setuptools-scm builds fail (03c §4 notes it; 12 doesn't implement it). humanize (hatch-vcs) and tabulate (setuptools_scm) are among the curated 10 | Set `SETUPTOOLS_SCM_PRETEND_VERSION` from the resolved tag in `install_cmd`. Pre-check all 10 during K2 | resolved in 12 §3.1 (SETUPTOOLS_SCM_PRETEND_VERSION from resolved tag); 15 B-07/T-35 |
| DA-16 | minor | 07 and 08 distinguish capability states | They do (DOC/IMPL/IMPL+T/DISABLED/UNKNOWN legends: 07:5, 08:7). But nothing is TESTED or LIVE: "IMPL+T" means tests were *read*, not run | Keep it. In the README, don't call any ported pattern "tested upstream" | resolved in 16 §6 checklist (no "tested upstream" claims) |
| DA-17 | minor | "Untrusted repro code **never** shares a runner with your write token or model keys" (10 §3) | True only while the control plane and sandbox host stay separate VMs (S-02). Budget pressure ($200/team, D-02) could collapse them, and nothing in 13 forbids that | Make S-02 a hard gate. If a single VM is forced, drop the "never shares" line | resolved in 12 §1 and §10.3 #8 (two-VM hard gate); 19 boundary 14 |
| DA-18 | minor | "Just CI" perception | Fail-before/pass-after in containers reads like CI or SWT-bench to technical judges | Lead the demo with the **untrusted input** (hostile PoC absorbed) and the **agent's stderr→retry loop** (C1-13). Show the fresh-sandbox re-run second | resolved in 16 §1–§2 (untrusted input + stderr→retry first, re-run second) |

**Checked, no finding:**
- **Vultr escape.** Every LLM call goes from the control plane to `api.vultrinference.com` (00 §7, 12:70). GitHub REST and PyPI/codeload are data fetches, not model calls, so they're compatible with C1-02. No GitHub Actions or hosted sandbox is in the path. The `nemotron` guard is Vultr-hosted.
- **Identity, approvals and transport.** These are well specified: hash-bound approvals, atomic claim, `outcome_unknown`, run-scoped SSE and a judge role with no mutating routes (12 §6-7, threats 18-21, 25).
- **Security language.** No "zero risk" wording was found in the plan files; 12 §10.3 states its residuals plainly.
- **Banned list.** Low risk: the product is execution, not a dashboard. Watch that the receipt viewer doesn't become the demo's centre.

---

## C. Challenge questions, answered

1. **Independent pain, or one repeated anecdote? Recent? Already fixed?** The pain comes from **independent** sources, and the dates and quotes check out (§A3). But the "AI slop" pain is **being fixed by policy** in several places (curl EV-S-0001/EV-R-0011, AllStarLink EV-A-0039, Vite EV-R-0018, GitHub limits EV-R-0007/0008), and Pallets rejects by origin. The surviving pain is volume, duplicates and already-fixed reports (EV-R-0010), plus maintainers running PoCs by hand (EV-R-0004). That supports the DA-01 and DA-06 re-scope.
2. **Is the differentiator available elsewhere? Is the novelty inflated?** Yes, the novelty is inflated (DA-05). Two-ref re-execution is standard in ClusterFuzz and syzbot, and triagebot does LLM repro plus bug-vs-intended. What remains is the untrusted-NL-report input, the secret-free boundary, the approval-gated post and the signed receipt.
3. **Is the value useful execution, or chat/dashboard? "Just CI"?** It is execution: sandboxes run code and the verdict is computed from exit codes and signatures. The "just CI" risk is real (DA-18); mitigate it with demo ordering.
4. **Does anything escape Vultr?** No model call does. PyPI and GitHub fetches are data egress through the proxy, which is fine under C1-02. C1-06 ("every action contained") is arguably strained by the control-plane GitHub fetch and post, but that is defensible because they are approval-gated non-code actions.
5. **Do 07/08 distinguish mocked, disabled, documented and live capabilities?** Yes (DA-16).
6. **Identity, approvals, transport, trust boundaries, seal and fault locality:**
   - Identity, approvals and transport are sound.
   - The seal latch is sound *for the post-seal run*, but install runs pre-seal in B and C (DA-08).
   - Fault locality is spoofable and brittle (DA-04).
   - A repro can legitimately need network (DA-14).
   - **pip install does execute repo code (`setup.py`/build hooks) with egress before sealing.** It's acknowledged (12 residual #2) but not mitigated in B/C (DA-08).
7. **Is the security claim stronger than implementation and tests?** Yes in the pitch, not in 12. 12 §11 says "all to be written; none exist yet". Claim only what T-SBX/T-NET tests demonstrably pass on stage, and use DA-03's wording.
8. **Is there an acceptable path when the model, sandbox, worker, network or GitHub fails?** Partly: ERROR and `outcome_unknown` exist. There is no demo-level fallback (DA-11).
9. **Is the new hackathon contribution unmistakable?** Mostly yes. Everything is new code, and patterns are credited (17). Tighten it by removing the novelty claims from DA-05.
10. **Can 1-4 people demo this by Sun 12:00?** A reduced version can, with 3-4 people. The **scariest risk is DA-10**: K3 depends on the full infrastructure stack, so the pivot signal arrives too late. The second is run latency versus the live slot (DA-11).
11. **Banned list?** Low risk (see "checked, no finding").
12. **Is Repro Receipts better than the runners-up for this rubric?** Only marginally. See §D.

---

## D. Independent re-score (0–10; R1 = .40T + .25C + .20D + .15F; R2 = mean)

I score what a 3-person team will plausibly *demo*, not the full design.

| Concept | T | C | D | F | **R1** | **R2** | Rationale |
|---|---|---|---|---|---|---|---|
| **Repro Receipts (as written)** | 7 | 5 | 7 | 7 | **6.50** | **6.50** | Tech: strong boundary, but verification is gameable (DA-03/04) and much of 12 won't be built. Creativity: prior art (DA-05). Demo: multi-minute runs plus model dependence (DA-11). Future: real but mismatched pain (DA-06) |
| Repro Receipts (after C1–C6) | 8 | 5 | 8 | 7 | **7.10** | **7.00** | A verify-only replay plus a coherent hostile-PoC beat raises Demo. The lock/seal fix plus the script gate restores the Tech claim |
| Exactly-Once Submitter | 7 | 5 | 8 | 5 | **6.40** | **6.25** | Deterministic and low model dependence (good for Demo). But its "containment moment" is a kill/restart, which is weaker on "sandbox absorbs something unsafe". Idempotency is textbook (Temporal/Inngest). Weak production pain |
| Evidence Clerk | 7 | 6 | 5 | 7 | **6.35** | **6.25** | Login + seeded Gitea + live browser is fragile. Build risk 4 |

**Result:** the ranking is unchanged, but the margin shrinks from 0.30 to **0.10** (R1) and 0.25 (R2). With a one-point Demo drop, Repro Receipts (6.30) falls **below** Exactly-Once Submitter (6.40). Demo reliability is therefore *the* decision variable. That is the same conclusion as 10, but with less slack.

---

## E. Vetoes

- **V1 (claim veto):** don't say on stage or in the README that triagebot puts "write tokens / model keys in the sandbox environment", or that it "runs in isolated sandboxes". Use the §A1 sentence.
- **V2 (claim veto):** no claim that the receipt "proves the bug is real" or that two-ref re-execution is novel. Use "proves this frozen script fails at X and passes at Y in fresh, secret-free sandboxes".
- **V3 (headline-metric veto):** don't present "Pallets 88 rejected-AI items" as issue-triage demand without "(13 issues, 75 PRs)".

No concept-level veto.

## F. Final verdict: **ENDORSE WITH CONDITIONS**

Conditions, each with an owner and a deadline during hacking:
- **C1 (DA-10), by H+3:** run the K3a model-only spike and decide the pivot on it.
- **C2 (DA-01/02), in 12 before coding the verifier:** reconcile 00 and 12 by adding the HEAD run and the ALREADY_FIXED verdict.
- **C3 (DA-08), in the verifier:** B and C install from the locked, hashed set (or the wheelhouse) with no egress from creation.
- **C4 (DA-03/04), before claiming REPRODUCED without a fix ref:** add the static script gate and harden fault locality.
- **C5 (DA-11), by Sun 08:00 PDT:** build the verify-only replay mode and pre-recorded receipts, and record the video early.
- **C6 (DA-07/12, V1–V3):** make the hostile beat a hostile *issue PoC*, and correct the claims about triagebot and Pallets.

If C1 fails (<3/6 on K3a), pivot to **Exactly-Once Submitter**, not Claim Court. My scores give Claim Court no advantage (crowded, Creativity 5), while Exactly-Once has the highest Demo score.
