#!/usr/bin/env bash
# Airlock: build the offline Node runtime image.
#
#   runtime/node/build.sh [tag] [--no-cache]          (default tag: dev -> airlock-runtime-node:dev)
#
# The Dockerfile's paths are repository-root relative (runtime/node/*). Instead of sending the whole
# repository as context, this script stages EXACTLY those files into a temporary context.
# Before building it runs the probe parity test (runtime/node/tests/probe-parity.test.mjs): the
# Node probe must classify mounts exactly like runtime/python/probe.sh, so drift fails the build.
# (SKIP_PARITY=1 skips it when the host lacks node/bash/python3; never in CI.)
# Prints JSON {image, imageId, baseImage, sizeBytes, contextFiles} on stdout; logs on stderr.
# Exit codes: 0 ok, 1 usage/environment, 4 docker build failed.
set -euo pipefail

TAG="dev"; NO_CACHE=""
for a in "$@"; do
  case "$a" in
    --no-cache) NO_CACHE="--no-cache" ;;
    -*) echo "usage: $0 [tag] [--no-cache]" >&2; exit 1 ;;
    *) TAG="$a" ;;
  esac
done
[[ "$TAG" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$ ]] || { echo "build: invalid tag" >&2; exit 1; }

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
IMAGE="airlock-runtime-node:$TAG"
FILES=(
  runtime/node/Dockerfile
  runtime/node/package.json
  runtime/node/package-lock.json
  runtime/node/probe.sh
  runtime/node/probe.mjs
  runtime/node/run.sh
  runtime/node/image_check.mjs
)
command -v docker >/dev/null 2>&1 || { echo "build: docker is required" >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo "build: docker daemon unavailable (Colima: export DOCKER_HOST=unix://\$HOME/.colima/default/docker.sock)" >&2; exit 1; }

if [[ "${SKIP_PARITY:-0}" != "1" ]]; then
  echo "build: probe parity test (node probe.mjs vs python probe.sh)" >&2
  node --test "$ROOT/runtime/node/tests/probe-parity.test.mjs" 1>&2 || { echo "build: probe parity FAILED; port runtime/python/probe.sh changes to probe.mjs" >&2; exit 1; }
fi

CTX="$(mktemp -d "${TMPDIR:-/tmp}/airlock-node-ctx.XXXXXX")"
trap 'rm -rf "$CTX"' EXIT
for f in "${FILES[@]}"; do
  [[ -f "$ROOT/$f" && ! -L "$ROOT/$f" ]] || { echo "build: missing $f" >&2; exit 1; }
  mkdir -p "$CTX/$(dirname "$f")"
  cp "$ROOT/$f" "$CTX/$f"
done

echo "build: docker build $IMAGE (staged context: ${#FILES[@]} files)" >&2
if ! docker build $NO_CACHE -f "$CTX/runtime/node/Dockerfile" -t "$IMAGE" "$CTX" 1>&2; then
  echo "build: docker build failed" >&2
  exit 4
fi

BASE="$(sed -n 's/^FROM[[:space:]]\{1,\}\([^[:space:]]\{1,\}\).*/\1/p' "$HERE/Dockerfile" | head -n1)"
IMAGE_ID="$(docker image inspect "$IMAGE" --format '{{.Id}}')"
SIZE="$(docker image inspect "$IMAGE" --format '{{.Size}}')"
printf '{\n  "image": "%s",\n  "imageId": "%s",\n  "baseImage": "%s",\n  "sizeBytes": %s,\n  "contextFiles": %s\n}\n' \
  "$IMAGE" "$IMAGE_ID" "$BASE" "$SIZE" "${#FILES[@]}"
