// Parity: runtime/node/probe.mjs must classify mounts exactly like runtime/python/probe.sh and print
// the same JSON shape. Runs on the host:  node --test runtime/node/tests/
// (needs bash + python3 for the reference probe.sh).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PY_PROBE = join(HERE, "..", "..", "python", "probe.sh");
const NODE_PROBE = join(HERE, "..", "probe.mjs");

const BASE = `305 232 0:42 / / ro,relatime - overlay overlay rw,lowerdir=/a,upperdir=/b,workdir=/c
307 305 0:53 / /proc rw,nosuid,nodev,noexec,relatime - proc proc rw
308 305 0:54 / /dev rw,nosuid - tmpfs tmpfs rw,size=65536k,mode=755,inode64
309 308 0:55 / /dev/pts rw,nosuid,noexec,relatime - devpts devpts rw,gid=5,mode=620,ptmxmode=666
310 305 0:56 / /sys ro,nosuid,nodev,noexec,relatime - sysfs sysfs ro
311 310 0:30 / /sys/fs/cgroup ro,nosuid,nodev,noexec,relatime - cgroup2 cgroup rw,nsdelegate
312 308 0:51 / /dev/mqueue rw,nosuid,nodev,noexec,relatime - mqueue mqueue rw
313 308 0:57 / /dev/shm rw,nosuid,nodev,noexec,relatime - tmpfs shm rw,size=65536k,inode64
314 305 0:58 / /tmp rw,nosuid,nodev,noexec,relatime - tmpfs tmpfs rw,size=65536k,inode64
315 305 0:46 / /workspace rw,relatime master:211 - tmpfs tmpfs rw,size=131072k,mode=755,uid=1000,gid=1000,inode64
316 305 253:17 /docker/containers/4a9a/resolv.conf /etc/resolv.conf ro,relatime - ext4 /dev/vdb1 rw
317 305 253:17 /docker/containers/4a9a/hostname /etc/hostname ro,relatime - ext4 /dev/vdb1 rw
318 305 253:17 /docker/containers/4a9a/hosts /etc/hosts ro,relatime - ext4 /dev/vdb1 rw
233 307 0:53 /bus /proc/bus ro,nosuid,nodev,noexec,relatime - proc proc rw
238 307 0:59 / /proc/acpi ro,relatime - tmpfs tmpfs ro,inode64
273 307 0:54 /null /proc/kcore rw,nosuid - tmpfs tmpfs rw,size=65536k,mode=755,inode64
278 310 0:61 / /sys/firmware ro,relatime - tmpfs tmpfs ro,inode64
`;

const VARIANTS = {
  baseline: BASE,
  candidateInsteadOfWorkspace: BASE.replace(" /workspace ", " /candidate "),
  hostBind: BASE + "400 305 253:17 /home/u /data rw - ext4 /dev/vdb1 rw\n",
  bindUnderWorkspace: BASE + "401 315 253:17 /x /workspace/x rw - ext4 /dev/vdb1 rw\n",
  diskWorkspace: BASE.replace("- tmpfs tmpfs rw,size=131072k,mode=755,uid=1000", "- ext4 /dev/vdb1 rw,size=131072k,mode=755,uid=1000"),
  bigWorkspace: BASE.replace("size=131072k,mode=755,uid", "size=1g,mode=755,uid"),
  unboundedWorkspace: BASE.replace("rw,size=131072k,mode=755,uid", "rw,mode=755,uid"),
  execTmp: BASE.replace("/tmp rw,nosuid,nodev,noexec,relatime", "/tmp rw,nosuid,nodev,relatime"),
  stacked: BASE + "402 305 0:47 / /workspace rw - tmpfs tmpfs rw,size=1024k\n",
  both: BASE + "403 305 0:48 / /candidate ro - tmpfs tmpfs rw,size=1024k\n",
  unparseable: BASE + "garbage line\n",
  writableProcTmpfs: BASE + "404 307 0:62 / /proc/evil rw,relatime - tmpfs tmpfs rw\n",
  escapedSpace: BASE + "405 305 0:63 / /my\\040dir rw - tmpfs tmpfs rw,size=1k\n",
  badRoot: BASE.replace("- overlay overlay", "- ext4 /dev/vda1"),
  sockUnderDev: BASE + "406 308 253:17 /docker.sock /dev/docker.sock rw - ext4 /dev/vdb1 rw\n",
  subtreeWorkspace: BASE.replace("0:46 / /workspace", "0:46 /sub /workspace"),
  writableHosts: BASE.replace("/hosts /etc/hosts ro,relatime", "/hosts /etc/hosts rw,relatime"),
  etcDirAsHosts: BASE.replace("/docker/containers/4a9a/hosts /etc/hosts", "/etc /etc/hosts"),
  writableCgroup: BASE.replace("/sys/fs/cgroup ro,", "/sys/fs/cgroup rw,"),
  bigShm: BASE.replace("tmpfs shm rw,size=65536k", "tmpfs shm rw,size=1g"),
  bigDev: BASE.replace("/dev rw,nosuid - tmpfs tmpfs rw,size=65536k", "/dev rw,nosuid - tmpfs tmpfs rw,size=1g"),
  extraDevTmpfs: BASE + "407 308 0:64 / /dev/foo rw - tmpfs tmpfs rw,size=1k\n",
  stackedHosts: BASE + "408 305 253:17 /docker/containers/4a9a/hosts /etc/hosts ro,relatime - ext4 /dev/vdb1 rw\n",
  badSize: BASE.replace("size=131072k,mode=755,uid", "size=12x,mode=755,uid"),
};

