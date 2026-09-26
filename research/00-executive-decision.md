> **Historical plan — superseded for product choice and build scope.** Read [35-AIRLOCK-MAIN-CHALLENGE.md](35-AIRLOCK-MAIN-CHALLENGE.md) for the current main-challenge project and [34](34-main-challenge-evidence-and-decision.md) for the evidence and corrections. Do not execute this older plan as the current brief.

# 00 — Executive decision

> **Superseded in part (Sat 07:00 PDT):** read [25-WIN-PLAN.md](25-WIN-PLAN.md) first. After the Fable 5.1 review (24), the demo, pivot rule (now PoC-only mode) and cut list there override this file.


Decided 2026-09-26 (IST). The event runs in America/Los_Angeles. Hacking is Sat Sep 26 11:30 → **Sun Sep 27 12:00 PDT** (Mon Sep 28 00:30 IST), about 24.5 h. Sources: 01-rules-and-compliance.md and the CV event record.

This is a recommendation, not a verified product. Nothing here has run on Vultr yet. Kill tests K1, K2 and K3a/K3b decide whether it survives first contact; K3a alone decides the pivot (§9).

## 1. What to build
**Repro Receipts**: a web app on Vultr. It takes an untrusted bug report (a public GitHub issue URL) and returns an **independently re-executed reproduction verdict with a signed receipt**.

- An agent (Vultr Serverless Inference) writes a minimal reproduction inside a disposable, egress-limited, secret-free gVisor sandbox.
- A separate verifier then re-runs the frozen script in fresh sandboxes at two refs:
  - **(a) the reported version:** does the behaviour occur?
  - **(b) latest `main`:** does it still occur, or was it already fixed?
- Hostile reports (PoCs that try to wipe disks, fork-bomb, read the metadata service, use planted honeytoken credentials or phone home) are contained and labelled **HOSTILE** internally, and **"CONTAINED: policy violation"** on every public surface (DA-13; rev. after 18).
- The only outward action is a draft GitHub comment. It is posted only after a human approves that exact text (hash-bound, expiring).

## 2. For whom
Maintainers and triagers of small-to-mid OSS libraries facing a rising volume of plausible, often AI-written issues. The secondary persona is a security triager handling PoC-bearing reports.

## 3. Strongest evidence
- **Current volume pain, all from the last 30 days:**
  - Pallets labelled 88 items "rejected AI" in 30 days, against 45 the previous month. **13 of the 88 are issues and 75 are PRs** (18 §A2), so cite it as "13 issues + 75 PRs".
  - 3DTilesRendererJS describes a "wave of… AI-generated issues with no repros and false reports" (EV-R-0003).
  - The Little-CMS owner hand-ran an AI PoC that didn't crash (EV-R-0004).
  - An OSS policy rejects unreproduced reports (EV-A-0039, 2026-09-24).
  - GitHub shipped anti-spam issue and PR limits in June 2026 (EV-R-0007/0008).
- **Independent execution beats model judgement:**
  - LLM judges approved broken generated tests that Docker showed broken 61.9% of the time.
  - About 1 in 5 "solved" SWE-bench patches are wrong.
  - Agent/grader shared environments are gameable (BenchJack) (05, EV-P).
- **The market's closest tool shows both the demand and the boundary gap:** withastro/triagebot-action, read at SHA `51d30da` (18 §A1), reproduces issues automatically (Astro reports its open issues falling from about 200 to 30). Its repro commands run directly on the GitHub Actions runner with unrestricted network, not in a sandbox. Its write token and model key live in the parent process on that same runner (not in the agent shell's env). It has no fresh-sandbox re-execution, no receipt, and posts without human approval. **Stage-safe sentence:** "triagebot runs repro commands on the same runner that holds its write token and model key; we run them in a secret-free, egress-limited sandbox on a separate VM and re-execute them fresh."
- **Prior art we must acknowledge (18 DA-05):** ClusterFuzz and syzbot already re-run reproducers on latest and fix commits at production scale for *fuzzer-generated* crashes. Our position is "syzbot-style verification for untrusted human/AI issue text and PoCs", which is a stronger boundary plus packaging, not a new capability.

