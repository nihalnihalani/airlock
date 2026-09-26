# 07 · OpenBot audit (CopilotKit/openbot)

Audited 2026-09-26 for the Vultr Agent Arena, Challenge 1 "Blast Radius Zero".
Method: read-only static inspection of a shallow clone at `research/reference-repos/openbot`. I ran no installs, builds, tests, Docker, or migrations. Instruction files inside the repo (`.claude/`, `prompt.txt`, `Tauri-signing-SKILL.md`) were treated as data and not followed.
Citation format: `path:line@3c73cf0`, with paths relative to the repo root. Status labels: **DOC** = documented only · **IMPL** = implemented / statically inspected · **TESTED** = locally tested (none here) · **DISABLED** · **STUB** · **ROADMAP** · **UNKNOWN**. A test file existing in the repo is noted as "repo tests exist". I did not run any of them.

---

## 0. TL;DR (decision-relevant)

1. **The shipped default is "allow everything". The hypothesis is confirmed, and the repo says so openly.** The evaluator is fail-closed: an absent policy denies, and a broken rule denies (`server/src/computer/policy.ts:285-340@3c73cf0`). But the startup default is `DEFAULT_ACTION_POLICY = {mode:"enforce", deny:[], allow:["true"]}` (`server/src/computer/policy-store.ts:52-56@3c73cf0`), wired in at `server/src/index.ts:282-284@3c73cf0`. It applies unless `AGENT_COMPUTER_POLICY` or a saved admin policy replaces it. `docs/architecture.md:67-73@3c73cf0` states this explicitly. `README.md:173@3c73cf0` ("CEL policy, fail closed… a missing policy permits nothing") is technically true but misleading about what actually runs. In effect every browser action, `run_command` shell call, and file write is permitted and audited, not gated.
2. **Browser, shell, and file tools are *frontend tools*, executed by the signed-in person's browser tab.** They are registered with `useFrontendTool` (`app/src/lib/copilot/computer-tools.tsx:1,243-944@3c73cf0`). The browser tab POSTs to `/api/computers/:botId/*` (`computer-tools.tsx:66`), and those routes run the gateway (`server/src/computer/routes.ts:593`). So there is **no unattended computer use**: routines and hand-offs cannot drive the computer (`docs/architecture.md:120-122`, `gateway.ts:516-521`). A second consequence is that **any user who can see a Bot can call `/exec` directly with curl**. The policy is the only gate, and by default it is `allow:["true"]`.
3. **Intelligence is a hard, closed, externally hosted dependency.** The server refuses to start without `INTELLIGENCE_API_URL`, `INTELLIGENCE_GATEWAY_WS_URL`, and `INTELLIGENCE_API_KEY` (`server/src/config.ts:879-906`). The defaults point at `api.intelligence.copilotkit.ai` and `realtime.intelligence.copilotkit.ai`. `.env.example:110-128` says "Do not run Intelligence yourself… self-hosting is an Enterprise… feature… not self-serve". Durable threads and memory, which means all conversation content, live off-Vultr. That **undermines "Vultr-central"** if we adopt OpenBot as-is.
4. **The single image collapses the boundary.** It runs API + Chromium + Bot shell (+ optional Postgres) in one container under s6 (`Dockerfile:1-17,155`). The shell user `pwuser` has passwordless `sudo` for `apt-get/apt/dpkg` (`Dockerfile:189-196`). That is root by well-known techniques (apt `-o …Pre-Invoke`, crafted `.deb`); this is my inference and I did not test it. `/app`, which holds the API server's source, is `chown`ed to `pwuser` (`Dockerfile:236`), while the API runs as `apiuser` from `/app/server` (`docker/s6/s6-rc.d/api/run`). The Bot's shell can therefore rewrite the server's code. The authors call this "a floor, not a boundary" (`Dockerfile:170-188`). The CI check that the shell can't read secrets tests only non-sudo reads (`.github/workflows/ci.yml:494-509`).
5. **The supervisor isolation is reasonable, but it is per-Bot, not per-user/task, and it is optional.** Settings: `CapDrop: ALL`, `no-new-privileges`, `PidsLimit 512`, optional memory cap, optional `Runtime: runsc` (`supervisor/src/docker.ts:418-457`). The supervisor holds the Docker socket, mounted `:ro`, but `:ro` does not restrict API calls (`docker-compose.yml:246`). Compose ships **public default tokens** (`openbot-dev-computer-token`, `openbot-dev-supervisor-token`: `docker-compose.yml:104,205,211`). All computers share one `COMPUTER_TOKEN` (`supervisor/src/environment.ts:15,31`). Public Bots are usable by everyone (`server/src/agents/profile-policy.ts:10`), so one Bot's cookies, logins, and workspace are shared across users.
6. **Model routing to Vultr is feasible, with caveats.** Everything OpenAI-shaped honors `OPENAI_BASE_URL` (`server/src/routing/model.ts:97-106`, `agent-bot/src/index.ts:77,107-110`, `agent-langgraph/src/index.ts:99,217`). But: the default model is `gpt-5.6-terra`, which **forces the Responses API** in the LangGraph Bot (`agent-langgraph/src/index.ts:88-90`). The server-side `BuiltInAgent` uses `openai/<model>` via the CopilotKit runtime (`server/src/copilot.ts:372`), and whether that path uses Responses or Chat Completions is UNKNOWN because node_modules are absent. Voice has hardcoded `api.openai.com` / `api.x.ai` URLs (`server/src/voice/provider.ts:120,216`). "Plan sign-in" and the model-OAuth routes hardcode Google/xAI endpoints (`server/src/provider-oauth.ts:54-58`, `server/src/google-oauth-transport.ts:238`).

**Recommendation in one line:** don't fork OpenBot for a 24h build. Adopt its *patterns*: opaque-ref snapshots resolved server-side, CEL deny-before-allow, audit-row-before-act plus a failure row, human takeover, and the four-verb supervisor with CapDrop/no-new-privileges/runsc. Pair them with our own **default-deny** policy, server-side (not browser-side) tool execution, and self-hosted persistence on Vultr.

