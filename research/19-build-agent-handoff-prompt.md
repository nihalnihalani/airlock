> **Historical plan — superseded for product choice and build scope.** Read [35-AIRLOCK-MAIN-CHALLENGE.md](35-AIRLOCK-MAIN-CHALLENGE.md) for the current main-challenge project and [34](34-main-challenge-evidence-and-decision.md) for the evidence and corrections. Do not execute this older plan as the current brief.

# 19 · Build-Agent Handoff Prompt: Repro Receipts

> **Superseded in part (Sat 07:00 PDT):** read [25-WIN-PLAN.md](25-WIN-PLAN.md) first. After the Fable 5.1 review (24), the demo, pivot rule (now PoC-only mode) and cut list there override this file.


Written 2026-09-26 ~18:30 IST. Paste everything below the line into a fresh build agent at **Sat Sep 26 11:30 PDT or later** (hacking start; G-04 "new work only"). Everything it describes is **new design**. The research files it points to are in `research/` of the pre-event research repo, which stays separate from the product repo. **(rev. after 18)** This prompt was updated to apply the accepted devil's-advocate findings (18): K3a/K3b split and pivot target, HEAD run + ALREADY_FIXED, locked no-network verification installs, AST static gate, hardened locality, verify-only replay, hostile issue PoC, two-step re-run command, public label, two-VM gate, judge role, cancel ≤5 s, streaming exec.

---

## PROMPT

You are the build agent for **Repro Receipts**, a Vultr Agent Arena (Challenge 1 "Blast Radius Zero") hackathon project. Hacking ends **Sun Sep 27 12:00 PDT**. Our internal freeze is 11:30 PDT, and feature freeze is **Sun 07:00 PDT**. You work in a **fresh product repo** created after Sat 11:30 PDT. You never work inside `research/` or `research/reference-repos/`.

### What we are building (one paragraph)

A web app on Vultr that takes a public GitHub issue URL for a pure-Python library and returns a **verdict with a signed receipt**:
- The verdict is one of REPRODUCED / **ALREADY_FIXED** / NOT_REPRODUCED / INCONCLUSIVE / HOSTILE / ERROR.
- An agent on **Vultr Serverless Inference** writes a minimal repro inside a disposable, secret-free, egress-limited **gVisor** sandbox (A) on a **separate sandbox-host VM**. If the issue has a code block (a PoC), attempt 1 runs it verbatim.
- The script is frozen by hash and checked by an **AST static gate**. A separate prep sandbox (P) builds a **hash-locked wheelhouse** per ref. The script is re-run in **fresh sandboxes with no network from creation**, installing only from that lock: B at the reported SHA (run twice), C at the fix SHA if known (must pass), and **D at HEAD, always**.
- A **pure function** computes the verdict. The model never judges. A receipt proves "this frozen script fails at X and passes at Y in fresh, secret-free, no-network sandboxes", never that the bug is real.
- Hostile inputs trip planted honeytokens, canary hosts or network drops. They are killed and labelled HOSTILE internally and **"CONTAINED: policy violation"** on every public surface.
- A **verify-only replay mode** re-runs a stored frozen tuple in fresh sandboxes with no model and no GitHub; it is the live-demo fallback.
- The only outward action is a templated GitHub comment on **our own demo repo**, posted only after a human approves those exact bytes (hash-bound, 30 min expiry, atomic claim, `outcome_unknown` never retried).

### Authoritative references (read these; don't re-derive them)

