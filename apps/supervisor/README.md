# Airlock supervisor (VM B)

The execution plane. This is the **only** process in Airlock that holds the Docker socket. It speaks a
narrow vocabulary expressed in attempts and operations, never in Docker terms: a caller can create an
attempt for a supported profile, run a command inside it, freeze it, revoke it and destroy it. It cannot
name an image, a mount, a network, a runtime, a Docker option or a host path, because none of those are
expressible in this API. The bearer token keeps other processes off the API; the vocabulary is the boundary.

Adapted from the OpenBot supervisor (narrow verbs, derived names, ownership labels) and the OpenMuse
computer service (create-and-inspect hardening, record-before-dispatch, stop-and-quarantine). See
`NOTICES.partial.md` for the exact files and modifications.

## Run

```sh
SUPERVISOR_TOKEN=<secret> AIRLOCK_RUNTIME=kata bun src/index.ts
```

The process refuses to start when: the token is missing or shorter than 16 characters; Docker is
unreachable; the configured runtime is not listed by `docker info`; `AIRLOCK_RUNTIME=runc` without
`AIRLOCK_DEV_UNSAFE=1`; a profile under `AIRLOCK_PROFILES_DIR` fails validation.

### Environment

| Variable | Default | Meaning |
|---|---|---|
| `SUPERVISOR_TOKEN` | required | Bearer token for every route except `GET /health`. At least 16 characters. |
| `PORT` | `4300` | Listen port. |
| `SUPERVISOR_BIND` | `127.0.0.1` | Bind address. A deployment sets the **VPC** address of VM B; never a public interface. |
| `AIRLOCK_RUNTIME` | `kata` | `kata` \| `runsc` \| `runc`. Which OCI runtime every sandbox is created with, and what is checked on inspection. |
| `AIRLOCK_DEV_UNSAFE` | unset | Must be `1` to allow `runc`. Then every inspection and attempt record carries `devUnsafe: true`. |
| `AIRLOCK_DOCKER_RUNTIME_NAME` | `kata`/`runsc`/`runc` | Override for the name Docker lists the runtime under (e.g. `io.containerd.kata.v2`). Refused at start when the name belongs to a different tier than `AIRLOCK_RUNTIME` (a name matching `runc`/`crun`/`youki` is runc, `kata` is kata, `runsc`/`gvisor` is runsc). Inspection classifies the effective name the same way before it trusts the configured tier, so a container that actually runs on runc is always recorded `runc` + `devUnsafe`. |
| `AIRLOCK_PROFILES_DIR` | `<repo>/profiles` | Directory of `<id>/profile.json` manifests. |
| `AIRLOCK_DATA_DIR` | `<repo>/data/supervisor` | Journal and host sentinel. |
| `AIRLOCK_JOURNAL_PATH` | `<data dir>/supervisor-journal.sqlite` | `bun:sqlite` execution journal. |
| `DOCKER_SOCKET` | dockerode default | Docker socket path. A `unix://` `DOCKER_HOST` is honoured too (Colima, rootless). |
| `AIRLOCK_NAMESPACE` | `airlock` | Deployment namespace in every container/volume name and label; two supervisors on one host must differ. |
| `AIRLOCK_RETENTION_MS` | `1800000` | How long a stopped attempt's volume survives past its deadline before the janitor destroys it. |
| `AIRLOCK_JANITOR_INTERVAL_MS` | `30000` | Janitor period. |

## Runtime tiers and what dev-unsafe means

The runtime tier is **inspected, never assumed**. Every container is created with `HostConfig.Runtime`
set to the configured runtime and, after creation, the effective configuration is read back and checked
(see "Hardening"); the effective runtime name and the guest `uname -a` / `hostname` go into every
`RuntimeInspection`.

- **`kata`** (target): Kata Containers on the Vultr VX1 sandbox host. Each sandbox has its own guest kernel.
- **`runsc`** (floor): gVisor. Syscalls are intercepted in user space. Ship this if Kata fails its deployment probe.
- **`runc`** (dev-unsafe only): shares the host kernel. Not an acceptable shipped runtime. The supervisor only
  accepts it with `AIRLOCK_DEV_UNSAFE=1`, logs a warning at start, sets `devUnsafe: true` on the host check
  and on every inspection, and the control plane shows that label on every record produced this way.
  It exists so the whole pipeline can be exercised on a laptop (macOS Docker/Colima has no gVisor or Kata).
  It is never a deployment default.

## Hardening (checked on every container)

Created: user `1000:1000`, `WORKDIR /workspace`, `--network none`, read-only rootfs, `CapDrop ALL`,
`no-new-privileges`, PIDs/memory (`MemorySwap = Memory`)/CPU from the profile caps, private IPC, restart `no`,
tmpfs `/tmp` (noexec, 64 MiB), no ports, no devices, no host binds, exactly one named volume (`/workspace`
read-write for author/one-shot roles; `/candidate` read-only for the collector), entrypoint `/usr/bin/sleep infinity`,
env limited to an allowlist. Labels `airlock.supervisor=true`, `airlock.namespace`, `airlock.task`,
`airlock.attempt`, `airlock.role` (and `airlock.operation` on one-shots).

