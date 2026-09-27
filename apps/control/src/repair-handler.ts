/**
 * RepairHandler: the TaskHandler that runs one repair task through the deterministic phases
 * `prepare → reproduce → baseline → repair → freeze → verify → ready` around ONE model loop.
 *
 * Authority (CLAUDE.md §3): the controller owns identities, phases and budgets; the supervisor owns
 * execution; `compare()` owns the verdict; the artifact store owns bytes and digests. The model owns
 * none of these: `submit_candidate` only advances to freeze, and the outcome is set exclusively from
 * compare() results and budget/deadline logic in this file.
 *
 * The guard/checkpoint/tool-error-feedback pattern follows OpenMuse `apps/server/src/engine/model.ts`
 * (MIT, 205cc386b75aae1a862f3fdd43104b570c8d0911) in spirit; no code is copied from it because its
 * tool inventory, AG-UI runtime and model-owned finish semantics are exactly what Airlock replaces.
 */
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ModelToolCall,
  candidateDigestOf,
  sha256,
  type AdapterRequest,
  type AttemptRef,
  type AttemptState,
  type CandidateBundle,
  type CaseContract,
  type CollectedFile,
  type FileEnvelope,
  type HostCheck,
  type InvokeResult,
  type Outcome,
  type ProfileManifest,
  type SourceManifest,
  type Task,
  type VerificationRecord,
} from "@airlock/contracts";
import type { LoadedProfile } from "./profiles.ts";
import { MODEL_TOOLS, systemPrompt, taskMessage, type ToolSpec } from "./prompts.ts";
import type { Store } from "./store/index.ts";
import { SupervisorFenceError, SupervisorNotFoundError, type SupervisorClient } from "./supervisor-client.ts";
import { LostLeaseError, TeardownIncompleteError, type TaskContext, type TaskHandler } from "./worker/index.ts";

// --- Structural types matching apps/control/src/vultr-client.ts, verifier/index.ts, artifacts/index.ts ---

export type ChatMessage = {
  role: "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  toolCalls?: { id: string; name: string; args: unknown }[];
};
export interface ModelDriver {
  chat(input: { system: string; messages: ChatMessage[]; tools: ToolSpec[]; signal?: AbortSignal; maxTokens?: number }): Promise<{
    text: string;
    toolCalls: { id: string; name: string; args: unknown }[];
    usage: { input: number; output: number };
  }>;
  /** Identity recorded on every model event (model name, serving host). */
  describe?(): { model: string; host: string };
}
export type CompareFn = (input: {
  id: string;
  taskId: string;
  role: "baseline" | "candidate";
  contract: CaseContract;
  invoke: InvokeResult;
  host: HostCheck;
  adapterDigest: string;
  contractDigest: string;
  candidateDigest: string;
  now: string;
}) => VerificationRecord;
export type ValidateEnvelopeFn = (
  envelope: FileEnvelope,
  profile: ProfileManifest,
) => { ok: true; files: CollectedFile[] } | { ok: false; reasons: string[] };
export type BuildManifestFn = (profile: ProfileManifest, files: CollectedFile[]) => SourceManifest;
export interface ArtifactStoreLike {
  putBlob(bytes: Uint8Array): Promise<string>;
  getBlob(sha256: string): Promise<Uint8Array | null>;
  putImmutableJson(kind: string, id: string, value: unknown): Promise<boolean>;
  getJson<T>(kind: string, id: string): Promise<T | null>;
}

/** A driver instance, or a factory called once per task run (scripted drivers are stateful). */
export type DriverSource = ModelDriver | ((task: Task) => ModelDriver | Promise<ModelDriver>);

export interface RepairDeps {
  profiles: Map<string, LoadedProfile>;
  supervisor: SupervisorClient;
  driver: DriverSource;
  artifacts: ArtifactStoreLike;
  store: Store;
  compare: CompareFn;
  validateEnvelope: ValidateEnvelopeFn;
  buildManifest: BuildManifestFn;
  /** Directory containing adapter.py (runtime/python). */
  runtimeDir: string;
  now?: () => number;
  /** Max tokens per model turn. */
  maxTokens?: number;
}

export const STORE_KIND_VERIFICATIONS = "verifications";
export const STORE_KIND_MANIFESTS = "manifests";
export const ARTIFACT_KIND_BUNDLE = "bundle";

