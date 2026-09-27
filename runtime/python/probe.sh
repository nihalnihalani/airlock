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
#   --shm-bytes N         /dev/shm may not be larger than N bytes (default 64 MiB, Docker's default)
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
parser.add_argument("--shm-bytes", type=int, default=67108864)
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
# size-capped tmpfs on runc/runsc; Kata shares the host-side tmpfs into the guest over virtio-fs and
# gVisor may present it over 9p. Whatever the type, the mount must be the ROOT of that filesystem
# (mountinfo root "/"): a subtree bind is refused. What the guest cannot see — that the virtio-fs/9p
# share really is the supervisor's volume — the supervisor guarantees from the host side before any
# dispatch (runtime.ts checkEffective/workspaceVolumeBounded): exactly one mount, type volume, the
# attempt's own volume name, at /workspace, and that volume is a `local` tmpfs with exactly
# size=<caps.workspaceBytes>, uid/gid 1000, mode 0755; no binds, devices or other mounts at all.
# UNVERIFIED on Kata: if its guest mountinfo shows a non-"/" root for shared volumes, this refuses
# (fail closed) and the Kata guest's actual line must be recorded before relaxing anything.
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
}
# Under /dev only these named mounts exist in a sandbox (no tty, no devices): anything else under
# /dev, including an extra tmpfs, is REACHED. /dev/shm is size-bounded by --shm-bytes.
DEV_CHILDREN = {
    "/dev/pts": ("devpts",),
    "/dev/mqueue": ("mqueue",),
    "/dev/shm": ("tmpfs",),
}
# The /dev tmpfs itself: Docker creates it at 64 MiB.
DEV_BYTES = 67108864
# Mount points that must be the ROOT of their filesystem (mountinfo field 4 == "/"): a bind of a
# host subtree (a host tmpfs or virtio-fs directory) shows the subtree path there instead.
ROOT_ONLY_POINTS = ("/workspace", "/candidate", "/tmp", "/dev", "/dev/shm", "/dev/pts", "/dev/mqueue", "/proc", "/sys")
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

        if point in ROOT_ONLY_POINTS and root != "/":
            kind = "workspace " if point in ("/workspace", "/candidate") else ""
            problems.append("%s%s is a subtree bind (root %s)" % (kind, what, root))
            continue
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
            elif point == "/dev" and fstype == "tmpfs":
                size = _size_bytes(super_opts)
                if size is None or size > DEV_BYTES:
                    problems.append("/dev tmpfs not bounded to %d bytes: size=%s" % (DEV_BYTES, size))
        elif point in ALLOWED_MOUNT_FILES:
            # Docker's per-container file, bound read-only; the bind's source must be that one file
            # (its mountinfo root ends in the same name), never a host directory such as /etc.
            name = point.rsplit("/", 1)[1]
            if "ro" not in mount_opts:
                problems.append("writable file bind " + what)
            elif not (root.endswith("/" + name) or root.endswith("-" + name)):
                problems.append("file bind from %s at %s" % (root, what))
        elif _under(point, "/dev"):
            if point not in DEV_CHILDREN:
                problems.append("unexpected mount under /dev: " + what)
            elif fstype not in DEV_CHILDREN[point]:
                problems.append("unexpected %s at %s" % (fstype, what))
            elif point == "/dev/shm":
                size = _size_bytes(super_opts)
                if size is None or size > ARGS.shm_bytes:
                    problems.append("/dev/shm not bounded to %d bytes: size=%s" % (ARGS.shm_bytes, size))
        else:
            parent = next((p for p in PSEUDO_CHILDREN if _under(point, p)), None)
            if parent is None:
                problems.append("unexpected mount " + what)
            elif fstype not in PSEUDO_CHILDREN[parent]:
                problems.append("unexpected %s under %s: %s" % (fstype, parent, what))
            elif fstype == "tmpfs" and parent in ("/proc", "/sys") and "ro" not in mount_opts and root != "/null":
                # Docker's masks are read-only tmpfs dirs or its /dev/null; a writable tmpfs is not one.
                problems.append("writable tmpfs under %s: %s" % (parent, what))
            elif fstype in ("cgroup", "cgroup2") and "ro" not in mount_opts:
                # A writable cgroup hierarchy lets the sandbox change its own limits.
                problems.append("writable cgroup: " + what)
    for point in ("/", "/workspace", "/candidate", "/tmp", "/proc", "/sys", "/dev", "/dev/shm") + ALLOWED_MOUNT_FILES:
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
