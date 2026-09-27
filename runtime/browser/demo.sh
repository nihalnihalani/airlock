#!/usr/bin/env bash
# Airlock browser plane, real-Docker demonstration (doc 40 Stage 1: C1-C10 evidence).
#
#   runtime/browser/demo.sh            build images, run the checks, tear everything down
#   SKIP_BUILD=1 runtime/browser/demo.sh
#   BROWSER_MEMORY=1g runtime/browser/demo.sh   (default 2g; lower on small dev VMs)
#
# Topology (one browser attempt):
#   [browser]  --internal network only-->  [egress proxy]  --normal network-->  allowlisted sites
# The browser container has no route anywhere except the proxy; the proxy enforces the hostname
# allowlist and refuses private/metadata/loopback resolutions (DNS pinned per request).
#
# On a local Mac (Colima/Docker Desktop) the runtime is runc: this is DEV-UNSAFE evidence of the
# browser/egress mechanics only, never a statement about the deployed gVisor/Kata tier.
# Idempotent and self-cleaning: every resource is named airlock-bdemo-* and removed on exit.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
P=airlock-bdemo
NET_INT=$P-int
NET_EXT=$P-ext
PROXY=$P-egress
BROWSER=$P-browser
BROWSER_IMAGE=${BROWSER_IMAGE:-airlock-browser:dev}
EGRESS_IMAGE=${EGRESS_IMAGE:-airlock-egress:dev}
BROWSER_MEMORY=${BROWSER_MEMORY:-2g}
# internal-svc.test is allowlisted on purpose: it is a Docker alias of a private bridge address, so
# the proxy must refuse it after resolution (an allowed NAME never grants an internal ADDRESS).
ALLOW='["example.com","iana.org",".iana.org","internal-svc.test"]'
OUT="$(mktemp -d "${TMPDIR:-/tmp}/airlock-bdemo.XXXXXX")"
PASS=0
FAIL=0
RESULTS=()

pass() { PASS=$((PASS + 1)); RESULTS+=("PASS  $1"); echo "PASS  $1"; }
fail() { FAIL=$((FAIL + 1)); RESULTS+=("FAIL  $1"); echo "FAIL  $1"; }
check() { if eval "$2"; then pass "$1"; else fail "$1"; fi; }
info() { echo "      $*"; }

# JSON field from stdin, e.g. jget .result.generation (path is a fixed literal from this script).
jget() {
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let v;try{v=JSON.parse(s);for(const k of process.argv[1].split(".").filter(Boolean))v=v?.[k]}catch{v=undefined}process.stdout.write(v===undefined?"":typeof v==="object"?JSON.stringify(v):String(v))})' "$1"
}

cleanup() {
  docker rm -f "$BROWSER" "$PROXY" >/dev/null 2>&1 || true
  docker network rm "$NET_INT" "$NET_EXT" >/dev/null 2>&1 || true
}

# The supervisor's bounded exec: one JSON request on stdin, one JSON line out.
op() { printf '%s' "$1" | docker exec -i "$BROWSER" node /opt/airlock/client.mjs; }

cleanup
trap cleanup EXIT

RUNTIME="$(docker info --format '{{.DefaultRuntime}}' 2>/dev/null)"
echo "== Airlock browser-plane demo  $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "   docker $(docker version --format '{{.Server.Version}} {{.Server.Os}}/{{.Server.Arch}}')  default runtime: $RUNTIME"
if [ "$RUNTIME" = "runc" ]; then echo "   RUNTIME TIER: runc = dev-unsafe (local development only; not a deployment claim)"; fi

if [ "${SKIP_BUILD:-0}" != "1" ]; then
  echo "== building images"
  docker build -q -t "$EGRESS_IMAGE" "$ROOT/apps/egress" >/dev/null || { echo "egress build failed"; exit 1; }
  docker build -q -t "$BROWSER_IMAGE" "$HERE" >/dev/null || { echo "browser build failed"; exit 1; }
fi

