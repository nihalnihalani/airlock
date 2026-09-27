#!/usr/bin/env bash
# Airlock browser plane: host-level network enforcement (research/40 §3 "proxy-only egress enforced
# outside the task container"; doc 42 C8). Installed and run by deploy/host/sandbox-host.sh as the
# oneshot unit airlock-egress-guard.service (after docker.service, and again on every deploy).
#
#   airlock-egress-guard.sh             apply (idempotent: our chains are flushed and rebuilt)
#   airlock-egress-guard.sh --dry-run   print the iptables/ip6tables commands, change nothing
#   airlock-egress-guard.sh --remove    remove the chains and their jumps
#
# The supervisor names every per-attempt bridge with a fixed prefix (apps/supervisor/src/names.ts):
#   ali<12 hex>  the --internal network (browser <-> its egress proxy only)
#   ale<12 hex>  the egress network (proxy -> internet)
# Rules (IPv4):
#   DOCKER-USER -> AIRLOCK-FWD (FORWARD path, i.e. traffic leaving a container for another host):
#     from ale+ : drop 169.254.0.0/16 (cloud metadata), RFC 1918, 100.64.0.0/10, loopback, 0/8,
#                 multicast and reserved space: the proxy reaches only public addresses (its own
#                 per-request DNS-pinned public-IP check stays as defense in depth). Private
#                 resolvers from the host's resolv.conf are allowed on port 53 only.
#     from ali+ : drop anything not staying on an ali+ bridge; nothing may be forwarded INTO ali+.
#                 (Docker's --internal already does this; this is the belt to its braces.)
#   INPUT -> AIRLOCK-IN (traffic addressed to this host itself: sshd, the supervisor on the VPC
#     address, the bridge gateway addresses): drop everything arriving on ale+ or ali+.
# Rules (IPv6): the per-attempt networks are created with IPv6 disabled; anything on ale+/ali+ is
#   dropped in FORWARD and INPUT regardless.
# Cross-attempt isolation: each attempt has its own bridges; Docker's DOCKER-ISOLATION chains drop
#   bridge-to-bridge forwarding, and the RFC 1918 drop above covers other attempts' subnets.
#
# STATUS: dry-run checked by apps/supervisor/test/egress-guard.test.ts. NOT yet verified on the
# Vultr VX1 host (iptables-nft backend, ufw active, Kata/runsc networking); verify with
# `iptables -S AIRLOCK-FWD`, `iptables -S AIRLOCK-IN` and the browser integration test there.
set -euo pipefail

MODE=apply
case "${1:-}" in
  "") ;;
  --dry-run) MODE=dry ;;
  --remove) MODE=remove ;;
  *) echo "airlock-egress-guard: unknown argument $1" >&2; exit 2 ;;
esac
IPT="${AIRLOCK_GUARD_IPTABLES:-iptables}"
IP6T="${AIRLOCK_GUARD_IP6TABLES:-ip6tables}"
RESOLV="${AIRLOCK_GUARD_RESOLV:-}"
if [[ -z "$RESOLV" ]]; then
  if [[ -f /run/systemd/resolve/resolv.conf ]]; then RESOLV=/run/systemd/resolve/resolv.conf; else RESOLV=/etc/resolv.conf; fi
fi

run() {
  if [[ "$MODE" == dry ]]; then echo "$*"; else "$@"; fi
}
# `-C` probes are skipped in dry-run (they would need root); the add is printed instead.
ensure_jump() { # tool chain target position
  if [[ "$MODE" == dry ]]; then echo "$1 -I $2 $4 -j $3"; return; fi
  "$1" -C "$2" -j "$3" 2>/dev/null || "$1" -I "$2" "$4" -j "$3"
}
reset_chain() { # tool chain
  if [[ "$MODE" == dry ]]; then echo "$1 -N $2"; echo "$1 -F $2"; return; fi
  "$1" -N "$2" 2>/dev/null || true
  "$1" -F "$2"
}
drop_chain() { # tool parent chain
  if [[ "$MODE" == dry ]]; then echo "$1 -D $2 -j $3"; echo "$1 -F $3"; echo "$1 -X $3"; return; fi
  while "$1" -D "$2" -j "$3" 2>/dev/null; do :; done
  "$1" -F "$3" 2>/dev/null || true
  "$1" -X "$3" 2>/dev/null || true
}

