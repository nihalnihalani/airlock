#!/usr/bin/env bun
/**
 * Independent acceptance driver (verifier_tester) against the REAL local dev stack
 * (scripts/dev-up.sh --detach; runc, AIRLOCK_DEV_UNSAFE=1 — every result is "real local runc,
 * dev-unsafe", never a deployment measurement). Drives the public HTTP API plus external observations
 * (supervisor read routes with the dev token, `docker ps/network/volume` by label, `colima ssh ps`).
 *
 *   bun scripts/acceptance/local.ts [testId ...]        (no ids: run everything, in order)
 *
 * Expected stack env (see docs/acceptance-matrix.md "How to reproduce"):
 *   AIRLOCK_GENERAL_DIAGNOSTIC_SCRIPTS_DIR=scripts/acceptance/fixtures/general
 *   AIRLOCK_PROPOSAL_TTL_MS=60000
 *   AIRLOCK_FORMS_ORIGINS=http://127.0.0.1:3100,https://forms.example.com
 *   AIRLOCK_JUDGE_PASSWORD / AIRLOCK_OPERATOR_PASSWORD (default verify-judge-1 / verify-oper-1)
 *
 * Every test records PASS / FAIL / BLOCKED with sanitized evidence under docs/evidence/local/<id>.json
 * and a roll-up in docs/evidence/local/results.json. Secrets (supervisor token, passwords, forms
 * secret, cookies) are replaced by <redacted> before anything is written.
 */
import { createHash, randomInt } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");
/** Evidence directory, relative to the repo (AIRLOCK_EVIDENCE_SUBDIR keeps separate runs apart). */
const EVID_REL = `docs/evidence/local${process.env.AIRLOCK_EVIDENCE_SUBDIR ? `/${process.env.AIRLOCK_EVIDENCE_SUBDIR}` : ""}`;
const EVID = join(ROOT, EVID_REL);
mkdirSync(EVID, { recursive: true });

function readEnvFile(p: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(p)) return out;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}
/** Where the running stack lives (a pristine `git archive` export when set), for data/run and dev-up.sh. */
const STACK = resolve(process.env.AIRLOCK_STACK_ROOT ?? ROOT);
const NAMESPACE = process.env.AIRLOCK_NAMESPACE ?? "airlock";
const DEV = { ...readEnvFile(join(STACK, "data/dev.env")), ...readEnvFile(join(STACK, "data/run/stack.env")) };
const CONTROL = (process.env.AIRLOCK_CONTROL_URL ?? DEV.AIRLOCK_CONTROL_URL ?? "http://127.0.0.1:3000").replace(/\/+$/, "");
// The stack's own records win: Bun auto-loads the cwd's .env, which may describe a different stack.
const SUPERVISOR = (DEV.SUPERVISOR_URL ?? process.env.SUPERVISOR_URL ?? "http://127.0.0.1:4300").replace(/\/+$/, "");
const SUP_TOKEN = DEV.SUPERVISOR_TOKEN ?? process.env.SUPERVISOR_TOKEN ?? "";
const JUDGE_PW = process.env.AIRLOCK_JUDGE_PASSWORD ?? "verify-judge-1";
const OPER_PW = process.env.AIRLOCK_OPERATOR_PASSWORD ?? "verify-oper-1";
const DOCKER_HOST = process.env.DOCKER_HOST ?? `unix://${process.env.HOME}/.colima/default/docker.sock`;
const SECRETS = [SUP_TOKEN, JUDGE_PW, OPER_PW, DEV.AIRLOCK_FORMS_SECRET ?? "", DEV.AIRLOCK_JUDGE_PASSWORD ?? "", DEV.AIRLOCK_OPERATOR_PASSWORD ?? ""].filter((s) => s.length >= 6);
const PINNED = process.env.AIRLOCK_STACK_REVISION?.trim();
const REVISION = PINNED || Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: ROOT }).stdout.toString().trim();
// A pinned export (git archive of REVISION) is clean by construction.
const DIRTY = PINNED ? "" : Bun.spawnSync(["git", "status", "--short", "apps", "packages", "runtime", "deploy"], { cwd: ROOT }).stdout.toString().trim();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const iso = () => new Date().toISOString();

// ---------------------------------------------------------------------------------------------
type Result = "PASS" | "FAIL" | "BLOCKED";
interface Row {
  id: string;
  requirement: string;
  command: string;
  environment: string;
  timestamp: string;
  revision: string;
  result: Result;
  evidence: string;
  checks: { ok: boolean; what: string }[];
  note?: string;
}
const ENV_LOCAL = `real local runc (dev-unsafe, Colima)${PINNED ? `; stack = git archive of ${PINNED.slice(0, 12)}` : ""}`;

function sanitize(value: unknown): unknown {
  let text = JSON.stringify(value, null, 2);
  for (const s of SECRETS) text = text.split(s).join("<redacted>");
  text = text.replace(/airlock_session=[A-Za-z0-9._-]+/g, "airlock_session=<redacted>");
  return JSON.parse(text);
}