---

## 1. Identity

| Item | Value | Evidence |
|---|---|---|
| Upstream | CopilotKit/openbot (copyright "CopilotKit") | `LICENSE:1-3@3c73cf0` |
| Branch / SHA | `main` @ `3c73cf00efba46122dfd0447485e2b61f1d6a2cd` (grafted shallow) | `git log -1` |
| Commit date | 2026-09-23 15:18:02 -0300 | `git log -1` |
| License | MIT | `LICENSE:1`, `package.json:4` |
| Version | root `0.0.15`; CHANGELOG has `Unreleased` (dictation / voice calls) above `0.0.15` (model-provider OAuth) | `package.json:3`, `CHANGELOG.md:9,32` |
| Tooling | Bun 1.3.14 workspaces `app, server, worker`; Biome; TS 5.9; `@copilotkit/aimock` for tests | `package.json:5-43` |
| Server deps | Hono 4, `@copilotkit/runtime 1.70.1`, `@ag-ui/client`, better-auth (+SSO), drizzle/postgres, `cel-js`, MCP SDK, Composio, Mastra | `server/package.json:14-35` |
| Files | ~1292 tracked files (server 450, app 390, desktop 117, agent-computer 45, charts 33) | `find` count |

**Directory map (condensed)**

```
app/                React/Vite UI (TanStack routes): channels, bot chat, live screen, admin (audit, boundaries, computers, people, plugins, playground)
server/src/         Hono API + CopilotKit runtime
  computer/         gateway.ts policy*.ts snapshot-store.ts target.ts provider.ts supervisor.ts sandbox.ts(k8s) routes.ts
  agents/           AG-UI endpoints, handoff, callback tokens, plan-model (ChatGPT/Claude plan sign-in)
  auth/             better-auth, roles, dev-actor (single-user)
  channels/ routines/ work/ (PG queue) plugins/ (MCP, Composio, skills) voice/ dictation/ host-access/ (desktop)
agent-computer/     Bun + Playwright Chromium, /workspace, profiles, /exec shell, screencast WS, human control
supervisor/         Docker-socket holder; 4 verbs: ensure/stop/reset/list per Bot
worker/             local routine loop (stand-in for k8s CronJob)
agent-bot/          PoC AG-UI Bot (OpenAI SDK, chat/completions by hand)
agent-langgraph[-agui]/ framework Bot (LangChain ChatOpenAI/Anthropic/Google)
agent-{adk,ag2,agno,claude-sdk,crewai,langroid,llamaindex,mastra,microsoft,pydantic-ai,strands}/  framework harness adapters (AG-UI)
charts/openbot/     Helm: server, computer (StatefulSet or agent-sandbox CRD), culler CronJob, routines CronJob, NetworkPolicy
docker/s6/          s6-overlay services for the one-container image
spire/              optional SPIFFE/SPIRE server+agent confs
desktop/            Tauri app (Rust) incl. host_access.rs (runs containers on the user's machine)
tests/smoke/        journey.test.ts (OPENBOT_SMOKE=1)
.github/workflows/  ci.yml, release, desktop signing, zizmor
```

**CI** (`.github/workflows/ci.yml@3c73cf0`) has these jobs: static (fmt/lint/types, `:22`), deployables types (`:64`), chart render + refusal checks (`:90-191`), tests against a pgvector service (`:194-248`), startup matrix (`:249`), Python harness regressions (`:266-349`), build (`:362`), migrations drift (`:378`), and image boot plus the "shell cannot reach secrets" check (`:411-509`). The repo has **349 test files**. I ran none of them.

**File-coverage ledger**

| Class | Files / areas |
|---|---|
| Inspected (read or targeted greps with line cites) | `docs/architecture.md` (full), `README.md` (sections), `.env.example` (auth, Intelligence, model, policy, supervisor), `Dockerfile`, `agent-computer/Dockerfile`, `docker-compose.yml` (computer, supervisor, networks), `docker/s6/**` (all run/up scripts), `server/src/computer/{policy,policy-store,gateway,routes,sandbox}.ts`, `server/src/config.ts` (single-user, Intelligence, computer, policy), `server/src/auth/{dev-actor,roles}.ts`, `server/src/agents/profile-policy.ts`, `server/src/intelligence-client.ts`, `server/src/copilot.ts` (runtime/model), `server/src/routing/model.ts`, `server/src/app.ts` (mounts, agent-tools callback), `server/src/audit.ts` (insert), `server/src/work/culler.ts`, `server/scripts/cull-idle-computers.ts`, `supervisor/src/{index,docker,environment,names}.ts`, `agent-computer/src/{authorisation,shell,workspace,profiles}.ts` (parts), `app/src/lib/copilot/computer-tools.tsx` (tool list), `agent-bot/src/index.ts`, `agent-langgraph/src/index.ts` (model), `server/src/voice/provider.ts`, `server/src/provider-oauth.ts` (URLs), module headers of ~15 more files |
| Generated / vendored | `bun.lock`, `server/drizzle/meta/*`, `desktop/src-tauri/gen`, `assets/*.svg`, `CHANGELOG.md` (skimmed only) |
| Irrelevant to Challenge 1 | `desktop/**` (Tauri, signing), `Tauri-signing-SKILL.md`, `docs/windows-signing.md`, `docs/releasing.md`, Composio adapter internals (~4.7k lines), theme/gallery UI |
| Deferred (not read in depth) | `agent-computer/src/index.ts` handlers beyond line refs, `aria-snapshot.ts`, `screencast.ts`, `control.ts` bodies, the 11 Python/TS harness adapters, `charts/openbot/templates/**` beyond greps, `server/src/plugins/{mcp,tools,store}.ts` bodies, `server/src/channels/**`, `server/src/routines/**`, `spire/*.conf`, all tests |

---

## 2. Capability families

### 2.1 React web surfaces