### Counterevidence we accept
- Security-bounty slop was solved by policy (curl, EV-S-0001, EV-R-0011).
- Pallets rejects by origin, not validity.
- Many disputes are "is this intended?", not "does it happen?".
- Small libraries fix clear reports the same day.
- Only about 51% of reports contain steps (03c).

So we pitch **a safe boundary for running untrusted, PoC-bearing reports, plus independently re-executed receipts**, never "we detect AI slop". INCONCLUSIVE is a first-class outcome.

The receipt proves *this frozen script behaves differently at these refs*. It never proves "the bug is real" or "it is a bug rather than intended" (18 DA-03). Recent firsthand pain is mostly outside Python (JS, C, Java; 18 DA-06), so we describe the runner as language-agnostic in design and Python in the MVP.

## 4. Why this wins over alternatives
- **Scores:** our model gives 7.25 in both rounds after Creativity was corrected to 5 (see 10). The independent reviewer's numbers are 6.50 as written and 7.10 / 7.00 once conditions C1–C6 are met (18 §D). Runners-up are Exactly-Once Submitter (6.40) and Evidence Clerk (6.35) on the reviewer's scale. **The lead is narrow and depends on demo reliability.**
- **Containment is the product here:** the input *is* attacker-controlled code, so the "containment moment" the challenge requires is a natural part of the workflow rather than a staged stunt.
- **Verification is deterministic:** exit codes, failure-signature match and cross-ref comparison. The model never judges success.
- **Demo inputs are public:** 10 curated pure-Python issues with linked fixes (03c). No customer secrets or logins are needed.
- **It avoids Vultr's crowded starter ideas and every banned category.**
- **Sensitivity:** if Live demo drops by one point, Evidence Clerk overtakes (7.10 vs 7.20). Demo reliability is therefore the thing to protect.

## 5. What is reused
**Patterns, not code**; neither upstream app is deployed. Both OpenBot (MIT @3c73cf0) and OpenMuse (MIT @205cc38) *require* the closed, hosted CopilotKit Intelligence service at startup (07, 08). That conflicts with "Vultr-central" and can't be removed in 24 h.

Ported patterns, with citations in 09:
- **From OpenMuse:** hash-bound expiring approvals with atomic SQL claim; the `outcome_unknown` state that is never auto-retried; task leases with heartbeat; hardened container flags.
- **From OpenBot:** the supervisor's container hardening (CapDrop ALL, no-new-privileges, pids limit); deny-before-allow policy evaluation; audit row written before the action; server-side agent loop (inverting OpenBot's browser-mediated tools).

## 6. What is original (built at the event)
- The entire application: UI, API, agent loop, supervisor daemon, egress proxy policy, and the multi-ref verification protocol (reported, fix if known, HEAD; fresh no-network sandboxes; rev. after 18). The re-execution idea itself is prior art (ClusterFuzz/syzbot, §3).
- The HOSTILE classifier (tripwire and honeytoken events plus policy violations), the receipt format and signer, and the approval-bound GitHub comment executor.
- The curated evaluation set and the demo fixtures.

See 17 for the attribution plan and the inherited-vs-new feature map.

## 7. Exact Vultr execution path
```
Browser ─TLS─▶ Control-plane VM (Vultr, public 443 or NetBird)
                 ├─ API + UI + agent loop + verifier + SQLite
                 ├─▶ Vultr Serverless Inference (api.vultrinference.com/v1): plan, write repro, summarise
                 └─▶ (VPC only, token auth) Sandbox-host VM (Vultr)
                        └─ supervisor daemon ─▶ Docker + gVisor runsc containers
                              └─ egress proxy: PyPI + GitHub only; metadata/RFC1918/VPC denied
Artifacts ─▶ control-plane disk or Vultr Object Storage (signed, expiring URLs)
```
- The inference key and GitHub token exist only on the control plane.
- The sandbox host has no secrets beyond its supervisor token.
- Models are provisional (13): `glm-5.3` for the planner and repro writer, and `qwen3.8-flash-next` for the fast loop, appending `-normalize`. Structured output comes from a forced tool call, because JSON mode is not available.

