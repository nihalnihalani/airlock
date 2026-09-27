// Generation / reference binding, tab registry and event queue for the browser runner.
// Pure (no Playwright import) so the rules are unit-testable without Chromium.
//
// Rules:
// - `generation` increments on every observe, every main-frame navigation of the active tab, every
//   tab switch and when the active tab goes away. Refs are valid only for the generation and tab of
//   the observe that produced them; anything else is `stale_reference` and needs a fresh observe.
// - New tabs/popups are registered (at most `maxTabs`) but never become active on their own.
// - Dismissed confirm/prompt/beforeunload dialogs set `pendingReview`; mutating operations are
//   refused until an observe has delivered the event to the controller.

import { MAX_TABS } from "./protocol.mjs";

export class StaleReference extends Error {
  constructor(message) {
    super(message);
    this.code = "stale_reference";
  }
}

export class SessionState {
  #refs = new Set();
  #refTab = null;
  #nextTab = 1;

  constructor({ maxTabs = MAX_TABS, maxEvents = 50, maxMutationEvents = 10 } = {}) {
    this.maxTabs = maxTabs;
    this.maxEvents = maxEvents;
    this.maxMutationEvents = maxMutationEvents;
    /** Refused mutations over the container's lifetime (reported by status). */
    this.mutationsBlocked = 0;
    this.generation = 0;
    this.tabs = new Map(); // tabId -> opaque handle (a Playwright Page in the runner)
    this.activeTabId = null;
    this.events = [];
    this.droppedEvents = 0;
    this.pendingReview = false;
  }

  invalidate() {
    this.generation += 1;
    this.#refs = new Set();
    this.#refTab = null;
    return this.generation;
  }

  /** Called by observe with the refs its snapshot published; returns the new generation. */
  recordSnapshot(tabId, refs) {
    this.invalidate();
    this.#refs = new Set(refs);
    this.#refTab = tabId;
    return this.generation;
  }

  checkGeneration(generation) {
    if (generation !== this.generation) {
      throw new StaleReference(
        `generation ${generation} is not current (${this.generation}); observe again and use the new refs`,
      );
    }
  }

  checkRef(ref, generation) {
    this.checkGeneration(generation);
    if (this.#refTab !== this.activeTabId || !this.#refs.has(ref)) {
      throw new StaleReference(`ref ${ref} is not in the current snapshot; observe again`);
    }
  }

  /** Register a tab; returns its id, or null if the tab limit is reached (caller closes it). */
  addTab(handle) {
    if (this.tabs.size >= this.maxTabs) return null;
    const tabId = `tab-${this.#nextTab++}`;
    this.tabs.set(tabId, handle);
    if (this.activeTabId === null) this.activeTabId = tabId;
    return tabId;
  }

  tabIdOf(handle) {
    for (const [tabId, h] of this.tabs) if (h === handle) return tabId;
    return null;
  }

  activeHandle() {
    return this.activeTabId === null ? null : this.tabs.get(this.activeTabId) ?? null;
  }

  switchTab(tabId) {
    if (!this.tabs.has(tabId)) return false;
    this.activeTabId = tabId;
    this.invalidate();
    return true;
  }

  /** Forget a tab. If it was active, the most recently opened remaining tab becomes active. */
  removeTab(tabId) {
    if (!this.tabs.delete(tabId)) return { removed: false, wasActive: false };
    const wasActive = this.activeTabId === tabId;
    if (wasActive) {
      const remaining = [...this.tabs.keys()];
      this.activeTabId = remaining.length ? remaining[remaining.length - 1] : null;
      this.invalidate();
    }
    return { removed: true, wasActive };
  }

  /** Main-frame navigation on a tab: only the active tab's refs are invalidated. */
  navigated(tabId) {
    if (tabId !== null && tabId === this.activeTabId) this.invalidate();
  }

  pushEvent(event) {
    // A dropped decision still gates mutating ops until the next observe.
    if (event.status === "pending_review") this.pendingReview = true;
    if (this.events.length >= this.maxEvents) {
      this.droppedEvents += 1;
      return;
    }
    this.events.push({ at: new Date().toISOString(), ...event });
  }

  /**
   * Record a refused mutation ({ method, url }). Repeats of the same method+url coalesce into one
   * event's `count`; at most `maxMutationEvents` distinct refusals are queued per observe so a page
   * that spams requests cannot crowd dialogs and downloads out of the bounded queue (overflow is
   * counted in droppedEvents). Returns true when a new event was queued.
   */
  pushMutationBlocked({ method, url, tabId = null }) {
    this.mutationsBlocked += 1;
    const existing = this.events.find((e) => e.type === "mutation_blocked" && e.method === method && e.url === url);
    if (existing) {
      existing.count += 1;
      return false;
    }
    const queued = this.events.filter((e) => e.type === "mutation_blocked").length;
    if (queued >= this.maxMutationEvents) {
      this.droppedEvents += 1;
      return false;
    }
    const before = this.events.length;
    this.pushEvent({ type: "mutation_blocked", method, url, tabId, count: 1 });
    return this.events.length > before;
  }

  /** Deliver queued events (observe does this) and clear the review gate. */
  drainEvents() {
    const events = this.events;
    const dropped = this.droppedEvents;
    const pendingReview = this.pendingReview;
    this.events = [];
    this.droppedEvents = 0;
    this.pendingReview = false;
    return { events, droppedEvents: dropped, pendingReview };
  }
}
