# Acceptance matrix: independent verification

Verifier: `verifier_tester`, an independent pass by someone who did not write the product code. Date: 2026-09-27.

## Revisions under test

| Evidence set | Code revision | How it was run |
|---|---|---|
| Integration (real local stack) | `42a41d4f5bf9a112810c47a522c54e11d477af25` | A `git archive` export of that commit in a scratch directory, plus `bun install`, plus the two untracked files `apps/fixtures/data/regional-sales-{a,b}.csv` copied in (see F1). Other engineers were editing the working tree during the run, so the working tree was **not** used for the integration evidence. |
| Unit suites (primary) | `42a41d4` (same export) | Logs in `docs/evidence/local/unit/*.log` |
| Unit suites (first pass) | `7c1ab8e` (clean `apps/`) | Logs in `docs/evidence/local/unit/at-7c1ab8e/` |
| Preliminary integration pass | `7c1ab8e`–`42a41d4`, working tree | `docs/evidence/local/preliminary/`. Superseded. Kept only for transparency, because the tree was dirty while those runs happened. |

The container images were rebuilt at the start (`runtime/{browser,analysis,node,python}`, `apps/egress`). `runtime/` and `apps/egress` did not change between `7c1ab8e` and `42a41d4`.

## Environment categories

These categories are strict. A pass in one category does not imply a pass in another.

- **unit**: `bun test`, `node --test` and `pytest`. These use fakes, or real Docker where a test says so.
- **real local runc**: the dev stack from `scripts/dev-up.sh` on Colima (aarch64, 2 CPU, 2 GiB). It runs with `AIRLOCK_DEV_UNSAFE=1` and **plain runc**. Every result here is dev-unsafe: it is not gVisor or Kata, and it is not a deployment. The model driver is **scripted**, which means labelled diagnostics and never a live model.
- **Vultr**: the two-VM deployment with Kata or gVisor and live Vultr Serverless Inference. **No access**: there was no `VULTR_API_KEY`, no inference key and no deploy state. Every item in this category is BLOCKED.

## How to reproduce

```bash
export DOCKER_HOST=unix://$HOME/.colima/default/docker.sock
AIRLOCK_WEB_DIST=none AIRLOCK_JUDGE_PASSWORD=verify-judge-1 AIRLOCK_OPERATOR_PASSWORD=verify-oper-1 \
AIRLOCK_GENERAL_DIAGNOSTIC_SCRIPTS_DIR=$PWD/scripts/acceptance/fixtures/general \
AIRLOCK_PROPOSAL_TTL_MS=60000 AIRLOCK_FORMS_ORIGINS=http://127.0.0.1:3100,https://forms.example.com \
scripts/dev-up.sh --detach
bun scripts/acceptance/local.ts            # or: bun scripts/acceptance/local.ts A1 T5 K1 …
# against a pinned export: AIRLOCK_STACK_ROOT=<export dir> AIRLOCK_STACK_REVISION=<sha> bun scripts/acceptance/local.ts
scripts/dev-down.sh
```

The fixtures in `scripts/acceptance/fixtures/general/` (`acc-*.json`, `acc_analysis.py`) are labelled acceptance diagnostics that I wrote. `general-analysis.json` and `summarize.py` are copies of the product's own fixtures. Every row's machine-readable result, with its checks, is in `docs/evidence/local/results.json`.

## A. Independent acceptance list

