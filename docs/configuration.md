# Airlock configuration and operations reference

Moved out of the top-level README so it stays short. Deployment steps and the submission checklist are in [runbook.md](runbook.md); deploy scripts in [../deploy/README.md](../deploy/README.md).

## Local development (dev-unsafe)

Prerequisites: Bun 1.3, Docker (on macOS via Colima: `colima start`; `./run.sh` defaults `DOCKER_HOST` to the Colima socket), `python3`, `git`, `perl` (present on macOS and Linux), `unzip` and `patch` (for the smoke), `uv` (for the Python tests).

```sh
./run.sh                  # bun install if needed, build the runtime image and the web UI if missing,
                          # start supervisor + control plane, stream the merged debug log; Ctrl-C stops everything
./run.sh up -d            # the same, detached
./run.sh status           # pids, health JSON, owned containers, model driver/model, log path
./run.sh logs             # tail -F the merged log
./run.sh smoke            # end to end through the HTTP API (about a minute; scripted driver)
./run.sh gate --n 3       # live-repair gate (needs AIRLOCK_MODEL_DRIVER=vultr, a key and AIRLOCK_MODEL in .env)
./run.sh test             # the four suites: control, supervisor (real Docker), web, runtime pytest
./run.sh down             # stop; footer with the docker owned-container listing
open http://127.0.0.1:3000/   # web UI; operator password is in data/dev.env
```

`./run.sh` is a thin wrapper over `scripts/dev-up.sh` / `scripts/dev-down.sh`, which hold the start/stop
logic: they generate a random `SUPERVISOR_TOKEN` and the two role passwords into the gitignored
`data/dev.env` on first run, load `.env`, build the runtime image (`runtime/python/build.sh tabulate-365`)
when it is missing, rebuild `apps/web/dist`, start both processes on `127.0.0.1`, wait for `/health` and
`/api/session`, and are idempotent. They can still be called directly (`scripts/dev-up.sh --detach`,
`bun scripts/smoke.ts`); the wrapper adds the merged debugging log below.

### The debugging log

Every `./run.sh up` writes `data/run/airlock-<YYYYmmdd-HHMMSS>.log` and points the symlink
`data/run/airlock-latest.log` at it. It contains, in order:

1. **A preflight header**: git revision and dirty flag, `bun`/`docker`/`uv` versions, `DOCKER_HOST`,
   the runtimes Docker lists, the runtime image id and digest, the profile ids, a redacted summary of the
   effective environment (values for ordinary settings, `[set, N chars]` for anything named like a
   token, password or key), the chosen model driver and model, and the ports.
2. **Both processes' output, merged in order**: each line is `<ISO ts> [control|supervisor] <line>`;
   `dev-up`'s own progress (image build, URLs) appears as `[run]`. Each app's line is one JSON object
   `{ts, level, app, msg, ...fields}` (see "Log levels" below).
3. **A footer on exit** with the exit reason and the `docker ps` listing of owned containers, which must
   read `(no sandboxes)`.

**Log levels.** Both apps read `AIRLOCK_LOG_LEVEL` (`error` | `warn` | `info` | `debug`; default `info`
when started by hand). `./run.sh` defaults it to `debug`; pass `--quiet` for `info`. At `debug` the control
plane records every HTTP request/response (method, path, status, duration, role, body sizes; never a body),
worker lease claims/releases, every phase transition, every model call (model, host, `finish_reason`,
prompt/completion/reasoning tokens, tool names, duration), every supervisor-client call (operation id,
endpoint, status, duration, fence errors), SSE subscribe/replay/close and export grants; the supervisor
records every HTTP request, every Docker verb with container/volume names and duration (create, inspect,
start, stop, remove, list, archive upload, exec start/end with exit code and captured byte counts), probe
results, provisioning, reconcile/janitor passes and what they removed, deadline timers armed and fired, and
journal operations (new / replay / conflict / in-progress, completion status). At `info` only the startup
lines, attempt lifecycle summaries and anomalies remain.

**What is never in the log.** The supervisor token, the inference key, the role passwords, session tokens
and cookies. The apps redact any field whose name looks like a credential and any bearer/cookie header
value; the wrapper prints secret names only. The smoke run used for this README was grepped for every
token, password and key value in `data/dev.env` and `.env`: zero hits.

