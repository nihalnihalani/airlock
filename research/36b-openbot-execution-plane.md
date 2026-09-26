# 36b — OpenBot execution-plane audit for Airlock

2026-09-26. **Read-only source inspection**, not a running integration. Pinned repository: `research/reference-repos/openbot`, SHA `3c73cf00efba46122dfd0447485e2b61f1d6a2cd` (verified with `git rev-parse`). All file:line references below are relative to that repository at this SHA. No installs, builds, Docker runs, exploit tests, or network/deployment tests were performed. No product code written.

## Decision

**Fork the small OpenBot supervisor as Airlock's execution substrate; do not deploy the OpenBot app or its browser computer unchanged.** Preserve its narrow resource vocabulary, ownership checks, lifecycle error handling and server-side container policy. Adapt it to task-scoped, secretless, non-root code containers with a hard lifetime and deterministic artifact collection.

For the tabulate report-to-repair workflow, the untrusted image needs Python, the pinned package/dependencies, a writable task directory and bounded command/file tools. It does not need Chromium, a browser profile, Node, Bun, an HTTP management listener, CopilotKit Intelligence, a shared computer token or sudo. The trusted supervisor can dispatch code through Docker exec and collect specific files through a constrained archive/collector path.

This is concrete source reuse, not “inspired by OpenBot” as a label. It is also **not** a claim that setting a few environment variables makes upstream OpenBot meet Airlock's threat model. The required changes are listed explicitly below.

## 1. What upstream actually does

### Standalone supervisor — valuable and separable

`supervisor/package.json` has runtime dependencies `dockerode` and `hono`. `supervisor/src/index.ts:1–17` imports local supervisor modules and Bun/Hono; it does **not** import the OpenBot server, frontend, CopilotKit runtime, database or Intelligence service. Its own Dockerfile packages this module independently, with an optional SPIRE CLI.

Its authenticated API is:

| Method/path | Implemented behavior | Source |
|---|---|---|
| `GET /health` | Unauthenticated health and Docker reachability | `supervisor/src/index.ts:77–87` |
| `POST /computers/:botId/ensure` | Validate ID, optionally register identity, create/start/reuse a configured computer and wait for readiness | `supervisor/src/index.ts:95–118` |
| `POST /computers/:botId/stop` | Stop container, retain storage | `supervisor/src/index.ts:136–148`; `docker.ts:607–619` |
| `POST /computers/:botId/reset` | Remove container and profile volume; **retain workspace volume** | `supervisor/src/index.ts:150–162`; `docker.ts:622–650` |
| `GET /computers` | List supervisor-owned resources | `supervisor/src/index.ts:164–173`; `docker.ts:187–208` |

A caller cannot supply an arbitrary image, Docker mount, Docker command, runtime or network in these requests. Those are deployment configuration (`index.ts:62–73`, `104–110`). This narrow vocabulary is a useful boundary around the Docker socket.

Names are derived from a validated plain ID (letters/digits/hyphen/underscore, maximum 64 characters), plus a deployment namespace: `supervisor/src/names.ts:15–18,30–38,67–93`. Labels identify supervisor/deployment/Bot: `docker.ts:173–184`. Name conflict handling refuses an unrelated container after Docker reports 409 (`docker.ts:533–551`). Preserve this behavior when replacing Bot identity with run identity.

### Supervisor defaults do not implement Airlock containment

`hostConfig()` at `supervisor/src/docker.ts:418–458`:

- Mounts persistent browser-profile and workspace volumes.
- Publishes an ephemeral **host-loopback** computer port if no shared network is configured; otherwise joins the configured network.
- Uses `RestartPolicy: unless-stopped`.
- Drops all capabilities and sets `no-new-privileges`.
- Memory limit and runtime are **optional**.
- PID limit defaults to 512; shared memory is 1 GiB for Chromium.
- Does not specify a CPU cap, readonly root filesystem, non-root user, disk quota, no-network default, per-run wall-clock expiry or a cleanup janitor in this function.

`createContainer` does not override user (`docker.ts:522–532`). `inspectOwned()` checks ownership labels and retrieves status/image/token/start time, but does **not** compare every hardening field against desired settings (`docker.ts:215–246`). `ensure()` replaces on image/token change, otherwise reuses/starts existing containers (`docker.ts:468–504,555–599`). Therefore “ensure returned ready” is not evidence that an existing container has Airlock's complete required configuration.

