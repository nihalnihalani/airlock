#!/bin/bash
# Airlock isolation probe (checkpoint 4). Runs INSIDE the sandbox before any agent work.
#
# Prints one JSON object:
#   {"probedAt": iso, "metadataEndpoint": R, "dns": R, "outboundTcp": R, "dockerSocket": R,
#    "hostMounts": R, "allBlocked": bool, "details": {...}}
# where R is "BLOCKED" | "REACHED" | "UNKNOWN". The supervisor refuses the run unless allBlocked.
#
# Python stdlib only (no curl assumed), 2-second timeouts, isolated interpreter (-I -S) so nothing
# in the workspace or user site can influence the result. The probe is untrusted output like any
# other sandbox output: the supervisor still inspects the container configuration itself.
set -u
PY_BIN=/usr/local/bin/python3   # the runtime image's interpreter
[[ -x "$PY_BIN" ]] || PY_BIN="$(command -v python3 || true)"
if [[ -z "$PY_BIN" ]]; then
  echo '{"metadataEndpoint":"UNKNOWN","dns":"UNKNOWN","outboundTcp":"UNKNOWN","dockerSocket":"UNKNOWN","hostMounts":"UNKNOWN","allBlocked":false,"details":{"error":"python3 not found"}}'
  exit 3
fi
exec "$PY_BIN" -I -S - "$@" <<'PY'
import datetime
import json
import os
import socket
import sys
import urllib.error
import urllib.request

TIMEOUT = 2.0
METADATA_URL = "http://169.254.169.254/v1.json"
DNS_NAME = "example.com"
TCP_TARGET = ("1.1.1.1", 443)
DOCKER_SOCKETS = ("/var/run/docker.sock", "/run/docker.sock")
# Mount points that are part of the sandbox's own shape. Everything else is a host mount.
ALLOWED_MOUNT_ROOTS = ("/", "/workspace", "/candidate", "/tmp", "/proc", "/sys", "/dev")
# Docker writes these per-container files and bind-mounts them into every container, including
# ones on --network none. They are not host directories.
ALLOWED_MOUNT_FILES = ("/etc/hosts", "/etc/hostname", "/etc/resolv.conf")

BLOCKED, REACHED, UNKNOWN = "BLOCKED", "REACHED", "UNKNOWN"
details = {}


def probe_metadata():
    try:
        req = urllib.request.Request(METADATA_URL, headers={"User-Agent": "airlock-probe"})
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            details["metadataEndpoint"] = "http %s" % resp.status
            return REACHED
    except urllib.error.HTTPError as exc:
        details["metadataEndpoint"] = "http %s" % exc.code
        return REACHED  # any HTTP answer means the endpoint is reachable
    except (urllib.error.URLError, OSError, socket.timeout) as exc:
        details["metadataEndpoint"] = str(getattr(exc, "reason", exc))[:200]
        return BLOCKED
    except Exception as exc:  # noqa: BLE001
        details["metadataEndpoint"] = "unexpected %s: %s" % (type(exc).__name__, str(exc)[:200])
        return UNKNOWN


def probe_dns():
    try:
        infos = socket.getaddrinfo(DNS_NAME, 443, proto=socket.IPPROTO_TCP)
        details["dns"] = "resolved %d addresses" % len(infos)
        return REACHED
    except (socket.gaierror, socket.timeout, OSError) as exc:
        details["dns"] = str(exc)[:200]
        return BLOCKED
    except Exception as exc:  # noqa: BLE001
        details["dns"] = "unexpected %s: %s" % (type(exc).__name__, str(exc)[:200])
        return UNKNOWN


def probe_tcp():
    try:
        with socket.create_connection(TCP_TARGET, timeout=TIMEOUT):
            details["outboundTcp"] = "connected %s:%d" % TCP_TARGET
            return REACHED
    except (OSError, socket.timeout) as exc:
        details["outboundTcp"] = str(exc)[:200]
        return BLOCKED
    except Exception as exc:  # noqa: BLE001
        details["outboundTcp"] = "unexpected %s: %s" % (type(exc).__name__, str(exc)[:200])
        return UNKNOWN


def probe_docker_socket():
    try:
        present = [p for p in DOCKER_SOCKETS if os.path.lexists(p)]
        details["dockerSocket"] = present or "absent"
        return REACHED if present else BLOCKED
    except Exception as exc:  # noqa: BLE001
        details["dockerSocket"] = "unexpected %s: %s" % (type(exc).__name__, str(exc)[:200])
        return UNKNOWN


def _allowed_mount(point):
    if point in ALLOWED_MOUNT_FILES:
        return True
    for root in ALLOWED_MOUNT_ROOTS:
        if point == root or (root != "/" and point.startswith(root + "/")):
            return True
    return False


def _unescape(field):
    # /proc/self/mountinfo escapes space, tab, newline and backslash as octal sequences.
    for seq, ch in (("\\040", " "), ("\\011", "\t"), ("\\012", "\n"), ("\\134", "\\")):
        field = field.replace(seq, ch)
    return field


def probe_host_mounts():
    try:
        with open("/proc/self/mountinfo", "r", encoding="utf-8", errors="replace") as fh:
            lines = fh.read().splitlines()
    except OSError as exc:
        details["hostMounts"] = "mountinfo unreadable: %s" % str(exc)[:200]
        return UNKNOWN
    foreign = []
    for line in lines:
        parts = line.split(" ")
        if len(parts) < 5:
            continue
        point = _unescape(parts[4])
        if not _allowed_mount(point):
            foreign.append(point)
    details["hostMounts"] = foreign[:50] if foreign else "only sandbox mounts"
    return REACHED if foreign else BLOCKED


socket.setdefaulttimeout(TIMEOUT)
result = {
    "probedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
    "metadataEndpoint": probe_metadata(),
    "dns": probe_dns(),
    "outboundTcp": probe_tcp(),
    "dockerSocket": probe_docker_socket(),
    "hostMounts": probe_host_mounts(),
}
result["allBlocked"] = all(result[k] == BLOCKED for k in ("metadataEndpoint", "dns", "outboundTcp", "dockerSocket", "hostMounts"))
result["details"] = details
sys.stdout.write(json.dumps(result, separators=(",", ":")) + "\n")
sys.stdout.flush()
sys.exit(0 if result["allBlocked"] else 3)
PY
