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

## Post-run fixes (lead; not re-measured by this driver)

The rows above are the verifier's results at the recorded revisions and are unchanged. Findings fixed afterwards:

| Finding | Fix | Evidence |
|---|---|---|
| F1 fixture CSVs untracked (fresh checkout broke fixtures) | `!apps/fixtures/data/` + committed CSVs | a6f3b9f; fixtures suite 41/41 from the tree |
| F2 upload integration test depended on a third-party site | hermetic in-image upload test; public variant prechecked | 0d60e64; supervisor 207/207, all integration tests ran |
| F3 failed cleanup of a finished task never retried by control | bounded cleanup-retry sweep | e38367d; control 384/384 |
| DA R1 form submissions on non-adapter sites not refused | runner mutation guard + worker removal | 31bf40f, 179542f; real Chromium on httpbin + in-image harness |

A re-run of `scripts/acceptance/local.ts` at the final revision is the next local step; Vultr rows stay BLOCKED until access is available.

## Re-run at `c39340c`: 2026-09-27, verifier_tester

**Revision:** `c39340c6091a32ff8203fba5fd205bccac8614fd` (HEAD).

**How it was run:**
- The stack ran from a `git archive` export of HEAD, with `bun install` and **nothing copied in**. The export was taken fresh, the stack was started from it, and it was stopped after the run.
- All child processes had a clean environment: `env -i`, and the driver ran from the export directory so Bun did not load the repo `.env`.
- Images: `airlock-browser:dev` was rebuilt from the export's `runtime/browser` and gave the identical id `sha256:edeea738…`, so it matches HEAD. `airlock-egress:dev` is `sha256:4be8332c…`, and `runtime/` is otherwise unchanged.

**Evidence:** `docs/evidence/local/run-c39340c/` (per-row JSON plus `results.json`) and `docs/evidence/local/unit/at-c39340c/`.

**Scope:** every row is either real local runc (dev-unsafe) or unit, with the scripted driver only. Every Vultr and live-model row from the sections above (A11, A16, A23, A24, D1, D2, D5 live, D9, D14 public URL and video) stays **BLOCKED**. Nothing here measures a deployment.

### Integration: 18 PASS, 0 FAIL

| Row | Requirement | Environment | Time (UTC) | Result | Evidence (`run-c39340c/`) |
|---|---|---|---|---|---|
| A1 | fresh CSV → analysis → outputs match their sha256; the input change is reflected | real local runc | 10:32:12 | PASS | `A1-analysis-fresh-csv.json` |
| A2 | web-research on example.com, screenshot is a valid PNG | real local runc | 10:32:20 | PASS | `B1-web-research-example-com.json` |
| A9/A15 | browser egress refusals and stale ref (agent path) | real local runc | 10:32:28 | PASS | `K4-browser-egress-and-stale-ref.json` |
| A3 | repair diagnostic, forged log, sealed export | real local runc | 10:32:47 | PASS | `C1-repair-diagnostic-forged-export.json` |
| A4 | two-judge isolation (404) | real local runc | 10:32:47 | PASS | `T1-two-judge-isolation.json` |
| A5 | SSE close/reopen replay | real local runc | 10:32:59 | PASS | `T2-sse-close-reopen-replay.json` |
| A6 | cancel mid-run (repair) | real local runc | 10:33:42 | PASS | `T3-cancel-mid-run-repair.json` |
| A7 | cancel mid-run (browser) | real local runc | 10:33:58 | PASS | `T4-cancel-mid-run-browser.json` |
| A8/A9/A15 | takeover, human stale ref, proxy deny of iana.org, no secrets in container Env | real local runc | 10:34:26 | PASS | `T5-takeover-and-stale-ref.json` |
| A10 | proposals: 409, 409, 410, reject | real local runc | 10:35:36 | PASS | `T6-proposal-decide-semantics.json` |
| A12/A14 | hostile panel (5 commands), health, no secrets | real local runc | 10:36:26 | PASS | `K1-hostile-panel.json` |
| A13 | fork bomb with a running sibling | real local runc | 10:37:08 | PASS | `K2-hostile-with-running-sibling.json` |
| A19 | timeout cleanup | real local runc | 10:37:49 | PASS | `K3-timeout-cleanup.json` |
| A21 | unsupported capabilities labelled; arbitrary-site submit refused | real local runc | 10:37:57 | PASS | `D1-unsupported-labelled-and-refused.json` |
| **A25 (new)** | **Browser mutation guard (DA R1).** `egressAllow: ["httpbin.org"]`. **Human path:** clicking "Submit order" on `https://httpbin.org/forms/post` produces a runner `mutation_blocked` event (`POST https://httpbin.org/post`, count 1); the page never reaches httpbin's `/post` echo; a `GET https://httpbin.org/get` on the same site still returns 200. **Agent path:** the scripted `browser_click` on the same ref completes, the blocked mutation is recorded in the task's events, and the task ends `RESULT_VERIFIED` with cleanup `confirmed`. | real local runc | 10:38:24 | PASS | `M1-browser-mutation-guard.json` |
| A17 | supervisor restart during an author attempt | real local runc | 10:39:54 | PASS | `K5-supervisor-restart-during-author.json` |
| **A26 (new)** | **F3 sweep.** The supervisor was SIGKILLed during the author command and kept down, so the task ended `done/INCONCLUSIVE` with cleanup `failed`, and the container was still on the host. After a clean restart, cleanup went `retrying` → `confirmed` **11 s later** ("supervisor confirmed teardown of 1 attempt(s) on cleanup retry 1"). Status and outcome were unchanged, and the host was empty (no containers or volumes in the dev namespace). | real local runc | 10:40:23 | PASS | `K7-finished-task-cleanup-sweep.json` |
| A20 | final host cleanup (containers, networks, volumes, `/listing` all empty) | real local runc | 10:40:26 | PASS | `K6-final-host-cleanup.json` |

