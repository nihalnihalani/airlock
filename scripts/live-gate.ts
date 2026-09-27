#!/usr/bin/env bun
/**
 * Live-repair gate (35 §9 / CLAUDE.md §4): N fresh tasks on the hero profile through the public
 * control API with whatever model driver the running control plane has, then a tally against the
 * gate "at least 2 of 3 fresh attempts pass the external comparator".
 *
 *   bun scripts/live-gate.ts [--n 3] [--profile tabulate-365] [--issue data/issues/tabulate-365.md]
 *
 * Needs a running stack (scripts/dev-up.sh --detach) and AIRLOCK_OPERATOR_PASSWORD (dev-up puts it
 * in data/dev.env). Prints one line per task as it finishes and a final summary; exit 0 only if
 * the gate passes. Nothing here can influence a verdict: it only reads TaskView/events.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

type Args = { n: number; profile: string; issue: string };
function parseArgs(): Args {
  const a = process.argv.slice(2);
  const get = (k: string, d: string) => {
    const i = a.indexOf(k);
    return i >= 0 && a[i + 1] ? (a[i + 1] as string) : d;
  };
  return { n: Number(get("--n", "3")), profile: get("--profile", "tabulate-365"), issue: get("--issue", "data/issues/tabulate-365.md") };
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

async function main() {
  const args = parseArgs();
  const env = { ...loadDevEnv(), ...process.env };
  const password = env.AIRLOCK_OPERATOR_PASSWORD;
  if (!password) throw new Error("AIRLOCK_OPERATOR_PASSWORD not set (dev-up writes it to data/dev.env)");
  const issueText = readFileSync(resolve(ROOT, args.issue), "utf8");

  const login = await fetch(`${BASE}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });
  if (!login.ok) throw new Error(`login failed: ${login.status} ${await login.text()}`);
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const H = { cookie, "content-type": "application/json" };

  const results: { id: string; status: string; outcome: string; phase: string; modelCalls: number; ms: number; digest: string; error: string; model: string }[] = [];
  for (let i = 0; i < args.n; i++) {
    const t0 = Date.now();
    const created = await fetch(`${BASE}/api/tasks`, { method: "POST", headers: H, body: JSON.stringify({ profileId: args.profile, issueText }) });
    if (!created.ok) throw new Error(`create failed: ${created.status} ${await created.text()}`);
    const task = (await created.json()) as { id: string };
    process.stdout.write(`attempt ${i + 1}/${args.n}: task ${task.id} created; waiting`);
    let view: any;
    for (;;) {
      await Bun.sleep(3000);
      const r = await fetch(`${BASE}/api/tasks/${task.id}`, { headers: { cookie } });
      if (!r.ok) throw new Error(`view failed: ${r.status}`);
      view = await r.json();
      const st = view.task.status as string;
      process.stdout.write(".");
      if (["done", "failed", "cancelled"].includes(st)) break;
      if (Date.now() - t0 > 20 * 60_000) throw new Error(`task ${task.id} did not finish within 20 minutes`);
    }
    process.stdout.write("\n");
    const ev = await fetch(`${BASE}/api/tasks/${task.id}/events?lastEventId=0`, { headers: { cookie, accept: "text/event-stream" } });
    const text = await ev.text();
    const modelEvents = text.split("\n").filter((l) => l.startsWith("data:")).map((l) => { try { return JSON.parse(l.slice(5)); } catch { return null; } }).filter((e) => e && e.kind === "model");
    const model = modelEvents.map((e: any) => e.data?.model ?? e.data?.modelId).find(Boolean) ?? "?";
    const row = {
      id: task.id,
      status: view.task.status,
      outcome: view.task.outcome ?? "-",
      phase: view.task.phase,
      modelCalls: view.task.budget?.modelCallsUsed ?? modelEvents.length,
      ms: Date.now() - t0,
      digest: (view.task.candidateDigest ?? "").slice(0, 12),
      error: (view.task.error ?? "").slice(0, 120),
      model: String(model),
    };
    results.push(row);
    console.log(`  → status=${row.status} outcome=${row.outcome} phase=${row.phase} modelCalls=${row.modelCalls} ${Math.round(row.ms / 1000)}s digest=${row.digest || "-"} model=${row.model}${row.error ? " error=" + row.error : ""}`);
  }
  const passed = results.filter((r) => r.outcome === "CANDIDATE_PASSED_CHECKS").length;
  const need = Math.ceil((2 / 3) * args.n);
  console.log(`\nLIVE GATE: ${passed}/${args.n} passed the external comparator (need ${need}). ${passed >= need ? "PASS" : "FAIL"}`);
  console.log(JSON.stringify(results, null, 2));
  process.exit(passed >= need ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
