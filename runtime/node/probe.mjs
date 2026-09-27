// Airlock isolation probe for the Node runtime (checkpoint 4): a line-for-line port of
// runtime/python/probe.sh, because the Node image deliberately carries no Python interpreter.
//
// Prints one JSON object with EXACTLY the shape of probe.sh (apps/supervisor/src/probe.ts parses it):
//   {"probedAt": iso, "metadataEndpoint": R, "dns": R, "outboundTcp": R, "dockerSocket": R,
//    "hostMounts": R, "allBlocked": bool, "details": {...}}
// where R is "BLOCKED" | "REACHED" | "UNKNOWN"; exit 0 only when all are BLOCKED, else 3.
// Same targets, same 2-second timeouts, same mount classification rules and messages. Node
// built-ins only (node: specifiers), so nothing on disk can shadow a dependency. Invoked through
// /opt/airlock/probe.sh (a bash shim that clears the environment, so NODE_OPTIONS cannot inject code).
//
// Arguments (fixed by the supervisor):  --workspace-bytes N (default 128 MiB), --shm-bytes N (default 64 MiB)
// Test-only (can only make the result stricter): --mountinfo PATH, --only-mounts
import { readFileSync, lstatSync } from "node:fs";
import { request } from "node:http";
import { lookup } from "node:dns/promises";
import { connect } from "node:net";
import { pathToFileURL } from "node:url";

const argv = process.argv.slice(2);
const ARGS = { workspaceBytes: 134217728, shmBytes: 67108864, mountinfo: "/proc/self/mountinfo", meminfo: "/proc/meminfo", onlyMounts: false, guestVm: false };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--workspace-bytes" && i + 1 < argv.length) {
    const v = argv[++i];
    if (!/^\d+$/.test(v)) { process.stderr.write("probe: --workspace-bytes must be an integer\n"); process.exit(2); }
    ARGS.workspaceBytes = Number(v);
  } else if (a.startsWith("--workspace-bytes=")) {
    const v = a.slice(18);
    if (!/^\d+$/.test(v)) { process.stderr.write("probe: --workspace-bytes must be an integer\n"); process.exit(2); }
    ARGS.workspaceBytes = Number(v);
  } else if (a === "--shm-bytes" && i + 1 < argv.length) {
    const v = argv[++i];
    if (!/^\d+$/.test(v)) { process.stderr.write("probe: --shm-bytes must be an integer\n"); process.exit(2); }
    ARGS.shmBytes = Number(v);
  } else if (a.startsWith("--shm-bytes=")) {
    const v = a.slice(12);
    if (!/^\d+$/.test(v)) { process.stderr.write("probe: --shm-bytes must be an integer\n"); process.exit(2); }
    ARGS.shmBytes = Number(v);
  } else if (a === "--mountinfo" && i + 1 < argv.length) ARGS.mountinfo = argv[++i];
  else if (a.startsWith("--mountinfo=")) ARGS.mountinfo = a.slice(12);
  else if (a === "--only-mounts") ARGS.onlyMounts = true;
  // Set by the supervisor only when the inspected runtime boots a guest kernel (Kata): the guest's
  // /dev/shm is guest RAM, bounded by the VM's memory limit, and Kata mounts it without size=.
  else if (a === "--guest-vm") ARGS.guestVm = true;
  else if (a === "--meminfo" && i + 1 < argv.length) ARGS.meminfo = argv[++i];
  // unknown arguments are ignored, like argparse.parse_known_args in probe.sh
}