| Capability | Trace | Status |
|---|---|---|
| Channels / coworkers / bot chat | `app/src/routes/_authed/_app/{channel/$channelId,bot,agents/index}.tsx` → CopilotKit React v2 → `/api/copilotkit` (`server/src/app.ts:1090-1098`, `copilot.ts:2022,2195`). Coworkers = `agents` + `agent_profiles` + `agent_preferences` (`docs/architecture.md:142-150`) | IMPL |
| Rich components / generative UI | Compiled gallery plus sandboxed components published from `/admin/playground` (`docs/architecture.md:172-188`). `openGenerativeUI` / A2UI flags (`copilot.ts:2143-2163`) | IMPL |
| Live screen | Chrome screencast over WS (`agent-computer/src/screencast.ts:1-8`), proxied by the server behind the Bot access check (`docs/architecture.md:136-138`; `server/src/index.ts:1387-1400` WS upgrade) | IMPL |
| Activity tab | Client-memory only, "gone on reload" (`docs/architecture.md:140`) | IMPL (ephemeral) |
| Human takeover | `agent-computer/src/control.ts:1-8`. Acting paths are refused while a human holds control (`agent-computer/src/authorisation.ts:52-80`). Audited as `computer.control_taken/released/help_requested` (`gateway.ts:1180-1213`) | IMPL (repo tests: `server/tests/control-refusal-end-to-end.test.ts`) |
| Secret entry | `computer_request_secret` frontend tool (`computer-tools.tsx:517`). The audit trail records length only (`docs/architecture.md:134`) | IMPL |

### 2.2 API, AG-UI, CopilotKit runtime, adapters

- **Hono app**: all routes use `requireUser`, and admin routes use `requireAdmin` (`server/src/app.ts:504-1004`). The CopilotKit handler is mounted last at root with basePath `/api/copilotkit` (`app.ts:1090-1098`). Status: IMPL.
- **CopilotRuntime**: `new CopilotRuntime({identifyUser, intelligence, licenseToken, agents: createRequestAgents(...)})` (`server/src/copilot.ts:2130-2192`). Built-in Bots run in-process as `BuiltInAgent` (`copilot.ts:49,912,1496`). External Bots are AG-UI endpoints reached with `x-openbot-agent-token` (`.env.example:320-339`). SSRF checks apply to the endpoint URL (`server/src/agents/endpoint.ts:1-10`). Status: IMPL.
- **External-Bot tool callback**: `POST /api/agent-tools/call` authenticates with a per-agent hashed token plus a deployment-signed `run` assertion (`app.ts:1343-1420`). It **executes MCP refs only**, not computer tools (`docs/architecture.md:262-264`). Status: IMPL.
- **Framework adapters**: `agent-{adk,ag2,agno,claude-sdk,crewai,langgraph,langgraph-agui,langroid,llamaindex,mastra,microsoft,pydantic-ai,strands}`, selected via the compose `harness` profile (`docker-compose.yml:301-309`). CI runs Python regressions per adapter (`ci.yml:266-349`). Status: IMPL (not inspected in depth).

### 2.3 Browser / computer tools

Tool list (frontend, `app/src/lib/copilot/computer-tools.tsx@3c73cf0`): `computer_navigate:244`, `computer_read:343`, `computer_snapshot:353`, `computer_type:381`, `computer_click:431`, `computer_key:477`, `computer_request_secret:518`, `report_refusal:577`, `computer_request_help:614`, `computer_list_files:667`, `computer_read_file:714`, `computer_run_command:759`, `computer_write_file:844`, `computer_scroll:911`.

| Capability | Caller → handler → authz → side effect → persistence → error | Status |
|---|---|---|
| Snapshot + opaque refs | Frontend tool → `POST /api/computers/:botId/snapshot` (`routes.ts:273`) → gateway stores the snapshot (DB-backed `snapshot-store.ts:1-8`). Later acting calls send `{ref, snapshotId}`. The server resolves the element and never trusts caller labels (`gateway.ts:1-19`). A stale ref after the decision row gives `StaleSnapshotError` plus a failure row (`gateway.ts:549-581`) | IMPL (repo tests: `computer-snapshot-*.test.ts`) |
| navigate / click / type / key / scroll | `routes.ts:230-345` → Bot access check `routes.ts:65-90` → `evaluateActionPolicy` → audit row → agent-computer `/navigate` etc. (`agent-computer/src/index.ts:894-1098`). The URL floor is http/https only plus metadata IPs, with **no DNS resolution and no redirect following** (`server/src/computer/target.ts:1-40`) | IMPL |
| Screenshots | `GET /:botId/screenshot` (`routes.ts:97`) → `agent-computer /screenshot` (`index.ts:935`). A read, so no policy decision | IMPL |
| Downloads | No download handler found (grep `download` in `agent-computer/src/index.ts` returns nothing) | UNKNOWN / not implemented |
| File ops | `/files/{list,read,write}` (`routes.ts:566-650`). Workspace confinement via realpath and `..` refusal (`agent-computer/src/workspace.ts:103-160`). Only the path goes into audit, never content (`gateway.ts:1122-1125`) | IMPL |
| Shell exec | `computer_run_command` → `POST /:botId/exec` (`routes.ts:593`) → gateway (`command` in the policy context, `gateway.ts:515`) → `agent-computer /exec` (`index.ts:1003`) → `spawn("/bin/bash",["-c",cmd])` in `/workspace`, with an allow-listed env, 120s default / 600s max timeout, 64KB output cap (`agent-computer/src/shell.ts:1-120,266-268`). The shell is **not** egress-restricted, so the metadata block applies to navigation only | IMPL |

### 2.4 Gateway authorization / policy engine

