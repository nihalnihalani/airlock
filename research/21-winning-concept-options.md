# 21 — Winning-concept options (stage-impact pass)

> **Superseded in part (Sat 07:00 PDT):** read [25-WIN-PLAN.md](25-WIN-PLAN.md) first. After the Fable 5.1 review (24), the demo, pivot rule (now PoC-only mode) and cut list there override this file.


Written 2026-09-26 by the wow-designer team. Goal: **win** Challenge 1 "Blast Radius Zero", not merely be correct. This file re-reads the validated core engine (untrusted input → sandboxed agent execution on Vultr → independent re-execution → signed receipt; 00, 03c, 12) through Gary-Yau Chan's winning lens: optimise 1–2 features for judge WOW, make the audience *do* something, open with a skit, ask the room a question, show loading states that signal real work, and pitch it like a mature startup.

All prior research stands. This file only re-optimises **presentation and concept framing**. Nothing here weakens the safety design in 12; the audience mechanic is spec'd to be safe in §4.

---

## 1. Why the current pick under-performs *on stage* (not on correctness)

"Repro Receipts" is the right engine and the safest bet on correctness (devil's advocate 6.50 → 7.10 after conditions). But as a **3-minute stage act judged on Technicality 40 / Creativity 25 / Live demo 20 / Future 15**, it has five WINNING weaknesses:

1. **The gasp is buried in a JSON receipt.** The intellectual payoff (a signed, re-runnable verdict) is a *document*. Documents don't make a room gasp. The most visually exciting second — untrusted code being absorbed — is currently beat 2 of 6, and lasts 30s.
2. **It reads as "just CI / SWT-bench" to technical judges (DA-18).** Fail-before/pass-after in containers is exactly what half the room has seen. Creativity was honestly scored **5** because ClusterFuzz and syzbot already do two-ref re-execution.
3. **Multi-minute runs fight the clock.** One real run is A(≤900s) + P + B + B′ + C + D. That does not fit 3 minutes, so the live demo leans on a pre-started run and a replay — which is fine, but it drains tension and invites "so it's pre-baked?".
4. **The audience is passive.** Nobody in the room touches it. Chan's single highest-leverage move — "scan this QR / text this number" — is unused. Passive demos lose the final round where storytelling decides.
5. **The pain is abstract to *this* room.** "OSS maintainer triage volume" is real (D1) but a room of builders and VCs doesn't feel it in their gut the way they feel "my coding agent lied to me about the tests passing."

**Bottom line:** the engine wins Technicality. It is losing Creativity and Live-demo points it doesn't have to. The fix is a **presentation layer that makes containment a live, audience-driven spectacle while a real repro finishes as the main event** — turning the challenge's mandatory "containment moment" from a chore into the show.

---

## 2. Five sharpened variants (same engine) + two honest alternatives

Scoring uses the organizer rubric. **R1** = .40T + .25C + .20D + .15F; **R2** = equal-weight mean (top-6 stage round). Build cost is incremental hours **on top of** the ~20h core engine, against the 24.5h window.

### Variant A — "Detonation Chamber" (RECOMMENDED)
**One-liner:** "A public URL where anyone can throw their nastiest code at an AI agent — it still does real work, and a live wall shows every attack contained and by which layer."

- **Core stays:** the repro engine runs a real public bug (humanize#333) end-to-end as the main event.
- **WOW #1 — the Blast Wall:** a live, big-font wall of attempts. Each submission shows a card: *received → running in gVisor on Vultr VM #id → limit/tripwire hit → **CONTAINED: policy violation** → sandbox destroyed → host healthy, sentinel unchanged.* A running counter: "**N attacks absorbed · 0 escapes · host untouched**."
- **WOW #2 — the signed receipt** anyone re-verifies from the terminal (tamper one byte → FAIL).
- **Audience mechanic:** a QR on the opening slide → phone form → paste an issue body (text only) → it runs in a throwaway sandbox and appears on the wall within seconds. The room attacks the system *while* the legit repro finishes. (Safety spec in §4.)
- **Skit/hook (≤20s):** N holds up a laptop. "In July, 1,200 AI agents escaped their sandbox and breached Hugging Face. *[beat]* Raise your hand if you've ever run a stranger's proof-of-concept on your own machine to see if a bug was real." Hands go up. "Every one of you just did what this maintainer did — [slide: Little-CMS] — 'developer time is too valuable to spend on war games.' So we built a place to run that code that can't hurt you, and proves what happened."
- **Judge minute-by-minute:** see §5 run-of-show.
- **Containment moment:** the audience *is* the containment moment — many attacks, each blocked and logged, answering the incident's two named causes ("inadequate sandboxing", "no log monitoring"). Plus one scripted hostile issue PoC we control, so the beat never depends on the crowd.
- **Independent-verification moment:** verify-receipt in the terminal recomputes the verdict from hashes with no trust in our UI; one-byte tamper → FAIL.
- **Business model:** OSS maintainers free (GitHub App, receipts on issues); **enterprise security & platform teams paid** ("the execution layer a regulated team can approve") — per-seat + per-run; distribution via GitHub Marketplace and Vultr's discover.vultr.com case-study pipeline.
- **Different from triagebot/syzbot/CI/E2B:** triagebot runs repro on the runner that holds its write token + model key and an LLM judges the result (verified at `51d30da`); syzbot/ClusterFuzz re-run *fuzzer* testcases, not untrusted natural-language reports; CI runs *your* code on trusted triggers — we run a *stranger's* code on demand; E2B is the sandbox primitive, not the verdict + receipt + approval layer on top.
- **Build cost:** +6–9h on the engine (wall UI + SSE fan-out you already have, a rate-limited public intake queue, a moderation gate). Highest incremental cost of the five, but it buys the two scarcest points (Creativity + Live demo).
- **Failure modes & fallback:** (1) nobody scans → we seed the wall with 3 pre-queued attacks and invite one named judge to try; (2) offensive text submitted → moderation gate + text-only + our display never renders attacker HTML (§4); (3) intake overload → hard rate limit + queue depth cap, excess shown as "queued"; (4) whole live stack down → labelled recording from the Sun 08:00 slot.
- **Score:** **T8 C8 D9 F8 → R1 8.10 / R2 8.25.** Creativity rises from 5→8 because the *audience-driven containment wall answering the HF incident* is a genuinely new stage act even though two-ref re-execution isn't new. Live demo 9 because the crowd participates and the main run is de-risked by replay.

### Variant B — "Repro Badge" (GitHub App)
**One-liner:** "A green badge on every issue: ✅ Reproduced on Vultr at v1.2 · still broken on main — re-runnable by anyone."
- **WOW:** the badge appearing live on a real issue; hover → the signed receipt.
- **Audience mechanic:** weak — judges watch a badge appear. Could QR to "install on your repo," but that needs auth (Chan says skip sign-in).
- **Containment:** one scripted hostile PoC; less dramatic than a wall.
- **Business model:** cleanest of all — classic GitHub Marketplace freemium, per-repo pricing, obvious buyer.
- **Different-from:** same boundary story; the badge is the packaging.
- **Build:** +4–6h (GitHub App manifest, check-run/badge rendering).
- **Failure modes:** GitHub App install/callback flakiness live; badge propagation delay.
- **Score:** T8 C6 D6 F8 → **R1 7.10 / R2 7.00.** Best *business* story, weakest *stage* energy.

### Variant C — "PoC Detonator" (security-report wedge)
**One-liner:** "Forward any vulnerability report with a proof-of-concept; we detonate it in a secret-free sandbox and hand back a contained verdict + receipt."
- **WOW:** running an actual attacker-supplied PoC and containing it is inherently tense; the receipt proves what the PoC did without endangering anything.
- **Audience mechanic:** medium — "email/forward a PoC to this address" (a real inbox intake is a great Chan-style hook), but hostile-content moderation risk is highest here.
- **Business model:** security teams / bug-bounty triagers, paid; HackerOne-adjacent. Strong enterprise willingness-to-pay.
- **Different-from:** HackerOne Hai covers web-vuln classes only and doesn't independently re-execute in a secret-free box with a signed receipt.
- **Build:** +3–5h (mail/forward intake) on top of engine.
- **Failure modes:** real PoCs are risky and unpredictable live (03c flags this — use synthetic); narrow to safe fixtures kills spontaneity.
- **Score:** T8 C7 D6 F7 → **R1 7.15 / R2 7.00.** Great buyer, but the "detonate real malware live" promise is a demo-reliability trap; better as a *slide* future direction than the live act.

### Variant D — "Ship Gate" (agent-claim verification, my sharpening of Claim Court)
**One-liner:** "Your AI coding agent says 'all tests pass, done.' Ship Gate re-runs its work in a sandbox it doesn't control and catches the lie before merge."
- **Why it resonates with THIS room:** the audience *builds agents*. "1 in 5 SWE-bench 'solved' patches are wrong; LLM judges pass broken tests 61.9% of the time" is *their* pain, not a stranger's.
- **WOW:** a live agent PR proudly claiming "✅ all 4,966 tests pass" → Ship Gate re-executes independently → **"3 tests never ran; 1 fails" — MERGE BLOCKED.** The gasp is the agent being caught.
- **Audience mechanic:** QR → "paste your agent's last 'done' claim / a PR URL" → we re-run and grade it on the wall.
- **Containment:** the agent's code is untrusted and runs in the secret-free sandbox; a hostile-PR beat contains an escape attempt.
- **Business model:** dev-tools buyer (platform/DevEx teams), CI-adjacent, per-run pricing; huge and current TAM as agent-authored PRs explode (GitHub PRs 25M→90M/mo).
- **Different-from:** CI trusts the trigger and shares the agent's env (BenchJack: gameable); we re-execute *outside* the agent's trust domain.
- **Build:** +2–4h (swap the planner prompt + input parser; engine is 80% shared per 00 §5).
- **Failure modes:** crowded startup field (Canary/Opslane etc.) → Creativity capped ~5; overlaps CI perception (DA-18 again).
- **Score:** T7 C6 D7 F7 → **R1 6.75 / R2 6.75.** Most *relatable to the room*; strongest pivot target if the repro-authoring spike (K3a) fails, because it reuses the engine.

### Variant E — "Blast Radius Live" (my own: the escape-replay theatre)
**One-liner:** "We replay the exact Hugging Face escape vectors against our agent, live, and show each one blocked, by which layer, and logged — while the agent finishes a real task."
- **WOW:** a "Replay incident" button runs the documented attack categories (egress/exfil, a planted vulnerable internal tool, cross-agent notes to shared storage, metadata/credential read, fork bomb, prompt-injected page) as a montage of red cards, each naming the layer that stopped it and the audit line written.
- **Audience mechanic:** same QR intake as A, but framed as "add your vector to the replay."
- **Difference from A:** A centres the *repro product*; E centres the *incident*. E scores marginally higher on zeitgeist recognition but lower on "real work" — risk of a refusal-only demo the challenge warns against.
- **Business model:** identical to A.
- **Build:** +5–7h (the replay harness of scripted vectors + layer attribution).
- **Score:** T8 C8 D8 F7 → **R1 7.85 / R2 7.75.** Excellent, but folds into A: A = E's escape theatre + a real repro as the main event + audience participation. Ship A, keep E's "Replay incident" button as A's fallback when the crowd is quiet.

### Honest alternative 1 — Exactly-Once Submitter
**One-liner:** "Submit N records to a portal; crash the sandbox mid-run; it resumes with zero duplicates."
- **WOW/containment:** the kill-mid-run + clean resume is the most *deterministic* live moment of any concept (devil's advocate's top pick for demo reliability).
- **Audience mechanic:** thin; judges watch a kill/restore.
- **Weakness for winning:** idempotency is textbook (Temporal/Inngest); Creativity ~5; production pain is the weakest; "sandbox absorbs something unsafe" is stretched (a crash isn't an attack).
- **Score:** T7 C5 D8 F5 → **R1 6.40 / R2 6.25.** The safe pivot, not the winner.

### Honest alternative 2 — Evidence Clerk
**One-liner:** "Provenance-stamped audit evidence for UI-only compliance controls, captured by a browser agent in an isolated session."
- **WOW:** a browser agent + signed screenshot receipts; a compliance buyer story.
- **Weakness for winning:** login + seeded app + live browser = fragile (build risk 4, demo score 5–6); +4–8h of browser/live-view work with no slack.
- **Score:** T7 C6 D5 F7 → **R1 6.35 / R2 6.25.**

**Ranking for winning:** A (8.10/8.25) > E (7.85) > C (7.15) ≈ B (7.10) > D (6.75) > Exactly-Once (6.40) > Evidence Clerk (6.35).

---

## 3. Recommendation

**Ship Variant A — "Detonation Chamber": the validated Repro Receipts engine, presented as a live audience-driven containment wall with a real repro as the main event, and E's scripted "Replay incident" button as the crowd-quiet fallback.**

It keeps every safety property in 12, keeps the deterministic verify-only replay as the reliability backstop (DA-11), and adds the two things the base pitch lacked: a **gasp** (a wall of contained attacks with a live "0 escapes" counter, directly answering the HF incident every judge has in mind) and **audience participation** (Chan's highest-leverage move). Pivot rule unchanged: if the K3a model-only spike returns <3/6 fail-before/pass-after by H+3, drop to **Variant D (Ship Gate)** — it reuses the same engine and the same wall, only the input changes — and only fall to Exactly-Once if D's authoring also proves unreliable.

---

## 4. Audience-interaction design (must be safe)

The mechanic is the risk. It is contained by design:

- **Intake:** QR → mobile web form → **single text field: an issue body.** No file upload, no URL fetch of attacker choice, no attachments.
- **What runs:** the submitted text is treated exactly as an untrusted issue — it drives the agent only *inside* a throwaway gVisor sandbox on the sandbox-host VM (no secrets, egress-allowlisted, pids/wall-clock capped, tripwires armed). Nothing the crowd sends touches the control plane, keys, or the display host.
- **Rate & abuse limits:** per-IP and global token-bucket; hard queue-depth cap; excess shown as "queued." One concurrent public run per device.
- **Moderation of the *display*:** the wall renders **only** our own structured fields (status, layer that fired, VM id, verdict) as plain text — it **never** renders attacker-supplied strings as HTML, and issue bodies are shown truncated, escaped, and behind a one-tap "reveal" that an operator can disable. A human operator holds a kill-switch for the public queue and can hide any card. A profanity/nsfw text filter drops obviously offensive submissions from the visible wall (still counted in the "absorbed" tally).
- **Determinism backstop:** if the crowd is quiet or hostile, press **"Replay incident"** (Variant E's scripted vectors) — same wall, our fixtures, no dependence on the room.

This is safe because the public never supplies code that runs outside a sandbox, never supplies anything that renders as markup on our screen, and the containment layers are exactly the ones the product already enforces.

---

## 5. Exact 3-minute run-of-show (second by second)

Roles: **D** (driver, laptop), **N** (narrator, phone). At **T−5 min**: run `preflight.sh` all-green; start the real E17 repro run; seed the wall with 3 pre-queued attacks; put the QR slide up.

| Time | On screen | N says (key line) | Fallback |
|---|---|---|---|
| 0:00–0:20 | Slide 1 (problem) + **QR code** | Skit + hand-raise (§2 hook). "Scan this — throw your worst code at it. It runs on a Vultr VM that can't hurt you." | If projector QR fails, read a short URL |
| 0:20–0:45 | The Blast Wall, first audience cards landing next to our 3 seeds; counter climbs | "That's a gVisor sandbox on a separate Vultr VM with **no keys at all**. Every card names the layer that stopped it and writes an audit line — the two things the Hugging Face agents' owners didn't have." | Wall quiet → press **Replay incident** |
| 0:45–1:05 | One scripted hostile issue PoC card blooms: pids limit → tripwire → **CONTAINED: policy violation** → destroyed → host healthy, sentinel unchanged | "Here's one we control: it tries to wipe the home dir, fork-bomb, read cloud credentials and phone home. The credentials were planted honeytokens; the moment it touched them we killed the box. **This is the sandbox absorbing it.**" | Tripwire slow → show the same fixture from rehearsal, labelled with its time |
| 1:05–1:35 | Switch to the real repro (E01 humanize#333): plan panel, `glm-5.3 @ api.vultrinference.com`, Card A pytest fails → **stderr fed back** → attempt 2 rewrites | "Meanwhile, real work. The agent plans on Vultr Serverless Inference; its only tools are write-file and exec **inside the sandbox** — no network tool, no GitHub tool. Watch it read its own stderr and retry." | Plan slow → "inference is warming; back to the finished E17" |
| 1:35–2:05 | E17 verdict **REPRODUCED · high**, "still fails on HEAD"; B/C/D marked "no network since creation"; frozen script + static gate `pass` | "It wrote the repro but doesn't grade it. We froze the script, checked it for tricks like version-sniffing, and re-ran it in **fresh, no-network** sandboxes: fails at the reported commit, passes at the fix. **The receipt proves this script behaves differently at these commits** — intent is the maintainer's call." | Not finished → **Replay (verify only)**, say so |
| 2:05–2:30 | Terminal: `verify-receipt … --recompute` → OK; `sed` one byte → FAIL | "Signed. Anyone re-checks it and recomputes the verdict without trusting our UI. Change one byte — it's void." | CLI error → show receipt JSON + public-key endpoint |
| 2:30–2:50 | E17 → Draft comment → hash + expiry → **Approve** → GitHub tab refresh, comment on **our own** `ror-demo-target#1` | "The only thing that leaves the box is this comment, after a human approves these exact bytes." | Post fails → show `outcome_unknown` chip, "designed, no blind retry" |
| 2:50–3:00 | Slide 2 (business) + wall counter "**‹N› attacks absorbed · 0 escapes**" | "Free for maintainers, paid for security and platform teams. Every attack you just threw was contained on Vultr. Built today." | — |

Rules: never start a new run after 2:00 (replay OK to 2:15); never type URLs; never SSH on stage.

---

## 6. One-minute video shot list (≤60s, containment mandatory)

Capture from the deployed URL in the **Sun 08:00–09:00 PDT** slot; burn a timestamp; badge any speed-ups; no mocked screens; no upstream UI.

1. **0:00–0:05** Title over the Blast Wall: "Run untrusted bug reports safely. Get a signed verdict." (built: yes)
2. **0:05–0:20** **Containment moment:** the hostile issue PoC card → pids → tripwire → **CONTAINED: policy violation** → destroyed → host healthy → wall counter ticks, next run OK. Caption: "Untrusted issue PoC contained — host untouched." (yes)
3. **0:20–0:28** Real issue → plan panel + Vultr model id. Caption: "Agent plans on Vultr Serverless Inference." (yes)
4. **0:28–0:38 (4×)** Card A: pytest fails → stderr fed back → rewrite. Caption: "Writes a repro in a gVisor sandbox · separate VM · no keys." (yes)
5. **0:38–0:48** Fresh no-network B/C/D → **REPRODUCED · high** / **ALREADY_FIXED**, frozen script gate `pass`. Caption: "Re-executed fresh: fails at the reported commit, passes at the fix." (yes)
6. **0:48–0:54** Terminal `verify-receipt` OK → one-byte tamper → FAIL. Caption: "Signed receipt anyone can verify." (yes)
7. **0:54–1:00** Approval card → Approve → comment on our repo; end card: repo URL, demo URL, "Built at the event." (yes)

NetBird "zero-ports" beat inserted after shot 2 only if a tier is actually working at freeze. Never drop the containment shot.

---

## 7. The two slides (max)

- **Slide 1 (problem, the hook):** one stat + the QR. "Maintainers run strangers' code to check bugs. 1,200 agents escaped their sandbox and breached Hugging Face (Jul 2026). *[QR]* Throw your worst at ours."
- **Slide 2 (business):** buyer + model + moat. "Free for OSS maintainers (GitHub App). Paid for security & platform teams — the execution layer a regulated team can approve. GitHub Marketplace + Vultr. Different from CI: we run a *stranger's* code, outside the agent's trust domain, with a receipt anyone re-checks." Footer: "100% on Vultr — VMs + Serverless Inference + Object Storage · ~$0.06/hr infra, ≤$0.25/run."

---

## 8. Twelve hardest judge questions (crisp answers)

1. **"Isn't this just Astro's triagebot / CI?"** Triagebot runs repro on the same runner that holds its write token and model key and lets an LLM judge the result, then posts automatically (verified at `51d30da`). We run on a separate secret-free VM, re-execute the frozen script in fresh no-network sandboxes, and a human approves every post. CI runs *your* code on trusted triggers; we run a *stranger's* on demand.
2. **"Isn't this just ClusterFuzz/syzbot?"** They're the prior art and we say so — but they re-run *fuzzer* testcases; we take an untrusted natural-language issue, have a model *author* the reproducer, treat it as hostile code, and gate the only outward post on a hash-bound approval.
3. **"gVisor isn't a VM."** Correct — an escape needs a gVisor bug *plus* a host-kernel bug, and it lands on a separate VM holding no keys. MicroVM-on-VX1 plugs in behind the same supervisor API.
4. **"Where do the keys live?"** Only on the control plane. The sandbox host has no secrets but its supervisor token. Prove it: `env` in the sandbox shows nothing.
5. **"The audience is sending you hostile input — is *that* safe?"** That's the product. Text-only field, runs only inside the sandbox, our wall renders only our own fields (never attacker HTML), rate-limited, operator kill-switch. §4.
6. **"So the demo is pre-baked?"** The real repro was started when we walked up (we say so); everything on the wall is live, including the audience's. Verify-only replay is our honest fallback, labelled as such.
7. **"What if the model fakes the repro?"** A static AST gate rejects version-sniffing/`exec`/tracing/monkeypatching; fault-locality requires a real package frame byte-identical to a pristine checkout; assertions need a fix or HEAD to pass. The receipt claims the *script's* behaviour, never "the bug is real."
8. **"Does the receipt prove the bug is real?"** No — it proves this frozen script fails at the reported commit and passes at the fix in fresh, secret-free, no-network sandboxes. Intent is the maintainer's call.
9. **"Prompt injection in the issue?"** The issue is data. The model's only tools act inside a secret-free sandbox; it has no GitHub/approval tool and doesn't decide the verdict. Worst case: a bad repro (INCONCLUSIVE) or a tripped honeytoken (contained).
10. **"Why is Vultr central, not just hosting?"** Control plane plans/dispatches/verifies on a Vultr VM; sandboxes run on a second Vultr VM over a Vultr VPC; every model call goes to Vultr Serverless Inference (startup refuses any other endpoint); receipts on Vultr Object Storage.
11. **"What does it cost / how does it scale?"** ~$0.06/hr for two small VMs, ≤$0.25/run model spend (hard-capped: 12 calls, 5 attempts, $5/day). Sandboxes are per-run and destroyed; density scales per core on VX1.
12. **"What's the business and who buys?"** Free GitHub App for maintainers builds distribution; security and platform teams pay for the approvable execution layer (per-seat + per-run) via GitHub Marketplace; adjacent expansion to agent-claim verification (Ship Gate) is the same engine.

---

## 9. Explicit cut list (if time or the K3a spike forces it)

**Cut, in this order:**
1. NetBird tiers (optional; only if core is frozen — 14).
2. Live audience intake → fall back to the scripted **Replay incident** wall (still a full containment spectacle, zero crowd dependence).
3. The C-ref (fix-commit) run → keep B (reported) + D (HEAD) only; verdict caps at `medium`, stated honestly.
4. The draft-GitHub-comment beat → describe it, show the approval card static.
5. Multiple live repros → one pre-started E17 + one verify-only replay.

**Never cut:** the containment moment (mandatory, C1-11); the signed-receipt verify + tamper; "every model call on Vultr Serverless Inference"; the honesty beats (we say what's live, replayed, or recorded).

**Pivot (K3a <3/6 by H+3):** → **Ship Gate (Variant D)**, same engine + same wall, input becomes an agent's "done" claim. → Exactly-Once only if D's authoring also fails.
