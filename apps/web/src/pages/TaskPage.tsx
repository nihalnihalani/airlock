import { IconLayoutSidebarRight, IconPlayerStopFilled, IconPlus } from "@tabler/icons-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TaskView } from "@airlock/contracts";
import { Badge, Dot, ErrorBox, Notice, type Tone } from "../components/common";
import { STREAM_LABEL, TaskDetail } from "../components/detail/task-detail";
import { DetailPanel } from "../components/layout/detail-panel";
import { PageHeader } from "../components/layout/page-header";
import { OutcomeBadge, PhaseRail, RuntimeChip } from "../components/PhaseRail";
import { ComposerFrame } from "../components/thread/composer-frame";
import { AssistantMessage, MarkRow, ResultCard, StandaloneTool, UserMessage, WorkingRow } from "../components/thread/thread-items";
import { Button } from "../components/ui/button";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerViewport,
  useStickToBottom,
} from "../components/ui/message-scroller";
import { Skeleton } from "../components/ui/skeleton";
import { canOperate, useSession } from "../hooks/session";
import { useSharedTaskList } from "../hooks/useTaskList";
import { useTaskEvents, type StreamStatus } from "../hooks/useTaskEvents";
import { CleanupBadge, DiagnosticBadge, RepairDisabledBanner } from "../components/Evidence";
import { ApiError, cancelTask, describeError, getTask } from "../lib/api";
import { cleanupStatus, isDiagnostic, type CleanupStatus } from "../lib/evidence";
import { extractCheckpoints, runtimeTier } from "../lib/eventViews";
import { isTerminalStatus, PHASE_LABEL, STATUS_LABEL } from "../lib/format";
import { hrefFor } from "../lib/router";
import { issueTitle } from "../lib/taskList";
import { buildThread, type ThreadItem } from "../lib/thread";

const POLL_MS = 4000;

type Group = { key: string; items: ThreadItem[]; activity: boolean };

/** Messages stand alone; consecutive marks and system executions stack tightly as one activity block. */
function groupItems(items: ThreadItem[]): Group[] {
  const groups: Group[] = [];
  for (const item of items) {
    const activity = item.type === "mark" || item.type === "tool";
    const last = groups[groups.length - 1];
    if (activity && last?.activity) last.items.push(item);
    else groups.push({ key: item.key, items: [item], activity });
  }
  return groups;
}
const EVENT_REFRESH_DEBOUNCE_MS = 300;
const DETAIL_WIDTH = 420;
const DETAIL_STORAGE_KEY = "airlock-task-details";

function streamTone(status: StreamStatus): Tone {
  switch (status) {
    case "open":
      return "ok";
    case "connecting":
    case "reconnecting":
      return "warn";
    case "closed":
    case "unsupported":
      return "bad";
    case "ended":
    case "idle":
      return "neutral";
  }
}

/**
 * Open by default only where the pane fits beside the thread (sidebar + 400px thread + pane); on a
 * narrower window it would be a sheet covering the conversation before anybody asked for it.
 */
function readDetailPref(): boolean {
  const wide = typeof window.matchMedia === "function" && window.matchMedia(`(min-width: ${320 + 400 + DETAIL_WIDTH}px)`).matches;
  if (!wide) return false;
  try {
    return window.localStorage.getItem(DETAIL_STORAGE_KEY) !== "closed";
  } catch {
    return true;
  }
}

function writeDetailPref(open: boolean) {
  try {
    window.localStorage.setItem(DETAIL_STORAGE_KEY, open ? "open" : "closed");
  } catch {
    // not remembered
  }
}

function ThreadRow({ item, view, cleanup, onOpenDetails }: { item: ThreadItem; view: TaskView | null; cleanup: CleanupStatus; onOpenDetails: () => void }) {
  switch (item.type) {
    case "user":
      return <UserMessage item={item} />;
    case "assistant":
      return <AssistantMessage item={item} onOpenDetails={onOpenDetails} />;
    case "tool":
      return <StandaloneTool item={item} />;
    case "mark":
      return <MarkRow item={item} />;
    case "result":
      return <ResultCard item={item} view={view} cleanup={cleanup} onOpenDetails={onOpenDetails} />;
    case "working":
      return <WorkingRow item={item} />;
  }
}

function ThreadSkeleton() {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 py-6" aria-hidden>
      <div className="flex justify-end">
        <Skeleton className="h-16 w-72 rounded-xl bg-muted/60" />
      </div>
      {["w-3/4", "w-full", "w-2/3"].map((w) => (
        <Skeleton key={w} className={`h-4 bg-muted/60 ${w}`} />
      ))}
    </div>
  );
}

