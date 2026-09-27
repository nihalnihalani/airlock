#!/usr/bin/env bash
# Airlock offline analysis runtime: real-Docker demonstration (doc 40 Stage 3 hero-task core,
# research/42 C29/C32 evidence). LOCAL COLIMA RUNC = DEV-UNSAFE (mechanics only, no tier claim).
#
#   runtime/analysis/demo.sh                 (builds airlock-runtime-analysis:dev if missing)
#   REBUILD=1 runtime/analysis/demo.sh
#
# 1. hardened author sandbox (see runtime/outputs/demo-lib.sh for the exact flags), probe allBlocked
# 2. supervisor places inputs/regions.csv (SYNTHETIC fixture) and code/analyze_regions.py
# 3. /opt/airlock/run.sh code/analyze_regions.py -> outputs/summary.json + outputs/chart.png
# 4. offline proofs: pip/pip3/python -m pip/ensurepip unusable, no network, no compilers
# 5. fresh collector container holds the volume read-only at /candidate, THEN the author is stopped
#    and removed (lifecycle.ts freeze order), then the collector runs collect_outputs.py under python3 -I -S; envelope decoded and checked on host
# 6. refusal: a hostile script writes svg/symlink/hardlink/fake png/huge png/.sh -> all rejected
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
# shellcheck source=../outputs/demo-lib.sh
source "$ROOT/runtime/outputs/demo-lib.sh"
IMAGE="${ANALYSIS_IMAGE:-airlock-runtime-analysis:dev}"
P=airlock-odemo-analysis
OUT="$(mktemp -d "${TMPDIR:-/tmp}/airlock-analysis-demo.XXXXXX")"

cleanup() {
  docker rm -f "$P-author" "$P-hostile" airlock-odemo-collector >/dev/null 2>&1 || true
  docker volume rm -f "$P-ws" "$P-ws-hostile" >/dev/null 2>&1 || true
}
cleanup
trap cleanup EXIT

echo "== Airlock analysis-runtime demo  $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "   docker $(docker version --format '{{.Server.Version}} {{.Server.Os}}/{{.Server.Arch}}')  runtime: runc = DEV-UNSAFE (local only)"
if [[ "${REBUILD:-0}" == "1" ]] || ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  "$HERE/build.sh" >/dev/null || { echo "FAIL  build"; exit 1; }
fi
echo "   image $IMAGE $(docker image inspect "$IMAGE" --format '{{.Id}}')"

# ---------------------------------------------------------------- 1. author sandbox
new_volume "$P-ws"
sandbox "$P-author" "$IMAGE" "$P-ws:/workspace"
check "readiness: python3 -I -S -c print('ready')" '[[ "$(docker exec "$P-author" python3 -I -S -c "print(\"ready\")")" == ready ]]'
PROBE="$(probe "$P-author")"
check "isolation probe allBlocked (metadata, dns, tcp, docker socket, host mounts)" 'grep -q "\"allBlocked\":true" <<<"$PROBE"'
info "$PROBE"

# ---------------------------------------------------------------- 2. inputs + code
place "$P-author" "$HERE/fixtures/regions.csv" /workspace/inputs/regions.csv 0444
place "$P-author" "$HERE/fixtures/analyze_regions.py" /workspace/code/analyze_regions.py 0444
docker exec -u 1000:1000 "$P-author" chmod 0555 /workspace/inputs
info "inputs: $(docker exec "$P-author" ls -l /workspace/inputs | tail -n +2)"

# ---------------------------------------------------------------- 3. run
RUN_OUT="$(docker exec -u 1000:1000 -w /workspace "$P-author" timeout 120 /opt/airlock/run.sh code/analyze_regions.py 2>&1 | head -c 16384)"
RUN_RC=${PIPESTATUS[0]}
check "analysis script exit 0 (stdout: $RUN_OUT)" '[[ $RUN_RC -eq 0 ]]'

