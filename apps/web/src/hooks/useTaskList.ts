/**
 * The task roster, kept live by polling `GET /api/tasks` (there is no roster stream). Polling pauses
 * while the tab is hidden and resumes with an immediate fetch; `refresh` lets a caller that just
 * changed a task (create, cancel) update the roster without waiting for the next tick.
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { Task } from "@airlock/contracts";
import { describeError, listTasks } from "../lib/api";
import { sortTasks } from "../lib/taskList";

const POLL_MS = 3000;

export interface TaskList {
  tasks: Task[] | null;
  error: string | null;
  refresh: () => void;
}

export function useTaskList(): TaskList {
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inflight = useRef<AbortController | null>(null);

  /** Fetch now; `poll` skips the tick while a previous fetch is still out, so a slow API still answers. */
  const load = useCallback((poll: boolean) => {
    if (poll && inflight.current && !inflight.current.signal.aborted) return;
    inflight.current?.abort();
    const controller = new AbortController();
    inflight.current = controller;
    listTasks(controller.signal)
      .then((list) => {
        if (controller.signal.aborted) return;
        setTasks(sortTasks(list));
        setError(null);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(describeError(err));
      })
      .finally(() => {
        if (inflight.current === controller) inflight.current = null;
      });
  }, []);
  const refresh = useCallback(() => load(false), [load]);
  const poll = useCallback(() => load(true), [load]);

  useEffect(() => {
    refresh();
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer === null) timer = setInterval(poll, POLL_MS);
    };
    const stop = () => {
      if (timer !== null) clearInterval(timer);
      timer = null;
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        refresh();
        start();
      } else stop();
    };
    if (document.visibilityState !== "hidden") start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
      inflight.current?.abort();
    };
  }, [refresh, poll]);

  return { tasks, error, refresh };
}

/** A clock for relative times; ticks every `ms`. */
export function useNow(ms = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}

export const TaskListContext = createContext<TaskList | null>(null);

/** The app's one roster, provided by the shell. */
export function useSharedTaskList(): TaskList {
  const ctx = useContext(TaskListContext);
  if (!ctx) throw new Error("useSharedTaskList must be used inside TaskListContext");
  return ctx;
}
