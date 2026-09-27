#!/usr/bin/env bash
# Airlock: start, stop and observe the local stack with one thorough debugging log.
#
#   ./run.sh | ./run.sh up      start the stack, stream the merged log, Ctrl-C stops everything
#   ./run.sh up -d              start detached (stop with ./run.sh down)
#   ./run.sh down               stop the stack; footer with the docker owned-container listing
#   ./run.sh status             pids, health JSON, owned containers, model driver/model, log path
#   ./run.sh logs               tail -F the merged log
#   ./run.sh smoke              end-to-end smoke through the HTTP API (needs the stack up)
#   ./run.sh gate [--n N]       live-repair gate (needs the stack up with the vultr driver)
#   ./run.sh test               the four suites: control, supervisor (real Docker), web, runtime pytest
#   ./run.sh help
#   flag: --quiet               AIRLOCK_LOG_LEVEL=info (the default here is debug)
#
# The start/stop logic lives in scripts/dev-up.sh and scripts/dev-down.sh; this script only adds
# the merged debugging log, data/run/airlock-<YYYYmmdd-HHMMSS>.log (symlink data/run/airlock-latest.log):
#   (a) a preflight header (git rev, tool versions, DOCKER_HOST, Docker runtimes, runtime image,
#       profiles, a redacted env summary, driver/model, ports),
#   (b) both processes' output merged in order, each line prefixed "<ISO ts> [control|supervisor] ",
#   (c) on exit, a footer with the exit reason and the docker owned-container listing.
# Secret VALUES never enter the log: the env summary prints names only for anything that looks like
# a token, password or key, and the apps redact credential-like fields themselves.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA="$ROOT/data"
RUN="$DATA/run"
LATEST="$RUN/airlock-latest.log"
MERGE_PIDS="$RUN/logmerge.pids"
mkdir -p "$RUN"
export DOCKER_HOST="${DOCKER_HOST:-unix://$HOME/.colima/default/docker.sock}"
export AIRLOCK_SUPERVISOR_LOG="$RUN/supervisor.log"
export AIRLOCK_CONTROL_LOG="$RUN/control.log"

# --- arguments ------------------------------------------------------------------------------------
CMD=""
DETACH=0
QUIET=0
REST=()
for arg in "$@"; do
  case "$arg" in
    --quiet|-q) QUIET=1 ;;
    -d|--detach) DETACH=1 ;;
    up|down|status|logs|smoke|gate|test|help|-h|--help) if [[ -z "$CMD" ]]; then CMD="$arg"; else REST+=("$arg"); fi ;;
    *) REST+=("$arg") ;;
  esac
done
CMD="${CMD:-up}"
if [[ $QUIET -eq 1 ]]; then export AIRLOCK_LOG_LEVEL=info; else export AIRLOCK_LOG_LEVEL="${AIRLOCK_LOG_LEVEL:-debug}"; fi

# --- helpers --------------------------------------------------------------------------------------
now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# Prefix every stdin line with a UTC timestamp and a tag, appending to the log (and to stdout when
# `tee` is given). Bash 3.2 has no per-line timestamp builtin; perl is present on macOS and Linux.
prefix() { # tag file [tee]
  perl -e '
    use strict; use POSIX qw(strftime);
    my ($tag, $file, $tee) = @ARGV;
    open(my $out, ">>", $file) or die "cannot append $file: $!";
    $| = 1; select($out); $| = 1; select(STDOUT);
    while (defined(my $line = <STDIN>)) {
      chomp $line;
      my $stamped = strftime("%Y-%m-%dT%H:%M:%SZ", gmtime) . " [$tag] $line\n";
      print $out $stamped;
      print STDOUT $stamped if $tee;
    }
    close $out;
  ' "$1" "$2" "${3:-}"
}