- **Order**: resolve target → evaluate → **write audit row** → act only if `forward`. A failed act writes a second row (`gateway.ts:532-620`). If the audit insert throws, the action is not performed, because `recordAuditEvent` awaits `store.insert` with no catch (`server/src/audit.ts:557-586`). So audit-before-action is fail-closed. IMPL.
- **Rule language**: CEL via `cel-js`, plus case-insensitive `contains()` / `matches()`. Deny is evaluated before allow. A broken deny counts as a match (denies). A broken allow does not permit. No match gives a default refusal (`policy.ts:293-340`). Every context field is bound to a neutral value so rules can't throw on other surfaces (`gateway.ts:480-530`).
- **`dry-run` mode forwards denied actions** (`policy.ts:313,337`). It records `carriedOut:true` (`gateway.ts:1160-1164`).
- **Effective startup default**: `DEFAULT_ACTION_POLICY = {enforce, deny:[], allow:["true"]}` (`policy-store.ts:41-56`), used when `config.computer.policy` is unset (`index.ts:282-284`). A malformed `AGENT_COMPUTER_POLICY` fails startup (`config.ts:1102-1127`). A saved admin policy is loaded from the DB at boot (`index.ts:287`) and fanned out via PG NOTIFY (`policy-store.ts:33-39,85-118`). The example restrictive policy in `.env.example:278` is commented out, and it too ends with `"allow":["true"]`.
- **Hypothesis verdict: CONFIRMED.** The engine is fail-closed. The shipped configuration is allow-all. The docs disclose this (`docs/architecture.md:67-73`), while the README headline stresses fail-closed (`README.md:173`).
- **Policy admin**: `GET/PUT /api/computers/policy` and `/policy-dry-run` are admin-only (`routes.ts:651-702`). In single-user mode *every visitor is admin* (see 2.6), so every visitor can also rewrite the policy.
- **Initiator**: computer actions always carry `initiator = person` because they come only from browsers (`gateway.ts:516-521`).

### 2.5 Supervisor lifecycle, isolation, persistence

| Topic | Finding | Evidence | Status |
|---|---|---|---|
| Providers | `sandbox` (k8s agent-sandbox CRD) > `docker` (supervisor) > `shared` (single `AGENT_COMPUTER_URL`) | `config.ts:1040-1099`, `sandbox.ts:1-24` | IMPL |
| Supervisor API | 4 verbs, Bearer token (**plain `!==` compare**, not constant-time), Bot-id-derived names, ownership labels | `supervisor/src/index.ts:19-47,77-84,95-134`, `names.ts:67-90` | IMPL |
| Docker socket | Mounted `${ENGINE_SOCKET}:/var/run/docker.sock:ro`. `:ro` does not limit the Docker API. `label=disable` | `docker-compose.yml:246-251` | IMPL |
| Container hardening | `CapDrop ALL`, `no-new-privileges`, `PidsLimit 512`, optional `Memory`, `ShmSize 1GB`, `RestartPolicy unless-stopped`, loopback-only port unless on a network | `supervisor/src/docker.ts:418-457` | IMPL |
| gVisor | `COMPUTER_RUNTIME=runsc` → `HostConfig.Runtime` (default unset = shared kernel) | `supervisor/src/index.ts:65,108`, `docker.ts:447`, `.env.example:360-362` | IMPL (opt-in) |
| k8s gVisor | `computers.runtimeClassName: ""` by default | `charts/openbot/values.yaml:212`, `templates/computer/statefulset.yaml:91-92` | IMPL (opt-in) |
| Chromium sandbox | `--no-sandbox` unless `COMPUTER_SANDBOX=on` | `agent-computer/src/profiles.ts:94-98,422-425` | IMPL (default off) |
| agent-computer image user | No `USER` directive, so it **runs as root** in its own container. The compose shared `agent-computer` service has no cap_drop / security_opt | `agent-computer/Dockerfile` (whole), `docker-compose.yml:73-126` | IMPL |
| Mapping | **One computer per Bot id**, not per user/task/session. Public Bots are usable by all users (`canAccessAgent`: `visibility === "public"`), so logins, cookies, and workspace are shared across users of a Bot | `supervisor/src/index.ts:95-111`, `profile-policy.ts:3-25` | IMPL |
| Shared mode | All Bots share one container and one `/workspace` | `docs/architecture.md:81`, `agent-computer/src/index.ts:250,292` | IMPL |
| Persistence | Named volumes per Bot for `/profiles` and `/workspace` | `docker.ts:422-429,506-518` | IMPL |
| Idle cleanup | PG-queue culler, **only for the `sandbox` (k8s) provider** (the script throws otherwise). Docker computers are never suspended. There is an in-process browser eviction (`COMPUTER_BROWSER_IDLE_MS`, max browsers 8) | `server/scripts/cull-idle-computers.ts:22-33`, `work/culler.ts:1-13`, `docker-compose.yml:107-112` | IMPL |
| Token model | One `COMPUTER_TOKEN` for all computers, public defaults in compose. A same-uid shell can likely read it from the computer process's `/proc/<pid>/environ` (inference, untested) and use it to reach sibling computers on a shared `COMPUTER_NETWORK` | `supervisor/src/environment.ts:15,31`, `docker-compose.yml:104,211` | Inference |
| SPIRE | Optional per-Bot SVIDs. `start.sh` doesn't start it | `docker-compose.yml:127-180`, `docs/architecture.md:28` | IMPL (optional) |

### 2.6 Identity, roles, grants, credentials, MCP, routines

