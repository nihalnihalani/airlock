#!/usr/bin/env bash
# Airlock: deploy the working tree onto the two VMs recorded in data/deploy/state.json.
#
#   deploy/deploy.sh [--driver scripted|vultr] [--model <id>] [--skip-host-setup] [--only control|sandbox]
#
# Steps (each idempotent; re-run after any change):
#   1. secrets: data/deploy/secrets.env (0600, gitignored) gets a random SUPERVISOR_TOKEN and role
#      passwords on first run; VULTR_INFERENCE_API_KEY and AIRLOCK_MODEL come from the environment or
#      from $AIRLOCK_ENV_FILE (default <repo>/.env). Nothing is printed; nothing goes through Vultr user_data.
#   2. rsync the tree to both VMs (/opt/airlock/app), excluding node_modules, data, .env*, dist, research/.
#   3. VM B: deploy/host/sandbox-host.sh (docker, runsc, kata, bun, service user, nftables, unit), then
#      `bun install --frozen-lockfile`, build airlock-runtime-python:tabulate-365 on the host, write
#      /etc/airlock/supervisor.env (root, 0600), restart airlock-supervisor, wait for /health on the VPC address.
#   4. VM A: deploy/host/control-host.sh (caddy, bun, service user, unit), `bun install --frozen-lockfile`,
#      `bun run --cwd apps/web build`, write /etc/airlock/control.env (root, 0600), restart airlock-control,
#      wait for /api/session on 127.0.0.1:3000 and then over https on the public name.
#   5. print the public URL and where the passwords are.
#
# --driver scripted  (default) AIRLOCK_MODEL_DRIVER=scripted:<fixtures dir on VM A>: the diagnostic and
#                    forged-log scripts scripts/smoke.ts needs; every model event is labelled scripted.
# --driver vultr     AIRLOCK_MODEL_DRIVER=vultr with VULTR_INFERENCE_API_KEY and AIRLOCK_MODEL (--model
#                    or AIRLOCK_MODEL, default glm-5.3): live Vultr Serverless Inference repairs.
# Logs: data/deploy/deploy-<ts>.log (tee). Requires: rsync, ssh, jq, openssl, curl.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY_DIR="$ROOT/data/deploy"
STATE="$DEPLOY_DIR/state.json"
SECRETS="$DEPLOY_DIR/secrets.env"
ENV_FILE="${AIRLOCK_ENV_FILE:-$ROOT/.env}"
DRIVER="scripted"
MODEL="${AIRLOCK_MODEL:-}"
SKIP_HOST=0
ONLY=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --driver) DRIVER="$2"; shift 2 ;;
    --model) MODEL="$2"; shift 2 ;;
    --skip-host-setup) SKIP_HOST=1; shift ;;
    --only) ONLY="$2"; shift 2 ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "deploy: unknown argument $1" >&2; exit 1 ;;
  esac
done
[[ "$DRIVER" == "scripted" || "$DRIVER" == "vultr" ]] || { echo "deploy: --driver must be scripted or vultr" >&2; exit 1; }
[[ -z "$ONLY" || "$ONLY" == "control" || "$ONLY" == "sandbox" ]] || { echo "deploy: --only must be control or sandbox" >&2; exit 1; }
for tool in rsync ssh jq openssl curl; do command -v "$tool" >/dev/null || { echo "deploy: $tool is required" >&2; exit 1; }; done
[[ -f "$STATE" ]] || { echo "deploy: $STATE not found; run deploy/vultr/provision.sh first" >&2; exit 1; }

mkdir -p "$DEPLOY_DIR"
LOG="$DEPLOY_DIR/deploy-$(date -u +%Y%m%dT%H%M%SZ).log"
exec > >(tee -a "$LOG") 2>&1
log() { echo "deploy: $*"; }