# Follow a per-process log from its current end and append prefixed lines to the merged log. One
# perl process per source; partial lines are buffered until their newline arrives so a line is
# never split across two prefixed lines. Stops when the merged log is removed or on SIGTERM.
follow() { # tag source merged
  perl -e '
    use strict; use POSIX qw(strftime); use Time::HiRes qw(sleep);
    my ($tag, $src, $dst) = @ARGV;
    open(my $in, "<", $src) or die "cannot open $src: $!";
    seek($in, 0, 2);
    open(my $out, ">>", $dst) or die "cannot append $dst: $!";
    select($out); $| = 1;
    my $buf = "";
    my $stop = 0;
    $SIG{TERM} = $SIG{INT} = sub { $stop = 1 };
    while (!$stop) {
      my $got = 0;
      while (defined(my $chunk = <$in>)) {
        $got = 1;
        $buf .= $chunk;
        while ($buf =~ s/^([^\n]*)\n//) {
          print strftime("%Y-%m-%dT%H:%M:%SZ", gmtime) . " [$tag] $1\n";
        }
      }
      seek($in, 0, 1);
      sleep 0.2 unless $got;
      last unless -e $dst;
    }
    print strftime("%Y-%m-%dT%H:%M:%SZ", gmtime) . " [$tag] $buf\n" if length $buf;
  ' "$1" "$2" "$3"
}

log_line() { # tag text...  → merged log only
  local tag="$1"; shift
  [[ -n "${LOG:-}" ]] && printf '%s [%s] %s\n' "$(now_iso)" "$tag" "$*" >> "$LOG"
  return 0
}
say() { # tag text... → terminal and merged log
  local tag="$1"; shift
  printf '%s [%s] %s\n' "$(now_iso)" "$tag" "$*"
  [[ -n "${LOG:-}" ]] && printf '%s [%s] %s\n' "$(now_iso)" "$tag" "$*" >> "$LOG"
  return 0
}

alive() { [[ -f "$1" ]] && kill -0 "$(cat "$1")" 2>/dev/null; }

# The effective environment the stack will see: caller exports > .env > data/dev.env (the same
# precedence as scripts/dev-up.sh), evaluated in a subshell so this process stays clean.
effective_env() { # prints NAME=VALUE lines for the names in $@
  (
    CALLER_EXPORTS="$(export -p)"
    set -a
    [[ -f "$DATA/dev.env" ]] && source "$DATA/dev.env"
    [[ -f "$ROOT/.env" ]] && source "$ROOT/.env"
    set +a
    eval "$CALLER_EXPORTS"
    for name in "$@"; do
      if [[ -n "${!name+x}" ]]; then printf '%s=%s\n' "$name" "${!name}"; else printf '%s=\n' "$name"; fi
    done
  )
}

is_secret_name() { [[ "$1" =~ (TOKEN|PASSWORD|KEY|SECRET|COOKIE) ]]; }

env_summary() { # redacted: names only for secrets, values otherwise; only names that are set
  local names name value
  names="$( { grep -ho '^[A-Z][A-Z0-9_]*=' "$ROOT/.env.example" 2>/dev/null | tr -d '='; echo AIRLOCK_LOG_LEVEL; echo AIRLOCK_MODEL_DRIVER; echo AIRLOCK_MODEL; echo DOCKER_HOST; } | sort -u)"
  while IFS='=' read -r name value; do
    [[ -z "$name" ]] && continue
    if is_secret_name "$name"; then
      if [[ -n "$value" ]]; then echo "  $name=[set, ${#value} chars]"; fi
    elif [[ -n "$value" ]]; then
      echo "  $name=$value"
    fi
  done < <(effective_env $names)
}

image_line() {
  local image
  image="$(bun -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).runtimeImage)' "$ROOT/profiles/tabulate-365/profile.json" 2>/dev/null || echo airlock-runtime-python:tabulate-365)"
  if docker image inspect "$image" >/dev/null 2>&1; then
    echo "$image id=$(docker image inspect "$image" --format '{{.Id}}') digest=$(docker image inspect "$image" --format '{{if .RepoDigests}}{{index .RepoDigests 0}}{{else}}(not pushed){{end}}') created=$(docker image inspect "$image" --format '{{.Created}}')"
  else
    echo "$image (missing; dev-up builds it)"
  fi
}

owned_containers() {
  if docker info >/dev/null 2>&1; then
    local left
    left="$(docker ps -a --filter label=airlock.supervisor=true --format '{{.Names}} ({{.Status}})' 2>/dev/null || true)"
    if [[ -n "$left" ]]; then echo "$left" | sed 's/^/  /'; else echo "  (no sandboxes)"; fi
  else
    echo "  (docker unreachable at $DOCKER_HOST)"
  fi
}

driver_line() {
  local driver model
  driver="$(effective_env AIRLOCK_MODEL_DRIVER | cut -d= -f2-)"
  model="$(effective_env AIRLOCK_MODEL | cut -d= -f2-)"
  driver="${driver:-scripted:$ROOT/apps/control/test/fixtures/scripted (dev-up default)}"
  if [[ "$driver" == vultr ]]; then echo "vultr model=${model:-(unset)}"; else echo "$driver"; fi
}