### Unit suites at `c39340c`: 10 PASS, 0 FAIL

All suites ran from the fresh export (`unit/at-c39340c/`):

| Suite | Result |
|---|---|
| apps/control | 384 pass / 0 fail |
| apps/supervisor (real Docker) | 207 pass / 0 fail |
| apps/web | 126 pass / 0 fail |
| apps/egress | 35 pass / 0 fail |
| apps/fixtures | 41 pass / 0 fail, from a fresh checkout with no files copied in: **F1 is confirmed fixed** |
| scripts | 11 pass / 0 fail |
| runtime/browser (`node --test`) | 27 pass / 0 fail |
| pytest | 134 passed, 3 skipped (reference clone absent, APFS, case-insensitive file system) |
| typecheck | clean |

### Status of the earlier findings at `c39340c`

| Finding | Status | Evidence |
|---|---|---|
| F1 | resolved | fresh-export fixtures suite passes and the fixtures service starts |
| F2 | resolved | supervisor suite 207/207 |
| F3 | resolved | A26 |

## C41 crash/restart at `033531b`: 2026-09-27, verifier_tester

**Revision:** `033531b34aebf221836c79fe2e3204e082232803`. HEAD moved to `4ff88d3` during the run, but `033531b..4ff88d3` touches only `deploy/` and `docs/`, so `apps/`, `packages/` and `runtime/` are identical.

**How it was run:**
- The stack ran from a fresh `git archive` export of `033531b` with `bun install`, using `env -i` and the "How to reproduce" variables.
- The updated `scripts/acceptance/` (driver plus the new `acc-c41-*` fixtures) was copied into the export. That directory holds test code only.
- Driver command: `AIRLOCK_STACK_ROOT=<export> AIRLOCK_STACK_REVISION=033531b… AIRLOCK_EVIDENCE_SUBDIR=c41-033531b bun scripts/acceptance/local.ts C41A C41B C41C C41D C41E C41E2 C41F K6`.
- Each kill is `kill -9` of the pid in `data/run/{control,supervisor}.pid`. The restart is `scripts/dev-up.sh --detach`, which is idempotent and restarts only the dead process.
- The kill is triggered from a live SSE stream at the named event, so it lands mid-operation. For every uncertain operation, the supervisor's own journal record (`GET /operations/:id`) was captured before the kill and again at the end.

**Scope:** real local runc (dev-unsafe, Colima) with scripted drivers only. Nothing here measures a deployment, Kata or gVisor.