| Need | File |
|---|---|
| Decision, scope, pivot rules | `research/00-executive-decision.md` |
| **Interfaces, verdict rules, receipt format, approval binding, container flags, threat table, test IDs: AUTHORITATIVE** | `research/12-architecture-and-threat-model.md` |
| PRD, UX states, ADR (stack), pivot rule (ADR-02), **Conflicts CF-01…CF-15, all resolved in 12** | `research/11-recommended-project-prd.md` |
| Devil's-advocate findings DA-01…DA-18 and conditions C1–C6 (all accepted; statuses point to where each is resolved) | `research/18-devils-advocate-review.md` |
| Task IDs, order, file map, cut line and **team-size cut lists (§2.6)**, acceptance tests T-01…T-35, eval set | `research/15-build-plan-and-acceptance-tests.md` |
| Demo script and reset (what the UI must support on stage) | `research/16-demo-and-submission.md` |
| Vultr inference caveats (`-normalize`, no `response_format`, 401 vs 422, pricing), plans, gVisor apt install, metadata | `research/13-vultr-inference-and-deployment.md` |
| Inference probe (K1) | `research/raw/vultr/probe_inference.sh` |
| Pattern ledger with pinned upstream line refs | `research/09-reuse-and-integration-matrix.md` §2.3, `research/17-originality-and-attribution.md` §2 |
| NetBird (optional, never blocking) | `research/14-netbird-bonus-plan.md` |
| Rules (C1-xx, G-xx, NB-xx) | `research/01-rules-and-compliance.md` §2 |
| Curated issues | `research/03c-repro-idea-validation.md` §3 |

If 11 or 15 appears to contradict 12, follow **12**. The conflicts listed in 11 §9 are all resolved **in 12** (rev. after 18); note which ones you implemented in `docs/decisions.md`. Report any new conflict to the human; don't resolve it silently.

### Upstream pattern sources (read-only; patterns, not code)

- **OpenMuse** `CopilotKit/openmuse@205cc386b75aae1a862f3fdd43104b570c8d0911` (MIT, "Copyright (c) 2026 OpenMuse contributors"):
  - approvals: `apps/server/src/actions.ts:39-191`
  - atomic claim and boot sweep: `apps/server/src/db.ts:78-95`
  - lease, heartbeat and guard: `apps/server/src/engine/worker.ts:116-248`
  - step receipt before exec, `interrupted` on stop: `apps/server/src/computer.ts:540-554,615-747`
  - container flags and inspect-before-attach: `apps/server/src/computer.ts:225-294,465-508`
  - O_NOFOLLOW reader: `apps/computer/files.py:1-103`
  - public-IP classifier and DNS pin: `apps/worker/src/network.ts:8-96`
  - definite vs unknown write failures: `packages/integrations/src/google.ts:551-607`
  - test *cases* to port: `tests/actions.test.ts:35-287`, `tests/engine.test.ts:30-99`

  Context: `research/08-openmuse-audit.md` §7 (patterns) and §8 (risks we must not copy, e.g. Docker CLI in the API process and write execution inside the HTTP handler).
- **OpenBot** `CopilotKit/openbot@3c73cf00efba46122dfd0447485e2b61f1d6a2cd` (MIT, "Copyright (c) 2026 CopilotKit"):
  - supervisor verbs: `supervisor/src/index.ts:19-134`
  - server-derived names: `names.ts:67-90`
  - hostConfig hardening: `supervisor/src/docker.ts:418-457`. Make runsc mandatory, and **don't** copy `unless-stopped` or the named volumes.
  - audit before act: `server/src/computer/gateway.ts:532-620`
  - deny-before-allow: `server/src/computer/policy.ts:285-340`

  Context: `research/07-openbot-audit.md` §6.

**Default: re-implement in our own structure.** If you copy code verbatim or nearly so:
- add the header `// Adapted from <upstream>@<sha> <path> (MIT). See THIRD_PARTY_NOTICES.md`;
- add a commit trailer `Copied-From: <upstream>@<sha> <path>:<lines> (MIT)`;
- add the row to `THIRD_PARTY_NOTICES.md`.

Pattern-inspired files get `// Pattern: see ATTRIBUTION.md P<n>`. **Never** import, vendor or submodule either upstream repo, and never use CopilotKit runtime or Intelligence.

### Stack (11 ADR-01; pin exact versions in lockfiles at kickoff)

