> **Historical plan — superseded for product choice and build scope.** Read [35-AIRLOCK-MAIN-CHALLENGE.md](35-AIRLOCK-MAIN-CHALLENGE.md) for the current main-challenge project and [34](34-main-challenge-evidence-and-decision.md) for the evidence and corrections. Do not execute this older plan as the current brief.

# 11 · Repro Receipts: PRD and Architecture Decision Record

Written 2026-09-26 ~18:30 IST (06:00 PDT), before hacking starts. The event runs on America/Los_Angeles. Hacking is **Sat Sep 26 11:30 PDT → Sun Sep 27 12:00 PDT** (Sun 00:00 IST → Mon 00:30 IST). Our internal freeze is 11:30 PDT, and round-1 judging is at 12:30 PDT.

**Status.** This is a plan. Nothing has been built, deployed or measured. **Every interface, table, screen, metric and file path in this file is new design** unless a line cites `12-architecture-and-threat-model.md` (12), which stays authoritative. Where this file seems to disagree with 12, the disagreement is listed in §9 "Conflicts found" and 12 wins until a human decides otherwise. **(rev. after 18)** All §9 conflicts are now resolved in 12, and this file has been updated to match 12 and the accepted findings of `18-devils-advocate-review.md` (DA-01..DA-18, conditions C1–C6).

**Read with:**
- 00 (decision)
- 10 (scorecards and the F1/F3 specs)
- 03c (demand validation and the curated issues)
- 12 (interfaces, verdict rules, threats)
- 13 (Vultr inference and deployment)
- 14 (NetBird)
- 17 (attribution)
- 15 (build plan and tests)
- 16 (demo and submission)
- 19 (build-agent prompt)

---

## 1. Problem (evidence-led)

Maintainers of small-to-mid open-source libraries get more plausible-looking bug reports than they can check by hand, and some of those reports carry code the maintainer has to run to check them.

| Claim | Evidence | Window |
|---|---|---|
| Report volume attributed to AI is rising fast | Pallets labelled 88 items "rejected AI" from 2026-08-27 to 09-26, against 45–46 the previous 30 days (EV-R-0001). **Of the 88, 13 are issues and 75 are PRs** (18 §A2), so for an issue tool cite "13 issues + 75 PRs", never "88" alone (18 V3) *(rev. after 18)* | last 30 days |
| Maintainers say triage itself is the pain | 3DTilesRendererJS: "wave of overly-long AI-generated issues with no repros and false reports" (EV-R-0003). KDE: slop MRs are "burning people out" (EV-R-0009) | last 30 days |
| Maintainers run untrusted PoCs by hand today | The Little-CMS owner hand-ran an AI-written ASan PoC. It did not crash (EV-R-0004) | last 30 days |
| Projects now demand reproduction before engaging | AllStarLink policy rejects unreproduced reports (EV-A-0039, 2026-09-24). Turso retired its bounty over non-reproducing AI reports (EV-A-0038). Vite auto-closes `needs reproduction` after 3 days (EV-R-0018) | 2026 |
| The platform is responding by gating access, not by verifying | GitHub shipped PR limits and restrict-issue-creation in 2026 (EV-R-0007, EV-R-0008) | 2026 |
| "Already fixed" duplicates cost maintainers time | Torvalds on duplicate reports of bugs that were already fixed (EV-R-0010) | 2026-05 |
| A model's judgement is not verification | An LLM judge endorsed tests that fail on the gold patch 61.9% of the time. Only Docker execution caught this (EV-P-0014). About 1 in 5 "solved" SWE-bench patches are wrong (EV-P-0013) | papers |
| A verifier that shares the agent's environment can be gamed | BenchJack's top flaw class is agent and evaluator sharing a container (EV-P-0016..0018) | 2026-05 |
| The closest tool runs repros next to its secrets | withastro/triagebot-action (read at `51d30da`, 18 §A1) runs repro commands directly on the GitHub Actions runner with unrestricted network, not in a sandbox. Its write token and model key are in the **parent process on that same runner**, not in the agent shell's env. It has no fresh-sandbox re-run or receipt, and posts without approval. Its LLM verify step does address bug-vs-intended, which we don't (EV-R-0015). **Stage-safe sentence (00 §3):** "triagebot runs repro commands on the same runner that holds its write token and model key; we run them in a secret-free, egress-limited sandbox on a separate VM and re-execute them fresh." *(rev. after 18)* | 2026-06 |
| Two-ref re-execution itself is not new | ClusterFuzz/OSS-Fuzz re-runs testcases daily against the latest build and auto-closes fixed bugs; syzbot re-runs stored reproducers on a tree or patch to check whether a bug is already fixed (18 §A5). **Our novelty is narrower:** syzbot-style verification for untrusted human/AI issue text and PoCs, with the report treated as hostile code, an LLM-authored reproducer and an approval-gated post *(rev. after 18, DA-05)* | ongoing |
| Agents execute hostile repo configuration | AI agents ran repo-supplied git config/malware outside their sandbox (EV-R-0024) | 2026 |

