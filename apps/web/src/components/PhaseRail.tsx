import { IconAlertTriangle } from "@tabler/icons-react";
import { Phase, type Outcome, type Task } from "@airlock/contracts";
import { isTerminalStatus, OUTCOME_HINT, OUTCOME_LABEL, outcomeTone, PHASE_LABEL, STATUS_LABEL, statusTone } from "../lib/format";
import type { RuntimeTier } from "../lib/eventViews";
import { cn } from "../lib/utils";
import { Badge, type Tone } from "./common";

const PHASES = Phase.options;

export function OutcomeBadge({ outcome }: { outcome: Outcome }) {
  return (
    <Badge tone={outcomeTone(outcome)} title={OUTCOME_HINT[outcome]}>
      {OUTCOME_LABEL[outcome]}
    </Badge>
  );
}

export function StatusBadge({ status }: { status: Task["status"] }) {
  return <Badge tone={statusTone(status)}>{STATUS_LABEL[status]}</Badge>;
}

/** The runtime tier exactly as inspected (or as the host check selected it before any inspection). */
export function RuntimeChip({ tier }: { tier: RuntimeTier }) {
  if (!tier.runtime) return <Badge tone="neutral">runtime: {tier.source}</Badge>;
  const tone: Tone = tier.runtime === "kata" ? "ok" : tier.runtime === "runsc" ? "info" : "bad";
  const label = tier.runtime === "kata" ? "Kata" : tier.runtime === "runsc" ? "gVisor (runsc)" : "runc";
  return (
    <span className="inline-flex items-center gap-1">
      <Badge tone={tone} title={`Runtime tier as ${tier.source}`}>
        {label}
        {tier.source === "inspected" ? null : <span className="font-normal opacity-70">({tier.source})</span>}
      </Badge>
      {tier.devUnsafe || tier.runtime === "runc" ? (
        <Badge tone="bad" title="Plain runc without a guest kernel: local development only, never a deployment.">
          <IconAlertTriangle />
          dev-unsafe
        </Badge>
      ) : null}
    </span>
  );
}

/** Seven phases as a compact stepper: done, current (live or terminal), to come. */
export function PhaseRail({ task, className }: { task: Task; className?: string }) {
  const currentIndex = PHASES.indexOf(task.phase);
  const terminal = isTerminalStatus(task.status);
  return (
    <ol className={cn("flex min-w-0 items-center gap-1", className)} aria-label="Phases">
      {PHASES.map((phase, i) => {
        const done = i < currentIndex || (i === currentIndex && terminal);
        const current = i === currentIndex;
        return (
          <li key={phase} className="flex min-w-0 flex-1 flex-col gap-1" aria-current={current ? "step" : undefined} title={PHASE_LABEL[phase]}>
            <span
              className={cn(
                "h-1 rounded-full transition-colors duration-300",
                done ? "bg-foreground/70" : current ? "bg-blue-500 animate-pulse motion-reduce:animate-none" : "bg-muted-foreground/20",
              )}
            />
            <span className={cn("hidden truncate text-[10px] sm:block", current ? "font-medium text-foreground" : "text-muted-foreground")}>
              {PHASE_LABEL[phase]}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
