# 16 · Demo Script, Video Storyboard, Q&A and Submission: Repro Receipts

> **Superseded in part (Sat 07:00 PDT):** read [25-WIN-PLAN.md](25-WIN-PLAN.md) first. After the Fable 5.1 review (24), the demo, pivot rule (now PoC-only mode) and cut list there override this file.


Written 2026-09-26 ~18:30 IST (Sat 06:00 PDT). This is a plan. Every screen named here is the new design from 11 §7. Numbers written as `‹…›` are **placeholders to fill from measured runs at freeze**. Never quote an unmeasured number on stage.

**Roles:**
- **D (Driver):** clicks, on the laptop.
- **N (Narrator):** talks and holds the phone.
- **Solo:** one person does both. Drop the narration marked *(N-optional)*.

**Demo order (rev. after 18, DA-18):** lead with the **untrusted input** (a hostile issue PoC absorbed) and the **agent's stderr→retry loop**; show the fresh-sandbox re-run **second**. Fail-before/pass-after in containers alone reads as "just CI".

**Tabs open before the slot starts, in this order:**
1. The Runs list.
2. The E17 run page (started at T−5 min).
3. The E16 hostile issue on GitHub (read-only), showing its PoC block.
4. A terminal on the laptop, with `verify-receipt` ready and a downloaded receipt.
5. The GitHub `ror-demo-target#1` issue page.
6. The sandbox-host health view (`/api/health/sandbox-host` in the app, not SSH).

---

## 1. Three-minute live demo script

**At T−5 min**, during setup:
- D runs `scripts/preflight.sh`, which must be all green.
- D starts the **E17** run (`ror-demo-target#1`) from the curated picker and leaves it running.
- We say so honestly on stage: "we started this one when we walked up".

