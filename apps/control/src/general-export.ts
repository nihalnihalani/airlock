/**
 * Evidence bundle for a general task (C37, 40 §6): sealed once from immutable inputs (the terminal
 * task record, its immutable artifacts and its append-only events) and served byte for byte.
 *
 * Contents: task.json (profile id/version, tools, checks, budgets, input digests), result.json (the
 * controller's completion checks and outcome, clearly labelled when partial), outputs/, code/,
 * screenshots/ + screenshots.json (sha256, source URL, step), page-text/ (browser_save_text),
 * events.jsonl (ordered tool observations), identity.json (model/host per turn, tool inventory,
 * sandbox runtimes), egress.json (proxy decisions per browser attempt), cleanup.json (teardown
 * receipts and the cleanup state), manifest.json (sha256 of every file) and README.txt.
 *
 * These are auditable execution records, not proof against a compromised supervisor and not a
 * guarantee that the answer is correct.
 */
import { createHash } from "node:crypto";
import { compareCodePoints, type Artifact, type RunEvent, type Task } from "@airlock/contracts";
import { publicTaskProfile, type TaskProfile } from "./task-profiles.ts";

/** Local seal/grant records for general exports (the contract ExportSeal/ExportGrant are candidate-bound). */
export interface GeneralExportSeal {
  schemaVersion: 1;
  id: string;
  taskId: string;
  outcome: "RESULT_VERIFIED" | "RESULT_PARTIAL";
  /** sha256 of the canonical TaskResult the bundle was sealed from. */
  resultDigest: string;
  zipDigest: string;
  byteLength: number;
  eventsThroughSeq: number;
  sealedAt: string;
}
export interface GeneralExportGrant {
  id: string;
  owner: string;
  taskId: string;
  sealId: string;
  resultDigest: string;
  zipDigest: string;
  outcome: GeneralExportSeal["outcome"];
  createdAt: string;
  expiresAt: string;
}

export interface GeneralBundleInput {
  task: Task;
  profile: TaskProfile;
  inputs: Artifact[];
  artifacts: { artifact: Artifact; bytes: Uint8Array }[];
  codeFiles: { path: string; bytes: Uint8Array }[];
  events: RunEvent[];
}

const enc = new TextEncoder();
const json = (v: unknown) => enc.encode(`${JSON.stringify(v, null, 2)}\n`);
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const safeSegment = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^[._]+/, "").slice(0, 120) || "file";
const safePath = (p: string) =>
  p
    .split("/")
    .filter((seg) => seg && seg !== "." && seg !== "..")
    .map(safeSegment)
    .join("/") || "file";