| # | Requirement | Test / command | Environment | Timestamp (UTC) | Revision | Result | Evidence |
|---|---|---|---|---|---|---|---|
| A1 | Useful work (a): upload a fresh random CSV, run a general `analysis` task, and check the outputs. `summary.json` and `chart.png` bytes fetched through `/api/artifacts/:id` and `/api/tasks/:id/artifacts/:id` equal their recorded sha256 and the `x-airlock-sha256` header. The summary totals match values computed locally. Changing the input changes both output digests. The upstream `general-analysis` fixture's answer reflects the row count. | `local.ts A1` | real local runc | 2026-09-27T09:08:55Z | 42a41d4 | PASS | `docs/evidence/local/A1-analysis-fresh-csv.json` |
| A2 | Useful work (b): `web-research` on `example.com`. Chromium 153 navigates (HTTP 200) and observes. The screenshot artifact is a valid 1280×800 PNG whose sha256 matches. The Chromium sandbox is on, and the browser-container isolation probe is fully BLOCKED. Teardown lists "(no sandboxes)". | `local.ts B1` | real local runc | 09:12:14Z | 42a41d4 | PASS | `B1-web-research-example-com.json` |
| A3 | Useful work (c): the repair diagnostic ends `CANDIDATE_PASSED_CHECKS`. The forged-log run ends `CHECKS_FAILED`, with `312 passed` printed in exec stdout. Export of the failed candidate is refused (409). The zip's sha256 equals `x-airlock-zip-sha256` and `grant.zipDigest`, and three downloads are byte-identical. | `local.ts C1` | real local runc | 09:09:30Z | 42a41d4 | PASS | `C1-repair-diagnostic-forged-export.json` |
| A4 | Two judge sessions cannot reach each other's tasks, events, artifacts (both routes), approvals, control (get/take/release/live), decide, cancel, export or grant download: 15 probes, all 404. B's task list excludes A's tasks. Anonymous access gets 401. | `local.ts T1` | real local runc | 09:09:30Z | 42a41d4 | PASS | `T1-two-judge-isolation.json` |
| A5 | Closing SSE mid-run and reopening with `Last-Event-ID` replays the events: 89 events, seq 1..89 contiguous, no duplicates. `?lastEventId=10` resumes at 11. | `local.ts T2` | real local runc | 09:09:43Z | 42a41d4 | PASS | `T2-sse-close-reopen-replay.json` |
| A6 | Cancelling mid-run during a repair (`sleep 25` executing) goes `cancelling`, then `cancelled` in about 3 s. When `cancelled` was first observed, no task container existed. The teardown event comes after the request. 35 s later the task is still `cancelled`, with no outcome or candidate and no late exec or phase events. The supervisor holds no live attempt. | `local.ts T3` | real local runc | 09:14:11Z | 42a41d4 | PASS | `T3-cancel-mid-run-repair.json` |
| A7 | Cancelling a general browser task mid-run gives `cancelled` with no browser or egress container at that moment, cleanup `confirmed`, and no tool events afterwards. | `local.ts T4` | real local runc | 09:10:42Z | 42a41d4 | PASS | `T4-cancel-mid-run-browser.json` |
| A8 | Takeover: `take` gives holder=human. While the human held control for 16 s, no agent browser op started (the "Agent paused" event is present). A human screenshot works. `release` lets the agent resume and the task completes. | `local.ts T5` | real local runc | 09:14:39Z | 42a41d4 | PASS | `T5-takeover-and-stale-ref.json` |
| A9 | Stale browser refs are rejected on the agent path (`browser_click` at generation 1 after observe: "generation 1 is not current (2)") and on the human path (click at the previous generation: `stale_reference`). | `local.ts K4`, `T5` | real local runc | 09:09:11Z / 09:14:39Z | 42a41d4 | PASS | `K4-…json`, `T5-…json` |
| A10 | Proposals at the API level: a wrong digest gets 409. Another judge gets 404. The exact digest gets 200 `approved`. A replay gets 409, and reject-after-approve gets 409. An expired proposal gets 410: I used a 60 s TTL (`AIRLOCK_PROPOSAL_TTL_MS`, minimum 60000) and waited it out, with no 15 min wait. Reject gets 200. Deciding after the task ended gets 409. | `local.ts T6` | real local runc | 09:15:56Z | 42a41d4 | PASS | `T6-proposal-decide-semantics.json` |
| A11 | An approved submission reaches a controlled forms destination and is confirmed by its receipt. | none. The loopback fixtures service is not reachable from the sandboxed browser (egress allows public addresses only). `forms.example.com` is configured but unreachable, so the approved proposal ended `failed`, not `confirmed`, which is correct. | Vultr | n/a | n/a | BLOCKED | `T6-…json` (proposal B final status) |
| A12 | Hostile panel (judge only; the operator gets 403) runs a fork bomb, `rm -rf / --no-preserve-root`, a metadata fetch (curl is not in the image; Python gets `Network is unreachable`), a detached `nohup sleep`, and `env` + `/proc/1/environ`. Each card has died, survived (supervisor, host sentinel, control plane before/after), siblings[] and workspace (rm -rf: 16 files to 0), and a "(no sandboxes)" host listing. `/api/health` answered on every run (max 2 ms, 0 failures). No `sleep 3137` survives in the Docker VM (`colima ssh ps`). No secret names or values appear in the sandbox environment. | `local.ts K1` | real local runc | 09:16:46Z | 42a41d4 | PASS | `K1-hostile-panel.json` |
| A13 | A fork bomb while another task's command runs: the sibling is running before and after, its `sleep 25` completes (exit 0, "done"), and the control plane stays healthy. | `local.ts K2` | real local runc | 09:17:27Z | 42a41d4 | PASS | `K2-hostile-with-running-sibling.json` |
| A14 | No secrets inside a sandbox. Checked three ways: the hostile `env` and `/proc/1/environ` (A12), the analysis-sandbox environment names (A1), and `docker inspect` Env of the live browser and egress containers (T5). There is no SUPERVISOR_TOKEN, VULTR*, password, forms secret or API key. | `local.ts K1 A1 T5` | real local runc | see rows | 42a41d4 | PASS | `K1`, `A1`, `T5` json |
| A15 | Browser egress. The control-plane policy refuses 169.254.169.254, `example.org`, 10.0.0.1 and `metadata.google.internal`. The proxy **itself** denies `iana.org:443` (`host_not_allowed`) when a human clicks example.com's outbound link. Only `example.com` is ever allowed. The browser container's direct metadata/DNS/TCP/docker-socket probe is all BLOCKED. | `local.ts K4`, `T5` | real local runc | 09:09:11Z / 09:14:39Z | 42a41d4 | PASS | `K4-…json`, `T5-…json` (`egressLogWhileHeld`) |
| A16 | Host-level egress guard (DOCKER-USER rules on VM B) and IPv6 bypass on the real host. | none | Vultr | n/a | n/a | BLOCKED | none |
| A17 | Supervisor restart during an author attempt (SIGKILL, then restart). The control plane stays up. The interrupted attempt is `destroyed` and its container is not running after restart. The task retries on a fresh attempt (generation 2) and ends `REPRODUCED_UNRESOLVED` ("repair attempts exhausted (2/2)"), which is honest for a script that never submits. No container remains. | `local.ts K5` | real local runc | 09:21:17Z | 42a41d4 | PASS | `K5-supervisor-restart-during-author.json` |
| A18 | Supervisor unreachable for about 40 s during an author attempt (incidental). Tool errors are fed back. Teardown cannot be confirmed, so the outcome is `INCONCLUSIVE` and `cleanup.status=failed`, both visible. **But** the stopped container and volume stayed after the supervisor returned (see F3). | incidental; see note | real local runc | 09:21Z | 42a41d4 | PASS (honest outcome), with finding F3 | `X2-supervisor-unreachable-inconclusive.json` |
| A19 | Timeout cleanup: hostile `sleep 600` becomes `timed_out` (exit 124) after 30.0 s. Teardown is clean and the host listing is "(no sandboxes)". | `local.ts K3` | real local runc | 10:07:37Z | 42a41d4 | PASS | `K3-timeout-cleanup.json` |
| A20 | After everything, `docker ps -a`, networks and volumes (label `airlock.supervisor=true`, namespace `airlock`) are empty, and the supervisor's `/listing` is empty. This was run after F3's leftover had been removed by the janitor, at 09:53:59Z. | `local.ts K6` | real local runc | 10:07:41Z | 42a41d4 | PASS | `K6-final-host-cleanup.json` |
| A21 | Unsupported or deferred capabilities are labelled. Seven invalid creates get 422: unknown profiles, IP-literal, localhost and `.internal` destinations, a browser profile with no destinations, and egress for a no-browser profile. An arbitrary-site submit is refused with no proposal recorded. A task that needs an absent capability ends `UNSUPPORTED`. | `local.ts D1` | real local runc | 09:17:35Z | 42a41d4 | PASS | `D1-unsupported-labelled-and-refused.json` |
| A22 | Budget limit (incidental): a 45-turn general script ends `STOPPED_LIMIT` with the reason "model call budget exhausted (30/30)", and the browser sandbox is destroyed. | preliminary T5 run | real local runc (preliminary, working tree) | 08:56:20Z | 22dcce5 tree | PASS | `preliminary/X1-model-call-budget-stopped-limit.json` |
| A23 | Live model runs: the live-repair gate (2 of 3 fresh hero attempts), general tasks driven by a live Vultr model, and a vision round trip. | none | Vultr | n/a | n/a | BLOCKED | none |
| A24 | Kata/gVisor: runtime-tier gates, the Chromium sandbox under gVisor or Kata, and storage and pids limits measured on the deployed runtime. | none | Vultr | n/a | n/a | BLOCKED | none |

