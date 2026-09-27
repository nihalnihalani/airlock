// Build-time self-check for airlock-runtime-node. Fails the docker build on any mismatch.
//   node /opt/airlock/image_check.mjs     (run once, as root, during the build)
import { readFileSync, existsSync, statSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { join, delimiter } from "node:path";
import { spawnSync } from "node:child_process";

const fails = [];
const check = (ok, what) => { console.log((ok ? "ok    " : "FAIL  ") + what); if (!ok) fails.push(what); };
const which = (tool) => (process.env.PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin")
  .split(delimiter).some((d) => existsSync(join(d, tool)));

for (const tool of ["npm", "npx", "corepack", "yarn", "yarnpkg", "pnpm", "python3", "python", "gcc", "cc", "g++", "c++", "clang", "ld", "as", "make", "curl", "wget"]) {
  check(!which(tool), `${tool} not on PATH`);
}
check(!existsSync("/usr/local/lib/node_modules"), "global node_modules (npm/corepack) removed");

const lock = JSON.parse(readFileSync("/opt/airlock/node/package-lock.json", "utf8"));
const locked = Object.entries(lock.packages).filter(([k]) => k.startsWith("node_modules/"));
const installed = readdirSync("/opt/airlock/node/node_modules").filter((n) => !n.startsWith("."));
check(installed.length === locked.length, `installed packages == lock (${locked.length})`);
for (const [key, meta] of locked) {
  const pj = JSON.parse(readFileSync(join("/opt/airlock/node", key, "package.json"), "utf8"));
  check(pj.version === meta.version && typeof meta.integrity === "string" && meta.integrity.startsWith("sha512-"), `${key}@${meta.version} sha512-locked`);
  check(!pj.scripts || !["preinstall", "install", "postinstall"].some((s) => pj.scripts[s]), `${key} has no install scripts`);
}
check(realpathSync("/node_modules") === "/opt/airlock/node/node_modules", "/node_modules -> baked deps");

const suid = [];
const walk = (dir) => {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.isFile()) { try { if (lstatSync(p).mode & 0o6000) suid.push(p); } catch { /* ignore */ } }
  }
};
for (const top of ["/bin", "/sbin", "/usr", "/etc", "/opt", "/lib", "/var"]) walk(top);
check(suid.length === 0, `no setuid/setgid files ${JSON.stringify(suid.slice(0, 5))}`);

for (const [p, mode] of [["/opt/airlock/probe.sh", 0o555], ["/opt/airlock/run.sh", 0o555], ["/opt/airlock/probe.mjs", 0o444], ["/opt/airlock/image_check.mjs", 0o444]]) {
  const st = statSync(p);
  check(st.uid === 0 && (st.mode & 0o7777) === mode, `${p} root-owned ${mode.toString(8)}`);
}
const ready = spawnSync("/usr/local/bin/node", ["-e", "console.log('ready')"], { encoding: "utf8" });
check(ready.stdout.trim() === "ready", "readiness node -e");
const dep = spawnSync("/usr/local/bin/node", ["--input-type=module", "-e", "import { parse } from 'csv-parse/sync'; console.log(parse('a,b\\n1,2', { columns: true })[0].b)"], { encoding: "utf8", cwd: "/workspace" });
check(dep.stdout.trim() === "2", "csv-parse importable from /workspace (ESM)");

if (fails.length) { console.error(`image_check: ${fails.length} failure(s)`); process.exit(1); }
console.log("image_check: all checks passed");
