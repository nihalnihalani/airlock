#!/usr/bin/env bun
/**
 * Runs ON VM B (invoked by deploy/preflight.sh over SSH, from /opt/airlock/app so the workspace
 * packages resolve). Talks to the supervisor's private API exactly as the control plane would and
 * prints what it inspected, never what it assumed:
 *
 *   1. GET /health                          host check block (selectedRuntime, devUnsafe, kvm, runtimes)
 *   2. POST /attempts (role author)         a real author sandbox: inspection (effective runtime name,
 *                                           guest uname/hostname) and the isolation probe results
 *      POST /attempts/:id/tool exec         `uname -a` inside it
 *      POST /attempts/:id/destroy           teardown listing
 *   3. POST /hostile                        a one-shot hostile run: the metadata endpoint is reached
 *                                           from inside (must fail), blast-radius card
 *   4. Runtime-tier gates on THIS host's runtime (G4, D1, C4, C27, C29): workspace quota and where
 *      its pages live (host MemAvailable), a detached child dying with the sandbox, post-stop
 *      collection, a destroyed id refusing execution; a browser attempt (Chromium's own sandbox,
 *      allowed navigation, metadata refused, a form POST refused by the runner); an analysis sandbox
 *      computing an answer offline; and a host-wide empty listing at the end.
 *
 * Env: SUPERVISOR_URL, SUPERVISOR_TOKEN (read by preflight.sh from /etc/airlock/supervisor.env as root
 * and passed through the environment of this process only). Exit 1 if any expectation fails.
 */
import { requestDigestOf } from "@airlock/contracts";

const BASE = (process.env.SUPERVISOR_URL ?? "").replace(/\/+$/, "");
const TOKEN = process.env.SUPERVISOR_TOKEN ?? "";
if (!BASE || !TOKEN) {
  console.error("preflight-api: SUPERVISOR_URL and SUPERVISOR_TOKEN are required");
  process.exit(2);
}
let failures = 0;
function check(cond: unknown, msg: string) {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${msg}`);
  if (!cond) failures++;
}
async function call(method: string, path: string, body?: Record<string, unknown>) {
  let payload: string | undefined;
  if (body) {
    const opId = `pf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const withOp = { ...body, operation: { operationId: opId } };
    const requestDigest = await requestDigestOf(withOp);
    payload = JSON.stringify({ ...body, operation: { operationId: opId, requestDigest } });
  }
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, ...(payload ? { "content-type": "application/json" } : {}) },
    body: payload,
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text };
}

const live = await (await fetch(`${BASE}/health`)).json();
console.log("== supervisor /health (public liveness) and /host (authenticated host check)");
check(live?.ok === true && Object.keys(live).length === 1, `public /health is liveness only (${JSON.stringify(live)})`);
const hostRes = await call("GET", "/host");
const host = hostRes.json;
console.log(JSON.stringify(host, null, 2));
check(hostRes.status === 200, `GET /host → ${hostRes.status}`);
check(host?.devUnsafe === false, `host.devUnsafe=false (${host?.devUnsafe})`);
check(host?.kvmPresent === true, `host.kvmPresent=true (${host?.kvmPresent})`);
check(typeof host?.selectedRuntime === "string" && host.selectedRuntime !== "runc", `host.selectedRuntime=${host?.selectedRuntime} (not runc)`);
check(typeof host?.runtimeImageId === "string" && host.runtimeImageId.startsWith("sha256:"), `runtime image pinned (${host?.runtimeImageId})`);
const expected = host?.selectedRuntime as string;