**Counterevidence we accept, and that shapes scope (03c §1, 00 §3):**
- curl's bounty slop ended once incentives changed (EV-S-0001, EV-R-0011).
- Pallets rejects reports by origin, whatever their validity (EV-R-0002).
- Many disputed reports describe behaviour that is real but intended (EV-R-0006: tomli #304, click #3841, semver #465/#468).
- Small libraries fix clear reports the same day (EV-R-0014).
- Only about 51% of reports include steps to reproduce (EV-R-0021).

So the pitch is **triage throughput plus a safe boundary for running untrusted repro code**. It is never "we detect AI slop". INCONCLUSIVE is a first-class, honest outcome.

## 2. Target user and job

- **Primary user: a maintainer or triager who receives PoC-bearing reports** (the Little-CMS pattern: the maintainer runs attacker code on their own machine) *(rev. after 18, DA-06)*.
- **MVP language:** pure-Python libraries. The runner design is language-agnostic; recent firsthand pain is mostly JS, C and Java (18 §A3), and we say so.
- **Secondary user:** a security triager handling the same kind of report.

**Job story.** *When* an issue arrives that claims a bug, possibly AI-written and possibly carrying a PoC, *I want* someone other than me to run it somewhere that can't hurt me, at the reported version and against the fix, *so that* I get a verdict I can re-check myself before I spend an hour on it or paste attacker code into my own terminal.

**Evidence of success, from the user's side:** the maintainer runs the two-step `rerun_command` from the receipt on their own machine, or runs `verify-receipt`, and gets the same answer without trusting us.

## 3. Non-goals

These are out of scope for the event. 15 §7 has the full do-not-build list.
- Judging whether a behaviour **is a bug**. We report *observed behaviour*, quote the claim, and leave intent to the human (03c §5).
- Detecting AI authorship.
- Languages other than Python. Build systems that need a compiler (for example Little-CMS, C).
- Fix generation, PR creation, auto-labelling, webhooks, or triaging every new issue automatically.
- Posting to any repository we don't own. Comments go **only** to our own `ror-demo-target` repo.
- Human takeover of the sandbox shell. The MVP offers **cancel and a manual re-run** only.
- Multi-tenant organisations, SSO (except the optional NetBird tier 2), billing.
- MicroVM or throwaway-VM tiers. They are post-hackathon (13 §4 C/D).
- Any non-Vultr model call, including helpers, embeddings, guards and dev fallbacks in the runtime path (C1-02).

## 4. Distinguishing workflow

Automated reproduction exists (Astro triagebot, Sentry, LogicStar; 03c §2). Our difference is the **boundary and the evidence**, not the capability:

1. **Untrusted code never shares a machine with a secret.** The repro runs on a separate sandbox-host VM under gVisor. That VM holds no inference key, GitHub token or receipt key. Egress goes only through the allowlisted proxy (12 §1).
2. **The author isn't the judge.** The agent writes the repro in sandbox A. The script is frozen by hash, passed through an AST static gate, and re-run in **fresh, no-network-from-creation** sandboxes B (reported ref), C (fix ref, if known) and D (HEAD, always), installing only a hashed lock built in a separate prep sandbox. Deterministic code, not the model, computes the verdict, including **ALREADY_FIXED** (12 §5, rev. after 18). The receipt proves *this frozen script behaves differently at these refs*, never that the bug is real.
3. **Hostile input is contained.** A PoC in the issue that reads planted credentials, touches metadata, phones home, wipes `~` or fork-bombs is killed; the run is labelled HOSTILE internally and **"CONTAINED: policy violation"** publicly, and the host and the next run are shown to be unaffected (12 §4, rev. after 18).
4. **Receipt.** An ed25519-signed JCS receipt records the image digest, SHAs, script hash, argv, exit codes, log hashes, egress summary and verdict rules version. Anyone can check it with a CLI and recompute the verdict from it (12 §8).
5. **Approval.** The one outward action is a templated GitHub comment, posted only after a human approves those exact bytes. The approval is hash-bound, expires, and is claimed atomically. An uncertain post goes to `outcome_unknown` and is never retried (12 §6.2, §7).

## 5. Measurable success conditions

Every condition has a test in 15 §5. "Curated set" means `eval/curated-issues.json` (15 §6).

| ID | Condition | Measure | Target |
|---|---|---|---|
| SC-01 | Real work end to end | T-01 passes: a real Vultr model writes a repro, the sandboxes execute it, and the receipt verifies | pass on ≥1 curated issue live, every rehearsal |
| SC-02 | Repro yield (K3a gate, rev. after 18) | **K3a (model-only):** scripts for the 6 curated issues fail at the before-ref and pass at the after-ref in plain `docker run --network none`. **K3b:** the same through the full stack, reaching REPRODUCED or ALREADY_FIXED with fix control passed | K3a **≥3/6 by hour ≤2.5 (~14:00 PDT Sat)**, or pivot to **Exactly-Once Submitter** (00 §9). Stretch ≥6/10 on the full set |
| SC-03 | No false REPRODUCED | Runs where the reported ref is set to the **fix** commit (synthetic negatives) | 0 REPRODUCED |
| SC-04 | Deterministic verdict | `verify-receipt --recompute` result vs the stored verdict, over all receipts produced | 100% equal |
| SC-05 | Receipts verifiable | `verify-receipt` over all receipts: signature OK. A one-byte tamper of the receipt or an artifact fails | 100% / 100% |
| SC-06 | Hostile fixture always contained | Hostile fixture run → HOSTILE. Host sentinel hash unchanged. The next legitimate run succeeds | 10/10 consecutive runs before freeze |
| SC-07 | Zero secrets in sandboxes | T-03 grep of env, `/proc/*/environ`, the filesystem, image history and metadata reachability, for real key values and key patterns | 0 hits (honeytokens excluded by design) |
| SC-08 | Vultr-only inference | Every LLM request in `events` (`llm.call`) and client logs goes to `api.vultrinference.com`. Startup refuses any other base URL | 100%; T-11 |
| SC-09 | Cancel is fast | Cancel → every sandbox of the run `destroyed` (in-flight exec docker-killed) | **≤5 s** (T-09; rev. after 18) |
| SC-10 | No leaks | After each rehearsal: `docker ps -a --filter label=ror.sandbox=1` is empty, and no approvals are in `executing` | 0 |
| SC-11 | Nothing posted without approval | GitHub comments on `ror-demo-target` equal approvals in `posted`. 0 comments anywhere else | exact match |
| SC-12 | Bounded run | Median curated run ≤5 min wall clock. Model spend ≤ $0.25/run at worst-case price (12 §5, 13 §2) | measured in the eval run |
| SC-13 | Verify-only replay works live *(rev. after 18)* | Replay of each curated tuple: 0 model calls, 0 GitHub calls, fresh B/C/D, same verdict (T-28) | ≤90 s, 100% same verdict |
| SC-14 | Third parties can re-run *(rev. after 18)* | The two-step `rerun_command` from a receipt, run on a clean laptop, gives the same pass/fail at each ref (T-29) | pass on E01 and E17 before the demo |
| SC-15 | No lying-script shortcut *(rev. after 18)* | Static-gate fixtures (T-GATE-*) and spoof/stdlib fixtures (T-VER-05/06) | 100% expected outcome |

## 6. The complete vertical slice (new design over 12)

```
[1] Input        Operator pastes a GitHub issue URL (+ optional reported_ref / fix_ref) in the web UI,
                 or picks a curated entry, or starts a verify-only replay (rev. after 18)
[2] Auth         Session cookie + CSRF, role=operator (judge = read + start curated/hostile/replay
                 runs only; never proposes or approves posts)                   12 §9.1, T-AUTH-*
[3] Intake       Control plane fetches the issue (unauthenticated GitHub REST), resolves refs → 40-hex SHAs
                 including head_sha (default branch, always), wraps the body as <untrusted_issue>,
                 caps it at 16 KB; pasted-snapshot fallback                                          12 §5 Phase 0
[4] Plan         Vultr Serverless Inference (glm-5.3-normalize), forced tool call emit_plan
                 → plan.created event (steps, model id, token/cost)                                13 §1–2
[5] Policy       Static policy file (policy_version = sha256): image allowlist, limit clamps, egress profile,
                 run budget. The tool registry holds only write_file / exec / emit_repro       09 policy row
[6] Sandbox A    Supervisor create(role=author, egress=fetch) → PoC-first attempt if the issue has a code
                 block → author loop ≤5 attempts / ≤12 LLM calls / $0.25; stderr + static-gate findings
                 fed back to the model as UNTRUSTED data; live step.output events (streamed exec) 12 §5 Phase 1
[7] Observe      Live SSE stream: states, argv, output chunks, egress allow/deny, limit.hit, tripwire, spend
    Intervene    Cancel → guard() fences the next effect AND every live sandbox is docker-killed (≤5 s);
                 manual re-run = new run with retry_of (optionally with ref overrides)             12 §3.4
[8] Freeze       copy_out script → script_sha256 + signature_sha256; destroy A; AST static gate   12 §5 Phase 2, §5.2
[8b] Prep        Fresh P (egress=fetch, fixed commands, no model): per ref, src tarball + wheels →
                 hashed lock-<ref>.txt → export_bundle → bundle_digest (curated repos: cache hit)  12 §5.3
[9] Verify       Fresh B (reported_sha), C (fix_sha, if known) and D (head_sha, always), each with
                 egress NONE from creation: bundle + frozen bytes streamed in → gate re-run → hash
                 check → pip install --require-hashes --no-deps --no-index → run (B ×2) → locality
                 check vs pristine checkout; verdict = pure function (incl. ALREADY_FIXED)   12 §5 Phases 3–6, §5.1, §5.4
[10] Artifact    Content-addressed blobs (script, logs, junit, egress log, locks), signed ed25519 JCS receipt
     + receipt   with the two-step rerun_command, /.well-known/ror-receipt-key.json, scripts/verify-receipt,
                 stored replay tuple for verify-only mode                                           12 §8, §5.5
[11] Approve     Operator requests a proposal → server renders the templated comment → card shows the exact
                 bytes + hash + expiry → approve → atomic claim → executor posts to ror-demo-target only
                                                                                              12 §6.2, §7
[12] Revoke/     Every sandbox destroyed at run end (the UI shows "destroyed at T"); supervisor janitor by
     cleanup     TTL label; control-plane reconciler; artifact URLs expire ≤15 min; approvals expire in 30 min;
                 post-event teardown of VMs, keys and tokens (15 §3)                        12 §3.4, T-SBX-12
```

## 7. UX specification (new design)

One web app with four screens: **Login**, **Runs** (list + new-run form), **Run** (live), and **Receipt** (public-ish, judge-readable). Untrusted text is rendered as text only (T-UI-01).

### 7.1 Start a run
- **Runs → "New run".** Fields:
  - Issue URL. Validated client-side and server-side with 12's regex.
  - Optional "Reported version/ref" and "Fix ref".
  - A **curated picker** listing the eval-set issues with their pinned refs, so the demo never depends on typing.
  - **"Replay (verify only)"** on any curated entry or finished run: re-runs the stored frozen tuple in fresh B/C/D with no model and no GitHub (12 §5.5). It is the live-demo fallback *(rev. after 18)*.
  - **Judges** see the curated picker and the replay button only; free-form URLs and ref overrides are hidden and refused server-side (12 §9.1).
- **Submit.** `POST /api/runs` with an `Idempotency-Key`, which prevents duplicate runs on a double click. The app goes straight to the Run screen.
- **Validation errors appear inline:**
  - bad URL → `VALIDATION`
  - two runs already active → `CONCURRENCY_LIMIT`, with a "wait" hint

### 7.2 Understand the plan
- The **Plan panel** is the first panel on the Run screen. It shows:
  - the ordered plan steps;
  - the model id and host (`glm-5.3-normalize @ api.vultrinference.com`);
  - tokens and estimated cost so far;
  - the budget remaining (calls, $, attempts).
- A collapsible **"What the agent may do"** box lists the three tools and says: "no network tool, no GitHub tool, no approval tool".
- The **issue body** is shown in a quoted, monospaced "untrusted input" frame. It is never rendered as markdown/HTML.

### 7.3 Inspect execution (live event stream)
- **Timeline.** One row per event from the 12 §9.2 union. It reconnects with `Last-Event-ID` after a dropped connection, and a "reconnected, replayed N events" toast confirms the resume.
- **Sandbox cards** (A, P, B, B-run-2, C, D). Each shows:
  - role, image digest (short), `runtime: runsc`;
  - limits (CPU, memory, pids, workspace, wall);
  - egress profile, then a `sealed at T` badge (A, P) or `no network since creation` (B, C, D);
  - state chip, then **`destroyed at T (reason)`**.
- **Step output.** A live tail of stdout and stderr (UI chunks ≤4 KB), with a "truncated at 256 KiB" marker when capped, plus the step's exit code and sha256.
- **Egress log.** Allowed hosts with connection counts; denied hosts in amber; after-seal attempts in amber with an "INCONCLUSIVE risk" note.
- **Spend meter.** LLM calls out of 12, $ out of $0.25, attempts out of 5.

### 7.4 Approve a specific comment
- On a finished run, the operator clicks **"Draft GitHub comment"**, which calls `POST /api/runs/:id/approvals`. The card shows:
  - target `owner/repo#N` (always `ror-demo-target` in the MVP) and the issue's `updated_at` as read at proposal time;
  - the **exact comment bytes** in a monospaced block, rendered as text, with the short `payload_sha256` next to them;
  - the verdict, confidence, receipt id and an expiry countdown (30 min);
  - **Approve** and **Deny** buttons. Approve sends `{decision, payload_sha256}` with CSRF.
- **State chips:** `awaiting_approval → approved → executing → posted` (with a link to the comment) | `failed:<code>` | `outcome_unknown`.
- **`outcome_unknown` is shown as a banner:** "We don't know whether GitHub accepted this. We will not retry. Checking for marker `ror:approval=<id>`…". The result is either `posted (reconciled)` or "Not found; create a new proposal to try again".
- **There is no edit box on the card.** "Edit" means "create a new proposal", which gets a new hash and needs a new approval.
- **Judges see the card read-only.** Buttons are absent, not merely disabled, and the server returns 403 anyway.

### 7.5 Cancel / take control
- A **Cancel run** button stays visible while the run is non-terminal. After a confirm dialog, the timeline shows `run.state cancelling`, each sandbox reaching `destroyed (reason=cancelled)` (in-flight execs are docker-killed, not waited out), then `cancelled`. Target: **≤5 s** (SC-09, rev. after 18).
- **"Re-run…"** on any terminal run opens the new-run form pre-filled with the same URL and refs. The new run links `retry_of`.
- **Out of scope, and said so in the UI tooltip:** a shell into the sandbox, editing the frozen script, and resuming a cancelled run.

### 7.6 Errors
- Every error shows `{code, message, retryable}` (12 §9.4) plus a **human sentence and a next action**:
  - `INFERENCE_UNAVAILABLE`: "Vultr Inference did not answer after 3 tries. No other provider is used. Re-run later."
  - `INFERENCE_AUTH`: "Inference key rejected (401/422). Operator must fix configuration."
  - `SANDBOX_UNAVAILABLE`: "Sandbox host unreachable; run failed before executing anything."
  - `BUDGET_EXCEEDED`: "Agent used its budget without a verifiable repro → NOT_REPRODUCED."
- **A failed run is still a finished page.** It keeps its timeline, whatever sandboxes ran, and a receipt if verification got far enough. A run that fails before verification shows "no receipt: failed at phase X".

### 7.7 Retrieve output
- **Receipt panel:**
  - verdict badge, confidence, reasons in plain English (for example "B failed with `OverflowError` in `humanize/time.py` on both runs; C passed at the fix commit; D passed on HEAD → **ALREADY_FIXED**", or "no fix commit known; HEAD still fails the same way → REPRODUCED · medium");
  - the one-sentence claim: **"This frozen script fails at X and passes at Y in fresh, secret-free, no-network sandboxes."** It never says the bug is real *(rev. after 18)*;
  - the static-gate result and findings next to the frozen script;
  - **"Behaviour observed" and "Bug claim (quoted from the issue; not assessed)" side by side;**
  - the frozen script with a copy button;
  - the **two-step** `rerun_command` (step 1 fetch with network on your host; step 2 `docker run --network none`) with copy buttons, plus the image Dockerfile link and digest (12 §8);
  - "Download receipt.json" and the artifact list. Each artifact link is signed and expires in ≤15 min, and is served as `attachment` + `text/plain`;
  - a **"Verify it yourself"** box: `node scripts/verify-receipt.mjs receipt.json --key https://<host>/.well-known/ror-receipt-key.json --artifacts ./dl`.

### 7.8 Understand a refusal or a HOSTILE verdict
- **HOSTILE** (internal code) gets a red banner labelled **"CONTAINED: policy violation"** on every public-facing surface: "Something in this run tried to do something it shouldn't. We stopped it." The word HOSTILE appears only in the operator view *(rev. after 18, DA-13)*.
  - **Tripwire list:** kind, sandbox, time, and a detail line such as `CONNECT 3f9a….aws.canary.ror.invalid`. It never shows a token value.
  - **Limits hit** (pids, memory, wall).
  - **Containment proof:** each sandbox `destroyed at T (tripwire:<kind>)`, and "sandbox host healthy; sentinel hash unchanged; next run OK" from `/api/health/sandbox-host`.
  - **Attribution caveat (12 §5.1):** "The cause may be the report, the repo, a dependency, or the model after prompt injection."
  - "No comment is proposed automatically." The operator may still draft one on our own demo repo.
- **Refusals at intake:** a non-GitHub URL, a non-Python repo (no `pyproject.toml`/`setup.py`/`setup.cfg` found by `ror-fetch`), or a repo over the size cap. Each shows `VALIDATION` with the reason and runs no model.
- **INCONCLUSIVE** shows the reason code in plain words, for example "flaky: runs disagreed", "failure differed from the claimed signature", "fix ref also fails", "network needed after seal", "script rejected by the static gate (it reads the package version)", or "failure not located in the package code" *(last two rev. after 18)*.
- **ALREADY_FIXED** shows "Reproduced at the reported version; HEAD no longer fails", plus "fixing commit: <sha>" when C passed or "fixing commit not identified" when no fix ref is known *(rev. after 18)*.

## 8. Architecture Decision Record

### ADR-01: One boring TypeScript control plane plus a small Go sandbox side

**Status:** proposed (decide at kickoff, 11:30 PDT). **Context:** 12 §2 leaves the language open (TS/Hono or Python/FastAPI; Go or TS supervisor). 09 §2.2 chose foundation **C**, a minimal new app with ported patterns. 17 requires fresh code.

**Decision (versions "to pin at kickoff" as exact versions in lockfiles):**

| Layer | Choice | Why |
|---|---|---|
| Control-plane runtime | **Node.js 24 LTS**, TypeScript (strict), pnpm workspaces | One language for API, worker, UI and the verify CLI. The OpenAI SDK is first-class. The patterns we port (OpenMuse) are TS |
| HTTP API + SSE | **Hono 4** on `@hono/node-server` | Tiny, typed, built-in `streamSSE`, signed cookies and CSRF helpers. The UI is served from the same origin, so CSRF is simpler |
| DB | **SQLite (WAL) via `better-sqlite3`**, hand-written SQL migrations (no ORM) | 12 §9.3 says SQLite. It's synchronous, so CAS and the atomic-claim SQL (12 §6.2) are literal. Single file, easy backup. Drizzle was rejected: an extra abstraction over ~10 hand-written CAS statements |
| Worker | Same Node process, separate loop, lease + heartbeat + `guard()` | 12 §6.1. One process means one deploy unit |
| UI | **React 19 + Vite**, react-router, plain CSS, native `EventSource` | The boring default. No component framework or CopilotKit (17 §2) |
| LLM client | **`openai` npm SDK**, `baseURL` hard-pinned to `https://api.vultrinference.com/v1`, `chat.completions` only, forced tool calls, `-normalize` models; `zod` validates tool args | 13 §2. The Responses API is avoided (09 model row). Startup asserts the host |
| Crypto | Node `crypto` ed25519 + a ~40-line RFC 8785 JCS canonicaliser in `packages/core` (or the `canonicalize` npm package after a license check) | No native deps. Shared by the signer and `verify-receipt` |
| Regex for signatures | **`re2-wasm`** (RE2, linear time) | 12 §5 requires RE2. Pure WASM, so no native build. [unverified: API fit and license, check at kickoff] |
| Password hashing | `@node-rs/argon2` | Prebuilt binaries. 12 §9.3 uses argon2 |
| Supervisor | **Go (current stable, pin at kickoff), single static binary**, official Docker Engine Go client over the Unix socket, stdlib `net/http` with mTLS | It runs on the untrusted host next to the Docker socket, so it should have the smallest runtime and no npm dependency tree beside root. Static binary, typed Docker API, no CLI shell-out (12 §2). Easy nftables-log tail and Unix-socket tripwire channel |
| Egress proxy | **Go**, ~250 LOC: CONNECT-only, resolve → public-IP check → pin → peek ClientHello SNI == CONNECT host, per-source-IP seal latch, tripwire hosts, JSONL log | 12 §2 (Go/Python ≈200 LOC). It shares the IP-classification code with the supervisor. Squid `ssl_bump peek/splice` is the fallback if the Go SNI peek slips |
| Sandbox image | Debian slim + CPython 3.12 (3.10/3.11 optional) + git + pytest + `/opt/ror/{ror-run,ror-readfile,ror-writefile,ror-fetch,ror-gate,ror-locality,ror_pytest_plugin.py,conftest_guard.py}`, pinned by digest; Dockerfile published for third-party re-runs (rev. after 18) | 12 §2, §3.3, §8 |
| Sandbox runtime | Docker Engine (Docker apt repo) + **gVisor `runsc` from the gVisor apt repo** (systrap) | 13 §4 B: the binary-only install is being dropped at the end of Sept 2026 |
| Ingress | **Caddy 2** (auto-TLS) on the control-plane VM, 80/443 only; optional NetBird (14) | 12 §1 |
| Process mgmt | systemd units; secrets via `LoadCredential=` files (0600) | 12 §1. Nothing in `user_data` (13 §5) |
| Tests | `vitest` (TS), `go test` (Go), `bash` + `curl` live suites under `tests/live/` | Fast, boring |

**Alternatives considered:**
1. **Python/FastAPI control plane.** Equally viable. We rejected it because the UI, verify CLI and API would then span two ecosystems on the trusted side. Choose it instead if the team is Python-first, since nothing in 12 depends on TS.
2. **Node supervisor (dockerode) and Node proxy.** One language overall, but it puts a Node runtime and an npm dependency tree on the host that holds the Docker socket, and a CONNECT proxy with SNI peeking is more awkward in Node. **This is the fallback if nobody on the team can write Go.** The interfaces stay identical.
3. **Fork OpenMuse or OpenBot.** Rejected in 09 §2.2: both hard-require the closed CopilotKit Intelligence service at startup, and OpenMuse runs Docker from its API process.
4. **Postgres** (13 §6 shows it). Rejected for the MVP: one process and one VM, and 12 §9.3 says SQLite.
5. **Throwaway Vultr VM per run.** Stronger isolation, but boot latency is unmeasured (30–120 s assumed) and billing granularity is unknown (13 §4 D). Post-hackathon.
6. **Plain runc.** Rejected. runsc is mandatory (12 §3.3, S-01).

**Consequences:**
- Two languages: Go only on the sandbox host.
- mTLS needs a tiny CA generated at kickoff (`scripts/gen-mtls.sh`).
- All state lives on one control-plane VM. Back up the SQLite file and blobs before judging.

### ADR-02: Pivot rule (replaces "Fallback F3 Claim Court", rev. after 18)

Source of truth: 00 §9 and 18 §F (C1, DA-10).

- **Decision signal: K3a, the model-only spike, by hour ≤2.5 (~14:00 PDT Sat).** The Vultr model writes repro scripts for the 6 curated issues (E01–E06); each runs in plain `docker run --network none` against a pre-installed checkout on any VM, with no supervisor, proxy or UI. **Go** if ≥3 of 6 fail at the before-ref and pass at the after-ref. The infrastructure path (K2 → K3b) runs in parallel and does **not** gate the pivot.
- **If K3a fails because repro authoring is unreliable → pivot to Exactly-Once Submitter.** It has the lowest model dependence and the most deterministic demo (18 §D: Demo 8). It reuses the supervisor, lease/heartbeat, `outcome_unknown` and hash-bound approval patterns (12 §3, §6); it does not reuse the verifier.
- **If K3a passes but infrastructure lags → cut scope, don't pivot:** drop C and D refs (B-only with `fix_control: absent`, confidence ≤ medium), drop the approvals UI, and lean on verify-only replay for the demo.
- **Claim Court is a secondary option only**, if the team explicitly values engine reuse over demo reliability. It would change the input parser, the planner prompt and add a `claim.verdict.v1`, and keep §3–§8 of 12. The reviewer scores it no advantage (crowded, Creativity 5).
- **If Vultr inference can't do multi-step tool calls at all (K1):** try a single-shot forced-tool-call writer inside K3a; if K3a still fails, Exactly-Once Submitter.

### ADR-03: The model never judges

The verdict is `verdict(observations, rules_version="ror.verdict.v2")`, a pure function in `packages/core/verdict.ts`, imported by both the worker and `verify-receipt`. The model only proposes the script and `expected_failure` (12 §5).

## 9. Conflicts found (not silently changed in 12)

**Status (rev. after 18):** every conflict below is **resolved**. The resolutions were applied to 12 after the devil's-advocate review (18) and the research director's acceptance of DA-01..DA-18. 12 remains authoritative; the "Resolution" column points to where. The original conflict text is kept for traceability.

| # | Conflict | Where | Resolution (rev. after 18) |
|---|---|---|---|
| CF-01 | **Second ref semantics.** 00 §1 and 03c §5 describe (a) the reported version and (b) **latest `main`**, with an **ALREADY_FIXED** verdict. 12 §5 used (B) reported SHA and (C) a **known fix SHA**, and had no ALREADY_FIXED | 00, 03c vs 12 | **Resolved in 12 §5 and §5.1** (DA-01): C = fix ref when known, **plus D = HEAD always**. ALREADY_FIXED = B fails with the signature and D passes; `high` only when C also passed, otherwise `medium`. No-fix-known REPRODUCED is at most `medium`. Receipt fields `head_sha`, `head_status`, `fix_control` in 12 §8. The old "second linked run" workaround is withdrawn |
| CF-02 | **Judge permissions.** 12 §9.1 made `judge` read-only. 14 §4 lets the judge "start the scripted demo tasks" | 12 vs 14 | **Resolved in 12 §9.1**: a judge may start runs only for curated allowlist entries, the hostile fixture, and verify-only replays of curated tuples (1 active judge run max); a judge can never propose or approve an outward post. Test T-AUTH-05 |
| CF-03 | **`rerun_command` couldn't work.** 12 §8 ran `git clone` and `pip install` inside `docker run --network none` | 12 §8 | **Resolved in 12 §8** (DA-09): two-step command (step 1 fetch on the host with network; step 2 `docker run --network none` with read-only mounts). Image Dockerfile + digest published; public Vultr Container Registry push optional. Tested from a clean laptop (15 T-29) |
| CF-04 | **Sandbox-to-sandbox traffic on the same bridge.** Container-to-container traffic on one bridge bypasses `DOCKER-USER` unless `br_netfilter` is on, and the proxy sat on the same bridge (`10.89.0.2`) | 12 §1, §3.3 | **Resolved in 12 §1** (threat #33): ICC off on `ror-sbx`, proxy as a host process on the gateway IP `10.89.0.1:3128`, `br_netfilter` + nftables intra-subnet drop; fallback = one internal network per sandbox. Tests T-04, T-SBX-14 |
| CF-05 | **Cancel latency.** Cancel only fenced the next effect; an in-flight exec could run up to 305 s | 12 §9.1 vs SC-09 | **Resolved in 12 §3.4** (threat #34): cancel CASes to `cancelling`, marks steps `interrupted`, and docker-kills every live sandbox immediately. Target **≤5 s** (SC-09, T-09) |
| CF-06 | **Live output vs a synchronous `exec`** | 12 §3.1 vs §9.2 | **Resolved in 12 §3.1**: `exec` is async and returns an `exec_id`; the worker long-polls with byte offsets; `step.output` events carry offsets and fan out over SSE from the control plane. Now CORE (15 C-06b), not optional |
| CF-07 | **The tarball fetch has no `.git`** | 12 vs 03c | **Resolved in 12 §3.1** (DA-15): `SETUPTOOLS_SCM_PRETEND_VERSION` = the tag resolved for that ref (fallback `0+ror.<shortsha>`); the tarball's pax-header commit id must equal the SHA; `src_tarball_sha256` recorded. All 10 curated repos pre-checked in K2 |
| CF-08 | **tmpfs vs memory** under gVisor [unverified] | 12 §3.3 | Unchanged: T-15 accepts either `limit.hit: workspace` or `limit.hit: memory`, as long as the host is unaffected (accepted residual, 12 §10.3 #7) |
| CF-09 | **Topology details.** 13 §6 shows Postgres and sandbox-side presigned uploads | 13 vs 12 | Follow 12: SQLite, copy_out only; the sandbox never uploads |
| CF-10 | **File layout names** | 09, 17 vs 15 | Cosmetic. Update the ATTRIBUTION "Where" column at freeze (15 task D-02) |
| CF-11 | **Timeline.** NetBird tier 3 at 10:00 PDT Sun vs feature freeze 07:00 | 14 vs 15 | NetBird is frozen at 07:00 like everything else. Only tiers already working then are claimed |
| CF-12 | **Role names.** "maintainer, viewer/judge" vs `operator`/`judge` | 00 vs 12 | Use `operator`/`judge` |
| CF-13 | **Python versions** | 12 | The MVP ships 3.12, with 3.10/3.11 optional (O-03 in 15); 12 §2 now says so |
| CF-14 | **Install phase inside the verification sandbox** (18 DA-08, found after this table was written) | 12 §5 | **Resolved in 12 §5.3**: B/C/D have no egress from creation and install `--require-hashes --no-deps --no-index` from a wheelhouse built in a separate prep sandbox P. Residual: A's and P's installs still run build hooks with allowlisted egress (12 §10.3 #2) |
| CF-15 | **Demo containment beat** used a hostile `setup.py` in the maintainer's own repo (18 DA-07) | 12 §11 | **Resolved in 12 §11**: the hostile input is an **issue PoC**; the hostile `setup.py` is a supply-chain test only |
