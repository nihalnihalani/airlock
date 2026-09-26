import { Phase, type Outcome, type Task } from "@airlock/contracts";
import { OUTCOME_HINT, OUTCOME_LABEL, PHASE_LABEL, STATUS_LABEL } from "../lib/format";
import type { RuntimeTier } from "../lib/eventViews";
import { Badge, type Tone } from "./ui";

const PHASES = Phase.options;

export function OutcomeBadge({ outcome }: { outcome: Outcome }) {
  const tone: Tone =
    outcome === "CANDIDATE_PASSED_CHECKS"
      ? "ok"
      : outcome === "INCONCLUSIVE" || outcome === "STOPPED_LIMIT" || outcome === "NOT_REPRODUCED"
        ? "warn"
        : "bad";
  return (
    <Badge tone={tone} title={OUTCOME_HINT[outcome]}>
      {OUTCOME_LABEL[outcome]}
    </Badge>
  );
}

export function StatusBadge({ status }: { status: Task["status"] }) {
  const tone: Tone =
    status === "running" || status === "queued"
      ? "info"
      : status === "done"
        ? "neutral"
        : status === "cancelling"
          ? "warn"
          : "bad";
  return <Badge tone={tone}>{STATUS_LABEL[status]}</Badge>;
}

export function RuntimeChip({ tier }: { tier: RuntimeTier }) {
  if (!tier.runtime) return <Badge tone="neutral">runtime: {tier.source}</Badge>;
  const tone: Tone = tier.runtime === "kata" ? "ok" : tier.runtime === "runsc" ? "info" : "bad";
  const label = tier.runtime === "kata" ? "Kata" : tier.runtime === "runsc" ? "gVisor (runsc)" : "runc";
  return (
    <span className="runtime-chip">
      <Badge tone={tone} title={`Runtime tier as ${tier.source}`}>
        {label}
      </Badge>
      {tier.devUnsafe || tier.runtime === "runc" ? (
        <Badge tone="bad" title="Plain runc without a guest kernel: local development only, never a deployment.">
          dev-unsafe
        </Badge>
      ) : null}
    </span>
  );
}

export function PhaseRail({ task }: { task: Task }) {
  const currentIndex = PHASES.indexOf(task.phase);
  const terminal = task.status === "done" || task.status === "failed" || task.status === "cancelled";
  return (
    <ol className="phase-rail" aria-label="Phases">
      {PHASES.map((phase, i) => {
        let cls = "phase";
        if (i < currentIndex) cls += " phase-done";
        else if (i === currentIndex) cls += terminal ? " phase-done phase-current" : " phase-current";
        return (
          <li className={cls} key={phase} aria-current={i === currentIndex ? "step" : undefined}>
            <span className="phase-dot" />
            <span className="phase-label">{PHASE_LABEL[phase]}</span>
          </li>
        );
      })}
    </ol>
  );
}
