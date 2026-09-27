#!/usr/bin/env bash
# Sourced by dev-up.sh. Decides what to do about the web bundle before the control plane starts.
#
#   web_dist_action <AIRLOCK_WEB_DIST value> <repo root>
#
# Prints one of:
#   skip     the UI is disabled ("" or "none", the same values config.ts maps to "no web UI")
#   build    the value names <root>/apps/web/dist (any spelling: trailing slash, relative path,
#            symlink; compared by canonical path when it exists) — always rebuild, because dist/
#            is gitignored and depends on apps/web/src, packages/contracts, vite.config.ts and
#            the lockfile, so a dist left from an earlier checkout would silently serve a stale
#            bundle after a pull
#   serve    another directory that already holds an index.html
# and returns 2 with a message on stderr when a custom directory has no index.html.
web_dist_action() {
  local value="$1" root="$2" default canonical
  if [[ -z "$value" || "$value" == "none" ]]; then
    echo skip
    return 0
  fi
  default="$(cd "$root/apps/web" && pwd -P)/dist"
  canonical="$(cd "$value" 2>/dev/null && pwd -P || true)"
  if [[ "$value" == "$default" || "$value" == "$root/apps/web/dist" || "$canonical" == "$default" ]]; then
    echo build
    return 0
  fi
  if [[ ! -f "$value/index.html" ]]; then
    echo "AIRLOCK_WEB_DIST=$value has no index.html; build it first (bun run --cwd apps/web build) or set AIRLOCK_WEB_DIST=none" >&2
    return 2
  fi
  echo serve
}
