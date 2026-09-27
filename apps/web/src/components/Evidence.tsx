/**
 * Display pieces for the milestone-2 evidence: Vultr instance ids, host vs guest kernel, the
 * host-wide sandbox listing, cleanup status, candidates, diagnostics and repair-disabled banners.
 * Each restates a projection from lib/evidence.ts; strings are text nodes.
 */
import { IconAlertTriangle, IconFlask, IconServer2 } from "@tabler/icons-react";
import type { ReactNode } from "react";
import type { HostCheck, RuntimeInspection, Task } from "@airlock/contracts";
import {
  candidateRows,
  compareKernels,
  DIAGNOSTIC_LABEL,
  NOT_DEPLOYED,
  type CleanupStatus,
  type InstanceIds,
  type ListingSummary,
} from "../lib/evidence";
import { formatDateTime } from "../lib/format";
import { cn } from "../lib/utils";
import { Badge, Chip, Digest, KeyValue, Mono, Notice } from "./common";

export function InstanceIdRows(ids: InstanceIds, source?: string): { key: string; value: ReactNode }[] {
  const value = (id: string | null) =>
    id ? <Mono wrap>{id}</Mono> : <span className="text-muted-foreground">{NOT_DEPLOYED}</span>;
  return [
    { key: "control instance", value: value(ids.control) },
    { key: "execution instance", value: value(ids.execution) },
    ...(source ? [{ key: "reported by", value: <span className="text-muted-foreground">{source}</span> }] : []),
  ];
}

/** Compact form for the sidebar footer. */
export function InstanceIdsLine({ ids, className }: { ids: InstanceIds; className?: string }) {
  return (
    <div className={cn("flex min-w-0 items-start gap-1.5 text-[11px] leading-4 text-muted-foreground", className)} title="Vultr instance ids reported by the control plane and the execution host">
      <IconServer2 className="mt-px size-3 shrink-0" />
      {ids.deployed ? (
        <span className="min-w-0 break-all">
          control <Mono className="text-foreground/80">{ids.control ?? "not reported"}</Mono> · execution <Mono className="text-foreground/80">{ids.execution ?? "not reported"}</Mono>
        </span>
      ) : (
        <span>Vultr instances: {NOT_DEPLOYED}</span>
      )}
    </div>
  );
}

/** Checkpoint 3: the guest's uname beside the execution host's, and whether the kernels differ. */
export function KernelCompare({ host, inspection }: { host: HostCheck | null; inspection: RuntimeInspection }) {
  const cmp = compareKernels(host?.hostUname, inspection);
  return (
    <div className="flex flex-col gap-1.5 rounded-md bg-muted/50 px-2.5 py-2 dark:bg-background/50">
      <KeyValue
        className="grid-cols-[minmax(0,5.5rem)_minmax(0,1fr)] text-xs"
        rows={[
          { key: "guest", value: <Mono wrap>{inspection.guestUname || "(empty)"}</Mono> },
          { key: "guest host", value: <Mono>{inspection.guestHostname || "(empty)"}</Mono> },
          { key: "host", value: host?.hostUname ? <Mono wrap>{host.hostUname}</Mono> : <span className="text-muted-foreground">not reported</span> },
          { key: "host name", value: host?.hostHostname ? <Mono>{host.hostHostname}</Mono> : <span className="text-muted-foreground">not reported</span> },
        ]}
      />
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone={cmp.tone}>{cmp.verdict === "differs" ? "kernels differ" : cmp.verdict === "same" ? "same kernel" : "not comparable"}</Badge>
        {cmp.hostRelease && cmp.guestRelease ? (
          <span className="text-[11px] text-muted-foreground">
            <Mono>{cmp.guestRelease}</Mono> vs host <Mono>{cmp.hostRelease}</Mono>
          </span>
        ) : null}
      </div>
      <p className="text-[11px] text-muted-foreground">{cmp.note}</p>
    </div>
  );
}

/** The host-wide listing: "(no sandboxes)" only when it exists and is empty; otherwise what remains. */
export function HostListingView({ summary }: { summary: ListingSummary }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs text-muted-foreground">host-wide</span>
        <Badge tone={summary.tone}>{summary.label}</Badge>
        {summary.listedAt ? <span className="text-[11px] text-muted-foreground">{formatDateTime(summary.listedAt)}</span> : null}
      </div>
      {summary.state === "remaining" ? (
        <ul className="flex flex-col gap-0.5 text-xs">
          {summary.containers.map((c) => (
            <li key={`c-${c.name}`} className="break-all">
              container <Mono>{c.name}</Mono>
              {c.role ? <span className="text-muted-foreground"> · {c.role}</span> : null}
              {c.taskId ? <span className="text-muted-foreground"> · task {c.taskId}</span> : null}
              {c.state ? <span className="text-muted-foreground"> · {c.state}</span> : null}
            </li>
          ))}
          {summary.volumes.map((v) => (
            <li key={`v-${v}`} className="break-all">
              volume <Mono>{v}</Mono>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function CleanupBadge({ cleanup }: { cleanup: CleanupStatus }) {
  if (cleanup.state === "none") return null;
  return (
    <Badge tone={cleanup.tone} title={cleanup.detail ?? "Author-sandbox teardown, from the lifecycle events"}>
      {cleanup.label}
    </Badge>
  );
}

export function DiagnosticBadge({ className }: { className?: string }) {
  return (
    <Badge tone="warn" className={cn(className)} title="A scripted model replays a fixed script. No model is called and it is never a live repair.">
      <IconFlask />
      {DIAGNOSTIC_LABEL}
    </Badge>
  );
}

export function RepairDisabledBanner({ reason, className }: { reason: string; className?: string }) {
  return (
    <Notice tone="warn" className={cn("flex gap-2 text-xs", className)}>
      <IconAlertTriangle className="mt-px size-4 shrink-0 text-warning" />
      <span>
        <span className="font-medium text-foreground">Repair disabled for this case.</span> {reason} It reproduces the issue and
        measures the baseline only; no repair was attempted.
      </span>
    </Notice>
  );
}

export function CandidatesList({ task, onOpenRecord }: { task: Task; onOpenRecord?: () => void }) {
  const rows = candidateRows(task);
  if (rows.length === 0) return <p className="text-xs text-muted-foreground">No candidate sealed yet.</p>;
  return (
    <ol className="flex flex-col gap-1.5">
      {rows.map((r) => (
        <li key={`${r.attemptId}-${r.index}`} className="flex flex-wrap items-center gap-1.5 rounded-md bg-muted/50 px-2 py-1.5 text-xs dark:bg-background/50">
          <span className="font-medium">#{r.index}</span>
          <Mono className="text-muted-foreground">{r.attemptId}</Mono>
          <Badge tone={r.tone}>{r.outcome}</Badge>
          <Chip>
            <Digest value={r.candidateDigest} />
          </Chip>
          {r.verificationRecordId ? (
            onOpenRecord ? (
              <button type="button" className="font-mono text-[11px] underline underline-offset-4 hover:text-foreground" onClick={onOpenRecord} title="Open the verification record in the details pane">
                {r.verificationRecordId}
              </button>
            ) : (
              <Mono className="text-[11px]">{r.verificationRecordId}</Mono>
            )
          ) : null}
          {r.current ? <span className="text-[11px] text-muted-foreground">(current)</span> : null}
        </li>
      ))}
    </ol>
  );
}
