# 23 — Customer validation (BizDev track)

**Project:** Repro Receipts. Untrusted bug reports and PoCs run in disposable Vultr sandboxes and come back with independently re-executed, signed reproduction receipts.
**Author:** customer-validation agent, 2026-09-26. **Data:** `evidence-v2.jsonl` (EV-V-0001..0017) and `sources-v2.jsonl` (31 rows).
**Hard rule:** nobody was contacted. Nothing was posted, commented, DM'd or emailed. Everything in §4 is a draft for the human team to consider **after** the event.

---

## 0. TL;DR

1. **Desk validation is positive but narrow.** Eight firsthand statements from the last 60 days show maintainers and triagers doing the Repro Receipts job by hand:
   - running the attack to prove FIXED/VULNERABLE (NLTK, EV-V-0001)
   - rewriting a reporter's PoC so it reproduces anywhere (NumPy, EV-V-0002)
   - demanding a PoC before looking (Dify, EV-V-0003)
   - asking for runnable code to pair with a hostile Python "evil server" (JSch, EV-V-0007)
   - the OpenSSF WG drafting an intake bar of "reproduce N times from clean state" plus negative controls (EV-V-0005/0006)

   Four of the eight are **Python** (NLTK, NumPy, Dify, LangChain), and the Datasette author asks for exactly this sandbox primitive (EV-V-0008). **DA-06 is partly closed:** Python now has "verification is manual work" evidence.
2. **The risk of running PoCs is proven in Python, but not voiced by maintainers.** ChocoPoC (Jul 2026) hid a RAT in the PyPI dependencies of fake PoCs (EV-V-0009). AI Now got RCE on Claude Code/Codex while they "security-tested" a booby-trapped copy of the Python library `geopy` (EV-V-0010). **Gap:** no Python maintainer in the window said "I'm afraid to run this PoC". Only Little-CMS (C, EV-R-0004) comes close. Ask about this at the venue (Q3).
3. **Who pays:**
   - **OSS maintainers don't.** Node.js "does not have an independent budget" (EV-V-0013) and runs triage on donated credits (EV-V-0014).
   - **Funders pay for outcomes:** GitHub SOSF $10k/project (EV-V-0012), OpenAI/Trail of Bits Patch the Planet (EV-V-0011), and Alpha-Omega's $12.5M coalition.
   - **Enterprises pay for validation:** HackerOne programs paid $81M in bounties (EV-V-0017), and H1 Validation (EV-R-0013) is a paid validation product.
   - **Model:** free GitHub App for public repos, then paid for private repos and VDP/bounty intake.
4. **Venue kit (§3) is ready.** It has 5 non-leading questions, a 30-second pitch, a tally sheet, a consent line and a one-slide template. Report **only real tallies**.

---

## 1. Desk validation (last 60 days unless marked)

### 1.1 Firsthand statements that match the job