**Evidence:** `docs/evidence/local/c41-033531b/` (per-row JSON with checks, timelines and event trails, `results.json`, `final-host-listing.txt`).

### Rows: 7 PASS, 0 FAIL (plus K6 PASS)

| Row | Kill moment | What was verified | Time (UTC) | Result |
|---|---|---|---|---|
| C41A | control SIGKILL 1.5 s into `browser_navigate https://httpbin.org/delay/8` (supervisor op `pending`) | Reclaimed 53 s after the kill (60 s worker lease), counted as recovery 1 of 2. The outstanding `browserOp` was reconciled "(intent): not replayed". Its operationId has one `started` event and no completion anywhere. The old browser attempt was revoked by the supervisor's authorization lapse, then "Discarded … revoked; destroyed" by the recovery. Every later op ran on a new attempt. Final state: `done/RESULT_VERIFIED`, cleanup `confirmed`, no containers or networks. | 13:45:13 | PASS |
| C41B | control SIGKILL 2.5 s into `code_run` (`sleep 20`, then **append** a marker line) | The uncertain `authorTool` was reconciled "not replayed" and never recorded as completed. Exactly one completed `code_run` exists, and it is a new operation on a fresh sandbox. `outputs/marker.txt` has exactly **one** line. No artifact came from the old attempt. The old sandbox was discarded. Cleanup `confirmed`. | 13:46:27 | PASS |
| C41C | control SIGKILL while a judge held browser control (holder=human, after a human observe) | Between the restart and the reclaim, human observe and scroll → **409** and take → **409** ("browser loop is not running"). On reclaim: "Control returned to the agent" (#22) **before** the recovered run's first browser op (#27). The agent restarted in a fresh session with navigate → observe. No human op completed after the kill. Final `Task.control.holder=agent`. | 13:38:10 | PASS |
| C41D | control SIGKILL with the **real** proposal caught in `claimed` (polled every 15 ms after the exact-digest approve) | **(a) real path:** `claimed` → `outcome_unknown` after the restart. The receipt read fails because `forms.example.com` is unreachable, so it stays `outcome_unknown` and is never confirmed or resubmitted. **(b) store level (labelled injection, see note):** a `submitted` proposal whose submission had really reached the loopback fixtures destination → `outcome_unknown` → "Receipt read (reconciliation) 1: confirmed" → `confirmed` with the destination's receipt and the approved digest. A `claimed` proposal that never reached it → `outcome_unknown` ("read 1: none"). The destination's `submission_accepted` counts are 1 (the pre-crash post), 0 and 0, so nothing was re-submitted, and no controller step ran after the restart. The replayed script's new proposal needed a fresh decision (rejected, 200). | 13:39:31 | PASS |
| C41E | control SIGKILL right after `browser_download_save` → `download.read` of a 9,000,000-byte file from speed.cloudflare.com was accepted by the supervisor (op `pending`) | The op never completed at the controller: the supervisor finished it (HTTP 200) but the response was lost. No download artifact or "Download stored" event exists from the killed attempt, and there are no `.tmp-*` blobs in the control artifact store, neither while the control plane was down nor at the end. The old attempt (and its tmpfs downloads) was destroyed. The only stored download is the complete 9,000,000 B file from the fresh attempt after the replay. | 13:48:02 | PASS |
| C41E2 | control SIGKILL while the browser's own download (`httpbin.org/drip`, 300 kB over 40 s) was `in_progress` | The partial file never became an artifact (0 download artifacts), there are no `.tmp-*` blobs, the old attempt was destroyed, and cleanup is `confirmed`. | 13:43:04 | PASS |
| C41F | **supervisor** SIGKILL 1.5 s into `browser_navigate …/delay/8`, restarted about 4 s later | The controller recorded "browser_navigate outcome unknown … not replayed and the browser session is closed". Right after the restart, the old attempt is `unknown` and the browser and egress containers are `Exited`. The supervisor journal shows the op `completed` with httpStatus 409 and `interruptedByRestart: true`. At the end the attempt is destroyed, and no containers or networks of the task remain. The task finished and did not run forever. | 13:44:34 | PASS |
| K6 | after all rows | `/listing` empty; `docker ps -a`, `network ls` and `volume ls` (label `airlock.supervisor=true`) are empty | 13:49:10 | PASS |

After `scripts/dev-down.sh`: "(no sandboxes)". `docker network ls --filter label=airlock.supervisor=true` is empty, and nothing is listening on 3000, 3100 or 4300 (`final-host-listing.txt`).

**What C41D part (b) is.** The sandboxed browser cannot reach the loopback fixtures destination, so a controller-driven submit to it cannot happen locally. While the control plane was dead, the driver did two things:
- It inserted two `action-proposals` records (`submitted` and `claimed`) for the killed task into its PGlite store.
- It posted the `submitted` one **once** to the fixtures destination with a correctly minted approval code. This simulates a submit that landed before the crash.

Everything after the restart is the product's own code: settling, the receipt reads and the transitions. Part (a) is the unmodified product path.

### Observations (not failures)

- **O1: stale control display during the lease gap.** Between the restart and the reclaim (49–58 s, which is the 60 s worker lease), `GET /api/tasks/:id` still says `running`, and `GET /api/tasks/:id/control` still says `holder: "human"` with `live: null`. Every human action is refused (409), so control is never simultaneous. The durable record is reset only when the run re-attaches (`apps/control/src/browser-control.ts:118-121`).
- **O2: reconciliation does not read the supervisor's operation record.** Recovery marks outstanding ops "(intent): not replayed" without calling the supervisor's `GET /operations/:id`. In C41A, C41B and C41E that record shows the operation **did complete** in the orphaned sandbox (httpStatus 200): in C41B the old `sleep 20` ran to the end (`docker top` while the control plane was down). This is safe, because the result is discarded along with the sandbox and never recorded. But the event could state "completed at the supervisor; result discarded" (`apps/control/src/general-handler.ts:1727-1748`).
- **O3: the recovery replay and a weak completion check (C41F).** A recovered run replays the scripted diagnostic from turn 1 (the recovery note says "start again"), so re-issued ops are new operations on new attempts. In C41F the script continued after the supervisor kill with observe and screenshot of a fresh `about:blank` session, and still ended `RESULT_VERIFIED`. That happened because `screenshot-evidence` counts any screenshot and `sources-visited` accepted example.com visited in the lost session. This is a scripted-driver artifact, but the checks do not bind the screenshot to a cited source (`apps/control/src/completion-checks.ts:131-144`).

## Full re-run at `a07cf32`: 2026-09-27, verifier_tester

**Revision:** `a07cf3228ef791f5bb1f44aae751df80077edc00` (HEAD). The product changes since the C41 run are:
- `509a832`: O1, O2 and O3
- `d3746a2`: N1
- `f688a6d`: web
- `3165226`: budget counters and scripted token charging

`runtime/`, `apps/egress`, `apps/supervisor` and `packages/` did not change, so the images from the `033531b` run are still current.

**How it was run:**
- The stack ran from a fresh `git archive` of `a07cf32` with `bun install`, using `env -i`, throwaway passwords (`verify-*`) and the "How to reproduce" variables. Nothing was copied in except `scripts/acceptance/`.
- Driver: `bun scripts/acceptance/local.ts A1 B1 K4 C1 T1 T2 T3 T4 T5 T6 K1 K2 K3 K5 D1 M1 K7 C41A C41B C41C C41D C41E C41E2 C41F K6`, from 15:15Z to 15:32Z. T5, T6, M1 and K6 were re-run at 15:33–15:35Z after their expectations were updated (see below).
- The stack was stopped afterwards and the host left empty (`final-host-listing.txt`).

**Evidence:** `docs/evidence/local/run-a07cf32/` (per-row JSON, `results.json`, both driver logs, `unit/`).

**Scope:** real local runc (dev-unsafe) with scripted drivers only. The Vultr and live-model rows stay **BLOCKED**, as listed above.

### Integration: 25 PASS, 0 FAIL

Every row passed: A1, B1, K4, C1, T1–T6, K1, K2, K3, K5, D1, M1 (A25), K7 (A26), C41A–C41F, C41E2 and K6.

**Lead's questions:**
- **C41C: control returns to the agent at restart, not only at reclaim.** Immediately after `dev-up.sh`, before the worker reclaimed the task, `GET /control` reports `holder=agent` ("control plane restarted; control returned to the agent"). The "Control returned to the agent" event (#17) comes before "Recovering task" (#20). Human actions in the gap still get 409. Observation O1 is resolved.
- **C41F now ends `RESULT_PARTIAL`.** `screenshot-evidence` failed with "1 screenshot(s) stored, none of an http(s) page (e.g. about:blank)". Observation O3 is resolved. This is now an explicit check.
- **O2 is resolved.** In C41A, C41B and C41E, the reconciliation event now carries the supervisor's own operation record: "(intent): not replayed; supervisor: completed (HTTP 200); result discarded, not replayed". It matches `GET /operations/:id`, and the operation is still never replayed. This is now an explicit check.

### Expectations changed because of O3/N1

The screenshot must now show a cited source. I changed only fixture and expectation text, never the product.

- **T5 (A8), T6 (A10) and M1 agent path (A25) now end `RESULT_PARTIAL`, not `RESULT_VERIFIED`.** In each, the agent's only screenshot is of a `chrome-error://chromewebdata/` page:
  - T5: after the human clicked example.com's outbound link, which the proxy denied.
  - T6: after the approved submit to the unreachable `forms.example.com` failed.
  - M1: after the blocked form POST.

  The earlier `RESULT_VERIFIED` was over-generous. The new outcome is correct, and each row now asserts it explicitly with `checkErrorPageScreenshotPartial`.
- **`acc-c41-slow-nav.json` now cites both pages** (`example.com` and `httpbin.org/delay/8`), because its screenshot is taken on the slow page. With that, C41A ends `RESULT_VERIFIED` after a counted recovery, with the check "screenshot shows a cited source: httpbin.org/delay/8". C41F ends `RESULT_PARTIAL` as described above.

Every other row's outcome is unchanged from `run-c39340c`.

### Unit suites at `a07cf32`: all PASS

All suites ran from the fresh export with `env -i` (`unit/`):

| Suite | Result |
|---|---|
| apps/control | 398 pass / 0 fail |
| apps/supervisor (real Docker) | 207 pass / 0 fail |
| apps/web | 132 pass / 0 fail |
| apps/egress | 35 pass / 0 fail |
| apps/fixtures | 41 pass / 0 fail |
| scripts | 11 pass / 0 fail |
| runtime/browser | 27 pass / 0 fail |
| pytest | 134 passed, 3 skipped |
| typecheck | clean |

`browser-node.log` records the correct invocation, `node --test runtime/browser/test/*.test.mjs`. My first attempt passed the directory instead, which is a harness error: it matched no tests.

## Live model (local runc, dev-unsafe) at `ee8d1be`: 2026-09-27, verifier_tester

**Revision:** `ee8d1be7583afefb35f483d3a4b13ab254b973b5` (HEAD).

**Category: live model + real local runc.** Every model call went to Vultr Serverless Inference (`api.vultrinference.com`, model `glm-5.3-normalize`, i.e. `AIRLOCK_MODEL=glm-5.3` plus the driver's `-normalize` suffix). The sandboxes ran on **plain runc on Colima (dev-unsafe)**. This is **not** Vultr compute, not gVisor or Kata, and not a deployment. The Vultr account key is IP-restricted, so nothing was deployed. The Vultr-compute rows (A11, A16, A24, D1, D9, public URL) stay **BLOCKED**.

**How it was run:**
- The stack ran from a fresh `git archive` of HEAD with `bun install`. The optional `cpu-features` native build failed; it is an unused optional dependency.
- The `.env` in the export root held only the four inference lines from the repo `.env` (`VULTR_INFERENCE_API_KEY`, `VULTR_INFERENCE_BASE_URL`, `AIRLOCK_MODEL`, `AIRLOCK_MODEL_DRIVER`). It did not include the account key. It was deleted right after `dev-up.sh` started.
- Stack command: `env -i … AIRLOCK_WEB_DIST=none AIRLOCK_MODEL_DRIVER=vultr AIRLOCK_MODEL_VISION=1 AIRLOCK_JUDGE_PASSWORD=live-judge-1 AIRLOCK_OPERATOR_PASSWORD=live-oper-1 scripts/dev-up.sh --detach`. The control log shows `driver: vultr, model: glm-5.3`.
- The general tasks were driven through the public API by `driver-live-general.ts.txt`, which I wrote. The gate records were collected by `driver-gate-evidence.ts.txt`.
- Afterwards, `scripts/dev-down.sh` printed "(no sandboxes)". No labelled containers, networks or volumes remained, and nothing listened on 3000, 3100 or 4300.
- A script read the key from `.env` and scanned all evidence for it. It found 0 occurrences of the key, and none of the supervisor token, the forms secret or any session cookie.

**Evidence:** `docs/evidence/live/local-ee8d1be/`

### Rows

| # | Requirement | Time (UTC) | Result | Evidence |
|---|---|---|---|---|
| L1 | **Live repair (hero, tabulate #365).** Command: `bun scripts/live-gate.ts --n 3 --allow-dev-unsafe`, run from the export. **3/3 `CANDIDATE_PASSED_CHECKS`** by the external comparator: the baseline reproduced `IndexError`, and verification passed 6/6 cases on each candidate. Details below. | 16:00–16:03 | PASS (**local live pass**; not a gate receipt) | `live-gate-run.log`, `live-gate-attempts.json` |
| L1a | **No receipt on dev-unsafe.** The script printed "dev-unsafe rehearsal: no receipt written" and exited 1. The export's `docs/evidence/live-gate/` holds only `README.md`, and no JSON was created there. | 16:03 | PASS | `live-gate-run.log` |
| L2 | **Live general `analysis`, fresh random CSV (two runs).** Goal: "find the worst-performing region by total revenue…, summary.json `answer` + chart.png". Both runs gave the correct answer for different data (details below). | 16:03–16:05 | PASS | `analysis-run1.json`, `analysis-run2.json` |
| L3 | **Live `web-research` with vision.** Details below. | 16:06 | PASS | `web-research-run1.json` |
| L4 | **Live `web-analysis`, combined workflow (two runs).** The source was `people.sc.fsu.edu/~jburkardt/data/csv/csv.html`, which the egress proxy could reach. The work itself was correct end to end, but both runs ended **`RESULT_PARTIAL`** because of finding LM1 (details below). | 16:07–16:10 | **PARTIAL** (work correct; completion check false negative, LM1) | `web-analysis-run1.json`, `web-analysis-run2.json` |
| L5 | **A genuine execution error leads to bounded correction.** In three runs a failed `code_run` was followed by a corrected, successful run (details below). The dedicated malformed-row run needed no correction (details below). | see rows | PASS (live) | `analysis-run1.json`, `web-analysis-run1.json` |

**L1: live repair attempts.** All three used model `glm-5.3-normalize`, and every model event's host was `https://api.vultrinference.com/v1` (the script's provenance check enforces this). Cleanup was `confirmed` for all three.

| Attempt | Task | Model calls | Duration | Tokens (in/out) | Candidate digest |
|---|---|---|---|---|---|
| 1 | `task-b2241a11b4e06d6f` | 11 | 39 s | 57,959 / 4,351 | `f7be5b0a6783cab50d4ac4ab09adafb1f1a76e0b46ccd47390c9606f00d3a20e` |
| 2 | `task-fee44356a430057a` | 14 | 42 s | 93,678 / 3,883 | `0fbbf34e344da73447de7e6f251783e9e7894c138fbd5fe1a62c2860ae2b0f03` |
| 3 | `task-6774bf96f7006a8c` | 10 | 54 s | 60,506 / 7,092 | `6d4ba043dd7af94cf1b7e41e44e7ab3b05fd22a222e1bc3c7c60f2d922f25da8` |

**L2: analysis runs.** Both runs ended `RESULT_VERIFIED` with cleanup `confirmed`. Output bytes fetched through both artifact routes, and the `x-airlock-sha256` header, equal the recorded sha256. The two runs' output digests differ.

| Run | Task | Expected (computed locally) | Model's `answer` | Model calls | Tokens (in/out) | Output digests |
|---|---|---|---|---|---|---|
| 1 | `task-a24d64e4f3e7a9b3` | North, 11,171.96 (margin 5,171.09) | "North … 11,171.96", and every region total matches | 15 | 55,357 / 3,599 | `summary.json` `366d3c27…`, `chart.png` `41b32eb6…` (1200×750) |
| 2 | `task-e61fcb806ba5bc4c` | South, 8,877.83 | "South … 8,877.83" | 10 | 26,509 / 2,466 | `summary.json` `2bdf559c…`, `chart.png` `64fc5cd2…` |

**L3: web-research run.** Task `task-44bde658c315ad41`, allowlist `example.com`, `iana.org`, `www.iana.org`.
- The model navigated to example.com (200) and observed it. It clicked "Learn more", which landed on `https://www.iana.org/help/example-domains`. It observed that page and took a screenshot (1280×800).
- Model turn 6 has `imageAttached: true`, and its `imageSha256` equals the screenshot artifact's sha256 (`8e396907…`). So the screenshot was really sent to the model.
- All 4 completion checks passed, and the task ended `RESULT_VERIFIED`, cleanup `confirmed`.
- The answer "RFC 2606 and RFC 6761" is **correct**. The model took it from the text observation, one turn before the image was attached.
- 6 model calls, 16,980 / 815 tokens.

**L4: web-analysis runs.** Tasks `task-85dbf712867ef64a` and `task-be704c3bce6f3b5d`.
- **Download:** the model clicked the `airtravel.csv` link, then used `browser_download_list` and `browser_download_save`. The stored download artifact has sha256 `f6a5fc62…`. That equals my direct fetch of the file, the "Input inputs/airtravel.csv placed" event's sha256, and the downloaded bytes.
- **Answer:** the totals 1958 = 4,572, 1959 = 5,140 and 1960 = 5,714, and growth of 24.98%, match my offline computation in both runs. `chart.png` is valid, and all outputs match their sha256.
- **Citation:** both the page and the CSV URL were cited. The page has a screenshot.
- **Why `RESULT_PARTIAL`:** in both runs `sources-visited` failed with "never reached by this task's browser: …/airtravel.csv", even though that URL was fetched by this task's browser as a download.
- **Cost:** run 1 took 21 calls and 241,993 / 11,720 tokens. Run 2 took 16 calls and 146,258 / 8,266 tokens. Each run had one vision turn.

**L5: execution errors followed by correction.**
- `analysis` run 1: the model named its script `code/inspect.py`, which shadowed the stdlib `inspect`, and matplotlib failed (exit 1, twice). It then renamed the script and succeeded (exit codes `0,1,1,0,0,0`).
- `web-analysis` run 1: the header parse left the year columns empty (exit 1). The model inspected the raw file and rewrote the parser (exit 0).
- `web-analysis` run 1, later: `verify.py` exited 1, was fixed, then exited 0.
- A dedicated malformed-row run (`task-51f3bcf40a9a0938`: a 7-field row at line 41, placed in a non-worst region) needed **no** correction. The model inspected the file first, noted "line 41: 7 fields; used first 5", and answered West at 8,768.61, which is correct, ending `RESULT_VERIFIED`.

### Findings

- **LM1: a browser download does not count as "visited" for `sources-visited`.** The handler builds the visited set only from completed `tool` events that carry `visitedUrl` (`apps/control/src/general-handler.ts:1649-1656`), and the check is `apps/control/src/completion-checks.ts:178-186`. A file fetched through the egress proxy by `browser_download_save` is recorded as an `artifact` event whose `source.url` is the download URL (`general-handler.ts:820`), but it never enters that set.
  - Effect: the natural combined workflow (download a CSV and cite it) ends `RESULT_PARTIAL` even when every output is correct. This reproduced in 2/2 live runs.
  - Navigating to the CSV URL does not help: `page.goto` fails with "Download is starting" (`navigation_failed`, event #31 in run 1).
  - It fails closed, so it is not a safety problem, but it undercuts workflow D.
  - Reproduce: `bun driver-live-general.ts web-analysis` against a live-driver stack.
- **Observation (not a defect):** an upload named `.csv` whose bytes do not parse as strict CSV (one ragged row) is sniffed as `text/plain` and renamed `sales-run3.txt` (`apps/control/src/artifact-service.ts:82`, `:92`). The model coped, but the owner's filename changed silently.