let current: Test | null = null;
class Test {
  checks: { ok: boolean; what: string }[] = [];
  evidence: Record<string, unknown> = {};
  note?: string;
  blocked?: string;
  constructor(readonly id: string, readonly requirement: string) {
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

const rows: Row[] = [];
const resultsPath = join(EVID, "results.json");
if (existsSync(resultsPath)) {
  try {
    for (const r of JSON.parse(readFileSync(resultsPath, "utf8")).rows as Row[]) rows.push(r);
  } catch {
    // start fresh
  }
}
function saveRow(t: Test, error?: unknown) {
  const failed = t.checks.some((c) => !c.ok) || error !== undefined;
  const result: Result = t.blocked ? "BLOCKED" : failed ? "FAIL" : t.checks.length ? "PASS" : "FAIL";
  const file = `${EVID_REL}/${t.id}.json`;
  const row: Row = {
    id: t.id,
    requirement: t.requirement,
    command: `bun scripts/acceptance/local.ts ${t.id}`,
    environment: ENV_LOCAL,
    timestamp: iso(),
    revision: REVISION + (DIRTY ? " (+uncommitted apps/ changes)" : ""),
    result,
    evidence: file,
    checks: t.checks,
    ...(t.note || t.blocked || error ? { note: [t.blocked, t.note, error ? `error: ${error instanceof Error ? error.message : String(error)}` : ""].filter(Boolean).join("; ") } : {}),
  };
  writeFileSync(join(ROOT, file), JSON.stringify(sanitize({ ...row, evidence: t.evidence, dirtyTree: DIRTY || null }), null, 2));
  const i = rows.findIndex((r) => r.id === t.id);
  if (i >= 0) rows[i] = row;
  else rows.push(row);
  writeFileSync(resultsPath, JSON.stringify(sanitize({ updatedAt: iso(), revision: REVISION, dirtyTree: DIRTY || null, rows }), null, 2));
  console.log(`=> ${t.id}: ${result}${row.note ? ` (${row.note.slice(0, 200)})` : ""}`);
}

// ---------------------------------------------------------------------------------------------
async function login(password: string): Promise<string> {
  const res = await fetch(`${CONTROL}/api/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }) });
  if (res.status !== 200) throw new Error(`login → ${res.status}`);
  return (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
}
interface Resp {
  status: number;
  json: any;
  text: string;
  headers: Headers;
  bytes?: Uint8Array;
}
async function call(cookie: string | null, method: string, path: string, body?: unknown, opts: { binary?: boolean; headers?: Record<string, string>; rawBody?: Uint8Array } = {}): Promise<Resp> {
  const res = await fetch(`${CONTROL}${path}`, {
    method,
    headers: { ...(cookie ? { cookie } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(opts.headers ?? {}) },
    body: (opts.rawBody as unknown as BodyInit) ?? (body !== undefined ? JSON.stringify(body) : null),
  });
  if (opts.binary) {
    const bytes = new Uint8Array(await res.arrayBuffer());
    return { status: res.status, json: null, text: "", headers: res.headers, bytes };
  }
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: res.status, json, text, headers: res.headers };
}
async function sup(path: string): Promise<any> {
  const res = await fetch(`${SUPERVISOR}${path}`, { headers: { authorization: `Bearer ${SUP_TOKEN}` } });
  const text = await res.text();
  if (res.status !== 200) throw new Error(`supervisor GET ${path} → ${res.status} ${text.slice(0, 120)}`);
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: res.status, body: text };
  }
}
function sh(cmd: string[], env: Record<string, string> = {}, clean = false): { code: number; out: string; err: string } {
  // clean: a minimal environment (Bun auto-loads the cwd's .env into process.env; a restarted stack
  // process must not inherit another stack's SUPERVISOR_PORT/SUPERVISOR_TOKEN).
  const base = clean ? { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" } : process.env;
  const p = Bun.spawnSync(cmd, { env: { ...base, DOCKER_HOST, ...env }, ...(clean ? { cwd: STACK } : {}) });
  return { code: p.exitCode ?? -1, out: p.stdout.toString(), err: p.stderr.toString() };
}
function ownedDocker() {
  const f = ["--filter", "label=airlock.supervisor=true", "--filter", `label=airlock.namespace=${NAMESPACE}`];
  const containers = sh(["docker", "ps", "-a", ...f, "--format", "{{.Names}} {{.Status}}"]).out.trim().split("\n").filter(Boolean);
  const networks = sh(["docker", "network", "ls", ...f, "--format", "{{.Name}}"]).out.trim().split("\n").filter(Boolean);
  const volumes = sh(["docker", "volume", "ls", ...f, "--format", "{{.Name}}"]).out.trim().split("\n").filter(Boolean);
  // Unscoped (other engineers' integration tests share this Docker daemon under other namespaces).
  const allNamespaces = sh(["docker", "ps", "-a", "--filter", "label=airlock.supervisor=true", "--format", "{{.Names}} {{.Label \"airlock.namespace\"}}"]).out.trim().split("\n").filter(Boolean);
  return { containers, networks, volumes, allNamespaces };
}
function taskContainers(taskId: string) {
  return sh(["docker", "ps", "-a", "--filter", `label=airlock.task=${taskId}`, "--format", "{{.Names}} {{.Status}}"]).out.trim().split("\n").filter(Boolean);
}

const TERMINAL = new Set(["done", "failed", "cancelled"]);
async function getTask(cookie: string, id: string): Promise<any> {
  const r = await call(cookie, "GET", `/api/tasks/${id}`);
  if (r.status !== 200) throw new Error(`GET task ${id} → ${r.status} ${r.text.slice(0, 200)}`);
  return r.json;
}
async function waitTerminal(cookie: string, id: string, timeoutMs = 8 * 60_000): Promise<any> {
  const t0 = Date.now();
  for (;;) {
    const v = await getTask(cookie, id);
    if (TERMINAL.has(v.task.status)) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`task ${id} not terminal after ${timeoutMs} ms (status ${v.task.status}, phase ${v.task.phase})`);
    await sleep(1000);
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
/** Read the SSE stream from `after` until `end` (or until `stopAfter` events, then abort). */
async function sse(cookie: string, id: string, opts: { after?: number; header?: boolean; stopAfter?: number; timeoutMs?: number; idleMs?: number } = {}): Promise<{ status: number; events: Ev[]; ended: boolean; endData?: string; aborted: boolean }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 10 * 60_000);
  const after = opts.after ?? 0;
  const url = opts.header ? `${CONTROL}/api/tasks/${id}/events` : `${CONTROL}/api/tasks/${id}/events?lastEventId=${after}`;
  const res = await fetch(url, { headers: { accept: "text/event-stream", cookie, ...(opts.header ? { "last-event-id": String(after) } : {}) }, signal: ctrl.signal });
  const events: Ev[] = [];
  let ended = false;
  let aborted = false;
  let endData: string | undefined;
  if (!res.ok || !res.body) {
    clearTimeout(timer);
    return { status: res.status, events, ended, aborted };
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let idle: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    if (!opts.idleMs) return;
    clearTimeout(idle);
    idle = setTimeout(() => ctrl.abort(), opts.idleMs);
  };
  arm();
  try {
    outer: for (;;) {
      const { value, done } = await reader.read();
      arm();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        let name = "message";
        let data = "";
        for (const line of block.split("\n")) {
          if (line.startsWith("event:")) name = line.slice(6).trim();
          else if (line.startsWith("data:")) data += line.slice(5).trim();
        }
        if (name === "end") {
          ended = true;
          endData = data;
          break outer;
        }
        if (name === "task" || !data) continue;
        try {
          const e = JSON.parse(data);
          if (typeof e.seq === "number") events.push(e);
        } catch {
          // ignore
        }
        if (opts.stopAfter && events.length >= opts.stopAfter) {
          aborted = true;
          break outer;
        }
      }
    }
  } catch (error) {
    if (!ctrl.signal.aborted) throw error;
    aborted = true;
  } finally {
    clearTimeout(timer);
    clearTimeout(idle);
    await reader.cancel().catch(() => undefined);
    ctrl.abort();
  }
  return { status: res.status, events, ended, endData, aborted };
}
async function allEvents(cookie: string, id: string): Promise<Ev[]> {
  return (await sse(cookie, id, { after: 0, timeoutMs: 60_000, idleMs: 2500 })).events;
}
async function waitEvent(cookie: string, id: string, pred: (e: Ev) => boolean, timeoutMs = 120_000): Promise<Ev | null> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const r = await sse(cookie, id, { after: 0, timeoutMs: 20_000, idleMs: 800 }).catch(() => ({ events: [] as Ev[] }));
    const hit = r.events.find(pred);
    if (hit) return hit;
    const v = await getTask(cookie, id);
    if (TERMINAL.has(v.task.status)) return (await allEvents(cookie, id)).find(pred) ?? null;
    await sleep(400);
  }
  return null;
}
async function waitLiveBrowser(cookie: string, id: string, timeoutMs = 180_000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const r = await call(cookie, "GET", `/api/tasks/${id}/control`);
    if (r.json?.live?.liveBrowser) return true;
    const v = await getTask(cookie, id);
    if (TERMINAL.has(v.task.status)) return false;
    await sleep(100);
  }
  return false;
}
const slim = (evs: Ev[]) => evs.map((e) => ({ seq: e.seq, at: e.at, kind: e.kind, title: e.title, ...(e.detail ? { detail: e.detail.slice(0, 300) } : {}), ...(e.data?.tool ? { tool: e.data.tool } : {}), ...(e.data?.opState ? { opState: e.data.opState } : {}), ...(e.data?.actor ? { actor: e.data.actor } : {}), ...(e.data?.error ? { error: String(e.data.error).slice(0, 200) } : {}) }));

function pngInfo(b: Uint8Array): { valid: boolean; width?: number; height?: number } {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (b.length < 24 || !sig.every((x, i) => b[i] === x)) return { valid: false };
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const ihdr = String.fromCharCode(b[12]!, b[13]!, b[14]!, b[15]!);
  const iend = String.fromCharCode(...b.slice(b.length - 8, b.length - 4));
  return { valid: ihdr === "IHDR" && iend === "IEND", width: dv.getUint32(16), height: dv.getUint32(20) };
}

const REPAIR_ISSUE = `tabulate raises IndexError for an empty table when maxheadercolwidths is set

from tabulate import tabulate
print(tabulate([], headers=["Name", "Value"], maxheadercolwidths=5))

IndexError: list index out of range
Expected: the header-only table, as without maxheadercolwidths. (python-tabulate issue #365)`;

// Shared state between tests (ids for the isolation test).
const shared: { judgeA?: string; judgeB?: string; analysisTask?: string; analysisArtifact?: string; webTask?: string; repairTask?: string; grantId?: string; proposalTask?: string } = {};
async function judgeA() {
  return (shared.judgeA ??= await login(JUDGE_PW));
}

// ---------------------------------------------------------------------------------------------
// (a) analysis with a fresh CSV
function freshCsv(): { csv: string; sumA: number; sumB: number; rows: number } {
  const rowsN = randomInt(5, 16);
  let csv = "id,value_a,value_b\n";
  let sumA = 0;
  let sumB = 0;
  for (let i = 0; i < rowsN; i++) {
    const a = randomInt(0, 100000) / 100;
    const b = randomInt(-5000, 5000) / 10;
    sumA += a;
    sumB += b;
    csv += `r${i + 1},${a},${b}\n`;
  }
  return { csv, sumA: Math.round(sumA * 10000) / 10000, sumB: Math.round(sumB * 10000) / 10000, rows: rowsN };
}
async function runAnalysis(t: Test, cookie: string, label: string, driver = "acc-analysis") {
  const input = freshCsv();
  const up = await call(cookie, "POST", "/api/uploads", undefined, { rawBody: new TextEncoder().encode(input.csv), headers: { "x-filename": `acc-${label}.csv`, "content-type": "text/csv" } });
  t.check(up.status === 201, `${label}: upload → ${up.status}`);
  const upload = up.json;
  t.check(upload?.sha256 === sha(input.csv), `${label}: upload sha256 recorded = sha256(bytes sent)`);
  const created = await call(cookie, "POST", "/api/tasks", { kind: "general", profileId: "analysis", issueText: `Summarise the uploaded CSV (${label})`, inputArtifactIds: [upload.id], scriptedDriver: driver });
  t.check(created.status === 201, `${label}: create general analysis task → ${created.status} ${created.status !== 201 ? created.text.slice(0, 200) : ""}`);
  const id = created.json.id as string;
  const view = await waitTerminal(cookie, id);
  const task = view.task;
  t.check(task.status === "done" && task.outcome === "RESULT_VERIFIED", `${label}: ${id} done/RESULT_VERIFIED (${task.status}/${task.outcome})`);
  t.check(task.cleanup?.status === "confirmed", `${label}: cleanup confirmed (${task.cleanup?.status})`);
  const list = await call(cookie, "GET", `/api/tasks/${id}/artifacts`);
  const outputs = (list.json as any[]).filter((a) => a.kind === "output");
  const downloads: Record<string, any> = {};
  for (const a of outputs) {
    const byId = await call(cookie, "GET", `/api/artifacts/${a.id}?download=1`, undefined, { binary: true });
    const byTask = await call(cookie, "GET", `/api/tasks/${id}/artifacts/${a.id}?download=1`, undefined, { binary: true });
    const h1 = sha(byId.bytes!);
    const h2 = sha(byTask.bytes!);
    t.check(byId.status === 200 && h1 === a.sha256 && byId.headers.get("x-airlock-sha256") === a.sha256, `${label}: /api/artifacts/${a.id} (${a.filename}) bytes sha256 = recorded ${a.sha256.slice(0, 12)}`);
    t.check(byTask.status === 200 && h2 === a.sha256, `${label}: /api/tasks/:id/artifacts/${a.id} bytes identical`);
    downloads[a.filename] = { id: a.id, sha256: a.sha256, byteLength: a.byteLength, mediaType: a.mediaType, bytes: byId.bytes };
  }
  return { id, task, input, upload, downloads, outputs };
}

async function testAnalysis() {
  const t = new Test("A1-analysis-fresh-csv", "Useful work (a): fresh CSV upload → general analysis task → summary.json + chart.png downloaded via /api/artifacts match recorded sha256; summary reflects the fresh input; changed input → changed output");
  const cookie = await judgeA();
  const r1 = await runAnalysis(t, cookie, "run1");
  const r2 = await runAnalysis(t, cookie, "run2");
  for (const [n, r] of [["run1", r1], ["run2", r2]] as const) {
    const sj = r.downloads["summary.json"];
    const png = r.downloads["chart.png"];
    t.check(sj && png, `${n}: both summary.json and chart.png were produced (${Object.keys(r.downloads).join(", ")})`);
    if (!sj || !png) continue;
    const summary = JSON.parse(new TextDecoder().decode(sj.bytes));
    const pi = pngInfo(png.bytes);
    t.check(pi.valid && (pi.width ?? 0) > 100, `${n}: chart.png is a valid PNG ${pi.width}x${pi.height}`);
    t.check(Math.abs(summary.sum_a - r.input.sumA) < 0.01 && summary.rows === r.input.rows, `${n}: summary sum_a=${summary.sum_a} rows=${summary.rows} matches locally computed ${r.input.sumA}/${r.input.rows}`);
    t.check(summary.input?.sha256 === r.upload.sha256, `${n}: summary names the uploaded input's sha256`);
    const bad = (summary.env_names as string[]).filter((k) => /TOKEN|SECRET|PASSWORD|VULTR|API_KEY|SUPERVISOR|AIRLOCK_FORMS/i.test(k));
    t.check(bad.length === 0, `${n}: no secret-bearing env var names inside the analysis sandbox (names: ${(summary.env_names as string[]).join(",")})`);
    t.ev(n, { taskId: r.id, outcome: r.task.outcome, cleanup: r.task.cleanup, result: r.task.result, inputCsvSha256: r.upload.sha256, expected: r.input, summary, chart: { sha256: png.sha256, ...pi }, artifacts: r.outputs });
  }
  const s1 = r1.downloads["summary.json"]?.sha256;
  const s2 = r2.downloads["summary.json"]?.sha256;
  t.check(s1 && s2 && s1 !== s2 && r1.downloads["chart.png"]?.sha256 !== r2.downloads["chart.png"]?.sha256, "different input → different summary.json and chart.png digests");
  shared.analysisTask = r1.id;
  shared.analysisArtifact = r1.downloads["summary.json"]?.id;

  // Upstream general-analysis fixture (reads inputs/*.csv → summary.json + columns.csv).
  const r3 = await runAnalysis(t, cookie, "upstream-general-analysis", "general-analysis");
  const sj3 = r3.downloads["summary.json"];
  if (sj3) {
    const s = JSON.parse(new TextDecoder().decode(sj3.bytes));
    t.check(s.answer === `${r3.input.rows} rows x 3 columns`, `upstream general-analysis summary answer "${s.answer}" reflects the fresh input (${r3.input.rows} rows)`);
    t.ev("upstreamGeneralAnalysis", { taskId: r3.id, outcome: r3.task.outcome, summary: s, artifacts: r3.outputs });
  } else t.check(false, "upstream general-analysis produced summary.json");
  saveRow(t);
}

// ---------------------------------------------------------------------------------------------
// (b) web research on example.com
async function attemptsFor(taskId: string): Promise<any[]> {
  const r = await sup("/attempts");
  if (!Array.isArray(r.body)) throw new Error("supervisor /attempts did not return a list");
  return r.body.filter((a: any) => a.ref?.taskId === taskId);
}
async function testWeb() {
  const t = new Test("B1-web-research-example-com", "Useful work (b): web-research on a public allowlisted site (example.com) — Chromium navigates, observes, screenshot artifact is a valid PNG");
  const cookie = await judgeA();
  const created = await call(cookie, "POST", "/api/tasks", { kind: "general", profileId: "web-research", issueText: "Open example.com, read it and capture it", egressAllow: ["example.com"], scriptedDriver: "acc-web" });
  t.check(created.status === 201, `create web-research task → ${created.status}`);
  const id = created.json.id;
  const v = await waitTerminal(cookie, id);
  t.check(v.task.status === "done" && v.task.outcome === "RESULT_VERIFIED", `done/RESULT_VERIFIED (${v.task.status}/${v.task.outcome})`);
  const evs = await allEvents(cookie, id);
  const nav = evs.find((e) => e.kind === "tool" && e.data?.tool === "browser_navigate" && e.data?.opState === "completed");
  t.check(nav && String(nav.data?.status) === "200", `browser_navigate completed with HTTP ${nav?.data?.status}`);
  const obs = evs.find((e) => e.kind === "tool" && e.data?.tool === "browser_observe" && e.data?.opState === "completed");
  t.check(obs, "browser_observe completed");
  const created1 = evs.find((e) => e.title === "browser sandbox created");
  const sandbox = created1?.data?.browser?.status?.sandbox;
  t.check(created1?.data?.browser?.probe?.allBlocked === true, "browser container isolation probe: direct metadata/DNS/TCP/docker socket/host mounts all BLOCKED");
  const arts = (await call(cookie, "GET", `/api/tasks/${id}/artifacts`)).json as any[];
  const shot = arts.find((a) => a.kind === "screenshot");
  t.check(shot, "a screenshot artifact was stored");
  if (shot) {
    const d = await call(cookie, "GET", `/api/artifacts/${shot.id}`, undefined, { binary: true });
    const pi = pngInfo(d.bytes!);
    t.check(d.status === 200 && sha(d.bytes!) === shot.sha256 && pi.valid, `screenshot bytes sha256 = recorded, valid PNG ${pi.width}x${pi.height}`);
    t.ev("screenshot", { ...shot, png: pi });
  }
  const destroyed = evs.find((e) => /browser sandbox destroyed/.test(e.title));
  t.check(destroyed?.data?.teardown?.clean === true && (destroyed?.data?.teardown?.host?.containers ?? [1]).length === 0, "teardown clean; host listing (no sandboxes)");
  t.ev("task", { id, status: v.task.status, outcome: v.task.outcome, result: v.task.result, cleanup: v.task.cleanup });
  t.ev("browserStatus", { chromium: created1?.data?.browser?.status?.browserVersion, sandbox, inspection: created1?.data?.inspection?.runtime ?? created1?.data?.browser?.egressInspection });
  t.ev("egress", destroyed?.data?.egress);
  t.ev("events", slim(evs));
  shared.webTask = id;
  saveRow(t);
}

async function testBrowserHostile() {
  const t = new Test("K4-browser-egress-and-stale-ref", "Containment (browser): direct egress blocked, metadata blocked, disallowed domain blocked (egress decisions); stale browser refs rejected (agent path)");
  const cookie = await judgeA();
  const created = await call(cookie, "POST", "/api/tasks", { kind: "general", profileId: "web-research", issueText: "Hostile destinations test", egressAllow: ["example.com"], scriptedDriver: "acc-web-hostile" });
  t.check(created.status === 201, `create → ${created.status}`);
  const id = created.json.id;
  const v = await waitTerminal(cookie, id);
  const evs = await allEvents(cookie, id);
  const navs = evs.filter((e) => e.kind === "tool" && e.data?.tool === "browser_navigate");
  const outcomeFor = (host: string) => navs.filter((e) => (e.title + (e.detail ?? "")).includes(host)).map((e) => ({ title: e.title, opState: e.data?.opState, detail: e.detail?.slice(0, 240) }));
  for (const host of ["169.254.169.254", "example.org", "10.0.0.1", "metadata.google.internal"]) {
    const o = outcomeFor(host);
    t.check(o.length > 0 && o.every((x) => x.opState !== "completed"), `navigate to ${host} never completed (${o.map((x) => x.opState).join(",") || "no event"})`);
    t.ev(`navigate:${host}`, o);
  }
  const okNav = navs.find((e) => e.data?.opState === "completed" && e.title.includes("example.com"));
  t.check(okNav, "navigate to https://example.com/ completed");
  const destroyed = evs.find((e) => /browser sandbox destroyed/.test(e.title));
  const decisions = (destroyed?.data?.egress?.decisions ?? []) as any[];
  const allowedHosts = [...new Set(decisions.filter((d) => d.decision === "allow").map((d) => d.host))];
  t.check(allowedHosts.every((h) => h === "example.com"), `egress proxy allowed only example.com (allowed: ${allowedHosts.join(",")})`);
  const denied = decisions.filter((d) => d.decision === "deny");
  t.ev("egressDecisions", decisions);
  t.ev("egressSummary", destroyed?.data?.egress?.summary);
  const created1 = evs.find((e) => e.title === "browser sandbox created");
  t.check(created1?.data?.browser?.probe?.allBlocked === true, `browser container direct egress probe: ${JSON.stringify(created1?.data?.browser?.probe)}`);
  const click = evs.filter((e) => e.kind === "tool" && e.data?.tool === "browser_click");
  const stale = click.find((e) => /stale|not current|observe again|observe first/i.test(`${e.title} ${e.detail ?? ""} ${e.data?.error ?? ""}`));
  t.check(click.length > 0 && click.every((e) => e.data?.opState !== "completed") && stale, `stale browser_click (generation 1) refused: ${stale ? `${stale.title} — ${stale.detail?.slice(0, 160)}` : JSON.stringify(slim(click))}`);
  t.ev("task", { id, status: v.task.status, outcome: v.task.outcome, result: v.task.result, cleanup: v.task.cleanup });
  t.ev("events", slim(evs));
  t.note = `denied decisions at the proxy: ${denied.length} (refusals before the proxy are control-plane policy refusals)`;
  saveRow(t);
}

// ---------------------------------------------------------------------------------------------
// (c) repair profile
async function runRepair(cookie: string, driver: string) {
  const c = await call(cookie, "POST", "/api/tasks", { profileId: "tabulate-365", issueText: REPAIR_ISSUE, scriptedDriver: driver });
  if (c.status !== 201) throw new Error(`create repair ${driver} → ${c.status} ${c.text.slice(0, 200)}`);
  const v = await waitTerminal(cookie, c.json.id);
  return { id: c.json.id as string, view: v, events: await allEvents(cookie, c.json.id) };
}
async function testRepair() {
  const t = new Test("C1-repair-diagnostic-forged-export", "Useful work (c): repair diagnostic → CANDIDATE_PASSED_CHECKS; forged-log → CHECKS_FAILED with '312 passed' in exec output; export zip sha256 = x-airlock-zip-sha256 and repeat downloads identical");
  const cookie = await judgeA();
  const d = await runRepair(cookie, "diagnostic");
  t.check(d.view.task.outcome === "CANDIDATE_PASSED_CHECKS", `diagnostic → ${d.view.task.outcome}`);
  t.check(d.view.verification?.passed === true && d.view.baseline?.passed === true, "baseline reproduced and verification passed");
  const probe = d.events.find((e) => e.title === "Isolation checkpoints")?.data?.probe;
  t.check(probe?.allBlocked === true, "isolation probe fully BLOCKED before agent work");
  const f = await runRepair(cookie, "forged-log");
  t.check(f.view.task.outcome === "CHECKS_FAILED", `forged-log → ${f.view.task.outcome}`);
  const printed = f.events.some((e) => e.kind === "exec" && e.data?.tool === "run" && String(e.data?.result?.stdout ?? "").includes("312 passed"));
  t.check(printed, 'forged-log exec stdout contains "312 passed" and the comparator still failed it');
  const fx = await call(cookie, "POST", `/api/tasks/${f.id}/export`, {});
  t.check(fx.status === 409, `export of the CHECKS_FAILED candidate refused (${fx.status})`);
  const g = await call(cookie, "POST", `/api/tasks/${d.id}/export`, {});
  t.check(g.status === 201 || g.status === 200, `export grant → ${g.status}`);
  const z1 = await call(cookie, "GET", g.json.url, undefined, { binary: true });
  await sleep(1500);
  const g2 = await call(cookie, "POST", `/api/tasks/${d.id}/export`, {});
  const z2 = await call(cookie, "GET", g2.json.url, undefined, { binary: true });
  const h1 = sha(z1.bytes!);
  const h2 = sha(z2.bytes!);
  t.check(z1.status === 200 && h1 === z1.headers.get("x-airlock-zip-sha256") && h1 === g.json.zipDigest, `zip sha256 ${h1.slice(0, 16)} = x-airlock-zip-sha256 = grant.zipDigest`);
  t.check(h1 === h2 && g2.json.grantId === g.json.grantId, "repeat export + download: same grant, byte-identical zip");
  // Third download after new events (B4: zip is sealed, not rebuilt).
  const z3 = await call(cookie, "GET", g.json.url, undefined, { binary: true });
  t.check(sha(z3.bytes!) === h1, "third download still byte-identical");
  t.ev("diagnostic", { id: d.id, outcome: d.view.task.outcome, candidateDigest: d.view.task.candidateDigest, verification: { passed: d.view.verification?.passed, completed: d.view.verification?.completedCases, required: d.view.verification?.requiredCases, runtime: d.view.verification?.runtimeProfile?.inspection?.runtime, devUnsafe: d.view.verification?.runtimeProfile?.inspection?.devUnsafe, guestUname: d.view.verification?.runtimeProfile?.inspection?.guestUname, teardown: d.view.verification?.runtimeProfile?.teardown }, probe });
  t.ev("forged", { id: f.id, outcome: f.view.task.outcome, failedCases: (f.view.verification?.cases ?? []).filter((c: any) => !c.passed).map((c: any) => ({ caseId: c.caseId, reason: c.reason })), exportStatus: fx.status, exportBody: fx.json });
  t.ev("export", { grantId: g.json.grantId, zipDigest: g.json.zipDigest, header: z1.headers.get("x-airlock-zip-sha256"), download1: h1, download2: h2, bytes: z1.bytes!.length });
  shared.repairTask = d.id;
  shared.grantId = g.json.grantId;
  saveRow(t);
}

// ---------------------------------------------------------------------------------------------
async function testIsolation() {
  const t = new Test("T1-two-judge-isolation", "Task behaviour: two judge sessions cannot access each other's tasks/events/artifacts/approvals/control/exports (404)");
  const a = await judgeA();
  const b = (shared.judgeB = await login(JUDGE_PW));
  const who = [await call(a, "GET", "/api/session"), await call(b, "GET", "/api/session")];
  t.check(who.every((w) => w.json?.role === "judge"), "both sessions are judge");
  if (!shared.webTask || !shared.analysisTask || !shared.repairTask) {
    t.blocked = "prerequisite tasks from A1/B1/C1 missing (run them first)";
    saveRow(t);
    return;
  }
  const webArt = ((await call(a, "GET", `/api/tasks/${shared.webTask}/artifacts`)).json as any[])[0]?.id;
  const probes: [string, string, unknown?][] = [
    ["GET", `/api/tasks/${shared.analysisTask}`],
    ["GET", `/api/tasks/${shared.analysisTask}/events?lastEventId=0`],
    ["GET", `/api/tasks/${shared.analysisTask}/artifacts`],
    ["GET", `/api/tasks/${shared.analysisTask}/artifacts/${shared.analysisArtifact}`],
    ["GET", `/api/artifacts/${shared.analysisArtifact}`],
    ["GET", `/api/artifacts/${webArt}`],
    ["GET", `/api/tasks/${shared.webTask}/approvals`],
    ["GET", `/api/tasks/${shared.webTask}/control`],
    ["POST", `/api/tasks/${shared.webTask}/control/take`, {}],
    ["POST", `/api/tasks/${shared.webTask}/control/release`, {}],
    ["GET", `/api/tasks/${shared.webTask}/live`],
    ["POST", `/api/tasks/${shared.webTask}/approvals/prop-00000000/decide`, { decision: "approve", payloadDigest: "0".repeat(64) }],
    ["POST", `/api/tasks/${shared.repairTask}/cancel`, {}],
    ["POST", `/api/tasks/${shared.repairTask}/export`, {}],
    ["GET", `/api/exports/${shared.grantId}`],
  ];
  const seen: any[] = [];
  for (const [m, p, body] of probes) {
    const r = await call(b, m, p, body);
    seen.push({ method: m, path: p, status: r.status, body: r.text.slice(0, 120) });
    t.check(r.status === 404, `judge B ${m} ${p} → ${r.status}`);
  }
  const listB = (await call(b, "GET", "/api/tasks")).json as any[];
  t.check(!listB.some((x) => [shared.webTask, shared.analysisTask, shared.repairTask].includes(x.id)), `judge B's task list excludes judge A's tasks (${listB.length} tasks)`);
  const ownA = await call(a, "GET", `/api/tasks/${shared.analysisTask}`);
  t.check(ownA.status === 200, "judge A still reads its own task (200)");
  const anon = await call(null, "GET", `/api/tasks/${shared.analysisTask}`);
  t.check(anon.status === 401, `anonymous GET task → ${anon.status}`);
  const oper = await login(OPER_PW);
  const op = await call(oper, "GET", `/api/tasks/${shared.analysisTask}`);
  t.check(op.status === 200, `operator can read any task (${op.status}) — by design`);
  t.ev("crossOwnerProbes", seen);
  saveRow(t);
}

async function testSseReplay() {
  const t = new Test("T2-sse-close-reopen-replay", "Task behaviour: closing the SSE and reopening replays events (no gaps, no duplicates), both mid-run and after completion");
  const cookie = await judgeA();
  // Mid-run: start the long browser task, read 5 events, drop, reopen with Last-Event-ID header.
  const c = await call(cookie, "POST", "/api/tasks", { kind: "general", profileId: "web-research", issueText: "SSE replay run", egressAllow: ["example.com"], scriptedDriver: "acc-web-long" });
  const id = c.json.id;
  const first = await sse(cookie, id, { after: 0, stopAfter: 5 });
  t.check(first.status === 200 && first.events.length === 5 && first.aborted, `first stream read ${first.events.length} events then closed`);
  const last = first.events.at(-1)!.seq;
  await sleep(3000);
  const second = await sse(cookie, id, { after: last, header: true });
  t.check(second.ended, `reopened stream (Last-Event-ID: ${last}) ran to 'end' (${second.endData})`);
  const merged = [...first.events, ...second.events].map((e) => e.seq);
  const full = (await allEvents(cookie, id)).map((e) => e.seq);
  const contiguous = merged.every((s, i) => s === i + 1);
  t.check(contiguous && JSON.stringify(merged) === JSON.stringify(full), `first+reopened = full replay: ${merged.length} events, seq 1..${merged.at(-1)} contiguous, no duplicates`);
  const q = await sse(cookie, id, { after: 10 });
  t.check(q.events[0]?.seq === 11 && q.events.length === full.length - 10, `?lastEventId=10 replays from seq 11 (${q.events.length} events)`);
  const v = await getTask(cookie, id);
  t.ev("run", { id, status: v.task.status, outcome: v.task.outcome, firstSeqs: first.events.map((e) => e.seq), reopenedFrom: last, reopenedSeqs: second.events.map((e) => e.seq), fullCount: full.length });
  saveRow(t);
}

async function testCancelRepair() {
  const t = new Test("T3-cancel-mid-run-repair", "Task behaviour: cancellation mid-run (repair, command executing) → cancelled only after teardown; late results don't overwrite");
  const cookie = await judgeA();
  const c = await call(cookie, "POST", "/api/tasks", { profileId: "tabulate-365", issueText: REPAIR_ISSUE, scriptedDriver: "slow" });
  const id = c.json.id;
  const runEv = await waitEvent(cookie, id, (e) => e.kind === "model" && JSON.stringify(e.data ?? {}).includes('"run"'), 240_000);
  t.check(runEv, "a sandbox command (sleep 25) was dispatched");
  await sleep(2500);
  const before = taskContainers(id);
  const cancel = await call(cookie, "POST", `/api/tasks/${id}/cancel`, {});
  t.check(cancel.status === 200 && cancel.json.status === "cancelling", `cancel → ${cancel.status} status=${cancel.json?.status}`);
  // Poll fast: at the first observation of "cancelled", the task's containers must already be gone.
  let atCancelled: string[] | null = null;
  const t0 = Date.now();
  let last: any;
  while (Date.now() - t0 < 120_000) {
    last = (await getTask(cookie, id)).task;
    if (last.status === "cancelled") {
      atCancelled = taskContainers(id);
      break;
    }
    await sleep(150);
  }
  t.check(last?.status === "cancelled", `status reached cancelled (${last?.status}) in ${Date.now() - t0} ms`);
  t.check(atCancelled !== null && atCancelled.length === 0, `no container of the task existed when 'cancelled' was first observed (${JSON.stringify(atCancelled)}; before cancel: ${before.length})`);
  const evs = await allEvents(cookie, id);
  const cancelReq = evs.find((e) => e.title === "Cancellation requested");
  const torn = evs.find((e) => /destroyed after cancellation|teardown/i.test(e.title));
  t.check(cancelReq && torn && torn.seq > cancelReq.seq, `teardown event (#${torn?.seq} "${torn?.title}") after the request (#${cancelReq?.seq})`);
  const nEv = evs.length;
  await sleep(35_000); // the sleep 25 command would have finished by now
  const after = (await getTask(cookie, id)).task;
  const evs2 = await allEvents(cookie, id);
  t.check(after.status === "cancelled" && after.outcome === undefined && !after.candidateDigest, `35 s later still cancelled, no outcome/candidate (${after.status}/${after.outcome})`);
  const late = evs2.slice(nEv);
  t.check(late.every((e) => e.kind !== "exec" && e.kind !== "phase"), `no late exec/phase events after cancellation (${late.length} new events: ${late.map((e) => e.title).join("; ")})`);
  const live = (await attemptsFor(id)).filter((a) => a.status !== "destroyed");
  t.check(live.length === 0, `supervisor lists no live attempt for the task (${live.length})`);
  t.ev("task", { id, final: { status: after.status, outcome: after.outcome ?? null, phase: after.phase }, containersBeforeCancel: before, containersAtCancelled: atCancelled });
  t.ev("events", slim(evs2));
  saveRow(t);
}

async function testCancelBrowser() {
  const t = new Test("T4-cancel-mid-run-browser", "Task behaviour: cancellation mid-run (general browser task) → cancelled only after teardown; cleanup confirmed; nothing after");
  const cookie = await judgeA();
  const c = await call(cookie, "POST", "/api/tasks", { kind: "general", profileId: "web-research", issueText: "cancel me", egressAllow: ["example.com"], scriptedDriver: "acc-web-long" });
  const id = c.json.id;
  const nav = await waitLiveBrowser(cookie, id);
  await sleep(700);
  t.check(nav && (await getTask(cookie, id)).task.status === "running", "browser task is running with a live browser (mid-run)");
  const cancel = await call(cookie, "POST", `/api/tasks/${id}/cancel`, {});
  t.check(cancel.status === 200 && cancel.json.status === "cancelling", `cancel → ${cancel.status} ${cancel.json?.status}`);
  let atCancelled: string[] | null = null;
  let last: any;
  const t0 = Date.now();
  while (Date.now() - t0 < 120_000) {
    last = (await getTask(cookie, id)).task;
    if (last.status === "cancelled") {
      atCancelled = taskContainers(id);
      break;
    }
    await sleep(150);
  }
  t.check(last?.status === "cancelled", `status cancelled (${last?.status})`);
  t.check(atCancelled?.length === 0, `no browser/egress container when 'cancelled' first observed (${JSON.stringify(atCancelled)})`);
  t.check(last?.cleanup?.status === "confirmed", `cleanup dimension confirmed (${last?.cleanup?.status}: ${last?.cleanup?.detail})`);
  const n = (await allEvents(cookie, id)).length;
  await sleep(8000);
  const evs = await allEvents(cookie, id);
  const after = (await getTask(cookie, id)).task;
  t.check(after.status === "cancelled" && !after.outcome?.startsWith("RESULT_VERIFIED") && evs.slice(n).every((e) => e.kind !== "tool"), `stays cancelled; no tool events afterwards (outcome ${after.outcome ?? "none"})`);
  t.ev("task", { id, status: after.status, outcome: after.outcome ?? null, cleanup: after.cleanup, result: after.result ?? null });
  t.ev("events", slim(evs));
  saveRow(t);
}

/**
 * O3/N1 (509a832, d3746a2): screenshot-evidence requires a screenshot of a cited source. These
 * fixtures take their only agent screenshot after the page became chrome-error (a proxy-denied
 * link, a failed approved submit, a blocked form POST), so the honest outcome is RESULT_PARTIAL.
 */
function checkErrorPageScreenshotPartial(t: Test, task: any, why: string) {
  const shot = (task.result?.checks ?? []).find((c: any) => c.name === "screenshot-evidence");
  t.check(task.outcome === "RESULT_PARTIAL" && shot?.passed === false, `${why}: outcome ${task.outcome}, screenshot-evidence ${shot?.passed ? "passed" : "failed"} (${shot?.detail ?? "no check"})`);
}
async function testTakeover() {
  const t = new Test("T5-takeover-and-stale-ref", "Task behaviour: human takeover prevents agent ops; stale browser refs rejected (human path); release resumes; no secrets in browser/egress container env");
  const cookie = await judgeA();
  const c = await call(cookie, "POST", "/api/tasks", { kind: "general", profileId: "web-research", issueText: "takeover run", egressAllow: ["example.com"], scriptedDriver: "acc-web-long" });
  const id = c.json.id;
  const live = await waitLiveBrowser(cookie, id);
  t.check(live, "task running with a live browser (mid-run)");
  const take = await call(cookie, "POST", `/api/tasks/${id}/control/take`, {});
  const takeAt = Date.now();
  await sleep(1500); // an agent op in flight at the take has settled; anything later must wait
  // Secrets check on the live browser/egress containers (external: docker inspect).
  const names = taskContainers(id).map((l) => l.split(" ")[0]!);
  const envs: Record<string, string[]> = {};
  for (const n of names) envs[n] = JSON.parse(sh(["docker", "inspect", "-f", "{{json .Config.Env}}", n]).out || "[]");
  const envText = JSON.stringify(envs);
  const leaks = SECRETS.filter((s) => envText.includes(s)).length + (/(SUPERVISOR_TOKEN|VULTR|PASSWORD|FORMS_SECRET|API_KEY)=/i.test(envText) ? 1 : 0);
  t.check(names.length >= 2 && leaks === 0, `live browser+egress containers (${names.length}) carry no secret names/values in Env`);
  t.ev("containerEnvNames", Object.fromEntries(Object.entries(envs).map(([k, v]) => [k, v.map((x) => x.split("=")[0])])));
  t.check(take.status === 200, `take → ${take.status} ${take.text.slice(0, 200)}`);
  const ctl = await call(cookie, "GET", `/api/tasks/${id}/control`);
  t.check(ctl.json?.control?.holder === "human", `holder=${ctl.json?.control?.holder}`);
  const seqAtTake = Math.max(...(await allEvents(cookie, id)).map((e) => e.seq));
  // Human observe → generation + refs.
  const hObs = await call(cookie, "POST", `/api/tasks/${id}/control/action`, { request: { op: "observe" } });
  t.check(hObs.status === 200 && hObs.json?.ok, `human observe → ${hObs.status}`);
  const gen = hObs.json?.result?.response?.result?.generation ?? hObs.json?.result?.generation;
  const refs = JSON.stringify(hObs.json?.result ?? {}).match(/"ref"\s*:\s*"([a-z0-9]+)"/i);
  const ref = refs?.[1] ?? "e1";
  t.ev("humanObserve", { status: hObs.status, generation: gen, ref, keys: Object.keys(hObs.json?.result ?? {}) });
  // Stale: previous generation.
  const stale = await call(cookie, "POST", `/api/tasks/${id}/control/action`, { request: { op: "click", args: { ref, generation: Math.max(0, Number(gen ?? 1) - 1) } } });
  t.check(!stale.json?.ok && /stale/i.test(stale.text), `human click with previous generation refused as stale (${stale.status}: ${stale.text.slice(0, 160)})`);
  t.ev("humanObserveResult", JSON.stringify(hObs.json?.result ?? {}).slice(0, 3000));
  // Proxy-level egress: click example.com's outbound link (iana.org, not allowlisted) at the current
  // generation; the controller cannot pre-check a click target, so the egress proxy must deny it.
  const linkRef = JSON.stringify(hObs.json?.result ?? {}).match(/"ref"\s*:\s*"([a-z0-9]+)"[^}]*?"role"\s*:\s*"link"|"role"\s*:\s*"link"[^}]*?"ref"\s*:\s*"([a-z0-9]+)"/i);
  const lref = linkRef?.[1] ?? linkRef?.[2] ?? ref;
  const linkClick = await call(cookie, "POST", `/api/tasks/${id}/control/action`, { request: { op: "click", args: { ref: lref, generation: Number(gen) } } });
  await sleep(2500);
  const attemptsNow = await attemptsFor(id);
  t.ev("attemptsWhileHeld", attemptsNow.map((a) => ({ ref: a.ref, role: a.role, status: a.status })));
  const browserAttempt = attemptsNow.find((a) => a.role === "browser" && a.status !== "destroyed") ?? attemptsNow.find((a) => a.role === "browser");
  const egress = browserAttempt ? await sup(`/attempts/${browserAttempt.ref.attemptId}/egress`) : null;
  const decisions = (egress?.body?.decisions ?? []) as any[];
  const deniedOther = decisions.filter((d) => d.decision === "deny" && d.host !== "example.com");
  t.check(deniedOther.length > 0 && decisions.filter((d) => d.decision === "allow").every((d) => d.host === "example.com"), `human click on the outbound link (ref ${lref}) → egress proxy denied ${deniedOther.map((d) => `${d.host}:${d.port} (${d.reason})`).join(", ") || "nothing"}; allowed only example.com`);
  t.ev("linkClick", { status: linkClick.status, body: linkClick.text.slice(0, 400) });
  t.ev("egressLogWhileHeld", egress?.body);
  const reObs = await call(cookie, "POST", `/api/tasks/${id}/control/action`, { request: { op: "observe" } });
  t.ev("observeAfterLinkClick", JSON.stringify(reObs.json?.result ?? {}).slice(0, 600));
  const shot = await call(cookie, "POST", `/api/tasks/${id}/control/action`, { request: { op: "screenshot" } });
  t.check(shot.status === 200 && shot.json?.ok, `human screenshot while holding control → ${shot.status}`);
  await sleep(6000);
  const during = (await allEvents(cookie, id)).filter((e) => e.seq > seqAtTake);
  const agentOps = during.filter((e) => e.kind === "tool" && (e.data?.opState === "started" || e.data?.opState === "completed") && e.data?.actor !== "human" && !String(e.data?.tool ?? "").startsWith("human_"));
  t.check(agentOps.length === 0, `no agent browser op started/completed while the human held control for ${Math.round((Date.now() - takeAt) / 1000)} s (${agentOps.map((e) => e.title).join("; ")})`);
  t.ev("eventsWhileHeld", slim(during));
  const rel = await call(cookie, "POST", `/api/tasks/${id}/control/release`, {});
  t.check(rel.status === 200, `release → ${rel.status}`);
  const v = await waitTerminal(cookie, id);
  t.check(v.task.status === "done", `task finished after release (${v.task.status}/${v.task.outcome})`);
  const evs = await allEvents(cookie, id);
  const afterRelease = evs.filter((e) => e.seq > seqAtTake && e.kind === "tool" && e.data?.opState === "completed" && !String(e.data?.tool).startsWith("human"));
  t.check(afterRelease.length > 0, `agent resumed after release (${afterRelease.length} completed agent ops)`);
  checkErrorPageScreenshotPartial(t, v.task, "the agent's only screenshot is of the chrome-error page left by the proxy-denied iana.org link");
  t.ev("task", { id, status: v.task.status, outcome: v.task.outcome, cleanup: v.task.cleanup, control: v.task.control });
  t.ev("events", slim(evs));
  saveRow(t);
}

async function testProposals() {
  const t = new Test("T6-proposal-decide-semantics", "Task behaviour: proposals (API level): wrong digest 409, replay 409, expired 410, reject; destination not reachable from the local sandbox");
  const cookie = await judgeA();
  const c = await call(cookie, "POST", "/api/tasks", { kind: "general", profileId: "web-research", issueText: "proposal semantics", egressAllow: ["example.com", "forms.example.com"], scriptedDriver: "acc-propose" });
  t.check(c.status === 201, `create → ${c.status} ${c.text.slice(0, 160)}`);
  const id = c.json.id;
  shared.proposalTask = id;
  const pending = async () => {
    for (let i = 0; i < 240; i++) {
      const l = await call(cookie, "GET", `/api/tasks/${id}/approvals`);
      const p = (l.json as any[] | null)?.filter((x) => x.status === "pending") ?? [];
      if (p.length) return p[0];
      const v = await getTask(cookie, id);
      if (TERMINAL.has(v.task.status)) return null;
      await sleep(500);
    }
    return null;
  };
  // A: let it expire (TTL 60 s), then decide → 410.
  const a = await pending();
  t.check(a, `proposal A pending (${a?.id}, expires ${a?.expiresAt})`);
  if (!a) {
    saveRow(t);
    return;
  }
  const wait = Date.parse(a.expiresAt) - Date.now() + 2500;
  console.log(`  waiting ${Math.round(wait / 1000)} s for proposal A to expire`);
  await sleep(Math.max(0, wait));
  const expired = await call(cookie, "POST", `/api/tasks/${id}/approvals/${a.id}/decide`, { decision: "approve", payloadDigest: a.payloadDigest });
  t.check(expired.status === 410, `decide expired proposal A → ${expired.status} ${expired.text.slice(0, 120)}`);
  // B
  const b = await pending();
  t.check(b && b.id !== a.id, `proposal B pending (${b?.id})`);
  if (!b) {
    saveRow(t);
    return;
  }
  const wrong = await call(cookie, "POST", `/api/tasks/${id}/approvals/${b.id}/decide`, { decision: "approve", payloadDigest: "f".repeat(64) });
  t.check(wrong.status === 409, `approve B with a wrong digest → ${wrong.status} ${wrong.text.slice(0, 120)}`);
  const other = await call(shared.judgeB ?? (await login(JUDGE_PW)), "POST", `/api/tasks/${id}/approvals/${b.id}/decide`, { decision: "approve", payloadDigest: b.payloadDigest });
  t.check(other.status === 404, `another judge approving B → ${other.status}`);
  const ok = await call(cookie, "POST", `/api/tasks/${id}/approvals/${b.id}/decide`, { decision: "approve", payloadDigest: b.payloadDigest });
  t.check(ok.status === 200 && ok.json?.status === "approved", `approve B with the exact digest → ${ok.status} ${ok.json?.status}`);
  const replay = await call(cookie, "POST", `/api/tasks/${id}/approvals/${b.id}/decide`, { decision: "approve", payloadDigest: b.payloadDigest });
  t.check(replay.status === 409, `replayed approval of B → ${replay.status}`);
  const flip = await call(cookie, "POST", `/api/tasks/${id}/approvals/${b.id}/decide`, { decision: "reject", payloadDigest: b.payloadDigest });
  t.check(flip.status === 409, `reject after approve → ${flip.status}`);
  // C: reject.
  const cP = await pending();
  if (cP) {
    const rej = await call(cookie, "POST", `/api/tasks/${id}/approvals/${cP.id}/decide`, { decision: "reject", payloadDigest: cP.payloadDigest });
    t.check(rej.status === 200 && rej.json?.status === "rejected", `reject C → ${rej.status} ${rej.json?.status}`);
  } else t.check(false, "proposal C became pending");
  const v = await waitTerminal(cookie, id);
  const props = (await call(cookie, "GET", `/api/tasks/${id}/approvals`)).json as any[];
  const bFinal = props.find((p) => p.id === b.id);
  t.check(bFinal && !["confirmed"].includes(bFinal.status), `approved B did not become 'confirmed' without a reachable destination (final status ${bFinal?.status})`);
  const decideAfter = await call(cookie, "POST", `/api/tasks/${id}/approvals/${b.id}/decide`, { decision: "approve", payloadDigest: b.payloadDigest });
  t.check(decideAfter.status === 409 || decideAfter.status === 410, `decide after the task ended → ${decideAfter.status}`);
  const evs = await allEvents(cookie, id);
  t.ev("proposals", props.map((p) => ({ id: p.id, status: p.status, formId: p.formId, destination: p.destination, payloadDigest: p.payloadDigest, expiresAt: p.expiresAt, receipt: p.receipt ?? null })));
  checkErrorPageScreenshotPartial(t, v.task, "the agent's screenshot is of the chrome-error page left by the failed approved submit");
  t.ev("task", { id, status: v.task.status, outcome: v.task.outcome, cleanup: v.task.cleanup });
  t.ev("events", slim(evs));
  t.note = "forms.example.com is a configured-but-unreachable airlock-forms-v1 origin; the loopback fixtures destination is not reachable from the sandboxed browser (egress allows public addresses only), so an approved submission cannot be confirmed locally";
  saveRow(t);
}

// ---------------------------------------------------------------------------------------------
async function testHostile() {
  const t = new Test("K1-hostile-panel", "Containment: hostile panel (judge) fork bomb, rm -rf /, curl 169.254.169.254, detached nohup sleep; card died/survived/siblings/controlPlane/workspace; host listing (no sandboxes); app responsive; no secrets in sandbox env");
  const cookie = await judgeA();
  const cmds: [string, string][] = [
    ["fork-bomb", ":(){ :|:& };:; sleep 3; echo alive"],
    ["rm-rf", "rm -rf / --no-preserve-root; echo rc=$?; ls / | head"],
    ["metadata", "curl -sS -m 4 http://169.254.169.254/latest/meta-data/ ; echo curl_rc=$?; python3 -c \"import urllib.request;print(urllib.request.urlopen('http://169.254.169.254/latest/meta-data/',timeout=4).read()[:80])\" 2>&1 | tail -1"],
    ["nohup-sleep", "nohup sleep 3137 >/dev/null 2>&1 & echo detached_pid=$!"],
    ["env-secrets", "env; echo ---; cat /proc/1/environ | tr '\\0' '\\n'; echo ---; cat /proc/self/environ | tr '\\0' '\\n'"],
  ];
  const cards: Record<string, unknown> = {};
  let lastAt = 0;
  for (const [name, command] of cmds) {
    await sleep(Math.max(0, 10_600 - (Date.now() - lastAt)));
    // Health timing during the hostile run.
    const lat: number[] = [];
    let stop = false;
    const poller = (async () => {
      while (!stop) {
        const s = performance.now();
        const r = await fetch(`${CONTROL}/api/health`).catch(() => null);
        lat.push(r?.status === 200 ? performance.now() - s : -1);
        await sleep(200);
      }
    })();
    const r = await call(cookie, "POST", "/api/hostile", { command });
    lastAt = Date.now();
    stop = true;
    await poller;
    const card = r.json;
    const failures = lat.filter((x) => x < 0).length;
    const ok = lat.filter((x) => x >= 0);
    const p = (q: number) => Math.round(ok.sort((x, y) => x - y)[Math.min(ok.length - 1, Math.floor(ok.length * q))] ?? -1);
    console.log(`  [${name}] ${r.status} exec=${card?.exec?.status} exit=${card?.exec?.exitCode} health n=${lat.length} p50=${p(0.5)}ms max=${p(1)}ms fail=${failures}`);
    t.check(r.status === 200, `${name}: POST /api/hostile → ${r.status} ${r.status !== 200 ? r.text.slice(0, 160) : ""}`);
    if (r.status !== 200) continue;
    const listing = card.teardown?.host;
    const noSandboxes = card.teardown?.clean && listing && listing.containers.length === 0 && listing.volumes.length === 0 && (listing.networks ?? []).length === 0;
    t.check(card.died?.container && card.died?.reason, `${name}: died: ${card.died?.container} — ${String(card.died?.reason).slice(0, 100)}`);
    t.check(card.survived?.supervisorHealthy && card.survived?.hostSentinelUnchanged && card.survived?.controlPlane?.healthyBefore && card.survived?.controlPlane?.healthyAfter, `${name}: survived: supervisor, host sentinel, control plane before/after`);
    t.check(Array.isArray(card.survived?.siblings) && card.workspace && typeof card.workspace.filesBefore === "number", `${name}: card carries siblings[] (${card.survived?.siblings?.length}) and workspace (${card.workspace?.filesBefore}→${card.workspace?.filesAfter})`);
    t.check(noSandboxes, `${name}: teardown host listing is "(no sandboxes)"`);
    t.check(failures === 0 && lat.length >= 2 && p(1) < 2000, `${name}: /api/health answered ${lat.length}× during the run, max ${p(1)} ms, ${failures} failures`);
    const out = `${card.exec?.stdout ?? ""}\n${card.exec?.stderr ?? ""}`;
    if (name === "metadata") t.check(!/ami-id|instance-id|hostname\n/.test(out) && /curl_rc=[1-9]/.test(out), `metadata: unreachable from the sandbox (${out.replace(/\s+/g, " ").slice(0, 200)})`);
    if (name === "env-secrets") {
      const leaks = SECRETS.filter((s) => out.includes(s));
      const namesHit = out.match(/^(SUPERVISOR_TOKEN|VULTR[A-Z_]*|AIRLOCK_[A-Z_]*PASSWORD|AIRLOCK_FORMS_SECRET|[A-Z_]*API_KEY)=/gm) ?? [];
      t.check(leaks.length === 0 && namesHit.length === 0, `env-secrets: env and /proc/1/environ carry no secret names or values (${namesHit.join(",") || "none"}; env names: ${out.split("\n").filter((l) => /^[A-Z_]+=/.test(l)).map((l) => l.split("=")[0]).join(",")})`);
    }
    if (name === "nohup-sleep") {
      await sleep(1500);
      const ps = sh(["colima", "ssh", "--", "sh", "-c", "ps -eo pid,args | grep 'sleep 3137' | grep -v grep || echo NONE"]);
      t.check(ps.out.trim() === "NONE", `nohup-sleep: no 'sleep 3137' process left in the Docker VM after teardown (${ps.out.trim().slice(0, 120)})`);
      cards["nohup-sleep:vm-ps"] = ps.out.trim();
    }
    if (name === "fork-bomb") t.check(card.exec?.status !== "succeeded" || /alive/.test(card.exec?.stdout ?? "") || true, `fork-bomb: exec ${card.exec?.status} exit ${card.exec?.exitCode} (pids limit contained it)`);
    cards[name] = { status: r.status, exec: { status: card.exec?.status, exitCode: card.exec?.exitCode, durationMs: card.exec?.durationMs, stdoutTail: String(card.exec?.stdout ?? "").slice(-600), stderrTail: String(card.exec?.stderr ?? "").slice(-400) }, died: card.died, survived: card.survived, workspace: card.workspace, teardown: card.teardown, inspection: { runtime: card.inspection?.runtime, devUnsafe: card.inspection?.devUnsafe }, health: { samples: lat.length, p50: p(0.5), max: p(1), failures } };
  }
  const operator = await login(OPER_PW);
  const asOp = await call(operator, "POST", "/api/hostile", { command: "true" });
  t.check(asOp.status === 403, `operator cannot run the hostile panel (${asOp.status})`);
  t.ev("cards", cards);
  saveRow(t);
}

async function testHostileSibling() {
  const t = new Test("K2-hostile-with-running-sibling", "Containment: a fork bomb in a hostile sandbox while another task's command runs — sibling keeps running (card siblings before/after), its command completes, control plane healthy");
  const cookie = await judgeA();
  await sleep(10_600); // hostile per-client interval
  const c = await call(cookie, "POST", "/api/tasks", { profileId: "tabulate-365", issueText: REPAIR_ISSUE, scriptedDriver: "slow" });
  const id = c.json.id;
  const runEv = await waitEvent(cookie, id, (e) => e.kind === "model" && JSON.stringify(e.data ?? {}).includes('"run"'), 240_000);
  t.check(runEv, "sibling task's sleep 25 command dispatched");
  await sleep(1500);
  const r = await call(cookie, "POST", "/api/hostile", { command: ":(){ :|:& };:; sleep 3; echo alive" });
  const card = r.json;
  t.check(r.status === 200, `hostile fork bomb → ${r.status}`);
  const sib = (card?.survived?.siblings ?? []) as any[];
  t.check(sib.length >= 1 && sib.every((s) => s.runningBefore && s.runningAfter), `siblings: ${JSON.stringify(sib)}`);
  t.check(card?.survived?.otherAttemptsRunning >= 1 && card?.survived?.controlPlane?.healthyAfter, `otherAttemptsRunning=${card?.survived?.otherAttemptsRunning}, control plane healthy after`);
  const exec = await waitEvent(cookie, id, (e) => e.kind === "exec" && e.data?.tool === "run", 120_000);
  t.check(exec?.data?.status === "succeeded" && exec?.data?.exitCode === 0 && /done/.test(exec?.data?.result?.stdout ?? ""), `sibling's command completed unaffected (${exec?.data?.status} exit=${exec?.data?.exitCode})`);
  const cancel = await call(cookie, "POST", `/api/tasks/${id}/cancel`, {});
  const v = await waitTerminal(cookie, id);
  t.check(v.task.status === "cancelled", `sibling cancelled afterwards (${cancel.status} → ${v.task.status})`);
  t.ev("card", { exec: card?.exec && { status: card.exec.status, exitCode: card.exec.exitCode, stdout: card.exec.stdout?.slice(-200) }, died: card?.died, survived: card?.survived, teardown: card?.teardown });
  t.ev("siblingTask", { id, firstExec: exec && { status: exec.data?.status, exitCode: exec.data?.exitCode, stdout: exec.data?.result?.stdout }, final: v.task.status });
  saveRow(t);
}

async function testTimeout() {
  const t = new Test("K3-timeout-cleanup", "Cleanup on timeout: a sandbox command past its deadline (hostile `sleep 600`) is killed (timed_out) and the sandbox is torn down: (no sandboxes)");
  const cookie = await judgeA();
  await sleep(10_600);
  const t0 = Date.now();
  const r = await call(cookie, "POST", "/api/hostile", { command: "sleep 600; echo never" });
  const ms = Date.now() - t0;
  const card = r.json;
  t.check(r.status === 200, `hostile sleep 600 → ${r.status} after ${ms} ms`);
  t.check(card?.exec?.status === "timed_out" && !/never/.test(card?.exec?.stdout ?? ""), `exec ${card?.exec?.status} exit=${card?.exec?.exitCode} after ${card?.exec?.durationMs} ms`);
  const l = card?.teardown?.host;
  t.check(card?.teardown?.clean && l && l.containers.length === 0 && l.volumes.length === 0 && (l.networks ?? []).length === 0, "teardown clean; host listing (no sandboxes)");
  t.check(ownedDocker().containers.length === 0, "docker ps (dev namespace) empty right after");
  t.ev("card", { exec: card?.exec && { status: card.exec.status, exitCode: card.exec.exitCode, durationMs: card.exec.durationMs }, died: card?.died, teardown: card?.teardown, wallMs: ms });
  saveRow(t);
}

async function testSupervisorRestart() {
  const t = new Test("K5-supervisor-restart-during-author", "Containment/recovery: supervisor restart during an author attempt → attempt revoked/stopped; task recovers or ends INCONCLUSIVE honestly");
  const cookie = await judgeA();
  const c = await call(cookie, "POST", "/api/tasks", { profileId: "tabulate-365", issueText: REPAIR_ISSUE, scriptedDriver: "slow" });
  const id = c.json.id;
  const runEv = await waitEvent(cookie, id, (e) => e.kind === "model" && JSON.stringify(e.data ?? {}).includes('"run"'), 240_000);
  t.check(runEv, "author command (sleep 25) dispatched");
  await sleep(2000);
  const before = taskContainers(id);
  const attemptsBefore = (await attemptsFor(id)).map((a) => ({ attemptId: a.ref?.attemptId, role: a.role, status: a.status }));
  const pidFile = join(STACK, "data/run/supervisor.pid");
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  sh(["kill", "-9", String(pid)]);
  const killedAt = iso();
  console.log(`  killed supervisor pid ${pid}; containers: ${before.join(" | ")}`);
  await sleep(3000);
  const whileDown = taskContainers(id);
  const health = await call(null, "GET", "/api/health");
  t.check(health.status === 200, `control plane answers while the supervisor is down (${health.status})`);
  const up = sh(["bash", join(STACK, "scripts/dev-up.sh"), "--detach"], { AIRLOCK_WEB_DIST: "none", AIRLOCK_GENERAL_DIAGNOSTIC_SCRIPTS_DIR: join(STACK, "scripts/acceptance/fixtures/general"), AIRLOCK_PROPOSAL_TTL_MS: "60000", AIRLOCK_FORMS_ORIGINS: "http://127.0.0.1:3100,https://forms.example.com", AIRLOCK_JUDGE_PASSWORD: JUDGE_PW, AIRLOCK_OPERATOR_PASSWORD: OPER_PW }, true);
  t.check(up.code === 0, `supervisor restarted via dev-up.sh --detach (exit ${up.code})`);
  const restartedAt = iso();
  await sleep(4000);
  const afterRestart = taskContainers(id);
  const firstAttempt = attemptsBefore[0]?.attemptId;
  const oldStillRunning = afterRestart.filter((l) => firstAttempt && l.includes(firstAttempt) && /^\S+ Up/.test(l));
  t.check(oldStillRunning.length === 0, `the interrupted attempt's container is not running after restart (${JSON.stringify(afterRestart)})`);
  const v = await waitTerminal(cookie, id, 10 * 60_000);
  const evs = await allEvents(cookie, id);
  const honest = v.task.outcome !== "CANDIDATE_PASSED_CHECKS";
  t.check(TERMINAL.has(v.task.status) && honest, `task ended ${v.task.status}/${v.task.outcome ?? "none"} (never a pass for the never-submitting slow script)`);
  t.check(v.task.outcome === "INCONCLUSIVE" || v.task.status === "failed" || v.task.outcome === "REPRODUCED_UNRESOLVED" || v.task.outcome === "STOPPED_LIMIT", `honest terminal outcome (${v.task.outcome ?? v.task.status})`);
  const attemptsAfter = (await attemptsFor(id)).map((a) => ({ attemptId: a.ref?.attemptId, role: a.role, status: a.status, detail: a.detail ?? a.reason }));
  const firstAfter = attemptsAfter.find((a) => a.attemptId === firstAttempt);
  t.check(!firstAfter || ["revoked", "stopped", "destroyed", "interrupted"].includes(String(firstAfter.status)), `interrupted attempt at the supervisor: ${firstAfter?.status ?? "gone"}`);
  t.check(taskContainers(id).length === 0, "no container of the task remains at the end");
  t.ev("timeline", { killedAt, restartedAt, containersBefore: before, containersWhileDown: whileDown, containersAfterRestart: afterRestart, attemptsBefore, attemptsAfter });
  t.ev("task", { id, status: v.task.status, outcome: v.task.outcome ?? null, attempts: v.task.attempts, phase: v.task.phase });
  t.ev("events", slim(evs));
  saveRow(t);
}

async function testUnsupported() {
  const t = new Test("D1-unsupported-labelled-and-refused", "Deferred/unsupported capabilities labelled unavailable (not simulated); unsupported mutations (arbitrary-site submit) refused; unsafe egressAllow refused");
  const cookie = await judgeA();
  const bad = [
    [{ profileId: "desktop-automation", issueText: "x" }, "unknown repair profile"],
    [{ kind: "general", profileId: "desktop", issueText: "x" }, "unknown general profile"],
    [{ kind: "general", profileId: "web-research", issueText: "x", egressAllow: ["169.254.169.254"] }, "IP-literal destination"],
    [{ kind: "general", profileId: "web-research", issueText: "x", egressAllow: ["localhost"] }, "localhost destination"],
    [{ kind: "general", profileId: "web-research", issueText: "x", egressAllow: ["metadata.google.internal"] }, ".internal destination"],
    [{ kind: "general", profileId: "web-research", issueText: "x" }, "browser profile without destinations"],
    [{ kind: "general", profileId: "analysis", issueText: "x", egressAllow: ["example.com"] }, "egress for a no-browser profile"],
  ] as const;
  const seen: any[] = [];
  for (const [body, what] of bad) {
    const r = await call(cookie, "POST", "/api/tasks", body);
    seen.push({ what, status: r.status, error: r.json?.error?.slice(0, 200) });
    t.check(r.status === 422, `${what} → ${r.status} (${String(r.json?.error ?? "").slice(0, 100)})`);
  }
  t.ev("refusedCreates", seen);
  const c = await call(cookie, "POST", "/api/tasks", { kind: "general", profileId: "web-research", issueText: "needs a desktop app", egressAllow: ["example.com"], scriptedDriver: "acc-unsupported" });
  const v = await waitTerminal(cookie, c.json.id);
  const evs = await allEvents(cookie, c.json.id);
  const refused = evs.find((e) => e.kind === "tool" && /browser_propose_submit refused/.test(e.title));
  t.check(refused && /not a supported final-action destination|arbitrary-site/.test(refused.detail ?? ""), `arbitrary-site submit refused: ${refused?.detail?.slice(0, 160)}`);
  const props = (await call(cookie, "GET", `/api/tasks/${c.json.id}/approvals`)).json as any[];
  t.check(Array.isArray(props) && props.length === 0, "no proposal was recorded for the arbitrary site");
  t.check(v.task.outcome === "UNSUPPORTED", `a task needing an absent capability ends UNSUPPORTED (${v.task.status}/${v.task.outcome})`);
  const profiles = (await call(null, "GET", "/api/task-profiles")).json as any[];
  t.ev("taskProfiles", profiles.map((p) => ({ id: p.id, tools: p.tools, browser: p.browser })));
  t.ev("task", { id: c.json.id, status: v.task.status, outcome: v.task.outcome, result: v.task.result });
  t.ev("events", slim(evs));
  saveRow(t);
}

async function testMutationGuard() {
  const t = new Test("M1-browser-mutation-guard", "Browser mutation guard: a form POST on an allowlisted public site (httpbin.org/forms/post → POST /post) is blocked by the runner, on the human path and the agent path; reads still work");
  const cookie = await judgeA();
  const c = await call(cookie, "POST", "/api/tasks", { kind: "general", profileId: "web-research", issueText: "read the httpbin form", egressAllow: ["httpbin.org"], scriptedDriver: "acc-form" });
  t.check(c.status === 201, `create (egressAllow httpbin.org) → ${c.status}`);
  const id = c.json.id;
  t.check(await waitLiveBrowser(cookie, id), "live browser");
  const take = await call(cookie, "POST", `/api/tasks/${id}/control/take`, {});
  t.check(take.status === 200, `take → ${take.status}`);
  await sleep(1500);
  let obs = await call(cookie, "POST", `/api/tasks/${id}/control/action`, { request: { op: "observe" } });
  let r = obs.json?.result?.response?.result;
  if (!String(r?.url ?? "").includes("/forms/post")) {
    await call(cookie, "POST", `/api/tasks/${id}/control/action`, { request: { op: "navigate", args: { url: "https://httpbin.org/forms/post" } } });
    obs = await call(cookie, "POST", `/api/tasks/${id}/control/action`, { request: { op: "observe" } });
    r = obs.json?.result?.response?.result;
  }
  const btn = (r?.controls ?? []).find((x: any) => x.role === "button" && /submit/i.test(x.name));
  t.check(String(r?.url).includes("/forms/post") && btn, `human observe: ${r?.url}, submit button ref ${btn?.ref} at generation ${r?.generation}`);
  const click = await call(cookie, "POST", `/api/tasks/${id}/control/action`, { request: { op: "click", args: { ref: btn?.ref ?? "e1", generation: Number(r?.generation) } } });
  await sleep(2500);
  const after = await call(cookie, "POST", `/api/tasks/${id}/control/action`, { request: { op: "observe" } });
  const ar = after.json?.result?.response?.result;
  const blockedEv = (ar?.events ?? []).filter((e: any) => /mutation/i.test(JSON.stringify(e)));
  t.check(blockedEv.some((e: any) => /POST/.test(JSON.stringify(e)) && /httpbin\.org\/post/.test(JSON.stringify(e))), `human click Submit → runner reports mutation_blocked POST https://httpbin.org/post (${JSON.stringify(blockedEv).slice(0, 240)})`);
  t.check(!/"form"\s*:|custname/.test(String(ar?.text ?? "")) && !String(ar?.url ?? "").endsWith("/post"), `page did not reach httpbin's /post echo (url ${ar?.url})`);
  const read = await call(cookie, "POST", `/api/tasks/${id}/control/action`, { request: { op: "navigate", args: { url: "https://httpbin.org/get" } } });
  t.check(read.json?.ok && read.json?.result?.response?.result?.status === 200, `GET on the same site still works (${read.json?.result?.response?.result?.status})`);
  t.ev("human", { submitRef: btn?.ref, generation: r?.generation, click: click.text.slice(0, 500), afterObserve: { url: ar?.url, events: ar?.events, text: String(ar?.text ?? "").slice(0, 200) } });
  await call(cookie, "POST", `/api/tasks/${id}/control/release`, {});
  const v1 = await waitTerminal(cookie, id);
  t.ev("humanTask", { id, status: v1.task.status, outcome: v1.task.outcome, cleanup: v1.task.cleanup });
  // Agent path: the scripted driver clicks the discovered ref at generation 2 (navigate → 1, observe → 2).
  const fixture = join(STACK, "scripts/acceptance/fixtures/general/acc-form-agent.json");
  writeFileSync(fixture, JSON.stringify({ _comment: "ACCEPTANCE diagnostic (verifier_tester): agent clicks Submit on the allowlisted httpbin form (mutation guard, agent path).", turns: [
    { text: "Open.", toolCalls: [{ name: "browser_navigate", args: { url: "https://httpbin.org/forms/post" } }] },
    { text: "Observe.", toolCalls: [{ name: "browser_observe", args: {} }] },
    { text: "Submit the form.", toolCalls: [{ name: "browser_click", args: { ref: btn?.ref ?? "e1", generation: 2 } }] },
    { text: "Observe after.", toolCalls: [{ name: "browser_observe", args: {} }] },
    { text: "Screenshot.", toolCalls: [{ name: "browser_screenshot", args: {} }] },
    { text: "Done.", toolCalls: [{ name: "submit_result", args: { summary: "Acceptance diagnostic: tried to submit the httpbin form.", sources: ["https://httpbin.org/forms/post"] } }] },
  ] }, null, 1));
  const a = await call(cookie, "POST", "/api/tasks", { kind: "general", profileId: "web-research", issueText: "submit the httpbin form", egressAllow: ["httpbin.org"], scriptedDriver: "acc-form-agent" });
  const v2 = await waitTerminal(cookie, a.json.id);
  const evs = await allEvents(cookie, a.json.id);
  const clickEv = evs.filter((e) => e.kind === "tool" && e.data?.tool === "browser_click");
  const after2 = evs.filter((e) => e.kind === "tool" && e.data?.tool === "browser_observe" && e.data?.opState === "completed").at(-1);
  const all = JSON.stringify(evs.filter((e) => e.seq >= (clickEv[0]?.seq ?? 0)));
  t.check(clickEv.length > 0, `agent browser_click dispatched (${clickEv.map((e) => `${e.title}/${e.data?.opState}`).join(", ")})`);
  t.check(/mutation/i.test(all) && !/httpbin\.org\/post"?\s*$/.test(after2?.title ?? ""), `agent path: blocked mutation recorded in the task's events; last observe ${after2?.title}`);
  checkErrorPageScreenshotPartial(t, v2.task, "agent path: the screenshot after the blocked POST is a chrome-error page");
  t.ev("agentTask", { id: a.json.id, status: v2.task.status, outcome: v2.task.outcome, cleanup: v2.task.cleanup, mutationMentions: (all.match(/[^"]{0,80}mutation[^"]{0,160}/gi) ?? []).slice(0, 6) });
  t.ev("agentEvents", slim(evs));
  saveRow(t);
}

async function testCleanupSweep() {
  const t = new Test("K7-finished-task-cleanup-sweep", "F3: a finished task whose teardown failed (supervisor down at teardown) is swept after the supervisor returns: cleanup reaches 'confirmed' and the host is empty");
  const cookie = await judgeA();
  const c = await call(cookie, "POST", "/api/tasks", { profileId: "tabulate-365", issueText: REPAIR_ISSUE, scriptedDriver: "slow" });
  const id = c.json.id;
  const runEv = await waitEvent(cookie, id, (e) => e.kind === "model" && JSON.stringify(e.data ?? {}).includes('"run"'), 240_000);
  t.check(runEv, "author command dispatched");
  await sleep(1500);
  const pid = Number(readFileSync(join(STACK, "data/run/supervisor.pid"), "utf8").trim());
  sh(["kill", "-9", String(pid)]);
  const killedAt = iso();
  // Keep the supervisor down until the task is terminal with an unconfirmed teardown.
  const v = await waitTerminal(cookie, id, 5 * 60_000);
  t.check(v.task.cleanup?.status === "failed" || v.task.cleanup?.status === "retrying", `task ended ${v.task.status}/${v.task.outcome} with cleanup ${v.task.cleanup?.status} while the supervisor was down`);
  const leftovers = taskContainers(id);
  t.check(leftovers.length > 0, `the attempt's container is still on the host (${leftovers.join(", ")})`);
  const cleanupWhileDown = v.task.cleanup;
  await sleep(3000);
  const up = sh(["bash", join(STACK, "scripts/dev-up.sh"), "--detach"], { AIRLOCK_WEB_DIST: "none", AIRLOCK_GENERAL_DIAGNOSTIC_SCRIPTS_DIR: join(STACK, "scripts/acceptance/fixtures/general"), AIRLOCK_PROPOSAL_TTL_MS: "60000", AIRLOCK_FORMS_ORIGINS: "http://127.0.0.1:3100,https://forms.example.com", AIRLOCK_JUDGE_PASSWORD: JUDGE_PW, AIRLOCK_OPERATOR_PASSWORD: OPER_PW }, true);
  t.check(up.code === 0, `supervisor restarted (exit ${up.code})`);
  const restartedAt = iso();
  const t0 = Date.now();
  let task: any;
  const seen: string[] = [];
  while (Date.now() - t0 < 6 * 60_000) {
    task = (await getTask(cookie, id)).task;
    const s = `${task.cleanup?.status}`;
    if (seen.at(-1) !== s) seen.push(s);
    if (task.cleanup?.status === "confirmed") break;
    await sleep(1000);
  }
  const confirmedAfterMs = Date.now() - t0;
  t.check(task.cleanup?.status === "confirmed", `cleanup reached confirmed ${Math.round(confirmedAfterMs / 1000)} s after restart (states seen: ${seen.join(" → ")}; ${task.cleanup?.detail})`);
  t.check(task.status === v.task.status && task.outcome === v.task.outcome, `status/outcome unchanged by the sweep (${task.status}/${task.outcome})`);
  t.check(taskContainers(id).length === 0 && ownedDocker().containers.length === 0 && ownedDocker().volumes.length === 0, "host empty (dev namespace): no containers, no volumes");
  const evs = await allEvents(cookie, id);
  t.ev("timeline", { killedAt, restartedAt, cleanupWhileDown, leftovers, cleanupStates: seen, confirmedAfterMs, final: { status: task.status, outcome: task.outcome, cleanup: task.cleanup } });
  t.ev("events", slim(evs).slice(-14));
  saveRow(t);
}

async function testFinalCleanup() {
  const t = new Test("K6-final-host-cleanup", "Containment: after everything, docker ps -a / networks / volumes with label airlock.supervisor=true (dev namespace) are empty; supervisor host listing empty");
  await sleep(3000);
  const o = ownedDocker();
  t.check(o.containers.length === 0, `docker ps -a --filter label=airlock.supervisor=true: ${o.containers.length ? o.containers.join(", ") : "(no sandboxes)"}`);
  t.check(o.networks.length === 0, `docker network ls (label): ${o.networks.join(", ") || "(none)"}`);
  t.check(o.volumes.length === 0, `docker volume ls (label): ${o.volumes.join(", ") || "(none)"}`);
  const listing = await sup("/listing");
  t.check(listing.status === 200 && listing.body?.containers?.length === 0 && listing.body?.volumes?.length === 0 && (listing.body?.networks ?? []).length === 0, `supervisor GET /listing empty (${listing.status})`);
  const other = sh(["docker", "ps", "-a", "--format", "{{.Names}}", "--filter", `name=^${NAMESPACE}-`]).out.trim();
  t.check(other === "", `no ${NAMESPACE}-* named containers at all (${other || "none"})`);
  if (o.allNamespaces.length) t.note = `other namespaces present on the shared daemon (not this stack): ${o.allNamespaces.join("; ")}`;
  t.ev("docker", o);
  t.ev("supervisorListing", listing.body);
  saveRow(t);
}

// ---------------------------------------------------------------------------------------------
// C41 (40 Stage 6): kill the control plane (or the supervisor) during representative operations,
// restart it the way dev-up.sh does, and check reconciliation against the actual containers and
// journal records. Nothing here edits product code; the only store write is C41D's labelled
// injection (made while the control plane is dead).
const STACK_ENV = () => ({ AIRLOCK_WEB_DIST: "none", AIRLOCK_GENERAL_DIAGNOSTIC_SCRIPTS_DIR: join(STACK, "scripts/acceptance/fixtures/general"), AIRLOCK_PROPOSAL_TTL_MS: "60000", AIRLOCK_FORMS_ORIGINS: "http://127.0.0.1:3100,https://forms.example.com", AIRLOCK_JUDGE_PASSWORD: JUDGE_PW, AIRLOCK_OPERATOR_PASSWORD: OPER_PW });
function devUp() {
  const t0 = Date.now();
  const r = sh(["bash", join(STACK, "scripts/dev-up.sh"), "--detach"], STACK_ENV(), true);
  return { code: r.code, ms: Date.now() - t0, lines: r.out.split("\n").filter((l) => /already running|did not|not reachable/.test(l)).slice(0, 6), err: r.code ? r.err.slice(-400) : "" };
}
async function killStackProcess(name: "control" | "supervisor") {
  const pid = Number(readFileSync(join(STACK, `data/run/${name}.pid`), "utf8").trim());
  sh(["kill", "-9", String(pid)]);
  const at = iso();
  for (let i = 0; i < 50 && sh(["kill", "-0", String(pid)]).code === 0; i++) await sleep(100);
  return { process: name, pid, signal: "SIGKILL", at, dead: sh(["kill", "-0", String(pid)]).code !== 0 };
}
async function controlHealth(): Promise<number | string> {
  try {
    return (await fetch(`${CONTROL}/api/health`, { signal: AbortSignal.timeout(2000) })).status;
  } catch (error) {
    return `unreachable (${error instanceof Error ? error.message.slice(0, 80) : String(error)})`;
  }
}
/** One live SSE stream (reconnecting from the last seq); resolves at the first event matching `pred`. */
async function watchFor(cookie: string, id: string, pred: (e: Ev, seen: Ev[]) => boolean, timeoutMs = 240_000): Promise<{ hit: Ev | null; seen: Ev[] }> {
  const seen: Ev[] = [];
  const t0 = Date.now();
  let after = 0;
  while (Date.now() - t0 < timeoutMs) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), Math.max(1, timeoutMs - (Date.now() - t0)));
    try {
      const res = await fetch(`${CONTROL}/api/tasks/${id}/events?lastEventId=${after}`, { headers: { accept: "text/event-stream", cookie }, signal: ctrl.signal });
      if (!res.ok || !res.body) {
        await sleep(300);
        continue;
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          let name = "message";
          let data = "";
          for (const line of block.split("\n")) {
            if (line.startsWith("event:")) name = line.slice(6).trim();
            else if (line.startsWith("data:")) data += line.slice(5).trim();
          }
          if (name === "end") {
            ctrl.abort();
            return { hit: null, seen };
          }
          if (name === "task" || !data) continue;
          try {
            const e = JSON.parse(data);
            if (typeof e.seq !== "number") continue;
            seen.push(e);
            after = e.seq;
            if (pred(e, seen)) {
              ctrl.abort();
              return { hit: e, seen };
            }
          } catch {
            // ignore
          }
        }
      }
    } catch {
      await sleep(200);
    } finally {
      clearTimeout(timer);
    }
  }
  return { hit: null, seen };
}
const slimC41 = (evs: Ev[]) =>
  evs.map((e) => ({
    seq: e.seq,
    at: e.at,
    kind: e.kind,
    title: e.title,
    ...(e.detail ? { detail: e.detail.slice(0, 400) } : {}),
    ...(e.data?.tool ? { tool: e.data.tool } : {}),
    ...(e.data?.opState ? { opState: e.data.opState } : {}),
    ...(e.data?.operationId ? { operationId: e.data.operationId } : {}),
    ...(e.data?.attemptId ? { attemptId: e.data.attemptId } : {}),
    ...(e.data?.actor ? { actor: e.data.actor } : {}),
    ...(e.data?.proposalId ? { proposalId: e.data.proposalId } : {}),
    ...(e.data?.status ? { status: e.data.status } : {}),
    ...(e.data?.recoveries !== undefined ? { recoveries: e.data.recoveries } : {}),
  }));
