# 20 · Judges, "API judge" features and winning patterns

Researched 2026-09-26, 12:30–13:05 UTC (05:30–06:05 PDT). Raw scrapes are in `.firecrawl/judges/` (gitignored). Sources are in `sources-w.jsonl`. This builds on 06 (meta strategy) and 14 (NetBird plan) and does not repeat them.

Framework: Gary-Yau Chan's 8-step guide. The four judge types are **API** (sponsor evangelist), **CTO** (is it real, where does it break), **investor** (market, precedent) and **BD** (would I use or buy it). Pitch order: problem → solution → market → validation → demo → business model → future → team.

Confidence labels: **[C]** confirmed by a primary source, **[S]** search snippet only (LinkedIn, Facebook and X are not scrapeable), **[I]** inference.

---

## 1. Who is in the room

**The judge list is still not public.** `cerebralvalley.ai/e/vultr-the-agent-arena/details` needs a CV login, and no public post names judges. The people below come from the organisers' own promo posts for this event (Sep 22 2026). Each post tags the same set of people, which usually means the host team plus partners. **Someone who can log in should check `/details` or Discord at kickoff and fix this table.**

| Person | Role, company | Link to this event | Likely judge type | What they publicly care about (2026) | Confidence |
|---|---|---|---|---|---|
| **Kevin Cochrane** | CMO, Vultr | Wrote an event promo post that tags Kartikey, Ivan Porollo and Brandon Hopkins. Gave out the Vultr-track prizes at RAISE 2026 | BD + investor (marketing story) | "Real agents working in real sandboxes doing real work – with full governance and compliance to boot" (06). Keynotes on the "Agentic Enterprise": rethink infra, **own your data**, "scarcity is not a moat", cost efficiency without hyperscaler lock-in (Ai4, theCUBE GTC/SUSECON, Techstrong 2026) | Event role [C]; judge [I] |
| **Mayank Debnath** | Director, Developer Relations, Vultr | Wrote an event promo post ("The next phase of AI will be defined by agents that can act, not just respond") tagging Brandon Hopkins (NetBird), Sanskriti, Kartikey, Ivan Porollo | **API judge** | Developer adoption of Vultr primitives; runs the "Getting Started on Vultr" workshops | [S]; judge [I] |
| **Mirdul S.** | Vultr DevRel | Wrote an event promo post: "AI agents are becoming distributed systems. So how do you securely connect everything they need to operate?" and plugs NetBird | API + CTO | Secure connectivity between agent components, i.e. the NetBird angle | [S]; judge [I] |
| **Kartikey (Gaur)** | Vultr DevRel/solutions | Tagged in the Cochrane and Debnath posts; also tagged on the RAISE winners post | CTO / API | Hands-on Vultr usage | [S]; judge [I] |
| **Sanskriti Harmukh** | Developer Relations Advocate, Vultr | Tagged in the Debnath post | API | Developer experience, tutorials | [S]; judge [I] |
| **Brandon Hopkins** (@TechHutTV) | Head of Content & Developer Relations, **NetBird** | Posted "Heading to San Francisco this weekend for The Agent Arena Hackathon… NetBird is one of the track partners, and **I'm doing a quick demo**…" Author of NetBird's newsletters and the Agent Network launch post | **API judge for the NetBird bonus** (very likely); possibly main pool | Self-hosting and homelab; the NetBird reverse proxy; **NetBird Agent Network** (keyless LLM access, Jun 28 2026); Control Center Draft mode (Sep 2026). Writes "Keeping it honest" sections, so he likes candour about limits | Attending [C via snippet on X and LinkedIn]; judge [I, high] |
| **Ivan Porollo** | Founder, Cerebral Valley | Tagged in the Vultr posts; CV produces the event | Investor / ecosystem | CV's usual taste (see §5): real systems, one crisp number, "could this be a company" | [S]; judge [I, medium] |
| Nima Sadeghifard / Kim Harre | NetBird (growth, Berlin) | Came up in searches for this event only; no direct link | — | — | [S], probably not present |
| Other Vultr staff who might appear | Piyush Shukla (Dir. PMM GPU and AI), Bhavya Sachdeva (DevRel), Madhav Ahuja (Field Marketing) | Surfaced only in LinkedIn searches | — | — | [I, low] |