echo "== network + containers"
docker network create --internal --label airlock.demo=browser "$NET_INT" >/dev/null
docker network create --label airlock.demo=browser "$NET_EXT" >/dev/null
docker run -d --name "$PROXY" --label airlock.demo=browser \
  --network "$NET_EXT" --network-alias internal-svc.test \
  --read-only --cap-drop ALL --security-opt no-new-privileges --user 1000:1000 \
  --pids-limit 64 --memory 128m --memory-swap 128m \
  -e AIRLOCK_EGRESS_ALLOW="$ALLOW" -e AIRLOCK_EGRESS_PORTS='[443,80]' \
  "$EGRESS_IMAGE" >/dev/null
docker network connect "$NET_INT" "$PROXY"

docker run -d --name "$BROWSER" --label airlock.demo=browser \
  --network "$NET_INT" \
  --read-only \
  --tmpfs /tmp:rw,nosuid,nodev,noexec,size=512m \
  --tmpfs /run/airlock:rw,nosuid,nodev,noexec,size=1m,mode=0700,uid=1001,gid=1001 \
  --cap-drop ALL --security-opt no-new-privileges \
  --security-opt seccomp="$HERE/seccomp/chromium.json" \
  --user 1001:1001 \
  --pids-limit 256 --memory "$BROWSER_MEMORY" --memory-swap "$BROWSER_MEMORY" --shm-size 256m \
  -e AIRLOCK_PROXY="http://$PROXY:3128" \
  "$BROWSER_IMAGE" >/dev/null

for _ in $(seq 1 60); do
  health="$(docker inspect -f '{{.State.Health.Status}}' "$BROWSER" 2>/dev/null)"
  [ "$health" = "healthy" ] && break
  [ "$(docker inspect -f '{{.State.Running}}' "$BROWSER" 2>/dev/null)" != "true" ] && break
  sleep 1
done
check "browser container healthy (runner up, Chromium launched)" '[ "$health" = "healthy" ]'
if [ "$health" != "healthy" ]; then docker logs "$BROWSER" 2>&1 | tail -20; fi

echo "== container facts"
info "browser: $(docker inspect -f 'user={{.Config.User}} readonly={{.HostConfig.ReadonlyRootfs}} capdrop={{.HostConfig.CapDrop}} secopt={{len .HostConfig.SecurityOpt}} pids={{.HostConfig.PidsLimit}} mem={{.HostConfig.Memory}} shm={{.HostConfig.ShmSize}} networks={{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}ports={{.HostConfig.PortBindings}}' "$BROWSER")"
info "in-sandbox: $(docker exec "$BROWSER" sh -c 'echo "hostname=$(hostname) uname=$(uname -srm) uid=$(id -u)"')"
# Docker's embedded DNS (127.0.0.11, owned by dockerd, uid 0) is the only permitted listener.
LISTENERS="$(docker exec "$BROWSER" sh -c "cat /proc/net/tcp /proc/net/tcp6 2>/dev/null" | awk '$4=="0A" && $2 !~ /^0B00007F:/ {print $2}')"
check "no TCP listener inside the browser container (besides Docker's 127.0.0.11 DNS stub)" '[ -z "$LISTENERS" ]'
check "runner socket is 0600 in a 0700 dir owned by pwuser" \
  '[ "$(docker exec "$BROWSER" stat -c "%a %U" /run/airlock /run/airlock/runner.sock | tr "\n" " ")" = "700 pwuser 600 pwuser " ]'

echo "== runner status / Chromium sandbox evidence"
STATUS="$(op '{"schemaVersion":1,"id":"s1","op":"status"}')"
info "$(printf '%s' "$STATUS" | jget .result.browserVersion) sandbox=$(printf '%s' "$STATUS" | jget .result.sandbox)"
check "Chromium sandbox on: no --no-sandbox, zygote present, renderers in nested PID namespaces" \
  '[ "$(printf "%s" "$STATUS" | jget .result.sandbox.anyNoSandboxFlag)" = "false" ] && [ "$(printf "%s" "$STATUS" | jget .result.sandbox.zygotePresent)" = "true" ] && [ "$(printf "%s" "$STATUS" | jget .result.sandbox.renderersInNestedPidNamespace)" = "true" ]'

