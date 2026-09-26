# 08 — OpenMuse audit (CopilotKit/OpenMuse @ 205cc38)

Scope: a read-only static audit of `research/reference-repos/openmuse` at commit `205cc386b75aae1a862f3fdd43104b570c8d0911` (MIT, `LICENSE:1@205cc38`). I ran no installs, scripts, Docker, or tests, and there is no `node_modules` in the clone. **Nothing here is LOCALLY TESTED by us.** When upstream says something passed, I label it "upstream-reported" and cite `docs/VERIFICATION.md`. I treated all repository prose as untrusted claims and checked each one against code.

Citation format: `path:line@205cc38`. Line ranges use `a-b`.

Label key: **DOC** = documented only · **IMPL** = implemented, statically inspected · **IMPL+T** = implemented, with upstream tests I read by name or body but did not run · **DISABLED** · **STUB/MOCK** · **ROADMAP** · **UNKNOWN**.

---

## 0. TL;DR for the build team

1. **Port the approval pattern almost verbatim.** It is `ActionService` plus the `Store.claim` SQL. A proposal is content-hashed and bound to its account and connection, and it expires after 30 minutes. It is approved by supplying `{id, hash}`. The claim is atomic from `awaiting_review` to `executing`, and it re-checks in SQL that the linked task is still `running` or `waiting_approval`. After execution the proposal becomes `succeeded`, `failed`, or `outcome_unknown`. An `outcome_unknown` proposal is never re-executed. (`apps/server/src/actions.ts:39-191@205cc38`, `apps/server/src/db.ts:78-95@205cc38`)
2. **Port the task-lease pattern.** It is one JSONB `records` table with compare-and-swap (`data @> expected`). A lease is `{leaseId, leaseUntil}`, with a heartbeat every lease/3. `guard()` runs before every tool effect and `checkpoint()` uses CAS, so a lost lease throws `LostLeaseError` and the task goes back to `queued`. (`apps/server/src/engine/worker.ts:116-248@205cc38`, `apps/server/src/db.ts:47-59@205cc38`)
3. **Port the sandbox hardening flags and the inspect-before-attach check.** Keep them, but move Docker control out of the API process. Today the API spawns the `docker` CLI itself (`apps/server/src/computer.ts:40-111@205cc38`), and the docs call the API "trusted infrastructure" (`SECURITY.md:17@205cc38`). For the challenge's "never in the app process" framing, put a narrow supervisor on the Vultr VM.
4. **Routing to Vultr is one env change, with one compatibility caveat.** Set `MODEL=openai/<vultr-model>`, `OPENAI_BASE_URL=https://api.vultrinference.com/v1`, and `OPENAI_API_KEY=<vultr key>` (`apps/server/src/engine/tanstack-agent.ts:27-31@205cc38`). The caveat is that the OpenAI adapter speaks the **Responses API** (`response.created` and similar events in `tests/helpers/model.ts:42,112@205cc38`; `.env.example:17@205cc38`). Vultr lists `/v1/responses` (`research/02-vultr-and-sandbox-tech.md:11,47`), but streamed function calling over it is **UNKNOWN**. Smoke-test it first, and have a chat-completions adapter ready as a fallback.
5. **Hard blocker if you reuse the app wholesale:** a CopilotKit Intelligence SaaS key is mandatory in every mode (`apps/server/src/config.ts:108@205cc38`, `apps/server/src/app.ts:29,44@205cc38`). That is a non-Vultr, non-MIT dependency on the chat path. The recommendation is to reuse patterns, not the app.

---

## 1. Architecture (as implemented)

```
                       ┌───────────────────────── Client (Expo RN / RN-Web) ─────────────────────────┐
                       │ CopilotKitProvider runtimeUrl=/api/copilotkit, Bearer session token          │
                       │ (apps/mobile/App.tsx:93-95)  useAgent/useRenderTool (src/chat.tsx:44-182)   │
                       │ Activity/tasks/approvals = REST polling every 3 s (src/agent-workspace.tsx:60)│
                       └───────────────┬──────────────────────────────────────┬──────────────────────┘
                          AG-UI (SSE via runtime)                     REST /api/* (Bearer or signed URL)
                                       │                                      │
┌──────────────────────────────────── API process (Hono, apps/server/src/index.ts) ─────────────────────────────────┐
│ auth middleware (app.ts:126-137) → owner="local-user" (auth.ts:26)                                                 │
│ /api/copilotkit/* → CopilotRuntime{agents, intelligence} (agent.ts:27-61) ──► CopilotKit Intelligence (SaaS, req'd) │
│   ConversationAgent (engine/conversation.ts) → tanstackAgent → provider SDK (OpenAI/Anthropic/Gemini, base URL env) │
│ ActionService: propose/decide/execute  (actions.ts)  ── executes Gmail/Calendar writes IN the HTTP request          │
│ AgentService + TaskWorker (engine/service.ts, engine/worker.ts) — hosted in API unless TASK_WORKER_ENABLED=false  │
│ BrowserService (browser.ts) ── HTTP+WORKER_TOKEN ──┐        ComputerService (computer.ts) ── spawn("docker",argv) ─┐ │
│ Files (files.ts) → DATA_DIR/files/*.pdf            │        GoogleAuth/GoogleClient (google-auth.ts, google.ts)    │ │
│ Store: PGlite (in-proc) or Postgres (db.ts)        │                                                              │ │
└────────────────────────────────────────────────────┼──────────────────────────────────────────────────────────────┼─┘
                                                     ▼                                                              ▼
                     ┌──────── Browser worker (apps/worker) ────────┐          ┌──── Docker engine (host or Colima VM) ─────┐
                     │ node:http, Bearer WORKER_TOKEN (server.ts)    │          │ per-owner container openmuse-<dep>-<own>   │
                     │ Playwright persistent Chromium profiles       │          │ --network none, --read-only, uid 1000,     │
                     │ loopback egress proxy + DNS pinning           │          │ cap-drop ALL, 512m, 1 cpu, 128 pids        │
                     │ (browser.ts, proxy.ts, network.ts)            │          │ named volume → /workspace (computer.ts)    │
                     └───────────────────────────────────────────────┘          └────────────────────────────────────────────┘
Optional: separate task-worker process (worker-entry.ts) — requires Postgres + shared DATA_DIR (README.md:134).
Disabled: OpenBotAdapter (packages/backends/src/openbot.ts) — imported only by tests/openbot.test.ts.
```

The component inventory is in `README.md:146-173@205cc38`. The wiring is in `apps/server/src/app.ts:24-45@205cc38`.

## 2. Trust boundaries

```
 [Internet user / phone]                                       [Public web]
        │ TB1: Bearer session (24h, sha256-stored) or                ▲
        │      HMAC signed URL (15 min, owner+path+expiry)            │ TB5: app-level egress policy only
        ▼                                                             │ (public IPs, ports 80/443, DNS pinned)
 ┌──────────────── API (holds EVERYTHING sensitive) ──────────┐       │
 │ model keys, Google tokens (AES-GCM at rest), WORKER_TOKEN, │  TB3  │
 │ signing key file, CPK Intelligence key, Docker CLI access  │──────►│ Browser worker (no app secrets,
 │                                                            │ Bearer│ single shared token, no owner model)
 │   TB2: model output → tools (prompt says "untrusted data") │       │
 └───────┬───────────────────────────┬────────────────────────┘
         │ TB4: docker CLI (= engine │ TB6: Google APIs (reviewed writes only)
         │ = host-root equivalent)   ▼
         ▼                     [Gmail/Calendar]
 [Linux container: no net, no secrets, no host mounts; /workspace volume]
```