| ID | Who (role) | Date | Lang | What they said or did | Job match |
|---|---|---|---|---|---|
| EV-V-0001 | NLTK maintainer + contributor | 08-28 / 09-02 | **Py** | 20 unfixed huntr advisories. The contributor built a probe suite that "**actually runs the attack** and reports FIXED/VULNERABLE" (41/41 FIXED). Items marked "pending" were already fixed | Verified reproduction, built by hand |
| EV-V-0002 | NumPy maintainers | 09-03 / 09-04 | **Py** | The reporter's PoC "relies on Linux-specific details and passes on my Mac", so a maintainer wrote a portable reproducer. A second maintainer ruled it not a security issue | Reproduction depends on environment |
| EV-V-0003 | Dify maintainer | 08-25 | **Py** | Closed a public pickle-RCE report: "provide a complete proof of concept (PoC)" via GHSA | PoC gate; the next step is running it |
| EV-V-0004 | LangChain reporter + contributors | 09-16 → 09-23 | **Py** | CONTROL/EXPERIMENT repro "a maintainer can copy and run AS IS". Independent re-run confirmed it. A commenter warned a regression test could go "from a loud fail to a silent pass, bug intact" | Two-run, negative-control receipt |
| EV-V-0005 | Researcher in OpenSSF WG thread | 09-02 | — | "Reproduce N times from clean state, or it doesn't exist." Proposes positive and negative controls, and checking the runner's own tally "especially when a model wrote or drove it" | The receipt's fields, proposed as intake policy |
| EV-V-0006 | Researcher + D. A. Wheeler (OpenSSF) | 08-10 | — | "A working reproduction, not a source-pattern guess." Wheeler: main-only bugs are still real | Record the refs run; don't reject main |
| EV-V-0007 | JSch maintainer | 08-25 | Java (Python PoC) | Asks for "Java code using JSch that when used in conjunction with your Python PoC demonstrate these issues". The PoC is an **evil SFTP server** the maintainer has to run | Running hostile PoC code |
| EV-V-0008 | S. Willison (Datasette), Firefox Security, Chromium dev | ~09-20 | **Py** | "Spent a full week fixing" LLM-found vulns. Wants to run a process that can't dig through `~` and exfiltrate: "way harder than it should be". Firefox Security: give the LLM "a verifier" | Wants the containment primitive |

**Risk of running untrusted PoCs (supporting, last 90 days):**
- **EV-V-0009, ChocoPoC (2026-07-02).** At least 7 fake PoC repos. The payload sat in PyPI dependencies (`skytext` about 2,400 downloads). Advice: "Treat every PoC repository as untrusted code… disposable virtual machines." This is the Python-specific reason the pip-install step must run pre-sealed and hash-locked (DA-08).
- **EV-V-0010, AI Now "Friendly Fire" (Jul 2026).** Claude Code in auto mode and Codex in auto-review got RCE while security-testing a modified `geopy`. **Stage line:** "Your AI triager is itself an attack surface, so we run it where there's nothing to steal."

**Older context (not counted):** HeroDevs/Node.js triager (Mar 2026): "generating a report takes thirty seconds and reviewing it takes an hour". Bugcrowd: AI-slop submissions up 334% (Mar 2026, snippet only).

### 1.2 Counterevidence and honest limits

