import type { ReactElement } from "react";
import { canOperate, useSession } from "./hooks/session";
import { hrefFor, useRoute } from "./lib/router";
import { HostilePage } from "./pages/HostilePage";
import { LoginPage } from "./pages/LoginPage";
import { NewCasePage } from "./pages/NewCasePage";
import { TaskPage } from "./pages/TaskPage";
import { TasksPage } from "./pages/TasksPage";
import { Badge, Notice, Section } from "./components/ui";

function RoleBadge() {
  const session = useSession();
  if (session.loading) return <Badge tone="neutral">…</Badge>;
  const tone = session.role === "operator" ? "ok" : session.role === "judge" ? "info" : "neutral";
  return (
    <Badge tone={tone} title="Roles: operator and judge may start cases and run the hostile panel; viewer is read-only.">
      {session.role}
    </Badge>
  );
}

function NotFound({ path }: { path: string }) {
  return (
    <div className="page page-narrow">
      <Section title="Not found">
        <p>
          No page at <code className="mono">{path}</code>.
        </p>
        <a href={hrefFor({ name: "home" })}>Back to start</a>
      </Section>
    </div>
  );
}

export function App() {
  const route = useRoute();
  const session = useSession();
  const operator = canOperate(session.role);

  let page: ReactElement;
  switch (route.name) {
    case "home":
    case "new":
      page = <NewCasePage />;
      break;
    case "login":
      page = <LoginPage />;
      break;
    case "tasks":
      page = <TasksPage />;
      break;
    case "task":
      page = <TaskPage id={route.id} />;
      break;
    case "hostile":
      page = <HostilePage />;
      break;
    case "notfound":
      page = <NotFound path={route.path} />;
      break;
  }

  return (
    <div className="app">
      <nav className="topbar">
        <a className="brand" href={hrefFor({ name: "home" })}>
          Airlock
        </a>
        <div className="nav-links">
          <a href={hrefFor({ name: "new" })} aria-current={route.name === "new" || route.name === "home" ? "page" : undefined}>
            New case
          </a>
          <a href={hrefFor({ name: "tasks" })} aria-current={route.name === "tasks" || route.name === "task" ? "page" : undefined}>
            Tasks
          </a>
          {operator ? (
            <a href={hrefFor({ name: "hostile" })} aria-current={route.name === "hostile" ? "page" : undefined}>
              Hostile input
            </a>
          ) : null}
        </div>
        <div className="nav-right">
          <RoleBadge />
          {session.role === "viewer" ? (
            <a href={hrefFor({ name: "login" })}>Sign in</a>
          ) : (
            <button type="button" className="btn btn-link" onClick={() => void session.logout()}>
              Sign out
            </button>
          )}
        </div>
      </nav>
      {session.error ? <Notice tone="warn">Session check failed: {session.error}. Continuing as viewer.</Notice> : null}
      <main className="main">{page}</main>
      <footer className="footer muted">
        "Passed these checks" means exactly the frozen contract cases passed on a sealed candidate. It never means safe,
        certified or correct.
      </footer>
    </div>
  );
}
