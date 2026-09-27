#!/usr/bin/env bun
/**
 * Airlock end-to-end smoke against a running dev stack (scripts/dev-up.sh), driven only through the
 * public HTTP API plus two external observations (the supervisor's attempt list and `docker ps` by
 * label) that a user of the product could make too.
 *
 *   bun scripts/smoke.ts
 *
 * Env: AIRLOCK_CONTROL_URL (default http://127.0.0.1:3000), SUPERVISOR_URL (default
 * http://127.0.0.1:4300), SUPERVISOR_TOKEN and AIRLOCK_OPERATOR_PASSWORD (default: read from
 * data/dev.env), DOCKER_HOST (default: Colima socket).
 *
 * What it proves, in order:
 *   1. diagnostic scripted repair → CANDIDATE_PASSED_CHECKS; the five checkpoints are present
 *   2. preview on the sealed candidate renders the header-only table for the reported input
 *   3. export zip carries patch.diff that applies cleanly to profiles/tabulate-365/base
 *   4. hostile `rm -rf / --no-preserve-root` dies inside its sandbox; the host survives; teardown clean
 *   5. forged-log scripted "repair" (unchanged code, forged success log) → CHECKS_FAILED
 *   6. fork bomb in a hostile sandbox while task 3's command runs (task 3 unaffected, supervisor healthy);
 *      then cancel mid-command → status cancelled; no owned attempt or container remains
 *
 * Every model run here is SCRIPTED (a labelled diagnostic), never a live repair. The stack runs on
 * plain runc with AIRLOCK_DEV_UNSAFE=1: local development only.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  AttemptState,
  BlastRadiusCard,
  CaseContract,
  PreviewResult,
  RunEvent,
  Task,
  TaskView,
  type Outcome,
} from "@airlock/contracts";
import { z } from "zod";

const ROOT = resolve(import.meta.dir, "..");
const CONTROL = (process.env.AIRLOCK_CONTROL_URL ?? "http://127.0.0.1:3000").replace(/\/+$/, "");
const SUPERVISOR = (process.env.SUPERVISOR_URL ?? "http://127.0.0.1:4300").replace(/\/+$/, "");
const PROFILE = "tabulate-365";
const TASK_TIMEOUT_MS = 6 * 60_000;

const ISSUE_TEXT = `tabulate raises IndexError for an empty table when maxheadercolwidths is set

from tabulate import tabulate
print(tabulate([], headers=["Name", "Value"], maxheadercolwidths=5))

Traceback (most recent call last):
  File "tabulate/__init__.py", line 2291, in tabulate
    num_cols = len(list_of_lists[0])
IndexError: list index out of range

Expected: the header-only table, as without maxheadercolwidths.
(python-tabulate issue #365)`;

// ---------------------------------------------------------------------------------------------

function devEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (const line of readFileSync(join(ROOT, "data/dev.env"), "utf8").split("\n")) {
      const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
      if (m) out[m[1]!] = m[2]!;
    }
  } catch {
    // no dev.env; rely on the environment
  }
  return out;
}
const DEV = devEnv();
const OPERATOR_PASSWORD = process.env.AIRLOCK_OPERATOR_PASSWORD ?? DEV.AIRLOCK_OPERATOR_PASSWORD ?? "";
const SUPERVISOR_TOKEN = process.env.SUPERVISOR_TOKEN ?? DEV.SUPERVISOR_TOKEN ?? "";
const DOCKER_HOST = process.env.DOCKER_HOST ?? `unix://${process.env.HOME}/.colima/default/docker.sock`;

let failures = 0;
function ok(condition: unknown, message: string): asserts condition {
  if (condition) console.log(`  ok   ${message}`);
  else {
    failures++;
    console.log(`  FAIL ${message}`);
    throw new Error(`assertion failed: ${message}`);
  }
}
function step(title: string) {
  console.log(`\n== ${title}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let cookie = "";
async function api<T>(schema: z.ZodType<T>, path: string, init: { method?: string; body?: unknown; raw?: boolean } = {}): Promise<T> {
  const res = await fetch(`${CONTROL}${path}`, {
    method: init.method ?? "GET",
    headers: { accept: "application/json", ...(init.body !== undefined ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  return schema.parse(JSON.parse(text));
}

/** Follow the task's SSE stream until the server sends `end`; returns the events seen. */
async function followEvents(taskId: string, onEvent?: (e: RunEvent) => void | Promise<void>, lastEventId = 0): Promise<{ events: RunEvent[]; ended: boolean }> {
  const events: RunEvent[] = [];
  const deadline = Date.now() + TASK_TIMEOUT_MS;
  let cursor = lastEventId;
  let ended = false;
  while (!ended && Date.now() < deadline) {
    const res = await fetch(`${CONTROL}/api/tasks/${taskId}/events?lastEventId=${cursor}`, { headers: { accept: "text/event-stream", ...(cookie ? { cookie } : {}) } });
    if (!res.ok || !res.body) throw new Error(`events stream → ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        let name = "message";
        let data = "";
        for (const line of block.split("\n")) {
          if (line.startsWith("event:")) name = line.slice(6).trim();
          else if (line.startsWith("data:")) data += line.slice(5).trim();
        }
        if (name === "end") {
          ended = true;
          break;
        }
        if (name === "task" || !data) continue;
        const parsed = RunEvent.safeParse(JSON.parse(data));
        if (!parsed.success) continue;
        if (parsed.data.seq <= cursor) continue;
        cursor = parsed.data.seq;
        events.push(parsed.data);
        await onEvent?.(parsed.data);
      }
      if (ended) break;
    }
    await reader.cancel().catch(() => undefined);
    if (!ended) await sleep(500); // stream dropped: reconnect with ?lastEventId (seam 1)
  }
  return { events, ended };
}

async function runTask(scriptedDriver: string, label: string, onEvent?: (e: RunEvent) => void | Promise<void>) {
  const task = await api(Task, "/api/tasks", { method: "POST", body: { profileId: PROFILE, issueText: ISSUE_TEXT, scriptedDriver } });
  console.log(`  task ${task.id} (${label}, scripted:${scriptedDriver})`);
  const { events, ended } = await followEvents(task.id, async (e) => {
    if (e.kind === "phase" || e.kind === "check" || e.kind === "error") console.log(`    #${e.seq} ${e.kind.padEnd(9)} ${e.title}`);
    await onEvent?.(e);
  });
  ok(ended, "SSE stream ended with the terminal `end` event");
  const view = await api(TaskView, `/api/tasks/${task.id}`);
  return { task: view.task, view, events };
}

