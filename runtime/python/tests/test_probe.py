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
        "315 305 0:46 / /workspace rw,relatime - virtiofs kataShared rw",
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
    # Review findings (milestone 2): each was reported BLOCKED before the fix.
    "host tmpfs subtree bound at /workspace": RUNC_MOUNTINFO.replace(
        "315 305 0:46 / /workspace rw,relatime master:211 - tmpfs tmpfs rw,size=131072k",
        "315 305 0:46 /host/secrets /workspace rw,relatime master:211 - tmpfs tmpfs rw,size=131072k",
    ),
    "virtiofs host dir bound at /workspace": RUNC_MOUNTINFO.replace(
        "315 305 0:46 / /workspace rw,relatime master:211 - tmpfs tmpfs rw,size=131072k,mode=755,uid=1000,gid=1000,inode64",
        "315 305 0:46 /home/ubuntu /workspace rw,relatime - virtiofs kataShared rw",
    ),
    "host tmpfs subtree bound at /tmp": RUNC_MOUNTINFO.replace("314 305 0:58 / /tmp", "314 305 0:58 /run/user /tmp"),
    "8 GiB /dev/shm": RUNC_MOUNTINFO.replace("/dev/shm rw,nosuid,nodev,noexec,relatime - tmpfs shm rw,size=65536k", "/dev/shm rw,nosuid,nodev,noexec,relatime - tmpfs shm rw,size=8g"),
    "unbounded /dev/shm": RUNC_MOUNTINFO.replace("- tmpfs shm rw,size=65536k,inode64", "- tmpfs shm rw,inode64"),
    "extra tmpfs under /dev": RUNC_MOUNTINFO + "410 308 0:73 / /dev/cache rw,nosuid - tmpfs tmpfs rw,size=1k\n",
    "oversized /dev tmpfs": RUNC_MOUNTINFO.replace("/dev rw,nosuid - tmpfs tmpfs rw,size=65536k", "/dev rw,nosuid - tmpfs tmpfs rw,size=4g"),
    "host /etc bound at /etc/hosts": RUNC_MOUNTINFO.replace(
        "318 305 253:17 /docker/containers/4a9a/hosts /etc/hosts ro,relatime",
        "318 305 253:17 /etc /etc/hosts ro,relatime",
    ),
    "writable /etc/hosts bind": RUNC_MOUNTINFO.replace("/docker/containers/4a9a/hosts /etc/hosts ro,relatime", "/docker/containers/4a9a/hosts /etc/hosts rw,relatime"),
    "read-write cgroup2": RUNC_MOUNTINFO.replace("/ /sys/fs/cgroup ro,nosuid,nodev,noexec,relatime - cgroup2", "/ /sys/fs/cgroup rw,nosuid,nodev,noexec,relatime - cgroup2"),
}


@pytest.mark.parametrize("name", sorted(REACHED_VARIANTS))
def test_unexpected_mounts_are_reached(runtime_dir: Path, tmp_path: Path, name: str):
    result = _mounts(runtime_dir, tmp_path, REACHED_VARIANTS[name])
    assert result["hostMounts"] == "REACHED", (name, result["details"])
    assert isinstance(result["details"]["hostMounts"], list) and result["details"]["hostMounts"]


def test_workspace_bound_follows_the_supervisor_argument(runtime_dir: Path, tmp_path: Path):
    assert _mounts(runtime_dir, tmp_path, RUNC_MOUNTINFO, "--workspace-bytes", str(134217728))["hostMounts"] == "BLOCKED"
    assert _mounts(runtime_dir, tmp_path, RUNC_MOUNTINFO, "--workspace-bytes", str(64 * 1024 * 1024))["hostMounts"] == "REACHED"


def test_shm_bound_follows_the_supervisor_argument(runtime_dir: Path, tmp_path: Path):
    assert _mounts(runtime_dir, tmp_path, RUNC_MOUNTINFO, "--shm-bytes", str(64 * 1024 * 1024))["hostMounts"] == "BLOCKED"
    assert _mounts(runtime_dir, tmp_path, RUNC_MOUNTINFO, "--shm-bytes", str(32 * 1024 * 1024))["hostMounts"] == "REACHED"


def test_no_subtree_exemption_remains(runtime_dir: Path):
    text = (runtime_dir / "probe.sh").read_text()
    assert "ALLOWED_MOUNT_ROOTS" not in text


