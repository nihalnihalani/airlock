# Third-party notices

Airlock adapts code and design from two MIT-licensed repositories. Every copied or adapted file is listed here with its upstream pin, path and what changed, so "built at the event vs reused" is reconstructible from this file plus git history. Upstream MIT notices are preserved in the headers of the adapted files.

- **OpenMuse** — pin `205cc386b75aae1a862f3fdd43104b570c8d0911` — MIT License, Copyright (c) 2026 OpenMuse contributors — https://github.com/CopilotKit/openmuse
- **OpenBot** — pin `3c73cf00efba46122dfd0447485e2b61f1d6a2cd` — MIT License, Copyright (c) 2026 CopilotKit — https://github.com/CopilotKit/openbot

Local clones at those pins live in `research/reference-repos/` (gitignored). Neither complete upstream application is deployed or used as a composition root; both require the hosted CopilotKit Intelligence service, which Airlock does not depend on.

## apps/supervisor (execution plane)

| Airlock file | Upstream path | Modifications |
|---|---|---|
| `apps/supervisor/src/names.ts` | OpenBot `supervisor/src/names.ts` | Bot id → (taskId, attemptId, role) triple and operation ids; derived container/volume/collector names; labels `airlock.supervisor/namespace/task/attempt/role/operation`; namespace from `AIRLOCK_NAMESPACE`; `ours()` requires the namespace label (no default-namespace adoption); `ownedFilter()` added. |
| `apps/supervisor/src/docker-api.ts` | OpenBot `supervisor/src/docker.ts` (design: narrow vocabulary, no passthrough) | Reduced to an interface over dockerode so the lifecycle can be tested against a fake; no ensure/reset/healthcheck/port publishing/SPIRE. |
| `apps/supervisor/src/runtime.ts` | OpenBot `supervisor/src/docker.ts` (dockerode verbs, tolerated 304/404/409, ownership on inspect); OpenMuse `apps/server/src/computer.ts` ~L200–320 (create flags and effective-config inspection, fail closed) | dockerode instead of the docker CLI; per-attempt disposable identity; `Runtime` set from `AIRLOCK_RUNTIME` and verified on inspection; guest `uname`/`hostname` read via exec; image digest recorded; caps from the profile; env allowlist widened for the python image; read-only `/candidate` mount variant for the collector; no `RestartPolicy unless-stopped`, no port bindings, no `ShmSize`. |
| `apps/supervisor/src/exec.ts` | OpenMuse `apps/server/src/computer.ts` ~L590–750 (`execute`: timeout wrapper argv, quarantine on timeout/interruption, receipt statuses) | Runs through the Docker exec API with a multiplexed-stream demuxer instead of spawning the docker CLI; combined output cap per profile with `truncated`; `controlLost` flag drives the caller's stop-and-quarantine; exit 124 → `timed_out`; unknown exit → `interrupted`, never a receipt. |
| `apps/supervisor/src/errors.ts` | OpenBot `supervisor/src/docker.ts` (`NameHeldError`, `DockerUnavailableError`) | Single `SupervisorError` with a code → HTTP status table. |
| `apps/supervisor/src/index.ts` | OpenBot `supervisor/src/index.ts` | Bun + Hono, bearer auth except `/health`, refusal to start without the token retained; routes replaced by the Airlock attempt/invoke/hostile API; constant-time token compare; body size bound and request-digest verification; runtime/dev-unsafe startup checks; graceful shutdown. |
| `apps/supervisor/src/lifecycle.ts` | OpenMuse `apps/server/src/computer.ts` (record-before-dispatch, lease re-check before exec, stop-and-quarantine on lost exec, stop `--time 2`) | New: per-attempt lock, revoke signal, absolute-deadline timer, freeze ordering (revoke → stop → settle → inspect stopped → collector), tombstones, janitor/reconcile, teardown listing. No DB lease/CAS; the sqlite journal replaces OpenMuse Store. |

Written from scratch (no upstream code): `config.ts`, `tar.ts`, `host.ts`, `probe.ts`, `profiles.ts`, `operations.ts`, `invoke.ts`, `hostile.ts`, `types.ts`, all of `apps/supervisor/test/`.

## apps/control (control plane)

