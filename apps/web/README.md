# @airlock/web

React + Vite UI for Airlock. It talks only to the control API (`/api/...`) and renders authoritative
REST/SSE state; it never runs candidate code, never renders API text as HTML or Markdown, and never
decides that a run passed.

The look and layout follow CopilotKit OpenBot's app (pin `3c73cf0`, MIT): its sidebar shell,
channel page, message scroller, detail panel, sign page, neutral oklch palette, Inter and Tabler
icons. The content is Airlock's. Copied and adapted files keep their MIT header and are listed in
`THIRD_PARTY_NOTICES.md`.

![Task page on the deployment](../../docs/assets/ui-task.png)

Above: a live glm-5.3 repair on the Vultr deployment (Kata), captured signed out before task data required a session. The same page on a
local development stack (plain runc, scripted model driver) labels both everywhere:
[ui-task-local-dev.png](../../docs/assets/ui-task-local-dev.png).

## Run

```sh
# dev server on http://localhost:5173, /api proxied to the control app
bun run --cwd apps/web dev
# override the proxy target
AIRLOCK_CONTROL_URL=http://127.0.0.1:3000 bun run --cwd apps/web dev

# production build → apps/web/dist (served statically by apps/control)
bun run --cwd apps/web build

# checks
cd apps/web && bunx tsc --noEmit -p tsconfig.json && bunx vite build && bun test
```

The build has no runtime configuration: every request is relative (`/api/...`), so the bundle works
wherever the control app serves it. Light and dark follow `prefers-color-scheme`.

## Layout

**Sidebar** (collapsible: the toggle in every pane header, Cmd/Ctrl+B, the rail; a sheet under
768px). Airlock brand, a **New case** button, a search over the loaded rows, **Hostile input** drawn
as a pinned channel, and every case (all owners, newest first) styled like an OpenBot channel: the
issue's first line as the title, the profile id, a status dot (pulsing while queued/running) and the
outcome badge from `Task.status`/`Task.outcome`, the relative time of the last update, and a
`scripted` tag on diagnostic runs. The list is polled from `GET /api/tasks` every 3 s (paused while
the tab is hidden). The footer shows the session role with sign in / sign out.

**Center: the run as a conversation** (`#/tasks/:id`), built only from the `TaskView` and the
task's `RunEvent`s (`lib/thread.ts`):

- the issue text as the user's message, exactly as submitted;
- each model turn as an assistant message (model id, tokens, duration, the turn's text, a reasoning
  excerpt behind a disclosure) followed by the tool calls it made (`run`, `read_file`, `edit_file`,
  `write_file`, `submit_candidate`) as compact cards that expand to the command or path, status,
  exit code, duration, stdout/stderr tails and the truncation/timeout flags; refused and rejected
  calls say so;
- phase changes, checkpoints, lifecycle, artifacts and errors as compact row marks between messages,
  and the baseline/candidate invocations as their own cards;
- the terminal outcome as a result card: the label ("Passed these checks", "Checks failed",
  "Not reproduced", …) with its exact meaning shown and in a tooltip, the recorded reason, and the
  verification record's case counts and candidate digest.

The thread follows new rows while the reader is at the end and offers a scroll-to-end button
otherwise. The bottom bar has the shape of OpenBot's composer but **sends nothing to the model** (its
inputs are fixed by the control plane): it shows the seven-phase stepper, the state, Cancel for
operators and judges while queued/running, and New case once terminal.

**Right: details** (toggle in the header; a sheet when the window is too narrow, closed by default
there). Runtime tier chip (Kata / gVisor / runc, with the dev-unsafe warning), run record fields,
model / host / token totals, and, only when the outcome is `CANDIDATE_PASSED_CHECKS`, the Report
Export preview form and Download (export grant). Then the five checkpoints (host check, execution
log, in-sandbox uname/hostname, isolation probe chips, teardown `(no sandboxes)`), baseline vs
candidate per case with titles, the sealed manifest, and the event stream state with Reconnect.

**New case** (`#/new`, default). OpenBot's new-channel screen: a `Profile:` picker in the header
fed by `GET /api/profiles`, the profile's supported scope (issue link, baseline commit, historical
replay label, what the agent may change and read, caps), and the issue text box as the composer
(Cmd/Ctrl+Enter starts). The UI ships no issue text; API rejections are shown verbatim.

