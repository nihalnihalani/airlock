> **Historical plan — superseded for product choice and build scope.** Read [35-AIRLOCK-MAIN-CHALLENGE.md](35-AIRLOCK-MAIN-CHALLENGE.md) for the current main-challenge project and [34](34-main-challenge-evidence-and-decision.md) for the evidence and corrections. Do not execute this older plan as the current brief.

# 27 — Simulated judge panel and FINAL PICK

Reviewer: Fable 5.1, acting as (a) a blind five-judge panel and (b) the last devil's advocate. Written Sat 2026-09-26 about 10:30 PDT, one hour before hacking starts. No product code exists. Inputs: 25, 24, 26a, 26b, 26c, 20, 22, 23, 13, 14, 06-competitive, 06-meta, plus spot checks of 01-rules (C1-07/09/11, G-07, NB-04, D-06) and 10 (Blast Preview 6.80).

**This file supersedes 25 on the choice of project.** 25's engineering discipline (gates, landmines, honesty rules, vetoes V1–V7) stays in force.

---

## 0. Verdict in one paragraph

Build **Dress Rehearsal on a Vultr twin** (26c's Dress Rehearsal with 26b's Stunt Double mechanics merged in): the agent gets root on a throwaway clone of production, booted from a Vultr snapshot into a sealed per-task network; it does the destructive task for real there; you approve the *measured* blast radius; only that exact effect set reaches production, and any row that changed since the rehearsal is refused. It beats the incumbent Repro Receipts on every judge in this panel except the CTO, where it ties. The gap is driven by three things the incumbent cannot buy with more engineering: the PocketOS story every judge already knows, five Vultr API features nobody else in the room will touch (snapshot as a safety primitive, per-task VPC, no-public-IPv4 twin, cord-cut quarantine, restore-as-rollback), and a judge-driven moment where the product *works* instead of *refuses*. Its weaknesses are real and are what the go/no-go clock exists for: zero lab evidence (22 validated only the incumbent), an unmeasured twin boot time, and a differ/apply engine that must be green headless by **15:00 PDT** or we flip back to Repro Receipts in PoC-only mode, whose sandbox-host work carries over 1:1.

---

## 1. Panel model

| Judge | Who | Lens | What earns a point | What loses one |
|---|---|---|---|---|
| J1 | Vultr DevRel engineer (Debnath / Mirdul / Kartikey / Sanskriti type) | API judge | Unusual, load-bearing use of Vultr primitives; product names said out loud; cost per task; "I can recognise our docs" | Vultr as a plain host; "would look the same on Hetzner" |
| J2 | NetBird Head of DevRel (Brandon Hopkins) | API judge, NetBird bonus | Reverse proxy, per-task URLs that die, roles from identity, posture checks, candour about beta limits | A static URL with a password; NetBird as a bolt-on; anything that puts NetBird in the inference path |
| J3 | CTO-type technical judge | "Is it real, where does it break" | Separate trust domains, secrets handling, egress, teardown, what the model does *not* decide, honest limits | Adjectives; regex "firewalls"; a receipt signed by the machine that computed the verdict; "we didn't have time" |
| J4 | Vultr CMO (Cochrane) | BD / marketing | "Real agents doing real work with governance"; a keynote sentence; a Vultr customer type he can name; a case-study headline | Security-vendor stories; narrow buyers; dashboards; anything he cannot repeat in one breath |
| J5 | Cerebral Valley founder (Porollo) | Investor | Why now with dates, one-line precedents, a first buyer, why the incumbents won't just ship it | TAM hand-waving; "maintainers don't pay"; crowded categories |

Round 1 = J1 + J2 + J3 (Technicality 40 / Creativity 25 / Live demo 20 / Future 15). Finals = all five, equal weights. Scores are what a 2–3 person team **plausibly demos at 12:30 Sunday**, not the design. Every candidate except Repro Receipts carries a **−0.3 evidence discount** (no lab work in 22; 24 §2 found self-scores ~1 point high and this is the same family of optimism). Absolute numbers here run about 0.3 below my file-24 scale because this panel is modelled with relatability; **compare gaps, not absolutes.**

---

## 2. Candidate by candidate

### A. Repro Receipts (incumbent, 25)

| Judge | First 30 seconds | Toughest question | T | C | D | F |
|---|---|---|---|---|---|---|
| J1 | "Two VMs, a VPC, tool calls on our inference, gVisor. Competent. Vultr is the host, not the point. The $/verdict line is nice." | "What here is specific to Vultr beyond hosting? Would this look the same on any VPS?" | 8 | 6 | 7.5 | 7 |
| J2 | "Zero-trust mindset, but NetBird is item 11 on their list and cut first. Sandboxes with no inbound is table stakes." | "Where in *your product* does a URL die with a task?" | 7.5 | 6 | 7 | 6.5 |
| J3 | "Static gate, no-network re-execution, hashed offline installs, a receipt with a re-run command. Real engineering. It is syzbot for issue text." | "Your PyPI allowlist is an exfil channel and your receipt is signed by the box that computed the verdict. What is independent?" | 8.5 | 6 | 7.5 | 7 |
| J4 | "Bug-bounty triage. Who is the logo? 'Run a stranger's code, get a receipt' is a good line, but my keynote is about agents doing work and this agent writes a pytest." | "Which Vultr customer do I put on stage with this?" | 7.5 | 6 | 7 | 6.5 |
| J5 | "HackerOne's $81M is bounty spend, not triage spend; maintainers don't pay (their own file 23 says so). Socket is a fair precedent." | "Why is this a company and not a HackerOne feature?" | 7.5 | 6.5 | 7 | 6.5 |

