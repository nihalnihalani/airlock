import { IconArrowUp, IconBrandGithub, IconExternalLink, IconGitCommit, IconLock, IconShieldCheck } from "@tabler/icons-react";
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { ProfileManifest } from "@airlock/contracts";
import { Badge, Chip, ErrorBox, Mono, Notice } from "../components/common";
import { PageHeader } from "../components/layout/page-header";
import { ComposerFrame } from "../components/thread/composer-frame";
import { Button } from "../components/ui/button";
import { Skeleton } from "../components/ui/skeleton";
import { canOperate, useSession } from "../hooks/session";
import { useSharedTaskList } from "../hooks/useTaskList";
import { createTask, describeError, getProfiles } from "../lib/api";
import { formatBytes, formatDurationMs, httpUrl, shortSha } from "../lib/format";
import { hrefFor, navigate } from "../lib/router";

const ISSUE_MAX = 20000;
const EDITOR_MAX_HEIGHT_PX = 280;

function PathChips({ paths }: { paths: string[] }) {
  return (
    <span className="flex flex-wrap gap-1">
      {paths.map((p) => (
        <Chip key={p}>
          <Mono>{p}</Mono>
        </Chip>
      ))}
    </span>
  );
}

function ProfileCard({ profile }: { profile: ProfileManifest }) {
  const caps = profile.caps;
  const issueHref = httpUrl(profile.issueUrl);
  return (
    <div className="w-full rounded-xl border border-border bg-card p-4 text-left dark:border-transparent">
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex size-8 items-center justify-center rounded-lg bg-muted/60 text-muted-foreground">
          <IconBrandGithub className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{profile.displayName}</div>
          <div className="truncate text-xs text-muted-foreground">{profile.id}</div>
        </div>
        <Badge tone="info" title="A disclosed replay of a historical, already-fixed issue. Not a benchmark claim.">
          historical replay
        </Badge>
        <Chip>{profile.language}</Chip>
      </div>
      <dl className="mt-3 grid grid-cols-[minmax(0,7.5rem)_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs">
        <dt className="text-muted-foreground">issue</dt>
        <dd className="min-w-0">
          {issueHref ? (
            <a className="inline-flex max-w-full items-center gap-1 underline-offset-4 hover:underline" href={issueHref} target="_blank" rel="noreferrer noopener">
              <span className="truncate">{profile.issueUrl}</span>
              <IconExternalLink className="size-3 shrink-0" />
            </a>
          ) : (
            <span className="break-all">{profile.issueUrl}</span>
          )}
        </dd>
        <dt className="text-muted-foreground">baseline commit</dt>
        <dd className="flex items-center gap-1">
          <IconGitCommit className="size-3.5 text-muted-foreground" />
          <Mono title={profile.baselineCommit}>{shortSha(profile.baselineCommit)}</Mono>
        </dd>
        <dt className="text-muted-foreground">agent may change</dt>
        <dd>
          <PathChips paths={profile.allowedReplacementPaths} />
        </dd>
        <dt className="text-muted-foreground">agent may read</dt>
        <dd>
          <PathChips paths={profile.readablePaths} />
        </dd>
        <dt className="text-muted-foreground">caps</dt>
        <dd className="text-foreground/80">
          {caps.cpus} CPU · {formatBytes(caps.memoryBytes)} · {caps.pidsLimit} pids · {formatDurationMs(caps.commandTimeoutMs)} per command ·{" "}
          {formatDurationMs(caps.attemptTimeoutMs)} per attempt · {caps.maxRepairAttempts} repair attempts · {caps.maxModelCalls} model calls
        </dd>
      </dl>
    </div>
  );
}

