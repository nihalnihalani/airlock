/**
 * The three status dimensions of a general task, never merged (40 §6): Workflow (status/phase),
 * Result (outcome), Cleanup (Task.cleanup). The environment is described as gone only when cleanup
 * is `confirmed`.
 */
import type { Task } from "@airlock/contracts";
import { cleanupView, resultView, workflowView } from "../../lib/general";
import { formatDateTime } from "../../lib/format";
import { cn } from "../../lib/utils";
import { Badge } from "../common";

export function CleanupDimensionBadge({ task }: { task: Pick<Task, "cleanup" | "status"> }) {
  const c = cleanupView(task.cleanup, task.status);
  return (
    <Badge tone={c.tone} title={`${c.sentence}${c.detail ? ` ${c.detail}` : ""}`}>
      {c.label}
    </Badge>
  );
}

export function StatusDimensions({ task, className, compact = false }: { task: Task; className?: string; compact?: boolean }) {
  const w = workflowView(task);
  const r = resultView(task);
  const c = cleanupView(task.cleanup, task.status);
  const rows = [
    { key: "Workflow", badge: <Badge tone={w.tone}>{w.label}</Badge>, note: compact ? null : "Where the worker is." },
    { key: "Result", badge: <Badge tone={r.tone} title={r.hint ?? undefined}>{r.label}</Badge>, note: compact ? null : r.hint ?? "Decided by the controller's completion checks, never by the model." },
    {
      key: "Cleanup",
      badge: <Badge tone={c.tone}>{c.label}</Badge>,
      note: compact ? null : `${c.sentence}${c.detail ? ` ${c.detail}` : ""}${task.cleanup?.at ? ` (${formatDateTime(task.cleanup.at)})` : ""}`,
    },
  ];
  if (compact) {
    return (
      <span className={cn("flex flex-wrap items-center gap-1.5 text-xs", className)} aria-label="Status dimensions">
        {rows.map((row) => (
          <span key={row.key} className="inline-flex items-center gap-1">
            <span className="text-muted-foreground">{row.key}</span>
            {row.badge}
          </span>
        ))}
      </span>
    );
  }
  return (
    <dl className={cn("grid grid-cols-[5rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-xs", className)} aria-label="Status dimensions">
      {rows.map((row) => (
        <div key={row.key} className="contents">
          <dt className="pt-0.5 text-muted-foreground">{row.key}</dt>
          <dd className="flex min-w-0 flex-wrap items-center gap-1.5">
            {row.badge}
            {row.note ? <span className="min-w-0 text-pretty text-muted-foreground">{row.note}</span> : null}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** The top of a general task page: profile, goal, allowed destinations, inputs and the three dimensions. */
export function GeneralTaskSummary({
  task,
  profileName,
  inputNames,
}: {
  task: Task;
  profileName: string;
  inputNames: string[];
}) {
  const egress = task.egressAllow ?? [];
  return (
    <section aria-label="Task" className="mb-5 flex flex-col gap-3 rounded-xl border border-border bg-card p-4 dark:border-transparent">
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        <Badge tone="info">general task</Badge>
        <span className="font-medium">{profileName}</span>
        <span className="font-mono text-muted-foreground">{task.profileId}</span>
      </div>
      <dl className="grid grid-cols-[5rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-xs">
        <dt className="text-muted-foreground">Allowed sites</dt>
        <dd className="flex min-w-0 flex-wrap items-center gap-1">
          {egress.length === 0 ? (
            <span className="text-muted-foreground">none: this profile has no network</span>
          ) : (
            egress.map((h) => (
              <span key={h} className="rounded-md border border-border px-1.5 font-mono text-[11px]">
                {h}
              </span>
            ))
          )}
          {egress.length > 0 ? <span className="w-full text-[11px] text-muted-foreground">Only these sites; set by you, never by a page or the model.</span> : null}
        </dd>
        <dt className="text-muted-foreground">Inputs</dt>
        <dd className="min-w-0 break-words">{inputNames.length ? inputNames.join(", ") : <span className="text-muted-foreground">none</span>}</dd>
      </dl>
      <StatusDimensions task={task} />
    </section>
  );
}