header() {
  local dirty rev
  rev="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
  dirty="$(git -C "$ROOT" status --porcelain --untracked-files=no 2>/dev/null | wc -l | tr -d ' ')"
  {
    echo "=== airlock run $(now_iso) ==="
    echo "log:            $LOG"
    echo "log level:      $AIRLOCK_LOG_LEVEL"
    echo "git:            $rev$( [[ "$dirty" != 0 ]] && echo " (dirty: $dirty tracked files modified)" || echo " (clean)")"
    echo "bun:            $(bun --version 2>/dev/null || echo missing)"
    echo "docker:         $(docker version --format '{{.Client.Version}} (server {{.Server.Version}})' 2>/dev/null || echo unreachable)"
    echo "uv:             $(uv --version 2>/dev/null || echo missing)"
    echo "DOCKER_HOST:    $DOCKER_HOST"
    echo "runtimes:       $(docker info --format '{{range $k, $v := .Runtimes}}{{$k}} {{end}}(default {{.DefaultRuntime}})' 2>/dev/null || echo unknown)"
    echo "runtime image:  $(image_line)"
    echo "profiles:       $(ls "$ROOT"/profiles/*/profile.json 2>/dev/null | xargs -n1 dirname | xargs -n1 basename | tr '\n' ' ')"
    echo "model driver:   $(driver_line)"
    echo "ports:          control ${CONTROL_PORT:-3000}  supervisor ${SUPERVISOR_PORT:-4300}"
    echo "env (redacted): secrets by name only"
    env_summary
    echo "=== process output follows; lines are '<ts> [control|supervisor|run] <line>' ==="
  } >> "$LOG"
}

footer() { # reason
  {
    echo "=== airlock exit $(now_iso): $1 ==="
    echo "owned containers:"
    owned_containers
    echo "=== end of log $LOG ==="
  } >> "$LOG"
}

start_merge() {
  : > "$MERGE_PIDS"
  touch "$AIRLOCK_SUPERVISOR_LOG" "$AIRLOCK_CONTROL_LOG"
  follow supervisor "$AIRLOCK_SUPERVISOR_LOG" "$LOG" </dev/null >/dev/null 2>&1 &
  echo $! >> "$MERGE_PIDS"
  follow control "$AIRLOCK_CONTROL_LOG" "$LOG" </dev/null >/dev/null 2>&1 &
  echo $! >> "$MERGE_PIDS"
  disown -a 2>/dev/null || true
}

stop_merge() {
  [[ -f "$MERGE_PIDS" ]] || return 0
  sleep 0.6 # let the followers drain the last shutdown lines
  while read -r pid; do
    [[ -n "$pid" ]] && kill -TERM "$pid" 2>/dev/null || true
  done < "$MERGE_PIDS"
  rm -f "$MERGE_PIDS"
}

current_log() {
  if [[ -L "$LATEST" || -f "$LATEST" ]]; then readlink "$LATEST" 2>/dev/null || echo "$LATEST"; fi
}

# --- commands ---------------------------------------------------------------------------------------
cmd_up() {
  command -v perl >/dev/null || { echo "perl is required for the merged log" >&2; exit 2; }
  command -v bun >/dev/null || { echo "bun is required (https://bun.sh)" >&2; exit 2; }
  if [[ ! -d "$ROOT/node_modules" ]]; then
    echo "node_modules missing; running bun install"
    (cd "$ROOT" && bun install)
  fi
  LOG="$RUN/airlock-$(date -u +%Y%m%d-%H%M%S).log"
  : > "$LOG"
  ln -sfn "$LOG" "$LATEST"
  header
  echo "debug log: $LOG  (also $LATEST)"
  stop_merge
  start_merge
  # dev-up's own progress (image build, web build, URLs) goes to the terminal and the log as [run].
  set +e
  "$ROOT/scripts/dev-up.sh" --detach 2>&1 | prefix run "$LOG" tee
  local rc=${PIPESTATUS[0]}
  set -e
  if [[ $rc -ne 0 ]]; then
    footer "dev-up failed (exit $rc)"
    stop_merge
    echo "start failed; see $LOG" >&2
    exit "$rc"
  fi
  log_line run "runtime image after start: $(image_line)"
  if [[ $DETACH -eq 1 ]]; then
    say run "detached; ./run.sh logs follows $LATEST; ./run.sh down stops the stack"
    return 0
  fi
  say run "foreground; Ctrl-C stops the stack"
  local reason="stopped by signal"
  finish() {
    trap - EXIT INT TERM
    echo
    say run "stopping ($reason)"
    "$ROOT/scripts/dev-down.sh" 2>&1 | prefix run "$LOG" tee
    stop_merge
    footer "$reason"
    kill "$TAIL_PID" 2>/dev/null || true
    echo "debug log: $LOG"
  }
  trap finish EXIT INT TERM
  tail -n +1 -f "$LOG" &
  TAIL_PID=$!
  while alive "$RUN/supervisor.pid" && alive "$RUN/control.pid"; do sleep 1; done
  reason="a process exited"
  exit 1
}