export function buildGeneralBundle(input: GeneralBundleInput): { files: { path: string; bytes: Uint8Array }[] } {
  const { task, profile, events } = input;
  const files: { path: string; bytes: Uint8Array }[] = [];
  const { leaseId: _l, leaseUntil: _u, ...record } = task;
  const partial = task.outcome === "RESULT_PARTIAL";

  files.push({
    path: "task.json",
    bytes: json({
      task: record,
      profile: publicTaskProfile(profile),
      inputs: input.inputs.map((a) => ({ artifactId: a.id, filename: a.filename, mediaType: a.mediaType, byteLength: a.byteLength, sha256: a.sha256 })),
    }),
  });
  files.push({ path: "result.json", bytes: json({ outcome: task.outcome, label: partial ? "PARTIAL: some completion checks failed; see checks" : "VERIFIED: every completion check of the profile passed", cleanup: task.cleanup ?? null, result: task.result ?? null }) });

  // Output paths as collected (from the "Output stored" events), else the stored filename.
  const outputPath = new Map<string, string>();
  for (const e of events) {
    const d = e.data as { artifactId?: unknown; path?: unknown; kind?: unknown } | undefined;
    if (e.kind === "artifact" && d?.kind === "output" && typeof d.artifactId === "string" && typeof d.path === "string") outputPath.set(d.artifactId, d.path);
  }
  const screenshots: unknown[] = [];
  for (const { artifact, bytes } of input.artifacts) {
    if (artifact.kind === "output") files.push({ path: safePath(outputPath.get(artifact.id) ?? `outputs/${artifact.filename}`), bytes });
    else if (artifact.kind === "screenshot") {
      files.push({ path: `screenshots/${safeSegment(artifact.id)}.png`, bytes });
      screenshots.push({ artifactId: artifact.id, file: `screenshots/${safeSegment(artifact.id)}.png`, sha256: artifact.sha256, byteLength: artifact.byteLength, url: artifact.source?.url ?? null, step: artifact.source?.step ?? null, attemptId: artifact.source?.attemptId ?? null, createdAt: artifact.createdAt });
    } else if (artifact.kind === "download") files.push({ path: `page-text/${safeSegment(artifact.id)}-${safeSegment(artifact.filename)}`, bytes });
  }
  files.push({ path: "screenshots.json", bytes: json(screenshots) });
  for (const f of input.codeFiles) files.push({ path: safePath(f.path.startsWith("code/") ? f.path : `code/${f.path}`), bytes: f.bytes });

  files.push({ path: "events.jsonl", bytes: enc.encode(events.map((e) => JSON.stringify(e)).join("\n") + (events.length ? "\n" : "")) });

  const models = new Map<string, { model: string; host: string; turns: number; imagesAttached: number }>();
  const runtimes = new Map<string, { role: string; runtime: unknown; devUnsafe: unknown; imageDigest: unknown }>();
  const egress: unknown[] = [];
  const receipts: unknown[] = [];
  for (const e of events) {
    const d = (e.data ?? {}) as Record<string, unknown>;
    if (e.kind === "model" && typeof d.model === "string") {
      const key = `${d.model}\n${String(d.host)}`;
      const m = models.get(key) ?? { model: d.model, host: String(d.host), turns: 0, imagesAttached: 0 };
      m.turns += 1;
      if (d.imageAttached === true) m.imagesAttached += 1;
      models.set(key, m);
    }
    if (e.kind === "lifecycle" && typeof d.attemptId === "string") {
      const insp = d.inspection as { runtime?: unknown; devUnsafe?: unknown; imageDigest?: unknown } | undefined;
      if (insp) runtimes.set(d.attemptId, { role: String(d.role ?? ""), runtime: insp.runtime ?? null, devUnsafe: insp.devUnsafe ?? null, imageDigest: insp.imageDigest ?? null });
      if (d.egress !== undefined || d.egressSummary !== undefined) egress.push({ attemptId: d.attemptId, seq: e.seq, egress: d.egress ?? null, egressSummary: d.egressSummary ?? null });
      if (d.teardown !== undefined || /destroyed|teardown/i.test(e.title)) receipts.push({ seq: e.seq, at: e.at, attemptId: d.attemptId, role: d.role ?? null, title: e.title, detail: e.detail, teardown: d.teardown ?? null });
    }
  }
  files.push({ path: "identity.json", bytes: json({ models: [...models.values()], tools: profile.tools, sandboxes: [...runtimes].map(([attemptId, r]) => ({ attemptId, ...r })) }) });
  files.push({ path: "egress.json", bytes: json({ egressAllow: task.egressAllow ?? [], attempts: egress }) });
  files.push({ path: "cleanup.json", bytes: json({ cleanup: task.cleanup ?? null, receipts }) });
  files.push({ path: "README.txt", bytes: enc.encode(readme(task, profile, input, [...models.values()])) });

  // De-duplicate paths deterministically, then list every file's digest.
  const seen = new Map<string, number>();
  for (const f of files) {
    const n = seen.get(f.path) ?? 0;
    seen.set(f.path, n + 1);
    if (n > 0) f.path = `${f.path}.${n}`;
  }
  files.sort((a, b) => compareCodePoints(a.path, b.path));
  files.push({ path: "manifest.json", bytes: json(files.map((f) => ({ path: f.path, byteLength: f.bytes.byteLength, sha256: sha(f.bytes) }))) });
  files.sort((a, b) => compareCodePoints(a.path, b.path));
  return { files };
}

function readme(task: Task, profile: TaskProfile, input: GeneralBundleInput, models: { model: string; host: string }[]): string {
  const checks = task.result?.checks ?? [];
  const partial = task.outcome === "RESULT_PARTIAL";
  return [
    `Airlock evidence bundle for task ${task.id}`,
    "",
    partial ? "*** PARTIAL RESULT: not every completion check passed. Read the checks below before using any output. ***" : "Result: every completion check of the task profile passed (RESULT_VERIFIED).",
    "",
    `Outcome:   ${task.outcome}`,
    `Profile:   ${profile.id} v${profile.version} (${profile.displayName})`,
    `Goal:      ${task.issueText.slice(0, 500).replace(/\s+/g, " ")}`,
    `Cleanup:   ${task.cleanup?.status ?? "unknown"}${task.cleanup?.detail ? ` (${task.cleanup.detail})` : ""}`,
    `Models:    ${models.map((m) => `${m.model} @ ${m.host}`).join(", ") || "none recorded"}`,
    `Inputs:    ${input.inputs.map((a) => `${a.filename} sha256:${a.sha256}`).join(", ") || "none"}`,
    `Allowed destinations: ${(task.egressAllow ?? []).join(", ") || "none"}`,
    "",
    "Completion checks (run by the Airlock controller on collected bytes and the task's own events; the model's claims are not checks):",
    ...checks.map((c) => `  [${c.passed ? "PASS" : "FAIL"}] ${c.name}: ${c.detail}`),
    "",
    "Files: task.json, result.json, outputs/, code/, screenshots/ + screenshots.json, page-text/, events.jsonl (ordered tool observations),",
    "identity.json (model/host, tools, sandbox runtimes), egress.json, cleanup.json (teardown receipts), manifest.json (sha256 of every file).",
    "",
    "What this is: an auditable record of what ran, what it observed and what the controller checked. It is not a proof against a",
    "compromised execution host, and a passed check is structural (files exist and parse, sources were visited) — not a guarantee that",
    "the answer is correct. Screenshots and any image the model saw are evidence, not authority.",
    "",
  ].join("\n");
}
