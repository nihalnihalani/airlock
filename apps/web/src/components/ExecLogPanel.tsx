import type { ExecResult, RunEvent } from "@airlock/contracts";
import { execRows, type ExecRow } from "../lib/eventViews";
import { formatDurationMs, formatTime, tail } from "../lib/format";
import { Badge, Chip, Mono, Pre, Section, type Tone } from "./ui";

function statusTone(status: ExecResult["status"]): Tone {
  switch (status) {
    case "succeeded":
      return "ok";
    case "failed":
      return "bad";
    case "timed_out":
    case "interrupted":
      return "warn";
    case "refused":
      return "bad";
  }
}

function Stream({ label, text }: { label: string; text: string }) {
  if (text.length === 0) return null;
  const t = tail(text);
  return (
    <div className="stream">
      <span className="stream-label">
        {label}
        {t.clipped ? " (tail)" : ""}
      </span>
      <Pre className="pre-small">{t.text}</Pre>
    </div>
  );
}

function Row({ row }: { row: ExecRow }) {
  const r = row.result;
  return (
    <li className="list-item">
      <div className="list-head">
        <span className="muted mono-small">
          #{row.seq} {formatTime(row.at)}
        </span>
        <Chip>{row.kind}</Chip>
        {row.tool ? <Chip>{row.tool}</Chip> : null}
        <strong>{row.title}</strong>
        {r ? (
          <>
            <Badge tone={statusTone(r.status)}>{r.status}</Badge>
            <Chip>exit {r.exitCode === null ? "—" : r.exitCode}</Chip>
            <Chip>{formatDurationMs(r.durationMs)}</Chip>
            {r.truncated ? <Badge tone="warn">output truncated</Badge> : null}
            {r.timedOut ? <Badge tone="warn">timed out</Badge> : null}
          </>
        ) : row.statusHint ? (
          <Chip>{row.statusHint}</Chip>
        ) : null}
      </div>
      {row.command ? (
        <div className="command">
          <span className="stream-label">command</span>
          <Mono wrap>{row.command}</Mono>
        </div>
      ) : null}
      {row.path ? (
        <div className="command">
          <span className="stream-label">path</span>
          <Mono>{row.path}</Mono>
        </div>
      ) : null}
      {!row.command && !row.path && row.detail.length > 0 ? <Pre className="pre-small">{tail(row.detail).text}</Pre> : null}
      {r ? (
        <>
          <Stream label="stdout" text={r.stdout} />
          <Stream label="stderr" text={r.stderr} />
        </>
      ) : null}
    </li>
  );
}

export function ExecLogPanel({ events }: { events: readonly RunEvent[] }) {
  const rows = execRows(events);
  return (
    <Section title="Tool / exec log" aside={<span className="muted">{rows.length} entries</span>}>
      {rows.length === 0 ? (
        <p className="muted">No tool calls or sandbox executions recorded yet.</p>
      ) : (
        <ul className="list">
          {rows.map((row) => (
            <Row row={row} key={row.seq} />
          ))}
        </ul>
      )}
    </Section>
  );
}