const DETAIL_CAP = 16 * 1024;
const TOOL_RESULT_CAP = 24 * 1024;
const MAX_TEXT_ONLY_TURNS = 2;
const MAX_CONSECUTIVE_DRIVER_ERRORS = 3;

class AttemptLostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttemptLostError";
  }
}

export function createRepairHandler(deps: RepairDeps): TaskHandler {
  const now = () => deps.now?.() ?? Date.now();
  const iso = () => new Date(now()).toISOString();
  const newId = (prefix: string) => `${prefix}-${randomBytes(10).toString("hex")}`;
  const bounded = (text: string, cap = DETAIL_CAP) => (text.length > cap ? `${text.slice(0, cap)}\n…[truncated ${text.length - cap} chars]` : text);

  /**
   * Best-effort teardown of an attempt: revoke then destroy. Unknown attempts count as gone.
   * Teardown runs twice on cancellation (the aborted run's failure path, then the worker's cancel
   * pass): the supervisor fences the repeat with 409 because the identity is tombstoned. That is
   * only "clean" when the supervisor's own journal says the attempt is `destroyed` (which it sets
   * only after a clean teardown); any other fenced state stays visible as incomplete.
   */
  async function teardown(ref: AttemptRef): Promise<{ clean: boolean; detail: string; data?: Record<string, unknown> }> {
    const confirmedDestroyed = async (): Promise<boolean> => {
      try {
        const state = await deps.supervisor.getAttempt(ref.attemptId);
        return state.ref.taskId === ref.taskId && state.status === "destroyed";
      } catch (error) {
        return error instanceof SupervisorNotFoundError;
      }
    };
    let revoked = "revoked";
    try {
      await deps.supervisor.revoke({ ref });
    } catch (error) {
      if (error instanceof SupervisorNotFoundError) return { clean: true, detail: "attempt unknown to supervisor (already destroyed)" };
      if (error instanceof SupervisorFenceError && (await confirmedDestroyed())) return { clean: true, detail: "attempt already destroyed (supervisor journal status: destroyed)" };
      revoked = `revoke failed: ${errorMessage(error)}`;
    }
    try {
      const result = await deps.supervisor.destroy({ ref });
      return {
        clean: result.teardown.clean,
        detail: `${revoked}; destroyed; remaining containers=${result.teardown.containersRemaining.length} volumes=${result.teardown.volumesRemaining.length}`,
        data: { teardown: result.teardown },
      };
    } catch (error) {
      if (error instanceof SupervisorNotFoundError) return { clean: true, detail: `${revoked}; attempt unknown to supervisor (already destroyed)` };
      if (error instanceof SupervisorFenceError && (await confirmedDestroyed())) return { clean: true, detail: `${revoked}; attempt already destroyed (supervisor journal status: destroyed)` };
      return { clean: false, detail: `${revoked}; destroy failed: ${errorMessage(error)}` };
    }
  }

  return async (owner, initial, ctx) => {
    if (ctx.mode === "cancel") return runCancel(initial, ctx);
    return runRepair(owner, initial, ctx);
  };

  async function runCancel(task: Task, ctx: TaskContext): Promise<Partial<Task>> {
    if (task.attemptId) {
      const ref: AttemptRef = { taskId: task.id, attemptId: task.attemptId, generation: task.generation };
      const result = await teardown(ref);
      await ctx.event("lifecycle", result.clean ? "Attempt destroyed after cancellation" : "Teardown incomplete after cancellation", result.detail, result.data);
      if (!result.clean) throw new TeardownIncompleteError(`Cancellation requested, but teardown of attempt ${task.attemptId} is incomplete: ${result.detail}`);
    }
    await ctx.event("lifecycle", "Task cancelled");
    return { status: "cancelled", error: undefined } as Partial<Task>;
  }

  async function runRepair(owner: string, initial: Task, ctx: TaskContext): Promise<Partial<Task>> {
    let task = initial;
    let liveAttempt: AttemptRef | null = null;
    const checkpoint = async (patch: Partial<Task>) => {
      task = await ctx.checkpoint(patch);
      return task;
    };
    const finish = async (outcome: Outcome, why: string): Promise<Partial<Task>> => {
      await ctx.event("phase", `Outcome ${outcome}`, why);
      await checkpoint({ phase: "ready", outcome });
      return { status: "done", phase: "ready", outcome };
    };
    const destroyLive = async (reason: string) => {
      if (!liveAttempt) return;
      const ref = liveAttempt;
      liveAttempt = null;
      const result = await teardown(ref);
      await ctx.event("lifecycle", result.clean ? `Attempt destroyed (${reason})` : `Teardown incomplete (${reason})`, result.detail, result.data).catch(() => undefined);
      if (!result.clean) throw new Error(`Teardown of attempt ${ref.attemptId} incomplete: ${result.detail}`);
    };

    try {
      if (task.phase === "ready" && task.outcome) return { status: "done" };

      // ---- prepare -------------------------------------------------------------------------
      const profile = deps.profiles.get(task.profileId);
      if (!profile) throw new Error(`Profile "${task.profileId}" is not loaded; unsupported or misconfigured`);
      const { manifest, contract, contractDigest } = profile;
      const adapterDigest = await computeAdapterDigest(deps.runtimeDir, profile);
      const host = await deps.supervisor.host(ctx.signal);
      await checkpoint({ phase: "prepare" });
      await ctx.event("phase", "prepare", `profile ${manifest.id} @ ${manifest.baselineCommit}; ${contract.cases.length} contract cases`, {
        contractDigest,
        adapterDigest,
        runtimeImage: manifest.runtimeImage,
        selectedRuntime: host.selectedRuntime,
        devUnsafe: host.devUnsafe,
        host,
      });
      if (host.devUnsafe) await ctx.event("check", "dev-unsafe runtime", `supervisor host runs ${host.selectedRuntime} with AIRLOCK_DEV_UNSAFE; results are not a deployment measurement`);

      // A previous claim of this task may have left an attempt behind (restart, lost lease):
      // discard it. A sealed candidate can be continued from verify.
      if (task.attemptId) {
        const stale: AttemptRef = { taskId: task.id, attemptId: task.attemptId, generation: task.generation };
        const result = await teardown(stale);
        await ctx.event("lifecycle", "Discarded attempt from an earlier run", result.detail, result.data);
        if (!result.clean) throw new Error(`Previous attempt ${stale.attemptId} could not be torn down: ${result.detail}`);
        await checkpoint({ attemptId: undefined } as Partial<Task>);
      }
      if (task.candidateDigest && (task.phase === "freeze" || task.phase === "verify")) {
        const bundle = await deps.artifacts.getJson<CandidateBundle>(ARTIFACT_KIND_BUNDLE, task.candidateDigest);
        if (bundle) {
          await ctx.event("info", "Resuming from sealed candidate", task.candidateDigest);
          return verifyAndFinish(bundle);
        }
        await ctx.event("error", "Sealed candidate bundle missing; starting a fresh attempt", task.candidateDigest);
        await checkpoint({ candidateDigest: undefined } as Partial<Task>);
      }

      // ---- reproduce: create the author sandbox --------------------------------------------
      if (task.budget.repairAttemptsUsed >= manifest.caps.maxRepairAttempts)
        return finish("STOPPED_LIMIT", `repair attempts exhausted (${task.budget.repairAttemptsUsed}/${manifest.caps.maxRepairAttempts})`);
      const generation = task.generation + 1;
      const attemptId = newId("att");
      const ref: AttemptRef = { taskId: task.id, attemptId, generation };
      const attemptStartedAt = now();
      const attemptDeadline = new Date(attemptStartedAt + manifest.caps.attemptTimeoutMs).toISOString();
      await checkpoint({
        phase: "reproduce",
        attemptId,
        generation,
        budget: { ...task.budget, repairAttemptsUsed: task.budget.repairAttemptsUsed + 1 },
      });
      await ctx.event("phase", "reproduce", `creating author sandbox (attempt ${attemptId}, generation ${generation}, deadline ${attemptDeadline})`);
      let attempt: AttemptState;
      try {
        attempt = await deps.supervisor.createAttempt({ ref, profileId: manifest.id, role: "author", absoluteDeadline: attemptDeadline }, { signal: ctx.signal });
      } catch (error) {
        if (error instanceof SupervisorFenceError) {
          await ctx.event("error", "Sandbox refused by supervisor", errorMessage(error));
          throw new Error(`Author sandbox refused: ${errorMessage(error)}`);
        }
        throw error;
      }
      liveAttempt = ref;
      await ctx.event("lifecycle", "Author sandbox created", `container ${attempt.container}; runtime ${attempt.inspection?.runtime ?? "unknown"}; probe ${attempt.probe?.allBlocked ? "all BLOCKED" : "NOT fully blocked"}`, {
        container: attempt.container,
        inspection: attempt.inspection,
        probe: attempt.probe,
      });
      if (!attempt.inspection?.allPassed) {
        await destroyLive("inspection failed");
        throw new Error("Author sandbox inspection did not pass; refusing to run agent work");
      }
      if (!attempt.probe?.allBlocked) {
        await destroyLive("isolation probe not blocked");
        throw new Error("Author sandbox isolation probe was not fully BLOCKED; refusing to run agent work");
      }
      await ctx.event("check", "Isolation checkpoints", `runtime ${attempt.inspection.runtime}${attempt.inspection.devUnsafe ? " (dev-unsafe)" : ""}; guest ${bounded(attempt.inspection.guestUname, 200)}; hostname ${bounded(attempt.inspection.guestHostname, 100)}; probe all BLOCKED`, {
        runtime: attempt.inspection.runtime,
        devUnsafe: attempt.inspection.devUnsafe,
        guestUname: attempt.inspection.guestUname,
        guestHostname: attempt.inspection.guestHostname,
        probe: attempt.probe,
      });

      // ---- baseline: measure the pristine tree externally ----------------------------------
      await checkpoint({ phase: "baseline" });
      await ctx.event("phase", "baseline", `invoking ${contract.cases.length} cases against the pristine tree`);
      const baselineManifest: SourceManifest = {
        schemaVersion: 1,
        profileId: manifest.id,
        baselineCommit: manifest.baselineCommit,
        baselineTreeDigest: manifest.baselineTreeDigest,
        replacements: [],
      };
      const baselineDigest = await candidateDigestOf(baselineManifest);
      const baselineInvoke = await invokeCases("baseline", undefined);
      const baselineRecord = deps.compare({
        id: newId("ver"),
        taskId: task.id,
        role: "baseline",
        contract,
        invoke: baselineInvoke,
        host,
        adapterDigest,
        contractDigest,
        candidateDigest: baselineDigest,
        now: iso(),
      });
      await deps.store.insertImmutable(owner, STORE_KIND_VERIFICATIONS, baselineRecord);
      await checkpoint({ baselineRecordId: baselineRecord.id });
      await ctx.event("check", baselineRecord.passed ? "Baseline reproduces the reported failure" : "Baseline does not show the reported failure", summarizeRecord(baselineRecord), {
        recordId: baselineRecord.id,
        passed: baselineRecord.passed,
        completedCases: baselineRecord.completedCases,
        requiredCases: baselineRecord.requiredCases,
      });
      if (!baselineRecord.passed) {
        await destroyLive("baseline not reproduced");
        const reported = baselineRecord.cases.filter((c) => c.kind === "reported");
        const measured = reported.length > 0 && reported.every((c) => c.observed !== undefined) && baselineInvoke.exec.status === "succeeded" && baselineInvoke.protocolErrors.length === 0;
        return measured
          ? finish("NOT_REPRODUCED", `the pristine tree did not show the reported failure: ${reported.map((c) => c.reason).join("; ").slice(0, 1000)}`)
          : finish("INCONCLUSIVE", `baseline measurement incomplete (exec ${baselineInvoke.exec.status}, ${baselineInvoke.protocolErrors.length} protocol errors, ${baselineRecord.completedCases}/${baselineRecord.requiredCases} cases)`);
      }

      // ---- repair: the model loop -----------------------------------------------------------
      await checkpoint({ phase: "repair" });
      await ctx.event("phase", "repair", "model loop started");
      const loop = await modelLoop(ref, attemptStartedAt + manifest.caps.attemptTimeoutMs);
      if (loop.end !== "submitted") {
        await destroyLive(loop.end);
        if (loop.end === "budget" || loop.end === "deadline") return finish("STOPPED_LIMIT", loop.reason);
        return finish("REPRODUCED_UNRESOLVED", loop.reason);
      }

      // ---- freeze: seal the candidate -------------------------------------------------------
      await checkpoint({ phase: "freeze" });
      await ctx.event("phase", "freeze", "revoking dispatch, stopping the author sandbox and collecting allowed files");
      const frozen = await deps.supervisor.freeze({ ref }, { signal: ctx.signal });
      await ctx.event("lifecycle", "Author sandbox frozen", `stopConfirmed=${frozen.stopConfirmed} settled=${frozen.outstandingOperationsSettled} files=${frozen.envelope.files.length} rejected=${frozen.envelope.rejected.length}`, {
        stoppedAt: frozen.stoppedAt,
        stopConfirmed: frozen.stopConfirmed,
        outstandingOperationsSettled: frozen.outstandingOperationsSettled,
        rejected: frozen.envelope.rejected.slice(0, 50),
      });
      if (!frozen.stopConfirmed || !frozen.outstandingOperationsSettled) {
        await destroyLive("freeze unconfirmed");
        return finish("INCONCLUSIVE", "the supervisor could not confirm that the author sandbox stopped before collection; the collected bytes are not trusted");
      }
      const validated = deps.validateEnvelope(frozen.envelope, manifest);
      if (!validated.ok) {
        await ctx.event("error", "Collected files rejected", validated.reasons.join("\n").slice(0, DETAIL_CAP), { reasons: validated.reasons.slice(0, 50) });
        await destroyLive("envelope rejected");
        return finish("CHECKS_FAILED", `collected candidate rejected: ${validated.reasons.join("; ").slice(0, 1000)}`);
      }
      const sourceManifest = deps.buildManifest(manifest, validated.files);
      const candidateDigest = await candidateDigestOf(sourceManifest);
      for (const file of validated.files) {
        const bytes = Buffer.from(file.contentBase64, "base64");
        const stored = await deps.artifacts.putBlob(bytes);
        if (stored !== file.sha256) throw new Error(`blob digest mismatch for ${file.path}: collected ${file.sha256}, stored ${stored}`);
      }
      const bundle: CandidateBundle = { manifest: sourceManifest, candidateDigest, files: validated.files };
      await deps.artifacts.putImmutableJson(ARTIFACT_KIND_BUNDLE, candidateDigest, bundle);
      await deps.store.insertImmutable(owner, STORE_KIND_MANIFESTS, { id: candidateDigest, taskId: task.id, manifest: sourceManifest, createdAt: iso() });
      await checkpoint({ candidateDigest });
      await ctx.event("artifact", "Candidate sealed", `candidateDigest ${candidateDigest}; ${sourceManifest.replacements.length} replacement file(s)`, {
        candidateDigest,
        replacements: sourceManifest.replacements,
      });
      await destroyLive("sealed");

      // ---- verify → ready -----------------------------------------------------------------------
      return verifyAndFinish(bundle);

      // ======================================================================================
      async function verifyAndFinish(bundle: CandidateBundle): Promise<Partial<Task>> {
        await checkpoint({ phase: "verify" });
        await ctx.event("phase", "verify", `invoking ${contract.cases.length} cases against sealed candidate ${bundle.candidateDigest}`);
        const invoke = await invokeCases("candidate", bundle);
        const record = deps.compare({
          id: newId("ver"),
          taskId: task.id,
          role: "candidate",
          contract,
          invoke,
          host,
          adapterDigest,
          contractDigest,
          candidateDigest: bundle.candidateDigest,
          now: iso(),
        });
        const inserted = await deps.store.insertImmutable(owner, STORE_KIND_VERIFICATIONS, record);
        if (!inserted) throw new Error(`verification record ${record.id} already exists`);
        await checkpoint({ verificationRecordId: record.id });
        await ctx.event("check", record.passed ? "Candidate passed these checks" : "Candidate failed checks", summarizeRecord(record), {
          recordId: record.id,
          passed: record.passed,
          completedCases: record.completedCases,
          requiredCases: record.requiredCases,
          teardown: invoke.teardown,
        });
        return finish(record.passed ? "CANDIDATE_PASSED_CHECKS" : "CHECKS_FAILED", record.passed ? `all ${record.requiredCases} frozen cases passed` : summarizeRecord(record));
      }

      async function invokeCases(role: "baseline" | "candidate", bundle: CandidateBundle | undefined): Promise<InvokeResult> {
        await ctx.guard();
        const request: AdapterRequest = { schemaVersion: 1, cases: contract.cases.map((c) => ({ id: c.id, input: c.input })) };
        const budgetMs = Math.min(manifest.caps.attemptTimeoutMs, manifest.caps.commandTimeoutMs * (contract.cases.length + 2));
        const result = await deps.supervisor.invoke(
          { taskId: task.id, profileId: manifest.id, role, ...(bundle ? { bundle } : {}), request, absoluteDeadline: new Date(now() + budgetMs).toISOString() },
          { signal: ctx.signal, timeoutMs: budgetMs + 30_000 },
        );
        await ctx.event("exec", `${role} invocation ${result.exec.status}`, `exit=${result.exec.exitCode} ${result.exec.durationMs}ms observations=${result.observations.length} protocolErrors=${result.protocolErrors.length}${result.exec.stderr ? `\nstderr:\n${bounded(result.exec.stderr, 4096)}` : ""}`, {
          tool: role,
          command: "/opt/airlock/materialize.py; /opt/airlock/adapter.py --request /workspace/request.json",
          result: boundedExec(result.exec),
          inspection: result.inspection,
          container: result.container,
          runtime: result.inspection.runtime,
          devUnsafe: result.inspection.devUnsafe,
          guestUname: result.inspection.guestUname,
          exitCode: result.exec.exitCode,
          status: result.exec.status,
          protocolErrors: result.protocolErrors.slice(0, 20),
          teardown: result.teardown,
        });
        return result;
      }

      async function modelLoop(attemptRef: AttemptRef, deadlineMs: number): Promise<{ end: "submitted" | "budget" | "deadline" | "unresolved"; reason: string }> {
        const driver: ModelDriver = typeof deps.driver === "function" ? await deps.driver(task) : deps.driver;
        const identity = driver.describe?.() ?? { model: "unknown", host: "unknown" };
        const reported = contract.cases.find((c) => c.kind === "reported");
        const system = systemPrompt(manifest);
        const messages: ChatMessage[] = [{ role: "user", content: taskMessage(task.issueText, reported) }];
        let textOnlyTurns = 0;
        let driverErrors = 0;
        for (;;) {
          await ctx.guard();
          if (now() >= deadlineMs) return { end: "deadline", reason: `attempt deadline reached (${manifest.caps.attemptTimeoutMs} ms)` };
          if (task.budget.modelCallsUsed >= manifest.caps.maxModelCalls)
            return { end: "budget", reason: `model call budget exhausted (${task.budget.modelCallsUsed}/${manifest.caps.maxModelCalls})` };
          await checkpoint({ budget: { ...task.budget, modelCallsUsed: task.budget.modelCallsUsed + 1 } });
          let turn: Awaited<ReturnType<ModelDriver["chat"]>>;
          const startedAt = now();
          try {
            turn = await driver.chat({ system, messages, tools: MODEL_TOOLS, signal: ctx.signal, ...(deps.maxTokens ? { maxTokens: deps.maxTokens } : {}) });
            driverErrors = 0;
          } catch (error) {
            if (ctx.signal.aborted) throw new LostLeaseError();
            driverErrors++;
            await ctx.event("error", "Model call failed", bounded(errorMessage(error), 2000), { consecutive: driverErrors, model: identity.model, host: identity.host, durationMs: now() - startedAt, error: true });
            if (driverErrors >= MAX_CONSECUTIVE_DRIVER_ERRORS) throw new Error(`Model driver failed ${driverErrors} times in a row: ${errorMessage(error).slice(0, 300)}`);
            continue;
          }
          const toolCalls = Array.isArray(turn.toolCalls) ? turn.toolCalls.slice(0, 16) : [];
          const text = typeof turn.text === "string" ? turn.text : "";
          await ctx.event("model", `Model turn ${task.budget.modelCallsUsed}`, bounded(text || "(no text)"), {
            model: identity.model,
            host: identity.host,
            durationMs: now() - startedAt,
            toolCalls: toolCalls.map((c) => ({ name: String(c.name).slice(0, 64) })),
            usage: turn.usage,
          });
          messages.push({ role: "assistant", content: text.slice(0, 65536), ...(toolCalls.length ? { toolCalls } : {}) });
          if (toolCalls.length === 0) {
            textOnlyTurns++;
            if (textOnlyTurns > MAX_TEXT_ONLY_TURNS) return { end: "unresolved", reason: "the model ended without submitting a candidate" };
            messages.push({ role: "user", content: "Continue. Use the tools to reproduce and fix the issue, then call submit_candidate; if you cannot fix it, reply with a short explanation and no tool calls." });
            continue;
          }
          textOnlyTurns = 0;
          let submitted = false;
          for (const call of toolCalls) {
            const toolCallId = String(call.id ?? "").slice(0, 128) || newId("call");
            const result: { payload: unknown; submitted?: boolean } = submitted
              ? { payload: { error: "The candidate was already submitted in this turn; no further actions are executed." } }
              : await runTool(attemptRef, call.name, call.args);
            if (result.submitted) submitted = true;
            messages.push({ role: "tool", toolCallId, content: bounded(JSON.stringify(result.payload), TOOL_RESULT_CAP) });
          }
          if (submitted) return { end: "submitted", reason: "submit_candidate" };
        }
      }

      async function runTool(attemptRef: AttemptRef, name: unknown, args: unknown): Promise<{ payload: unknown; submitted?: boolean }> {
        const parsed = ModelToolCall.safeParse({ name, args });
        if (!parsed.success) {
          const reason = `invalid tool call: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ").slice(0, 500)}`;
          await ctx.event("tool", `${String(name).slice(0, 32)} rejected`, reason);
          return { payload: { error: reason } };
        }
        const call = parsed.data;
        await ctx.guard();
        if (now() >= attemptStartedAt + manifest.caps.attemptTimeoutMs) return { payload: { error: "attempt deadline reached" } };
        try {
          switch (call.name) {
            case "read_file": {
              if (!manifest.readablePaths.includes(call.args.path)) {
                await ctx.event("tool", "read_file refused", `${call.args.path} is not a readable path`);
                return { payload: { error: `"${call.args.path}" is not readable. Allowed: ${manifest.readablePaths.join(", ")}` } };
              }
              const result = await deps.supervisor.authorTool({ ref: attemptRef, args: { kind: "read", path: call.args.path } }, { signal: ctx.signal });
              await ctx.event("tool", `read_file ${call.args.path}`, result.kind === "read" ? `${result.content.length} chars${result.truncated ? " (truncated)" : ""}` : describeToolResult(result), {
                tool: "read_file",
                path: call.args.path,
                ...(result.kind === "read" ? { chars: result.content.length, truncated: result.truncated } : { refused: describeToolResult(result) }),
              });
              if (result.kind === "read") return { payload: { path: call.args.path, content: result.content, truncated: result.truncated } };
              return { payload: { error: describeToolResult(result) } };
            }
            case "write_file": {
              if (!manifest.allowedReplacementPaths.includes(call.args.path)) {
                await ctx.event("tool", "write_file refused", `${call.args.path} is not an allowed replacement path`);
                return { payload: { error: `"${call.args.path}" may not be changed. Allowed: ${manifest.allowedReplacementPaths.join(", ")}` } };
              }
              const byteLength = Buffer.byteLength(call.args.content, "utf8");
              if (byteLength > manifest.caps.maxFileBytes) {
                await ctx.event("tool", "write_file refused", `${call.args.path}: ${byteLength} bytes exceeds ${manifest.caps.maxFileBytes}`);
                return { payload: { error: `file exceeds ${manifest.caps.maxFileBytes} bytes` } };
              }
              const result = await deps.supervisor.authorTool({ ref: attemptRef, args: { kind: "write", path: call.args.path, content: call.args.content } }, { signal: ctx.signal });
              await ctx.event("tool", `write_file ${call.args.path}`, result.kind === "write" ? `${result.byteLength} bytes` : describeToolResult(result), {
                tool: "write_file",
                path: call.args.path,
                ...(result.kind === "write" ? { byteLength: result.byteLength } : { refused: describeToolResult(result) }),
              });
              if (result.kind === "write") return { payload: { path: call.args.path, byteLength: result.byteLength } };
              return { payload: { error: describeToolResult(result) } };
            }
            case "run": {
              const result = await deps.supervisor.authorTool({ ref: attemptRef, args: { kind: "exec", command: call.args.command } }, { signal: ctx.signal });
              if (result.kind === "exec") {
                const r = result.result;
                await ctx.event("exec", `run: ${bounded(call.args.command, 200)}`, `${r.status} exit=${r.exitCode} ${r.durationMs}ms${r.truncated ? " (output truncated)" : ""}\nstdout:\n${bounded(r.stdout, 6000)}\nstderr:\n${bounded(r.stderr, 6000)}`, {
                  tool: "run",
                  command: call.args.command,
                  status: r.status,
                  exitCode: r.exitCode,
                  durationMs: r.durationMs,
                  timedOut: r.timedOut,
                  result: boundedExec(r),
                });
                return {
                  payload: {
                    status: r.status,
                    exitCode: r.exitCode,
                    timedOut: r.timedOut,
                    truncated: r.truncated,
                    stdout: r.stdout.slice(0, TOOL_RESULT_CAP / 2),
                    stderr: r.stderr.slice(0, TOOL_RESULT_CAP / 2),
                    note: "advisory only; external verification decides",
                  },
                };
              }
              await ctx.event("tool", "run refused", describeToolResult(result));
              return { payload: { error: describeToolResult(result) } };
            }
            case "submit_candidate": {
              await ctx.event("tool", "submit_candidate", bounded(call.args.summary, 4000));
              return { payload: { accepted: true, note: "The candidate will be frozen and verified externally. No result is reported to you." }, submitted: true };
            }
          }
        } catch (error) {
          if (ctx.signal.aborted) throw new LostLeaseError();
          if (error instanceof SupervisorFenceError) throw new AttemptLostError(`attempt fenced by supervisor: ${errorMessage(error)}`);
          if (error instanceof SupervisorNotFoundError) throw new AttemptLostError(`attempt no longer exists: ${errorMessage(error)}`);
          const message = errorMessage(error);
          await ctx.event("error", `${call.name} failed`, bounded(message, 2000));
          return { payload: { error: message.slice(0, 2000) } };
        }
      }
    } catch (error) {
      // Never leave a sandbox behind, whatever the failure. Cancel path re-runs teardown too.
      if (liveAttempt) {
        const ref = liveAttempt;
        liveAttempt = null;
        const result = await teardown(ref);
        if (!(error instanceof LostLeaseError)) await ctx.event("lifecycle", result.clean ? "Attempt destroyed after failure" : "Teardown incomplete after failure", result.detail, result.data).catch(() => undefined);
        if (!result.clean && !(error instanceof LostLeaseError)) throw new Error(`${errorMessage(error)}; additionally teardown incomplete: ${result.detail}`);
      }
      throw error;
    }
  };
}

