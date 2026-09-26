import type { BlastRadiusCard } from "@airlock/contracts";
import { formatDateTime, formatDurationMs, formatSeconds, tail } from "../lib/format";
import { Badge, BoolChip, Chip, KeyValue, Mono, Pre } from "./ui";

export function BlastRadiusView({ card }: { card: BlastRadiusCard }) {
  const s = card.survived;
  const allSurvived = s.supervisorHealthy && s.hostSentinelUnchanged;
  const teardownClean =
    card.teardown.clean && card.teardown.containersRemaining.length === 0 && card.teardown.volumesRemaining.length === 0;
  return (
    <div className="blast">
      <div className="blast-cols">
        <div className="blast-col blast-died">
          <h3>Died</h3>
          <KeyValue
            rows={[
              { key: "container", value: <Mono>{card.died.container}</Mono> },
              { key: "runtime", value: <Chip tone={card.died.runtime === "runc" ? "bad" : "ok"}>{card.died.runtime}</Chip> },
              { key: "guest uname", value: <Mono wrap>{card.died.guestUname || "(empty)"}</Mono> },
              { key: "reason", value: card.died.reason },
            ]}
          />
        </div>
        <div className="blast-col blast-survived">
          <h3>Survived</h3>
          <KeyValue
            rows={[
              { key: "supervisor healthy", value: <BoolChip value={s.supervisorHealthy} /> },
              { key: "host sentinel unchanged", value: <BoolChip value={s.hostSentinelUnchanged} /> },
              { key: "other attempts running", value: String(s.otherAttemptsRunning) },
              { key: "host uptime", value: formatSeconds(s.hostUptimeSeconds) },
            ]}
          />
          <Badge tone={allSurvived ? "ok" : "bad"}>{allSurvived ? "host and supervisor unaffected" : "blast radius escaped the sandbox"}</Badge>
        </div>
      </div>

      <div className="list-head">
        <strong>Execution</strong>
        <Chip>{card.exec.status}</Chip>
        <Chip>exit {card.exec.exitCode === null ? "—" : card.exec.exitCode}</Chip>
        <Chip>{formatDurationMs(card.exec.durationMs)}</Chip>
        {card.exec.timedOut ? <Badge tone="warn">timed out</Badge> : null}
        {card.exec.truncated ? <Badge tone="warn">output truncated</Badge> : null}
        <Chip>{card.inspection.runtime}</Chip>
        {card.inspection.devUnsafe ? <Badge tone="bad">dev-unsafe</Badge> : null}
        <Badge tone={card.inspection.allPassed ? "ok" : "bad"}>
          {card.inspection.allPassed ? "inspection passed" : "inspection FAILED"}
        </Badge>
      </div>
      {card.exec.stdout.length > 0 ? (
        <div className="stream">
          <span className="stream-label">stdout (tail)</span>
          <Pre className="pre-small">{tail(card.exec.stdout, 20).text}</Pre>
        </div>
      ) : null}
      {card.exec.stderr.length > 0 ? (
        <div className="stream">
          <span className="stream-label">stderr (tail)</span>
          <Pre className="pre-small">{tail(card.exec.stderr, 20).text}</Pre>
        </div>
      ) : null}

      <div className="list-head">
        <strong>Teardown</strong>
        <Badge tone={teardownClean ? "ok" : "bad"}>{teardownClean ? "(no sandboxes)" : "teardown incomplete"}</Badge>
        <span className="muted">{formatDateTime(card.teardown.destroyedAt)}</span>
      </div>
      {!teardownClean ? (
        <ul className="plain-list">
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
      <p className="muted">
        operation <Mono>{card.operationId}</Mono> · container <Mono>{card.container}</Mono>
      </p>
    </div>
  );
}
