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
#
# Arguments (fixed by the supervisor):
#   --workspace-bytes N   the owned workspace tmpfs may not be larger than N bytes (default 128 MiB)
# Test-only arguments (never passed by the supervisor; they can only make the result stricter):
#   --mountinfo PATH      classify this mountinfo file instead of /proc/self/mountinfo
#   --only-mounts         skip the network probes; they report UNKNOWN, so allBlocked is false
set -u
PY_BIN=/usr/local/bin/python3   # the runtime image's interpreter
[[ -x "$PY_BIN" ]] || PY_BIN="$(command -v python3 || true)"
if [[ -z "$PY_BIN" ]]; then
  echo '{"metadataEndpoint":"UNKNOWN","dns":"UNKNOWN","outboundTcp":"UNKNOWN","dockerSocket":"UNKNOWN","hostMounts":"UNKNOWN","allBlocked":false,"details":{"error":"python3 not found"}}'
  exit 3
fi
exec "$PY_BIN" -I -S - "$@" <<'PY'
import argparse
import datetime
import json
import os
import socket
import sys
import urllib.error
import urllib.request

parser = argparse.ArgumentParser(add_help=False)
parser.add_argument("--workspace-bytes", type=int, default=134217728)
parser.add_argument("--mountinfo", default="/proc/self/mountinfo")
parser.add_argument("--only-mounts", action="store_true")
ARGS, _unknown = parser.parse_known_args(sys.argv[1:])

TIMEOUT = 2.0
METADATA_URL = "http://169.254.169.254/v1.json"
DNS_NAME = "example.com"
TCP_TARGET = ("1.1.1.1", 443)
DOCKER_SOCKETS = ("/var/run/docker.sock", "/run/docker.sock")
# The sandbox's expected mounts, each by mount point AND filesystem type (no subtree is exempt).
# Anything else, or an expected mount point with an unexpected type, size or duplicate, is REACHED.
TMP_BYTES = 67108864  # the supervisor's /tmp tmpfs (runtime.ts TMPFS_TMP)
# Root filesystem: overlay (runc), 9p/overlay (gVisor), virtio-fs (Kata). The supervisor also
# checks it is read-only from outside.
ROOT_TYPES = ("overlay", "9p", "virtiofs", "fuse.virtiofs", "rootfs")
# The single owned workspace volume (/workspace, or /candidate read-only for the collector): a
# size-capped tmpfs on runc/runsc; Kata shares the host-side tmpfs into the guest over virtio-fs.
WORKSPACE_TYPES = ("tmpfs", "virtiofs", "fuse.virtiofs", "9p")
# Pseudo-filesystems and their standard sub-mounts (Docker masks /proc and /sys entries with
# read-only tmpfs or with its own /dev/null, which shows up as the /dev tmpfs with root "/null").
PSEUDO = {
    "/proc": ("proc",),
    "/sys": ("sysfs",),
    "/dev": ("tmpfs", "devtmpfs"),
}
PSEUDO_CHILDREN = {
    "/proc": ("proc", "tmpfs"),
    "/sys": ("sysfs", "cgroup", "cgroup2", "tmpfs"),
    "/dev": ("devpts", "mqueue", "tmpfs"),
}
# Docker writes these per-container files on the host and bind-mounts them into every container,
# including ones on --network none. Exactly these three file paths; any filesystem type.
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


def _unescape(field):
    # /proc/self/mountinfo escapes space, tab, newline and backslash as octal sequences.
    for seq, ch in (("\\040", " "), ("\\011", "\t"), ("\\012", "\n"), ("\\134", "\\")):
        field = field.replace(seq, ch)
    return field


def _size_bytes(super_opts):
    for opt in super_opts.split(","):
        if opt.startswith("size="):
            value = opt[5:]
            unit = 1
            if value[-1:].lower() in ("k", "m", "g"):
                unit = {"k": 1024, "m": 1024 ** 2, "g": 1024 ** 3}[value[-1].lower()]
                value = value[:-1]
            try:
                return int(value) * unit
            except ValueError:
                return None
    return None


def _under(point, parent):
    return point.startswith(parent + "/")