# --- topology from state.json ---------------------------------------------------------------------------------
CONTROL_IP="$(jq -r .control.publicIp "$STATE")"
CONTROL_VPC_IP="$(jq -r .control.vpcIp "$STATE")"
SANDBOX_IP="$(jq -r .sandbox.publicIp "$STATE")"
SANDBOX_VPC_IP="$(jq -r .sandbox.vpcIp "$STATE")"
PUBLIC_HOST="$(jq -r .publicHost "$STATE")"
SSH_KEY_FILE="$(jq -r .sshKeyFile "$STATE")"
SSH=(ssh -i "$SSH_KEY_FILE" -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=15)
RSYNC_RSH="ssh -i $SSH_KEY_FILE -o BatchMode=yes -o StrictHostKeyChecking=accept-new"

# --- secrets (generated once; never printed; never in user_data) --------------------------------------------------
if [[ ! -f "$SECRETS" ]]; then
  umask 077
  {
    echo "SUPERVISOR_TOKEN=$(openssl rand -hex 24)"
    echo "AIRLOCK_OPERATOR_PASSWORD=op-$(openssl rand -hex 8)"
    echo "AIRLOCK_JUDGE_PASSWORD=judge-$(openssl rand -hex 8)"
  } > "$SECRETS"
  umask 022
  log "generated $SECRETS"
