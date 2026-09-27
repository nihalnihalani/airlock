/**
 * The rows of a task conversation. Message/Bubble are OpenBot's primitives; every string from the
 * control plane, the model or a sandbox is a React text node (whitespace preserved), never Markdown
 * or HTML.
 */
import {
  IconAlertTriangle,
  IconBox,
  IconCircleCheck,
  IconCircleDashed,
  IconCircleX,
  IconFlag,
  IconInfoCircle,
  IconPackage,
  IconShieldCheck,
  IconSparkles,
  IconUser,
} from "@tabler/icons-react";
import { useState, type ComponentType } from "react";
import type { RunEvent, TaskView } from "@airlock/contracts";
import { formatDurationMs, formatTime, PHASE_LABEL } from "../../lib/format";
import type { ThreadItem } from "../../lib/thread";
import { cn } from "../../lib/utils";
import { Badge, Chip, Digest, InfoTip, TONE_TEXT, type Tone } from "../common";
import { RowMark } from "../layout/row-mark";
import { Bubble, BubbleContent } from "../ui/bubble";
import { Button } from "../ui/button";
import { Message, MessageContent, MessageFooter, MessageHeader } from "../ui/message";
import { ToolCard } from "./tool-card";

const LONG_ISSUE_CHARS = 1400;

export function UserMessage({ item }: { item: Extract<ThreadItem, { type: "user" }> }) {
  const long = item.text.length > LONG_ISSUE_CHARS;
  const [expanded, setExpanded] = useState(false);
  const shown = long && !expanded ? `${item.text.slice(0, LONG_ISSUE_CHARS).trimEnd()}…` : item.text;
  return (
    <Message align="end">
      <MessageContent>
        <Bubble align="end" variant="muted" className="max-w-[85%]">
          <BubbleContent>
            <span className="whitespace-pre-wrap">{shown}</span>
          </BubbleContent>
        </Bubble>
        <MessageFooter className="gap-1.5">
          <IconUser className="size-3" />
          <span>Issue as submitted</span>
          <span className="text-muted-foreground/50">·</span>
          <span>{item.profileId}</span>
          {item.scriptedDriver ? (
            <>
              <span className="text-muted-foreground/50">·</span>
              <span title="Diagnostic run: a scripted model replays a fixed script. Never a live repair.">scripted: {item.scriptedDriver}</span>
            </>
          ) : null}
          {long ? (
            <Button variant="link" size="xs" className="h-auto px-0 text-xs" onClick={() => setExpanded((v) => !v)}>
              {expanded ? "Show less" : `Show all ${item.text.length.toLocaleString()} chars`}
            </Button>
          ) : null}
        </MessageFooter>
      </MessageContent>
    </Message>
  );
}

export function AssistantMessage({ item }: { item: Extract<ThreadItem, { type: "assistant" }> }) {
  const t = item.turn;
  return (
    <Message align="start">
      <MessageContent className="gap-2">
        <MessageHeader className="gap-1.5 px-0">
          <span className="flex size-5 items-center justify-center rounded-full bg-foreground text-background">
            <IconSparkles className="size-3" />
          </span>
          <span className="text-foreground/80">{item.turn.title}</span>
          <span className="truncate font-normal" title={t.model ?? undefined}>
            {t.model ?? "model unknown"}
          </span>
          {t.inputTokens !== null || t.outputTokens !== null ? (
            <span className="hidden font-normal tabular-nums sm:inline">
              · {t.inputTokens ?? "?"} in / {t.outputTokens ?? "?"} out
            </span>
          ) : null}
          {t.durationMs !== null ? <span className="font-normal tabular-nums">· {formatDurationMs(t.durationMs)}</span> : null}
          {t.isError ? <Badge tone="bad">error</Badge> : null}
        </MessageHeader>
        <Bubble variant="ghost" className="w-full">
          <BubbleContent className="w-full">
            <span className="whitespace-pre-wrap">{item.text}</span>
          </BubbleContent>
        </Bubble>
        {item.reasoning ? (
          <details className="tool-line text-sm">
            <summary className="flex cursor-pointer list-none items-center gap-1.5 text-muted-foreground [&::-webkit-details-marker]:hidden">
              <span aria-hidden className="tool-line-chevron text-xs transition-transform">
                ▸
              </span>
              Reasoning excerpt
            </summary>
            <p className="mt-2 border-l pl-3 text-xs whitespace-pre-wrap text-muted-foreground">{item.reasoning}</p>
          </details>
        ) : null}
        {item.tools.length > 0 ? (
          <div className="flex flex-col gap-1.5">
            {item.tools.map((call) => (
              <ToolCard key={call.seq} call={call} />
            ))}
          </div>
        ) : null}
      </MessageContent>
    </Message>
  );
}

const MARK_ICON: Record<RunEvent["kind"], ComponentType<{ className?: string }>> = {
  phase: IconFlag,
  check: IconShieldCheck,
  lifecycle: IconBox,
  artifact: IconPackage,
  error: IconAlertTriangle,
  info: IconInfoCircle,
  model: IconSparkles,
  tool: IconBox,
  exec: IconBox,
};