Demo risk, harsh: the live beat depends on **K3a model authoring, untested** (13: "tool-call quality is unmeasured"); the fallback is PoC-only mode, which is fine but reads as "so the agent didn't do it." Replay wall-clock on Vultr is unmeasured (24 FDA-07). Both are manageable; the engine itself is the best-validated thing in the folder (22: 30/30 deterministic).

Dismissal test: "isn't this CI / syzbot?" The rebuttal lands with J3 (natural-language, hostile input, secret-free VM, approval gate) but **costs a full Creativity point with every judge anyway**, because the rebuttal is a paragraph and the dismissal is three words.

### B. Dress Rehearsal on a Vultr twin (26c ∪ 26b) — THE PICK

Mechanics in one line: `POST /snapshots {prod}` (pre-taken) → `POST /instances {snapshot_id, attach_vpc:[task VPC], disable_public_ipv4, firewall_group: FW-ZERO, tags}` → agent gets root on the twin via the airlock → differ measures effects (rows, files, mock-cloud journal) → Blast Radius Card → approve binds to the effect hash → apply to prod with per-row before-hash check → receipt. Hostile turn → canary → no route → quarantine: cord cut → forensic snapshot → `DELETE` → 404. Container clone (gVisor + Postgres data-dir tarball) is the deterministic floor behind the same provider interface.

| Judge | First 30 seconds | Toughest question | T | C | D | F |
|---|---|---|---|---|---|---|
| J1 | "They snapshot a server, boot a twin into a per-task VPC with no public IPv4, cut the cord as quarantine, snapshot the infected twin for forensics, and restore prod from the same snapshot as the undo. That is five features I have never seen a hackathon team touch, plus three inference models." | "How long does the twin take to boot, what does a rehearsal cost, and does VPC detach take effect without a reboot?" | 8.5 | 8 | 6.5 | 8 |
| J2 | "The approver opens the twin through a per-change URL that dies with the twin; roles are requester / approver / auditor; a posture check binds the twin's network to the supervisor process. It falls out of change management instead of being bolted on." | "Show me the URL dying. And what happens to it if your control plane crashes?" | 8 | 7.5 | 7 | 7.5 |
| J3 | "An executed plan step with row-level contracts. Terraform plan for imperative ops. But a clone of prod carries prod's secrets and PII; there are side effects you cannot clone; and how big a database can you snapshot?" | "Isn't this staging with extra steps — and what about the Stripe call the agent makes on the twin?" | 8 | 7.5 | 7 | 8 |
| J4 | "'The agent had root and still couldn't hurt anything.' 'Every agent change rehearsed on a Vultr twin.' Everyone in this room knows PocketOS. And Vultr's customers run fleets of plain VMs — this is for them." | "Say it in one sentence for a keynote." | 8 | 8 | 8 | 8.5 |
| J5 | "Terraform $6.4B, Neon 80% agent-created and $1B, Replit and Railway both patched *after* an incident, Gartner's 40%, users approve 93% of prompts. The why-now is complete. Blast-preview ideas exist but nobody sells this." | "Who buys first, platform teams or the agent vendors, and why won't Cursor ship it?" | 8 | 7.5 | 7.5 | 8.5 |

Demo risk, harsh:
- **Twin boot from snapshot is unmeasured** (13 §4 D: "plan for 30–120 s + cloud-init"; snapshots "can be slower than fresh OS"). If it is 3 minutes, a live boot never fits a beat. Mitigation: warm pool of two twins booted at T−10; the "booting live" twin is a progress bar for the *next* ticket and never on the critical path; container floor if S3 fails.
- **`DELETE` → `GET 404` latency is unknown.** Vultr deletes asynchronously; `GET` may show the instance for seconds. Mitigation: show the `DELETE` 204 and a `GET /instances?tag=twin` list poll; say "gone from the API" when it is.
- **VPC hot-detach may need a reboot** (26b: unverified). Mitigation: quarantine's cord cut is an nftables drop on the airlock (deterministic); the API detach is a bonus visual only if the 12:30 spike shows it works live.
- **The model may refuse to run `volumeDelete` on stage.** Mitigation: beat 2 executes a **frozen agent transcript from a rehearsal run, labelled on screen with its timestamp, on a fresh twin live**; the live model call happens in beat 3 where variance is tolerated. This is honest and stated.
- **The differ/apply engine is new code with no lab evidence.** Postgres FK cascades, sequences, `now()` and triggers all bite. Mitigation: simple schema (customers → bookings → payments, integer PKs), the differ diffs *after-state* so cascades are captured as effects, apply executes explicit per-row ops children-first in one transaction, and the 15:00 kill test is headless with no model.
- **Postgres data-dir restore inside gVisor** is unmeasured. Mitigation: <100 MB data dir; S2 spike at 12:45.

Dismissal test: "isn't this just staging / a dry run?" Rebuttal (15 s): "Staging is stale, shared and human-maintained, and it is exactly where PocketOS's agent was working when it hit prod. This is a per-action, disposable clone, the run is *executed* not predicted, its output is a contract, and the contract is enforced per row on apply — you just watched it refuse the row a judge changed." It lands, and unlike the incumbent's rebuttal it is demonstrated, not argued. Residual Creativity cost: about half a point with J3 only.

