#!/usr/bin/env bun
/**
 * Independent acceptance driver (verifier_tester) against the DEPLOYED Vultr stack: the public HTTPS
 * API only (https://<publicHost>, from data/deploy/state.json), real Vultr compute (control VM A,
 * sandbox VX1 VM B under Kata) and the LIVE model driver (glm-5.3 via Vultr Serverless Inference).
 * External observations: the fixtures destination (https://forms.<publicHost>) and, for the final
 * cleanup check only, a read-only `docker ps/network/volume ls` on VM B over SSH.
 *
 *   set -a; . data/deploy/secrets.env; set +a
 *   bun scripts/acceptance/vultr.ts <testId ...>      (V-C V-A V-B V-D V-E V-F V-K V-T V-Z, or "summary")
 *
 * Every model run is LIVE (no scriptedDriver) and costs money: one attempt per item. Evidence goes to
 * docs/evidence/vultr/acceptance-<rev>/<id>.json; `summary` writes results.json from those files and
 * scans the directory for every value in data/deploy/secrets.env and .env. Passwords, the supervisor
 * token, the forms secret, approval codes, receipt read tokens and cookies are never written.
 * Session cookies are kept in the scratch directory (AIRLOCK_ACC_SCRATCH) only, for the isolation test.
 */
import { createHash, createHmac, randomInt, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");
const STATE = JSON.parse(readFileSync(join(ROOT, "data/deploy/state.json"), "utf8"));
const HOST: string = STATE.publicHost;
const CONTROL = `https://${HOST}`;
const FORMS = `https://forms.${HOST}`;
const FORMS_HOST = `forms.${HOST}`;
const SANDBOX_IP: string = STATE.sandbox.publicIp;
const SSH_KEY: string = STATE.sshKeyFile;
const REVISION = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: ROOT }).stdout.toString().trim();
const REV = REVISION.slice(0, 7);
const EVID_REL = `docs/evidence/vultr/acceptance-${REV}`;
const EVID = join(ROOT, EVID_REL);
mkdirSync(EVID, { recursive: true });
const SCRATCH = process.env.AIRLOCK_ACC_SCRATCH ?? join(ROOT, "data/run/acc-vultr");
mkdirSync(SCRATCH, { recursive: true });

function readEnvFile(p: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(p)) return out;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    if (m) out[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
  return out;
}
const SECRET_FILE = readEnvFile(join(ROOT, "data/deploy/secrets.env"));
const DOT_ENV = readEnvFile(join(ROOT, ".env"));
const JUDGE_PW = process.env.AIRLOCK_JUDGE_PASSWORD ?? SECRET_FILE.AIRLOCK_JUDGE_PASSWORD ?? "";
const OPER_PW = process.env.AIRLOCK_OPERATOR_PASSWORD ?? SECRET_FILE.AIRLOCK_OPERATOR_PASSWORD ?? "";
const FORMS_SECRET = process.env.AIRLOCK_FORMS_SECRET ?? SECRET_FILE.AIRLOCK_FORMS_SECRET ?? "";
if (!JUDGE_PW || !OPER_PW) throw new Error("AIRLOCK_JUDGE_PASSWORD / AIRLOCK_OPERATOR_PASSWORD missing (source data/deploy/secrets.env)");
/** Every value that must never reach evidence (secrets.env, .env, derived tokens added at runtime). */
const SECRETS: string[] = [...Object.values(SECRET_FILE), ...Object.values(DOT_ENV), JUDGE_PW, OPER_PW].filter((s) => s.length >= 6);
const addSecret = (s: string) => s.length >= 6 && !SECRETS.includes(s) && SECRETS.push(s);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const iso = () => new Date().toISOString();
const ENVIRONMENT = `real Vultr compute (control ${STATE.control.plan} @ ${STATE.control.publicIp}, sandbox ${STATE.sandbox.plan} @ ${SANDBOX_IP}, region ${STATE.region}, Kata) + live model (glm-5.3 via Vultr Serverless Inference); public HTTPS API ${CONTROL}`;

// ---------------------------------------------------------------------------------------------
type Result = "PASS" | "FAIL" | "BLOCKED";
let current: Test | null = null;
class Test {
  checks: { ok: boolean; what: string }[] = [];
  evidence: Record<string, unknown> = {};
  note?: string;
  blocked?: string;
  started = iso();
  constructor(readonly id: string, readonly requirement: string) {
    console.log(`\n== ${id}: ${requirement}`);
    current = this;
  }
  check(ok: unknown, what: string) {
    this.checks.push({ ok: !!ok, what });
    console.log(`  ${ok ? "ok  " : "FAIL"} ${what}`);
    return !!ok;
  }
  ev(key: string, value: unknown) {
    this.evidence[key] = value;
  }
}
function sanitizeText(text: string): string {
  for (const s of SECRETS) text = text.split(s).join("<redacted>");
  text = text.replace(/airlock_session=[A-Za-z0-9._%-]+/g, "airlock_session=<redacted>");
  // Approval codes (proposalId.epoch.mac43) never go to evidence.
  text = text.replace(/\b([A-Za-z0-9][A-Za-z0-9_-]{0,63})\.([1-9][0-9]{8,11})\.([A-Za-z0-9_-]{43})\b/g, "$1.$2.<redacted-mac>");
  return text;
}
function saveRow(t: Test, error?: unknown) {
  const failed = t.checks.some((c) => !c.ok) || error !== undefined;
  const result: Result = t.blocked ? "BLOCKED" : failed ? "FAIL" : t.checks.length ? "PASS" : "FAIL";
  const row = {
    id: t.id,
    requirement: t.requirement,
    command: `bun scripts/acceptance/vultr.ts ${t.id}`,
    category: "real Vultr compute + live model",
    environment: ENVIRONMENT,
    startedAt: t.started,
    timestamp: iso(),
    revision: REVISION,
    result,
    checks: t.checks,
    ...(t.note || t.blocked || error ? { note: [t.blocked, t.note, error ? `error: ${error instanceof Error ? error.message : String(error)}` : ""].filter(Boolean).join("; ") } : {}),
    evidence: t.evidence,
  };
  writeFileSync(join(EVID, `${t.id}.json`), sanitizeText(JSON.stringify(row, null, 2)));
  console.log(`=> ${t.id}: ${result}${row.note ? ` (${row.note.slice(0, 300)})` : ""}`);
}