In the UI, sign in with the operator password, choose the `tabulate-365` profile, paste the issue text (for the hero case: an empty table with `headers` and `maxheadercolwidths` raises `IndexError`) and start. The default dev driver is scripted (see "Model driver"), so the run replays the labelled diagnostic candidate; pick `forged-log` or `slow` through the API's `scriptedDriver` field to see `CHECKS_FAILED` or a cancellable run. With `AIRLOCK_MODEL_DRIVER=vultr`, `VULTR_INFERENCE_API_KEY` and `AIRLOCK_MODEL` in `.env`, the same start runs live repairs.

## Configuration

Secrets come from the environment only. For local work, put `VULTR_INFERENCE_API_KEY`, `AIRLOCK_MODEL` and any overrides in a conventional `.env` at the repository root (gitignored; `dev-up.sh` loads it after the generated `data/dev.env`, and variables exported in your shell win over both). `.env.example` lists the deployment shape; nothing under `data/` or `.env` is committed.

### Control plane (`apps/control`)

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `SUPERVISOR_TOKEN` | yes (≥16 chars) | — | Bearer secret for the supervisor API. |
| `SUPERVISOR_URL` | no | `http://127.0.0.1:4300` | Supervisor base URL; the VPC address of VM B in a deployment. |
| `AIRLOCK_MODEL_DRIVER` | no | `vultr` | `vultr` for live inference, or `scripted:<file-or-directory>` of JSON scripts for diagnostics and tests. Scripted runs are labelled `scripted:<name>` on every model event and are never a live repair. |
| `VULTR_INFERENCE_API_KEY` | with `vultr` | — | Vultr Serverless Inference key. Never logged, never in an event, never in a sandbox. |
| `VULTR_INFERENCE_BASE_URL` | no | `https://api.vultrinference.com/v1` | Must be https. |
| `AIRLOCK_MODEL` | with `vultr` | — | Model name; choose it with `bun scripts/probe-model.ts` (measured tool-call round trip on the live `/v1/models` list). |
| `AIRLOCK_DATA_DIR` | no | `./data` | PGlite database and content-addressed artifacts. |
| `AIRLOCK_PROFILES_DIR` | no | `<repo>/profiles` | Profiles; each needs a verified `base/`. |
| `AIRLOCK_RUNTIME_DIR` | no | `<repo>/runtime/python` | Where `adapter.py` lives (part of the adapter digest). |
| `AIRLOCK_WEB_DIST` | no | `<repo>/apps/web/dist` | Built web UI served at `/`; `/api/*` always takes precedence; `none` disables. |
| `AIRLOCK_OPERATOR_PASSWORD`, `AIRLOCK_JUDGE_PASSWORD` | no (≥8 chars, must differ) | — | Role passwords. Without both, no one can sign in. Task data (issue text, events, model turns, command output) is readable only by the session that started the task and by the operator; each login is its own principal, so judges sharing the judge password do not see each other's cases. Signed out, only profiles and the host check are served. Export is limited to candidates that passed their checks, and serves one sealed zip. |
| `PORT`, `CONTROL_BIND` | no | `3000`, `0.0.0.0` | Listener. |
| `AIRLOCK_INSECURE_COOKIES` | no | unset | `1` drops the cookie `Secure` flag for plain-http local development only. |
| `AIRLOCK_TRUST_PROXY` | no | unset | Set when a reverse proxy fronts control (deployment step 2): `1` for a proxy on the same host, or a comma-separated list of proxy IP addresses. The login rate limit (10/min per client) then keys on the proxy's `X-Forwarded-For` hop for requests arriving from that proxy; every other peer is keyed on its own address, so a direct connection cannot spoof a fresh budget. Unset behind a proxy, all clients share the proxy's address and one login bucket, and ten bad passwords a minute from anyone lock every operator out. |
| `AIRLOCK_SESSION_TTL_MS`, `AIRLOCK_EXPORT_GRANT_TTL_MS`, `AIRLOCK_HOSTILE_MIN_INTERVAL_MS` | no | 12 h, 24 h, 10 s | Session lifetime, export grant lifetime, per-session hostile-run rate limit. |

### Supervisor (`apps/supervisor`)