# Measured on the VX1 host under Kata (guest kernel 6.18.35), 27 Sep 2026: a real author sandbox's
# mountinfo, as the supervisor creates it (read-only rootfs over virtio-fs, tmpfs workspace shared in).
KATA_VX1_MOUNTINFO = """73 46 0:35 / / ro,nodev,relatime master:22 - virtiofs none rw
74 73 0:36 / /proc rw,nosuid,nodev,noexec,relatime - proc proc rw
75 73 0:37 / /dev rw,nosuid - tmpfs tmpfs rw,size=65536k,mode=755
76 75 0:38 / /dev/pts rw,nosuid,noexec,relatime - devpts devpts rw,gid=5,mode=620,ptmxmode=666
77 73 0:21 / /sys ro,nosuid,nodev,noexec,relatime - sysfs sysfs rw
78 77 0:26 / /sys/fs/cgroup ro,nosuid,nodev,noexec,relatime - cgroup2 cgroup2 rw,nsdelegate,memory_recursiveprot
79 75 0:32 / /dev/mqueue rw,nosuid,nodev,noexec,relatime - mqueue mqueue rw
80 75 0:34 / /dev/shm rw,relatime master:21 - tmpfs shm rw
81 73 0:39 / /tmp rw,nosuid,nodev,noexec,relatime - tmpfs tmpfs rw,size=65536k
83 73 0:40 / /workspace rw,relatime - virtiofs none rw
84 73 0:33 /81f3e754-e68b0c7cb9120239-hostname /etc/hostname ro,relatime - virtiofs kataShared rw
85 73 0:33 /81f3e754-11d3f9074a20c122-hosts /etc/hosts ro,relatime - virtiofs kataShared rw
86 73 0:33 /81f3e754-2e9eb70638428f8b-resolv.conf /etc/resolv.conf ro,relatime - virtiofs kataShared rw
47 74 0:37 /null /proc/interrupts rw,nosuid - tmpfs tmpfs rw,size=65536k,mode=755
48 74 0:37 /null /proc/keys rw,nosuid - tmpfs tmpfs rw,size=65536k,mode=755
49 74 0:37 /null /proc/timer_list rw,nosuid - tmpfs tmpfs rw,size=65536k,mode=755
50 74 0:36 /bus /proc/bus ro,relatime - proc proc rw
51 74 0:36 /fs /proc/fs ro,relatime - proc proc rw
52 74 0:36 /irq /proc/irq ro,relatime - proc proc rw
53 74 0:36 /sys /proc/sys ro,relatime - proc proc rw
"""


def test_kata_vx1_guest_unsized_shm_needs_the_guest_vm_flag(runtime_dir: Path, tmp_path: Path):
    # Without the supervisor's guest-VM flag the unsized /dev/shm is refused (fail closed) ...
    refused = _mounts(runtime_dir, tmp_path, KATA_VX1_MOUNTINFO)
    assert refused["hostMounts"] == "REACHED"
    assert any("/dev/shm" in d for d in refused["details"]["hostMounts"])
    # ... and with it (the supervisor inspected runtime=kata) the measured Kata layout is BLOCKED.
    assert _mounts(runtime_dir, tmp_path, KATA_VX1_MOUNTINFO, "--guest-vm")["hostMounts"] == "BLOCKED"


def _meminfo(tmp_path: Path, kib: int) -> str:
    path = tmp_path / "meminfo"
    path.write_text(f"MemTotal:       {kib} kB\nMemFree:        1000 kB\n")
    return str(path)


# With the supervisor's real limits (512 MiB, 64 PIDs) Kata sized the guest /dev/shm at 984636 KiB,
# about half of the guest's RAM (measured on VX1). The bound there is the guest's MemTotal.
def test_guest_vm_shm_sized_by_kata_within_guest_ram_is_blocked(runtime_dir: Path, tmp_path: Path):
    sized = KATA_VX1_MOUNTINFO.replace("- tmpfs shm rw\n", "- tmpfs shm rw,size=984636k,nr_inodes=246159\n")
    mem = _meminfo(tmp_path, 1969272)
    assert _mounts(runtime_dir, tmp_path, sized, "--guest-vm", "--meminfo", mem)["hostMounts"] == "BLOCKED"
    assert _mounts(runtime_dir, tmp_path, sized, "--meminfo", mem)["hostMounts"] == "REACHED"  # not a guest VM


def test_guest_vm_flag_never_accepts_an_oversized_or_foreign_shm(runtime_dir: Path, tmp_path: Path):
    mem = _meminfo(tmp_path, 1969272)
    big = KATA_VX1_MOUNTINFO.replace("- tmpfs shm rw\n", "- tmpfs shm rw,size=8388608k\n")
    assert _mounts(runtime_dir, tmp_path, big, "--guest-vm", "--meminfo", mem)["hostMounts"] == "REACHED"
    bound = KATA_VX1_MOUNTINFO.replace("0:34 / /dev/shm", "0:34 /host/dir /dev/shm")
    assert _mounts(runtime_dir, tmp_path, bound, "--guest-vm", "--meminfo", mem)["hostMounts"] == "REACHED"
    # An unreadable guest meminfo refuses a sized shm (fail closed).
    sized = KATA_VX1_MOUNTINFO.replace("- tmpfs shm rw\n", "- tmpfs shm rw,size=984636k\n")
    assert _mounts(runtime_dir, tmp_path, sized, "--guest-vm", "--meminfo", str(tmp_path / "missing"))["hostMounts"] == "REACHED"
