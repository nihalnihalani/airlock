/**
 * Action proposals and their one-use approval (40 Stage 5; audit 42 C25–C27).
 *
 * A proposal is inserted once (insertImmutable) with its normalized payload and digest; nothing in
 * it changes afterwards except the status fields, and every status change is a compare-and-swap
 * from an expected status:
 *
 *   pending ──decide(approve, exact digest)──▶ approved ──controller claims──▶ claimed ──click sent──▶ submitted
 *      │                                                                         │                      │
 *      ├──decide(reject)──▶ rejected                                              └──▶ failed         ├──▶ confirmed (receipt matches)
 *      └──expiry / task deadline──▶ expired                                                            ├──▶ failed (definitively not recorded)
 *                                                                                                     └──▶ outcome_unknown ──receipt read──▶ confirmed
 *
 * The approver must restate the digest they reviewed; a different digest (a changed payload) is
 * 409, a second decision is 409 (replay), an expired proposal is 410. The model never decides.
 */
import type { ActionProposal } from "@airlock/contracts";
import type { Store } from "./store/index.ts";

export const STORE_KIND_PROPOSALS = "action-proposals";
/** Default lifetime of a proposal (and of its approval code). */
export const PROPOSAL_TTL_MS = 15 * 60_000;

export type DecideResult = { ok: true; proposal: ActionProposal } | { ok: false; status: 404 | 409 | 410; error: string };

export async function listProposals(store: Store, owner: string, taskId: string): Promise<ActionProposal[]> {
  return (await store.scanWhere<ActionProposal>(STORE_KIND_PROPOSALS, { taskId }))
    .filter((r) => r.owner === owner && r.value.taskId === taskId)
    .map((r) => r.value)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

/** Compare-and-swap a proposal's status from one of `from`; null when none matched. */
export async function transitionProposal(store: Store, owner: string, id: string, from: ActionProposal["status"][], patch: Partial<ActionProposal> & { status: ActionProposal["status"] }): Promise<ActionProposal | null> {
  for (const status of from) {
    const next = await store.compareAndSwap<ActionProposal>(owner, STORE_KIND_PROPOSALS, id, { status }, patch as Record<string, unknown>);
    if (next) return next;
  }
  return null;
}

export async function decideProposal(
  store: Store,
  input: { owner: string; taskId: string; proposalId: string; decision: "approve" | "reject"; payloadDigest: string; decidedBy: string; now: number },
): Promise<DecideResult> {
  const found = await store.get<ActionProposal>(input.owner, STORE_KIND_PROPOSALS, input.proposalId);
  if (!found || found.taskId !== input.taskId) return { ok: false, status: 404, error: "proposal not found" };
  if (found.status === "expired") return { ok: false, status: 410, error: "the proposal expired" };
  if (found.status !== "pending") return { ok: false, status: 409, error: `the proposal was already decided (${found.status}); an approval is one-use` };
  if (input.now >= Date.parse(found.expiresAt)) {
    await transitionProposal(store, input.owner, found.id, ["pending"], { status: "expired" });
    return { ok: false, status: 410, error: "the proposal expired" };
  }
  if (input.payloadDigest !== found.payloadDigest) return { ok: false, status: 409, error: "payloadDigest does not match the proposal: approve exactly the payload you reviewed" };
  const decided = await store.compareAndSwap<ActionProposal>(
    input.owner,
    STORE_KIND_PROPOSALS,
    found.id,
    { status: "pending", payloadDigest: found.payloadDigest },
    { status: input.decision === "approve" ? "approved" : "rejected", decidedBy: input.decidedBy, decidedAt: new Date(input.now).toISOString() },
  );
  if (!decided) {
    const latest = await store.get<ActionProposal>(input.owner, STORE_KIND_PROPOSALS, found.id);
    if (latest?.status === "expired") return { ok: false, status: 410, error: "the proposal expired" };
    return { ok: false, status: 409, error: `the proposal was already decided (${latest?.status ?? "unknown"}); an approval is one-use` };
  }
  return { ok: true, proposal: decided };
}
