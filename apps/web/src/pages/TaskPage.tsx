import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TaskView } from "@airlock/contracts";
import { canOperate, useSession } from "../hooks/session";
import { useTaskEvents, type StreamStatus } from "../hooks/useTaskEvents";
import { cancelTask, describeError, getTask } from "../lib/api";
import { extractCheckpoints, runtimeTier } from "../lib/eventViews";
import { formatDateTime, formatTime, isTerminalStatus, OUTCOME_HINT } from "../lib/format";
import { CaseTable } from "../components/CaseTable";
import { CheckpointsPanel } from "../components/CheckpointsPanel";
import { ExecLogPanel } from "../components/ExecLogPanel";
import { ExportPanel } from "../components/ExportPanel";
import { ModelCallsPanel } from "../components/ModelCallsPanel";
import { OutcomeBadge, PhaseRail, RuntimeChip, StatusBadge } from "../components/PhaseRail";
import { PreviewForm } from "../components/PreviewForm";
import { Badge, Chip, Digest, ErrorBox, KeyValue, Loading, Mono, Notice, Pre, Section, type Tone } from "../components/ui";

const POLL_MS = 4000;
const EVENT_REFRESH_DEBOUNCE_MS = 300;

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

const STREAM_LABEL: Record<StreamStatus, string> = {
  idle: "stream idle",
  connecting: "connecting",
  open: "live",
  reconnecting: "reconnecting",
  closed: "disconnected",
  ended: "stream ended",
  unsupported: "no EventSource",
};

