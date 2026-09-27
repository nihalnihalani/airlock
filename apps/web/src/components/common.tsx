/**
 * Small display atoms in OpenBot's visual language. Every string passed in is rendered as a React
 * text node; nothing here interprets HTML or Markdown.
 */
import { IconAlertTriangle, IconInfoCircle } from "@tabler/icons-react";
import type { ReactNode } from "react";
import type { Tone } from "../lib/format";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

export type { Tone };

export const TONE_TEXT: Record<Tone, string> = {
  neutral: "text-muted-foreground",
  ok: "text-success",
  warn: "text-warning",
  bad: "text-destructive",
  info: "text-blue-600 dark:text-blue-400",
};

const TONE_BADGE: Record<Tone, string> = {
  neutral: "bg-muted text-muted-foreground",
  ok: "bg-success/10 text-success dark:bg-success/15",
  warn: "bg-warning/12 text-warning dark:bg-warning/15",
  bad: "bg-destructive/10 text-destructive dark:bg-destructive/20",
  info: "bg-blue-500/10 text-blue-700 dark:text-blue-300",
};

export const TONE_DOT: Record<Tone, string> = {
  neutral: "bg-muted-foreground/50",
  ok: "bg-success",
  warn: "bg-warning",
  bad: "bg-destructive",
  info: "bg-blue-500",
};

export function Badge({
  tone = "neutral",
  title,
  className,
  children,
}: {
  tone?: Tone;
  title?: string | undefined;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex h-5 max-w-full shrink-0 items-center gap-1 truncate rounded-md px-1.5 text-xs font-medium whitespace-nowrap [&_svg]:size-3",
        TONE_BADGE[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/** An outlined chip for plain facts (counts, durations, names). */
export function Chip({ tone, className, children, title }: { tone?: Tone; className?: string; children: ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex h-5 max-w-full shrink-0 items-center gap-1 rounded-md border border-border bg-background px-1.5 text-xs whitespace-nowrap dark:bg-input/30 [&_svg]:size-3",
        tone ? TONE_TEXT[tone] : "text-foreground/80",
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Dot({ tone, pulse = false, className }: { tone: Tone; pulse?: boolean; className?: string }) {
  return (
    <span className={cn("relative inline-flex size-2 shrink-0", className)} aria-hidden>
      {pulse ? <span className={cn("absolute inset-0 rounded-full opacity-60 animate-ping motion-reduce:animate-none", TONE_DOT[tone])} /> : null}
      <span className={cn("relative inline-flex size-2 rounded-full", TONE_DOT[tone])} />
    </span>
  );
}

export function BoolChip({ value, yes = "yes", no = "no", invert = false }: { value: boolean; yes?: string; no?: string; invert?: boolean }) {
  const good = invert ? !value : value;
  return <Badge tone={good ? "ok" : "bad"}>{value ? yes : no}</Badge>;
}

export function ErrorBox({ message, onRetry, className }: { message: string; onRetry?: () => void; className?: string }) {
  return (
    <div
      role="alert"
      className={cn(
        "flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive",
        className,
      )}
    >
      <IconAlertTriangle className="mt-0.5 size-4 shrink-0" />
      <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{message}</span>
      {onRetry ? (
        <Button size="xs" variant="outline" onClick={onRetry}>
          Retry
        </Button>
      ) : null}
    </div>
  );
}

export function Notice({ tone = "info", children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "rounded-lg border px-3 py-2 text-sm",
        tone === "bad"
          ? "border-destructive/30 bg-destructive/5 text-destructive"
          : tone === "warn"
            ? "border-warning/30 bg-warning/5 text-foreground"
            : "border-border bg-muted/50 text-muted-foreground",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function Mono({ children, title, wrap = false, className }: { children: ReactNode; title?: string; wrap?: boolean; className?: string }) {
  return (
    <code title={title} className={cn("font-mono text-[0.8em]", wrap ? "break-all whitespace-pre-wrap" : "whitespace-nowrap", className)}>
      {children}
    </code>
  );
}

/** Untrusted text, shown verbatim. */
export function Pre({ children, className }: { children: string; className?: string }) {
  return (
    <pre
      className={cn(
        "max-h-72 overflow-auto rounded-lg bg-muted/60 px-3 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words text-foreground/90 dark:bg-background/60",
        className,
      )}
    >
      {children}
    </pre>
  );
}

export function Digest({ value, label, className }: { value: string; label?: string; className?: string }) {
  return (
    <span className={cn("inline-flex min-w-0 items-baseline gap-1", className)} title={value}>
      {label ? <span className="text-muted-foreground">{label}</span> : null}
      <Mono>{value.length > 16 ? `${value.slice(0, 16)}…` : value}</Mono>
    </span>
  );
}

export function KeyValue({ rows, className }: { rows: { key: string; value: ReactNode }[]; className?: string }) {
  return (
    <dl className={cn("grid grid-cols-[minmax(0,8.5rem)_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-sm", className)}>
      {rows.map((row) => (
        <div className="contents" key={row.key}>
          <dt className="truncate text-muted-foreground" title={row.key}>
            {row.key}
          </dt>
          <dd className="min-w-0 break-words">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A titled block inside a pane, OpenBot's "Activity" heading style. */
export function PanelSection({
  title,
  aside,
  children,
  className,
}: {
  title: string;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("px-4 py-4", className)}>
      <div className="mb-2.5 flex min-h-6 items-center justify-between gap-3">
        <h3 className="font-medium text-sm">{title}</h3>
        {aside ? <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">{aside}</div> : null}
      </div>
      {children}
    </section>
  );
}

/** A hint whose full text sits behind an info icon; the same text must also be visible nearby. */
export function InfoTip({ text, label = "What this means" }: { text: string; label?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button type="button" aria-label={label} className="inline-flex text-muted-foreground hover:text-foreground">
            <IconInfoCircle className="size-4" />
          </button>
        }
      />
      <TooltipContent side="top" className="max-w-xs text-pretty">
        {text}
      </TooltipContent>
    </Tooltip>
  );
}