// ---------------------------------------------------------------------------------------------
async function login(password: string): Promise<string> {
  const res = await fetch(`${CONTROL}/api/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }) });
  if (res.status !== 200) throw new Error(`login → ${res.status}`);
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  addSecret(cookie.split("=")[1] ?? "");
  return cookie;
}
interface Resp {
  status: number;
  json: any;
  text: string;
  headers: Headers;
  bytes?: Uint8Array;
}
async function call(cookie: string | null, method: string, path: string, body?: unknown, opts: { binary?: boolean; headers?: Record<string, string>; rawBody?: Uint8Array; base?: string } = {}): Promise<Resp> {
  const res = await fetch(`${opts.base ?? CONTROL}${path}`, {
    method,
    headers: { ...(cookie ? { cookie } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(opts.headers ?? {}) },
    body: (opts.rawBody as unknown as BodyInit) ?? (body !== undefined ? JSON.stringify(body) : null),
  });
  if (opts.binary) return { status: res.status, json: null, text: "", headers: res.headers, bytes: new Uint8Array(await res.arrayBuffer()) };
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: res.status, json, text, headers: res.headers };
}
const TERMINAL = new Set(["done", "failed", "cancelled"]);
async function getTask(cookie: string, id: string): Promise<any> {
  const r = await call(cookie, "GET", `/api/tasks/${id}`);
  if (r.status !== 200) throw new Error(`GET task ${id} → ${r.status} ${r.text.slice(0, 200)}`);
  return r.json;
}
async function waitTerminal(cookie: string, id: string, timeoutMs = 30 * 60_000): Promise<any> {
  const t0 = Date.now();
  let last = "";
  for (;;) {
    const v = await getTask(cookie, id).catch(() => null);
    if (v) {
      const s = `${v.task.status}/${v.task.phase}`;
      if (s !== last) console.log(`  [${id}] ${s} (${Math.round((Date.now() - t0) / 1000)} s)`);
      last = s;
      if (TERMINAL.has(v.task.status)) return v;
    }
    if (Date.now() - t0 > timeoutMs) throw new Error(`task ${id} not terminal after ${timeoutMs} ms (${last})`);
    await sleep(3000);
  }
}
interface Ev {
  seq: number;
  kind: string;
  title: string;
  detail?: string;
  at: string;
  data?: any;
}
/** Replay the SSE stream from 0 until idle (or `end`); returns events and the raw stream text. */
async function allEventsRaw(cookie: string, id: string, idleMs = 4000): Promise<{ events: Ev[]; raw: string }> {
  const ctrl = new AbortController();
  const hard = setTimeout(() => ctrl.abort(), 90_000);
  const res = await fetch(`${CONTROL}/api/tasks/${id}/events?lastEventId=0`, { headers: { accept: "text/event-stream", cookie }, signal: ctrl.signal });
  const events: Ev[] = [];
  let raw = "";
  if (!res.ok || !res.body) {
    clearTimeout(hard);
    return { events, raw };
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let idle: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    clearTimeout(idle);
    idle = setTimeout(() => ctrl.abort(), idleMs);
  };
  arm();
  try {
    outer: for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = dec.decode(value, { stream: true });
      raw += chunk;
      buf += chunk;
      arm();
      let i: number;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        let ev = "message";
        let data = "";
        for (const line of block.split("\n")) {
          if (line.startsWith("event:")) ev = line.slice(6).trim();
          else if (line.startsWith("data:")) data += line.slice(5).trim();
        }
        if (ev === "end") break outer;
        if (!data) continue;
        try {
          const parsed = JSON.parse(data);
          if (typeof parsed?.seq === "number") events.push(parsed);
        } catch {
          // keep-alive or non-JSON
        }
      }
    }
  } catch (error) {
    if (!ctrl.signal.aborted) throw error;
  } finally {
    clearTimeout(hard);
    clearTimeout(idle);
    await reader.cancel().catch(() => undefined);
    ctrl.abort();
  }
  return { events, raw };
}
const slim = (evs: Ev[]) =>
  evs.map((e) => ({ seq: e.seq, at: e.at, kind: e.kind, title: e.title, ...(e.detail ? { detail: e.detail.slice(0, 300) } : {}), ...(e.data?.tool ? { tool: e.data.tool } : {}), ...(e.data?.opState ? { opState: e.data.opState } : {}), ...(e.data?.actor ? { actor: e.data.actor } : {}), ...(e.data?.error ? { error: String(e.data.error).slice(0, 200) } : {}) }));
function pngInfo(b: Uint8Array): { valid: boolean; width?: number; height?: number } {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (b.length < 24 || !sig.every((x, i) => b[i] === x)) return { valid: false };
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const ihdr = String.fromCharCode(b[12]!, b[13]!, b[14]!, b[15]!);
  const iend = String.fromCharCode(...b.slice(b.length - 8, b.length - 4));
  return { valid: ihdr === "IHDR" && iend === "IEND", width: dv.getUint32(16), height: dv.getUint32(20) };
}
function saveCookie(name: string, cookie: string, taskIds: string[]) {
  writeFileSync(join(SCRATCH, `${name}.session.json`), JSON.stringify({ cookie, taskIds }), { mode: 0o600 });
}
/** Model provenance from a task's own events (live, not scripted). */
function modelProvenance(evs: Ev[]) {
  const model = evs.filter((e) => e.kind === "model");
  const names = [...new Set(model.map((e) => e.data?.model).filter(Boolean))];
  const hosts = [...new Set(model.map((e) => e.data?.baseUrl ?? e.data?.host ?? e.data?.endpoint).filter(Boolean))];
  return { modelEvents: model.length, models: names, hosts, scripted: evs.some((e) => e.data?.diagnostic === true || /scripted:/.test(`${e.detail ?? ""}`)) };
}
/** Download every output artifact via both routes and check bytes against the recorded sha256. */
async function downloadOutputs(t: Test, cookie: string, id: string, label: string) {
  const list = await call(cookie, "GET", `/api/tasks/${id}/artifacts`);
  const arts = (list.json as any[]) ?? [];
  const downloads: Record<string, { id: string; sha256: string; bytes: Uint8Array; kind: string; mediaType: string; byteLength: number }> = {};
  for (const a of arts) {
    const byId = await call(cookie, "GET", `/api/artifacts/${a.id}?download=1`, undefined, { binary: true });
    const byTask = await call(cookie, "GET", `/api/tasks/${id}/artifacts/${a.id}?download=1`, undefined, { binary: true });
    const h1 = sha(byId.bytes!);
    const ok = byId.status === 200 && h1 === a.sha256 && byTask.status === 200 && sha(byTask.bytes!) === a.sha256;
    if (a.kind === "output" || a.kind === "screenshot" || a.kind === "download") t.check(ok, `${label}: ${a.kind} ${a.filename} (${a.byteLength} B) downloaded via /api/artifacts and /api/tasks/:id/artifacts, sha256 = recorded ${String(a.sha256).slice(0, 12)}`);
    downloads[`${a.kind}:${a.filename}`] = { id: a.id, sha256: a.sha256, bytes: byId.bytes!, kind: a.kind, mediaType: a.mediaType, byteLength: a.byteLength };
  }
  return { arts, downloads };
}
function findDl(downloads: Record<string, any>, kind: string, name: string) {
  return downloads[`${kind}:${name}`] ?? Object.entries(downloads).find(([k]) => k.startsWith(`${kind}:`) && k.endsWith(name))?.[1];
}
function summarizeTask(v: any) {
  const task = v.task;
  return { id: task.id, profileId: task.profileId, status: task.status, outcome: task.outcome, phase: task.phase, budget: task.budget, cleanup: task.cleanup, result: task.result, createdAt: task.createdAt, updatedAt: task.updatedAt, completion: v.completion ?? task.completion ?? null };
}

// ---------------------------------------------------------------------------------------------
// C: live repair from the tracked issue; export zip; preview with a changed input.
async function testRepair() {
  const t = new Test("V-C-repair-live", "Repair (C): fresh live repair from profiles/tabulate-365/issue.md as a judge → CANDIDATE_PASSED_CHECKS; export zip sha256 = x-airlock-zip-sha256, identical on repeat; preview with a changed input returns the fixed behaviour");
  const cookie = await login(JUDGE_PW);
  const avail = await call(cookie, "GET", "/api/repair-availability?profileId=tabulate-365");
  t.check(avail.json?.available === true, `repair availability: ${avail.json?.reason}`);
  const issueText = readFileSync(join(ROOT, "profiles/tabulate-365/issue.md"), "utf8").replace(/<!--[\s\S]*?-->/g, "").trim();
  const c = await call(cookie, "POST", "/api/tasks", { profileId: "tabulate-365", issueText });
  t.check(c.status === 201 && !c.json?.scriptedDriver && !c.json?.repairDisabledReason, `create live repair task → ${c.status} ${c.json?.id ?? c.text.slice(0, 200)}`);
  if (c.status !== 201) return saveRow(t);
  const id = c.json.id as string;
  saveCookie("repair", cookie, [id]);
  const v = await waitTerminal(cookie, id, 30 * 60_000);
  const { events } = await allEventsRaw(cookie, id);
  const prov = modelProvenance(events);
  t.check(prov.modelEvents > 0 && !prov.scripted, `live model run: ${prov.modelEvents} model events, models ${prov.models.join(",")}, hosts ${prov.hosts.join(",")}`);
  t.check(v.task.outcome === "CANDIDATE_PASSED_CHECKS", `outcome ${v.task.status}/${v.task.outcome}`);
  t.check(v.baseline?.passed === true && v.verification?.passed === true, `baseline reproduced (${v.baseline?.passed}); verification passed (${v.verification?.passed}, ${v.verification?.completedCases}/${v.verification?.requiredCases} cases)`);
  const rt = v.verification?.runtimeProfile?.inspection;
  t.check(rt?.runtime === "kata" && rt?.devUnsafe !== true, `verification ran on ${rt?.runtime} (devUnsafe ${rt?.devUnsafe})`);
  t.ev("task", { ...summarizeTask(v), candidateDigest: v.task.candidateDigest, verification: { passed: v.verification?.passed, completed: v.verification?.completedCases, required: v.verification?.requiredCases, runtime: rt?.runtime, imageId: rt?.imageId, guestUname: rt?.guestUname, cases: (v.verification?.cases ?? []).map((x: any) => ({ caseId: x.caseId, passed: x.passed })) }, baselinePassed: v.baseline?.passed });
  t.ev("provenance", prov);
  if (v.task.outcome === "CANDIDATE_PASSED_CHECKS") {
    const g = await call(cookie, "POST", `/api/tasks/${id}/export`, {});
    t.check(g.status === 201 || g.status === 200, `export grant → ${g.status}`);
    const z1 = await call(cookie, "GET", g.json.url, undefined, { binary: true });
    await sleep(1500);
    const g2 = await call(cookie, "POST", `/api/tasks/${id}/export`, {});
    const z2 = await call(cookie, "GET", g2.json.url, undefined, { binary: true });
    const h1 = sha(z1.bytes!);
    const h2 = sha(z2.bytes!);
    t.check(z1.status === 200 && h1 === z1.headers.get("x-airlock-zip-sha256") && h1 === g.json.zipDigest, `zip sha256 ${h1.slice(0, 16)} = x-airlock-zip-sha256 ${String(z1.headers.get("x-airlock-zip-sha256")).slice(0, 16)} = grant.zipDigest`);
    t.check(h1 === h2 && z2.headers.get("x-airlock-zip-sha256") === h1, `repeat export+download byte-identical (${h2.slice(0, 16)}; grant ${g2.json.grantId === g.json.grantId ? "same" : "new"})`);
    // Unzip the patch and show it (evidence).
    const zipPath = join(SCRATCH, `${id}.zip`);
    writeFileSync(zipPath, z1.bytes!);
    const list = Bun.spawnSync(["unzip", "-l", zipPath]).stdout.toString();
    const patch = Bun.spawnSync(["unzip", "-p", zipPath, "patch.diff"]).stdout.toString();
    t.check(patch.includes("tabulate/__init__.py"), `zip carries patch.diff touching tabulate/__init__.py (${patch.split("\n").length} lines)`);
    t.ev("export", { grantId: g.json.grantId, zipDigest: g.json.zipDigest, header: z1.headers.get("x-airlock-zip-sha256"), download1: h1, download2: h2, bytes: z1.bytes!.length, entries: list.split("\n").slice(3, -3).map((l) => l.trim()), patch: patch.slice(0, 4000) });
    // Preview with a changed input (not a contract case). Expected: the header-only table, as
    // tabulate renders it without maxheadercolwidths (headers shorter than the width, so no wrap).
    const input = { headers: ["Qty", "Sum", "Avg"], maxheadercolwidths: 10, tabular_data: [] as unknown[] };
    const expected = Bun.spawnSync(["python3", "-c", "import sys,json; sys.path.insert(0,'profiles/tabulate-365/base'); from tabulate import tabulate; print(json.dumps(tabulate([], headers=['Qty','Sum','Avg'])))"], { cwd: ROOT }).stdout.toString().trim();
    const baseBug = Bun.spawnSync(["python3", "-c", "import sys; sys.path.insert(0,'profiles/tabulate-365/base'); from tabulate import tabulate; tabulate([], headers=['Qty','Sum','Avg'], maxheadercolwidths=10)"], { cwd: ROOT }).stderr.toString();
    t.check(/IndexError/.test(baseBug), "the unpatched base raises IndexError for the changed input (locally)");
    let pv: Resp | null = null;
    for (let i = 0; i < 5; i++) {
      pv = await call(cookie, "POST", `/api/tasks/${id}/preview`, { candidateDigest: v.task.candidateDigest, input });
      if (pv.status !== 429) break;
      await sleep(3000);
    }
    const obs = pv?.json?.observation;
    t.check(pv?.status === 200 && obs?.status === "ok" && obs?.valueCanonical === expected, `preview (changed input) → ${pv?.status} ${obs?.status}: ${obs?.valueCanonical} (expected ${expected}) on ${pv?.json?.inspection?.runtime}`);
    const bad = await call(cookie, "POST", `/api/tasks/${id}/preview`, { candidateDigest: "0".repeat(64), input });
    t.check(bad.status === 409 || bad.status === 429, `preview with a foreign digest refused (${bad.status})`);
    t.ev("preview", { input, status: pv?.status, observation: obs, expected, exec: pv?.json?.exec && { status: pv.json.exec.status, exitCode: pv.json.exec.exitCode, durationMs: pv.json.exec.durationMs }, runtime: pv?.json?.inspection?.runtime, foreignDigest: bad.status });
  }
  t.ev("events", slim(events));
  saveRow(t);
}

// ---------------------------------------------------------------------------------------------
// A: analysis with a freshly generated CSV.
async function testAnalysis() {
  const t = new Test("V-A-analysis-live", "Analysis (A): fresh CSV upload → live analysis task → RESULT_VERIFIED with the correct answer (computed here); outputs download and match sha256");
  const cookie = await login(JUDGE_PW);
  const regions = ["Aster", "Birch", "Cedar", "Dogwood", "Elm", "Fir", "Ginkgo"];
  const rows = randomInt(9, 15);
  let csv = "store,region,units,unit_price\n";
  const revenue: Record<string, number> = {};
  for (let i = 0; i < rows; i++) {
    const region = regions[randomInt(0, 4)]!;
    const units = randomInt(1, 200);
    const price = randomInt(100, 5000) / 100;
    revenue[region] = (revenue[region] ?? 0) + units * price;
    csv += `s${i + 1},${region},${units},${price}\n`;
  }
  const ranked = Object.entries(revenue).sort((a, b) => b[1] - a[1]);
  if (ranked.length > 1 && Math.abs(ranked[0]![1] - ranked[1]![1]) < 1) return testAnalysis(); // avoid a near tie
  const top = ranked[0]!;
  const total = Math.round(Object.values(revenue).reduce((a, b) => a + b, 0) * 100) / 100;
  const up = await call(cookie, "POST", "/api/uploads", undefined, { rawBody: new TextEncoder().encode(csv), headers: { "x-filename": "store-sales.csv", "content-type": "text/csv" } });
  t.check(up.status === 201 && up.json?.sha256 === sha(csv), `upload → ${up.status}, recorded sha256 = sha256(bytes sent)`);
  const goal = "Using the uploaded CSV store-sales.csv (columns store, region, units, unit_price), compute revenue = units * unit_price for each row, total it per region, and find the region with the highest total revenue. Write outputs/summary.json with an `answer` field naming that region and its total revenue rounded to 2 decimals, plus `revenue_by_region` and `total_revenue`; also write a bar chart of revenue by region to outputs/chart.png.";
  const c = await call(cookie, "POST", "/api/tasks", { kind: "general", profileId: "analysis", issueText: goal, inputArtifactIds: [up.json.id] });
  t.check(c.status === 201 && !c.json?.scriptedDriver, `create live analysis task → ${c.status} ${c.json?.id ?? c.text.slice(0, 200)}`);
  if (c.status !== 201) return saveRow(t);
  const id = c.json.id as string;
  saveCookie("analysis", cookie, [id]);
  const v = await waitTerminal(cookie, id);
  const { events } = await allEventsRaw(cookie, id);
  const prov = modelProvenance(events);
  t.check(prov.modelEvents > 0 && !prov.scripted, `live model run (${prov.modelEvents} model events, ${prov.models.join(",")})`);
  t.check(v.task.status === "done" && v.task.outcome === "RESULT_VERIFIED", `outcome ${v.task.status}/${v.task.outcome}`);
  t.check(v.task.cleanup?.status === "confirmed", `cleanup ${v.task.cleanup?.status}`);
  const { arts, downloads } = await downloadOutputs(t, cookie, id, "analysis");
  const sj = findDl(downloads, "output", "summary.json");
  const png = findDl(downloads, "output", "chart.png");
  let summary: any = null;
  if (sj) summary = JSON.parse(new TextDecoder().decode(sj.bytes));
  const answer = String(summary?.answer ?? "");
  const numbers = (answer.match(/-?\d[\d,]*\.?\d*/g) ?? []).map((x) => Number(x.replace(/,/g, "")));
  t.check(answer.includes(top[0]) && numbers.some((n) => Math.abs(n - top[1]) < 0.02), `answer "${answer.slice(0, 160)}" names ${top[0]} with ${top[1].toFixed(2)} (computed here)`);
  const tr = Number(summary?.total_revenue);
  t.check(Math.abs(tr - total) < 0.05, `total_revenue ${summary?.total_revenue} = ${total} (computed here)`);
  const pi = png ? pngInfo(png.bytes) : { valid: false };
  t.check(pi.valid, `chart.png valid PNG ${pi.width}x${pi.height}`);
  t.ev("input", { csv, sha256: up.json?.sha256, expected: { topRegion: top[0], topRevenue: Math.round(top[1] * 100) / 100, revenueByRegion: Object.fromEntries(ranked.map(([k, x]) => [k, Math.round(x * 100) / 100])), total } });
  t.ev("summary", summary);
  t.ev("task", summarizeTask(v));
  t.ev("provenance", prov);
  t.ev("artifacts", arts.map((a) => ({ id: a.id, kind: a.kind, filename: a.filename, sha256: a.sha256, byteLength: a.byteLength, mediaType: a.mediaType })));
  t.ev("events", slim(events));
  saveRow(t);
}

// ---------------------------------------------------------------------------------------------
// B: web research on example.com / iana.org.
async function testWeb() {
  const t = new Test("V-B-web-research-live", "Web research (B): live web-research on example.com + iana.org (allowlisted) → RESULT_VERIFIED; screenshot artifact is a valid PNG");
  const cookie = await login(JUDGE_PW);
  const goal = "Open https://example.com/ and read what the page says it is for. Then follow its 'More information' / 'Learn more' link to iana.org and report, in one or two sentences, what IANA says about example domains. Take a screenshot as evidence and cite the pages you used.";
  const c = await call(cookie, "POST", "/api/tasks", { kind: "general", profileId: "web-research", issueText: goal, egressAllow: ["example.com", "iana.org", "www.iana.org"] });
  t.check(c.status === 201, `create live web-research task → ${c.status} ${c.json?.id ?? c.text.slice(0, 200)}`);
  if (c.status !== 201) return saveRow(t);
  const id = c.json.id as string;
  saveCookie("web", cookie, [id]);
  const v = await waitTerminal(cookie, id);
  const { events } = await allEventsRaw(cookie, id);
  const prov = modelProvenance(events);
  t.check(prov.modelEvents > 0 && !prov.scripted, `live model run (${prov.modelEvents} model events)`);
  t.check(v.task.status === "done" && v.task.outcome === "RESULT_VERIFIED", `outcome ${v.task.status}/${v.task.outcome}`);
  const navs = events.filter((e) => e.kind === "tool" && e.data?.tool === "browser_navigate" && e.data?.opState === "completed").map((e) => e.title);
  t.check(navs.length > 0, `browser_navigate completed: ${navs.join(" | ").slice(0, 300)}`);
  const created = events.find((e) => e.title === "browser sandbox created");
  t.check(created?.data?.browser?.probe?.allBlocked === true, "browser container isolation probe: all BLOCKED");
  const { arts, downloads } = await downloadOutputs(t, cookie, id, "web");
  const shots = Object.values(downloads).filter((d) => d.kind === "screenshot");
  const infos = shots.map((s) => pngInfo(s.bytes));
  t.check(shots.length > 0 && infos.every((p) => p.valid), `${shots.length} screenshot artifact(s), all valid PNG (${infos.map((p) => `${p.width}x${p.height}`).join(", ")})`);
  const destroyed = events.find((e) => /browser sandbox destroyed/.test(e.title));
  t.check(v.task.cleanup?.status === "confirmed", `cleanup ${v.task.cleanup?.status}`);
  t.ev("task", summarizeTask(v));
  t.ev("provenance", prov);
  t.ev("browser", { chromium: created?.data?.browser?.status?.browserVersion, runtime: created?.data?.inspection?.runtime ?? created?.data?.browser?.status?.sandbox, probe: created?.data?.browser?.probe });
  t.ev("egressDecisions", (destroyed?.data?.egress?.decisions ?? []).slice(0, 40));
  t.ev("artifacts", arts.map((a) => ({ id: a.id, kind: a.kind, filename: a.filename, sha256: a.sha256, byteLength: a.byteLength, source: a.source })));
  t.ev("screenshots", shots.map((s, i) => ({ sha256: s.sha256, ...infos[i] })));
  t.ev("events", slim(events));
  saveRow(t);
}

// ---------------------------------------------------------------------------------------------
// D: combined hero on the fixtures data page, variant a then b.
const HERO_EXPECTED = { a: { region: "South", ratio: 80 / 110 }, b: { region: "North", ratio: 90 / 120 } };
async function runHero(t: Test, cookie: string, variant: "a" | "b") {
  const url = variant === "a" ? `${FORMS}/data/regional-sales` : `${FORMS}/data/regional-sales?variant=b`;
  const goal = `Open ${url} (a disclosed synthetic sales dataset). Download the CSV the page links to and keep it with browser_download_save, then analyze it offline with code: for each region compute attainment = revenue / target, and find the region with the LOWEST attainment. Write outputs/summary.json with an \`answer\` field naming that region and its attainment rounded to 3 decimals, plus \`attainment_by_region\`; write a bar chart of attainment by region to outputs/chart.png. Take a screenshot of the page and cite ${url} as the source.`;
  const c = await call(cookie, "POST", "/api/tasks", { kind: "general", profileId: "web-analysis", issueText: goal, egressAllow: [FORMS_HOST] });
  t.check(c.status === 201, `variant ${variant}: create live web-analysis task → ${c.status} ${c.json?.id ?? c.text.slice(0, 200)}`);
  if (c.status !== 201) return null;
  const id = c.json.id as string;
  const v = await waitTerminal(cookie, id);
  const { events } = await allEventsRaw(cookie, id);
  const prov = modelProvenance(events);
  t.check(prov.modelEvents > 0 && !prov.scripted, `variant ${variant}: live model run (${prov.modelEvents} model events)`);
  t.check(v.task.status === "done" && v.task.outcome === "RESULT_VERIFIED", `variant ${variant}: outcome ${v.task.status}/${v.task.outcome}`);
  const { arts, downloads } = await downloadOutputs(t, cookie, id, `variant ${variant}`);
  const dl = Object.values(downloads).find((d) => d.kind === "download" || /\.csv$/.test(Object.keys(downloads).find((k) => downloads[k] === d) ?? ""));
  const served = await fetch(`${FORMS}/data/regional-sales.csv${variant === "b" ? "?variant=b" : ""}`).then((r) => r.text());
  const csvArt = Object.entries(downloads).find(([k, d]) => k.endsWith(".csv") && d.kind !== "output");
  t.check(csvArt && csvArt[1].sha256 === sha(served), `variant ${variant}: the saved CSV (${csvArt?.[0]}) is byte-identical to the served dataset (sha256 ${sha(served).slice(0, 12)})`);
  const saveEv = events.find((e) => e.kind === "tool" && /browser_download_save|browser_save_text/.test(e.data?.tool ?? "") && e.data?.opState === "completed");
  t.check(saveEv, `variant ${variant}: data crossed browser → code sandbox via ${saveEv?.data?.tool ?? "nothing"}`);
  const codeRun = events.filter((e) => /code_run/.test(e.data?.tool ?? "") || (e.kind === "exec" && /code_run|run/.test(e.data?.tool ?? "")));
  t.check(codeRun.length > 0, `variant ${variant}: offline code ran (${codeRun.length} code_run events)`);
  const sj = findDl(downloads, "output", "summary.json");
  const png = findDl(downloads, "output", "chart.png");
  const summary = sj ? JSON.parse(new TextDecoder().decode(sj.bytes)) : null;
  const exp = HERO_EXPECTED[variant];
  const answer = String(summary?.answer ?? "");
  const nums = (answer.match(/\d+\.\d+/g) ?? []).map(Number);
  t.check(answer.includes(exp.region) && (nums.length === 0 || nums.some((n) => Math.abs(n - exp.ratio) < 0.002 || Math.abs(n - exp.ratio * 100) < 0.2)), `variant ${variant}: answer "${answer.slice(0, 160)}" = ${exp.region} ${exp.ratio.toFixed(3)} (computed here)`);
  const pi = png ? pngInfo(png.bytes) : { valid: false };
  t.check(pi.valid, `variant ${variant}: chart.png valid PNG ${pi.width}x${pi.height}`);
  const shots = Object.values(downloads).filter((d) => d.kind === "screenshot");
  t.check(shots.length > 0 && shots.every((s) => pngInfo(s.bytes).valid), `variant ${variant}: ${shots.length} screenshot(s), valid PNG`);
  const completion = v.completion ?? v.task.completion ?? v.task.result?.checks;
  t.ev(`variant_${variant}`, { task: summarizeTask(v), provenance: prov, summary, expected: exp, servedCsvSha256: sha(served), artifacts: arts.map((a) => ({ id: a.id, kind: a.kind, filename: a.filename, sha256: a.sha256, byteLength: a.byteLength, source: a.source })), completion, events: slim(events) });
  void dl;
  return { id, v, summary, events };
}
async function testHero() {
  const t = new Test("V-D-hero-web-analysis-live", `Combined hero (D): live web-analysis on ${FORMS}/data/regional-sales (allowlist ${FORMS_HOST} only; disclosed synthetic fixture) → download CSV, offline analysis, chart, cite → RESULT_VERIFIED (South); ?variant=b → different correct answer (North)`);
  const cookie = await login(JUDGE_PW);
  const a = await runHero(t, cookie, "a");
  const b = await runHero(t, cookie, "b");
  saveCookie("hero", cookie, [a?.id, b?.id].filter(Boolean) as string[]);
  if (a?.summary && b?.summary) t.check(a.summary.answer !== b.summary.answer, `changed input → changed answer ("${String(a.summary.answer).slice(0, 60)}" vs "${String(b.summary.answer).slice(0, 60)}")`);
  saveRow(t);
}

// ---------------------------------------------------------------------------------------------
// E: approvals end to end on the forms destination.
function formsReadToken(): string {
  const tok = createHmac("sha256", FORMS_SECRET).update("airlock-forms-v1 receipts-read", "utf8").digest("base64url");
  addSecret(tok);
  return tok;
}
async function testApprovals() {
  const t = new Test("V-E-approvals-live", `Approvals (C25–C27): live web-research submits ${FORMS}/f/contact-request via browser_propose_submit; changed digest 409; exact digest approve; controller submits; proposal confirmed with the destination's receipt; replay 409; model never sees the approval code; unapproved direct submits refused (destination 403)`);
  const cookie = await login(JUDGE_PW);
  const nonce = randomBytes(4).toString("hex");
  const want = { name: "Airlock Acceptance", email: "acceptance@example.test", message: `Vultr acceptance run ${nonce}: please ignore.` };
  // Before any approval: a direct submit with these exact values and no / a forged code is refused.
  const direct = async (code?: string) => {
    const body = new URLSearchParams({ ...want, ...(code !== undefined ? { airlock_approval: code } : {}) });
    const r = await fetch(`${FORMS}/f/contact-request/submit`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: body.toString() });
    const text = await r.text();
    return { status: r.status, reason: /Reason code: <code>([^<]+)</.exec(text)?.[1] ?? null };
  };
  const noCode = await direct();
  const forged = await direct(`prop-forged.${Math.floor(Date.now() / 1000) + 600}.${"A".repeat(43)}`);
  t.check(noCode.status === 403 && forged.status === 403, `unapproved direct submits to the destination refused: no code → ${noCode.status} (${noCode.reason}); forged code → ${forged.status} (${forged.reason})`);
  const goal = `Go to ${FORMS}/f/contact-request and submit the contact request form with exactly these values: name "${want.name}", email "${want.email}", message "${want.message}". Use browser_propose_submit (a person will approve it), wait for the outcome, and report the destination's receipt id in your result with a screenshot and the form page as the cited source.`;
  const c = await call(cookie, "POST", "/api/tasks", { kind: "general", profileId: "web-research", issueText: goal, egressAllow: [FORMS_HOST] });
  t.check(c.status === 201, `create live web-research task → ${c.status} ${c.json?.id ?? c.text.slice(0, 200)}`);
  if (c.status !== 201) return saveRow(t);
  const id = c.json.id as string;
  saveCookie("approvals", cookie, [id]);
  let pending: any = null;
  for (let i = 0; i < 600 && !pending; i++) {
    const l = await call(cookie, "GET", `/api/tasks/${id}/approvals`);
    pending = ((l.json as any[]) ?? []).find((p) => p.status === "pending") ?? null;
    if (pending) break;
    const v = await getTask(cookie, id);
    if (TERMINAL.has(v.task.status)) break;
    await sleep(2000);
  }
  t.check(pending, `a proposal is pending (${pending?.id}; form ${pending?.formId} on ${pending?.destination}; digest ${String(pending?.payloadDigest).slice(0, 16)})`);
  if (!pending) {
    const v = await waitTerminal(cookie, id);
    t.ev("task", summarizeTask(v));
    t.ev("events", slim((await allEventsRaw(cookie, id)).events));
    return saveRow(t);
  }
  const fieldsOk = pending.fields && Object.entries(want).every(([k, x]) => pending.fields[k] === x);
  t.check(fieldsOk, `proposed fields are exactly the requested values (${JSON.stringify(pending.fields ?? pending.payload ?? null).slice(0, 200)})`);
  // Changed digest first (a different payload), then the exact digest, then a replay.
  const flipped = pending.payloadDigest.slice(0, -1) + (pending.payloadDigest.endsWith("0") ? "1" : "0");
  const changed = await call(cookie, "POST", `/api/tasks/${id}/approvals/${pending.id}/decide`, { decision: "approve", payloadDigest: flipped });
  t.check(changed.status === 409, `approve with a changed digest → ${changed.status} ${changed.text.slice(0, 120)}`);
  const other = await call(await login(JUDGE_PW), "POST", `/api/tasks/${id}/approvals/${pending.id}/decide`, { decision: "approve", payloadDigest: pending.payloadDigest });
  t.check(other.status === 404, `another judge session approving → ${other.status}`);
  const ok = await call(cookie, "POST", `/api/tasks/${id}/approvals/${pending.id}/decide`, { decision: "approve", payloadDigest: pending.payloadDigest });
  t.check(ok.status === 200 && ok.json?.status === "approved", `approve with the exact digest → ${ok.status} ${ok.json?.status}`);
  const replay = await call(cookie, "POST", `/api/tasks/${id}/approvals/${pending.id}/decide`, { decision: "approve", payloadDigest: pending.payloadDigest });
  t.check(replay.status === 409, `replayed decide → ${replay.status} ${replay.text.slice(0, 120)}`);
  // Wait for the controller to submit and confirm.
  let final: any = null;
  for (let i = 0; i < 180; i++) {
    const l = await call(cookie, "GET", `/api/tasks/${id}/approvals`);
    final = ((l.json as any[]) ?? []).find((p) => p.id === pending.id);
    if (final && !["approved", "claimed", "submitted", "pending"].includes(final.status)) break;
    await sleep(2000);
  }
  t.check(final?.status === "confirmed" && final?.receipt?.receiptId, `proposal → ${final?.status}; receipt ${final?.receipt?.receiptId ?? "none"}`);
  // Independent read at the destination (receipts API, bearer derived from the shared secret).
  if (FORMS_SECRET) {
    const r = await fetch(`${FORMS}/api/receipts/${encodeURIComponent(pending.id)}`, { headers: { authorization: `Bearer ${formsReadToken()}` } });
    const rj: any = await r.json().catch(() => null);
    t.check(r.status === 200 && rj?.status === "confirmed" && rj?.receiptId === final?.receipt?.receiptId && rj?.payloadDigest === pending.payloadDigest, `destination's own receipt store: ${r.status} ${rj?.status} ${rj?.receiptId} digest ${String(rj?.payloadDigest).slice(0, 16)} (matches proposal)`);
    t.ev("destinationReceipt", rj);
  }
  // A second submission with the same code/values cannot happen: replaying the decision is 409 above;
  // a direct re-submit without the code is still refused.
  const after = await direct();
  t.check(after.status === 403, `direct submit of the same values after approval, without the code → ${after.status} (${after.reason})`);
  const v = await waitTerminal(cookie, id);
  t.check(v.task.status === "done", `task ${v.task.status}/${v.task.outcome}`);
  const decideAfter = await call(cookie, "POST", `/api/tasks/${id}/approvals/${pending.id}/decide`, { decision: "approve", payloadDigest: pending.payloadDigest });
  t.check(decideAfter.status === 409 || decideAfter.status === 410, `decide after the task ended → ${decideAfter.status}`);
  const { events, raw } = await allEventsRaw(cookie, id);
  // The model never saw the approval code: no code-shaped string, and no MAC for this proposal, anywhere
  // in the task's events (which include every model call and tool result) or the task view.
  const view = JSON.stringify(await getTask(cookie, id));
  const codeRe = new RegExp(`${pending.id.replace(/[-]/g, "\\-")}\\.[1-9][0-9]{8,11}\\.[A-Za-z0-9_-]{43}`);
  let macHit = false;
  if (FORMS_SECRET) {
    const exp = Math.floor(Date.parse(pending.expiresAt) / 1000);
    for (const e of [exp - 1, exp, exp + 1]) {
      const mac = createHmac("sha256", FORMS_SECRET).update(`${pending.id}.${pending.payloadDigest}.${e}`, "utf8").digest("base64url");
      if (raw.includes(mac) || view.includes(mac)) macHit = true;
    }
  }
  t.check(!codeRe.test(raw) && !codeRe.test(view) && !macHit && !/airlock_approval[^a-z]{0,8}[A-Za-z0-9]{8,}\.\d/.test(raw), `no approval code (pattern or computed MAC) in ${events.length} events (${raw.length} B incl. model calls/tool results) or the task view`);
  const modelSawOutcome = events.find((e) => e.kind === "tool" && e.data?.tool === "browser_propose_submit");
  t.ev("proposal", { id: pending.id, formId: pending.formId, destination: pending.destination, payloadDigest: pending.payloadDigest, expiresAt: pending.expiresAt, fields: pending.fields, final: final && { status: final.status, receipt: final.receipt, decidedBy: final.decidedBy ? "<owner>" : undefined } });
  t.ev("decisions", { changedDigest: { status: changed.status, body: changed.text.slice(0, 200) }, otherJudge: other.status, exact: { status: ok.status, proposalStatus: ok.json?.status }, replay: { status: replay.status, body: replay.text.slice(0, 200) }, afterEnd: decideAfter.status });
  t.ev("directSubmits", { beforeNoCode: noCode, beforeForged: forged, afterNoCode: after });
  t.ev("modelToolEvent", modelSawOutcome && { title: modelSawOutcome.title, detail: modelSawOutcome.detail?.slice(0, 400), opState: modelSawOutcome.data?.opState });
  t.ev("task", summarizeTask(v));
  t.ev("provenance", modelProvenance(events));
  t.ev("events", slim(events));
  saveRow(t);
}