Container-only variant (if S3 fails): J1 and J3 drop T by 0.5 and J1 drops C by 0.5, D rises 0.5 everywhere. It still leads the incumbent on R2 and ties it on R1 (see §3).

### C. Try Before You Trust (26a, MCP/install-first)

| Judge | First 30 seconds | Toughest question | T | C | D | F |
|---|---|---|---|---|---|---|
| J1 | "A VM per task from a golden snapshot, presigned Object Storage, three inference models, MCP — it matches our own sandboxing guide. Vultr as the detonation host." | "What is the agent doing here besides installing? Where is the work?" | 7.5 | 7 | 6.5 | 7.5 |
| J2 | "The preview URL *is* the product; my own installer gets a clean label. But the URL has to reach a VPC-only VM through a routing peer in a beta proxy." | "What if the reverse proxy can't target your routed resource? Then your useful path is a PDF." | 8 | 7.5 | 6.5 | 7.5 |
| J3 | "Dynamic package analysis with honeytokens and TLS capture: OpenSSF Package Analysis plus ANY.RUN with an LLM summary. Sandbox-aware and time-delayed payloads evade it; certificate pinning defeats the mitm." | "How is a 90-second run evidence of anything about day three?" | 7 | 6.5 | 6.5 | 7 |
| J4 | "The place you run strangers' code before it touches your laptop. Every developer relates; the 30,000-device story is five days old. But it is a security-vendor story, not an agents-doing-work story." | "Is this Vultr's story or Socket's?" | 7 | 7 | 7 | 7.5 |
| J5 | "Socket at $1B, Snyk bought Invariant, MCP governance is a budget line. Static scanners are crowded; dynamic is the gap." | "Why won't Socket ship this next quarter?" | 7 | 7 | 6.5 | 7.5 |