| Time | D does | On screen | N says (key line) | Fallback if it fails |
|---|---|---|---|---|
| 0:00–0:15 | Nothing (Runs list visible) | Runs list, with the app URL on Vultr | "Maintainers now get bug reports that come with code: PoCs, often AI-written, that they end up running by hand on their own laptops. Pallets alone labelled 13 issues and 75 PRs 'rejected AI' in the last 30 days. We built a place to run that code that can't hurt you, and that proves what happened." | — |
| 0:15–0:30 | Runs → New run → curated picker **E16 `ror-hostile-fixture#1`** → Start | The hostile run starts. The issue body, with its PoC block, is shown in the "untrusted input" frame | "This is untrusted input: an issue whose proof-of-concept wipes the home directory, fork-bombs, reads cloud credentials, probes the metadata service and tries to send what it finds out. We run it exactly as the reporter wrote it." | — |
| 0:30–1:00 | Watch; point at events as they arrive | Card A: `runsc`, limits. `limit.hit: pids` → `tripwire: canary_host` (or `metadata_or_private`) → red **"CONTAINED: policy violation"** banner → sandbox `destroyed at T (tripwire)` → "sandbox host healthy · sentinel unchanged" | "That's a gVisor sandbox on a separate Vultr VM that holds **no keys at all**. The credentials it read were planted honeytokens; the moment it tried to use them, we killed the sandbox. **This is the sandbox absorbing it**: host untouched, nothing real to steal." | Tripwire doesn't fire in 30 s → open the **hostile run from Rehearsal 3 (today, live URL)** and say "here's the same fixture from ‹N› minutes ago". Never claim it is this run |
| 1:00–1:25 | New tab: curated picker **E01 humanize#333** → Start; point at the plan panel, then the A output tail | Plan panel: steps, `glm-5.3-normalize @ api.vultrinference.com`, budget meter. Card A: pytest fails with the wrong error, **stderr fed back**, attempt 2 rewrites the script | "Now a real public issue. The agent plans on Vultr Serverless Inference. Its only tools are write-file and exec **inside a sandbox**. Watch it read its own stderr and retry. No network tool, no GitHub tool, no approval tool." | Plan doesn't appear in 20 s → "inference is slow; it'll finish in the background", move on and use E17 |
| 1:25–1:50 | Switch to the E17 tab (finished) | Verdict **REPRODUCED · high**, "still reproduces on HEAD". Reasons: "B failed with ‹Exc› in ‹pkg/file› on both runs; C passed at the fix commit; D (HEAD) still fails". Static gate `pass`. Sandbox cards A/P/B/B/C/D, B/C/D marked "no network since creation", all `destroyed` | "The agent wrote the repro, but it doesn't grade it. We froze the script, checked it for tricks like version sniffing, and re-ran it in **fresh** sandboxes with no network at all: it fails at the reported commit, passes at the fix, and still fails on HEAD. **The receipt proves this script behaves differently at these commits.** It doesn't prove intent; that's the maintainer's call." | E17 not finished → click **Replay (verify only)** on E17: fresh B/C/D, no model, no GitHub, about ‹N› s. Say "this is a verify-only replay, running live now" |
| 1:50–2:20 | Terminal: `node scripts/verify-receipt.mjs receipt.json --key https://‹host›/.well-known/ror-receipt-key.json --artifacts dl --recompute` → OK. Then `sed` one byte → run again → FAIL | `signature OK · artifacts OK · verdict recomputed = REPRODUCED`, then `signature FAIL` | "The receipt is signed, and anyone can re-check it and recompute the verdict without trusting our UI." | CLI error → show the receipt JSON and the public-key endpoint in the browser instead |
| 2:20–2:45 | E17 page → "Draft GitHub comment" → the card shows the exact bytes + hash + expiry → **Approve** → switch to the GitHub tab and refresh | Approval chip `posted`. The comment appears on **our own** `ror-demo-target#1` | "The only thing that leaves the box is this comment, and only after a human approves **these exact bytes**. Change one character and the approval is void. If GitHub times out, we mark it unknown and never retry blindly." | Post fails → show the `failed` or `outcome_unknown` chip and say "that's the designed behaviour, no blind retry" |
| 2:45–3:00 | Back to the E01 tab | Whatever the state is, shown truthfully: likely **ALREADY_FIXED · high** ("HEAD no longer fails"), or still verifying | "That's today's live run on a real public issue, and it tells the maintainer the bug is already fixed on main. Everything you saw was built today, runs on Vultr, and every model call goes to Vultr Inference." | Still running → "it'll finish in about a minute; the receipt will be at this URL" |

**Live fallback ladder (rev. after 18, DA-11):**
1. A step lags → narrate the state chips, keep going.
2. Model or GitHub down → **verify-only replay** of a curated tuple (E17 or E01): fresh sandboxes run live with no model and no GitHub (12 §5.5). Say that it is a replay.
3. Sandbox host down → show the stored receipt from Rehearsal 3 and `verify-receipt` it live; say when it was produced.
4. The URL itself down → the labelled recording (§5).

**Optional honesty beat (DA-02),** if time allows or in Q&A: open the pre-run **E21** receipt (a new-style issue with no fix known): **REPRODUCED · medium**, "no fix commit to compare against". This is what a brand-new issue looks like.

**Rules:**
- Never start a new run after 2:00 (a replay may start until 2:15).
- Never type URLs; use the curated picker.
- Never SSH on stage.

---

## 2. One-minute submission video storyboard (≤ 60 s, G-07)

- **Built-at-event only (G-03).** Every frame shows our UI or CLI, or it is labelled infrastructure: the Vultr console and the GitHub page get the caption "infrastructure: Vultr / GitHub".
- **No upstream (OpenBot/OpenMuse) UI appears.**
- **Capture:** screen recording from the deployed URL during the **Sun 08:00–09:00 PDT** slot, which is a hard slot (00 §10, 18 C5; 15 §1). If the live stack misbehaves then, record a verify-only replay rather than slipping the slot. Speed up waiting sections (with a "2×" / "4×" badge) and don't cut out failures dishonestly.
- A burned-in timestamp is shown in a corner.

