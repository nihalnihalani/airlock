import type { ReactElement } from "react";
import { IconMapQuestion } from "@tabler/icons-react";
import { AppSidebar } from "./components/app-sidebar/app-sidebar";
import { Notice } from "./components/common";
import { PageHeader } from "./components/layout/page-header";
import { SidebarShell } from "./components/layout/sidebar-shell";
import { Button } from "./components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "./components/ui/empty";
import { useSession } from "./hooks/session";
import { TaskListContext, useTaskList } from "./hooks/useTaskList";
import { hrefFor, useRoute } from "./lib/router";
import { HostilePage } from "./pages/HostilePage";
import { LoginPage } from "./pages/LoginPage";
import { NewCasePage } from "./pages/NewCasePage";
import { TaskPage } from "./pages/TaskPage";
import { TasksPage } from "./pages/TasksPage";

function NotFound({ path }: { path: string }) {
  return (
    <>
      <PageHeader>
        <span className="text-sm text-muted-foreground">Not found</span>
      </PageHeader>
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <IconMapQuestion />
          </EmptyMedia>
          <EmptyTitle>No page here</EmptyTitle>
          <EmptyDescription>
            Nothing lives at <code className="font-mono text-xs">{path}</code>.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button variant="outline" size="sm" render={<a href={hrefFor({ name: "home" })} />}>
            Back to a new case
          </Button>
        </EmptyContent>
      </Empty>
    </>
  );
}

export function App() {
  const route = useRoute();
  const session = useSession();
  // Task data needs a session: nothing is fetched while signed out.
  const roster = useTaskList(session.loading ? null : session.role !== "viewer");

  // The sign-in screen stands alone, like OpenBot's /sign.
  if (route.name === "login") return <LoginPage />;

  let page: ReactElement;
  switch (route.name) {
    case "home":
    case "new":
      page = <NewCasePage />;
      break;
    case "tasks":
      page = <TasksPage />;
      break;
    case "task":
      page = <TaskPage id={route.id} key={route.id} />;
      break;
    case "hostile":
      page = <HostilePage />;
      break;
    case "notfound":
      page = <NotFound path={route.path} />;
      break;
  }

  return (
    <TaskListContext.Provider value={roster}>
      {/* One viewport, never scrolls: panes scroll inside it. */}
      <SidebarShell className="h-svh overflow-hidden" width="320px">
        <AppSidebar route={route} />
        <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
          {session.error ? (
            <Notice tone="warn" className="m-2">
              Session check failed: {session.error}. Sign in again to see your cases.
            </Notice>
          ) : null}
          {page}
        </main>
      </SidebarShell>
    </TaskListContext.Provider>
  );
}