echo "== allowed navigation + interaction"
NAV="$(op '{"schemaVersion":1,"id":"n1","op":"navigate","args":{"url":"https://example.com/"}}')"
info "navigate: $(printf '%s' "$NAV" | jget .result)"
check "navigate https://example.com (allowlisted) -> 200" '[ "$(printf "%s" "$NAV" | jget .result.status)" = "200" ]'

OBS1="$(op '{"schemaVersion":1,"id":"o1","op":"observe"}')"
G1="$(printf '%s' "$OBS1" | jget .result.generation)"
LINK="$(printf '%s' "$OBS1" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const c=JSON.parse(s).result.controls.find(c=>c.role==="link");process.stdout.write(c?c.ref:"")})')"
info "observe: generation=$G1 title=$(printf '%s' "$OBS1" | jget .result.title) controls=$(printf '%s' "$OBS1" | jget .result.controls) text=$(printf '%s' "$OBS1" | jget .result.text | head -c 80)..."
check "observe returns a link control with a ref" '[ -n "$LINK" ]'

CLICK="$(op "{\"schemaVersion\":1,\"id\":\"c1\",\"op\":\"click\",\"args\":{\"ref\":\"$LINK\",\"generation\":$G1}}")"
info "click: $(printf '%s' "$CLICK" | jget .result)"
check "click the link (fresh ref) succeeds" '[ "$(printf "%s" "$CLICK" | jget .ok)" = "true" ]'

OBS2="$(op '{"schemaVersion":1,"id":"o2","op":"observe"}')"
G2="$(printf '%s' "$OBS2" | jget .result.generation)"
info "observe: generation=$G2 url=$(printf '%s' "$OBS2" | jget .result.url) title=$(printf '%s' "$OBS2" | jget .result.title)"
check "generation advanced after navigation ($G1 -> $G2)" '[ -n "$G2" ] && [ "$G2" -gt "$G1" ]'
check "redirect target (iana.org) loaded through the proxy" 'printf "%s" "$OBS2" | jget .result.url | grep -q "iana.org"'

STALE="$(op "{\"schemaVersion\":1,\"id\":\"c2\",\"op\":\"click\",\"args\":{\"ref\":\"$LINK\",\"generation\":$G1}}")"
info "stale click: $(printf '%s' "$STALE" | jget .error) - $(printf '%s' "$STALE" | jget .message)"
check "old ref/generation refused as stale_reference" '[ "$(printf "%s" "$STALE" | jget .error)" = "stale_reference" ]'
UNKNOWN="$(op "{\"schemaVersion\":1,\"id\":\"c3\",\"op\":\"click\",\"args\":{\"ref\":\"e99999\",\"generation\":$G2}}")"
check "unknown ref at current generation refused as stale_reference" '[ "$(printf "%s" "$UNKNOWN" | jget .error)" = "stale_reference" ]'
EVAL="$(op '{"schemaVersion":1,"id":"x1","op":"evaluate","args":{"expression":"document.cookie"}}')"
check "no arbitrary-JS operation exists (evaluate -> unknown_op)" '[ "$(printf "%s" "$EVAL" | jget .error)" = "unknown_op" ]'

SCROLL="$(op '{"schemaVersion":1,"id":"sc","op":"scroll","args":{"dy":400}}')"
check "scroll succeeds" '[ "$(printf "%s" "$SCROLL" | jget .ok)" = "true" ]'
KEY="$(op "{\"schemaVersion\":1,\"id\":\"k1\",\"op\":\"key\",\"args\":{\"key\":\"Home\",\"generation\":$G2}}")"
check "allowlisted key (Home) at current generation succeeds" '[ "$(printf "%s" "$KEY" | jget .ok)" = "true" ]'

