/**
 * Adapted from OpenBot `app/src/components/ui/message-scroller.tsx` (pin 3c73cf00efba46122dfd0447485e2b61f1d6a2cd).
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
 * Airlock modifications: Upstream wraps `@shadcn/react/message-scroller`; that dependency is replaced by a small stick-to-bottom hook (`useStickToBottom`) with the same slots, classes and scroll-to-end button, so the transcript follows new rows while the reader is at the end and stops following once they scroll up.
 */
import { IconArrowDown } from "@tabler/icons-react";
import type * as React from "react";
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { cn } from "../../lib/utils";
import { Button } from "./button";

/** Within this many pixels of the end counts as "at the end". */
const STICK_THRESHOLD_PX = 48;

/**
 * Follow the end of a scroller while the reader is there.
 *
 * `version` is anything that changes when content is appended (the last event seq). Content that
 * grows without a new version (a card expanding) is caught by the ResizeObserver on the content.
 */
export function useStickToBottom(version: unknown): {
  viewportRef: (el: HTMLDivElement | null) => void;
  contentRef: (el: HTMLDivElement | null) => void;
  atEnd: boolean;
  scrollToEnd: (behavior?: ScrollBehavior) => void;
} {
  // Elements in state, not ref objects: the viewport often mounts after the page (once data has
  // loaded), and the listeners below must attach whenever it does.
  const [viewport, setViewport] = useState<HTMLDivElement | null>(null);
  const [content, setContent] = useState<HTMLDivElement | null>(null);
  const stuck = useRef(true);
  const [atEnd, setAtEnd] = useState(true);

  const scrollToEnd = useCallback(
    (behavior: ScrollBehavior = "auto") => {
      if (!viewport) return;
      stuck.current = true;
      setAtEnd(true);
      viewport.scrollTo({ top: viewport.scrollHeight, behavior });
    },
    [viewport],
  );

  useEffect(() => {
    if (!viewport) return;
    const onScroll = () => {
      const distance = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
      const next = distance <= STICK_THRESHOLD_PX;
      stuck.current = next;
      setAtEnd(next);
    };
    viewport.addEventListener("scroll", onScroll, { passive: true });
    return () => viewport.removeEventListener("scroll", onScroll);
  }, [viewport]);

  useLayoutEffect(() => {
    if (viewport && stuck.current) viewport.scrollTo({ top: viewport.scrollHeight });
  }, [version, viewport]);

  useEffect(() => {
    if (!content || !viewport || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (stuck.current) viewport.scrollTo({ top: viewport.scrollHeight });
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [content, viewport]);

  return { viewportRef: setViewport, contentRef: setContent, atEnd, scrollToEnd };
}

function MessageScroller({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="message-scroller"
      className={cn("group/message-scroller relative flex size-full min-h-0 flex-col overflow-hidden", className)}
      {...props}
    />
  );
}

function MessageScrollerViewport({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="message-scroller-viewport"
      className={cn("size-full min-h-0 min-w-0 overflow-y-auto overscroll-contain [scrollbar-gutter:stable]", className)}
      {...props}
    />
  );
}

function MessageScrollerContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="message-scroller-content"
      role="log"
      className={cn("flex h-max min-h-full flex-col gap-6", className)}
      {...props}
    />
  );
}

function MessageScrollerItem({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="message-scroller-item" className={cn("min-w-0 shrink-0", className)} {...props} />;
}

function MessageScrollerButton({
  active,
  onClick,
  className,
  children,
}: {
  active: boolean;
  onClick: () => void;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <Button
      data-slot="message-scroller-button"
      data-active={active}
      variant="secondary"
      size="icon-sm"
      tabIndex={active ? 0 : -1}
      aria-hidden={!active}
      onClick={onClick}
      className={cn(
        "absolute bottom-4 left-1/2 -translate-x-1/2 border-border bg-background text-foreground shadow-sm transition-[translate,scale,opacity] duration-200 hover:bg-muted hover:text-foreground data-[active=false]:pointer-events-none data-[active=false]:translate-y-full data-[active=false]:scale-95 data-[active=false]:opacity-0 data-[active=true]:translate-y-0 data-[active=true]:scale-100 data-[active=true]:opacity-100",
        className,
      )}
    >
      {children ?? (
        <>
          <IconArrowDown />
          <span className="sr-only">Scroll to end</span>
        </>
      )}
    </Button>
  );
}

export { MessageScroller, MessageScrollerViewport, MessageScrollerContent, MessageScrollerItem, MessageScrollerButton };