**Control plane:**
- Node.js 24 LTS, TypeScript strict, pnpm workspaces.
- **Hono 4** + `@hono/node-server`, with SSE via `streamSSE`.
- **SQLite (WAL) via better-sqlite3**, hand-written SQL migrations, no ORM.
- **React 19 + Vite**, react-router, plain CSS, native `EventSource`.
- **`openai` npm SDK** with `baseURL` hard-pinned to `https://api.vultrinference.com/v1`, `chat.completions` only, forced tool calls as structured output, `-normalize` model suffix; `zod` validates tool args.
- Node `crypto` ed25519 + an RFC 8785 JCS canonicaliser in `packages/core`.
- `re2-wasm` for signature regexes.
- `@node-rs/argon2`.
- vitest.

**Sandbox host:**
- **Go** (current stable): a `ror-supervisor` static binary using the official Docker Engine Go client over the Unix socket (never a CLI shell-out), and a `ror-egress-proxy` static binary (CONNECT-only).
- Docker Engine from Docker's apt repo, and **gVisor `runsc` from the gVisor apt repo** (not the legacy binary installer).
- Ubuntu 24.04.

**Ingress:** Caddy 2 on the control-plane VM. Services run as systemd units, with secrets supplied through `LoadCredential=`.

**If nobody can review Go**, fall back to a Node supervisor (dockerode) and a Node proxy with **identical interfaces**, and record that in `docs/decisions.md`.

### Repository layout to create (15 §2)

```
apps/api/src/{server.ts,config.ts,auth/,db/,events/,runs/,intake/,agent/,verifier/,sandbox-client/,
              approvals/,receipts/,artifacts/,reconciler/,cli/{spike.ts,eval.ts}}
apps/web/src/{pages/,components/}
packages/core/src/{verdict.ts,jcs.ts,receipt-schema.ts,events.ts,policy.ts}
supervisor/        (Go) cmd/ror-supervisor, internal/{api,spec,docker,inspect,honeytoken,janitor,tripwire,mtls}
egress-proxy/      (Go) cmd/ror-egress-proxy, internal/{allow,ipclass,sni,seal,tripwire,log}
sandbox-images/python-runner/{Dockerfile,opt-ror/{ror-run,ror-readfile,ror-writefile,ror-fetch,ror-prep,ror_gate.py,ror_locality.py,ror_pytest_plugin.py,conftest_guard.py}}
spikes/k3a/        (throwaway K3a model-only spike; not imported by product code)
deploy/{caddy/Caddyfile,systemd/*.service,nftables/ror.nft,docker/daemon.json,cloud-init/*.yaml,policy/policy.json,sandbox-host/install.sh}
fixtures/{hostile/ (issue PoC + supply-chain setup.py branch),demo-target/ (issue #1 fix on branch fix/1; issue #2 no fix),flaky/,forged-pass/,slow/,lying-script/,stdlib-raise/}
eval/curated-issues.json
scripts/{verify-receipt.mjs,gen-mtls.sh,deploy.sh,preflight.sh,demo-reset.sh,run-eval.ts,secret-scan.sh}
tests/live/*.sh
README.md  ATTRIBUTION.md  THIRD_PARTY_NOTICES.md  docs/{decisions.md,k1-results.md,k2-results.md}
```

### Task order (IDs from 15 §2; don't start UI before B-10 passes)

0. **Decide the team-size cut list (15 §2.6) with the human at kickoff**, before any task starts.
1. **B-02** Vultr resources (**STOP-AND-ASK**; the inference key and one VM are enough to start) → **B-00 K3a model-only spike (hours 0–2.5)**: model writes repros for E01–E06, run with plain `docker run --network none` against pre-installed checkouts; no supervisor, proxy or UI.
   - **K3a gate (decides the pivot), by Sat 14:00 PDT:** ≥3 of 6 fail at the before-ref and pass at the after-ref → continue. Otherwise **stop and ask**: the recommended pivot is **Exactly-Once Submitter** (11 ADR-02, 00 §9). Claim Court is only a secondary option.
   - In parallel (another person, or after K3a if solo): **B-01** repo bootstrap → **B-03 K1** probe → **B-04** sandbox host (docker + runsc from apt + `ror-sbx` with ICC off + nftables + `br_netfilter`) → **B-05** sandbox image → **B-06** egress proxy as a **host process on `10.89.0.1:3128`** → **B-07 K2** checklist (incl. ICC isolation, loopback after seal, `SETUPTOOLS_SCM_PRETEND_VERSION` builds for all 10 repos) → **B-09** mTLS → **B-08** supervisor (async exec with offsets, `export_bundle`, docker-kill destroy) → **B-10 headless spike CLI = K3b**.
   - **K3b (by ~Sat 17:30 PDT):** ≥3 of E01–E06 reach REPRODUCED or ALREADY_FIXED (high) through the real stack. A miss means **cut scope** (15 §2.5), not pivot.
