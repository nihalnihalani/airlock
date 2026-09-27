#!/usr/bin/env bash
# Airlock VM B (sandbox host) setup. Idempotent; run as root over SSH by deploy/deploy.sh:
#
#   ssh root@<sandbox public ip> bash -s -- --control-vpc-ip <VM A VPC address> < deploy/host/sandbox-host.sh
#
# Installs and configures, without ever receiving a secret (secrets arrive separately as the
# root-only EnvironmentFile /etc/airlock/supervisor.env written by deploy.sh):
#   - Docker Engine from the official apt repository (>= 25 is needed for shim-v2 runtimes in daemon.json)
#   - gVisor `runsc` from the official apt repository, registered as Docker runtime "runsc"
#   - Kata Containers static release $KATA_VERSION under /opt/kata, registered as Docker runtime "kata"
#     (runtimeType io.containerd.kata.v2, ConfigPath /opt/kata/share/defaults/kata-containers/configuration.toml)
#   - bun $BUN_VERSION in /usr/local/bin, git + python3 (runtime/python/prepare-profile.sh needs both), zstd
#   - service user `airlock-supervisor` (system account, member of `docker`), /opt/airlock/app (tree),
#     /var/lib/airlock/supervisor (journal + sentinel), /etc/airlock (EnvironmentFile dir, 0700 root)
#   - ufw (active by default on Vultr's Ubuntu image, 22/tcp only): adds 4300/tcp from the control plane's
#     VPC address only (the Vultr firewall group filters the public interface only, so a VPC neighbour
#     would otherwise reach the supervisor; the bearer token remains the second line)
#   - systemd unit airlock-supervisor.service with AIRLOCK_PRODUCTION=1 (not started here; deploy.sh
#     writes the env and starts it)
#
# Trade-off, documented in deploy/README.md: a member of the docker group is root-equivalent on this
# host. The supervisor is the one process that must hold the Docker socket (CLAUDE.md §2); running it
# as a dedicated non-root user still keeps its files, journal and crash surface separate from root's.
set -euo pipefail

KATA_VERSION="${KATA_VERSION:-3.32.0}"
BUN_VERSION="${BUN_VERSION:-1.3.14}"
CONTROL_VPC_IP=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --control-vpc-ip) CONTROL_VPC_IP="$2"; shift 2 ;;
    *) echo "sandbox-host: unknown argument $1" >&2; exit 1 ;;
  esac