const TIMEOUT_MS = 2000;
const METADATA_URL = "http://169.254.169.254/v1.json";
const DNS_NAME = "example.com";
const TCP_TARGET = ["1.1.1.1", 443];
const DOCKER_SOCKETS = ["/var/run/docker.sock", "/run/docker.sock"];
const TMP_BYTES = 67108864;
const ROOT_TYPES = ["overlay", "9p", "virtiofs", "fuse.virtiofs", "rootfs"];
const WORKSPACE_TYPES = ["tmpfs", "virtiofs", "fuse.virtiofs", "9p"];
const PSEUDO = { "/proc": ["proc"], "/sys": ["sysfs"], "/dev": ["tmpfs", "devtmpfs"] };
const PSEUDO_CHILDREN = {
  "/proc": ["proc", "tmpfs"],
  "/sys": ["sysfs", "cgroup", "cgroup2", "tmpfs"],
};
// Under /dev only these named mounts exist in a sandbox; /dev/shm is bounded by --shm-bytes.
// The guest's MemTotal in bytes (meaningful only inside a VM guest); 0 when unreadable, which refuses.
function guestMemBytes() {
  try {
    const text = readFileSync(ARGS.onlyMounts ? ARGS.meminfo : "/proc/meminfo", "utf8");
    const m = /^MemTotal:\s+(\d+)\s+kB/m.exec(text);
    return m ? Number(m[1]) * 1024 : 0;
  } catch {
    return 0;
  }
}

const DEV_CHILDREN = { "/dev/pts": ["devpts"], "/dev/mqueue": ["mqueue"], "/dev/shm": ["tmpfs"] };
const DEV_BYTES = 67108864;
// Mount points that must be the ROOT of their filesystem (mountinfo root "/"): no subtree binds.
const ROOT_ONLY_POINTS = ["/workspace", "/candidate", "/tmp", "/dev", "/dev/shm", "/dev/pts", "/dev/mqueue", "/proc", "/sys"];
const ALLOWED_MOUNT_FILES = ["/etc/hosts", "/etc/hostname", "/etc/resolv.conf"];
const BLOCKED = "BLOCKED", REACHED = "REACHED", UNKNOWN = "UNKNOWN";
const details = {};
const s200 = (x) => String(x).slice(0, 200);
const errText = (e) => s200(e && (e.code ? `${e.code}: ${e.message}` : e.message) || e);

function withTimeout(promise, onTimeout) {
  let t;
  return Promise.race([promise, new Promise((resolve) => { t = setTimeout(() => resolve(onTimeout()), TIMEOUT_MS + 250); })])
    .finally(() => clearTimeout(t));
}

function probeMetadata() {
  return withTimeout(new Promise((resolve) => {
    try {
      const req = request(METADATA_URL, { headers: { "User-Agent": "airlock-probe" }, timeout: TIMEOUT_MS }, (res) => {
        details.metadataEndpoint = `http ${res.statusCode}`;
        res.destroy();
        resolve(REACHED); // any HTTP answer means the endpoint is reachable
      });
      req.on("timeout", () => { details.metadataEndpoint = "timed out"; req.destroy(); resolve(BLOCKED); });
      req.on("error", (e) => { if (!details.metadataEndpoint) details.metadataEndpoint = errText(e); resolve(BLOCKED); });
      req.end();
    } catch (e) {
      details.metadataEndpoint = `unexpected ${e?.name}: ${s200(e?.message)}`;
      resolve(UNKNOWN);
    }
  }), () => { details.metadataEndpoint = "timed out"; return BLOCKED; });
}

function probeDns() {
  return withTimeout(
    lookup(DNS_NAME, { all: true }).then(
      (infos) => { details.dns = `resolved ${infos.length} addresses`; return REACHED; },
      (e) => { details.dns = errText(e); return BLOCKED; },
    ),
    () => { details.dns = "timed out"; return BLOCKED; },
  );
}

function probeTcp() {
  return withTimeout(new Promise((resolve) => {
    try {
      const sock = connect({ host: TCP_TARGET[0], port: TCP_TARGET[1], timeout: TIMEOUT_MS });
      sock.on("connect", () => { details.outboundTcp = `connected ${TCP_TARGET[0]}:${TCP_TARGET[1]}`; sock.destroy(); resolve(REACHED); });
      sock.on("timeout", () => { details.outboundTcp = "timed out"; sock.destroy(); resolve(BLOCKED); });
      sock.on("error", (e) => { details.outboundTcp = errText(e); resolve(BLOCKED); });
    } catch (e) {
      details.outboundTcp = `unexpected ${e?.name}: ${s200(e?.message)}`;
      resolve(UNKNOWN);
    }
  }), () => { details.outboundTcp = "timed out"; return BLOCKED; });
}

