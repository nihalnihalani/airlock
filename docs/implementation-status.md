# Implementation status ledger

Durable state for the Airlock completion work (prompt in research/41 and the pasted remediation prompt; findings from research/42). Updated at each milestone.

## Current state

- Branch: `fix/milestone-1-guarantees` (pushed). Base: `main` @ `a1ae88d`.
- Milestone 1 (B1–B8): done and pushed; verified with local unit/integration tests against fakes.
- Milestone 2: done and pushed (review findings fixed). Milestone 3: browser runner, egress proxy and supervisor browser role done and pushed (local runc evidence; gVisor/Kata blocked). Milestone 4: in progress.
- **External blocker:** this machine has no Vultr access (`VULTR_API_KEY` absent, no `data/deploy/` state). Every gate that needs the deployed VMs (Kata measurements, live gate, deployment evidence, SSH/HTTPS checks) stays *blocked* until access is provided. Local verification uses Colima (runc, labelled dev-unsafe).

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
| D14 | 6 | lead | open | CLAUDE.md layout names |
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
| C11 | 4 | execution/control/web | open | doc 40 browser/general execution scope |
| C12 | 4 | execution/control/web | open | doc 40 browser/general execution scope |
| C13 | 4 | execution/control/web | open | doc 40 browser/general execution scope |
| C14 | 4 | execution/control/web | open | doc 40 browser/general execution scope |
| C15 | 4 | execution/control/web | open | doc 40 browser/general execution scope |
| C16 | 4 | execution/control/web | open | doc 40 browser/general execution scope |
| C17 | 4 | execution/control/web | open | doc 40 browser/general execution scope |
| C18 | 4 | execution/control/web | open | doc 40 browser/general execution scope |
| C19 | 4 | execution/control/web | open | doc 40 browser/general execution scope |
| C20 | 4 | execution/control/web | open | doc 40 browser/general execution scope |
| C21 | 4 | execution/control/web | open | doc 40 browser/general execution scope |
| C22 | 5 | execution/control/web | open | doc 40 browser/general execution scope |
| C23 | 5 | execution/control/web | open | doc 40 browser/general execution scope |
| C24 | 5 | execution/control/web | open | doc 40 browser/general execution scope |
| C25 | 5 | execution/control/web | open | doc 40 browser/general execution scope |
| C26 | 5 | execution/control/web | open | doc 40 browser/general execution scope |
| C27 | 5 | execution/control/web | open | doc 40 browser/general execution scope |
| C28 | 4 | execution/control/web | open | doc 40 browser/general execution scope |
| C29 | 4 | execution/control/web | open | doc 40 browser/general execution scope |
| C30 | 4 | execution/control/web | open | doc 40 browser/general execution scope |
| C31 | 4 | execution/control/web | open | doc 40 browser/general execution scope |
| C32 | 4 | execution/control/web | open | doc 40 browser/general execution scope |
| C33 | 4 | execution/control/web | open | doc 40 browser/general execution scope |
| C34 | 4 | execution/control/web | open | doc 40 browser/general execution scope |
| C35 | 4 | execution/control/web | open | doc 40 browser/general execution scope |
| C36 | 4 | execution/control/web | open | doc 40 browser/general execution scope |
| C37 | 4 | execution/control/web | open | doc 40 browser/general execution scope |
| C38 | 6 | execution/control/web | open | doc 40 browser/general execution scope |
| C39 | 6 | execution/control/web | open | doc 40 browser/general execution scope |
| C40 | 6 | execution/control/web | open | doc 40 browser/general execution scope |
| C41 | 6 | execution/control/web | open | doc 40 browser/general execution scope |

## Housekeeping

- scripted fixture path (`fileURLToPath`): done — 011fb84
- root `bun test` picks up reference repos: `bun run test` lists owned paths (Bun 1.3.2 has no ignore option) — fcc8170
- README test counts / CLAUDE.md layout / research status line / duplicate 38- file: open
