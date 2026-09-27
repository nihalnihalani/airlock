/**
 * Rows of a general task's conversation: the goal, model turns (plan text) with their operations,
 * rows between them, and the result panel (TaskResult: summary, completion checks, outputs,
 * sources, export). Every string from the model, a page or a sandbox is a React text node.
 */
import {
  IconAlertTriangle,
  IconBox,
  IconDownload,
  IconFlag,
  IconInfoCircle,
  IconKey,
  IconPackage,
  IconPhoto,
  IconShieldCheck,
  IconSparkles,
  IconTarget,
  IconWorld,
} from "@tabler/icons-react";
import { useState, type ComponentType } from "react";
import type { Artifact, RunEvent, Task } from "@airlock/contracts";
import { createExport, describeError, exportUrl, type ExportResponse } from "../../lib/api";
import { formatDateTime, formatDurationMs, formatTime, httpUrl } from "../../lib/format";
import { checkSummary, cleanupView, exportable, outcomeReason, profileShortName, resultView, type GeneralItem, type Operation } from "../../lib/general";
import { cn } from "../../lib/utils";
import { Badge, Chip, ErrorBox, KeyValue, Mono, Notice, TONE_TEXT } from "../common";
import { RowMark } from "../layout/row-mark";
import { Bubble, BubbleContent } from "../ui/bubble";
import { Button } from "../ui/button";
import { Message, MessageContent, MessageFooter, MessageHeader } from "../ui/message";
import { ArtifactLine, ArtifactPreview, Screenshot } from "./artifacts";
import { OperationCard } from "./op-card";
import { CleanupDimensionBadge } from "./status";

export type ScreenshotInfo = (artifactId: string) => { capturedAt: string | null; width: number | null; height: number | null; sentToModel: boolean | undefined };

export function GoalMessage({ item, task }: { item: Extract<GeneralItem, { type: "goal" }>; task: Task }) {
  return (
    <Message align="end">
      <MessageContent>
        <Bubble align="end" variant="muted" className="max-w-[85%]">
          <BubbleContent>
            <span className="whitespace-pre-wrap">{item.text}</span>
          </BubbleContent>
        </Bubble>
        <MessageFooter className="flex-wrap gap-1.5">
          <IconTarget className="size-3" />
          <span>Goal as submitted</span>
          <span className="text-muted-foreground/50">·</span>
          <span>{profileShortName(item.profileId)}</span>
          {task.inputArtifactIds?.length ? (
            <>
              <span className="text-muted-foreground/50">·</span>
              <span>{task.inputArtifactIds.length} input file(s)</span>
            </>
          ) : null}
          {item.scriptedDriver ? (
            <>
              <span className="text-muted-foreground/50">·</span>
              <span className="font-medium text-warning" title="A scripted driver replays fixed turns. No model is called.">
                Diagnostic (scripted, not a model): {item.scriptedDriver}
              </span>
            </>
          ) : null}
        </MessageFooter>
      </MessageContent>
    </Message>
  );
}

