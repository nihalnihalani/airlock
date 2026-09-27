/**
 * One-shot baseline / candidate / preview invocation.
 *
 * A fresh container per call. The bundle's digests are verified BEFORE anything is created: every
 * file's sha256, byte length, path allowlist, count/size bounds, and candidateDigestOf(manifest).
 * Files reach the container as a tar upload, never through a shell. The fixed materializer and
 * adapter run under the role's caps; adapter stdout is parsed line by line with Observation and
 * every bad line becomes a protocol error. The container is always destroyed and the teardown
 * listing is part of the result.
 */
import {
  type CandidateBundle,
  type InvokeResult,
  Observation,
  type ProfileManifest,
  candidateDigestOf,
  canonicalJson,
  sha256,
} from "@airlock/contracts";
import { SupervisorError } from "./errors";
import { SANDBOX_USER, SUPERVISOR_GRACE_MS, runExec, timedCommand } from "./exec";
import { type OperationResponse, type Supervisor } from "./lifecycle";
import { log } from "./log";
import { oneShotLabels, oneShotNames, ownedFilter } from "./names";
import { ancestorDirs, createTar } from "./tar";
import type { InvokeRequest } from "./types";

export const ADAPTER = "/opt/airlock/adapter.py";
const MAX_CASES = 256;
const MAX_REQUEST_JSON_BYTES = 1_048_576;
/** Per-observation line bound: the Observation schema allows ~78 KiB; leave headroom. */
const OBSERVATION_LINE_BYTES = 96 * 1024;
/** Longest in-container adapter run; below Bun's connection idle timeout. */
const MAX_ADAPTER_SECONDS = 200;

export type VerifiedBundle = { ok: true; files: { path: string; bytes: Uint8Array }[] } | { ok: false; reason: string };

/** Verify transferred bytes against the manifest and the manifest against the digest. Pure. */
export async function verifyBundle(bundle: CandidateBundle, profile: ProfileManifest): Promise<VerifiedBundle> {
  const m = bundle.manifest;
  if (m.profileId !== profile.id) return { ok: false, reason: `manifest.profileId ${m.profileId} is not ${profile.id}` };
  if (m.baselineCommit !== profile.baselineCommit) return { ok: false, reason: "manifest.baselineCommit does not match the profile" };
  if (m.baselineTreeDigest !== profile.baselineTreeDigest) return { ok: false, reason: "manifest.baselineTreeDigest does not match the profile" };
  if (m.replacements.length > profile.caps.maxFiles) return { ok: false, reason: `manifest lists ${m.replacements.length} replacements; the profile allows ${profile.caps.maxFiles}` };
  if (bundle.files.length !== m.replacements.length) return { ok: false, reason: "bundle.files and manifest.replacements differ in count" };

  const expectedDigest = await candidateDigestOf(m);
  if (expectedDigest !== bundle.candidateDigest) return { ok: false, reason: "candidateDigest does not equal SHA256(canonical manifest)" };

  const byPath = new Map<string, { byteLength: number; sha256: string }>();
  for (const r of m.replacements) {
    if (byPath.has(r.path)) return { ok: false, reason: `duplicate replacement path ${r.path}` };
    if (!profile.allowedReplacementPaths.includes(r.path)) return { ok: false, reason: `path ${r.path} is not an allowed replacement path` };
    if (r.byteLength > profile.caps.maxFileBytes) return { ok: false, reason: `${r.path} is ${r.byteLength} bytes; the limit is ${profile.caps.maxFileBytes}` };
    byPath.set(r.path, { byteLength: r.byteLength, sha256: r.sha256 });
  }
  let total = 0;
  const files: { path: string; bytes: Uint8Array }[] = [];
  const seen = new Set<string>();
  for (const f of bundle.files) {
    if (seen.has(f.path)) return { ok: false, reason: `duplicate file ${f.path}` };
    seen.add(f.path);
    const expected = byPath.get(f.path);
    if (!expected) return { ok: false, reason: `file ${f.path} is not in the manifest` };
    if (f.byteLength !== expected.byteLength || f.sha256 !== expected.sha256) return { ok: false, reason: `file ${f.path} does not match its manifest entry` };
    if (f.contentBase64.length > Math.ceil((profile.caps.maxFileBytes * 4) / 3) + 4) return { ok: false, reason: `file ${f.path} base64 payload exceeds the per-file bound` };
    let bytes: Uint8Array;
    try {
      bytes = Uint8Array.from(Buffer.from(f.contentBase64, "base64"));
    } catch {
      return { ok: false, reason: `file ${f.path} is not valid base64` };
    }
    if (bytes.length !== f.byteLength) return { ok: false, reason: `file ${f.path} decodes to ${bytes.length} bytes, not ${f.byteLength}` };
    if ((await sha256(bytes)) !== f.sha256) return { ok: false, reason: `file ${f.path} sha256 does not match its declared digest` };
    total += bytes.length;
    if (total > profile.caps.maxTotalBytes) return { ok: false, reason: `bundle exceeds the total byte bound ${profile.caps.maxTotalBytes}` };
    files.push({ path: f.path, bytes });
  }
  return { ok: true, files };
}

