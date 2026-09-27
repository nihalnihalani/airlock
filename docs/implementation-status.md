# Implementation status ledger

Durable state for the Airlock completion work (prompt in research/41 and the pasted remediation prompt; findings from research/42). Updated at each milestone.

## Current state

- Branch: `fix/milestone-1-guarantees` (pushed). Base: `main` @ `a1ae88d`. HEAD tracked in git.
- Milestones 1–5 implemented and pushed; milestone 6 (independent verification, deployment) in progress.
- Team (Claude Code subagents, Opus 5.5): control_developer, execution_developer, product_developer, verifier_tester, devils_advocate; the lead owns contracts, lockfile, integration and deploy scripts. The experimental "agent teams" feature was not used; each role ran as a separate subagent with file ownership.
- **External blocker:** no Vultr access here (`VULTR_API_KEY` absent, no `data/deploy/` state, no inference key). Blocked: deployment, Kata/gVisor gates (D1, C4, G4, P1–P3), live repair gate and receipts (G2), vision round trip (C20), live-model evidence, demo recording. Local evidence is Colima runc, labelled dev-unsafe.
- Independent review: devil's advocate R1 (non-GET mutations off the form destination) fixed and re-reviewed (31bf40f, 179542f — two further worker leaks found and closed); S1–S3, L1 fixed (ab34815, daea39e). Verifier: 20/20 local acceptance rows; F1 (fixture data untracked) a6f3b9f, F2 (non-hermetic upload test) 0d60e64, F3 (no cleanup retry for finished tasks) e38367d fixed after the run.
- Remaining (blocked on Vultr): deployment of this branch, Kata/gVisor runtime gates, D1, live gate receipt, vision round trip, live-model evidence, demo recording. Documented limitation: GET requests to owner-allowlisted hosts can carry data; pages needing web workers do not run.

Decisions: tmpfs workspace kept pending Kata measurement (D1); one live attempt per task per role family (browser, code); scripted drivers are labelled diagnostics everywhere and cannot produce live-gate receipts; RESULT_VERIFIED means the profile's structural checks passed, not that the answer is correct.

Status vocabulary: `open`, `in progress`, `implemented-unverified`, `verified (local)` (unit/fake or local Docker), `verified (Vultr)`, `conditional`, `optional`, `blocked (reason)`.

## Findings (95)

