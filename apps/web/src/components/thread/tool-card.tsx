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
import type { ComponentType, ReactNode } from "react";
import { formatDurationMs, tail } from "../../lib/format";
import type { ToolCall, ToolState } from "../../lib/thread";
import { cn } from "../../lib/utils";
import { Badge, Chip, Digest, Mono, Pre, type Tone } from "../common";

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

const MODEL_TOOL_NAMES = new Set(["run", "read_file", "edit_file", "write_file", "submit_candidate"]);

/** Plan → dispatch → observation → verification, as recorded. */
function DispatchTrail({ call, onOpenDetails }: { call: ToolCall; onOpenDetails?: (() => void) | undefined }) {
  const fromModel = MODEL_TOOL_NAMES.has(call.name);
  const v = call.verification;
  const steps: { label: string; body: ReactNode }[] = [
    {
      label: "plan",
      body: fromModel ? (
        <span>
          model requested <Mono>{call.name}</Mono>
          {call.target ? (
            <>
              {" "}
              on <Mono wrap>{call.target.length > 120 ? `${call.target.slice(0, 120)}…` : call.target}</Mono>
            </>
          ) : null}
        </span>
      ) : (
        <span>controller step (no model request)</span>
      ),
    },
    {
      label: "dispatch",
      body: call.operation ? (
        <span>
          {call.operation}
          {call.operationId ? (
            <>
              {" "}
              · op <Mono>{call.operationId}</Mono>
            </>
          ) : null}
        </span>
      ) : (
        <span className="text-destructive">not dispatched: stopped by the controller before any sandbox effect</span>
      ),
    },
    { label: "observation", body: <span className="break-words">{call.observation}</span> },
  ];
  if (call.name === "submit_candidate") {
    steps.push({
      label: "verification",
      body: v ? (
        <span className="flex flex-wrap items-center gap-1">
          candidate #{v.index} <Digest value={v.candidateDigest} /> <Badge tone={v.tone}>{v.outcome}</Badge>
          {v.verificationRecordId ? (
            onOpenDetails ? (
              <button type="button" className="font-mono text-[11px] underline underline-offset-4 hover:text-foreground" onClick={onOpenDetails}>
                {v.verificationRecordId}
              </button>
            ) : (
              <Mono>{v.verificationRecordId}</Mono>
            )
          ) : null}
        </span>
      ) : (
        <span className="text-muted-foreground">no sealed candidate recorded for this submission yet</span>
      ),
    });
  }
  return (
    <ol className="flex flex-col gap-1 text-xs" aria-label="Dispatch trail">
      {steps.map((step, i) => (
        <li key={step.label} className="grid grid-cols-[1.25rem_5.5rem_minmax(0,1fr)] items-baseline gap-1">
          <span className="text-[11px] tabular-nums text-muted-foreground">{i + 1}.</span>
          <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">{step.label}</span>
          <span className="min-w-0">{step.body}</span>
        </li>
      ))}
    </ol>
  );
}

export function ToolCard({ call, onOpenDetails }: { call: ToolCall; onOpenDetails?: (() => void) | undefined }) {
  const Icon = ICON[call.name] ?? IconTool;
  const label = LABEL[call.name] ?? call.name;
  const r = call.result;
  const exitTone: Tone = r ? (r.status === "succeeded" ? "neutral" : r.status === "failed" ? "warn" : "bad") : "neutral";
  const stateBadge = call.state === "ok" || call.state === "failed" ? null : STATE_BADGE[call.state];
  // A `run` event's detail only restates its ExecResult (status, exit, stdout/stderr tails);
  // invocation details also carry observation and protocol-error counts, so they stay.
  const showDetail = call.detail.length > 0 && (!r || call.name !== "run");

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
          {call.verification ? <Badge tone={call.verification.tone}>{call.verification.outcome}</Badge> : null}
        </span>
      </summary>
      <div className="flex flex-col gap-2.5 border-t border-border px-3 py-3 dark:border-foreground/5">
        <DispatchTrail call={call} onOpenDetails={onOpenDetails} />
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