export function MarkRow({ item }: { item: Extract<ThreadItem, { type: "mark" }> }) {
  const Icon = MARK_ICON[item.kind];
  const detail = item.detail.trim();
  const titleClass = cn(
    "shrink-0 text-[13px] font-medium",
    item.tone === "neutral" ? (item.phase ? "text-foreground" : "text-foreground/80") : TONE_TEXT[item.tone],
  );
  const line = (
    <>
      <RowMark className={cn("size-6 rounded-md", item.tone !== "neutral" && TONE_TEXT[item.tone])}>
        <Icon className="size-3.5" />
      </RowMark>
      <span className={titleClass}>{item.phase ? `${item.title} phase` : item.title}</span>
      {detail.length > 0 ? <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{detail.split("\n")[0]}</span> : <span className="flex-1" />}
      <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/70">{formatTime(item.at)}</span>
    </>
  );
  if (detail.length === 0) return <div className="flex min-h-7 min-w-0 items-center gap-2.5">{line}</div>;
  return (
    <details className="tool-line group/mark min-w-0">
      <summary className="flex min-h-7 min-w-0 cursor-pointer list-none items-center gap-2.5 rounded-md [&::-webkit-details-marker]:hidden">{line}</summary>
      <pre className="mt-1 ml-[2.125rem] max-h-60 overflow-auto border-l pl-3 font-mono text-[11px] whitespace-pre-wrap break-words text-muted-foreground">{detail}</pre>
    </details>
  );
}

export function StandaloneTool({ item }: { item: Extract<ThreadItem, { type: "tool" }> }) {
  return (
    <div className="min-w-0 pl-[2.125rem]">
      <ToolCard call={item.call} />
    </div>
  );
}

const RESULT_ICON: Record<Tone, ComponentType<{ className?: string }>> = {
  ok: IconCircleCheck,
  bad: IconCircleX,
  warn: IconAlertTriangle,
  neutral: IconCircleDashed,
  info: IconInfoCircle,
};

export function ResultCard({
  item,
  view,
  onOpenDetails,
}: {
  item: Extract<ThreadItem, { type: "result" }>;
  view: TaskView | null;
  onOpenDetails: () => void;
}) {
  const Icon = RESULT_ICON[item.tone];
  const verification = view?.verification;
  const task = view?.task;
  return (
    <div
      className={cn(
        "rounded-xl border bg-card p-4 animate-in fade-in-0 slide-in-from-bottom-1 duration-300 motion-reduce:animate-none",
        item.tone === "ok" ? "border-success/40" : item.tone === "bad" ? "border-destructive/40" : item.tone === "warn" ? "border-warning/40" : "border-border",
      )}
    >
      <div className="flex items-start gap-3">
        <span
          className={cn(
            "flex size-9 shrink-0 items-center justify-center rounded-lg",
            item.tone === "ok" ? "bg-success/10" : item.tone === "bad" ? "bg-destructive/10" : item.tone === "warn" ? "bg-warning/10" : "bg-muted",
            TONE_TEXT[item.tone],
          )}
        >
          <Icon className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <h2 className="text-base font-semibold tracking-tight">{item.label}</h2>
            {item.hint ? <InfoTip text={item.hint} /> : null}
            {item.outcome ? <span className="ml-auto hidden font-mono text-[11px] text-muted-foreground sm:inline">{item.outcome}</span> : null}
          </div>
          {item.hint ? <p className="mt-1 text-sm text-pretty text-muted-foreground">{item.hint}</p> : null}
          {item.reason ? (
            <p className="mt-2 text-sm whitespace-pre-wrap break-words">
              <span className="text-muted-foreground">Recorded reason: </span>
              {item.reason}
            </p>
          ) : null}
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            {verification ? (
              <Chip title="From the candidate verification record">
                {verification.completedCases}/{verification.requiredCases} frozen cases completed
              </Chip>
            ) : null}
            {task?.candidateDigest ? (
              <Chip>
                <Digest label="candidate" value={task.candidateDigest} />
              </Chip>
            ) : null}
            {verification ? <Chip title="Verification record id">{verification.id}</Chip> : null}
            <Button variant="outline" size="sm" className="ml-auto" onClick={onOpenDetails}>
              {item.outcome === "CANDIDATE_PASSED_CHECKS" ? "Preview & download" : "Checkpoints & cases"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function WorkingRow({ item }: { item: Extract<ThreadItem, { type: "working" }> }) {
  const text =
    item.status === "queued"
      ? "Queued for a worker…"
      : item.status === "cancelling"
        ? "Cancelling: revoking dispatch and stopping the sandbox…"
        : `Working · ${PHASE_LABEL[item.phase]} phase…`;
  return (
    <div className="flex items-center gap-3" aria-live="polite">
      <RowMark className="size-7 rounded-md">
        <IconCircleDashed className="size-3.5 animate-spin [animation-duration:3s] motion-reduce:animate-none" />
      </RowMark>
      <span className="tool-line-running text-sm text-muted-foreground">{text}</span>
    </div>
  );
}
