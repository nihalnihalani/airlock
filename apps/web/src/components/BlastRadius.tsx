import { IconHeartbeat, IconSkull } from "@tabler/icons-react";
import type { BlastRadiusCard } from "@airlock/contracts";
import { formatDateTime, formatDurationMs, formatSeconds, tail } from "../lib/format";
import { Badge, BoolChip, Chip, KeyValue, Mono, Pre } from "./common";

export function BlastRadiusView({ card }: { card: BlastRadiusCard }) {
  const s = card.survived;
  const allSurvived = s.supervisorHealthy && s.hostSentinelUnchanged;
  const teardownClean =
    card.teardown.clean && card.teardown.containersRemaining.length === 0 && card.teardown.volumesRemaining.length === 0;
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
              { key: "guest uname", value: <Mono wrap>{card.died.guestUname || "(empty)"}</Mono> },
              { key: "reason", value: card.died.reason },
            ]}
          />
        </div>
        <div className={`rounded-lg border p-3 ${allSurvived ? "border-success/30 bg-success/5" : "border-destructive/40 bg-destructive/5"}`}>
          <div className={`mb-2 flex items-center gap-1.5 text-sm font-medium ${allSurvived ? "text-success" : "text-destructive"}`}>
            <IconHeartbeat className="size-4" />
            Survived
          </div>
          <KeyValue
            className="grid-cols-[minmax(0,10rem)_minmax(0,1fr)] text-xs"
            rows={[
              { key: "supervisor healthy", value: <BoolChip value={s.supervisorHealthy} /> },
              { key: "host sentinel unchanged", value: <BoolChip value={s.hostSentinelUnchanged} /> },
              { key: "other attempts running", value: String(s.otherAttemptsRunning) },
              { key: "host uptime", value: formatSeconds(s.hostUptimeSeconds) },
            ]}
          />
          <div className="mt-2">
            <Badge tone={allSurvived ? "ok" : "bad"}>{allSurvived ? "host and supervisor unaffected" : "blast radius escaped the sandbox"}</Badge>
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

      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-xs font-medium">Teardown</span>
        <Badge tone={teardownClean ? "ok" : "bad"}>{teardownClean ? "(no sandboxes)" : "teardown incomplete"}</Badge>
        <span className="text-[11px] text-muted-foreground">{formatDateTime(card.teardown.destroyedAt)}</span>
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
