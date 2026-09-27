import { IconHeartbeat, IconSkull } from "@tabler/icons-react";
import type { BlastRadiusCard } from "@airlock/contracts";
import { attemptTeardownClean, blastContained, hostListingSummary, siblingRows, workspaceSummary } from "../lib/evidence";
import { formatDateTime, formatDurationMs, formatSeconds, tail } from "../lib/format";
import { Badge, BoolChip, Chip, KeyValue, Mono, Pre } from "./common";
import { HostListingView } from "./Evidence";

export function BlastRadiusView({ card }: { card: BlastRadiusCard }) {
  const s = card.survived;
  const allSurvived = blastContained(card);
  const teardownClean = attemptTeardownClean(card.teardown);
  const workspace = workspaceSummary(card.workspace);
  const siblings = siblingRows(s);
  const listing = hostListingSummary(card.teardown);
  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="rounded-lg border border-destructive/25 bg-destructive/5 p-3">
          <div className="mb-2 flex items-center gap-1.5 text-sm font-medium text-destructive">
            <IconSkull className="size-4" />
            Died
          </div>
          <KeyValue
            className="grid-cols-[minmax(0,6rem)_minmax(0,1fr)] text-xs"
            rows={[
              { key: "container", value: <Mono wrap>{card.died.container}</Mono> },
              { key: "runtime", value: <Badge tone={card.died.runtime === "runc" ? "bad" : "ok"}>{card.died.runtime}</Badge> },
              { key: "guest kernel", value: <Mono wrap>{card.died.guestUname || "(empty)"}</Mono> },
              { key: "reason", value: card.died.reason },
              { key: "workspace files", value: <Badge tone={workspace.tone}>{workspace.text}</Badge> },
            ]}
          />
        </div>
        <div className={`rounded-lg border p-3 ${allSurvived ? "border-success/30 bg-success/5" : "border-destructive/40 bg-destructive/5"}`}>
          <div className={`mb-2 flex items-center gap-1.5 text-sm font-medium ${allSurvived ? "text-success" : "text-destructive"}`}>
            <IconHeartbeat className="size-4" />
            Survived
          </div>
          <KeyValue
            className="grid-cols-[minmax(0,7.5rem)_minmax(0,1fr)] text-xs"
            rows={[
              {
                key: "control plane",
                value: s.controlPlane ? (
                  <span className="flex flex-wrap items-center gap-1">
                    <BoolChip value={s.controlPlane.healthyBefore} yes="healthy before" no="unhealthy before" />
                    <BoolChip value={s.controlPlane.healthyAfter} yes="healthy after" no="unhealthy after" />
                  </span>
                ) : (
                  <span className="text-muted-foreground">not recorded</span>
                ),
              },
              { key: "supervisor healthy", value: <BoolChip value={s.supervisorHealthy} /> },
              { key: "host sentinel unchanged", value: <BoolChip value={s.hostSentinelUnchanged} /> },
              { key: "host uptime", value: formatSeconds(s.hostUptimeSeconds) },
              {
                key: "sibling attempts",
                value:
                  siblings === null ? (
                    <span>
                      {s.otherAttemptsRunning} running <span className="text-muted-foreground">(per-attempt check not recorded)</span>
                    </span>
                  ) : siblings.length === 0 ? (
                    <span className="text-muted-foreground">none were running</span>
                  ) : (
                    <ul className="flex flex-col gap-0.5">
                      {siblings.map((r) => (
                        <li key={r.attemptId} className="flex flex-wrap items-center gap-1">
                          <Mono className="break-all">{r.attemptId}</Mono>
                          <span className="text-muted-foreground">task {r.taskId}</span>
                          <Badge tone={r.survived ? "ok" : "bad"} className="h-auto whitespace-normal">
                            {r.runningBefore ? "running" : "stopped"} → {r.runningAfter ? "running" : "stopped"}
                          </Badge>
                        </li>
                      ))}
                    </ul>
                  ),
              },
            ]}
          />
          <div className="mt-2">
            <Badge tone={allSurvived ? "ok" : "bad"} className="h-auto py-0.5 whitespace-normal">{allSurvived ? "everything checked outside the sandbox survived" : "something outside the sandbox did not survive"}</Badge>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1">
        <span className="mr-1 text-xs font-medium">Execution</span>
        <Badge tone={card.exec.status === "succeeded" ? "ok" : card.exec.status === "failed" ? "warn" : "bad"}>{card.exec.status}</Badge>
        <Chip>exit {card.exec.exitCode === null ? "—" : card.exec.exitCode}</Chip>
        <Chip>{formatDurationMs(card.exec.durationMs)}</Chip>
        {card.exec.timedOut ? <Badge tone="warn">timed out</Badge> : null}
        {card.exec.truncated ? <Badge tone="warn">output truncated</Badge> : null}
        <Chip tone={card.inspection.runtime === "runc" ? "bad" : "ok"}>{card.inspection.runtime}</Chip>
        {card.inspection.devUnsafe ? <Badge tone="bad">dev-unsafe</Badge> : null}
        <Badge tone={card.inspection.allPassed ? "ok" : "bad"}>{card.inspection.allPassed ? "inspection passed" : "inspection FAILED"}</Badge>
      </div>
      {card.exec.stdout.length > 0 ? (
        <div className="flex flex-col gap-1">
          <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">stdout · tail</span>
          <Pre className="max-h-48">{tail(card.exec.stdout, 20).text}</Pre>
        </div>
      ) : null}
      {card.exec.stderr.length > 0 ? (
        <div className="flex flex-col gap-1">
          <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">stderr · tail</span>
          <Pre className="max-h-48">{tail(card.exec.stderr, 20).text}</Pre>
        </div>
      ) : null}

      <div className="flex flex-col gap-1.5 rounded-lg border border-border p-2.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-xs font-medium">Destroy</span>
          <Badge tone={teardownClean ? "ok" : "bad"}>{teardownClean ? "sandbox and workspace destroyed" : "teardown incomplete"}</Badge>
          <span className="text-[11px] text-muted-foreground">{formatDateTime(card.teardown.destroyedAt)}</span>
        </div>
        <HostListingView summary={listing} />
      </div>
      {!teardownClean ? (
        <ul className="flex flex-col gap-0.5 text-xs">
          {card.teardown.containersRemaining.map((c) => (
            <li key={`c-${c}`}>
              container <Mono>{c}</Mono>
            </li>
          ))}
          {card.teardown.volumesRemaining.map((v) => (
            <li key={`v-${v}`}>
              volume <Mono>{v}</Mono>
            </li>
          ))}
        </ul>
      ) : null}
      <p className="text-[11px] break-all text-muted-foreground">
        operation <Mono>{card.operationId}</Mono> · container <Mono>{card.container}</Mono>
      </p>
    </div>
  );
}