console.log("== author sandbox: create → inspect → probe → uname → destroy");
const ref = { taskId: `preflight-${Date.now().toString(36)}`, attemptId: `a${Date.now().toString(36)}`, generation: 0 };
const deadline = new Date(Date.now() + 120_000).toISOString();
const created = await call("POST", "/attempts", { ref, profileId: "tabulate-365", role: "author", absoluteDeadline: deadline });
check(created.status === 200 || created.status === 201, `POST /attempts → ${created.status}${created.status >= 300 ? " " + created.text.slice(0, 300) : ""}`);
const attempt = created.json ?? {};
const insp = attempt.inspection ?? {};
console.log(`  inspection.runtime=${insp.runtime} devUnsafe=${insp.devUnsafe} container=${insp.container}`);
console.log(`  inspection.guestHostname=${insp.guestHostname}`);
console.log(`  inspection.guestUname=${insp.guestUname}`);
console.log(`  inspection.imageDigest=${insp.imageDigest}`);
console.log(`  inspection.checks=${JSON.stringify(insp.checks)}`);
check(insp.runtime === expected, `inspection.runtime="${insp.runtime}" equals the selected runtime "${expected}"`);
check(insp.devUnsafe === false, `inspection.devUnsafe=false`);
const probe = attempt.probe ?? {};
console.log(`  probe: metadataEndpoint=${probe.metadataEndpoint} dns=${probe.dns} outboundTcp=${probe.outboundTcp} dockerSocket=${probe.dockerSocket} hostMounts=${probe.hostMounts}`);
for (const k of ["metadataEndpoint", "dns", "outboundTcp", "dockerSocket", "hostMounts"]) check(probe[k] === "BLOCKED", `probe.${k}=BLOCKED (${probe[k]})`);
if (created.status < 300) {
  const exec = await call("POST", `/attempts/${ref.attemptId}/tool`, { ref, args: { kind: "exec", command: "uname -a; hostname; id; cat /proc/version" } });
  const out = exec.json?.result?.stdout ?? exec.text;
  console.log(`  exec uname -a (exit ${exec.json?.result?.exitCode}):\n${String(out).trim().split("\n").map((l: string) => "    " + l).join("\n")}`);
  check(exec.status === 200 && exec.json?.result?.exitCode === 0, "exec inside the sandbox succeeded");
  const destroyed = await call("POST", `/attempts/${ref.attemptId}/destroy`, { ref });
  console.log(`  teardown: ${JSON.stringify(destroyed.json?.teardown)}`);
  check(destroyed.status === 200 && destroyed.json?.teardown?.clean === true, "teardown clean (no sandboxes)");
}

console.log("== hostile one-shot: metadata endpoint from inside the sandbox");
const hostile = await call("POST", "/hostile", {
  profileId: "tabulate-365",
  command: "uname -r; python3 -c \"import urllib.request,sys\ntry:\n  urllib.request.urlopen('http://169.254.169.254/v1.json', timeout=2); print('METADATA_REACHED')\nexcept Exception as e:\n  print('METADATA_BLOCKED', type(e).__name__)\"",
});
check(hostile.status === 200, `POST /hostile → ${hostile.status}${hostile.status >= 300 ? " " + hostile.text.slice(0, 300) : ""}`);
const card = hostile.json ?? {};
console.log(`  died: ${JSON.stringify(card.died)}`);
console.log(`  survived: ${JSON.stringify(card.survived)}`);
console.log(`  exec stdout:\n${String(card.exec?.stdout ?? "").trim().split("\n").map((l: string) => "    " + l).join("\n")}`);
console.log(`  teardown: ${JSON.stringify(card.teardown)}`);
check(/METADATA_BLOCKED/.test(card.exec?.stdout ?? ""), "169.254.169.254 unreachable from inside the sandbox");
check(card.inspection?.runtime === expected, `hostile inspection.runtime="${card.inspection?.runtime}"`);
check(card.survived?.supervisorHealthy === true && card.survived?.hostSentinelUnchanged === true, "supervisor healthy and host sentinel unchanged afterwards");
check(card.teardown?.clean === true, "hostile teardown clean");

// ---- runtime-tier gates (G4, D1, C4): measured on this host's actual runtime, not assumed -------------
const uid = () => Math.random().toString(36).slice(2, 8);
const deadlineIn = (ms: number) => new Date(Date.now() + ms).toISOString();