**Critical lifecycle finding:** `reset` leaves the workspace alone by design (`docker.ts:622–650`). Calling reset after a malicious run does not provide a fresh workspace. Giving each new task a unique ID helps isolation, but without deleting task volumes it leaks storage and retained untrusted content. Airlock needs a distinct destroy operation that removes the whole owned run, not a renamed upstream reset.

### Agent-computer is a separate service, but wrong-sized for this task

`agent-computer/Dockerfile:5–22` copies Node and Bun into Ubuntu and installs Chromium with Playwright dependencies. Its package includes Playwright, SPIFFE and YAML. It exposes port 4100 and runs Bun (`Dockerfile:36–42`). **There is no `USER` instruction** in that Dockerfile; the supervisor does not override user, so this standalone default runs as root. This is a source-level conclusion, not a measured container inspection.

Its entrypoint initializes browser mode/display and verifies both workspace and profile directories (`agent-computer/src/index.ts:89–104,248–259`), then creates shell/workspace/browser services in one runtime. Browser and shell are not separate trust domains. It requires `COMPUTER_TOKEN` at startup (`index.ts:81–87`). Policy and audit are explicitly absent from this service; the intended gateway provides them (`index.ts:44–50`).

Measured image size and cold start are **unknown**. Do not invent an MB/GB number. The source is sufficient to conclude that the browser/toolchain stack is unnecessary for a Python-only repair and complicates startup.

## 2. Can file/read/write/exec work without the original app?

**Yes at the protocol/module level. No Intelligence dependency is required for these endpoints.** A caller holding the computer token can call the standalone service directly. The current external gateway and UI are not required to execute them.

| Endpoint | Request | Response/behavior | Source |
|---|---|---|---|
| `POST /files/read` | `{path}` | Workspace-relative UTF-8 text, byte count and truncation flag | `agent-computer/src/index.ts:964–975`; `workspace.ts:253–281` |
| `POST /files/list` | `{path?}` | Recursive workspace listing, bounded entry count | `index.ts:978–993`; `workspace.ts:220–250` |
| `POST /files/write` | `{path, contents, append?}` | Creates parent dirs, writes text, returns size | `index.ts:1033–1053`; `workspace.ts:284–307` |
| `POST /exec` | `{command, timeoutMs?}` | Runs shell, returns command/exitCode/stdout/stderr/truncated/timedOut/elapsedMs | `index.ts:1003–1030`; `shell.ts:39–47,210–363` |

Auth accepts `x-openbot-computer-token` or bearer auth (`authorisation.ts:33–42`). `x-openbot-bot-id` selects session state (`index.ts:197–203`). Missing/incorrect token returns 401; malformed Bot ID returns 400 (`index.ts:644–663`). Shell/write actions are refused during human browser takeover (`index.ts:674–683`); this is useful for browser workflows but irrelevant to Airlock's code-only worker.

However, directly adopting this service creates avoidable exposure:

1. **Shared computer credential:** supervisor forwards `COMPUTER_TOKEN` into every child (`supervisor/src/environment.ts:15,31–38`); Compose confirms it is shared (`docker-compose.yml:200–202`). Shell child environment scrubbing does not isolate the token-bearing parent process or sibling services from code in the same container. Root/default process permissions make this especially unsuitable. Exploitability across a specific hardened deployment was not tested.
2. **Shared workspace:** `createWorkspace()` is instantiated once from `WORKSPACE_DIR`, not keyed by the per-request Bot ID (`agent-computer/src/index.ts:257–259`). Header-based browser sessions do not create distinct file/shell boundaries.
3. **Root and writable runtime:** a shell runs with the service's UID unless another boundary changes it; `spawn()` supplies no user (`shell.ts:266–270`). Even non-root same-UID code should not be assumed unable to inspect/alter its peer process.
4. **File tools are convenience constraints, not shell constraints:** `workspace.ts` checks absolute/traversal/symlink paths, but arbitrary shell code can use ordinary filesystem syscalls. Container mount/user policy supplies the actual accessible boundary.