// ---------------------------------------------------------------------------------------------

async function main() {
  console.log(`Airlock smoke — control ${CONTROL}, supervisor ${SUPERVISOR}`);
  const contract = CaseContract.parse(JSON.parse(readFileSync(join(ROOT, "profiles", PROFILE, "contract.json"), "utf8")));
  const reported = contract.cases.find((c) => c.kind === "reported")!;

  step("login as operator");
  ok(OPERATOR_PASSWORD, "operator password available (data/dev.env or AIRLOCK_OPERATOR_PASSWORD)");
  const loginRes = await fetch(`${CONTROL}/api/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: OPERATOR_PASSWORD }) });
  ok(loginRes.status === 200, `POST /api/session → ${loginRes.status}`);
  cookie = (loginRes.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const who = await api(z.object({ role: z.string() }), "/api/session");
  ok(who.role === "operator", `session role is operator (${who.role})`);
  const profiles = await api(z.array(z.object({ id: z.string(), referenceCommitMaintainerOnly: z.unknown().optional() })), "/api/profiles");
  ok(profiles.some((p) => p.id === PROFILE), `profile ${PROFILE} is offered`);
  ok(profiles.every((p) => p.referenceCommitMaintainerOnly === undefined), "maintainer reference commit is not exposed");

  // ---- 1. diagnostic repair ----------------------------------------------------------------------
  step("task 1: diagnostic scripted repair → CANDIDATE_PASSED_CHECKS");
  const t1 = await runTask("diagnostic", "diagnostic");
  ok(t1.task.status === "done", `status done (${t1.task.status})`);
  ok(t1.task.outcome === ("CANDIDATE_PASSED_CHECKS" satisfies Outcome), `outcome CANDIDATE_PASSED_CHECKS (${t1.task.outcome})`);
  ok(t1.view.baseline?.passed === true, "baseline record: reported failure reproduced");
  ok(t1.view.verification?.passed === true, `verification record: ${t1.view.verification?.completedCases}/${t1.view.verification?.requiredCases} cases`);
  ok(t1.view.cases?.length === contract.cases.length, `TaskView carries ${t1.view.cases?.length} contract case titles (seam 2)`);
  const v = t1.view.verification!;
  step("five checkpoints (task 1)");
  const host = t1.view.host;
  ok(host, "1 host check present on TaskView");
  console.log(`    docker ${host.dockerVersion}; cpuVirt=${host.cpuVirtualization} kvm=${host.kvmPresent} runtimes=[${host.availableRuntimes.join(",")}] selected=${host.selectedRuntime} devUnsafe=${host.devUnsafe}`);
  const execEvents = t1.events.filter((e) => e.kind === "exec");
  ok(execEvents.length >= 3, `2 execution log: ${execEvents.length} exec events with exit codes`);
  for (const e of execEvents) console.log(`    #${e.seq} ${e.title} exit=${String((e.data as { exitCode?: unknown })?.exitCode)}`);
  const insp = v.runtimeProfile.inspection;
  ok(insp.guestHostname.length > 0 && insp.guestUname.length > 0, "3 in-sandbox identity proof");
  console.log(`    container ${insp.container} runtime=${insp.runtime}${insp.devUnsafe ? " (dev-unsafe)" : ""} hostname=${insp.guestHostname}\n    uname=${insp.guestUname}`);
  const probeEvent = t1.events.find((e) => e.kind === "check" && e.title === "Isolation checkpoints");
  const probe = (probeEvent?.data as { probe?: { allBlocked?: boolean; metadataEndpoint?: string; dns?: string; outboundTcp?: string; dockerSocket?: string; hostMounts?: string } })?.probe;
  ok(probe?.allBlocked === true, "4 isolation probe fully BLOCKED before agent work");
  console.log(`    metadata=${probe.metadataEndpoint} dns=${probe.dns} tcp=${probe.outboundTcp} dockerSocket=${probe.dockerSocket} hostMounts=${probe.hostMounts}`);
  const td = v.runtimeProfile.teardown;
  ok(td.clean && td.containersRemaining.length === 0 && td.volumesRemaining.length === 0, "5 teardown: (no sandboxes)");
  const modelEvents = t1.events.filter((e) => e.kind === "model");
  ok(modelEvents.length >= 5, `${modelEvents.length} model turns recorded`);
  const modelData = modelEvents[0]?.data as { model?: unknown; host?: unknown } | undefined;
  ok(typeof modelData?.model === "string" && String(modelData.model).startsWith("scripted"), `model events are labelled scripted (${String(modelData?.model)}, seam 3)`);
  const runEvent = t1.events.find((e) => e.kind === "exec" && e.title.startsWith("run:"));
  const runData = runEvent?.data as { command?: unknown; result?: { stdout?: string; exitCode?: number } } | undefined;
  ok(typeof runData?.command === "string" && typeof runData.result?.stdout === "string", "run events carry command and full ExecResult (seam 3)");

  // ---- 2. preview ----------------------------------------------------------------------------------
  step("preview on the sealed candidate");
  const preview = await api(PreviewResult, `/api/tasks/${t1.task.id}/preview`, { method: "POST", body: { candidateDigest: t1.task.candidateDigest, input: reported.input } });
  ok(preview.candidateDigest === t1.task.candidateDigest, "preview ran against the sealed digest");
  ok(preview.observation?.status === "ok", `preview observation ok (exec ${preview.exec.status})`);
  const expected = reported.candidate.kind === "returns" ? reported.candidate.valueCanonical : "";
  ok(preview.observation?.valueCanonical === expected, "preview text equals the contract's header-only table");
  console.log(`    preview text:\n${String(JSON.parse(preview.observation!.valueCanonical!)).split("\n").map((l) => `      | ${l}`).join("\n")}`);
  const badPreview = await fetch(`${CONTROL}/api/tasks/${t1.task.id}/preview`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ candidateDigest: "0".repeat(64), input: reported.input }) });
  ok(badPreview.status === 409, `preview with a foreign digest is refused (${badPreview.status})`);

  // ---- 3. export ----------------------------------------------------------------------------------
  step("export bundle");
  const grant = await api(z.object({ grantId: z.string(), url: z.string(), expiresAt: z.string() }), `/api/tasks/${t1.task.id}/export`, { method: "POST", body: {} });
  const zipRes = await fetch(`${CONTROL}${grant.url}`, { headers: { cookie } });
  ok(zipRes.status === 200 && (zipRes.headers.get("content-type") ?? "").includes("zip"), `GET ${grant.url} → ${zipRes.status} ${zipRes.headers.get("content-type")}`);
  const zipBytes = new Uint8Array(await zipRes.arrayBuffer());
  const work = mkdtempSync(join(tmpdir(), "airlock-smoke-"));
  writeFileSync(join(work, "export.zip"), zipBytes);
  const unzip = Bun.spawnSync(["unzip", "-o", "-q", "export.zip", "-d", "x"], { cwd: work });
  ok(unzip.exitCode === 0, `unzip ok (${zipBytes.length} bytes)`);
  const listing = Bun.spawnSync(["find", "x", "-type", "f"], { cwd: work }).stdout.toString().trim().split("\n").sort();
  console.log(`    ${listing.join("\n    ")}`);
  ok(listing.includes("x/patch.diff"), "zip contains patch.diff");
  const dry = Bun.spawnSync(["patch", "-p1", "--dry-run", "-i", join(work, "x/patch.diff")], { cwd: join(ROOT, "profiles", PROFILE, "base") });
  ok(dry.exitCode === 0, `patch -p1 --dry-run applies cleanly to profiles/${PROFILE}/base: ${dry.stdout.toString().trim()}`);
  const again = await api(z.object({ grantId: z.string() }), `/api/tasks/${t1.task.id}/export`, { method: "POST", body: {} });
  ok(again.grantId === grant.grantId, "repeated export returns the same grant");

  // ---- 4. hostile ---------------------------------------------------------------------------------
  step("hostile panel: rm -rf / --no-preserve-root");
  const card = await api(BlastRadiusCard, "/api/hostile", { method: "POST", body: { command: "rm -rf / --no-preserve-root" } });
  const lastHostileAt = Date.now();
  console.log(`    died:     container=${card.died.container} runtime=${card.died.runtime} reason=${card.died.reason}`);
  console.log(`    exec:     ${card.exec.status} exit=${card.exec.exitCode} ${card.exec.durationMs}ms stderr(tail)=${JSON.stringify(card.exec.stderr.slice(-160))}`);
  console.log(`    survived: supervisorHealthy=${card.survived.supervisorHealthy} hostSentinelUnchanged=${card.survived.hostSentinelUnchanged} otherAttemptsRunning=${card.survived.otherAttemptsRunning} hostUptimeSeconds=${card.survived.hostUptimeSeconds}`);
  ok(card.died.container.length > 0 && card.died.reason.length > 0, "died: the sandbox is named and its end is explained");
  ok(card.survived.supervisorHealthy && card.survived.hostSentinelUnchanged, "survived: supervisor healthy and host sentinel unchanged");
  ok(card.teardown.clean && card.teardown.containersRemaining.length === 0, "teardown clean: (no sandboxes)");
  const health = await fetch(`${CONTROL}/api/host`);
  ok(health.status === 200, `control plane still answers after the hostile run (${health.status})`);

  // ---- 5. forged log ----------------------------------------------------------------------------
  step("task 2: forged-log scripted 'repair' → CHECKS_FAILED");
  const t2 = await runTask("forged-log", "forged log, unchanged code");
  ok(t2.task.status === "done", `status done (${t2.task.status})`);
  ok(t2.task.outcome === "CHECKS_FAILED", `outcome CHECKS_FAILED (${t2.task.outcome})`);
  ok(t2.view.verification?.passed === false, "verification record: not passed");
  const forgedRefused = t2.events.find((e) => e.kind === "tool" && e.title === "write_file refused");
  ok(forgedRefused, "the forged tests-passed.log write was refused (not an allowed replacement path)");
  const t2Preview = await fetch(`${CONTROL}/api/tasks/${t2.task.id}/preview`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ candidateDigest: t2.task.candidateDigest, input: reported.input }) });
  ok(t2Preview.status === 409, `preview on a failed candidate is refused (${t2Preview.status})`);

  // ---- 6. another task over its limits while a task runs; then cancel mid-flight -------------------
  step("task 3: fork bomb in a hostile sandbox while task 3's command runs; then cancel during its next command");
  let cancelled: Task | null = null;
  let bomb: BlastRadiusCard | null = null;
  let runsSeen = 0;
  const t3 = await runTask("slow", "slow, cancelled", async (e) => {
    if (e.kind !== "model" || !(e.data as { toolCalls?: { name: string }[] })?.toolCalls?.some((c) => c.name === "run")) return;
    runsSeen++;
    if (runsSeen === 1) {
      await sleep(1500); // the run has been dispatched into the sandbox by now
      // /api/hostile is limited to one run per 10 s per session; task 3's command runs for 25 s.
      await sleep(Math.max(0, 10_500 - (Date.now() - lastHostileAt)));
      // CLAUDE.md §4: one task over its limits is terminated while another task and the control plane stay healthy.
      bomb = await api(BlastRadiusCard, "/api/hostile", { method: "POST", body: { command: ":(){ :|:& };:; sleep 3; echo alive" } });
      console.log(`    fork bomb: exec ${bomb.exec.status} exit=${bomb.exec.exitCode}; survived: supervisorHealthy=${bomb.survived.supervisorHealthy} otherAttemptsRunning=${bomb.survived.otherAttemptsRunning}; teardown clean=${bomb.teardown.clean}`);
    } else if (runsSeen === 2 && !cancelled) {
      await sleep(1500);
      cancelled = await api(Task, `/api/tasks/${e.taskId}/cancel`, { method: "POST", body: {} });
      console.log(`    cancel → status ${cancelled.status} (phase ${cancelled.phase})`);
    }
  });
  ok(bomb !== null, "hostile fork bomb ran while task 3's command was executing");
  const bombCard = bomb as unknown as BlastRadiusCard;
  ok(bombCard.survived.supervisorHealthy && bombCard.survived.hostSentinelUnchanged, "supervisor and host sentinel survived the fork bomb");
  ok(bombCard.survived.otherAttemptsRunning === 1, `task 3's attempt was still running during the fork bomb (otherAttemptsRunning=${bombCard.survived.otherAttemptsRunning})`);
  ok(bombCard.teardown.clean, "fork-bomb sandbox torn down clean");
  const firstExec = t3.events.find((e) => e.kind === "exec" && (e.data as { tool?: string })?.tool === "run");
  const firstExecData = firstExec?.data as { status?: string; exitCode?: number | null; result?: { stdout?: string } } | undefined;
  ok(firstExecData?.status === "succeeded" && firstExecData.exitCode === 0 && /done/.test(firstExecData.result?.stdout ?? ""), `task 3's first command completed unaffected (${firstExecData?.status} exit=${firstExecData?.exitCode})`);
  ok(cancelled !== null && (cancelled as Task).status === "cancelling", "cancel was accepted while running");
  ok(t3.task.status === "cancelled", `final status cancelled (${t3.task.status})`);
  ok(t3.task.outcome === undefined, "no outcome invented for a cancelled task");
  const torn = t3.events.find((e) => e.kind === "lifecycle" && /destroyed after cancellation/i.test(e.title));
  ok(torn, "teardown after cancellation recorded");
  const attempts = await fetch(`${SUPERVISOR}/attempts`, { headers: { authorization: `Bearer ${SUPERVISOR_TOKEN}` } });
  ok(attempts.status === 200, `supervisor GET /attempts → ${attempts.status}`);
  const live = z.array(AttemptState).parse(await attempts.json()).filter((a) => a.ref.taskId === t3.task.id && a.status !== "destroyed");
  ok(live.length === 0, `no live attempt for ${t3.task.id} at the supervisor (${live.length})`);
  const ps = Bun.spawnSync(["docker", "ps", "-a", "--filter", "label=airlock.supervisor=true", "--format", "{{.Names}} {{.Status}}"], { env: { ...process.env, DOCKER_HOST } });
  const owned = ps.stdout.toString().trim().split("\n").filter(Boolean);
  ok(ps.exitCode === 0 && owned.length === 0, `docker ps by label airlock.supervisor=true: ${owned.length === 0 ? "(no sandboxes)" : owned.join(", ")}`);

  console.log(`\nSMOKE PASSED — outcomes: task1=${t1.task.outcome} task2=${t2.task.outcome} task3=${t3.task.status}`);
}

main().catch((error) => {
  console.error(`\nSMOKE FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