function lexists(p) {
  try { lstatSync(p); return true; } catch (e) { if (e.code === "ENOENT" || e.code === "ENOTDIR") return false; throw e; }
}

function probeDockerSocket() {
  try {
    const present = DOCKER_SOCKETS.filter(lexists);
    details.dockerSocket = present.length ? present : "absent";
    return present.length ? REACHED : BLOCKED;
  } catch (e) {
    details.dockerSocket = `unexpected ${e?.name}: ${s200(e?.message)}`;
    return UNKNOWN;
  }
}

function unescape(field) {
  // /proc/self/mountinfo escapes space, tab, newline and backslash as octal sequences.
  for (const [seq, ch] of [["\\040", " "], ["\\011", "\t"], ["\\012", "\n"], ["\\134", "\\"]]) field = field.split(seq).join(ch);
  return field;
}

function sizeBytes(superOpts) {
  for (const opt of superOpts.split(",")) {
    if (opt.startsWith("size=")) {
      let value = opt.slice(5);
      let unit = 1;
      const last = value.slice(-1).toLowerCase();
      if (["k", "m", "g"].includes(last)) { unit = { k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[last]; value = value.slice(0, -1); }
      if (!/^\d+$/.test(value)) return null;
      return Number(value) * unit;
    }
  }
  return null;
}

const under = (point, parent) => point.startsWith(parent + "/");
const pyStr = (v) => (v === null ? "None" : String(v));

export function classifyMounts(lines, workspaceBytes) {
  const problems = [];
  const seen = new Map();
  const workspacePoints = [];
  for (const line of lines) {
    const parts = line.split(" ");
    if (parts.length < 7 || !parts.slice(6).includes("-")) { problems.push("unparseable mountinfo line"); continue; }
    const sep = parts.indexOf("-", 6);
    if (parts.length < sep + 3) { problems.push("unparseable mountinfo line"); continue; }
    const root = unescape(parts[3]);
    const point = unescape(parts[4]);
    const mountOpts = parts[5].split(",");
    const fstype = parts[sep + 1];
    const source = unescape(parts[sep + 2]);
    const superOpts = parts.length > sep + 3 ? parts[sep + 3] : "";
    seen.set(point, (seen.get(point) ?? 0) + 1);
    const what = `${point} (${fstype} from ${source})`;

    if (ROOT_ONLY_POINTS.includes(point) && root !== "/") {
      const kind = point === "/workspace" || point === "/candidate" ? "workspace " : "";
      problems.push(`${kind}${what} is a subtree bind (root ${root})`);
      continue;
    }
    if (point === "/") {
      if (!ROOT_TYPES.includes(fstype)) problems.push("rootfs " + what);
    } else if (point === "/workspace" || point === "/candidate") {
      workspacePoints.push(point);
      if (!WORKSPACE_TYPES.includes(fstype)) problems.push("workspace " + what);
      else if (fstype === "tmpfs") {
        const size = sizeBytes(superOpts);
        if (size === null || size > workspaceBytes) problems.push(`workspace tmpfs not bounded to ${workspaceBytes} bytes: ${point} size=${pyStr(size)}`);
      }
    } else if (point === "/tmp") {
      const size = sizeBytes(superOpts);
      if (fstype !== "tmpfs" || size === null || size > TMP_BYTES || !mountOpts.includes("noexec")) problems.push("tmp " + what + ` size=${pyStr(size)}`);
    } else if (Object.hasOwn(PSEUDO, point)) {
      if (!PSEUDO[point].includes(fstype)) problems.push("pseudo-fs " + what);
      else if (point === "/dev" && fstype === "tmpfs") {
        const size = sizeBytes(superOpts);
        if (size === null || size > DEV_BYTES) problems.push(`/dev tmpfs not bounded to ${DEV_BYTES} bytes: size=${pyStr(size)}`);
      }
    } else if (ALLOWED_MOUNT_FILES.includes(point)) {
      // Docker's per-container file, bound read-only; the bind's source must be that one file.
      const name = point.slice(point.lastIndexOf("/") + 1);
      if (!mountOpts.includes("ro")) problems.push("writable file bind " + what);
      else if (!(root.endsWith("/" + name) || root.endsWith("-" + name))) problems.push(`file bind from ${root} at ${what}`);
    } else if (under(point, "/dev")) {
      if (!Object.hasOwn(DEV_CHILDREN, point)) problems.push("unexpected mount under /dev: " + what);
      else if (!DEV_CHILDREN[point].includes(fstype)) problems.push(`unexpected ${fstype} at ${what}`);
      else if (point === "/dev/shm") {
        const size = sizeBytes(superOpts);
        if (ARGS.guestVm && (size === null || size <= guestMemBytes())) { /* guest tmpfs inside the VM: bounded by the guest's own RAM */ }
        else if (size === null || size > ARGS.shmBytes) problems.push(`/dev/shm not bounded to ${ARGS.shmBytes} bytes: size=${pyStr(size)}`);
      }
    } else {
      const parent = Object.keys(PSEUDO_CHILDREN).find((p) => under(point, p)) ?? null;
      if (parent === null) problems.push("unexpected mount " + what);
      else if (!PSEUDO_CHILDREN[parent].includes(fstype)) problems.push(`unexpected ${fstype} under ${parent}: ${what}`);
      else if (fstype === "tmpfs" && (parent === "/proc" || parent === "/sys") && !mountOpts.includes("ro") && root !== "/null") {
        problems.push(`writable tmpfs under ${parent}: ${what}`);
      } else if ((fstype === "cgroup" || fstype === "cgroup2") && !mountOpts.includes("ro")) {
        problems.push("writable cgroup: " + what); // a writable cgroup lets the sandbox change its own limits
      }
    }
  }
  for (const point of ["/", "/workspace", "/candidate", "/tmp", "/proc", "/sys", "/dev", "/dev/shm", ...ALLOWED_MOUNT_FILES]) {
    if ((seen.get(point) ?? 0) > 1) problems.push(`stacked mounts at ${point} (${seen.get(point)})`);
  }
  if (new Set(workspacePoints).size > 1) problems.push("both /workspace and /candidate are mounted");
  return problems;
}

function probeHostMounts() {
  let lines;
  try {
    lines = readFileSync(ARGS.mountinfo, "utf8").split(/\r\n|\r|\n/).filter((l) => l.trim());
  } catch (e) {
    details.hostMounts = `mountinfo unreadable: ${errText(e)}`;
    return UNKNOWN;
  }
  if (!lines.length) { details.hostMounts = "mountinfo empty"; return UNKNOWN; }
  const problems = classifyMounts(lines, ARGS.workspaceBytes);
  details.hostMounts = problems.length ? problems.slice(0, 50) : "only sandbox mounts";
  return problems.length ? REACHED : BLOCKED;
}

async function main() {
  let network;
  if (ARGS.onlyMounts) {
    network = { metadataEndpoint: UNKNOWN, dns: UNKNOWN, outboundTcp: UNKNOWN, dockerSocket: UNKNOWN };
    details.network = "skipped (--only-mounts)";
  } else {
    const [metadataEndpoint, dns, outboundTcp] = await Promise.all([probeMetadata(), probeDns(), probeTcp()]);
    network = { metadataEndpoint, dns, outboundTcp, dockerSocket: probeDockerSocket() };
  }
  const result = {
    probedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    ...network,
    hostMounts: probeHostMounts(),
  };
  result.allBlocked = ["metadataEndpoint", "dns", "outboundTcp", "dockerSocket", "hostMounts"].every((k) => result[k] === BLOCKED);
  result.details = details;
  process.stdout.write(JSON.stringify(result) + "\n", () => process.exit(result.allBlocked ? 0 : 3));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    process.stdout.write(JSON.stringify({ metadataEndpoint: UNKNOWN, dns: UNKNOWN, outboundTcp: UNKNOWN, dockerSocket: UNKNOWN, hostMounts: UNKNOWN, allBlocked: false, details: { error: s200(e?.message ?? e) } }) + "\n");
    process.exit(3);
  });
}
