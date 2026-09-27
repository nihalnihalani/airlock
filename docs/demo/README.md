# Local demo recording (dev-unsafe) and UI walkthrough

**Status of the required demo:** the Vultr demo recording (useful work, measured containment and teardown on the two-VM deployment with Kata/gVisor and live inference) is **incomplete: blocked** on Vultr deployment access and `VULTR_INFERENCE_API_KEY` (see [runbook](../runbook.md), submission checklist). What follows is a clearly labelled **local** recording. It does not replace the Vultr recording.

## `local-demo.mp4`

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
| 0:54–1:02 | Closing card | What is not shown: Vultr, Kata/gVisor, live model | The required Vultr recording is still blocked |

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
