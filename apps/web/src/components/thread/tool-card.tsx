/**
 * One tool call, drawn like OpenBot's `ToolLine` (components/channels/tool-line.tsx): a single line
 * with a disclosure, the detail behind it. Airlock's detail is the recorded, bounded execution:
 * command, exit code, duration, stdout/stderr tails and the truncation/timeout flags.
 */
import {
  IconCircleCheck,
  IconEdit,
  IconFileDescription,
  IconFilePlus,
  IconPlayerPlay,
  IconSend,
  IconTerminal2,
  IconTool,
} from "@tabler/icons-react";
import type { ComponentType } from "react";
import { formatDurationMs, tail } from "../../lib/format";
import type { ToolCall, ToolState } from "../../lib/thread";
import { cn } from "../../lib/utils";
import { Badge, Chip, Mono, Pre, type Tone } from "../common";

const LABEL: Record<string, string> = {
  run: "Ran",
  read_file: "Read",
  edit_file: "Edited",
  write_file: "Wrote",
  submit_candidate: "Submitted the candidate",
  baseline: "Baseline invocation",
  candidate: "Candidate invocation",
};

const ICON: Record<string, ComponentType<{ className?: string }>> = {
  run: IconTerminal2,
  read_file: IconFileDescription,
  edit_file: IconEdit,
  write_file: IconFilePlus,
  submit_candidate: IconSend,
  baseline: IconPlayerPlay,
  candidate: IconCircleCheck,
};

const STATE_BADGE: Record<Exclude<ToolState, "ok" | "failed">, { label: string; tone: Tone }> = {
  refused: { label: "refused", tone: "bad" },
  rejected: { label: "rejected", tone: "warn" },
  error: { label: "error", tone: "bad" },
};

function Stream({ label, text }: { label: string; text: string }) {
  if (text.length === 0) return null;
  const t = tail(text, 40, 8000);
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
        {label}
        {t.clipped ? " · tail" : ""}
      </span>
      <Pre className="max-h-64">{t.text}</Pre>
    </div>
  );
}

export function ToolCard({ call }: { call: ToolCall }) {
  const Icon = ICON[call.name] ?? IconTool;
  const label = LABEL[call.name] ?? call.name;
  const r = call.result;
  const exitTone: Tone = r ? (r.status === "succeeded" ? "neutral" : r.status === "failed" ? "warn" : "bad") : "neutral";
  const stateBadge = call.state === "ok" || call.state === "failed" ? null : STATE_BADGE[call.state];
  const showDetail = call.detail.length > 0 && (!r || call.name === "submit_candidate" || call.state !== "ok");

  return (
    <details className="tool-line group min-w-0 rounded-lg border border-border bg-card text-sm dark:border-transparent dark:bg-card/60">
      <summary className="flex min-h-9 cursor-pointer list-none items-center gap-2 rounded-lg px-2.5 py-1.5 select-none hover:bg-foreground/[0.03] [&::-webkit-details-marker]:hidden">
        <span aria-hidden className="tool-line-chevron w-2.5 shrink-0 text-xs text-muted-foreground transition-transform">
          ▸
        </span>
        <Icon className={cn("size-4 shrink-0", stateBadge ? "text-destructive" : "text-muted-foreground")} />
        <span className="shrink-0 font-medium text-foreground/90">{label}</span>
        {call.target ? (
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground" title={call.target}>
            {call.target}
          </span>
        ) : call.detail.trim().length > 0 ? (
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={call.detail.split("\n")[0]}>
            {call.detail.split("\n")[0]}
          </span>
        ) : (
          <span className="flex-1" />
        )}
        <span className="flex shrink-0 items-center gap-1">
          {stateBadge ? <Badge tone={stateBadge.tone}>{stateBadge.label}</Badge> : null}
          {r ? (
            <>
              <Chip tone={exitTone}>{r.exitCode === null ? r.status : `exit ${r.exitCode}`}</Chip>
              <Chip className="hidden sm:inline-flex">{formatDurationMs(r.durationMs)}</Chip>
            </>
          ) : null}
          {call.readTruncated ? <Badge tone="warn">truncated</Badge> : null}
        </span>
      </summary>
      <div className="flex flex-col gap-2.5 border-t border-border px-3 py-3 dark:border-foreground/5">
        {call.target ? (
          <div className="flex flex-col gap-1">
            <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">{call.name === "run" || r ? "command" : "path"}</span>
            <Mono wrap className="rounded-md bg-muted/60 px-2 py-1.5 text-xs dark:bg-background/60">
              {call.target}
            </Mono>
          </div>
        ) : null}
        {r ? (
          <div className="flex flex-wrap items-center gap-1">
            <Badge tone={r.status === "succeeded" ? "ok" : r.status === "failed" ? "warn" : "bad"}>{r.status}</Badge>
            <Chip>exit {r.exitCode === null ? "—" : r.exitCode}</Chip>
            <Chip>{formatDurationMs(r.durationMs)}</Chip>
            {r.truncated ? <Badge tone="warn">output truncated</Badge> : null}
            {r.timedOut ? <Badge tone="bad">timed out</Badge> : null}
          </div>
        ) : null}
        {r ? (
          <>
            <Stream label="stdout" text={r.stdout} />
            <Stream label="stderr" text={r.stderr} />
            {r.stdout.length === 0 && r.stderr.length === 0 ? <p className="text-xs text-muted-foreground">No output captured.</p> : null}
          </>
        ) : null}
        {showDetail ? <Pre className="max-h-64">{call.detail.length > 12000 ? `${call.detail.slice(0, 12000)}…` : call.detail}</Pre> : null}
        <p className="text-[11px] text-muted-foreground">
          event #{call.seq} · {call.title}
        </p>
      </div>
    </details>
  );
}
