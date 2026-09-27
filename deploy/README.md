# Deploying Airlock to Vultr (two VMs)

This directory deploys the repository onto the two-VM topology described in `../README.md`
("Deployment outline") and `research/38-kickoff-decks-and-netbird-clarification.md` §3.1, and records
what the deployment actually is. Every step below has been executed from this checkout; the measured
results are at the end of this file.

```
                 https://<a-b-c-d>.sslip.io          VPC 10.x/20 (private)          docker --runtime=kata
 judge/operator ───────────────► VM A airlock-control ──────────────► VM B airlock-sandbox ─► sandbox (guest kernel,
                 Caddy :443 → 127.0.0.1:3000        http://<B vpc>:4300              --network none, no secrets)
                 holds: inference key,               holds: supervisor token,
                        supervisor token                    Docker socket, /dev/kvm
```

| | VM A `airlock-control` | VM B `airlock-sandbox` |
|---|---|---|
| Plan | `vhp-2c-4gb-amd` ($0.033/h; `vc2-2c-4gb` $0.027/h if unavailable in atl) | `vx1-g-4c-16g-240s` ($0.153/h; the VX1 family exposes `/dev/kvm`) |
| OS | Ubuntu 24.04 LTS (`os_id` 2284) | Ubuntu 24.04 LTS |
| Inbound (Vultr firewall group) | 22/tcp from the deploying machine's egress IPs; 80 and 443/tcp from anywhere | 22/tcp from the deploying machine's egress IPs; nothing else |
| Listeners | Caddy 80/443 (public); control plane 127.0.0.1:3000 | supervisor on the VPC address only, port 4300; ufw admits it from VM A's VPC address only |
| Runs as | `airlock` (system user, no docker) | `airlock-supervisor` (system user in `docker` and `kvm`) |
| Secrets (root-only `EnvironmentFile`, 0600) | `/etc/airlock/control.env`: `SUPERVISOR_TOKEN`, `VULTR_INFERENCE_API_KEY`, role passwords | `/etc/airlock/supervisor.env`: `SUPERVISOR_TOKEN` only |
| Runtime | – | Docker CE + gVisor `runsc` (apt) + Kata Containers 3.32.0 static (`/opt/kata`), both registered in `/etc/docker/daemon.json`; `AIRLOCK_RUNTIME=kata` |
| Data | `/var/lib/airlock/control` (PGlite + artifacts) | `/var/lib/airlock/supervisor` (journal + sentinel) |
| Tree | `/opt/airlock/app` (rsync of this checkout) | `/opt/airlock/app`; runtime image `airlock-runtime-python:tabulate-365` built here |

Cost: **$0.186/h** for both VMs on the plans above ($0.180/h with the `vc2` fallback), about $4.50 per
day. Instances bill while they exist, stopped or not; run `deploy/vultr/destroy.sh` when done.

## Prerequisites (on the machine you deploy from)

- `curl`, `jq`, `rsync`, `ssh`, `openssl`, `bun` (for the smoke and live gate).
- A Vultr account API key as `VULTR_API_KEY` in `.env` at the repository root (or exported), a
  Serverless Inference subscription key as `VULTR_INFERENCE_API_KEY` (only needed for `--driver vultr`).
  Neither is ever printed, committed or sent as instance `user_data`.
- An SSH key registered in the account under the name `airlock-hackathon` (override with
  `AIRLOCK_SSHKEY_NAME`) whose private half is `~/.ssh/airlock_ed25519` (override with `AIRLOCK_SSH_KEY`).
- Region `atl` (override `AIRLOCK_REGION`): the inference models are served from there.

## Steps

```sh
deploy/vultr/provision.sh                  # 1. VPC, firewall groups, two instances; waits for SSH; writes data/deploy/state.json
deploy/deploy.sh --driver scripted         # 2. hosts, tree, runtime image, units; scripted model driver (for the smoke)
deploy/preflight.sh                        # 3. on VM B: kvm, runtimes, kata/runsc uname, /health, a real sandbox + hostile run
AIRLOCK_CONTROL_URL=https://<host>.sslip.io AIRLOCK_OPERATOR_PASSWORD=<data/deploy/secrets.env> \
  SUPERVISOR_URL=http://127.0.0.1:4300 SUPERVISOR_TOKEN=<secrets.env> DOCKER_HOST=ssh://root@<VM B ip> \
  bun scripts/smoke.ts                     # 4. end to end through the public URL (see "Running the smoke remotely")
deploy/deploy.sh --driver vultr --model glm-5.3 --skip-host-setup   # 5. switch VM A to live inference
AIRLOCK_CONTROL_URL=https://<host>.sslip.io AIRLOCK_OPERATOR_PASSWORD=<...> bun scripts/live-gate.ts --n 3
deploy/vultr/destroy.sh                    # teardown (asks for confirmation; --yes to skip)
```

