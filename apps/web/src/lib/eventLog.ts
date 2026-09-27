/**
 * Pure event-log state: bounded, deduplicated by `seq`, always sorted. The SSE hook feeds it and
 * components read it; keeping it pure makes reconnect/replay behavior testable without a DOM.
 */
import { EventKind, RunEvent } from "@airlock/contracts";

export const MAX_EVENTS = 4000;

/**
 * SSE event names that carry a RunEvent. The control API names each event after its `kind`
 * (`event: phase`, `event: exec`, …), and EventSource delivers a named event only to a listener
 * registered for that name, never to `onmessage`; unnamed `message` events are accepted too.
 */
export const RUN_EVENT_NAMES: readonly string[] = [...EventKind.options, "message"];
/** RunEvent.detail is capped at 64 KiB by the contract; allow headroom for the envelope. */
export const MAX_PAYLOAD_CHARS = 96 * 1024;

export interface EventLog {
  events: RunEvent[];
  lastSeq: number | null;
  /** Events discarded from the front to stay within MAX_EVENTS. */
  dropped: number;
  /** Payloads that did not parse as a RunEvent (counted, not shown). */
  malformed: number;
}

export function emptyLog(): EventLog {
  return { events: [], lastSeq: null, dropped: 0, malformed: 0 };
}

export type ParsedPayload = { ok: true; event: RunEvent } | { ok: false; reason: string };

export function parseEventPayload(data: string): ParsedPayload {
  if (data.length > MAX_PAYLOAD_CHARS) return { ok: false, reason: "payload too large" };
  let json: unknown;
  try {
    json = JSON.parse(data);
  } catch {
    return { ok: false, reason: "payload is not JSON" };
  }
  const parsed = RunEvent.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, reason: issue ? `${issue.path.join(".")}: ${issue.message}` : "invalid RunEvent" };
  }
  return { ok: true, event: parsed.data };
}

export function appendEvents(log: EventLog, incoming: readonly RunEvent[]): EventLog {
  if (incoming.length === 0) return log;
  const seen = new Set<number>();
  for (const ev of log.events) seen.add(ev.seq);
  const fresh: RunEvent[] = [];
  for (const ev of incoming) {
    if (seen.has(ev.seq)) continue;
    seen.add(ev.seq);
    fresh.push(ev);
  }
  if (fresh.length === 0) return log;
  let events = log.events.concat(fresh);
  // Replays can arrive out of order after a reconnect; keep the log ordered by seq.
  const lastExisting = log.events[log.events.length - 1];
  const firstFresh = fresh[0];
  const needsSort =
    fresh.length > 1 || (lastExisting !== undefined && firstFresh !== undefined && firstFresh.seq < lastExisting.seq);
  if (needsSort) events = events.slice().sort((a, b) => a.seq - b.seq);
  let dropped = log.dropped;
  if (events.length > MAX_EVENTS) {
    dropped += events.length - MAX_EVENTS;
    events = events.slice(events.length - MAX_EVENTS);
  }
  const last = events[events.length - 1];
  return { events, lastSeq: last ? last.seq : log.lastSeq, dropped, malformed: log.malformed };
}

export function noteMalformed(log: EventLog): EventLog {
  return { ...log, malformed: log.malformed + 1 };
}