**Is CopilotKit involved? No evidence.** It is not on the CV page, in the Vultr, NetBird or Cochrane posts, or in the Facebook promo. CopilotKit's only connection to us is that OpenBot and OpenMuse depend on hosted CopilotKit Intelligence, which is why we did not deploy them (00 §5). CopilotKit also ran a *different* SF hackathon on "Saturday, September 27" (AI Tinkerers, with LlamaIndex, Composio and B Capital). That page is an older event whose weekday doesn't match 2026. **Do not add CopilotKit to win a judge. It earns nothing here and brings back a non-Vultr dependency.**

The Facebook snippet mentioning "Elastic or Fivetran" partner tools comes from a *different* Vultr/Google Cloud post that got merged into the same result. **Ignore it.**

**Expected panel shape [I].** Round 1: Vultr DevRel (Debnath, Mirdul, Kartikey, Sanskriti) plus Brandon Hopkins, possibly with 1–2 CV ecosystem judges. Finals: add Cochrane and Porollo. So round 1 is **API/CTO heavy** (Technicality 40), and the finals are **BD/investor heavy** (equal weights, storytelling).

---

## 2. Tactics per judge type, mapped to Repro Receipts

| Judge type | Who | What earns points | What we show or say |
|---|---|---|---|
| **API (Vultr)** | Debnath, Mirdul, Kartikey, Sanskriti | Meaningful, *unusual* use of Vultr beyond "a VM that hosts my app". They want to recognise their own docs and launches | The Vultr API creates and destroys a throwaway VM per high-risk report (instance ID shown live, then 404). A **Microsandbox microVM on VX1**, following Vultr's own Agent Sandboxing guide (§3). `nemotron-3.5-content-safety` as a pre-dispatch guard. Per-verdict cost read from Vultr's billing and inference usage and printed on the receipt. Say the product names out loud |
| **API (NetBird)** | Brandon Hopkins | Features he just launched, used for real: reverse proxy, lifecycle-bound expose, **Agent Network**. Honesty about beta limits | **Agent Network in front of Vultr Serverless Inference**: the agent host has no key and the tunnel is the credential. A per-report `netbird expose` URL that dies with the sandbox. Zero inbound rules on app and sandbox VMs. Per-identity token and budget cap blocks a runaway loop live (§4) |
| **CTO** | Vultr solutions/DevRel, any engineer judge | Where does it break? Secrets, egress, kernel sharing, teardown leaks, prompt injection, cost at scale | Answer with the design, not adjectives: separate VM with no secrets; default-deny egress enforced outside the sandbox; microVM kernel for hostile PoCs; a tag-based janitor for leaked VMs; the model never decides the verdict (exit codes and signatures do); verify-only replay with no model. Have a "failure modes" slide with **3 known limits** ready |
| **Investor** | Porollo, CV ecosystem judges | Market size, precedent, why now | Why now: GitHub anti-spam limits (Jun 2026), Pallets "13 issues + 75 PRs rejected as AI" in 30 days, the OpenAI–HF sandbox escape. Precedent: syzbot/ClusterFuzz prove that re-execution works at scale for fuzzers, and triagebot-action (Astro, ~200→30 open issues) proves that demand exists. Market: OSS maintainers → security triage (bug bounty platforms, PSIRTs) → enterprise vuln intake |
| **BD** | Cochrane | "Could I sell this / write a case study?" A named buyer, a revenue model, a Vultr pull-through | Buyer: a security triage team receiving PoC-bearing reports (bounty platforms, PSIRTs). Pricing: per verified receipt, with every receipt billing Vultr compute and inference, which is **usage pull-through for Vultr**. Phrase it as a case-study headline: "Runs 100% on Vultr VX1 + Serverless Inference + self-hosted NetBird" |

---

## 3. Vultr features ranked by "API judge wow × feasibility in 24 h"

Scores run 1–5. **Rank = wow × feasibility.** "Unusual" means few teams will use it. Everything here is available today (02, 13, live API catalog) unless marked.