| Variable | Default | Meaning |
|---|---|---|
| `SUPERVISOR_TOKEN` | required (≥16 chars) | Bearer token for every route except `GET /health`. |
| `PORT` | `4300` | Listen port. |
| `SUPERVISOR_BIND` | `127.0.0.1` | Bind address. A deployment sets VM B's **VPC** address, never a public interface. |
| `AIRLOCK_RUNTIME` | `kata` | `kata`, `runsc` or `runc`. |
| `AIRLOCK_DEV_UNSAFE` | unset | Must be `1` to allow `runc`; then every record carries `devUnsafe: true`. |
| `AIRLOCK_DOCKER_RUNTIME_NAME` | per runtime | The name Docker lists the runtime under (e.g. `io.containerd.kata.v2`). |
| `AIRLOCK_PROFILES_DIR` | `<repo>/profiles` | Profile manifests. |
| `AIRLOCK_DATA_DIR` | `<repo>/data/supervisor` | Journal and host sentinel. |
| `AIRLOCK_JOURNAL_PATH` | `<data dir>/supervisor-journal.sqlite` | Execution journal. |
| `DOCKER_SOCKET` | dockerode default | Docker socket path; a `unix://` `DOCKER_HOST` is honoured too. |
| `AIRLOCK_NAMESPACE` | `airlock` | Namespace in every container/volume name and label. |
| `AIRLOCK_RETENTION_MS`, `AIRLOCK_JANITOR_INTERVAL_MS` | 30 min, 30 s | Stopped-volume retention past deadline; janitor period. |

### Web UI (`apps/web`)

No runtime configuration: every request is relative (`/api/...`). `bun run --cwd apps/web build` writes `apps/web/dist`, which the control plane serves. For UI development `bun run --cwd apps/web dev` proxies `/api` to `AIRLOCK_CONTROL_URL` (default `http://localhost:3000`). The layout (case sidebar, the run as a conversation, details pane, hostile input as a chat) follows CopilotKit OpenBot's app; see [apps/web/README.md](../apps/web/README.md) and the screenshots in `docs/assets/`: [mobile](assets/ui-mobile.png) (deployment, Kata); [new case](assets/ui-new-case.png) and [hostile input](assets/ui-hostile.png) (local dev (runc): the hostile card there reports `runc`/dev-unsafe, which only shows that the container's read-only rootfs, dropped capabilities and `--network none` held, not kernel isolation).

### Model driver

`vultr` talks to Vultr Serverless Inference with forced tool calls (the API has no JSON mode); it is the only provider in the runtime path. `scripted:<path>` replays a JSON `ScriptedTurn[]` file, or one of the `<name>.json` files in a directory, chosen per task with `CreateTaskRequest.scriptedDriver` (the field is refused in `vultr` mode). The repository ships three under `apps/control/test/fixtures/scripted/`: `diagnostic` (writes the labelled hand-written fix), `forged-log` (writes a fake "312 passed" log and submits unchanged code), `slow` (runs `sleep 25` so a cancel lands mid-command).

## Deployment outline: two Vultr VMs

**Performed from this repository with the scripts under [`deploy/`](../deploy/README.md)** (provision, host setup, deploy, preflight, teardown, and the measured results on Kata). The outline below follows the research in `research/13-vultr-inference-and-deployment.md` and `research/38-kickoff-decks-and-netbird-clarification.md`.

1. **VM B, sandbox host**: a VX1 plan with a `-120s`/`-240s` suffix (local boot disk) in `atl`, because VX1 is the only cloud plan documented with nested virtualization. On first boot verify `ls -l /dev/kvm`, install Docker plus Kata Containers (target) and gVisor `runsc` (floor), and confirm both appear under `docker info` → Runtimes. Build the runtime image there: `runtime/python/build.sh tabulate-365`. Run the supervisor with `SUPERVISOR_BIND=<VPC address>`, `AIRLOCK_RUNTIME=kata` (or `runsc` if Kata fails its deployment probe) and a strong `SUPERVISOR_TOKEN`. Keep the Docker socket local to this VM; open no public port. `GET /health` reports what was actually found: `kvmPresent`, `availableRuntimes`, `selectedRuntime`, `devUnsafe`.
2. **VM A, control plane**: any plan, in `atl` so inference traffic stays in-region. Set `SUPERVISOR_URL=http://<VM B VPC address>:4300`, the same `SUPERVISOR_TOKEN`, `VULTR_INFERENCE_API_KEY`, `AIRLOCK_MODEL` (from `bun scripts/probe-model.ts`), the role passwords and `AIRLOCK_DATA_DIR` on persistent disk. Build `apps/web/dist` and let the control plane serve it. Put TLS in front of port 3000 (a reverse proxy), set `AIRLOCK_TRUST_PROXY=1` (proxy on the same VM) or the proxy's IP address, and make port 3000 reachable only from the proxy (`CONTROL_BIND=127.0.0.1` for a same-host proxy, or a firewall rule); cookies are `Secure` by default.
3. **Private link**: both VMs in one Vultr VPC; the supervisor listens only on its VPC address and VM B's firewall admits port 4300 from VM A only. Provider credentials exist only on VM A; sandbox VM `user_data` carries no secrets.
4. **NetBird (optional add-on, only after the core works end to end)**: peer-to-peer link for controller → supervisor first, then a reverse proxy and judge-role gating for the public URL. Nothing in the core depends on it; see `research/38-kickoff-decks-and-netbird-clarification.md` §3.4 for the recommended shape.

