> **Historical plan — superseded for product choice and build scope.** Read [35-AIRLOCK-MAIN-CHALLENGE.md](35-AIRLOCK-MAIN-CHALLENGE.md) for the current main-challenge project and [34](34-main-challenge-evidence-and-decision.md) for the evidence and corrections. Do not execute this older plan as the current brief.

# 25 — WIN PLAN (authoritative; supersedes 00 §9–§11, 16 and 21 where they conflict)

> **Superseded on the choice of project (Sat, Fable judge panel):** the pick is now **Dress Rehearsal on a Vultr twin**. See [27-final-pick-judge-panel.md](27-final-pick-judge-panel.md). The gates and vetoes below still apply; Repro Receipts (PoC-only mode) is the fallback.


Written Sat 2026-09-26, about 07:00 PDT, before hacking starts (11:30 PDT). No product code exists; per the rules, none is written before 11:30.

**Inputs:**
- 20 judge intel
- 21 wow options
- 22 feasibility lab (real experiments)
- 23 customer validation
- 24 Fable 5.1 devil's advocate (the adversarial final say; its vetoes are adopted)

## 1. The idea in one breath
**Repro Receipts: "Run a stranger's code. Get a receipt."**

- **What happens:** untrusted bug reports and PoCs run in secret-free, egress-limited gVisor sandboxes on a separate Vultr VM. A Vultr-Inference agent writes a minimal repro and iterates on stderr.
- **How it's verified:** the repro is frozen, statically gated, and re-executed fresh **with no network** at the reported commit, the fix and HEAD.
- **What you get back:** a signed receipt with a re-run command anyone can use.
- **The only outward action:** a comment a human approved byte-for-byte.

**Who pays:** security/platform teams that triage bug-bounty and VDP reports. HackerOne programs paid $81M across about 1,950 programs (EV-V, 23). Maintainers get it free (GitHub App, free for public repos). Precedents: Socket, Sentry Seer, HackerOne validation (23).

**Why it wins this panel (20):**
- **Vultr DevRel:** they see real use of their products: two VMs + VPC + zero-inbound firewall + Serverless Inference with tool calls + measured $/verdict.
- **NetBird DevRel:** they see a zero-trust mindset.
- **CMO / CV founder in the finals:** they get a named buyer and a four-beat story.

