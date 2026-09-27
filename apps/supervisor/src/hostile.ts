/**
 * Hostile-input panel: run an arbitrary command in an author-profile sandbox and report the blast
 * radius. The command is data passed to bash inside the container; it never touches a host shell.
 * "Survived" is measured, not asserted: supervisor health, a host sentinel file's hash, other
 * attempts still running (each one inspected before and after the command), host uptime. "Files
 * destroyed" is measured too: scratch files are written into the hostile sandbox's own workspace
 * before the command and counted again after it.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { uptime } from "node:os";
import { join } from "node:path";
import { type BlastRadiusCard, sha256, workspaceBytesOf } from "@airlock/contracts";
import { SupervisorError } from "./errors";
import type { DockerApi } from "./docker-api";
import { SANDBOX_USER, SUPERVISOR_GRACE_MS, authorCommand, runExec, timedCommand } from "./exec";
import type { OperationResponse, Supervisor } from "./lifecycle";
import { log } from "./log";
import { oneShotLabels, oneShotNames, ownedFilter } from "./names";
import { runProbe } from "./probe";
import { createTar } from "./tar";
import type { HostileRunRequest } from "./types";

export interface Sentinel {
  path: string;
  digest: string;
  /** Re-hash the file; false if it changed, vanished or cannot be read. */
  unchanged(): Promise<boolean>;
}

/** Written at supervisor start under the data dir; a sandbox that could reach the host could alter it. */
export async function createSentinel(dataDir: string): Promise<Sentinel> {
  mkdirSync(dataDir, { recursive: true });
  const path = join(dataDir, "host-sentinel");
  const content = `airlock host sentinel ${new Date().toISOString()} ${randomBytes(32).toString("hex")}\n`;
  writeFileSync(path, content, { mode: 0o600 });
  const digest = await sha256(content);
  return {
    path,
    digest,
    async unchanged() {
      try {
        return (await sha256(readFileSync(path, "utf8"))) === digest;
      } catch {
        return false;
      }
    },
  };
}

const HOSTILE_TASK = "hostile";
const STOP_SECONDS = 2;
/** Scratch files placed in the hostile sandbox's workspace before the command (blast radius: files destroyed). */
export const SCRATCH_DIR = "airlock-blast";
export const SCRATCH_FILES = 16;
const COUNT_SCRIPT = `import os; p='/workspace/${SCRATCH_DIR}'; print(len([n for n in os.listdir(p) if os.path.isfile(os.path.join(p, n))]) if os.path.isdir(p) else 0)`;

/** Count the scratch files; null when the sandbox cannot answer (gone, stopped, or the count failed). */
export async function countScratch(api: DockerApi, container: string): Promise<number | null> {
  const detail = await api.inspectContainer(container).catch(() => null);
  if (!detail?.state.running) return null;
  const outcome = await runExec(api, container, { cmd: timedCommand(["/usr/local/bin/python3", "-I", "-S", "-c", COUNT_SCRIPT], 5), user: SANDBOX_USER, workingDir: "/workspace" }, { timeoutMs: 7_000, outputBytes: 64 });
  if (outcome.result.status !== "succeeded" || !/^\d+\n$/.test(outcome.result.stdout)) return null;
  return Number.parseInt(outcome.result.stdout, 10);
}

interface SiblingProbe {
  attemptId: string;
  taskId: string;
  container: string;
  runningBefore: boolean;
}

/** Other live attempts and whether Docker reports their container running. */
async function siblingsBefore(core: Supervisor): Promise<SiblingProbe[]> {
  const live = core.journal.listAttempts().filter((a) => a.status === "running" && !a.revoked);
  return Promise.all(
    live.map(async (a) => ({ attemptId: a.attemptId, taskId: a.taskId, container: a.container, runningBefore: (await core.api.inspectContainer(a.container).catch(() => null))?.state.running ?? false })),
  );
}

