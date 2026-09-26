# 38 — Kickoff decks and the NetBird clarification: what changes in Airlock

**Decision, 26 September 2026.** New organizer sources arrived at kickoff: Vultr's two slide decks and an official clarification of the NetBird bonus. This file records what they say, decides what changes in [35](35-AIRLOCK-MAIN-CHALLENGE.md) and [37](37-AIRLOCK-OPENMUSE-OPENBOT-ARCHITECTURE.md), and amends those files where they conflict. 35 and 37 remain the product and architecture owners; this file is the amendment record.

Sources (local copies in `raw/vultr/kickoff-decks/`, gitignored):
- **"Blast Radius Zero — Safe Agent Execution on Vultr"**, 8 slides, presented by Kartikey Gaur (Engineering Manager, Developer Relations, Vultr). Image-only PDF; every slide was read visually. Its QR code decodes to Vultr's guide [How to set up agent sandboxing on Vultr Cloud Compute](https://docs.vultr.com/how-to-set-up-agent-sandboxing-on-vultr-cloud-compute) (Microsandbox on VX1), which 01 and 13 already cite.
- **"Welcome to the Agent Arena / Problem statement intro slides"**, 5 slides, Mayank Debnath and Talia Sverdlik (Vultr). Challenge 2 plus logistics.
- **Organizer Discord clarification "Zero-Port Access Bonus"**, quoted verbatim in §4 and in 01 §2c.

Authority: organizer doc (same level as the Google Docs in 01). Where the decks and the Google Docs differ, the decks are the newer statement of what the judges were told.

## 1. Decision in one paragraph

**Keep Airlock. Alter five things.** The Challenge 1 deck is entirely about execution isolation and verifiable execution, which is Airlock's territory; its closing line, "Blast radius zero is the reason you can let your agent do anything," is Airlock's argument for running a stranger's crash reproducer and letting the model attempt a repair. What changes: (1) the isolation runtime becomes an inspected, recorded tier, gVisor as the floor and a Kata microVM tier on VX1, with no Docker-only fallback; (2) the primary containment moment becomes a judge-typed hostile command whose blast radius is displayed, not a timeout fixture; (3) every run record carries Vultr's five checkpoints (host/KVM check, sandbox execution, `uname`/hostname proof, blocked isolation probe, empty teardown listing); (4) NetBird stays an **optional add-on attempted only after the core works**, but its recommended shape changes: the newly qualifying **peer-to-peer** approach for the controller → supervisor link, then the reverse proxy and gated access for the public URL; (5) the build gates in 35 §9 keep their hour targets, stated explicitly as loose guidelines that are never a reason to reduce scope. The project, the tabulate hero case, the external comparator and the artifact contracts do not change.

## 2. What the Challenge 1 deck says, and the implication for Airlock