**Recommended reuse:** retain endpoint/result schemas as an internal tool contract, selected input validation, and bounded output/cancellation patterns. Dispatch through the trusted host supervisor into a lean container. Do not expose a token-bearing general computer HTTP service inside that container.

**Do not make the dangerous porting mistake:** importing `createShell()` into the supervisor and calling it there would execute untrusted commands on the worker host. `shell.ts` is intended to execute *inside* the computer container. Reusing its result shape or adapting its logic around Docker exec is different from calling its host `spawn`.

## 3. Execution transport and UI wiring

Upstream's normal chain is:

`CopilotKit frontend tool → /api/computers/:botId/... → server gateway → provider.locate/ensure → agent-computer HTTP → shell/browser`.

- `app/src/lib/copilot/computer-tools.tsx:1,52–70` imports `useFrontendTool` and calls the authenticated server route from the user's browser. `computer_read_file`, `computer_run_command` and `computer_write_file` are registered at `713–785,843–870`.
- `agent-bot/src/index.ts:15–24` explicitly says tools come from `input.tools`, and the loop ends on a tool call so the client executes it and begins the next run.
- `server/src/computer/gateway.ts:924–985` governs file/command actions then sends `/files/read`, `/files/list`, `/exec`, `/files/write`.
- `server/src/computer/client.ts:157–172,203–222` sets Bot/token headers and merges caller cancellation with request timeout.
- `server/src/computer/supervisor.ts:206–217` calls ensure for location; the returned URL can be a container-network name or worker-host loopback URL. Across two VMs, `127.0.0.1` in that result refers to the worker and cannot simply be fetched by the remote control plane. Airlock's host-supervisor execution API avoids this address confusion entirely.

**Airlock change:** the durable server worker owns the model→tool→result loop. The browser subscribes to persisted run events and sends pause/cancel/approve requests. Closing the tab must not stop orchestration or become a tool dependency. AG-UI event encoding is optional; SSE is sufficient. The upstream AG-UI bot provides reusable stream/event mapping, **not** the unattended durable execution loop Airlock needs.

Pure rendering components such as `CommandOutput`/`ToolLine` can be copied with attribution if their dependencies are inexpensive; their surrounding frontend handlers should not be reused as execution owners. This review inspected the importing/usage sites, not those components' full implementations.

## 4. Policy gateway: retain principle, narrow implementation

`gateway.ts:9–18` establishes the right sequence: resolve authoritative target → evaluate policy → record audit → act. Browser targets are resolved from server-held snapshots rather than model-supplied labels. For Airlock the equivalent is: resolve server-owned run/artifact ID → validate task/phase/tool schema → append dispatch event → execute in that exact sandbox.

`policy.ts:293–341` is fail-closed when no rule allows an action, with deny preceding allow and broken deny expressions denying. But the shipped policy store supplies `allow: ["true"]` (`policy-store.ts:52–56`). A deployment can also configure `dry-run`, in which denials may still forward. Never infer an enforced policy from a red UI row.

Do not import the entire 988-line browser gateway solely to run Python. Its audit/provider/snapshot/actor/page-frame dependencies solve a larger product. For the MVP, a typed phase-aware tool registry is simpler. If reusing `policy.ts`, keep only the required contexts/types and make explicit enforced allow rules for run-scoped file/exec actions. A command-text regex is not the containment boundary.

## 5. Recommended Airlock substrate and changes

### Proposed APIs — new, not present upstream

A trusted host supervisor offers fixed resource profiles, not a Docker passthrough:

- Create a run from a server-selected pinned image/profile and base artifact.
- Execute a bounded command in that already-owned run; caller cannot choose Docker flags, container ID, user, image, mounts or network.
- Read/write/list bounded files in the run workspace.
- Freeze declared source paths into an immutable artifact after stopping untrusted execution.
- Destroy the owned run and all its temporary storage; list/status support janitor reconciliation.

Only trusted orchestration calls these APIs. The model receives tools bound to its own run by the server; it never gets the supervisor token, raw IDs of other runs, or create/destroy capabilities outside its task. Supervisor auth stays on the trusted processes/hosts, never in task containers.

### Required default profile

