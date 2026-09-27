# Demo recordings

**Status of the required demo:** the Vultr deployment recording is **done**: [`vultr-demo.mp4`](vultr-demo.mp4), described in the next section. The older **local** recording (`local-demo.mp4`, dev-unsafe runc, scripted drivers) is kept below for reference; it does not replace the Vultr recording.

## Vultr deployment recording (`vultr-demo.mp4`)

- 1920x1080 H.264, 30 fps, **2:20**, 5.9 MB. A slideshow of real screenshots of the live UI, 3–6 s per frame (38 frames). It is not a screencast.
- Every frame carries the burned-in label **"Vultr deployment · Kata on VX1 · glm-5.3 via Vultr Serverless Inference · revision dfbba65"** plus a caption bar. ffmpeg has no `drawtext`, so labels were composited with Pillow (SF font) and the frames were concatenated with `/opt/homebrew/bin/ffmpeg` (concat demuxer, libx264, `-tune stillimage`).
- **Live run, not scripted.** Recorded 2026-09-27 22:40–22:52 (UTC+05:30; UI times below are in that zone) with the chrome-devtools MCP in an isolated browser context at 1920x1080, signed in as **judge** on the public URL `https://155-138-198-12.sslip.io`. Control plane: VM A, instance `32b367c0-…` (vc2). Sandboxes: VM B, instance `f034dad8-…` (VX1), runtime Kata. The hero task and the repair used the live model `glm-5.3` (recorded as `glm-5.3-normalize`) via `api.vultrinference.com`. Live model use was exactly one hero task and one repair.
- The sibling task in the containment segment is a **labelled scripted diagnostic** (`slow`: three `sleep 25` commands, no model). The UI labels it "Diagnostic (scripted, not a model)" everywhere.
- **No secrets.** The login step is not in the recording. The judge password was never typed on screen or into a tool call: a page script read it from a local file through a temporary file input and set it into the masked password field. The file was then deleted. Afterwards, the page text and the full task records and event logs of all three tasks (about 250 KB) were checked against every value in `data/deploy/secrets.env`: 0 hits. The one-use export grant id was masked in the DOM before its frame was taken ("id masked in this recording").

| Time | Segment | What it shows | What it proves |
|---|---|---|---|
| 0:00–0:06 | Title | Scope, host, runtime, model, revision | Framing |
| 0:06–0:25 | 1 Show me the instance | Execution host check: `Kata (host check)`, `/dev/kvm` present, runtimes `kata, runc, runsc`, host kernel `6.8.0-139-generic`, execution instance `f034dad8-…`. The sidebar footer shows control `32b367c0-…` and execution `f034dad8-…`. The five checkpoints panel shows the browser and analysis guests on kernel `6.18.35` ("kernels differ": each sandbox boots its own guest kernel in a Kata VM), 13/13 container checks, an isolation probe with everything BLOCKED (metadata 169.254.169.254, DNS, outbound TCP, Docker socket, host mounts), and teardown ending host-wide `(no sandboxes)` | Real Vultr compute, with hardware-virtualised Kata sandboxes on the VX1 host |
| 0:25–1:06 | 2 Live hero task | `task-21492c0b5b955ede`, web-analysis. Allowlist `forms.155-138-198-12.sslip.io` only. Model plan → `browser_navigate` (allowlist checked) → Kata browser sandbox → observe → `browser_screenshot` (stored, sha256) → click CSV link → `browser_download_list`/`browser_download_save` → offline analysis sandbox → `code_write` / `code_run` (exit 0) → `submit_result`. Freeze → controller collects outputs → **all 10 completion checks pass → `RESULT_VERIFIED`**, cleanup confirmed. Output `chart.png` and `summary.json`: answer **"South (0.727)"** (80/110, correct), citing the fixtures page. 10 model calls, 39,535 tokens, 22:40:53 → 22:41:27 (34 s) | Useful multi-step work across browser, download and code. The controller decides completion, not the model |
| 1:06–1:45 | 3 Live repair | `task-a0474163887cff0d`, tabulate-365. The issue text is `profiles/tabulate-365/issue.md` without its provenance comment, as `scripts/live-gate.ts` sends it. Baseline reproduces the IndexError. The model reproduces, edits `tabulate/__init__.py`, re-tests and submits. Freeze seals candidate `49ecc6e73e3c3e86…`. Verify runs 6 frozen cases, each in a fresh Kata sandbox → **`CANDIDATE_PASSED_CHECKS` 6/6** (verification `ver-890c3775426aef80b690`). The **Baseline vs candidate** table: the reported case raised IndexError on the baseline and returns the header-only table on the candidate; the regression cases match. Preview on the sealed candidate (kata, exit 0) prints `Name    Value / ------  -------`. The sealed export grant downloads a 222,810-byte zip, sha256 `abbace2e…0398`, equal to `x-airlock-zip-sha256`. 21 model calls, 166,800 tokens, 22:43:14 → 22:45:01 (107 s) | A live model repair judged only by the external comparator on a sealed candidate, with an exportable bundle |
| 1:45–2:03 | 4 Containment | While the sibling `task-b36083cac2d05c18` runs `sleep 25` in its Kata sandbox, the judge runs the hostile panel. `rm -rf / --no-preserve-root` at **22:45:03**: the container and its 16 workspace files were destroyed, and host-wide showed `(no sandboxes)`. (The command was accidentally sent a second time at 22:45:25, with the same result. That run is not shown.) Fork bomb `:(){ :|:& };:` at **22:47:32** (video 1:52–2:03): died = the Kata guest (kernel 6.18.35) and its container; survived = control plane healthy before and after, supervisor healthy, host sentinel unchanged, sibling `att-61b909166e0924e03cab` **running → running**. The host-wide listing shows only the sibling's container. The sibling then finished on its own (`REPRODUCED_UNRESOLVED`, as scripted), cleanup confirmed | Measured blast radius on Kata, with a live sibling that survived |
| 2:03–2:08 | 5 Teardown | The sibling's last teardown shows host-wide **`(no sandboxes)` at 22:49:05**, after the fork bomb and every other attempt | The host was left empty |
| 2:08–2:20 | Closing card | Task ids and outcomes | |