- TB1: `apps/server/src/auth.ts:15-66@205cc38`. Signed routes are selected by regex, and that regex **includes POST to `/console`**, so a signed console URL grants browser *control*, not just viewing (`apps/server/src/app.ts:127-134,316-319@205cc38`).
- TB2: tool results are labeled as untrusted in the prompt (`apps/server/src/engine/model.ts:286@205cc38`, `apps/server/src/engine/conversation.ts:224-226@205cc38`). Enforcement is structural only for external writes, because no approve tool exists.
- TB3: `apps/server/src/browser.ts:50-66@205cc38` and `apps/worker/src/server.ts:39-60@205cc38`. `/health` is unauthenticated (`apps/worker/src/server.ts:52-55@205cc38`).
- TB4: `apps/server/src/computer.ts:38-66@205cc38`. `DOCKER_HOST` and `DOCKER_CONTEXT` are passed through, and provider keys are stripped from the child env (`apps/server/src/computer.ts:55-65@205cc38`).
- TB5: `apps/worker/src/network.ts:8-96@205cc38`, `apps/worker/src/proxy.ts:6-88@205cc38`, `apps/worker/src/browser.ts:175-223@205cc38`. The worker README says this is not a kernel firewall and that Chromium's sandbox is disabled (`apps/worker/README.md:64@205cc38`).
- TB6: writes are made only via `ActionService.decide` → `WorkspaceService.execute` (`apps/server/src/workspace.ts:349-419@205cc38`).

## 3. Task state machine

The status union is in `packages/domain/src/agent.ts:3-12@205cc38`.

```
              createTask (service.ts:180-230; held → paused)
                         │
                         ▼
   ┌──────────────► queued ◄──────────────┬──────────── answer() (service.ts:308-332)
   │                    │ tick CAS claim   │                     ▲
   │                    ▼ (worker.ts:125)  │                     │
   │   LostLease/abort  running ───────────┼─► waiting_input ────┘
   │   (worker.ts:205)  │ │ │ │            │     (ask_user / missing fields / no model)
   └────────────────────┘ │ │ │            │
         ┌────────────────┘ │ └───────────────► waiting_approval ── tick skips while action
         │ error            │ monitor ok/retry        │             awaiting_review|executing
         ▼                  ▼                         │             (worker.ts:85-107); then
       failed ◄──────── scheduled (nextRunAt) ──due──►│ re-run: succeeded→continue,
         │ retry (only if no linked            ▲      │ else throw → failed (service.ts:732-748)
         │ unresolved action; service.ts:248-255)     │
         ▼                                     │      ▼
       queued / waiting_approval               └── succeeded (terminal)
 pause: any non-terminal → paused ── resume → queued|waiting_approval (service.ts:237-247)
 cancel: any except succeeded → cancelled (terminal); denies a still-awaiting proposal (service.ts:293-297)
```

Action (proposal) lifecycle (`packages/domain/src/index.ts:142-150@205cc38`):
`awaiting_review →(claim) executing → succeeded | failed | outcome_unknown`. The side branches are `awaiting_review → denied | expired`. A restart sweeps `executing → outcome_unknown` (`apps/server/src/db.ts:91-95@205cc38`, called at `apps/server/src/index.ts:11@205cc38`). The type also includes `cancelled`, but no code path sets it; cancel uses `denied` (`apps/server/src/engine/service.ts:293-297@205cc38`).

## 4. End-to-end call trace: "Summarize copilotkit.ai" from web chat

1. The web client mounts `CopilotKitProvider runtimeUrl=${API_URL}/api/copilotkit` with a Bearer token (`apps/mobile/App.tsx:93-95@205cc38`). `useAgent({agentId, runtimeAgentId:"default", threadId})` is at `apps/mobile/src/chat.tsx:182@205cc38`. The token comes from `POST /api/session` (`apps/mobile/src/api.ts:33-43@205cc38`, `apps/server/src/app.ts:101-114@205cc38`).
2. Hono runs, in order: the origin allowlist, then CORS, then a 12 MB body limit, then auth, which sets `owner` (`apps/server/src/app.ts:48-71,126-137@205cc38`).
3. `/api/copilotkit/*` returns 503 unless a model or AG-UI agent is configured. It then calls `runtime.fetch` and re-encodes SSE string chunks to bytes (`apps/server/src/app.ts:320-337@205cc38`).
4. `CopilotRuntime` resolves `default` to `new ConversationAgent(config, service, owner)`, where the owner comes from the same bearer (`apps/server/src/agent.ts:33-51@205cc38`). `identifyUser` resolves the same owner for Intelligence (`apps/server/src/agent.ts:55-58@205cc38`).
5. `ConversationAgent.run` builds its tools (`search_mail`, `read_mail_thread`, `browse_web`, `delegate_task`, `agent_status`, `create_goal`, `watch_page`, `remember_fact`, plus the computer tools) with `maxSteps: 6`. It keeps only the `open_workspace` client tool (`apps/server/src/engine/conversation.ts:93-237@205cc38`).
6. `tanstackAgent` → `BuiltInAgent{type:"tanstack"}` → `chat({adapter: openaiText(id,{baseURL: OPENAI_BASE_URL, maxRetries:2})})` (`apps/server/src/engine/tanstack-agent.ts:19-31,97-130@205cc38`).
7. The model calls `browse_web{url}`, which runs `BrowserService.observeForThread(owner, threadId, url, abortSignal)`. That call first persists the thread→session mapping and the browser record, then runs serially: open, then read (`apps/server/src/browser.ts:165-198@205cc38`).
8. The API calls `POST {WORKER}/sessions {id,url}` with `Authorization: Bearer WORKER_TOKEN` and a 45 s timeout (`apps/server/src/browser.ts:50-66,116-121@205cc38`). The worker checks the token hash, then `createSession`: validate the URL (DNS → public IP only), then `launchPersistentContext(profileDir, {proxy: loopback egress proxy})`, route-level validation, and WebSocket/popup/dialog blocking, then `navigate` (`apps/worker/src/server.ts:56-68@205cc38`, `apps/worker/src/browser.ts:152-283@205cc38`).
9. `GET /sessions/:id/read` runs a fixed `page.evaluate` that returns innerText (at most 100k characters) and re-validates the final URL (`apps/worker/src/browser.ts:299-324@205cc38`). The API truncates to 30k characters for the model (`apps/server/src/browser.ts:191-196@205cc38`).
10. The tool result is emitted as AG-UI `TOOL_CALL_RESULT`. The model's text arrives as `TEXT_MESSAGE_CHUNK`, split per step (`apps/server/src/engine/tanstack-agent.ts:175-193@205cc38`), and is streamed to the client. The client renders the `browse_web` card (`apps/mobile/src/chat.tsx:61@205cc38`).
11. **Take control:** the card uses `decorate()` → HMAC-signed `consoleUrl` and `previewUrl` (`apps/server/src/browser.ts:90-96@205cc38`). On web this is an `<iframe>` (`apps/mobile/src/BrowserConsole.web.tsx:1-9@205cc38`). The console polls the PNG preview every 2 s and POSTs clicks, text, keys, and scroll back to the same signed URL (`apps/server/src/browser-console.ts:22-37@205cc38`). The worker whitelists input types and keys (`apps/worker/src/browser.ts:325-360@205cc38`).