def classify_mounts(lines, workspace_bytes):
    """Return a list of human-readable problems; empty means only the expected sandbox mounts."""
    problems = []
    seen = {}
    workspace_points = []
    for line in lines:
        parts = line.split(" ")
        if len(parts) < 7 or "-" not in parts[6:]:
            problems.append("unparseable mountinfo line")
            continue
        sep = parts.index("-", 6)
        if len(parts) < sep + 3:
            problems.append("unparseable mountinfo line")
            continue
        root = _unescape(parts[3])
        point = _unescape(parts[4])
        mount_opts = parts[5].split(",")
        fstype = parts[sep + 1]
        source = _unescape(parts[sep + 2])
        super_opts = parts[sep + 3] if len(parts) > sep + 3 else ""
        seen[point] = seen.get(point, 0) + 1
        what = "%s (%s from %s)" % (point, fstype, source)

        if point == "/":
            if fstype not in ROOT_TYPES:
                problems.append("rootfs " + what)
        elif point in ("/workspace", "/candidate"):
            workspace_points.append(point)
            if fstype not in WORKSPACE_TYPES:
                problems.append("workspace " + what)
            elif fstype == "tmpfs":
                size = _size_bytes(super_opts)
                if size is None or size > workspace_bytes:
                    problems.append("workspace tmpfs not bounded to %d bytes: %s size=%s" % (workspace_bytes, point, size))
        elif point == "/tmp":
            size = _size_bytes(super_opts)
            if fstype != "tmpfs" or size is None or size > TMP_BYTES or "noexec" not in mount_opts:
                problems.append("tmp " + what + " size=%s" % size)
        elif point in PSEUDO:
            if fstype not in PSEUDO[point]:
                problems.append("pseudo-fs " + what)
        elif point in ALLOWED_MOUNT_FILES:
            pass
        else:
            parent = next((p for p in PSEUDO_CHILDREN if _under(point, p)), None)
            if parent is None:
                problems.append("unexpected mount " + what)
            elif fstype not in PSEUDO_CHILDREN[parent]:
                problems.append("unexpected %s under %s: %s" % (fstype, parent, what))
            elif fstype == "tmpfs" and parent in ("/proc", "/sys") and "ro" not in mount_opts and root != "/null":
                # Docker's masks are read-only tmpfs dirs or its /dev/null; a writable tmpfs is not one.
                problems.append("writable tmpfs under %s: %s" % (parent, what))
    for point in ("/", "/workspace", "/candidate", "/tmp", "/proc", "/sys", "/dev"):
        if seen.get(point, 0) > 1:
            problems.append("stacked mounts at %s (%d)" % (point, seen[point]))
    if len(set(workspace_points)) > 1:
        problems.append("both /workspace and /candidate are mounted")
    return problems


def probe_host_mounts():
    try:
        with open(ARGS.mountinfo, "r", encoding="utf-8", errors="replace") as fh:
            lines = [l for l in fh.read().splitlines() if l.strip()]
    except OSError as exc:
        details["hostMounts"] = "mountinfo unreadable: %s" % str(exc)[:200]
        return UNKNOWN
    if not lines:
        details["hostMounts"] = "mountinfo empty"
        return UNKNOWN
    problems = classify_mounts(lines, ARGS.workspace_bytes)
    details["hostMounts"] = problems[:50] if problems else "only sandbox mounts"
    return REACHED if problems else BLOCKED


socket.setdefaulttimeout(TIMEOUT)
if ARGS.only_mounts:
    network = {"metadataEndpoint": UNKNOWN, "dns": UNKNOWN, "outboundTcp": UNKNOWN, "dockerSocket": UNKNOWN}
    details["network"] = "skipped (--only-mounts)"
else:
    network = {"metadataEndpoint": probe_metadata(), "dns": probe_dns(), "outboundTcp": probe_tcp(), "dockerSocket": probe_docker_socket()}
result = {
    "probedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
    **network,
    "hostMounts": probe_host_mounts(),
}
result["allBlocked"] = all(result[k] == BLOCKED for k in ("metadataEndpoint", "dns", "outboundTcp", "dockerSocket", "hostMounts"))
result["details"] = details
sys.stdout.write(json.dumps(result, separators=(",", ":")) + "\n")
sys.stdout.flush()
sys.exit(0 if result["allBlocked"] else 3)
PY