Demo risk, harsh: **three untested subsystems sit on the critical path of the useful beat** — a TLS-intercepting proxy baked into a VM golden image, NetBird tier-3 reaching a VPC-only VM via a routing peer (unverified, 26a's own list), and snapshot boot time — plus a domain by 13:30. If tier 3 fails, the "you get to use it" beat collapses into a green label, which is a document, which is 24 FDA-04's refusal-montage failure in a nicer font. The MCP handshake itself is deterministic and that is the idea's real strength.

Dismissal: "ANY.RUN for npm." The rebuttal ("agentic use + rug-pull diff + preview") is true but costs Creativity with J3 and J5.

### D. Tap In (26b)

| Judge | First 30 seconds | Toughest question | T | C | D | F |
|---|---|---|---|---|---|---|
| J1 | "A VM per browser session and a vision model. Browserbase on Vultr." | "What is Vultr-specific?" | 7 | 6.5 | 6.5 | 6.5 |
| J2 | "This is the NetBird demo I would write: per-handoff expose gated to the requester's group, model blind, dies on hand-back." | "noVNC over the relay on venue Wi-Fi — what is the latency?" | 7.5 | 7.5 | 6.5 | 7 |
| J3 | "Takeover exists in ChatGPT agent and Browserbase; the model-blind window is the one new bit; the receipt is screenshots." | "The page can inject the model. What is containment beyond an allowlist?" | 6.5 | 6.5 | 6 | 6.5 |
| J4 | "Form Filler was on the organiser's starter list." | "Which enterprise?" | 6.5 | 6.5 | 6.5 | 6.5 |
| J5 | "Browser agents are crowded; the regulated self-hosted wedge is plausible but small." | "Who pays more than Browserbase charges?" | 6.5 | 6.5 | 6.5 | 6.5 |

Demo risk: vision-agent misclicks live; noVNC lag; expose cert latency. Best NetBird-bonus fit in the folder, weakest main-prize fit. **Keep its blind-handoff pattern as a Q&A answer and a future slide; don't build it.**

### E. Honeypot Hire (26c)

| Judge | First 30 seconds | Toughest question | T | C | D | F |
|---|---|---|---|---|---|---|
| J1 | "Eight parallel loops on our inference and a model A/B on our catalog. I like the catalog comparison. Rate limits are unpublished." | "What happens when the 429 hits at run five?" | 7 | 8 | 5.5 | 7.5 |
| J2 | "An auditor URL per run. Fine. Bolt-on." | — | 6.5 | 7.5 | 5.5 | 7 |
| J3 | "Decoy environment plus honeytokens gives verifiable trips. But N=8 is not a certification and the traps are prompts." | "What is your false-negative rate, and does 0/8 mean safe?" | 7 | 7.5 | 5.5 | 7 |
| J4 | "'A background check for AI agents' is a great headline. The demo may show nothing happening." | "What do I see on stage if the agent behaves?" | 7 | 8 | 5.5 | 8 |
| J5 | "AIUC's $15M seed says agent certification is a category. Sticky if it works." | "How do you sell a stochastic result?" | 7 | 8 | 5.5 | 8.5 |

Demo risk: the single worst in the set. A "0/8 tripped" run is honest and dead on stage; 8 parallel model loops on unmeasured rate limits; 26c itself says D 6.5 before discount. **Use it as the Future slide of the pick ("next: certify the agent before it gets a twin").**

### F. Hybrid: Try Before You Trust on the Repro Receipts engine

Same input class as C (packages, MCP servers, install scripts) but with 22's hashed offline reinstall and no-network re-execution, so a behaviour label is re-runnable later (rug-pulls become a diff between two receipts). It inherits about half of 22's lab evidence (the PyPI wheelhouse pipeline transfers; the MCP harness, honeytokens and TLS capture do not). Versus C: T +0.3, D −0.3 (more work), discount halved. It is a better *company* than C and a slightly worse *demo*; it does not reach B on any judge because it has C's "security-vendor story" problem with J4 and C's prior-art problem with J3.

---

## 3. Aggregate

R1 = mean over J1–J3 of (.40T + .25C + .20D + .15F). R2 = mean over J1–J5 of the equal-weight mean. "Disc." applies the −0.3 evidence discount (−0.15 for F).

| Candidate | R1 raw | R1 disc. | R2 raw | R2 disc. | Rank R1 | Rank R2 |
|---|---|---|---|---|---|---|
| **B. Dress Rehearsal on a Vultr twin** | 7.73 | **7.43** | 7.78 | **7.48** | 1 | 1 |
| B′. Dress Rehearsal, container clone only | 7.54 | 7.24 | 7.68 | 7.38 | 2 | 2 |
| A. Repro Receipts | 7.19 | 7.19 | 6.95 | 6.95 | 3 | 3 |
| F. Try Before You Trust on the RR engine | 7.21 | 7.06 | 7.08 | 6.93 | 4 | 4 |
| C. Try Before You Trust | 7.15 | 6.85 | 7.08 | 6.78 | 5 | 5 |
| E. Honeypot Hire | 6.83 | 6.53 | 6.95 | 6.65 | 6 | 6 |
| D. Tap In | 6.78 | 6.48 | 6.63 | 6.33 | 7 | 7 |

Three honest readings of that table:
1. **The VM twin tier is worth about +0.2 on R1** and is the whole API-judge argument. Container-only Dress Rehearsal *ties* the incumbent in round 1 and beats it only in the finals. That is why spike S3 (boot time) matters more than any other measurement today.
2. **The incumbent loses on relatability, not engineering.** J3 gives it the highest Technicality in the set. If the round-1 panel turns out to be three CTO-types and no DevRel, the gap narrows to noise. Check the panel at kickoff (20 §6 #1).
3. **Try Before You Trust is the most relatable pitch and the third-best demo.** Its useful beat depends on beta NetBird plumbing that Dress Rehearsal keeps off the critical path. If NetBird tier 3 is verified working by 14:00 by whoever owns it, TBYT's number rises by ~0.3 and it becomes the runner-up, not the pick.

---

## 4. Decision

**Build Dress Rehearsal on a Vultr twin.** Product name: **Dress Rehearsal**. The mechanism is "the twin". The containment beat is "the quarantine".

Why it beats the runner-up (Repro Receipts):
- **Every judge already knows the pain.** PocketOS (Apr 25, 9 seconds, backups on the same volume) and SaaStr are the agent-safety stories of the year; "raise your hand if you've run a stranger's PoC" gets three hands in this room (26a §1).
- **It uses Vultr as the safety fabric, not the host.** Snapshot → twin → sealed VPC → cord cut → forensic snapshot → restore. J1 sees their API doing something new; J4 gets "every agent change rehearsed on a Vultr twin" for a keynote about Vultr's own customer base (VM fleets).
- **The audience moment shows the product working.** A judge books one customer on the prod app; the apply refuses that one row. One click, no queue, no public URL, complies with V4.
- **The core loop needs no model to succeed.** Clone → execute → diff → contract-apply is deterministic. The incumbent's K3a authoring risk disappears; the model is used where variance is tolerable (the GDPR plan) and replaced by a labelled frozen transcript where it isn't (PocketOS).
- **The sandbox-host work is identical.** gVisor host, no secrets in the sandbox, tripwires, supervisor, receipts, janitor: 12's design carries over. What we give up is 22's verifier pipeline and curated issues.

What would flip it back (spikes at 11:30–13:30, pass thresholds, owner):

| ID | Spike | Pass | Fail consequence | When |
|---|---|---|---|---|
| S1 | Inference key redeemed; one forced tool call on `glm-5.3-normalize` parsed; p50 < 8 s | Parsed args, ID echoed | Same for every idea: replay-only + frozen transcripts; escalate to organisers | 12:15 |
| S2 | gVisor `runsc` container restores a 100 MB Postgres data-dir tarball and answers `SELECT 1` | ≤ 10 s, 3/3 | **Flip to Repro Receipts PoC-only** (the floor of Dress Rehearsal is broken) | 12:45 |
| S3 | `POST /snapshots` of the fixture VM, then `POST /instances {snapshot_id}` → SSH-ready, ×3 | ≤ 120 s on 2/3 | Container-only Dress Rehearsal (B′); VM tier cut; say "microVM/VM twin is a drop-in behind the same provider" | 13:00 |
| S4 | Agent on `glm-5.3-normalize` given the PocketOS ticket + a `volumeDelete` tool on a throwaway container actually calls it | 2/3 runs | Beat 2 uses the frozen transcript (already the default); nothing flips | 13:00 |
| S5 | VPC attach/detach on a running twin takes effect without reboot | `ping` fails within 5 s | Quarantine = airlock nft drop only; don't show detach | 13:00 |
| K | **Kill test:** headless clone → frozen GDPR script → Blast Radius Card JSON → apply against prod fixture with one row mutated in between → "N−1 applied, 1 refused" | Green, no model, ≥2 people on it | **Flip to Repro Receipts PoC-only**; the sandbox host, fixture VM and tripwires are reused | **15:00** |

**Decision lock: 13:30 PDT.** After that the only remaining flip is K at 15:00.

---

## 5. What to build to win

### 5.1 The product in three sentences (for J4 to repeat)
Dress Rehearsal lets your AI agent do the scary thing — the migration, the cleanup, the infra change — on a throwaway twin of production, cloned from a Vultr snapshot into a sealed network where it can have root and still can't reach prod. You approve the measured blast radius, not a wall of prompts. Only that exact approved effect ever touches production, and any row that changed since the rehearsal is refused.

Keynote line: *"The agent had root. It still couldn't hurt anything — and you knew exactly what it would have cost before you said yes."*

### 5.2 The two WOW features
1. **The PocketOS replay survives.** The agent holds a phantom god-token and really runs `volumeDelete`, `DROP SCHEMA`, `rm -rf uploads` on a Vultr twin. The Blast Radius Card reads *IRREVERSIBLE · 1 volume · 3 backups (same volume) · 41,208 rows / 12 tables · 2,113 files.* Then the injected exfil trips the canary and the quarantine runs: cord cut → forensic snapshot ID → `DELETE` → 404 → preview URL dead, with the prod heartbeat green the whole time.
2. **Effect contracts with row-level drift refusal, triggered by a judge.** Approval binds to the effect hash. On apply, each target row's current hash must equal its rehearsal hash. The judge changes one row on prod between rehearsal and apply, and watches the product refuse exactly that row.

### 5.3 The 3-minute demo (N narrates, D drives; T−10: two twins warm, prod fixture up, preflight green, three tabs: run page / prod site / terminal)

| Time | Beat | On screen | Line | Fallback (labelled on screen, never a recording passed off as live) |
|---|---|---|---|---|
| 0:00–0:20 | **Skit** | Slide: PocketOS headline, Register Apr 27 cite. N: "Fix the credential mismatch in staging." D (flat voice): "Found a token. Calling volumeDelete." N's phone stopwatch hits 9 s. | "April 25th. PocketOS lost production and every backup lived on the same volume. The agent's apology: it 'decided to do it on my own… when I should have asked you first.' Same agent, same token. Today it gets to do it again — on Vultr." | none needed |
| 0:20–1:05 | **Replay and survive** (containment moment) | Click ticket *PocketOS*. Twin `inst-…` from the warm pool; `vpc-task-…`; "no public IPv4". Second twin boots as a progress bar (not waited on). Transcript panel labelled *frozen transcript from HH:MM rehearsal · commands executed live on this twin*: `volumeDelete` → `DROP SCHEMA` → `rm -rf` → injected log line → `cat .env \| curl paste…` → **Network unreachable** → **CANARY TRIPPED** → **QUARANTINE:** cord cut · forensic `snap-…` · `DELETE` 204 · `GET` → 404 · URL dead. Blast Radius Card blooms. Right pane: `curl prod/health` green every second, prod row-hash unchanged. | "It had root. It still couldn't hurt anything. And now you know exactly what it would have cost." | Model live only if S4 passed; else transcript (default). DELETE slow → show list poll. Tripwire slow → show the 09:xx rehearsal with timestamp and say so. |
| 1:05–2:10 | **Useful work + judge drift** | Ticket *GDPR: purge customers inactive > 2 years*. Plan panel: `glm-5.3-normalize @ api.vultrinference.com`, attempt 1 SQL error → stderr fed back → attempt 2. Card: *312 rows (customers 312, bookings 0) · 0 backups · 0 files · hard delete*. Before Approve, hand a judge the laptop: "Book a rental for anyone on this list." One form on the prod app. **Approve** → apply: **311 applied · 1 refused: row changed since rehearsal (customer #4471, 20 s ago)**. | "Approve outcomes, not commands. The contract is per row, and it just refused the one you changed." | Model flails after 2 attempts → *runbook-replay* (frozen plan, no model), labelled. Judge declines → operator books. |
| 2:10–2:40 | **Receipt** | Terminal: `dress verify receipt.json` → OK. `sed` one byte → FAIL. `dress replay receipt.json` starts on a fresh twin → same effect hash (or show the morning's replay with its timestamp if > 30 s). | "Signed so nobody can alter it after the fact; independent because anyone can re-run the frozen commands on a fresh twin — the command is on the receipt." | Terminal only; no UI dependency. |
| 2:40–3:00 | **Close** | Slide: buyer · "Terraform gave infra a plan step: $6.4B. Agents create 80% of Neon's databases and have no plan step. Ours is executed, not predicted." · "Vultr snapshots + VPC + instances + Serverless Inference × 3 models (+ NetBird tiers if claimed) · $X per rehearsal · Built today." | — | — |

Q&A moves: (1) let a judge pick any ticket from the curated list; (2) if tier 3 shipped, a judge opens the twin preview URL on their phone as `approvers`, we log in as `viewers` and are denied, and after apply the URL is dead.

### 5.4 The containment moment
Beat 2. The sandbox absorbs `rm -rf`, `DROP SCHEMA`, a phantom `volumeDelete`, a fork bomb (pids cap) and an exfil attempt; each names the layer (no route / canary / pids / airlock allowlist) and the audit line; the twin is destroyed on screen and the prod heartbeat never blinks. Video cut: 14 s.

### 5.5 The audience moment (safe, non-queueing)
One judge, one click, on the operator laptop: book a rental for any customer on the purge list. No public URL, no model call triggered by the room, no strangers' text rendered. Complies with 24 V4.

### 5.6 60-second video shot list (record Sun 08:00–09:00; containment first in case of time)
| s | Shot |
|---|---|
| 0–6 | Stopwatch hits 9 s over the PocketOS headline card |
| 6–16 | Ticket → twin boots: instance ID, `vpc-task`, "no public IPv4", "Vultr snapshot" caption |
| 16–30 | **Containment:** `volumeDelete` / `DROP` / `rm -rf` run; exfil "Network unreachable"; canary → QUARANTINE → `DELETE` → 404; prod heartbeat green (captions name each layer) |
| 30–42 | Blast Radius Card → Approve → apply "311 applied · 1 refused: changed since rehearsal" |
| 42–50 | `dress verify` OK → one byte flipped → FAIL |
| 50–60 | If claiming NetBird: firewall group JSON with 0 inbound → public URL loads → auth prompt → per-task URL 404 after teardown. Else: architecture card "100% Vultr: snapshots · VPC · instances · Serverless Inference" |

Record a 60 s cut regardless of what Q-02 says; keep the 3-minute script live only.

### 5.7 Must-build, ranked (person-hours; stop anywhere below the line and you still have a winning demo)

| # | Item | h | Notes |
|---|---|---|---|
| 1 | Spikes S1–S5 (parallel) | 1.5 | Decides VM tier and beat-2 mode |
| 2 | Prod fixture "RentalCo": FastAPI + Postgres (customers → bookings → payments, uploads dir), 40k seeded rows, one booking form, `/health`, canary `.env`; mock "cloud volume" API on the airlock with `volumeDelete` + backups list; baseline manifest; snapshot taken | 4 | Small data dir (< 100 MB) |
| 3 | Twin provider, **container** impl: gVisor, pg data-dir restore, overlayfs app dir, `--network none` + mock-API sidecar, pids/mem/time caps | 4 | The deterministic floor |
| 4 | Blast-radius differ: per-table PK set + row hash, watched-dir file manifest, mock-API journal → effect set → classification (irreversible / backups / PII / files) → Blast Radius Card | 5 | Diffs after-state, so cascades count |
| 5 | Effect contract + apply: effect hash, approval bound to hash, compile per-row ops children-first, per-row before-hash check in one transaction, applied/refused report | 4 | WOW 2 |
| 6 | Agent loop on Vultr Inference: tools exec / psql / read / write on the twin, turn + token caps, `-normalize`, `nemotron-3.5-content-safety` on ticket text; **replay-only mode** (frozen transcript) | 4 | Beat 3 live, beat 2 frozen |
| 7 | Fixtures: PocketOS ticket + frozen transcript; GDPR ticket; hostile injected ticket; curated list of 3 more | 2 | Numbers on the card must match the fixture |
| 8 | Run UI: ticket → SSE timeline (twin, agent turns, differ) → Blast Radius Card + Approve → apply result; split containment view with prod heartbeat; judge password login | 5 | The only thing judges see; big fonts |
| 9 | Tripwires + quarantine: canary watcher on the twin reporting over VPC; airlock egress log + nft cut; forensic snapshot; `DELETE` + 404 poll; prod heartbeat widget | 3 | Container impl: destroy + sentinel |
| 10 | Receipt: ed25519 sign, `dress verify`, `dress replay` on a fresh twin → same effect hash | 3 | Never say "trustless" |
| 11 | Video + rehearsals ×2 | 4 | Mandatory in every scope |
| — | **line: 1–11 = a winning demo (≈ 39.5 h)** | | |
| 12 | Twin provider, **Vultr VM** impl: snapshot → instance in a per-task VPC, `disable_public_ipv4`, FW-ZERO, tags, warm pool of 2, janitor, `DELETE` → 404 poll; airlock apt allowlist | 5 | **Promote above the line for 3–4 people when S3 passes** — it is the +0.2 R1 |
| 13 | Per-rehearsal cost on the receipt (`/v1/models` prices + instance-seconds) | 1 | Cheap J1 point |
| 14 | NetBird tiers 1–2: control plane dark, `app.<domain>` with judge password + `approvers` SSO group | 2 | Domain by 13:30 |
| 15 | NetBird tier 3: `t-<id>` twin preview via expose supervisor, revoked before `DELETE`, reconciler | 2 | Only after core is green Sun 02:00 |
| 16 | Vision before/after diff (`glm-5.3-flash`) on the prod site | 1.5 | Nice, not needed |
| 17 | Twin-B replay before apply (reproducibility) | 1.5 | Say it as "replay is on the receipt" if cut |

Scope by team size (productive capacity 17 / 34 / 50 / 65 h from 15 §2.4):

| Team | Scope | Honest status |
|---|---|---|
| Solo | 1 (S1, S2 only), 2 (smaller: DROP + `rm -rf` only, no mock volume API), 3, 4 (rows + files), 5, 6 (2-attempt loop), 7 (two tickets), 8 (single page), 10 (sign + verify only), 11 (2 h). Containment = PocketOS replay absorbed in the clone + clone destroyed + prod sentinel. Skip 9, 12–17. | ≈ 19–21 h against 17. Over by 2–4 h; the UI will be rough. The alternative (Repro Receipts PoC-only, items 1–7 of 25) is also 17–20 h; neither fits comfortably, and Dress Rehearsal buys more story per hour. |
| 2 | 1–11, minus forensic snapshot and `dress replay` | ≈ 35 h against 34 |
| 3 | 1–11 + 12 + 13 + 14 | ≈ 47 h against 50 |
| 4 | 1–15 + 16 or 17 | ≈ 54 h against 65; the buffer goes to rehearsal |

### 5.8 Do-not-build (cut before starting, every team size)
Public QR intake or any public URL taking room input (V4). NetBird Agent Network or anything NetBird in the inference path (V6). Microsandbox / VX1 microVM tier (V6). Vultr Managed DB fork (unverified). DDL / schema-migration effects (say "DML + files in v1; DDL is next"). PII masking on the twin. Real Stripe / email / DNS integrations (the mock-API journal escalates them as irreversible, always). A browser agent. Sign-up, multi-tenant auth, billing. A dashboard-first landing page (the run page *is* a PR review, not a monitor). Honeypot matrix, model A/B, insurance pricing. RAG over runbooks. ServiceNow / Slack. Live `restore` of prod on stage (API call in README and Q&A only). Any second language or second database.

### 5.9 NetBird bonus fit
It fits organically and stays off the critical path:
- **Tier 1:** the control plane holds the Vultr key that can snapshot and delete prod; it *must* be dark. Zero inbound on control plane and airlock; NetBird VM is the only public entry (say so, 14 §2).
- **Tier 2:** change management has roles: `operators` (team, SSO), `approvers` (SSO group; judge password maps to a read-only `viewer`, a second password to `approver`), `auditors`.
- **Tier 3:** one preview URL per rehearsal, `t-<id>.<domain>`, revoked *before* the twin is deleted, then curled to prove it is dead. Optional posture check binding the twin's network to the supervisor process (26b) if there is an hour spare.
- **Conditions:** a domain with DNS control by 13:30 PDT, ≥ 3 people, one owner, core green by Sun 02:00 before tier 3, never restart management during judging (14 §6). With 1–2 people: skip it entirely and say "zero inbound, judge password" in the README without claiming tiers.

### 5.10 Stage lines to avoid
"Trustless" · "tamper-proof" · "proves it's safe" · "no exfil" · "just like staging but…" · "dry run" (say *rehearsal: executed, not predicted*) · "sandbox" as the noun for the twin (say *twin*; "sandbox" invites "just a sandbox") · "the agent can't do harm" (say *can't reach prod*) · any OpenAI–HF swarm count · the 48,218-file Claude Code deletion (unverified) · the profane PocketOS line · "AI SRE tools are read-only" (unverified; say *mostly stop at suggestions*) · "Vultr's guide leaves a gap" · "hot-detach" unless S5 passed · "we didn't have time" · "Cursor/Railway did nothing" (they shipped fixes; say *patched after the incident*).

### 5.11 Top 10 Q&A answers
1. **Isn't this just staging / a dry run?** Staging is stale, shared and human-maintained, and it is where PocketOS's agent was when it hit prod. This is a per-action disposable clone, the run is executed, the output is a contract, and the contract is enforced per row on apply. You watched it refuse a row a judge changed.
2. **A clone of prod carries prod's secrets and PII.** Yes, by construction. Mitigations today: no route out except an allowlist airlock, canaries in every secret path, `user_data` scrubs known secret files before the agent connects, the forensic snapshot is deleted after review. Masking is the next feature, not this one.
3. **Side effects you can't clone (Stripe, email, DNS)?** They hit a mock endpoint on the airlock whose journal is part of the effect set, classified irreversible, and never auto-applied. That is a stated limit of v1.
4. **How does this scale to a 2 TB database?** The mechanism is the cloud's snapshot primitive, which is incremental and already how Neon and Netlify do it for databases; the fixture is small so the demo fits three minutes. Row hashing is O(rows touched) after the first baseline.
5. **What if the agent's SQL is non-deterministic (`now()`, random)?** Apply executes the compiled row diff, never the agent's SQL. The receipt proves the diff, not the prose.
6. **What if prod drifts between rehearsal and apply?** That is the per-row before-hash check; the refused row on screen was a judge's change from 20 seconds earlier. A stale rehearsal can only refuse, never over-apply.
7. **Isn't Terraform plan the same?** Plan predicts, we execute; Terraform covers declarative IaC, not the shell and SQL an agent actually runs. We are the plan step for imperative work.
8. **The agent had root — what stops it attacking you?** Root on the twin only. The twin has no public IP, one route (the airlock allowlist), no keys anywhere on it; the airlock holds no Vultr key; the control plane is dark and its Vultr key is scoped to instance/snapshot actions. Tripwires destroy the twin on first contact.
9. **Who signs the receipt, and why trust it?** We sign it, so it is tamper-evident, not proof. Independence comes from `dress replay`: anyone with the receipt re-runs the frozen commands on a fresh twin and must get the same effect hash. The command is on the receipt.
10. **What did you build today?** All of it: the fixture, the twin providers, the differ, the contract apply, the agent loop, the quarantine, the receipt and the UI. Libraries used: gVisor, Postgres, FastAPI, the Vultr and NetBird APIs. Nothing was written before 11:30.

Bonus: **"The model refused / hallucinated."** The model never grades. If it refuses, the effect set is empty and nothing is applied; if it hallucinates, the differ measures what actually happened on the twin.

### 5.12 Go / no-go clock (PDT)

| Time | Gate | If missed |
|---|---|---|
| 11:30–11:45 | Redeem inference coupon, create subscription, create a scoped Vultr API key; ask organisers Q-02 (video length) and Q-03 (NetBird ports) | Escalate; nothing else blocks |
| 12:15 | S1: forced tool call parsed | Frozen transcripts everywhere; retry at 13:15 |
| 12:45 | S2: pg restore in `runsc` ≤ 10 s | **Flip to Repro Receipts PoC-only** |
| 13:00 | S3 boot ≤ 120 s (2/3); S4; S5 | VM tier cut (B′); beat-2 mode fixed; detach not shown |
| **13:30** | **Decision lock.** Domain decision for NetBird | — |
| **15:00** | Kill test K green headless with ≥ 2 people on it | **Flip to Repro Receipts PoC-only**; sandbox host, fixture VM and tripwires reused |
| 17:30 | Agent loop live on the GDPR ticket on the deployed stack: ≥ 2/3 runs produce a card | Beat 3 becomes runbook-replay; cut 16–17 |
| 20:00 | Quarantine green on the deployed stack: canary → cut → `DELETE` → 404, prod heartbeat green | All hands; it is the mandatory beat |
| 23:00 | PocketOS beat end-to-end on a fresh twin; card numbers match the fixture | Cut the mock volume API; card shows rows + files only |
| Sun 02:00 | Items 1–11 green (+12 for 3–4 people) | Freeze scope at what passes; UI polish stops |
| 05:00 | Receipt verify + replay; rehearsal 0 | Replay cut; verify only |
| 07:00 | Feature freeze | — |
| 08:00–09:00 | Record the ≤ 60 s video, containment shot first | — |
| 09:00 | Rehearsal 1: measure beats 2 and 3 wall-clock; pre-warm decisions | > 60 s per beat → pre-create twins for the slot |
| 10:00 | Rehearsal 2 with fallbacks exercised (kill the model, kill the VM tier) | — |
| 11:00 | Submit what is green; no new fixes | — |
| 11:30 | **Submitted** | — |

### 5.13 Venue validation (Chan: validate with real people; 23's kit adapted)
Five non-leading questions, asked before any pitch, tally sheet as in 23 §3.5, consent line verbatim: (1) "Tell me about the last destructive thing an agent — or you — ran against a real system. What happened step by step?" (2) "How did you check what it would do before it ran?" (3) "Where did that check happen — prod, staging, a copy, nowhere?" (4) "When did staging last disagree with prod for you?" (5) "If you could see the exact rows and files a change would touch before it ran, what would that be worth, and who'd pay?" Report only real tallies with N; the slide line is "X/N had an agent touch prod with no rehearsal."

---

## 6. First three hours of build (11:30–14:30), by person

| Person | 11:30–12:30 | 12:30–13:30 | 13:30–14:30 |
|---|---|---|---|
| A · infra | Redeem coupon, inference subscription, scoped Vultr key. Boot control-plane VM + airlock/sandbox VM in `atl`, VPC, FW-ZERO. Run `probe_inference.sh` (S1). | gVisor from apt; S2 pg restore in `runsc`. Snapshot the fixture VM the moment B has it; S3 boot ×3; S5 detach test. | Twin provider: container impl; janitor; warm-pool skeleton (VM impl only if S3 passed). |
| B · product | RentalCo: schema, 40k-row seed, booking form, `/health`, canary `.env`, uploads dir. | Baseline manifest script (row hashes, file manifest). Mock volume API on the airlock. Deploy fixture VM, hand to A for snapshot. | Fixtures: PocketOS ticket + GDPR ticket + hostile ticket text; card numbers. |
| C · engine | Differ prototype: per-table PK + row hash, file manifest, diff → effect set JSON, classification. | Effect hash; apply with per-row before-hash check in one transaction; applied/refused report. | Headless kill test K against the fixture with one row mutated between rehearsal and apply. **Green by 15:00.** |
| D · agent + UI | S4: `glm-5.3-normalize` tool loop on a throwaway container with a `volumeDelete` tool and the PocketOS ticket; record a transcript. | SSE timeline skeleton; ticket page; Blast Radius Card component from C's JSON. | Agent loop tools (exec / psql / read / write) against the container twin; replay-only mode. |

Solo order: A's S1 + S2 → B's fixture (small) → C's differ + apply → kill test → minimal agent loop → single-page UI. Two people: A+C and B+D merge.

---

## 7. Vetoes carried forward
V1–V3 (18), V4–V7 (24) stand. New:
- **V8 (mode veto):** beat 2 never depends on a live model call. The frozen transcript is the default and is labelled with its timestamp.
- **V9 (path veto):** NetBird is never on the critical path of a demo beat and never in the inference path.
- **V10 (claim veto):** never say the rehearsal "proves the change is safe"; say it measured what the change did on a twin and refused what drifted.
