/**
 * Host listings name every Airlock-owned container and volume on VM B, including other tasks'
 * (CLAUDE.md §3.6: task ids and container names are identifiers, and another tenant's are not
 * ours to show). Before a listing is stored in a record or event, or returned on a hostile card,
 * entries that do not belong to the viewer's own task(s) keep their role, state and count but lose
 * their identity: taskId → "other", names → "other-task container" / "other-task volume". Counts
 * are unchanged, so "(no sandboxes)" still means an empty host.
 */
import type { BlastRadiusCard, HostListing, TeardownRecord } from "@airlock/contracts";

export const OTHER_TASK = "other";
export const OTHER_CONTAINER = "other-task container";
export const OTHER_VOLUME = "other-task volume";
export const OTHER_NETWORK = "other-task network";

/** A resource name belongs to a task when it embeds `-<taskId>-` (the supervisor's naming rule) or ends with it. */
function nameBelongs(name: string, own: ReadonlySet<string>): boolean {
  for (const id of own) if (name.includes(`-${id}-`) || name.endsWith(`-${id}`)) return true;
  return false;
}

export function redactHostListing<T extends HostListing>(listing: T, own: ReadonlySet<string>): T {
  const containers = listing.containers.map((c) => {
    const mine = c.taskId !== undefined ? own.has(c.taskId) : nameBelongs(c.name, own);
    if (mine) return c;
    return { name: OTHER_CONTAINER, taskId: OTHER_TASK, ...(c.role !== undefined ? { role: c.role } : {}), ...(c.state !== undefined ? { state: c.state } : {}) };
  });
  const volumes = listing.volumes.map((v) => (nameBelongs(v, own) ? v : OTHER_VOLUME));
  const out = { ...listing, containers, volumes } as T & { networks?: unknown };
  // The supervisor's listing may carry an extension field with per-attempt network names.
  const networks = (listing as { networks?: unknown }).networks;
  if (Array.isArray(networks)) out.networks = networks.map((n) => (typeof n === "string" && nameBelongs(n, own) ? n : OTHER_NETWORK));
  return out as T;
}

export function redactTeardown<T extends TeardownRecord>(teardown: T, own: ReadonlySet<string>): T {
  return teardown.host ? { ...teardown, host: redactHostListing(teardown.host, own) } : teardown;
}

/** A hostile card as a judge may see it: siblings and host listing entries of other tasks anonymised. */
export function redactBlastRadiusCard(card: BlastRadiusCard, own: ReadonlySet<string>): BlastRadiusCard {
  const siblings = card.survived.siblings?.map((s) => (own.has(s.taskId) ? s : { ...s, taskId: OTHER_TASK, attemptId: OTHER_TASK }));
  return {
    ...card,
    survived: { ...card.survived, ...(siblings ? { siblings } : {}) },
    teardown: redactTeardown(card.teardown, own),
  };
}
