# 26a — Ideas through the "judge relatability" lens

Ideator: relatable-to-judges lens. Written Sat 2026-09-26, about 07:15–08:00 PDT, before hacking starts.

**Inputs read:** README, 25-WIN-PLAN, 20, 03a/03b, 04 (both), 06-competitive, 10, 12 §4, 13, 14, 22 (grep), 23, 24.

**New web evidence:** 11 Firecrawl searches, about 22 credits, last-30-days filter where it applies. Confidence labels follow 20:
- **[C]** the page itself was read;
- **[S]** search snippet only;
- **[R]** from memory, not re-checked today; verify before quoting on stage.

**The lens.** Gary-Yau Chan's rule: *"Judges want to picture themselves as the user; if their family or coworkers have the problem, say so."* So the question for every idea is whether **Kevin Cochrane, Mayank Debnath, Mirdul, Kartikey, Sanskriti, Brandon Hopkins and Ivan Porollo** have personally felt this pain in the last month. The panel is still the inferred one from 20 §1.

**Bottom line up front:**
1. **Try Before You Trust** (§3), narrowed to **MCP servers, packages and install one-liners first, arbitrary repos best-effort**, is the most relatable idea I can find. It is the only one where **the NetBird bonus is the product rather than a bolt-on**: the preview URL you use is the tier-3 URL that dies with the task.
   - My honest scores are R1 7.58 and R2 7.50, against the incumbent Repro Receipts at 7.48 / 7.38 (Fable's scores).
   - Self-scores run about 1.3 high (24 §2), so treat this as a **tie on points**.
   - It **wins on relatability and NetBird fit**, and **loses on validation**: none of 22's lab work transfers to it.
2. Runner-up: **Does It Run?** (§4), a hackathon judge's copilot that also checks take-homes. It is maximally relatable because the judges do this job the same weekend, but it scores lower (R1 7.05) because agents often fail to set up arbitrary repos.

---

## 1. What this panel personally lives with (Sep 2026)

| Pain | Who on the panel feels it personally | Current evidence (dated) | Conf. |
|---|---|---|---|
| **"Just clone this and `npm install`"**: fake job interviews that deliver malware | Everyone who hires or has interviewed (all of them), plus their dev teams on corporate laptops | Six government agencies issued a joint advisory naming **WaterPlum / "Contagious Interview"**: **at least 30,000 devices** in 100+ countries, **$10.71M in crypto stolen**, Dec 2025–Jul 2026 (hacklido, gblock, invaders.ie, about Sep 21–23). A r/csMajors post 4 days ago: "Fake recruiter tricked me into running malicious code… I ran npm install" | [S] |
| **Installing someone's MCP server / agent skill** | Brandon Hopkins, who launched NetBird Agent Network (keyless LLM access for agents); Vultr DevRel, whose own guide pairs Microsandbox with an MCP server (20 §3) | GTIG AI Threat Tracker: UNC6780 published **trojanized forks of MCP servers to PyPI (`tiktoken_mcp`)** and injected code into an official org repo (`azure-functions-mcp-extension`). Pillar "Deadbugz": a malicious MCP server whose updated tool descriptions told agents to hunt SSH keys, AWS creds and shell history, **sprayed to 23 repos in one evening**. Island research: **about 8,000 malicious public GitHub repos** that "lie to your robots" (John Hammond, this month) | GTIG [S], others [S] |
| **Piping a stranger's install script into bash** | Brandon (homelab and self-hosting is his whole channel; NetBird's own install is `curl … \| bash`, 20 §4); every DevRel who writes "Getting started" docs | r/selfhosted this month: "My homelab was compromised. Here is what I learned". 04 row 10: the MCP STDIO RCE family spans 150M+ downloads | [S] |
| **ClickFix: "paste this into your terminal"** | Cochrane (CMO) and his family and coworkers; this is the non-developer version | ClickFix reports a **517% surge** and **now targets macOS** (hwbusters, Sep 2026). TechSpot / Slashdot headline: "ClickFix May Be the Biggest Security Threat Your Family Has Never Heard Of". The Hacker News weekly recap from 5 days ago lists "AI Agent RCE, ClickFix attacks" | [S] |
| **npm postinstall credential theft** | Every developer | Recorded Future's H1 2026 malware trends: compromised npm publisher accounts shipped trojanized versions whose pre/postinstall scripts harvest GitHub, cloud and container credentials and then **self-propagate by publishing new malicious packages** | [C] (page snippet with diagram) |
| **"Does this submission actually run?"** | **The judges, this weekend.** Porollo's Cerebral Valley runs a hackathon almost every week, and Vultr DevRel judges them (20 §5) | No citation needed: every judge in the room will try to open a repo that doesn't start | [I] |
| Untrusted bug-report PoCs (the incumbent) | OSS maintainers and PSIRTs. **Nobody on this panel triages bug bounties** | 23 §1 | — |

