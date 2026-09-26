/**
 * In-process fan-out of appended RunEvents to SSE subscribers. The Store is the durable source;
 * this bus only wakes streams so they do not have to poll tightly. Subscribers must still replay
 * from the store by seq (Last-Event-ID) to be complete.
 */
import type { RunEvent } from "@airlock/contracts";

type Listener = (event: RunEvent) => void;

export class TaskEventBus {
  private listeners = new Map<string, Set<Listener>>();

  publish(event: RunEvent) {
    const set = this.listeners.get(event.taskId);
    if (!set) return;
    for (const listener of set) {
      try {
        listener(event);
      } catch {
        // A broken subscriber never breaks the publisher.
      }
    }
  }

  subscribe(taskId: string, listener: Listener): () => void {
    let set = this.listeners.get(taskId);
    if (!set) {
      set = new Set();
      this.listeners.set(taskId, set);
    }
    set.add(listener);
    return () => {
      const current = this.listeners.get(taskId);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) this.listeners.delete(taskId);
    };
  }

  subscriberCount(taskId: string) {
    return this.listeners.get(taskId)?.size ?? 0;
  }
}