### 2a. Core cut (no NetBird)

| # | Time | Shot | Caption on screen | Built at event? |
|---|---|---|---|---|
*(Order rev. after 18, DA-18: untrusted input and the retry loop first, the fresh re-run second.)*

| 1 | 0:00–0:05 | Title card over the Runs list | "Repro Receipts: run untrusted bug reports safely, get a signed verdict" | yes |
| 2 | **0:05–0:20** | **Containment moment:** the hostile **issue PoC** (shown in the untrusted-input frame) → `limit.hit pids` → `tripwire` → **"CONTAINED: policy violation"** → "destroyed at T" → "host healthy, sentinel unchanged" → next run starts OK | "Untrusted issue PoC: rm -rf ~ + fork bomb + credential theft + metadata probe + exfil → contained" | yes (the fixture is ours) |
| 3 | 0:20–0:27 | Pick a real issue → plan panel with the Vultr model id | "Agent plans on Vultr Serverless Inference" | yes |
| 4 | 0:27–0:35 (4×) | Sandbox A: pytest fails, **stderr fed back**, the agent rewrites and retries | "Writes a repro inside a gVisor sandbox · separate VM · no keys" | yes |
| 5 | 0:35–0:45 | Fresh no-network sandboxes B/B/C/D → **REPRODUCED · high** or **ALREADY_FIXED · high**, observed vs claim, frozen script with gate `pass` | "Re-executed fresh: this script fails at the reported commit, passes at the fix" | yes |
| 6 | 0:45–0:52 | Terminal: `verify-receipt` OK → one-byte tamper → FAIL | "Signed receipt anyone can verify" | yes |
| 7 | 0:52–0:57 | Approval card with hash → Approve → comment on `ror-demo-target` | "Only outward action: human-approved exact comment, our own repo" | yes |
| 8 | 0:57–1:00 | End card: repo URL, demo URL, "Built at the event: see README feature map" | — | yes |

### 2b. With NetBird (only if tier ≥1 is actually working at freeze)

Compress shots 3 and 5 by 5 s each, and add:

| # | Time | Shot | Caption |
|---|---|---|---|
| 2b | +10 s after shot 2 | **Zero-ports moment:** Vultr firewall group for the app VM with 0 inbound rules → load the public URL → NetBird auth prompt (tier 2) → (tier 3 only if built) a per-run URL going dead after its run | "App VM: zero inbound ports. NetBird VM is the only public entry (80/443/3478)" (14 §2, D-12) |

If the result runs over 60 s, drop shot 6 before shot 2b. **Never drop shot 2 (containment).**

---

## 3. Expected judge Q&A

1. **"Isn't this just Astro's triagebot, or CI?"**
   - Triagebot proves the demand: it reproduces issues and cut Astro's open issues from about 200 to 30. Its LLM verify step also judges bug-vs-intended, which we deliberately don't.
   - **Stage-safe sentence (00 §3, 18 §A1, verified at `51d30da`):** "triagebot runs repro commands on the same runner that holds its write token and model key; we run them in a secret-free, egress-limited sandbox on a separate VM and re-execute them fresh." Its verification is another model call, and it posts without human approval.
   - **Don't say** its keys are "in the sandbox env" (the agent shell's env is allowlisted; the keys sit in the parent process on the runner), and don't say it "runs in isolation" (18 V1).
   - Our difference is the boundary and the evidence:
     - the untrusted code runs on a VM with no secrets;
     - the verdict comes from fresh sandboxes re-running a frozen script with egress sealed;
     - the result is a signed receipt anyone can re-check;
     - posting needs a hash-bound human approval.
   - CI runs *your* code on trusted triggers. We run a *stranger's* code on demand.
   - *(Confirmed from source at SHA `51d30da`, 18 §A1. Re-check the SHA is still current on the morning of the demo.)*