**Why this matters for the incumbent.** Repro Receipts' pitch opens with "raise your hand if you've run a stranger's PoC". In this room almost nobody will. "Raise your hand if you've installed an MCP server, or piped a `curl` into `bash`, this month" gets **every hand**.

---

## 2. Six fresh concepts, screened through the lens

Relatability (Rel) is 0–10: can a named judge picture themselves as the user this month?

| # | Concept | One line | Rel | T | C | D | F | R1 | Verdict |
|---|---|---|---|---|---|---|---|---|---|
| 1 | **Try Before You Trust: any repo** | Paste any GitHub repo, MCP server, npm/PyPI package or install script. An agent gets it running in a throwaway Vultr VM, uses it like a user, and reports what it **did**: network, files, secret reads caught by honeytokens. You also get a NetBird preview URL that dies with the task | 9 | 8 | 7 | **5.5** | 7.5 | 7.08 | **Right idea, wrong scope.** "Any repo" fails live too often (§3.1). Narrowed, it becomes #2 |
| 2 | **Try Before You Trust: MCP- and install-first (the "tasting room")** | The same product with inputs ordered by setup determinism: MCP servers (`npx`/`uvx`, a uniform protocol), then packages, then install one-liners, then docker-compose repos, then arbitrary repos as best-effort with an honest COULDN'T RUN | **9** | 8 | 7 | 7.5 | 7.5 | **7.58** | **Pick A** (§3) |
| 3 | **Interview Airlock** | A candidate pastes the "take-home" repo a recruiter sent. It runs in a throwaway VM, and they get a behaviour report plus a browser IDE (code-server) inside that VM through a NetBird URL, so the interview happens in the airlock | 8 | 7 | 7 | 7.5 | 7 | 7.13 | Strongest *story* (30k devices, 5 days old), but it is #2 with an IDE. **Use it as Pick A's hook, not as a separate product** |
| 4 | **Does It Run? (judge's copilot)** | Paste a repo plus its README claims. You get a running preview and a claim-by-claim receipt (ran / didn't, with screenshots), and the browser agent tries each claimed feature | **10** | 7.5 | 7.5 | 6 | 6.5 | 7.05 | **Pick B** (§4). Most relatable and most fragile |
| 5 | **Paste-Check** | Paste any command someone told you to run (ClickFix, a Discord "fix", `curl \| bash`). It detonates in a throwaway VM, and you get a plain-English account of what it downloaded, read and persisted | 8 (Cochrane's family) | 6.5 | 6 | 7.5 | 6.5 | 6.58 | ClickFix payloads are mostly **Windows PowerShell / macOS osascript**. A Linux VM covers only the `curl \| bash` slice, and Windows VMs add licence cost and boot time. It competes with ANY.RUN, VirusTotal and Hybrid Analysis, and the agent's job is thin. Fold `curl \| bash` into #2 as an input type |
| 6 | **Link Taster** | Forward a suspicious link (a toll-scam SMS, a fake DocuSign). A browser agent in a throwaway VM plays the victim with honeytoken credentials and reports where the credentials go and what downloads | 8 (everyone gets toll texts) | 7 | 6 | 5.5 | 6.5 | 6.43 | Live phishing sites die within hours, and planted pages look staged. urlscan.io, Safe Browsing, Norton Genie and SOC phishing triage (Sublime, Abnormal) are crowded. Handing even fake credentials to real criminals raises an ethics question on stage |

**Filtered out before scoring:**
- "Is this vibe-coded app safe?", which pentests a Lovable/Bolt URL. Scanning a live third-party URL is only safe on our own clone, and it drifts to Challenge-1's own "site QA sweep" (10 #16).
- A "family IT desk" for scam calls. It has no code execution, so it fails G2.

---

## 3. Pick A — **Try Before You Trust** ("the tasting room")

### 3.1 First, the honest check: can an agent get "ANY repo" running?

| Source | Setting | Success | Conf. |
|---|---|---|---|
| **EnvBench** (JetBrains, ICLR'25 workshop; arXiv 2503.14443) | 329 Python + 665 JVM repos. Strict metric: zero exit **and** zero missing-import issues | Bash agent on GPT-4o: **6.69% Python, 29.47% JVM**. Zero-shot: 5.47% / 8.57% | [C] (table in the search result) |
| **SetupBench** (Microsoft, arXiv 2507.09063, Jul 2025) | 93 bare-Linux bootstrap tasks | By category, **database setup 20.0–53.3%**. Overall best agent (OpenHands) roughly 34–62% | categories [S]; overall [R] |
| **Repo2Run** (arXiv 2502.13681) | 420 Python repos with unit tests; a specialised agent with Docker rollback | **86.0%**, vs. SWE-agent about 9% | [S] |

**Implications:**
- A generic "get this repo running" agent on a mid-tier Vultr model is a **coin flip at best** on arbitrary repos, and most of those runs take several minutes. **A live "paste any repo" beat will fail on stage about half the time.**
- The fix is to **rank inputs by how standard their entrypoint is**:
  - **MCP servers:** `npx -y pkg` / `uvx pkg`, then the MCP `initialize` → `tools/list` → `tools/call` handshake. Near-deterministic, with no model needed to start it.
  - **npm/PyPI packages:** install, import, call the exported main.
  - **Install one-liners:** run as-is.
  - **docker-compose repos:** `compose up`.
  - **Arbitrary repos:** best-effort agent with an iteration cap.
- **"COULDN'T RUN — here's the last error and what it did before failing"** is a first-class, honest verdict. A malicious `postinstall` runs *before* the build fails, so the safety half of the report still works.

### 3.2 Spec

**One-line pitch:** *"Before an MCP server, package or install script touches your laptop, we run it on a throwaway Vultr VM, use it like you would, and show you everything it tried to do, plus a live preview link that dies when you're done."*

**Who, and why a judge relates:**
- **Brandon Hopkins** installs self-hosted apps and MCP servers for a living (homelab channel), and ships `curl | bash` installers.
- **Vultr DevRel** try community projects and MCP servers for workshops.
- **Cochrane** has developers on corporate laptops who take side interviews (WaterPlum).
- **Porollo** runs hackathons full of "clone my repo" moments.

**Buyers:**
- Platform and security teams that must approve which MCP servers and packages employees install.
- MCP registries that want a behaviour-verified badge.
- Individual developers, on a free tier.

**Wow feature 1: bait-and-watch.**
- The golden VM image is seeded with **honeytokens a real attacker wants**: `~/.aws/credentials`, `~/.ssh/id_ed25519`, a `.env`, a fake browser cookie DB, and a **fake MetaMask vault**, because WaterPlum steals wallets.
- All egress goes through a **TLS-intercepting logging proxy** (mitmproxy; its CA is baked into our own golden image), and everything not allowlisted lands in a **sinkhole**.
- So the report can say *"at 00:41 it read `~/.aws/credentials`; at 00:42 it POSTed those exact bytes to `hooks.example[.]io`, and here is the captured body."*
- That is evidence, not an LLM opinion. A deterministic rule engine assigns the verdict, and the model only writes the plain-English summary.

**Wow feature 2: you get to use it, safely.**
- If it's clean, the result isn't a refusal. It's a **working preview**: for an MCP server, a tiny web console listing its tools that you can call from your phone; for an app, its UI.
- It is served through a **per-task NetBird URL** (PIN-gated) that is revoked *before* the VM is destroyed. After teardown the URL 404s on stage.
- This answers FDA-04 (the "refusal montage" risk): the main path ends in something useful.

**Wow feature 3 (Q&A depth): rug-pull detection for MCP.**
- The harness calls `tools/list` again after every N `tools/call` and diffs tool descriptions. The Deadbugz pattern is changed descriptions that tell the agent to hunt keys.
- We also run the model **as an MCP client** over the server's tool descriptions and check whether it gets steered toward the honeytoken files. That catches tool-poisoning *prompt injection* dynamically, which the static scanners grep for.

**Audience moment (safe):**
- A judge types **any npm/PyPI MCP package name or public install-script URL** on the operator laptop. It gets its own throwaway VM with a sinkhole and no secrets. One at a time, with a 90 s cap.
- **The flattering version, pre-tested on Saturday:**
  - "Brandon, here's NetBird's own installer": its label shows it fetched only from `pkgs.netbird.io`, installed a systemd unit and read no secrets.
  - "Vultr team, here's your MCP server" [verify that an official Vultr MCP server exists and is public].
  - A clean label on the sponsor's own tools is a warm, relatable moment. **Pre-run both.** If either shows anything surprising, drop it and tell them privately.

**Containment moment (mandatory):**
- Our planted `weather-helper-mcp` lives **in our own GitHub repo and a Verdaccio/devpi registry on the sandbox host. It is never published to public npm/PyPI**, which would break their ToS.
- On its third tool call it:
  - reads the AWS and SSH honeytokens and the wallet;
  - POSTs them over TLS to an unlisted host;
  - tries `169.254.169.254`;
  - tries `rm -rf ~`;
  - spawns a miner-style CPU loop.
- The card sequence: `honeytoken read` → `exfil captured in sinkhole (body contains canary)` → **CONTAINED** → NetBird URL revoked → `DELETE /v2/instances/{id}` → `GET` returns 404 → the control plane's sentinel is unchanged.
- **Replay** shows each vector and the layer that stopped or observed it.

**Verifiable output: a signed "Behaviour Label"** (a nutrition label for code):
- installed / started / COULDN'T RUN;
- tools or endpoints exercised;
- files read outside the working directory, especially honeytoken paths;
- processes spawned and persistence (cron, systemd, shell rc);
- DNS names and hosts contacted, with bytes and the proxy verdict;
- tool-description drift.

Every line links to a raw log line (auditd/fanotify, proxy flow). The label also carries:
- the exact input (package + version + tarball sha256);
- the golden image snapshot ID;
- the VM instance ID with created/destroyed timestamps;
- cost.

**Independence:** the label includes a re-run command that boots the same public golden image and replays the same inputs. As in 24 FDA-08, say "signed = tamper-evident", not "proof".

**Vultr usage (the creative parts in bold):**
- **One throwaway VM per task** via `POST /v2/instances`: `vc2-1c-1gb` at $0.007/h, or VX1. Tagged `tbyt,task-<id>`, 0-inbound firewall group, `disable_public_ipv4` + VPC-only.
  - Its default route goes through the sandbox host's logging proxy/NAT, so **all egress is observable**.
  - **`user_data` holds no secrets**, because the VM can read its own metadata.
- **Golden-image snapshot** (`POST /v2/snapshots`) with honeytokens and the proxy CA preloaded. **Warm pool of 2** pre-booted VMs. Boot time is unmeasured (13), so measure it at K2.
- **Optional forensic snapshot:** snapshot the "infected" VM before destroying it, and put the snapshot ID on the label as a sealed evidence locker. Nobody else will do this. Cut it if a snapshot takes over 2 min.
- **Serverless Inference:**
  - `glm-5.3` drives install and exercise for non-MCP inputs, and writes the summary;
  - `glm-5.3-flash` (vision) screenshots the preview and checks that it looks like what the README claims;
  - `nemotron-3.5-content-safety` screens README and tool-description text for injection before the model reads it (20 §3 #1).
- **Object Storage presigned URLs** for raw logs and pcaps. The VM never holds storage keys.
- **Tag janitor** deletes `tbyt`-tagged instances past TTL.

**NetBird usage (all three tiers, used organically):**
- **Tier 1:** zero open ports on the app VM, which is reached through the reverse proxy.
- **Tier 2:** a judge password maps to a `viewer` role; operator SSO.
- **Tier 3:** a per-task preview through the **Services API** (`POST /api/reverse-proxies/services`), targeting the throwaway VM's VPC IP through a routing peer on the sandbox host.
  - **The throwaway VM never gets a NetBird identity or setup key**, so a hostile payload can't touch NetBird.
  - [verify that the reverse-proxy service can target a routed network resource; if it can't, run `netbird expose` on the sandbox host with a local port-forward to the VM.]
- **Lifecycle binding** per 14 §3: revoke the URL, then destroy the VM, then curl the URL and expect it to fail. The reconciler handles orchestrator crashes.
- Stage line for Brandon: *"The only way into a detonated VM is a NetBird URL that dies with it."*

**Business model:**
- **Free:** 5 labels/month for individuals.
- **Team ($/seat):** an MCP/package allowlist gate. Employees request a server, the label is attached, security approves.
- **Registry API (per label):** a behaviour-verified badge for MCP registries and package mirrors.
- **Vultr pull-through:** every label is a Vultr VM-minute plus inference tokens.

**Precedents:**
- Socket, $1B valuation (May 2026, 23);
- Snyk's acquisition of Invariant Labs (mcp-scan) in 2025 [R];
- ANY.RUN's paid interactive sandboxes.

**Competitors, and why we're different:**

| Competitor | What it does | Gap we fill |
|---|---|---|
| OpenSSF **Package Analysis** (Google; ongoing) [R] | Dynamically installs every npm/PyPI package in gVisor and records syscalls and network | **Closest prior art; name it on stage.** It installs but doesn't *use* the package, has no MCP exercise, no honeytoken bait and no on-demand UX or preview. Our claim is integration + agentic exercise, not a new mechanism |
| Socket / Snyk agent-scan / Invariant **mcp-scan**, **tirith v0.4.2** (Sep 2026), **repo-forensics** (2026) | **Static** (plus LLM) scanning of code and tool descriptions; tirith adds config-drift pinning | Static scanners miss runtime-fetched second stages and time-delayed rug-pulls. We show what **happened** |
| ANY.RUN, **JUCY Sandbox** (Cyber Defense Magazine, Sep 2026), VirusTotal, Hybrid Analysis | Interactive malware sandboxes, mostly Windows binaries and URLs, for SOC analysts | Not developer-shaped: no package/MCP semantics, no "use it" preview |
| Anthropic **sandbox-runtime** (`srt` v0.0.76, Sep 12 2026) | Sandboxes *your own agent* locally | A local boundary with no verdict or report; it runs on your laptop, which is exactly where WaterPlum lands |
| E2B / Daytona / Docker Sandboxes | Sandbox infrastructure | Infrastructure only; no behavioural verdict |

**3-minute demo:**
1. **0:00–0:20, hook.** "Hands up if you installed an MCP server or piped `curl` into `bash` this month." *(all hands)* "Five days ago six governments said a fake job interview, 'just clone and `npm install`', got 30,000 developer machines. We're the place you run it instead."
2. **0:20–1:00, paste and watch.**
   - Paste `weather-helper-mcp`. A Vultr instance ID appears (from the warm pool).
   - Install; `tools/list` shows 3 tools; the agent calls `get_forecast("SF")`.
   - A split view shows the file-access feed and the egress feed.
3. **1:00–1:30, containment.**
   - Honeytoken read, then exfil captured with the canary visible in the TLS body → **CONTAINED**.
   - URL revoked, VM `DELETE` → 404, host sentinel unchanged.
   - 10 s replay: 5 vectors, each with the layer that caught it.
4. **1:30–2:20, the useful path.**
   - Paste a real, clean MCP server (pre-chosen, cached) → green label.
   - The **NetBird preview URL goes on screen as a QR code**, only for the panel, PIN-gated. A judge calls a tool from their phone.
   - Then the "NetBird's own installer" label from earlier, re-run live if the clock allows.
5. **2:20–2:45, the label.** `verify-label` passes; flip one byte and it fails. Point to the re-run command.
6. **2:45–3:00, close.** Buyer (the MCP allowlist gate), $/label measured, "100% Vultr VMs + Serverless Inference + NetBird; built today."

**Build estimate (person-hours; we have 24.5 wall-clock hours, about 17 productive hours per person, per 15):**

| Component | h | Reuse from the RR design (docs only, no code yet) |
|---|---|---|
| Vultr VM lifecycle (create from snapshot, warm pool, destroy, janitor) | 5 | 13 §D, 20 §3 #2 |
| Golden image: honeytokens, proxy CA, auditd/fanotify telemetry agent | 5 | 12 §4 honeytoken table |
| Egress: logging mitmproxy + sinkhole + DNS log + allowlist phases | 6 | 12 §5.3 proxy design |
| MCP harness: stdio client, schema-driven args, description-drift diff | 4 | — (the MCP SDK does most of it) |
| Agent loop for non-MCP inputs (Vultr inference, capped) | 5 | 19 inference client |
| Deterministic rule engine → label; ed25519 sign + `verify-label` | 4 | 12 §6 receipts |
| NetBird tiers 1–3, per-task preview + reconciler | 6 | 14 |
| UI: paste box, live SSE feeds, label page, preview console | 7 | — |
| Fixtures (evil MCP, clean MCP, installers), deploy, rehearsal | 7 | — |
| **Total** | **≈49** | Solo: MCP-only, containers not VMs, no tier 3. 2 people: add VMs. 3–4 people: everything |

**What breaks live, and the fallback for each:**
- **VM boot over 60 s.** Use the warm pool. If there is no pool, fall back to gVisor containers on the sandbox host and say so; the challenge allows containers.
- **`npx` fetch latency.** Pre-cache in Verdaccio.
- **NetBird certificate stuck at `certificate_pending`.** Use a wildcard cert set up Saturday.
- **Inference latency.** The MCP path is **model-light**: the handshake and tool calls are deterministic, and the model only writes the summary. This is the same pivot logic as 24 FDA-06.
- **Sandbox-aware or time-delayed malware evades us.** State it as an honest limit.
- **Vultr AUP when running unknown code.** Sinkhole egress means no outbound attack traffic. [verify the AUP wording at kickoff]

**Scores (mine; discount about 1 point per 24 §2):**
- **T 8:** a VM per task, observable egress with TLS capture, honeytoken proof, MCP drift detection, all three NetBird tiers, signed label.
- **C 7:** dynamic package analysis is old (OpenSSF), but agentic *use* plus MCP rug-pull detection plus the live preview is a new combination.
- **D 7.5:** MCP inputs are near-deterministic and the model-light path exists, but VM boot is unmeasured.
- **F 7.5:** MCP governance is a live enterprise budget line.

**R1 = 0.4·8 + 0.25·7 + 0.2·7.5 + 0.15·7.5 = 7.58. R2 = 7.50.**

**Kill test (by Sat 15:00):**
- the planted evil MCP runs in a throwaway VM (or a gVisor container);
- its honeytoken exfil is captured in the sinkhole with the canary in the body;
- the VM is destroyed;
- a clean MCP produces a green label.

If any of these fail, fall back to the incumbent. Its sandbox, proxy and tripwire layer is the same work.

---

## 4. Pick B — **Does It Run?** (the judge's copilot)

**One-line pitch:** *"Paste a repo and its README. We run it on a throwaway Vultr VM, click through every feature it claims, and hand you a live link plus a claim-by-claim receipt, before you spend your 3 minutes on it."*

**Who, and why a judge relates:**
- **Every judge in the room does this job this weekend.** Porollo's Cerebral Valley and Vultr DevRel evaluate dozens of repos per event.
- Adjacent users with budgets:
  - hiring managers reviewing take-homes (CoderPad/HackerRank-type platforms);
  - VC technical due diligence;
  - grant reviewers (the GitHub SOSF / Alpha-Omega style funders in 23);
  - engineers deciding whether to adopt an OSS project.
- Stage line: *"The judges in this room will open 40 repos tonight. How many will start?"*

**Wow features:**
1. **Claim ledger.**
   - `glm-5.3` extracts testable claims from the README ("upload a CSV and see a chart", "`/api/health` returns ok").
   - The setup agent brings the repo up.
   - A Playwright agent with the `glm-5.3-flash` vision model tries each claim.
   - Each row reads RAN ✅ / FAILED ❌ / COULDN'T TEST ⚪ with a screenshot and a log line.
2. **The same live NetBird preview as Pick A.** The judge clicks the running app themselves, and it dies with the task.

**Audience moment:** a judge picks any repo from a pre-screened list of public, past Cerebral Valley / Vultr hackathon winners, **not this event's submissions**. Never grade rival teams on stage.

**Containment moment:** a "submission" whose `postinstall` reads the judge-machine honeytokens (`~/.config/gh/hosts.yml`, `~/.aws`) and does `rm -rf ~`. It is captured, and the VM is destroyed. The line: *"This is how a hackathon repo steals a judge's GitHub token."*

**Verifiable output:** a signed claim receipt with, for each claim, the screenshot hash, the command, the exit code, and the setup log up to the first failure. **COULDN'T RUN at step N** is an honest verdict. Given EnvBench and SetupBench it will be common, and judges will recognise it as their own experience.

**Vultr and NetBird:**
- Vultr: the same VM-per-task, snapshot, inference trio as Pick A, plus a vision model for claim checks.
- NetBird: the per-task preview is the core feature.

**Business model:**
- per-evaluation pricing for hackathon platforms (Devpost, CV, MLH) and take-home platforms;
- a seat-based plan for DD teams;
- a **defensible wedge**: the same engine as Pick A, so the two are one company ("Is it safe? Does it work?").

**Competitors:**
- Devpost has no execution.
- Take-home platforms run *their* sandboxes for candidates, not a reviewer's view of an arbitrary repo.
- Repo2Run / EnvBench agents are research, with no claim checking and no safety layer.
- GitHub Codespaces / Gitpod give you an environment, not a verdict.

**3-minute demo:**
- **0:00–0:20:** hook, the "40 repos tonight" line.
- **0:20–1:15:** paste a past winner's repo. Setup log, then preview URL, then 3 claims checked with screenshots.
- **1:15–1:45:** containment with the hostile "submission".
- **1:45–2:30:** the claim receipt; a judge opens the NetBird URL on their phone.
- **2:30–3:00:** business + Vultr stack.

**Build:** about 55 person-hours. It is Pick A's core minus the MCP harness, plus a claim extractor (3 h) and a Playwright claim agent (8 h).

**What breaks:**
- **Setup success on unseen repos** (§3.1): expect under 50% live. Pre-select repos that pass 3/3 in rehearsal.
- Browser-agent flakiness (03b C2).
- Multi-minute installs: pre-warmed wheel/npm caches.

**Scores:** T 7.5, C 7.5, D 6, F 6.5. **R1 7.05, R2 6.88.** The low demo score is the whole problem. As a *second label section* in Pick A ("…and does it do what it says?"), it adds the most relatable line in the pitch at little extra cost.

---

## 5. Against the incumbent (Repro Receipts, 25)

| | Repro Receipts | Try Before You Trust (Pick A) |
|---|---|---|
| Judge relatability | Low. Nobody on the panel triages bug bounties (23: maintainers don't pay) | **High.** Every judge installs MCP servers and install scripts; WaterPlum is 5 days old |
| Validated engineering | **22: 30/30 hashed installs, 8/10 issues deterministic.** Model spike K3a is pending | None yet. The MCP handshake is deterministic by design; VM boot is unmeasured |
| Containment moment | A hostile PoC in a bug report: a staged fixture | A hostile MCP server: the **product's own core path** with bait + sinkhole evidence |
| Useful-work beat | A repro verdict on a real issue (strong, but abstract to BD judges) | A **live app or tool preview a judge touches on their phone** |
| NetBird | Optional, cut first (25 §4 item 11) | **Organic:** the preview URL *is* tier 3 |
| Creativity risk | ClusterFuzz/syzbot prior art (C 6.5) | OpenSSF Package Analysis prior art (C 7) |
| Business | PSIRT/bounty triage; maintainers don't pay | MCP/package allowlist gate for enterprises; Socket-scale precedent |
| R1 / R2 | 7.48 / 7.38 (Fable) | 7.58 / 7.50 (mine, likely about 1 high) |

**Recommendation to the tournament:**
1. On points it's a **tie**. On the finals panel (equal weights, BD + investor), relatability should break it toward Pick A.
2. The switch is cheap *now*, because no code exists and the containment layer designed in 12 carries over: supervisor, egress proxy, honeytokens, janitor, receipts, and the 14 NetBird plan.
3. **What we'd lose is 22's validated repro pipeline.** Pick A's riskiest unknown (VM boot, TLS capture inside the VM) should get its own kill test at Sat 15:00, with the incumbent as the fallback.
4. **If the team keeps Repro Receipts**, steal two things from here:
   - swap the hook for the MCP / `curl | bash` hands-up question and WaterPlum;
   - in the hostile-fixture beat, have the PoC steal a **fake wallet + AWS key and show the captured exfil body in the sinkhole**. That is more visceral than "policy violation".

**Not verified (do before quoting on stage):**
- the exact wording and date of the WaterPlum joint advisory (read the primary advisory);
- SetupBench's overall percentage;
- OpenSSF Package Analysis's current scope;
- whether an official Vultr MCP server exists;
- whether NetBird reverse-proxy services can target a routed resource;
- the Vultr AUP on running unknown code;
- throwaway-VM boot time in `atl`.
