/**
 * Control state, the latest live frame and the action proposals of one general browser task, kept
 * current by polling while the task runs and by refetching when the event stream reports a control
 * or proposal change. Every value is the control plane's answer; nothing is inferred locally.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ActionProposal, ControlState, RunEvent, Task } from "@airlock/contracts";
import { describeError, getControl, getLive, listApprovals } from "../lib/api";
import { pendingProposals, reviewCandidates, type ControlResponse, type LiveResponse } from "../lib/control";

const POLL_MS = 4000;

export interface BrowserControlData {
  control: ControlResponse | null;
  controlError: string | null;
  live: LiveResponse | null;
  liveError: string | null;
  proposals: ActionProposal[] | null;
  proposalsError: string | null;
  refreshControl: () => void;
  refreshLive: () => void;
  refreshProposals: () => void;
  /** Apply a ControlState a take/release just returned, then refetch the full view. */
  applyControl: (c: ControlState) => void;
}

export function useBrowserControl(taskId: string, enabled: boolean, running: boolean, events: readonly RunEvent[]): BrowserControlData {
  const [control, setControl] = useState<ControlResponse | null>(null);
  const [controlError, setControlError] = useState<string | null>(null);
  const [live, setLive] = useState<LiveResponse | null>(null);
  const [liveError, setLiveError] = useState<string | null>(null);
  const [proposals, setProposals] = useState<ActionProposal[] | null>(null);
  const [proposalsError, setProposalsError] = useState<string | null>(null);
  const seq = useRef({ control: 0, live: 0, proposals: 0 });

  const refreshControl = useCallback(() => {
    if (!enabled) return;
    const n = ++seq.current.control;
    getControl(taskId)
      .then((r) => {
        if (n !== seq.current.control) return;
        setControl(r);
        setControlError(null);
      })
      .catch((err: unknown) => n === seq.current.control && setControlError(describeError(err)));
  }, [taskId, enabled]);

  const refreshLive = useCallback(() => {
    if (!enabled) return;
    const n = ++seq.current.live;
    getLive(taskId)
      .then((r) => {
        if (n !== seq.current.live) return;
        setLive(r);
        setLiveError(null);
      })
      .catch((err: unknown) => n === seq.current.live && setLiveError(describeError(err)));
  }, [taskId, enabled]);

  const refreshProposals = useCallback(() => {
    if (!enabled) return;
    const n = ++seq.current.proposals;
    listApprovals(taskId)
      .then((r) => {
        if (n !== seq.current.proposals) return;
        setProposals(r);
        setProposalsError(null);
      })
      .catch((err: unknown) => n === seq.current.proposals && setProposalsError(describeError(err)));
  }, [taskId, enabled]);

  const applyControl = useCallback(
    (c: ControlState) => {
      setControl((prev) => (prev ? { ...prev, control: c, live: prev.live ? { ...prev.live, ...c, humanOwner: c.humanOwner } : prev.live } : prev));
      refreshControl();
    },
    [refreshControl],
  );

  useEffect(() => {
    setControl(null);
    setLive(null);
    setProposals(null);
    setControlError(null);
    setLiveError(null);
    setProposalsError(null);
  }, [taskId]);

  // Initial load and whenever running flips (a terminal task still shows its proposal history).
  useEffect(() => {
    refreshControl();
    refreshLive();
    refreshProposals();
  }, [refreshControl, refreshLive, refreshProposals, running]);

  useEffect(() => {
    if (!enabled || !running) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "hidden") return;
      refreshControl();
      refreshProposals();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [enabled, running, refreshControl, refreshProposals]);

  // Refetch on the events that change what this hook holds.
  const signals = useMemo(() => {
    let controlSeq = -1;
    let proposalSeq = -1;
    for (const ev of events) {
      const d = ev.data as Record<string, unknown> | undefined;
      if (!d) continue;
      if (d["control"] !== undefined) controlSeq = ev.seq;
      if (typeof d["proposalId"] === "string") proposalSeq = ev.seq;
    }
    return { controlSeq, proposalSeq };
  }, [events]);
  useEffect(() => {
    if (signals.controlSeq >= 0) refreshControl();
  }, [signals.controlSeq, refreshControl]);
  useEffect(() => {
    if (signals.proposalSeq >= 0) refreshProposals();
  }, [signals.proposalSeq, refreshProposals]);

  return { control, controlError, live, liveError, proposals, proposalsError, refreshControl, refreshLive, refreshProposals, applyControl };
}

/** A clock that ticks every `ms` while `active`. */
export function useTick(ms: number, active = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms, active]);
  return now;
}

const REVIEW_POLL_MS = 5000;

/**
 * The ids of roster tasks that wait for a person's review: running general browser tasks with an
 * open proposal, polled from `GET /api/tasks/:id/approvals` (the roster itself does not carry it).
 * Errors are ignored here; the task page shows them.
 */
export function usePendingReviews(tasks: readonly Task[] | null): Set<string> {
  const [waiting, setWaiting] = useState<Set<string>>(() => new Set());
  const candidates = useMemo(() => reviewCandidates(tasks ?? [], 8), [tasks]);
  const key = candidates.join(",");
  useEffect(() => {
    if (candidates.length === 0) {
      setWaiting((w) => (w.size === 0 ? w : new Set()));
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    const poll = async () => {
      if (document.visibilityState === "hidden") return;
      const results = await Promise.all(
        candidates.map((id) =>
          listApprovals(id, controller.signal)
            .then((list) => (pendingProposals(list, Date.now()).length > 0 ? id : null))
            .catch(() => null),
        ),
      );
      if (!cancelled) setWaiting(new Set(results.filter((x): x is string => x !== null)));
    };
    void poll();
    const timer = setInterval(() => void poll(), REVIEW_POLL_MS);
    return () => {
      cancelled = true;
      controller.abort();
      clearInterval(timer);
    };
  }, [key]);
  return waiting;
}