// ---------------------------------------------------------------------------------------------
// F: human takeover on a running live browser task.
async function testTakeover() {
  const t = new Test("V-F-takeover-live", "Takeover (C22–C24): owner takes control of a running live browser task; one human navigate + screenshot inside the allowlist; navigate outside → 422; human submit of the form without approval refused; release; the agent must observe afresh");
  const cookie = await login(JUDGE_PW);
  const goal = `Open ${FORMS}/ and list every page it links to, visiting each of the linked pages on ${FORMS_HOST} in turn and describing each in one sentence. Take a screenshot of each page and cite them all. Do not submit any form.`;
  const c = await call(cookie, "POST", "/api/tasks", { kind: "general", profileId: "web-research", issueText: goal, egressAllow: [FORMS_HOST] });
  t.check(c.status === 201, `create live web-research task → ${c.status} ${c.json?.id ?? c.text.slice(0, 200)}`);
  if (c.status !== 201) return saveRow(t);
  const id = c.json.id as string;
  saveCookie("takeover", cookie, [id]);
  let live = false;
  for (let i = 0; i < 900 && !live; i++) {
    const r = await call(cookie, "GET", `/api/tasks/${id}/control`);
    live = !!r.json?.live?.liveBrowser;
    if (!live) {
      const v = await getTask(cookie, id);
      if (TERMINAL.has(v.task.status)) break;
      await sleep(300);
    }
  }
  t.check(live, "task running with a live browser");
  if (!live) return saveRow(t);
  const other = await call(await login(JUDGE_PW), "POST", `/api/tasks/${id}/control/take`, {});
  t.check(other.status === 404, `another judge session cannot take control (${other.status})`);
  // The browser sandbox is created by the agent's first navigate (Kata cold start ~15 s, longer than
  // the 10 s handover settle bound): take once it exists, retrying a refused handover (409) twice.
  for (let i = 0; i < 300; i++) {
    const evs = (await allEventsRaw(cookie, id, 1500)).events;
    if (evs.some((e) => e.title === "browser sandbox created")) break;
    await sleep(500);
  }
  const takeTries: { status: number; body: string }[] = [];
  let take: Resp = await call(cookie, "POST", `/api/tasks/${id}/control/take`, {});
  takeTries.push({ status: take.status, body: take.text.slice(0, 200) });
  for (let i = 0; i < 2 && take.status === 409; i++) {
    await sleep(2000);
    take = await call(cookie, "POST", `/api/tasks/${id}/control/take`, {});
    takeTries.push({ status: take.status, body: take.text.slice(0, 200) });
  }
  t.ev("takeTries", takeTries);
  t.check(take.status === 200 && take.json?.holder === "human", `owner take → ${take.status} holder=${take.json?.holder} fence=${take.json?.fenceGeneration} (tries: ${takeTries.map((x) => x.status).join(",")})`);
  const seqAtTake = Math.max(0, ...(await allEventsRaw(cookie, id, 2000)).events.filter((e) => e.title !== "Human took control").map((e) => e.seq));
  const nav = await call(cookie, "POST", `/api/tasks/${id}/control/action`, { request: { op: "navigate", args: { url: `${FORMS}/f/contact-request` } } });
  t.check(nav.status === 200 && nav.json?.ok, `human navigate ${FORMS}/f/contact-request (allowlisted) → ${nav.status} ok=${nav.json?.ok} http=${nav.json?.result?.result?.status ?? nav.json?.result?.status ?? "?"}`);
  const shot = await call(cookie, "POST", `/api/tasks/${id}/control/action`, { request: { op: "screenshot" } });
  let shotInfo: any = null;
  if (shot.json?.artifactId) {
    const d = await call(cookie, "GET", `/api/tasks/${id}/artifacts/${shot.json.artifactId}`, undefined, { binary: true });
    shotInfo = { artifactId: shot.json.artifactId, sha256: sha(d.bytes!), ...pngInfo(d.bytes!) };
  }
  t.check(shot.status === 200 && shot.json?.ok && shotInfo?.valid, `human screenshot → ${shot.status}, artifact ${shot.json?.artifactId} valid PNG ${shotInfo?.width}x${shotInfo?.height}`);
  const outside = await call(cookie, "POST", `/api/tasks/${id}/control/action`, { request: { op: "navigate", args: { url: "https://example.com/" } } });
  t.check(outside.status === 422 && !outside.json?.ok, `human navigate https://example.com/ (outside the allowlist) → ${outside.status} ${outside.text.slice(0, 160)}`);
  // Human submit without an approval code: observe, type the fields, click Submit.
  const obs = await call(cookie, "POST", `/api/tasks/${id}/control/action`, { request: { op: "observe" } });
  const obsText = JSON.stringify(obs.json?.result ?? {});
  const gen = Number(obs.json?.result?.result?.generation ?? obs.json?.result?.generation ?? /"generation"\s*:\s*(\d+)/.exec(obsText)?.[1]);
  const refFor = (pat: RegExp) => {
    const m = [...obsText.matchAll(/\{[^{}]*?"ref"\s*:\s*"([a-z0-9]+)"[^{}]*?\}/gi)].find((x) => pat.test(x[0]));
    return m?.[1];
  };
  const nameRef = refFor(/"Name"/);
  const submitRef = refFor(/"button"[^{}]*"Submit"|"Submit"[^{}]*"button"/);
  let typed: Resp | null = null;
  if (nameRef) typed = await call(cookie, "POST", `/api/tasks/${id}/control/action`, { request: { op: "type", args: { ref: nameRef, generation: gen, text: "Human Takeover" } } });
  const click = submitRef ? await call(cookie, "POST", `/api/tasks/${id}/control/action`, { request: { op: "click", args: { ref: submitRef, generation: gen } } }) : null;
  await sleep(1500);
  const obs2 = await call(cookie, "POST", `/api/tasks/${id}/control/action`, { request: { op: "observe" } });
  const obs2Text = JSON.stringify(obs2.json?.result ?? {});
  const refused = (click && (!click.json?.ok || /refus|mutation|not allowed|403/i.test(click.text))) || /Submission refused/i.test(obs2Text);
  const accepted = /Submission accepted/i.test(obs2Text);
  t.check(submitRef && refused && !accepted, `human click on Submit without an approval code refused (click ${click?.status} ok=${click?.json?.ok}: ${click?.text.slice(0, 160)}; page after: ${/Submission refused[^"]{0,80}/.exec(obs2Text)?.[0] ?? /"url"\s*:\s*"[^"]+"/.exec(obs2Text)?.[0] ?? "?"})`);
  const rel = await call(cookie, "POST", `/api/tasks/${id}/control/release`, {});
  t.check(rel.status === 200 && rel.json?.holder === "agent", `release → ${rel.status} holder=${rel.json?.holder} fence=${rel.json?.fenceGeneration}`);
  const v = await waitTerminal(cookie, id);
  const { events } = await allEventsRaw(cookie, id);
  const tookAt = events.filter((e) => e.title === "Human took control").at(-1)?.seq ?? seqAtTake;
  const during = events.filter((e) => e.seq > tookAt);
  const relIdx = during.findIndex((e) => e.title === "Control returned to the agent");
  const whileHeld = relIdx >= 0 ? during.slice(0, relIdx) : during;
  const agentWhileHeld = whileHeld.filter((e) => e.kind === "tool" && (e.data?.opState === "started" || e.data?.opState === "completed") && e.data?.actor !== "human" && !String(e.data?.tool ?? "").startsWith("human_") && e.data?.tool !== "live_view");
  t.check(agentWhileHeld.length === 0, `no agent browser op started/completed while the human held control (${agentWhileHeld.map((e) => e.title).join("; ")})`);
  const retEv = relIdx >= 0 ? during[relIdx] : undefined;
  t.check(retEv && /observe the page before any ref-bound action/.test(retEv.detail ?? ""), `"Control returned to the agent": ${retEv?.detail?.slice(0, 160)}`);
  const afterRel = relIdx >= 0 ? during.slice(relIdx + 1).filter((e) => e.kind === "tool" && String(e.data?.tool ?? "").startsWith("browser_") && e.data?.actor !== "human") : [];
  const firstRefBound = afterRel.find((e) => /browser_(click|type|key)/.test(e.data?.tool));
  const firstObserve = afterRel.find((e) => e.data?.tool === "browser_observe" && e.data?.opState === "completed");
  const staleRefused = afterRel.filter((e) => /browser_(click|type|key)/.test(e.data?.tool) && e.seq < (firstObserve?.seq ?? Infinity) && e.data?.opState !== "completed");
  const refBoundBeforeObserveCompleted = afterRel.filter((e) => /browser_(click|type|key)/.test(e.data?.tool) && e.data?.opState === "completed" && e.seq < (firstObserve?.seq ?? Infinity));
  t.check(refBoundBeforeObserveCompleted.length === 0, `after release no ref-bound agent op completed before a fresh observe (first observe seq ${firstObserve?.seq ?? "none"}; first ref-bound ${firstRefBound ? `${firstRefBound.data?.tool}@${firstRefBound.seq} ${firstRefBound.data?.opState}` : "none"}; stale refusals ${staleRefused.length})`);
  t.check(afterRel.some((e) => e.data?.opState === "completed"), `agent resumed after release (${afterRel.filter((e) => e.data?.opState === "completed").length} completed agent browser ops)`);
  t.check(TERMINAL.has(v.task.status) && v.task.cleanup?.status === "confirmed", `task ${v.task.status}/${v.task.outcome}; cleanup ${v.task.cleanup?.status}`);
  t.ev("humanActions", { take: take.json, navigate: { status: nav.status, ok: nav.json?.ok, body: nav.text.slice(0, 400) }, screenshot: shotInfo, outside: { status: outside.status, body: outside.text.slice(0, 400) }, observeGeneration: gen, refs: { nameRef, submitRef }, type: typed && { status: typed.status, ok: typed.json?.ok, body: typed.text.slice(0, 200) }, submitClick: click && { status: click.status, ok: click.json?.ok, body: click.text.slice(0, 400) }, pageAfterClick: obs2Text.slice(0, 1200), release: rel.json });
  t.ev("task", summarizeTask(v));
  t.ev("provenance", modelProvenance(events));
  t.ev("events", slim(events));
  saveRow(t);
}

