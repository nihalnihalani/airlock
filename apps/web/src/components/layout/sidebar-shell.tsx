/**
 * Adapted from OpenBot `app/src/components/layout/sidebar-shell.tsx` (pin 3c73cf00efba46122dfd0447485e2b61f1d6a2cd).
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
 * Airlock modifications: Imports made relative; localStorage reads and writes wrapped so a blocked storage never breaks the shell.
 */
import { type CSSProperties, type ReactNode, useEffect, useState } from "react";

import { SidebarProvider } from "../../components/ui/sidebar";
import {
  applySidebarOpen,
  parseStoredSidebarOpen,
  SIDEBAR_STORAGE_KEY,
} from "../../lib/sidebar";

/**
 * The frame the three shells — app, admin, settings — hang their sidebar in.
 *
 * It exists for one reason: the open/closed state has to outlive a reload, and the primitive's
 * `SidebarProvider` cannot do that on its own (it writes a cookie nothing reads and hardcodes
 * `defaultOpen` to true). Driving it as controlled state is a dozen lines, and three copies of a
 * dozen lines is three chances for one shell to forget the preference the other two remember.
 *
 * `width` is what actually differs between the shells. The app's roster earns 340px because its
 * rows are two-line message previews; admin and settings hold short nav labels and earn 300px.
 */
export function SidebarShell({
  children,
  className,
  width,
}: {
  children: ReactNode;
  className?: string;
  width: string;
}) {
  // Read before the first paint, so a shell somebody left collapsed never flashes open.
  const [open, setOpen] = useState(() => {
    try {
      return parseStoredSidebarOpen(window.localStorage.getItem(SIDEBAR_STORAGE_KEY));
    } catch {
      return true;
    }
  });

  useEffect(() => {
    applySidebarOpen(open, {
      setStoredValue: (key, value) => {
        try {
          window.localStorage.setItem(key, value);
        } catch {
          // Private windows and blocked storage: the preference simply is not remembered.
        }
      },
    });
  }, [open]);

  return (
    <SidebarProvider
      className={className}
      onOpenChange={setOpen}
      open={open}
      /*
       * `--sidebar-width-mobile` is set for the shape's sake and currently goes unread: the
       * primitive's mobile branch styles its Sheet from a hardcoded 18rem. Below 768px the sidebar
       * is that Sheet, which is also why the stored preference never reaches it — a panel that
       * covers the screen it overlays has no business being open before anybody asked for it.
       */
      style={
        {
          "--sidebar-width": width,
          "--sidebar-width-mobile": "20rem",
        } as CSSProperties
      }
    >
      {children}
    </SidebarProvider>
  );
}
