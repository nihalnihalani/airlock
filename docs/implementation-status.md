# Implementation status ledger

Durable state for the Airlock completion work (prompt in research/41 and the pasted remediation prompt; findings from research/42). Updated at each milestone.

## Current state

- Branch: `fix/milestone-1-guarantees` (pushed). Base: `main` @ `a1ae88d`.
- Milestone 1 (B1–B8): done and pushed; verified with local unit/integration tests against fakes.
- Milestone 2: in progress.
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
| M1 | 2 | supervisor+control | open | renewable execution authorization tied to worker lease |
| M2 | 2 | supervisor | open | atomic host admission |
| M3 | 2 | control | open | token budget per attempt and task |
| M4 | 2 | control | open | second repair attempt after failed checks |
| M5 | 2 | control | open | preview bound to verified image/adapter |
| M6 | 2 | control | open | probe result in VerificationRecord |
| M7 | 2 | supervisor | open | host-wide teardown listing |
| M8 | 2 | control | open | persist operation intent/ids; reconcile by id |
| M9 | 2 | control | open | collector rejections fail sealing |
| M10 | 1 | control | verified (local) | ExportGrant binds verificationRecordDigest — 1fbeae2 |
| M11 | 2 | control | open | outcome in VerificationRecord |
| M12 | 2 | supervisor | open | runner readiness check |
| M13 | 2 | control | conditional | no model case-proposal tool exists; keep none |
| D1 | 6 | supervisor+lead | blocked (deployment) | durable quota storage must be proven on Kata; needs VM B access |
| D2 | 2 | supervisor+runtime | open | digest-pinned base/runtime image enforced at inspection |
| D3 | 2 | control | open | fresh one-shot sandbox per case |
| D4 | 2 | supervisor+control | open | production rejects dev-unsafe/runc |
| D5 | 2 | supervisor | open | bind address validation |
| D6 | 2 | control | open | phase events match real work |
| D7 | 2 | control | open | hard failures → INCONCLUSIVE |
| D8 | 2 | control | open | bounded recoveries |
| D9 | 2 | control | open | baseline regression drift → INCONCLUSIVE |
| D10 | 2 | control | open | hostile judge-only; rate limit survives relogin |
| D11 | 2 | control | open | inference base URL pinned |
| D12 | 2 | runtime | open | probe mount exemptions |
| D13 | 2 | contracts | done (lead) | compareCodePoints for manifest ordering |
| D14 | 6 | lead | open | CLAUDE.md layout names |
| D15 | 2 | supervisor | open | minimal public /health |
| G1 | 2 | control | open | live gate: tracked issue, provenance check |
| G2 | 6 | lead | blocked (deployment) | committed sanitized evidence needs a deployment run |
| G3 | 2 | supervisor | open | background child dies on stop (real Docker) |
| G4 | 6 | lead | blocked (deployment) | runtime gates on Kata |
| G5 | 2 | control+web | open | forged '312 passed' reaches comparator |
| G6 | 2 | web | open | launch forged-log/slow diagnostics from UI |
| G7 | 2 | control | open | resume from sealed bundle test |
| U1 | 2 | web+supervisor | open | instance ids in UI |
| U2 | 2 | web+supervisor | open | host uname beside guest |
| U3 | 2 | web+supervisor+control | open | blast radius: control health, files destroyed, siblings |
| U4 | 2 | web | open | dispatch trail evidence |
| U5 | 2 | control+web | open | repair-disabled state from live-gate evidence |
| U6 | 2 | control | open | CSP |
| U7 | 2 | web | open | re-check unused modules against current imports |
| P1 | 6 | lead | blocked (deployment) | SSH restriction on VMs |
| P2 | 6 | lead | blocked (deployment) | host headroom measured |
| P3 | 6 | lead | blocked (deployment) | HTTPS/restart verification |
| P4 | - | optional | optional | NetBird add-on; not claimed |
| C1 | 3 | execution/control/web | open | doc 40 browser/general execution scope |
| C2 | 3 | execution/control/web | open | doc 40 browser/general execution scope |
| C3 | 3 | execution/control/web | open | doc 40 browser/general execution scope |
| C4 | 3 | execution/control/web | open | doc 40 browser/general execution scope |
| C5 | 3 | execution/control/web | open | doc 40 browser/general execution scope |
| C6 | 3 | execution/control/web | open | doc 40 browser/general execution scope |
| C7 | 3 | execution/control/web | open | doc 40 browser/general execution scope |
| C8 | 3 | execution/control/web | open | doc 40 browser/general execution scope |
| C9 | 3 | execution/control/web | open | doc 40 browser/general execution scope |
| C10 | 3 | execution/control/web | open | doc 40 browser/general execution scope |
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
- root `bun test` picks up reference repos: open
- README test counts / CLAUDE.md layout / research status line / duplicate 38- file: open