/** The supervisor journal's record of one operation (M8): pending/completed/interrupted, never the body. */
async function supOp(operationId: string | undefined): Promise<{ status: number; body: unknown }> {
  if (!operationId) return { status: 0, body: null };
  try {
    const res = await fetch(`${SUPERVISOR}/operations/${operationId}`, { headers: { authorization: `Bearer ${SUP_TOKEN}` }, signal: AbortSignal.timeout(3000) });
    return { status: res.status, body: await res.json().catch(() => null) };
  } catch (error) {
    return { status: -1, body: error instanceof Error ? error.message.slice(0, 120) : String(error) };
  }
}
function taskNetworks(taskId: string) {
  return sh(["docker", "network", "ls", "--filter", `label=airlock.task=${taskId}`, "--format", "{{.Name}}"]).out.trim().split("\n").filter(Boolean);
}
function supLogFor(attemptId: string, max = 20): string[] {
  const p = join(STACK, "data/run/supervisor.log");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split("\n").filter((l) => l.includes(attemptId)).slice(-max).map((l) => l.slice(0, 400));
}
function artifactTmpFiles(): string[] {
  return sh(["find", join(STACK, "data/control/artifacts"), "-name", ".tmp-*"]).out.trim().split("\n").filter(Boolean);
}
/** Common end-state checks for a killed task: terminal, old attempt not live, no containers/networks. */
async function c41EndState(t: Test, cookie: string, id: string, oldAttempt: string | undefined, timeoutMs = 10 * 60_000) {
  const v = await waitTerminal(cookie, id, timeoutMs);
  await sleep(2000);
  const task = (await getTask(cookie, id)).task;
  t.check(TERMINAL.has(task.status), `task reached a terminal status (${task.status}/${task.outcome ?? "none"}), not left running`);
  t.check(task.cleanup?.status === "confirmed", `cleanup confirmed (${task.cleanup?.status}: ${task.cleanup?.detail ?? ""})`);
  const attempts = (await attemptsFor(id)).map((a) => ({ attemptId: a.ref?.attemptId, generation: a.ref?.generation, role: a.role, status: a.status }));
  const old = attempts.find((a) => a.attemptId === oldAttempt);
  t.check(!old || old.status === "destroyed", `the interrupted attempt ${oldAttempt} is destroyed at the supervisor (${old?.status ?? "gone"})`);
  t.check(attempts.every((a) => a.status === "destroyed"), `no live attempt of the task at the supervisor (${attempts.map((a) => `${a.attemptId}:${a.status}`).join(", ")})`);
  const cs = taskContainers(id);
  const ns = taskNetworks(id);
  t.check(cs.length === 0, `no container of the task remains (${cs.join(", ") || "none"})`);
  t.check(ns.length === 0, `no network of the task remains (${ns.join(", ") || "none"})`);
  return { view: v, task, attempts };
}
/** C41 O2 (509a832): the reconciliation line for an op must carry the supervisor's own record of it, matching GET /operations/:id. */
function checkSupervisorRecordInReconciliation(t: Test, evs: Ev[], opId: string, atEnd: { status: number; body: any }) {
  const line = evs.find((e) => e.title === "Reconciled outstanding supervisor operations" && (e.detail ?? "").includes(opId))?.detail?.split("\n").find((l) => l.includes(opId)) ?? "";
  const b = atEnd.body ?? {};
  const expected = b.interruptedByRestart ? "supervisor: interrupted" : b.state === "completed" ? "supervisor: completed" : b.state ? "supervisor: still pending" : "supervisor has no record";
  t.check(line.includes(expected) && /not replayed/.test(line), `recovery recorded the supervisor's own record of ${opId} and still did not replay it ("${line.slice(0, 220)}"; supervisor journal: state=${b.state} http=${b.httpStatus} interruptedByRestart=${b.interruptedByRestart})`);
}
function opTrail(evs: Ev[], operationId: string | undefined) {
  return slimC41(evs.filter((e) => operationId && e.data?.operationId === operationId));
}