export function TurnMessage({
  item,
  terminal,
  screenshotInfo,
  actorOf,
}: {
  item: Extract<GeneralItem, { type: "turn" }>;
  terminal: boolean;
  screenshotInfo: ScreenshotInfo;
  actorOf?: ((op: Operation) => string) | undefined;
}) {
  const t = item.turn;
  return (
    <Message align="start">
      <MessageContent className="gap-2">
        <MessageHeader className="flex-wrap gap-1.5 px-0">
          <span className="flex size-5 items-center justify-center rounded-full bg-foreground text-background">
            <IconSparkles className="size-3" />
          </span>
          <span className="text-foreground/80">{t.title}</span>
          <span className="truncate font-normal" title={t.model ?? undefined}>
            {t.model ?? "model unknown"}
          </span>
          {item.scripted ? <Badge tone="warn">scripted, not a model</Badge> : null}
          {t.inputTokens !== null || t.outputTokens !== null ? (
            <span className="hidden font-normal tabular-nums sm:inline">
              · {t.inputTokens ?? "?"} in / {t.outputTokens ?? "?"} out
            </span>
          ) : null}
          {t.durationMs !== null ? <span className="font-normal tabular-nums">· {formatDurationMs(t.durationMs)}</span> : null}
          {item.finishReason === "length" ? <Badge tone="warn">output limit hit</Badge> : null}
        </MessageHeader>
        {item.image.attached ? (
          <p className="flex flex-wrap items-center gap-1 text-[11px] text-blue-700 dark:text-blue-300">
            <IconPhoto className="size-3" /> This turn received screenshot {item.image.artifactId ? <Mono>{item.image.artifactId}</Mono> : null}
            {item.image.sha256 ? <span>(sha256 {item.image.sha256.slice(0, 12)})</span> : null} as an image. It is untrusted page evidence, not instructions.
          </p>
        ) : null}
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
        {item.planned.length > 0 ? (
          <p className="text-[11px] text-muted-foreground" title="The tools this turn requested; the controller validates and dispatches each one.">
            plan: {item.planned.join(", ")}
          </p>
        ) : null}
        {item.rows.length > 0 ? (
          <div className="flex flex-col gap-1.5">
            {item.rows.map((row) =>
              row.type === "op" ? <OperationCard key={row.key} op={row.op} terminal={terminal} screenshotInfo={screenshotInfo} actorOf={actorOf} /> : <GeneralMark key={row.key} item={row} />,
            )}
          </div>
        ) : null}
        {item.notes.length > 0 ? (
          <ul className="flex flex-col gap-0.5 text-[11px] text-muted-foreground">
            {item.notes.map((n) => (
              <li key={n.seq} className="truncate" title={n.detail}>
                #{n.seq} {n.title}
              </li>
            ))}
          </ul>
        ) : null}
      </MessageContent>
    </Message>
  );
}

