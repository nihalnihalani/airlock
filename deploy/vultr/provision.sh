#!/usr/bin/env bash
# Airlock: provision the two-VM Vultr topology (deploy/README.md) through the Vultr API v2.
#
#   deploy/vultr/provision.sh            create or adopt everything, wait for SSH, write data/deploy/state.json
#   deploy/vultr/provision.sh --plan     print what would be created and exit
#
# Creates, idempotently (each resource is looked up by description/label+tag before it is created):
#   - VPC            "airlock-vpc"       in $REGION (default atl, where the inference models are served)
#   - firewall group "airlock-control"   inbound: 22/tcp from this machine's public IP, 80+443/tcp from anywhere
#   - firewall group "airlock-sandbox"   inbound: 22/tcp from this machine's public IP, nothing else
#   - instance       "airlock-control"   $PLAN_CONTROL (default vhp-2c-4gb-amd, fallback vc2-2c-4gb), Ubuntu 24.04, VPC member
#   - instance       "airlock-sandbox"   $PLAN_SANDBOX (default vx1-g-4c-16g-240s: KVM exposed), Ubuntu 24.04, VPC member
# Both instances get the SSH key named $SSHKEY_NAME (default airlock-hackathon), tag "airlock", backups disabled
# and NO user_data: nothing is configured through cloud-init; every setup step runs over SSH afterwards
# (deploy/deploy.sh), so no secret ever reaches the Vultr metadata service (CLAUDE.md §3.7).
#
# Inputs: VULTR_API_KEY from the environment or from $AIRLOCK_ENV_FILE (default <repo>/.env). Never printed.
# Output: data/deploy/state.json (gitignored) with ids, plans, public IPs and VPC IPs. Costs: see deploy/README.md.
# Requires: curl, jq, ssh. Exit codes: 0 ok, 1 environment, 2 API error, 3 timeout.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STATE_DIR="$ROOT/data/deploy"
STATE="$STATE_DIR/state.json"
API="https://api.vultr.com/v2"

REGION="${AIRLOCK_REGION:-atl}"
PLAN_CONTROL="${AIRLOCK_PLAN_CONTROL:-vhp-2c-4gb-amd}"
PLAN_CONTROL_FALLBACK="${AIRLOCK_PLAN_CONTROL_FALLBACK:-vc2-2c-4gb}"
PLAN_SANDBOX="${AIRLOCK_PLAN_SANDBOX:-vx1-g-4c-16g-240s}"
OS_ID="${AIRLOCK_OS_ID:-2284}"                      # Ubuntu 24.04 LTS x64 (GET /v2/os)
SSHKEY_NAME="${AIRLOCK_SSHKEY_NAME:-airlock-hackathon}"
SSH_KEY_FILE="${AIRLOCK_SSH_KEY:-$HOME/.ssh/airlock_ed25519}"
TAG="airlock"
PLAN_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --plan) PLAN_ONLY=1 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 1 ;;
  esac
done

for tool in curl jq ssh; do command -v "$tool" >/dev/null || { echo "provision: $tool is required" >&2; exit 1; }; done

# --- API key (never echoed) --------------------------------------------------------------------
ENV_FILE="${AIRLOCK_ENV_FILE:-$ROOT/.env}"
if [[ -z "${VULTR_API_KEY:-}" && -f "$ENV_FILE" ]]; then
  VULTR_API_KEY="$(grep -E '^VULTR_API_KEY=' "$ENV_FILE" | head -n1 | cut -d= -f2- | tr -d '"'"'"' \r')"
fi
[[ -n "${VULTR_API_KEY:-}" ]] || { echo "provision: VULTR_API_KEY is not set (environment or $ENV_FILE)" >&2; exit 1; }
[[ -f "$SSH_KEY_FILE" ]] || { echo "provision: SSH private key $SSH_KEY_FILE not found" >&2; exit 1; }