Durable variant: `delegate_task` → `createTask` with an idempotency key of `threadId:messageId:sha(args)` (`apps/server/src/engine/conversation.ts:90-91,169-175@205cc38`). Then `TaskWorker.tick` (1 s poll, at most 3 claims per tick) → `AgentService.execute` → `executeModelTask` with `maxSteps: 16` and a 5-minute timeout (`apps/server/src/engine/worker.ts:64-115@205cc38`, `apps/server/src/engine/model.ts:282-341@205cc38`).

---

## 5. Capability inventory with labels

### 5.1 Client surfaces (Expo / RN-Web)

| Capability | Label | Evidence |
|---|---|---|
| A web app served without native builds | IMPL (upstream-reported export) | `expo start --web --port 8081` and `expo export --platform web` (`apps/mobile/package.json:8-9@205cc38`). Metro web bundler (`apps/mobile/app.json:12@205cc38`). Web exports are upstream-reported (`docs/VERIFICATION.md:9@205cc38`). |
| Web-specific replacements | IMPL | `BrowserConsole.web.tsx` uses an iframe (`:1-9`). `PdfReader.web.tsx` uses the browser's PDF viewer (`apps/mobile/README.md:25@205cc38`). Native PDF requires a dev build (`README.md:91@205cc38`). |
| Streaming chat UI and tool cards | IMPL | `useRenderTool` for 8 server tools (`apps/mobile/src/chat.tsx:44-101@205cc38`). |
| Visible follow-up queue (client-only, not durable) | IMPL+T | `apps/mobile/src/conversation-queue.ts:5-45@205cc38`. A failure pauses the queue and never resends (`:38-41`). Tests in `apps/mobile/test/conversation-queue.test.ts:5,26,53@205cc38`. The queue lives in the open app, not on the server (`docs/RICH-THREADS.md:24@205cc38`). |
| Activity, task, and approval freshness | IMPL | **Polling** every 3 s, not streamed (`apps/mobile/src/agent-workspace.tsx:40-61@205cc38`). The computer view polls every 5 s (`apps/mobile/src/computer-workspace.tsx:65@205cc38`). |
| Approval UI sends `{hash, decision}` | IMPL | `apps/mobile/src/details.tsx:545-551,577-579@205cc38`. |

### 5.2 API runtime, streaming, and durable records

| Capability | Label | Evidence |
|---|---|---|
| Hono API and CopilotKit runtime v2 | IMPL | `apps/server/src/app.ts:1-342@205cc38`, `apps/server/src/agent.ts:27-61@205cc38`. |
| Streamed AG-UI events | IMPL+T | The sample agent emits the RUN/TEXT/TOOL events (`apps/server/src/engine/conversation.ts:33-89@205cc38`). The test calls the agent directly, not over HTTP through Intelligence (`tests/api.test.ts:180-192@205cc38`). |
| HTTP streaming path through Intelligence | UNKNOWN | The runtime is constructed with `intelligence` (`apps/server/src/agent.ts:52-60@205cc38`). The OpenBot doc says an Intelligence runtime's run response is "connection metadata, not raw SSE" (`docs/OPENBOT-INTEGRATION.md:32@205cc38`). Whether OpenMuse's own `/agent/:id/run` returns SSE or a WS descriptor was not verified. The tests mock Intelligence (`docs/VERIFICATION.md:40@205cc38`). |
| Plans | IMPL | `set_plan` tool (`apps/server/src/engine/model.ts:94-104@205cc38`). Kind-specific default plans (`apps/server/src/engine/service.ts:192-213@205cc38`). |
| Durable activity / run events | IMPL | `run-events` records via `ctx.event` behind `guard()` (`apps/server/src/engine/worker.ts:154-164@205cc38`). The action activity log is at `apps/server/src/actions.ts:192-201@205cc38`. Run history is keyed by leaseId (`apps/server/src/engine/worker.ts:184-203@205cc38`). |
| Stored reviews / approvals | IMPL+T | §7.1. Tests at `tests/actions.test.ts:35-287@205cc38`. |
| Input requests | IMPL+T | `ask_user` → `waiting_input` (`apps/server/src/engine/model.ts:245-253@205cc38`). `POST /tasks/:id/input` → `answer()` requeues the task (`apps/server/src/engine/routes.ts:43-55@205cc38`, `apps/server/src/engine/service.ts:308-332@205cc38`). |
| Receipts | IMPL+T | The action `result` holds the provider id string, e.g. `Gmail sent message · <id>` (`apps/server/src/workspace.ts:405-418@205cc38`). The computer command receipt stores `stdout/stderr/exitCode/status` (`packages/domain/src/computer.ts:1-12@205cc38`, `apps/server/src/computer.ts:719-747@205cc38`). |
| Notifications (in-app, deduplicated by key hash) | IMPL | `apps/server/src/engine/service.ts:658-668,826-893@205cc38`. |

### 5.3 Task engine

| Capability | Label | Evidence |
|---|---|---|
| SQL lease claim with CAS, 60 s lease, heartbeat at lease/3 | IMPL+T | `apps/server/src/engine/worker.ts:116-182@205cc38`. "two workers claim one task only once" (`tests/engine.test.ts:30-45@205cc38`). |
| Guard before each effect; checkpoint by CAS | IMPL+T | `apps/server/src/engine/worker.ts:136-153@205cc38`. "cancellation invalidates a stale worker before its next effect" (`tests/engine.test.ts:46-69@205cc38`). |
| Expired-lease recovery from a checkpoint after a DB restart | IMPL+T | `apps/server/src/engine/worker.ts:81@205cc38`, `tests/engine.test.ts:70-99@205cc38`. |
| Pause / resume / cancel / retry | IMPL+T | `apps/server/src/engine/service.ts:231-307@205cc38`. Retry is only allowed from `failed`, and is blocked when the linked action is not `succeeded` (`:235-255`). |
| Worker recovery on restart | IMPL | Maintenance republishes outcomes, reactivates monitors, and recovers accepted ideas (`apps/server/src/engine/service.ts:73-116@205cc38`). `recoverInterruptedActions` runs on API boot (`apps/server/src/index.ts:11@205cc38`). |
| Blind retry of uncertain external effects | **No** (IMPL+T) | See §7.2. |
| Replay of the model loop after a lost lease | IMPL (risk) | A lost lease sets `status: queued` (`apps/server/src/engine/worker.ts:205-212@205cc38`). The **whole model loop re-runs**, with only `import_pdf` and `fill_pdf` memoized by an args hash (`apps/server/src/engine/model.ts:75-85,133-165@205cc38`). Computer commands are deduplicated only if the model reuses its own `operationId`, which the prompt asks for (`apps/server/src/computer-tools.ts:12,59-68@205cc38`). |
| Scale | IMPL (limitation) | Each tick does a full-table `scan("tasks")` (`apps/server/src/engine/worker.ts:75@205cc38`, `apps/server/src/db.ts:71-77@205cc38`). At most 3 runs per tick (`apps/server/src/engine/worker.ts:109@205cc38`). At most 100 non-terminal tasks per owner (`apps/server/src/engine/service.ts:187-191@205cc38`). |