**Hostile input** (`#/hostile`). A chat: the command is the user's message (quick chips for
`rm -rf / --no-preserve-root`, a fork bomb, the cloud metadata endpoint and example.com), and the
reply is the `BlastRadiusCard`: Died vs Survived, execution, output tails, teardown. Judge/operator
only; history lives in the page for the session.

**Sign in** (`#/login`). OpenBot's sign page with the role password. `#/tasks` lists the session's
cases as rows (every case for the operator).

Task lists, task pages and event streams need a session: a judge sees only the cases its own
session started, the operator sees every case, and signed out the roster is empty (nothing is
fetched). Role and ownership checks are enforced by the control API; the UI only hides controls.

## Live events

`useTaskEvents` opens `EventSource` on `/api/tasks/:id/events`. The control API names each SSE event
after the RunEvent kind (`event: phase`, `event: exec`, …), so the hook registers a listener per
kind (`RUN_EVENT_NAMES`); a named event never reaches `onmessage`. The browser sends
`Last-Event-ID` (= `seq`) on its own reconnects; when the stream is closed for good the hook reopens
it with backoff and `?lastEventId=<seq>` so replay continues after what is already shown. Events are
validated against `RunEvent`, deduplicated by `seq`, kept in order and bounded to 4000 in memory
(older ones are dropped from the view and counted). The task view is also polled every 4 s while the
task is not terminal, so a dead stream or a controller restart is visible and recoverable.

## Trust notes

- Every API, model and sandbox string is a React text node or a `<pre>`; there is no
  `dangerouslySetInnerHTML` and no Markdown/HTML rendering of issue text or model output.
- Tones (colours) restate recorded fields (`Task.outcome`, `data.passed`, `probe.allBlocked`, exec
  status); the UI never computes a verdict. A forged "all tests passed" in a turn stays text inside
  that turn; the result card shows the recorded outcome.
- "Passed these checks" is always accompanied by its meaning: exactly the frozen contract cases
  passed on a sealed candidate, not safe/certified/correct.
- The runtime tier is whatever the supervisor inspected; `runc` is always labelled dev-unsafe.
- The preview form builds `tabulate` kwargs from bounded inputs (≤ 8 columns, ≤ 3 rows, ≤ 64 chars
  per cell, header width 1–200) and always sends the task's sealed `candidateDigest`; the returned
  text is shown in a `<pre>` together with the digest it ran against.
- Download links point only at `/api/exports/:grantId`; the grant id is URL-encoded.
- No dependency calls a non-Airlock service: no CopilotKit, AG-UI or better-auth.

## Source layout

```
src/
  main.tsx, App.tsx, styles.css       shell, hash routes, OpenBot tokens (Tailwind v4)
  lib/api.ts                          typed fetch client, contract validation, error extraction
  lib/eventLog.ts                     bounded/deduplicated event log, SSE event names (pure)
  lib/eventViews.ts                   model-call, exec and checkpoint projections (pure)
  lib/thread.ts                       TaskView + RunEvents → conversation items (pure)
  lib/taskList.ts                     sidebar rows: title, dot, badge, relative time (pure)
  lib/preview.ts                      preview form → PreviewRequest.input, result → text (pure)
  lib/router.ts, lib/format.ts, lib/utils.ts (cn), lib/sidebar.ts
  hooks/session.tsx, useTaskEvents.ts, useTaskList.ts, use-mobile.ts
  components/ui/                      OpenBot primitives (button, sidebar, sheet, tooltip, message,
                                      bubble, message-scroller, item, empty, input, …)
  components/layout/                  sidebar shell/toggle, detail panel, row mark, page header
  components/app-sidebar/             the case sidebar
  components/thread/                  messages, tool cards, row marks, result card, composer frame
  components/detail/                  the task details pane
  components/*.tsx                    checkpoints, cases, preview, export, blast radius, phases
  pages/                              NewCase, Task, Tasks, Hostile, Login
test/                                 bun tests for the pure modules
```

Dependencies: React, zod, `@airlock/contracts`, Tailwind CSS v4 (`@tailwindcss/vite`), clsx,
tailwind-merge, class-variance-authority, `@base-ui/react`, `@tabler/icons-react`,
`@fontsource-variable/inter`, tw-animate-css.