### Unit suites

| Suite | Command | Env | Timestamp | Revision | Result | Counts | Evidence |
|---|---|---|---|---|---|---|---|
| apps/control | `bun test` | unit | 09:23Z | 42a41d4 | PASS | 372 pass / 0 fail (7c1ab8e: 371/0) | `unit/control.log` |
| apps/supervisor (real Docker) | `DOCKER_HOST=… bun test` | unit + real local Docker | 09:24Z | 42a41d4 | **FAIL** | 197 pass / 1 fail (7c1ab8e: 198/0). See F2: a third-party site dependency; failed on 2 re-runs. | `unit/supervisor.log`, `unit/supervisor-browser-files-rerun.log` |
| apps/web | `bun test` | unit | 09:23Z | 42a41d4 | PASS | 126 / 0 (7c1ab8e: 96/0) | `unit/web.log` |
| apps/egress | `bun test` | unit | 09:23Z | 42a41d4 | PASS | 35 / 0 | `unit/egress.log` |
| apps/fixtures (working copy or export with CSVs) | `bun test` | unit | 09:23Z | 42a41d4 | PASS | 41 / 0 | `unit/fixtures.log` |
| apps/fixtures (**fresh checkout**) | `bun test` in the `git archive` export | unit | 09:08Z | 42a41d4 | **FAIL** | 22 pass / 2 fail / 1 error. See F1. | `unit/fixtures-fresh-checkout.log` |
| scripts | `bun test ./scripts/` | unit | 09:25Z | 42a41d4 | PASS | 11 / 0 | `unit/scripts.log` |
| runtime/browser | `node --test runtime/browser/test/*.test.mjs` | unit | 09:25Z | 42a41d4 | PASS | 18 / 0 | `unit/browser-node.log` |
| runtime python + outputs | `python3 -m pytest runtime/python/tests runtime/outputs/tests -q` | unit | 09:25Z | 42a41d4 | PASS | 134 passed, 3 skipped. The skips: the reference clone is absent (gitignored), APFS rejects non-UTF-8 names, and the host file system is case-insensitive. | `unit/pytest.log` |
| typecheck (6 workspaces) | `bun run typecheck` | unit | 09:26Z | 42a41d4 | PASS | clean | `unit/typecheck.log` |