Runtime caps come from the profile (`caps` in `profile.json`): 1 CPU, 512 MiB, 64 PIDs, 30 s per command, 64 KiB captured output, 5 min per attempt, 2 repair attempts, 40 model calls, 1 MiB per accepted file, 4 MiB total. They are what the supervisor enforces; measure before advertising anything else.

## Supported profile and how to add one

The only supported profile is **`tabulate-365`**: a historical replay of [python-tabulate #365](https://github.com/astanin/python-tabulate/issues/365) at base commit `e13a4d0d…`, where an empty table with `headers` and `maxheadercolwidths` raises `IndexError`. The contract has six measured cases (one reported failure, five regressions); the agent may change only `tabulate/__init__.py`. The maintainer's later fix is used only to author the contract and is never supplied to any sandbox. The UI offers this profile and nothing else; other repository/runtime combinations are rejected by the API (`422`).

A profile is a directory, not a special case:

```
profiles/<id>/profile.json                 ProfileManifest: repo, baselineCommit, baselineTreeDigest, allowed/readable paths, caps, runtimeImage
profiles/<id>/contract.json                CaseContract: measured baseline and candidate expectations per case
profiles/<id>/<adapterModule>.py           run_case(input) → value; raising is how failures are observed
profiles/<id>/base/                        pristine tracked tree at baselineCommit (prepare-profile.sh)
```

To add one: write `profile.json` with the pinned commit and the digest rule described in `profiles/tabulate-365/README.md` (lines ordered by `(casefold(path), path)`, symlinks hashed as their target's bytes), measure the contract at the base and reference commits in a clean environment and record the observed values, write the adapter module, run `runtime/python/build.sh <id>` (it refuses a `base/` that does not match the digest), and start both processes: each loads and verifies every profile at start-up and skips one that fails. Never `pip install` from issue text on any host; dependencies are pinned in the image.

## Testing

Current counts on this branch (Colima for the real-Docker tests): control 398, supervisor 207 (all real-Docker integration tests ran), web 132, egress 35, fixtures 41, scripts 11, browser runner 27, Node probe parity 2, Python runtime and output collector 135 (+2 skipped on macOS). `bun run test` runs the owned Bun suites (it lists paths so upstream reference trees are not collected); `bun run test:python` and `bun run test:browser` run the others. The independent acceptance driver is `bun scripts/acceptance/local.ts` against a running `scripts/dev-up.sh` stack.

The original four suites plus the smoke:

```sh
# supervisor: unit tests with a fake Docker plus one real-docker integration test (skipped without Docker/image)
cd apps/supervisor && bunx tsc --noEmit -p tsconfig.json && DOCKER_HOST=unix://$HOME/.colima/default/docker.sock bun test
# control: in-memory PGlite, fake supervisor, scripted drivers
cd apps/control && bunx tsc --noEmit -p tsconfig.json && bun test
# web: pure modules
cd apps/web && bunx tsc --noEmit -p tsconfig.json && bunx vite build && bun test
# runtime: adapter, materializer, collector, probe, tree digest, and a docker integration test on dev-unsafe runc
uv run --with pytest pytest runtime/python/tests
# end to end against a running stack (./run.sh up -d)
./run.sh smoke            # or: bun scripts/smoke.ts
# all four suites in one go
./run.sh test
```

The smoke proves, through the public HTTP API only: diagnostic repair → `CANDIDATE_PASSED_CHECKS` with all five checkpoints; preview of the reported input renders the header-only table; the export zip's `patch.diff` applies with `patch -p1 --dry-run` to `profiles/tabulate-365/base`; `rm -rf / --no-preserve-root` dies in its sandbox while the supervisor, host sentinel and control plane survive and teardown is `(no sandboxes)`; the forged-log script ends `CHECKS_FAILED`; a task cancelled during `sleep 25` ends `cancelled` with no live attempt at the supervisor and no owned container in `docker ps`.