| Slide | Content | Implication |
|---|---|---|
| Title | Hook: "April 2026 — a coding agent, mid-task, deletes a customer's production database records" (PocketOS, see 04). | The judges' reference incident is credential/production reach, not a sandbox escape. Airlock's opening line should be that the agent holds no credentials and has no production reach; the sandbox holds only the pinned library. |
| "The brief, decoded" | Rule → judge's question: VM backend → "Show me the instance." Serverless Inference → "Is the model yours, or a borrowed key?" Orchestration → "Is Vultr planning and dispatching, or serving a static page?" Sandboxes outside the app → **"If I paste `rm -rf /`, what dies?"** Tagline: "An agent that only chats is a demo. An agent that executes safely is a product." | The UI must answer all four literally: instance IDs in the run record; the inference request log with host and model id; the dispatch trail; and a blast-radius card for a hostile command (§3.2). |
| "A container is not a sandbox" | Four tiers: 01 in-process (`eval`/`subprocess`: "dies: your app, your DB creds, your cloud keys"), 02 container/runc ("one kernel bug from tier 1"), 03 gVisor ("dies: the sandbox process"), **04 microVM, Firecracker/libkrun/Kata ("dies: the VM. Throw it away")**, highlighted. Footer: `ls -l /dev/kvm` — "VX1 exposes KVM. Every tier runs on one instance." | A runc-only build loses the argument the judges were just given. gVisor is an accepted tier; microVM is the highlighted one. See §3.1. |
| "Pick your sandbox" | gVisor: `--runtime=runsc`, ~10 min on VX1, "orchestration and egress are yours to write." OpenSandbox: platform with SDKs/`osb` CLI/MCP, ~30–45 min, "runs on gVisor/Kata/Firecracker underneath." E2B: "read the self-hosting docs early." **"Best combo: OpenSandbox on gVisor."** | Airlock keeps its narrow supervisor instead of OpenSandbox; the reasons must be stated up front (§3.6). |
| "Two instances. One boundary." | Browser (Next.js) → **VX1 #1 control plane** (FastAPI/Node, planner) → `dispatch(task)` over a private network → **VX1 #2 sandbox host** (sandbox-01 gVisor/microVM code task, sandbox-02 Playwright browser task, sandbox-N destroyed on finish) → Vultr Serverless Inference. **"Verifiable output: stdout · exit code · files · screenshot · hostname/uname proof."** | This is Airlock's layout already. It is therefore the *expected* shape, not a differentiator. Airlock's differentiators remain the useful patch and the grading that the worker cannot influence. |
| "Five checkpoints" | Reference demo output: 1 host check (CPU virt, `/dev/kvm`, KVM read/write); 2 agent → `sandbox_run` (Fibonacci list); 3 proof (`py-demo`, `Linux py-demo 6.12.99 … x86_64`); 4 isolation probe **BLOCKED**; 5 teardown "(no sandboxes)". | Adopt as the skeleton of every run record (§3.3). Expect many teams to ship exactly this and no more. |
| "Where to find us" | Links: VX1 docs, Serverless Inference chat + tool-calling guides, gVisor, OpenSandbox, E2B, Microsandbox-on-VX1 guide (QR). "Vultr DevRel is in the room all weekend." | Open organizer questions in 01 §8 can be asked in person. |
| "Screenshot this" | Ubuntu 24.04 on VX1; `usermod -aG kvm`; gVisor install and a `runsc` smoke command; `osb create --image python:3-slim`; `OPENAI_BASE_URL=https://api.vultrinference.com/v1`, `OPENAI_API_KEY=$VULTR_INFERENCE_API_KEY`; **"model: Kimi-K2.6"**. | Fresh check at 12:5x PDT today: `GET /v1/models` returns the same 19 models as in 13 and **no Kimi-K2.6**. The slide line is stale or refers to a different catalog (the pricing page lists Kimi-K2.6; 01 D-09). Choose the model by a real tool-call round trip on the live list, as 13 already says. |

## 3. Alterations to 35 and 37

### 3.1 Isolation runtime: an inspected, recorded tier; no Docker-only build

35 §5 and 37 "Runtime profile" allowed Docker + gVisor "if the smoke test passes" and a documented Docker-only fallback. Replace with:

- **Floor: gVisor (`runsc`).** A plain runc container is not an acceptable Airlock runtime. If gVisor cannot run the pinned Python image, fix the image or the runtime configuration; do not lower the tier.
- **Target tier on VX1: Kata Containers (`--runtime=kata`)**, an OCI runtime that gives each task container its own guest kernel while keeping the Docker API the supervisor already uses (dockerode, named volumes, `--network none`, resource flags, stopped-container collection). This is why Kata is preferred over Microsandbox/libkrun for Airlock: Microsandbox replaces the control surface (its own SDK/MCP/`msb` CLI) and would discard the OpenBot supervisor and OpenMuse inspection code that 37 reuses. Vultr's own guide uses Microsandbox; the deck names Kata in the same tier. If Kata fails its deployment probe on VX1 (no `/dev/kvm`, virtiofs volume problems, or the read-only collector mount misbehaving), gVisor remains the shipped runtime and the record says so.
- **The runtime is a deployment profile value that the supervisor inspects before every dispatch** (OpenMuse-style effective-configuration inspection, extended to check the actual runtime name and, for Kata, the guest kernel from `uname -r` inside the container). The runtime name, guest kernel string and host check result are written into the `VerificationRecord` (§3.3). The product records its tier; it does not claim one.
- Sandbox host = a VX1 plan (13 already selected `vx1-g-4c-16g-240s`, atl). The control plane stays on whichever plan is convenient; nothing in the rubric needs KVM there.
- Both runtimes must pass the same evidence gates: background child dies on stop, expired attempt cannot restart, altered flags fail attachment, a runaway task cannot exhaust host storage or starve the control plane. These are measured, per 35 §9.