The named volume is a `local` volume backed by a **size-capped tmpfs** (`type=tmpfs,device=tmpfs,o=size=<caps.workspaceBytes>,uid=1000,gid=1000,mode=0755`;
128 MiB unless the profile says otherwise). A sandbox cannot write more than that (ENOSPC inside the
sandbox, the pages are charged to its memory cgroup) and nothing it writes reaches host disk, so a fill
loop cannot exhaust VM B's storage or starve the journal. `provision` re-inspects the volume (driver,
options, ownership labels) before any container mounts it and refuses anything else. A tmpfs volume's
contents exist only while some container holds the mount, which is why freeze provisions the collector
before it stops the author container (see the route table).

Inspection reads the **effective** config back and fails closed (409, container destroyed) if any check
differs, if the runtime is not the configured one, or if the guest identity cannot be read. Author sandboxes
then run the fixed isolation probe (`/opt/airlock/probe.sh`: metadata endpoint, DNS, outbound TCP, Docker
socket, host mounts); anything not `BLOCKED` destroys the sandbox and refuses the run (409). The probe's own
`allBlocked` field carries no authority; it is recomputed from the five results.

## API

JSON bodies are exactly the `@airlock/contracts` types. `Authorization: Bearer <SUPERVISOR_TOKEN>` on
everything except `GET /health`. Body limit 16 MiB.

| Route | Body → Response |
|---|---|
| `GET /health` | `{status: "ok"\|"degraded", docker, host: HostCheck}` (no auth) |
| `GET /host` | `HostCheck` |
| `POST /attempts` | `CreateAttemptRequest → AttemptState` (roles `author`, `hostile`). Creates volume + container, materializes the pristine tree, inspects, probes. |
| `GET /attempts` | `AttemptState[]` (journaled attempts this supervisor owns) |
| `GET /attempts/:attemptId` | `AttemptState` |
| `POST /attempts/:attemptId/tool` | `AuthorToolRequest → AuthorToolResult`. `read` limited to `readablePaths`, `write` to `allowedReplacementPaths` (delivered by tar upload), `exec` runs `timeout --signal=TERM --kill-after=2s <commandTimeout>s bash --noprofile --norc -c <command>` as 1000:1000 in `/workspace/src`. |
| `POST /attempts/:attemptId/freeze` | `FreezeRequest → FreezeResult`: revoke → collector container created with the volume read-only at `/candidate` (holds the tmpfs-backed workspace; it has run nothing) → stop author (t=2) → settle outstanding execs → re-inspect stopped → collector runs → `FileEnvelope`. An attempt whose container was already stopped (quarantine, deadline) has no workspace left to collect: the collector reports the files missing and the freeze fails closed. |
| `POST /attempts/:attemptId/revoke` | `RevokeRequest → AttemptState` (dispatch closed, container stopped and confirmed) |
| `POST /attempts/:attemptId/destroy` | `DestroyRequest → DestroyResult` (container + volume removed; `teardown` lists what remains) |
| `POST /invoke` | `InvokeRequest → InvokeResult`: fresh one-shot container; bundle digests verified **before** anything is created; replacements + `request.json` uploaded as tar; materialize, then adapter; stdout parsed line by line with `Observation`; always destroyed. |
| `POST /hostile` | `HostileRunRequest → BlastRadiusCard`: author-profile sandbox, the command under author caps, then measured survival (supervisor health, host sentinel hash, other attempts running, host uptime) and teardown. |

### Errors

| Status | When |
|---|---|
| 400 | invalid body, digest of the body does not match `operation.requestDigest`, unsupported profile, deadline in the past |
| 401 | missing/wrong token |
| 404 | unknown attempt |
| 409 | fenced (stale generation, revoked, destroyed/tombstoned), operation id reused with a different digest, operation still in progress, inspection failed, probe not blocked, bundle digest mismatch, name held by a foreign container |
| 503 | Docker unavailable / stop not confirmed |

Every mutating call carries `Operation{operationId, requestDigest}`. `requestDigest` must equal
`sha256(canonical body without operation.requestDigest)`. A repeat with the same id and digest returns the
recorded result (including recorded errors). Same id, different digest: 409. An operation left pending by a
supervisor crash replays as 409 "interrupted"; it is never rerun and no receipt is invented.

## Generation fencing and deadlines

Each attempt row records `generation`. A request with a lower generation is refused (409); a higher one is
recorded and fences the older. The fence is re-checked immediately before every start/exec, not only at
request acceptance. Every attempt has an absolute deadline (bounded by the profile's `attemptTimeoutMs`); a
timer revokes and stops the container at the deadline regardless of the caller, and the janitor does the
same after a restart. Loss of control over a command (client lost, stream error, supervisor-side timeout,
unknown exit code) stops the whole container and revokes the attempt: nothing unknown keeps running.

## Janitor

On startup and every `AIRLOCK_JANITOR_INTERVAL_MS`: reconcile the journal with Docker labels (a live
attempt whose container vanished becomes `unknown`), stop expired attempts, destroy attempts past deadline +
retention, remove one-shot containers past their deadline, remove and tombstone every owned container or
volume the journal does not know. Tombstoned identities cannot be created again.

## Tests

```sh
bunx tsc --noEmit -p tsconfig.json
bun test
```

Unit tests use a fake Docker. `test/integration.test.ts` uses the real daemon on `runc` (dev-unsafe) and is
skipped automatically when Docker is unreachable or `airlock-runtime-python:tabulate-365` is not built
(`runtime/python/build.sh tabulate-365`). With Colima set `DOCKER_HOST=unix://$HOME/.colima/default/docker.sock`.
