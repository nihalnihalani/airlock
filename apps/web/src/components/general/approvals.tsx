/**
 * Review of proposed final actions (40 Stage 5; audit 42 C25–C27). One card per ActionProposal:
 * the destination, the form, every field exactly as it will be submitted (text nodes, never
 * truncated), the model's summary labelled as the model's words, the full payload digest and the
 * expiry. Approve/Reject send the digest shown on the card — the card keeps the copy the reviewer
 * saw and never re-fetches before sending; the server refuses a digest that differs (409).
 */
import { IconAlertTriangle, IconCheck, IconEye, IconX } from "@tabler/icons-react";
import { useState } from "react";
import type { ActionProposal } from "@airlock/contracts";
import { useTick } from "../../hooks/useBrowserControl";
import { ApiError, decideProposal, describeError } from "../../lib/api";
import {
  controlErrorMessage,
  decisionBody,
  expiryCountdown,
  holderIsViewer,
  isOpenProposal,
  proposalChanged,
  proposalFieldRows,
  proposalLifecycle,
  proposalStatusView,
  type Viewer,
} from "../../lib/control";
import { formatDateTime } from "../../lib/format";
import { cn } from "../../lib/utils";
import { Badge, ErrorBox, Mono, Notice } from "../common";
import { Button } from "../ui/button";

function LifecycleStrip({ status }: { status: ActionProposal["status"] }) {
  const steps = proposalLifecycle(status);
  return (
    <ol className="flex flex-wrap items-center gap-1 text-[11px]" aria-label="Proposal lifecycle">
      {steps.map((s, i) => (
        <li key={s.status} className="flex items-center gap-1">
          {i > 0 ? <span className="text-muted-foreground/50">→</span> : null}
          <span className={cn("rounded px-1", s.current ? "bg-foreground/10 font-medium" : s.reached ? "text-foreground/80" : "text-muted-foreground/60")}>{s.label}</span>
        </li>
      ))}
    </ol>
  );
}