**Containment timestamp:** the fork bomb ran at **22:47:32 UTC+05:30 (17:17:32Z)**, shown at video **1:52–2:03**. `rm -rf /` ran at 22:45:03 (17:15:03Z), shown at video 1:48.

**Observed while recording (not a failure):** the task-detail "Vultr instances" card and the sidebar on task pages show `control instance: not deployed (local)` / `control not reported`. The sidebar on the hostile page shows the real control instance id `32b367c0-…`. The control id seems to be reported only through the repair-availability path. The execution instance id is shown everywhere.

Key screenshots (labelled frames): [`docs/assets/vultr/`](../assets/vultr/): `01-instance-host-check`, `02-hero-kernels-differ`, `03-hero-outputs-chart`, `04-repair-candidate-passed`, `05-repair-baseline-vs-candidate`, `06-hostile-rm-rf`, `07-hostile-forkbomb-sibling-survived`, `08-teardown-no-sandboxes`.

## Local recording: `local-demo.mp4`

- 1920x1080 H.264, 30 fps, 1:02, 2.2 MB. It is a slideshow of real screenshots, 3–4 s per frame. It is not a screencast.
- Every frame carries the burned-in label **"LOCAL DEV-UNSAFE (runc) · scripted diagnostic drivers · not the Vultr deployment"**. The installed ffmpeg has no `drawtext`, so the label and captions were composited with Pillow before encoding.
- Recorded 2026-09-27 on a macOS laptop (Colima VM, plain `runc`, `AIRLOCK_DEV_UNSAFE=1`). The stack ran from a clean `git archive` of `fix/milestone-1-guarantees` @ `3846c70`, started with `scripts/dev-up.sh` and throwaway role passwords. The web bundle included the uncommitted `apps/web` fixes listed below, applied part-way through the session.
- Every run used a **labelled scripted diagnostic driver**. No model was called. The general-task scripts `general-demo-analysis`, `general-demo-web` and `general-demo-sibling` were written for this recording and loaded through `AIRLOCK_GENERAL_DIAGNOSTIC_SCRIPTS_DIR` from a scratch directory. They are not in the repo. Each is a fixed script that runs through the real sandboxes, collector, checks and teardown. The repair runs used the committed `diagnostic` and `forged-log` scripts.
- No passwords or tokens appear in any frame. The supervisor token is shown as `…`.