- **Sign-in**: Google, Microsoft, or Okta via env, plus runtime SAML/OIDC via better-auth SSO. `INITIAL_ADMIN_EMAILS` is an admin floor (`docs/architecture.md:337-344`, `auth/roles.ts:1-30`). IMPL.
- **Single-user mode**: with no provider, the server refuses to start unless `OPENBOT_SINGLE_USER=true` (`auth/dev-actor.ts:67-85`). `.env.example:46` **ships it on**. The guard admits *every request* as `DEV_ACTOR {role:"admin"}` (`dev-actor.ts:25-29,88-95`). The public-exposure check reads only *configured URLs* (`OPENBOT_PUBLIC_URL`, `OPENBOT_APP_URL`, `TRUSTED_ORIGINS`) (`config.ts:453-486`). The example `TRUSTED_ORIGINS=http://localhost:3010` (`.env.example:109`) passes as loopback. The README's deploy command is `docker run -p 3001:3001 --env-file .env` (`README.md:120-130`), and Bun `serve` is called with no `hostname` (`server/src/index.ts:1387-1389`), so it binds all interfaces. The log line claims `127.0.0.1` (`index.ts:1515`). **On a Vultr VM with a public IP, this admits public users as admin** (inference from code, untested). One friction point: the example `KEY_ENCRYPTION_KEY` is refused under `NODE_ENV=production` (`config.ts:400-423`), and the image sets `NODE_ENV=production` (`Dockerfile:243`), so an operator must at least rotate that key first.
- **External agent identity**: per-agent callback token (hashed) plus a signed run assertion (`app.ts:1358-1420`). Hand-offs are via `plugin_grants` bot-kind, with depth/fan-out caps (`docs/architecture.md:190-249`). IMPL.
- **Credentials**: AES (`credentials.ts:144-189`) under `KEY_ENCRYPTION_KEY`, redacted from audit (`audit.ts:563`). IMPL.
- **MCP**: grant check → the same policy engine with `mcp.*` context → audit. Unknown or custom tools are treated as writes (`docs/architecture.md:283-294`). MCP tools execute **server-side** as runtime tools (`plugins/tools.ts` header). IMPL (not deeply traced).
- **Routines**: PG `work_items` queue with `FOR UPDATE SKIP LOCKED` plus leases (`work/queue.ts:1-10`). Run headless as the owner (`routines/runner.ts:1-8`). The local `worker/` loops it (`worker/src/index.ts:1-18`). **No computer access in routines** (see 2.7). IMPL.

### 2.7 Durability, reconnect, cancellation, frontend tools

- Threads, memory, and realtime come from **CopilotKit Intelligence** (external). "There is no degraded mode" (`.env.example:110-113`). Status: IMPL, external.
- Stall watchdog: silence-based `AGENT_STALL_TIMEOUT_MS=60000` (`.env.example:136-157`, `channels/turn-watchdog.ts`). Browser tool calls "run between turns… the run ends before the browser executes the tool and a second run carries the result back" (`.env.example:154-156`). That is the frontend-tool round-trip.
- Stop: `ComputerStoppedError` is recorded as `computer.action_stopped` (`gateway.ts:600-603,1097-1103`).
- **Frontend-mediated tools (cannot run unattended)**: all `computer_*` tools and `report_refusal` (`computer-tools.tsx`), the skill-authoring tools `list_skills/read_skill/list_skill_tools/save_skill` (`docs/architecture.md:298-302`), and component/gallery tools (`app/src/lib/copilot/{gallery,sandboxed,bot}-tools.tsx`). **Server-side (unattended-capable)**: MCP/plugin tools, `message_bot`, `ask_person`.
- Hand-off replay: durable queued hops with renewed leases, and failed hops are announced (`docs/architecture.md:230-239`). IMPL.

### 2.8 Single-image deployment path

`Dockerfile` puts API (`apiuser`), Chromium + shell (`pwuser`), and optional Postgres (`postgres`) in one container (`docker/s6/s6-rc.d/{api,computer,postgres}/run`). Mitigations present: the shell env is `env -i` allow-listed (`computer/run`, `shell.ts:84-116`), there is a per-boot generated `COMPUTER_TOKEN` (`scripts/computer-token.sh`), and Postgres uses a scram password stored 0600 (`scripts/postgres-init.sh:4-10,43-74`). Weaknesses:
- `sudo NOPASSWD` for apt-get/apt/dpkg means the shell can reach root (inference). Root can then read `/run/s6/container_environment/*` (DATABASE_URL with password, KEY_ENCRYPTION_KEY, and so on).
- `/app` is owned by `pwuser` (`Dockerfile:236`), so the shell can modify the API's source.
- No supervisor, so all Bots share one browser and workspace (`Dockerfile:12-15`).

**Verdict: yes, it collapses untrusted execution into the app boundary.** The authors say so themselves (`Dockerfile:183-186`).

### 2.9 Every model call

| Call site | Provider path | Base-URL knob | Hardcoded default | Evidence |
|---|---|---|---|---|
| Built-in Bots (in-process) | CopilotKit `BuiltInAgent`, model string `openai/<m>` or `anthropic/<m>`, or `PlanModel` | `OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL` (read by the runtime SDK, normalized at `copilot.ts:166-180`) | default model `gpt-5.6-terra` (`copilot.ts:203`, `examples/fintech/model.yaml`) | `copilot.ts:356-372` |
| `BOT_MODEL` override | Applies to openai **only if `OPENAI_BASE_URL` is set** | — | — | `copilot.ts:204-213` |
| Router / classify, tool-selection narrowing | raw `fetch` to `chatCompletionsUrl()` or Anthropic `/messages` | `OPENAI_BASE_URL` | `https://api.openai.com` | `routing/model.ts:11-60,97-115` |
| Channel titler, channel summaries | `chatCompletionsUrl` | same | same | `channels/titler.ts:5,45` |
| Voice call summary | PlanModel, or chat/completions, or Anthropic | same | same | `voice/summary.ts:24-107` |
| Voice realtime | OpenAI Realtime / xAI | **none** | `https://api.openai.com/v1/realtime/calls`, `https://api.x.ai/v1/realtime/client_secrets` | `voice/provider.ts:120,216` |
| Dictation | `TRANSCRIPTION_BASE_URL` (explicit, no inheritance) | yes | — | `.env.example:177-183` |
| Plan sign-in (ChatGPT/Claude subscription) | `PlanModel` endpoint | desktop-provided | — | `agents/plan-model.ts:25-70` |
| Model-provider OAuth proxy | Google Gemini / xAI | **none** (fixed by design) | `generativelanguage.googleapis.com`, `api.x.ai` | `google-oauth-transport.ts:238`, `provider-oauth.ts:54-58` |
| PoC Bot `agent-bot` | OpenAI SDK chat/completions | `OPENAI_BASE_URL` | SDK default | `agent-bot/src/index.ts:77,107-110` |
| LangGraph Bot | LangChain `ChatOpenAI` / `ChatAnthropic` / `ChatGoogleGenerativeAI` | `OPENAI_BASE_URL` etc. Responses API is forced for `gpt-5.6+` | — | `agent-langgraph/src/index.ts:79-110,197-222` |
| Python adapters (ag2, microsoft) | Anthropic fallback | `ANTHROPIC_BASE_URL` | `https://api.anthropic.com` | `agent-ag2/src/main.py:24`, `agent-microsoft/src/main.py:24` |
| Composio (optional) | third-party backend and telemetry | — | `backend.composio.dev` | `plugins/composio-adapter.ts:4714-4737` |