2. **"gVisor isn't a VM."**
   - Correct. gVisor is a user-space kernel, so an escape needs a gVisor bug plus a host-kernel bug.
   - We don't rely on it alone. The sandbox host is a **separate Vultr VM** that holds no keys, so an escape lands on a machine with nothing to steal.
   - Egress is proxy-only, and the metadata service is dropped.
   - The next tier, microVMs on VX1 or a throwaway VM per run, plugs in behind the same supervisor API (13 §4).
3. **"What did you build today?"**
   - All of it: UI, API, agent loop, verifier, verdict rules, receipt format and signer, supervisor, egress proxy with seal latch and tripwires, fixtures, eval set.
   - We ported *patterns* from two MIT repos (hash-bound approvals, leases, container flags) and credited them in `ATTRIBUTION.md`, with no code copied unless listed in `THIRD_PARTY_NOTICES`.
   - The repo's first commit is after 11:30 PDT Saturday, and the README has a feature map.
4. **"Why should a maintainer trust the receipt?"**
   - They shouldn't have to trust *us*. The receipt pins the image digest, commit SHAs, script hash, exact commands, exit codes and log hashes, and it includes a re-run command for their own machine.
   - `verify-receipt` checks the signature and recomputes the verdict.
   - What it doesn't prove, and we say so in the README: that our sandbox host didn't lie, or that it's the *same* bug the reporter meant. That's why confidence is `high` only when a known fix commit passes; with no fix known, the best a new issue gets is `medium`.
   - The re-run command is two steps (fetch with network on your host, then `docker run --network none`), and we tested it from a clean laptop.
5. **"Is this an AI-slop detector?"**
   - No. Plenty of AI-found bugs are real, and plenty of rejected reports describe real but intended behaviour.
   - We answer "does the claimed behaviour happen at this version, and does the fix make it stop?". "Is it a bug?" stays with the human; that's why the UI puts "behaviour observed" next to the quoted claim.
6. **"What does it cost?"**
   - Two small Vultr VMs are about $0.06/hour (13 §7).
   - Model spend is capped at $0.25 per run. Our measured average on the eval set is ‹$X›/run and ‹N› calls.
   - Hard caps: 12 model calls, 5 attempts, $5/day globally.
7. **"What if the model fakes a repro, like `raise ValueError` in the test, or a script that checks the version?"**
   - A static gate on the frozen script rejects version sniffing (`__version__`, `importlib.metadata`), `exec`/`compile`, tracing hooks, monkeypatching the package, subprocesses and writes to our runner files. The script is shown on the receipt.
   - Fault locality: some frame on the raising stack must be real package code, byte-identical to a pristine checkout at that commit, with a matching function name, reached from the test. So a `raise` in the test file, or a `compile()` trick that fakes a package filename, doesn't count.
   - Assertion repros need a fix control: the fix commit, or HEAD, must pass.
   - A frozen hash stops the script changing between runs, and a conftest override is flagged INCONCLUSIVE.
   - The gate is a deny-list over Python, so it raises the cost of a lying script; it isn't a proof. That's why the receipt's claim is about the script, not the bug.
8. **"Prompt injection in the issue?"**
   - The issue is data. The model's only tools act inside a sandbox with nothing secret in it, it has no GitHub or approval tool, and it doesn't decide the verdict.
   - The worst an injection can do is produce a bad repro (INCONCLUSIVE) or touch a honeytoken (contained and labelled "CONTAINED: policy violation").
9. **"What if the repro legitimately needs the network?"**
   - Loopback always works: a repro that starts a local HTTP server or socket fixture runs fine in the no-network sandboxes, so HTTP-client bugs are in scope that way.
   - An *external* host is out of scope for verification: the verification sandboxes have no network at all, and any attempt marks the run INCONCLUSIVE with that reason.
   - For API-client libraries, an operator can opt in up to three allowlisted hosts for the authoring phase only.
   - We'd rather say "can't verify" than run unverified code with network access.
