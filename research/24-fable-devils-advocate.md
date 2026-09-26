# 24 — Devil's advocate II: will "Detonation Chamber" win?

Reviewer: independent, adversarial (Fable 5.1). Written Sat 2026-09-26 ~07:00 PDT, before hacking starts. Files read: 00, 18, 20, 21, 22, 23, 12 §5, 15 §1–§2.6, 14, 10, 13 (grep), 16 §1, 01 (grep), 06-competitive §2–4, 06-meta (grep). Spot-checked: `evidence-r.jsonl` EV-R-0004, `experiments.jsonl`, `checkpoint.json`, `.firecrawl/judges/vultr-msb.md`, `.firecrawl/judges/nb-2026-july-newsletter.md`, `raw/problems-a/…theguardian…escaping….md`, 04 §timeline.

## 0. Verdict in one paragraph

Keep the **engine** (Repro Receipts: untrusted issue → sandboxed authoring on Vultr → frozen script → fresh no-network re-execution at 2–3 refs → signed receipt → approval-gated post). It is the best-validated thing in this folder (22 measured 8/10 curated issues deterministic at 13–20 s non-LLM). **Do not ship the public QR "Blast Wall".** It is the single biggest new demo risk in 21, it costs +6–9 h nobody has, it drifts toward the banned "dashboard-as-main-feature" and the challenge's own warning ("an agent that only chats is a demo"), and its "appears on the wall within seconds" claim is false as specified (every audience card runs the full model-driven author loop, concurrency cap 2, ≤900 s TTL). Replace it with a **scripted, operator-driven containment montage (≤45 s)** plus **one judge-chosen payload in Q&A**. 21's 8.10 is inflated by ~1.3 points; my honest number for the package below is **R1 7.48 / R2 7.38**, which still leads every alternative in this folder by ≥0.6.

---

## 1. Findings

Severity: **blocker** = fix before build/pitch · **major** = moves a rubric point or a safety claim · **minor** = cleanup.

