#!/usr/bin/env bash
# Airlock: materialize the pristine baseline tree of a profile into profiles/<id>/base/.
#
#   runtime/python/prepare-profile.sh <profileId>
#
# Reads profiles/<id>/profile.json, ensures a clone of profile.repository exists under
# research/reference-repos/<name> (uses an existing clone whose origin matches; clones otherwise),
# extracts the tracked files of profile.baselineCommit with `git archive` (no .git, no untracked
# files), computes the tree digest (runtime/python/tree_digest.py) and REFUSES to install the tree
# when it differs from profile.baselineTreeDigest. Idempotent: an already correct base/ is left alone.
#
# Exit codes: 0 ok, 1 usage/environment error, 2 digest mismatch, 3 repository/commit problem.
set -euo pipefail

usage() { echo "usage: $0 <profileId>" >&2; exit 1; }
[[ $# -eq 1 ]] || usage
PROFILE_ID="$1"
if ! [[ "$PROFILE_ID" =~ ^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$ ]]; then
  echo "prepare-profile: invalid profile id '$PROFILE_ID' (letters, digits, hyphen, underscore)" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PROFILE_DIR="$REPO_ROOT/profiles/$PROFILE_ID"
PROFILE_JSON="$PROFILE_DIR/profile.json"
BASE_DIR="$PROFILE_DIR/base"
REF_DIR="$REPO_ROOT/research/reference-repos"
DIGEST_PY="$SCRIPT_DIR/tree_digest.py"

for tool in git python3 tar; do
  command -v "$tool" >/dev/null 2>&1 || { echo "prepare-profile: '$tool' is required" >&2; exit 1; }
done
[[ -f "$PROFILE_JSON" ]] || { echo "prepare-profile: missing $PROFILE_JSON" >&2; exit 1; }
[[ -f "$DIGEST_PY" ]] || { echo "prepare-profile: missing $DIGEST_PY" >&2; exit 1; }

# Read the three fields we need with python3 (jq is optional on the deployment host).
read_field() {
  python3 - "$PROFILE_JSON" "$1" <<'PY'
import json, sys
with open(sys.argv[1], "rb") as fh:
    profile = json.load(fh)
value = profile.get(sys.argv[2])
if not isinstance(value, str) or not value:
    sys.stderr.write(f"prepare-profile: profile.json field '{sys.argv[2]}' missing or not a string\n")
    sys.exit(1)
sys.stdout.write(value)
PY
}
REPOSITORY="$(read_field repository)"
BASELINE_COMMIT="$(read_field baselineCommit)"
EXPECTED_DIGEST="$(read_field baselineTreeDigest)"
[[ "$BASELINE_COMMIT" =~ ^[0-9a-f]{40}$ ]] || { echo "prepare-profile: baselineCommit is not a 40-hex sha" >&2; exit 1; }
[[ "$EXPECTED_DIGEST" =~ ^[0-9a-f]{64}$ ]] || { echo "prepare-profile: baselineTreeDigest is not a 64-hex sha256" >&2; exit 1; }

# Repository name = last URL segment without .git; restricted to a safe character set.
REPO_NAME="${REPOSITORY%/}"
REPO_NAME="${REPO_NAME##*/}"
REPO_NAME="${REPO_NAME%.git}"
if ! [[ "$REPO_NAME" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]]; then
  echo "prepare-profile: cannot derive a safe clone name from repository '$REPOSITORY'" >&2
  exit 3
fi
CLONE_DIR="$REF_DIR/$REPO_NAME"

normalize_url() { local u="${1%/}"; u="${u%.git}"; printf '%s' "$u"; }

if [[ -d "$CLONE_DIR/.git" ]]; then
  ORIGIN="$(git -C "$CLONE_DIR" remote get-url origin 2>/dev/null || true)"
  if [[ "$(normalize_url "$ORIGIN")" != "$(normalize_url "$REPOSITORY")" ]]; then
    echo "prepare-profile: $CLONE_DIR exists but its origin '$ORIGIN' is not '$REPOSITORY'; refusing to reuse it" >&2
    exit 3
  fi
elif [[ -e "$CLONE_DIR" ]]; then
  echo "prepare-profile: $CLONE_DIR exists and is not a git clone" >&2
  exit 3
else
  mkdir -p "$REF_DIR"
  echo "prepare-profile: cloning $REPOSITORY into $CLONE_DIR" >&2
  git clone --quiet "$REPOSITORY" "$CLONE_DIR"
fi

if ! git -C "$CLONE_DIR" cat-file -e "${BASELINE_COMMIT}^{commit}" 2>/dev/null; then
  echo "prepare-profile: commit $BASELINE_COMMIT not present locally; fetching" >&2
  git -C "$CLONE_DIR" fetch --quiet origin
  if ! git -C "$CLONE_DIR" cat-file -e "${BASELINE_COMMIT}^{commit}" 2>/dev/null; then
    echo "prepare-profile: commit $BASELINE_COMMIT not found in $REPOSITORY" >&2
    exit 3
  fi
fi

# Idempotence: an existing base/ that already digests correctly is left untouched.
if [[ -d "$BASE_DIR" ]]; then
  CURRENT="$(python3 "$DIGEST_PY" "$BASE_DIR" 2>/dev/null || true)"
  if [[ "$CURRENT" == "$EXPECTED_DIGEST" ]]; then
    echo "prepare-profile: $BASE_DIR already matches baselineTreeDigest $EXPECTED_DIGEST" >&2
    exit 0
  fi
fi

TMP_DIR="$(mktemp -d "$PROFILE_DIR/.base.tmp.XXXXXX")"
cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT

# Tracked files only, no .git, no untracked files, no working-tree state.
git -C "$CLONE_DIR" archive --format=tar "$BASELINE_COMMIT" | tar -x -C "$TMP_DIR"

ACTUAL_DIGEST="$(python3 "$DIGEST_PY" "$TMP_DIR")"
if [[ "$ACTUAL_DIGEST" != "$EXPECTED_DIGEST" ]]; then
  echo "prepare-profile: REFUSING — tree digest mismatch for $PROFILE_ID @ $BASELINE_COMMIT" >&2
  echo "  expected (profile.baselineTreeDigest): $EXPECTED_DIGEST" >&2
  echo "  actual   (git archive of commit):      $ACTUAL_DIGEST" >&2
  if [[ -d "$BASE_DIR" ]]; then
    echo "--- diff: existing base/ listing vs freshly archived listing ---" >&2
    diff <(python3 "$DIGEST_PY" --lines "$BASE_DIR" 2>/dev/null || echo "(existing base/ unreadable)") \
         <(python3 "$DIGEST_PY" --lines "$TMP_DIR") >&2 || true
  else
    echo "--- freshly archived listing (no existing base/ to diff against) ---" >&2
    python3 "$DIGEST_PY" --lines "$TMP_DIR" >&2
  fi
  exit 2
fi

# Install atomically: the old base/ is only removed once the new tree has been verified.
if [[ -e "$BASE_DIR" ]]; then
  rm -rf "$BASE_DIR"
fi
chmod 0755 "$TMP_DIR"   # mktemp creates 0700; the tree is public source and must be readable by builders
mv "$TMP_DIR" "$BASE_DIR"
trap - EXIT
echo "prepare-profile: installed $BASE_DIR (digest $ACTUAL_DIGEST)" >&2