api() { # method path [json]; retries transient failures (5xx, 429, network) up to 8 times.
  local method="$1" path="$2" body="${3:-}" out code attempt
  for ((attempt = 1; attempt <= 8; attempt++)); do
    if [[ -n "$body" ]]; then
      out="$(curl -sS -w '\n%{http_code}' -X "$method" "$API$path" -H "Authorization: Bearer $VULTR_API_KEY" -H 'Content-Type: application/json' -d "$body" 2>/dev/null || echo $'\n000')"
    else
      out="$(curl -sS -w '\n%{http_code}' -X "$method" "$API$path" -H "Authorization: Bearer $VULTR_API_KEY" 2>/dev/null || echo $'\n000')"
    fi
    code="${out##*$'\n'}"
    out="${out%$'\n'*}"
    if [[ "$code" -ge 200 && "$code" -lt 300 ]]; then printf '%s' "$out"; return 0; fi
    if [[ "$code" == "000" || "$code" == "429" || "$code" -ge 500 ]]; then
      echo "provision: $method $path -> HTTP $code (attempt $attempt/8, retrying): ${out:0:160}" >&2
      sleep $((attempt * 5))
      continue
    fi
    echo "provision: $method $path -> HTTP $code: $out" >&2
    return 2
  done
  echo "provision: $method $path failed after 8 attempts" >&2
  return 2
}
require_id() { # value what
  [[ "$1" =~ ^[0-9a-f-]{36}$ ]] || { echo "provision: $2 did not return an id ($1)" >&2; exit 2; }
}

# --- this machine's public IP(s): SSH is admitted from these only --------------------------------
# A NATed uplink can hand out more than one egress address (observed: two, alternating per flow), so
# several reflectors are sampled a few times and every distinct answer gets a /32 rule. Override with
# AIRLOCK_ADMIN_IPS="a.b.c.d,e.f.g.h".
if [[ -n "${AIRLOCK_ADMIN_IPS:-}" ]]; then
  ADMIN_IPS="$(tr ',' '\n' <<<"$AIRLOCK_ADMIN_IPS" | sed '/^$/d' | sort -u)"
else
  ADMIN_IPS="$(for i in 1 2 3; do
    curl -fsS -4 --max-time 5 https://api.ipify.org; echo
    curl -fsS -4 --max-time 5 https://checkip.amazonaws.com
    curl -fsS -4 --max-time 5 https://ifconfig.me; echo
  done 2>/dev/null | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | sort -u)"
fi
[[ -n "$ADMIN_IPS" ]] || { echo "provision: could not determine this machine's public IPv4 addresses" >&2; exit 1; }
MY_IP="$(head -n1 <<<"$ADMIN_IPS")"

# --- plan availability ---------------------------------------------------------------------------
PLANS="$(api GET "/plans?per_page=500")"
plan_in_region() { jq -e --arg p "$1" --arg r "$REGION" '.plans[] | select(.id==$p) | .locations | index($r) != null' <<<"$PLANS" >/dev/null 2>&1; }
plan_cost() { jq -r --arg p "$1" '.plans[] | select(.id==$p) | .hourly_cost' <<<"$PLANS"; }
if ! plan_in_region "$PLAN_CONTROL"; then
  echo "provision: $PLAN_CONTROL is not offered in $REGION; falling back to $PLAN_CONTROL_FALLBACK" >&2
  PLAN_CONTROL="$PLAN_CONTROL_FALLBACK"
  plan_in_region "$PLAN_CONTROL" || { echo "provision: $PLAN_CONTROL is not offered in $REGION either" >&2; exit 2; }
fi
plan_in_region "$PLAN_SANDBOX" || { echo "provision: $PLAN_SANDBOX is not offered in $REGION" >&2; exit 2; }

SSHKEY_ID="$(api GET /ssh-keys | jq -r --arg n "$SSHKEY_NAME" '.ssh_keys[] | select(.name==$n) | .id' | head -n1)"
[[ -n "$SSHKEY_ID" ]] || { echo "provision: no SSH key named '$SSHKEY_NAME' in the account (register ~/.ssh/airlock_ed25519.pub first)" >&2; exit 2; }

echo "provision: region=$REGION control=$PLAN_CONTROL (\$$(plan_cost "$PLAN_CONTROL")/h) sandbox=$PLAN_SANDBOX (\$$(plan_cost "$PLAN_SANDBOX")/h) os=$OS_ID sshkey=$SSHKEY_NAME admin-ips=$(tr '\n' ',' <<<"$ADMIN_IPS" | sed 's/,$//')"
if [[ $PLAN_ONLY -eq 1 ]]; then exit 0; fi
mkdir -p "$STATE_DIR"

# --- VPC ------------------------------------------------------------------------------------------
VPC_ID="$(api GET "/vpcs?per_page=500" | jq -r --arg r "$REGION" '.vpcs[] | select(.description=="airlock-vpc" and .region==$r) | .id' | head -n1)"
if [[ -z "$VPC_ID" ]]; then
  VPC_ID="$(api POST /vpcs "$(jq -nc --arg r "$REGION" '{region:$r, description:"airlock-vpc"}')" | jq -r .vpc.id)"
  require_id "$VPC_ID" "POST /vpcs"
  echo "provision: created VPC $VPC_ID"
