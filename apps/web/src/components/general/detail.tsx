/**
 * The detail pane for a general task: run identity, the three status dimensions, budget used
 * against the profile's limits (browser ops, code runs, sessions), the allowed destinations, every
 * artifact of the task, the model, the runtime/probe checkpoints (unchanged) and the event stream.
 */
import { IconAlertTriangle, IconRefresh } from "@tabler/icons-react";
import type { Artifact, RunEvent, TaskView } from "@airlock/contracts";
import type { StreamStatus } from "../../hooks/useTaskEvents";
import { useDeployment } from "../../hooks/useDeployment";
import type { TaskProfileInfo } from "../../lib/api";
import type { Checkpoints, RuntimeTier } from "../../lib/eventViews";
import { modelCallRows, totalUsage } from "../../lib/eventViews";
import { instanceIds } from "../../lib/evidence";
import { formatDateTime, formatDurationMs, formatTime } from "../../lib/format";
import { generalBudgetRows, profileShortName } from "../../lib/general";
import { CheckpointsPanel } from "../CheckpointsPanel";
import { STREAM_LABEL } from "../detail/task-detail";
import { DiagnosticBadge, InstanceIdRows } from "../Evidence";
import { Chip, KeyValue, Mono, Notice, PanelSection } from "../common";
import { OutcomeBadge, RuntimeChip, StatusBadge } from "../PhaseRail";
import { Button } from "../ui/button";
import { Separator } from "../ui/separator";
import { ArtifactLine } from "./artifacts";
import { StatusDimensions } from "./status";

export function GeneralTaskDetail({
  view,
  events,
  checkpoints,
  tier,
  profile,
  artifacts,
  artifactsError,
  stream,
  lastFetch,
  onReconnect,
  onRefresh,
}: {
  view: TaskView;
  events: readonly RunEvent[];
  checkpoints: Checkpoints;
  tier: RuntimeTier;
  profile: TaskProfileInfo | null;
  artifacts: Artifact[] | null;
  artifactsError: string | null;
  stream: { status: StreamStatus; note: string | null; count: number; dropped: number; malformed: number };
  lastFetch: string | null;
  onReconnect: () => void;
  onRefresh: () => void;
}) {
  const { task } = view;
  const deployment = useDeployment();
  const ids = instanceIds(deployment.availability, checkpoints.host ?? (deployment.host.state === "ok" ? deployment.host.host : null));
  const calls = modelCallRows(events);
  const usage = totalUsage(calls);
  const models = [...new Set(calls.map((c) => c.model).filter((m): m is string => !!m))];
  const hosts = [...new Set(calls.map((c) => c.host))];
  const imagesSent = events.filter((e) => e.kind === "model" && (e.data as Record<string, unknown> | undefined)?.["imageAttached"] === true).length;

  return (
    <div className="flex flex-col pb-10">
      <PanelSection title="Run" aside={<RuntimeChip tier={tier} />} className="pt-1">
        {tier.runtime === "runc" || tier.devUnsafe ? (
          <Notice tone="bad" className="mb-3 flex gap-2 text-xs">
            <IconAlertTriangle className="mt-px size-4 shrink-0" />
            <span>This run executed on plain runc (dev-unsafe): a local development configuration, never a deployment.</span>
          </Notice>
        ) : null}
        <div className="mb-3 flex flex-wrap gap-1.5">
          <StatusBadge status={task.status} />
          {task.outcome ? <OutcomeBadge outcome={task.outcome} /> : null}
          <Chip>{profile?.displayName ?? profileShortName(task.profileId)}</Chip>
          {task.scriptedDriver ? (
            <>
              <DiagnosticBadge />
              <Chip>script {task.scriptedDriver}</Chip>
            </>
          ) : null}
        </div>
        <StatusDimensions task={task} className="mb-3" />
        <KeyValue
          className="text-xs"
          rows={[
            { key: "task", value: <Mono wrap>{task.id}</Mono> },
            { key: "owner", value: task.owner },
            { key: "profile", value: `${task.profileId}${profile ? ` v${profile.version}` : ""}` },
            { key: "attempt", value: task.attemptId ? <Mono wrap>{task.attemptId}</Mono> : <span className="text-muted-foreground">none active (attempts are listed in the thread)</span> },
            { key: "created", value: formatDateTime(task.createdAt) },
            { key: "updated", value: formatDateTime(task.updatedAt) },
          ]}
        />
        {task.error ? <Notice tone="bad" className="mt-3 text-xs whitespace-pre-wrap break-words">Task error: {task.error}</Notice> : null}
      </PanelSection>

      <Separator />
      <PanelSection title="Budget used" aside={<span>{profile ? "used / profile limit" : "charged by the controller"}</span>}>
        <KeyValue className="text-xs" rows={generalBudgetRows(task.budget, profile?.budgets ?? null)} />
        {profile ? (
          <p className="mt-2 text-[11px] text-muted-foreground">
            Wall clock {formatDurationMs(profile.budgets.wallClockMs)} per task, {formatDurationMs(profile.budgets.attemptMs)} per sandbox. Sessions = browser sessions
            ({profile.budgets.browserSessions}) + code sandboxes ({profile.budgets.codeSandboxes}).
          </p>
        ) : null}
      </PanelSection>

      <Separator />
      <PanelSection title="Allowed destinations" aside={<span>{task.egressAllow?.length ?? 0}</span>}>
        {task.egressAllow && task.egressAllow.length > 0 ? (
          <>
            <ul className="flex flex-wrap gap-1">
              {task.egressAllow.map((h) => (
                <li key={h}>
                  <Chip>
                    <Mono>{h}</Mono>
                  </Chip>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-[11px] text-muted-foreground">Only these sites; set by you at creation, never by a page or the model. Enforced by the egress proxy.</p>
          </>
        ) : (
          <p className="text-xs text-muted-foreground">None. {profile && !profile.browser ? "This profile runs offline with no network." : ""}</p>
        )}
      </PanelSection>

      <Separator />
      <PanelSection title="Artifacts" aside={<span>{artifacts ? artifacts.length : "…"}</span>}>
        {artifactsError ? <p className="text-xs text-destructive">{artifactsError}</p> : null}
        {artifacts && artifacts.length === 0 ? <p className="text-xs text-muted-foreground">No artifacts yet.</p> : null}
        {artifacts ? (
          <ul className="flex flex-col gap-2">
            {artifacts.map((a) => (
              <li key={a.id} className="rounded-md bg-muted/50 px-2 py-1.5 dark:bg-background/50">
                <ArtifactLine artifact={a} />
              </li>
            ))}
          </ul>
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
            { key: "images sent", value: `${imagesSent} turn(s) received a screenshot` },
          ]}
        />
      </PanelSection>

      <Separator />
      <PanelSection title="Five checkpoints">
        <CheckpointsPanel cp={checkpoints} ids={ids} />
      </PanelSection>

      <Separator />
      <PanelSection title="Vultr instances" aside={<span>{ids.deployed ? "deployed" : "local"}</span>}>
        <KeyValue className="text-xs" rows={InstanceIdRows(ids, "control plane and the execution host check")} />
      </PanelSection>

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
            { key: "events", value: `${stream.count}${stream.dropped > 0 ? ` (+${stream.dropped} older dropped from view)` : ""}${stream.malformed > 0 ? ` · ${stream.malformed} malformed ignored` : ""}` },
            { key: "view fetched", value: lastFetch ? formatTime(lastFetch) : "—" },
          ]}
        />
      </PanelSection>
    </div>
  );
}