| Airlock file | Upstream path | Modifications |
|---|---|---|
| `apps/control/src/store/index.ts` | OpenMuse `apps/server/src/db.ts` | PGlite only (`pg` pool, `claim`, `recoverInterruptedActions`, `updateCredential` removed). Added `insertImmutable` (INSERT … ON CONFLICT DO NOTHING RETURNING → boolean), an append-only `events` table with `appendEvent` (per-task monotonic `seq` assigned in the INSERT) and `listEvents(taskId, afterSeq)`, `scanWhere`, and an `unset` key list on `compareAndSwap`. |
| `apps/control/src/worker/index.ts` | OpenMuse `apps/server/src/engine/worker.ts` | Typed to the contracts `Task`/`TaskStatus`; `scheduled`/`waiting_approval`/action-expiry branches removed. `cancelling` tasks are claimed only to run the cancellation path; lost lease on `cancelling` releases the lease instead of requeueing. Events via `Store.appendEvent` plus an in-process bus; `splitPatch` for key removal; `backgroundFailure` moved in from `log.ts`. `LostLeaseError` semantics unchanged. |
| `apps/control/src/sessions.ts` | OpenMuse `apps/server/src/auth.ts` | Hashed-token idea only (store sha256(token), never the token). Rewritten for two role passwords + a viewer role, an HttpOnly cookie instead of a bearer header, a login rate limiter; HMAC-signed document links removed. |
| `apps/control/src/api.ts` | OpenMuse `apps/server/src/engine/routes.ts`, `apps/server/src/errors.ts` | `AppError` shape and task-route layout; all routes, role checks, ownership checks, SSE replay, preview/export/hostile are Airlock code. |
| `apps/control/src/repair-handler.ts` | OpenMuse `apps/server/src/engine/model.ts` | Pattern only (guard before every tool, serial tool dispatch, schema-validated arguments, tool errors fed back as results). No code copied: the tool inventory, AG-UI runtime and model-owned finish semantics are replaced by the deterministic phase machine. |

No files under `apps/control` copy OpenBot code. `verifier/`, `artifacts/`, `vultr-client.ts`, `vultr-probe.ts`, `profiles.ts`, `config.ts`, `events.ts`, `prompts.ts`, `supervisor-client.ts` and `scripts/probe-model.ts` are new Airlock code (OpenMuse `engine/model.ts` is built on CopilotKit/AG-UI and was not reusable for a chat-completions driver).

## apps/web

The UI's look and layout follow OpenBot's app (`app/`, pin above). Copied or adapted files keep the MIT header:

| Airlock file | Upstream path | Modifications |
|---|---|---|
| `apps/web/src/styles.css` | OpenBot `app/src/styles.css` | OpenBot's oklch palette (light and dark), radii, `@theme inline` block, base layer, scrollbar and `.tool-line-running` shimmer kept. Dropped the shadcn, prompt-area and streamdown imports and the websandbox rule; added a `--warning` token; dark palette and `dark:` variant follow `prefers-color-scheme` in CSS instead of a stored `.dark` class. The `data-open`/`data-closed`/`data-active`/`data-horizontal`/`data-vertical` variants and `no-scrollbar` are re-declared from `shadcn/tailwind.css` (MIT, shadcn); `scroll-fade-b` is a static simplification. |
| `apps/web/src/components/ui/button.tsx` | OpenBot `app/src/components/ui/button.tsx` | Imports made relative. |
| `apps/web/src/components/ui/tooltip.tsx` | OpenBot `app/src/components/ui/tooltip.tsx` | Imports made relative; `"use client"` dropped. |
| `apps/web/src/components/ui/separator.tsx` | OpenBot `app/src/components/ui/separator.tsx` | Imports made relative. |
| `apps/web/src/components/ui/skeleton.tsx` | OpenBot `app/src/components/ui/skeleton.tsx` | Imports made relative. |
| `apps/web/src/components/ui/input.tsx` | OpenBot `app/src/components/ui/input.tsx` | Imports made relative. |
| `apps/web/src/components/ui/textarea.tsx` | OpenBot `app/src/components/ui/textarea.tsx` | Imports made relative. |
| `apps/web/src/components/ui/message.tsx` | OpenBot `app/src/components/ui/message.tsx` | Imports made relative. |
| `apps/web/src/components/ui/bubble.tsx` | OpenBot `app/src/components/ui/bubble.tsx` | Imports made relative. |
| `apps/web/src/components/ui/empty.tsx` | OpenBot `app/src/components/ui/empty.tsx` | Imports made relative. |
| `apps/web/src/components/ui/item.tsx` | OpenBot `app/src/components/ui/item.tsx` | Imports made relative. |
| `apps/web/src/components/ui/sheet.tsx` | OpenBot `app/src/components/ui/sheet.tsx` | Imports made relative. |
| `apps/web/src/components/ui/sidebar.tsx` | OpenBot `app/src/components/ui/sidebar.tsx` | Imports made relative; `"use client"` dropped; `keyOf` inlined from `app/src/lib/hotkeys/hotkeys.ts`. |
| `apps/web/src/components/ui/message-scroller.tsx` | OpenBot `app/src/components/ui/message-scroller.tsx` | Same slots, classes and scroll-to-end button; the `@shadcn/react/message-scroller` primitive underneath is replaced by a small stick-to-bottom hook (`useStickToBottom`), so that package is not a dependency. |
| `apps/web/src/components/layout/sidebar-shell.tsx` | OpenBot `app/src/components/layout/sidebar-shell.tsx` | Imports made relative; localStorage access wrapped in try/catch. |
| `apps/web/src/components/layout/sidebar-toggle.tsx` | OpenBot `app/src/components/layout/sidebar-toggle.tsx` | Imports made relative. |
| `apps/web/src/components/layout/row-mark.tsx` | OpenBot `app/src/components/layout/row-mark.tsx` | Imports made relative. |
| `apps/web/src/components/layout/detail-panel.tsx` | OpenBot `app/src/components/layout/detail-panel.tsx` | `motion` removed: CSS width transition and tw-animate-css fade instead; imports made relative. |
| `apps/web/src/hooks/use-mobile.ts` | OpenBot `app/src/hooks/use-mobile.ts` | Unchanged apart from the header. |
| `apps/web/src/lib/utils.ts` | OpenBot `app/src/lib/utils.ts` | Unchanged apart from the header (`cn`). |
| `apps/web/src/lib/sidebar.ts` | OpenBot `app/src/lib/sidebar.ts` | Storage key renamed to `airlock-sidebar`. |
| `apps/web/src/components/app-sidebar/app-sidebar.tsx` | OpenBot `app/src/components/app-sidebar/app-sidebar.tsx, channel-item-content.tsx` | Rewritten for Airlock data: the roster is the polled task list (issue title, profile, status dot, outcome badge, relative time, scripted tag), Hostile input as a pinned channel, role footer with sign in/out. Header/brand row, search field, row anatomy and classes, empty states and rail kept. No TanStack Router/Query, motion, dropdown or channel mutations. |
| `apps/web/src/pages/LoginPage.tsx` | OpenBot `app/src/routes/sign.tsx` | Centred column, mark, heading and full-width outline controls kept; OAuth/SSO providers replaced by the role password form, "Continue as viewer" and the current role; CSS entrance stagger instead of motion. No better-auth. |