- Pinned Python image by digest; dependencies prepared before the run.
- Explicit non-root UID/GID; no sudo; root filesystem readonly where compatible.
- Dedicated writable workspace per run, bounded `/tmp`, all capabilities dropped, no-new-privileges, mandatory runtime selection validated at startup.
- Mandatory memory/CPU/PID limits and a host-enforced absolute wall-clock deadline. A command timeout is insufficient: background children can outlive the shell or create a new process group.
- No public ports and **no network** for authoring/reproduction where possible. Docker exec/file transfer does not require an application network interface.
- No profile volume, SPIRE socket, Docker socket, host bind mount, model/provider/GitHub token or management HTTP token inside the task container.
- No automatic restart; fresh source/task workspace on each run; idempotent destroy removes workspace too.
- Startup/attachment verifies current image/user/mount/network/resource/security configuration, not just owner labels and image tag.
- A host janitor destroys expired labeled runs even when the control plane crashes. Quotas/concurrency limits prevent many small runs exhausting the host.

For independent HTTP verification, the frozen candidate server needs a deliberately narrow verifier-to-candidate connection or fixed supervisor request/response relay. Do not silently attach it to the shared management network to make HTTP convenient. Authoring can remain network-none. A relay must have a fixed local target selected by the supervisor, method/body/response limits, and no caller-selected URL.

## 6. Artifact collection is a new security-sensitive component

OpenBot exposes text files, not an immutable patch-freeze protocol. Do not accept a candidate's `git diff` text, `receipt.json` or “all tests passed” as trusted final evidence.

Recommended flow:

1. Mark the run `freezing`; reject further writes/exec and stop all untrusted processes. Retain that run's dedicated workspace volume only until collection completes.
2. Collect **only** expected regular source files from the known root. For the tabulate hero, the allowlist can be one/few package files. Reject symlinks, hardlinks, special files, traversal, duplicates, excessive sizes and unexpected file names; impose aggregate bytes/file-count limits.
3. Compute the diff against a trusted pinned baseline outside the author's workspace. Record source bytes, baseline SHA, canonical artifact digest and capture status. Never execute candidate hooks or trust candidate `.git` configuration during this step.
4. Copy accepted bytes into fresh candidate sandbox(s) created from the trusted image; separately instantiate baseline. The verifier receives no agent-produced tests as its oracle.
5. Observe bounded behavior from outside the candidate runtime, persist the verdict separately, and serve the same frozen artifact through the trusted text/table UI and download path.
6. Destroy original workspace/container and baseline/candidate run resources after their defined lifetimes. Keep only validated artifact bytes and bounded evidence.

Collection options need a quick deployment spike: Docker archive API from a stopped workspace-containing container, or a small **isolated, no-network collector** with a read-only mount of the run volume and a fixed file manifest. Do not unpack an untrusted archive directly into host paths. A collector should produce bounded bytes, not arbitrary host-side tar extraction. Preserve file-freeze atomicity; checking symlinks and then letting the agent continue writes is not a freeze.

**Tmpfs tradeoff:** stopping a container destroys tmpfs-backed state. If using tmpfs workspaces, collection must occur under a tested pause/freeze strategy before destruction. For the MVP, a dedicated named volume retained only through stopped-container collection gives a clearer lifecycle; delete it explicitly afterward. Do not both promise stop-before-collect and choose a disappearing workspace.

### Newly observed file-tool limits

- `workspace.ts:271–279` calls `readFile(full)` **before** slicing to the configured 64 KB response limit. This bounds returned text, not memory allocated for an arbitrarily large file. Do not reuse it as a host-side hostile-file reader without streaming/capped reads.
- The 1 MB write cap is per request (`workspace.ts:293–305`); repeated appends and shell writes can fill storage. It is not a volume quota.
- Path resolution checks and subsequent file access are separate operations. A concurrent shell mutating symlinks must be included in the threat model; this audit did not test a race exploit. Stopping the author before collection avoids relying on those checks against a concurrently mutating workspace.

## 7. Two VMs versus stronger separation

### Two-VM minimum that is honest for the hackathon

