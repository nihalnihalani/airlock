> **Updated comparison caution:** the old positioning claims that CI only runs after merge or that no agent vendor verifies work are incorrect. See [34](34-main-challenge-evidence-and-decision.md) for current OpenHands/Astro evidence and [35](35-AIRLOCK-MAIN-CHALLENGE.md) for the scoped product claim. Older source audits remain pinned to their recorded versions.

# 06 — Competitive Landscape and Novelty Checks: "Blast Radius Zero"

Checked 2026-09-26. Capabilities come from **official docs or vendor pages** wherever a source is linked. Cells marked *(04)* reuse the secondary MarkTechPost-based data in `04-painpoints-blast-radius-zero.md`, which I did not re-verify today. Cells marked "not found" mean I didn't see it in what I read. That is **not** evidence the feature is absent: a feature missing from a landing page may still exist. Evidence IDs are in `evidence-p.jsonl`; raw notes are in `raw/papers-comp/`.

---

## TL;DR

- **Sandboxing is commoditized:** microVMs, gVisor, default-deny egress, snapshot/fork and session replay.
- **Credential brokering is commoditized too.** The sandbox holds a placeholder and the proxy swaps in the real secret. Vercel, Cloudflare, Docker Sandboxes and Claude Code all ship it, and so do at least 6 OSS proxies.
- **Hash-bound approvals are an established pattern.** Examples: Mastra docs, the WorkOS blog, Microsoft agent-governance-toolkit, openmed approval tokens.
- **Migration rehearsal on DB branches is shipped:** Netlify gives each agent run its own DB branch.
- **Still open as a product (nobody among the 20 checked ships these together as first-class features):**
  1. **Independent re-execution in a fresh sandbox outside the agent's trust domain**, emitting a verdict. Among agent-sandbox products it exists only in niche OSS and papers. **Correction (rev. after 18, §A5):** in *fuzzing infrastructure* it is production-standard: ClusterFuzz/OSS-Fuzz re-runs testcases daily against the latest build until fixed and auto-closes the bug, and syzbot re-runs stored reproducers on a tree or patch "to check if the bug is already fixed", both with regression/fix bisection. Two-ref re-execution itself is therefore **not** novel; see §4.
  2. **Receipts of *executed effects*,** as opposed to commit signatures (Cursor) or policy-decision receipts (AgentBound).
  3. **Tripwires wired to automatic sandbox destruction plus a forensic snapshot.** Honeytokens exist generically, but not inside agent-sandbox products.
  4. **Approval cards rendered from what the proxy or sandbox *observed*.** Most approval prompts show the agent's own summary (OpenHands example code) or come from model judgment (ChatGPT agent).
- **Best positioning:** "A self-hosted control plane on Vultr that turns commodity isolation into **verifiable** execution." The differentiation is the **combination and the evidence**, not any single primitive.

---

## 1. Competitor matrix (20 rows)

Column key:
- **Coverage:** C = code execution, B = browser, D = desktop/computer-use, W = whole SWE agent.
- **Receipts:** verifiable outputs or receipts.
- **Deploy:** deployment complexity for a team.

