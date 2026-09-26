# 17 · Originality and Attribution Plan (F1 Repro-or-Reject)

Written 2026-09-26. This plan covers:
- rule **G-03**: "Demo must only show what was built during the hackathon; must clearly identify original contributions or be disqualified";
- rule **G-04**: "New work only";
- rule **G-05**: "Banned: … using unlicensed code/data/assets".

All three are rules from `01-rules-and-compliance.md` §2b. They carry "Guide" authority, and the original wording wasn't re-fetched. **Everything below is our plan (new design), not an organizer rule.** Nothing here is legal advice.

---

## 1. Pinned upstream baselines

| Upstream | Commit | Commit date | License | Copyright line | Audit |
|---|---|---|---|---|---|
| CopilotKit/openbot | `3c73cf00efba46122dfd0447485e2b61f1d6a2cd` (`main`, shallow) | 2026-09-23 15:18:02 -0300 | MIT (`LICENSE:1@3c73cf0`, `package.json:4`) | "Copyright (c) 2026 CopilotKit" (`LICENSE:3@3c73cf0`) | `07-openbot-audit.md` |
| CopilotKit/openmuse (clone origin `https://github.com/CopilotKit/openmuse.git`) | `205cc386b75aae1a862f3fdd43104b570c8d0911` | 2026-09-25 11:31:59 -0700 | MIT (`LICENSE:1@205cc38`) | "Copyright (c) 2026 OpenMuse contributors" (`LICENSE:3@205cc38`) | `08-openmuse-audit.md` |

The clones live under `research/reference-repos/`, which the root `.gitignore` excludes. They are reference material only: they are **not** vendored into the product repo, **not** git submodules, and **not** installed as dependencies. Any instruction files inside them (`.claude/`, `prompt.txt`, skill files) were treated as untrusted data (07 header, 08 header).

---

## 2. What we port: patterns, not code (unless marked)

**Default rule:** we re-implement from our own understanding, in our own code structure and names. The citations below are credits for ideas. Where we copy code verbatim, or nearly so, we mark it **COPY**. That triggers the MIT notice obligation in §3.

| # | Pattern (what the idea is) | Source (cite) | Mode | Where in our repo (planned) |
|---|---|---|---|---|
| P1 | Hash-bound action proposal. Expiry. `{id, hash}` decision. Idempotent re-decide | OpenMuse `apps/server/src/actions.ts:39-191@205cc38` | pattern | `control/approvals.*` |
| P2 | Atomic claim `UPDATE … WHERE status=… AND expires>now AND EXISTS(task …) RETURNING` | OpenMuse `apps/server/src/db.ts:78-90@205cc38` | pattern. The SQLite SQL is rewritten by us (12 §6.2). If a teammate pastes the original Postgres SQL, mark it **COPY** | `control/db.*` |
| P3 | Boot sweep `executing → outcome_unknown`. Never auto-retry an unknown outcome | OpenMuse `db.ts:91-95@205cc38`, `actions.ts:112,177-186@205cc38` | pattern | `control/approvals.*` |
| P4 | Lease + heartbeat (lease/3) + guard-before-effect + CAS checkpoint | OpenMuse `apps/server/src/engine/worker.ts:116-248@205cc38` | pattern | `control/worker.*` |
| P5 | Step receipt inserted `running` before exec, CAS-finalized; a stop marks it `interrupted` first | OpenMuse `apps/server/src/computer.ts:540-554,615-747@205cc38` | pattern | `control/steps.*` |
| P6 | Container hardening flag set + inspect-before-attach refusal | OpenMuse `computer.ts:225-294,465-508@205cc38`; OpenBot `supervisor/src/docker.ts:418-457@3c73cf0` | pattern. Our flag list (12 §3.3) differs: runsc is mandatory, no volumes, a tmpfs workspace, proxy-only network, `--restart no` | `supervisor/docker.*` |
| P7 | O_NOFOLLOW per-component reader confined to `/workspace` | OpenMuse `apps/computer/files.py:1-103@205cc38` | pattern (rewrite as `ror-readfile`). **COPY** if ported line by line | `sandbox-image/ror-readfile` |
| P8 | Public-IP classifier + DNS pinning before connect | OpenMuse `apps/worker/src/network.ts:8-96@205cc38` | pattern. The IP-range table is factual data, but we'll still credit it | `egress-proxy/` |
| P9 | Definite vs unknown failure classification for external writes | OpenMuse `packages/integrations/src/google.ts:551-607@205cc38` | pattern | `control/github.*` |
| P10 | Narrow supervisor with a few verbs, a token, ownership labels, server-derived names | OpenBot `supervisor/src/index.ts:19-134@3c73cf0`, `names.ts:67-90@3c73cf0` | pattern. Our verbs differ (create/exec/copy_out/destroy), and we use mTLS + a constant-time token | `supervisor/api.*` |
| P11 | Audit row before the act; failure row after; a failed audit insert blocks the act | OpenBot `server/src/computer/gateway.ts:532-620@3c73cf0`, `audit.ts:557-586@3c73cf0` | pattern | `control/events.*` |
| P12 | Fail-closed evaluation, deny before allow | OpenBot `server/src/computer/policy.ts:285-340@3c73cf0` | pattern. We don't use CEL; our policy is a static default-deny file | `control/policy.*` |
| P13 | Test *cases* for approvals and leases (single consumption, stale hash, expiry, idempotent replay, two workers claim once, cancel fences a stale worker) | OpenMuse `tests/actions.test.ts:35-287@205cc38`, `tests/engine.test.ts:30-99@205cc38` | test scenarios re-written against our API | `tests/approvals.*`, `tests/runs.*` |