**VM A, control/verification:** web UI/API, Vultr model client, durable orchestration (OpenMuse-derived), task/policy/event store, trusted external behavior grader, artifact hashes and downloads. No Docker socket. The grader parses bounded results; it never imports/executes the package or agent code.

**VM B, execution:** adapted OpenBot supervisor and Docker/gVisor; disposable author, baseline and candidate containers. Only the supervisor has Docker control. Management access is restricted to VM A; task containers cannot reach management services or each other.

This separates untrusted execution from the application/model keys and makes the oracle separate from the candidate interpreter. **It does not protect verification against a full escape that compromises VM B's host or supervisor.** If both baseline and candidate responses are delivered by a compromised host, that host can lie. State that trust boundary; don't call it independent-host attestation.

### Preferred stronger layout if the claimed threat includes author-host compromise

Add **VM C, verifier execution host**, with its own minimal supervisor and fresh baseline/candidate containers; retain the external grader on VM A. Author host B never gains C's control credentials, test cases, mutable volumes or routes. Transfer only validated source artifacts. This materially separates author-host compromise from verification execution, though C's own container/runtime remains trusted and finite tests remain finite evidence.

Do not add VMs merely to look distributed. A separate process/container on B is enough to prevent ordinary interpreter/file tampering with the oracle when the host remains trusted. A third execution VM addresses a stronger host-compromise claim. Neither topology requires one VM for every named agent or a separate Kubernetes cluster.

## 8. Concrete reuse map

| Upstream module | Reuse decision | Required Airlock change |
|---|---|---|
| `supervisor/src/names.ts` | Reuse validation/derived names/namespace concept | Use task-run IDs and generation, not durable Bot ID; preserve collision checks |
| `supervisor/src/docker.ts` | Fork lifecycle/ownership/error handling | Mandatory hardened profile; remove browser health/port/profile; new exec/file/freeze paths; true destroy; no restart; hard TTL |
| `supervisor/src/index.ts` | Reuse small authenticated service structure | Task API and resource quotas; startup validation; no arbitrary Docker passthrough |
| `supervisor/src/environment.ts` | Replace most content | No shared computer token, proxy credentials or SPIRE socket in child environment |
| `supervisor/src/identity.ts` | Omit for MVP | Avoid SPIRE socket/CLI/attestation deployment work |
| `server/src/computer/supervisor.ts` | Borrow error semantics and ID-based provider abstraction | Return handles/results, not worker loopback URLs; do not auto-ensure after terminal run destruction |
| `agent-computer/src/shell.ts` | Borrow output shape, bounded stream collection, cancellation ideas | Execute through container API; never call its host spawn in supervisor; container kill backs per-command timeout |
| `agent-computer/src/workspace.ts` | Borrow schema/path-validation cases cautiously | Stream reads, aggregate limits, immutable collection, no-follow regular-file rules; not a host filesystem boundary by itself |
| `agent-computer/src/index.ts` / Dockerfile | Do not deploy | Replace browser/token-bearing service with lean code runner |
| `server/src/computer/policy.ts` | Optional small extraction | Enforced explicit allow rules with server-known run/phase; default denied |
| `server/src/computer/gateway.ts` | Reuse resolve→policy→audit→act principle | Avoid copying browser/snapshot dependency graph |
| `app/.../computer-tools.tsx` | Presentation/reference only | Tools execute server-side; UI displays trusted persisted events |
| `agent-bot/src/index.ts` | Optional event/stream reference | No client-owned continuation; Vultr-only enforced endpoint; durable loop elsewhere |
| Root app/server/Compose | Do not fork/deploy wholesale | Avoid Intelligence requirement, shared app/computer image and development tokens |

## 9. Full-app problems confirmed from source

- `server/src/config.ts:879–905` throws unless all required Intelligence API/WS/key settings exist and returns `mode: intelligence`. This requirement belongs to the full app, **not the standalone supervisor**.
- `docker-compose.yml:103,200–202` ships named development computer/supervisor token defaults. They are configuration conveniences, unsuitable public deployment credentials.
- Root `Dockerfile:189–194` configures passwordless package-manager sudo; `/app` is owned by the shell user at `235–236`. Source comments themselves call the combined image a floor rather than an isolation story. Do not use it for hostile report execution alongside control secrets.
- The direct supervisor Docker socket mount is labeled readonly in Compose (`246`), but its Docker API remains capable of mutations. The code needs that ability; readonly mount syntax does not make Docker access readonly. The supervisor is a trusted, host-powerful component.