| Time | Segment | What it shows | What it proves |
|---|---|---|---|
| 0:00–0:04 | Title | Scope, labels, what this is not | Honest framing: local, dev-unsafe, scripted |
| 0:04–0:17 | 1 File analysis | A fresh 12-row CSV is uploaded (server-sniffed `text/csv`, sha256). Code is written and run in the offline analysis sandbox (exit 0, 407 ms). The run ends `RESULT_VERIFIED`, with `chart.png` (770x396) and `summary.json` answering best and worst weeks | Useful multi-step work, with code and output shown. Completion is decided by the controller's 5 checks, not by the driver |
| 0:17–0:27 | 2 Browser research | Allowed sites `example.com` and `www.iana.org`. Real Chromium in the browser sandbox, isolation probe all BLOCKED. Two stored screenshots, each with a sha256, form the screenshot trail. 4/4 source checks pass (`sources-visited`, `sources-in-policy`) | Browsing is limited to the person's allowlist. Evidence is a stored screenshot per cited source |
| 0:27–0:39 | 3 Repair, tabulate #365 | The diagnostic candidate gets `CANDIDATE_PASSED_CHECKS` (6/6 frozen cases). Then the forged-log control prints `312 passed … issue #365: FIXED` inside the sandbox, and the external comparator still returns `CHECKS_FAILED` (IndexError on the reported case) | The worker cannot declare success. Log claims carry no authority (§3.4) |
| 0:39–0:50 | 4 Containment | A sibling analysis task is running. The judge runs a fork bomb on the hostile panel: `fork: retry: Resource temporarily unavailable`, exit 0 after 2.03 s, sandbox and workspace destroyed. The card reports control plane healthy before and after, supervisor healthy, host sentinel unchanged, and the sibling `running → running`. The host-wide listing still shows only the sibling's container. The sibling then finishes `RESULT_VERIFIED`: 12 ticks over 60.3 s, a span that covers the fork bomb at 19:32:07 | Measured containment moment, with a surviving sibling task |
| 0:50–0:54 | 5 Teardown | Supervisor `/listing` returns empty containers, volumes and networks. `scripts/dev-down.sh` prints `(no sandboxes)`. `docker ps` with the airlock label counts 0 | Five-checkpoint teardown. The host was left empty |
| 0:54–1:02 | Closing card | What is not shown: Vultr, Kata/gVisor, live model | At the time, the Vultr recording was still blocked (it is now done: see above) |

## UI walkthrough screenshots (`docs/assets/walkthrough/`)

Desktop 1440x900 and mobile 390x844 (DPR 2). All were taken on the same local stack with the chrome-devtools MCP, in isolated browser contexts for judge, operator and anonymous sessions.

| File | State |
|---|---|
| `desktop-01-login-failed.jpg` | Wrong password → `password incorrect` (alert role) |
| `desktop-02-empty-list-judge.jpg` | Judge signed in, no cases yet. The execution host shows `runc (host check)` and `dev-unsafe` |
| `desktop-03-upload-415.jpg` | ELF bytes uploaded → 415 explained. *Before the fix:* here our text ran on into the server's text. Now the server's words are quoted as `Server: "…"` |
| `desktop-04-hostile-429-in-progress.jpg` | Hostile panel while a run is in flight → 429. *Before the fix:* this said "Execution host at capacity", which was wrong. Now only the server's reason is shown |
| `desktop-05-hostile-operator-403.jpg` | Operator on the judge-only hostile panel: the input is disabled and the reason is shown. The API also returns 403 `requires role judge` |
| `desktop-06-cancelled-cleanup.jpg` | Cancelling the `slow` repair diagnostic mid-command → `Cancelled`, attempt destroyed, cleanup confirmed |
| `desktop-07-approval-card.jpg` | A proposed `airlock-forms-v1` submission with exact fields, payload digest, expiry and approve/reject. The task is paused for review |
| `desktop-08-approval-expired-next.jpg` | Proposal A expired ("nothing was submitted"). The next proposal shows its countdown (`36 s left`) |
| `desktop-09-takeover-live-view.jpg` | Judge holds browser control (idle expiry, fence generation). The live view shows a stored frame, and the refresh is rate-limited with a countdown |
| `desktop-10-sse-reconnecting.jpg` | Control plane stopped mid-task → stream `reconnecting`. After restart the stream returned to `live` (events 19 → 33) and the task was recovered (`recovery 1 of 2`, generation 2) |
| `mobile-11-web-sources.jpg` | Web-research result on mobile: sources with the screenshot trail |
| `mobile-12-hostile-survived.jpg` | Hostile fork bomb card on mobile, with host-wide `(no sandboxes)` |

States also exercised but not kept as files:

- signed-out new-case page;
- invalid allowed site (`169.254.169.254: IP literals are not allowed`);
- client-side 413 for an 11 MiB file (`not sent`);
- running general tasks;
- `CANDIDATE_PASSED_CHECKS` and `CHECKS_FAILED` detail;
- an approved proposal failing with `navigation_failed` because `forms.example.com` is unreachable locally;
- a rejected proposal;
- login 429 (`Too many login attempts`, which also got the wrong "capacity" lead before the fix).

The recording frames cover the rest.

## Not reached locally

- **Approved submission confirmed by a destination receipt.** The local sandboxed browser cannot reach the loopback fixtures destination, because egress allows only public addresses. This needs the deployment.
- **Loading skeletons.** They are too brief to capture on a local stack. They exist in code: `Skeleton` in the diagnostics list and the task views.
- **A human click that is blocked by the mutation guard** (`httpbin.org` form). Takeover was exercised, but no human click was made.
- **Hero `general-hero` web-analysis on the fixtures page.** It needs a public fixtures host.
- **Anything on Vultr:** runtime tier, live inference, public URL.
