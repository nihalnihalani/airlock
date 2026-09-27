/**
 * Hostile-input panel: run an arbitrary command in an author-profile sandbox and report the blast
 * radius. The command is data passed to bash inside the container; it never touches a host shell.
 * "Survived" is measured, not asserted: supervisor health, a host sentinel file's hash, other
 * attempts still running, host uptime.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { uptime } from "node:os";
import { join } from "node:path";
import { type BlastRadiusCard, sha256 } from "@airlock/contracts";
import { SupervisorError } from "./errors";
import { SANDBOX_USER, SUPERVISOR_GRACE_MS, authorCommand, runExec } from "./exec";
import type { OperationResponse, Supervisor } from "./lifecycle";
import { log } from "./log";
import { oneShotLabels, oneShotNames, ownedFilter } from "./names";
import { runProbe } from "./probe";
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

export async function hostileRun(core: Supervisor, body: HostileRunRequest, sentinel: Sentinel): Promise<OperationResponse> {
  const profile = core.profile(body.profileId);
  const names = oneShotNames(core.config.namespace, HOSTILE_TASK, body.operation.operationId, "hostile");
  if (!names.ok) throw new SupervisorError("invalid_body", names.reason);
  const n = names.value;
  const caps = profile.caps;

  return core.withOperation(body.operation, "hostile", async () => {
    const filter = ownedFilter(core.config.namespace, { taskId: n.taskId, attemptId: `op-${n.operationId}` });
    const deadline = new Date(Date.now() + caps.commandTimeoutMs * 3 + 60_000).toISOString();
    core.journal.insertEphemeral({ container: n.container, volume: n.volume, taskId: n.taskId, operationId: n.operationId, role: "hostile", deadline, createdAt: new Date().toISOString() });
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
      const probe = await runProbe(core.api, n.container, "/workspace");
      if (!probe.allBlocked) throw new SupervisorError("probe_failed", "Isolation probe not fully BLOCKED; hostile sandbox destroyed and run refused.");

      const outcome = await runExec(
        core.api,
        n.container,
        { cmd: authorCommand(body.command, caps.commandTimeoutMs / 1000), user: SANDBOX_USER, workingDir: profile.sourceRoot },
        { timeoutMs: caps.commandTimeoutMs + SUPERVISOR_GRACE_MS, outputBytes: caps.outputBytes },
      );
      if (outcome.controlLost) await core.api.stopContainer(n.container, STOP_SECONDS);
      const after = await core.api.inspectContainer(n.container);
      const reason = describeDeath(outcome.result.status, outcome.result.exitCode, after?.state.oomKilled ?? false, outcome.controlLost);

      const [supervisorHealthy, hostSentinelUnchanged] = await Promise.all([core.api.ping(), sentinel.unchanged()]);
      const otherAttemptsRunning = core.journal.countRunning();
      const hostUptimeSeconds = Math.max(0, Math.floor(uptime()));

      await core.removeResources(n.container, n.volume);
      const teardown = await core.teardownRecord(filter);
      log.info("hostile run finished", { operationId: body.operation.operationId, container: n.container, exec: outcome.result.status, exitCode: outcome.result.exitCode, reason, supervisorHealthy, hostSentinelUnchanged, otherAttemptsRunning, teardownClean: teardown.clean });
      const card: BlastRadiusCard = {
        operationId: body.operation.operationId,
        container: n.container,
        inspection: provisioned.inspection,
        exec: outcome.result,
        died: { container: n.container, runtime: provisioned.inspection.runtime, guestUname: provisioned.inspection.guestUname, reason },
        survived: { supervisorHealthy, hostSentinelUnchanged, otherAttemptsRunning, hostUptimeSeconds },
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