| ID | Milestone | Owner | Status | Evidence / notes |
|---|---|---|---|---|
| B1 | 1 | control | verified (local) | api.test.ts: 401 anonymous, 404 cross-owner, SSE end on logout — commit 1fbeae2 |
| B2 | 1 | control | verified (local) | per-login owner ids; legacy sessions refused — 1fbeae2 |
| B3 | 1 | control | verified (local) | exportEligibility on grant and download — 1fbeae2 |
| B4 | 1 | control | verified (local) | ExportSeal + content-addressed zip; restart/concurrency tests — 1fbeae2 |
| B5 | 1 | supervisor | verified (local, fake Docker) | freeze refuses unsettled/uncertain writes — a8f9f1c |
| B6 | 1 | control | verified (local) | queued-with-attempt → cancelling; lost-lease teardown recorded — 1fbeae2 |
| B7 | 1 | control | verified (local) | cancel-pass errors retry then failed — 1fbeae2 |
| B8 | 1 | supervisor | verified (local, fake Docker) | restart revokes+stops live attempts; freeze only live running — a8f9f1c |
| M1 | 2 | supervisor+control | verified (local) | renew route + control renewal timer; fake+unit tests — 2c662a8, cf86da6 |
| M2 | 2 | supervisor | verified (local) | capacity.ts admission for every role incl. browser; tmpfs counted against memory — 2c662a8, b2de0d6 |
| M3 | 2 | control | verified (local) | token/call ceilings, conservative charging — cf86da6 |
| M4 | 2 | control | verified (local) | second attempt with comparator feedback; Task.candidates — cf86da6 |
| M5 | 2 | control | verified (local) | imageId/adapter/contract/runtime drift refusal — 9168d5d, a5f9bce |
| M6 | 2 | control | verified (local) | probe in both records incl. resume; required for production export — a5f9bce |
| M7 | 2 | supervisor | verified (local) | GET /listing, TeardownRecord.host incl. networks — 2c662a8, b2de0d6 |
| M8 | 2 | control | verified (local) | journal before send; reconcile pages all rows; GET /operations/:id — cf86da6, a5f9bce, b2de0d6 |
| M9 | 2 | control | verified (local) | collector rejections fail sealing — cf86da6 |
| M10 | 1 | control | verified (local) | ExportGrant binds verificationRecordDigest — 1fbeae2 |
| M11 | 2 | control | verified (local) | VerificationRecord.outcome — cf86da6 |
| M12 | 2 | supervisor | verified (local, real Docker) | readiness exec before dispatch — 2c662a8 |
| M13 | 2 | control | conditional | no model case-proposal tool exists |
| D1 | 6 | supervisor+lead | blocked (deployment) | durable quota storage must be proven on Kata; needs VM B access |
| D2 | 2 | supervisor+runtime | verified (local, real Docker) | digest-pinned base; imageId enforced; retag test — 2c662a8 |
| D3 | 2 | control | verified (local, real Docker) | one sandbox per case — cf86da6; smoke 66/66 |
| D4 | 2 | supervisor+control | verified (local) | AIRLOCK_PRODUCTION on both planes; deploy sets it — 2c662a8, a5f9bce |
| D5 | 2 | supervisor | verified (local) | bind classification — 2c662a8 |
| D6 | 2 | control | verified (local) | phase order prepare→baseline→reproduce→repair — cf86da6 |
| D7 | 2 | control | verified (local) | infrastructure errors → INCONCLUSIVE after confirmed teardown — a5f9bce |
| D8 | 2 | control | verified (local) | bounded recoveries — cf86da6, a5f9bce |
| D9 | 2 | control | verified (local) | regression drift → INCONCLUSIVE — cf86da6 |
| D10 | 2 | control | verified (local) | judge-only; client-keyed + global limits — 9168d5d |
| D11 | 2 | control | verified (local) | exact base URL, redirect:error — 9168d5d |
| D12 | 2 | runtime | verified (local, real Docker runc) | root/ro/size-aware mount classification — b2de0d6; Kata mount roots unmeasured |
| D13 | 2 | contracts | verified (local) | compareCodePoints — c7580dc, cf86da6 |
| D14 | 6 | lead | done | CLAUDE.md layout and scope updated — c42b7aa |
| D15 | 2 | supervisor | verified (local) | public health {ok:true} on both planes — 2c662a8, 9168d5d |
| G1 | 2 | control | verified (local) | provenance-checked live gate + receipts bound to image/adapter/store; running it needs Vultr — a5f9bce |
| G2 | 6 | lead | blocked (deployment) | committed sanitized evidence needs a deployment run |
| G3 | 2 | supervisor | verified (local, real Docker runc) | detached child dies on expiry/revoke/destroy — 2c662a8; Kata blocked |
| G4 | 6 | lead | blocked (deployment) | runtime gates on Kata |
| G5 | 2 | control+web | verified (local, real Docker runc) | forged '312 passed' reaches comparator → CHECKS_FAILED; smoke asserts it |
| G6 | 2 | web | verified (local, real browser check) | diagnostics catalog + UI launch — 9168d5d, 083d977 |
| G7 | 2 | control | verified (local) | resume from sealed bundle — cf86da6, a5f9bce |
| U1 | 2 | web+supervisor | verified (local UI) | instance ids or 'not deployed (local)' — 083d977 |
| U2 | 2 | web+supervisor | verified (local UI) | host vs guest uname with honest runc wording — 083d977 |
| U3 | 2 | web+supervisor+control | verified (local) | files before/after, siblings, control-plane health, host listing — 2c662a8, 9168d5d, 083d977 |
| U4 | 2 | web | verified (local UI) | plan→dispatch→observation→verification — 083d977 |
| U5 | 2 | control+web | verified (local) | repair availability from receipts; baseline-only tasks — 9168d5d, a5f9bce |
| U6 | 2 | control | verified (local) | CSP/nosniff/no-referrer on every response — 9168d5d |
| U7 | 2 | web | verified (local) | all four modules imported; getHealth removed — 083d977 |
| P1 | 6 | lead | blocked (deployment) | SSH restriction on VMs |
| P2 | 6 | lead | blocked (deployment) | host headroom measured |
| P3 | 6 | lead | blocked (deployment) | HTTPS/restart verification |
| P4 | - | optional | optional | NetBird add-on; not claimed |
| C1 | 3 | execution/control/web | verified (local, real Docker runc) | browser image/runner/egress + supervisor browser role — fcc8170, b2de0d6; gVisor/Kata + host iptables unverified |
| C2 | 3 | execution/control/web | verified (local, real Docker runc) | browser image/runner/egress + supervisor browser role — fcc8170, b2de0d6; gVisor/Kata + host iptables unverified |
| C3 | 3 | execution/control/web | verified (local, real Docker runc) | browser image/runner/egress + supervisor browser role — fcc8170, b2de0d6; gVisor/Kata + host iptables unverified |
| C4 | 3 | execution/control/web | blocked (deployment) | Chromium sandbox under gVisor/Kata needs VX1 |
| C5 | 3 | execution/control/web | verified (local, real Docker runc) | browser image/runner/egress + supervisor browser role — fcc8170, b2de0d6; gVisor/Kata + host iptables unverified |
| C6 | 3 | execution/control/web | verified (local, real Docker runc) | browser image/runner/egress + supervisor browser role — fcc8170, b2de0d6; gVisor/Kata + host iptables unverified |
| C7 | 3 | execution/control/web | verified (local, real Docker runc) | browser image/runner/egress + supervisor browser role — fcc8170, b2de0d6; gVisor/Kata + host iptables unverified |
| C8 | 3 | execution/control/web | implemented-unverified | DOCKER-USER egress guard (dry-run tested); needs VX1 host |
| C9 | 3 | execution/control/web | verified (local, real Docker runc) | browser image/runner/egress + supervisor browser role — fcc8170, b2de0d6; gVisor/Kata + host iptables unverified |
| C10 | 3 | execution/control/web | verified (local, real Docker runc) | browser image/runner/egress + supervisor browser role — fcc8170, b2de0d6; gVisor/Kata + host iptables unverified |
| C11 | 4 | execution/control/web | verified (local, real Docker runc) | navigate/observe with ARIA controls — fcc8170, b2de0d6, fde81e1 |
| C12 | 4 | execution/control/web | verified (local, real Docker runc) | click/type/key/scroll bound to generation — fcc8170 |
| C13 | 4 | execution/control/web | verified (local, real Docker runc) | stale refs refused; real-Docker stale click — b2de0d6 |
| C14 | 4 | execution/control/web | verified (runner unit) | tabs list/switch/close, popups tracked ≤5 — fcc8170 |
| C15 | 4 | execution/control/web | verified (runner unit) | dialogs dismissed + pending_review; file chooser cancelled — fcc8170 |
| C16 | 4 | execution/control/web | verified (local, real Docker runc) | bounded downloads (in-progress size, count, total); public CSV + 20 MB cancel — d8450d3 |
| C17 | 4 | execution/control/web | verified (local, real Docker runc) | uploads of sha256-checked owner artifacts; public test form — d8450d3, 7c1ab8e |
| C18 | 4 | execution/control/web | verified (fakes) | task-profiles registry + controller-owned completion — fde81e1 |
| C19 | 4 | execution/control/web | verified (fakes) | screenshot artifacts with url/time/dims/sha256 — fde81e1 |
| C20 | 4 | execution/control/web | blocked (inference key) | image parts implemented and gated (AIRLOCK_MODEL_VISION); live round trip needs a Vultr key — fde81e1 |
| C21 | 4 | execution/control/web | verified (fakes) | model call-site inventory in apps/control/README.md; pinned URL — fde81e1 |
| C22 | 5 | execution/control/web | verified (fakes) | authenticated rate-limited screenshot live view — 7c1ab8e, 22dcce5 |
| C23 | 5 | execution/control/web | verified (fakes) | exclusive take/release with settle and generation fence — 7c1ab8e |
| C24 | 5 | execution/control/web | verified (fakes) | human actions keep egress/deadline/budget; never approvals — 7c1ab8e |
| C25 | 5 | execution/control/web | verified (fakes) | proposals + one-use CAS decide — 9d4b94b, 7c1ab8e |
| C26 | 5 | execution/control/web | verified (fakes + real Chromium on fixtures) | controller-driven submit, destination enforces HMAC-bound payload — 0ff1e56, 7c1ab8e |
| C27 | 5 | execution/control/web | verified (local, real Chromium) | runner refuses non-GET/HEAD/OPTIONS and WebSockets off configured origins; workers disabled; httpbin + in-image harness — 31bf40f, 179542f |
| C28 | 4 | execution/control/web | verified (fakes) | uploads, artifacts, owner scope, quotas, nosniff — fde81e1 |
| C29 | 4 | execution/control/web | verified (local, real Docker runc) | collector for CSV/JSON/PNG/code outputs — dffdc55, d8450d3 |
| C30 | 4 | execution/control/web | verified (local, real Docker runc) | offline Node image + role — dffdc55, d8450d3 |
| C31 | 4 | execution/control/web | verified (fakes) | general handler + profile registry at the worker seam — fde81e1 |
| C32 | 4 | execution/control/web | verified (fakes) | completion checks per profile — fde81e1 |
| C33 | 4 | execution/control/web | verified (fakes) | UNSUPPORTED outcome, no simulated capability — fde81e1, 7c1ab8e |
| C34 | 4 | execution/control/web | verified (local, real Docker runc; scripted) | hero pieces verified (fixture page, download, analysis sandbox); acceptance A1/B1; live-model run blocked — e6a4b9a |
| C35 | 4 | execution/control/web | verified (fakes) | workflow/result/cleanup separated in contracts/API/UI — fde81e1, a2bc7d3 |
| C36 | 4 | execution/control/web | verified (fakes) | opState allowed/started/completed/failed/unknown — fde81e1, 7c1ab8e |
| C37 | 4 | execution/control/web | verified (fakes) | general sealed evidence bundle — fde81e1 |
| C38 | 6 | execution/control/web | verified (local, real Chromium) | hostile targets refused (disallowed, metadata, private, POST); prompt-injection has no authority path (DA review) — e6a4b9a, 31bf40f |
| C39 | 6 | execution/control/web | verified (local, real Docker runc) | teardown of containers/networks/profiles confirmed; janitor — b2de0d6, d8450d3 |
| C40 | 6 | execution/control/web | verified (fakes) | two-owner authorization tests across task/event/artifact/control/approval APIs — 1fbeae2, fde81e1, 7c1ab8e |
| C41 | 6 | execution/control/web | verified (local) / partial | runner loss → interrupted, supervisor restart reconcile, cleanup-retry sweep; controller kill mid-action not measured — e6a4b9a, e38367d |

## Housekeeping

- scripted fixture path (`fileURLToPath`): done — 011fb84
- root `bun test` picks up reference repos: `bun run test` lists owned paths (Bun 1.3.2 has no ignore option) — fcc8170
- CLAUDE.md layout: done (c42b7aa). README test counts, research status line, duplicate 38- file: open (final docs pass)