### What each script does

- **`deploy/vultr/provision.sh`** (curl + jq against `api.vultr.com/v2`): looks up or creates the VPC
  `airlock-vpc`, the firewall groups `airlock-control` and `airlock-sandbox` with the rules in the table,
  and the two instances (label + tag `airlock`, `attach_vpc`, `sshkey_id`, `backups: disabled`,
  **no `user_data`**). It samples several public-IP reflectors because a NATed uplink may alternate
  between egress addresses (this one did: two), and admits SSH from each. Transient API failures
  (5xx/429) are retried. Waits for `active/ok/running`, the VPC address and SSH, then writes
  `data/deploy/state.json` (gitignored). Idempotent: re-running adopts what exists and prunes SSH rules
  for egress IPs that are no longer yours. `--plan` prints the plan and exits.
- **`deploy/vultr/destroy.sh`**: deletes exactly the ids in `state.json` (instances, then firewall
  groups, then the VPC), after you type `destroy` (or `--yes`). `secrets.env` is kept.
- **`deploy/host/sandbox-host.sh`** (run on VM B as root, over SSH, by `deploy.sh`): Docker CE from
  the official repository; gVisor from its apt repository; Kata Containers static release under
  `/opt/kata` with the shim symlinked into `/usr/local/bin`; both registered in `daemon.json`
  (`runsc` by path, `kata` as `io.containerd.kata.v2` with its `ConfigPath`); bun 1.3.14; git and
  python3 (`runtime/python/prepare-profile.sh` needs both); the `airlock-supervisor` user; the
  `ufw` (already active on Vultr's Ubuntu image with 22/tcp only) extended with 4300/tcp from VM A's VPC
  address only; `airlock-supervisor.service`. It never receives a secret.
- **`deploy/host/control-host.sh`** (VM A): Caddy from its official repository with a Caddyfile for the
  sslip.io name (automatic TLS, `reverse_proxy 127.0.0.1:3000`); bun; the `airlock` user;
  `airlock-control.service`. Never receives a secret.
- **`deploy/deploy.sh`**: generates `data/deploy/secrets.env` (0600: `SUPERVISOR_TOKEN`, operator and
  judge passwords) once; rsyncs the tree (excluding `node_modules`, `data`, `.env*`, `dist`,
  `research/`, `.git`); runs the host scripts; `bun install --frozen-lockfile` on both; builds
  `apps/web/dist` on VM A and `airlock-runtime-python:tabulate-365` on VM B (`runtime/python/build.sh`,
  which verifies the profile's base tree digest first); writes the two EnvironmentFiles over SSH
  (stdin → root-only file, never a command-line argument, never `user_data`); restarts the units; waits
  for the supervisor `/health` on the VPC address, the control plane on `127.0.0.1:3000` and then the
  public https URL. `--driver scripted|vultr`, `--model`, `--skip-host-setup`, `--only control|sandbox`.
  Everything is logged to `data/deploy/deploy-<ts>.log`.
- **`deploy/preflight.sh`** (over SSH on VM B, output saved to `data/deploy/preflight-<ts>.txt`):
  `/dev/kvm` and CPU flags; Docker's runtime list; `docker run --rm --runtime=<kata|runsc|runc>
  python:3.12-slim uname -r`; listeners and ufw; the unit's user; then `deploy/preflight-api.ts`
  talks to the supervisor API like the control plane does: `/health`, a real author sandbox (effective
  runtime name, guest uname/hostname, the five isolation probe results, `uname -a` from inside,
  teardown) and a hostile one-shot that tries `169.254.169.254` from inside. Exit 1 on any failed check.

### Control plane environment written by `deploy.sh`

`CONTROL_BIND=127.0.0.1`, `AIRLOCK_TRUST_PROXY=1` (Caddy is on the same host; the login limiter keys
on Caddy's `X-Forwarded-For` hop), cookies keep their `Secure` flag (https only),
`SUPERVISOR_URL=http://<VM B VPC ip>:4300`, `AIRLOCK_WEB_DIST=/opt/airlock/app/apps/web/dist`,
`AIRLOCK_DATA_DIR=/var/lib/airlock/control`. With `--driver scripted` the driver is
`scripted:/opt/airlock/app/apps/control/test/fixtures/scripted` (every model event is labelled
`scripted:<name>`; never a live repair); with `--driver vultr` it is `vultr` plus
`VULTR_INFERENCE_API_KEY` and `AIRLOCK_MODEL`.

### Supervisor environment

`SUPERVISOR_BIND=<VM B VPC ip>`, `PORT=4300`, `AIRLOCK_RUNTIME=kata` (override `AIRLOCK_RUNTIME=runsc`
in the deploying shell to ship the floor tier), `AIRLOCK_DATA_DIR=/var/lib/airlock/supervisor`,
`AIRLOCK_DEV_UNSAFE` unset. `AIRLOCK_DOCKER_RUNTIME_NAME` is left empty: the daemon registers the
runtimes under exactly the names the supervisor expects (`kata`, `runsc`, see
`apps/supervisor/src/config.ts`).

### Running the smoke remotely

`scripts/smoke.ts` drives the public HTTP API but makes two external observations that need VM B: the
supervisor's `GET /attempts` (VPC only) and `docker ps` by label. From the deploying machine:

```sh
ssh -i ~/.ssh/airlock_ed25519 -f -N -L 4300:<VM B VPC ip>:4300 root@<VM A public ip>        # supervisor, via VM A (only VM A may reach it)
ssh -i ~/.ssh/airlock_ed25519 -f -N -L /tmp/airlock-vmb-docker.sock:/var/run/docker.sock root@<VM B public ip>  # VM B's docker socket
AIRLOCK_CONTROL_URL=https://<host>.sslip.io SUPERVISOR_URL=http://127.0.0.1:4300 \
  DOCKER_HOST=unix:///tmp/airlock-vmb-docker.sock \
  AIRLOCK_OPERATOR_PASSWORD=<secrets.env> SUPERVISOR_TOKEN=<secrets.env> bun scripts/smoke.ts
```

(A local `docker` CLI, `unzip` and `patch` are needed; the smoke only runs `docker ps` by label through
the forwarded socket. `DOCKER_HOST=ssh://` would also work but cannot be pointed at a specific key.)

## Trust properties actually enforced on this topology

Enforced and observed (preflight and smoke output below):

- The supervisor (the only Docker-socket holder) listens on VM B's VPC address only; VM B's Vultr
  firewall admits nothing but SSH from the deploying machine; ufw on VM B drops 4300/tcp from any
  source other than VM A's VPC address. The bearer token is a second layer, not the boundary.
- Provider credentials exist only on VM A (`/etc/airlock/control.env`, root 0600). VM B holds the
  supervisor token only. No secret was placed in instance `user_data` (the instances were created with
  none) or on any command line.
- Every sandbox is created with the configured OCI runtime and inspected afterwards; the recorded tier
  is the effective one (`kata`), with the guest kernel string from inside. `devUnsafe` is false on the
  host check and on every inspection.
- Sandboxes have `--network none`; the isolation probe (metadata endpoint, DNS, outbound TCP, Docker
  socket, host mounts) is fully BLOCKED before any agent work, and a hostile run that tries
  `169.254.169.254` from inside fails.
- The control plane binds loopback behind Caddy with automatic TLS; session cookies are `Secure`;
  the login rate limit keys on the real client address (`AIRLOCK_TRUST_PROXY=1`).
- Both services run as dedicated non-root users under systemd with `Restart=on-failure`,
  `NoNewPrivileges`, `ProtectSystem=full`, `PrivateTmp`.

Not enforced (known limits of this deployment):

- **No NetBird.** The controller → supervisor link is the Vultr VPC, not a mutually authenticated
  peer link; the public URL is served directly from VM A. NetBird remains the optional add-on of
  `research/38` §3.4.
- **SSH is open from the deploying machine's egress IPs** (two /32s here) on both VMs, as root with
  the registered key. Password SSH is what the image ships; it is not used.
- **The Vultr firewall filters inbound only**, and only the public interface: it does not apply to
  VPC traffic (hence the ufw rule) and does not restrict egress from either VM. VM B's own egress
  is unrestricted (apt, image pulls, the profile clone). Sandboxes have no network at all, so VM B's
  egress is irrelevant to them.
- **`docker` group = root-equivalent on VM B.** The supervisor must hold the Docker socket; running it
  as `airlock-supervisor` separates its files, journal and crash surface from root's but does not
  make a compromise of the supervisor process less than a compromise of VM B. That is the reason the
  supervisor's API is as narrow as it is and why nothing on VM B holds a provider credential.
- The viewer role needs no password and can read every task and event stream (see `../README.md`,
  "Sessions and roles"). Do not paste private text into this public deployment.
- `sslip.io` is a public wildcard DNS service; the certificate is issued by Let's Encrypt/ZeroSSL for
  the IP-derived name. There is no custom domain.
- TLS to VM A only; VM A → VM B is plain HTTP inside the VPC.

## Teardown

```sh
deploy/vultr/destroy.sh        # deletes the two instances, both firewall groups and the VPC listed in data/deploy/state.json
```

Check afterwards in the console (or `GET /v2/instances?tag=airlock`) that nothing tagged `airlock`
remains; instances are billed hourly until destroyed.

## Recorded results (2026-09-27, from this checkout)

Instances (both `atl`, Ubuntu 24.04, tag `airlock`, no `user_data`; the metadata service returns 0 bytes of user-data on both):

| | id | plan | public IP | VPC IP |
|---|---|---|---|---|
| airlock-control | `fd8ce18b-49b7-4056-9a45-467b682acad4` | `vhp-2c-4gb-amd` ($0.033/h) | 144.202.21.168 | 10.6.96.3 |
| airlock-sandbox | `b0f4d0c0-d6b0-428a-b9d0-1d5d820c039c` | `vx1-g-4c-16g-240s` ($0.153/h) | 45.76.248.176 | 10.6.96.4 |

VPC `2bc3528c-f708-4647-9ea1-5dae00c7b81a` (10.6.96.0/20); firewall groups `200bab19-…` (control) and
`721a8456-…` (sandbox). Public URL `https://144-202-21-168.sslip.io`, certificate issued by Let's
Encrypt (`CN=144-202-21-168.sslip.io`). Total $0.186/h.

**Preflight on VM B** (`data/deploy/preflight-20260927T024706Z.txt`, `PREFLIGHT PASSED`), verbatim for the runtime checks:

```
host kernel: 6.8.0-139-generic   Linux airlock-sandbox 6.8.0-139-generic #139-Ubuntu SMP PREEMPT_DYNAMIC Sat Aug  1 03:52:05 UTC 2026 x86_64 x86_64 x86_64 GNU/Linux
cpu: AMD EPYC-Turin Processor   virt flags on 4 cores
/dev/kvm: crw-rw---- 1 root kvm 10, 232 Sep 27 02:06 /dev/kvm
  ok   /dev/kvm present
  ok   /dev/kvm readable+writable by root
  ok   /dev/kvm readable+writable by airlock-supervisor
Docker version 29.8.1, build 4a63305
runtimes: io.containerd.runc.v2 kata runc runsc    default: runc
  kata: 6.18.35                       (guest kernel; differs from the host's 6.8.0-139-generic)
  runsc: 4.19.0-gvisor
  runc: 6.8.0-139-generic             (shares the host kernel; reference only)
  kata-runtime check: System is capable of running Kata Containers System can currently create Kata Containers
  kata full uname inside guest: Linux d3fbc21433df 6.18.35 #1 SMP Mon Jun 15 12:55:58 UTC 2026 x86_64 GNU/Linux
  runsc full uname inside sandbox: Linux d4f18caa3d0c 4.19.0-gvisor #1 SMP Sun Jan 10 15:06:54 PST 2016 x86_64 GNU/Linux
LISTEN 0 512 10.6.96.4:4300 (bun)     ok   supervisor bound to the VPC address 10.6.96.4:4300 only
ufw: Status: active; 4300/tcp ALLOW 10.6.96.3
supervisor /health host: {"dockerVersion":"29.8.1","cpuVirtualization":true,"kvmPresent":true,"kvmReadWrite":true,
  "availableRuntimes":["io.containerd.runc.v2","kata","runc","runsc"],"selectedRuntime":"kata","devUnsafe":false}
author sandbox: inspection.runtime=kata devUnsafe=false
  inspection.guestUname=Linux sandbox 6.18.35 #1 SMP Mon Jun 15 12:55:58 UTC 2026 x86_64 GNU/Linux
  probe: metadataEndpoint=BLOCKED dns=BLOCKED outboundTcp=BLOCKED dockerSocket=BLOCKED hostMounts=BLOCKED
  teardown: {"containersRemaining":[],"volumesRemaining":[],"clean":true}
hostile one-shot: died.runtime=kata; exec stdout: "6.18.35 / METADATA_BLOCKED URLError"; survived: supervisorHealthy=true hostSentinelUnchanged=true; teardown clean
```

`AIRLOCK_DOCKER_RUNTIME_NAME` was not needed: the daemon lists the runtimes as `kata` and `runsc`.

**Smoke** (`data/deploy/smoke.log`, run from the deploying machine against the public URL with the
scripted driver): `SMOKE PASSED — outcomes: task1=CANDIDATE_PASSED_CHECKS task2=CHECKS_FAILED task3=cancelled`.
Task 1's five checkpoints on the deployment: host check `selected=kata devUnsafe=false kvm=true`; four exec
events with exit codes; in-sandbox identity `runtime=kata hostname=sandbox uname=Linux sandbox 6.18.35 …`;
isolation probe all BLOCKED; teardown `(no sandboxes)`. Preview rendered the header-only table; the export
zip's `patch.diff` applied with `patch -p1 --dry-run`; `rm -rf / --no-preserve-root` died in its Kata
sandbox (exit 1, read-only rootfs) with the supervisor, host sentinel and control plane intact; the
forged-log run ended `CHECKS_FAILED`; the fork bomb timed out in its sandbox while task 3's command
finished unaffected; the cancelled task left no attempt at the supervisor and no container in `docker ps`.

**Live gate** (`data/deploy/live-gate.log`, after `deploy.sh --driver vultr --model glm-5.3 --only control
--skip-host-setup`; three fresh hero tasks through the public API, verdicts by the external comparator on
Kata sandboxes): `LIVE GATE: 3/3 passed the external comparator (need 2). PASS`

| task | outcome | model calls | wall time | candidate digest | model |
|---|---|---|---|---|---|
| task-b27370ac500e0662 | CANDIDATE_PASSED_CHECKS | 15 | 63 s | b4d4f97d5cda… | glm-5.3-normalize |
| task-dc4eefede82991eb | CANDIDATE_PASSED_CHECKS | 12 | 41 s | 10df8edaaa61… | glm-5.3-normalize |
| task-944aee3d74be46ae | CANDIDATE_PASSED_CHECKS | 13 | 53 s | 4ca535f631f6… | glm-5.3-normalize |

Each verification record carries `inspection.runtime: "kata"`, `devUnsafe: false`, the guest uname
`Linux sandbox 6.18.35 …` and a clean teardown; `docker ps` by label on VM B is empty afterwards. The
deployment is left on the `vultr` driver.

**Deviations from the target topology**

- Host firewall is `ufw` (already active on Vultr's Ubuntu image) rather than a hand-written nftables
  table: the same scope (4300/tcp from VM A's VPC address only; 80/443 on VM A), one mechanism.
- SSH is admitted from two /32s, not one: this uplink alternates between two egress addresses.
- `git` is installed on VM B: `runtime/python/build.sh` runs `prepare-profile.sh`, which keeps a
  reference clone of python-tabulate to verify the base tree. VM A needs no git.
- The committed profile base was missing four dotfiles (fixed in this branch); `deploy.sh` now verifies
  the base digest on each host after the sync.
- `airlock-supervisor` is also in the `kvm` group so that `HostCheck.kvmReadWrite` reports what that
  process can open; Kata's VMM itself runs under containerd as root.