| # | Product | Coverage | Where execution runs | Provider flexibility | Isolation | Approvals | Recoverability | Receipts | Deploy | Pricing basis | License | Checked |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | **E2B** | C (+B/D via templates) | E2B cloud (GCP per [security page](https://e2b.dev/security)); self-host possible | Any LLM (infra only) | Firecracker microVM *(04)* | None built in (infra) | Pause/resume, snapshot, fork ([e2b.dev](https://e2b.dev/)) | Logs only *(04)* | Low (SDK); self-host is heavy (needs KVM, 12 GiB; see 02) | Billed per second ([e2b.dev](https://e2b.dev/)) | Apache-2.0 ([e2b.dev](https://e2b.dev/)) | 2026-09-26 |
| 2 | **Daytona** | C, VM, GPU, macOS | Daytona cloud; BYOC *(04)* | Any LLM | Containers plus a VM class with its own kernel ([isolation](https://www.daytona.io/docs/en/isolation/)) | None built in | VM class: pause/resume, fork, hot snapshots [EV-P-0042] | Not found | Low | Usage *(04)* | AGPL-3.0 ([Pixeljets](https://pixeljets.com/blog/ai-sandboxes-daytona-vs-microsandbox/), secondary) | 2026-09-26 |
| 3 | **Modal Sandboxes** | C | Modal cloud | Any LLM | gVisor ([Northflank blog](https://northflank.com/blog/daytona-vs-modal), secondary; *(04)*) | None | FS, memory and fork snapshots ([docs](https://modal.com/docs/guide/sandbox-snapshots)) | Not found | Low | Usage (≈3× functions *(04)*) | Proprietary | 2026-09-26 |
| 4 | **Microsandbox** | C | Self-hosted / local | Any | libkrun microVM (secondary) | None | Snapshots (vendor comparison page) | Not found | Medium | Free (OSS) | Apache-2.0 (secondary) | 2026-09-26 |
| 5 | **OpenSandbox** (Alibaba) | C, B (chrome / playwright images) | Self-hosted Docker/K8s → **runs on Vultr** | Any | runc, gVisor, Kata or Firecracker (see 02) | None | Lifecycle API, TTL | Not found | Medium (unsafe defaults; see 02) | Free | Apache-2.0 (02) | via 02 |
| 6 | **gVisor / Firecracker / Kata** (primitives) | Any | Anywhere (Vultr VM; KVM needed except gVisor) | Any | User-space kernel / microVM | DIY | DIY | DIY | High | Free | Apache-2.0 (all three; prior knowledge) | via 02 |
| 7 | **Vercel Sandbox** | C | Vercel (AWS); AWS BYOC beta *(04)* | Any (AI Gateway) | Firecracker *(04)* | None | FS snapshots *(04)* | Not found | Low | Usage | Proprietary | 2026-09-26 |
| — | ↳ network | | | | Deny-all, SNI allowlist, **credential brokering** by domain/path/method, live updates [EV-P-0029] | | | | | | | |
| 8 | **Cloudflare Sandbox / Containers** | C | Cloudflare edge | Any | Containers | None | Disk resets on sleep *(04)* | Not found | Low (Workers only) | Usage | SDK OSS; runtime proprietary | 2026-09-26 |
| — | ↳ network | | | | Outbound Worker handlers **inject secrets outside the sandbox**; TLS interception (2026-04-13) [EV-P-0030] | | | | | | | |
| 9 | **Docker Sandboxes (sbx)** | W (runs Claude Code, Codex, Gemini CLI) | Local microVMs | Any agent | microVM, own kernel and Docker engine | None found | Not found | Not found | Low | Docker subscription (unverified) | Proprietary | 2026-09-26 |
| — | ↳ network | | | | Deny-by-default; **credentials injected by host proxy** ([Docker blog](https://www.docker.com/blog/defending-your-software-supply-chain-what-every-engineering-team-should-do-now/)) | | | | | | | |
| 10 | **Northflank Sandboxes** | C + full workloads | Managed or **BYOC** (AWS/GCP/Azure/Oracle/on-prem/bare metal) | Any | Kata + Cloud Hypervisor, Firecracker or gVisor per workload ([blog](https://northflank.com/blog/best-byoc-sandbox-platforms)) | None | Not found | Not found | Medium | $0.01667/vCPU-hr, per second (vendor) | Proprietary | 2026-09-26 |
| 11 | **Browserbase** | B | Browserbase cloud | Any (Stagehand etc.) | Per-session VMs *(04)* | None | Contexts *(04)* | **Session video recorded by default**, 31-day retention [EV-P-0041]; a video, not a verifiable receipt | Low | Browser-hours | Proprietary (Stagehand OSS) | 2026-09-26 |
| 12 | **Steel** | B | Steel cloud **or self-host via Docker** ([steel.dev](https://steel.dev/)) | Any | Firecracker VM per session (founder HN post, Dec 2024) | None | Sessions | Session viewer | Low–Medium | $0 / $250 per month + usage | Apache-2.0 ([repo](https://github.com/steel-dev/steel-browser)) | 2026-09-26 |
| 13 | **Hyperbrowser / Browser Use Cloud** | B (Browser Use also agent) | Vendor cloud | Any | Browser Use: Firecracker *(04)* | None | Profiles | Not found | Low | Hyperbrowser: credits; Browser Use: $0.02/browser-hour, per-minute billing ([pricing](https://browser-use.com/pricing)) | Browser Use lib is OSS; clouds proprietary | 2026-09-26 |
| 14 | **Anthropic computer use** | D, B | **Client-side**: you supply the VM or container ([docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool)) | Claude only | Reference Docker container | Up to the developer | Up to the developer | Up to the developer | Medium | Tokens | Reference implementation OSS | 2026-09-26 |
| 15 | **OpenAI ChatGPT agent / Codex cloud** | B, D (agent); W (Codex) | OpenAI cloud | OpenAI only | Hosted VM/containers (details not verified) | Agent: **asks before consequential actions**, watch mode, takeover [EV-P-0039]. Codex: **internet blocked by default in the agent phase**, allowlist [EV-P-0038] | Codex returns a diff/PR | Not found | None (SaaS) | Subscription | Proprietary | 2026-09-26 |
| 16 | **Claude Code sandboxing / Claude Code on the web** | W | Local (bubblewrap/Seatbelt) or Anthropic cloud | Claude (plus configured providers) | OS sandbox, FS + network via proxy ([srt](https://github.com/anthropics/sandbox-runtime)) [EV-P-0043] | Per-domain prompts; auto mode with classifier *(04)* | Checkpoints (don't cover Bash; *(04)*) | Transcript | Low | Subscription / tokens | srt is OSS | 2026-09-26 |
| — | ↳ network | | | | **Credential masking**: placeholder in file, proxy substitutes on egress [EV-P-0031]; git proxy on the web version | | | | | | | |
| 17 | **Cursor Cloud Agents** | W | Isolated VMs on Cursor's AWS; self-hosted machine option | Multi-model | VM per agent | **Auto-runs all terminal commands** in cloud agents [EV-P-0037]; PR approval routing | Environment snapshots (90 days) | **HSM-backed Ed25519 signed commits** (provenance of the commit, not of the execution) | None (SaaS) | Subscription | Proprietary | 2026-09-26 |
| — | ↳ network | | | | Internet on by default; allowlist modes | | | | | | | |
| 18 | **Devin / Manus** | W / general agent | Devin: its cloud, or **Outposts** in your VPC on Cloudflare or Daytona ([blog](https://devin.ai/blog/introducing-devin-outposts)). Manus: isolated cloud VM per task ([blog](https://manus.im/blog/manus-sandbox)), built on E2B ([case study](https://e2b.dev/customers/how-manus-uses-e2b-to-provide-agents-with-virtual-computers)) | Vendor models | VM snapshot per session | Chat-level oversight (not verified) | Snapshots | Not found | None (SaaS) | Subscription / ACU | Proprietary | 2026-09-26 |
| 19 | **OpenHands** | W | Self-host; **Docker sandbox by default** ([docs](https://docs.openhands.dev/openhands/usage/sandboxes/docker)) or cloud | **Any LLM** (LiteLLM), so it could run on Vultr Inference | Docker container | **Confirmation mode + LLM security analyzer** (`ConfirmRisky`); the example code leads with the LLM's summary [EV-P-0040] | Not found | Event log | Medium | Free / cloud | MIT (prior knowledge; not re-verified) | 2026-09-26 |
| 20 | **Ordinary scripts / Playwright / RPA (UiPath) / manual** | Any | CI runner, desktop, or a person | n/a | CI runner or none | UiPath **Action Center** human tasks ([blog](https://www.uipath.com/community-blog/tutorials/human-in-the-loop-automation0-for-customer-onboarding-using-action-center)); manual = the human *is* the approval | Git revert, DB backups | CI logs; Orchestrator logs | Low → High | Free / license / labor | Various | 2026-09-26 |

**Reading the matrix**
- **Infra vendors (rows 1–13)** sell isolation, lifecycle and networking. None ships approvals or verification.
- **Agent products (rows 14–19)** ship approvals, but those approvals are model-narrated or model-triggered, and the products run on the vendor's cloud with the vendor's models.
- **The ordinary alternative (row 20)** is "CI re-runs the tests on the PR plus a human reviews the diff". That already provides independent re-execution **for code**. Our demo has to beat it on:
  - speed: seconds, pre-merge, per agent step;
  - scope: browser and API side effects, not just tests;
  - tamper-evidence: pristine tests, a separate VM, signed receipts.

---

## 2. Novelty checks for candidate differentiators

Classification key: **new capability** / **better workflow** / **stronger boundary** / **packaging**.

| # | Differentiator | Existing implementations found | Classification | Verdict for the hackathon |
|---|---|---|---|---|
| a | **Action-bound approvals** (approve exact parameters, hash-bound, expiring) | openmed single-use tokens signed over the SHA-256 of the action plus expiry and nonce [EV-P-0035]; Microsoft agent-governance-toolkit #2478 (parameter-hash binding) [EV-P-0034]; Mastra HITL docs ("bind approval to the exact tool arguments"); WorkOS step-up blog; go-micro durable approvals. Research: VAC dispatch-time re-check [EV-P-0021]; Consent Integrity [EV-P-0022] | **Packaging** for the hash/expiry part. **Stronger boundary** only if the card is built from what the **proxy or sandbox observed** (the real HTTP request, SQL statement or DOM target) and re-checked at dispatch. Mainstream products show agent-narrated summaries [EV-P-0040]. | Build it, but **don't pitch the hash as novel.** Pitch "what you approve is what the wire sees". |
| b | **Signed execution receipts / attestation** | Research is crowded: AgentBound (policy receipts, no results) [EV-P-0024], NovaFabric (DSSE + Merkle) [EV-P-0025], Proof of Execution, Sello, Agent Flight Recorder, PunkGo, VET. Products: Cursor signs commits with HSM-backed Ed25519 [EV-P-0037]; Browserbase session video [EV-P-0041]. | **Packaging** (standard DSSE / in-toto / Sigstore). Nothing new cryptographically. | Use off-the-shelf formats (DSSE/in-toto). Differentiate on *what* is signed: observed effects plus the verifier's verdict. |
| c | **Independent re-execution in a fresh sandbox** | OSS: ouroboros harness reruns [EV-P-0044], dos-kernel `verify`, bitget-agentbench replay. Research: Rajan's Docker gate [EV-P-0014], BenchJack's isolation principle [EV-P-0016], RewardHackingAgents evaluator locking. Ordinary CI re-runs tests post-PR. **Production prior art missed in the first pass (rev. after 18, 18 §A5):** ClusterFuzz/OSS-Fuzz (daily re-run on latest build, auto-verify and close, fix/regression bisection) and syzbot (`#syz test` re-runs a stored reproducer on a tree or patch, including "already fixed?" checks, plus cause/fix bisection). SWT-bench harnesses do fail-before/pass-after in fresh containers [EV-R-0019]. | **Better workflow + stronger boundary** only for *untrusted natural-language issue input*; the re-execution mechanism itself is established (ClusterFuzz/syzbot). Not in any sandbox vendor's product that I found. | **Strongest open lane.** Put it at the demo's center: agent claims → a fresh Vultr VM re-runs with pristine tests → verdict plus receipt. Keep scope deterministic, since NovaFabric shows tool-using replay is hard. |
| d | **Credential-brokering egress proxy** (placeholder tokens) | Vercel [EV-P-0029], Cloudflare [EV-P-0030], Docker sbx, Claude Code credential masking [EV-P-0031]. OSS: iron-proxy [EV-P-0033], fnox [EV-P-0032], onecli, shuru, Bromure, omnigent #236, Dust design doc. | **Packaging** (commoditized). | Reuse iron-proxy or fnox rather than building one. Mention it as table stakes. Its value here is "self-hosted on Vultr, and every swap is logged into the receipt". |
| e | **Canary / honeytoken tripwires in agent sandboxes** | Generic: Thinkst Canarytokens, Tracebit, GitGuardian honeytokens. Agent-specific: IBM ContextForge EPIC #2599 (shipping status unverified), AgentShield paper [EV-P-0027]. Theory: tokens are sensors, not a boundary [EV-P-0028]. | **Better workflow** (the concept is old; the integration is new). Not found as a feature in E2B, Daytona, Modal, Vercel or Cloudflare. | Good theatrical demo: touching the fake metadata or credentials triggers an auto-snapshot plus instance destruction. **Frame it as a detector layered on isolation.** |
| f | **Snapshot / preview-then-apply** (dry-run diff of destructive ops) | File-level diffs are commodity: Codex and Cursor PR diffs, virtual-FS overlays, Fly Sprites copy-on-write checkpoints, Modal and Daytona snapshots and forks. IaC has `terraform plan`. Research rollback is weak and cannot un-send external calls [EV-P-0026]. | **Better workflow** only for *external* side effects (cloud/API/DB blast-radius preview). **Packaging** for files. | Scope it to "external effects are dry-run in a fork, then proxy-observed requests become the approval card". Combine with (a). |
| g | **Patch verification / bug reproduction in disposable environments** | Research is saturated: SWT-Bench line, DPIAgent 86%, Echo, AssertFlip, SWE-Doctor, CoHarden. Products: Devin, OpenHands and Codex all run in containers. | **Packaging.** | Use only as a sub-step inside (c): the reproduction test must fail before and pass after, in the verifier VM. |
| h | **Migration rehearsal on disposable DB clones** | Netlify Database gives each agent run a DB branch and the agent has no prod credentials [EV-P-0036]; Prisma per-branch rehearsal; Neon-style branching; PandaStack. | **Packaging** (commoditized). | Optional demo variant on a Vultr Managed DB fork or snapshot. Don't lead with it. |

**Counts:**
- Commoditized / packaging: **d, g, h** fully; **a** and **b** at the mechanism level.
- Better workflow: **e, f**.
- Better workflow + stronger boundary (the most open): **c**, plus **a** when the card is built from observed ground truth.
- No differentiator qualifies as a genuinely **new capability.**

---

## 3. Recommended positioning

**"Proof-of-Run on Vultr."** The agent works in a disposable gVisor sandbox or VM. Credentials are brokered (commodity, stated as such). A **separate** fresh Vultr instance then independently re-executes the claimed result with pristine tests. It emits a DSSE-signed receipt of the *observed* effects (egress log, file diff, stdout hashes) plus the verifier's verdict. Any external side effect waits on an approval card built from the proxy-observed request and bound to its hash. Tripwires kill the run on contact.

**Why this wins against the matrix:**
- No infra vendor ships verification or approvals.
- No agent vendor runs its verifier outside its own trust domain.
- CI only covers code, and only after merge.

**Literature anchors:** BenchJack V1/V7, Rajan's 61.9% LLM-judge miss, VAC and Consent Integrity, SandboxEscapeBench (see `05-papers-and-benchmarks.md`).

**Honest caveats for judges:**
- Every primitive exists somewhere.
- Two-ref, fresh-environment re-execution with auto-verification is standard in ClusterFuzz and syzbot for fuzzer crashes (§4, rev. after 18). Never imply it is new.
- Our claim is the integration, self-hosted on Vultr with Vultr Serverless Inference.
- The measured demo numbers must come from **our own runs** (for example pass^k over N fresh sandboxes), never from the papers.

---

## 4. Post-review corrections (rev. after 18-devils-advocate-review.md)

1. **ClusterFuzz and syzbot are prior art for two-ref re-execution (18 §A5, DA-05).** They take *fuzzer-generated* crashes with machine-produced reproducers and re-run them on latest/fix builds at production scale. What neither does: accept a **natural-language, untrusted issue report**, have an **LLM author** the reproducer, treat the report as **hostile code** (secret-free, egress-limited sandbox on a separate VM), or gate the outward post on a **hash-bound human approval**. **Positioning:** "syzbot-style verification for human- or AI-written issue reports, with the report treated as hostile code." Creativity is scored 5, not 6 (10 §6).
2. **withastro/triagebot-action, corrected (18 §A1, DA-12; read at `51d30da`).** It is the closest product. Its repro commands run through `sandbox: local()` → `child_process.exec` **directly on the GitHub Actions runner**, with unrestricted network (`dangerouslyAllowFullInternetAccess: true`). It is **runner-level, not sandboxed**: its only isolation is the ephemeral runner VM. The write token and model key are inputs to the same job and sit in the **parent node process's environment on that runner** (readable via `/proc/<ppid>/environ`), but they are **not** in the agent shell's env, which is allowlisted to `PATH, HOME, USER…` plus the read token. It has no fresh-sandbox re-execution and no receipt, and posts (and can force-push fix branches) without human approval. Its LLM "verify" step *does* address bug-vs-intended, which Repro Receipts deliberately doesn't. **Stage-safe sentence (00 §3):** "triagebot runs repro commands on the same runner that holds its write token and model key; we run them in a secret-free, egress-limited sandbox on a separate VM and re-execute them fresh." Don't say its keys are "in the sandbox env", and don't say it "runs in isolation" (18 V1).
