/**
 * One general-tool operation (its `started` intent and its answer merged by operationId), drawn as
 * a disclosure line like the repair ToolCard. The state badge restates `data.opState`; "unknown"
 * is a warning: outcome unknown, not retried. All page text, code and output are text nodes.
 */
import {
  IconBrowser,
  IconDownload,
  IconEye,
  IconForms,
  IconHandStop,
  IconShieldCheck,
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
import { artifactHref, isHumanTool, observationOf, opStateView, type Operation } from "../../lib/general";
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
  browser_download_list: "List downloads",
  browser_download_save: "Save download",
  browser_propose_submit: "Propose submission",
  approved_submit: "Approved submission (Airlock)",
  live_view: "Live frame",
};

/** "human_download_read" → "download read". */
function humanLabel(tool: string): string {
  return tool.replace(/^human_/, "").replace(/_/g, " ");
}

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
  browser_download_list: IconDownload,
  browser_download_save: IconDownload,
  browser_propose_submit: IconForms,
  approved_submit: IconShieldCheck,
  live_view: IconEye,
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

/** A live-view frame: read-only, never acts on the page; one compact line. */
function LiveFrameLine({ op, terminal }: { op: Operation; terminal: boolean }) {
  const obs = observationOf(op);
  const state = opStateView(op.state, terminal);
  const id = obs.saved?.artifactId ?? null;
  return (
    <div className="flex min-h-7 min-w-0 items-center gap-2 px-2.5 text-xs text-muted-foreground">
      <IconEye className="size-3.5 shrink-0" />
      <span className="shrink-0 font-medium text-foreground/80">Live frame</span>
      {id ? (
        <a className="shrink-0 underline underline-offset-4" href={artifactHref(id)} target="_blank" rel="noreferrer noopener">
          <Mono>{id}</Mono>
        </a>
      ) : null}
      {obs.saved?.sha256 ? <span className="shrink-0">sha256 {obs.saved.sha256.slice(0, 12)}</span> : null}
      <span className="min-w-0 flex-1 truncate" title={obs.summary}>
        {obs.url ?? obs.summary}
      </span>
      <Badge tone={state.tone} title={state.note}>
        {state.label}
      </Badge>
    </div>
  );
}

export function OperationCard({
  op,
  terminal,
  screenshotInfo,
  actorOf,
}: {
  op: Operation;
  terminal: boolean;
  screenshotInfo?: ((artifactId: string) => { capturedAt: string | null; width: number | null; height: number | null; sentToModel: boolean | undefined }) | undefined;
  /** "you (judge)" / "a person (operator)" for a human_* operation. */
  actorOf?: ((op: Operation) => string) | undefined;
}) {
  if (op.tool === "live_view") return <LiveFrameLine op={op} terminal={terminal} />;
  const human = isHumanTool(op.tool);
  const Icon = human ? IconHandStop : (ICON[op.tool] ?? IconTool);
  const state = opStateView(op.state, terminal, op.tool);
  const obs = observationOf(op);
  const actor = human ? (actorOf?.(op) ?? "a person") : null;
  const target = obs.url ?? (typeof op.data["path"] === "string" ? (op.data["path"] as string) : typeof op.data["file"] === "string" ? (op.data["file"] as string) : null);
  const shot = obs.screenshot ? screenshotInfo?.(obs.screenshot.artifactId) : undefined;

  return (
    <details className={cn("tool-line group min-w-0 rounded-lg border bg-card text-sm dark:bg-card/60", human ? "border-blue-500/30" : "border-border dark:border-transparent")} open={op.tool === "browser_screenshot" || op.tool === "submit_result" || op.state === "unknown" ? true : undefined}>
      <summary className="flex min-h-9 cursor-pointer list-none items-center gap-2 rounded-lg px-2.5 py-1.5 select-none hover:bg-foreground/[0.03] [&::-webkit-details-marker]:hidden">
        <span aria-hidden className="tool-line-chevron w-2.5 shrink-0 text-xs text-muted-foreground transition-transform">
          ▸
        </span>
        <Icon className={cn("size-4 shrink-0", op.state === "failed" ? "text-destructive" : op.state === "unknown" ? "text-warning" : "text-muted-foreground")} />
        {human ? <Badge tone="info" title="An action by a person holding browser control, not the model">{actor}</Badge> : null}
        <span className="shrink-0 font-medium text-foreground/90">{human ? humanLabel(op.tool) : (LABEL[op.tool] ?? op.tool)}</span>
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
        {human ? <p className="text-xs text-muted-foreground">Done by {actor} while holding browser control; the same allowed sites, deadline and budgets applied. It is not an approval.</p> : null}
        {obs.proposal ? (
          <p className="text-xs">
            <span className="text-muted-foreground">proposal: </span>
            <a className="underline underline-offset-4" href={`#proposal-${obs.proposal.id}`}>
              <Mono>{obs.proposal.id}</Mono>
            </a>
            {obs.proposal.formId ? <span className="text-muted-foreground"> · form {obs.proposal.formId}</span> : null}
            {obs.proposal.destination ? <span className="text-muted-foreground"> · {obs.proposal.destination}</span> : null}
            <span className="text-muted-foreground"> · the model cannot submit it; a person reviews the exact values below.</span>
          </p>
        ) : null}
        {obs.saved && !obs.screenshot ? (
          <p className="flex flex-wrap items-center gap-1 text-xs">
            <span className="text-muted-foreground">stored as</span>
            <a className="underline underline-offset-4" href={artifactHref(obs.saved.artifactId)} target="_blank" rel="noreferrer noopener">
              <Mono>{obs.saved.artifactId}</Mono>
            </a>
            {obs.saved.path ? <Mono>{obs.saved.path}</Mono> : null}
            {obs.saved.byteLength !== null ? <Chip>{obs.saved.byteLength} bytes</Chip> : null}
            {obs.saved.sha256 ? <Chip title={obs.saved.sha256}>sha256 {obs.saved.sha256.slice(0, 12)}</Chip> : null}
          </p>
        ) : null}
        {obs.downloads ? (
          obs.downloads.length === 0 ? (
            <p className="text-xs text-muted-foreground">No downloads.</p>
          ) : (
            <ul className="flex flex-col gap-1 text-xs">
              {obs.downloads.map((d) => (
                <li key={d.downloadId} className="flex flex-wrap items-center gap-1.5">
                  <Mono>{d.downloadId}</Mono>
                  <span className="min-w-0 break-all">{d.suggestedFilename || "(no name)"}</span>
                  <Badge tone={d.state === "completed" ? "ok" : d.state === "in_progress" ? "info" : "bad"}>{d.state}</Badge>
                  {d.reason ? <span className="text-muted-foreground">{d.reason}</span> : null}
                  {d.bytes !== null ? <Chip>{d.bytes} bytes</Chip> : null}
                  {d.url ? <span className="w-full min-w-0 truncate text-muted-foreground" title={d.url}>{d.url}</span> : null}
                </li>
              ))}
              <li className="text-[11px] text-muted-foreground">File names and URLs come from untrusted pages.</li>
            </ul>
          )
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
