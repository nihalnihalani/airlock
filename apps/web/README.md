# @airlock/web

React + Vite UI for Airlock. It talks only to the control API (`/api/...`) and renders authoritative
REST/SSE state; it never runs candidate code, never renders API text as HTML, and never decides that
a run passed.

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
wherever the control app serves it.

## Screens (hash routes)

| Route | Screen |
|---|---|
| `#/login` | Password → role (`operator` / `judge`). Viewers read without signing in. |
| `#/new` (default) | Profile selector fed by `GET /api/profiles` (display name, issue link, baseline commit, "historical replay" label, what the agent may change/read, caps), a paste box for the issue text (the UI ships no issue text), Start. API rejections are shown verbatim. |
| `#/tasks` | All tasks (every owner) with status, phase and outcome. Task lists, task pages and event streams are readable by the viewer role without signing in, including the pasted issue text, every model turn and the output of every command the model runs (which can include candidate file contents); only the sealed zip needs an export grant. See the control README's route table. |
| `#/tasks/:id` | Task page: phase rail, status/outcome badges, runtime tier chip (with dev-unsafe warning), live stream badge, Cancel; Five checkpoints panel; Baseline vs candidate table; sealed manifest; Report Export preview and Download (only when the outcome is `CANDIDATE_PASSED_CHECKS`); Model calls; Tool/exec log; full event timeline. |
| `#/hostile` | Judge/operator only. Command box with quick buttons; renders the `BlastRadiusCard` (Died vs Survived, execution, teardown). |

## Live events

`useTaskEvents` opens `EventSource` on `/api/tasks/:id/events`. The browser sends `Last-Event-ID`
(= `seq`) on its own reconnects; when the stream is closed for good the hook reopens it with
backoff and `?lastEventId=<seq>` so replay continues after what is already shown. Events are
validated against `RunEvent`, deduplicated by `seq`, kept in order and bounded to 4000 in memory
(older ones are dropped from the view and counted). The task view is also polled every 4 s while the
task is not terminal, so a dead stream or a controller restart is visible and recoverable.

## Trust notes

- All API strings are rendered as React text nodes; there is no `dangerouslySetInnerHTML`.
- The preview form builds `tabulate` kwargs from bounded inputs (≤ 8 columns, ≤ 3 rows, ≤ 64 chars
  per cell, header width 1–200) and always sends the task's sealed `candidateDigest`; the returned
  text is shown in a `<pre>` together with the digest it ran against.
- The result badge reads "Passed these checks" and its tooltip states that this means exactly the
  frozen cases passed on a sealed candidate, not safe/certified/correct.
- The runtime tier is whatever the supervisor inspected; `runc` is always labelled dev-unsafe.
- Download links point only at `/api/exports/:grantId`; the grant id is URL-encoded.

## Layout

```
src/
  main.tsx, App.tsx, styles.css      shell, nav, role badge, hash router
  lib/api.ts                          typed fetch client, contract validation, error extraction
  lib/eventLog.ts                     bounded/deduplicated event log (pure)
  lib/eventViews.ts                   model-call, exec-log and checkpoint projections (pure)
  lib/preview.ts                      preview form → PreviewRequest.input, result → text (pure)
  lib/router.ts, lib/format.ts
  hooks/session.tsx, hooks/useTaskEvents.ts
  components/                         panels and primitives
  pages/                              Login, NewCase, Tasks, Task, Hostile
test/                                 bun tests for the pure modules
```

Dependencies are exactly those in `package.json`: React, React DOM, zod and `@airlock/contracts`.
No UI library; one stylesheet with light/dark tokens.