| # | Feature | How Repro Receipts uses it | Wow | Feas. | Rank | Notes |
|---|---|---|---|---|---|---|
| 1 | **Serverless Inference, including `nemotron-3.5-content-safety`** | Repro writer (`glm-5.3` / `qwen3.8-flash-next`) plus a **guard model that screens the issue text and generated script before dispatch**. A vision model (`glm-5.3-flash`) can read screenshots attached to issues | 3 | 5 | **15** | Everyone will use a chat model; very few will use the guard model. Put its verdict on the receipt |
| 2 | **Vultr API throwaway VM per HOSTILE-risk report + tags + janitor** | High-risk PoCs escalate to a fresh `vc2`/VX1 VM created through `POST /v2/instances` with `tags:["sandbox","report-<id>"]`, `firewall_group_id` (0 inbound), `vpc_only` or `disable_public_ipv4`, and `user_data`. It is destroyed afterwards, and the receipt carries the instance ID and created/destroyed timestamps | 4 | 3.5 | **14** | The biggest visible "Vultr is the sandbox fabric" moment. Pre-warm 1–2 VMs; boot time is unmeasured (13) |
| 3 | **Microsandbox microVM on VX1 (nested virt)**, per Vultr's own guide *"How to Set Up Agent Sandboxing on Vultr Cloud Compute"* | Middle rung of the ladder: each re-execution runs in its own libkrun microVM (a separate kernel). Say "we followed Vultr's VX1 guide, then **closed the gap it leaves open**": the guide shows sandboxes reaching the internet by default ("Verify the output reports `REACHABLE`"), and we default-deny | 5 | 3 | **15** | The guide makes this a 30–60 min install (`curl install.microsandbox.dev`, `msb doctor`). Many teams will copy the guide too, but few will add egress deny and multi-ref re-execution. **Fallback: stay on gVisor if `msb doctor` fails on VX1** |
| 4 | **Billing and usage for per-verdict cost** | Receipt field `cost_usd`: inference tokens × per-model price from `/v1/models` (live catalog lists `cost_usd` per token), plus VM seconds × plan price; reconcile against `GET /v2/billing/pending-charges` once | 4 | 4 | **16** | FinOps fits Vultr's brand (FinOps & Tokenomics Foundation, Sep 15). Cheap to build. Label it "estimated" unless reconciled |
| 5 | **Firewall group with 0 inbound + VPC 2.0 between control plane and sandbox host** | The sandbox host is reachable only over the VPC or NetBird; show the firewall group JSON on screen | 3 | 5 | **15** | Table stakes for the CTO judge, and essential to the NetBird claim |
| 6 | **Vultr IAM least-privilege identity for the orchestrator** | The orchestrator's API key belongs to an IAM user whose policy allows only instance create/delete/list (service and action level). Even a fully compromised control plane can't delete the NetBird VM or read billing | 4 | 3 | **12** | IAM upgrades support service-, action- and **resource-level** permissions (blogs.vultr.com/iam-upgrades). **[verify]** that API keys inherit the user's policy. Very unusual; a good CTO answer to "what if your orchestrator is compromised?" |
| 7 | **Object Storage + presigned URLs for receipts and artifacts** | Signed receipt JSON plus logs go to a bucket; the public receipt link is a presigned GET with an expiry; sandboxes upload artifacts with presigned PUTs and never hold storage keys | 3 | 4 | **12** | Also answers "secrets never enter the sandbox" for storage |
| 8 | **Vultr Container Registry publishing the runner image** | `vcr.io/<ours>/repro-runner@sha256:…` digest on the receipt; the "re-run it yourself" command pulls that exact image | 4 | 3 | **12** | Makes DA-09 (the two-step re-run command) credible: judges can re-run the receipt |
| 9 | **Snapshot of a golden sandbox VM** | Faster throwaway boot; snapshot ID on the receipt as provenance | 3 | 3 | 9 | Measure first; it can be slower than fresh OS + cloud-init |
| 10 | Marketplace app 1334 (NetBird Server) | One-click NetBird control plane on Vultr | 3 | 4 | 12 | Already the plan in 14; name it on stage ("from Vultr Marketplace") |
| 11 | Instance Templates / VKE / Modelplane | Not needed | 2 | 1 | 2 | Skip. VKE adds risk with no demo payoff |
| 12 | VultronRetriever reranker | Rank similar past issues and receipts (duplicate detection) | 3 | 3 | 9 | Only if time allows. It is Vultr's own model family, so it is a nice nod |

**Build order for API-judge value:** 1 → 4 → 5 → 2 → 3 → 7 → 8 → 6. Items 1, 4 and 5 are nearly free. Items 2 and 3 are the stage moments. Items 6–8 are Q&A ammunition that we implement only if the core is frozen.