### 5.4 Browser worker

| Capability | Label | Evidence |
|---|---|---|
| Persistent Chromium profile per session UUID; cookies saved on close | IMPL+T (upstream-reported real Chromium) | `apps/worker/src/browser.ts:137-195,206-214@205cc38`. Lifecycle test is upstream-reported (`docs/VERIFICATION.md:10@205cc38`). |
| Limits: 3 active sessions, 20 profiles, 30-min idle close | IMPL | `apps/worker/src/browser.ts:41,155-166,284-290@205cc38`. |
| Session auth (API↔worker) | IMPL | One shared Bearer token of at least 32 characters, compared by constant-time hash (`apps/worker/src/server.ts:39-60@205cc38`). The worker has no owner concept; ownership lives in the API DB (`apps/server/src/browser.ts:85-89@205cc38`). |
| Live control (screenshot, click, type, key, scroll) | IMPL | `apps/worker/src/browser.ts:297-360@205cc38`, `apps/server/src/browser-console.ts:1-39@205cc38`. |
| Autonomous interactive browsing (click/type by the agent) | ROADMAP | The agent has only read/navigate (`apps/server/src/engine/conversation.ts:149-168@205cc38`). Autonomous booking is roadmap (`ROADMAP.md:25@205cc38`). |
| Downloads (PDF only, ≤10 MiB, ≤20 per session, failure outcomes persisted) | IMPL+T | `apps/worker/src/browser.ts:235-252,361-380@205cc38`, `apps/worker/README.md:54-56@205cc38`, `tests/browser.test.ts:274-327@205cc38`. |
| PDF transfer: browser → Files → computer | IMPL | `apps/server/src/browser.ts:219-253@205cc38`. `import_computer_pdf` / `export_computer_pdf` (`apps/server/src/computer-tools.ts:93-107@205cc38`). |
| Egress policy (public IPs, 80/443, DNS pinning, no QUIC/WebRTC UDP) | IMPL+T | `apps/worker/src/network.ts:8-96@205cc38`, `apps/worker/src/proxy.ts:6-88@205cc38`, `tests/browser.test.ts:328-395,504@205cc38`. |
| Task-side browser read cancellation | **Missing** | `BrowserService.observe` takes no signal (`apps/server/src/browser.ts:158-164@205cc38`), and the `read_web` tool does not pass one (`apps/server/src/engine/model.ts:166-191@205cc38`). The chat path does pass one (`apps/server/src/engine/conversation.ts:157-162@205cc38`). |

### 5.5 Optional Linux computer

| Capability | Label | Evidence |
|---|---|---|
| Disabled by default | DISABLED | `COMPUTER_ENABLED=false` (`.env.example:52@205cc38`, `apps/server/src/config.ts:115@205cc38`, `apps/server/src/computer.ts:201-207@205cc38`). |
| Terminal exec (non-interactive `bash -c` via `docker exec`) | IMPL+T | `apps/server/src/computer.ts:591-751@205cc38`. There is no PTY (`docs/COMPUTER.md:46@205cc38`). |
| Time limits | IMPL | In-container `timeout 30s --kill-after=2s` and a 35 s client timeout. On a timeout or interrupt the **whole container is stopped** (`apps/server/src/computer.ts:646-718@205cc38`). |
| Resource limits | IMPL | 512m memory with swap equal to memory, 1 CPU, 128 pids, 64 MB noexec `/tmp`, `--ipc private`, `--restart no` (`apps/server/src/computer.ts:465-508@205cc38`). Output is capped at 128 KB (`:15`). There is no disk quota (`SECURITY.md:25@205cc38`). |
| Runs as nonroot | IMPL | `--user 1000:1000`, `--read-only`, `--cap-drop ALL`, `no-new-privileges` (`apps/server/src/computer.ts:473-481@205cc38`, `apps/computer/Dockerfile:14@205cc38`). |
| Workspace persistence | IMPL | Labeled named volume at `/workspace`, verified before attach (`apps/server/src/computer.ts:295-319,453-464@205cc38`). |
| Host access | IMPL | No binds, devices, or port bindings, enforced by `inspect()` which **refuses to attach** otherwise (`apps/server/src/computer.ts:225-294@205cc38`). |
| Networking | IMPL | `--network none`, verified on inspect (`apps/server/src/computer.ts:482-483,263,286@205cc38`). |
| Command lease, stop fencing, interrupted → never replayed | IMPL+T | `apps/server/src/computer.ts:320-409,514-584@205cc38`. Tests at `tests/computer.test.ts:45-304@205cc38`. |
| File API (symlink-safe, atomic writes) | IMPL+T | `apps/computer/files.py:1-103@205cc38`, `apps/server/src/computer.ts:752-822@205cc38`. |
| Sandbox granularity | IMPL (limitation) | **One container per owner per deployment**, shared by chat and tasks (`apps/server/src/computer.ts:113-126@205cc38`). A single lease serializes all operations, so concurrent callers get 409 "busy" (`:334-346`). |
| **API has Docker-engine access** | IMPL (risk) | `spawn("docker", args, {shell:false})` from the API or task-worker process (`apps/server/src/computer.ts:66@205cc38`). Required per `docs/COMPUTER.md:7@205cc38` and `README.md:128@205cc38`. |

**Recommendation for Docker access.** Yes, move it behind a narrow supervisor on the Vultr sandbox VM. Docker-engine access is host-root equivalent. Today any RCE or SSRF in the Hono process, which also parses PDFs and serves the CopilotKit runtime, inherits it. A supervisor should expose only `create(owner|task) / exec(id, argv, timeout) / stop / files` over mTLS or a token. It should hard-code the flag set from `computer.ts:465-508` and run the `inspect()` checks server-side. The API should then hold only the supervisor token. That also fits the "all execution on Vultr VMs, never in the app process" rule.

### 5.6 Persistence