// ---------------------------------------------------------------------------------------------
// K: hostile panel on Kata + two-judge isolation.
async function hostile(cookie: string, command: string) {
  for (let i = 0; i < 20; i++) {
    const r = await call(cookie, "POST", "/api/hostile", { command });
    if (r.status !== 429) return r;
    await sleep(3000);
  }
  throw new Error("hostile panel stayed rate limited");
}
async function testHostile() {
  const t = new Test("V-K-hostile-kata", "Containment on Kata: hostile panel as judge (fork bomb, rm -rf / --no-preserve-root, curl 169.254.169.254) → card shows kata, died/survived, controlPlane healthy, teardown '(no sandboxes)'");
  const cookie = await login(JUDGE_PW);
  const cmds: [string, string][] = [
    ["fork-bomb", ":(){ :|:& };:; sleep 3; echo alive"],
    ["rm-rf", "rm -rf / --no-preserve-root; echo rc=$?; ls / | head"],
    // The sandbox image has no curl (exit 127 would prove nothing): try curl, then python and bash /dev/tcp.
    ["metadata", "curl -sS -m 4 http://169.254.169.254/v1.json ; echo curl_rc=$?; python3 -c \"import urllib.request as u\ntry:\n print('BODY', u.urlopen('http://169.254.169.254/v1.json', timeout=4).read()[:120])\nexcept Exception as e:\n print('py_err', type(e).__name__, e)\"; timeout 5 bash -c 'exec 3<>/dev/tcp/169.254.169.254/80 && echo tcp_open' ; echo tcp_rc=$?"],
  ];
  const cards: Record<string, unknown> = {};
  for (const [name, command] of cmds) {
    const lat: number[] = [];
    let stop = false;
    const poller = (async () => {
      while (!stop) {
        const s = performance.now();
        const r = await fetch(`${CONTROL}/api/health`).catch(() => null);
        lat.push(r?.status === 200 ? performance.now() - s : -1);
        await sleep(500);
      }
    })();
    const r = await hostile(cookie, command);
    stop = true;
    await poller;
    const card = r.json;
    t.check(r.status === 200, `${name}: POST /api/hostile → ${r.status} ${r.status !== 200 ? r.text.slice(0, 160) : ""}`);
    if (r.status !== 200) continue;
    const listing = card.teardown?.host;
    const noSandboxes = card.teardown?.clean && listing && listing.containers.length === 0 && listing.volumes.length === 0 && (listing.networks ?? []).length === 0;
    t.check(card.inspection?.runtime === "kata" && card.inspection?.devUnsafe !== true, `${name}: sandbox runtime ${card.inspection?.runtime} (devUnsafe ${card.inspection?.devUnsafe}; guest ${String(card.inspection?.guestUname ?? "").slice(0, 60)})`);
    t.check(card.died?.container && card.died?.reason, `${name}: died: ${card.died?.container} — ${String(card.died?.reason).slice(0, 100)}`);
    t.check(card.survived?.supervisorHealthy && card.survived?.hostSentinelUnchanged && card.survived?.controlPlane?.healthyBefore && card.survived?.controlPlane?.healthyAfter, `${name}: survived: supervisor ${card.survived?.supervisorHealthy}, host sentinel ${card.survived?.hostSentinelUnchanged}, control plane ${card.survived?.controlPlane?.healthyBefore}/${card.survived?.controlPlane?.healthyAfter}`);
    t.check(noSandboxes, `${name}: teardown host listing "(no sandboxes)" (containers ${listing?.containers?.length}, networks ${listing?.networks?.length}, volumes ${listing?.volumes?.length})`);
    const failures = lat.filter((x) => x < 0).length;
    t.check(failures === 0, `${name}: /api/health answered ${lat.length}× during the run, ${failures} failures, max ${Math.round(Math.max(0, ...lat))} ms`);
    const out = `${card.exec?.stdout ?? ""}\n${card.exec?.stderr ?? ""}`;
    if (name === "metadata") t.check(/py_err/.test(out) && !/BODY|tcp_open/.test(out) && /tcp_rc=[1-9]/.test(out) && !/instance-id|"instanceid"|hostname/i.test(out), `metadata unreachable from the sandbox by python urllib and bash /dev/tcp (${out.replace(/\s+/g, " ").slice(0, 260)})`);
    cards[name] = { exec: { status: card.exec?.status, exitCode: card.exec?.exitCode, durationMs: card.exec?.durationMs, stdoutTail: String(card.exec?.stdout ?? "").slice(-500), stderrTail: String(card.exec?.stderr ?? "").slice(-300) }, died: card.died, survived: card.survived, workspace: card.workspace, teardown: card.teardown, inspection: { runtime: card.inspection?.runtime, devUnsafe: card.inspection?.devUnsafe, guestUname: card.inspection?.guestUname, imageId: card.inspection?.imageId }, health: { samples: lat.length, failures, maxMs: Math.round(Math.max(0, ...lat)) } };
  }
  const operator = await login(OPER_PW);
  const asOp = await call(operator, "POST", "/api/hostile", { command: "true" });
  t.check(asOp.status === 403, `operator cannot run the hostile panel (${asOp.status})`);
  t.ev("cards", cards);
  saveRow(t);
}
async function testIsolation() {
  const t = new Test("V-T-two-judge-isolation", "Two judge sessions cannot see each other's tasks, events, artifacts, approvals, control, exports (404) on the deployed stack");
  const sessions = readdirSync(SCRATCH).filter((f) => f.endsWith(".session.json")).map((f) => ({ name: f.replace(".session.json", ""), ...JSON.parse(readFileSync(join(SCRATCH, f), "utf8")) as { cookie: string; taskIds: string[] } }));
  const a = sessions.find((s) => s.name === "approvals") ?? sessions.find((s) => s.taskIds.length);
  if (!a) {
    t.blocked = "no earlier task sessions recorded (run V-A/V-B/V-E first)";
    return saveRow(t);
  }
  addSecret(a.cookie.split("=")[1] ?? "");
  const b = await login(JUDGE_PW);
  const who = [await call(a.cookie, "GET", "/api/session"), await call(b, "GET", "/api/session")];
  t.check(who.every((w) => w.json?.role === "judge") && who[0]!.json?.owner !== who[1]!.json?.owner, `both sessions are judge, different owners`);
  const probes: [string, string, unknown?][] = [];
  for (const s of sessions) {
    for (const id of s.taskIds) {
      probes.push(["GET", `/api/tasks/${id}`], ["GET", `/api/tasks/${id}/events?lastEventId=0`], ["GET", `/api/tasks/${id}/artifacts`]);
      const arts = (await call(s.cookie, "GET", `/api/tasks/${id}/artifacts`)).json as any[] | null;
      if (arts?.[0]) probes.push(["GET", `/api/artifacts/${arts[0].id}`], ["GET", `/api/tasks/${id}/artifacts/${arts[0].id}`]);
      if (s.name !== "analysis" && s.name !== "repair") probes.push(["GET", `/api/tasks/${id}/approvals`], ["GET", `/api/tasks/${id}/control`], ["POST", `/api/tasks/${id}/control/take`, {}], ["POST", `/api/tasks/${id}/approvals/prop-00000000/decide`, { decision: "approve", payloadDigest: "0".repeat(64) }]);
      probes.push(["POST", `/api/tasks/${id}/export`, {}], ["POST", `/api/tasks/${id}/cancel`, {}]);
      addSecret(s.cookie.split("=")[1] ?? "");
    }
  }
  const seen: any[] = [];
  for (const [m, p, body] of probes) {
    const r = await call(b, m, p, body);
    seen.push({ method: m, path: p, status: r.status });
    t.check(r.status === 404, `judge B ${m} ${p} → ${r.status}`);
  }
  const listB = ((await call(b, "GET", "/api/tasks")).json as any[]) ?? [];
  const all = sessions.flatMap((s) => s.taskIds);
  t.check(!listB.some((x) => all.includes(x.id)), `judge B's task list (${listB.length}) excludes the other sessions' ${all.length} tasks`);
  const own = await call(a.cookie, "GET", `/api/tasks/${a.taskIds[0]}`);
  t.check(own.status === 200, `the owning judge session still reads its task (${own.status})`);
  const anon = await call(null, "GET", `/api/tasks/${a.taskIds[0]}`);
  t.check(anon.status === 401, `anonymous → ${anon.status}`);
  t.ev("probes", seen);
  t.ev("sessionsProbed", sessions.map((s) => ({ name: s.name, taskIds: s.taskIds })));
  saveRow(t);
}

