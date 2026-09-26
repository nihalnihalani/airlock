# Vultr Agent Arena Hackathon 2026 — Participant Guide (source copy)

Event page: https://cerebralvalley.ai/e/vultr-the-agent-arena
Details: https://cerebralvalley.ai/e/vultr-the-agent-arena/details
Submit: https://cerebralvalley.ai/e/vultr-the-agent-arena/hackathon/submit
Discord: [invite link redacted; see the organizer email]

Problem-statement docs (Google Docs, linked from the guide):
- https://docs.google.com/document/d/1cca0kJZSraBDNfE_gFCRovpgRnlD2m613WLebd2ApN4/edit
- https://docs.google.com/document/d/1nd1RqTaLA3vpFaE4ZExZaD7mXxPw242FcD5HVn8EGbc/edit
- https://docs.google.com/document/d/1lZUBBVhdcOmg0Sgi2i5vTmipe6THU3xiBWKA26dyYmY/edit

## Goal
Two problem statements plus a NetBird bonus. All projects are judged in one pool.

### 1. Blast Radius Zero: Safe Agent Execution on Vultr
Build a web-based agent that does real work (writing and running code, or operating a real browser), with every action contained in a sandbox running on Vultr. The system is a central control layer: plan a task, dispatch it to an isolated execution environment, return verifiable output. Show multi-step agentic workflows, real executed results (not described ones), and a production-style web app, all on Vultr. Containment first is required: "An agent that only chats is a demo; an agent that executes safely is a product."
- VM-based backend on Vultr (mandatory)
- Agent LLM calls go through Vultr Serverless Inference (mandatory)
- Vultr is the central system of control and orchestration, not just static hosting
- Sandboxes run as containers or throwaway instances on Vultr, never inside the app process
- Example OSS sandboxes: OpenSandbox (https://github.com/opensandbox-group/OpenSandbox), gVisor (https://gvisor.dev/), E2B (https://github.com/e2b-dev/e2b)

### 2. Future of Work: AI + Robotics on Vultr
Build and deploy a web-based, enterprise-focused AI solution on Vultr infrastructure. Show multi-step agentic or rule-based workflows, realistic future-of-work use cases, and a production-style web app, all on Vultr.
- VM-based backend on Vultr (mandatory)
- Vultr is the central system of record and control, not just static hosting
- Vultr Serverless Inference optional

### 3. Bonus: Zero-Port Access with NetBird
Serve the project through NetBird's reverse proxy instead of opening ports on the Vultr VM. NetBird terminates TLS and routes public traffic down a WireGuard tunnel to a local port. Self-host the management server on Vultr.
- No open ports: public demo URL served through NetBird, no inbound app ports on the VM
- Gated access: SSO, password, PIN, or header auth, matched to a real user role
- Lifecycle-bound URLs: provisioned per task/session, expire with the workload that created them

## Location
Shack15, Ferry Building 1, Suite 201, San Francisco, CA 94111. Doors open 9:00 AM; bring ID.

## Schedule
Sat Sep 26: 9:00 doors/breakfast/team formation · 11:00 kickoff · 11:30 hacking begins · 1:00 lunch · 7:00 dinner · 10:00 doors close (overnight stay)
Sun Sep 27: 9:00 doors · 12:00 PM hacking stops, submissions due · 12:30 round-1 judging · 1:00 lunch · 2:30 final judging · 3:30 winners · 5:00 doors close

## Rules
- Repos must be public
- Max 4 per team; solo allowed
- Demo must only show what was built during the hackathon; must clearly identify original contributions or be disqualified
- New work only
- Banned: illegal/unethical, or using unlicensed code/data/assets
- Anti-projects: basic mental-health chatbots, basic RAG, Streamlit apps, basic image analyzers, "AI for Education" chatbot, AI job-application screener, basic nutrition-coach chatbot, personality analyzers, dashboard-as-main-feature, sports analyzers/coaches

## Vultr resources
- Serverless Inference docs: https://docs.vultr.com/products/serverless/inference/provisioning
- Live model list: https://api.vultrinference.com/v1/chat/models
- Vultr API (throwaway-instance pattern): https://www.vultr.com/api/
- $200 credits per participant (code emailed after kickoff; do not share publicly)

## Submission
Submit at the link above, with a 1-minute demo video showing only what the team built.

## Judging
Round 1 (~3 min demo + 1–2 min Q&A): Technicality 40% · Creativity/Originality 25% · Live Demo 20% · Future Potential & AI Impact 15%
Round 2: top 6 on stage, same criteria, equal weights.

## Prizes
1st $5,000 · 2nd $3,000 · 3rd $1,000 · Best use of NetBird: $500 Vultr credits
