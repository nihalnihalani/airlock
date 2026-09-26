# 03b: Customer-problem signals, researcher B (Challenge 1, "Blast Radius Zero")

Run date: 2026-09-26 (Asia/Kolkata). Scope: investigations 10, 11, 13–18, plus a light Challenge 2 pass. This is problem research only; no idea has been chosen. It extends `04-painpoints-blast-radius-zero.md`, which already covers egress, credentials, destructive actions and prompt injection. This file does not repeat those incidents.

Artifacts:
- `evidence-b.jsonl`: 46 observations (EV-B-0001…0046)
- `queries-b.jsonl`: 52 query records
- `sources-b.jsonl`: 56 sources
- raw fetches in `raw/problems-b/`

**Counts**
- By source type: 30 firsthand, 9 vendor claims, 2 secondhand, 5 unknown (Reddit and LinkedIn snippets).
- Independence: 38 independence groups in total, 22 of them firsthand.
- By window: 9 in last30days (2026-08-27..09-26), 27 in 2026-context, 2 historical, 8 undated.

**Method caveats (read first)**
- **Reddit:** thread fetches were blocked (403, and Firecrawl returned "we do not support this site"), and the last30days Reddit backend failed with HTTP 402. Reddit items are search snippets only, marked `low` confidence and undated.
- **LinkedIn:** unsupported by Firecrawl, so LinkedIn is snippet or last30days-grounding text only.
- **X:** not queried. Cookie auth is not authorized, so `--no-browser-cookies` was used.
- **What was read in full:** GitHub issues and PRs (via the API), Discourse forums (community.openai.com and forum.uipath.com, via `.json`), HN threads (via the Algolia items API), vendor docs and blogs.
- **Tool noise:** GitHub search is polluted by agent-swarm repos, and the HN Algolia relevance ranking was poor for long queries.
- **Vendor SEO:** "portal / AP / verification" queries return almost only vendor pages, which is itself a signal (see C8).

---

## Pain clusters

### C1. Authenticated, UI-only systems: hosted agents back off, and RPA can't log in unattended (strongest)

**Evidence**
- OpenAI removed ChatGPT Agent Mode (July–August 2026). Users say the replacement, Work, browses public pages only, and it stops operating a page once the user logs in manually: "I'm required to stop controlling it once it becomes authenticated" (EV-B-0001, 0002, 0003; 66-post thread; OpenAI support confirmed on 2026-08-12).
- Hermes users on hosted instances are "locked out of login-gated and aggressively anti-bot sites". Copying cookies is fragile, and datacenter IPs get blocked (EV-B-0014).
- An enterprise UiPath developer has business functions that are "only available through the application's UI". MFA is push-only, and policy forbids TOTP, email OTP and non-MFA bot accounts, leaving "no supported way for the robot to complete the login automatically" (EV-B-0029).
- Microsoft staff confirm that Copilot Studio licensing and usage reports can only be downloaded by hand from the admin portal. This was still true on 2026-09-12 (EV-B-0030).

**Counterevidence and existing solutions**
- Agents can do this if they drive the user's local Chrome through the desktop app (EV-B-0004). That trades isolation for access.
- Hermes merged a takeover and hand-back lease on 2026-09-23 (EV-B-0015), but only the desktop half; the hosted leg is not built.
- WebMCP lets sites expose tools directly to agents (EV-B-0045), but only helps where the site cooperates.

**Why this matters for Challenge 1:** the valuable portals are exactly the authenticated ones. Vendors are responding by restricting hosted agents or by moving execution onto the user's own machine. A sandbox that holds the session, gives the human a scoped login handoff, and keeps cookies out of the user's browser is aimed straight at this gap.

### C2. "Success" is self-reported and often wrong (most directly tied to verifiable output)