2. **C-01** DB → **C-03** runs + worker (lease/guard/CAS/recovery) → **C-05** agent (PoC-first step) → **C-06** verifier + pure verdict (`ror.verdict.v2`, B/C/D, ALREADY_FIXED) → **C-06a** static gate → **C-06c** prep/lock/wheelhouse → **C-06d** hardened locality → **C-07** events/SSE → **C-06b** streaming exec → **C-08** receipts + `verify-receipt` → **C-18 verify-only replay** → **C-14** fixtures (**STOP-AND-ASK** before creating public repos) → **C-16** deploy.
3. **C-02** auth (judge = curated/hostile/replay starts only) → **C-09** artifacts → **C-10** web UI (11 §7 states) → **C-12** cancel (docker-kill, ≤5 s) → **C-13** reconciler → **C-11** approvals (post only to `ror-demo-target`) → **C-19** two-step rerun command + published Dockerfile/digest → **C-15** eval → **C-17** acceptance suite.
4. Polish **D-01..D-03** before Sun 07:00 PDT feature freeze. After the freeze, bug fixes only, and each fix re-runs T-01, T-02 and T-28. T-29 (clean-laptop re-run) runs Sun 07:00–07:30. **The video is recorded Sun 08:00–09:00 PDT** (a hard slot; record a replay if the live path misbehaves).
5. Optional work (NetBird N-01..N-03, O-01..O-04) happens **only** after core is complete, and **never** blocks core.

Commit at least hourly. Never force-push `main`. Tag `k3a-model-ok`, `k1-inference-ok`, `k2-sandbox-ok`, `k3b-repro-ok`, `demo-freeze-rc1` and `demo-freeze`. `/healthz` returns `version: git:<sha>`.

### Hard boundaries (violating one is a defect, whatever the deadline)

1. **The sandbox never gets a secret.**
   - No env var, file, image layer, label or `user_data` on the sandbox host may contain the inference key, GitHub token, receipt key, session key or supervisor credentials.
   - The only "secrets" in a sandbox are per-sandbox **honeytokens**, created by the supervisor.
   - The sandbox-host VM's `user_data` is empty.
2. **The control plane never has the Docker socket or the Docker CLI**, and never executes untrusted or model-generated code (`exec`, `eval`, `child_process` on model output). Its only route to sandboxes is the supervisor API over the VPC with mTLS + bearer.
3. **Vultr-only LLM calls, everywhere.**
   - No OpenAI, Anthropic, OpenRouter, Google or other model endpoint, in any runtime path, helper, guard, summariser, test fixture that runs in prod, or "temporary" fallback.
   - Startup refuses any base URL other than `https://api.vultrinference.com/v1`.
   - A failed inference call fails the run visibly (`INFERENCE_AUTH` / `INFERENCE_UNAVAILABLE`); it never falls back.
   - (Coding assistants used to *write* code are not runtime calls.)
4. **Never post, label, comment, open a PR or push to any third-party repo.**
   - Third-party issues are read unauthenticated.
   - The executor has a hard allowlist containing only `ror-demo-target`, and the comment always includes the `<!-- ror:approval=<id> -->` marker.
5. **No blind retry of uncertain writes.**
   - A network error, 5xx, 408, timeout or unparseable response on the GitHub write → `outcome_unknown`, which is terminal. Recover only through the read-only marker reconcile.
   - `executing` → `outcome_unknown` on boot.
6. **The model never decides the verdict or an approval.**
   - Its tools are only `write_file`, `exec` (inside sandbox A) and `emit_repro`, plus the planner's `emit_plan`.
   - There is no GitHub, network or approval tool. Approval state changes only through `POST /api/approvals/:id` with an operator session, CSRF and a matching `payload_sha256`.