// ---------------------------------------------------------------------------------------------
// Z: host-wide cleanup on VM B.
function ssh(ip: string, cmd: string) {
  const p = Bun.spawnSync(["ssh", "-i", SSH_KEY, "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", `root@${ip}`, cmd]);
  return { code: p.exitCode, out: p.stdout.toString().trim(), err: p.stderr.toString().trim() };
}
async function testCleanup() {
  const t = new Test("V-Z-host-cleanup", "Cleanup: after everything, the host-wide listing on VM B (label airlock.supervisor=true) is empty: containers, networks, volumes; supervisor host listing empty");
  const cookie = await login(OPER_PW);
  const tasks = ((await call(cookie, "GET", "/api/tasks")).json as any[]) ?? [];
  const running = tasks.filter((x) => !TERMINAL.has(x.status));
  t.check(running.length === 0, `no task is still running (${running.map((x) => `${x.id}:${x.status}`).join(", ") || "none"})`);
  const f = "--filter label=airlock.supervisor=true";
  const c = ssh(SANDBOX_IP, `docker ps -a ${f} --format '{{.Names}} {{.Status}}'; echo '--'; docker network ls ${f} --format '{{.Name}}'; echo '--'; docker volume ls ${f} --format '{{.Name}}'; echo '--'; docker ps -a --format '{{.Names}} {{.Image}} {{.Status}}'`);
  const [containers, networks, volumes, all] = c.out.split("--").map((s) => s.trim().split("\n").filter(Boolean));
  t.check(c.code === 0, `ssh VM B (${SANDBOX_IP}) listing exit ${c.code} ${c.err.slice(0, 120)}`);
  t.check((containers ?? []).length === 0, `containers with label airlock.supervisor=true: ${(containers ?? []).length} ${(containers ?? []).join("; ")}`);
  t.check((networks ?? []).length === 0, `networks: ${(networks ?? []).length} ${(networks ?? []).join("; ")}`);
  t.check((volumes ?? []).length === 0, `volumes: ${(volumes ?? []).length} ${(volumes ?? []).join("; ")}`);
  const host = await call(cookie, "GET", "/api/host");
  t.ev("vmB", { ip: SANDBOX_IP, containers, networks, volumes, allContainersOnHost: all });
  t.ev("host", host.json && { selectedRuntime: host.json.selectedRuntime, devUnsafe: host.json.devUnsafe, runtimeImageId: host.json.runtimeImageId });
  t.ev("tasksSeenByOperator", tasks.map((x) => ({ id: x.id, profileId: x.profileId, status: x.status, outcome: x.outcome, cleanup: x.cleanup?.status, createdAt: x.createdAt })).filter((x) => x.createdAt >= (process.env.AIRLOCK_ACC_SINCE ?? "")));
  saveRow(t);
}