/** Parse adapter stdout: one Observation JSON object per line. Untrusted; bad lines are recorded. */
export function parseObservations(stdout: string, maxObservations: number): { observations: Observation[]; protocolErrors: string[] } {
  const observations: Observation[] = [];
  const protocolErrors: string[] = [];
  const lines = stdout.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? "").trim();
    if (line.length === 0) continue;
    if (line.length > OBSERVATION_LINE_BYTES) {
      protocolErrors.push(`line ${i + 1}: exceeds ${OBSERVATION_LINE_BYTES} bytes`);
      continue;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      protocolErrors.push(`line ${i + 1}: not JSON: ${line.slice(0, 120)}`);
      continue;
    }
    const parsed = Observation.safeParse(raw);
    if (!parsed.success) {
      protocolErrors.push(`line ${i + 1}: not an Observation: ${parsed.error.issues[0]?.message ?? "invalid"}`.slice(0, 512));
      continue;
    }
    if (observations.length >= maxObservations) {
      protocolErrors.push(`line ${i + 1}: more observations than requested cases`);
      continue;
    }
    observations.push(parsed.data);
  }
  return { observations, protocolErrors };
}

export async function invoke(core: Supervisor, body: InvokeRequest): Promise<OperationResponse> {
  // Every body validation runs INSIDE the operation so that a repeat with the same id and digest
  // replays the recorded result even when the deadline it named has since passed.
  return core.withOperation(body.operation, `invoke:${body.role}`, async () => {
    const profile = core.profile(body.profileId);
    if (body.role === "baseline" && body.bundle) throw new SupervisorError("invalid_body", "A baseline invocation takes no bundle: it runs the pristine tree.");
    if (body.role !== "baseline" && !body.bundle) throw new SupervisorError("invalid_body", `A ${body.role} invocation requires a bundle.`);
    if (body.request.cases.length > MAX_CASES) throw new SupervisorError("invalid_body", `At most ${MAX_CASES} cases per invocation.`);
    const requestJson = canonicalJson(body.request);
    if (requestJson.length > MAX_REQUEST_JSON_BYTES) throw new SupervisorError("invalid_body", "The adapter request exceeds 1 MiB.");
    const names = oneShotNames(core.config.namespace, body.taskId, body.operation.operationId, body.role);
    if (!names.ok) throw new SupervisorError("invalid_body", names.reason);
    const deadline = core.boundDeadline(body.absoluteDeadline, profile.caps);

    // Verify everything BEFORE creating anything.
    let files: { path: string; bytes: Uint8Array }[] = [];
    if (body.bundle) {
      const verified = await verifyBundle(body.bundle, profile);
      if (!verified.ok) throw new SupervisorError("bundle_mismatch", `Candidate bundle rejected: ${verified.reason}.`);
      files = verified.files;
    }
    const labels = oneShotLabels(names.value);
    const filter = ownedFilter(core.config.namespace, { taskId: names.value.taskId, attemptId: `op-${names.value.operationId}` });
    core.journal.insertEphemeral({
      container: names.value.container,
      volume: names.value.volume,
      taskId: names.value.taskId,
      operationId: names.value.operationId,
      role: body.role,
      deadline,
      createdAt: new Date().toISOString(),
    });
    try {
      const provisioned = await core.provision({
        container: names.value.container,
        volume: names.value.volume,
        labels,
        profile,
        mount: { target: "/workspace", readOnly: false },
        workingDir: "/workspace",
        createVolume: true,
      });
      // Deliver replacements and the request as a tar upload.
      const entries = [
        ...(files.length > 0 ? ["replacements", ...ancestorDirs(files.map((f) => `replacements/${f.path}`)).filter((d) => d !== "replacements")] : []).map((dir) => ({ path: dir, kind: "dir" as const })),
        ...files.map((f) => ({ path: `replacements/${f.path}`, kind: "file" as const, bytes: f.bytes })),
        { path: "request.json", kind: "file" as const, bytes: new TextEncoder().encode(requestJson) },
      ];
      await core.api.putArchive(names.value.container, createTar(entries), "/workspace");

      const materialized = await core.materialize(names.value.container, profile.caps);
      let exec = materialized.result;
      let observations: Observation[] = [];
      let protocolErrors: string[] = [];
      if (materialized.result.status !== "succeeded") {
        protocolErrors = [`materialize failed (${materialized.result.status}, exit ${materialized.result.exitCode}): ${materialized.result.stderr.slice(0, 400)}`];
      } else {
        const remainingSeconds = Math.max(1, Math.floor((Date.parse(deadline) - Date.now()) / 1000));
        const adapterSeconds = Math.min(remainingSeconds, MAX_ADAPTER_SECONDS, Math.ceil(profile.caps.attemptTimeoutMs / 1000));
        const outputBytes = body.request.cases.length * OBSERVATION_LINE_BYTES + 65_536;
        const run = await runExec(
          core.api,
          names.value.container,
          {
            cmd: timedCommand(["/usr/local/bin/python", ADAPTER, "--request", "/workspace/request.json"], adapterSeconds),
            user: SANDBOX_USER,
            workingDir: "/workspace",
          },
          { timeoutMs: adapterSeconds * 1000 + SUPERVISOR_GRACE_MS, outputBytes },
        );
        exec = run.result;
        const parsed = parseObservations(run.result.stdout, body.request.cases.length);
        observations = parsed.observations;
        protocolErrors = parsed.protocolErrors;
        if (run.result.truncated) protocolErrors.push("adapter output exceeded the capture bound and was truncated");
        if (run.result.status !== "succeeded") protocolErrors.push(`adapter exec ${run.result.status} (exit ${run.result.exitCode})`);
      }
      await core.removeResources(names.value.container, names.value.volume);
      const teardown = await core.teardownRecord(filter);
      log.info("one-shot invocation finished", { operationId: body.operation.operationId, taskId: names.value.taskId, role: body.role, container: names.value.container, cases: body.request.cases.length, replacementFiles: files.length, exec: exec.status, exitCode: exec.exitCode, execMs: exec.durationMs, observations: observations.length, protocolErrors: protocolErrors.length, teardownClean: teardown.clean });
      const result: InvokeResult = {
        operationId: body.operation.operationId,
        role: body.role,
        container: names.value.container,
        inspection: provisioned.inspection,
        exec,
        observations,
        protocolErrors: protocolErrors.map((e) => e.slice(0, 512)),
        teardown,
      };
      return { status: 200, body: result };
    } finally {
      await core.removeResources(names.value.container, names.value.volume);
      core.journal.deleteEphemeral(names.value.container);
    }
  });
}