| Capability | Label | Evidence |
|---|---|---|
| One generic `records(owner,kind,id,data jsonb)` table | IMPL | `apps/server/src/db.ts:138-140@205cc38`. |
| PGlite (in-process) by default; Postgres via `DATABASE_URL` | IMPL+T | `apps/server/src/db.ts:122-142@205cc38`. PGlite restart is tested (`tests/persistence.test.ts:8@205cc38`). |
| Process-sharing constraint | DOC+IMPL | PGlite cannot be shared across processes (`README.md:134@205cc38`). `worker-entry.ts` refuses to start without `DATABASE_URL` (`apps/server/src/worker-entry.ts:6-9@205cc38`). Run a single API instance (`README.md:134@205cc38`). |
| File storage | IMPL | PDFs live on local disk at `DATA_DIR/files/<uuid>.pdf` with mode 0600 (`apps/server/src/files.ts:44-47@205cc38`). A separate worker needs a shared `DATA_DIR` (`README.md:134@205cc38`). |
| Restart behavior | IMPL | Actions: `executing → outcome_unknown` (`apps/server/src/db.ts:91-95@205cc38`). Tasks: lease expiry leads to a re-claim. Computer commands: `running → interrupted` when the lease has expired (`apps/server/src/computer.ts:387-409@205cc38`). Browser: all sessions are marked `closed` on worker restart (`apps/worker/src/browser.ts:47-58@205cc38`). |

### 5.7 Gmail / Calendar

| Capability | Label | Evidence |
|---|---|---|
| Fictional fixtures (sample mode) | STUB/MOCK (by design) | Seeded mail, events, and PDF (`apps/server/src/workspace.ts:143-260@205cc38`). Sample "send" writes to local sent mail (`:355-380`). Sample mode is loopback-only (`apps/server/src/config.ts:129-130@205cc38`). |
| Live mode | IMPL+T against HTTP fixtures; **no live account run** | `docs/VERIFICATION.md:33@205cc38`, `ROADMAP.md:16@205cc38`. |
| OAuth scopes | IMPL | Read scopes are always requested. `gmail.send` and `calendar.events` are added only on a write connect. Uses PKCE and single-use state (`apps/server/src/google-auth.ts:100-191@205cc38`). |
| Token encryption | IMPL+T | AES-256-GCM with AAD and a versioned envelope (`packages/integrations/src/vault.ts:11-56@205cc38`). Generation CAS guards against refresh races (`apps/server/src/google-auth.ts:56-99,205-234@205cc38`). |
| Review invalidation | IMPL+T | The proposal hash includes `connection`. `decide` re-checks `connectionId` and `account` (`apps/server/src/actions.ts:77-86,136-149@205cc38`). Calendar writes use an ETag with `If-Match` (`packages/integrations/src/google.ts:543-549,787-815@205cc38`). |
| Uncertain writes | IMPL+T | A network error, 5xx/408 on a write, or an unparseable write response raises `OutcomeUnknownError` (`packages/integrations/src/google.ts:19-27,576-606,766-784@205cc38`). |

### 5.8 Documents, artifacts, goals, suggestions, memories

| Capability | Label | Evidence |
|---|---|---|
| PDF form job: import → ask for fields → fill a new copy → propose reply → wait → receipt | IMPL+T | `apps/server/src/engine/service.ts:894-985@205cc38`, `tests/workflows.test.ts:66@205cc38`. Only AcroForm is supported (`docs/VERIFICATION.md:31@205cc38`). |
| Structured artifacts (plan / comparison / report / finance), id = `sha(task:key)` | IMPL | `apps/server/src/engine/service.ts:672-692@205cc38`. |
| Goals and milestones; watchers (change / contains / price_below) with backoff and auto-pause | IMPL+T | `apps/server/src/engine/service.ts:333-520,986-1088@205cc38`, `tests/monitor-recovery.test.ts@205cc38`. |
| Suggestions ("Ideas") are **rules-based regex**, not model-derived | IMPL | `apps/server/src/engine/service.ts:521-604@205cc38`. |
| Memories (user-confirmed; injected into the task prompt as data) | IMPL | `apps/server/src/engine/routes.ts:84-110@205cc38`, `apps/server/src/engine/model.ts:281-286@205cc38`. |
| Finance CSV → spending artifact | IMPL+T | `apps/server/src/engine/service.ts:790-814@205cc38`. |

### 5.9 Auth assumptions

| Item | Label | Evidence |
|---|---|---|
| Single owner. Every session maps to `"local-user"` | IMPL | `apps/server/src/auth.ts:26@205cc38`. `SECURITY.md:9@205cc38` states this is not multi-tenant. |
| Access key in live mode; **no key in sample mode** | IMPL | `apps/server/src/auth.ts:15-22@205cc38`. |
| Login rate limit (process-global, 30/min) | IMPL | `apps/server/src/app.ts:99-107@205cc38`. |
| Signed URLs: HMAC-SHA256(owner\npath\nexpiry), 15 min, key file in `DATA_DIR` | IMPL | `apps/server/src/auth.ts:42-79@205cc38`. The signature does not bind the HTTP method; see TB1. |
| Worker token | IMPL | §5.4. |

### 5.10 Every model call

| Call site | Provider path | Evidence |
|---|---|---|
| Chat agent (`ConversationAgent`) | `tanstackAgent` → `chat()` → `openaiText` / `anthropicText` / `geminiText` | `apps/server/src/engine/conversation.ts:217-227@205cc38`, `apps/server/src/engine/tanstack-agent.ts:19-54@205cc38`. |
| Task agent (`executeModelTask`) | Same adapter, `maxSteps: 16`, 5-minute timeout | `apps/server/src/engine/model.ts:282-341@205cc38`. |
| `AGENT_BACKEND=agui` | `HttpAgent` to an external raw AG-UI URL with a Bearer token. Replaces chat routing only | `apps/server/src/agent.ts:41-45@205cc38`, `.env.example:37-41@205cc38`. |
| Thread naming | Disabled (`generateThreadNames:false`) | `apps/server/src/agent.ts:59@205cc38`. |
| Helper / "ideas" LLM calls | **None**; rules only | `apps/server/src/engine/service.ts:521-604@205cc38`. |
| Demo | `@copilotkit/aimock` on a local `OPENAI_BASE_URL` | `apps/server/src/demo/entry.ts:39-43,72-76@205cc38`. |
| Retries | SDK-level, pre-stream only, `MODEL_MAX_RETRIES=2`. No fallback model | `apps/server/src/config.ts:76-83@205cc38`, `tests/model-retry.test.ts:54-146@205cc38`. |

**Routing via Vultr.** Set:

- `AGENT_BACKEND=model`
- `MODEL=openai/<vultr-model-id>`
- `OPENAI_BASE_URL=https://api.vultrinference.com/v1`
- `OPENAI_API_KEY=<Vultr key>`

`agentConfigured` checks only that the key is present (`apps/server/src/agent.ts:14-25@205cc38`). The model id is cast, so any string passes (`apps/server/src/engine/tanstack-agent.ts:28@205cc38`).

Risk: `@tanstack/ai-openai` `openaiText` uses the **Responses** wire format. This is proven by the fixture emitting `response.created`, `response.function_call_arguments.delta`, and `response.completed` (`tests/helpers/model.ts:109-145@205cc38`). Vultr exposes `POST /responses` (`research/02-vultr-and-sandbox-tech.md:47`), but its spec there lists only `input`, `max_output_tokens`, and `reasoning`. Streaming and tool-call support on Responses is UNKNOWN. Vultr tool-call ID quirks are addressed on chat-completions via `-normalize` models (`research/02-vultr-and-sandbox-tech.md:56`). **Action:** run a 10-minute smoke test (a streamed Responses call with one function tool on `glm-5.3`). If it fails, swap in a chat-completions adapter; the AI SDK's `openai.chat()` or a thin custom adapter both work.