console.log("== G4/D1: workspace quota, background child, post-stop collection");
{
  const r = { taskId: `pf-q-${uid()}`, attemptId: `q${uid()}`, generation: 1 };
  const c = await call("POST", "/attempts", { ref: r, profileId: "tabulate-365", role: "author", absoluteDeadline: deadlineIn(180_000) });
  check(c.status === 200, `author attempt for runtime gates → ${c.status}`);
  if (c.status === 200) {
    // D1: where do the workspace's tmpfs pages live? This script runs on VM B, so it reads the host's
    // own MemAvailable before and after filling the workspace (under Kata the pages may sit in host RAM
    // outside the guest's memory limit; capacity.ts budgets for that).
    const memAvail = async () => Number(/MemAvailable:\s+(\d+)/.exec(await Bun.file("/proc/meminfo").text())?.[1] ?? 0);
    const before = await memAvail();
    const fill = await call("POST", `/attempts/${r.attemptId}/tool`, { ref: r, args: { kind: "exec", command: "dd if=/dev/zero of=/workspace/fill bs=1M count=400 2>&1 | tail -1; echo rc=$?; df -k /workspace | tail -1" } });
    const afterFill = await memAvail();
    console.log(`  D1 host MemAvailable: before ${Math.round(before / 1024)} MiB, with the workspace full ${Math.round(afterFill / 1024)} MiB (delta ${Math.round((before - afterFill) / 1024)} MiB)`);
    const out = String(fill.json?.result?.stdout ?? "");
    console.log(`  workspace fill:\n${out.trim().split("\n").map((l) => "    " + l).join("\n")}`);
    check(/No space left|rc=1/.test(out) || fill.json?.result?.exitCode !== 0, "D1/G4: writing past the workspace quota fails inside the sandbox");
    await call("POST", `/attempts/${r.attemptId}/tool`, { ref: r, args: { kind: "exec", command: "rm -f /workspace/fill" } });
    const bg = await call("POST", `/attempts/${r.attemptId}/tool`, { ref: r, args: { kind: "exec", command: "nohup sleep 1000 >/dev/null 2>&1 & echo started" } });
    check(bg.status === 200, "G4: detached background child started");
    const w = await call("POST", `/attempts/${r.attemptId}/tool`, { ref: r, args: { kind: "write", path: "tabulate/__init__.py", content: "# preflight write\n" } });
    check(w.status === 200, "author write before freeze");
    const fr = await call("POST", `/attempts/${r.attemptId}/freeze`, { ref: r });
    const files = fr.json?.envelope?.files ?? [];
    check(fr.status === 200 && fr.json?.stopConfirmed === true && files.some((f: { path: string }) => f.path === "tabulate/__init__.py"), `D1: post-stop collection on this runtime returns the written file (freeze ${fr.status}, ${files.length} file(s))`);
    const d = await call("POST", `/attempts/${r.attemptId}/destroy`, { ref: r });
    check(d.status === 200 && d.json?.teardown?.clean === true, "G4: destroy clean after a detached child (whole sandbox stopped)");
    const again = await call("POST", `/attempts/${r.attemptId}/tool`, { ref: r, args: { kind: "exec", command: "echo alive" } });
    check(again.status === 409 || again.status === 404, `G4: destroyed id cannot execute again (→ ${again.status})`);
  }
}

const listing = async () => (await call("GET", "/listing")).json ?? {};