export function TaskPage({ id }: { id: string }) {
  const session = useSession();
  const [view, setView] = useState<TaskView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [cancelBusy, setCancelBusy] = useState(false);
  const [lastFetch, setLastFetch] = useState<string | null>(null);
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
      setLoadError(describeError(err));
    }
  }, [id]);

  // Initial load and reset on id change.
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
    if (lastKind !== "phase" && lastKind !== "lifecycle" && lastKind !== "artifact" && lastKind !== "error" && lastKind !== "check")
      return;
    const timer = setTimeout(() => void refresh(), EVENT_REFRESH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [lastSeq, lastKind, refresh]);

  // One last fetch when the stream ends, so the terminal view is current.
  useEffect(() => {
    if (stream.status === "ended") void refresh();
  }, [stream.status, refresh]);

  const checkpoints = useMemo(() => extractCheckpoints(view, stream.log.events), [view, stream.log.events]);
  const tier = useMemo(() => runtimeTier(checkpoints), [checkpoints]);
  const caseTitles = useMemo(() => new Map<string, string>(), []);

  const cancel = async () => {
    if (!window.confirm("Cancel this task? The supervisor will revoke dispatch and stop the sandbox.")) return;
    setCancelBusy(true);
    setCancelError(null);
    try {
      const task = await cancelTask(id);
      setView((v) => (v ? { ...v, task } : v));
      void refresh();
    } catch (err) {
      setCancelError(describeError(err));
    } finally {
      setCancelBusy(false);
    }
  };

  if (!view && !loadError) return <Loading label="Loading task…" />;
  if (!view && loadError) {
    return (
      <div className="page">
        <ErrorBox message={loadError} onRetry={() => void refresh()} />
      </div>
    );
  }
  if (!view) return null;

  const { task } = view;
  const canCancel = canOperate(session.role) && (task.status === "queued" || task.status === "running");
  const passed = task.outcome === "CANDIDATE_PASSED_CHECKS";
  const showArtifacts = passed && task.candidateDigest !== undefined && task.verificationRecordId !== undefined;

  return (
    <div className="page">
      <header className="task-head">
        <div className="task-title">
          <h1>
            Task <Mono>{task.id}</Mono>
          </h1>
          <div className="chips">
            <Chip>{task.profileId}</Chip>
            <StatusBadge status={task.status} />
            {task.outcome ? <OutcomeBadge outcome={task.outcome} /> : null}
            <RuntimeChip tier={tier} />
            <Badge tone={streamTone(stream.status)} title={stream.note ?? undefined}>
              {STREAM_LABEL[stream.status]}
            </Badge>
          </div>
        </div>
        <div className="btn-row">
          {canCancel ? (
            <button type="button" className="btn btn-danger" onClick={() => void cancel()} disabled={cancelBusy}>
              {cancelBusy ? "Cancelling…" : "Cancel"}
            </button>
          ) : null}
          <button type="button" className="btn btn-small" onClick={() => void refresh()}>
            Refresh
          </button>
          {stream.status === "closed" || stream.status === "ended" ? (
            <button type="button" className="btn btn-small" onClick={stream.reconnect}>
              Reconnect stream
            </button>
          ) : null}
        </div>
      </header>

      {loadError ? <ErrorBox message={`Could not refresh the task view: ${loadError}`} onRetry={() => void refresh()} /> : null}
      {cancelError ? <ErrorBox message={cancelError} /> : null}
      {stream.note && stream.status !== "open" ? <Notice tone={streamTone(stream.status)}>{stream.note}</Notice> : null}
      {task.error ? <Notice tone="bad">Task error: {task.error}</Notice> : null}
      {tier.runtime === "runc" || tier.devUnsafe ? (
        <Notice tone="bad">
          This run executed on plain runc (dev-unsafe). That is a local development configuration, never a deployment;
          gVisor is the floor and Kata the target.
        </Notice>
      ) : null}

      <PhaseRail task={task} />
      {task.outcome ? <p className="outcome-hint">{OUTCOME_HINT[task.outcome]}</p> : null}

      <Section title="Run">
        <KeyValue
          rows={[
            { key: "owner", value: task.owner },
            { key: "attempt", value: task.attemptId ? <Mono>{task.attemptId}</Mono> : <span className="muted">none yet</span> },
            { key: "generation", value: String(task.generation) },
            { key: "attempts", value: String(task.attempts) },
            {
              key: "budget",
              value: `${task.budget.modelCallsUsed} model calls · ${task.budget.repairAttemptsUsed} repair attempts used`,
            },
            { key: "lease", value: task.leaseId ? `${task.leaseId} until ${task.leaseUntil ? formatDateTime(task.leaseUntil) : "?"}` : "none" },
            { key: "candidate digest", value: task.candidateDigest ? <Digest value={task.candidateDigest} /> : <span className="muted">not sealed</span> },
            { key: "baseline record", value: task.baselineRecordId ? <Mono>{task.baselineRecordId}</Mono> : <span className="muted">—</span> },
            { key: "verification record", value: task.verificationRecordId ? <Mono>{task.verificationRecordId}</Mono> : <span className="muted">—</span> },
            { key: "created", value: formatDateTime(task.createdAt) },
            { key: "updated", value: formatDateTime(task.updatedAt) },
            { key: "view fetched", value: lastFetch ? formatTime(lastFetch) : "—" },
            {
              key: "events",
              value: `${stream.log.events.length}${stream.log.dropped > 0 ? ` (+${stream.log.dropped} older dropped from view)` : ""}${
                stream.log.malformed > 0 ? ` · ${stream.log.malformed} malformed ignored` : ""
              }`,
            },
          ]}
        />
        <details className="details">
          <summary>Issue text as submitted</summary>
          <Pre className="pre-small">{task.issueText}</Pre>
        </details>
      </Section>

      <CheckpointsPanel cp={checkpoints} />
      <CaseTable baseline={view.baseline} verification={view.verification} titles={caseTitles} />

      {view.manifest ? (
        <Section title="Sealed source manifest">
          <KeyValue
            rows={[
              { key: "baseline commit", value: <Mono>{view.manifest.baselineCommit}</Mono> },
              { key: "baseline tree digest", value: <Digest value={view.manifest.baselineTreeDigest} /> },
              {
                key: "replacements",
                value:
                  view.manifest.replacements.length === 0 ? (
                    <span className="muted">none</span>
                  ) : (
                    <ul className="plain-list">
                      {view.manifest.replacements.map((r) => (
                        <li key={r.path}>
                          <Mono>{r.path}</Mono> · {r.byteLength} bytes · <Digest value={r.sha256} />
                        </li>
                      ))}
                    </ul>
                  ),
              },
            ]}
          />
        </Section>
      ) : null}

      {showArtifacts && task.candidateDigest && task.verificationRecordId ? (
        <>
          <PreviewForm taskId={task.id} candidateDigest={task.candidateDigest} />
          <ExportPanel
            taskId={task.id}
            candidateDigest={task.candidateDigest}
            verificationRecordId={task.verificationRecordId}
            canExport={canOperate(session.role)}
          />
        </>
      ) : null}

      <ModelCallsPanel events={stream.log.events} />
      <ExecLogPanel events={stream.log.events} />

      <Section title="All events" aside={<span className="muted">{stream.log.events.length}</span>}>
        {stream.log.events.length === 0 ? (
          <p className="muted">No events received yet.</p>
        ) : (
          <ul className="timeline">
            {stream.log.events.map((ev) => (
              <li key={ev.seq} className={`timeline-item timeline-${ev.kind}`}>
                <span className="muted mono-small">
                  #{ev.seq} {formatTime(ev.at)}
                </span>
                <Chip>{ev.kind}</Chip>
                <span>{ev.title}</span>
                {ev.detail.length > 0 ? (
                  <details className="details">
                    <summary>detail</summary>
                    <Pre className="pre-small">{ev.detail.length > 8000 ? `${ev.detail.slice(0, 8000)}…` : ev.detail}</Pre>
                  </details>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