function FieldTable({ fields }: { fields: Record<string, string> }) {
  const rows = proposalFieldRows(fields);
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full border-collapse text-left text-xs">
        <thead className="bg-muted/60">
          <tr>
            <th className="px-2 py-1 font-medium">field</th>
            <th className="px-2 py-1 font-medium">value that will be submitted (exact)</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.name} className="border-t border-border align-top">
              <td className="px-2 py-1 font-mono whitespace-nowrap">{r.name}</td>
              <td className="px-2 py-1">
                {r.value.length === 0 ? (
                  <Badge>empty</Badge>
                ) : (
                  <span className="font-mono break-all whitespace-pre-wrap">{r.value}</span>
                )}
              </td>
            </tr>
          ))}
          {rows.length === 0 ? (
            <tr>
              <td colSpan={2} className="px-2 py-1 text-muted-foreground">
                no fields
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}

export function ProposalCard({ latest, taskId, viewer, canDecide, running, onDecided }: { latest: ActionProposal; taskId: string; viewer: Viewer; canDecide: boolean; running: boolean; onDecided: () => void }) {
  // The copy the reviewer is looking at. Decisions are built from this, never from a refetch.
  const [shown, setShown] = useState<ActionProposal>(latest);
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<{ decision: string; payloadDigest: string } | null>(null);
  const changed = proposalChanged(shown, latest);
  const status = latest.status;
  const view = proposalStatusView(status);
  const open = isOpenProposal(latest, Date.now());
  const now = useTick(1000, status === "pending");
  const expiry = expiryCountdown(latest.expiresAt, now);
  const decidedByMe = latest.decidedBy ? holderIsViewer(latest.decidedBy, viewer) : null;

  const decide = async (decision: "approve" | "reject") => {
    const body = decisionBody(shown, decision);
    setBusy(decision);
    setError(null);
    setSent(body);
    try {
      await decideProposal(taskId, shown.id, body);
      onDecided();
    } catch (err) {
      setError(err instanceof ApiError ? controlErrorMessage(err.status, err.message, "decide") : describeError(err));
      onDecided();
    } finally {
      setBusy(null);
    }
  };

  return (
    <article
      id={`proposal-${latest.id}`}
      aria-label={`Proposal ${latest.id}`}
      className={cn("flex scroll-mt-4 flex-col gap-3 rounded-xl border bg-card p-4", status === "pending" ? "border-warning/60 ring-2 ring-warning/20" : view.tone === "ok" ? "border-success/40" : view.tone === "bad" ? "border-destructive/40" : "border-border")}
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold">{status === "pending" ? "Review this submission" : "Proposed submission"}</h3>
        <Badge tone={view.tone}>{view.label}</Badge>
        {status === "pending" ? <span className={cn("text-xs tabular-nums", expiry.urgent ? "font-medium text-warning" : "text-muted-foreground")}>{expiry.text}</span> : null}
        <Mono className="ml-auto text-[11px] text-muted-foreground">{latest.id}</Mono>
      </div>
      <p className="text-xs text-pretty text-muted-foreground">{view.note}</p>

      <dl className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted-foreground">destination</dt>
        <dd className="font-mono break-all">{shown.destination}</dd>
        <dt className="text-muted-foreground">form</dt>
        <dd className="font-mono break-all">{shown.formId}</dd>
        <dt className="text-muted-foreground">adapter</dt>
        <dd>
          <Mono>{shown.adapter}</Mono> <span className="text-muted-foreground">(the destination accepts only this exact approved payload)</span>
        </dd>
        <dt className="text-muted-foreground">attempt</dt>
        <dd>
          <Mono>{shown.attemptId}</Mono> · browser generation <Mono>{shown.browserGeneration}</Mono>
        </dd>
        <dt className="text-muted-foreground">proposed</dt>
        <dd>{formatDateTime(shown.createdAt)}</dd>
        <dt className="text-muted-foreground">expires</dt>
        <dd>{formatDateTime(shown.expiresAt)}</dd>
      </dl>

      <FieldTable fields={shown.fields} />

      <div className="flex flex-col gap-1 rounded-lg border border-dashed border-warning/40 p-2.5">
        <span className="text-[11px] font-medium text-warning">The model's words (untrusted; the fields above are what will be submitted)</span>
        <p className="text-sm whitespace-pre-wrap break-words">{shown.summary || "(no summary)"}</p>
      </div>

      <div className="flex flex-col gap-1">
        <span className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">payload digest (sha256 of adapter, destination, form and fields)</span>
        <code className="rounded-md bg-muted/60 px-2 py-1 font-mono text-xs break-all dark:bg-background/60">{shown.payloadDigest}</code>
      </div>

      {changed ? (
        <Notice tone="bad" className="flex gap-2 text-xs">
          <IconAlertTriangle className="mt-px size-4 shrink-0" />
          <span>
            The control plane now reports different values for this proposal than the ones shown. Nothing was sent. Review the new values before deciding.{" "}
            <Button size="xs" variant="outline" onClick={() => setShown(latest)}>
              <IconEye />
              Show the new values
            </Button>
          </span>
        </Notice>
      ) : null}

      {status === "pending" ? (
        canDecide && running ? (
          <div className="flex flex-col gap-1.5">
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => void decide("approve")} disabled={busy !== null || changed || !open}>
                <IconCheck />
                {busy === "approve" ? "Approving…" : "Approve exactly these values"}
              </Button>
              <Button size="sm" variant="destructive" onClick={() => void decide("reject")} disabled={busy !== null || changed || !open}>
                <IconX />
                {busy === "reject" ? "Rejecting…" : "Reject"}
              </Button>
            </div>
            <p className="text-[11px] text-pretty text-muted-foreground">
              Your decision carries the digest shown above. The approval is one-use: Airlock (not the model) fills in these values with a one-use approval code and submits once, then checks
              the destination's receipt. A changed payload, a second decision or an expired proposal is refused.
            </p>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">{!running ? "The task is not running; this proposal can no longer be decided." : "Sign in as operator or judge to decide."}</p>
        )
      ) : (
        <div className="flex flex-col gap-1.5 border-t border-border pt-2.5 text-xs">
          <LifecycleStrip status={status} />
          <dl className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-1">
            {latest.decidedAt ? (
              <>
                <dt className="text-muted-foreground">decided</dt>
                <dd>
                  {formatDateTime(latest.decidedAt)}
                  {latest.decidedBy ? <span className="text-muted-foreground"> by {decidedByMe === true ? "you" : "a person"}</span> : null}
                </dd>
              </>
            ) : null}
            <dt className="text-muted-foreground">receipt</dt>
            <dd>
              {latest.receipt ? (
                <span className="flex flex-col gap-0.5">
                  <span>
                    <Mono>{latest.receipt.receiptId}</Mono> at {formatDateTime(latest.receipt.at)}
                  </span>
                  <span className="text-muted-foreground">
                    receipt digest <Mono wrap>{latest.receipt.payloadDigest}</Mono>{" "}
                    {latest.receipt.payloadDigest === latest.payloadDigest ? <Badge tone="ok">matches the approved digest</Badge> : <Badge tone="bad">differs from the approved digest</Badge>}
                  </span>
                </span>
              ) : (
                <span className="text-muted-foreground">none recorded</span>
              )}
            </dd>
          </dl>
          {status === "outcome_unknown" ? (
            <Notice tone="warn" className="text-xs">
              Outcome unknown: not retried; reconciled by reading the destination's receipt. The submission is never repeated.
            </Notice>
          ) : null}
        </div>
      )}
      {sent ? (
        <p className="text-[11px] text-muted-foreground">
          Sent {sent.decision} with digest <Mono wrap>{sent.payloadDigest}</Mono>
        </p>
      ) : null}
      {error ? <ErrorBox message={error} /> : null}
    </article>
  );
}