---

## 6. Integration-risk verification (the 8 items)

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| 1 | The OpenBot doc describes a disabled adapter and contract inspection, not a live deployment | **Confirmed.** | The doc says "source inspection, not a running integration" (`docs/OPENBOT-INTEGRATION.md:3@205cc38`) and "not connected to a deployment" (`:57`, `:76`). Code is disabled unless `enabled:true` plus a transport (`packages/backends/src/openbot.ts:139-141,245-254@205cc38`). The adapter is imported only by tests (`tests/openbot.test.ts:4-7@205cc38`). The workspace reports `openbot: "unconfigured"` (`apps/server/src/workspace.ts:315-320@205cc38`). No `OPENBOT_*` env var is read anywhere; only the `OPENBOT_CONTRACT_REF` constant exists (`packages/backends/src/openbot.ts:4@205cc38`). |
| 2 | Intelligence-backed runtime URL vs raw AG-UI SSE | **Confirmed as distinct contracts.** | `runtime()` returns `{runtimeUrl, agentId, mode:"intelligence", credentials:"include"}` and is documented as "NOT an AG-UI SSE URL" (`packages/backends/src/openbot.ts:120-136@205cc38`). The raw AG-UI path is `AGENT_BACKEND=agui` → `HttpAgent` (`apps/server/src/agent.ts:41-45@205cc38`), and `.env.example:41@205cc38` warns against confusing the two. OpenMuse's own `/api/copilotkit` also uses Intelligence; its wire behavior is UNKNOWN (§5.2). |
| 3 | Distinct IDs for actor/agent/bot/task/channel/thread/browser-session/sandbox/approval | **Partly.** | Distinct: task id (UUID or `sha(task:key)`, `apps/server/src/engine/service.ts:184@205cc38`); run id = leaseId (`apps/server/src/engine/worker.ts:118,184@205cc38`); thread id (Intelligence main thread UUID, `apps/server/src/app.ts:196-218@205cc38`); browser session UUID (`apps/server/src/browser.ts:105@205cc38`); action id plus a separate review hash (`apps/server/src/actions.ts:45-48,77-86@205cc38`); command id (`apps/server/src/computer.ts:599-601@205cc38`). The OpenBot adapter keeps channel, thread, and agent separate (`packages/backends/src/openbot.ts:153-175@205cc38`, `tests/openbot.test.ts:123@205cc38`). **Collapsed:** actor is always `local-user` (`apps/server/src/auth.ts:26@205cc38`); the agent id is always `"default"` (`apps/server/src/engine/conversation.ts:24@205cc38`); the **sandbox is keyed per owner, not per task or thread** (`apps/server/src/computer.ts:113-126@205cc38`); the task model run reuses `task.id` as the AG-UI threadId (`apps/server/src/engine/model.ts:289@205cc38`). There is no bot or channel concept outside the adapter. |
| 4 | No shared upstream admin session | **Confirmed (by design; untested live).** | The injected per-person transport "never accepts a shared administrator token or calls global fetch" (`packages/backends/src/openbot.ts:6-14@205cc38`). The doc says "a shared administrator session is unsuitable" (`docs/OPENBOT-INTEGRATION.md:16@205cc38`). Caveat: OpenMuse *itself* uses one shared access key for its single owner (`SECURITY.md:9@205cc38`). |
| 5 | Gateway policy ≠ OpenMuse action-specific approval lifecycle | **Confirmed.** | `docs/OPENBOT-INTEGRATION.md:70@205cc38`. The adapter lists `approval_persistence` as unsupported (`packages/backends/src/openbot.ts:105-110@205cc38`), and the comment says the caller must enforce OpenMuse proposals (`:99-103`). Policy refusals are surfaced and not retried (`tests/openbot.test.ts:215@205cc38`). |
| 6 | Docker access in the API | **Confirmed.** | `apps/server/src/computer.ts:66@205cc38`. Docs: `docs/COMPUTER.md:7,13@205cc38`, `SECURITY.md:17@205cc38`. It also applies to a separate task worker (`.env.example:51@205cc38`). |
| 7 | Pause/cancel does not reverse dispatched side effects | **Confirmed.** | `README.md:136@205cc38`, `SECURITY.md:29@205cc38`. Code: cancel only denies an `awaiting_review` proposal (`apps/server/src/engine/service.ts:293-297@205cc38`). An approved write runs synchronously inside `POST /api/actions/:id/decide` with no abort signal (`apps/server/src/app.ts:172-179@205cc38`, `apps/server/src/actions.ts:167-176@205cc38`). There is no compensation logic anywhere. The in-flight browser read in tasks is not abortable either (§5.4). |
| 8 | No automatic retry of uncertain external mutations | **Confirmed, with one soft spot.** | `outcome_unknown` is terminal and a re-approve returns without calling the adapter (`apps/server/src/actions.ts:112,177-186@205cc38`, `tests/actions.test.ts:107-121@205cc38`). Google 5xx and network failures on writes are not retried (`tests/google.test.ts:516@205cc38`). Task retry is blocked on an unresolved action (`apps/server/src/engine/service.ts:248-255@205cc38`). A boot sweep handles crashes (`apps/server/src/db.ts:91-95@205cc38`). OpenBot mutations are marked `outcomeUnknown` (`packages/backends/src/openbot.ts:277-313@205cc38`). **Soft spot:** after a lost lease, the whole model loop re-runs, and in-sandbox commands are deduplicated only through a model-chosen `operationId` (§5.3). |

---

## 7. Patterns worth porting (detail)

### 7.1 Action-bound approval

- **propose:** `id = sha256(idempotencyKey)`, using `taskId:sha(draft)` from the task path (`apps/server/src/engine/model.ts:222-223@205cc38`, `apps/server/src/engine/service.ts:707@205cc38`). An existing proposal is returned as-is (`apps/server/src/actions.ts:45-52,90-98@205cc38`). `prepare()` fetches the authoritative target and version before hashing (`apps/server/src/workspace.ts:330-348@205cc38`).
- **hash** = `sha256(JSON{input, connection, target, targetVersion})`. **expiresAt** = now + 30 min (`apps/server/src/actions.ts:76-88@205cc38`).
- **decide:**
  1. A hash mismatch returns 409.
  2. A proposal that is not `awaiting_review` is returned unchanged (idempotent).
  3. A linked task must be running or waiting.
  4. Expiry is a CAS to `expired`.
  5. The connection and account are re-checked.
  6. The SQL `claim` moves it to `executing`, with an `EXISTS` subquery on the task (`apps/server/src/db.ts:78-90@205cc38`).
  7. The adapter executes.
  8. The result is persisted as `succeeded`, `failed`, or `outcome_unknown`, with an activity row.

  Source: `apps/server/src/actions.ts:102-191@205cc38`.