Design only, no code copied: `components/thread/tool-card.tsx` and the row disclosures follow OpenBot's `components/channels/tool-line.tsx` (one line, native `<details>`, rotating chevron); `components/thread/composer-frame.tsx` uses the classes of OpenBot's compact composer (`components/channels/composer/composer.tsx`); `components/layout/page-header.tsx` is the 48px channel header of `routes/_authed/_app/channel/$channelId.tsx`; the thread column (`max-w-2xl`, `gap-6`, user bubble `muted`, assistant bubble `ghost`) follows `components/channels/chat-transcript.tsx`. Airlock renders no Markdown (OpenBot's Streamdown is not used) and depends on no CopilotKit, AG-UI or better-auth package.

New Airlock code: `lib/thread.ts`, `lib/taskList.ts`, `lib/eventLog.ts`, `lib/eventViews.ts`, `lib/preview.ts`, `lib/api.ts`, `lib/router.ts`, `lib/format.ts`, the hooks `session.tsx`, `useTaskEvents.ts`, `useTaskList.ts`, `components/common.tsx`, `components/thread/*`, `components/detail/*`, the panels in `components/*.tsx`, the other pages and all of `apps/web/test/`.

## Browser plane: runtime/browser and apps/egress (milestone 3)

Adapted at newer upstream pins than the files above; existing files keep their original pins.

- **OpenBot** — pin `1ac9c35b393152e8d7e76c2331b8d5b584ba0e13` (MIT, Copyright (c) 2026 CopilotKit)
- **OpenMuse** — pin `34b15bc80340e582fb8c25573646cfb0bbc5184d` (MIT, Copyright (c) 2026 OpenMuse contributors)

| Airlock file | Upstream path | Modifications |
|---|---|---|
| `runtime/browser/src/aria.mjs` | OpenBot `agent-computer/src/aria-snapshot.ts` | Snapshot parsing only, as dependency-free ESM; refs bound to a snapshot generation; control limit raised to 300; bounded fields. |
| `runtime/browser/src/runner.mjs` | OpenBot `agent-computer/src/profiles.ts`, `agent-computer/src/index.ts` | One persistent headless Chromium per container with a transient `/tmp` profile, Chromium's sandbox on, proxy-only networking, QUIC off, WebRTC limited to proxied UDP, downloads and service workers disabled; the HTTP/token API is replaced by a unix-socket framed protocol; no evaluate/CDP operations; dialogs are dismissed and held for review. |
| `apps/egress/src/policy.ts` | OpenMuse `apps/worker/src/network.ts` (`isPublicIp`) | IPv6 parsing hardened; IPv4-mapped and CGNAT ranges refused; host allowlist matching (exact or `.suffix`). |
| `apps/egress/src/proxy.ts` | OpenMuse `apps/worker/src/proxy.ts` | CONNECT and absolute-URI GET only; resolve once and connect to the validated address (no rebinding); per-attempt allowlist and ports from env; bounded tunnel lifetime and bytes; one JSON decision line per request. |

Written from scratch: `runtime/browser/src/{client,protocol,state}.mjs`, `runtime/browser/demo.sh`, `runtime/browser/seccomp/derive.py`, `apps/egress/src/index.ts`, all tests. `runtime/browser/seccomp/chromium.json` is Docker's default seccomp profile (moby/profiles v0.1.0, Apache-2.0) plus one rule allowing `clone`/`unshare`/`chroot` for Chromium's own sandbox.

## runtime/python and profile adapters

No source code in `runtime/python/` or `profiles/tabulate-365/airlock_adapter_tabulate.py` is copied from either upstream. Design ideas taken, with no code carried over:

| Airlock file | Upstream path | Modifications |
|---|---|---|
| `runtime/python/collector.py` | OpenBot `agent-computer/src/workspace.ts` (three-layer path confinement idea; bounded read limits) | Re-implemented in Python. Exact allowlist instead of workspace-relative resolution; symlink check at every component via `lstat`; hard-link, special-file and TOCTOU (`fstat` inode match) checks added; reads stream in 64 KiB chunks with a cap instead of reading the whole file before truncating. |
| `runtime/python/materialize.py` | OpenBot `agent-computer/src/workspace.ts` (write confinement idea) | Re-implemented in Python for a fixed base → target copy plus allowlisted overlay; no code reused. |
| `runtime/python/Dockerfile` | OpenMuse `apps/server/src/computer.ts` (idle `sleep infinity` sandbox process, non-root / read-only expectations) | Different image and layout; no code reused. |

## packages/contracts

New Airlock code. The `plainId` identifier discipline derives from OpenBot `supervisor/src/names.ts` (letters, digits, hyphen, underscore; identifiers are validated before they become any kind of name).

## python-tabulate (profile `tabulate-365`)

MIT License, Copyright (c) 2011-2020 Sergey Astanin and contributors. https://github.com/astanin/python-tabulate

`profiles/tabulate-365/base/` is the pristine tracked tree at `e13a4d0dd292cade200e653eb9155a1ca0f1dbea`, produced by `runtime/python/prepare-profile.sh` (`git archive`, no `.git`) and verified against `baselineTreeDigest`. It is the untrusted candidate base for the historical replay and is copied unchanged into the runtime image at `/opt/airlock/base/`. It is not part of Airlock's codebase; its `LICENSE` file is included in the tree. The maintainer reference commit `87a9a4e07a5efb39b81fdb6ac513b1d345bb21fb` was used only to measure the acceptance contract and is never supplied to any sandbox.

## Runtime base image

`python:3.12-slim` (Docker Official Image; Python is PSF-licensed, Debian components under their respective licenses). The digest observed at build time is recorded in `runtime/python/Dockerfile`.
