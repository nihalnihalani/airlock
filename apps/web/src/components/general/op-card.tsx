/**
 * One general-tool operation (its `started` intent and its answer merged by operationId), drawn as
 * a disclosure line like the repair ToolCard. The state badge restates `data.opState`; "unknown"
 * is a warning: outcome unknown, not retried. All page text, code and output are text nodes.
 */
import {
  IconBrowser,
  IconCamera,
  IconClick,
  IconCode,
  IconFileText,
  IconFolder,
  IconKeyboard,
  IconPlayerPlay,
  IconSend,
  IconTool,
  IconWorld,
} from "@tabler/icons-react";
import type { ComponentType } from "react";
import { formatDurationMs, tail } from "../../lib/format";
import { observationOf, opStateView, type Operation } from "../../lib/general";
import { cn } from "../../lib/utils";
import { Badge, Chip, Mono, Notice, Pre } from "../common";
import { Screenshot } from "./artifacts";

const LABEL: Record<string, string> = {
  browser_navigate: "Navigate",
  browser_observe: "Observe page",
  browser_click: "Click",
  browser_type: "Type",
  browser_key: "Key",
  browser_scroll: "Scroll",
  browser_screenshot: "Screenshot",
  browser_tabs: "Tabs",
  browser_save_text: "Save page text",
  code_write: "Write code",
  code_run: "Run code",
  code_read: "Read file",
  files_list: "List files",
  submit_result: "Submit result",
};

const ICON: Record<string, ComponentType<{ className?: string }>> = {
  browser_navigate: IconWorld,
  browser_observe: IconBrowser,
  browser_click: IconClick,
  browser_type: IconKeyboard,
  browser_key: IconKeyboard,
  browser_scroll: IconBrowser,
  browser_screenshot: IconCamera,
  browser_tabs: IconBrowser,
  browser_save_text: IconFileText,
  code_write: IconCode,
  code_run: IconPlayerPlay,
  code_read: IconFileText,
  files_list: IconFolder,
  submit_result: IconSend,
};

function Stream({ label, text }: { label: string; text: string }) {
  if (text.length === 0) return null;
  const t = tail(text, 40, 8000);
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
        {label}
        {t.clipped ? " · tail" : ""}
      </span>
      <Pre className="max-h-64">{t.text}</Pre>
    </div>
  );
}

function Label({ children }: { children: string }) {
  return <span className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{children}</span>;
}