/** An ExecResult with stdout/stderr cut to what an event should carry (the tool result keeps more). */
function boundedExec(r: { status: string; exitCode: number | null; stdout: string; stderr: string; truncated: boolean; timedOut: boolean; durationMs: number }) {
  const cap = 8 * 1024;
  return {
    status: r.status,
    exitCode: r.exitCode,
    stdout: r.stdout.length > cap ? r.stdout.slice(0, cap) : r.stdout,
    stderr: r.stderr.length > cap ? r.stderr.slice(0, cap) : r.stderr,
    truncated: r.truncated || r.stdout.length > cap || r.stderr.length > cap,
    timedOut: r.timedOut,
    durationMs: r.durationMs,
  };
}

/** sha256(adapter.py bytes ++ profile adapter module bytes). */
export async function computeAdapterDigest(runtimeDir: string, profile: LoadedProfile): Promise<string> {
  const adapterPath = join(runtimeDir, "adapter.py");
  const modulePath = join(profile.dir, `${profile.manifest.adapterModule}.py`);
  let adapter: Uint8Array;
  let module: Uint8Array;
  try {
    adapter = await readFile(adapterPath);
  } catch {
    throw new Error(`runtime adapter missing at ${adapterPath}`);
  }
  try {
    module = await readFile(modulePath);
  } catch {
    throw new Error(`profile adapter module missing at ${modulePath}`);
  }
  const joined = new Uint8Array(adapter.byteLength + module.byteLength);
  joined.set(adapter, 0);
  joined.set(module, adapter.byteLength);
  return sha256(joined);
}

function summarizeRecord(record: VerificationRecord): string {
  const failed = record.cases.filter((c) => !c.passed);
  const head = `${record.completedCases}/${record.requiredCases} cases completed; ${record.cases.length - failed.length} passed, ${failed.length} failed; exec ${record.exec.status}`;
  if (!failed.length) return head;
  return `${head}\n${failed.map((c) => `- ${c.caseId} (${c.kind}): ${c.reason}`).join("\n")}`.slice(0, DETAIL_CAP);
}

function describeToolResult(result: { kind: string; reason?: string }): string {
  return result.kind === "refused" ? `refused: ${result.reason ?? "no reason"}` : `unexpected result kind ${result.kind}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