**Evidence**
- In browser-use, failed scroll, input, click and dropdown actions return `error=None`. The action queue keeps running, `max_failures` never trips, and the LLM is told the step succeeded (EV-B-0012, reported separately in #5361 and #5438).
- Actions get "technically dispatched but did not visibly advance the task" (EV-B-0011, 13 comments).
- Daytona's `create_snapshot()` reports success, and the snapshot then fails with ENOSPC (EV-B-0018).
- E2B sandboxes were silently deleted about 28 s into a 300 s timeout (EV-B-0020; closed as completed, so likely fixed).
- A Manus user and Manus support disagree about what the agent actually did. Support kept asking for screenshots or video even though the user had sent the task link (EV-B-0023).

**Counterevidence and existing solutions**
- Sentinel's own benchmark uses programmatic validators and has browser-use at 45/45 (EV-B-0008). Reliability can be high when the task is validated externally.

**Implication:** the verifier must be independent of the agent's own claim of success. It should check page state, files, hashes and counts.

### C3. Resume, state loss and duplicate work

**Evidence**
- There is no idempotency key for sandbox creation, so a retry can create a second sandbox and skipping the retry can strand work (EV-B-0019).
- stdout stalls after auto-resume, a regression in the E2B SDK (EV-B-0021).
- Manus says "resetting will inevitably result in file loss" and resets sandboxes after 7 days of inactivity (free) or 21 days (paid) (EV-B-0022).
- A crash in the desktop app's GPU process kills "every running Claude Code session … mid-flight" (EV-B-0028).
- Snapshots are reported as successful but are not (EV-B-0018).
- The human-takeover input path itself corrupts text: "abcd1234ef" becomes "bbccdd11223344eeff" in 3 of 3 runs (EV-B-0013).

**Counterevidence:** E2B #1381 was closed as completed, and the Hermes lease model exists (EV-B-0015).

**Recency:** 0013, 0015 and 0018 fall in the last 30 days.

### C4. Deterministic scripts beat agents on repeated jobs, and vendors are converging on "explore once, compile to script"

**Evidence**
- A healthcare back-office team (EMR, practice management and payment portals) hit latency, cost, drift and debuggability problems and switched to scripts (EV-B-0006, historical, December 2025).
- "I prefer the brittleness of scripts…" (EV-B-0007).
- A consultant reports flaky multi-step runs and token budgets blown with browser-use and Stagehand (EV-B-0008).
- Browserbase describes an "amnesia problem" and turns agent runs into SKILL.md plus deterministic glue (EV-B-0010).
- Browser Use: "a game of edge cases", now model-written CDP code (EV-B-0009, last30days).
- A user's cost per task rose to about 5% of a weekly quota (EV-B-0005).

**Counterevidence:** browser-use scored 45/45 on a small benchmark (EV-B-0008), and vendors argue agents adapt when a site's UI changes.

**Implication:** agent-writes-code-then-code-runs needs a sandbox for real reasons (untrusted generated code plus a real browser). The "compile to a skill" idea itself is already owned by Browserbase and BrowserBook.

### C5. Audit and handoff evidence is still screenshots, with provenance gaps

**Evidence**
- An engineer with a decade of Drata, Vanta and Oneleet experience: "a huge pain grabbing screenshots for what feels like a very performative process" (EV-B-0031, 2026-08-04).
- A CPA auditor says buyers "can't tell whether one auditor inspected evidence and the other just collected screenshots". He published a machine-readable method under CC BY 4.0 (86 controls, 355 test attributes, 498 calibration examples) (EV-B-0032).
- Engineers report that screenshots of consoles, command output and Splunk searches are standard evidence (EV-B-0033, 0034).
- An undated MFA screenshot is graded PARTIAL because it lacks tenant, capture time, scope, exceptions and reviewer (EV-B-0035, last30days).
- Reddit snippets: "reused screenshots, missing timestamps" are common findings (EV-B-0037, 0038, low confidence).

**Counterevidence and existing solutions:** GRC platforms automate evidence for controls they can reach by API (EV-B-0036, Scrut case study; Vanta and Drata generally).

**What remains:** UI-only controls, third-party consoles, and proof of who, when and which tenant.

### C6. Self-hosting agent runtimes: security-review blockers and maintenance burden

**Evidence**
- OpenHands requires mounting `docker.sock`, "effectively root access to the host". Three issues have been closed as not planned (EV-B-0024).
- Local agent apps leak tool processes: 133 orphaned MCP processes using about 9.3 GB RSS (EV-B-0026), and more than 100 zombie processes from Codex computer use (EV-B-0027).
- Hosted lock-in: Manus's data-deletion window on 23–25 August 2026 left deployed sites offline until owners restored them by hand (EV-B-0046, secondhand).

**Counterevidence:** OpenHands Enterprise says it never mounts the host socket (EV-B-0025), and OpenAI now sells hosted sandboxes (EV-B-0044).

### C7. Temporary access to outputs and preview URLs (thin)

**Evidence**
- A single-use Vercel share link expired silently and broke E2E runs. The first fix leaked the bypass secret to Supabase and Cloudinary because Playwright headers apply to the whole browser context (EV-B-0016, merged 2026-09-26).
- A claimed Daytona preview-proxy auth bypass via the port string "02280" reaches the unauthenticated toolbox (EV-B-0017; unverified and still open).

**Assessment:** two sources only, both developer infrastructure. Treat this as a supporting feature, not a problem to build around.

### C8. No-API finance-ops portals: real, but vendor-saturated, with weak firsthand evidence

**Evidence**
- Search results for "collect last month's invoices from vendor portals with no API" include templates from at least six vendors (EV-B-0043).
- Dental payer-portal eligibility checks are crowded with vendors, and EDI covers part of the need (EV-B-0042).
- GSTR-2B reconciliation is mostly solved: Tally has it built in and free tools exist. Only the portal JSON download stays manual (EV-B-0041).
- Reddit snippets: each vendor portal has its own login and format (EV-B-0039); manual invoice download takes 1–2 days (EV-B-0040, historical).

**Limitations:** firsthand AP-clerk voices were not reachable (Reddit and LinkedIn were blocked). Treat demand here as plausible, not proven.

---

## Recency split

| Window | IDs | Note |
|---|---|---|
| last30days (9) | 0009, 0013, 0015, 0016, 0018, 0030, 0035, 0036, 0044 | Mostly C2/C3 infra bugs and the C1 takeover and no-API items. Plus the vendor landscape (hosted sandboxes, compile-to-script). |
| 2026-context (27) | the rest with dates | The C1 Agent Mode removal (July–August) and the C5 HN SOC2 threads (Feb–Aug). |
| historical (2) | 0006, 0007 | BrowserBook, December 2025 |
| unknown (8) | Reddit/vendor snippets | low weight |

## What existing tools already solve (don't rebuild)

| Area | Covered by | Remaining gap |
|---|---|---|
| Hosted sandboxes, secret vaults, egress allowlists | OpenAI Agents API (0044), E2B, Daytona, Vercel Sandbox | Their own bugs (C2, C3) |
| Compile agent runs into reusable scripts | Browserbase Autobrowse (0010), BrowserBook (0006) | none noted |
| API-reachable compliance evidence | Vanta, Drata, Scrut (0036) | UI-only controls |
| Monthly invoice pulls from vendor portals | at least six vendors (0043) | none noted |
| Dental eligibility | Overjet, Foji, Zentist (0042) | none noted |
| GST reconciliation logic | Tally (0041) | Portal download step |
| Human takeover | Hermes desktop (0015), browser-use live view (buggy, 0013) | Hosted and verified handoff |

## Sampling-bias notes
- GitHub issues over-represent developer and infrastructure pain, and reporters are often contributors filing code-level bugs rather than end users.
- The OpenAI forum skews toward paying power users. One author (kadda) appears in both threads, so EV-B-0001 to 0005 are one independence group.
- Vendor SEO dominates the operational (AP, insurance, freight) queries, so business-user voice is under-sampled.
- Several items come from authors with incentives: the BrowserBook, Sentinel and Chiaro founders, and a Manus critic.

## Coverage shortfalls
- **#11:** no firsthand voices from government or benefits portals. That query hit a 429 and was not retried.
- **#17:** firsthand "went back to manual" stories from non-developers are thin.
- **#16:** no Devin, Modal or Operator-specific complaints were gathered, and Claude computer-use evidence is limited to one desktop crash.
- **#15:** only two sources.
- **Challenge 2 pass:** light. The finance, procurement and support examples map onto C8 and C1 but add no new firsthand evidence.

---

## Candidate "smallest valuable automated jobs"

These are problems, not a chosen idea. Each one produces output that can be checked independently of the agent.

1. **Provenance-stamped evidence capture for a UI-only control** (C5, C2)
   - **Job:** given a control statement (for example "branch protection on repo X", "MFA required in admin console"), the agent logs into the target in a sandboxed browser. It returns a packet: screenshot, DOM/JSON state extract, URL, tenant identifier, UTC timestamp, SHA-256 hashes, and a controller-signed manifest. It is graded against the attribute's pass criteria.
   - **Why a sandbox is necessary:** the agent holds an authenticated session and renders untrusted pages. Provenance has to come from the controller, not from the agent's say-so.
   - **Demo inputs:** a self-hosted Gitea, GitLab CE or Keycloak seeded inside the sandbox, plus the Chiaro CC BY 4.0 criteria (EV-B-0032). No customer secrets.
   - **Risk:** GRC tools already cover API-based controls, so the pitch must be UI-only controls.

2. **Verified login handoff and resume** (C1, C3)
   - **Job:** the agent reaches MFA or CAPTCHA, pauses, and issues a one-time scoped live-view link. The human completes the step, a lease is handed back, and the agent continues in the same session.
   - **Verifier:** checks the typed-input echo (EV-B-0013), the session continuity, and an audit log recording who held control and when.
   - **Why a sandbox is necessary:** the cookies stay in a disposable VM, not in the user's Chrome (EV-B-0004).
   - **Demo inputs:** a local app with TOTP or simulated push MFA. Obtainable without secrets.

3. **Idempotent, crash-safe multi-step form submission** (C3, C2)
   - **Job:** submit N records to a web form or portal. Kill the sandbox mid-run, resume, and prove that every record was submitted exactly once.
   - **Verifier:** the server-side submission ledger must equal the input list, with no duplicates (EV-B-0019, 0022, 0028).
   - **Why a sandbox is necessary:** killing or restoring the sandbox is the demo, and it is also the containment moment.
   - **Demo inputs:** a mock portal that counts submissions. Trivially obtainable.

4. **Postcondition-checked document pull from a no-API portal** (C8, C1, C2)
   - **Job:** download last month's statements or invoices. Verify that each file exists, that the PDF parses, that totals match the portal's listing page, and flag gaps.
   - **Why a sandbox is necessary:** it handles untrusted downloads and portal JavaScript.
   - **Demo inputs:** an open-source invoicing app (for example Invoice Ninja or Crater) seeded with fake vendors.
   - **Risk:** heavily crowded market (EV-B-0043). The only differentiator is independent verification.

5. **Explore-once, replay-verified script** (C4)
   - **Job:** the agent explores a flow in sandbox A and emits a Playwright script. The script is replayed in a clean sandbox B and accepted only if assertions pass. The output is the script plus the replay proof.
   - **Why a sandbox is necessary:** it runs model-generated code.
   - **Demo inputs:** any public demo site or a local app.
   - **Risk:** Browserbase and BrowserBook already own the compile step. The replay-proof angle is thinner but still checkable.

6. **Action-effect assertions for browser steps** (C2): a narrower, component-level version of #3 and #4.
   - **Job:** each step declares its expected change (URL, DOM node, file, or network response). The controller checks it and fails loudly on a no-op, directly addressing browser-use #5137 and #5361.
   - **Demo inputs:** any local app.
   - **Caveat:** it may be too infrastructure-heavy to count as a "product" for judges.

7. **Expiring, infrastructure-free result sharing** (C7, C6): add-on only.
   - **Job:** outputs are copied out of the sandbox and served through a signed, expiring URL from the control plane. No sandbox ports are ever exposed (EV-B-0016, 0017).
   - **Assessment:** thin evidence, so bundle it with #1 to #4.

**Not recommended** as standalone jobs:
- Real payer, insurance or government portals and Microsoft admin-report pulls (EV-B-0030). They need real accounts or PHI, so there are no demo inputs without secrets.
- GST reconciliation. The logic is commoditized.
