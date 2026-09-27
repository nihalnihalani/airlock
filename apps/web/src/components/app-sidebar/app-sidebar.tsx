/**
 * Layout adapted from OpenBot `app/src/components/app-sidebar/app-sidebar.tsx` and
 * `channel-item-content.tsx` (pin 3c73cf00efba46122dfd0447485e2b61f1d6a2cd).
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
 * Airlock modifications: rewritten for Airlock data. The roster is the task list (title from the
 * issue's first line, profile, status dot, outcome badge, relative time) polled from the control
 * API; the search filters loaded rows; "Hostile input" is drawn as a pinned channel; the footer shows
 * the session role with sign in/out instead of a user menu. Kept from upstream: the header/brand
 * row, the search field, the row anatomy and classes, the empty states, the footer rows and the rail.
 * No TanStack Router/Query, motion, dropdown or channel mutations.
 */
import { IconBug, IconFlame, IconLogin2, IconLogout, IconPinFilled, IconPlus, IconSearch, IconShieldLock } from "@tabler/icons-react";
import { useMemo, useState } from "react";
import type { Task } from "@airlock/contracts";
import { useNow, useSharedTaskList } from "../../hooks/useTaskList";
import { canOperate, useSession } from "../../hooks/session";
import { hrefFor, type Route } from "../../lib/router";
import { taskRowView, type TaskDot, type TaskRowView } from "../../lib/taskList";
import { cn } from "../../lib/utils";
import { Badge, Dot, TONE_TEXT, type Tone } from "../common";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from "../ui/sidebar";

const DOT_TONE: Record<TaskDot, Tone> = {
  queued: "neutral",
  running: "info",
  cancelling: "warn",
  ok: "ok",
  warn: "warn",
  bad: "bad",
  neutral: "neutral",
};

export function BrandMark({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex size-6 shrink-0 items-center justify-center rounded-md bg-foreground text-background", className)}>
      <IconShieldLock className="size-3.5" stroke={2.25} />
    </span>
  );
}

/** Rows match the title, profile and badge, because those are what the row shows. */
export function matchingRows(rows: TaskRowView[], query: string): TaskRowView[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return rows;
  return rows.filter((row) => [row.title, row.profileId, row.badge.label, row.id].some((f) => f.toLowerCase().includes(needle)));
}

function rowClass(active: boolean) {
  return cn(
    "flex w-full flex-row items-center gap-2 rounded-lg px-2 py-2 outline-none transition-colors hover:bg-foreground/5 focus-visible:ring-2 focus-visible:ring-sidebar-ring [contain-intrinsic-size:auto_3.25rem] [content-visibility:auto]",
    active && "bg-foreground/5",
  );
}

function TaskRow({ row, active, onNavigate }: { row: TaskRowView; active: boolean; onNavigate: () => void }) {
  const tone = DOT_TONE[row.dot];
  return (
    <a href={hrefFor({ name: "task", id: row.id })} className={rowClass(active)} aria-current={active ? "page" : undefined} onClick={onNavigate}>
      <div className="relative shrink-0">
        <div className="flex size-8 items-center justify-center rounded-full bg-muted-foreground/10 text-foreground/70">
          <IconBug className="size-4" />
        </div>
        <span className="absolute -right-0.5 -bottom-0.5 rounded-full bg-sidebar p-[2px]">
          <Dot tone={tone} pulse={row.live} />
        </span>
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate text-[0.9rem] leading-5 font-medium tracking-[-0.01em]" title={row.title}>
            {row.title}
          </span>
          <span className="shrink-0 whitespace-nowrap text-[12px] leading-4 text-muted-foreground/70" title={row.at}>
            {row.relative}
          </span>
        </div>
        <div className="mt-px flex min-w-0 items-center gap-1.5 text-[12px] leading-4 text-muted-foreground">
          <span className="shrink-0">{row.profileId}</span>
          <span className="shrink-0 text-muted-foreground/50">·</span>
          <span className={cn("min-w-0 truncate font-medium", TONE_TEXT[row.badge.tone])}>{row.badge.label}</span>
          {row.scripted ? (
            <span
              className="ml-auto shrink-0 rounded bg-foreground/5 px-1 font-mono text-[10px] leading-4"
              title={`Diagnostic run driven by the scripted model "${row.scripted}"; never a live repair`}
            >
              scripted
            </span>
          ) : null}
        </div>
      </div>
    </a>
  );
}

function HostileRow({ active, onNavigate }: { active: boolean; onNavigate: () => void }) {
  return (
    <a href={hrefFor({ name: "hostile" })} className={rowClass(active)} aria-current={active ? "page" : undefined} onClick={onNavigate}>
      <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-destructive/10 text-destructive">
        <IconFlame className="size-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate text-[0.9rem] leading-5 font-medium tracking-[-0.01em]">Hostile input</span>
          <IconPinFilled className="size-3 shrink-0 text-muted-foreground/70" aria-label="Pinned" />
        </div>
        <div className="mt-px truncate text-[12px] leading-4 text-muted-foreground">Run a command in a throwaway sandbox</div>
      </div>
    </a>
  );
}