if (host?.runtimeImageId) {
  console.log("== C4: browser attempt under this runtime (Chromium sandbox, egress, mutation guard)");
  const r = { taskId: `pf-b-${uid()}`, attemptId: `b${uid()}`, generation: 1 };
  const c = await call("POST", "/attempts", { ref: r, profileId: "browser", role: "browser", absoluteDeadline: deadlineIn(300_000), egressAllow: ["example.com", "httpbin.org"] });
  if (c.status === 400 && /unsupported_profile|not set/i.test(c.text)) {
    console.log("  SKIP browser plane not configured on this supervisor");
  } else {
    check(c.status === 200, `browser attempt → ${c.status}${c.status >= 300 ? " " + c.text.slice(0, 300) : ""}`);
    if (c.status === 200) {
      const ev = (await call("GET", `/attempts/${r.attemptId}/browser`)).json ?? {};
      console.log(`  browser inspection.runtime=${ev.browserInspection?.runtime} guest=${ev.browserInspection?.guestUname}`);
      console.log(`  chromium sandbox: ${JSON.stringify(ev.status?.sandbox)}`);
      check(ev.browserInspection?.runtime === expected, `C4: browser container runs under ${expected}`);
      check(ev.status?.sandbox?.anyNoSandboxFlag === false && ev.status?.sandbox?.renderersInNestedPidNamespace === true, "C4: Chromium's own sandbox is active under this runtime");
      const op = (request: Record<string, unknown>) => call("POST", `/attempts/${r.attemptId}/browser`, { ref: r, request });
      const nav = await op({ op: "navigate", args: { url: "https://example.com/" } });
      check(nav.json?.status === "completed" && nav.json?.response?.ok === true, "C4: allowed navigation works through the egress proxy");
      const shot = await op({ op: "screenshot" });
      check(shot.json?.response?.ok === true && typeof shot.json?.response?.result?.sha256 === "string", "C4: screenshot captured");
      const meta = await op({ op: "navigate", args: { url: "http://169.254.169.254/v1.json" } });
      check(meta.json?.response?.ok === false || meta.json?.response?.result?.egressDenied === true, "C8: metadata endpoint refused");
      const form = await op({ op: "navigate", args: { url: "https://httpbin.org/forms/post" } });
      const obs = await op({ op: "observe" });
      const submit = (obs.json?.response?.result?.controls ?? []).find((k: { role: string; name: string }) => k.role === "button" && /submit/i.test(k.name));
      if (form.json?.response?.ok && submit) {
        await op({ op: "click", args: { ref: submit.ref, generation: obs.json.response.result.generation } });
        const after = await op({ op: "observe" });
        const blocked = (after.json?.response?.result?.events ?? []).some((e: { type: string }) => e.type === "mutation_blocked");
        check(blocked, "C27: form POST on an allowlisted site refused by the runner under this runtime");
      } else console.log("  SKIP httpbin form not reachable");
      const eg = (await call("GET", `/attempts/${r.attemptId}/egress`)).json ?? {};
      console.log(`  egress summary: ${JSON.stringify(eg.summary)}`);
      const d = await call("POST", `/attempts/${r.attemptId}/destroy`, { ref: r });
      check(d.status === 200 && d.json?.teardown?.clean === true, "browser teardown clean (containers and networks)");
    }
  }

  console.log("== C29/C30: analysis sandbox under this runtime");
  const a = { taskId: `pf-a-${uid()}`, attemptId: `a${uid()}`, generation: 1 };
  const ca = await call("POST", "/attempts", { ref: a, profileId: "analysis", role: "analysis", absoluteDeadline: deadlineIn(300_000) });
  if (ca.status === 400 && /unsupported_profile|not set/i.test(ca.text)) console.log("  SKIP analysis plane not configured");
  else {
    check(ca.status === 200, `analysis attempt → ${ca.status}`);
    if (ca.status === 200) {
      const csv = Buffer.from("region,revenue\nA,10\nB,3\n").toString("base64");
      await call("POST", `/attempts/${a.attemptId}/tool`, { ref: a, args: { kind: "put", path: "inputs/r.csv", contentBase64: csv } });
      await call("POST", `/attempts/${a.attemptId}/tool`, { ref: a, args: { kind: "write", path: "code/a.py", content: "import csv,json\nrows=list(csv.DictReader(open('inputs/r.csv')))\nw=min(rows,key=lambda r:int(r['revenue']))\njson.dump({'answer':w['region']},open('outputs/summary.json','w'))\n" } });
      const run = await call("POST", `/attempts/${a.attemptId}/tool`, { ref: a, args: { kind: "exec", command: "/opt/airlock/run.sh code/a.py" } });
      check(run.json?.result?.exitCode === 0, "analysis code ran offline");
      const col = await call("POST", `/attempts/${a.attemptId}/collect-outputs`, { ref: a });
      const f = (col.json?.envelope?.files ?? []).find((x: { path: string }) => x.path === "summary.json");
      check(!!f && Buffer.from(f.contentBase64, "base64").toString().includes('"B"'), "collected outputs/summary.json has the computed answer");
      const d = await call("POST", `/attempts/${a.attemptId}/destroy`, { ref: a });
      check(d.status === 200 && d.json?.teardown?.clean === true, "analysis teardown clean");
    }
  }
}

const final = await listing();
console.log(`== host-wide listing after preflight: ${JSON.stringify({ containers: final.containers?.length, volumes: final.volumes?.length, networks: final.networks?.length })}`);
check((final.containers ?? []).length === 0 && (final.volumes ?? []).length === 0 && (final.networks ?? []).length === 0, "host-wide (no sandboxes) after preflight");

console.log(failures === 0 ? "PREFLIGHT API: all checks passed" : `PREFLIGHT API: ${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
