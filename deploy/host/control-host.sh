#!/usr/bin/env bash
# Airlock VM A (control plane) setup. Idempotent; run as root over SSH by deploy/deploy.sh:
#
#   ssh root@<control public ip> bash -s -- --public-host <name>.sslip.io < deploy/host/control-host.sh
#
# Installs and configures, without ever receiving a secret (secrets arrive separately as the
# root-only EnvironmentFile /etc/airlock/control.env written by deploy.sh):
#   - Caddy from its official apt repository, serving https://<public-host> with automatic TLS and
#     reverse-proxying to the control plane on 127.0.0.1:3000 (port 80 answers the ACME challenge and
#     redirects to https)
#   - bun $BUN_VERSION in /usr/local/bin, unzip + patch (scripts/smoke.ts if run here), python3
#   - service user `airlock` (system account, no docker group: VM A never holds a Docker socket),
#     /opt/airlock/app (tree), /var/lib/airlock/control (PGlite + artifacts), /etc/airlock (0700 root)
#   - systemd unit airlock-control.service (not started here; deploy.sh writes the env and starts it)
set -euo pipefail

BUN_VERSION="${BUN_VERSION:-1.3.14}"
PUBLIC_HOST=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --public-host) PUBLIC_HOST="$2"; shift 2 ;;
    *) echo "control-host: unknown argument $1" >&2; exit 1 ;;
  esac
done
[[ "$PUBLIC_HOST" =~ ^[a-z0-9.-]+$ ]] || { echo "control-host: --public-host <dns name> is required" >&2; exit 1; }
[[ $(id -u) -eq 0 ]] || { echo "control-host: run as root" >&2; exit 1; }
export DEBIAN_FRONTEND=noninteractive
log() { echo "control-host: $*" >&2; }

apt-get -o DPkg::Lock::Timeout=600 update -q
apt-get -o DPkg::Lock::Timeout=600 install -y -q ca-certificates curl gnupg debian-keyring debian-archive-keyring apt-transport-https python3 unzip patch rsync jq

# --- Caddy (official repository) ----------------------------------------------------------------------------------
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get -o DPkg::Lock::Timeout=600 update -q
  apt-get -o DPkg::Lock::Timeout=600 install -y -q caddy
fi
cat > /etc/caddy/Caddyfile <<EOF
# Managed by deploy/host/control-host.sh. Automatic TLS for the sslip.io name of this VM's public IP.
${PUBLIC_HOST} {
	encode gzip
	reverse_proxy 127.0.0.1:3000
}
# Disclosed demo fixtures (apps/fixtures): the hero data page and the airlock-forms-v1 destination.
# A separate public name, because the browser's egress proxy only reaches public addresses.
forms.${PUBLIC_HOST} {
	encode gzip
	reverse_proxy 127.0.0.1:3100
}
EOF
systemctl enable caddy >/dev/null 2>&1 || true
systemctl restart caddy
# Host firewall: Vultr's Ubuntu image ships ufw ACTIVE with only 22/tcp allowed; Caddy needs 80 (ACME
# http-01 + redirect) and 443. The control plane itself stays on 127.0.0.1:3000 (nothing to open).
ufw --force enable >/dev/null
ufw default deny incoming >/dev/null
ufw allow 22/tcp >/dev/null
ufw allow 80/tcp comment 'caddy: ACME + https redirect' >/dev/null
ufw allow 443/tcp comment 'caddy: public UI' >/dev/null
ufw reload >/dev/null
log "ufw: $(ufw status | grep -E '^(22|80|443)/tcp ' | tr -s ' ' | tr '\n' ';')"
# Restart after the ports are open so an ACME attempt that failed on a closed port 80 is retried now
# rather than after Caddy's backoff.
systemctl restart caddy
log "caddy $(caddy version | head -n1) serving ${PUBLIC_HOST}"

# --- bun ---------------------------------------------------------------------------------------------------------------
if ! command -v bun >/dev/null || [[ "$(bun --version)" != "$BUN_VERSION" ]]; then
  curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash -s -- "bun-v${BUN_VERSION}" >/dev/null
fi
log "bun $(bun --version)"

# --- service user and directories ---------------------------------------------------------------------------------------
if ! id airlock >/dev/null 2>&1; then
  useradd --system --create-home --home-dir /var/lib/airlock --shell /usr/sbin/nologin airlock
fi
install -d -m 0755 -o airlock -g airlock /opt/airlock /opt/airlock/app
install -d -m 0750 -o airlock -g airlock /var/lib/airlock /var/lib/airlock/control /var/lib/airlock/fixtures
install -d -m 0700 -o root -g root /etc/airlock

# --- systemd unit (env written by deploy.sh) ---------------------------------------------------------------------------------
cat > /etc/systemd/system/airlock-control.service <<'EOF'
[Unit]
Description=Airlock control plane (VM A: tasks, contracts, model client, export; never runs candidate code)
After=network-online.target
Wants=network-online.target
[Service]
User=airlock
Group=airlock
WorkingDirectory=/opt/airlock/app/apps/control
EnvironmentFile=/etc/airlock/control.env
ExecStart=/usr/local/bin/bun src/index.ts
Restart=on-failure
RestartSec=3
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=full
ReadWritePaths=/var/lib/airlock
[Install]
WantedBy=multi-user.target
EOF
cat > /etc/systemd/system/airlock-fixtures.service <<'EOF'
[Unit]
Description=Airlock demo fixtures (disclosed: hero data page and the airlock-forms-v1 form destination)
After=network-online.target
Wants=network-online.target
[Service]
User=airlock
Group=airlock
WorkingDirectory=/opt/airlock/app/apps/fixtures
EnvironmentFile=/etc/airlock/fixtures.env
ExecStart=/usr/local/bin/bun src/index.ts
Restart=on-failure
RestartSec=3
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=full
ReadWritePaths=/var/lib/airlock/fixtures
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable airlock-control.service airlock-fixtures.service >/dev/null 2>&1 || true
log "done"
