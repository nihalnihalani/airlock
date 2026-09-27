#!/usr/bin/env bash
# Airlock: destroy exactly what deploy/vultr/provision.sh recorded in data/deploy/state.json.
#
#   deploy/vultr/destroy.sh          list the resources, ask for confirmation, delete them
#   deploy/vultr/destroy.sh --yes    no confirmation prompt
#
# Order: instances (waits until they are gone) → firewall groups → VPC. Nothing outside state.json
# is touched. state.json is renamed to state.destroyed-<ts>.json afterwards; data/deploy/secrets.env
# is kept (it holds no cloud resource; delete it yourself if the passwords must not survive).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STATE="$ROOT/data/deploy/state.json"
API="https://api.vultr.com/v2"
YES=0
for arg in "$@"; do
  case "$arg" in
    --yes|-y) YES=1 ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 1 ;;
  esac
done
for tool in curl jq; do command -v "$tool" >/dev/null || { echo "destroy: $tool is required" >&2; exit 1; }; done
[[ -f "$STATE" ]] || { echo "destroy: $STATE not found; nothing to destroy" >&2; exit 1; }

ENV_FILE="${AIRLOCK_ENV_FILE:-$ROOT/.env}"
if [[ -z "${VULTR_API_KEY:-}" && -f "$ENV_FILE" ]]; then
  VULTR_API_KEY="$(grep -E '^VULTR_API_KEY=' "$ENV_FILE" | head -n1 | cut -d= -f2- | tr -d '"'"'"' \r')"
fi
[[ -n "${VULTR_API_KEY:-}" ]] || { echo "destroy: VULTR_API_KEY is not set (environment or $ENV_FILE)" >&2; exit 1; }

api() { # method path -> body; prints HTTP code on stderr for non-2xx; retries transient failures
  local method="$1" path="$2" out code attempt
  for ((attempt = 1; attempt <= 8; attempt++)); do
    out="$(curl -sS -w '\n%{http_code}' -X "$method" "$API$path" -H "Authorization: Bearer $VULTR_API_KEY" 2>/dev/null || echo $'\n000')"
    code="${out##*$'\n'}"; out="${out%$'\n'*}"
    if [[ "$code" -ge 200 && "$code" -lt 300 ]]; then printf '%s' "$out"; return 0; fi
    if [[ "$code" == "404" ]]; then return 4; fi
    if [[ "$code" == "000" || "$code" == "429" || "$code" -ge 500 ]]; then sleep $((attempt * 5)); continue; fi
    echo "destroy: $method $path -> HTTP $code: $out" >&2
    return 2
  done
  return 2
}

CONTROL_ID="$(jq -r .control.id "$STATE")"
SANDBOX_ID="$(jq -r .sandbox.id "$STATE")"
FW_CONTROL="$(jq -r .firewallGroups.control "$STATE")"
FW_SANDBOX="$(jq -r .firewallGroups.sandbox "$STATE")"
VPC_ID="$(jq -r .vpc.id "$STATE")"

echo "destroy: will delete"
echo "  instance airlock-control  $CONTROL_ID  ($(jq -r '.control.plan + " " + .control.publicIp' "$STATE"))"
echo "  instance airlock-sandbox  $SANDBOX_ID  ($(jq -r '.sandbox.plan + " " + .sandbox.publicIp' "$STATE"))"
echo "  firewall group airlock-control  $FW_CONTROL"
echo "  firewall group airlock-sandbox  $FW_SANDBOX"
echo "  vpc airlock-vpc  $VPC_ID"
if [[ $YES -ne 1 ]]; then
  read -r -p "Type 'destroy' to continue: " answer
  [[ "$answer" == "destroy" ]] || { echo "destroy: aborted"; exit 1; }
fi

for id in "$CONTROL_ID" "$SANDBOX_ID"; do
  [[ -n "$id" && "$id" != "null" ]] || continue
  if api DELETE "/instances/$id" >/dev/null; then echo "destroy: instance $id deletion requested"
  else echo "destroy: instance $id already gone or refused"; fi
done
for id in "$CONTROL_ID" "$SANDBOX_ID"; do
  [[ -n "$id" && "$id" != "null" ]] || continue
  for ((i = 0; i < 60; i++)); do
    if ! api GET "/instances/$id" >/dev/null 2>&1; then break; fi
    sleep 5
  done
done
for id in "$FW_CONTROL" "$FW_SANDBOX"; do
  [[ -n "$id" && "$id" != "null" ]] || continue
  for ((i = 0; i < 12; i++)); do
    if api DELETE "/firewalls/$id" >/dev/null 2>&1; then echo "destroy: firewall group $id deleted"; break; fi
    sleep 5
  done
done
if [[ -n "$VPC_ID" && "$VPC_ID" != "null" ]]; then
  for ((i = 0; i < 12; i++)); do
    if api DELETE "/vpcs/$VPC_ID" >/dev/null 2>&1; then echo "destroy: vpc $VPC_ID deleted"; break; fi
    sleep 5
  done
fi
mv "$STATE" "$ROOT/data/deploy/state.destroyed-$(date -u +%Y%m%dT%H%M%SZ).json"
echo "destroy: done; remaining instances tagged airlock: $(api GET '/instances?tag=airlock' | jq -r '[.instances[].id] | length')"