10. **"What stops a malicious PyPI dependency?"**
    - Nothing stops it running; that's the point of the product. It runs inside the same containment.
    - Build hooks run only in the authoring and prep sandboxes. The verification sandboxes install hash-locked wheels with no network, so a dependency can't phone home during verification or change between runs.
    - A dependency that builds a poisoned wheel can still distort a verdict. We contain packages; we don't vet them. That is stated as a residual risk.
11. **"Honeytokens can be avoided."**
    - Yes. They're sensors, not the boundary.
    - The boundary is no real secrets + gVisor + separate VM + egress allowlist + limits.
    - A careful attacker who avoids them still gets nothing and reaches nothing.
12. **"What happens if the GitHub post times out?"**
    - The state becomes `outcome_unknown`, which is terminal. We never retry automatically.
    - A read-only check looks for our hidden marker in the comments. A human creates a new proposal if needed.
    - Duplicate public comments are worse than a missing one.
13. **"How often does it actually reproduce?"**
    - On our curated set: ‹k›/‹n› REPRODUCED(high), ‹m› NOT_REPRODUCED, ‹p› INCONCLUSIVE, and **0 false REPRODUCED** on the synthetic negatives (measured ‹time›).
    - The literature says real-world rates are much lower (28% for Google's internal BRT), so INCONCLUSIVE is a first-class answer.
    - Our curated set is closed issues with known fixes; a brand-new issue with no fix reaches at most `medium` (E21 shows one).
14. **"Why is Vultr central, not just hosting?"**
    - The control plane on a Vultr VM plans, dispatches and verifies.
    - Sandboxes run on a second Vultr VM over a Vultr VPC.
    - Every model call goes to Vultr Serverless Inference, and startup refuses any other endpoint.
    - Artifacts and receipts live on Vultr.
15. **"Can a judge break it?"**
    - The judge account can start any curated issue, the hostile fixture, or a verify-only replay, and can read everything. It can't start arbitrary URLs and can never propose or approve a GitHub post.
    - Hostile input is exactly what it's built for. Try the hostile fixture; an operator can point it at any pure-Python issue.
16. **"Future potential?"**
    - Security triage for PoC-bearing reports.
    - Verifying coding-agent "all tests pass" claims, which is the same engine (Claim Court).
    - A GitHub App that attaches receipts to issues.
    - MicroVM tiers.
17. **"Isn't this just ClusterFuzz or syzbot?"** *(rev. after 18, DA-05)*
    - They're the prior art, and we say so. ClusterFuzz re-runs fuzzer testcases against the latest build daily and auto-closes fixed bugs; syzbot re-runs stored kernel reproducers on a tree or patch to check whether a bug is already fixed. Two-ref re-execution isn't new.
    - What they don't do: take a **natural-language, untrusted issue**, have a model **author** the reproducer, treat the report as **hostile code**, and gate the only outward post on a hash-bound human approval.
    - So our pitch is "syzbot-style verification for human- or AI-written issue reports, with the report treated as hostile code".
18. **"Does the receipt prove the bug is real?"** *(rev. after 18, DA-03, 18 V2)*
    - No. It proves **this frozen script fails at the reported commit and passes at the fix (or on HEAD) in fresh, secret-free, no-network sandboxes**.
    - A script can tell two commits apart for reasons unrelated to the claim. The static gate and fault-locality check make that harder, and we show the script so a human can read it.
    - Whether the behaviour is a bug or intended stays with the maintainer; the UI puts "behaviour observed" next to the quoted claim.

---

## 4. Reset steps between demos (about 3 min; `scripts/demo-reset.sh` + manual)

1. Cancel any non-terminal run from the UI, or with `demo-reset.sh --cancel-active`.
2. `scripts/preflight.sh` must show all green:
   - `/healthz` returns the version SHA;
   - the inference ping (one tiny call to the chosen model) succeeds;
   - supervisor `/v1/health` is OK;
   - **0** `ror.sandbox=1` containers;
   - the sentinel hash is unchanged;
   - disk is under 70%;
   - the clock skew is under 2 s;
   - no approval is in `executing`;
   - the daily $ cap has more than $2 left.
3. Close the stale run tabs and reopen the Runs list.
4. Start the **E17** run at T−5 min (§1).
5. **The demo-target issue:** the approval precondition compares the issue's state at proposal time, so earlier comments are fine. Don't edit the issue during the slot. If it was edited, create the new proposal after the edit.
6. Check the phone hotspot as the backup network, and have the recorded fallback file open, paused, on its first frame.
7. Log in the judge account on the phone, in case judges want to browse.

---

## 5. Recorded-fallback policy

- **Record it:** capture a full 3-minute run of the live script during the Sun 08:00–09:00 slot, and again after Rehearsal 3 if it's cleaner.
- **Label it:** burn a **"RECORDED · Sun Sep 27 ‹HH:MM› PDT"** watermark into every frame.
- **When to use it:** only if the live URL is down, or two consecutive live steps fail.
- **Say so:** switching must be spoken aloud: "The live system is having trouble; this is a recording from ‹time› today, labelled as such."
- **Never** present a recording, or an earlier run, as the current live one. The same rule applies to the earlier-run fallbacks in §1: each is a real run on the live URL, and we give its start time.
- **Afterwards:** go back to the live URL for Q&A if it recovers.
- **The submission video** is by definition a recording. Its speed-ups are badged, and it contains no mocked screens.

---

## 6. Submission checklist (G-01, G-03, G-05, G-07, C1-11, NB-04/05)

**Repo and docs:**
- [ ] Product repo **public** (STOP-AND-ASK before flipping). `gitleaks detect --redact` on the full history is clean.
- [ ] `README.md` contains:
  - the one-paragraph use case with evidence links;
  - **setup** (provisioning, `deploy.sh`, env and credential list without values);
  - an **architecture diagram** (two VMs, VPC, proxy, supervisor, Vultr Inference);
  - the threat summary and "what receipts do not prove", including the one-sentence claim "this frozen script fails at X and passes at Y in fresh, secret-free, no-network sandboxes" and never "proves the bug is real" (18 V2);
  - prior art: ClusterFuzz/OSS-Fuzz and syzbot (two-ref re-execution), triagebot-action (repro on the runner), with the stage-safe triagebot sentence (18 V1) and Pallets cited as "13 issues + 75 PRs" (18 V3);
  - the demo URL;
  - **judge credentials (judge role only)**;
  - the eval results table;
  - known limitations and waived tests;
  - the models used;
  - the Vultr products used.
- [ ] README **feature map, inherited vs new** (17 §4 filled in). Every beat shown in the video is marked "built at event: yes" or labelled as infrastructure/config.
- [ ] No ported pattern is described as "tested upstream" in README or ATTRIBUTION: 07/08 read upstream tests but never ran them (18 DA-16, rev. after 18).
- [ ] `ATTRIBUTION.md` (pattern table P1–P13 with pinned permalinks) and `THIRD_PARTY_NOTICES.md` (COPY rows or "none", license-checker + go-licenses output, base image digest, services).
- [ ] The public receipt key is in the README, and `/.well-known/ror-receipt-key.json` is live.
- [ ] The tag `demo-freeze` SHA equals `/healthz` `version` and the receipts' `control_plane.version`.

**Demo URL and video:**
- [ ] The demo URL loads logged-out on a phone (TLS valid). The judge login works.
- [ ] Video ≤ 60 s, public or unlisted, tested in incognito. It **contains the containment moment**, and the zero-ports moment only if NetBird was built.

**Form and final checks:**
- [ ] Submission form fields:
  - team name and members (all have CV accounts);
  - GitHub URL;
  - video URL;
  - project website = the demo URL;
  - description stating Challenge 1, the NetBird tiers claimed (or none), the Vultr products used, the model ids, and "built at the event; patterns credited".
- [ ] Submitted by **11:30 PDT (Mon 00:00 IST)**, with a confirmation screenshot saved. Hard deadline 12:00 PDT.
- [ ] After judging: teardown per 15 §1.1.
