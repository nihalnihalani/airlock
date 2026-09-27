# shellcheck shell=bash
# Shared helpers for runtime/analysis/demo.sh and runtime/node/demo.sh (sourced, not executed).
#
# Mirrors the supervisor's sandbox shape (apps/supervisor/src/runtime.ts) with plain docker CLI:
#   per-attempt `local` volume backed by a size-capped tmpfs (uid/gid 1000, 0755) at /workspace,
#   --network none --read-only --cap-drop ALL --security-opt no-new-privileges --user 1000:1000
#   --pids-limit 128 --memory 1g, /tmp = noexec 64 MiB tmpfs, idle `sleep infinity` + docker exec.
# LOCAL COLIMA RUNC = DEV-UNSAFE: evidence of the mechanics only, never a deployment-tier claim.

WS_BYTES=134217728
TMPFS_TMP="rw,nosuid,nodev,noexec,size=67108864,mode=1777"
PASS=0
FAIL=0

pass() { PASS=$((PASS + 1)); echo "PASS  $1"; }
fail() { FAIL=$((FAIL + 1)); echo "FAIL  $1"; }
check() { if eval "$2"; then pass "$1"; else fail "$1"; fi; }
info() { echo "      $*"; }

# new_volume NAME: the supervisor's bounded tmpfs workspace volume.
new_volume() {
  docker volume rm -f "$1" >/dev/null 2>&1 || true
  docker volume create --driver local --opt type=tmpfs --opt device=tmpfs \
    --opt "o=size=$WS_BYTES,uid=1000,gid=1000,mode=0755" "$1" >/dev/null
}

# sandbox NAME IMAGE MOUNT: start an idle hardened container (MOUNT e.g. vol:/workspace or vol:/candidate:ro).
sandbox() {
  docker rm -f "$1" >/dev/null 2>&1 || true
  docker run -d --name "$1" --runtime runc --label airlock.dev-unsafe=true --label airlock.demo=outputs \
    --network none --read-only --cap-drop ALL --security-opt no-new-privileges \
    --user 1000:1000 --pids-limit 128 --memory 1g --memory-swap 1g \
    --tmpfs "/tmp:$TMPFS_TMP" -v "$3" -w "${4:-/workspace}" "$2" >/dev/null
}

# place CONTAINER SRC DEST MODE: stream a host file into the workspace as uid 1000 (no docker cp,
# no bind mounts), then drop write permission.
place() {
  docker exec -i -u 1000:1000 "$1" /bin/sh -c 'd=$(dirname "$1"); mkdir -p "$d" && cat > "$1" && chmod "$2" "$1"' sh "$3" "$4" < "$2"
}

# probe CONTAINER -> prints the probe JSON line; returns the probe's exit code.
probe() {
  docker exec -u 1000:1000 "$1" /bin/bash --noprofile --norc /opt/airlock/probe.sh --workspace-bytes "$WS_BYTES" 2>/dev/null | tail -n 1
}

# collect VOLUME ANALYSIS_IMAGE OUTFILE AUTHOR: the supervisor's freeze order (lifecycle.ts collect):
# 1. provision a FRESH collector container (analysis image) with the volume read-only at /candidate
#    while the author still runs: a tmpfs-backed volume exists only while a container holds the
#    mount, so the hold must come first; 2. stop + remove the author; 3. probe the collector
#    (allBlocked); 4. `python3 -I -S collect_outputs.py --root /candidate` with cwd / and an empty env.
collect() {
  local c="${COLLECT_NAME:-airlock-odemo-collector}"
  sandbox "$c" "$2" "$1:/candidate:ro" /
  docker stop -t 2 "$4" >/dev/null && docker rm "$4" >/dev/null
  if [[ -z "$(docker ps -aq --filter "name=^$4\$")" ]]; then pass "author $4 stopped and removed (volume held by collector)"; else fail "author $4 still present"; fi
  local p
  p="$(probe "$c")"
  if printf '%s' "$p" | grep -q '"allBlocked":true'; then pass "collector sandbox probe allBlocked (/candidate read-only)"; else fail "collector sandbox probe: $p"; fi
  docker exec -u 1000:1000 -w / "$c" /usr/bin/env -i PATH=/usr/bin:/bin /usr/local/bin/python3 -I -S \
    /opt/airlock/collect_outputs.py --root /candidate > "$3"
  local rc=$?
  docker rm -f "$c" >/dev/null 2>&1 || true
  return $rc
}

# summarize ENVELOPE OUTDIR: print files/rejections and decode accepted files into OUTDIR.
summarize() {
  python3 - "$1" "$2" <<'PY'
import base64, hashlib, json, os, struct, sys
env = json.load(open(sys.argv[1]))
out = sys.argv[2]
os.makedirs(out, exist_ok=True)
print("      envelope: schemaVersion=%s files=%d rejected=%d bytes=%d" % (
    env["schemaVersion"], len(env["files"]), len(env["rejected"]), os.path.getsize(sys.argv[1])))
for f in env["files"]:
    data = base64.b64decode(f["contentBase64"])
    assert hashlib.sha256(data).hexdigest() == f["sha256"] and len(data) == f["byteLength"]
    extra = ""
    if f["mediaType"] == "image/png":
        w, h = struct.unpack(">II", data[16:24]); extra = " %dx%d" % (w, h)
    print("      + %-22s %-18s %7d B sha256:%s%s" % (f["path"], f["mediaType"], f["byteLength"], f["sha256"][:16], extra))
    dest = os.path.join(out, f["path"])
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    open(dest, "wb").write(data)
for r in env["rejected"]:
    print("      - %-22s %s" % (r["path"], r["reason"]))
PY
}

# jq-free field read from the envelope: rejected reason for PATH, or file mediaType.
reason_of() { python3 -c 'import json,sys;e=json.load(open(sys.argv[1]));print(next((r["reason"] for r in e["rejected"] if r["path"]==sys.argv[2]),""))' "$1" "$2"; }
accepted() { python3 -c 'import json,sys;e=json.load(open(sys.argv[1]));print(" ".join(f["path"] for f in e["files"]))' "$1"; }
