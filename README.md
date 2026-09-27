# Airlock

Airlock takes an untrusted bug report for a supported library, reproduces the failure in a disposable sandbox on Vultr, attempts a minimal repair, and returns a patch with **externally measured** before/after behavior. The agent can edit the candidate; it can never edit the acceptance contract, grant itself privileges, publish its work, or decide that it passed. The result of a run is one of six terminal outcomes; "Passed these checks" means exactly that the frozen contract cases passed on a sealed candidate, measured by a comparator that never imports the candidate.

**Status.** Everything in this README has been run on one macOS laptop with Docker under Colima, on plain `runc` with `AIRLOCK_DEV_UNSAFE=1`. That is a development configuration, not a deployment: it shares the host kernel, and every record it produces is labelled `dev-unsafe`. The two-VM Vultr deployment, the Kata tier on VX1 and the gVisor tier are designed and documented below but have **not** been exercised yet. No live Vultr Serverless Inference repair has been run from this checkout; all runs so far used the scripted diagnostic drivers described under "Testing".

## Architecture

Two roles, meant for two VMs joined by a private (VPC) link:

| Role | Where | Owns | Never |
|---|---|---|---|
| **Control plane** `apps/control` (VM A) | any plan, in `atl` (where the inference models live) | task identity, contracts, phases, budgets, sessions, export authorization, the model client | holds a Docker socket, runs candidate code, trusts anything a sandbox prints |
| **Supervisor** `apps/supervisor` (VM B) | VX1 sandbox host with `/dev/kvm` | container identity, actual execution, deadlines, termination, cleanup, the isolation checks | learns an image, mount, network, runtime option or host path from a caller: none is expressible in its API |
| **Web UI** `apps/web` | served by the control plane | rendering authoritative REST/SSE state | deciding that anything passed |
| **Runtime image** `runtime/python` | built on VM B | the pinned source tree, fixed adapter/collector/probe scripts | network, pip, secrets |
| **Profile** `profiles/<id>` | repository | the supported repo/commit, what the agent may read and change, the frozen contract | a special case in code |
| **Contracts** `packages/contracts` | shared | every boundary's schemas and digests | runtime configuration or secrets |

The control plane runs one task through `prepare → reproduce → baseline → repair → freeze → verify → ready` around a single model loop with four tools (`read_file`, `write_file`, `run`, `submit_candidate`). `submit_candidate` only advances to freeze: the supervisor revokes dispatch, stops the author sandbox, confirms the stop and collects the allowed files in a fresh container; the control plane seals them into a `SourceManifest` whose digest identifies the candidate from then on. Verification, preview and export all run fresh one-shot sandboxes from that sealed bundle. The comparator decides the verdict from observations; a `passed` field, a pytest exit code or an "all tests passed" log from inside the sandbox carries no authority.

**Terminal outcomes:** `NOT_REPRODUCED`, `REPRODUCED_UNRESOLVED`, `CANDIDATE_PASSED_CHECKS`, `CHECKS_FAILED`, `INCONCLUSIVE`, `STOPPED_LIMIT`. A cancelled task has status `cancelled` and no outcome.

### The five checkpoints

Every run record carries them; the task page shows them under "Five checkpoints" and the export bundle contains them.

1. **Host check**: Docker version, CPU virtualization, `/dev/kvm` presence and mode, runtimes Docker lists, the selected runtime and the `devUnsafe` flag.
2. **Execution log**: every command with exit code, duration and bounded output; baseline and candidate invocations with their `ExecResult`.
3. **In-sandbox identity**: `hostname` and `uname -a` read from inside each sandbox.
4. **Isolation probe**: metadata endpoint, DNS, outbound TCP, Docker socket and host mounts, each `BLOCKED | REACHED | UNKNOWN`; anything not `BLOCKED` refuses the run before any agent work.
5. **Teardown**: what the supervisor still owns for the attempt after destroy. Must be `(no sandboxes)`; anything else stays visible on the task.

### Runtime tiers

The tier is **inspected, never assumed**: the supervisor creates every container with the configured OCI runtime, reads the effective configuration back and refuses (409, container destroyed) if any hardening check or the runtime differs.

| Tier | `AIRLOCK_RUNTIME` | Meaning | Status here |
|---|---|---|---|
| Kata Containers | `kata` | own guest kernel per sandbox; target on the VX1 host | untested |
| gVisor | `runsc` | user-space syscall interception; the floor for a deployment | untested |
| runc | `runc` + `AIRLOCK_DEV_UNSAFE=1` | shares the host kernel; **development only**, never a deployment default | what this checkout has run on |

## Quick start (local, dev-unsafe)

Prerequisites: Bun 1.3, Docker (on macOS via Colima: `colima start`, then `export DOCKER_HOST=unix://$HOME/.colima/default/docker.sock`), `python3`, `git`, `unzip` and `patch` (for the smoke), `uv` (for the Python tests).

```sh
bun install
runtime/python/build.sh tabulate-365     # pins profiles/tabulate-365/base and builds airlock-runtime-python:tabulate-365
scripts/dev-up.sh --detach               # supervisor + control plane, scripted model driver, prints URLs
bun scripts/smoke.ts                     # end to end through the HTTP API (about two minutes)
open http://127.0.0.1:3000/              # web UI; operator password is in data/dev.env
scripts/dev-down.sh
```

`dev-up.sh` generates a random `SUPERVISOR_TOKEN` and the two role passwords into the gitignored `data/dev.env` on first run, starts both processes on `127.0.0.1`, waits for `/health` and `/api/session`, and is idempotent. Without `--detach` it stays in the foreground and stops both on Ctrl-C. Logs are in `data/run/`.

