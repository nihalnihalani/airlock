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

const health = await (await fetch(`${BASE}/health`)).json();
console.log("== supervisor /health");
console.log(JSON.stringify({ status: health.status, docker: health.docker, host: health.host }, null, 2));
check(health.status === "ok", `status ok (${health.status})`);
check(health.host?.devUnsafe === false, `host.devUnsafe=false (${health.host?.devUnsafe})`);
check(health.host?.kvmPresent === true, `host.kvmPresent=true (${health.host?.kvmPresent})`);
check(typeof health.host?.selectedRuntime === "string" && health.host.selectedRuntime !== "runc", `host.selectedRuntime=${health.host?.selectedRuntime} (not runc)`);
const expected = health.host?.selectedRuntime as string;

console.log("== author sandbox: create → inspect → probe → uname → destroy");
const ref = { taskId: `preflight-${Date.now().toString(36)}`, attemptId: "a1", generation: 0 };
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

console.log(failures === 0 ? "PREFLIGHT API: all checks passed" : `PREFLIGHT API: ${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