export function NewCasePage() {
  const session = useSession();
  const roster = useSharedTaskList();
  const [profiles, setProfiles] = useState<ProfileManifest[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [profileId, setProfileId] = useState<string>("");
  const [issueText, setIssueText] = useState("");
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const editor = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    setProfiles(null);
    setLoadError(null);
    getProfiles(controller.signal)
      .then((list) => {
        setProfiles(list);
        setProfileId((current) => (list.some((p) => p.id === current) ? current : (list[0]?.id ?? "")));
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setLoadError(describeError(err));
      });
    return () => controller.abort();
  }, [reloadKey]);

  // Grow the editor with its text up to a cap, then scroll inside it.
  useEffect(() => {
    const el = editor.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, EDITOR_MAX_HEIGHT_PX)}px`;
  }, [issueText]);

  const selected = profiles?.find((p) => p.id === profileId) ?? null;
  const allowed = canOperate(session.role);
  const trimmed = issueText.trim();
  const canSend = allowed && !busy && selected !== null && trimmed.length > 0;

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!selected) {
      setSubmitError("Choose a supported profile.");
      return;
    }
    if (trimmed.length === 0) {
      setSubmitError("Paste the issue text first.");
      return;
    }
    if (issueText.length > ISSUE_MAX) {
      setSubmitError(`Issue text is limited to ${ISSUE_MAX.toLocaleString()} characters.`);
      return;
    }
    setBusy(true);
    setSubmitError(null);
    try {
      const task = await createTask(selected.id, issueText);
      roster.refresh();
      navigate({ name: "task", id: task.id });
    } catch (err) {
      setSubmitError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  // Enter inserts a newline (issues are multi-line); Cmd/Ctrl+Enter starts the case.
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && canSend) {
      e.preventDefault();
      void submit();
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader>
        <span className="text-sm text-muted-foreground">Profile:</span>
        {profiles && profiles.length > 0 ? (
          <select
            aria-label="Supported profile"
            className="h-8 min-w-0 max-w-full truncate rounded-md border-0 bg-transparent px-1.5 text-sm font-medium outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
            value={profileId}
            onChange={(e) => setProfileId(e.target.value)}
            disabled={busy}
          >
            {profiles.map((p) => (
              <option value={p.id} key={p.id}>
                {p.displayName} ({p.id})
              </option>
            ))}
          </select>
        ) : (
          <span className="text-sm text-muted-foreground">{loadError ? "unavailable" : "loading…"}</span>
        )}
      </PageHeader>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="mx-auto flex min-h-full w-full max-w-2xl flex-col items-center justify-center gap-6 px-4 py-10 text-center">
          <div className="flex flex-col items-center gap-3 animate-in fade-in-0 slide-in-from-bottom-2 duration-300 motion-reduce:animate-none">
            <span className="flex size-12 items-center justify-center rounded-2xl bg-foreground text-background">
              <IconShieldCheck className="size-6" />
            </span>
            <h1 className="text-2xl font-medium tracking-tight">What broke?</h1>
            <p className="max-w-md text-sm text-pretty text-muted-foreground">
              Paste an issue for a supported profile. Airlock reproduces it in a disposable sandbox, lets the model attempt a minimal
              repair, and measures the result against frozen cases outside the sandbox.
            </p>
          </div>
          {loadError ? <ErrorBox className="w-full text-left" message={loadError} onRetry={() => setReloadKey((k) => k + 1)} /> : null}
          {!profiles && !loadError ? <Skeleton className="h-48 w-full rounded-xl bg-muted/60" /> : null}
          {profiles && profiles.length === 0 ? <Notice tone="warn">The control app lists no supported profiles.</Notice> : null}
          {selected ? <ProfileCard profile={selected} /> : null}
          <p className="max-w-md text-xs text-pretty text-muted-foreground">
            Airlock supports exactly the profiles listed here; anything else is rejected by the API. The UI ships no issue text: copy
            it from the issue link. It is untrusted input that only reaches the sandbox and the model, never a host shell.
          </p>
        </div>
      </div>

      <ComposerFrame
        as="form"
        onSubmit={(e) => void submit(e)}
        above={
          <div className="mb-2 flex flex-col gap-2">
            {!allowed && !session.loading ? (
              <Notice className="flex items-center gap-2 text-xs">
                <IconLock className="size-4 shrink-0" />
                <span>
                  You are reading as a viewer.{" "}
                  <a className="font-medium text-foreground underline underline-offset-4" href={hrefFor({ name: "login" })}>
                    Sign in
                  </a>{" "}
                  as operator or judge to start a case.
                </span>
              </Notice>
            ) : null}
            {submitError ? <ErrorBox message={submitError} /> : null}
          </div>
        }
        footnote="Cmd/Ctrl + Enter starts the case. The model's inputs are fixed by the control plane: this text, the profile and tool results."
      >
        <textarea
          ref={editor}
          aria-label="Issue text"
          className="max-h-[280px] min-h-16 w-full resize-none bg-transparent px-1 text-sm leading-relaxed outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
          value={issueText}
          maxLength={ISSUE_MAX}
          rows={3}
          spellCheck={false}
          placeholder="Paste the issue title and body…"
          onChange={(e) => setIssueText(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={busy || !allowed}
        />
        <div className="flex items-center gap-2">
          {selected ? (
            <Chip className="max-w-[60%]">
              <span className="truncate">{selected.id}</span>
            </Chip>
          ) : null}
          <span className="ml-auto text-[11px] tabular-nums text-muted-foreground">
            {issueText.length.toLocaleString()} / {ISSUE_MAX.toLocaleString()}
          </span>
          <Button type="submit" aria-label="Start the case" title="Start the case" className="size-8 rounded-full p-0" size="icon" disabled={!canSend}>
            {busy ? <span className="size-3 animate-spin rounded-full border-2 border-current border-t-transparent" /> : <IconArrowUp className="size-4" />}
          </Button>
        </div>
      </ComposerFrame>
    </div>
  );
}
