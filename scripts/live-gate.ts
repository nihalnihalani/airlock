#!/usr/bin/env bun
/**
 * Live-repair gate (35 §9 / CLAUDE.md §4): N fresh tasks on the hero profile through the public
 * control API, then a tally against the gate "at least 2 of 3 fresh attempts pass the external
 * comparator", and a sanitized receipt that the control plane reads to decide repair availability.
 *
 *   bun scripts/live-gate.ts [--n 3] [--profile tabulate-365] [--issue profiles/<profile>/issue.md]
 *                            [--out docs/evidence/live-gate] [--allow-dev-unsafe]
 *
 * Needs a running stack with the LIVE driver (AIRLOCK_MODEL_DRIVER=vultr) and
 * AIRLOCK_OPERATOR_PASSWORD (dev-up puts it in data/dev.env). Tasks are created with `liveGate: true`
 * (operator only), which exempts them from the repair-disabled state the gate itself lifts.
 *
 * Provenance is taken from each task's own records, never from a supplied model name:
 *   - every task was created by this run (ids from our own POSTs, createdAt after the run began);
 *   - no task is a labelled diagnostic (`task.scriptedDriver` unset);
 *   - every model event names a vultr model (not `scripted:`) served from api.vultrinference.com;
 *   - the supervisor host check is not dev-unsafe, and each verification record ran on its runtime;
 *   - one adapter digest (from the verification records) and one runtime image id (the supervisor's
 *     enforced image, matching every record that names its own) bind the receipt; either missing
 *     means no receipt.
 * A provenance failure invalidates the whole run (exit 2, no receipt). Otherwise a receipt is
 * written to <out>/<UTC timestamp>.json whether the gate passes or not (a failing receipt withdraws
 * availability), and the exit code is 0 only if passed >= 2 of >= 3.
 *
 * The receipt holds no secrets, cookies or issue text: profile id, contract digest, model id,
 * runtime, task ids, outcomes, candidate digests, model-call counts and hosts, durations. Only the
 * profile id and the issue text are sent; the maintainer reference revision never is (refused if
 * the issue text contains it). Nothing here can influence a verdict: it only reads TaskView/events.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { LiveGateReceipt, ProfileManifest, type HostCheck, type RunEvent, type TaskView } from "@airlock/contracts";

const PINNED_HOST = "api.vultrinference.com";
const MIN_PASSED = 2;
const MIN_TOTAL = 3;

type Args = { n: number; profile: string; issue: string | null; out: string; allowDevUnsafe: boolean };
function parseArgs(): Args {
  const a = process.argv.slice(2);
  const get = (k: string) => {
    const i = a.indexOf(k);
    return i >= 0 && a[i + 1] ? (a[i + 1] as string) : null;
  };
  const n = Number(get("--n") ?? "3");
  if (!Number.isInteger(n) || n < 1 || n > 20) throw new Error("--n must be an integer between 1 and 20");
  return { n, profile: get("--profile") ?? "tabulate-365", issue: get("--issue"), out: get("--out") ?? "docs/evidence/live-gate", allowDevUnsafe: a.includes("--allow-dev-unsafe") };
}

const ROOT = resolve(import.meta.dir, "..");
const BASE = (process.env.AIRLOCK_CONTROL_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");

function loadDevEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const file of [resolve(ROOT, "data/dev.env"), resolve(ROOT, ".env")]) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m) out[m[1] as string] = m[2] as string;
    }
  }
  return out;
}

/** `https://api.vultrinference.com/v1` (what the driver records) or a bare host → the hostname. */
function hostOf(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    return new URL(value.includes("://") ? value : `https://${value}`).hostname;
  } catch {
    return null;
  }
}

function revision(): string {
  const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: ROOT });
  if (head.exitCode !== 0) return "unknown";
  const dirty = Bun.spawnSync(["git", "status", "--porcelain", "--untracked-files=no"], { cwd: ROOT }).stdout.toString().trim().length > 0;
  return `${head.stdout.toString().trim()}${dirty ? "-dirty" : ""}`.slice(0, 64);
}