export function OperationCard({
  op,
  terminal,
  screenshotInfo,
}: {
  op: Operation;
  terminal: boolean;
  screenshotInfo?: ((artifactId: string) => { capturedAt: string | null; width: number | null; height: number | null; sentToModel: boolean | undefined }) | undefined;
}) {
  const Icon = ICON[op.tool] ?? IconTool;
  const state = opStateView(op.state, terminal);
  const obs = observationOf(op);
  const target = obs.url ?? (typeof op.data["path"] === "string" ? (op.data["path"] as string) : typeof op.data["file"] === "string" ? (op.data["file"] as string) : null);
  const shot = obs.screenshot ? screenshotInfo?.(obs.screenshot.artifactId) : undefined;

  return (
    <details className="tool-line group min-w-0 rounded-lg border border-border bg-card text-sm dark:border-transparent dark:bg-card/60" open={op.tool === "browser_screenshot" || op.tool === "submit_result" || op.state === "unknown" ? true : undefined}>
      <summary className="flex min-h-9 cursor-pointer list-none items-center gap-2 rounded-lg px-2.5 py-1.5 select-none hover:bg-foreground/[0.03] [&::-webkit-details-marker]:hidden">
        <span aria-hidden className="tool-line-chevron w-2.5 shrink-0 text-xs text-muted-foreground transition-transform">
          ▸
        </span>
        <Icon className={cn("size-4 shrink-0", op.state === "failed" ? "text-destructive" : op.state === "unknown" ? "text-warning" : "text-muted-foreground")} />
        <span className="shrink-0 font-medium text-foreground/90">{LABEL[op.tool] ?? op.tool}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground" title={target ?? obs.summary}>
          {target ?? obs.summary}
        </span>
        <span className="flex shrink-0 items-center gap-1">
          <Badge tone={state.tone} title={state.note}>
            {state.label}
          </Badge>
          {obs.exec ? <Chip className="hidden sm:inline-flex">{formatDurationMs(obs.exec.durationMs)}</Chip> : null}
        </span>
      </summary>
      <div className="flex flex-col gap-2.5 border-t border-border px-3 py-3 dark:border-foreground/5">
        <p className={cn("text-xs", op.state === "unknown" ? "font-medium text-warning" : "text-muted-foreground")}>{state.note}</p>
        <div className="flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
          {op.operationId ? (
            <span>
              op <Mono>{op.operationId}</Mono>
            </span>
          ) : (
            <span>no supervisor operation (decided by the controller)</span>
          )}
          {op.attemptId ? (
            <span>
              · attempt <Mono>{op.attemptId}</Mono>
            </span>
          ) : null}
          <span>· events #{op.seqs.join(", #")}</span>
        </div>
        {obs.explain ? (
          <Notice tone={op.state === "unknown" || op.state === "failed" ? "warn" : "info"} className="text-xs">
            {obs.explain}
          </Notice>
        ) : null}
        {obs.summary && !obs.claim ? (
          <p className="text-xs break-words">
            <span className="text-muted-foreground">observation: </span>
            {obs.summary}
          </p>
        ) : null}
        {obs.url ? (
          <div className="flex flex-col gap-1">
            <Label>url</Label>
            <Mono wrap className="text-xs">
              {obs.url}
            </Mono>
          </div>
        ) : null}
        {obs.pageTitle ? (
          <p className="text-xs">
            <span className="text-muted-foreground">page title: </span>
            {obs.pageTitle}
          </p>
        ) : null}
        {obs.excerpt ? (
          <div className="flex flex-col gap-1">
            <Label>page text excerpt (untrusted)</Label>
            <Pre className="max-h-56">{obs.excerpt}</Pre>
          </div>
        ) : null}
        {obs.screenshot ? (
          <Screenshot
            artifactId={obs.screenshot.artifactId}
            sha256={obs.screenshot.sha256}
            url={obs.url}
            capturedAt={shot?.capturedAt}
            width={shot?.width}
            height={shot?.height}
            sentToModel={shot?.sentToModel}
          />
        ) : null}
        {obs.code !== null ? (
          <div className="flex flex-col gap-1">
            <Label>code as written by the model</Label>
            <Pre className="max-h-80">{obs.code}</Pre>
          </div>
        ) : null}
        {obs.exec ? (
          <>
            <div className="flex flex-wrap items-center gap-1">
              <Badge tone={obs.exec.status === "succeeded" ? "ok" : obs.exec.status === "failed" ? "warn" : "bad"}>{obs.exec.status}</Badge>
              <Chip>exit {obs.exec.exitCode === null ? "—" : obs.exec.exitCode}</Chip>
              <Chip>{formatDurationMs(obs.exec.durationMs)}</Chip>
              {obs.exec.truncated ? <Badge tone="warn">output truncated</Badge> : null}
              {obs.exec.timedOut ? <Badge tone="bad">timed out</Badge> : null}
            </div>
            <Stream label="stdout" text={obs.exec.stdout} />
            <Stream label="stderr" text={obs.exec.stderr} />
            {obs.exec.stdout.length === 0 && obs.exec.stderr.length === 0 ? <p className="text-xs text-muted-foreground">No output captured.</p> : null}
            <p className="text-[11px] text-muted-foreground">Exit codes and logs inside the sandbox are advisory; the result is decided by the controller's checks.</p>
          </>
        ) : null}
        {obs.files && obs.files.length > 0 ? (
          <ul className="flex flex-wrap gap-1">
            {obs.files.map((f) => (
              <li key={f}>
                <Chip>
                  <Mono>{f}</Mono>
                </Chip>
              </li>
            ))}
          </ul>
        ) : null}
        {obs.claim ? (
          <div className="flex flex-col gap-1.5 rounded-lg border border-dashed border-warning/40 p-2.5">
            <span className="text-xs font-medium text-warning">Claim — checked below by the controller</span>
            <p className="text-sm whitespace-pre-wrap break-words">{obs.claim.summary || "(no summary)"}</p>
            <p className="text-xs text-muted-foreground">outputs claimed: {obs.claim.outputs.length ? obs.claim.outputs.join(", ") : "(none)"}</p>
            <p className="text-xs break-all text-muted-foreground">sources cited: {obs.claim.sources.length ? obs.claim.sources.join(", ") : "(none)"}</p>
            {obs.claim.unsupported ? <p className="text-xs text-muted-foreground">declared unsupported capability: {obs.claim.unsupported}</p> : null}
          </div>
        ) : null}
        {!obs.claim && !obs.excerpt && obs.code === null && !obs.exec && op.detail.trim().length > 0 && op.detail.split("\n").length > 1 ? (
          <Pre className="max-h-48">{op.detail.length > 8000 ? `${op.detail.slice(0, 8000)}…` : op.detail}</Pre>
        ) : null}
        <p className="text-[11px] text-muted-foreground">{op.title}</p>
      </div>
    </details>
  );
}