### 3.2 Containment moment: answer "what dies?" with a judge-typed command

35 §7 used a labelled unsafe-code fixture hitting its timeout as the containment beat. Replace the primary beat:

- A **Hostile input** panel on the judge-role UI accepts a command or script (`rm -rf / --no-preserve-root`, a fork bomb, `curl 169.254.169.254`, `curl` to an arbitrary host) and runs it in a fresh author-profile sandbox with no repair pipeline attached. It is rate-limited and requires the judge role; it is not a public intake (24's veto on public payload intake stands).
- The result is a **blast-radius card**: *Died:* sandbox `t-…` (runtime, guest kernel, files destroyed inside its workspace, PID cap or exit reason). *Survived, re-checked after the event:* control plane health, supervisor health, the other running task, the sandbox host (`uptime`, a sentinel file hash). Then the destroy event and an empty `docker ps` listing.
- Keep the timeout beat and the forged-"tests passed" negative control. The forged-log beat is Airlock's most distinctive one; it is not dropped for timing.
- The video's containment moment is this card, which satisfies C1-11 ("the sandbox absorbing something unsafe") in the form the judges said they will ask for.

### 3.3 Five checkpoints in every run record

Extend the `VerificationRecord` and the run view with the deck's checklist, in its order:

1. **Host check** (per supervisor start and echoed per run): CPU virtualization, `/dev/kvm` present and readable, Docker runtimes available, selected runtime.
2. **Execution**: the actual command/tool calls with stdout, stderr, exit code, wall time, per sandbox.
3. **Proof**: `hostname` and `uname -a` from inside each sandbox, alongside the host's, so the guest kernel (Kata) or gVisor's kernel string visibly differs from the host's.
4. **Isolation probe**: a fixed probe run in every author sandbox before agent work: metadata endpoint, DNS, outbound TCP, Docker socket, host mounts — each expected **BLOCKED**, and a run whose probe is not fully blocked is refused.
5. **Teardown**: the destroy events and the post-run listing "(no sandboxes)" for the task.

Also answer "is the model yours, or a borrowed key?" in the UI: the inference log shows `api.vultrinference.com`, model id and token counts for every call. No other provider appears in the runtime path (01 C1-02).

### 3.4 NetBird: optional add-on, with a recommended shape

See §4 for the clarification. **NetBird is not a guaranteed part of the project.** Nothing in the core depends on it; the controller → supervisor link runs over the Vultr VPC, and the public URL is served directly from VM A. The add-on is attempted only after the core flow works end to end. If it is attempted, in this order:

- **Approach 3, peer-to-peer (first).** The controller (VM A) and the supervisor (VM B) become NetBird peers. The supervisor listens **only on its NetBird interface**; VM B's Vultr firewall group has **zero inbound rules**. NetBird access policy: group `control` → group `execution` on the supervisor port only; default all-to-all policy deleted; nothing may initiate toward `control`. Task sandboxes have no network and are not peers. This gives the privileged supervisor a mutually authenticated, private transport that only the controller can reach, which the Airlock trust model wanted anyway (36c invariant 6), without putting NetBird in the inference path (24 FDA-11) or depending on the beta reverse proxy.
- **Approaches 1 and 2 (second, combined).** The public app URL is served through the self-hosted NetBird reverse proxy on a small third VM (14 §2 topology), so VM A also has zero inbound rules; password auth maps to the app's `judge` role and SSO groups to `operators`. Then the only public inbound anywhere is the NetBird server's 80/443/3478.
- **Approach 4 is not pursued.** Airlock's preview is a typed supervisor operation rendered by the trusted UI; it deliberately has no per-task URL or port forward (35 §5 "Preview"). Do not add one to chase this approach. 14 §3's expose-session lifecycle machinery is therefore not needed.
- **Evidence for judges:** NetBird dashboard showing the two peers connected (direct), the access policy, `ss -ltn` on VM B showing the supervisor bound to the NetBird address only, both VMs' Vultr firewall views with no inbound rules, the proxy service configuration and the judge password prompt. Put screenshots and the judge credentials in the README (NB-05).
- **Failure mode:** if the peer link drops, the controller cannot reach the supervisor and tasks stall with a visible error; NetBird's relay fallback covers most drops. The Vultr VPC link stays configured so the add-on can be switched off without touching the core.
- **Not attempted or not working:** the core submission is unchanged and the bonus is not claimed.

### 3.5 Build gates: hour targets are soft

35 §9's gate table keeps its hour targets; they order the work and set expectations. They are loose guidelines only and never a reason to reduce scope. Scope is reduced only when a gate fails on its evidence (for example, the repair gate not reaching 2/3 after prompt/tooling simplification). The table gains a runtime-tier gate (§3.1) and an optional NetBird add-on row after Freeze (§3.4).

### 3.6 What does not change, and the questions to prepare

- **Project, hero case, comparator, artifact contracts, two-VM topology**: unchanged. The deck's two-instance slide confirms the topology as the expected baseline.
- **Not adopting OpenSandbox**, despite "best combo: OpenSandbox on gVisor." Prepared answer: OpenSandbox is a platform for an agent to talk to sandboxes through an SDK; in Airlock the agent never talks to a sandbox, only the supervisor does, through a fixed vocabulary (create, author-tool, freeze, invoke, revoke, destroy) with fencing and journaling that OpenSandbox does not provide. Its egress policy sidecar also does not work under gVisor (02 §sandbox table), and Airlock needs none because task networks are `none`. We use the same runtimes it would use underneath.
- **Not adding a browser task.** The challenge accepts code or browser work; the deck's sandbox-02 Playwright box is an example, not a requirement.
- **Prepared answers** for "why not Microsandbox like our guide?" (§3.1: Kata keeps the Docker control surface; both are the deck's tier 4) and "Kimi-K2.6?" (§2: not on the live list; we pick by measured tool-call behavior).

## 4. The NetBird clarification, verbatim

Posted by the organizers on Discord after kickoff:

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

What it changes relative to 01 §2c and 14:
- The three bullets are **not cumulative tiers**; any single approach qualifies. 14 Q-09 is answered.
- **Approach 3 is new.** It does not require the reverse proxy, a domain, a wildcard certificate or the 10-sessions-per-peer expose cap. It is the cheapest qualifying approach and the one that improves Airlock's own security posture.
- The "zero-ports moment in the video" (NB-04) is softened to "show how you're using NetBird in your demo or README," with screenshots explicitly acceptable. Still show it on video; the README carries the screenshots regardless.
- Still open: whether NetBird Cloud qualifies (Q-04) and whether SSH on the app VM counts as an application port (Q-03). Self-host on Vultr and keep SSH closed on the app and execution VMs (admin access via NetBird), which satisfies every reading.

## 5. What the Challenge 2 deck adds

- Confirms Challenge 2 is enterprise workflow agents (sales pipeline, recruiting co-pilot, ops exception handler, campaign crew, finance close, support fleet), with no robotics content. 01 D-03 stands. The "recruiting co-pilot that screens candidates" example still conflicts with the guide's banned job-application screener (D-07); not relevant to a Challenge 1 build.
- Qualifying submission: deployed on Vultr as the central backend (mandatory), autonomy and business value, public demo URL, public repo, architecture video or explanation. Tech stack is free; Serverless Inference recommended (Nemotron, Kimi, Qwen, Llama, DeepSeek).
- Prizes: more than $10K in cash and credits; $5,000 / $3,000 / $1,000 cash for the top three; one judging pool for both challenges.
- Resources: Serverless Inference docs; live model list at `api.vultrinference.com/v1/chat/models` (**still the URL that returns 404**; use `/v1/models`, 01 D-01); a **Coolify** marketplace app for fast deploys; the hackathon Discord.
- New Vultr presenter name: Talia Sverdlik (add to 20 as a possible judge; unconfirmed).

Nothing here changes the Challenge 1 plan.

## 6. Limits of this pass

Read from the two PDFs and the pasted clarification only; no new deployment, inference call or NetBird test was performed. The Kata-on-VX1 choice is a design decision with a deployment probe attached; it is not measured. The `/v1/models` check is the only live check in this file.
