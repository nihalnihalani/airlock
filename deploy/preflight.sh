#!/usr/bin/env bash
# Airlock deployment preflight: runs ON VM B over SSH and records what the sandbox host actually is.
#
#   deploy/preflight.sh            output on stdout and in data/deploy/preflight-<ts>.txt; exit 1 on any failed check
#
# What it records (CLAUDE.md §3.8, §3.9: inspected, never assumed):
#   - /dev/kvm presence and mode, CPU virtualization flags, host kernel
#   - Docker version and the runtimes the daemon lists
#   - `docker run --rm --runtime=<name> python:3.12-slim uname -r` for kata, runsc and runc: Kata must show a
#     guest kernel different from the host's; runsc shows gVisor's own kernel string; runc shows the host kernel
#   - the supervisor's /health host block and a real author sandbox + hostile run through the supervisor API
#     (deploy/preflight-api.ts): effective runtime name, guest uname, isolation probe all BLOCKED, metadata
#     endpoint unreachable from inside, teardown "(no sandboxes)"
#   - ufw: the supervisor port is reachable from the control plane's VPC address only; no public listener
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE="$ROOT/data/deploy/state.json"
[[ -f "$STATE" ]] || { echo "preflight: $STATE not found; provision and deploy first" >&2; exit 1; }
SANDBOX_IP="$(jq -r .sandbox.publicIp "$STATE")"
SANDBOX_VPC_IP="$(jq -r .sandbox.vpcIp "$STATE")"
CONTROL_VPC_IP="$(jq -r .control.vpcIp "$STATE")"
SSH_KEY_FILE="$(jq -r .sshKeyFile "$STATE")"
OUT="$ROOT/data/deploy/preflight-$(date -u +%Y%m%dT%H%M%SZ).txt"

ssh -i "$SSH_KEY_FILE" -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new "root@$SANDBOX_IP" \
  "SANDBOX_VPC_IP=$SANDBOX_VPC_IP CONTROL_VPC_IP=$CONTROL_VPC_IP bash -s" <<'REMOTE' | tee "$OUT"
set -u
fail=0
say() { echo "$*"; }
chk() { if eval "$2"; then echo "  ok   $1"; else echo "  FAIL $1"; fail=$((fail+1)); fi; }

say "== airlock preflight on $(hostname) at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
say "host kernel: $(uname -r)   $(uname -a)"
say "cpu: $(grep -m1 'model name' /proc/cpuinfo | cut -d: -f2- | sed 's/^ //')   virt flags on $(grep -c -E '(vmx|svm)' /proc/cpuinfo) cores"
say "/dev/kvm: $(ls -l /dev/kvm 2>&1)"
chk "/dev/kvm present" "[[ -e /dev/kvm ]]"
chk "/dev/kvm readable+writable by root" "[[ -r /dev/kvm && -w /dev/kvm ]]"
chk "/dev/kvm readable+writable by airlock-supervisor" "sudo -u airlock-supervisor test -r /dev/kvm -a -w /dev/kvm"

say "== docker"
say "$(docker --version)"
say "runtimes: $(docker info --format '{{range $k, $v := .Runtimes}}{{$k}} {{end}}')   default: $(docker info --format '{{.DefaultRuntime}}')"
say "daemon.json: $(tr -d '\n ' < /etc/docker/daemon.json)"
HOST_KR="$(uname -r)"
say "== runtime uname checks (docker run --rm --runtime=<name> python:3.12-slim uname -r)"
for rt in kata runsc runc; do
  if out="$(timeout 180 docker run --rm --runtime=$rt --network none python:3.12-slim uname -r 2>&1)"; then
    say "  $rt: $out"
    case "$rt" in
      kata)  chk "kata guest kernel ($out) differs from host ($HOST_KR)" "[[ '$out' != '$HOST_KR' ]]" ;;
      runsc) chk "runsc reports gVisor's kernel string ($out)" "[[ '$out' != '$HOST_KR' ]]" ;;
      runc)  say "  (runc shares the host kernel: $([[ "$out" == "$HOST_KR" ]] && echo same || echo DIFFERENT?) — reference only, never a deployment runtime)" ;;
    esac
  else
    say "  $rt: FAILED: $(echo "$out" | tail -n 3 | tr '\n' ' ')"
    [[ "$rt" == "runc" ]] || { echo "  FAIL $rt cannot run python:3.12-slim"; fail=$((fail+1)); }
  fi
done
say "  kata-runtime check: $(/opt/kata/bin/kata-runtime check 2>&1 | tail -n 2 | tr '\n' ' ')"
say "  kata full uname inside guest: $(timeout 180 docker run --rm --runtime=kata --network none python:3.12-slim uname -a 2>&1 | tail -n1)"
say "  runsc full uname inside sandbox: $(timeout 180 docker run --rm --runtime=runsc --network none python:3.12-slim uname -a 2>&1 | tail -n1)"

say "== listeners and firewall on VM B"
say "$(ss -ltnp | grep -E ':4300|:22 ' || true)"
chk "supervisor bound to the VPC address $SANDBOX_VPC_IP:4300 only" "ss -ltn | grep -q \"$SANDBOX_VPC_IP:4300\" && ! ss -ltn | grep -qE '(0\\.0\\.0\\.0|\\*):4300'"
say "ufw: $(ufw status | grep -E '4300/tcp|^Status' | tr -s ' ' | tr '\n' ';')"
chk "ufw active, 4300/tcp allowed from $CONTROL_VPC_IP only" "ufw status | grep -q '^Status: active' && ufw status | grep -E '4300/tcp' | grep -q \"$CONTROL_VPC_IP\" && ! ufw status | grep -E '4300/tcp' | grep -qE 'Anywhere'"
say "docker containers owned by airlock (should be none between runs): $(docker ps -a --filter label=airlock.supervisor=true --format '{{.Names}} {{.Status}}' | tr '\n' ';')"

say "== supervisor service"
say "$(systemctl is-active airlock-supervisor) $(systemctl show -p User,Group,SupplementaryGroups airlock-supervisor | tr '\n' ' ')"
say "env file: $(stat -c '%U:%G %a %n' /etc/airlock/supervisor.env)"
say "AIRLOCK_RUNTIME=$(grep -E '^AIRLOCK_RUNTIME=' /etc/airlock/supervisor.env | cut -d= -f2)  AIRLOCK_DEV_UNSAFE=$(grep -E '^AIRLOCK_DEV_UNSAFE=' /etc/airlock/supervisor.env | cut -d= -f2 || echo unset)"
chk "AIRLOCK_DEV_UNSAFE is not 1" "! grep -qE '^AIRLOCK_DEV_UNSAFE=1' /etc/airlock/supervisor.env"

say "== supervisor API (deploy/preflight-api.ts)"
TOKEN="$(grep -E '^SUPERVISOR_TOKEN=' /etc/airlock/supervisor.env | cut -d= -f2-)"
if (cd /opt/airlock/app && SUPERVISOR_URL="http://$SANDBOX_VPC_IP:4300" SUPERVISOR_TOKEN="$TOKEN" /usr/local/bin/bun deploy/preflight-api.ts); then :; else fail=$((fail+1)); fi
unset TOKEN

say "== egress note"
say "Vultr's firewall filters inbound only; VM B's own egress is unrestricted (apt, image pulls). Sandboxes run with --network none, so no sandbox has egress regardless."

if [[ $fail -eq 0 ]]; then say "PREFLIGHT PASSED"; else say "PREFLIGHT FAILED: $fail check(s)"; exit 1; fi
REMOTE
echo "preflight: saved to $OUT"
