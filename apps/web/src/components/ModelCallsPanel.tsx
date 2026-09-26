import { useState } from "react";
import type { RunEvent } from "@airlock/contracts";
import { modelCallRows, totalUsage } from "../lib/eventViews";
import { formatDurationMs, formatTime } from "../lib/format";
import { Badge, Chip, Mono, Pre, Section } from "./ui";

const DETAIL_PREVIEW = 400;

export function ModelCallsPanel({ events }: { events: readonly RunEvent[] }) {
  const rows = modelCallRows(events);
  const usage = totalUsage(rows);
  const [open, setOpen] = useState<Set<number>>(() => new Set());
  const toggle = (seq: number) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(seq)) next.delete(seq);
      else next.add(seq);
      return next;
    });

  return (
    <Section
      title="Model calls"
      aside={
        <span className="muted">
          {usage.calls} calls · {usage.input.toLocaleString()} in / {usage.output.toLocaleString()} out tokens
        </span>
      }
    >
      {rows.length === 0 ? (
        <p className="muted">No model calls yet. All runtime model calls go through Vultr Serverless Inference.</p>
      ) : (
        <ul className="list">
          {rows.map((row) => {
            const expanded = open.has(row.seq);
            const detail = expanded || row.detail.length <= DETAIL_PREVIEW ? row.detail : `${row.detail.slice(0, DETAIL_PREVIEW)}…`;
            return (
              <li className="list-item" key={row.seq}>
                <div className="list-head">
                  <span className="muted mono-small">
                    #{row.seq} {formatTime(row.at)}
                  </span>
                  <strong>{row.title}</strong>
                  {row.isError ? <Badge tone="bad">error</Badge> : null}
                  <Chip>{row.model ?? "model: unknown"}</Chip>
                  <Chip tone="info">{row.host}</Chip>
                  <Chip>
                    {row.inputTokens ?? "?"} in / {row.outputTokens ?? "?"} out
                  </Chip>
                  {row.durationMs !== null ? <Chip>{formatDurationMs(row.durationMs)}</Chip> : null}
                  {row.toolCalls.length > 0 ? (
                    <span className="chips">
                      {row.toolCalls.map((name, i) => (
                        <Chip tone="neutral" key={`${name}-${i}`}>
                          <Mono>{name}</Mono>
                        </Chip>
                      ))}
                    </span>
                  ) : null}
                </div>
                {row.detail.length > 0 ? <Pre className="pre-small">{detail}</Pre> : null}
                {row.detail.length > DETAIL_PREVIEW ? (
                  <button type="button" className="btn btn-link" onClick={() => toggle(row.seq)}>
                    {expanded ? "Show less" : `Show all (${row.detail.length.toLocaleString()} chars)`}
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}