async function readEvents(taskId: string, cookie: string): Promise<RunEvent[]> {
  const res = await fetch(`${BASE}/api/tasks/${taskId}/events?lastEventId=0`, { headers: { cookie, accept: "text/event-stream" } });
  if (!res.ok) throw new Error(`events for ${taskId}: ${res.status}`);
  const events: RunEvent[] = [];
  for (const block of (await res.text()).split("\n\n")) {
    let name = "message";
    let data = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) name = line.slice(6).trim();
      else if (line.startsWith("data:")) data += line.slice(5).trim();
    }
    if (!data || name === "task" || name === "end") continue;
    try {
      events.push(JSON.parse(data) as RunEvent);
    } catch {
      // not an event
    }
  }
  return events;
}

class ProvenanceError extends Error {}

async function main() {
  const args = parseArgs();
  const env = { ...loadDevEnv(), ...process.env };
  const password = env.AIRLOCK_OPERATOR_PASSWORD;
  if (!password) throw new Error("AIRLOCK_OPERATOR_PASSWORD not set (dev-up writes it to data/dev.env)");
  const profileDir = join(ROOT, "profiles", args.profile);
  const manifest = ProfileManifest.parse(JSON.parse(readFileSync(join(profileDir, "profile.json"), "utf8")));
  const issuePath = resolve(ROOT, args.issue ?? join("profiles", args.profile, "issue.md"));
  // Provenance comments in the tracked fixture are for maintainers, not the model.
  const issueText = readFileSync(issuePath, "utf8").replace(/<!--[\s\S]*?-->/g, "").trim();
  if (!issueText) throw new Error(`issue file ${issuePath} is empty`);
  const reference = manifest.referenceCommitMaintainerOnly;
  if (reference && (issueText.includes(reference) || issueText.includes(reference.slice(0, 7))))
    throw new Error("the issue text names the maintainer reference revision; it is never supplied to a run");

  const login = await fetch(`${BASE}/api/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }) });
  if (!login.ok) throw new Error(`login failed: ${login.status} ${await login.text()}`);
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const H = { cookie, "content-type": "application/json" };

  const hostRes = await fetch(`${BASE}/api/host`, { headers: { cookie } });
  if (!hostRes.ok) throw new Error(`host check failed: ${hostRes.status}`);
  const host = (await hostRes.json()) as HostCheck;
  console.log(`supervisor: runtime=${host.selectedRuntime} devUnsafe=${host.devUnsafe}${host.runtimeImageId ? ` image=${host.runtimeImageId}` : ""}${host.instanceId ? ` instance=${host.instanceId}` : ""}`);
  if (host.devUnsafe && !args.allowDevUnsafe) throw new ProvenanceError("the supervisor runs dev-unsafe (plain runc): a live-gate receipt needs gVisor or Kata. Use --allow-dev-unsafe to rehearse without writing a receipt.");

  const startedAt = Date.now();
  const attempts: LiveGateReceipt["attempts"] = [];
  const models = new Set<string>();
  const contractDigests = new Set<string>();
  // Bound identities (a receipt backs repair only for this exact image and adapter): the adapter
  // digest every verification record was measured under, and the image id the supervisor enforces
  // (cross-checked against each record's own inspected image id when the record carries one).
  const adapterDigests = new Set<string>();
  const imageIds = new Set<string>();
  if (host.runtimeImageId) imageIds.add(host.runtimeImageId);
  for (let i = 0; i < args.n; i++) {
    const t0 = Date.now();
    const created = await fetch(`${BASE}/api/tasks`, { method: "POST", headers: H, body: JSON.stringify({ profileId: args.profile, issueText, liveGate: true }) });
    if (!created.ok) throw new Error(`create failed: ${created.status} ${await created.text()}`);
    const createdTask = (await created.json()) as { id: string; scriptedDriver?: string };
    if (createdTask.scriptedDriver) throw new ProvenanceError(`task ${createdTask.id} is a scripted diagnostic (${createdTask.scriptedDriver}): the control plane is not running the live driver`);
    process.stdout.write(`attempt ${i + 1}/${args.n}: task ${createdTask.id} created; waiting`);
    let view: TaskView;
    for (;;) {
      await Bun.sleep(3000);
      const r = await fetch(`${BASE}/api/tasks/${createdTask.id}`, { headers: { cookie } });
      if (!r.ok) throw new Error(`view failed: ${r.status}`);
      view = (await r.json()) as TaskView;
      process.stdout.write(".");
      if (["done", "failed", "cancelled"].includes(view.task.status)) break;
      if (Date.now() - t0 > 20 * 60_000) throw new Error(`task ${createdTask.id} did not finish within 20 minutes`);
    }
    process.stdout.write("\n");
    const task = view.task;
    // Fresh and ours: the id came from our POST, and the record says it was created during this run.
    if (task.id !== createdTask.id || Date.parse(task.createdAt) < startedAt - 5_000) throw new ProvenanceError(`task ${task.id} was not created by this gate run`);
    if (task.scriptedDriver) throw new ProvenanceError(`task ${task.id} is a scripted diagnostic`);
    if (task.repairDisabledReason) throw new ProvenanceError(`task ${task.id} ran with repair disabled (${task.repairDisabledReason}); the control plane ignored liveGate`);

    const events = await readEvents(task.id, cookie);
    const modelEvents = events.filter((e) => e.kind === "model");
    const hosts = new Set<string>();
    for (const e of modelEvents) {
      const data = (e.data ?? {}) as { model?: unknown; host?: unknown };
      const model = typeof data.model === "string" ? data.model : "";
      const h = hostOf(data.host);
      if (!model || model.startsWith("scripted") || h !== PINNED_HOST) throw new ProvenanceError(`task ${task.id} event #${e.seq}: model "${model}" from "${String(data.host)}" is not the vultr driver on ${PINNED_HOST}`);
      models.add(model);
      hosts.add(h);
    }
    const prepare = events.find((e) => e.kind === "phase" && e.title === "prepare");
    const contractDigest = (prepare?.data as { contractDigest?: unknown } | undefined)?.contractDigest;
    if (typeof contractDigest !== "string") throw new ProvenanceError(`task ${task.id} recorded no contract digest`);
    contractDigests.add(contractDigest);
    for (const record of [view.baseline, view.verification]) {
      if (!record) continue;
      const insp = record.runtimeProfile.inspection;
      if (insp.devUnsafe || record.runtimeProfile.host.devUnsafe) {
        if (!args.allowDevUnsafe) throw new ProvenanceError(`task ${task.id}: ${record.role} ran dev-unsafe`);
      } else if (insp.runtime !== host.selectedRuntime) throw new ProvenanceError(`task ${task.id}: ${record.role} ran on ${insp.runtime}, the supervisor selects ${host.selectedRuntime}`);
      if (record.contractDigest !== contractDigest) throw new ProvenanceError(`task ${task.id}: ${record.role} record was measured under another contract`);
      if (typeof record.adapterDigest === "string" && record.adapterDigest) adapterDigests.add(record.adapterDigest);
      const imageId = insp.imageId;
      if (imageId) {
        if (host.runtimeImageId && imageId !== host.runtimeImageId) throw new ProvenanceError(`task ${task.id}: ${record.role} ran image ${imageId}; the supervisor enforces ${host.runtimeImageId}`);
        imageIds.add(imageId);
      }
    }
    const passed = task.status === "done" && task.outcome === "CANDIDATE_PASSED_CHECKS" && view.verification?.passed === true && view.verification.candidateDigest === task.candidateDigest && modelEvents.length > 0;
    // A pass the records do not back (no model call, record/digest mismatch) is never counted as one.
    const outcome = passed ? "CANDIDATE_PASSED_CHECKS" : task.outcome === "CANDIDATE_PASSED_CHECKS" ? "UNATTESTED_PASS" : (task.outcome ?? task.status.toUpperCase());
    attempts.push({
      taskId: task.id,
      outcome: outcome.slice(0, 64),
      ...(task.candidateDigest ? { candidateDigest: task.candidateDigest } : {}),
      modelCalls: modelEvents.length,
      modelHosts: [...hosts],
      durationMs: Date.now() - t0,
    });
    console.log(`  → status=${task.status} outcome=${task.outcome ?? "-"} phase=${task.phase} modelCalls=${modelEvents.length} ${Math.round((Date.now() - t0) / 1000)}s digest=${(task.candidateDigest ?? "-").slice(0, 12)}${task.error ? ` error=${task.error.slice(0, 120)}` : ""}`);
  }
  if (models.size > 1) throw new ProvenanceError(`the run used more than one model: ${[...models].join(", ")}`);
  if (contractDigests.size !== 1) throw new ProvenanceError("the attempts were measured under different contracts");

  const passedCount = attempts.filter((a) => a.outcome === "CANDIDATE_PASSED_CHECKS").length;
  const gatePassed = passedCount >= MIN_PASSED && attempts.length >= MIN_TOTAL;
  console.log(`\nLIVE GATE: ${passedCount}/${attempts.length} passed the external comparator (need ${MIN_PASSED} of ${MIN_TOTAL}). ${gatePassed ? "PASS" : "FAIL"}`);

  if (host.devUnsafe || args.allowDevUnsafe) {
    console.log("dev-unsafe rehearsal: no receipt written (a receipt requires gVisor or Kata and is never written with --allow-dev-unsafe).");
    process.exit(1);
  }
  const model = [...models][0];
  if (!model) throw new ProvenanceError("no model call was recorded in any attempt; nothing attests a live Vultr repair");
  if (adapterDigests.size !== 1) throw new ProvenanceError(adapterDigests.size === 0 ? "no verification record names an adapter digest; the receipt cannot be bound to an adapter" : `the attempts were measured under different adapters: ${[...adapterDigests].map((d) => d.slice(0, 12)).join(", ")}`);
  if (imageIds.size !== 1) throw new ProvenanceError(imageIds.size === 0 ? "neither the supervisor host check nor any verification record names a runtime image id; the receipt cannot be bound to an image" : `the attempts ran on different runtime images: ${[...imageIds].join(", ")}`);
  const runtimeImageId = [...imageIds][0] as string;
  if (!/^sha256:[a-f0-9]{64}$/.test(runtimeImageId)) throw new ProvenanceError(`runtime image id "${runtimeImageId.slice(0, 80)}" is not a local image id (sha256:<64 hex>)`);
  const recordedAt = new Date().toISOString();
  const receipt = LiveGateReceipt.parse({
    schemaVersion: 1,
    recordedAt,
    revision: revision(),
    profileId: args.profile,
    contractDigest: [...contractDigests][0],
    driver: "vultr",
    model,
    inferenceHost: PINNED_HOST,
    runtime: host.selectedRuntime,
    devUnsafe: false,
    runtimeImageId,
    adapterDigest: [...adapterDigests][0],
    attempts,
    passed: passedCount,
    total: attempts.length,
  });
  const outDir = resolve(ROOT, args.out);
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `${recordedAt.replace(/:/g, "-").replace(/\.\d+Z$/, "Z")}.json`);
  writeFileSync(file, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
  console.log(`receipt: ${file.startsWith(ROOT) ? file.slice(ROOT.length + 1) : file} (commit it; the control plane reads the newest receipt)`);
  process.exit(gatePassed ? 0 : 1);
}

main().catch((e) => {
  if (e instanceof ProvenanceError) {
    console.error(`\nLIVE GATE INVALID (provenance): ${e.message}\nNo receipt written.`);
    process.exit(2);
  }
  console.error(e);
  process.exit(2);
});