**To route everything via Vultr Serverless Inference**:
1. Set `OPENAI_BASE_URL=https://api.vultrinference.com/v1` and `OPENAI_API_KEY=<vultr>`.
2. Set `BOT_MODEL=<vultr model id>`, and change the tenant `model.yaml` `default_model` to it. Otherwise the server keeps `gpt-5.6-terra`.
3. Make sure the model name does **not** match `/^gpt-5\.[6-9]|^gpt-[6-9]/` and set `BOT_RESPONSES_API=false`, so the LangGraph Bot stays on chat/completions.
4. Leave `VOICE_*` unset and don't use plan sign-in, model OAuth, or Composio.
5. **Verify** that the CopilotKit runtime's `openai/<model>` path calls `/chat/completions` rather than `/responses`. This is UNKNOWN without node_modules. If it uses Responses, the built-in Bots would fail against Vultr.
6. Vultr must support streaming plus tool calls on chat/completions (see `02-vultr-and-sandbox-tech.md`).

### 2.10 Intelligence service

- **What it does**: durable threads, memory, and the realtime gateway. It is required, and the server throws at startup without it (`config.ts:879-906`; `.env.example:110-133`).
- **Deployment**: managed SaaS at `api.intelligence.copilotkit.ai` / `wss://realtime.intelligence.copilotkit.ai` (`.env.example:119-120`). Self-hosting is "an Enterprise Intelligence Platform feature deployed by Helm chart, and is not self-serve" (`.env.example:114-117`). `README.md:65` says "can be self-hosted", which conflicts with the free-tier reality.
- **Licensing**: free plan via the CopilotKit CLI project key. `COPILOTKIT_LICENSE_TOKEN` is optional (`.env.example:130-133`). The service is closed and **not** part of the MIT repo. Client: `CopilotKitIntelligence` from `@copilotkit/runtime/v2` (`intelligence-client.ts:1,72-82`).
- **Networking and persistence**: all conversation content crosses to CopilotKit's cloud. `identifyUser` scopes threads (`copilot.ts:2130-2137`).
- **Impact**: it undermines "Vultr-central orchestration" and "all state on Vultr". It also adds a sign-up/credential dependency during a 24h hackathon. Removing it means replacing the CopilotKit runtime's intelligence mode, which is deeply wired in (`copilot.ts:2120-2192`).

---

## 3. Diagrams

### 3.1 Architecture (compose / docker provider)

```
 Browser (React app :3010)                       CopilotKit Intelligence (SaaS, closed)
  ├─ CopilotKit React v2  ──AG-UI/HTTP──┐          ▲ threads / memory / realtime WS
  ├─ useFrontendTool(computer_*) ──┐    │          │
  └─ live screen WS ─────────┐     │    ▼          │
                             │     │  server (Bun+Hono :3001) ───────────────┘
                             │     │   ├─ /api/copilotkit  CopilotRuntime ── BuiltInAgent ──► LLM (OPENAI_BASE_URL)
                             │     │   │                    └─ remote AG-UI Bots (agent-bot :4200, langgraph :4201, harness :4202) ──► LLM
                             │     └──►├─ /api/computers/:botId/*  → gateway: resolve → CEL policy → audit row → act
                             └────────►├─ WS proxy (screen)                       │
                                       ├─ MCP/plugins (server-side tools) ──► external MCP / Composio
                                       ├─ Postgres (data network) ◄── audit, policy, snapshots, grants, creds, work_items
                                       └─ supervisor client ──Bearer──► supervisor :4500→4300 (docker.sock)
                                                                            │ ensure/stop/reset/list
                                                                            ▼
                                                    per-Bot container "agent-computer" :4100 (COMPUTER_TOKEN)
                                                     Chromium(--no-sandbox) + /exec bash + /workspace vol + /profiles vol
                                                     CapDrop ALL, no-new-privs, pids 512, [runsc]
```

### 3.2 Trust boundaries

```
[Internet user] ──(sign-in OR single-user=admin-for-all)──► ║B1: server session guard║
                                                             ║ canUseBot(public|owner|admin)║
[Person's browser tab] executes computer_* tools ──────────► ║B2: gateway policy+audit ║ (default allow:["true"])
[LLM output] ─ can only request tools; browser relays ─────►   (element resolved server-side from snapshot)
                                                             ║B3: COMPUTER_TOKEN (shared, dev default public)║
                                                             ▼
                                         per-Bot container (root in std image; pwuser+sudo apt in one-image)
                                         ║B4: container: CapDrop/no-new-privs/pids; kernel shared unless runsc║
                                         shell egress: UNRESTRICTED (metadata block is navigate-only)
[supervisor] holds docker.sock = host root; ║B5: 4 verbs + SUPERVISOR_TOKEN (dev default public)║
[Intelligence SaaS] receives all conversation content — outside Vultr trust domain
Single-image mode: B3/B4 collapse — API, Postgres, browser, shell share one container; /app owned by pwuser.
```

### 3.3 Representative end-to-end trace ("run `ls` in the workspace")

