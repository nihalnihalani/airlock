/**
 * Checkpoint 4: the isolation probe.
 *
 * Runs the fixed `/opt/airlock/probe.sh` inside a sandbox before any agent work. Its output is
 * untrusted text; it is parsed strictly and anything that is not BLOCKED refuses the run. A probe
 * that fails to run, times out or prints something unparseable is UNKNOWN, which also refuses.
 */
import { z } from "zod";
import { IsolationProbe, ProbeResult } from "@airlock/contracts";
import type { DockerApi } from "./docker-api";
import { SANDBOX_USER, runExec, timedCommand } from "./exec";

const PROBE_PATH = "/opt/airlock/probe.sh";
const PROBE_TIMEOUT_SECONDS = 25;
/** Task sandboxes get Docker's default /dev/shm (no ShmSize is set): 64 MiB. */
export const SHM_BYTES = 67_108_864;

const probeOutput = z.object({
  metadataEndpoint: ProbeResult,
  dns: ProbeResult,
  outboundTcp: ProbeResult,
  dockerSocket: ProbeResult,
  hostMounts: ProbeResult,
  allBlocked: z.boolean(),
});

export function parseProbeOutput(stdout: string, probedAt: string): IsolationProbe {
  const unknown: IsolationProbe = {
    probedAt,
    metadataEndpoint: "UNKNOWN",
    dns: "UNKNOWN",
    outboundTcp: "UNKNOWN",
    dockerSocket: "UNKNOWN",
    hostMounts: "UNKNOWN",
    allBlocked: false,
  };
  // The last non-empty line is the JSON document; earlier lines are diagnostics.
  const lines = stdout.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  const last = lines[lines.length - 1];
  if (!last || last.length > 4096) return unknown;
  let raw: unknown;
  try {
    raw = JSON.parse(last);
  } catch {
    return unknown;
  }
  const parsed = probeOutput.safeParse(raw);
  if (!parsed.success) return unknown;
  const p = parsed.data;
  const fields = [p.metadataEndpoint, p.dns, p.outboundTcp, p.dockerSocket, p.hostMounts];
  // The probe's own allBlocked claim carries no authority; recompute from the fields.
  const allBlocked = fields.every((f) => f === "BLOCKED");
  return { probedAt, ...p, allBlocked };
}

/**
 * `workspaceBytes` is the size the owned workspace tmpfs must not exceed; the probe treats a larger
 * or unbounded tmpfs at /workspace or /candidate as a host-backed mount (REACHED).
 */
/**
 * `guestVm`: the effective runtime inspected for this container boots its own guest kernel (Kata).
 * Only then does the probe accept an unsized /dev/shm, which is guest RAM bounded by the VM's memory
 * limit. Never derived from the container's own claims.
 */
export async function runProbe(api: DockerApi, container: string, workingDir: string, workspaceBytes: number, signal?: AbortSignal, guestVm = false): Promise<IsolationProbe> {
  const probedAt = new Date().toISOString();
  const outcome = await runExec(
    api,
    container,
    { cmd: timedCommand(["/bin/bash", "--noprofile", "--norc", PROBE_PATH, "--workspace-bytes", String(workspaceBytes), "--shm-bytes", String(SHM_BYTES), ...(guestVm ? ["--guest-vm"] : [])], PROBE_TIMEOUT_SECONDS), user: SANDBOX_USER, workingDir },
    { timeoutMs: (PROBE_TIMEOUT_SECONDS + 7) * 1000, outputBytes: 16_384, ...(signal ? { signal } : {}) },
  );
  if (outcome.result.status !== "succeeded") return parseProbeOutput("", probedAt);
  return parseProbeOutput(outcome.result.stdout, probedAt);
}
