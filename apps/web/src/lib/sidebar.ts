/**
 * Adapted from OpenBot `app/src/lib/sidebar.ts` (pin 3c73cf00efba46122dfd0447485e2b61f1d6a2cd).
 *
 * MIT License
 * Copyright (c) 2026 CopilotKit
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
 * associated documentation files (the "Software"), to deal in the Software without restriction,
 * including without limitation the rights to use, copy, modify, merge, publish, distribute,
 * sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions: The above copyright notice and this
 * permission notice shall be included in all copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.
 *
 * Airlock modifications: Storage key renamed to `airlock-sidebar`.
 */
/**
 * Whether the shell's sidebar is open, remembered across reloads.
 *
 * The primitive under `components/ui/sidebar.tsx` writes a `sidebar_state` cookie of its own, which
 * exists so a server-rendered shell can paint the right width on the first byte. Nothing renders
 * this app on a server, and nothing ever read that cookie back — so the preference lives here
 * instead, in the same shape and the same storage as the theme preference next door.
 */
export const SIDEBAR_STORAGE_KEY = "airlock-sidebar";

/**
 * Only the exact stored `collapsed` starts the sidebar closed.
 *
 * Everything else opens it: a key never written, a value from an older build, a value somebody
 * else's script left behind. The roster is this app's navigation, and the cost of the two mistakes
 * is not symmetric — opening a sidebar somebody wanted shut costs them one click, while shutting one
 * on a guess hides every channel they have behind an affordance they have not found yet.
 */
export function parseStoredSidebarOpen(value: string | null) {
  return value !== "collapsed";
}

type SidebarEffects = {
  setStoredValue: (key: string, value: string) => void;
};

/**
 * Records the state in the vocabulary the primitive already uses for it — `expanded` and
 * `collapsed`, the two values of its `data-state` attribute — rather than inventing a second pair.
 */
export function applySidebarOpen(open: boolean, effects: SidebarEffects) {
  effects.setStoredValue(SIDEBAR_STORAGE_KEY, open ? "expanded" : "collapsed");
}