else
  echo "provision: VPC $VPC_ID exists"
fi
VPC_SUBNET="$(api GET "/vpcs/$VPC_ID" | jq -r '.vpc.v4_subnet + "/" + (.vpc.v4_subnet_mask|tostring)')"

# --- firewall groups ---------------------------------------------------------------------------------
ensure_group() { # description -> id
  local id
  id="$(api GET "/firewalls?per_page=500" | jq -r --arg d "$1" '.firewall_groups[] | select(.description==$d) | .id' | head -n1)"
  if [[ -z "$id" ]]; then
    id="$(api POST /firewalls "$(jq -nc --arg d "$1" '{description:$d}')" | jq -r .firewall_group.id)"
    require_id "$id" "POST /firewalls ($1)"
    echo "provision: created firewall group $1 ($id)" >&2
  else
    echo "provision: firewall group $1 ($id) exists" >&2
  fi
  printf '%s' "$id"
}
ensure_rule() { # group-id subnet subnet_size port notes
  local gid="$1" subnet="$2" size="$3" port="$4" notes="$5" rules
  rules="$(api GET "/firewalls/$gid/rules?per_page=500")"
  if jq -e --arg s "$subnet" --argjson z "$size" --arg p "$port" '.firewall_rules[] | select(.ip_type=="v4" and .protocol=="tcp" and .subnet==$s and .subnet_size==$z and .port==$p)' <<<"$rules" >/dev/null; then
    return 0
  fi
  api POST "/firewalls/$gid/rules" "$(jq -nc --arg s "$subnet" --argjson z "$size" --arg p "$port" --arg n "$notes" '{ip_type:"v4", protocol:"tcp", subnet:$s, subnet_size:$z, port:$p, notes:$n}')" >/dev/null
  echo "provision: rule $notes: tcp $port from $subnet/$size" >&2
}
prune_ssh_rules() { # group-id: remove 22/tcp rules whose source is not one of the current admin IPs (they changed)
  local gid="$1" rules
  rules="$(api GET "/firewalls/$gid/rules?per_page=500")"
  for rid in $(jq -r --arg s "$ADMIN_IPS" '($s | split("\n")) as $keep | .firewall_rules[] | select(.protocol=="tcp" and .port=="22" and (.subnet as $x | $keep | index($x) | not)) | .id' <<<"$rules"); do
    api DELETE "/firewalls/$gid/rules/$rid" >/dev/null && echo "provision: removed stale SSH rule $rid" >&2
  done
}
FW_CONTROL="$(ensure_group airlock-control)"
for ip in $ADMIN_IPS; do ensure_rule "$FW_CONTROL" "$ip" 32 22 "ssh from the deploying machine"; done
ensure_rule "$FW_CONTROL" 0.0.0.0 0 80 "http (ACME + redirect)"
ensure_rule "$FW_CONTROL" 0.0.0.0 0 443 "https public UI"
prune_ssh_rules "$FW_CONTROL"
FW_SANDBOX="$(ensure_group airlock-sandbox)"
for ip in $ADMIN_IPS; do ensure_rule "$FW_SANDBOX" "$ip" 32 22 "ssh from the deploying machine"; done
prune_ssh_rules "$FW_SANDBOX"

# --- instances ------------------------------------------------------------------------------------------
ensure_instance() { # label plan firewall-group-id -> id
  local label="$1" plan="$2" fw="$3" id
  id="$(api GET "/instances?per_page=500&tag=$TAG" | jq -r --arg l "$label" '.instances[] | select(.label==$l) | .id' | head -n1)"
  if [[ -z "$id" ]]; then
    id="$(api POST /instances "$(jq -nc --arg r "$REGION" --arg p "$plan" --argjson os "$OS_ID" --arg l "$label" --arg k "$SSHKEY_ID" --arg fw "$fw" --arg vpc "$VPC_ID" --arg t "$TAG" \
      '{region:$r, plan:$p, os_id:$os, label:$l, hostname:$l, tags:[$t], sshkey_id:[$k], firewall_group_id:$fw, attach_vpc:[$vpc], backups:"disabled", activation_email:false, enable_ipv6:false}')" \
      | jq -r .instance.id)"
    require_id "$id" "POST /instances ($label)"
    echo "provision: created instance $label ($plan) $id" >&2
  else
    echo "provision: instance $label ($id) exists" >&2
  fi
  printf '%s' "$id"
}
CONTROL_ID="$(ensure_instance airlock-control "$PLAN_CONTROL" "$FW_CONTROL")"
SANDBOX_ID="$(ensure_instance airlock-sandbox "$PLAN_SANDBOX" "$FW_SANDBOX")"