echo "== screenshot"
SHOT="$(op '{"schemaVersion":1,"id":"p1","op":"screenshot"}')"
printf '%s' "$SHOT" | jget .result.png | base64 -d > "$OUT/step.png" 2>/dev/null || printf '%s' "$SHOT" | jget .result.png | base64 -D > "$OUT/step.png"
REPORTED="$(printf '%s' "$SHOT" | jget .result.sha256)"
ACTUAL="$(shasum -a 256 "$OUT/step.png" | cut -d' ' -f1)"
info "png=$OUT/step.png bytes=$(printf '%s' "$SHOT" | jget .result.bytes) ${ACTUAL} $(printf '%s' "$SHOT" | jget .result.width)x$(printf '%s' "$SHOT" | jget .result.height) url=$(printf '%s' "$SHOT" | jget .result.url) at=$(printf '%s' "$SHOT" | jget .result.capturedAt)"
check "screenshot is a 1280x800 PNG whose sha256 matches the reported digest" \
  '[ "$REPORTED" = "$ACTUAL" ] && [ "$(printf "%s" "$SHOT" | jget .result.width)x$(printf "%s" "$SHOT" | jget .result.height)" = "1280x800" ] && file "$OUT/step.png" | grep -q PNG'

echo "== negative checks"
DENY="$(op '{"schemaVersion":1,"id":"n2","op":"navigate","args":{"url":"https://www.wikipedia.org/"}}')"
info "navigate wikipedia: ok=$(printf '%s' "$DENY" | jget .ok) $(printf '%s' "$DENY" | jget .error) $(printf '%s' "$DENY" | jget .message)"
check "disallowed domain blocked (tunnel refused by proxy)" \
  '[ "$(printf "%s" "$DENY" | jget .ok)" = "false" ] && docker logs "$PROXY" 2>&1 | grep -q "\"host\":\"www.wikipedia.org\".*\"decision\":\"deny\",\"reason\":\"host_not_allowed\""'

META="$(op '{"schemaVersion":1,"id":"n3","op":"navigate","args":{"url":"http://169.254.169.254/latest/meta-data/"}}')"
info "navigate metadata: $(printf '%s' "$META" | jget .result)$(printf '%s' "$META" | jget .message)"
check "http://169.254.169.254/ blocked by proxy (403, X-Airlock-Egress)" \
  '[ "$(printf "%s" "$META" | jget .result.status)" = "403" ] && [ "$(printf "%s" "$META" | jget .result.egressDenied)" = "true" ]'

INTERNAL="$(op '{"schemaVersion":1,"id":"n5","op":"navigate","args":{"url":"https://internal-svc.test/"}}')"
info "navigate allowlisted-but-private internal-svc.test: $(printf '%s' "$INTERNAL" | jget .message)"
check "allowlisted name resolving to a private address refused after DNS (non_public_address)" \
  '[ "$(printf "%s" "$INTERNAL" | jget .ok)" = "false" ] && docker logs "$PROXY" 2>&1 | grep -q "\"host\":\"internal-svc.test\".*\"reason\":\"non_public_address\""'

LOOP="$(op '{"schemaVersion":1,"id":"n4","op":"navigate","args":{"url":"http://127.0.0.1:9/"}}')"
check "loopback navigation goes to the proxy and is refused (no implicit bypass)" \
  '[ "$(printf "%s" "$LOOP" | jget .result.egressDenied)" = "true" ] || [ "$(printf "%s" "$LOOP" | jget .ok)" = "false" ]'