// Measured under Kata on the VX1 host (guest 6.18.35): /dev/shm is a guest tmpfs without size=.
VARIANTS.kataVx1Sized = null; // filled below from kataVx1 with Kata's measured shm size
VARIANTS.kataVx1 = `73 46 0:35 / / ro,nodev,relatime master:22 - virtiofs none rw
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
`;

VARIANTS.kataVx1Sized = VARIANTS.kataVx1.replace("- tmpfs shm rw\n", "- tmpfs shm rw,size=984636k,nr_inodes=246159\n");

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 30000 });
  const lines = r.stdout.trim().split("\n");
  return { code: r.status, out: JSON.parse(lines[lines.length - 1]) };
}

test("node probe.mjs classifies mounts identically to python probe.sh", () => {
  const dir = mkdtempSync(join(tmpdir(), "airlock-probe-parity-"));
  try {
    for (const [name, text] of Object.entries(VARIANTS)) {
      const file = join(dir, name);
      writeFileSync(file, text);
      const meminfo = join(dir, "meminfo");
      writeFileSync(meminfo, "MemTotal:       1969272 kB\n");
      for (const [wb, shm, ...guest] of [["134217728", "67108864"], ["1048576", "1024"], ["134217728", "67108864", "--guest-vm", "--meminfo", meminfo]]) {
        const args = ["--only-mounts", "--mountinfo", file, "--workspace-bytes", wb, "--shm-bytes", shm, ...guest];
        const py = run("bash", [PY_PROBE, ...args]);
        const js = run(process.execPath, [NODE_PROBE, ...args]);
        assert.deepEqual(Object.keys(js.out), Object.keys(py.out), `${name}: key order`);
        assert.equal(js.code, py.code, `${name}: exit code`);
        for (const k of ["metadataEndpoint", "dns", "outboundTcp", "dockerSocket", "hostMounts", "allBlocked"]) {
          assert.equal(js.out[k], py.out[k], `${name}/${wb}: ${k}`);
        }
        assert.deepEqual(js.out.details, py.out.details, `${name}/${wb}: details`);
        assert.match(js.out.probedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
      }
    }
    // Sanity: the baseline really is BLOCKED and the variants really are REACHED.
    const b = run(process.execPath, [NODE_PROBE, "--only-mounts", "--mountinfo", join(dir, "baseline")]);
    assert.equal(b.out.hostMounts, "BLOCKED");
    assert.equal(b.out.allBlocked, false); // --only-mounts can never pass
    const h = run(process.execPath, [NODE_PROBE, "--only-mounts", "--mountinfo", join(dir, "hostBind")]);
    assert.equal(h.out.hostMounts, "REACHED");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unreadable mountinfo is UNKNOWN in both", () => {
  const args = ["--only-mounts", "--mountinfo", "/nonexistent/mountinfo"];
  assert.equal(run("bash", [PY_PROBE, ...args]).out.hostMounts, "UNKNOWN");
  assert.equal(run(process.execPath, [NODE_PROBE, ...args]).out.hostMounts, "UNKNOWN");
});
