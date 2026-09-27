/**
 * Adapted from OpenBot `app/src/components/layout/detail-panel.tsx` (pin 3c73cf00efba46122dfd0447485e2b61f1d6a2cd).
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
 * Airlock modifications: `motion` removed: the pane animates its width with a CSS transition and the content fades in with tw-animate-css, so the app carries no animation library. Imports made relative; the pane's scroll area is `overscroll-contain`.
 */
import { IconX } from "@tabler/icons-react";
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { Button } from "../ui/button";
import { Sheet, SheetContent, SheetTitle } from "../ui/sheet";

/**
 * A main pane with details beside it when there is room, or in a sheet on narrow windows.
 *
 * The open/closed state belongs to the caller. The pane is animated by width and the content inside
 * it is given that width outright, so the content is laid out once and the pane reveals it.
 */

const DEFAULT_DETAIL_WIDTH = 400;
const MIN_MAIN_WIDTH = 400;

export function DetailPanel({
  open,
  onClose,
  title,
  detail,
  detailWidth = DEFAULT_DETAIL_WIDTH,
  children,
}: {
  open: boolean;
  onClose: () => void;
  /** Rendered at the left of the detail pane's header row, beside the close button. */
  title?: ReactNode;
  detail?: ReactNode;
  /** Open width of the detail pane, in pixels. */
  detailWidth?: number;
  children: ReactNode;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [overlay, setOverlay] = useState(true);
  useLayoutEffect(() => {
    const element = container.current;
    if (!element) return;
    const measure = (width: number) => setOverlay(width < detailWidth + MIN_MAIN_WIDTH);
    measure(element.getBoundingClientRect().width);
    const observer = new ResizeObserver(([entry]) => {
      if (entry) measure(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [detailWidth]);

  return (
    <div ref={container} className="flex h-full min-h-0">
      <div className="flex flex-1 min-w-0 flex-col">{children}</div>
      {overlay ? (
        <Sheet
          open={open}
          onOpenChange={(next) => {
            if (!next) onClose();
          }}
        >
          <SheetContent className="gap-0" style={{ width: `min(${detailWidth}px, 100vw)`, maxWidth: "100vw" }}>
            <SheetTitle className="h-12 shrink-0 px-4 pr-12 flex items-center">{title ?? "Details"}</SheetTitle>
            <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain">{open ? detail : null}</div>
          </SheetContent>
        </Sheet>
      ) : (
        <div
          className="shrink-0 overflow-hidden transition-[width] duration-300 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none"
          style={{ width: open ? detailWidth : 0 }}
        >
          <div className="flex h-full flex-col bg-sidebar border-l border-border" style={{ width: detailWidth }}>
            {/* Rendered for the whole animation, so the way out is available immediately. */}
            <div className="h-12 shrink-0 sticky top-0 flex flex-row items-center justify-between px-2 gap-2">
              <div className="flex min-w-0 w-full items-center gap-1.5">{title}</div>
              <div className="flex flex-row gap-1.5">
                <Button aria-label="Close details" onClick={onClose} variant="ghost" size="icon">
                  <IconX className="size-4.5" />
                </Button>
              </div>
            </div>
            {/* Unmount while closed so dismissed form state does not remain active. */}
            {open ? (
              <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain animate-in fade-in-0 slide-in-from-bottom-2 duration-200 delay-100 fill-mode-both motion-reduce:animate-none">
                {detail}
              </div>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}
