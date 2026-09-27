#!/usr/bin/env bash
# Airlock offline Node runtime: real-Docker demonstration (doc 40 Stage 4, research/42 C30).
# LOCAL COLIMA RUNC = DEV-UNSAFE (mechanics only, no deployment-tier claim).
#
#   runtime/node/demo.sh                 (builds airlock-runtime-node:dev / -analysis:dev if missing)
#   REBUILD=1 runtime/node/demo.sh
#
# 1. hardened author sandbox (flags in runtime/outputs/demo-lib.sh), probe.sh -> probe.mjs allBlocked
# 2. supervisor places inputs/regions.csv (SYNTHETIC, shared with the analysis fixture) + code
# 3. /opt/airlock/run.sh code/analyze_regions.mjs (env cleared, --permission) -> outputs/*
# 4. offline proofs: npm / npx / corepack / yarn / npm-cli.js unusable, no network, no python
# 5. collection: the node image has NO python; the collector runs in the ANALYSIS image, which
#    holds the node workspace volume read-only at /candidate before the author is stopped
# 6. refusal: svg/html/bad json + a symlink planted outside the permission model -> rejected
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
# shellcheck source=../outputs/demo-lib.sh
source "$ROOT/runtime/outputs/demo-lib.sh"
IMAGE="${NODE_IMAGE:-airlock-runtime-node:dev}"
COLLECTOR_IMAGE="${ANALYSIS_IMAGE:-airlock-runtime-analysis:dev}"
P=airlock-odemo-node
OUT="$(mktemp -d "${TMPDIR:-/tmp}/airlock-node-demo.XXXXXX")"

cleanup() {
  docker rm -f "$P-author" "$P-hostile" airlock-odemo-collector >/dev/null 2>&1 || true
  docker volume rm -f "$P-ws" "$P-ws-hostile" >/dev/null 2>&1 || true
}
cleanup
trap cleanup EXIT

echo "== Airlock node-runtime demo  $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "   docker $(docker version --format '{{.Server.Version}} {{.Server.Os}}/{{.Server.Arch}}')  runtime: runc = DEV-UNSAFE (local only)"
if [[ "${REBUILD:-0}" == "1" ]] || ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  "$HERE/build.sh" >/dev/null || { echo "FAIL  build node"; exit 1; }
fi
if ! docker image inspect "$COLLECTOR_IMAGE" >/dev/null 2>&1; then
  "$ROOT/runtime/analysis/build.sh" >/dev/null || { echo "FAIL  build analysis (collector)"; exit 1; }
fi
echo "   image $IMAGE $(docker image inspect "$IMAGE" --format '{{.Id}}')"
echo "   collector image $COLLECTOR_IMAGE $(docker image inspect "$COLLECTOR_IMAGE" --format '{{.Id}}')"

# ---------------------------------------------------------------- 1. author sandbox
new_volume "$P-ws"
sandbox "$P-author" "$IMAGE" "$P-ws:/workspace"
check "readiness: node -e console.log('ready')" '[[ "$(docker exec "$P-author" node -e "console.log(\"ready\")")" == ready ]]'
PROBE="$(probe "$P-author")"
check "isolation probe (Node port) allBlocked" 'grep -q "\"allBlocked\":true" <<<"$PROBE"'
info "$PROBE"

# ---------------------------------------------------------------- 2. inputs + code
place "$P-author" "$ROOT/runtime/analysis/fixtures/regions.csv" /workspace/inputs/regions.csv 0444
place "$P-author" "$HERE/fixtures/analyze_regions.mjs" /workspace/code/analyze_regions.mjs 0444
docker exec -u 1000:1000 "$P-author" chmod 0555 /workspace/inputs

# ---------------------------------------------------------------- 3. run
RUN_OUT="$(docker exec -u 1000:1000 -w /workspace -e NODE_OPTIONS=--require=/workspace/x.js "$P-author" timeout 120 /opt/airlock/run.sh code/analyze_regions.mjs 2>&1 | head -c 16384)"
RUN_RC=${PIPESTATUS[0]}
check "node analysis exit 0, NODE_OPTIONS injection ignored (stdout: $RUN_OUT)" '[[ $RUN_RC -eq 0 && "$RUN_OUT" == *Synthetic-West* ]]'