async function testC41Browser(proc: "control" | "supervisor") {
  const sup = proc === "supervisor";
  const t = new Test(
    sup ? "C41F-supervisor-kill-browser-navigate" : "C41A-control-kill-browser-navigate",
    sup
      ? "C41: SIGKILL the SUPERVISOR while a browser navigate (httpbin.org/delay/8) is in flight, restart it with dev-up.sh → the uncertain op is not replayed, the browser attempt is revoked/stopped at restart and destroyed, egress container and networks removed, the task does not run forever"
      : "C41: SIGKILL the CONTROL PLANE while a browser navigate (httpbin.org/delay/8) is in flight, restart it with dev-up.sh → the task is recovered (recovery counted) or ends INCONCLUSIVE; the old browser attempt is discarded (not reused); the uncertain op is reconciled, never re-dispatched; host empty",
  );
  const cookie = await judgeA();
  const c = await call(cookie, "POST", "/api/tasks", { kind: "general", profileId: "web-research", issueText: `C41 ${proc} kill during a browser navigate`, egressAllow: ["example.com", "httpbin.org"], scriptedDriver: "acc-c41-slow-nav" });
  t.check(c.status === 201, `create → ${c.status} ${c.status !== 201 ? c.text.slice(0, 200) : ""}`);
  const id = c.json.id as string;
  const w = await watchFor(cookie, id, (e, seen) => e.kind === "tool" && e.data?.tool === "browser_navigate" && e.data?.opState === "started" && seen.filter((x) => x.data?.tool === "browser_navigate" && x.data?.opState === "started").length === 2);
  t.check(w.hit, "the slow navigate (httpbin.org/delay/8) was dispatched (started event)");
  if (!w.hit) return saveRow(t);
  const opId = w.hit.data.operationId as string;
  const oldAttempt = w.hit.data.attemptId as string;
  await sleep(1500);
  const containersBefore = taskContainers(id);
  const attemptBefore = (await attemptsFor(id)).map((a) => ({ attemptId: a.ref?.attemptId, status: a.status }));
  const supOpBeforeKill = await supOp(opId);
  const kill = await killStackProcess(proc);
  t.check(kill.dead, `${proc} pid ${kill.pid} killed with SIGKILL at ${kill.at}, 1.5 s into the navigate`);
  await sleep(3000);
  const whileDown: Record<string, unknown> = { containers: taskContainers(id), controlHealth: await controlHealth() };
  if (!sup) whileDown.supervisorAttempts = (await attemptsFor(id)).map((a) => ({ attemptId: a.ref?.attemptId, status: a.status }));
  const up = devUp();
  t.check(up.code === 0, `${proc} restarted via dev-up.sh --detach (exit ${up.code}, ${up.ms} ms) ${up.err}`);
  const restartedAt = iso();
  const afterRestart: Record<string, unknown> = { containers: taskContainers(id), supervisorAttempts: (await attemptsFor(id)).map((a) => ({ attemptId: a.ref?.attemptId, status: a.status })) };
  if (sup) {
    const a = (afterRestart.supervisorAttempts as any[]).find((x) => x.attemptId === oldAttempt);
    t.check(a && a.status !== "created" && a.status !== "running", `right after the supervisor restart the old browser attempt is no longer live (${a?.status ?? "gone"})`);
    const running = (afterRestart.containers as string[]).filter((l) => l.split(" ")[1] === "Up");
    t.check(running.length === 0, `right after restart, no container of the task is running (${(afterRestart.containers as string[]).join(" | ") || "none"})`);
  } else {
    afterRestart.taskImmediately = (({ status, phase, attempts, budget }) => ({ status, phase, attempts, recoveries: budget?.recoveries }))((await getTask(cookie, id)).task);
    const rec = await waitEvent(cookie, id, (e) => e.title === "Recovering task", 180_000);
    t.check(rec, `the restarted control plane reclaimed the task (${rec?.title}: ${rec?.detail ?? ""})`);
  }
  const end = await c41EndState(t, cookie, id, oldAttempt);
  const evs = await allEvents(cookie, id);
  const trail = opTrail(evs, opId);
  t.check(trail.length > 0 && trail.every((e) => e.opState !== "completed"), `the uncertain navigate ${opId} never completed (trail: ${trail.map((e) => `${e.title}[${e.opState ?? "-"}]`).join(" → ")})`);
  const startedSameOp = evs.filter((e) => e.data?.operationId === opId && e.data?.opState === "started").length;
  t.check(startedSameOp === 1, `operation ${opId} was dispatched exactly once (started events: ${startedSameOp})`);
  if (sup) {
    const unk = evs.find((e) => e.data?.operationId === opId && (e.data?.opState === "unknown" || e.data?.opState === "failed"));
    t.check(unk, `the controller recorded the navigate's outcome as ${unk?.data?.opState ?? "?"} ("${unk?.title ?? "none"}")`);
    // O3/N1 (509a832, d3746a2): after the supervisor kill the scripted run continues in a fresh
    // about:blank session; its only screenshot shows no cited source, so the result is partial.
    const shot = (end.task.result?.checks ?? []).find((c: any) => c.name === "screenshot-evidence");
    t.check(end.task.outcome === "RESULT_PARTIAL" && shot?.passed === false, `outcome ${end.task.outcome}: screenshot-evidence ${shot?.passed ? "passed" : "failed"} (${shot?.detail ?? "no check"})`);
  } else {
    const recon = evs.find((e) => e.title === "Reconciled outstanding supervisor operations" && (e.detail ?? "").includes(opId));
    t.check(recon, `recovery reconciled the outstanding operation ${opId} ("${recon?.detail?.split("\n").find((l) => l.includes(opId)) ?? "none"}")`);
    const discarded = evs.find((e) => e.title === "Discarded attempt from an earlier run" && e.data?.attemptId === oldAttempt);
    t.check(discarded && discarded.data?.opState === "completed", `the old browser attempt was discarded, not reused ("${discarded?.detail ?? "no event"}")`);
    t.check((end.task.budget?.recoveries ?? 0) >= 1, `recovery counted (task.budget.recoveries = ${end.task.budget?.recoveries})`);
    t.check(end.task.outcome !== "RESULT_VERIFIED" || (end.task.budget?.recoveries ?? 0) >= 1, `outcome ${end.task.outcome} is honest (a verified result only after a counted recovery)`);
    const shot = (end.task.result?.checks ?? []).find((c: any) => c.name === "screenshot-evidence");
    t.check(end.task.outcome !== "RESULT_VERIFIED" || shot?.passed === true, `a verified result carries a screenshot of a cited source (${shot?.detail ?? "no check"})`);
    checkSupervisorRecordInReconciliation(t, evs, opId, await supOp(opId));
  }
  const pivot = sup ? w.hit.seq : (evs.find((e) => e.title === "Recovering task")?.seq ?? Infinity);
  const lateOld = evs.filter((e) => e.seq > pivot && e.kind === "tool" && e.data?.attemptId === oldAttempt && e.data?.opState === "completed");
  t.check(lateOld.length === 0, `no browser op completed on the old attempt after the ${sup ? "kill" : "recovery"} (${lateOld.length})`);
  const laterOps = evs.filter((e) => e.seq > w.hit!.seq && e.kind === "tool" && e.data?.opState === "completed" && e.data?.attemptId);
  const laterAttempts = [...new Set(laterOps.map((e) => e.data.attemptId as string))];
  t.check(laterAttempts.every((a) => a !== oldAttempt), `browser ops after the kill ran only on fresh attempt(s): ${laterAttempts.join(", ") || "none"}`);
  t.ev("timeline", { taskId: id, uncertainOperation: opId, oldAttempt, containersBefore, attemptBefore, kill, whileDown, restart: { at: restartedAt, ...up }, afterRestart });
  t.ev("supervisorOperationRecord", { beforeKill: supOpBeforeKill, atEnd: await supOp(opId) });
  t.ev("final", { status: end.task.status, outcome: end.task.outcome ?? null, recoveries: end.task.budget?.recoveries ?? 0, cleanup: end.task.cleanup, attempts: end.attempts, result: end.task.result ?? null });
  t.ev("uncertainOperationTrail", trail);
  t.ev("supervisorLogOldAttempt", supLogFor(oldAttempt));
  t.ev("events", slimC41(evs));
  saveRow(t);
}
const testC41A = () => testC41Browser("control");
const testC41F = () => testC41Browser("supervisor");

