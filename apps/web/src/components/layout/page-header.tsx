import type { ReactNode } from "react";
import { cn } from "../../lib/utils";
import { SidebarToggle } from "./sidebar-toggle";

/**
 * The 48px bar at the top of every pane (OpenBot's channel header): the sidebar toggle, what this
 * pane is, and the pane's own controls on the right.
 */
export function PageHeader({ children, actions, className }: { children?: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <div className={cn("sticky top-0 z-10 flex h-12 shrink-0 flex-row items-center justify-between gap-2 border-b border-border bg-background px-3", className)}>
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        <SidebarToggle />
        {children}
      </div>
      {actions ? <div className="flex shrink-0 flex-row items-center gap-1.5">{actions}</div> : null}
    </div>
  );
}