| ID | Sev | Claim (where) | Evidence | Required change |
|---|---|---|---|---|
| FDA-01 | **blocker** | Audience cards "appear on the wall within seconds" (21 §2 A, §5 0:20–0:45) | Each submission is "treated exactly as an untrusted issue" and "drives the agent" (21 §4), i.e. Phase 1 authoring: ≤5 attempts, ≤12 LLM calls, 900 s TTL (12 §5). Worker concurrency cap is **2** (15 C-03). Ten scans → a queue that finishes after the slot ends. Vultr tool-call latency is unmeasured (13: "Tool-call quality is unmeasured until the probe runs") | Either cut the public intake (recommended, §4) or make the audience lane **model-free**: run only a fenced code block verbatim in a `none`-egress sandbox with a 20 s TTL (the PoC-first step already exists, 12 Phase 1). That lane must never call inference |
| FDA-02 | **blocker** | Opening hook: "In July, **1,200 AI agents** escaped their sandbox and breached Hugging Face" (21 §2, §7 slide 1) | 04 §timeline: "Swarm count is reported inconsistently as about 700 or 1,200+ **[unverified]**". No evidence row in `evidence*.jsonl` carries the number. The Guardian raw scrape (Aug 29) never states a count | Say "a swarm of OpenAI eval agents escaped their sandbox and breached Hugging Face in July" with no count. Keep the two named causes only if you can cite the OpenAI post-mortem line on stage (04 §106–107 paraphrases it; "inadequate sandboxing / no log monitoring" is a paraphrase, not a quote) |
| FDA-03 | **major** | Self-score T8 C8 D9 F8 → 8.10 (21 §2 A) | Creativity jumped 5→8 for a *presentation* change on the same engine; 18 DA-05 set 5 for prior art and that is unchanged. Demo 9 assumes a live public intake, a model never exercised, and **six beats in 180 s** (wall, hostile PoC, authoring, verdict, verify+tamper, approve+post) on top of 16's already dense script. Judges retain three things | Use my re-scores (§2). Cut the run-of-show to four beats (§4) |
| FDA-04 | **major** | Blast Wall is "the show" (21 §1 bottom line) | 01 G-06: dashboard-as-main-feature is an anti-project; 01 line 83: "An agent that only chats is a demo; an agent that executes safely is a product." A wall of red CONTAINED cards is a refusal montage; 21 itself flags Variant E for "risk of a refusal-only demo" and then makes A = E + audience | The main event is the **real repro verdict on a real issue**. Containment is one beat (≤45 s), not the frame. Counter on screen shows *work done* ("N issues verified · $ per verdict"), with "0 escapes" as the secondary line |
| FDA-05 | **major** | Public QR intake is "safe by design" (21 §4) | It is safe for the *sandbox*. It is not safe for the *slot*: venue Wi-Fi, the public URL becoming a load test (an attacker in the room can enqueue 100 jobs from a laptop; per-IP limits don't stop NAT-shared phones), rendering attacker text to a projector, judges scanning instead of watching, and the operator kill-switch consuming D's attention. Also every card burns inference budget ($5/day global cap, 12) | Cut public intake. If a crowd moment is wanted, hand **one** judge the operator laptop in Q&A and let them type a payload into the hostile-fixture form (still runs in the sandbox, no public URL, no rendering of strangers' text) |
| FDA-06 | **major** | Pivot on K3a failure → **Exactly-Once Submitter** (00 §9, 18 §F, 21 §9) | Exactly-Once shares 0% of the engine, has the weakest pain (18) and a stretched containment story. Meanwhile the engine already has a **model-light mode**: PoC-first runs the reporter's fenced block verbatim (12 Phase 1); 22 shows every hero issue reproduces from a hand-written 2–5 line test. Authoring failure ≠ product failure | New pivot ladder: K3a <3/6 → **PoC-only mode** (the model emits only `expected_failure` via one forced tool call; the frozen script is the reporter's PoC wrapped in a pytest template). Only if *that* fails too → Ship Gate (D). Exactly-Once is off the table |
| FDA-07 | **major** | Verify-only replay is "the honest fallback" (12 §5.5, 16 ladder step 2) | True and good. But 16's ladder step 3 ("stored receipt from Rehearsal 3") and step 4 ("labelled recording") are what a judge will call pre-baked. Nothing in 15 §1 measures replay wall-clock on Vultr before Sun 09:00 | Rehearsal 1 (Sun 09:00) must log replay time for E17 and E01 on the deployed stack; if >60 s, pre-create B/C/D and only *exec* live. Never show a recording during the live slot; if the URL is down, show the terminal `verify-receipt --recompute` on a receipt produced that morning and say the timestamp |
| FDA-08 | **major** | Receipt "anyone re-verifies … without trusting our UI" (21 §2, §8 Q8) | The receipt key lives on the control plane that also computes the verdict. `verify-receipt --recompute` recomputes from artifacts *we* produced. A CTO judge: "you sign your own homework." What actually gives independence is the **two-step rerun command** (DA-09) and the pristine-tarball hashes | Stage wording: "Signed so it can't be altered after the fact; *independent* because the frozen tuple lets you re-run it yourself — here is the command." Never say "trustless". Mention Sigstore/transparency log as future |
| FDA-09 | **major** | Egress allowlist (pypi, files.pythonhosted, github, codeload) closes exfil (12 §5.3) | A and P have fetch egress. A malicious `setup.py` can encode bytes into request paths to those hosts. What limits damage is that **A holds nothing secret**: the repo is public, the honeytokens are fake, the inference key is on the control plane. Bandwidth is low (the attacker can't read PyPI/GitHub server logs) but nonzero | Q&A card: "Yes, the allowlist is an exfil channel. There is nothing in A worth exfiltrating: public source, planted honeytokens, no keys. The verification sandboxes have no network at all." Don't claim "no exfil" |
| FDA-10 | **major** | "We followed Vultr's VX1 Microsandbox guide, then closed the gap it leaves open" (20 §3 #3, §6 #7) | The guide (`.firecrawl/judges/vultr-msb.md` line 709–738) does verify `REACHABLE` by default. But the round-1 panel is the Vultr DevRel team that publishes that guide. "Your guide leaves a gap" is a bad opening with an API judge. Also `msb doctor` on VX1 is NOT RUN (EXP-V-09) and adds a second isolation stack to debug | Phrase it as "we started from your Agent Sandboxing guide and added default-deny egress and fresh re-execution". **Do not build the microVM tier.** gVisor on a separate VM is enough; say microVM is a drop-in behind the same supervisor API |
| FDA-11 | **major** | NetBird **Agent Network** in front of Vultr Inference is "the NetBird winner" (20 §4 #1) | Newsletter (raw line 38): "open source … self-hosted for the moment". Requires the self-hosted Marketplace image to be new enough (unverified, 20 §7), a domain by 13:30 PDT (14 §6), and a "Custom/OpenAI-compatible provider" pointing at `api.vultrinference.com` (unverified). Rule C1-02 says calls must "go through Vultr Serverless Inference": the upstream would still be Vultr, so it *probably* counts, but the client's base URL would be a NetBird address, which is exactly what a judge checks when you say "Vultr-only inference" (C-05 hard-pins `baseURL` and asserts it at startup, 15) | **No-go for Agent Network** unless the team is 4 people, the core is frozen by Sun 02:00, and an organizer confirmed at kickoff that a tunnel in front of Vultr inference still satisfies C1-02. Tiers 1–2 (zero inbound + password/SSO judge role) are fine with a domain. Never let a NetBird step touch the inference path in the runtime that is demoed |
| FDA-12 | **major** | Schedule (15 §1) assumes the inference key exists at 11:30 | Coupon "emailed after the opening ceremony" (01 line 139). Redemption + subscription creation is manual. K3a (the pivot signal) is blocked until then | The team lead redeems the coupon and creates the inference subscription **during** the ceremony. If no key by 12:15 PDT, K3a slips one hour and the pivot decision moves to 15:00; if no key by 13:30, the whole timeline shifts and §2.5 cut item 6–7 is applied pre-emptively |
| FDA-13 | **major** | 21 §2 A build cost "+6–9 h on top of the ~20 h core" | 15 §2.4: core alone is **68–108 person-hours**; productive capacity is 17/34/50/65 h for 1/2/3/4 people. The wall is affordable only for a 4-person team that is *already* green at Sun 02:00, which 15 itself calls "still over at the top of the range" | Wall (public intake) is cut for every team size. The scripted montage reuses the hostile fixture + SSE you already build; budget 1.5 h, and only after T-02 passes |
| FDA-14 | minor | Demo name "Detonation Chamber" | "Detonation" is malware-sandbox vocabulary (Joe Sandbox, Any.Run); it frames the product as refusal, feeds FDA-04, and undersells the receipt. Fine as the *beat* name | Product name stays **Repro Receipts**; the containment beat is called "the chamber" on stage. Low stakes; don't spend time on it |
| FDA-15 | minor | Little-CMS "developer time is too valuable to spend on war games" (21 §2 hook) | EV-R-0004 verbatim: "Please check AI-generated reports prior submit, developers time is very valuable to spend it in war games." Close, but the slide must quote it exactly, and the maintainer *did* run the PoC (no crash) | Quote verbatim with the issue number (mm2/Little-CMS#608, 2026-09-16) |
| FDA-16 | minor | Round-of-show says "seed the wall with 3 pre-queued attacks" (21 §5 T−5) | Pre-queued means pre-run. If any card on screen is from before the slot, say so, or a judge who asks "when did this run?" gets a bad answer | Every card on screen shows its start timestamp; the montage says "started 20 s ago" honestly |
| FDA-17 | minor | Per-verdict cost "≤$0.25/run" (21 §7 slide 2) | 13 estimates $0.017–0.069 per task at list prices; $0.25 is the *cap*. Quoting the cap as the price undersells | Print the measured cost from the eval run on the receipt; quote that number |
| FDA-18 | minor | Video ≤60 s vs 3-min live (01 D-06) unresolved | Not new, still open | Ask Q-02 at kickoff; record a 60 s cut regardless |

**Checked, no finding:** Vultr-centrality (all model calls to `api.vultrinference.com`, sandboxes on a second Vultr VM); the hostile beat being an *issue PoC* (DA-07 resolved); "CONTAINED: policy violation" public label; two-VM hard gate; the honesty beats in 16; 22's timings are measured and reproducible (30/30 deterministic); 23's stage-safe claims list is sound and I would use it as written.

---

## 2. Independent re-scores

R1 = .40T + .25C + .20D + .15F; R2 = mean. I score what a 2–3 person team plausibly *demos at 12:30 Sun*, not the design.

| Concept | T | C | D | F | R1 | R2 | Why |
|---|---|---|---|---|---|---|---|
| A · Detonation Chamber **as written** (public QR wall) | 7 | 7 | 6 | 7 | **6.80** | 6.75 | Demo 6: FDA-01/05 risks, six beats, untested model. Creativity 7: the audience angle is new, the engine isn't. Tech 7: the wall dilutes the tech story |
| **A′ · Repro Receipts + scripted chamber (my package, §4)** | 8 | 6.5 | 8 | 7 | **7.48** | **7.38** | Tech 8 only if the static gate, no-egress B/C/D and replay are shipped. Demo 8: four beats, deterministic fallback, one judge-driven payload in Q&A |
| E · Blast Radius Live | 7 | 7 | 7 | 6 | 6.85 | 6.75 | Refusal montage; weak "useful work" |
| B · Repro Badge | 7.5 | 5.5 | 6 | 8 | 6.78 | 6.75 | Best business story; GitHub App callback live is fragile; badge is a slide, not a gasp |
| C · PoC Detonator | 7.5 | 6 | 5.5 | 7.5 | 6.73 | 6.63 | Real PoCs live = unpredictable; synthetic PoCs = "so it's staged" |
| D · Ship Gate | 7 | 5 | 7 | 7 | 6.50 | 6.50 | Crowded (Canary/Opslane et al.); reads as CI |
| Exactly-Once Submitter | 7 | 4.5 | 8 | 5 | 6.28 | 6.13 | Deterministic, but no engine reuse, no attack, textbook idempotency |
| Evidence Clerk | 7 | 6 | 5 | 7 | 6.35 | 6.25 | Login + seeded app + live browser |

Against 30–80 teams: most Challenge 1 entries will be "chat + Docker exec + a run log", several will follow the Microsandbox guide verbatim (20 §3), and a few will be polished E2B clones. A′ beats those on Technicality (independent re-execution, no-network verification, gate, receipt) and on the one thing the rubric rewards twice (a containment moment that is *part of the workflow*). It loses Creativity to whatever team does something visually wild; accept that and win R1 on Tech + Demo. Finals are equal-weighted and BD-heavy (Cochrane, Porollo): the receipt-as-case-study story (23 §2) carries there.

---

## 3. Vetoes

- **V4 (demo veto):** no public URL accepting arbitrary input from the room during the judged slot. Operator-typed payloads only.
- **V5 (claim veto):** no "1,200 agents" or any swarm count; no "proves the bug is real"; no "trustless" or "tamper-proof" receipt; no "no exfil" claim for sandbox A.
- **V6 (scope veto):** no Microsandbox/microVM tier, no NetBird Agent Network in the inference path, no Vultr throwaway-VM-per-run unless the core is green at Sun 02:00 *and* boot latency was measured <60 s.
- **V7 (pivot veto):** Exactly-Once Submitter is not the pivot. PoC-only mode is (FDA-06).
- Vetoes V1–V3 from file 18 stand.

---

## 4. FINAL WINNING PACKAGE

**Concept and name.** **Repro Receipts** — "Run a stranger's code. Get a receipt." Untrusted bug reports and PoCs execute in secret-free, egress-limited sandboxes on a separate Vultr VM; a frozen reproduction is re-executed fresh with no network at the reported commit, the fix and HEAD; a signed receipt with a re-run command comes back; the only outward action is a human-approved comment. The containment beat is called "the chamber".

**The 3-minute demo I'd bet on (four beats).** Setup at T−5: `preflight.sh` green; E17 (`ror-demo-target#1`) started; tabs per 16 §1. N narrates, D drives.

| Time | Beat | On screen | Key line | Fallback |
|---|---|---|---|---|
| 0:00–0:20 | **Hook** | Slide: Little-CMS#608 quote (verbatim, FDA-15) | "Raise your hand if you've run a stranger's proof-of-concept on your own laptop to see if a bug was real. This maintainer did, last week. In July a swarm of OpenAI agents escaped an eval sandbox and breached Hugging Face. We built the place to run that code that can't hurt you — and that proves what happened." | none needed |
| 0:20–1:05 | **The chamber** (containment moment) | Start E16 hostile issue from the curated picker. Card A: `runsc` · pids limit → tripwire (honeytoken/metadata) → **CONTAINED: policy violation** → destroyed → "host healthy · sentinel unchanged". Then D presses **Replay incident**: 4 scripted vectors (exfil to canary host, metadata read, fork bomb, `rm -rf ~`) bloom as cards, each naming the layer that stopped it and the audit line | "gVisor on a separate Vultr VM with no keys at all. The credentials it read were planted. Each card names the layer that stopped it and the audit line — the two things that were missing in July." | Tripwire slow → show the rehearsal-3 run with its timestamp, say so |
| 1:05–2:10 | **Real work** | Tab: E01 humanize#333 live: plan panel `glm-5.3-normalize @ api.vultrinference.com`, attempt 1 fails, **stderr fed back**, attempt 2. Switch to finished E17: **REPRODUCED · high**, B/C/D "no network since creation", frozen script + static gate `pass`, cost on the receipt | "The agent plans on Vultr Serverless Inference; its only tools are write-file and exec inside the sandbox. It writes the repro but never grades it. We froze the script, checked it for tricks, and re-ran it in fresh no-network sandboxes: fails at the reported commit, passes at the fix, still fails on HEAD. The receipt proves this script behaves differently at these commits; intent is the maintainer's call." | E17 not finished → **Replay (verify only)** live, labelled |
| 2:10–2:45 | **Receipt + approval** | Terminal: `verify-receipt --recompute` OK → `sed` one byte → FAIL. E17 → draft comment → hash + expiry → **Approve** → comment lands on our own `ror-demo-target#1` | "Signed so nobody can alter it after the fact; independent because the frozen tuple lets you re-run it yourself — the command is on the receipt. The only thing that leaves the box is this comment, after a human approves these exact bytes." | Post fails → `outcome_unknown` chip, "no blind retry" |
| 2:45–3:00 | **Close** | Slide 2: buyer + "100% Vultr: VMs + Serverless Inference" + measured $/verdict | "Free for maintainers, paid for security and platform teams. Every model call went to Vultr Inference; every byte of untrusted code ran on a Vultr VM with nothing to steal. Built today." | — |

**Q&A move:** offer a judge the operator laptop: "type anything into this issue body". It runs the PoC-only lane (no model, 20 s TTL, `none` egress) and the card blooms. That is the audience moment, with zero public-URL risk.

**Must-build, ranked (stop anywhere below the line and you still have a demo):**
1. K1 probe + K3a model-only spike (decides authoring vs PoC-only mode by **14:00 PDT**, or 15:00 if the key is late).
2. Sandbox host: gVisor, egress proxy allowlist + metadata drop + tripwires, supervisor, two VMs, no secrets in the sandbox.
3. Hostile issue fixture → CONTAINED end to end, host sentinel unchanged (the mandatory containment moment).
4. Verifier: freeze → AST gate → hashed no-network B (+D at HEAD; C if fix known) → pure verdict → signed receipt + `verify-receipt`.
5. Verify-only replay (the live fallback) and pre-built bundles for E01/E17 (22 §5).
6. Minimal UI: Run page with live cards + Receipt page. Curated picker. Judge login.
7. Two-step rerun command tested from a clean laptop.
— **line: everything above = a winning demo** —
8. Approval-gated comment to `ror-demo-target`.
9. "Replay incident" scripted montage (4 vectors, layer attribution) — 1.5 h, only after item 3 passes T-02.
10. Per-verdict cost from `/v1/models` prices on the receipt (cheap API-judge point, 20 §3 #4).
11. NetBird tiers 1–2 (zero inbound + judge password) if a domain exists by 13:30 PDT and a 4th person is free.
12. Vultr throwaway VM for the hostile tier, only with measured boot <60 s.

**Cut list (cut in this order, and items 1–3 are cut for every team size before starting):**
1. Public QR intake / Blast Wall (V4).
2. NetBird Agent Network and tier 3 (V6, FDA-11).
3. Microsandbox/microVM tier, VX1 experiments (V6, FDA-10).
4. Fix-ref C (keep B + D; cap at `medium`, say so).
5. Approval flow (receipt becomes the only output; drop the claim).
6. Hardened locality (then never show a no-fix `medium` REPRODUCED).
7. Multiple live repros (one pre-started E17 + one replay).

**Team-size reality (15 §2.6 adjusted):** solo = items 1–7 only, PoC-only mode from the start, B + D refs, replay-first demo. 2 people = 1–9. 3 = 1–10. 4 = 1–11; 12 only if bored.

**Go / no-go gates (PDT):**
- **Sat 12:15** — inference key redeemed and one forced tool call parsed. No → lead escalates to organizers; K3a shifts +1 h.
- **Sat 14:00 (≤15:00)** — K3a: ≥3/6 fail-before/pass-after → authoring mode. 1–2/6 → **PoC-only mode** (FDA-06). 0/6 *and* PoC-only fails on E01 → Ship Gate.
- **Sat 17:30** — K3b headless end-to-end on ≥3 issues through the real supervisor and proxy. Miss → cut list items 4–6 now, not later.
- **Sat 20:00** — hostile fixture → CONTAINED on the deployed stack with host sentinel unchanged. Miss → all hands on it; nothing else matters until it passes (mandatory beat).
- **Sun 02:00** — core done (items 1–7). Miss → freeze scope at whatever passes T-01/T-02/T-28; UI polish stops.
- **Sun 07:00** — feature freeze. **Sun 08:00–09:00** — video (≤60 s, containment shot first). **Sun 09:00** — rehearsal 1 measures replay wall-clock; >60 s → pre-create sandboxes for the slot.
- **Sun 11:30** — submitted. If at 11:00 any of {containment beat, receipt verify, replay} is red, submit anyway and demo the green subset; do not start fixes after 11:00.

**Answer to "is there a bolder idea that beats it on this rubric and panel?"** No. Every alternative in 10/21 scores lower on my table, and the two that are more relatable to the room (Ship Gate, PoC Detonator) lose on Creativity or Demo. The bold part is already in the engine: independent re-execution of a stranger's code with a receipt. Spend the creativity budget on *saying it in four beats*, not on a wall.