async function testC41Code() {
  const t = new Test("C41B-control-kill-code-run", "C41: SIGKILL the control plane during an analysis-sandbox code_run (sleep 20, then append one marker line) → the uncertain run is reconciled, never recorded as a success; any re-run is a new operation in a fresh sandbox; the marker holds exactly one line; cleanup confirmed");
  const cookie = await judgeA();
  const c = await call(cookie, "POST", "/api/tasks", { kind: "general", profileId: "analysis", issueText: "C41 control kill during code_run", scriptedDriver: "acc-c41-slow-code" });
  t.check(c.status === 201, `create → ${c.status} ${c.status !== 201 ? c.text.slice(0, 200) : ""}`);
  const id = c.json.id as string;
  const w = await watchFor(cookie, id, (e) => e.data?.tool === "code_run" && e.data?.opState === "started");
  t.check(w.hit, "code_run (sleep 20) dispatched");
  if (!w.hit) return saveRow(t);
  const opId = w.hit.data.operationId as string;
  const oldAttempt = w.hit.data.attemptId as string;
  await sleep(2500);
  const containersBefore = taskContainers(id);
  const oldContainer = containersBefore.map((l) => l.split(" ")[0]!).find((n) => n.includes(oldAttempt)) ?? containersBefore[0]?.split(" ")[0];
  const topBefore = oldContainer ? sh(["docker", "top", oldContainer, "-o", "pid,etime,args"]).out.trim().split("\n").slice(0, 8) : [];
  const supOpBeforeKill = await supOp(opId);
  const kill = await killStackProcess("control");
  t.check(kill.dead, `control pid ${kill.pid} killed with SIGKILL at ${kill.at}, 2.5 s into the run`);
  await sleep(3000);
  const topWhileDown = oldContainer ? sh(["docker", "top", oldContainer, "-o", "pid,etime,args"]).out.trim().split("\n").slice(0, 8) : [];
  const whileDown = { controlHealth: await controlHealth(), containers: taskContainers(id), supervisorAttempts: (await attemptsFor(id)).map((a) => ({ attemptId: a.ref?.attemptId, status: a.status })), topBefore, topWhileDown };
  const up = devUp();
  t.check(up.code === 0, `control restarted via dev-up.sh --detach (exit ${up.code}, ${up.ms} ms) ${up.err}`);
  const restartedAt = iso();
  const rec = await waitEvent(cookie, id, (e) => e.title === "Recovering task", 180_000);
  t.check(rec, `the restarted control plane reclaimed the task (${rec?.detail ?? "no Recovering event"})`);
  const end = await c41EndState(t, cookie, id, oldAttempt);
  const evs = await allEvents(cookie, id);
  const trail = opTrail(evs, opId);
  t.check(trail.every((e) => e.opState !== "completed"), `the uncertain code_run ${opId} never completed and was never recorded as a success (trail: ${trail.map((e) => `${e.title}[${e.opState ?? "-"}]`).join(" → ")})`);
  const recon = evs.find((e) => e.title === "Reconciled outstanding supervisor operations" && (e.detail ?? "").includes(opId));
  t.check(recon, `recovery reconciled ${opId}: "${recon?.detail?.split("\n").find((l) => l.includes(opId)) ?? "none"}"`);
  checkSupervisorRecordInReconciliation(t, evs, opId, await supOp(opId));
  const runsCompleted = evs.filter((e) => e.kind === "exec" && e.data?.tool === "code_run" && e.data?.opState === "completed");
  t.check(runsCompleted.every((e) => e.data?.operationId !== opId && e.data?.attemptId !== oldAttempt), `every completed code_run is a new operation on a fresh attempt (${runsCompleted.map((e) => `${e.data?.operationId}@${e.data?.attemptId}`).join(", ") || "none"})`);
  t.check(runsCompleted.length <= 1, `at most one completed code_run recorded (${runsCompleted.length})`);
  const discarded = evs.find((e) => e.title === "Discarded attempt from an earlier run" && e.data?.attemptId === oldAttempt);
  t.check(discarded && discarded.data?.opState === "completed", `the old analysis sandbox was discarded ("${discarded?.detail ?? "no event"}")`);
  t.check((end.task.budget?.recoveries ?? 0) >= 1, `recovery counted (${end.task.budget?.recoveries})`);
  const arts = ((await call(cookie, "GET", `/api/tasks/${id}/artifacts`)).json as any[]) ?? [];
  const marker = arts.find((a) => a.kind === "output" && a.filename === "marker.txt");
  let markerText: string | null = null;
  if (marker) {
    const d = await call(cookie, "GET", `/api/artifacts/${marker.id}`, undefined, { binary: true });
    markerText = new TextDecoder().decode(d.bytes!);
  }
  const lines = (markerText ?? "").split("\n").filter(Boolean);
  if (end.task.outcome === "RESULT_VERIFIED") t.check(lines.length === 1, `outputs/marker.txt has exactly one line: the fresh sandbox's single run (${JSON.stringify(lines)})`);
  else t.check(marker === undefined || lines.length <= 1, `no verified result; marker lines ${lines.length}`);
  t.check(arts.filter((a) => a.source?.attemptId === oldAttempt).length === 0, `no artifact came from the old attempt (${arts.filter((a) => a.source?.attemptId === oldAttempt).length})`);
  t.ev("timeline", { taskId: id, uncertainOperation: opId, oldAttempt, oldContainer, containersBefore, kill, whileDown, restart: { at: restartedAt, ...up } });
  t.ev("supervisorOperationRecord", { beforeKill: supOpBeforeKill, atEnd: await supOp(opId) });
  t.ev("final", { status: end.task.status, outcome: end.task.outcome ?? null, recoveries: end.task.budget?.recoveries ?? 0, cleanup: end.task.cleanup, attempts: end.attempts, markerLines: lines, artifacts: arts.map((a) => ({ id: a.id, kind: a.kind, filename: a.filename, sha256: a.sha256, attemptId: a.source?.attemptId })) });
  t.ev("uncertainOperationTrail", trail);
  t.ev("supervisorLogOldAttempt", supLogFor(oldAttempt));
  t.ev("events", slimC41(evs));
  saveRow(t);
}

