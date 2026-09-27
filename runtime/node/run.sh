#!/bin/bash
# Airlock Node runner (fixed; the supervisor execs it, never a model-chosen command line).
#
#   /opt/airlock/run.sh code/<name>.mjs|.js|.cjs [args...]   (cwd /workspace, uid 1000, --network none)
#
# Contract: inputs in /workspace/inputs (placed by the supervisor), model code in /workspace/code,
# results written to /workspace/outputs; only outputs/ is ever collected (collect_outputs.py, run
# from the analysis image against the stopped volume). The supervisor bounds wall time and
# stdout/stderr bytes.
#
# Defence in depth on top of the container boundary (--network none, read-only rootfs, cap-drop ALL,
# no-new-privileges, uid 1000): the environment is cleared (no NODE_OPTIONS/NODE_PATH injection) and
# Node's permission model is on: reads only from /workspace, the baked deps and /tmp; writes only to
# /workspace/outputs and /tmp; no child processes, worker threads, native addons or WASI. The
# permission model is not a security boundary by itself; the container is.
set -euo pipefail
umask 022

[[ $# -ge 1 ]] || { echo "run: usage: run.sh code/<name>.mjs [args...]" >&2; exit 64; }
SCRIPT="$1"; shift
[[ "$SCRIPT" =~ ^code/([A-Za-z0-9_][A-Za-z0-9_.-]{0,63}/){0,4}[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}\.(mjs|js|cjs)$ ]] \
  || { echo "run: script must be code/<path>.mjs|.js|.cjs" >&2; exit 64; }
[[ "$(pwd -P)" == "/workspace" ]] || { echo "run: cwd must be /workspace" >&2; exit 64; }
[[ -f "$SCRIPT" && ! -L "$SCRIPT" ]] || { echo "run: $SCRIPT is not a regular file" >&2; exit 66; }
mkdir -p /workspace/outputs

exec /usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/tmp NODE_ENV=production \
  /usr/local/bin/node \
  --permission \
  --allow-fs-read=/workspace \
  --allow-fs-read=/opt/airlock/node \
  --allow-fs-read=/node_modules \
  --allow-fs-read=/tmp \
  --allow-fs-write=/workspace/outputs \
  --allow-fs-write=/tmp \
  --disable-proto=delete \
  --no-warnings=ExperimentalWarning \
  "$SCRIPT" "$@"