7. **runsc is mandatory.** Container flags come only from the supervisor (12 §3.3), and inspect-after-create refuses any drift.
8. **Untrusted text is data.** Wrap the issue in `<untrusted_issue>`. Pass sandbox output to the model as capped, labelled data. Render it as text in the UI, never as HTML/markdown. Serve artifacts as `attachment` + `text/plain` + `nosniff` + `CSP: sandbox`.
9. **Budgets are always on:** ≤5 attempts, ≤12 LLM calls, $0.25/run at worst-case price, $5/day global, `max_completion_tokens` and `reasoning_effort` on every call, and at most 2 concurrent runs.
10. **Cleanup always happens:** destroy after every run, `RestartPolicy no`, a TTL label + supervisor janitor that works without the control plane, and a control-plane reconciler. Cancel docker-kills every live sandbox of the run (target ≤5 s).
11. **Verification sandboxes (B, C, D, B′) never have network.** They are created with `egress_profile:"none"` and install only `--require-hashes --no-deps --no-index` from the prep bundle. Only A and P ever talk to the proxy. Loopback inside a sandbox is always allowed.
12. **The frozen script passes the AST static gate** (12 §5.2) as the first exec in each verification sandbox, or it is not run and the verdict is INCONCLUSIVE.
13. **Public wording.** HOSTILE is an internal code; every public surface (receipt viewer, comment template, video, README) says **"CONTAINED: policy violation"**. No text anywhere claims a receipt "proves the bug is real"; the claim is "this frozen script fails at X and passes at Y in fresh, secret-free, no-network sandboxes". Cite Pallets only as "13 issues + 75 PRs", and triagebot only with the stage-safe sentence in 00 §3.
14. **Two separate VMs** (control plane and sandbox host) are a hard gate. Collapsing them requires the human's decision and removes the "never shares a machine with a secret" claim.
15. **Judges** can start only curated entries, the hostile fixture and verify-only replays of curated tuples, and can never propose or approve an outward post.

### Prohibited shortcuts

- Running sandboxes with plain `runc`, `--privileged`, `--network host`, bind mounts or the Docker socket mounted "just for now".
- Putting keys in `.env` files on the sandbox host, in cloud-init, or in image build args.
- Letting the sandbox download the repo through the host (the host must never extract attacker tarballs), or letting `copy_out` return directories or archives.
- Letting the model's text (a "PASSED" line, or "approved") influence the verdict or approvals. Computing the verdict from anything other than exit codes, junit XML, the read-only `/opt/ror` traceback dump, and the outputs of the fixed `/opt/ror` gate and locality tools.
- Fake or mocked screens, canned verdicts, or pre-recorded model output in the product or the demo path. (Mocks are allowed in unit tests only, behind test-only config that is refused in production.)
- Giving any verification sandbox network (even "just for pip"), or skipping the seal latch in A/P.
- Accepting a wheel or bundle whose hash doesn't match the lock, or letting the host extract or parse bundle contents.
- Auto-approving, or rendering the approval card from model narration instead of the stored payload bytes.
- Weakening a test's expected outcome after seeing the result. Change the code or record a waiver in the README.
- Claiming mTLS, NetBird tiers, microVMs or a pass rate in README or video unless they are built and measured.

### Deployment requirements

- **Region:** `atl` (all inference models are served from `atl`).
- **One VPC** containing:
  - **Control-plane VM** (`vc2-2c-4gb` or `vhp-4c-8gb-amd`): Caddy on 80/443; API + worker + SQLite + blobs; firewall inbound 80/443 plus SSH from the team IP only (removed before recording if NetBird tier 1 is claimed); secrets in `/etc/credstore` (0600) via `LoadCredential`.
  - **Sandbox-host VM** (`vhp-2c-4gb-amd`, upgradeable to VX1): firewall group with **0 inbound rules**; the supervisor binds the VPC IP only; the proxy runs on the `ror-sbx` gateway IP (CF-04); nftables `DOCKER-USER` + host rules drop 169.254/16, RFC1918, 100.64/10, the VPC CIDR and host IPs from `10.89.0.0/24` except to the proxy; IPv6 forwarding dropped; journald logs `ror-drop`.