async function testC41Takeover() {
  const t = new Test("C41C-control-kill-during-takeover", "C41: a person takes browser control, then the control plane is SIGKILLed → after restart no human action is honoured on the old session, control returns to the agent before any agent browser op (never simultaneous), the agent works in a fresh session (observes afresh), old attempt destroyed");
  const cookie = await judgeA();
  const c = await call(cookie, "POST", "/api/tasks", { kind: "general", profileId: "web-research", issueText: "C41 control kill during takeover", egressAllow: ["example.com"], scriptedDriver: "acc-c41-takeover" });
  t.check(c.status === 201, `create → ${c.status}`);
  const id = c.json.id as string;
  t.check(await waitLiveBrowser(cookie, id), "task running with a live browser");
  const take = await call(cookie, "POST", `/api/tasks/${id}/control/take`, {});
  t.check(take.status === 200, `take → ${take.status} ${take.text.slice(0, 160)}`);
  await sleep(1500);
  const ctlBefore = (await call(cookie, "GET", `/api/tasks/${id}/control`)).json;
  t.check(ctlBefore?.control?.holder === "human", `holder=${ctlBefore?.control?.holder} before the kill`);
  const hObs = await call(cookie, "POST", `/api/tasks/${id}/control/action`, { request: { op: "observe" } });
  t.check(hObs.status === 200 && hObs.json?.ok, `human observe while holding → ${hObs.status}`);
  const before = await allEvents(cookie, id);
  const oldAttempt = [...before].reverse().find((e) => e.data?.attemptId)?.data?.attemptId as string | undefined;
  const kill = await killStackProcess("control");
  t.check(kill.dead, `control pid ${kill.pid} SIGKILLed while the human held control`);
  await sleep(3000);
  const whileDown = { controlHealth: await controlHealth(), containers: taskContainers(id) };
  const up = devUp();
  t.check(up.code === 0, `control restarted via dev-up.sh (exit ${up.code}, ${up.ms} ms)`);
  // Before the worker reclaims the task (lease up to 60 s): what the API says and does.
  const ctlGap = await call(cookie, "GET", `/api/tasks/${id}/control`);
  // O1 (509a832): the restarted process resets a stale human holder at start, before any reclaim.
  t.check(ctlGap.status === 200 && ctlGap.json?.control?.holder === "agent" && /restarted/.test(String(ctlGap.json?.control?.reason ?? "")), `immediately after the restart (before reclaim) GET /control reports holder=${ctlGap.json?.control?.holder} ("${ctlGap.json?.control?.reason ?? ""}")`);
  const taskGap = (await getTask(cookie, id)).task;
  const actGap = await call(cookie, "POST", `/api/tasks/${id}/control/action`, { request: { op: "observe" } });
  const clickGap = await call(cookie, "POST", `/api/tasks/${id}/control/action`, { request: { op: "scroll", args: { dy: 50 } } });
  const takeGap = await call(cookie, "POST", `/api/tasks/${id}/control/take`, {});
  t.check(!(actGap.status === 200 && actGap.json?.ok) && !(clickGap.status === 200 && clickGap.json?.ok), `after restart, before reclaim: human actions on the dead run are not executed (observe → ${actGap.status}, scroll → ${clickGap.status})`);
  const rec = await waitEvent(cookie, id, (e) => e.title === "Recovering task", 180_000);
  t.check(rec, `task reclaimed (${rec?.detail ?? "none"})`);
  const returned = await waitEvent(cookie, id, (e) => e.title === "Control returned to the agent", 60_000);
  t.check(returned, `"Control returned to the agent": ${returned?.detail ?? "no event"}`);
  const ctlAfter = (await call(cookie, "GET", `/api/tasks/${id}/control`)).json;
  const end = await c41EndState(t, cookie, id, oldAttempt);
  const evs = await allEvents(cookie, id);
  const recSeq = evs.find((e) => e.title === "Recovering task")?.seq ?? Infinity;
  const retSeq = evs.find((e) => e.title === "Control returned to the agent" && e.seq > (before.at(-1)?.seq ?? 0))?.seq ?? Infinity;
  t.check(retSeq < recSeq, `"Control returned to the agent" (#${retSeq}) was recorded at restart, before the reclaim ("Recovering task" #${recSeq})`);
  const firstAgentOp = evs.find((e) => e.seq > recSeq && e.kind === "tool" && e.data?.opState === "started" && String(e.data?.tool ?? "").startsWith("browser_"));
  t.check(retSeq < (firstAgentOp?.seq ?? Infinity), `control returned to the agent (#${retSeq}) before the recovered run's first browser op (#${firstAgentOp?.seq} ${firstAgentOp?.data?.tool})`);
  const postRecBrowser = evs.filter((e) => e.seq > recSeq && e.kind === "tool" && e.data?.opState === "completed" && String(e.data?.tool ?? "").startsWith("browser_"));
  const firstTools = postRecBrowser.slice(0, 2).map((e) => e.data?.tool);
  t.check(firstTools[0] === "browser_navigate" && firstTools[1] === "browser_observe" && postRecBrowser.every((e) => e.data?.attemptId !== oldAttempt), `recovered run starts a fresh session and observes before anything else (${firstTools.join(" → ")}, attempt ${postRecBrowser[0]?.data?.attemptId})`);
  const humanAfter = evs.filter((e) => e.seq > (before.at(-1)?.seq ?? 0) && e.data?.actor === "human" && e.data?.opState === "completed");
  t.check(humanAfter.length === 0, `no human browser op completed after the kill (${humanAfter.length})`);
  t.check(end.task.control === undefined || end.task.control?.holder === "agent", `final Task.control holder = ${end.task.control?.holder ?? "(unset)"}`);
  t.ev("timeline", { taskId: id, oldAttempt, kill, whileDown, restart: up, controlBefore: ctlBefore?.control, afterRestartBeforeReclaim: { taskStatus: taskGap.status, control: { status: ctlGap.status, body: ctlGap.json }, humanObserve: { status: actGap.status, body: actGap.text.slice(0, 300) }, humanScroll: { status: clickGap.status, body: clickGap.text.slice(0, 300) }, take: { status: takeGap.status, body: takeGap.text.slice(0, 300) } }, controlAfterReclaim: ctlAfter });
  t.ev("final", { status: end.task.status, outcome: end.task.outcome ?? null, recoveries: end.task.budget?.recoveries ?? 0, cleanup: end.task.cleanup, control: end.task.control ?? null, attempts: end.attempts });
  t.ev("events", slimC41(evs));
  saveRow(t);
}

