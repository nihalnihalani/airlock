#!/usr/bin/env bash
# Airlock: build the pinned Python runtime image for one profile.
#
#   runtime/python/build.sh <profileId> [--no-cache]
#
# 1. runtime/python/prepare-profile.sh <profileId>   (verifies profiles/<id>/base against baselineTreeDigest)
# 2. docker build -f runtime/python/Dockerfile --build-arg PROFILE=<id> --build-arg ADAPTER_MODULE=<m>
#        -t airlock-runtime-python:<id>   (context = repository root)
# 3. prints the base image digest used, the built image id and its repo digest (if pushed) as JSON on stdout.
#
# Exit codes: 0 ok, 1 usage/environment, 2 prepare-profile refused, 4 docker build failed.
set -euo pipefail

usage() { echo "usage: $0 <profileId> [--no-cache]" >&2; exit 1; }
[[ $# -ge 1 && $# -le 2 ]] || usage
PROFILE_ID="$1"
NO_CACHE=""
if [[ $# -eq 2 ]]; then
  [[ "$2" == "--no-cache" ]] || usage
  NO_CACHE="--no-cache"
fi
[[ "$PROFILE_ID" =~ ^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$ ]] || { echo "build: invalid profile id" >&2; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PROFILE_JSON="$REPO_ROOT/profiles/$PROFILE_ID/profile.json"
IMAGE="airlock-runtime-python:$PROFILE_ID"

command -v docker >/dev/null 2>&1 || { echo "build: docker is required" >&2; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "build: python3 is required" >&2; exit 1; }
[[ -f "$PROFILE_JSON" ]] || { echo "build: missing $PROFILE_JSON" >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo "build: docker daemon unavailable" >&2; exit 1; }

ADAPTER_MODULE="$(python3 - "$PROFILE_JSON" <<'PY'
import json, re, sys
with open(sys.argv[1], "rb") as fh:
    profile = json.load(fh)
module = profile.get("adapterModule")
if not isinstance(module, str) or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,127}", module):
    sys.stderr.write("build: profile.adapterModule is not a valid module name\n")
    sys.exit(1)
if profile.get("runtimeImage") != "airlock-runtime-python:%s" % profile["id"]:
    sys.stderr.write("build: profile.runtimeImage must be airlock-runtime-python:<id>\n")
    sys.exit(1)
sys.stdout.write(module)
PY
)"
[[ -f "$REPO_ROOT/profiles/$PROFILE_ID/$ADAPTER_MODULE.py" ]] \
  || { echo "build: adapter module profiles/$PROFILE_ID/$ADAPTER_MODULE.py not found" >&2; exit 1; }

"$SCRIPT_DIR/prepare-profile.sh" "$PROFILE_ID" || { rc=$?; echo "build: prepare-profile failed (exit $rc)" >&2; exit 2; }

BASE_TAG="$(sed -n 's/^FROM[[:space:]]\{1,\}\([^[:space:]]\{1,\}\).*/\1/p' "$SCRIPT_DIR/Dockerfile" | head -n1)"
BASE_TAG="${BASE_TAG:-python:3.12-slim}"
BASE_DIGEST="$(docker image inspect "$BASE_TAG" --format '{{index .RepoDigests 0}}' 2>/dev/null || true)"
[[ -n "$BASE_DIGEST" ]] || echo "build: base image $BASE_TAG not present locally; docker build will pull it" >&2

echo "build: docker build $IMAGE (PROFILE=$PROFILE_ID ADAPTER_MODULE=$ADAPTER_MODULE)" >&2
if ! docker build $NO_CACHE \
      -f "$SCRIPT_DIR/Dockerfile" \
      --build-arg "PROFILE=$PROFILE_ID" \
      --build-arg "ADAPTER_MODULE=$ADAPTER_MODULE" \
      -t "$IMAGE" \
      "$REPO_ROOT" 1>&2; then
  echo "build: docker build failed" >&2
  exit 4
fi

[[ -n "$BASE_DIGEST" ]] || BASE_DIGEST="$(docker image inspect "$BASE_TAG" --format '{{index .RepoDigests 0}}' 2>/dev/null || echo unknown)"
IMAGE_ID="$(docker image inspect "$IMAGE" --format '{{.Id}}')"
IMAGE_REPO_DIGEST="$(docker image inspect "$IMAGE" --format '{{if .RepoDigests}}{{index .RepoDigests 0}}{{end}}')"
python3 - "$IMAGE" "$IMAGE_ID" "$IMAGE_REPO_DIGEST" "$BASE_TAG" "$BASE_DIGEST" "$PROFILE_ID" "$ADAPTER_MODULE" <<'PY'
import json, sys
image, image_id, repo_digest, base_tag, base_digest, profile, module = sys.argv[1:]
print(json.dumps({
    "image": image,
    "imageId": image_id,
    "imageRepoDigest": repo_digest or None,   # only set once the image has been pushed to a registry
    "baseImage": base_tag,
    "baseImageDigest": base_digest,
    "profileId": profile,
    "adapterModule": module,
}, indent=2))
PY