wait_active() { # id label
  local i inst status
  for ((i = 0; i < 120; i++)); do
    inst="$(api GET "/instances/$1")"
    status="$(jq -r '.instance.status + "/" + .instance.server_status + "/" + .instance.power_status' <<<"$inst")"
    if [[ "$status" == "active/ok/running" ]]; then printf '%s' "$inst"; return 0; fi
    sleep 5
  done
  echo "provision: $2 did not become active/ok within 10 minutes (last: $status)" >&2
  return 3
}
CONTROL_INST="$(wait_active "$CONTROL_ID" airlock-control)"
SANDBOX_INST="$(wait_active "$SANDBOX_ID" airlock-sandbox)"
CONTROL_IP="$(jq -r .instance.main_ip <<<"$CONTROL_INST")"
SANDBOX_IP="$(jq -r .instance.main_ip <<<"$SANDBOX_INST")"
# Record the plan each instance actually runs on (an adopted instance may predate a plan fallback).
PLAN_CONTROL="$(jq -r .instance.plan <<<"$CONTROL_INST")"
PLAN_SANDBOX="$(jq -r .instance.plan <<<"$SANDBOX_INST")"

vpc_ip() { # instance-id
  local i ip
  for ((i = 0; i < 60; i++)); do
    ip="$(api GET "/instances/$1/vpcs" | jq -r --arg v "$VPC_ID" '.vpcs[] | select(.id==$v) | .ip_address' | head -n1)"
    if [[ -n "$ip" && "$ip" != "null" ]]; then printf '%s' "$ip"; return 0; fi
    sleep 5
  done
  return 3
}
CONTROL_VPC_IP="$(vpc_ip "$CONTROL_ID")" || { echo "provision: airlock-control has no VPC address" >&2; exit 3; }
SANDBOX_VPC_IP="$(vpc_ip "$SANDBOX_ID")" || { echo "provision: airlock-sandbox has no VPC address" >&2; exit 3; }

wait_ssh() { # ip label
  local i
  for ((i = 0; i < 60; i++)); do
    if ssh -i "$SSH_KEY_FILE" -o BatchMode=yes -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new "root@$1" true 2>/dev/null; then return 0; fi
    sleep 5
  done
  echo "provision: SSH to $2 ($1) did not come up within 5 minutes" >&2
  return 3
}
wait_ssh "$CONTROL_IP" airlock-control
wait_ssh "$SANDBOX_IP" airlock-sandbox

PUBLIC_HOST="$(tr . - <<<"$CONTROL_IP").sslip.io"
umask 077
jq -n \
  --arg region "$REGION" --arg vpcId "$VPC_ID" --arg vpcSubnet "$VPC_SUBNET" --arg adminIp "$(tr '\n' ',' <<<"$ADMIN_IPS" | sed 's/,$//')" --arg sshKeyId "$SSHKEY_ID" --arg sshKeyFile "$SSH_KEY_FILE" \
  --arg fwControl "$FW_CONTROL" --arg fwSandbox "$FW_SANDBOX" \
  --arg cId "$CONTROL_ID" --arg cPlan "$PLAN_CONTROL" --arg cIp "$CONTROL_IP" --arg cVpc "$CONTROL_VPC_IP" --arg cCost "$(plan_cost "$PLAN_CONTROL")" \
  --arg sId "$SANDBOX_ID" --arg sPlan "$PLAN_SANDBOX" --arg sIp "$SANDBOX_IP" --arg sVpc "$SANDBOX_VPC_IP" --arg sCost "$(plan_cost "$PLAN_SANDBOX")" \
  --arg host "$PUBLIC_HOST" --arg osId "$OS_ID" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '{provisionedAt:$at, region:$region, osId:($osId|tonumber), adminIps:($adminIp|split(",")), sshKeyId:$sshKeyId, sshKeyFile:$sshKeyFile,
    vpc:{id:$vpcId, subnet:$vpcSubnet},
    firewallGroups:{control:$fwControl, sandbox:$fwSandbox},
    control:{id:$cId, label:"airlock-control", plan:$cPlan, hourlyCost:($cCost|tonumber), publicIp:$cIp, vpcIp:$cVpc},
    sandbox:{id:$sId, label:"airlock-sandbox", plan:$sPlan, hourlyCost:($sCost|tonumber), publicIp:$sIp, vpcIp:$sVpc},
    publicHost:$host, publicUrl:("https://" + $host)}' > "$STATE"
echo "provision: wrote $STATE"
jq . "$STATE"
