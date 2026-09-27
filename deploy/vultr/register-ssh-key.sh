#!/usr/bin/env bash
# Register this machine's Airlock SSH public key in the Vultr account, idempotently.
#
#   deploy/vultr/register-ssh-key.sh          uses ~/.ssh/airlock_ed25519.pub and the name airlock-hackathon
#
# Env: VULTR_API_KEY (environment or <repo>/.env; never printed), AIRLOCK_SSH_KEY (private key path,
# default ~/.ssh/airlock_ed25519; its .pub is registered), AIRLOCK_SSHKEY_NAME (default airlock-hackathon).
#
# - A key with this name and the same public key already registered: nothing to do.
# - A key with this name but a DIFFERENT public key: refuse (existing instances may depend on it);
#   pick another name with AIRLOCK_SSHKEY_NAME and pass the same variable to provision.sh.
# - Otherwise: create it. Prints the name, id and fingerprint only.
# A 401 "Unauthorized IP address" means the API key's access control list does not include this
# machine's address (Vultr dashboard: Account → API → Access Control; allow both IPv4 and IPv6).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
KEY_FILE="${AIRLOCK_SSH_KEY:-$HOME/.ssh/airlock_ed25519}"
NAME="${AIRLOCK_SSHKEY_NAME:-airlock-hackathon}"
if [[ -z "${VULTR_API_KEY:-}" && -f "$ROOT/.env" ]]; then
  VULTR_API_KEY="$(grep -E '^VULTR_API_KEY=' "$ROOT/.env" | head -n1 | cut -d= -f2- | sed -e 's/[[:space:]]#.*$//' -e "s/^[\"']//" -e "s/[\"']$//" | tr -d '\r ')"
fi
[[ -n "${VULTR_API_KEY:-}" ]] || { echo "register-ssh-key: VULTR_API_KEY is not set (environment or .env)" >&2; exit 2; }
[[ -f "$KEY_FILE.pub" ]] || { echo "register-ssh-key: $KEY_FILE.pub not found (ssh-keygen -t ed25519 -f $KEY_FILE)" >&2; exit 2; }
PUB="$(awk '{print $1" "$2}' "$KEY_FILE.pub")"
FPR="$(ssh-keygen -lf "$KEY_FILE.pub" | awk '{print $2}')"

api() { # method path [json]
  local out code
  out="$(mktemp)"
  code="$(curl -sS -o "$out" -w '%{http_code}' -m 30 -X "$1" -H "Authorization: Bearer $VULTR_API_KEY" \
    ${3:+-H 'Content-Type: application/json' --data "$3"} "https://api.vultr.com/v2$2")"
  if [[ "$code" -ge 300 ]]; then
    echo "register-ssh-key: $1 $2 → HTTP $code $(jq -r '.error // empty' "$out" 2>/dev/null | head -c 200)" >&2
    rm -f "$out"
    return 1
  fi
  cat "$out"
  rm -f "$out"
}

EXISTING="$(api GET '/ssh-keys?per_page=500')"
MATCH="$(jq -c --arg n "$NAME" '[.ssh_keys[] | select(.name==$n)] | first // empty' <<<"$EXISTING")"
if [[ -n "$MATCH" ]]; then
  REGISTERED="$(jq -r '.ssh_key' <<<"$MATCH" | awk '{print $1" "$2}')"
  if [[ "$REGISTERED" == "$PUB" ]]; then
    echo "register-ssh-key: '$NAME' already registered with this key ($(jq -r .id <<<"$MATCH"), $FPR)"
    exit 0
  fi
  echo "register-ssh-key: '$NAME' is already registered with a DIFFERENT public key; not replacing it." >&2
  echo "  Use another name: AIRLOCK_SSHKEY_NAME=airlock-$(hostname -s | tr '[:upper:]' '[:lower:]') $0  (and the same variable for provision.sh)" >&2
  exit 3
fi
CREATED="$(api POST /ssh-keys "$(jq -nc --arg n "$NAME" --arg k "$PUB" '{name:$n, ssh_key:$k}')")"
echo "register-ssh-key: registered '$NAME' as $(jq -r '.ssh_key.id' <<<"$CREATED") ($FPR)"