DIRECT="$(docker exec "$BROWSER" node -e "const s=require('net').connect(443,'1.1.1.1');s.setTimeout(5000,()=>{console.log('TIMEOUT');process.exit(1)});s.on('connect',()=>{console.log('CONNECTED');process.exit(0)});s.on('error',e=>{console.log('ERROR '+e.code);process.exit(1)})" 2>&1)"
info "direct socket to 1.1.1.1:443 from browser container: $DIRECT"
check "direct socket from browser container fails (internal network)" '! printf "%s" "$DIRECT" | grep -q CONNECTED'
DIRECTMETA="$(docker exec "$BROWSER" node -e "const s=require('net').connect(80,'169.254.169.254');s.setTimeout(5000,()=>{console.log('TIMEOUT');process.exit(1)});s.on('connect',()=>{console.log('CONNECTED');process.exit(0)});s.on('error',e=>{console.log('ERROR '+e.code);process.exit(1)})" 2>&1)"
info "direct socket to 169.254.169.254:80: $DIRECTMETA"
check "direct socket to metadata fails" '! printf "%s" "$DIRECTMETA" | grep -q CONNECTED'
DNS="$(docker exec "$BROWSER" node -e "require('dns').lookup('example.com',{all:true},(e,a)=>{console.log(e?'ERROR '+e.code:'RESOLVED '+JSON.stringify(a))})" 2>&1)"
info "DNS lookup of example.com from browser container: $DNS"
check "browser container cannot resolve external names (no DNS side channel)" '! printf "%s" "$DNS" | grep -q RESOLVED'
DIRECTPROXYHOST="$(docker exec "$BROWSER" node -e "const s=require('net').connect(22,'$PROXY');s.setTimeout(3000,()=>{console.log('TIMEOUT');process.exit(1)});s.on('connect',()=>{console.log('CONNECTED');process.exit(0)});s.on('error',e=>{console.log('ERROR '+e.code);process.exit(1)})" 2>&1)"
check "no other service reachable on the proxy container (port 22: $DIRECTPROXYHOST)" '! printf "%s" "$DIRECTPROXYHOST" | grep -q CONNECTED'

echo "== resources (browser container, after the run)"
STATS="$(docker stats --no-stream --format '{{.MemUsage}} cpu={{.CPUPerc}} pids={{.PIDs}}' "$BROWSER")"
PEAK="$(docker exec "$BROWSER" cat /sys/fs/cgroup/memory.peak 2>/dev/null)"
info "browser: $STATS  cgroup memory.peak=${PEAK:+$((PEAK / 1048576))MiB}"
info "egress:  $(docker stats --no-stream --format '{{.MemUsage}} cpu={{.CPUPerc}} pids={{.PIDs}}' "$PROXY")"
info "tmpfs:   $(docker exec "$BROWSER" df -h /tmp /run/airlock /dev/shm | tail -3 | awk '{print $6"="$3}' | tr '\n' ' ')"

echo "== egress decisions (proxy log, decisions only)"
docker logs "$PROXY" 2>&1 | grep '"event":"decision"' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const l of s.trim().split("\n")){const o=JSON.parse(l);console.log(`      ${o.decision.padEnd(5)} ${o.method} ${o.host}:${o.port} ${o.reason}${o.address?" -> "+o.address:""}`)}})'

echo "== teardown"
docker stop -t 5 "$BROWSER" >/dev/null 2>&1
EXIT_CODE="$(docker inspect -f '{{.State.ExitCode}}' "$BROWSER")"
info "runner exit code=$EXIT_CODE  last log: $(docker logs "$BROWSER" 2>&1 | tail -1)"
check "runner shut down cleanly on SIGTERM (browser closed, transient profile removed)" '[ "$EXIT_CODE" = "0" ]'
cleanup
trap - EXIT
LEFT="$(docker ps -a --filter "name=$P" --format '{{.Names}}'; docker network ls --filter "name=$P" --format '{{.Name}}'; docker volume ls --filter label=airlock.demo=browser --format '{{.Name}}')"
if [ -z "$LEFT" ]; then info "(no sandboxes)"; fi
check "teardown: no containers, networks or volumes remain" '[ -z "$LEFT" ]'

echo
echo "== SUMMARY: $PASS passed, $FAIL failed  (runtime: $RUNTIME${RUNTIME:+$([ "$RUNTIME" = runc ] && echo ', dev-unsafe')})"
for line in "${RESULTS[@]}"; do echo "   $line"; done
echo "   artifacts: $OUT"
[ "$FAIL" -eq 0 ]