- Tests cover a single consumption under concurrency, a stale hash, the wrong owner, expiry, account switching, and an idempotent replay (`tests/actions.test.ts:35-287@205cc38`).
- **For Blast Radius Zero:** generalize `kind` beyond email and calendar, e.g. to `sandbox.exec_with_egress`, `browser.submit_form`, or `git.push`. Add `argv`/`url` plus a `policyDecisionId` to the hashed payload.

### 7.2 Uncertainty discipline

- The adapter classifies failures as *definite* (a 4xx, or a credential failure before dispatch) or *unknown* (network error, 5xx/408, or an unparseable response on a write) (`packages/integrations/src/google.ts:551-607@205cc38`).
- A boot sweep moves `executing` to `outcome_unknown`.
- Retry is refused and the UI tells the user to "check the provider before creating another action".

### 7.3 Lease / guard / checkpoint worker

This is about 250 lines (`apps/server/src/engine/worker.ts@205cc38`). It is portable as-is onto Postgres, but replace the full-table `scan()` with an indexed `WHERE status IN (...)` query.

### 7.4 Sandbox runner and receipts

- `runDocker` is argv-only, uses a scrubbed env, SIGKILLs on timeout or abort, and caps output (`apps/server/src/computer.ts:40-111@205cc38`).
- A receipt is inserted as `running` before exec, and the final status is written by CAS from `running`. A Stop marks the receipt `interrupted` first, so late output cannot overwrite it (`apps/server/src/computer.ts:615-747,540-554@205cc38`).
- Inspect-before-attach refuses any container whose flags drift (`apps/server/src/computer.ts:225-294@205cc38`).

---

## 8. Risk table

| Risk | Severity (hackathon) | Where | Mitigation in our build |
|---|---|---|---|
| Mandatory CopilotKit Intelligence SaaS key; conversation data leaves Vultr | High | `apps/server/src/config.ts:108@205cc38`, `apps/server/src/app.ts:44@205cc38` | Don't reuse the app shell. Use plain AG-UI SSE from Hono, or CopilotRuntime without Intelligence (UNKNOWN whether 1.70.1 supports that cleanly). |
| API process holds Docker-engine access | High | `apps/server/src/computer.ts:66@205cc38` | Put a narrow supervisor on the Vultr VM; the API holds only a scoped token. |
| Responses-API adapter vs Vultr compatibility | High until tested | `apps/server/src/engine/tanstack-agent.ts:27-31@205cc38` | Smoke-test first; keep a chat-completions fallback. |
| Approved write executes in the HTTP handler; no abort, no worker | Med | `apps/server/src/app.ts:172-179@205cc38` | Run execution in the worker under the task lease, keeping the claim semantics. |
| Model-loop replay after a lost lease can re-run sandbox commands | Med | `apps/server/src/engine/worker.ts:205-212@205cc38`, `apps/server/src/computer-tools.ts:62-67@205cc38` | Derive `operationId` server-side, e.g. `taskId:stepIndex:sha(argv)`, rather than letting the model choose it. |
| Per-owner single sandbox; 409 busy between chat and task | Med | `apps/server/src/computer.ts:113-126,334-346@205cc38` | Key sandboxes by task or session. |
| Signed console URL grants browser control, not just view, for 15 min | Med | `apps/server/src/app.ts:127-134,316-319@205cc38` | Bind the method or scope in the HMAC; keep POST behind the bearer. |
| Browser egress is app-level only; Chromium sandbox off | Med | `apps/worker/README.md:64@205cc38`, `SECURITY.md:13@205cc38` | Run the browser on a separate Vultr VM with host firewall egress rules. |
| Single owner; sample mode has no auth (loopback-forced) | Low for demo | `apps/server/src/auth.ts:15-27@205cc38`, `apps/server/src/config.ts:129-130@205cc38` | Acceptable for a demo; bind the owner to a real login if multi-user. |
| Activity is polled, not streamed | Low | `apps/mobile/src/agent-workspace.tsx:60@205cc38` | Stream run-events over SSE for "live agent" UX points. |
| Task-side browser read has no abort | Low | `apps/server/src/browser.ts:158@205cc38` | Thread `ctx.signal` through. |
| PGlite is single-process | Low | `README.md:134@205cc38` | Use Vultr Managed Postgres or Postgres on the VM. |

## 9. Per-feature recommendation for a 24 h build (1–4 people)

| Feature | Recommendation | Why |
|---|---|---|
| `ActionService` + `Store.claim` + `recoverInterruptedActions` | **Reuse code** (generalize `kind`) | Small (~200 LOC plus SQL) and well-tested. Exactly the "action-bound approvals" requirement. |
| `TaskWorker` (lease, heartbeat, guard, checkpoint) | **Reuse code** (index the scan) | Durable tasks with pause/cancel fencing in ~250 LOC. |
| `records` JSONB store with CAS | **Reuse code** | Minimal schema; works on Postgres. |
| Computer: `runDocker`, hardening flags, `inspect()`, receipts, `files.py` | **Adapt pattern** behind a Vultr-VM supervisor | Solid hardening, but the Docker control plane must leave the API. |
| Browser worker (Playwright, egress proxy, DNS pinning, downloads) | **Reuse code** as a separate service on a Vultr VM | Already an independent service with token auth; tested with real Chromium upstream. |
| Take-control console (screenshot polling + input) | **Adapt pattern** | Cheap "human takeover" demo; tighten the signed-URL scope. |
| `tanstackAgent` / provider adapter | **Keep behind interface; replace provider** | Route to Vultr. Consider a chat-completions adapter. |
| CopilotKit runtime + Intelligence + `ConversationAgent` | **Replace** (plain AG-UI SSE, or CopilotKit without Intelligence) | SaaS dependency; transport uncertainty. |
| Expo / RN-Web client | **Omit**; build a web-first React UI | RN-Web works without native builds, but the 5k+ LOC UI is too heavy to adapt in 24 h. Borrow the queue and approval-card logic only. |
| Gmail / Calendar adapters | **Omit** (optionally keep `OutcomeUnknownError` classification) | Off-challenge; needs a live Google project. |
| PDF form job, finance, ideas, goals/watchers, memories | **Omit** | Off-challenge. Watchers are optional "keeps going" flair. |
| Vault (AES-GCM) + signed-URL HMAC | **Reuse code** | Tiny and correct; useful for artifact links. |
| OpenBot adapter | **Omit** (reference only) | Disabled; no live deployment. |

## 10. File-coverage ledger