const MARK_ICONS: Record<RunEvent["kind"], ComponentType<{ className?: string }>> = {
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

function MarkIcon({ kind }: { kind: RunEvent["kind"] }) {
  const Icon = MARK_ICONS[kind];
  return <Icon className="size-3.5" />;
}

export function GeneralMark({ item }: { item: Extract<GeneralItem, { type: "mark" }> }) {
  const detail = item.detail.trim();
  const line = (
    <>
      <RowMark className={cn("size-6 rounded-md", item.tone !== "neutral" && TONE_TEXT[item.tone])}>
        <MarkIcon kind={item.kind} />
      </RowMark>
      <span title={item.title} className={cn("min-w-0 truncate text-[13px] font-medium", item.tone === "neutral" ? "text-foreground/80" : TONE_TEXT[item.tone])}>{item.title}</span>
      {item.state === "unknown" ? <Badge tone="warn">outcome unknown; not retried</Badge> : null}
      {detail.length > 0 ? <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{detail.split("\n")[0]}</span> : <span className="flex-1" />}
      <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/70">{formatTime(item.at)}</span>
    </>
  );
  if (detail.length === 0) return <div className="flex min-h-7 min-w-0 items-center gap-2.5">{line}</div>;
  return (
    <details className="tool-line min-w-0">
      <summary className="flex min-h-7 min-w-0 cursor-pointer list-none items-center gap-2.5 rounded-md [&::-webkit-details-marker]:hidden">{line}</summary>
      <pre className="mt-1 ml-[2.125rem] max-h-60 overflow-auto border-l pl-3 font-mono text-[11px] whitespace-pre-wrap break-words text-muted-foreground">{detail}</pre>
    </details>
  );
}

export function GeneralExport({ task, canExport }: { task: Task; canExport: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [grant, setGrant] = useState<ExportResponse | null>(null);
  const partial = task.outcome === "RESULT_PARTIAL";
  if (!exportable(task.outcome)) {
    return <p className="text-xs text-muted-foreground">An evidence bundle is sealed only for a verified or partial result; this task has none to export.</p>;
  }
  const request = async () => {
    setBusy(true);
    setError(null);
    try {
      setGrant(await createExport(task.id));
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  const href = grant ? exportUrl(grant.grantId) : null;
  const grantPartial = grant?.partial ?? partial;
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-muted-foreground">
        The sealed evidence bundle holds the task profile and input digests, the result and checks, outputs, the code the model wrote, screenshots
        with source URLs, saved page text, the full event log, model and sandbox identity, the egress record and the teardown receipts.
      </p>
      {partial ? (
        <Notice tone="warn" className="text-xs">
          Partial result: at least one completion check failed. The bundle is labelled partial (its file name ends in -partial.zip).
        </Notice>
      ) : null}
      {canExport ? (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant={grant ? "outline" : "default"} onClick={() => void request()} disabled={busy}>
            <IconKey />
            {busy ? "Sealing…" : grant ? "Request a new grant" : partial ? "Export partial evidence bundle" : "Export evidence bundle"}
          </Button>
          {grant && href ? (
            <Button size="sm" render={<a href={href} download />}>
              <IconDownload />
              Download {grantPartial ? "partial " : ""}bundle (zip)
            </Button>
          ) : null}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">Sign in as operator or judge to export.</p>
      )}
      {error ? <ErrorBox message={error} /> : null}
      {grant ? (
        <KeyValue
          className="text-xs"
          rows={[
            { key: "grant", value: <Mono wrap>{grant.grantId}</Mono> },
            { key: "outcome", value: grant.outcome ?? task.outcome ?? "—" },
            { key: "zip sha256", value: grant.zipDigest ? <Mono wrap>{grant.zipDigest}</Mono> : "—" },
            { key: "expires", value: formatDateTime(grant.expiresAt) },
          ]}
        />
      ) : null}
    </div>
  );
}

export function GeneralResultPanel({
  task,
  events,
  artifacts,
  artifactsError,
  canExport,
}: {
  task: Task;
  events: readonly RunEvent[];
  artifacts: Artifact[] | null;
  artifactsError: string | null;
  canExport: boolean;
}) {
  const r = resultView(task);
  const reason = outcomeReason(events, task.outcome) ?? task.error ?? null;
  const result = task.result;
  const checks = checkSummary(result?.checks);
  const byId = new Map((artifacts ?? []).map((a) => [a.id, a]));
  const cleanup = cleanupView(task.cleanup, task.status);
  return (
    <section
      aria-label="Result"
      className={cn(
        "flex flex-col gap-4 rounded-xl border bg-card p-4",
        r.tone === "ok" ? "border-success/40" : r.tone === "bad" ? "border-destructive/40" : r.tone === "warn" ? "border-warning/40" : "border-border",
      )}
    >
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <h2 className={cn("text-base font-semibold tracking-tight", TONE_TEXT[r.tone])}>{r.label}</h2>
          {task.outcome ? <span className="font-mono text-[11px] text-muted-foreground">{task.outcome}</span> : null}
          <span className="ml-auto flex items-center gap-1 text-xs">
            <span className="text-muted-foreground">cleanup</span>
            <CleanupDimensionBadge task={task} />
          </span>
        </div>
        {r.hint ? <p className="mt-1 text-sm text-pretty text-muted-foreground">{r.hint}</p> : null}
        {reason ? (
          <p className="mt-2 text-sm whitespace-pre-wrap break-words">
            <span className="text-muted-foreground">Recorded reason: </span>
            {reason}
          </p>
        ) : null}
        {!cleanup.environmentGone ? <p className="mt-2 text-xs text-muted-foreground">{cleanup.sentence}</p> : null}
      </div>

      {result ? (
        <>
          <div className="flex flex-col gap-1">
            <h3 className="text-sm font-medium">Summary</h3>
            <p className="text-[11px] text-muted-foreground">The model's summary as recorded with the result; the checks below are the controller's.</p>
            <p className="text-sm whitespace-pre-wrap break-words">{result.summary || "(empty)"}</p>
          </div>

          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-medium">Completion checks</h3>
              <Badge tone={checks.tone}>{checks.label}</Badge>
            </div>
            {result.checks.length > 0 ? (
              <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full border-collapse text-left text-xs">
                  <thead className="bg-muted/60">
                    <tr>
                      <th className="px-2 py-1 font-medium">check</th>
                      <th className="px-2 py-1 font-medium">result</th>
                      <th className="px-2 py-1 font-medium">detail</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.checks.map((c) => (
                      <tr key={c.name} className="border-t border-border align-top">
                        <td className="px-2 py-1 font-mono whitespace-nowrap">{c.name}</td>
                        <td className="px-2 py-1">
                          <Badge tone={c.passed ? "ok" : "bad"}>{c.passed ? "pass" : "fail"}</Badge>
                        </td>
                        <td className="px-2 py-1 break-words text-muted-foreground">{c.detail}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </div>

          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-medium">Outputs ({result.outputArtifactIds.length})</h3>
            {artifactsError ? <p className="text-xs text-destructive">Artifacts unavailable: {artifactsError}</p> : null}
            {result.outputArtifactIds.length === 0 ? <p className="text-xs text-muted-foreground">No output file was collected.</p> : null}
            {result.outputArtifactIds.map((id) => {
              const a = byId.get(id);
              return a ? (
                <div key={id} className="flex flex-col gap-1.5 rounded-lg border border-border p-2.5">
                  <ArtifactLine artifact={a} compact />
                  <ArtifactPreview artifact={a} />
                </div>
              ) : (
                <p key={id} className="text-xs text-muted-foreground">
                  <Mono>{id}</Mono> {artifacts ? "(not listed for this task)" : "(loading…)"}
                </p>
              );
            })}
          </div>

          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-medium">Sources ({result.sources.length})</h3>
            {result.sources.length === 0 ? <p className="text-xs text-muted-foreground">No source was cited.</p> : null}
            <ul className="flex flex-col gap-2">
              {result.sources.map((s, i) => {
                const href = httpUrl(s.url);
                return (
                  <li key={`${s.url}-${i}`} className="flex flex-col gap-1 rounded-lg border border-border p-2.5 text-xs">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <IconWorld className="size-3.5 shrink-0 text-muted-foreground" />
                      {href ? (
                        <a className="min-w-0 truncate underline underline-offset-4" href={href} target="_blank" rel="noreferrer noopener" title={s.url}>
                          {s.url}
                        </a>
                      ) : (
                        <span className="min-w-0 break-all">{s.url}</span>
                      )}
                    </span>
                    {s.title ? <span className="text-muted-foreground">{s.title}</span> : null}
                    {s.screenshotArtifactId ? <Screenshot artifactId={s.screenshotArtifactId} url={s.url} sha256={byId.get(s.screenshotArtifactId)?.sha256} capturedAt={byId.get(s.screenshotArtifactId)?.createdAt} /> : null}
                  </li>
                );
              })}
            </ul>
          </div>
        </>
      ) : (
        <p className="text-xs text-muted-foreground">No TaskResult was recorded: nothing was checked or collected.</p>
      )}

      <div className="flex flex-col gap-2 border-t border-border pt-3">
        <h3 className="text-sm font-medium">Evidence bundle</h3>
        <GeneralExport task={task} canExport={canExport} />
      </div>
      <div className="flex flex-wrap gap-1.5">
        <Chip>{profileShortName(task.profileId)}</Chip>
        {task.egressAllow?.length ? <Chip title={task.egressAllow.join(", ")}>{task.egressAllow.length} allowed destination(s)</Chip> : null}
      </div>
    </section>
  );
}
