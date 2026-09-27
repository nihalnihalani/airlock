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
import type { BrowserPlaneConfig, CapacityBudget } from "./config";
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

/**
 * What one sandbox costs: caps memory + VM overhead + every tmpfs it can fill, caps PIDs, and the
 * tmpfs bytes again as scratch (the separate scratch ceiling).
 *
 * tmpfs pages are RAM, so their full sizes are charged to the MEMORY budget as well. On runc/runsc
 * the container's memory cgroup already bounds what its own writes put in tmpfs, so this
 * over-reserves by the tmpfs sizes (tabulate-365: 512 MiB caps + 64 MiB /tmp + 128 MiB workspace =
 * 704 MiB reserved per author sandbox; the browser: 2048 + 512 /tmp + 1 socket dir + 256 shm =
 * 2817 MiB). That is deliberate, because the cgroup bound does not hold everywhere:
 *   - under Kata the workspace is a HOST-side tmpfs volume shared into the guest over virtio-fs; its
 *     pages live outside the guest VM's memory limit;
 *   - a stopped author's workspace pages outlive its cgroup while the collector holds the volume
 *     (freeze), and stay resident until the volume is removed.
 * Charging the sizes up front means the admitted sandboxes can never jointly exceed the host
 * memory budget, whatever runtime they run on.
 */
export function sandboxCost(caps: Caps, budget: CapacityBudget, createsWorkspace: boolean): { memoryBytes: number; pids: number; scratchBytes: number } {
  const scratchBytes = TMP_BYTES + (createsWorkspace ? workspaceBytesOf(caps) : 0);
  return {
    memoryBytes: caps.memoryBytes + budget.vmOverheadBytes + scratchBytes,
    pids: caps.pidsLimit,
    scratchBytes,
  };
}

export type Cost = { memoryBytes: number; pids: number; scratchBytes: number };

/**
 * The browser plane's two containers, each charged separately (and each with its own VM overhead:
 * under Kata every container is its own guest). The browser's scratch is its `/tmp` and
 * `/run/airlock` tmpfs; `/dev/shm` is memory-backed and inside its memory cgroup.
 */
export function browserCosts(browser: BrowserPlaneConfig, budget: CapacityBudget): { browser: Cost; egress: Cost } {
  const scratch = browser.tmpBytes + 1_048_576;
  return {
    // tmpfs (/tmp, /run/airlock) and /dev/shm are RAM: charged to memory too (see sandboxCost).
    browser: { memoryBytes: browser.memoryBytes + budget.vmOverheadBytes + scratch + browser.shmBytes, pids: browser.pidsLimit, scratchBytes: scratch },
    egress: { memoryBytes: browser.egressMemoryBytes + budget.vmOverheadBytes, pids: browser.egressPidsLimit, scratchBytes: 0 },
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

  /**
   * Reserve several sandboxes as one admission (the browser and its egress proxy): either all fit
   * and all are recorded, or none is. Synchronous like `reserve`.
   */
  reserveAll(entries: { container: string; cost: Cost }[]): void {
    const total = entries.reduce((sum, e) => ({ memoryBytes: sum.memoryBytes + e.cost.memoryBytes, pids: sum.pids + e.cost.pids, scratchBytes: sum.scratchBytes + e.cost.scratchBytes }), { memoryBytes: 0, pids: 0, scratchBytes: 0 });
    for (const e of entries) {
      if (this.reservations.has(e.container)) throw new SupervisorError("capacity", `Sandbox ${e.container} already holds a host reservation.`);
    }
    const used = this.used();
    const short: string[] = [];
    if (used.sandboxes + entries.length > this.budget.maxSandboxes) short.push(`sandboxes ${used.sandboxes}+${entries.length} > ${this.budget.maxSandboxes}`);
    if (used.memoryBytes + total.memoryBytes > this.budget.memoryBytes) short.push(`memory ${mib(used.memoryBytes)}+${mib(total.memoryBytes)} > ${mib(this.budget.memoryBytes)} MiB`);
    if (used.pids + total.pids > this.budget.pids) short.push(`pids ${used.pids}+${total.pids} > ${this.budget.pids}`);
    if (used.scratchBytes + total.scratchBytes > this.budget.scratchBytes) short.push(`scratch ${mib(used.scratchBytes)}+${mib(total.scratchBytes)} > ${mib(this.budget.scratchBytes)} MiB`);
    if (short.length > 0) {
      throw new SupervisorError("capacity", `The execution host is at capacity (${short.join("; ")}); nothing was created. Retry after running sandboxes finish.`);
    }
    const reservedAt = new Date().toISOString();
    for (const e of entries) this.reservations.set(e.container, { container: e.container, ...e.cost, reservedAt, provisioning: true, adopted: false });
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