## B. research/40 §7: definition of done

| # | DoD item | Test / command | Environment | Timestamp | Revision | Result | Evidence |
|---|---|---|---|---|---|---|---|
| D1 | Public application and backend run on Vultr | none | Vultr | n/a | n/a | BLOCKED (no Vultr access) | none |
| D2 | Every agent model request uses Vultr Serverless Inference | none live. Every local run is scripted and labelled `scripted` in model events. | Vultr | n/a | n/a | BLOCKED (no inference key). A local unit suite covers the client; that is **not** evidence of this item. | none |
| D3 | Python and Chromium actually execute outside the app process | A1 (analysis container, matplotlib), B1 (Chromium 153 in the `airlock-browser-*` container behind the `airlock-egress-*` proxy) | real local runc | 09:08Z / 09:12Z | 42a41d4 | PASS (local runc only) | `A1`, `B1` json |
| D4 | Agent tool dispatch continues without an open frontend tab | Every integration task ran with no UI (`AIRLOCK_WEB_DIST=none`). A1, A3 and A6 had no event stream open while the task ran, only `GET /api/tasks/:id` polling. | real local runc | see A1 | 42a41d4 | PASS (local) | `A1`, `C1` json |
| D5 | Real errors can trigger a bounded repair attempt | A local attempt bound was observed: "repair attempts exhausted (2/2)" (K5), and the budget stop (A22). An actual model repairing a real error needs a live model. | real local runc / Vultr | 09:21Z | 42a41d4 | BLOCKED (live model). The local bound is PASS. | `K5-…json` |
| D6 | Code, browser, file, screenshot and human-control capabilities pass their acceptance cases | A1, A2, A8, A9, A15. File downloads and uploads in the browser are unit and Docker tests only (the supervisor's browser-files test fails on a third-party site, F2). | real local runc | see rows | 42a41d4 | PASS (local runc) for code, browser, screenshot, human control and file upload/output. Browser file transfer is FAIL (F2, external). Kata is BLOCKED. | rows A1–A15 |
| D7 | Supported final actions require exact valid approval; unsupported mutations are refused | A10, A21 | real local runc | 09:15Z / 09:17Z | 42a41d4 | PASS (API level). An end-to-end approved submission with a receipt is BLOCKED (A11). | `T6`, `D1` json |
| D8 | Runtime secrets do not enter execution containers | A14 | real local runc | see A14 | 42a41d4 | PASS (local) | `K1`, `A1`, `T5` json |
| D9 | Resource and egress limits hold on the actual deployment | Local only: the fork bomb was contained by the pids limit, timeout (A19), egress deny (A15). | Vultr | n/a | n/a | BLOCKED (the local runc evidence is not the deployment) | none |
| D10 | Output downloads match recorded immutable artifacts | A1 (outputs, both routes), A2 (screenshot), A3 (sealed zip, 3 identical downloads) | real local runc | see rows | 42a41d4 | PASS | `A1`, `B1`, `C1` json |
| D11 | Stop, crash, timeout and terminal completion all have measured cleanup behaviour | stop: A6, A7. crash: A17, A18. timeout: A19. terminal: A1 (cleanup confirmed), A2 ("(no sandboxes)"). | real local runc | see rows | 42a41d4 | PASS for stop, crash (supervisor restart), timeout (A19) and terminal. Finding F3: after an unreachable supervisor, leftovers wait for the 30 min janitor retention. Controller-process crash was not measured. | rows |
| D12 | A fresh user input produces a fresh useful result in the recorded/public workflow | A1 (fresh random CSV each run; outputs change with the input) | real local runc | 09:08Z | 42a41d4 | PASS (local API). The public workflow is BLOCKED. | `A1-…json` |
| D13 | Deferred capabilities are labelled unavailable rather than simulated | A21 | real local runc | 09:17Z | 42a41d4 | PASS | `D1-…json` |
| D14 | Setup docs, repository, public URL and demo video satisfy the submission checklist | A fresh-checkout check found F1: the fixtures data is gitignored. | unit (fresh export) | 09:08Z | 42a41d4 | **FAIL** (F1). The public URL and video are BLOCKED. | `unit/fixtures-fresh-checkout.log` |

## Findings

- **F1: the fixtures service data is not in the repository.** `.gitignore:13` has `data/`, which also matches `apps/fixtures/data/`. As a result `apps/fixtures/data/regional-sales-{a,b}.csv` (imported by `apps/fixtures/src/data.ts:6`) is untracked.
  - A fresh clone cannot start the fixtures service. `scripts/dev-up.sh` reports "fixtures did not start: Cannot find module '../data/regional-sales-a.csv'".
  - `apps/fixtures` tests fail from a fresh checkout: 22 pass / 2 fail / 1 error.
  - The hosted hero data page, and the fixtures image built from a checkout, lack their data.
  - Fix: anchor the ignore rule (`/data/`), or add `!apps/fixtures/data/`, then commit the two CSVs.
- **F2: a supervisor integration test depends on a live third-party site.** `apps/supervisor/test/browser-files-integration.test.ts:149` uploads to `https://the-internet.herokuapp.com/upload` and expects `airlock-test.txt` on the result page. It now lands on `chrome-error://chromewebdata/`, and the site's POST returns 500 to curl. The test passed at `7c1ab8e`, and no supervisor or runtime code changed between the two revisions. This is not a product regression, but the suite is not hermetic. Fix: point it at the repo's own fixtures service, or gate it behind an explicit network-test flag.
- **F3: a failed cleanup of a terminal task is never retried by the control plane.** Seen in A18: with the supervisor unreachable, the task honestly ended `INCONCLUSIVE` with `cleanup.status=failed`. After the supervisor was back, the control plane did not retry the teardown. The supervisor (restart path, `lifecycle.ts` about line 125) had revoked and stopped the attempt and marked it `unknown`. Its janitor (`lifecycle.ts` about line 1907) only destroys the container and workspace volume after `deadline + AIRLOCK_RETENTION_MS` (30 min default). Until then the host listing is not "(no sandboxes)" and the task's cleanup dimension stays `failed`: this is honest, but it is never resolved to `confirmed`. 40 §6 lists a "failed and retrying" cleanup state. At `42a41d4`, `retrying` is written only on the **cancel** path (`apps/control/src/repair-handler.ts:251`, `apps/control/src/general-handler.ts:229`). A run that ends with an unconfirmed teardown becomes terminal with `cleanup.status=failed`, and nothing retries it.
