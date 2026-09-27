#!/usr/bin/env bash
# Stop the local Airlock dev stack started by scripts/dev-up.sh. Safe to run when nothing is up.
# Leaves data/ (journal, PGlite, artifacts, dev.env) in place; remove data/ by hand to reset.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN="$ROOT/data/run"

stop_one() { # name
  local pidfile="$RUN/$1.pid" pid
  [[ -f "$pidfile" ]] || { echo "$1: not running"; return 0; }
  pid="$(cat "$pidfile")"
  if kill -0 "$pid" 2>/dev/null; then
    kill -TERM "$pid" 2>/dev/null
    for _ in $(seq 1 40); do kill -0 "$pid" 2>/dev/null || break; sleep 0.25; done
    kill -0 "$pid" 2>/dev/null && kill -KILL "$pid" 2>/dev/null
    echo "$1: stopped (pid $pid)"
  else
    echo "$1: stale pid file removed"
  fi
  rm -f "$pidfile"
}

# Control first so it stops driving the supervisor; then the supervisor, which stops its sandboxes.
stop_one control
stop_one supervisor

# Report anything the supervisor still owns. It removes its own containers on the next start
# (janitor); listing here makes a failed teardown visible instead of silent.
export DOCKER_HOST="${DOCKER_HOST:-unix://$HOME/.colima/default/docker.sock}"
if docker info >/dev/null 2>&1; then
  left="$(docker ps -a --filter label=airlock.supervisor=true --format '{{.Names}} ({{.Status}})')"
  if [[ -n "$left" ]]; then
    echo "owned containers still present (the supervisor's janitor reconciles them at next start):"
    echo "$left" | sed 's/^/  /'
  else
    echo "(no sandboxes)"
  fi
fi