done
[[ "$CONTROL_VPC_IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "sandbox-host: --control-vpc-ip <ipv4> is required" >&2; exit 1; }
[[ $(id -u) -eq 0 ]] || { echo "sandbox-host: run as root" >&2; exit 1; }
export DEBIAN_FRONTEND=noninteractive
log() { echo "sandbox-host: $*" >&2; }

# --- KVM must exist on this host (VX1); refuse early otherwise so the caller sees why ------------------
if [[ ! -e /dev/kvm ]]; then
  log "WARNING: /dev/kvm is absent on this host: Kata cannot run here; the deployment will have to use runsc"
else
  log "/dev/kvm: $(ls -l /dev/kvm)"
fi
log "cpu virtualization flags: $(grep -c -E '(vmx|svm)' /proc/cpuinfo) cores"

# --- base packages ---------------------------------------------------------------------------------------
apt-get -o DPkg::Lock::Timeout=600 update -q
apt-get -o DPkg::Lock::Timeout=600 install -y -q ca-certificates curl gnupg git python3 zstd unzip jq ufw rsync

# --- Docker Engine (official repository) -------------------------------------------------------------------
if ! command -v docker >/dev/null || ! dpkg -s docker-ce >/dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  . /etc/os-release
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" > /etc/apt/sources.list.d/docker.list
  apt-get -o DPkg::Lock::Timeout=600 update -q
  apt-get -o DPkg::Lock::Timeout=600 install -y -q docker-ce docker-ce-cli containerd.io docker-buildx-plugin
fi
log "docker $(docker --version)"

# --- gVisor (official apt repository; the binary-only `runsc install` download path is being retired) -----
if ! command -v runsc >/dev/null; then
  curl -fsSL https://gvisor.dev/archive.key | gpg --dearmor --yes -o /usr/share/keyrings/gvisor-archive-keyring.gpg
  echo "deb [arch=amd64 signed-by=/usr/share/keyrings/gvisor-archive-keyring.gpg] https://storage.googleapis.com/gvisor/releases release main" > /etc/apt/sources.list.d/gvisor.list
  apt-get -o DPkg::Lock::Timeout=600 update -q
  apt-get -o DPkg::Lock::Timeout=600 install -y -q runsc
fi
log "runsc $(runsc --version | head -n1)"

# --- Kata Containers static release --------------------------------------------------------------------------
if [[ ! -x /opt/kata/bin/containerd-shim-kata-v2 || "$(cat /opt/kata/.airlock-version 2>/dev/null || true)" != "$KATA_VERSION" ]]; then
  TARBALL="/var/tmp/kata-static-${KATA_VERSION}-amd64.tar.zst"
  if [[ ! -f "$TARBALL" ]]; then
    log "downloading kata-static ${KATA_VERSION} (about 1.5 GB)"
    curl -fL --retry 3 -o "$TARBALL.part" "https://github.com/kata-containers/kata-containers/releases/download/${KATA_VERSION}/kata-static-${KATA_VERSION}-amd64.tar.zst"
    mv "$TARBALL.part" "$TARBALL"
  fi
  log "extracting kata-static to /opt/kata"
  rm -rf /opt/kata
  tar --zstd -xf "$TARBALL" -C /
  echo "$KATA_VERSION" > /opt/kata/.airlock-version
  rm -f "$TARBALL"
fi
ln -sfn /opt/kata/bin/containerd-shim-kata-v2 /usr/local/bin/containerd-shim-kata-v2
ln -sfn /opt/kata/bin/kata-runtime /usr/local/bin/kata-runtime
log "kata $(/opt/kata/bin/kata-runtime --version | head -n1)"

# --- Docker daemon: register both runtimes (merge, never clobber unrelated keys) ----------------------------
python3 - <<'PY'
import json, os
path = "/etc/docker/daemon.json"
cfg = {}
if os.path.exists(path):
    with open(path) as fh:
        cfg = json.load(fh) or {}
runtimes = cfg.setdefault("runtimes", {})
runtimes["runsc"] = {"path": "/usr/bin/runsc"}
runtimes["kata"] = {"runtimeType": "io.containerd.kata.v2",
                    "options": {"ConfigPath": "/opt/kata/share/defaults/kata-containers/configuration.toml"}}
# containerd's shim lookup needs the shim binary on the daemon's PATH; /usr/local/bin is on it.
cfg.setdefault("log-driver", "json-file")
cfg.setdefault("log-opts", {"max-size": "20m", "max-file": "3"})
tmp = path + ".tmp"
with open(tmp, "w") as fh:
    json.dump(cfg, fh, indent=2, sort_keys=True)
    fh.write("\n")
os.replace(tmp, path)
PY
systemctl enable docker >/dev/null 2>&1 || true
systemctl restart docker
for i in $(seq 1 30); do docker info >/dev/null 2>&1 && break; sleep 1; done
log "docker runtimes: $(docker info --format '{{range $k, $v := .Runtimes}}{{$k}} {{end}}')"

# --- bun -------------------------------------------------------------------------------------------------------
if ! command -v bun >/dev/null || [[ "$(bun --version)" != "$BUN_VERSION" ]]; then
  curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash -s -- "bun-v${BUN_VERSION}" >/dev/null
fi
log "bun $(bun --version)"

# --- service user and directories -------------------------------------------------------------------------------
if ! id airlock-supervisor >/dev/null 2>&1; then
  useradd --system --create-home --home-dir /var/lib/airlock --shell /usr/sbin/nologin airlock-supervisor
fi
# docker: the supervisor's whole job (see the trade-off above). kvm: /dev/kvm is root:kvm 0660 on Ubuntu;
# Kata's VMM runs under containerd (root), but the host check reports whether THIS process can open
# /dev/kvm read-write (HostCheck.kvmReadWrite), so the service user is given the group as well.
usermod -aG docker,kvm airlock-supervisor
install -d -m 0755 -o airlock-supervisor -g airlock-supervisor /opt/airlock /opt/airlock/app
install -d -m 0750 -o airlock-supervisor -g airlock-supervisor /var/lib/airlock /var/lib/airlock/supervisor
install -d -m 0700 -o root -g root /etc/airlock
# runtime/python/prepare-profile.sh (run as root by deploy.sh through build.sh) keeps its reference
# clone under the tree, which the service user owns; root's git would otherwise refuse the directory.
# (the per-directory glob form needs git >= 2.46; Ubuntu 24.04 ships 2.43, so root gets the plain '*'.)
git config --global --get-all safe.directory 2>/dev/null | grep -qx '\*' || git config --global --add safe.directory '*'

# --- host firewall (ufw): Vultr's Ubuntu image ships ufw ACTIVE with only 22/tcp allowed, and the Vultr
# firewall group does not filter VPC traffic, so this is where the supervisor port is scoped: 4300/tcp
# from the control plane's VPC address only; everything else inbound stays denied (ufw default).
# Docker publishes no ports here, so the well-known docker/ufw FORWARD bypass does not apply.
ufw --force enable >/dev/null
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow 22/tcp >/dev/null
# drop any earlier 4300 rule whose source is not the current control plane address
while read -r num; do [[ -n "$num" ]] && ufw --force delete "$num" >/dev/null; done < <(ufw status numbered | grep -E '4300/tcp' | grep -v "$CONTROL_VPC_IP" | sed -E 's/^\[ *([0-9]+)\].*/\1/' | sort -rn)
ufw allow from "$CONTROL_VPC_IP" to any port 4300 proto tcp comment 'airlock supervisor from the control plane VPC address' >/dev/null
ufw reload >/dev/null
# a previous revision installed a separate nftables table for the same purpose; retire it if present
systemctl disable --now airlock-nft.service >/dev/null 2>&1 || true
rm -f /etc/systemd/system/airlock-nft.service /etc/airlock/nft.conf
nft delete table inet airlock >/dev/null 2>&1 || true
log "ufw: $(ufw status | grep -E '4300/tcp' | tr -s ' ' | tr '\n' ';')"

# --- browser plane: host-level egress enforcement (C8) ----------------------------------------------------------
# The supervisor names each browser attempt's bridges ali<hex> (internal) and ale<hex> (egress). The
# guard drops metadata/RFC 1918/host-bound traffic from them and all IPv6 on them (see the script
# header). A oneshot unit re-applies it after Docker on every boot; deploy re-runs it here.
# UNVERIFIED on VX1 until `iptables -S AIRLOCK-FWD` and the browser integration test are recorded there.
install -m 0755 -o root -g root "$(dirname "$0")/airlock-egress-guard.sh" /usr/local/sbin/airlock-egress-guard 2>/dev/null \
  || install -m 0755 -o root -g root /opt/airlock/app/deploy/host/airlock-egress-guard.sh /usr/local/sbin/airlock-egress-guard 2>/dev/null \
  || log "WARNING: airlock-egress-guard.sh not found next to this script or in /opt/airlock/app yet; deploy.sh installs it after the tree sync"
cat > /etc/systemd/system/airlock-egress-guard.service <<'EOF'
[Unit]
Description=Airlock browser plane: host firewall for per-attempt bridges (ali+/ale+)
After=docker.service ufw.service
Requires=docker.service
Before=airlock-supervisor.service
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/sbin/airlock-egress-guard
ExecReload=/usr/local/sbin/airlock-egress-guard
ExecStop=/usr/local/sbin/airlock-egress-guard --remove
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
if [[ -x /usr/local/sbin/airlock-egress-guard ]]; then
  systemctl enable airlock-egress-guard.service >/dev/null 2>&1 || true
  systemctl restart airlock-egress-guard.service && log "egress guard: $(iptables -S AIRLOCK-FWD 2>/dev/null | wc -l) forward rules, $(iptables -S AIRLOCK-IN 2>/dev/null | wc -l) input rules"
fi

# --- systemd unit (env written by deploy.sh) ------------------------------------------------------------------------
cat > /etc/systemd/system/airlock-supervisor.service <<'EOF'
[Unit]
Description=Airlock supervisor (VM B execution plane; the only process holding the Docker socket)
After=network-online.target docker.service ufw.service airlock-egress-guard.service
Requires=docker.service
Wants=airlock-egress-guard.service
Wants=network-online.target
[Service]
User=airlock-supervisor
Group=airlock-supervisor
SupplementaryGroups=docker
WorkingDirectory=/opt/airlock/app/apps/supervisor
EnvironmentFile=/etc/airlock/supervisor.env
# D4: this host is a deployment. The supervisor refuses to start with dev-unsafe, runc or without a
# pinned AIRLOCK_RUNTIME_IMAGE_ID. Set on the command line (after the EnvironmentFile is applied) so
# an env file entry cannot override it.
ExecStart=/usr/bin/env AIRLOCK_PRODUCTION=1 /usr/local/bin/bun src/index.ts
Restart=on-failure
RestartSec=3
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=full
ReadWritePaths=/var/lib/airlock /opt/airlock/app
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable airlock-supervisor.service >/dev/null 2>&1 || true
log "done"