1. The user types into the channel composer. CopilotKit React POSTs an AG-UI run to `/api/copilotkit` (`app.ts:1090-1098`), passing `requireUser`.
2. `createRequestAgents` resolves the actor and Bot, builds a `BuiltInAgent` with `model: "openai/<m>"`, and appends `COMPUTER_GUIDANCE` to the prompt (`copilot.ts:356-372,2164-2186`). The frontend-registered tool definitions ride along in the run's `tools`.
3. The LLM (via `OPENAI_BASE_URL`) emits a tool call `computer_run_command{command:"ls"}`. The run ends, and the tool call streams to the browser (`.env.example:154-156`). The thread persists to Intelligence.
4. The browser handler (`computer-tools.tsx:759-842`) → `POST /api/computers/:botId/exec` (`computer-tools.tsx:66`; `routes.ts:593`) → `canUseBot` (`routes.ts:65-90`).
5. The gateway builds the policy context (`command:"ls"`, `initiator: person`) and runs `evaluateActionPolicy` (`gateway.ts:497-532`). With the default policy, `allow:"true"` matches.
6. It writes the `computer.action_allowed` audit row (`gateway.ts:533-547,1095-1170`), then `provider` resolves the address, and the supervisor `ensure`s the container if it isn't running (`supervisor/src/index.ts:95-111`).
7. agent-computer checks the token (`authorisation.ts:17-44`) and the human-control guard (`authorisation.ts:52-80`), then `/exec` → `spawn bash -c` in `/workspace` (`shell.ts:266-268`).
8. The result goes to the browser, which calls a second agent run carrying the tool result. The LLM answers, and Intelligence stores it. If the exec fails, a `computer.action_failed` row is written (`gateway.ts:583-610`).

---

## 4. Effective-configuration risk table

| # | Setting (as shipped) | Effect | Severity for a Vultr-VM demo | Evidence |
|---|---|---|---|---|
| R1 | Policy default `allow:["true"]` | Every click, type, shell command, and file write permitted | High | `policy-store.ts:52-56`, `index.ts:283` |
| R2 | `OPENBOT_SINGLE_USER=true` in `.env.example`; exposure check reads config URLs, not the bind | Public VM + `-p 3001:3001` = every visitor is admin (policy editor + shell) | Critical (inference) | `.env.example:46,109`, `config.ts:453-486`, `index.ts:1387` |
| R3 | One-image `sudo` apt/dpkg for `pwuser` | Root in the container holding API + DB secrets | High (inference) | `Dockerfile:189-196` |
| R4 | `/app` chowned to `pwuser` | Bot shell can modify API server code | High | `Dockerfile:236`, `s6-rc.d/api/run` |
| R5 | Compose dev tokens `openbot-dev-{computer,supervisor}-token` | Known secrets if ports are ever exposed or the network is shared | Medium | `docker-compose.yml:104,205,211` |
| R6 | `COMPUTER_RUNTIME` unset | Computers share the host kernel | Medium-High for untrusted code | `.env.example:360-362` |
| R7 | Chromium `--no-sandbox`, agent-computer runs as root | A page exploit lands as root in the container | Medium | `profiles.ts:94-98`, `agent-computer/Dockerfile` |
| R8 | Shell egress unrestricted; navigation guard has no DNS/redirect check | Metadata (169.254.169.254 on Vultr) / LAN reachable from the shell | High on a cloud VM | `target.ts:1-13`, `shell.ts` |
| R9 | Per-Bot (not per-user) computers; public Bots | Cross-user cookie, login, and workspace sharing | Medium | `profile-policy.ts:10`, `supervisor/src/index.ts:95` |
| R10 | Intelligence required (SaaS) | Data leaves Vultr; external dependency | High for "Vultr-central" | `config.ts:879-906` |
| R11 | Default model `gpt-5.6-terra` → Responses API | Breaks on non-OpenAI endpoints unless overridden | Medium | `copilot.ts:203`, `agent-langgraph/src/index.ts:88-90` |
| R12 | Docker idle culler absent (k8s only) | Containers live forever (`unless-stopped`) | Low-Medium (cost) | `cull-idle-computers.ts:28-33`, `docker.ts:445` |
| R13 | Supervisor token compared with `!==` | Timing side channel (minor) | Low | `supervisor/src/index.ts:80` |
| R14 | Audit rows plain inserts, retention sweeps delete | Not tamper-evident "receipts" | Low-Medium | `audit.ts:576-586`, `audit-retention.ts` |

---

## 5. Feature inventory (condensed)

IMPL: channels, coworkers, roster; AG-UI remote Bots + 13 framework harnesses; built-in Bots via CopilotKit runtime; opaque-ref snapshots; navigate/click/type/key/scroll/read/screenshot; workspace file ops; shell exec; CEL policy (enforce / dry-run, deny>allow, admin editor, dry-run replay against history); audit trail with initiator kinds and failure/stop rows; human takeover + secret entry; live screencast; per-Bot computers (docker supervisor / k8s agent-sandbox / shared); SPIRE identities; egress proxy per Bot; MCP connectors (Drive, Notion, custom) with grant + policy + audit; Composio; skills + narrowing; routines (PG queue, leases); Bot-to-Bot handoff + ask_person; SSO (OAuth/SAML/OIDC), roles, people admin; credential vault; generative UI / A2UI; dictation; voice calls; Tauri desktop + host access.
UNKNOWN / not found: file downloads; hash-chained or signed receipts; per-task ephemeral sandboxes; unattended computer use (explicitly unsupported today: `gateway.ts:516-521` references issue "#298").

---

## 6. Reuse recommendations (24h, 1-4 people)