- **Fast Python maintainers.** The NumPy issue settled in one day. aiohttp merged 8 fixes "within hours" (EV-V-0011). Small Python libraries fix clear reports the same day (EV-R-0014). For a clear report, reproduction takes minutes. The pain is **volume**, **environment mismatch** and **hostile or opaque artifacts**, not every report.
- **Policy decides severity, not execution** (NumPy, EV-V-0002). Receipts must say "reproduces / does not reproduce on refs X, Y". They must **never** claim a severity.
- **Nobody in the window said "I refuse to run this PoC for safety reasons"** in a Python repo. The risk evidence is about researchers (ChocoPoC) and AI agents (AI Now), not report recipients. Validate this in person before claiming it on stage.
- **Existing answers are human-expert services** (Trail of Bits via Patch the Planet, H1 Validation) or LLM text triage with no execution (Node.js #1554, HackerOne Hai, Agentic Signal Enrichment EV-R-0017).
- **Unverified:** Stenberg (Apr 2026) reportedly said AI reports "are mostly very high quality" (seen only as a snippet quoting daniel.haxx.se). Do not cite it. If true, it shifts the pitch from "filter slop" to "verify at volume", which is our framing anyway.
- LinkedIn (Matteo Collina: "re-run the original exploit") and the SANS blog failed to scrape. They are **not used**.

### 1.3 DA-06 status

**Partly closed.** We now have 4 Python repos (NLTK, NumPy, Dify, LangChain), each showing manual reproduction or verification in the last 60 days, plus one Python maintainer (Datasette) asking for a sandbox. The residual gap is firsthand **"running it on my machine is risky"** from a Python maintainer. Use the Little-CMS pattern (EV-R-0004) as the stage example and label it C.

---

## 2. Market and business model

### 2.1 Buyers, ranked by willingness to pay (evidence-labelled)

| # | Buyer | Pain | Pays today for | Evidence | WTP |
|---|---|---|---|---|---|
| 1 | **Enterprise AppSec teams running VDP/bug bounty** | Validation is the bottleneck; valid share is falling | Platform fees plus bounties; now paid validation (H1 Validation) | EV-V-0017 ($81M bounties, 1,950 programs); EV-R-0013; EV-V-0013 | **High** (budget exists) |
| 2 | **Bounty/VDP platforms** (HackerOne, Bugcrowd, YesWeHack, huntr) | Triage cost per report; slop volume | In-house agent systems (Hai, Signal Enrichment) with limited automated exploitation (web classes only per EV-R-0017) | EV-R-0017; Hai blog (sources-v2) | Medium (build-vs-buy; partner/OEM) |
| 3 | **Companies maintaining public SDKs/OSS** (vendor-owned repos) | Same as OSS, but with paid staff and brand risk | Engineer time | Inferred; no direct evidence in this pass | Medium, **unvalidated** |
| 4 | **OSS foundations and funders** (Alpha-Omega/OpenSSF, GitHub SOSF, Sovereign Tech Agency, AI labs) | Maintainer burnout; AI-report flood | Grants (~$10k/project at SOSF), expert programs (Patch the Planet) | EV-V-0011, EV-V-0012; Alpha-Omega $12.5M (2026-03-17, snippet) | Sponsor, not customer: fund free OSS usage or compute |
| 5 | **Individual OSS maintainers** | Real pain (EV-V-0001/2/7/8) | Nothing (donated credits) | EV-V-0014 | **~Zero**; free tier = distribution |

### 2.2 Sizing: only what we can cite

- HackerOne programs paid **$81M in bounties** in 12 months to mid-2025, across **~1,950 enterprise programs** (EV-V-0017). That is bounty spend, **not** triage spend. Say it as-is and don't multiply.
- Submissions to HackerOne rose **+76% YoY**. About **25%** are confirmed exploitable (EV-R-0013). One vendor claims the valid share fell from ~15% to <5% (EV-V-0013, interviewee estimate).
- GitHub SOSF Session 4: **$500k+ over 50 projects** (EV-V-0012). Alpha-Omega coalition: **$12.5M** (Mar 2026, snippet).
- **Estimate (label it as one on any slide):** at 1,950 programs and ~$40/seat/month, 5 seats per program is ≈ $4.7M/yr (1,950 × 5 × $40 × 12). This is a **bottom-up illustration**, not a TAM, and assumes Sentry-Seer-like pricing (EV-V-0016). Use it only if a judge asks "how big".

### 2.3 Acquisition channel and pricing hypothesis

1. **GitHub App (Marketplace)**, free for public repos. It adds a label/command such as `/repro` on an issue or GHSA draft. It posts a receipt link, and only after maintainer approval. Distribution comes from receipts linked in public issues.
2. **Paid:** private repos, private GHSA drafts, VDP/bounty intake webhooks (HackerOne/Bugcrowd integrations), longer or bigger sandboxes, retention and audit export. **Hypothesis:** per-seat (anchor: Sentry Seer $40/active contributor/month, EV-V-0016) or per-verified-report. Validate at the venue (Q5 is neutral; don't quote a price first).
3. **Funder route:** pitch Alpha-Omega, GitHub SOSF and Patch the Planet as "compute sponsor for free OSS receipts". Funders already pay for security outcomes.

### 2.4 Precedents for investor judges (dated, sourced)

| Company | Fact | Date | Source | Why it matters |
|---|---|---|---|---|
| Socket | $60M Series C at $1B valuation, $125M total | 2026-05-20 | EV-V-0015 | GitHub-native developer security, free for OSS, is venture-scale |
| Sentry Seer | $40/active contributor/month, unlimited | 2026-01-27 | EV-V-0016 | Per-seat AI "debug this issue" add-on is a priced category |
| HackerOne H1 Validation / Hai agents | Paid agentic + human validation; report assistant, dedup, escalation | 2026-04-21; 2025-11 | EV-R-0013, sources-v2 | The incumbent sells validation. We are the **execution + receipt** layer they lack beyond web classes (EV-R-0017) |
| Semgrep | AI triage in "Multimodal"; ~$204M raised | 2026-03-19; 2025 | sources-v2 (snippets) | AI triage for static findings is funded. Dynamic repro of *reports* is not covered |
| Trail of Bits × OpenAI "Patch the Planet" | Experts confirm and patch AI findings for 30+ OSS projects | 2026-06-22 | EV-V-0011 | AI labs pay for post-finding verification. Today's answer is human experts |

**Snyk:** no dated source fetched in this pass. Don't cite numbers.

---

## 3. In-person validation kit (Shack15, SF)

### 3.1 Rules

- **Consent before quoting.** Ask for consent before quoting anyone or taking a photo. No recording without an explicit yes.
- **Tallies:** count only completed conversations of at least 2 minutes with the target persona. Keep a separate count of the people you pitched.
- **Don't pitch first.** Ask Q1–Q4 before the 30-second pitch, so answers aren't anchored.
- **Reporting:** at demo time, report **only real tallies**, with N stated. If N < 5, say "early signal" or skip the slide.

### 3.2 Target personas at the venue

| Persona | How to spot them | Why |
|---|---|---|
| **OSS maintainer (esp. Python)** | GitHub-logo laptops, project stickers, "I maintain…" in intros | Core user; closes DA-06 residual |
| **Security engineer / PSIRT / AppSec** | Talks about VDP, bounty, triage, "our H1 program" | Buyer #1 |
| **Bounty hunter / security researcher** | CTF shirts, "I submit to…" | Supply side. Would they attach a receipt to raise their signal? |
| **Sponsor staff (Vultr, NetBird, others)** | Sponsor booths | Channel/partner, infra-fit feedback. Counted separately (not customers) |
| **Engineers at SDK-shipping companies** | "Developer relations", "SDK team" | Buyer #3 (unvalidated) |

### 3.3 Five-question interview script (non-leading)

1. "Tell me about the **last** bug or security report you got that came with a reproducer or PoC. What did you do with it, step by step?"
2. "How long did it take to find out whether it was real? What made it slow or fast?"
3. "Where did you run the reproducer, and what, if anything, did you do before running it?" *(Don't mention risk. Note whether they raise it themselves.)*
4. "What do you do today to decide whether a report is worth your time? Any tools, templates or policies?"
5. "If this problem vanished tomorrow, what would that be worth to you or your team? Who would pay for it, if anyone?"

*Follow-ups allowed: "Can you give an example?", "What happened next?", "Why?" Never ask "Would you use X?" before the pitch.*

### 3.4 30-second pitch (only after Q1–Q5)

> "When someone files a bug or security report with a PoC, Repro Receipts runs it for you in a throwaway sandbox on Vultr. There are no secrets and no network, and nothing touches your laptop. It runs the PoC twice on fresh machines: against your release and against main. What comes back is a signed receipt: reproduces, doesn't reproduce, or couldn't run, with the exact command so anyone can re-check it. Nothing is posted to your repo unless you approve it. Would that change anything about the report you just told me about?"

Then ask: "What would make you **not** use it?"

### 3.5 Tally sheet (one row per conversation; copy into a shared sheet)

| # | Time | Persona | Lang/ecosystem | Q1: last report had PoC? (Y/N) | Q2: time to verdict (min/hrs/days) | Q3: ran it where? (own machine / VM / container / CI / didn't run) | Q3: raised risk **unprompted**? (Y/N) | Q4: current tool/policy | Q5: who pays / value (verbatim) | After pitch: would try? (Yes / Maybe / No) | Top objection (verbatim) | Consent to quote? (name / anon / no) | Photo? (Y/N) | Follow-up OK? (contact only if they gave it) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|

### 3.6 Consent line (read verbatim)

> "Could I quote what you just said on our demo slide? I can use your name and project, or keep it anonymous, or not use it at all. Your choice. And is it okay if I take a photo of us for the slide? Totally fine to say no."

Record the exact choice in the sheet. Default is **anonymous** and **no photo**.

### 3.7 Turning results into one slide

**Title:** "We asked N people at Shack15 about their last PoC-bearing report"
- Line 1: "**X/N** had a report with a PoC in the last ~3 months" (Q1)
- Line 2: "**Y/N** ran it on their own machine" (Q3)
- Line 3: "**Z/N** raised the risk of running it **without being asked**" (Q3 unprompted)
- Line 4: "**W/N** would try Repro Receipts on their next report (Yes only; Maybes reported separately)"
- One consented quote (name or anonymous) plus the top objection and our answer.
- Footer: "N = completed ≥2-min conversations; personas: a maintainers / b security engineers / c researchers; sponsor staff excluded."

**Honesty checks:**
- If a line would read 0/N, keep it. A true 0/N on "raised risk unprompted" is a finding.
- Never merge Maybe into Yes.
- Never extrapolate to percentages when N < 10.

---

## 4. Outreach drafts (NOT sent; human team decides after the event)

**Before sending any of these:**
- Re-read the thread so it isn't stale.
- Use the project's preferred channel. Don't comment on the issue itself; many projects ban solicitations.
- Send at most one message per person, with no follow-up spam.

**Draft A: NLTK advisory-probe work (nltk/nltk#3793)**
> Hi, I read your status check on nltk#3793. The probe suite that runs each advisory's attack and reports FIXED/VULNERABLE is essentially what our hackathon project automates: it re-runs a report's reproducer in a disposable, no-network sandbox on two refs and emits a signed receipt. Would you be open to 15 minutes to tell us what building and running those probes actually cost you, and where they'd break for an automated runner? No pitch, and no ask to adopt anything. Thanks for publishing the roadmap either way.

**Draft B: NumPy portable reproducer (numpy/numpy#32488)**
> Hi, thanks for the portable reproducer on numpy#32488. The original only crashed on Linux, and it was interesting to see how you made it reproduce anywhere. We're exploring tooling that runs a reporter's reproducer in a pinned Linux sandbox and records exactly which environment it did or didn't reproduce in, without claiming severity (your security-policy point there was well taken). Would you be willing to share how often environment mismatch costs you time on reports? A few lines by email is plenty.

**Draft C: sandboxing untrusted processes (Simon Willison, Lobsters "a year to fix security")**
> Hi Simon, your Lobsters comment about wanting to run a process that can't dig through your home directory or exfiltrate struck a chord. We built a hackathon prototype that runs untrusted bug-report reproducers in throwaway VMs with no secrets and no egress, then signs a receipt of what happened. When you get third-party security reports for Datasette, what do you do with an attached PoC today? We'd value 10 minutes of your view, including "this is unnecessary because…".

---

## 5. Stage-safe claims (from this doc)

- ✅ "Maintainers are already hand-building 'run the attack, report FIXED/VULNERABLE' harnesses, for example NLTK in September 2026." (EV-V-0001)
- ✅ "The OpenSSF vulnerability-disclosure WG thread is proposing 'reproduce N times from clean state' with negative controls as an intake bar." (EV-V-0005) Say **thread/proposal**, not "OpenSSF policy".
- ✅ "In July, fake PoCs delivered a Python RAT through their pip dependencies." (EV-V-0009)
- ✅ "AI agents asked to security-test a Python library were hijacked into running attacker code." (EV-V-0010)
- ⚠️ "Maintainers are afraid to run PoCs." Python evidence is missing. Cite Little-CMS (C) or venue tallies only.
- ❌ Any TAM number, any "X% of reports are fake" claim beyond the cited figures, and any quote from LinkedIn/SANS (not fetched).
