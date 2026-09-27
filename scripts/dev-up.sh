#!/usr/bin/env bash
# Airlock local development stack: supervisor (VM B role) + control plane (VM A role) on one
# machine, on plain runc with AIRLOCK_DEV_UNSAFE=1. This is a development configuration only and
# never a deployment (CLAUDE.md §3.8): every record it produces is labelled dev-unsafe.
#
#   scripts/dev-up.sh            start both, wait for health, print URLs, keep running (Ctrl-C stops both)
#   scripts/dev-up.sh --detach   start both and return; stop with scripts/dev-down.sh
#
# Secrets: a random SUPERVISOR_TOKEN and role passwords are generated once into data/dev.env
# (gitignored) when absent. A conventional .env at the repository root (also gitignored) is loaded
# afterwards and overrides it; put VULTR_INFERENCE_API_KEY, AIRLOCK_MODEL and any overrides there.
# Variables already exported in the calling shell win over both files.
#
# Model driver: scripted by default (AIRLOCK_MODEL_DRIVER=scripted:apps/control/test/fixtures/scripted),
# i.e. the labelled diagnostic candidate and the forged-log script; never a live repair. Set
# VULTR_INFERENCE_API_KEY, AIRLOCK_MODEL and AIRLOCK_MODEL_DRIVER=vultr (in .env) for live inference.
# The same scripts stay launchable as labelled diagnostics under the live driver
# (AIRLOCK_DIAGNOSTIC_SCRIPTS_DIR, default apps/control/test/fixtures/scripted; "none" disables).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA="$ROOT/data"
DEV_ENV="$DATA/dev.env"
RUN="$DATA/run"
mkdir -p "$DATA" "$RUN"
# Per-process log files (appended). ./run.sh points these at the same defaults and merges them.
SUPERVISOR_LOG="${AIRLOCK_SUPERVISOR_LOG:-$RUN/supervisor.log}"
CONTROL_LOG="${AIRLOCK_CONTROL_LOG:-$RUN/control.log}"

DETACH=0
for arg in "$@"; do
  case "$arg" in
    --detach|-d) DETACH=1 ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

# --- secrets (generated once, never committed) -----------------------------------------------
if [[ ! -f "$DEV_ENV" ]]; then
  umask 077
  {
    echo "SUPERVISOR_TOKEN=$(openssl rand -hex 24)"
    echo "AIRLOCK_OPERATOR_PASSWORD=op-$(openssl rand -hex 8)"
    echo "AIRLOCK_JUDGE_PASSWORD=judge-$(openssl rand -hex 8)"
  } > "$DEV_ENV"
  umask 022
  echo "generated $DEV_ENV"
fi
# Precedence: calling shell > .env > data/dev.env. Both files are gitignored. The caller's exports
# are snapshotted first and re-applied last, so a file never overrides an explicit export.
CALLER_EXPORTS="$(export -p)"
set -a
# shellcheck disable=SC1090
source "$DEV_ENV"
if [[ -f "$ROOT/.env" ]]; then
  # shellcheck disable=SC1091
  source "$ROOT/.env"
fi
set +a
eval "$CALLER_EXPORTS"

# --- environment ------------------------------------------------------------------------------
export DOCKER_HOST="${DOCKER_HOST:-unix://$HOME/.colima/default/docker.sock}"
export AIRLOCK_RUNTIME="${AIRLOCK_RUNTIME:-runc}"
export AIRLOCK_DEV_UNSAFE="${AIRLOCK_DEV_UNSAFE:-1}"
export SUPERVISOR_PORT="${SUPERVISOR_PORT:-4300}"
export CONTROL_PORT="${CONTROL_PORT:-3000}"
export SUPERVISOR_URL="http://127.0.0.1:$SUPERVISOR_PORT"
export AIRLOCK_MODEL_DRIVER="${AIRLOCK_MODEL_DRIVER:-scripted:$ROOT/apps/control/test/fixtures/scripted}"
export AIRLOCK_DIAGNOSTIC_SCRIPTS_DIR="${AIRLOCK_DIAGNOSTIC_SCRIPTS_DIR-$ROOT/apps/control/test/fixtures/scripted}"
export AIRLOCK_INSECURE_COOKIES=1
export AIRLOCK_DATA_DIR_CONTROL="${AIRLOCK_DATA_DIR_CONTROL:-$DATA/control}"
export AIRLOCK_DATA_DIR_SUPERVISOR="${AIRLOCK_DATA_DIR_SUPERVISOR:-$DATA/supervisor}"
export AIRLOCK_WEB_DIST="${AIRLOCK_WEB_DIST-$ROOT/apps/web/dist}"

if [[ "$AIRLOCK_RUNTIME" == "runc" && "$AIRLOCK_DEV_UNSAFE" != "1" ]]; then
  echo "AIRLOCK_RUNTIME=runc needs AIRLOCK_DEV_UNSAFE=1 (local development only)" >&2
  exit 2
fi

# --- preflight ----------------------------------------------------------------------------------
command -v bun >/dev/null || { echo "bun is required" >&2; exit 2; }
if ! docker info >/dev/null 2>&1; then
  echo "Docker is not reachable at DOCKER_HOST=$DOCKER_HOST (start Colima: colima start)" >&2
  exit 2
fi
IMAGE="$(bun -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).runtimeImage)' "$ROOT/profiles/tabulate-365/profile.json")"
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "runtime image $IMAGE is missing; building it (runtime/python/build.sh tabulate-365)"
  "$ROOT/runtime/python/build.sh" tabulate-365 >/dev/null