| Piece | Decision | Why |
|---|---|---|
| Opaque ref snapshot → server-side element resolution | **Adapt pattern** | Core anti-spoofing idea for approvals ("never click Submit"), ~200 lines (`gateway.ts:1-19`, `snapshot-store.ts`, `aria-snapshot.ts`) |
| CEL policy with deny>allow, fail-closed, neutral field binding | **Adapt pattern** (possibly copy `policy.ts`, MIT, `cel-js`) | Ship with **default-deny + explicit allow list + `require_approval` tier**. OpenBot has no approval tier; "ask" is only `computer_request_help` / `ask_person` |
| Audit-row-before-act + failure/stop rows | **Adapt pattern** | Becomes our "receipts"; add a hash chain / signature and artifacts (stdout, screenshots) |
| Supervisor 4-verb API + `hostConfig` hardening | **Reuse/adapt** (`supervisor/src/docker.ts:418-457`) | Directly applicable on a Vultr VM. Key by **task/session**, not Bot. Always set `Runtime: runsc`, add a network egress policy, and don't use `:ro` socket theater |
| agent-computer (Playwright + /exec + screencast + takeover) | **Keep behind interface / selectively copy** | Useful reference for screencast (`screencast.ts`, Apache/BSD-derived) and takeover state machine; too large to adopt whole |
| Frontend-tool execution model | **Replace** | We need the agent loop to run server-side, or in the sandbox, so it works unattended and approvals are server-enforced. Browser-mediated tools also let any Bot user curl `/exec` |
| CopilotKit runtime + Intelligence | **Omit / replace** | Closed SaaS dependency, data off-Vultr, sign-up friction. Use AG-UI or plain SSE with our own Postgres/SQLite on Vultr. CopilotKit React without Intelligence is possible only if the runtime supports that mode (UNKNOWN in v1.70 v2 API; the repo forbids it) |
| One-container image | **Omit** | Violates "never in the app process / boundary" |
| Single-user mode | **Omit** | Use a demo token or basic auth at minimum |
| Auth/SSO, Composio, skills, routines, desktop, voice | **Omit** | Out of scope for 24h |
| Model routing via `OPENAI_BASE_URL` | **Reuse pattern** | One env var for all LLM calls; add a startup check that the model does chat/completions + tools on Vultr |

---

## 7. Findings, confidence, contrary evidence

**Findings**
- F1 Default policy is allow-all. Confidence **high** (direct code + doc).
- F2 Computer tools are browser-mediated, so there is no unattended computer use, and Bot users can call `/exec` directly. Confidence **high**.
- F3 Intelligence is a required closed SaaS. Confidence **high**.
- F4 The single image puts shell, API, and DB together, with sudo apt and `/app` owned by pwuser. Confidence **high** on config. Root escalation via apt/dpkg is **medium-high** (well-known GTFOBins technique, not executed here).
- F5 Single-user mode on a public VM admits public users as admin. Confidence **medium-high**. It depends on Bun's default `0.0.0.0` bind and on the operator not setting a public URL. Not run.
- F6 Supervisor hardening is solid but opt-in on the key axis (runsc), per-Bot rather than per-task, with shared tokens and dev defaults. Confidence **high**.
- F7 Vultr routing works for the OpenAI-shaped paths via `OPENAI_BASE_URL`. The BuiltInAgent Responses-vs-Chat question is **UNKNOWN**, and voice is hardcoded.

**Contrary evidence / nuance**
- The authors are unusually candid. `docs/architecture.md:67-73`, `Dockerfile:170-188`, and `.env.example:42-46,360-362` all disclose these risks. The allow-all default is a deliberate product choice ("a Bot that can… touch nothing is not a product", `policy-store.ts:43-50`).
- Single-user mode refuses public URLs and warns on private ones (`config.ts:453-486`), and the example encryption key blocks a naive production boot.
- Postgres is on a separate `data` network from the Bots in compose (`docs/architecture.md:79`, `docker-compose.yml:383-392`). The one-image mode uses a scram password stored 0600 (`postgres-init.sh`).
- CI verifies that the non-sudo shell cannot read `KEY_ENCRYPTION_KEY` (`ci.yml:494-509`).
- A k8s path exists with agent-sandbox, a culler, and NetworkPolicy (`charts/openbot/templates/networkpolicy.yaml`), so the gaps are mostly in the Docker and single-image paths.

**Decisions affected**
- D1 Execution plane: build our own supervisor on the Vultr VM (pattern from `supervisor/`), with runsc, per-task containers, and egress deny by default.
- D2 Agent loop location: server- or sandbox-side, not frontend tools. Approvals must be server-enforced.
- D3 Persistence and threads: self-host on Vultr. Do not take the Intelligence dependency.
- D4 Policy default: deny by default, allow-list, and a "needs approval" tier. Receipts are audit rows plus a hash chain plus artifacts.
- D5 LLM: single `OPENAI_BASE_URL` → Vultr, and chat/completions only.

**Unresolved questions**
- Q1 Does `@copilotkit/runtime@1.70.1` `BuiltInAgent` with `openai/<m>` use `/responses` or `/chat/completions`? Does it honor `OPENAI_BASE_URL`? (Needs node_modules or a docs check.)
- Q2 Can the CopilotKit runtime v2 run without Intelligence at all (in-memory/SQLite runner)? OpenBot forbids it, but the SDK might allow it.
- Q3 Does Vultr's docker bridge on a VM allow containers to reach 169.254.169.254, and what does Vultr metadata expose (user-data)?
- Q4 Is gVisor `runsc` installable on the Vultr VM image we'll use (kernel/KVM constraints)?
- Q5 CopilotKit runtime telemetry defaults: does it phone home? `telemetryProperties` is set (`copilot.ts:2141-2145`), and the repo documents no opt-out.

**Estimated integration effort (all ranges are estimates)**

| Path | Estimate |
|---|---|
| Run OpenBot as-is on a Vultr VM (compose + supervisor + Vultr LLM + Intelligence SaaS), with hardened policy and auth | 4–8 h. Risk: Q1, Intelligence sign-up, Responses API |
| Same, but remove the Intelligence dependency | 2–4+ days (deep runtime wiring). Not viable in 24h |
| Port patterns into our own stack (policy.ts + gateway audit-before-act + snapshot refs + supervisor hostConfig) | 6–12 h for 1–2 people |
| Copy the agent-computer screencast/takeover for live view | 3–6 h |
| Full fork adapted to server-side tool execution | >2 days. Not recommended |