cmd_down() {
  LOG="$(current_log)"
  [[ -n "$LOG" && -f "$LOG" ]] || LOG=""
  "$ROOT/scripts/dev-down.sh" 2>&1 | { if [[ -n "$LOG" ]]; then prefix run "$LOG" tee; else cat; fi; }
  stop_merge
  [[ -n "$LOG" ]] && footer "./run.sh down" && echo "debug log: $LOG"
  return 0
}

cmd_status() {
  local name pidfile
  for name in supervisor control; do
    pidfile="$RUN/$name.pid"
    if alive "$pidfile"; then echo "$name: running (pid $(cat "$pidfile"))"; else echo "$name: not running"; fi
  done
  echo "supervisor health: $(curl -fsS -m 3 "http://127.0.0.1:${SUPERVISOR_PORT:-4300}/health" 2>/dev/null || echo unreachable)"
  echo "control session:   $(curl -fsS -m 3 "http://127.0.0.1:${CONTROL_PORT:-3000}/api/session" 2>/dev/null || echo unreachable)"
  echo "owned containers:"
  owned_containers
  echo "model driver:      $(driver_line)"
  echo "log level:         $AIRLOCK_LOG_LEVEL (this shell); processes use the level they were started with"
  echo "runtime image:     $(image_line)"
  echo "log:               ${LATEST} -> $(current_log || echo none)"
  if [[ -f "$MERGE_PIDS" ]]; then echo "log mergers:       $(tr '\n' ' ' < "$MERGE_PIDS")"; fi
}

cmd_logs() {
  local log
  log="$(current_log)"
  [[ -n "$log" && -f "$log" ]] || { echo "no merged log yet; start with ./run.sh up" >&2; exit 1; }
  exec tail -n 200 -F "$log"
}

require_up() {
  curl -fsS -m 3 -o /dev/null "http://127.0.0.1:${CONTROL_PORT:-3000}/api/session" 2>/dev/null || { echo "the stack is not running; ./run.sh up -d first" >&2; exit 1; }
}

cmd_smoke() { require_up; cd "$ROOT" && bun scripts/smoke.ts "${REST[@]+"${REST[@]}"}"; }
cmd_gate() { require_up; cd "$ROOT" && bun scripts/live-gate.ts "${REST[@]+"${REST[@]}"}"; }

cmd_test() {
  local failed=0
  run_suite() { # name dir command...
    local name="$1" dir="$2"; shift 2
    echo "=== $name ==="
    if (cd "$dir" && "$@"); then echo "=== $name: PASS ==="; else echo "=== $name: FAIL ==="; failed=1; fi
  }
  run_suite "control (bun test)" "$ROOT/apps/control" bun test
  run_suite "supervisor (bun test, DOCKER_HOST=$DOCKER_HOST)" "$ROOT/apps/supervisor" bun test
  run_suite "web (bun test)" "$ROOT/apps/web" bun test
  if command -v uv >/dev/null; then
    run_suite "runtime (pytest)" "$ROOT" uv run --with pytest pytest runtime/python/tests -q
  else
    echo "=== runtime (pytest): SKIPPED, uv not installed ==="; failed=1
  fi
  [[ $failed -eq 0 ]] && echo "all suites passed" || { echo "some suites failed" >&2; exit 1; }
}

cmd_help() { sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; }

case "$CMD" in
  up) cmd_up ;;
  down) cmd_down ;;
  status) cmd_status ;;
  logs) cmd_logs ;;
  smoke) cmd_smoke ;;
  gate) cmd_gate ;;
  test) cmd_test ;;
  help|-h|--help) cmd_help ;;
esac