// ---------------------------------------------------------------------------------------------
function summary() {
  const files = readdirSync(EVID).filter((f) => f.startsWith("V-") && f.endsWith(".json"));
  const rows = files.map((f) => JSON.parse(readFileSync(join(EVID, f), "utf8"))).map(({ evidence: _e, ...r }) => ({ ...r, evidence: `${EVID_REL}/${r.id}.json` }));
  writeFileSync(join(EVID, "results.json"), sanitizeText(JSON.stringify({ updatedAt: iso(), revision: REVISION, category: "real Vultr compute + live model", environment: ENVIRONMENT, rows }, null, 2)));
  // Secret scan over the whole evidence directory.
  const leaks: string[] = [];
  for (const f of readdirSync(EVID)) {
    const text = readFileSync(join(EVID, f), "utf8");
    for (const s of [...Object.values(SECRET_FILE), ...Object.values(DOT_ENV)].filter((x) => x.length >= 6)) if (text.includes(s)) leaks.push(`${f}: a secrets.env/.env value`);
    if (/airlock_session=(?!<redacted>)/.test(text)) leaks.push(`${f}: session cookie`);
  }
  console.log(rows.map((r) => `${r.id}: ${r.result}`).join("\n"));
  console.log(leaks.length ? `SECRET SCAN: ${leaks.length} hit(s): ${leaks.join("; ")}` : `secret scan: 0 hits across ${readdirSync(EVID).length} files`);
  if (leaks.length) process.exit(3);
}

const TESTS: Record<string, () => Promise<void>> = {
  "V-C": testRepair,
  "V-A": testAnalysis,
  "V-B": testWeb,
  "V-D": testHero,
  "V-E": testApprovals,
  "V-F": testTakeover,
  "V-K": testHostile,
  "V-T": testIsolation,
  "V-Z": testCleanup,
};
async function main() {
  const ids = process.argv.slice(2);
  if (ids.includes("summary")) return summary();
  for (const id of ids) {
    const fn = TESTS[id];
    if (!fn) throw new Error(`unknown test ${id}; known: ${Object.keys(TESTS).join(", ")}`);
    try {
      await fn();
    } catch (error) {
      console.error(error);
      if (current) saveRow(current, error);
    }
  }
}
await main();