export function TaskPage({ id }: { id: string }) {
  const session = useSession();
  const roster = useSharedTaskList();
  const [view, setView] = useState<TaskView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [cancelBusy, setCancelBusy] = useState(false);
  const [lastFetch, setLastFetch] = useState<string | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(readDetailPref);
  const inflight = useRef<AbortController | null>(null);

  const terminal = view ? isTerminalStatus(view.task.status) : false;
  const stream = useTaskEvents(id, true, !terminal);

  const refresh = useCallback(async () => {
    inflight.current?.abort();
    const controller = new AbortController();
    inflight.current = controller;
    try {
      const next = await getTask(id, controller.signal);
      if (controller.signal.aborted) return;
      setView(next);
      setLoadError(null);
      setLastFetch(new Date().toISOString());
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setLoadError(
        err instanceof ApiError && err.status === 401
          ? "Sign in to read this case: task data needs a session."
          : err instanceof ApiError && (err.status === 404 || err.status === 403)
            ? `This case does not exist or is not visible to this session (HTTP ${err.status}). A judge sees only the cases its own session started.`
            : describeError(err),
      );
    }
  }, [id]);

  useEffect(() => {
    setView(null);
    setLoadError(null);
    setCancelError(null);
    void refresh();
    return () => inflight.current?.abort();
  }, [refresh]);

  // Poll while the task is not terminal (covers a dead stream and controller restarts).
  useEffect(() => {
    if (terminal) return;
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [terminal, refresh]);

  // Refetch the authoritative view shortly after state-changing events arrive.
  const lastSeq = stream.log.lastSeq;
  const lastKind = stream.log.events[stream.log.events.length - 1]?.kind;
  useEffect(() => {
    if (lastSeq === null) return;
    if (lastKind !== "phase" && lastKind !== "lifecycle" && lastKind !== "artifact" && lastKind !== "error" && lastKind !== "check") return;
    const timer = setTimeout(() => void refresh(), EVENT_REFRESH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [lastSeq, lastKind, refresh]);

  useEffect(() => {
    if (stream.status === "ended") void refresh();
  }, [stream.status, refresh]);

  // The roster shows this task's status too; nudge it when this view learns something new.
  const status = view?.task.status;
  const outcome = view?.task.outcome;
  const rosterRefresh = roster.refresh;
  useEffect(() => {
    if (status) rosterRefresh();
  }, [status, outcome, rosterRefresh]);

  const checkpoints = useMemo(() => extractCheckpoints(view, stream.log.events), [view, stream.log.events]);
  const tier = useMemo(() => runtimeTier(checkpoints), [checkpoints]);
  const items = useMemo(() => buildThread(view?.task ?? null, stream.log.events), [view?.task, stream.log.events]);
  const groups = useMemo(() => groupItems(items), [items]);
  const cleanup = useMemo(() => cleanupStatus({ status: view?.task.status ?? "queued" }, stream.log.events), [view?.task.status, stream.log.events]);
  const scroller = useStickToBottom(`${lastSeq ?? -1}:${items.length}:${status ?? ""}`);

  const setDetails = (open: boolean) => {
    setDetailsOpen(open);
    writeDetailPref(open);
  };

  const cancel = async () => {
    if (!window.confirm("Cancel this task? The supervisor will revoke dispatch and stop the sandbox.")) return;
    setCancelBusy(true);
    setCancelError(null);
    try {
      const task = await cancelTask(id);
      setView((v) => (v ? { ...v, task } : v));
      void refresh();
      roster.refresh();
    } catch (err) {
      setCancelError(describeError(err));
    } finally {
      setCancelBusy(false);
    }
  };

  const task = view?.task ?? null;
  const title = task ? issueTitle(task.issueText) : "Loading case…";
  const canCancel = task !== null && canOperate(session.role) && (task.status === "queued" || task.status === "running");

  const header = (
    <PageHeader
      actions={
        <>
          <span className="hidden items-center gap-1.5 text-xs text-muted-foreground sm:flex" title={stream.note ?? undefined}>
            <Dot tone={streamTone(stream.status)} pulse={stream.status === "open" && !terminal} />
            {STREAM_LABEL[stream.status]}
          </span>
          <span className="hidden md:inline-flex">
            <RuntimeChip tier={tier} />
          </span>
          <Button
            aria-label={detailsOpen ? "Hide details" : "Show details"}
            aria-pressed={detailsOpen}
            title="Checkpoints, cases, preview and download"
            className={detailsOpen ? "bg-foreground/5" : undefined}
            onClick={() => setDetails(!detailsOpen)}
            variant="ghost"
            size="icon"
          >
            <IconLayoutSidebarRight className="size-4.5" />
          </Button>
        </>
      }
    >
      <span className="min-w-0 truncate text-sm tracking-tight" title={title}>
        {title}
      </span>
      {task && isDiagnostic(task) ? <DiagnosticBadge className="shrink-0" /> : null}
      {task?.outcome ? (
        <span className="hidden shrink-0 lg:inline-flex">
          <OutcomeBadge outcome={task.outcome} />
        </span>
      ) : null}
    </PageHeader>
  );

  return (
    <DetailPanel
      open={detailsOpen && view !== null}
      onClose={() => setDetails(false)}
      detailWidth={DETAIL_WIDTH}
      title={<span className="px-2 text-sm font-medium">Details</span>}
      detail={
        view ? (
          <TaskDetail
            view={view}
            events={stream.log.events}
            checkpoints={checkpoints}
            tier={tier}
            stream={{
              status: stream.status,
              note: stream.note,
              count: stream.log.events.length,
              dropped: stream.log.dropped,
              malformed: stream.log.malformed,
            }}
            lastFetch={lastFetch}
            canOperate={canOperate(session.role)}
            onReconnect={stream.reconnect}
            onRefresh={() => void refresh()}
          />
        ) : null
      }
    >
      {header}
      {!view && loadError ? (
        <div className="mx-auto w-full max-w-2xl p-4">
          <ErrorBox message={loadError} onRetry={() => void refresh()} />
        </div>
      ) : !view ? (
        <ThreadSkeleton />
      ) : (
        <>
          <div className="flex min-h-0 flex-1">
            <MessageScroller>
              <MessageScrollerViewport ref={scroller.viewportRef}>
                <MessageScrollerContent ref={scroller.contentRef} className="mx-auto w-full max-w-2xl px-4 py-6" aria-busy={!terminal}>
                  {task?.repairDisabledReason ? <RepairDisabledBanner reason={task.repairDisabledReason} className="mb-4" /> : null}
                  {stream.log.dropped > 0 ? (
                    <Notice className="text-xs">{stream.log.dropped} older events were dropped from this view; the full log is in the export.</Notice>
                  ) : null}
                  {groups.map((group) => (
                    <MessageScrollerItem key={group.key} className="flex flex-col gap-1.5 animate-in fade-in-0 duration-300 motion-reduce:animate-none">
                      {group.items.map((item) => (
                        <ThreadRow key={item.key} item={item} view={view} cleanup={cleanup} onOpenDetails={() => setDetails(true)} />
                      ))}
                    </MessageScrollerItem>
                  ))}
                </MessageScrollerContent>
              </MessageScrollerViewport>
              <MessageScrollerButton active={!scroller.atEnd} onClick={() => scroller.scrollToEnd("smooth")} />
            </MessageScroller>
          </div>
          <ComposerFrame
            above={
              <div className="mb-2 flex flex-col gap-2">
                {loadError ? <ErrorBox message={`Could not refresh the task view: ${loadError}`} onRetry={() => void refresh()} /> : null}
                {cancelError ? <ErrorBox message={cancelError} /> : null}
                {stream.note && (stream.status === "closed" || stream.status === "reconnecting" || stream.status === "unsupported") ? (
                  <Notice tone={streamTone(stream.status) === "bad" ? "bad" : "warn"} className="text-xs">
                    {stream.note}
                  </Notice>
                ) : null}
              </div>
            }
            footnote="Nothing typed here reaches the model: its inputs are fixed by the control plane (issue text, profile, tool results)."
          >
            {task ? <PhaseRail task={task} /> : null}
            <div className="flex items-center gap-3">
              <div className="min-w-0 flex-1 text-sm">
                {task ? (
                  task.outcome ? (
                    <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                      <OutcomeBadge outcome={task.outcome} />
                      <span className="text-pretty text-muted-foreground">Finished in the {PHASE_LABEL[task.phase].toLowerCase()} phase</span>
                      <CleanupBadge cleanup={cleanup} />
                    </span>
                  ) : terminal ? (
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <Badge tone={task.status === "cancelled" ? "neutral" : "bad"}>{STATUS_LABEL[task.status]}</Badge>
                      <span className="text-pretty text-muted-foreground">No outcome was recorded</span>
                      <CleanupBadge cleanup={cleanup} />
                    </span>
                  ) : (
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="tool-line-running text-muted-foreground">
                        {STATUS_LABEL[task.status]} · {PHASE_LABEL[task.phase]} phase
                      </span>
                      {task.status === "cancelling" ? <CleanupBadge cleanup={cleanup} /> : null}
                    </span>
                  )
                ) : null}
              </div>
              {canCancel ? (
                <Button
                  aria-label="Cancel the task"
                  title="Cancel: revoke dispatch, stop the sandbox, fence late results"
                  className="rounded-full"
                  size="sm"
                  variant="destructive"
                  onClick={() => void cancel()}
                  disabled={cancelBusy}
                >
                  <IconPlayerStopFilled className="size-3" />
                  {cancelBusy ? "Cancelling…" : "Cancel"}
                </Button>
              ) : terminal ? (
                <Button size="sm" variant="outline" className="rounded-full" render={<a href={hrefFor({ name: "new" })} />}>
                  <IconPlus />
                  New case
                </Button>
              ) : null}
            </div>
          </ComposerFrame>
        </>
      )}
    </DetailPanel>
  );
}