fi
chmod 0600 "$SECRETS"
read_kv() { grep -E "^$2=" "$1" | head -n1 | cut -d= -f2- | tr -d '"'"'"' \r'; }
SUPERVISOR_TOKEN="$(read_kv "$SECRETS" SUPERVISOR_TOKEN)"
OPERATOR_PASSWORD="$(read_kv "$SECRETS" AIRLOCK_OPERATOR_PASSWORD)"
JUDGE_PASSWORD="$(read_kv "$SECRETS" AIRLOCK_JUDGE_PASSWORD)"
[[ ${#SUPERVISOR_TOKEN} -ge 16 ]] || { echo "deploy: SUPERVISOR_TOKEN in $SECRETS is too short" >&2; exit 1; }
INFERENCE_KEY="${VULTR_INFERENCE_API_KEY:-}"
if [[ -z "$INFERENCE_KEY" && -f "$ENV_FILE" ]]; then INFERENCE_KEY="$(read_kv "$ENV_FILE" VULTR_INFERENCE_API_KEY)"; fi
if [[ -z "$MODEL" && -f "$ENV_FILE" ]]; then MODEL="$(read_kv "$ENV_FILE" AIRLOCK_MODEL)"; fi
MODEL="${MODEL:-glm-5.3}"
if [[ "$DRIVER" == "vultr" && -z "$INFERENCE_KEY" ]]; then
  echo "deploy: --driver vultr needs VULTR_INFERENCE_API_KEY (environment or $ENV_FILE)" >&2; exit 1
fi

# --- 2. sync the tree ----------------------------------------------------------------------------------------------
RSYNC_EXCLUDES=(--exclude node_modules --exclude data --exclude '.env' --exclude '.env.*' --exclude 'apps/web/dist' --exclude dist
  --exclude research --exclude '.git' --exclude '.claude' --exclude '.omc' --exclude '__pycache__' --exclude '*.sqlite'
  --exclude '.pytest_cache' --exclude '*.log' --exclude '.DS_Store')
sync_tree() { # ip service-user
  log "rsync tree -> root@$1:/opt/airlock/app"
  "${SSH[@]}" "root@$1" "install -d -m 0755 /opt/airlock/app"
  rsync -a --delete "${RSYNC_EXCLUDES[@]}" -e "$RSYNC_RSH" "$ROOT/" "root@$1:/opt/airlock/app/"
  "${SSH[@]}" "root@$1" "id $2 >/dev/null 2>&1 && chown -R $2:$2 /opt/airlock/app || true"
  # Both processes verify every profile's base/ against profile.baselineTreeDigest at start-up and
  # skip a profile that fails; with one profile that is a refusal to start. Check what arrived.
  local expected actual
  expected="$(jq -r .baselineTreeDigest "$ROOT/profiles/tabulate-365/profile.json")"
  actual="$("${SSH[@]}" "root@$1" "cd /opt/airlock/app && python3 runtime/python/tree_digest.py profiles/tabulate-365/base")"
  if [[ "$actual" != "$expected" ]]; then
    echo "deploy: profiles/tabulate-365/base on $1 digests to $actual, expected $expected (incomplete checkout? run runtime/python/prepare-profile.sh tabulate-365 locally and re-deploy)" >&2
    exit 1
  fi
}
write_env() { # ip remote-path (content on stdin)
  "${SSH[@]}" "root@$1" "umask 077 && install -d -m 0700 /etc/airlock && cat > $2.tmp && chmod 0600 $2.tmp && mv $2.tmp $2"
}

# --- 3. VM B: sandbox host --------------------------------------------------------------------------------------------
if [[ -z "$ONLY" || "$ONLY" == "sandbox" ]]; then
  log "== VM B airlock-sandbox $SANDBOX_IP (vpc $SANDBOX_VPC_IP)"
  if [[ $SKIP_HOST -ne 1 ]]; then
    "${SSH[@]}" "root@$SANDBOX_IP" "bash -s -- --control-vpc-ip $CONTROL_VPC_IP" < "$ROOT/deploy/host/sandbox-host.sh"
  fi
  sync_tree "$SANDBOX_IP" airlock-supervisor
  log "bun install (VM B)"
  "${SSH[@]}" "root@$SANDBOX_IP" "cd /opt/airlock/app && sudo -u airlock-supervisor -H /usr/local/bin/bun install --frozen-lockfile"
  log "building the runtime image on VM B (runtime/python/build.sh tabulate-365)"
  "${SSH[@]}" "root@$SANDBOX_IP" "cd /opt/airlock/app && PATH=/usr/local/bin:\$PATH runtime/python/build.sh tabulate-365 && chown -R airlock-supervisor:airlock-supervisor /opt/airlock/app"
  log "writing /etc/airlock/supervisor.env (root, 0600)"
  write_env "$SANDBOX_IP" /etc/airlock/supervisor.env <<EOF
PORT=4300
SUPERVISOR_BIND=$SANDBOX_VPC_IP
SUPERVISOR_TOKEN=$SUPERVISOR_TOKEN
AIRLOCK_RUNTIME=${AIRLOCK_RUNTIME:-kata}
AIRLOCK_DOCKER_RUNTIME_NAME=${AIRLOCK_DOCKER_RUNTIME_NAME:-}
AIRLOCK_DATA_DIR=/var/lib/airlock/supervisor
AIRLOCK_PROFILES_DIR=/opt/airlock/app/profiles
AIRLOCK_NAMESPACE=airlock
EOF
  "${SSH[@]}" "root@$SANDBOX_IP" "systemctl daemon-reload && systemctl restart airlock-supervisor.service"
  log "waiting for the supervisor on http://$SANDBOX_VPC_IP:4300/health (VPC only)"
  for i in $(seq 1 40); do
    if HEALTH="$("${SSH[@]}" "root@$SANDBOX_IP" "curl -fsS -m 5 http://$SANDBOX_VPC_IP:4300/health" 2>/dev/null)"; then break; fi
    sleep 3
    HEALTH=""
  done
  if [[ -z "$HEALTH" ]]; then
    echo "deploy: supervisor did not become healthy; journal:" >&2
    "${SSH[@]}" "root@$SANDBOX_IP" "journalctl -u airlock-supervisor -n 40 --no-pager" >&2 || true
    exit 1
  fi
  log "supervisor health: $(jq -c '{status, host: {selectedRuntime: .host.selectedRuntime, devUnsafe: .host.devUnsafe, kvmPresent: .host.kvmPresent, kvmReadWrite: .host.kvmReadWrite, availableRuntimes: .host.availableRuntimes}}' <<<"$HEALTH")"
fi

# --- 4. VM A: control plane ------------------------------------------------------------------------------------------------
if [[ -z "$ONLY" || "$ONLY" == "control" ]]; then
  log "== VM A airlock-control $CONTROL_IP (vpc $CONTROL_VPC_IP) https://$PUBLIC_HOST"
  if [[ $SKIP_HOST -ne 1 ]]; then
    "${SSH[@]}" "root@$CONTROL_IP" "bash -s -- --public-host $PUBLIC_HOST" < "$ROOT/deploy/host/control-host.sh"
  fi
  sync_tree "$CONTROL_IP" airlock
  log "bun install + web build (VM A)"
  "${SSH[@]}" "root@$CONTROL_IP" "cd /opt/airlock/app && sudo -u airlock -H /usr/local/bin/bun install --frozen-lockfile && sudo -u airlock -H /usr/local/bin/bun run --cwd apps/web build >/dev/null && test -f apps/web/dist/index.html"
  if [[ "$DRIVER" == "scripted" ]]; then
    DRIVER_VALUE="scripted:/opt/airlock/app/apps/control/test/fixtures/scripted"
  else
    DRIVER_VALUE="vultr"
  fi
  log "writing /etc/airlock/control.env (root, 0600; driver=$DRIVER_VALUE model=$MODEL)"
  write_env "$CONTROL_IP" /etc/airlock/control.env <<EOF
PORT=3000
CONTROL_BIND=127.0.0.1
AIRLOCK_TRUST_PROXY=1
AIRLOCK_DATA_DIR=/var/lib/airlock/control
AIRLOCK_PROFILES_DIR=/opt/airlock/app/profiles
AIRLOCK_RUNTIME_DIR=/opt/airlock/app/runtime/python
AIRLOCK_WEB_DIST=/opt/airlock/app/apps/web/dist
SUPERVISOR_URL=http://$SANDBOX_VPC_IP:4300
SUPERVISOR_TOKEN=$SUPERVISOR_TOKEN
AIRLOCK_MODEL_DRIVER=$DRIVER_VALUE
VULTR_INFERENCE_API_KEY=$INFERENCE_KEY
AIRLOCK_MODEL=$MODEL
AIRLOCK_MODEL_MAX_TOKENS=${AIRLOCK_MODEL_MAX_TOKENS:-16384}
AIRLOCK_MODEL_REASONING_EFFORT=${AIRLOCK_MODEL_REASONING_EFFORT:-}
AIRLOCK_OPERATOR_PASSWORD=$OPERATOR_PASSWORD
AIRLOCK_JUDGE_PASSWORD=$JUDGE_PASSWORD
EOF
  "${SSH[@]}" "root@$CONTROL_IP" "systemctl daemon-reload && systemctl restart airlock-control.service"
  log "waiting for the control plane on 127.0.0.1:3000"
  READY=0
  for i in $(seq 1 40); do
    if "${SSH[@]}" "root@$CONTROL_IP" "curl -fsS -m 5 -o /dev/null http://127.0.0.1:3000/api/session" 2>/dev/null; then READY=1; break; fi
    sleep 3
  done
  if [[ $READY -ne 1 ]]; then
    echo "deploy: control plane did not become ready; journal:" >&2
    "${SSH[@]}" "root@$CONTROL_IP" "journalctl -u airlock-control -n 40 --no-pager" >&2 || true
    exit 1
  fi
  log "waiting for https://$PUBLIC_HOST (certificate issuance can take a minute)"
  READY=0
  for i in $(seq 1 60); do
    if curl -fsS -m 10 -o /dev/null "https://$PUBLIC_HOST/api/session" 2>/dev/null; then READY=1; break; fi
    sleep 5
  done
  if [[ $READY -ne 1 ]]; then
    echo "deploy: https://$PUBLIC_HOST is not answering; caddy journal:" >&2
    "${SSH[@]}" "root@$CONTROL_IP" "journalctl -u caddy -n 30 --no-pager" >&2 || true
    exit 1
  fi
  log "control plane host view: $(curl -fsS -m 10 "https://$PUBLIC_HOST/api/host" | jq -c '{selectedRuntime, devUnsafe, kvmPresent, availableRuntimes}')"
fi

echo
echo "Airlock is deployed."
echo "  public URL        https://$PUBLIC_HOST"
echo "  model driver      ${DRIVER_VALUE:-unchanged} ${MODEL:+(model $MODEL)}"
echo "  passwords         $SECRETS  (AIRLOCK_OPERATOR_PASSWORD, AIRLOCK_JUDGE_PASSWORD; judge = hostile panel + preview)"
echo "  supervisor        http://$SANDBOX_VPC_IP:4300 (VPC only; VM B has no public listener)"
echo "  ssh               root@$CONTROL_IP (VM A)   root@$SANDBOX_IP (VM B)   key $SSH_KEY_FILE"
echo "  log               $LOG"
