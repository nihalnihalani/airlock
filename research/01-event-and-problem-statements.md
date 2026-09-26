# 01 · Event and Problem Statements (official sources)

Captured 2026-09-26, during hacking. Sources: the Cerebral Valley (CV) event page (public part plus the page payload), the three problem-statement Google Docs (full public exports), and the pages those docs link to. Raw captures are in `.firecrawl/event/` (gitignored). This file leaves out all secrets (Wi-Fi, credit coupon codes).

Legend: **[NEW]** means the fact is not in `00-participant-guide.md`. **[CONFLICT]** means it contradicts the guide.

---

## Event overview

- **Name:** The Agent Arena Hackathon. The host is **Vultr**, the platform/organizer is Cerebral Valley, and **NetBird is the "track partner"** [NEW] (source: NetBird's September 2026 newsletter).
- **When:** Sat Sep 26, 9:00 AM to Sun Sep 27, 5:00 PM PDT. In CV's data this is `startDateTime 2026-09-26 16:00 UTC` and `endDateTime 2026-09-28 00:00 UTC`, timezone America/Los_Angeles.
- **Where:** fully in person in San Francisco (the guide has the venue: Shack15, Ferry Building).
- **Pitch (public page):** "build what the next generation of agent infrastructure actually looks like in production… VM backends, serverless inference, and the compute layer agents run on when they stop talking and start acting."
- **Prize pool:** "more than $10,000 across cash and credits" ($9k cash from the guide plus NetBird's $500 credits plus the $200 per-person credits).
- **Teams:** up to 4. Attendance needed an approved application.
- **Vultr's own framing:** Vultr's promo post describes the weekend as building "around agent sandboxing". The Vultr Discover landing page (discover.vultr.com/agent-arena-hackathon-2026) pushes **High-Frequency and Dedicated Cloud Compute** for lower infrastructure cost. It's a lead-gen form with nothing substantive. [NEW]
- **Waiver:** required. Minors must have a guardian present the whole time. Organizers can remove disruptive participants. Seating, power, and tables "may be limited". [NEW]
- **IP clause in the waiver [NEW]:** you keep ownership of your submission, but you grant the organizer and **partner companies** a perpetual, irrevocable, worldwide, royalty-free, non-exclusive licence to use, modify, publish, and display it. The waiver also says there is **no confidentiality or NDA** for anything you share or pitch. Participant info (name, email) may be shared with event partners.

## Judges & sponsors

- **Judges: NOT ACCESSIBLE.** No judge list appears on the public event page. The `/details` page is behind a CV login (it redirects to "Welcome to CV / Log In"), and the judges and speakers are most likely listed there. A web search found no public list either. **Action for a human teammate:** log in to CV (or check Discord) and copy the judges from `/details`.
- **Sponsors/partners confirmed in public:** Vultr (host, sole listed co-host) and NetBird (track partner, bonus prize). No other sponsors appear anywhere public.
- Speakers/workshops: not visible (gated).

## Schedule

The public sources match the guide. The one addition is the platform deadline.

| Day | Time (PDT) | Item |
|---|---|---|
| Sat 9/26 | 9:00 | Doors, breakfast, team formation |
| | 11:00 | Kickoff (the Vultr credit coupon arrives by email **after the opening ceremony**) |
| | 11:30 | Hacking begins |
| | 1:00 PM / 7:00 PM | Lunch / dinner |
| | 10:00 PM | Doors close (overnight stay) |
| Sun 9/27 | 9:00 | Doors |
| | **12:00 PM** | **Hacking stops, submissions due** (guide) |
| | 12:30 | Round-1 judging |
| | 2:30 | Final judging (top 6 on stage) |
| | 3:30 | Winners |
| | 5:00 PM | Doors close |

**[CONFLICT / NEW] Platform deadline:** CV's event record has `hackathonSubmissionDueDate = 2026-09-28 00:00 UTC` (that's **Sun 5:00 PM PDT**) plus `submissionDueDateGracePeriodHours = 6`. So the submit form will probably still be open after noon. **Plan for 12:00 PM anyway**: round-1 judging starts at 12:30 and depends on submissions. Other flags: `showHackathonGallery=false`, `hackathonPublicVotingEnabled=false` (no public voting), `hackathonJudgingOpen=null`.

## Rules & disqualifiers

Combined from the guide and the docs:

- **Public repo**, new work only, max 4 people per team.
- The **demo may show only what was built at the hackathon**, and original contributions must be clearly identified. Breaking this means disqualification.
- Banned: illegal or unethical projects, and unlicensed code, data, or assets.
- Anti-project list (from the guide): basic mental-health chatbot, basic RAG, Streamlit apps, basic image analyzers, "AI for Education" chatbot, AI job-application screener, basic nutrition coach, personality analyzers, a dashboard as the main feature, sports analyzers.
  - Note: the **Challenge 2 doc lists "HR & Recruitment: screen candidates…" as an example domain**, while the guide bans an "AI job-application screener". Avoid a plain screener. [CONFLICT, minor]
- **Hard technical requirements (both challenges):** a VM-based backend on Vultr, a web app deployed on Vultr, a public web URL, and Vultr as the *central system of control/record*, not just static hosting.
- **Vultr GPUs are not available at this event** (Challenge 2 doc). [NEW]
- Challenge 1 only: **every agent LLM call must go through Vultr Serverless Inference**, and **sandboxes must never run inside the app process**.

## Submission form fields

The real form at `/hackathon/submit` needs a login, so the event-specific questions were **NOT ACCESSIBLE**. The CV submit-page code contains the platform's standard **preset fields**, so the form almost certainly includes some of these [NEW]:

- **Team name** and **Team Members** (you add teammates by searching their CV accounts, so every teammate needs a CV account)
- **GitHub Repository** (URL)
- **Demo Video** (URL). The player accepts YouTube, Vimeo, Google Drive, X, Facebook, Dailymotion, and Twitch links, so upload the video somewhere public or unlisted.
- **Project Website** (URL), which is where the public demo URL goes
- **Hugging Face** (URL, optional preset)
- **Project Description** (long text, up to 100k characters)
- There may also be event-specific custom questions, such as which challenge you picked or a NetBird claim. We can't confirm this.

What the docs require you to have ready: the GitHub repo with setup docs and an architecture explanation, the public demo URL, the recorded demo video (**1 minute** per the guide), the Challenge 1 containment moment, the NetBird zero-ports moment if you claim the bonus, and **NetBird credentials in the README** (see the bonus section).

(These are the *application* questions, not submission fields: LinkedIn, GitHub, X, where you work/study, role, city, company URL, 1-line bio, Discord handle.)

## Judging rubric

This comes from the guide. It isn't on any public page we could reach.

- **Round 1** (about 3 min demo plus 1–2 min Q&A): **Technicality 40%**, Creativity/Originality 25%, Live Demo 20%, Future Potential & AI Impact 15%.
- **Round 2:** the top 6 present on stage with the same criteria, weighted equally.
- One pool for both challenges. The NetBird bonus adds "bonus points on top of your challenge score" and has its own prize (Best use of NetBird: $500 Vultr credits).
- Judging hints in the docs: "Focus on **platform thinking**, not just a one-off demo"; "production-style web app, clear user flows, not just a local demo"; Challenge 1: "An agent that only chats is a demo; an agent that executes safely is a product."

---

## Problem statement 1 (full detail): Blast Radius Zero: Safe Agent Execution on Vultr

Doc `1cca0kJZSraBDNfE_gFCRovpgRnlD2m613WLebd2ApN4`, titled "Main Challenge – Theme".

**Description.** Build a **web-based agent that does real work** (writing and running code, or operating a real browser) with **every action contained in a sandbox running on Vultr**. The system is a central control layer that **plans** a task, **dispatches** it to an isolated execution environment, and **returns verifiable output**. You need to show multi-step agentic workflows, real executed results rather than described ones, and a production-style web app, all on Vultr. "Containment-first is required."

**AI / backend on Vultr**
- VM-based backend on Vultr (**mandatory**)
- Agent LLM calls go through **Vultr Serverless Inference** (**mandatory**). It's OpenAI-compatible with base URL `https://api.vultrinference.com/v1`.
- Vultr is the central system of control and orchestration, not just static hosting.
- Sandboxes run as **containers or throwaway instances on Vultr, never inside your app process**.
- Example OSS sandboxes: OpenSandbox, gVisor, E2B, and **Microsandbox** [NEW; the guide doesn't list it].

**Execution patterns** (build one or both)

*Pattern A: Sandboxed code execution.* The user asks, the model writes code, the code runs in a container, real output (a chart, file, or test log) comes back, and the model explains it. **On error, stderr goes back to the model for a retry.** Examples:
- **CSV Analyst:** upload a spreadsheet and ask in plain English, and you get an executed chart plus the code that made it.
- **Prove-It Code Reviewer:** paste a snippet or PR, and the agent runs it and its tests in the sandbox and reports what really happened.
- **Chart Anything:** natural language in, an executed matplotlib or plotly image out.
- **File Fixer:** a messy CSV or JSON file in, a cleaned file out, with an executed before/after diff.
- **Self-Healing Runner:** run the code, read the error, patch, retry, with the retry loop visible on screen.

*Pattern B: Sandboxed browser use.* The user gives a goal, the model plans, **Playwright in a container** navigates, clicks, and types, screenshots come back, a **vision model on Serverless Inference verifies** the result, and the loop repeats, **with a human approving anything final**. Examples:
- **Comparison Shopper:** 2–3 product URLs in, a screenshot-backed comparison table out.
- **Form Filler:** structured data in, a multi-step web form filled, with a screenshot trail and an approve-before-submit gate.
- **Site QA Sweep:** point it at a web app and get broken flows and links back, with screenshots and repro steps.
- **Research with Receipts:** a brief where every claim links to a screenshot of its source.
- **Page Watcher:** monitors listing or pricing pages, extracts structured data, and diffs it against yesterday.

**Containment focus** ("show how isolation makes autonomous execution shippable")
- **Process isolation:** execution never touches the host or the app runtime.
- **Secret hygiene:** no API keys or credentials inside the sandbox.
- **Resource limits:** time and memory caps on every run.
- **Lifecycle discipline:** reset or destroy the environment after each task.

**Production-ready web app:** reachable from a public browser, a real product experience, clear user flows, not a local demo.

**Key positioning:** Vultr is the central backend powering execution and orchestration. The app plans, dispatches, and verifies real work. Platform thinking.

**Developer expectations (deliverables)**
- ✅ GitHub repo with setup and documentation
- ✅ Vultr VM backend, with agent LLM calls through Vultr Serverless Inference
- ✅ Public demo URL
- ✅ Recorded demo video
- ✅ **One "containment moment" in the video [NEW]:** the sandbox absorbing something unsafe, such as `rm -rf`, an infinite loop, or a hostile web page.
- A clear explanation of the architecture and use case

**Technology**
- *Required:* a Vultr VM backend; the web app deployed on Vultr; Vultr Serverless Inference for agent reasoning; a sandbox isolated from the app process.
- *Strongly recommended [NEW]:* Docker containers as the sandbox boundary; REST or WebSocket APIs for run status and streaming output; web dashboards showing the execution loop, retries, and screenshot trails; approve-before-submit gates on any irreversible browser action.
- *Optional:* the Vultr API to create a **throwaway instance per task and destroy it** afterwards ("making Vultr itself the sandbox fabric"); vision models on Serverless Inference for reasoning about screenshots; Playwright in Docker.

**Resources in the doc:** Serverless Inference provisioning docs; the live model list at **`https://api.vultrinference.com/v1/models`** [CONFLICT: the guide's `/v1/chat/models` returns 404]; the Vultr API reference; **"How to Set Up Agent Sandboxing on Vultr Cloud Compute"** [NEW, summarized below]; $200 in credits per participant, with the coupon emailed after the opening ceremony and a redemption walkthrough video.

## Problem statement 2 (full detail): Future of Work

Doc `1nd1RqTaLA3vpFaE4ZExZaD7mXxPw242FcD5HVn8EGbc`, titled "Challenge 2 · 🤖 **Powering the Future of Work with Scalable, Deployed AI Agents**".

> [CONFLICT / NEW] The doc **never mentions robotics**. The guide calls it "AI + Robotics". The only related hint is "Simulation or digital twin integration" under *Strongly Recommended*.

**Description.** Build and deploy a **web-based, enterprise-focused AI** solution on Vultr infrastructure. Show **multi-step agentic or rule-based workflows**, realistic future-of-work use cases, and a production-style web app, all on Vultr.

**AI / backend on Vultr**
- VM-based backend on Vultr (**mandatory**)
- Vultr is the **central system of record and control**, not just static hosting.
- Vultr Serverless Inference is **optional**.

**Future-of-work focus areas [NEW detail]** ("show how software platforms + automation improve daily work")
- **Sales Operations:** qualify leads, research prospects, update the CRM, draft outreach, follow up automatically.
- **Finance & Accounting:** process invoices, reconcile transactions, flag anomalies, manage payment follow-ups.
- **HR & Recruitment:** screen candidates, schedule interviews, coordinate onboarding, track employee workflows. (The guide's anti-project list bans a plain "job-application screener".)
- **Customer Support:** resolve tickets across multiple systems, investigate, take actions, escalate only when a human is needed.
- **Procurement:** monitor purchasing needs, compare vendors, request quotes, track orders, follow up on delays.

**Production-ready web app:** public browser access, a real product experience, clear user flows.

**Key positioning:** Vultr is the central backend. The app coordinates planning, workflows, and operations. Platform thinking.

**Developer expectations:** ✅ GitHub repo with setup docs · ✅ Vultr VM backend · ✅ public demo URL · ✅ recorded demo video · a clear explanation of the architecture and use case. (There is **no** containment-moment requirement here.)

**Technology**
- *Required:* Vultr VM backend; the web app deployed on Vultr.
- *Strongly recommended:* REST or WebSocket APIs; **simulation or digital twin integration**; web dashboards for control and monitoring.
- *Optional:* Vultr Serverless Inference.
- ⚠️ **Vultr GPUs are not available for this event.**

**Recommended accelerators [NEW]:** **Supabase on Vultr** (a Marketplace app, with a Next.js deploy guide and video) and **Coolify on Vultr** (a Marketplace PaaS: git deploys, env vars, Traefik auto-HTTPS; guide and video), plus the Serverless Inference docs.

**Access:** this doc says "**$200 in free Vultr credits per team leader**", while the Challenge 1 doc and the guide say *per participant* [CONFLICT]. Don't rely on having more than $200 per team. The redemption-guide link in this doc is **empty**.

## NetBird bonus (full detail): Zero-Port Access with NetBird

Doc `1lZUBBVhdcOmg0Sgi2i5vTmipe6THU3xiBWKA26dyYmY`.

*It isn't a separate challenge.* It's an optional add-on to a Challenge 1 or Challenge 2 project that earns **bonus points on top of your challenge score** (plus the "Best use of NetBird" prize from the guide).

Serve the project through **NetBird's reverse proxy** instead of opening ports on the Vultr VM. NetBird terminates TLS and routes public traffic down a WireGuard tunnel to a local port. **Self-host the management server on Vultr** so the whole path stays on your infrastructure.

**The three tiers** (the doc wording reads as cumulative levels):
1. **No open ports:** the public demo URL goes through NetBird, and the VM has no inbound *application* ports.
2. **Gated access:** SSO, password, PIN, or header auth, **matched to a real user role**.
3. **Lifecycle-bound URLs:** URLs are provisioned per task or session and **expire with the workload that created them**.

**To claim it [NEW]:** include a **"zero-ports moment"** in the demo video. Show the firewall with no inbound application ports open, then load the public URL in a browser. For tier 2, also show the auth prompt. For tier 3, show a URL going dead after its task finishes. **Keep one service live for judging and put any credentials in your README** (an ephemeral URL dies about 90 seconds after its client stops).

**Links:** docs.netbird.io/manage/reverse-proxy · /manage/reverse-proxy/expose-from-cli · /selfhosted/marketplaces/vultr (summarized below).

---

## Linked resources (brief summaries)

- **Vultr: How to Set Up Agent Sandboxing on Vultr Cloud Compute** (docs.vultr.com). This is Vultr's own blueprint for Challenge 1. It uses **Microsandbox** (each sandbox is a **libkrun/KVM microVM** with its own kernel, booted from standard OCI images) on a **Vultr VX1 Cloud Compute** instance running Ubuntu 24.04. The instance needs `/dev/kvm`, so check `msb doctor`.
  - CLI: `msb run|create --cpus --memory|exec|copy|logs|metrics|ssh|touch|stop|remove`.
  - Sandboxes get outbound internet by default, and **sibling sandboxes can't reach each other** by default, with no firewall rules needed.
  - **Python SDK** (`pip install microsandbox`, `Sandbox.create(name, image, cpus, memory)` used as an async context manager, which auto-destroys). SDKs also exist for TS, Rust, and Go.
  - An **MCP server** (`npx -y microsandbox-mcp`, needs Node 22 or newer) exposes a `sandbox_run` tool. The guide wires it into OpenCode with Vultr Inference as an OpenAI-compatible provider (`@ai-sdk/openai-compatible`, baseURL `https://api.vultrinference.com/v1`).
- **Vultr Serverless Inference provisioning:** Console → Products → Serverless → Inference → Add (label), which gives you an API key. It can also be done through the API or CLI.
- **Live model list** (`/v1/models`, public, checked today): chat and vision models include `deepseek-v4-flash-0731`, `deepseek-v4.1-flash`, `glm-5.2`, `glm-5.3`, `glm-5.3-flash`, `glm-5.x-menthol`, `laguna-s-2.1`, `mimo-v2.6-flash-rl`/`-pro-rl` (text, image, audio, video), `minimax-m3`, `muse-glimmer-30b`, `nemotron-3-nano-omni-30b-a3b-reasoning`, `qwen3.8-27b`, and `qwen3.8-flash-next`. Most accept image input (useful for Pattern B verification), and several have a 1M-token context. There's also `nemotron-3.5-content-safety` (a safety classifier, handy for guardrails), three rerankers (`bge-reranker-v2-m3`, `vultron-retriever-*`), and `z-image-turbo` for image generation. The raw list is in `.firecrawl/event/vultr-models.json`.
- **NetBird Reverse Proxy (beta):**
  - NetBird provisions a public domain with automatic TLS and forwards traffic over WireGuard to a peer or network resource. HTTP (L7) and TCP/UDP/TLS (L4) modes are supported.
  - Auth options: SSO/OIDC (with user-group restriction), password, PIN, header auth, NetBird-only access, and IP, country, or CrowdSec restrictions.
  - **Self-hosted setups must use Traefik** (TLS passthrough) and need the `netbird-proxy` container. It ships by default with setup-script v0.65+ when you pick built-in Traefik.
  - Caveat: ACME `tls-alpn-01` needs **443 open on the proxy/management host**. "No open ports" refers to the *app VM*. The app VM and the NetBird host should be separate, or you use static or DNS-01 certificates (a "private proxy without public inbound ports" guide exists).
  - Service statuses: pending → certificate_pending → active.
- **NetBird `netbird expose <port>`:**
  - Creates **ephemeral** services from the CLI and prints the URL.
  - Flags: `--with-pin` (6 digits), `--with-password`, `--with-user-groups` (SSO), `--with-name-prefix`, `--with-custom-domain`, `--protocol`.
  - Keep-alive every 30 s, **90 s TTL**. Ctrl+C removes the service immediately; a killed client means it's removed after about 90 s.
  - **Max 10 active expose sessions per peer.**
  - An admin has to enable **Peer Expose** (Settings → Clients, or API `peer_expose_enabled`), and the peer must not have "Block Inbound Connections" set.
  - Audit events: "Peer exposed service", "Peer unexposed service", "Peer expose expired". These fit tier 3 (URLs tied to a workload) well.
- **NetBird on Vultr Marketplace:**
  - Deploy → Marketplace → NetBird with a Shared CPU plan and at least 2 GB RAM. Enter an email and domain.
  - DNS: an `A netbird → IP` record and a wildcard `CNAME *.netbird → netbird.<domain>` (the wildcard is required for the proxy's certificates). On Cloudflare, set both to DNS-only.
  - The stack includes Traefik (Let's Encrypt), the NetBird Proxy (on by default), CrowdSec, and a local admin user store. Files live in `/opt/netbird`.
  - Tip: reserve an IP before deploying so DNS can propagate early. **We need a domain we control.**
- **Sandbox options:**
  - *OpenSandbox:* a general-purpose AI sandbox platform with multi-language SDKs and a CLI. It runs on Docker or Kubernetes and uses gVisor or Firecracker for isolation.
  - *gVisor:* a user-space kernel runtime (`runsc`) for Docker.
  - *E2B:* open-source Firecracker sandboxes, mainly a hosted SaaS. Note that its cloud version wouldn't run "on Vultr".
  - *Microsandbox:* libkrun microVMs. It's the path the Vultr guide uses.
- **Supabase and Coolify Marketplace guides:** one-click Vultr images. Supabase gives Postgres, auth, RLS, and API keys behind Nginx and SSL. Coolify gives a Heroku-like PaaS with git deploys and Traefik HTTPS.
- **Credit redemption video:** `del1.vultrobjects.com/tech-talk/redeem-vultr-credits-for-hackathons.mp4` (the coupon code itself is emailed and must never be committed).

## Anything new vs the participant guide

1. **Challenge 1 requires a "containment moment" on video** (the sandbox absorbing `rm -rf`, an infinite loop, or a hostile page). There are two concrete execution patterns (A: code, with stderr fed back for retries; B: Playwright plus a vision-model verify loop plus human approval) and 10 named example apps.
2. **Containment checklist:** process isolation, **no secrets in the sandbox**, time and memory caps, and a reset/destroy after every task. Also *strongly recommended*: Docker boundary, WS/REST streaming, dashboards for loops, retries, and screenshot trails, and approve-before-submit gates.
3. **Vultr published its own reference architecture** for Challenge 1: Microsandbox microVMs on VX1, Python SDK, and an MCP server with Vultr Inference. **Microsandbox** was added to the sandbox list.
4. **Challenge 2 isn't really "Robotics".** It's enterprise future-of-work (sales ops, finance, HR, support, procurement). "Simulation/digital twin" is strongly recommended, **no Vultr GPUs** are available, and Supabase/Coolify are the suggested accelerators.
5. **NetBird claim mechanics:** a "zero-ports moment" in the video (firewall view, then the public URL, the auth prompt for tier 2, and a URL dying for tier 3). **Keep one service live for judges and put the credentials in the README.** Ephemeral URLs die about 90 s after the client stops, with a maximum of 10 per peer. Self-hosted NetBird needs Traefik and wildcard DNS (so we need a domain).
6. **The model-list URL is `/v1/models`.** The guide's `/v1/chat/models` returns 404.
7. **Credits conflict:** "per participant" (Challenge 1 doc and guide) versus "per team leader" (Challenge 2 doc).
8. **The platform submit deadline is Sun 5 PM PDT plus a 6 h grace period,** but the event schedule says noon. Target noon.
9. **Submission form presets:** team name and members (each member needs a CV account), GitHub repo, demo video URL (YouTube, Vimeo, Drive, etc.), project website, Hugging Face, and project description.
10. **Waiver:** a perpetual licence to the organizer and partners, and no confidentiality for pitches. NetBird is officially the "track partner".

## Could not access

- **`/details`, `/hackathon`, `/hackathon/submit`** on CV: these need a CV login and redirect to the sign-in wall. Creating or signing into accounts isn't allowed for this agent, and the Chrome extension wasn't connected. Because of that, **the judges, speakers, event-specific submission questions, and any extra rules or FAQ on the details page are missing**. A logged-in teammate should copy them from the page or from Discord.
- The Challenge 2 doc's "Redemption guide (Google Doc)" link is blank in the source.
- The Discord server wasn't checked (it needs an account).
- The YouTube videos (Supabase and Coolify walkthroughs) and the credit-redemption MP4 were not watched.

## Source URLs

- https://cerebralvalley.ai/e/vultr-the-agent-arena (+ `.md` variant, + `/details`, `/hackathon`, `/hackathon/submit`, `/apply` page payloads)
- https://docs.google.com/document/d/1cca0kJZSraBDNfE_gFCRovpgRnlD2m613WLebd2ApN4 (Challenge 1, exported as md/txt/html)
- https://docs.google.com/document/d/1nd1RqTaLA3vpFaE4ZExZaD7mXxPw242FcD5HVn8EGbc (Challenge 2)
- https://docs.google.com/document/d/1lZUBBVhdcOmg0Sgi2i5vTmipe6THU3xiBWKA26dyYmY (NetBird bonus)
- https://docs.vultr.com/how-to-set-up-agent-sandboxing-on-vultr-cloud-compute
- https://docs.vultr.com/products/serverless/inference/provisioning · https://docs.vultr.com/products/serverless/inference
- https://api.vultrinference.com/v1/models
- https://www.vultr.com/api/
- https://docs.vultr.com/how-to-deploy-a-nextjs-application-with-vultr-supabase-marketplace-app · https://youtu.be/icJzcsP59Ks
- https://docs.vultr.com/how-to-deploy-an-application-with-vultr-coolify-marketplace-app · https://youtu.be/P0wZ2LYufGU
- https://docs.netbird.io/manage/reverse-proxy · https://docs.netbird.io/manage/reverse-proxy/expose-from-cli · https://docs.netbird.io/selfhosted/marketplaces/vultr
- https://github.com/opensandbox-group/OpenSandbox · https://gvisor.dev/ · https://github.com/e2b-dev/e2b · https://microsandbox.dev/
- https://netbird.io/knowledge-hub/2026-september-newsletter (NetBird = track partner)
- https://discover.vultr.com/agent-arena-hackathon-2026 (Vultr promo/lead-gen page)