**What Vultr markets right now (primary sources):** VX1 CPUs for agentic AI with nested virtualization for microVM sandboxes (Aug 25 / Sep 9). The docs guide above pairs **Microsandbox on VX1 with Serverless Inference and an MCP server**. Vultr docs also have "How to Utilize Deno Sandboxes With Vultr". The docs site now shows a "Vultr Agent (Beta)" explain-code widget. Also IAM upgrades, FinOps membership, the VAST partnership (Sep 24), and "State of AI in Platform Engineering 2026" (Sep 22). **The event's own tagline is "VM backends, serverless inference, and the compute layer"**, so hit all three words.

---

## 4. NetBird "API judge" features (for Brandon Hopkins), ranked

| # | Feature | Use in Repro Receipts | Wow | Feas. | Rank |
|---|---|---|---|---|---|
| 1 | **Agent Network (keyless LLM access)**, launched Jun 28 2026, self-hosted only | Connect **Vultr Serverless Inference as a "Custom / OpenAI-compatible" provider**. The repro-writer host calls `*.netbird.ai`-style tunnel-only endpoints with **no API key**; NetBird injects the key server-side and strips client auth headers. Per-identity **token/USD budget cap** and a **model allowlist** (only `glm-5.3` and `nemotron-3.5-content-safety`). The access log shows identity, model, tokens and cost per request, which we cite on the receipt | **5** | 3 | **15** |
| 2 | Per-report `netbird expose` URL that dies with the sandbox (lifecycle-bound) | Live log view of a running repro; after teardown, the URL 404s on stage | 4 | 4 | **16** |
| 3 | Zero inbound rules on app and sandbox VMs; reverse proxy with SSO + password (judge role) | The permanent judge service from 14 | 3 | 4.5 | 13.5 |
| 4 | Budget cap trips live | A "runaway agent" fixture loops model calls; the policy blocks it with "Token limit exceeded" in NetBird's log. **A second containment moment on a different layer** | 5 | 3 | 15 |
| 5 | Identity headers (`X-NetBird-User/Groups`) drive app roles | Maintainer vs viewer role comes from NetBird identity, not app passwords | 3 | 3 | 9 |
| 6 | Control Center Draft mode (Sep 2026) | Screenshot of our ACL graph (app → sandboxes only) in the README | 2 | 4 | 8 |

**How to enable Agent Network [C, from the launch post]:** on an existing self-hosted deployment, set `NETBIRD_AGENT_NETWORK_ENABLED=true` on the dashboard. A fresh install uses `curl -fsSL https://pkgs.netbird.io/getting-started.sh | NETBIRD_AGENT_NETWORK=true bash`. IdP sync is Cloud/Enterprise only, so we assign groups manually. The caps are checked *before* each request, so the crossing request still completes; pick the demo cap with that in mind. **[verify]** that the Vultr Marketplace image (app 1334) is new enough (≥ the Agent Network release) and that the Custom provider accepts `api.vultrinference.com/v1`. Budget one hour; if it doesn't work by hour 14, drop it and keep the key on the control plane (the current design).

**Why this is the NetBird winner [I]:** 03/14 assumed that most teams stop at "one static URL with a password". Agent Network makes the pitch *"our agent never holds a key: identity is the credential, budget is the blast-radius limit"*. That is NetBird's newest launch, written by the likely NetBird judge, applied to the event theme.

---

## 5. Winning patterns from past Vultr and Cerebral Valley hackathons (2025–26)

New this pass: the Vultr-sponsored SF events **Autonomous GTM Hackathon (AGI House, May 9 2026, with OpenAI Codex)** and **MantisGrid AI (LF Edge, 2026, Vultr core sponsor)**. Their winners aren't publicly documented beyond LinkedIn snippets. RAISE 2026 judges included sponsor advocates such as **Eric Schabell (SUSE)**, who valued "can I get something running in ten minutes" and MCP-driven deploys. The full winner table is in 06 §A–B.

