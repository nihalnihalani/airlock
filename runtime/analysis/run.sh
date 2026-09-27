#!/bin/bash
# Airlock analysis runner (fixed; the supervisor execs it, never a model-chosen command line).
#
#   /opt/airlock/run.sh code/<name>.py [args...]      (cwd /workspace, uid 1000, --network none)
#
# Contract: inputs in /workspace/inputs (placed by the supervisor), model code in /workspace/code,
# results written to /workspace/outputs; only outputs/ is ever collected (collect_outputs.py).
# The supervisor bounds wall time (timeout) and stdout/stderr bytes; this script bounds nothing else.
set -euo pipefail
umask 022

[[ $# -ge 1 ]] || { echo "run: usage: run.sh code/<name>.py [args...]" >&2; exit 64; }
SCRIPT="$1"; shift
[[ "$SCRIPT" =~ ^code/([A-Za-z0-9_][A-Za-z0-9_.-]{0,63}/){0,4}[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}\.py$ ]] \
  || { echo "run: script must be code/<path>.py" >&2; exit 64; }
[[ "$(pwd -P)" == "/workspace" ]] || { echo "run: cwd must be /workspace" >&2; exit 64; }
[[ -f "$SCRIPT" && ! -L "$SCRIPT" ]] || { echo "run: $SCRIPT is not a regular file" >&2; exit 66; }
mkdir -p /workspace/outputs

# Prebuilt matplotlib font cache -> writable MPLCONFIGDIR (avoids a rebuild on every run).
export HOME=/tmp MPLCONFIGDIR=/tmp/matplotlib MPLBACKEND=Agg
mkdir -p "$MPLCONFIGDIR"
cp -n /opt/airlock/mplcache/fontlist-*.json "$MPLCONFIGDIR"/ 2>/dev/null || true

# -E: ignore PYTHON* env, -s: no user site, -B: no bytecode writes. The script's own directory stays
# on sys.path so the model can split code into modules under code/.
exec /usr/local/bin/python3 -E -s -B "$SCRIPT" "$@"