function RoleFooter() {
  const session = useSession();
  const role = session.loading ? "…" : session.role;
  const initials = session.loading ? "·" : session.role.slice(0, 1).toUpperCase();
  return (
    <div className="flex h-10 items-center gap-2 rounded-md px-2">
      <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted-foreground/10 text-xs text-foreground/70">{initials}</div>
      <div className="min-w-0 flex-1 leading-tight">
        <div className="truncate text-sm capitalize">{role}</div>
        <div className="truncate text-[11px] text-muted-foreground">
          {session.role === "viewer" ? "Read-only" : "Can start cases and run hostile input"}
        </div>
      </div>
      <Badge tone={session.role === "operator" ? "ok" : session.role === "judge" ? "info" : "neutral"} title="Roles are enforced by the control API: operator and judge may start cases and run hostile input; viewer is read-only.">
        {role}
      </Badge>
      {session.role === "viewer" ? (
        <Button size="icon-sm" variant="ghost" aria-label="Sign in" title="Sign in" render={<a href={hrefFor({ name: "login" })} />}>
          <IconLogin2 />
        </Button>
      ) : (
        <Button size="icon-sm" variant="ghost" aria-label="Sign out" title="Sign out" onClick={() => void session.logout()}>
          <IconLogout />
        </Button>
      )}
    </div>
  );
}

export function AppSidebar({ route }: { route: Route }) {
  const { tasks, error } = useSharedTaskList();
  const session = useSession();
  const now = useNow();
  const { isMobile, setOpenMobile } = useSidebar();
  const [search, setSearch] = useState("");
  const rows = useMemo(() => (tasks ?? []).map((t: Task) => taskRowView(t, now)), [tasks, now]);
  const visible = matchingRows(rows, search);
  const searching = search.trim().length > 0;
  const activeTask = route.name === "task" ? route.id : null;
  // On a phone the sidebar is a sheet over the page: close it once a destination is chosen.
  const onNavigate = () => {
    if (isMobile) setOpenMobile(false);
  };

  return (
    <Sidebar>
      <SidebarHeader className="h-12 justify-center p-2">
        <a href={hrefFor({ name: "home" })} className="flex h-8 items-center gap-2 rounded-md px-2 font-semibold text-[14px] tracking-tighter hover:bg-sidebar-accent" onClick={onNavigate}>
          <BrandMark />
          Airlock
        </a>
      </SidebarHeader>
      <SidebarContent className="scroll-fade-b">
        <SidebarMenu>
          <SidebarGroup className="gap-px">
            <SidebarMenuItem>
              <Button
                className="h-9 w-full justify-start gap-2 px-3"
                render={<a href={hrefFor({ name: "new" })} />}
                onClick={onNavigate}
                aria-current={route.name === "new" || route.name === "home" ? "page" : undefined}
              >
                <IconPlus />
                New case
                {!canOperate(session.role) && !session.loading ? <span className="ml-auto text-[11px] font-normal opacity-70">sign in to start</span> : null}
              </Button>
            </SidebarMenuItem>
            <div className="h-2" />
            <SidebarMenuItem>
              <label className="flex h-9 items-center gap-2 rounded-lg border border-input bg-background px-2.5 text-sm focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 dark:bg-input/30">
                <IconSearch className="size-4 text-muted-foreground" />
                <input
                  aria-label="Search cases"
                  className="h-full min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
                  placeholder="Search..."
                  value={search}
                  maxLength={200}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </label>
            </SidebarMenuItem>
            <div className="h-2" />
            <SidebarMenuItem>
              <HostileRow active={route.name === "hostile"} onNavigate={onNavigate} />
            </SidebarMenuItem>
            <div className="mx-2 my-1.5 h-px bg-sidebar-border" />
            {error ? (
              <p role="alert" className="px-2 py-1 text-xs text-destructive">
                Could not refresh cases: {error}
              </p>
            ) : null}
            {tasks === null && !error ? (
              <div className="flex flex-col gap-2 px-2 py-2" aria-hidden>
                {[0, 1, 2].map((i) => (
                  <div key={i} className="flex items-center gap-2">
                    <div className="size-8 animate-pulse rounded-full bg-muted" />
                    <div className="flex flex-1 flex-col gap-1.5">
                      <div className="h-3 w-3/4 animate-pulse rounded bg-muted" />
                      <div className="h-2.5 w-1/2 animate-pulse rounded bg-muted" />
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
            {searching && visible.length === 0 ? (
              <div className="py-4">
                <Empty className="min-h-[30dvh] border border-dashed">
                  <EmptyHeader>
                    <EmptyTitle>No cases match your search</EmptyTitle>
                    <EmptyDescription className="text-pretty">{`Nothing loaded is titled or labelled “${search.trim()}”.`}</EmptyDescription>
                  </EmptyHeader>
                </Empty>
              </div>
            ) : null}
            {!searching && tasks !== null && tasks.length === 0 ? (
              <div className="py-4">
                <Empty className="min-h-[30dvh] border border-dashed">
                  <EmptyHeader>
                    <EmptyTitle>No cases yet</EmptyTitle>
                    <EmptyDescription className="text-pretty">Start a case from a pasted issue and it will appear here.</EmptyDescription>
                  </EmptyHeader>
                </Empty>
              </div>
            ) : null}
            {visible.map((row) => (
              <SidebarMenuItem key={row.id}>
                <TaskRow row={row} active={row.id === activeTask} onNavigate={onNavigate} />
              </SidebarMenuItem>
            ))}
          </SidebarGroup>
        </SidebarMenu>
      </SidebarContent>
      <SidebarFooter className="border-t border-sidebar-border">
        <RoleFooter />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