Patterns, strongest first:
1. **Governance or a checkpoint is the product** (Sovereign Robotics Ops, Deals Machine, ContextGuard, ClinTrial). Our approval-gated comment plus the receipt fits this.
2. **Real systems, not simulations** (Kube SRE Gym, CAD Sandboxes 18 days ago at Shack15: a VM-backed sandbox with a live state stream). Use *real public GitHub issues*.
3. **One number that moves on screen** (Injester 2/5 → 5/5). Ours: "N/10 curated issues reproduced; 6/6 escape vectors contained; $0.00X per verdict".
4. **Visible orchestration or parallelism.** Split screen: writer agent | verifier ref A | ref B | HEAD.
5. **A named buyer or vertical.** Vultr turns winners into discover.vultr.com case studies.
6. **Small teams win with one deep primitive** (CAD Sandboxes was solo).
7. **Sponsor-native stack said out loud.** Winners' write-ups list the Vultr products used (e.g. "Fastify workers on hardened Vultr Ubuntu 24.04 VMs").

Demo styles that won: a live terminal or TUI plus a web view; the first 20 seconds is the pain; a single containment or "gate" moment; ending on the artifact (the receipt), not on a slide.

---

## 6. Ten concrete recommendations

1. **Confirm the panel at kickoff** (11:00 PDT). Log in to CV `/details` or Discord and update §1. Speak to Brandon Hopkins during or after his NetBird demo, and ask Mayank or Mirdul which Vultr features they most want to see. Mentor conversations are free validation and prime the judges.
2. **Open with a 15-second skit of the pain**: one teammate is the maintainer, one pastes an AI-written issue with a PoC ("run this to reproduce!"), and the maintainer hesitates to run it on a laptop holding their GitHub token. Then: "We run it so you don't have to."
3. **Make the audience part of it (a Chan tactic).** Put a QR code or short URL on screen where judges submit any public GitHub issue URL (or pick from our 10). Keep a curated fallback, and run the live one in verify-only mode if the model is slow.
4. **Show two containment moments on two different layers**: (a) a hostile PoC (metadata read, fork bomb, exfil) contained in the microVM or throwaway VM; (b) a runaway agent loop stopped by the **NetBird Agent Network budget cap** (or our control-plane cap if Agent Network slips).
5. **Say Vultr product names on every beat** ("Serverless Inference `glm-5.3` writes the repro; `nemotron-3.5-content-safety` screens it; a VX1 microVM runs it; the Vultr API destroys the VM"). Show the instance ID appear and then 404.
6. **Put cost and provenance on the receipt**: model + tokens + $ (from the `/v1/models` prices), VM instance ID, plan, seconds, image digest (Container Registry), and a presigned Object Storage link. This is the "one number": "$0.0X per verified verdict".
7. **Cite Vultr's own Microsandbox-on-VX1 guide and add the missing piece** (default-deny egress plus fresh re-execution). This flatters the API judge and differentiates us from the teams that follow the guide verbatim. Keep gVisor as the floor if `msb doctor` fails.
8. **Prepare the CTO Q&A cards**: "Isn't Docker enough?", "Where do keys live?", "What if the orchestrator is compromised?" (IAM least-privilege key, recommendation 6 in §3), "What if the PoC is prompt injection?" (the guard model plus the model never judges the verdict), "Leaked VMs?" (tag janitor), "Scale/cost?" (per-verdict $). Also one slide of **3 honest limits** (Python only, INCONCLUSIVE rate, VM boot time). Hopkins in particular rewards candour.
9. **Pitch in Chan's order in 3 minutes**: problem (skit, 0:15) → solution (0:15) → market and why now (0:15: GitHub limits, Pallets numbers, HF escape) → validation (0:10: triagebot/syzbot precedent, N/10 eval) → **demo (1:30)** → business model (0:10: per-receipt pricing for bounty platforms and PSIRTs, Vultr usage pull-through) → future (0:10: more languages, a GitHub App, CVE intake) → team (0:05).
10. **Don't chase CopilotKit, Elastic or Fivetran**, or any sponsor not in the room. Every hour goes into the Vultr/NetBird surfaces above or into demo reliability. Finals are equal-weighted, so rehearse the story for Cochrane (BD) and Porollo (investor) as seriously as the technical demo.

---

## 7. Open items

- Judge list: unknown until kickoff (login-gated).
- Agent Network on the Marketplace image: unverified.
- IAM API-key scoping: unverified.
- Microsandbox on VX1 in `atl`: unverified; the guide doesn't name a region.
- MantisGrid and AGI House GTM winners: not retrievable (LinkedIn/X).