# ---------------------------------------------------------------- 4. offline proofs
X() { docker exec -u 1000:1000 -w /workspace "$P-author" "$@" 2>&1; }
O="$(X sh -c 'pip install requests; echo rc=$?')";            check "pip install requests fails: ${O//$'\n'/ | }" '[[ "$O" == *"not found"* && "$O" == *"rc=127"* ]]'
O="$(X sh -c 'pip3 install requests; echo rc=$?')";           check "pip3 install fails: ${O//$'\n'/ | }" '[[ "$O" == *"rc=127"* ]]'
O="$(X sh -c 'python3 -m pip install requests; echo rc=$?')"; check "python3 -m pip fails: ${O//$'\n'/ | }" '[[ "$O" == *"No module named pip"* ]]'
O="$(X sh -c 'python3 -m ensurepip; echo rc=$?')";            check "python3 -m ensurepip fails: ${O//$'\n'/ | }" '[[ "$O" == *"No module named ensurepip"* ]]'
O="$(X python3 -c 'import urllib.request as u
try: u.urlopen("https://pypi.org/simple/", timeout=3); print("REACHED")
except Exception as e: print("blocked:", type(e).__name__, str(e)[:60])')"
check "no network from model code: $O" '[[ "$O" == blocked:* ]]'
O="$(X sh -c 'for t in gcc cc g++ clang ld make curl wget npm; do command -v $t; done; echo end')"
check "no compilers/fetchers on PATH" '[[ "$O" == end ]]'
O="$(X sh -c 'find / -xdev -perm /6000 -type f 2>/dev/null | head -3; echo end')"
check "no setuid/setgid binaries" '[[ "$O" == end ]]'
O="$(X sh -c 'touch /usr/local/x 2>&1; touch /workspace/inputs/x 2>&1; echo end')"
check "rootfs read-only, inputs dir not writable: ${O//$'\n'/ | }" '[[ "$O" == *"Read-only file system"* && "$O" == *"Permission denied"* ]]'

# ---------------------------------------------------------------- 5. stop, collect, verify
if collect "$P-ws" "$IMAGE" "$OUT/envelope.json" "$P-author"; then pass "collector exit 0 (python3 -I -S, fresh container, /candidate:ro)"; else fail "collector"; fi
summarize "$OUT/envelope.json" "$OUT/collected"
check "accepted exactly chart.png + summary.json" '[[ "$(accepted "$OUT/envelope.json")" == "chart.png summary.json" ]]'
WORST="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["worstRegion"])' "$OUT/collected/summary.json" 2>/dev/null)"
check "summary.json worstRegion == Synthetic-West (got $WORST)" '[[ "$WORST" == Synthetic-West ]]'
SHA_IN="$(shasum -a 256 "$HERE/fixtures/regions.csv" | cut -d" " -f1)"
check "summary.json binds the input sha256" 'grep -q "$SHA_IN" "$OUT/collected/summary.json"'
check "chart.png is a PNG (mediaType image/png)" '[[ "$(head -c 8 "$OUT/collected/chart.png" | xxd -p)" == 89504e470d0a1a0a ]]'
info "decoded outputs: $OUT/collected"

# ---------------------------------------------------------------- 6. refusal
new_volume "$P-ws-hostile"
sandbox "$P-hostile" "$IMAGE" "$P-ws-hostile:/workspace"
place "$P-hostile" "$HERE/fixtures/regions.csv" /workspace/inputs/regions.csv 0444
place "$P-hostile" "$HERE/fixtures/refusal.py" /workspace/code/refusal.py 0444
O="$(docker exec -u 1000:1000 -w /workspace "$P-hostile" timeout 60 /opt/airlock/run.sh code/refusal.py 2>&1)"
check "hostile script ran ($O)" '[[ "$O" == "wrote hostile outputs" ]]'
collect "$P-ws-hostile" "$IMAGE" "$OUT/hostile.json" "$P-hostile" || fail "collector (hostile)"
summarize "$OUT/hostile.json" "$OUT/hostile-collected"
E="$OUT/hostile.json"
check "only ok.txt accepted" '[[ "$(accepted "$E")" == ok.txt ]]'
check "chart.svg rejected (active content)" '[[ "$(reason_of "$E" chart.svg)" == svg\ is\ active* ]]'
check "passwd.csv symlink rejected" '[[ "$(reason_of "$E" passwd.csv)" == symlink ]]'
check "linked-dir symlinked directory rejected" '[[ "$(reason_of "$E" linked-dir)" == symlink ]]'
check "hardlinked.csv rejected" '[[ "$(reason_of "$E" hardlinked.csv)" == hardlink* ]]'
check "fake.png rejected (signature)" '[[ "$(reason_of "$E" fake.png)" == "not a PNG (bad signature)" ]]'
check "huge.png rejected (100000x10 > 8192)" '[[ "$(reason_of "$E" huge.png)" == *outside\ 1..8192* ]]'
check "run.sh rejected (extension)" '[[ "$(reason_of "$E" run.sh)" == *not\ allowed* ]]'

echo "== analysis demo: $PASS passed, $FAIL failed  (runc, DEV-UNSAFE)"
[[ $FAIL -eq 0 ]]
