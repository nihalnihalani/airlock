"""probe.sh: output parses to the IsolationProbe shape with only the three allowed values."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

KEYS = ("metadataEndpoint", "dns", "outboundTcp", "dockerSocket", "hostMounts")
VALUES = {"BLOCKED", "REACHED", "UNKNOWN"}


def test_probe_output_parses_and_is_consistent(runtime_dir: Path):
    # On a developer machine with network access the probe is expected to report REACHED for some
    # checks; the contract here is the shape, the enum and the allBlocked derivation. The blocked
    # case is asserted in the Docker integration test.
    proc = subprocess.run(["bash", str(runtime_dir / "probe.sh")], capture_output=True, text=True, timeout=60)
    lines = proc.stdout.strip().splitlines()
    assert len(lines) == 1, proc.stdout + proc.stderr
    result = json.loads(lines[0])
    for key in KEYS:
        assert result[key] in VALUES, key
    assert isinstance(result["allBlocked"], bool)
    assert result["allBlocked"] == all(result[k] == "BLOCKED" for k in KEYS)
    assert proc.returncode == (0 if result["allBlocked"] else 3)
    assert result["probedAt"].endswith("Z")
    assert isinstance(result["details"], dict)


def test_probe_has_no_curl_dependency(runtime_dir: Path):
    text = (runtime_dir / "probe.sh").read_text()
    assert "curl" not in text.replace("no curl assumed", "")
    assert "-I -S" in text


# -------------------------------------------------------------------------------------------------
# D12: no subtree is exempt from the mount check. A real runc sandbox's mountinfo (captured from a
# container created with the supervisor's flags) is the baseline; each variant adds or changes one
# mount and must turn hostMounts into REACHED.
# -------------------------------------------------------------------------------------------------

RUNC_MOUNTINFO = """\
305 232 0:42 / / ro,relatime - overlay overlay rw,lowerdir=/var/lib/containerd/snapshots/1/fs,upperdir=/var/lib/containerd/snapshots/2/fs,workdir=/var/lib/containerd/snapshots/2/work
307 305 0:53 / /proc rw,nosuid,nodev,noexec,relatime - proc proc rw
308 305 0:54 / /dev rw,nosuid - tmpfs tmpfs rw,size=65536k,mode=755,inode64
309 308 0:55 / /dev/pts rw,nosuid,noexec,relatime - devpts devpts rw,gid=5,mode=620,ptmxmode=666
310 305 0:56 / /sys ro,nosuid,nodev,noexec,relatime - sysfs sysfs ro
311 310 0:30 / /sys/fs/cgroup ro,nosuid,nodev,noexec,relatime - cgroup2 cgroup rw,nsdelegate,memory_recursiveprot
312 308 0:51 / /dev/mqueue rw,nosuid,nodev,noexec,relatime - mqueue mqueue rw
313 308 0:57 / /dev/shm rw,nosuid,nodev,noexec,relatime - tmpfs shm rw,size=65536k,inode64
314 305 0:58 / /tmp rw,nosuid,nodev,noexec,relatime - tmpfs tmpfs rw,size=65536k,inode64
315 305 0:46 / /workspace rw,relatime master:211 - tmpfs tmpfs rw,size=131072k,mode=755,uid=1000,gid=1000,inode64
316 305 253:17 /docker/containers/4a9a/resolv.conf /etc/resolv.conf ro,relatime - ext4 /dev/vdb1 rw
317 305 253:17 /docker/containers/4a9a/hostname /etc/hostname ro,relatime - ext4 /dev/vdb1 rw
318 305 253:17 /docker/containers/4a9a/hosts /etc/hosts ro,relatime - ext4 /dev/vdb1 rw
233 307 0:53 /bus /proc/bus ro,nosuid,nodev,noexec,relatime - proc proc rw
236 307 0:53 /sys /proc/sys ro,nosuid,nodev,noexec,relatime - proc proc rw
238 307 0:59 / /proc/acpi ro,relatime - tmpfs tmpfs ro,inode64
273 307 0:54 /null /proc/kcore rw,nosuid - tmpfs tmpfs rw,size=65536k,mode=755,inode64
277 307 0:60 / /proc/scsi ro,relatime - tmpfs tmpfs ro,inode64
278 310 0:61 / /sys/firmware ro,relatime - tmpfs tmpfs ro,inode64
"""


def _mounts(runtime_dir: Path, tmp_path: Path, mountinfo: str, *extra: str) -> dict:
    path = tmp_path / "mountinfo"
    path.write_text(mountinfo)
    proc = subprocess.run(
        ["bash", str(runtime_dir / "probe.sh"), "--only-mounts", "--mountinfo", str(path), *extra],
        capture_output=True, text=True, timeout=30,
    )
    result = json.loads(proc.stdout.strip().splitlines()[-1])
    # --only-mounts can never produce a passing probe
    assert result["allBlocked"] is False
    assert all(result[k] == "UNKNOWN" for k in ("metadataEndpoint", "dns", "outboundTcp", "dockerSocket"))
    return result


def test_real_runc_sandbox_mounts_are_blocked(runtime_dir: Path, tmp_path: Path):
    result = _mounts(runtime_dir, tmp_path, RUNC_MOUNTINFO)
    assert result["hostMounts"] == "BLOCKED", result["details"]


def test_collector_candidate_mount_is_blocked(runtime_dir: Path, tmp_path: Path):
    info = RUNC_MOUNTINFO.replace(" / /workspace rw,", " / /candidate ro,")
    assert _mounts(runtime_dir, tmp_path, info)["hostMounts"] == "BLOCKED"


def test_kata_virtiofs_workspace_is_blocked(runtime_dir: Path, tmp_path: Path):
    info = RUNC_MOUNTINFO.replace(
        "315 305 0:46 / /workspace rw,relatime master:211 - tmpfs tmpfs rw,size=131072k,mode=755,uid=1000,gid=1000,inode64",
        "315 305 0:46 /abc /workspace rw,relatime - virtiofs kataShared rw",
    )
    assert _mounts(runtime_dir, tmp_path, info)["hostMounts"] == "BLOCKED"


import pytest  # noqa: E402

REACHED_VARIANTS = {
    # a host block-device bind at a new path
    "host bind elsewhere": RUNC_MOUNTINFO + "400 305 253:17 /srv/data /data rw,relatime - ext4 /dev/vdb1 rw\n",
    # a host bind INSIDE the formerly exempt subtrees
    "bind under /workspace": RUNC_MOUNTINFO + "401 315 253:17 /home /workspace/src rw,relatime - ext4 /dev/vdb1 rw\n",
    "bind under /tmp": RUNC_MOUNTINFO + "402 314 253:17 /var /tmp/x rw,relatime - xfs /dev/sda1 rw\n",
    "bind under /dev": RUNC_MOUNTINFO + "403 308 253:17 /var/run /dev/host rw,relatime - ext4 /dev/vdb1 rw\n",
    "virtiofs under /sys": RUNC_MOUNTINFO + "404 310 0:70 / /sys/host rw - virtiofs kataShared rw\n",
    "docker socket dir under /proc": RUNC_MOUNTINFO + "405 307 0:24 /docker /proc/driver rw - tmpfs tmpfs rw\n",
    # the workspace itself replaced by a host-backed filesystem
    "ext4 workspace": RUNC_MOUNTINFO.replace("- tmpfs tmpfs rw,size=131072k,mode=755,uid=1000,gid=1000,inode64", "- ext4 /dev/vdb1 rw"),
    "oversized workspace tmpfs": RUNC_MOUNTINFO.replace("size=131072k,mode=755,uid=1000", "size=1g,mode=755,uid=1000"),
    "unbounded workspace tmpfs": RUNC_MOUNTINFO.replace("rw,size=131072k,mode=755,uid=1000", "rw,mode=755,uid=1000"),
    "tmp without size": RUNC_MOUNTINFO.replace("- tmpfs tmpfs rw,size=65536k,inode64\n315", "- tmpfs tmpfs rw,inode64\n315"),
    "tmp is ext4": RUNC_MOUNTINFO.replace("/tmp rw,nosuid,nodev,noexec,relatime - tmpfs tmpfs rw,size=65536k", "/tmp rw,nosuid,nodev,noexec,relatime - ext4 /dev/vdb1 rw,size=65536k"),
    "tmp executable": RUNC_MOUNTINFO.replace("/tmp rw,nosuid,nodev,noexec,relatime", "/tmp rw,nosuid,nodev,relatime"),
    "proc is a bind": RUNC_MOUNTINFO.replace("/ /proc rw,nosuid,nodev,noexec,relatime - proc proc rw", "/ /proc rw - ext4 /dev/vdb1 rw"),
    "writable tmpfs under /proc": RUNC_MOUNTINFO + "406 307 0:71 / /proc/foo rw,relatime - tmpfs tmpfs rw\n",
    "stacked workspace": RUNC_MOUNTINFO + "407 315 253:17 /x /workspace rw - tmpfs tmpfs rw,size=1k\n",
    "both workspace and candidate": RUNC_MOUNTINFO + "408 305 0:72 / /candidate ro - tmpfs tmpfs ro,size=1k\n",
    "rootfs is a host disk": RUNC_MOUNTINFO.replace("/ / ro,relatime - overlay overlay", "/ / ro,relatime - ext4 /dev/vdb1"),
    "bind at another /etc file": RUNC_MOUNTINFO + "409 305 253:17 /etc/shadow /etc/shadow ro - ext4 /dev/vdb1 rw\n",
}


@pytest.mark.parametrize("name", sorted(REACHED_VARIANTS))
def test_unexpected_mounts_are_reached(runtime_dir: Path, tmp_path: Path, name: str):
    result = _mounts(runtime_dir, tmp_path, REACHED_VARIANTS[name])
    assert result["hostMounts"] == "REACHED", (name, result["details"])
    assert isinstance(result["details"]["hostMounts"], list) and result["details"]["hostMounts"]


def test_workspace_bound_follows_the_supervisor_argument(runtime_dir: Path, tmp_path: Path):
    assert _mounts(runtime_dir, tmp_path, RUNC_MOUNTINFO, "--workspace-bytes", str(134217728))["hostMounts"] == "BLOCKED"
    assert _mounts(runtime_dir, tmp_path, RUNC_MOUNTINFO, "--workspace-bytes", str(64 * 1024 * 1024))["hostMounts"] == "REACHED"


def test_no_subtree_exemption_remains(runtime_dir: Path):
    text = (runtime_dir / "probe.sh").read_text()
    assert "ALLOWED_MOUNT_ROOTS" not in text