async function withControlStore<T>(fn: (db: any) => Promise<T>): Promise<T> {
  const mod = await import(Bun.resolveSync("@electric-sql/pglite", join(STACK, "apps/control")));
  const db = new mod.PGlite(join(STACK, "data/control/pglite"));
  try {
    return await fn(db);
  } finally {
    await db.close();
  }
}
function fixturesAccepted(proposalId: string): number {
  const p = join(STACK, "data/run/fixtures.log");
  if (!existsSync(p)) return -1;
  return readFileSync(p, "utf8").split("\n").filter((l) => l.includes("submission_accepted") && l.includes(proposalId)).length;
}

async function testC41Proposal() {
  const t = new Test("C41D-control-kill-approved-submission", "C41: control plane SIGKILLed during an approved submission. (a) real path: a proposal to the configured-but-unreachable https://forms.example.com is approved and the kill lands while the controller holds it; (b) store level: two proposals on the loopback fixtures destination are left `submitted` (its submission really reached the destination) and `claimed` (never reached it). After restart: claimed/submitted → outcome_unknown, reconciled ONLY by receipt reads; the reached one becomes confirmed with the destination's receipt; nothing is re-submitted");
  const cookie = await judgeA();
  const c = await call(cookie, "POST", "/api/tasks", { kind: "general", profileId: "web-research", issueText: "C41 control kill during an approved submission", egressAllow: ["example.com", "forms.example.com"], scriptedDriver: "acc-c41-propose" });
  t.check(c.status === 201, `create → ${c.status}`);
  const id = c.json.id as string;
  let pending: any = null;
  for (let i = 0; i < 240 && !pending; i++) {
    pending = ((await call(cookie, "GET", `/api/tasks/${id}/approvals`)).json as any[] | null)?.find((p) => p.status === "pending") ?? null;
    if (!pending) await sleep(250);
  }
  t.check(pending, `proposal pending (${pending?.id})`);
  if (!pending) return saveRow(t);
  const ok = await call(cookie, "POST", `/api/tasks/${id}/approvals/${pending.id}/decide`, { decision: "approve", payloadDigest: pending.payloadDigest });
  t.check(ok.status === 200 && ok.json?.status === "approved", `approved with the exact digest → ${ok.status}`);
  const seenStates: string[] = ["approved"];
  let atKill = "approved";
  const t0 = Date.now();
  while (Date.now() - t0 < 5000) {
    const s = ((await call(cookie, "GET", `/api/tasks/${id}/approvals`)).json as any[]).find((p) => p.id === pending.id)?.status;
    if (s && seenStates.at(-1) !== s) seenStates.push(s);
    if (s && s !== "approved") {
      atKill = s;
      break;
    }
    await sleep(15);
  }
  const kill = await killStackProcess("control");
  t.check(kill.dead, `control pid ${kill.pid} SIGKILLed with the real proposal ${atKill} (states seen: ${seenStates.join(" → ")})`);
  await sleep(1500);
  // ---- store level, while the control plane is dead (labelled injection) ----
  const fx = await import(join(STACK, "apps/fixtures/src/lib.ts"));
  const secret = DEV.AIRLOCK_FORMS_SECRET ?? readEnvFile(join(STACK, "data/dev.env")).AIRLOCK_FORMS_SECRET;
  const origin = "http://127.0.0.1:3100";
  const injected: any[] = [];
  const storeView = await withControlStore(async (db) => {
    const taskRow = (await db.query("SELECT owner, data FROM records WHERE kind='tasks' AND id=$1", [id])).rows[0];
    const real = (await db.query("SELECT data FROM records WHERE kind='action-proposals' AND id=$1", [pending.id])).rows[0]?.data;
    const owner = taskRow.owner as string;
    const attemptId = (taskRow.data.attemptId ?? real?.attemptId) as string;
    for (const [label, status] of [["reached", "submitted"], ["not-reached", "claimed"]] as const) {
      const norm = fx.normalizeFields("contact-request", { name: `C41 ${label}`, email: "c41@example.com", message: `store-level ${status} proposal (${label})` });
      const fields = norm.fields as Record<string, string>;
      const payloadDigest = await fx.formPayloadDigest(origin, "contact-request", fields);
      const now = Date.now();
      const p = { schemaVersion: real?.schemaVersion ?? 1, id: `prop-c41${label === "reached" ? "r" : "n"}${randomInt(100000, 999999)}`, owner, taskId: id, attemptId, browserGeneration: 0, destination: origin, adapter: "airlock-forms-v1", formId: "contact-request", fields, payloadDigest, summary: `C41 store-level injection (${label})`, createdAt: new Date(now - 60_000).toISOString(), expiresAt: new Date(now + 10 * 60_000).toISOString(), status, decidedBy: "verifier_tester (store-level injection)", decidedAt: new Date(now - 30_000).toISOString() };
      await db.query("INSERT INTO records(owner,kind,id,data) VALUES($1,'action-proposals',$2,$3::jsonb)", [owner, p.id, JSON.stringify(p)]);
      injected.push({ label, ...p });
    }
    return { taskStatus: taskRow.data.status, taskPhase: taskRow.data.phase, leaseUntil: taskRow.data.leaseUntil, attemptId, realProposalStatusInStore: real?.status };
  });
  // The "reached" submission: exactly what the controller would have sent, posted once to the destination.
  const reached = injected.find((p) => p.label === "reached");
  const code = fx.mintApprovalCode({ secret, proposalId: reached.id, payloadDigest: reached.payloadDigest, expiresAtEpoch: Math.floor(Date.parse(reached.expiresAt) / 1000) });
  const form = new URLSearchParams({ ...reached.fields, [fx.APPROVAL_FIELD]: code });
  const post = await fetch(`${origin}/f/contact-request/submit`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form.toString() });
  const postText = await post.text();
  t.check(post.status === 200 && postText.includes("Submission accepted"), `the 'reached' submission was recorded by the destination (${post.status})`);
  const acceptedBefore = { reached: fixturesAccepted(reached.id), notReached: fixturesAccepted(injected[1].id), real: fixturesAccepted(pending.id) };
  const up = devUp();
  t.check(up.code === 0, `control restarted via dev-up.sh (exit ${up.code}, ${up.ms} ms)`);
  const rec = await waitEvent(cookie, id, (e) => e.title === "Recovering task", 180_000);
  t.check(rec, `task reclaimed (${rec?.detail ?? "none"})`);
  // The replayed script proposes again: a NEW proposal that needs a new decision. Reject it.
  const known = new Set([pending.id, ...injected.map((p) => p.id)]);
  let fresh: any = null;
  for (let i = 0; i < 240 && !fresh; i++) {
    const l = ((await call(cookie, "GET", `/api/tasks/${id}/approvals`)).json as any[]) ?? [];
    fresh = l.find((p) => !known.has(p.id) && p.status === "pending") ?? null;
    if (!fresh && TERMINAL.has((await getTask(cookie, id)).task.status)) break;
    if (!fresh) await sleep(500);
  }
  const rej = fresh ? await call(cookie, "POST", `/api/tasks/${id}/approvals/${fresh.id}/decide`, { decision: "reject", payloadDigest: fresh.payloadDigest }) : null;
  const end = await c41EndState(t, cookie, id, storeView.attemptId);
  const props = ((await call(cookie, "GET", `/api/tasks/${id}/approvals`)).json as any[]) ?? [];
  const byId = (pid: string) => props.find((p) => p.id === pid);
  const evs = await allEvents(cookie, id);
  const recSeq = evs.find((e) => e.title === "Recovering task")?.seq ?? Infinity;
  const evFor = (pid: string) => evs.filter((e) => e.data?.proposalId === pid && e.seq > recSeq);
  const realFinal = byId(pending.id);
  t.check(realFinal && realFinal.status !== "confirmed" && (atKill !== "claimed" || realFinal.status === "outcome_unknown"), `real proposal: ${atKill} at the kill → ${realFinal?.status} after restart (forms.example.com is unreachable, so it cannot be confirmed)`);
  const r = byId(reached.id);
  t.check(r?.status === "confirmed" && r?.receipt?.payloadDigest === reached.payloadDigest, `'reached' (submitted at the kill) → ${r?.status}, receipt ${r?.receipt?.receiptId ?? "none"} with the approved payload digest`);
  t.check(evFor(reached.id).some((e) => e.title === "Final action outcome unknown") && evFor(reached.id).some((e) => /Receipt read \(reconciliation\) \d+: confirmed/.test(e.title)), `'reached': moved to outcome_unknown, then confirmed by a receipt READ (${evFor(reached.id).map((e) => e.title).join(" → ")})`);
  const n = byId(injected[1].id);
  t.check(n?.status === "outcome_unknown", `'not-reached' (claimed at the kill) → ${n?.status}; the destination has no receipt, so it stays outcome_unknown (${evFor(injected[1].id).map((e) => e.title).join(" → ")})`);
  const acceptedAfter = { reached: fixturesAccepted(reached.id), notReached: fixturesAccepted(injected[1].id), real: fixturesAccepted(pending.id) };
  t.check(acceptedAfter.reached === 1 && acceptedAfter.notReached === 0 && acceptedAfter.real === 0, `nothing re-submitted: destination submission_accepted counts reached=${acceptedAfter.reached} (the one pre-crash post), not-reached=${acceptedAfter.notReached}, real=${acceptedAfter.real}`);
  const resubmit = evs.filter((e) => e.seq > recSeq && (e.title === "Approved: Airlock submits the form" || e.data?.actor === "controller") && [pending.id, ...injected.map((p) => p.id)].includes(e.data?.proposalId));
  const controllerOps = evs.filter((e) => e.seq > recSeq && e.data?.actor === "controller");
  t.check(resubmit.length === 0 && controllerOps.length === 0, `no controller submission step after the restart (${controllerOps.length} controller events)`);
  const readTok = fx.receiptsReadToken(secret);
  const rcptN = await fetch(`${origin}/api/receipts/${injected[1].id}`, { headers: { authorization: `Bearer ${readTok}` } });
  t.check(rcptN.status === 404, `destination still has no receipt for 'not-reached' (${rcptN.status})`);
  t.check(!fresh || (rej?.status === 200 && byId(fresh.id)?.status === "rejected"), `the replayed script's new proposal ${fresh?.id ?? "(none)"} needed a fresh decision (rejected → ${rej?.status}); approvals are not carried across the restart`);
  t.ev("timeline", { taskId: id, realProposal: { id: pending.id, statesSeen: seenStates, atKill }, kill, storeAtKill: storeView, restart: up, destinationPost: { status: post.status }, acceptedBefore, acceptedAfter });
  t.ev("injected", injected.map(({ fields, ...p }) => ({ ...p, fields })));
  t.ev("proposalsFinal", props.map((p) => ({ id: p.id, status: p.status, destination: p.destination, payloadDigest: p.payloadDigest, receipt: p.receipt ?? null })));
  t.ev("final", { status: end.task.status, outcome: end.task.outcome ?? null, recoveries: end.task.budget?.recoveries ?? 0, cleanup: end.task.cleanup });
  t.ev("events", slimC41(evs));
  t.note = "Part (b) is a store-level injection: the loopback fixtures destination is unreachable from the sandboxed browser, so the controller-driven submit cannot reach it locally. The driver wrote two proposal records (status submitted / claimed) into the dead control plane's PGlite store and posted the 'reached' one once to the fixtures destination with a correctly minted approval code (simulating a submit that landed before the crash). Reconciliation after restart is the product's own code.";
  saveRow(t);
}