**Explicitly not taken:**
- any UI code (CopilotKit React, Expo/RN-Web);
- CopilotKit runtime and Intelligence client;
- agent-computer, screencast, browser worker (F1 doesn't need a browser; for F2 see §6);
- auth (better-auth, OpenMuse sessions);
- MCP/Composio, voice, desktop, Helm charts, s6 image;
- all example data and assets (images, GIFs, capybara, fixtures).

**Also ours from scratch** (no upstream equivalent was found in either repo, per 07 §5 and 08 §5):
- the multi-sandbox verification protocol (B/C/D with HEAD, ALREADY_FIXED, static gate, locked no-network installs, verify-only replay) and verdict rules. *The code is ours; the idea of re-running a stored reproducer at the reported and fixed/latest refs is **not** (see §2.1);*
- the seal latch;
- honeytokens and tripwires;
- the signed ed25519 receipt;
- the sandbox supervisor's janitor-by-label;
- the Repro-or-Reject agent loop and prompts;
- the GitHub comment template and reconcile marker.

### 2.1 Prior art for ideas (credited, no code) *(rev. after 18, 18 §A1/§A5, DA-05/DA-12)*

These are not code sources, so they don't go in `THIRD_PARTY_NOTICES.md`. They go in the README "Prior art" section and in `ATTRIBUTION.md`, so judges can see we are not claiming the mechanism as new (G-03 "clearly identify original contributions").

| Prior art | What it already does | What we add | Source |
|---|---|---|---|
| **ClusterFuzz / OSS-Fuzz** (Google) | Re-runs fuzzer testcases against the latest build daily until fixed, then auto-verifies and closes the bug; bisects regression and fixed ranges | Input is an untrusted natural-language issue, not a fuzzer testcase; an LLM authors the reproducer; the report is treated as hostile code; approval-gated post; signed receipt | google.github.io/clusterfuzz (fixing-a-bug page), 18 §A5 |
| **syzbot** (syzkaller) | Stores kernel-bug reproducers; `#syz test` re-runs them on a given tree or patch, including checking "if the bug is already fixed"; cause/fix bisection | Same as above; our ALREADY_FIXED verdict is the syzbot "already fixed?" idea applied to Python issue reports | syzkaller `docs/syzbot.md`, 18 §A5 |
| **SWT-bench harnesses** | Fail-before/pass-after in fresh containers for benchmark evaluation | Productised for live, hostile, untrusted reports | EV-R-0019 |
| **withastro/triagebot-action** @ `51d30da` | LLM-driven issue reproduction and bug-vs-intended triage in GitHub Actions. **Correction:** it runs repro commands directly on the Actions runner (`local()` → `child_process.exec`, unrestricted network), **runner-level, not sandboxed**; the write token and model key are in the parent process on that runner, not in the agent shell's env; no fresh re-execution, no receipt, posts without approval | Secret-free, egress-limited sandbox on a separate VM; fresh re-execution; signed receipt; hash-bound human approval. We do **not** judge bug-vs-intended, which triagebot does | 18 §A1; `action.yml`, `src/handlers/triage.ts:395-409`, `src/flue.ts:17-21`, `dist/index.mjs:233440-233465` at `51d30da` |

**Claim wording in README, video and pitch:** "syzbot-style verification for human- or AI-written issue reports, with the report treated as hostile code." Never "first to re-run repros", never "proves the bug is real" (18 V2), and never "triagebot keeps keys in the sandbox" or "triagebot runs in isolation" (18 V1).

---

## 3. THIRD_PARTY_NOTICES plan

In the product repo root:

1. **`THIRD_PARTY_NOTICES.md`**, with these sections:
   - **"Code copied or adapted (MIT)."** For every **COPY** row: upstream, commit SHA, source path and lines, our file path, and the full MIT license text with the upstream copyright line. Use "Copyright (c) 2026 CopilotKit" for OpenBot and "Copyright (c) 2026 OpenMuse contributors" for OpenMuse. MIT requires the notice in "all copies or substantial portions". If no COPY rows exist at submission, the section says "none; patterns only (see ATTRIBUTION.md)".
   - **"Runtime and build dependencies."** An auto-generated list: `npx license-checker --production --summary` or `pip-licenses --format=markdown` output, committed at freeze time. Also list: gVisor (Apache-2.0), Docker Engine / Moby (Apache-2.0), Caddy (Apache-2.0), and NetBird if the bonus is used (check its current license at the event; it is not verified here). Use the SPDX IDs the tools report and hand-check anything reported as `UNKNOWN`.
   - **"Container images."** Base image name + digest (e.g. `python:3.12-slim@sha256:…`) and a note that Debian packages carry their own licenses.
   - **"Services used (not code)."** Vultr Cloud Compute, Vultr Serverless Inference (model ids used, with a note that model outputs are governed by Vultr's terms), GitHub REST API, and optionally Vultr Object Storage.
2. **`ATTRIBUTION.md`** (or a README section "Built at the event vs reused"). It holds the §2 pattern table, with the P-ids and upstream permalinks at the pinned SHAs: `https://github.com/CopilotKit/openbot/blob/3c73cf0…/path#Lstart-Lend` and the OpenMuse equivalent. The clone origins are `github.com/CopilotKit/openbot` and `github.com/CopilotKit/openmuse` (from `git remote -v`).
3. **Per-file headers.** Only COPY files get one: `// Adapted from CopilotKit/OpenMuse@205cc38 apps/computer/files.py (MIT). See THIRD_PARTY_NOTICES.md.` Pattern-inspired files get a one-line comment `// Pattern: see ATTRIBUTION.md P4`, which helps judges and costs nothing.
4. **Demo data.** The hostile fixture repo and hostile issue are **authored by us at the event** and live in a separate public repo, `ror-hostile-fixture`, with a README saying "intentionally malicious test fixture; runs only in sandboxes". The real public issues used in the demo are linked, not copied, and we don't post comments on third-party repos during the demo. Approved comments go only to **our own** demo repo, `ror-demo-target`, which carries seeded issues that we wrote.
5. **A pre-submit gate**, a CI job or a manual checklist:
   - `gitleaks detect` (G-01);
   - the license-checker output is committed;
   - `grep -rn "Adapted from"` matches the COPY rows in `THIRD_PARTY_NOTICES.md`;
   - no files from `reference-repos/` appear in the tree (`git ls-files | xargs sha256sum` compared against the upstream file hashes, as a cheap exact-copy check).

---

## 4. Demo feature map template (inherited vs newly built at the event)

Fill this in at the freeze (Sun 11:30 PDT). The same table goes in the README and in the video description. A visible feature may appear in the 60 s video only if its "Built at event" cell is **yes**, or if it's labeled on screen as infrastructure (G-03, G-07).

| Demo beat / visible feature | Built at event? | Inherited component (name@version/SHA) | Ported pattern ids (§2) | Evidence (commit range / file) | Shown in video at |
|---|---|---|---|---|---|
| Paste issue URL → run created, live event stream | yes | — | — | `<sha..sha>` `api/runs.*`, `web/run.*` | 0:00–0:08 |
| Plan + repro authoring in sandbox A (Vultr inference) | yes | Vultr Serverless Inference (service) | — | `worker/author.*` | |
| gVisor sandbox with limits, "destroyed at T" | yes (supervisor) | gVisor runsc (apt, version …), Docker Engine (version …) | P6, P10 | `supervisor/*` | |
| Frozen script → static gate → fresh no-network sandboxes B fails, C passes, D (HEAD) checked | yes (the re-execution *idea* is prior art: ClusterFuzz/syzbot, §2.1) | — | P4, P5 | `worker/verify.*` | |
| Verdict + signed receipt + re-run command | yes | libsodium/tweetnacl (version, license) | P11 | `control/receipts.*` | |
| Hostile issue PoC → tripwire → "CONTAINED: policy violation" | yes | — | P8 | `egress-proxy/*`, `ror-hostile-fixture` (issue #1 PoC) | (containment moment, C1-11) |
| Verify-only replay (no model, no GitHub) | yes | — | — | `api/runs/replay.*` | (live fallback) |
| Approval card → approve → comment posted | yes | GitHub REST (service) | P1, P2, P3, P9 | `control/approvals.*` | |
| Public HTTPS URL / zero-ports (bonus) | config | Caddy x.y / NetBird x.y | — | `deploy/*` | |

Column rules:
- **"Built at event"** is `yes`, `config` (we only configured an upstream tool) or `no` (shown but not ours; avoid).
- **"Evidence"** points to commits whose timestamps fall after the start (§5).

---

## 5. Commit history and provenance practices

1. **A fresh product repo, created after hacking starts** (Sat Sep 26 11:30 PDT = 18:30 UTC, per 01 §1). The first commit is an empty README with a timestamp ≥ 18:30Z. This research repo stays separate. Its notes may be *linked* from the product README as "pre-event research (not code)", which answers G-04 Q-08 conservatively.
2. **No force-push to `main`, and no history rewrite.** The commit timestamps are the evidence. Commit early and often, at least one commit per hour per active teammate.
3. **Commit message conventions:**
   - A trailer `Pattern: P4 (OpenMuse worker.ts@205cc38)` when a commit implements a ported pattern.
   - A trailer `Copied-From: <upstream>@<sha> <path>:<lines> (MIT)` for any COPY. The COPY list in `THIRD_PARTY_NOTICES.md` must equal `git log --grep Copied-From`.
   - Keep the co-author lines the team's tooling adds, including AI-assistant attribution trailers. Judges can see what was AI-assisted, and the code remains authored at the event.
4. **Signed tags at milestones:** `k1-inference-ok`, `k2-sandbox-ok`, `k3-repro-ok`, `demo-freeze`. The freeze tag's SHA goes in the submission description.
5. **The deployed build identifies itself.** `/healthz` returns `version: git:<sha>`, and every receipt embeds `control_plane.version`. That lets judges tie the live demo, the video and the repo to one commit.
6. **Upstream code must not leak in accidentally:**
   - `reference-repos/` is never inside the product repo.
   - Editors and agents working on the product repo are pointed at `research/12` and `research/09`, not at upstream sources, unless a COPY is intended and logged.
7. **Secrets scan before making the repo public.** Run `gitleaks detect --redact` on the full history (G-01). The judge credentials in the README are for the `judge` role only, which can't mutate anything (NB-05).

---

## 6. Separately licensed or hosted services to avoid

| Service / component | Why avoid | Evidence |
|---|---|---|
| **CopilotKit Intelligence** (managed `api.intelligence.copilotkit.ai`, `realtime.intelligence.copilotkit.ai`) | A closed, externally hosted service, not part of either MIT repo. **Both** upstream apps refuse to start without it. Self-hosting is an "Enterprise Intelligence Platform feature… not self-serve". Using it would move conversation data off Vultr (C1-03) and add a signup dependency on event day | OpenBot `server/src/config.ts:879-906@3c73cf0`, `.env.example:110-128@3c73cf0`; OpenMuse `apps/server/src/config.ts:55-56,108@205cc38`, `apps/server/src/app.ts:44@205cc38` |
| `COPILOTKIT_LICENSE_TOKEN` / CopilotKit premium features | Separate licensing; not needed | `.env.example:130-133@3c73cf0` |
| CopilotKit runtime telemetry | Opt-out is undocumented (07 Q5); we don't ship the runtime | `server/src/copilot.ts:2141-2145@3c73cf0` |
| Composio (`backend.composio.dev`) | A third-party SaaS backend with telemetry | `server/src/plugins/composio-adapter.ts:4714-4737@3c73cf0` |
| OpenAI / xAI / Google / Anthropic endpoints (voice, plan sign-in, model OAuth, adapter fallbacks) | Break C1-02 ("all agent LLM calls through Vultr") | `server/src/voice/provider.ts:120,216@3c73cf0`, `server/src/provider-oauth.ts:54-58@3c73cf0`, `agent-ag2/src/main.py:24@3c73cf0` |
| `@copilotkit/aimock` in the runtime path | A test tool. Fine in our tests if the license checks out; never in production | OpenMuse `apps/server/src/demo/entry.ts:39-43@205cc38` |
| Hosted sandboxes (E2B Cloud, Browserbase, Modal, Vercel, Daytona cloud) | Fail "sandboxes … on Vultr" (C1-04) | 01 §2a C1-04 |
| Third-party screencast code inside OpenBot `agent-computer/src/screencast.ts` | Carries its own Apache/BSD-derived provenance per 07 §6. Not needed for F1. If F2 ever copies it, carry its original notices too | 07 §6 row "agent-computer" |

If F2 (Evidence Clerk) is chosen, reusing the OpenMuse browser worker *as code* (`apps/worker/**`, MIT) becomes a **COPY** with full notice. Record its Playwright/Chromium dependency licenses in the notices file.