# ---------------------------------------------------------------- 4. offline proofs
X() { docker exec -u 1000:1000 -w /workspace "$P-author" "$@" 2>&1; }
O="$(X sh -c 'npm i left-pad; echo rc=$?')";      check "npm i left-pad fails: ${O//$'\n'/ | }" '[[ "$O" == *"npm: not found"* && "$O" == *rc=127* ]]'
O="$(X sh -c 'npx cowsay hi; echo rc=$?')";       check "npx fails: ${O//$'\n'/ | }" '[[ "$O" == *rc=127* ]]'
O="$(X sh -c 'corepack enable; echo rc=$?')";     check "corepack fails: ${O//$'\n'/ | }" '[[ "$O" == *rc=127* ]]'
O="$(X sh -c 'yarn add x; echo rc=$?')";          check "yarn fails: ${O//$'\n'/ | }" '[[ "$O" == *rc=127* ]]'
O="$(X sh -c 'ls /usr/local/lib/node_modules 2>&1; find / -xdev -name npm-cli.js 2>/dev/null; echo end')"
check "no npm-cli.js anywhere (node npm-cli.js impossible)" '[[ "$O" == *"No such file"*end ]]'
O="$(X node -e 'fetch("https://registry.npmjs.org/left-pad").then(()=>console.log("REACHED"),e=>console.log("blocked:",e.cause?.code??e.message))')"
check "no network from Node: $O" '[[ "$O" == blocked:* ]]'
O="$(X sh -c 'for t in python3 python gcc cc make curl wget; do command -v $t; done; echo end')"
check "no python/compilers/fetchers on PATH" '[[ "$O" == end ]]'
O="$(X sh -c 'find / -xdev -perm /6000 -type f 2>/dev/null | head -3; echo end')"
check "no setuid/setgid binaries" '[[ "$O" == end ]]'

# ---------------------------------------------------------------- 5. collect (analysis image)
if collect "$P-ws" "$COLLECTOR_IMAGE" "$OUT/envelope.json" "$P-author"; then pass "collector exit 0 (analysis image, python3 -I -S, node volume at /candidate:ro)"; else fail "collector"; fi
summarize "$OUT/envelope.json" "$OUT/collected"
check "accepted exactly report.md summary.json totals.csv" '[[ "$(accepted "$OUT/envelope.json")" == "report.md summary.json totals.csv" ]]'
WORST="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["worstRegion"])' "$OUT/collected/summary.json" 2>/dev/null)"
check "summary.json worstRegion == Synthetic-West (got $WORST)" '[[ "$WORST" == Synthetic-West ]]'

# ---------------------------------------------------------------- 6. refusal
new_volume "$P-ws-hostile"
sandbox "$P-hostile" "$IMAGE" "$P-ws-hostile:/workspace"
place "$P-hostile" "$ROOT/runtime/analysis/fixtures/regions.csv" /workspace/inputs/regions.csv 0444
place "$P-hostile" "$HERE/fixtures/refusal.mjs" /workspace/code/refusal.mjs 0444
docker exec -u 1000:1000 "$P-hostile" mkdir -p /workspace/outputs
O="$(docker exec -u 1000:1000 -w /workspace "$P-hostile" timeout 60 /opt/airlock/run.sh code/refusal.mjs 2>&1)"
info "permission model inside run.sh: $O"
check "permission model denied symlink, /etc/passwd read, inputs write, spawn" '[[ "$O" == *"\"symlink\":\"ERR_ACCESS_DENIED\""* && "$O" == *"\"readPasswd\":\"ERR_ACCESS_DENIED\""* && "$O" == *"\"writeInputs\":\"ERR_ACCESS_DENIED\""* && "$O" != *"\"childProcess\":\"ok\""* ]]'
# Simulate a process NOT bound by the permission model (e.g. a Node escape): plant links directly.
docker exec -u 1000:1000 -w /workspace "$P-hostile" sh -c 'ln -s /etc/passwd outputs/passwd.csv && ln -s /workspace/inputs outputs/linked-dir && ln inputs/regions.csv outputs/hard.csv 2>/dev/null || cp -l inputs/regions.csv outputs/hard.csv'
collect "$P-ws-hostile" "$COLLECTOR_IMAGE" "$OUT/hostile.json" "$P-hostile" || fail "collector (hostile)"
summarize "$OUT/hostile.json" "$OUT/hostile-collected"
E="$OUT/hostile.json"
check "only ok.txt accepted" '[[ "$(accepted "$E")" == ok.txt ]]'
check "chart.svg rejected" '[[ "$(reason_of "$E" chart.svg)" == svg\ is\ active* ]]'
check "page.html rejected" '[[ "$(reason_of "$E" page.html)" == html\ is\ active* ]]'
check "bad.json rejected (not valid JSON)" '[[ "$(reason_of "$E" bad.json)" == "not valid JSON" ]]'
check "passwd.csv symlink rejected" '[[ "$(reason_of "$E" passwd.csv)" == symlink ]]'
check "linked-dir symlink rejected" '[[ "$(reason_of "$E" linked-dir)" == symlink ]]'
check "hard.csv hardlink rejected" '[[ "$(reason_of "$E" hard.csv)" == hardlink* ]]'

echo "== node demo: $PASS passed, $FAIL failed  (runc, DEV-UNSAFE)"
[[ $FAIL -eq 0 ]]
