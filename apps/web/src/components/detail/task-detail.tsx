/**
 * The task's right-hand detail pane: runtime tier, model totals, the five checkpoints, baseline vs
 * candidate, the sealed manifest, and (only for CANDIDATE_PASSED_CHECKS) the Report Export preview
 * and the download. Every value is a field of the TaskView or a RunEvent; nothing is computed into
 * a verdict here.
 */
import { IconAlertTriangle, IconRefresh } from "@tabler/icons-react";
import type { RunEvent, TaskView } from "@airlock/contracts";
import type { StreamStatus } from "../../hooks/useTaskEvents";
import type { Checkpoints, RuntimeTier } from "../../lib/eventViews";
import { modelCallRows, totalUsage } from "../../lib/eventViews";
import { formatDateTime, formatTime } from "../../lib/format";
import { useDeployment } from "../../hooks/useDeployment";
import { budgetRows, instanceIds } from "../../lib/evidence";
import { CaseTable } from "../CaseTable";
import { CandidatesList, DiagnosticBadge, InstanceIdRows, RepairDisabledBanner } from "../Evidence";
import { CheckpointsPanel } from "../CheckpointsPanel";
import { Badge, Chip, Digest, KeyValue, Mono, Notice, PanelSection } from "../common";
import { ExportPanel } from "../ExportPanel";
import { OutcomeBadge, RuntimeChip, StatusBadge } from "../PhaseRail";
import { PreviewForm } from "../PreviewForm";
import { Button } from "../ui/button";
import { Separator } from "../ui/separator";

export const STREAM_LABEL: Record<StreamStatus, string> = {
  idle: "stream idle",
  connecting: "connecting",
  open: "live",
  reconnecting: "reconnecting",
  closed: "disconnected",
  ended: "stream ended",
  unsupported: "no EventSource",
};

function distinct(values: (string | null)[]): string[] {
  return [...new Set(values.filter((v): v is string => v !== null && v.length > 0))];
}