## 10. Required pre-build decisions and meaningful acceptance probes

1. Lock topology: two-VM container-boundary scope or three-VM author-host-separation scope; use the same artifact contract in either case.
2. Prove the selected runtime/image as explicit non-root, actual effective memory/CPU/PID/network flags, and absence of host/supervisor credentials from the task.
3. Demonstrate stopped-run collection of an allowlisted source file, rejecting oversized files/symlink/special-file artifacts; digest must match the bytes in the candidate.
4. Demonstrate cancellation and absolute expiry remove escaped/background task processes and the entire run volume, including after controller restart.
5. Demonstrate reused ID after destroy cannot resurrect old workspace; changed container hardening cannot silently pass ensure.
6. Demonstrate fake test logs and author-written verdict files never influence the external grader; baseline/candidate checks execute outside author runtime.
7. Close the browser during an agent run and verify server-side continuation and later event replay.

These are acceptance probes to perform during implementation. None passed merely because this report inspected code.

## Source coverage

Full/large reads: supervisor entrypoint/environment/names and key lifecycle/config paths; agent-computer Dockerfile/package, shell implementation; authorization; policy evaluator; app tool registration/execution; agent-bot stream setup. Targeted reads: workspace validation/read/write/list; agent-computer initialization and file/exec handlers; server transport/provider/gateway; root Dockerfile, Compose and Intelligence config. Browser navigation/screencast, upstream tests, actual image size/performance, deployment networking and runtime exploitability were not tested. Tests in the source tree are evidence of intended coverage, not a test result from this audit.

## 11. Integration refinement after the OpenMuse cross-check

The main team's proposed combination is stronger than importing OpenBot's computer service: **OpenBot's small supervisor service boundary + OpenMuse's inspected container profile and stop/quarantine implementation**, moved wholly onto the execution VM. I checked the corresponding OpenMuse source at the local audited tree (`apps/server/src/computer.ts`, `apps/computer/Dockerfile`); it is not another live integration test.

OpenMuse's `computer.ts:239–290` checks user `1000:1000`, working directory, labels, permitted environment names, readonly rootfs, capabilities, security flags, network-none, memory/swap/PID/CPU limits, mounts, no published ports, and no restart before attaching. This is substantially stronger than OpenBot's label/image-only attachment checks. Its `start()` applies those fields at `465–510`. Its runner launches only the Docker CLI with `shell:false` (`38–66`), bounded stdin/stdout, and cancellation. **Keep this code behind the OpenBot-derived supervisor; never retain it in the public control-plane API process.**

Upstream OpenBot's supervisor has **no command execution, file-copy or freeze API**. These capabilities are new/adapted code in Airlock. Upstream OpenMuse has execution/file tools; its current placement and per-owner lifecycle still need adaptation. Attribution should state those facts instead of claiming OpenBot already provides the complete execution engine.

### Prefer fixed exec request/response over candidate HTTP for this hero

For tabulate's pure function, use a trusted fixed adapter invoked through Docker exec with structured stdin and bounded stdout. The external grader on VM A defines inputs and expectations; the package executes inside a fresh candidate container. No browser, task listener, network or candidate HTTP route is needed. This retains `--network none` for author, baseline and candidate. The earlier HTTP/relay option in section 5 is unnecessary for this hero and should be omitted from the build.

The adapter invokes the candidate package, so anything it prints is **candidate behavior**, not a trusted pass/fail verdict. The external grader compares returned bounded data against its expected cases and records counts itself. It must not accept a candidate's own `passed:true`, test count, or “verified” output as a grading decision.

### Image and gVisor compatibility are not established by configuration