export async function hostileRun(core: Supervisor, body: HostileRunRequest, sentinel: Sentinel): Promise<OperationResponse> {
  const profile = core.profile(body.profileId);
  const names = oneShotNames(core.config.namespace, HOSTILE_TASK, body.operation.operationId, "hostile");
  if (!names.ok) throw new SupervisorError("invalid_body", names.reason);
  const n = names.value;
  const caps = profile.caps;

  return core.withOperation(body.operation, "hostile", async () => {
    const filter = ownedFilter(core.config.namespace, { taskId: n.taskId, attemptId: `op-${n.operationId}` });
    const deadline = new Date(Date.now() + caps.commandTimeoutMs * 3 + 60_000).toISOString();
    // Host admission before any Docker call (429 with nothing created); released on confirmed removal.
    core.admit(n.container, profile, true);
    try {
      core.journal.insertEphemeral({ container: n.container, volume: n.volume, taskId: n.taskId, operationId: n.operationId, role: "hostile", deadline, createdAt: new Date().toISOString() });
    } catch (error) {
      core.capacity.release(n.container);
      throw error;
    }
    try {
      const provisioned = await core.provision({
        container: n.container,
        volume: n.volume,
        labels: oneShotLabels(n),
        profile,
        mount: { target: "/workspace", readOnly: false },
        workingDir: "/workspace",
        createVolume: true,
      });
      const materialized = await core.materialize(n.container, caps);
      if (materialized.result.status !== "succeeded") {
        throw new SupervisorError("internal", `Materializing the source tree failed (${materialized.result.status}): ${materialized.result.stderr.slice(0, 300)}`);
      }
      const probe = await runProbe(core.api, n.container, "/workspace", workspaceBytesOf(caps));
      if (!probe.allBlocked) throw new SupervisorError("probe_failed", "Isolation probe not fully BLOCKED; hostile sandbox destroyed and run refused.");

      // Blast radius, before: scratch files in this sandbox's own workspace, and every other live attempt.
      const scratch = createTar([
        { path: SCRATCH_DIR, kind: "dir" },
        ...Array.from({ length: SCRATCH_FILES }, (_, i) => ({ path: `${SCRATCH_DIR}/scratch-${String(i).padStart(2, "0")}.txt`, kind: "file" as const, bytes: new TextEncoder().encode(`airlock scratch ${i}\n`) })),
      ]);
      await core.api.putArchive(n.container, scratch, "/workspace");
      const filesBefore = await countScratch(core.api, n.container);
      if (filesBefore === null) throw new SupervisorError("internal", "Could not count the scratch files written before the hostile command.");
      const siblings = await siblingsBefore(core);

      const outcome = await runExec(
        core.api,
        n.container,
        { cmd: authorCommand(body.command, caps.commandTimeoutMs / 1000), user: SANDBOX_USER, workingDir: profile.sourceRoot },
        { timeoutMs: caps.commandTimeoutMs + SUPERVISOR_GRACE_MS, outputBytes: caps.outputBytes },
      );
      if (outcome.controlLost) await core.api.stopContainer(n.container, STOP_SECONDS);
      const filesAfter = await countScratch(core.api, n.container);
      const after = await core.api.inspectContainer(n.container);
      const reason = describeDeath(outcome.result.status, outcome.result.exitCode, after?.state.oomKilled ?? false, outcome.controlLost);

      const [supervisorHealthy, hostSentinelUnchanged] = await Promise.all([core.api.ping(), sentinel.unchanged()]);
      const otherAttemptsRunning = core.journal.countRunning();
      const hostUptimeSeconds = Math.max(0, Math.floor(uptime()));
      const siblingsAfter = await Promise.all(
        siblings.map(async (sib) => ({
          attemptId: sib.attemptId,
          taskId: sib.taskId,
          runningBefore: sib.runningBefore,
          runningAfter: (await core.api.inspectContainer(sib.container).catch(() => null))?.state.running ?? false,
        })),
      );

      await core.removeResources(n.container, n.volume);
      const teardown = await core.teardownRecord(filter);
      log.info("hostile run finished", { operationId: body.operation.operationId, container: n.container, exec: outcome.result.status, exitCode: outcome.result.exitCode, reason, supervisorHealthy, hostSentinelUnchanged, otherAttemptsRunning, siblings: siblingsAfter.length, filesBefore, filesAfter, teardownClean: teardown.clean });
      const card: BlastRadiusCard = {
        operationId: body.operation.operationId,
        container: n.container,
        inspection: provisioned.inspection,
        exec: outcome.result,
        died: { container: n.container, runtime: provisioned.inspection.runtime, guestUname: provisioned.inspection.guestUname, reason },
        survived: { supervisorHealthy, hostSentinelUnchanged, otherAttemptsRunning, hostUptimeSeconds, siblings: siblingsAfter },
        workspace: { filesBefore, filesAfter },
        teardown,
      };
      return { status: 200, body: card };
    } finally {
      await core.removeResources(n.container, n.volume);
      core.journal.deleteEphemeral(n.container);
    }
  });
}

function describeDeath(status: string, exitCode: number | null, oomKilled: boolean, controlLost: boolean): string {
  const parts: string[] = [];
  if (oomKilled) parts.push("the sandbox hit its memory limit and was OOM-killed");
  switch (status) {
    case "succeeded":
      parts.push("the command exited 0");
      break;
    case "failed":
      parts.push(`the command exited ${exitCode ?? "unknown"}`);
      break;
    case "timed_out":
      parts.push("the command was killed at the per-command timeout");
      break;
    default:
      parts.push(`the command was ${status}`);
  }
  if (controlLost) parts.push("the whole container was stopped because the supervisor lost control of the command");
  parts.push("then the container and its volume were destroyed");
  return parts.join("; ");
}