if [[ "$MODE" == remove ]]; then
  drop_chain "$IPT" DOCKER-USER AIRLOCK-FWD
  drop_chain "$IPT" INPUT AIRLOCK-IN
  drop_chain "$IP6T" FORWARD AIRLOCK-FWD6
  drop_chain "$IP6T" INPUT AIRLOCK-IN6
  exit 0
fi

PRIVATE_V4=(169.254.0.0/16 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 127.0.0.0/8 0.0.0.0/8 192.0.0.0/24 198.18.0.0/15 224.0.0.0/4 240.0.0.0/4)

is_private_v4() {
  local a b
  IFS=. read -r a b _ _ <<<"$1"
  [[ "$a" == 10 || "$a" == 127 || ( "$a" == 172 && "$b" -ge 16 && "$b" -le 31 ) || ( "$a" == 192 && "$b" == 168 ) || ( "$a" == 100 && "$b" -ge 64 && "$b" -le 127 ) || ( "$a" == 169 && "$b" == 254 ) ]]
}

# --- IPv4 FORWARD (via DOCKER-USER, which Docker evaluates first and never flushes) ---------------------
if [[ "$MODE" == apply ]] && ! "$IPT" -S DOCKER-USER >/dev/null 2>&1; then
  "$IPT" -N DOCKER-USER
  "$IPT" -C FORWARD -j DOCKER-USER 2>/dev/null || "$IPT" -I FORWARD 1 -j DOCKER-USER
fi
reset_chain "$IPT" AIRLOCK-FWD
# DNS to a private upstream resolver (the host's own resolv.conf), port 53 only, before the drops.
if [[ -r "$RESOLV" ]]; then
  while read -r key ns _; do
    [[ "$key" == nameserver && "$ns" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || continue
    if is_private_v4 "$ns" && [[ "$ns" != 127.* ]]; then
      run "$IPT" -A AIRLOCK-FWD -i ale+ -d "$ns" -p udp --dport 53 -j RETURN
      run "$IPT" -A AIRLOCK-FWD -i ale+ -d "$ns" -p tcp --dport 53 -j RETURN
    fi
  done <"$RESOLV"
fi
for net in "${PRIVATE_V4[@]}"; do
  run "$IPT" -A AIRLOCK-FWD -i ale+ -d "$net" -j DROP
done
run "$IPT" -A AIRLOCK-FWD -i ali+ ! -o ali+ -j DROP
run "$IPT" -A AIRLOCK-FWD -o ali+ ! -i ali+ -j DROP
run "$IPT" -A AIRLOCK-FWD -j RETURN
ensure_jump "$IPT" DOCKER-USER AIRLOCK-FWD 1

# --- IPv4 INPUT: nothing on a per-attempt bridge may reach the host itself --------------------------------
reset_chain "$IPT" AIRLOCK-IN
run "$IPT" -A AIRLOCK-IN -i ale+ -j DROP
run "$IPT" -A AIRLOCK-IN -i ali+ -j DROP
run "$IPT" -A AIRLOCK-IN -j RETURN
ensure_jump "$IPT" INPUT AIRLOCK-IN 1

# --- IPv6: the networks have IPv6 disabled; drop regardless -------------------------------------------------
if [[ "$MODE" == dry ]] || command -v "$IP6T" >/dev/null 2>&1; then
  reset_chain "$IP6T" AIRLOCK-FWD6
  run "$IP6T" -A AIRLOCK-FWD6 -i ale+ -j DROP
  run "$IP6T" -A AIRLOCK-FWD6 -o ale+ -j DROP
  run "$IP6T" -A AIRLOCK-FWD6 -i ali+ -j DROP
  run "$IP6T" -A AIRLOCK-FWD6 -o ali+ -j DROP
  run "$IP6T" -A AIRLOCK-FWD6 -j RETURN
  ensure_jump "$IP6T" FORWARD AIRLOCK-FWD6 1
  reset_chain "$IP6T" AIRLOCK-IN6
  run "$IP6T" -A AIRLOCK-IN6 -i ale+ -j DROP
  run "$IP6T" -A AIRLOCK-IN6 -i ali+ -j DROP
  run "$IP6T" -A AIRLOCK-IN6 -j RETURN
  ensure_jump "$IP6T" INPUT AIRLOCK-IN6 1
fi
[[ "$MODE" == dry ]] || echo "airlock-egress-guard: applied (AIRLOCK-FWD via DOCKER-USER, AIRLOCK-IN via INPUT, IPv6 drops)" >&2
