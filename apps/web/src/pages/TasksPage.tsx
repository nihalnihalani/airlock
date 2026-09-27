import { IconBug, IconRefresh } from "@tabler/icons-react";
import { Badge, Dot, ErrorBox, TONE_TEXT, type Tone } from "../components/common";
import { DiagnosticBadge } from "../components/Evidence";
import { PageHeader } from "../components/layout/page-header";
import { Button } from "../components/ui/button";
import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "../components/ui/item";
import { Separator } from "../components/ui/separator";
import { useSession } from "../hooks/session";
import { useNow, useSharedTaskList } from "../hooks/useTaskList";
import { formatDateTime } from "../lib/format";
import { hrefFor } from "../lib/router";
import { taskRowView, type TaskDot } from "../lib/taskList";
import { cn } from "../lib/utils";

const DOT_TONE: Record<TaskDot, Tone> = {
  queued: "neutral",
  running: "info",
  cancelling: "warn",
  ok: "ok",
  warn: "warn",
  bad: "bad",
  neutral: "neutral",
};

/** Every case, every owner, as rows in a card (OpenBot's PageShell/PageRows shape). */
export function TasksPage() {
  const { tasks, error, refresh } = useSharedTaskList();
  const session = useSession();
  const now = useNow();
  const rows = (tasks ?? []).map((t) => ({ row: taskRowView(t, now), task: t }));
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        actions={
          <Button size="icon" variant="ghost" aria-label="Refresh" onClick={refresh}>
            <IconRefresh className="size-4.5" />
          </Button>
        }
      >
        <span className="text-sm tracking-tight">All cases</span>
      </PageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-2xl flex-col px-4 pt-8 pb-12">
          <h1 className="text-2xl font-bold">Cases</h1>
          <p className="mt-2 text-sm text-muted-foreground">The cases this session may read, newest first: every case for the operator, only its own for a judge.</p>
          {error ? <ErrorBox className="mt-4" message={error} onRetry={refresh} /> : null}
          {tasks !== null && tasks.length === 0 ? (
            <p className="mt-4 text-sm text-muted-foreground">
              {session.role === "viewer" && !session.loading ? (
                <>
                  Signed out: no case data is fetched.{" "}
                  <a className="font-medium text-foreground underline underline-offset-4" href={hrefFor({ name: "login" })}>
                    Sign in
                  </a>{" "}
                  to see cases.
                </>
              ) : (
                "No cases yet."
              )}
            </p>
          ) : null}
          {rows.length > 0 ? (
            <div className="mt-4 overflow-hidden rounded-lg border border-border bg-card dark:border-transparent [&_[data-slot=item]]:rounded-none">
              {rows.map(({ row, task }, i) => (
                <div key={row.id}>
                  {i > 0 ? <Separator /> : null}
                  <Item size="sm" render={<a href={hrefFor({ name: "task", id: row.id })} />}>
                    <ItemMedia variant="icon" className="size-9 rounded-lg bg-muted/60 text-muted-foreground">
                      <IconBug />
                    </ItemMedia>
                    <ItemContent className="min-w-0">
                      <ItemTitle className="w-full truncate">{row.title}</ItemTitle>
                      <ItemDescription className="line-clamp-1 text-xs">
                        {row.profileId} · {formatDateTime(task.createdAt)} · <span className="font-mono">{row.id}</span>
                      </ItemDescription>
                    </ItemContent>
                    <ItemActions className="gap-1.5">
                      {row.scripted ? <DiagnosticBadge /> : null}
                      {task.repairDisabledReason ? (
                        <Badge tone="warn" title={task.repairDisabledReason}>
                          baseline only
                        </Badge>
                      ) : null}
                      <Dot tone={DOT_TONE[row.dot]} pulse={row.live} />
                      <span className={cn("text-xs font-medium", TONE_TEXT[row.badge.tone])}>{row.badge.label}</span>
                    </ItemActions>
                  </Item>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