- OpenBot passes a runtime string but does not install/test that runtime (`supervisor/src/index.ts:65,108`; `docker.ts:447`). Its inspected lifecycle test uses a tiny Bun HTTP health fixture and skips if Docker is unavailable (`supervisor/tests/docker.integration.test.ts`; `fixtures/Dockerfile`). That is not evidence of Python or gVisor compatibility.
- Its hardcoded readiness healthcheck calls Bun on port 4100 (`docker.ts:54–64`). Reusing this unchanged with a sleep-based Python image makes readiness fail. Replace it with a fixed exec readiness probe or explicit ready state; don't add a token-bearing HTTP daemon merely to satisfy an inherited healthcheck.
- OpenMuse's inspected create command does not select `--runtime runsc`, and its `inspect` allowlist does not currently check runtime. Add explicit runtime creation **and runtime verification** to the merged implementation. Do not claim gVisor based on intended config alone.
- OpenMuse's image is Node Debian plus apt-installed Python, bash, git and coreutils (`apps/computer/Dockerfile:1–17`). It already has a non-root UID and owned workspace. A new lean Python image is sensible, but its environment (e.g. Python image variables), `/usr/bin/sleep` location, command paths, root ownership, venv layout and UID must match the inspection contract. Blindly transplanting the existing environment-name allowlist can reject the new image or lead to unsafe “disable inspection” fixes.
- Readonly rootfs and `noexec` `/tmp` mean dependencies must be installed/built into the image or a defined writable workspace before execution. Avoid dynamic pip builds for the hero. Pin interpreter and dependency bytes. Python bytecode/cache writes must use the intended writable path or be disabled.
- Named volumes must be initialized with correct ownership without granting runtime agent root. Verify first-run volume initialization and clean-helper mounting under gVisor on the actual Vultr host.
- Compatibility gate: create with runsc, inspect actual flags/runtime, invoke trusted stdin/stdout adapter as UID 1000, run the base regression and normal case, stop, collect, create candidate, rerun, destroy both containers/volumes. None of this is proven by this report.

### Freeze helper and operation recovery hazards

Use a fixed clean collector image/helper with the stopped author volume mounted **read-only**, no network, no secrets, no other mounts, bounded resources and deadline. Run the trusted helper from its immutable directory with Python isolated mode (or equivalent safe import path); do not set cwd/PYTHONPATH to the candidate workspace or execute its files. The fixed allowlist, byte limits and regular-file/no-link rules belong to the helper/controller, not an agent-written manifest.

A readonly helper mount alone does not freeze data: another author process can still write through a different read-write mount. Only collect after all author execution has terminated and dispatch has been fenced. The output artifact hash must be persisted before deleting the source volume. A crash during collection produces no verified artifact until collection completes again from a confirmed-stopped source.

OpenMuse preserves a meaningful stop quarantine: `computer.ts:357–384` waits for both stop confirmation and executor completion before releasing the stopped lease; `550–580` marks commands interrupted before stopping and retains quarantine if stopping fails. Keep this behavior, then strengthen the remote version with an immutable run generation and supervisor-side operation ledger. Otherwise a delayed remote exec can arrive after a replacement sandbox starts.

Required recovery rules:

1. `exec` identifies `(runId, generation, operationId)` with a server-derived operation digest. After freeze/cancel/terminal state, the supervisor rejects it even if an old HTTP request arrives late.
2. Killing the host Docker CLI is not proof that the in-container exec stopped. OpenMuse's `runDocker` cancellation kills the CLI (`82–91`); retain its separate container stop/quarantine behavior and confirm container state before freezing.
3. Never auto-restart/ensure a stopped or terminal run just because an old tool retries. New attempt means a new generation and fresh workspace, with old request fencing.
4. On worker restart, reconcile persisted operations and actual labeled container state. A missing response is uncertain, not an invitation to rerun a mutating command. Read-only frozen-artifact verification may be retried from a new verifier run; arbitrary author execution may not be blindly replayed.
5. Container removal and volume removal are distinct. An in-use/409 volume or helper that remains alive means cleanup is pending/failed, not “destroyed.” Janitor must first stop owned helpers/containers and then delete only specifically owned volumes; protect artifact retention from TTL cleanup races.
6. Persist state needed for reconciliation on the trusted execution service, not solely browser memory or the author filesystem. Model-chosen IDs are not an idempotency guarantee.

This merged design reuses the strongest concrete parts of both repositories while making Airlock's new work explicit: task-scoped remote execution protocol, immutable source collection, independent baseline/candidate grading, and a useful report-to-patch product flow.