fi
# Web bundle: see scripts/lib/web-dist.sh. "none" (or empty) skips it, the default apps/web/dist
# is always rebuilt (about a second; the control plane reads dist files per request, so this is
# right even when the stack is already running), any other directory must already hold index.html.
# shellcheck disable=SC1091
source "$ROOT/scripts/lib/web-dist.sh"
case "$(web_dist_action "$AIRLOCK_WEB_DIST" "$ROOT")" in
  build)
    echo "building the web UI into apps/web/dist"
    (cd "$ROOT/apps/web" && bunx vite build >/dev/null)
    ;;
  skip) echo "AIRLOCK_WEB_DIST=none: web UI disabled; only /api is served" ;;
  serve) ;;
  *) exit 2 ;;
esac

# --- idempotent start -----------------------------------------------------------------------------
alive() { [[ -f "$1" ]] && kill -0 "$(cat "$1")" 2>/dev/null; }
wait_http() { # url, seconds, [curl args...]
  local i url="$1" secs="$2"
  shift 2
  for ((i = 0; i < secs * 2; i++)); do
    if curl -fsS -o /dev/null "$@" "$url" 2>/dev/null; then return 0; fi
    sleep 0.5
  done
  return 1
}

STARTED=()
SUPERVISOR_AUTH=(-H "authorization: Bearer $SUPERVISOR_TOKEN")
if alive "$RUN/supervisor.pid" && curl -fsS -o /dev/null "${SUPERVISOR_AUTH[@]}" "$SUPERVISOR_URL/health"; then
  echo "supervisor already running (pid $(cat "$RUN/supervisor.pid"))"
else
  rm -f "$RUN/supervisor.pid"
  ( cd "$ROOT/apps/supervisor" && \
    PORT="$SUPERVISOR_PORT" SUPERVISOR_BIND=127.0.0.1 AIRLOCK_DATA_DIR="$AIRLOCK_DATA_DIR_SUPERVISOR" \
    exec bun src/index.ts >>"$SUPERVISOR_LOG" 2>&1 ) &
  echo $! > "$RUN/supervisor.pid"
  STARTED+=(supervisor)
  if ! wait_http "$SUPERVISOR_URL/health" 30 "${SUPERVISOR_AUTH[@]}"; then
    echo "supervisor did not become healthy; last log lines:" >&2; tail -20 "$SUPERVISOR_LOG" >&2; exit 1
  fi
fi

CONTROL_URL="http://127.0.0.1:$CONTROL_PORT"
if alive "$RUN/control.pid" && curl -fsS -o /dev/null "$CONTROL_URL/api/health"; then
  echo "control already running (pid $(cat "$RUN/control.pid"))"
else
  rm -f "$RUN/control.pid"
  ( cd "$ROOT/apps/control" && \
    PORT="$CONTROL_PORT" CONTROL_BIND=127.0.0.1 AIRLOCK_DATA_DIR="$AIRLOCK_DATA_DIR_CONTROL" \
    exec bun src/index.ts >>"$CONTROL_LOG" 2>&1 ) &
  echo $! > "$RUN/control.pid"
  STARTED+=(control)
  if ! wait_http "$CONTROL_URL/api/health" 60; then
    echo "control did not become ready; last log lines:" >&2; tail -20 "$CONTROL_LOG" >&2; exit 1
  fi
fi

HOST_JSON="$(curl -fsS "${SUPERVISOR_AUTH[@]}" "$SUPERVISOR_URL/host")"
# What this stack actually runs with (after .env overrides), for smoke.ts and live-gate.ts.
(umask 077 && printf 'SUPERVISOR_URL=%s\nSUPERVISOR_TOKEN=%s\nAIRLOCK_CONTROL_URL=%s\n' "$SUPERVISOR_URL" "$SUPERVISOR_TOKEN" "$CONTROL_URL" > "$RUN/stack.env")
echo
echo "Airlock dev stack (dev-unsafe: plain runc, local only)"
echo "  supervisor  $SUPERVISOR_URL/host     -> $(bun -e 'const h=JSON.parse(process.argv[1]);console.log(`runtime=${h.selectedRuntime} devUnsafe=${h.devUnsafe} kvm=${h.kvmPresent} image=${h.runtimeImageId ?? "unpinned"}`)' "$HOST_JSON")"
echo "  control     $CONTROL_URL/api/health"
if [[ -z "$AIRLOCK_WEB_DIST" || "$AIRLOCK_WEB_DIST" == "none" ]]; then
  echo "  web UI      disabled (AIRLOCK_WEB_DIST=none); operator password in $DEV_ENV"
else
  echo "  web UI      $CONTROL_URL/   (operator and judge passwords in $DEV_ENV)"
fi
echo "  model       $AIRLOCK_MODEL_DRIVER"
echo "  diagnostics ${AIRLOCK_DIAGNOSTIC_SCRIPTS_DIR:-none}"
echo "  logs        $SUPERVISOR_LOG  $CONTROL_LOG  (AIRLOCK_LOG_LEVEL=${AIRLOCK_LOG_LEVEL:-info}; ./run.sh merges them)"
echo "  smoke       bun scripts/smoke.ts"
echo

if [[ $DETACH -eq 1 ]]; then
  exit 0
fi
stop() {
  echo; echo "stopping dev stack"
  "$ROOT/scripts/dev-down.sh"
}
trap stop EXIT INT TERM
if [[ ${#STARTED[@]} -eq 0 ]]; then
  echo "nothing new started; press Ctrl-C to stop the running stack"
fi
while alive "$RUN/supervisor.pid" && alive "$RUN/control.pid"; do sleep 1; done
echo "a process exited; see $SUPERVISOR_LOG and $CONTROL_LOG" >&2
exit 1
