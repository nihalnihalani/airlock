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
 * When a run stops for any reason (and when a recovery or cancel pass starts), settleOpenProposals
 * expires pending/approved proposals, moves claimed/submitted ones to outcome_unknown, and
 * reconciles outcome_unknown ones by receipt reads only.
 *
 * The approver must restate the digest they reviewed; a different digest (a changed payload) is
 * 409, a second decision is 409 (replay), an expired proposal is 410. The model never decides.
 */
import type { ActionProposal } from "@airlock/contracts";
import { readReceipt, type FormsConfig } from "./forms-adapter.ts";
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

export type ProposalEmit = (kind: "lifecycle" | "check" | "error", title: string, detail: string, data: Record<string, unknown>) => Promise<unknown>;

/**
 * Settles a task's open proposals when a run stops, whatever the reason (normal end, error,
 * cancellation, lost lease), and when a recovery or cancel pass starts after a controller restart:
 *
 * - `pending` / `approved`: can no longer be carried out → `expired` (the event carries the reason).
 * - `claimed` / `submitted`: the submit click may or may not have reached the destination →
 *   `outcome_unknown`. Never re-submitted.
 * - `outcome_unknown` (including the ones just moved there): reconciled ONLY by reading the
 *   destination's receipt, a bounded number of reads. A receipt whose payload digest matches the
 *   approved one → `confirmed`; anything else leaves it `outcome_unknown`.
 *
 * Every change is a compare-and-swap from the status that was read. Receipt reads use their own
 * timeout (not the run's abort signal), so they still work after a cancellation.
 */
export async function settleOpenProposals(
  store: Store,
  input: {
    owner: string;
    taskId: string;
    why: string;
    forms: FormsConfig | null | undefined;
    emit: ProposalEmit;
    /** Delays before each receipt read (its length bounds the reads per proposal). */
    receiptDelaysMs?: number[];
    /** Proposal ids already reconciled in this run: not read again. */
    alreadyRead?: Set<string>;
  },
): Promise<ActionProposal[]> {
  const { owner, taskId, why, emit } = input;
  const rows = (await store.scanWhere<ActionProposal>(STORE_KIND_PROPOSALS, { taskId })).filter((r) => r.owner === owner && r.value.taskId === taskId).map((r) => r.value);
  const out: ActionProposal[] = [];
  for (let p of rows) {
    const common = { proposalId: p.id, formId: p.formId, destination: p.destination, payloadDigest: p.payloadDigest };
    if (p.status === "pending" || p.status === "approved") {
      const next = await transitionProposal(store, owner, p.id, [p.status], { status: "expired" });
      if (next) {
        await emit("lifecycle", "Proposal expired", `${why}; the ${p.status} proposal can no longer be carried out and nothing was submitted`, { ...common, status: "expired", previousStatus: p.status, reason: why.slice(0, 500) });
        p = next;
      }
    } else if (p.status === "claimed" || p.status === "submitted") {
      const next = await transitionProposal(store, owner, p.id, [p.status], { status: "outcome_unknown" });
      if (next) {
        await emit(
          "lifecycle",
          "Final action outcome unknown",
          `the run stopped (${why}) while the approved submission was ${p.status}${p.status === "claimed" ? " (the submit click may or may not have been sent)" : ""}; it is NOT re-submitted. Reconciling by reading the destination's receipt.`,
          { ...common, status: "outcome_unknown", previousStatus: p.status, reason: why.slice(0, 500) },
        );
        p = next;
      }
    }
    if (p.status === "outcome_unknown" && input.forms && !input.alreadyRead?.has(p.id)) {
      input.alreadyRead?.add(p.id);
      p = await reconcileByReceipt(store, owner, p, input.forms, emit, input.receiptDelaysMs ?? [0, 500, 1000]);
    }
    out.push(p);
  }
  return out;
}

async function reconcileByReceipt(store: Store, owner: string, p: ActionProposal, forms: FormsConfig, emit: ProposalEmit, delays: number[]): Promise<ActionProposal> {
  const common = { proposalId: p.id, formId: p.formId, destination: p.destination, payloadDigest: p.payloadDigest };
  for (let i = 0; i < Math.max(1, delays.length); i++) {
    const delay = delays[i] ?? 0;
    if (delay > 0) await new Promise<void>((resolve) => setTimeout(resolve, delay));
    const read = await readReceipt(forms, p.destination, p.id);
    await emit("check", `Receipt read (reconciliation) ${i + 1}: ${read.kind}`, read.kind === "confirmed" ? `receipt ${read.receiptId} (payload digest ${read.payloadDigest})` : read.kind === "error" ? read.detail : "the destination has no receipt for this proposal", { ...common, receiptRead: read.kind, read: i + 1, reconciliation: true });
    if (read.kind === "confirmed") {
      if (read.payloadDigest !== p.payloadDigest) {
        await emit("error", "Receipt does not match the approval", `the destination's receipt ${read.receiptId} carries payload digest ${read.payloadDigest}, not the approved ${p.payloadDigest}; the proposal stays outcome_unknown`, { ...common, status: "outcome_unknown" });
        return p;
      }
      const receipt = { receiptId: read.receiptId, payloadDigest: read.payloadDigest, at: read.at };
      const next = await transitionProposal(store, owner, p.id, ["outcome_unknown"], { status: "confirmed", receipt });
      if (!next) return (await store.get<ActionProposal>(owner, STORE_KIND_PROPOSALS, p.id)) ?? p;
      await emit("lifecycle", "Final action confirmed by the destination", `receipt ${read.receiptId}: reconciled by reading the destination's receipt; nothing was re-submitted`, { ...common, status: "confirmed", receipt, reconciled: true });
      return next;
    }
    // The destination answered that it has no receipt: the proposal stays outcome_unknown (a later
    // recovery or cancel pass reads again). Transport errors are retried within the bound.
    if (read.kind === "none") return p;
  }
  return p;
}