In the UI, sign in with the operator password, choose the `tabulate-365` profile, paste the issue text (for the hero case: an empty table with `headers` and `maxheadercolwidths` raises `IndexError`) and start. The default dev driver is scripted (see "Model driver"), so the run replays the labelled diagnostic candidate; pick `forged-log` or `slow` through the API's `scriptedDriver` field to see `CHECKS_FAILED` or a cancellable run.

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
| `AIRLOCK_OPERATOR_PASSWORD`, `AIRLOCK_JUDGE_PASSWORD` | no (≥8 chars, must differ) | — | Role passwords. Without both, only the read-only viewer role exists. The viewer role needs no password and can read every task, its pasted issue text and its complete event stream, including every model turn and the output of every command the model runs (a `cat` or `git diff` puts the candidate source verbatim on the stream). Only the sealed candidate zip and `patch.diff` are gated, by an export grant. Do not paste text into a public deployment that must not be public; gating the URL is the optional NetBird add-on. |
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

No runtime configuration: every request is relative (`/api/...`). `bun run --cwd apps/web build` writes `apps/web/dist`, which the control plane serves. For UI development `bun run --cwd apps/web dev` proxies `/api` to `AIRLOCK_CONTROL_URL` (default `http://localhost:3000`).

### Model driver

`vultr` talks to Vultr Serverless Inference with forced tool calls (the API has no JSON mode); it is the only provider in the runtime path. `scripted:<path>` replays a JSON `ScriptedTurn[]` file, or one of the `<name>.json` files in a directory, chosen per task with `CreateTaskRequest.scriptedDriver` (the field is refused in `vultr` mode). The repository ships three under `apps/control/test/fixtures/scripted/`: `diagnostic` (writes the labelled hand-written fix), `forged-log` (writes a fake "312 passed" log and submits unchanged code), `slow` (runs `sleep 25` so a cancel lands mid-command).

## Deployment outline: two Vultr VMs

Not yet performed from this repository. The outline follows the research in `research/13-vultr-inference-and-deployment.md` and `research/38-kickoff-decks-and-netbird-clarification.md`.

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

## What "Passed these checks" means, and does not mean

`CANDIDATE_PASSED_CHECKS` means: the sealed candidate (identified by its `candidateDigest`) was materialized on the pristine base tree in a fresh sandbox, the fixed adapter ran every case in the frozen contract, every observation matched the contract's candidate expectation, and the run was complete (no timeout, protocol error, missing, duplicate or unknown case id). The same sealed bytes are what preview runs and what the export bundle contains, with the verification record, the baseline record and the diff.

It does not mean the patch is safe, certified, correct in general, or free of other regressions. It does not mean anything about behaviour outside the contract cases. It does not mean the model was honest: the model's own claims, logs and pass counts are never consulted. A run on `runc` additionally carries `devUnsafe: true` and is not a deployment measurement.

## Limits and dev-unsafe

- `runc` shares the host kernel. It is accepted only with `AIRLOCK_DEV_UNSAFE=1`, warns at start, and labels every host check, inspection, record and UI page. The hostile panel's "survived" card on `runc` shows that the container's read-only rootfs, dropped capabilities and `--network none` held for that command; it is not a kernel-isolation claim.
- Kata and gVisor tiers, the VX1 host, the VPC link and NetBird are untested from this checkout.
- Live Vultr repairs have not been run here; the live-repair gate (2 of 3 fresh hero attempts passing the comparator) is still open.
- One profile. Adding profiles is real adapter work, per above.
- The control plane uses an embedded PGlite database and runs the API and worker in one process; splitting them means moving to Postgres.

## Testing

Four suites plus the smoke. Each was run for the results below on the same laptop as the quick start.

```sh
# supervisor: unit tests with a fake Docker plus one real-docker integration test (skipped without Docker/image)
cd apps/supervisor && bunx tsc --noEmit -p tsconfig.json && DOCKER_HOST=unix://$HOME/.colima/default/docker.sock bun test
# control: in-memory PGlite, fake supervisor, scripted drivers
cd apps/control && bunx tsc --noEmit -p tsconfig.json && bun test
# web: pure modules
cd apps/web && bunx tsc --noEmit -p tsconfig.json && bunx vite build && bun test
# runtime: adapter, materializer, collector, probe, tree digest, and a docker integration test on dev-unsafe runc
uv run --with pytest pytest runtime/python/tests
# end to end against scripts/dev-up.sh
bun scripts/smoke.ts
```

The smoke proves, through the public HTTP API only: diagnostic repair → `CANDIDATE_PASSED_CHECKS` with all five checkpoints; preview of the reported input renders the header-only table; the export zip's `patch.diff` applies with `patch -p1 --dry-run` to `profiles/tabulate-365/base`; `rm -rf / --no-preserve-root` dies in its sandbox while the supervisor, host sentinel and control plane survive and teardown is `(no sandboxes)`; the forged-log script ends `CHECKS_FAILED`; a task cancelled during `sleep 25` ends `cancelled` with no live attempt at the supervisor and no owned container in `docker ps`.

## Attribution

Airlock adapts modules from two MIT-licensed repositories, OpenMuse (`205cc386…`) and OpenBot (`3c73cf00…`). Every copied or adapted file, its pin and its modifications are listed in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md); upstream notices are preserved in file headers. The development guideline is [`CLAUDE.md`](CLAUDE.md); the research that produced it is under `research/`.
