import { describe, expect, test } from "bun:test";
import type { RunEvent } from "@airlock/contracts";
import { appendEvents, emptyLog, MAX_EVENTS, MAX_PAYLOAD_CHARS, parseEventPayload } from "../src/lib/eventLog";

function ev(seq: number, kind: RunEvent["kind"] = "info"): RunEvent {
  return {
    id: `ev-${seq}`,
    taskId: "task-1",
    seq,
    at: "2026-01-01T00:00:00.000Z",
    kind,
    title: `event ${seq}`,
    detail: "",
  };
}

describe("parseEventPayload", () => {
  test("accepts a valid RunEvent", () => {
    const parsed = parseEventPayload(JSON.stringify(ev(3, "phase")));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.event.seq).toBe(3);
  });

  test("rejects non-JSON, wrong shape and oversized payloads", () => {
    expect(parseEventPayload("not json").ok).toBe(false);
    expect(parseEventPayload(JSON.stringify({ seq: 1 })).ok).toBe(false);
    expect(parseEventPayload(JSON.stringify({ ...ev(1), kind: "bogus" })).ok).toBe(false);
    expect(parseEventPayload("x".repeat(MAX_PAYLOAD_CHARS + 1)).ok).toBe(false);
  });
});

describe("appendEvents", () => {
  test("deduplicates by seq and keeps order after out-of-order replay", () => {
    let log = appendEvents(emptyLog(), [ev(1), ev(2)]);
    log = appendEvents(log, [ev(2), ev(4), ev(3)]);
    expect(log.events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(log.lastSeq).toBe(4);
  });

  test("inserts an older replayed event in order", () => {
    let log = appendEvents(emptyLog(), [ev(5)]);
    log = appendEvents(log, [ev(2)]);
    expect(log.events.map((e) => e.seq)).toEqual([2, 5]);
    expect(log.lastSeq).toBe(5);
  });

  test("returns the same object when nothing is new", () => {
    const log = appendEvents(emptyLog(), [ev(1)]);
    expect(appendEvents(log, [ev(1)])).toBe(log);
    expect(appendEvents(log, [])).toBe(log);
  });

  test("bounds the log and counts dropped events", () => {
    const many: RunEvent[] = [];
    for (let i = 0; i < MAX_EVENTS + 25; i++) many.push(ev(i));
    const log = appendEvents(emptyLog(), many);
    expect(log.events.length).toBe(MAX_EVENTS);
    expect(log.dropped).toBe(25);
    expect(log.events[0]?.seq).toBe(25);
    expect(log.lastSeq).toBe(MAX_EVENTS + 24);
  });
});