- **gVisor:** install from the official apt repo (`https://storage.googleapis.com/gvisor/releases`, `release main`) and register `runsc` in `/etc/docker/daemon.json` (systrap default). Record `runsc --version` in `docs/k2-results.md`.
- **Sandbox image:** built on the sandbox host and referenced by `@sha256` digest with `--pull never`.
- **Verify** everything in the K2 list (15 B-07) before you write the supervisor.

### Acceptance tests (15 §5)

- Implement and run **T-01…T-35**. The **minimum set before feature freeze** is T-01, T-02, T-03, T-04, T-05(a–e, g), T-06(a–d, f, i), T-09 (≤5 s), T-11(a, c, d), T-12, T-13, T-17, T-20, T-22, T-28 (replay), T-30 (static gate), T-34(a, c, d) (ALREADY_FIXED / no-fix-known) and T-35 (first bullet: no egress in B/C/D).
- The tests added after the review (18) are: T-28 replay, T-29 clean-laptop re-run, T-30 static gate (T-GATE-*), T-31 spoofed frame via `compile` (T-VER-05), T-32 stdlib-raise genuine bug (T-VER-06), T-33 loopback after seal (T-NET-09), T-34 ALREADY_FIXED and confidence rules, T-35 locked no-network installs. T-04 now covers inter-sandbox isolation (ICC off) and T-09 cancel latency ≤5 s.
- The expected outcomes are already fixed in 15. Don't change them.
- Report results in `docs/test-results.md` with timestamps. Any waiver goes in the README "Known limitations".
- Run the eval set (`eval/curated-issues.json`, 15 §6) and record per-row verdicts. **Any REPRODUCED or ALREADY_FIXED on E11/E12 is a defect, and so is any `high` on E21.**

### Stop and ask the human (don't proceed on your own)

- Creating, resizing or deleting **any billable resource**: VMs, VPC, reserved IPs, Object Storage, an inference subscription, a NetBird VM, domains.
- Making any repo **public**, creating `ror-demo-target` or `ror-hostile-fixture`, or changing repo visibility or permissions.
- **Posting anything outward**: any GitHub write, even to our own repo, outside a human-approved flow in the running app. That includes seeding issues with the API, and any message to organisers or Discord.
- Generating, rotating or revoking the inference key, GitHub PAT, receipt signing key or judge password.
- **K3a < 3/6 by Sat 14:00 PDT**: this is the pivot decision (recommended: Exactly-Once Submitter). K1 fails for all candidate models, or K2 fails any check: stop and ask. K3b < 3/6: propose §2.5 cuts to the human.
- Creating a Vultr Container Registry (optional, for the public re-run image).
- Any need to deviate from 12 (a new conflict), to cut an item above the cut line (15 §2.5), or to claim something not built.
- Anything that would send data to a non-Vultr third party other than GitHub reads/writes and package downloads inside the sandbox.
- Spend approaching $20 total, or the daily $5 model cap tripping.

### Definition of done

- The public URL on Vultr works.
- A curated issue reaches REPRODUCED or ALREADY_FIXED (high) live, and its receipt passes `verify-receipt --recompute`.
- Verify-only replay of every curated tuple reaches the same verdict with no model and no GitHub (T-28), and the two-step re-run command works from a clean laptop (T-29).
- The static gate, locality and ALREADY_FIXED tests (T-30…T-34) pass.
- The hostile **issue PoC** gives HOSTILE (public label "CONTAINED: policy violation") with the host unaffected, 10/10 times.
- T-03 finds zero secrets.
- Cancel destroys the run's sandboxes within 5 s.
- An approved comment posts only to `ror-demo-target`.
- README, ATTRIBUTION and THIRD_PARTY_NOTICES are complete (16 §6).
- Everything is committed after Sat 11:30 PDT and tagged `demo-freeze`.
