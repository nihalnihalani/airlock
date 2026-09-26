import { useEffect, useState } from "react";
import type { Task } from "@airlock/contracts";
import { describeError, listTasks } from "../lib/api";
import { formatDateTime, PHASE_LABEL } from "../lib/format";
import { hrefFor } from "../lib/router";
import { OutcomeBadge, StatusBadge } from "../components/PhaseRail";
import { ErrorBox, Loading, Mono, Section } from "../components/ui";

export function TasksPage() {
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    listTasks(controller.signal)
      .then((list) => setTasks(list.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt))))
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(describeError(err));
      });
    return () => controller.abort();
  }, [reloadKey]);

  return (
    <div className="page">
      <Section
        title="Tasks"
        aside={
          <button type="button" className="btn btn-small" onClick={() => setReloadKey((k) => k + 1)}>
            Refresh
          </button>
        }
      >
        {error ? <ErrorBox message={error} onRetry={() => setReloadKey((k) => k + 1)} /> : null}
        {!tasks && !error ? <Loading /> : null}
        {tasks && tasks.length === 0 ? <p className="muted">No tasks yet.</p> : null}
        {tasks && tasks.length > 0 ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Task</th>
                  <th>Profile</th>
                  <th>Status</th>
                  <th>Phase</th>
                  <th>Outcome</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {tasks.map((t) => (
                  <tr key={t.id}>
                    <td>
                      <a href={hrefFor({ name: "task", id: t.id })}>
                        <Mono>{t.id}</Mono>
                      </a>
                    </td>
                    <td>{t.profileId}</td>
                    <td>
                      <StatusBadge status={t.status} />
                    </td>
                    <td>{PHASE_LABEL[t.phase]}</td>
                    <td>{t.outcome ? <OutcomeBadge outcome={t.outcome} /> : <span className="muted">—</span>}</td>
                    <td>{formatDateTime(t.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </Section>
    </div>
  );
}
