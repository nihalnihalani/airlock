/**
 * Live RunEvent stream for one task over EventSource.
 *
 * - The browser sends `Last-Event-ID` automatically on its own reconnects (the server uses `seq`
 *   as the event id). When the stream is closed for good (readyState CLOSED) we reopen it ourselves
 *   with exponential backoff and `?lastEventId=<seq>` so replay still starts after what we have.
 * - Events are deduplicated by seq, kept sorted and bounded (see eventLog.ts).
 * - `status` is visible in the UI so a stalled or dead stream is never mistaken for "no news".
 */
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { appendEvents, emptyLog, noteMalformed, parseEventPayload, RUN_EVENT_NAMES, isServerMessage, type EventLog } from "../lib/eventLog";
import type { RunEvent } from "@airlock/contracts";

export type StreamStatus = "idle" | "connecting" | "open" | "reconnecting" | "closed" | "ended" | "unsupported";

type Action = { type: "append"; events: RunEvent[] } | { type: "malformed" } | { type: "reset" };

function reducer(state: EventLog, action: Action): EventLog {
  switch (action.type) {
    case "append":
      return appendEvents(state, action.events);
    case "malformed":
      return noteMalformed(state);
    case "reset":
      return emptyLog();
  }
}

const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 30_000;

export interface TaskEventStream {
  log: EventLog;
  status: StreamStatus;
  /** Human-readable note about the last connection problem, if any. */
  note: string | null;
  reconnect: () => void;
}

/**
 * @param active        open the stream at all
 * @param autoReconnect reopen a CLOSED stream with backoff; false once the task is terminal so a
 *                      server that closes finished streams is not hammered.
 */
export function useTaskEvents(taskId: string | null, active: boolean, autoReconnect = true): TaskEventStream {
  const [log, dispatch] = useReducer(reducer, undefined, emptyLog);
  const [status, setStatus] = useState<StreamStatus>("idle");
  const [note, setNote] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const lastSeqRef = useRef<number | null>(null);
  const backoffRef = useRef(BACKOFF_MIN_MS);
  const autoReconnectRef = useRef(autoReconnect);
  lastSeqRef.current = log.lastSeq;
  autoReconnectRef.current = autoReconnect;

  useEffect(() => {
    dispatch({ type: "reset" });
    lastSeqRef.current = null;
    backoffRef.current = BACKOFF_MIN_MS;
  }, [taskId]);

  const reconnect = useCallback(() => {
    backoffRef.current = BACKOFF_MIN_MS;
    setAttempt((n) => n + 1);
  }, []);

  useEffect(() => {
    if (!taskId || !active) {
      setStatus((s) => (s === "ended" ? s : "idle"));
      return;
    }
    if (typeof EventSource === "undefined") {
      setStatus("unsupported");
      setNote("This browser has no EventSource support; the page will poll instead.");
      return;
    }

    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const params = new URLSearchParams();
    if (lastSeqRef.current !== null) params.set("lastEventId", String(lastSeqRef.current));
    const query = params.size > 0 ? `?${params.toString()}` : "";
    const url = `/api/tasks/${encodeURIComponent(taskId)}/events${query}`;
    const source = new EventSource(url, { withCredentials: true });
    setStatus("connecting");

    const batch: RunEvent[] = [];
    let flushScheduled = false;
    const flush = () => {
      flushScheduled = false;
      if (batch.length === 0) return;
      const events = batch.splice(0, batch.length);
      dispatch({ type: "append", events });
    };
    const enqueue = (event: RunEvent) => {
      batch.push(event);
      if (!flushScheduled) {
        flushScheduled = true;
        // Coalesce bursts (replays) into one render.
        setTimeout(flush, 16);
      }
    };

    source.onopen = () => {
      if (disposed) return;
      backoffRef.current = BACKOFF_MIN_MS;
      setStatus("open");
      setNote(null);
    };
    const onRunEvent = (msg: Event) => {
      if (disposed) return;
      // A RunEvent named `error` shares its name with EventSource's connection-error event, which
      // is a plain Event without data: only MessageEvents carry a payload.
      if (!isServerMessage(msg)) return;
      const data = typeof msg.data === "string" ? msg.data : "";
      const parsed = parseEventPayload(data);
      if (parsed.ok) enqueue(parsed.event);
      else dispatch({ type: "malformed" });
    };
    // Named events (`event: <kind>`) never reach `onmessage`; listen for each kind by name.
    for (const name of RUN_EVENT_NAMES) source.addEventListener(name, onRunEvent);
    // Optional named terminal event. If the server never sends it, nothing changes.
    source.addEventListener("end", () => {
      if (disposed) return;
      flush();
      source.close();
      setStatus("ended");
      setNote("The server closed the stream: the task reached a terminal state.");
    });
    source.onerror = (event: Event) => {
      if (disposed) return;
      // A server-sent `event: error` RunEvent is dispatched to this handler too; it is data, not a
      // connection problem (onRunEvent records it).
      if (isServerMessage(event)) return;
      if (source.readyState === EventSource.CLOSED) {
        source.close();
        setStatus("closed");
        if (!autoReconnectRef.current) {
          setNote("Event stream closed. The task is finished; use Reconnect to replay.");
          return;
        }
        const wait = backoffRef.current;
        backoffRef.current = Math.min(BACKOFF_MAX_MS, wait * 2);
        setNote(`Event stream closed; reconnecting in ${Math.round(wait / 1000)} s.`);
        timer = setTimeout(() => {
          if (!disposed) setAttempt((n) => n + 1);
        }, wait);
      } else {
        setStatus("reconnecting");
        setNote("Event stream interrupted; the browser is reconnecting.");
      }
    };

    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      flush();
      source.close();
    };
  }, [taskId, active, attempt]);

  return { log, status, note, reconnect };
}
