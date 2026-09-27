# Airlock runbook and submission checklist

Operational handoff for `fix/milestone-1-guarantees`. Deployment details and the measured results of the earlier `main` deployment are in [deploy/README.md](../deploy/README.md). The findings ledger is [implementation-status.md](implementation-status.md), the independent evidence is [acceptance-matrix.md](acceptance-matrix.md), and the D1 decision is in [decisions/D1-workspace-storage.md](decisions/D1-workspace-storage.md).

## Local (development, dev-unsafe)

Prerequisites: Bun 1.3, Docker (Colima on macOS), Python 3, Node 22+ (for the runner unit tests).

```sh
bun install --frozen-lockfile
# images for every sandbox role (the repair image is built by dev-up on demand)
runtime/python/build.sh tabulate-365
docker build -t airlock-browser:dev runtime/browser
docker build -t airlock-egress:dev apps/egress
runtime/analysis/build.sh && runtime/node/build.sh
scripts/dev-up.sh --detach            # runc + AIRLOCK_DEV_UNSAFE=1; scripted diagnostics driver; fixtures on 127.0.0.1:3100
bun scripts/smoke.ts                  # repair, forged log, hostile, cancel
bun scripts/acceptance/local.ts       # independent acceptance driver (writes docs/evidence/local/)
scripts/dev-down.sh                   # prints "(no sandboxes)" when the host is clean
```

Tests: `bun run test` (Bun suites under apps/, packages/, scripts/), `bun run test:python`, `bun run test:browser`, `node --test runtime/node/tests/*.test.mjs`; the supervisor's real-Docker integration tests need `DOCKER_HOST=unix://$HOME/.colima/default/docker.sock`.

Locally the sandboxed browser can reach only public sites (the egress proxy refuses private addresses), so the hero fixture page and the forms destination are usable end to end only on the deployment.

## Deployment (two Vultr VMs)

Needs `VULTR_API_KEY`, an SSH key registered as `airlock-hackathon`, and `VULTR_INFERENCE_API_KEY` for live inference (never printed or committed). If the API key has an access control list, it must allow the deploying machine's IPv4 **and** IPv6 addresses (Vultr answers `401 Unauthorized IP address: <addr>` otherwise; curl may use either family).

```sh
bun scripts/check-keys.ts                                   # credentials by read-only calls (never printed)
deploy/vultr/register-ssh-key.sh                            # registers ~/.ssh/airlock_ed25519.pub as airlock-hackathon (idempotent)
deploy/vultr/provision.sh                                   # VPC, firewall groups, VM A (control) + VX1 VM B (sandbox)
deploy/deploy.sh --driver scripted                          # hosts, images (python/browser/egress/analysis/node) pinned by id,
                                                            # egress guard, supervisor (AIRLOCK_PRODUCTION=1), control, fixtures
deploy/preflight.sh                                         # on VM B: KVM, runtimes, real sandboxes, runtime-tier gates (G4, D1, C4, C27, C29)
bun scripts/smoke.ts                                        # through the public URL (see deploy/README.md)
bun scripts/probe-model.ts <model> && bun scripts/probe-model.ts --vision <model>   # tool-call and image round trips
deploy/deploy.sh --driver vultr --model <model> --skip-host-setup
bun scripts/live-gate.ts --n 3                              # writes docs/evidence/live-gate/<ts>.json on ≥ 2/3
git add docs/evidence/live-gate && git commit               # repair becomes available only with a matching receipt
deploy/deploy.sh --only control --skip-host-setup           # reload receipts (or restart airlock-control)
deploy/vultr/destroy.sh                                     # when done: both VMs bill while they exist
```

Production refuses dev-unsafe hosts, runc, and unpinned images on both planes. Rotate `data/deploy/secrets.env` values by deleting the line and redeploying; the forms secret is shared by the control plane and the fixtures service.

## Operations

- **Cleanup:** the control plane retries unconfirmed teardown of finished tasks (up to `AIRLOCK_CLEANUP_RETRIES`); the supervisor janitor removes anything expired after `AIRLOCK_RETENTION_MS`. `GET /listing` on the supervisor (token) is the host-wide truth; the UI shows "(no sandboxes)" only when it is empty.
- **Capacity:** `GET /capacity` on the supervisor; a 429 means admission refused before any Docker call. Tune `AIRLOCK_HOST_*`/`AIRLOCK_MAX_SANDBOXES` from the preflight's measured headroom.
- **Stuck approvals:** proposals in `outcome_unknown` are reconciled only by reading the destination's receipt; never resubmit by hand.
- **Legacy data:** tasks and grants created before per-login owners are readable by operators only; old grants return 410; old verification records without image identity cannot authorize preview/export.
- **Cost:** about $0.19/hour for the two VMs; `deploy/vultr/destroy.sh` removes both instances, the firewall groups and the VPC listed in `data/deploy/state.json`.

## Submission checklist

| Item | Status | Evidence / what unblocks it |
|---|---|---|
| Public repository with setup docs | done | README, this runbook, deploy/README.md |
| Code-repair workflow (C) | verified on Vultr (live gate 3/3, acceptance) | docs/evidence/live-gate, docs/evidence/vultr |
| File analysis workflow (A) | verified on Vultr with the live model | acceptance-f223c19 |
| Browser research workflow (B) | verified on Vultr with the live model | acceptance-f223c19 |
| Combined workflow (D) | verified on Vultr, two data variants | acceptance-f223c19 |
| Human takeover and approvals | verified on Vultr (approval confirmed by the destination's receipt) | acceptance-f223c19 |
| Runtime tier measured (Kata on VX1) | verified: preflight 49/49 | docs/evidence/vultr/preflight-*.txt |
| Live Vultr inference (repair, general, vision) | verified (glm-5.3; vision probe) | docs/evidence/live |
| Public demo URL on this revision | https://155-138-198-12.sslip.io (revision ee94b83; acceptance at f223c19, demo at dfbba65) | deploy logs, acceptance |
| Demo video (useful work + containment + teardown) | done: Vultr recording (live model, Kata) and the local labelled recording | [docs/demo/vultr-demo.mp4](demo/vultr-demo.mp4), [docs/demo/README.md](demo/README.md) |
| Independent review | verifier: local acceptance, C41 crash/restart 7/7; devil's advocate: R1, S1–S4, L1, N1 closed; L2, L3, N2 documented limitations | [acceptance-matrix.md](acceptance-matrix.md), ledger |
| NetBird bonus | not attempted (optional) | — |