| Status | Files |
|---|---|
| **Inspected (full read)** | `README.md`, `ROADMAP.md`, `SECURITY.md`, `CHANGELOG.md`, `.env.example`, `package.json`, `.github/workflows/ci.yml`, `infra/compose.yaml`, `docs/{FEATURES,VERIFICATION,COMPUTER,RICH-THREADS,OPENBOT-INTEGRATION}.md`; `apps/server/src/{app,auth,config,db,index,worker-entry,actions,agent,errors,log,browser,browser-console,files,computer,computer-tools,computer-routes,google-auth,workspace}.ts`; `apps/server/src/engine/{service,worker,routes,model,tanstack-agent,conversation}.ts`; `apps/worker/src/{server,browser,network,proxy,index,demo-entry}.ts`; `apps/worker/{Dockerfile,README.md}`; `apps/computer/{Dockerfile,files.py}`; `packages/backends/src/openbot.ts`; `packages/integrations/src/vault.ts`; `packages/domain/src/{agent,computer}.ts`; `apps/mobile/{package.json,app.json,README.md}`; `apps/mobile/src/{api,conversation-queue,BrowserConsole.web,BrowserConsole.native}.ts(x)`; `tests/helpers/model.ts` |
| **Inspected (partial / targeted)** | `docs/EXPERIENCE.md` (1-20), `docs/DEMO.md` (1-30), `packages/domain/src/index.ts` (117-197), `packages/integrations/src/google.ts` (15-30, 540-616, 750-816, plus grep), `apps/worker/src/downloads.ts` (1-46, 150-159), `apps/server/src/demo/{entry.ts (1-100), model.ts (1-40)}`, `apps/mobile/App.tsx` (grep), `apps/mobile/src/{chat,details,agent-workspace,PdfReader.*}.tsx` (grep/excerpts), `tests/{actions (107-121), engine (30-100), workflows (127-136), api (180-216), model-retry (1-60, 100-146)}.test.ts`, and **all test titles** via grep across `tests/*.ts`, `apps/*/tests`, `apps/mobile/test`, `apps/computer/smoke.test.ts` |
| **Generated / binary** | `pnpm-lock.yaml`, `apps/worker/package-lock.json`, `assets/**` (png/gif/mp4), `apps/mobile/assets/capybara.png` |
| **Irrelevant** | `.github/ISSUE_TEMPLATE/*`, `.github/pull_request_template.md`, `biome.json`, `tsconfig*.json`, `.gitattributes`, `.gitignore`, `.npmrc`, `*.dockerignore`, `CONTRIBUTING.md`, `LICENSE` (MIT confirmed, line 1), `pnpm-workspace.yaml`, `apps/mobile/{index.js,metro.config.js,tsconfig.json,assets/README.md}` |
| **Deferred** | `packages/integrations/src/pdf.ts`; the rest of `google.ts` (MIME/thread parsing); `apps/server/src/engine/finance.ts`; the rest of `demo/model.ts`; mobile UI files `agent-ui.tsx, screens.tsx, details.tsx, threads.tsx, computer*.tsx, ui.tsx, workspace.tsx, thread-artifacts.tsx, *-tool-card.tsx, Date*.tsx, date-time.ts, assistant-*.ts(x), background-updates.tsx, browser-address.ts, conversation-run.ts`; test bodies for google, oauth, browser, monitor-recovery, computer, rich-threads, agent-api, conversation-*, openbot, pdf, vault, config, log, persistence, step-limit, domain, demo-model, model-worker, computer-api/runner; `apps/computer/smoke.test.ts`; `apps/worker/tests/*` |

## 11. Findings, confidence, contrary evidence

**Findings**

1. Approval, uncertainty, and lease are the most reusable assets. The implementation is small, coherent, and backed by concurrency tests. *Confidence: high* (code read line by line).
2. There is no blind retry of uncertain external writes at the action layer. *High.* The soft spot is agent-loop replay of in-sandbox commands after lease loss. *Medium-high* (inferred from the control flow; not exercised).
3. Pause and cancel fence *future* steps only. Approved writes and task-side browser reads are not abortable. *High.*
4. Docker control lives in the API or worker process. *High.*
5. Vultr routing is config-only for OpenAI-style providers, but it depends on Responses-API compatibility. *Medium* (based on fixture events; the adapter source was not read because there is no `node_modules`).
6. Intelligence SaaS is mandatory at boot. *High.* How it affects the chat wire path is UNKNOWN.
7. The OpenBot integration is disabled and test-only. *High.*

**Contrary or nuancing evidence**

- Upstream reports 154 passing tests and real Chromium and Docker smoke runs (`docs/VERIFICATION.md:7-12@205cc38`). Against that, the browser-container CI job "was not rerun locally for this release" (`:12`). No live Google or live model acceptance run exists (`:33`, `ROADMAP.md:16-18@205cc38`).
- The computer is described as "isolated", but the docs themselves note that Docker shares the host kernel and is not a hostile-tenant boundary (`SECURITY.md:25@205cc38`, `docs/COMPUTER.md:54@205cc38`).
- The README says "SQL leases recover interrupted work" (`README.md:51@205cc38`). That is true for tasks. But recovery means *re-running* the handler from its last checkpoint, not resuming mid-step.

## 12. Decisions affected

- **D-approval:** adopt the OpenMuse proposal model (hash, expiry, claim, three-way outcome) as our approval spine.
- **D-tasks:** adopt the records, CAS, and lease worker on Postgres, not PGlite, because the sandbox supervisor and worker will be separate processes.
- **D-sandbox:** the API must not hold Docker access. Build a Vultr-VM supervisor that reuses the OpenMuse flag set and the inspect check.
- **D-transport:** do not depend on CopilotKit Intelligence. Stream AG-UI or SSE directly.
- **D-LLM:** a Vultr-only provider behind a thin adapter. Pick Responses vs chat-completions after the smoke test.
- **D-UI:** a web-first React UI, not Expo.

## 13. Unresolved questions

1. Does Vultr `/v1/responses` stream `response.function_call_arguments.delta` for tool-capable models (e.g. `glm-5.3`)? Does `@tanstack/ai-openai` send any fields Vultr rejects?
2. With `intelligence` configured, does `@copilotkit/runtime` 1.70.1's `/agent/:id/run` return SSE, or an Intelligence WebSocket descriptor for OpenMuse's own client? Can `CopilotRuntime` run without `intelligence`?
3. Does `@tanstack/ai` offer an OpenAI chat-completions adapter we can drop in?
4. Would a Vultr VM with gVisor/Kata allow keeping OpenMuse's `docker exec` model unchanged behind a supervisor?
5. Could the re-approval loop (§5.3: a re-run model re-proposes identical content, gets back the already-succeeded proposal, and sets `waiting_approval` again) spin in practice? It is bounded only by model behavior and `maxSteps`. Not exercised.

## 14. Effort estimates (labelled: rough engineering estimates, not measured)

| Work item | Estimate |
|---|---|
| Port `records` store + CAS + `claim` SQL to Postgres | 1–2 h |
| Port `TaskWorker` (with an indexed due-query) plus pause/cancel/retry routes | 2–3 h |
| Port `ActionService`, generalized to sandbox/browser action kinds, plus an approval card UI | 3–4 h |
| Vultr supervisor (create/exec/stop/files) reusing `runDocker` flags, `inspect()`, and `files.py` | 4–6 h |
| Browser worker deployed as-is on a second VM, plus a take-control iframe | 2–3 h |
| Vultr LLM adapter smoke test, plus a fallback chat-completions adapter if needed | 1–3 h |
| AG-UI/SSE streaming chat with tool cards (no Intelligence) | 3–5 h |
| **Total core** | **≈16–26 person-hours.** Feasible for 2–3 people in 24 h if Gmail, Calendar, PDF, ideas, goals, and mobile are omitted. |