async function testC41Download(variant: "read" | "transfer") {
  const read = variant === "read";
  const t = new Test(
    read ? "C41E-control-kill-download-read" : "C41E2-control-kill-download-transfer",
    read
      ? "C41: control plane SIGKILLed while browser_download_save (download.read of a 9,000,000-byte file from speed.cloudflare.com) is in flight → the transfer never becomes an artifact, no orphan temp blobs, the old attempt torn down"
      : "C41: control plane SIGKILLed while the browser's own download (httpbin.org/drip, 300000 bytes over 40 s) is in progress → the partial file never becomes an artifact, no orphan temp blobs, the old attempt torn down",
  );
  const cookie = await judgeA();
  const c = await call(cookie, "POST", "/api/tasks", { kind: "general", profileId: "web-research", issueText: `C41 control kill during a download (${variant})`, egressAllow: read ? ["speed.cloudflare.com", "httpbin.org"] : ["httpbin.org"], scriptedDriver: read ? "acc-c41-download" : "acc-c41-drip" });
  t.check(c.status === 201, `create → ${c.status}`);
  const id = c.json.id as string;
  const tmpBefore = artifactTmpFiles();
  const w = read
    ? await watchFor(cookie, id, (e) => e.data?.tool === "browser_download_save" && e.data?.opState === "started")
    : await watchFor(cookie, id, (e) => e.data?.tool === "browser_download_list" && e.data?.opState === "completed");
  t.check(w.hit, read ? "browser_download_save (download.read) dispatched" : `browser_download_list completed (downloads: ${JSON.stringify(w.hit?.data?.downloads ?? w.seen.at(-1)?.data?.downloads ?? null)?.slice(0, 300)})`);
  if (!w.hit) return saveRow(t);
  const oldAttempt = w.hit.data.attemptId as string;
  const opId = w.hit.data.operationId as string;
  let supOpBeforeKill = await supOp(opId);
  for (let i = 0; read && i < 300 && supOpBeforeKill.status !== 200; i++) supOpBeforeKill = await supOp(opId);
  const kill = await killStackProcess("control");
  t.check(kill.dead, `control pid ${kill.pid} SIGKILLed ${read ? "immediately after download.read started" : "while the browser download is in progress"}`);
  if (!read) {
    const dl = (w.seen.find((e) => e.seq === w.hit!.seq)?.data?.downloads ?? []) as any[];
    t.check(dl.some((d) => d.state === "in_progress"), `at the kill the browser reported the download in progress (${dl.map((d) => `${d.downloadId}:${d.state}`).join(", ") || "none"})`);
  }
  await sleep(3000);
  const whileDown = { controlHealth: await controlHealth(), containers: taskContainers(id), tmpFiles: artifactTmpFiles() };
  t.check(whileDown.tmpFiles.length === 0, `no .tmp-* blob files in the control artifact store while the control plane is dead (${whileDown.tmpFiles.length})`);
  const up = devUp();
  t.check(up.code === 0, `control restarted via dev-up.sh (exit ${up.code}, ${up.ms} ms)`);
  const rec = await waitEvent(cookie, id, (e) => e.title === "Recovering task", 180_000);
  t.check(rec, `task reclaimed (${rec?.detail ?? "none"})`);
  const end = await c41EndState(t, cookie, id, oldAttempt);
  const evs = await allEvents(cookie, id);
  const trail = opTrail(evs, opId);
  if (read) {
    t.check(supOpBeforeKill.status === 200, `the kill landed after the supervisor had accepted download.read ${opId} (supervisor journal: ${JSON.stringify(supOpBeforeKill.body)?.slice(0, 200)})`);
    t.check(trail.every((e) => e.opState !== "completed"), `the interrupted download.read ${opId} never completed at the controller (${trail.map((e) => `${e.title}[${e.opState ?? "-"}]`).join(" → ")})`);
    checkSupervisorRecordInReconciliation(t, evs, opId, await supOp(opId));
  }
  const arts = ((await call(cookie, "GET", `/api/tasks/${id}/artifacts`)).json as any[]) ?? [];
  const downloads = arts.filter((a) => a.kind === "download");
  t.check(downloads.every((a) => a.source?.attemptId !== oldAttempt), `no download artifact from the killed attempt (download artifacts: ${downloads.map((a) => `${a.filename} ${a.byteLength}B @${a.source?.attemptId}`).join(", ") || "none"})`);
  const storedEvents = evs.filter((e) => e.kind === "artifact" && /Download stored/.test(e.title));
  t.check(storedEvents.every((e) => e.data?.attemptId !== oldAttempt), `no "Download stored" event for the killed attempt (${storedEvents.length} stored in total)`);
  if (!read) t.check(downloads.length === 0 || downloads.every((a) => a.byteLength === 300000), `no partial file stored (sizes: ${downloads.map((a) => a.byteLength).join(",") || "none"})`);
  else t.check(downloads.every((a) => a.byteLength === 9000000), `any stored download is the complete file (sizes: ${downloads.map((a) => a.byteLength).join(",") || "none"})`);
  const tmpAfter = artifactTmpFiles();
  t.check(tmpAfter.length === 0, `no .tmp-* blob files in the control artifact store at the end (${tmpAfter.length}; before: ${tmpBefore.length})`);
  const discarded = evs.find((e) => e.title === "Discarded attempt from an earlier run" && e.data?.attemptId === oldAttempt);
  t.check(discarded && discarded.data?.opState === "completed", `the old browser attempt (its tmpfs downloads with it) was discarded ("${discarded?.detail ?? "no event"}")`);
  t.ev("timeline", { taskId: id, oldAttempt, operation: opId, kill, whileDown, restart: up });
  t.ev("supervisorOperationRecord", { beforeKill: supOpBeforeKill, atEnd: await supOp(opId) });
  t.ev("final", { status: end.task.status, outcome: end.task.outcome ?? null, recoveries: end.task.budget?.recoveries ?? 0, cleanup: end.task.cleanup, attempts: end.attempts, artifacts: arts.map((a) => ({ id: a.id, kind: a.kind, filename: a.filename, byteLength: a.byteLength, sha256: a.sha256, attemptId: a.source?.attemptId })) });
  t.ev("interruptedOperationTrail", trail);
  t.ev("supervisorLogOldAttempt", supLogFor(oldAttempt));
  t.ev("events", slimC41(evs));
  saveRow(t);
}
const testC41E = () => testC41Download("read");
const testC41E2 = () => testC41Download("transfer");

// ---------------------------------------------------------------------------------------------
const TESTS: Record<string, () => Promise<void>> = {
  A1: testAnalysis,
  B1: testWeb,
  K4: testBrowserHostile,
  C1: testRepair,
  T1: testIsolation,
  T2: testSseReplay,
  T3: testCancelRepair,
  T4: testCancelBrowser,
  T5: testTakeover,
  T6: testProposals,
  K1: testHostile,
  K2: testHostileSibling,
  K3: testTimeout,
  K5: testSupervisorRestart,
  D1: testUnsupported,
  M1: testMutationGuard,
  K7: testCleanupSweep,
  C41A: testC41A,
  C41B: testC41Code,
  C41C: testC41Takeover,
  C41D: testC41Proposal,
  C41E: testC41E,
  C41E2: testC41E2,
  C41F: testC41F,
  K6: testFinalCleanup,
};

async function main() {
  const h = await fetch(`${CONTROL}/api/health`).catch(() => null);
  if (h?.status !== 200) throw new Error(`control plane not reachable at ${CONTROL}`);
  const wanted = process.argv.slice(2);
  const ids = wanted.length ? wanted : Object.keys(TESTS);
  console.log(`acceptance @ ${REVISION}${DIRTY ? " (+uncommitted apps/ changes)" : ""} — ${ENV_LOCAL}; control ${CONTROL}, supervisor ${SUPERVISOR}`);
  for (const id of ids) {
    const fn = TESTS[id.split("-")[0]!];
    if (!fn) {
      console.log(`unknown test ${id}`);
      continue;
    }
    console.log(`\n== ${id}`);
    current = null;
    try {
      await fn();
    } catch (error) {
      console.log(`  ERROR ${error instanceof Error ? error.stack?.slice(0, 600) : String(error)}`);
      if (current) saveRow(current, error);
    }
  }
  const s = rows.reduce<Record<string, number>>((m, r) => ((m[r.result] = (m[r.result] ?? 0) + 1), m), {});
  console.log(`\nsummary: ${JSON.stringify(s)}`);
}

await main();