export function ApprovalsSection({
  taskId,
  proposals,
  error,
  viewer,
  canDecide,
  running,
  onDecided,
}: {
  taskId: string;
  proposals: ActionProposal[] | null;
  error: string | null;
  viewer: Viewer;
  canDecide: boolean;
  running: boolean;
  onDecided: () => void;
}) {
  if (!proposals && !error) return null;
  const list = proposals ?? [];
  if (list.length === 0 && !error) return null;
  const pending = list.filter((p) => p.status === "pending");
  const decided = list.filter((p) => p.status !== "pending").reverse();
  return (
    <section id="approvals" aria-label="Proposed final actions" className="flex scroll-mt-4 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-base font-semibold tracking-tight">Proposed final actions</h2>
        {pending.length > 0 ? <Badge tone="warn">{pending.length} waiting for review</Badge> : null}
      </div>
      <p className="text-xs text-pretty text-muted-foreground">
        Only forms on a supported destination (airlock-forms-v1) can be submitted, and only after a person approves the exact values. Irreversible actions on any other site are
        unsupported and refused.
      </p>
      {error ? <p className="text-xs text-destructive">Proposals unavailable: {error}</p> : null}
      {[...pending, ...decided].map((p) => (
        <ProposalCard key={p.id} latest={p} taskId={taskId} viewer={viewer} canDecide={canDecide} running={running} onDecided={onDecided} />
      ))}
    </section>
  );
}

/** Unmissable while a task waits for a decision: pinned above the composer. */
export function ReviewBanner({ proposals, eventIds }: { proposals: ActionProposal[] | null; eventIds: string[] }) {
  const now = useTick(1000, true);
  const pending = (proposals ?? []).filter((p) => isOpenProposal(p, now));
  const ids = proposals ? pending.map((p) => p.id) : eventIds;
  if (ids.length === 0) return null;
  const first = pending[0];
  return (
    <div role="alert" className="flex flex-wrap items-center gap-2 rounded-lg border border-warning/50 bg-warning/10 px-3 py-2 text-sm">
      <IconAlertTriangle className="size-4 shrink-0 text-warning" />
      <span className="min-w-0 flex-1 font-medium">
        Waiting for your review: {ids.length === 1 ? "a proposed submission" : `${ids.length} proposed submissions`}
        {first ? (
          <span className="font-normal text-muted-foreground">
            {" "}
            ({first.formId} on {first.destination}, {expiryCountdown(first.expiresAt, now).text})
          </span>
        ) : null}
        . The task is paused until it is decided or expires.
      </span>
      <Button
        size="sm"
        onClick={() => (document.getElementById(`proposal-${ids[0]}`) ?? document.getElementById("approvals"))?.scrollIntoView({ behavior: "smooth", block: "start" })}
      >
        Review
      </Button>
    </div>
  );
}