## 2. What changed after the Fable review (24)
| Was (21) | Now | Why |
|---|---|---|
| Public QR "Blast Wall" as centrepiece | **Cut.** The audience moment moves to Q&A: a judge types a payload on our laptop into the model-free PoC-only lane (20 s TTL, no egress) | Each card ran the full model loop, so the queue would outlive the slot. It also drifted toward a refusal montage and "dashboard as main feature" (FDA-01, V4) |
| "1,200 agents escaped" hook | Little-CMS verbatim hook + raised-hands question. The July incident is mentioned **without a count** | The count had no evidence row (FDA-02) |
| Pivot = Exactly-Once / Ship Gate | Pivot = **PoC-only mode** (run the reporter's fenced code verbatim; the model emits only `expected_failure`). Ship Gate only if both modes fail | 100% engine reuse. 22 shows each hero issue reproduces from a 2–5 line test |
| NetBird Agent Network | **No-go** unless 4 people, core frozen, and organizer confirmation | It puts a non-Vultr base URL in the inference path (rule risk). Marketplace support is unverified (FDA-11) |
| "Vultr's guide leaves a gap" | Say "we built on Vultr's sandboxing guidance and default-deny egress" | Don't insult the judge who wrote it |
| "Signed receipt proves it" | "Signed = tamper-evident. **Independent** = you can re-run it yourself; the command is on the receipt" | Signing on our own host is not independence (24) |

Scores:
- **Fable:** this package R1 7.48 / R2 7.38; next best 6.85.
- **21:** 8.10, judged inflated by about 1.3.
- **Prior reviewer:** 7.10.

All three rank it first.

## 3. The demo that must work (3:00, four beats)
Beats and fallbacks as in 24 §4. The short form:

1. **0:00–0:20 Hook.** "Raise your hand if you've run a stranger's PoC on your own laptop to check a bug." Then the Little-CMS maintainer quote.
2. **0:20–1:05 The chamber (containment moment).** A hostile issue (E16) runs: its PoC does `rm -rf ~`, a fork bomb, a metadata read, a honeytoken read and exfiltration.
   - Card: gVisor + pids limit → tripwire → **CONTAINED: policy violation** → sandbox destroyed → "host healthy, sentinel unchanged".
   - Then **Replay incident**: 4 vectors, each naming the layer that stopped it.
3. **1:05–2:10 Real work.**
   - Live: humanize#333, where `naturaldelta(inf)` raises OverflowError. Show the plan on `glm-5.3` via `api.vultrinference.com`: attempt 1 fails, stderr is fed back, attempt 2 lands.
   - Then the pre-started E17 on our own `ror-demo-target`: **REPRODUCED (high)**. B/C/D ran "no network since creation", with the static gate passing and the cost on the receipt.
4. **2:10–2:45 Receipt + approval.** `verify-receipt` passes → flip one byte → fails. Draft comment → hash + expiry → Approve → the comment lands on our own demo repo.
5. **2:45–3:00 Close.** Buyer; "100% Vultr: VMs + Serverless Inference"; measured $/verdict; "Built today."

Rules:
- **Never present a recording as live.** The live fallback is **verify-only replay** (a stored frozen tuple re-run in fresh sandboxes, no model or GitHub), labelled on screen.
- **Demo fixtures:**
  - hero issues E01 (humanize#333), E10 (marshmallow#2891) and E04 (tabulate#365), with E07 as backup;
  - ALREADY_FIXED showcases E02 and E09;
  - NOT_REPRODUCED from E01/E02 run at the fix ref;
  - REPRODUCED from E17, our planted `ror-demo-target`, **created after 11:30**.

## 4. Must-build list (stop anywhere below the line and you still win-capable)
1. K1 inference probe (`scripts/probe_inference.sh`) + K3a model-only spike.
2. Sandbox host:
   - gVisor from apt;
   - egress proxy (PyPI/GitHub allowlist, metadata/RFC1918/IPv6 denied);
   - tripwires;
   - supervisor (create/exec/copy-out/destroy);
   - **two VMs, no secrets in the sandbox**.
3. Hostile-issue fixture → CONTAINED end to end, host sentinel unchanged.
4. Verifier: freeze → AST gate → hashed offline installs (22's recipe) in B at the reported ref and D at HEAD (C at the fix ref if known) → pure verdict function → ed25519 receipt + `verify-receipt` CLI.
5. Verify-only replay + pre-built wheelhouses for the demo issues.
6. Minimal UI: Run page with live SSE cards + Receipt page; curated picker; password login for judges (skip sign-up).
7. Two-step re-run command, tested from a clean laptop.

**— line: items 1–7 = a winning demo —**

8. Approval-gated comment to our own demo repo.
9. "Replay incident" montage (4 vectors), only after item 3 passes.
10. Per-verdict cost on the receipt.
11. NetBird tiers 1–2, only if a domain exists by 13:30 and a 4th person is free.
12. Throwaway Vultr VM tier, only if measured boot is under 60 s.

**Cut first:** public QR wall; NetBird Agent Network and tier 3; microVM/VX1; fix-ref C (keep B + D, cap at medium); approval flow; hardened locality; multiple live repros.

**Team size:**

| Team | Scope |
|---|---|
| Solo | items 1–7, PoC-only mode from the start |
| 2 people | 1–9 |
| 3 people | 1–10 |
| 4 people | 1–11 |

## 5. Engineering landmines already found (22, 18): build these in from the start
- Tarball builds need `SETUPTOOLS_SCM_PRETEND_VERSION`. Reproducible wheels need `SOURCE_DATE_EPOCH`.
- **Pin the Python interpreter and require at least 1 test collected.** Otherwise a lock/interpreter mismatch produces a false FAIL on fixed refs.
- When the package under test is also a pytest dependency (for example `packaging`), exclude it from the dependency lock.
- Run pytest from a clean cwd.
- Default branches vary (master, dev, main), so resolve them via the API.
- Offline `--require-hashes --no-index --no-deps` installs worked in 30/30 cases. A single verification sandbox took 0.55 s with uv; the full non-LLM pipeline took 13–20 s per issue (native macOS; **container overhead not yet measured**).
- The receipt proves *this frozen script behaves differently at these refs*. Never claim "the bug is real" or "this is a bug and not intended". Two curated cases (cachetools#395, packaging#1154) show why: the correct verdict is INCONCLUSIVE, and our first eval draft got them wrong.

## 6. Go / no-go clock (PDT; IST = +12:30)
| Time | Gate | If missed |
|---|---|---|
| Sat 12:15 | Inference key redeemed; one forced tool call parsed | Escalate to organizers; shift K3a +1 h |
| Sat 14:00 (≤15:00) | K3a: ≥3/6 fail-before/pass-after → **authoring mode** | 1–2/6 → **PoC-only mode**. 0/6 and PoC-only fails on E01 → Ship Gate |
| Sat 17:30 | K3b headless end-to-end on ≥3 issues through real supervisor + proxy | Cut C, approvals and hardened locality now |
| Sat 20:00 | Hostile fixture CONTAINED on the deployed stack | All hands on it until green; it is the mandatory beat |
| Sun 02:00 | Items 1–7 done | Freeze scope at what passes T-01/T-02/T-28 |
| Sun 07:00 | Feature freeze | — |
| Sun 08:00–09:00 | Record the ≤60 s video (containment shot first) | — |
| Sun 09:00 | Rehearsal 1 measures replay wall-clock | Over 60 s → pre-create sandboxes |
| Sun 11:30 | **Submitted** | At 11:00, submit what's green; start no new fixes |

## 7. Presentation (Chan's order, compressed to four beats + Q&A)
**Problem, then solution.** The hook and the chamber.

**Real work.** The live beat.

**Validation.** The venue kit in 23, run Saturday afternoon by the pitch person:
- 5 questions, tally sheet, consent line.
- Show **only real tallies**, for example "N people at the venue: X/N have run a stranger's PoC locally".

**Business model and future.** The close slide.

**Q&A:**
- Hand the operator laptop to a judge for the PoC-only lane.
- Prepared answers in 16 §4 + 21 §8 + 24: "isn't this CI/syzbot/triagebot?", "gVisor isn't a VM", "the PyPI allowlist is an exfil path → nothing in the sandbox is secret", "who signs the receipt?", "what did you build today?".

**Dress to be remembered; never say "we didn't have time".**

## 8. Before 11:30 PDT (allowed, no product code)
- Every teammate: create a CV account.
- One person: log in to the CV `/details` page or Discord and **replace the guessed judge list in 20**.
- Buy or confirm a domain only if you'll attempt NetBird tiers 1–2.
- Read 19 (handoff prompt) plus this file. Assign owners by team size (§4).
- Prepare the interview tally sheet (23).