export function TaskDetail({
  view,
  events,
  checkpoints,
  tier,
  stream,
  lastFetch,
  canOperate,
  onReconnect,
  onRefresh,
}: {
  view: TaskView;
  events: readonly RunEvent[];
  checkpoints: Checkpoints;
  tier: RuntimeTier;
  stream: { status: StreamStatus; note: string | null; count: number; dropped: number; malformed: number };
  lastFetch: string | null;
  canOperate: boolean;
  onReconnect: () => void;
  onRefresh: () => void;
}) {
  const { task } = view;
  const deployment = useDeployment();
  const ids = instanceIds(deployment.availability, checkpoints.host ?? (deployment.host.state === "ok" ? deployment.host.host : null));
  const calls = modelCallRows(events);
  const usage = totalUsage(calls);
  const models = distinct(calls.map((c) => c.model));
  const hosts = distinct(calls.map((c) => c.host));
  const titles = new Map((view.cases ?? []).map((c) => [c.id, c.title]));
  const passed = task.outcome === "CANDIDATE_PASSED_CHECKS";
  const showArtifacts = passed && task.candidateDigest !== undefined && task.verificationRecordId !== undefined;

  return (
    <div className="flex flex-col pb-10">
      <PanelSection title="Run" aside={<RuntimeChip tier={tier} />} className="pt-1">
        {tier.runtime === "runc" || tier.devUnsafe ? (
          <Notice tone="bad" className="mb-3 flex gap-2 text-xs">
            <IconAlertTriangle className="mt-px size-4 shrink-0" />
            <span>
              This run executed on plain runc (dev-unsafe). That is a local development configuration, never a deployment; gVisor
              is the floor and Kata the target.
            </span>
          </Notice>
        ) : null}
        <div className="mb-3 flex flex-wrap gap-1.5">
          <StatusBadge status={task.status} />
          {task.outcome ? <OutcomeBadge outcome={task.outcome} /> : null}
          <Chip>{task.profileId}</Chip>
          {task.scriptedDriver ? (
            <>
              <DiagnosticBadge />
              <Chip>script {task.scriptedDriver}</Chip>
            </>
          ) : null}
        </div>
        {task.repairDisabledReason ? <RepairDisabledBanner reason={task.repairDisabledReason} className="mb-3" /> : null}
        <KeyValue
          className="text-xs"
          rows={[
            { key: "task", value: <Mono wrap>{task.id}</Mono> },
            { key: "owner", value: task.owner },
            { key: "attempt", value: task.attemptId ? <Mono wrap>{task.attemptId}</Mono> : <span className="text-muted-foreground">none yet</span> },
            { key: "generation", value: String(task.generation) },
            {
              key: "candidate digest",
              value: task.candidateDigest ? <Digest value={task.candidateDigest} /> : <span className="text-muted-foreground">not sealed</span>,
            },
            { key: "created", value: formatDateTime(task.createdAt) },
            { key: "updated", value: formatDateTime(task.updatedAt) },
          ]}
        />
        {task.error ? <Notice tone="bad" className="mt-3 text-xs whitespace-pre-wrap break-words">Task error: {task.error}</Notice> : null}
      </PanelSection>

      <Separator />
      <PanelSection title="Budget used" aside={<span>charged by the controller</span>}>
        <KeyValue className="text-xs" rows={budgetRows(task.budget)} />
      </PanelSection>

      <Separator />
      <PanelSection title="Candidates" aside={<span>one per repair attempt</span>}>
        <CandidatesList task={task} />
      </PanelSection>

      <Separator />
      <PanelSection title="Vultr instances" aside={<span>{ids.deployed ? "deployed" : "local"}</span>}>
        <KeyValue className="text-xs" rows={InstanceIdRows(ids, "control plane (/api/repair-availability) and the execution host check")} />
        {!ids.deployed ? (
          <p className="mt-2 text-[11px] text-muted-foreground">No Vultr instance id was reported: this stack is not a Vultr deployment.</p>
        ) : null}
      </PanelSection>

      <Separator />
      <PanelSection title="Model" aside={<span>{usage.calls} turns</span>}>
        <KeyValue
          className="text-xs"
          rows={[
            { key: "model", value: models.length > 0 ? models.join(", ") : <span className="text-muted-foreground">no calls yet</span> },
            { key: "host", value: hosts.length > 0 ? hosts.join(", ") : <span className="text-muted-foreground">—</span> },
            { key: "tokens", value: `${usage.input.toLocaleString()} in / ${usage.output.toLocaleString()} out` },
          ]}
        />
        <p className="mt-2 text-[11px] text-muted-foreground">
          {hosts.length > 0 && hosts.every((h) => /^scripted/i.test(h))
            ? "Scripted diagnostic: no model was called. Live runs call Vultr Serverless Inference only."
            : "All runtime model calls go through Vultr Serverless Inference."}
        </p>
      </PanelSection>

      {showArtifacts && task.candidateDigest && task.verificationRecordId ? (
        <>
          <Separator />
          <PanelSection title="Report Export preview">
            <PreviewForm taskId={task.id} candidateDigest={task.candidateDigest} />
          </PanelSection>
          <Separator />
          <PanelSection title="Download">
            <ExportPanel taskId={task.id} candidateDigest={task.candidateDigest} verificationRecordId={task.verificationRecordId} canExport={canOperate} />
          </PanelSection>
        </>
      ) : null}

      <Separator />
      <PanelSection title="Five checkpoints">
        <CheckpointsPanel cp={checkpoints} ids={ids} />
      </PanelSection>

      <Separator />
      <PanelSection title="Baseline vs candidate">
        <CaseTable baseline={view.baseline} verification={view.verification} titles={titles} />
      </PanelSection>

      {view.manifest ? (
        <>
          <Separator />
          <PanelSection title="Sealed source manifest">
            <KeyValue
              className="text-xs"
              rows={[
                { key: "baseline commit", value: <Mono wrap>{view.manifest.baselineCommit}</Mono> },
                { key: "tree digest", value: <Digest value={view.manifest.baselineTreeDigest} /> },
              ]}
            />
            {view.manifest.replacements.length === 0 ? (
              <p className="mt-2 text-xs text-muted-foreground">No replacement files.</p>
            ) : (
              <ul className="mt-2 flex flex-col gap-1">
                {view.manifest.replacements.map((r) => (
                  <li key={r.path} className="flex flex-wrap items-center gap-1.5 rounded-md bg-muted/50 px-2 py-1.5 text-xs dark:bg-background/50">
                    <Mono wrap className="text-foreground">
                      {r.path}
                    </Mono>
                    <span className="text-muted-foreground">{r.byteLength.toLocaleString()} bytes</span>
                    <Digest value={r.sha256} />
                  </li>
                ))}
              </ul>
            )}
          </PanelSection>
        </>
      ) : null}

      <Separator />
      <PanelSection
        title="Event stream"
        aside={
          <>
            <Button size="icon-xs" variant="ghost" aria-label="Refresh the task view" title="Refresh the task view" onClick={onRefresh}>
              <IconRefresh />
            </Button>
            {stream.status === "closed" || stream.status === "ended" ? (
              <Button size="xs" variant="outline" onClick={onReconnect}>
                Reconnect
              </Button>
            ) : null}
          </>
        }
      >
        <KeyValue
          className="text-xs"
          rows={[
            { key: "stream", value: STREAM_LABEL[stream.status] },
            {
              key: "events",
              value: `${stream.count}${stream.dropped > 0 ? ` (+${stream.dropped} older dropped from view)` : ""}${stream.malformed > 0 ? ` · ${stream.malformed} malformed ignored` : ""}`,
            },
            { key: "view fetched", value: lastFetch ? formatTime(lastFetch) : "—" },
          ]}
        />
        {stream.note && stream.status !== "open" ? <p className="mt-2 text-[11px] text-muted-foreground">{stream.note}</p> : null}
      </PanelSection>
    </div>
  );
}
