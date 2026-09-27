/**
 * Host admission: every sandbox reserves its memory, PIDs and scratch bytes against one host budget
 * before any Docker call, and gives them back only once its container is confirmed removed.
 *
 * The check-and-reserve is a single synchronous step in this process (no await between reading the
 * usage and recording the reservation), so two concurrent requests cannot both fit into the last
 * slot. A refusal is a `capacity` SupervisorError (HTTP 429) raised before anything exists on the
 * host. A sandbox whose removal is not confirmed (quarantined, `unknown`, remove failed) keeps its
 * reservation until the janitor sees the container gone. After a restart the reservations are
 * rebuilt from the containers Docker still lists (`adopt`), which may exceed the budget: new work is
 * then refused until the janitor clears the excess.
 */
import { type Caps, workspaceBytesOf } from "@airlock/contracts";
import type { CapacityBudget } from "./config";
import { SupervisorError } from "./errors";

/** The per-sandbox `/tmp` tmpfs (runtime.ts TMPFS_TMP size). */
export const TMP_BYTES = 67_108_864;

export interface Reservation {
  container: string;
  memoryBytes: number;
  pids: number;
  scratchBytes: number;
  reservedAt: string;
  /** True while the sandbox is being provisioned: the janitor must not read "no container yet" as removal. */
  provisioning: boolean;
  /** Rebuilt from Docker at startup rather than reserved by an admission. */
  adopted: boolean;
}

export interface CapacityUsage {
  budget: CapacityBudget;
  used: { memoryBytes: number; pids: number; scratchBytes: number; sandboxes: number };
  sandboxes: Reservation[];
}

/** What one sandbox costs: caps memory (+ VM overhead), caps PIDs, `/tmp` plus a fresh workspace. */
export function sandboxCost(caps: Caps, budget: CapacityBudget, createsWorkspace: boolean): { memoryBytes: number; pids: number; scratchBytes: number } {
  return {
    memoryBytes: caps.memoryBytes + budget.vmOverheadBytes,
    pids: caps.pidsLimit,
    scratchBytes: TMP_BYTES + (createsWorkspace ? workspaceBytesOf(caps) : 0),
  };
}

export class HostCapacity {
  private readonly reservations = new Map<string, Reservation>();

  constructor(readonly budget: CapacityBudget) {}

  has(container: string): boolean {
    return this.reservations.has(container);
  }

  /** Reserve or throw `capacity` (429). Synchronous: the check and the record are one step. */
  reserve(container: string, cost: { memoryBytes: number; pids: number; scratchBytes: number }): void {
    if (this.reservations.has(container)) {
      throw new SupervisorError("capacity", `Sandbox ${container} already holds a host reservation.`);
    }
    const used = this.used();
    const short: string[] = [];
    if (used.sandboxes + 1 > this.budget.maxSandboxes) short.push(`sandboxes ${used.sandboxes}/${this.budget.maxSandboxes}`);
    if (used.memoryBytes + cost.memoryBytes > this.budget.memoryBytes) short.push(`memory ${mib(used.memoryBytes)}+${mib(cost.memoryBytes)} > ${mib(this.budget.memoryBytes)} MiB`);
    if (used.pids + cost.pids > this.budget.pids) short.push(`pids ${used.pids}+${cost.pids} > ${this.budget.pids}`);
    if (used.scratchBytes + cost.scratchBytes > this.budget.scratchBytes) short.push(`scratch ${mib(used.scratchBytes)}+${mib(cost.scratchBytes)} > ${mib(this.budget.scratchBytes)} MiB`);
    if (short.length > 0) {
      throw new SupervisorError("capacity", `The execution host is at capacity (${short.join("; ")}); nothing was created. Retry after running sandboxes finish.`);
    }
    this.reservations.set(container, { container, ...cost, reservedAt: new Date().toISOString(), provisioning: true, adopted: false });
  }

  /** Record an existing container (restart reconciliation). Never refuses: it already exists. */
  adopt(container: string, cost: { memoryBytes: number; pids: number; scratchBytes: number }): void {
    if (this.reservations.has(container)) return;
    this.reservations.set(container, { container, ...cost, reservedAt: new Date().toISOString(), provisioning: false, adopted: true });
  }

  /** Provisioning finished (the container exists or its removal path owns the release). */
  settled(container: string): void {
    const r = this.reservations.get(container);
    if (r) r.provisioning = false;
  }

  /** Only after the container is confirmed gone. */
  release(container: string): boolean {
    return this.reservations.delete(container);
  }

  /** Reservations the janitor may test for removal (not mid-provisioning). */
  releasable(): string[] {
    return [...this.reservations.values()].filter((r) => !r.provisioning).map((r) => r.container);
  }

  used(): CapacityUsage["used"] {
    let memoryBytes = 0;
    let pids = 0;
    let scratchBytes = 0;
    for (const r of this.reservations.values()) {
      memoryBytes += r.memoryBytes;
      pids += r.pids;
      scratchBytes += r.scratchBytes;
    }
    return { memoryBytes, pids, scratchBytes, sandboxes: this.reservations.size };
  }

  usage(): CapacityUsage {
    return { budget: { ...this.budget }, used: this.used(), sandboxes: [...this.reservations.values()].map((r) => ({ ...r })) };
  }
}

function mib(bytes: number): number {
  return Math.round(bytes / 1_048_576);
}