## 8. Hardest unresolved issue
Whether a Vultr-hosted model writes a correct minimal repro within 3–5 execution-feedback iterations on real issues. The literature gives 28% on real internal bugs (Google BRT) and is not transferable. The Vultr inference probe has **not** been run (no key yet), so tool-call streaming and the `-normalize` behaviour are unverified.

## 9. First feasibility test (run in the first 90 minutes of hacking)
0. **K3a (model-only, hours 0–2.5; decides the pivot, per 18 DA-10):**
   - The Vultr model writes repro scripts for the 6 curated issues.
   - Each script runs in plain `docker run --network none` against a pre-installed checkout on any VM, with no supervisor, proxy or UI.
   - **Go** if ≥3 of 6 fail at the before-ref and pass at the after-ref.
   - The infrastructure path (K2 → K3b) proceeds in parallel.
1. **K1 (inference):** run `raw/vultr/probe_inference.sh` against the chosen models. It needs working multi-step tool calls.
2. **K2 (sandbox):** on a Vultr VM, run a `runsc` container. It must `pip install` via the proxy, fail to reach `169.254.169.254` and arbitrary hosts, and be stopped by the pids limit and the wall-clock kill.
3. **K3b (by about hour 6):** the same run through the real supervisor, sandboxes and egress proxy.

**Pivot rule:**
- If K3a fails because repro *authoring* is unreliable → **Exactly-Once Submitter**. It has the lowest model dependence and the most deterministic demo (18 §F).
- If K3a passes but infra lags → cut scope (no C/D refs, no approvals UI) rather than pivot.
- Claim Court stays an option only if the team values engine reuse over demo reliability.

## 10. MVP cut line
**In:**
- Python + pytest only.
- One sandbox host.
- Password login for 2–3 roles (maintainer, viewer/judge).
- Issue-URL input.
- Live event stream (SSE).
- Multi-ref verification: reported ref, fix ref if known, HEAD always (rev. after 18).
- Hostile issue-PoC containment demo.
- Signed JSON receipt and receipt viewer.
- Approval-gated GitHub comment. Post to **our own demo repo only**, never a third-party repo.
- **Conditions from the review (18 §F):**
  - a HEAD run plus an ALREADY_FIXED verdict (DA-01);
  - locked, hashed installs with no network in the verification sandboxes (DA-08);
  - an AST static gate on the frozen script, plus a hardened fault-locality rule (DA-03/04);
  - a **verify-only replay mode** that re-runs a stored tuple with no model and no GitHub (DA-11);
  - the hostile input is an **issue PoC**, not a hostile `setup.py` (DA-07);
  - a working two-step re-run command on the receipt (DA-09);
  - the public label is "CONTAINED: policy violation", never HOSTILE in a comment (DA-13);
  - two separate VMs as a hard gate (DA-17);
  - the video is recorded by **Sun 08:00–09:00 PDT**.

**Out:**
- Other languages.
- Multi-tenant orgs.
- Webhooks and auto-triage of every new issue.
- microVM tier.
- Human takeover of the sandbox shell.
- Fix generation.
- NetBird tier 3 (optional, only after the core is frozen; see 14).

## 11. What would change the recommendation
- K3a < 3/6 → **Exactly-Once Submitter** (reviewer's recommendation), or Claim Court if engine reuse matters more.
- Vultr inference can't do multi-step tool calls on any model → a single-shot forced-tool-call repro writer. If that also fails, choose a concept with less model dependency: **Exactly-Once Submitter** (F-alt).
- The team wants a browser pattern and has ≥3 people → **Evidence Clerk** (F2).
- An organizer clarification that a policy block before execution counts as the containment moment makes no difference; ours executes the hostile code *inside* the sandbox, which satisfies either reading.
- Discovering that triagebot-action (or another tool) already keeps secrets out of the runner *and* independently re-executes → drop the "boundary" claim and lead with the two-ref receipt only (Creativity −1).
