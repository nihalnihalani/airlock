/**
 * "Run a task": the general-task composer. The user picks a controller-defined profile, writes a
 * goal, uploads input files and (for browser profiles) lists the only sites the browser may reach.
 * Client-side checks mirror the server's so mistakes show before sending; the server still decides.
 */
import { IconArrowUp, IconCloudUpload, IconFlask, IconLock, IconSparkles, IconWorld, IconX } from "@tabler/icons-react";
import { useCallback, useEffect, useRef, useState, type DragEvent, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import type { Artifact } from "@airlock/contracts";
import { canOperate, useSession } from "../../hooks/session";
import { useSharedTaskList } from "../../hooks/useTaskList";
import {
  ApiError,
  createGeneralTask,
  describeError,
  getDiagnostics,
  getTaskProfiles,
  listUploads,
  uploadFile,
  type DiagnosticScript,
  type TaskProfileInfo,
  type UploadQuota,
} from "../../lib/api";
import { formatBytes, formatDurationMs } from "../../lib/format";
import { domainListProblems, domainProblem, HERO_EXAMPLE, normalizeDomainInput, shaPrefix, UPLOAD_MAX_BYTES, uploadErrorMessage } from "../../lib/general";
import { hrefFor, navigate } from "../../lib/router";
import { cn } from "../../lib/utils";
import { Badge, Chip, ErrorBox, Mono, Notice } from "../common";
import { PageHeader } from "../layout/page-header";
import { ComposerFrame } from "../thread/composer-frame";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";

const GOAL_MAX = 20000;
const MAX_INPUTS = 10;

function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="w-full rounded-xl border border-border bg-card p-4 text-left dark:border-transparent">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-medium">{title}</h2>
        {aside ? <div className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">{aside}</div> : null}
      </div>
      {children}
    </section>
  );
}

function ProfileDetails({ profile }: { profile: TaskProfileInfo }) {
  const b = profile.budgets;
  return (
    <dl className="mt-3 grid grid-cols-[minmax(0,7rem)_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs">
      <dt className="text-muted-foreground">tools</dt>
      <dd className="flex flex-wrap gap-1">
        {profile.tools.map((t) => (
          <Chip key={t}>
            <Mono>{t}</Mono>
          </Chip>
        ))}
      </dd>
      <dt className="text-muted-foreground">network</dt>
      <dd>{profile.browser ? `browser only to the sites you list below (1–${profile.maxEgressHosts})` : "none: code runs offline"}</dd>
      <dt className="text-muted-foreground">code</dt>
      <dd>{profile.codeLanguages.length ? `${profile.codeLanguages.join(" or ")} in an offline sandbox` : "no code execution"}</dd>
      <dt className="text-muted-foreground">uploads</dt>
      <dd>{profile.acceptsUploads ? "accepted (placed read-only under inputs/)" : "not accepted by this profile"}</dd>
      <dt className="text-muted-foreground">budgets</dt>
      <dd className="text-foreground/80">
        {b.modelCalls} model calls · {b.tokens.toLocaleString("en-US")} tokens · {formatDurationMs(b.wallClockMs)} wall clock · {b.browserOps} browser ops · {b.codeRuns} code runs ·{" "}
        {b.browserSessions} browser sessions · {b.codeSandboxes} code sandboxes
      </dd>
      <dt className="text-muted-foreground">checks</dt>
      <dd className="flex flex-wrap gap-1">
        {profile.checks.map((c) => (
          <Chip key={c}>{c}</Chip>
        ))}
        {profile.requiredOutputs.length ? <span className="w-full text-muted-foreground">required outputs: {profile.requiredOutputs.map((o) => `outputs/${o}`).join(", ")}</span> : null}
      </dd>
    </dl>
  );
}

function QuotaLine({ quota }: { quota: UploadQuota }) {
  const pct = quota.maxBytes > 0 ? Math.min(100, Math.round((quota.usedBytes / quota.maxBytes) * 100)) : 0;
  return (
    <div className="flex flex-col gap-1 text-[11px] text-muted-foreground">
      <span>
        Quota: {quota.usedFiles} / {quota.maxFiles} files · {formatBytes(quota.usedBytes)} / {formatBytes(quota.maxBytes)} · {formatBytes(quota.maxFileBytes)} per file
      </span>
      <span className="h-1 w-full overflow-hidden rounded-full bg-muted">
        <span className={cn("block h-full rounded-full", pct > 90 ? "bg-destructive" : "bg-foreground/60")} style={{ width: `${pct}%` }} />
      </span>
    </div>
  );
}

function UploadRow({ artifact, selected, onToggle, disabled }: { artifact: Artifact; selected: boolean; onToggle: () => void; disabled: boolean }) {
  return (
    <li className="flex items-center gap-2 rounded-lg bg-muted/50 px-2.5 py-1.5 text-xs dark:bg-background/50">
      <input type="checkbox" className="size-3.5" checked={selected} onChange={onToggle} disabled={disabled && !selected} aria-label={`Use ${artifact.filename} as an input`} />
      <span className="min-w-0 flex-1 truncate font-medium" title={artifact.filename}>
        {artifact.filename}
      </span>
      <Chip title="Type sniffed from the bytes by the server">{artifact.mediaType}</Chip>
      <Chip>{formatBytes(artifact.byteLength)}</Chip>
      <Chip title={artifact.sha256}>sha256 {shaPrefix(artifact.sha256)}</Chip>
    </li>
  );
}

function DomainInput({
  domains,
  onChange,
  maxHosts,
  disabled,
}: {
  domains: string[];
  onChange: (next: string[]) => void;
  maxHosts: number;
  disabled: boolean;
}) {
  const [draft, setDraft] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const add = (raw: string) => {
    const tokens = raw.split(/[\s,]+/).filter((t) => t.length > 0);
    const parts = tokens.map(normalizeDomainInput).filter((p) => p.length > 0);
    if (parts.length === 0) return;
    const next = [...domains];
    for (const p of parts) if (!next.includes(p)) next.push(p);
    onChange(next);
    setDraft("");
    setNote(tokens.some((t) => normalizeDomainInput(t) !== t.toLowerCase()) ? "Scheme, path and port were dropped: an entry is a hostname." : null);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === "," || e.key === " ") {
      e.preventDefault();
      add(draft);
    } else if (e.key === "Backspace" && draft.length === 0 && domains.length > 0) {
      onChange(domains.slice(0, -1));
    }
  };
  return (
    <div className="flex flex-col gap-2">
      <div className="flex min-h-9 flex-wrap items-center gap-1 rounded-lg border border-input px-2 py-1 focus-within:ring-3 focus-within:ring-ring/50">
        {domains.map((d) => {
          const problem = domainProblem(d);
          return (
            <span
              key={d}
              className={cn("inline-flex h-6 items-center gap-1 rounded-md border px-1.5 font-mono text-[11px]", problem ? "border-destructive/50 bg-destructive/5 text-destructive" : "border-border bg-muted/60")}
              title={problem ?? "allowed destination"}
            >
              {d}
              <button type="button" aria-label={`Remove ${d}`} className="text-muted-foreground hover:text-foreground" onClick={() => onChange(domains.filter((x) => x !== d))} disabled={disabled}>
                <IconX className="size-3" />
              </button>
            </span>
          );
        })}
        <input
          aria-label="Add an allowed site"
          className="h-6 min-w-40 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
          placeholder={domains.length === 0 ? "data.example.org or .example.org (subdomains)" : "add another…"}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKey}
          onBlur={() => add(draft)}
          disabled={disabled}
          spellCheck={false}
          autoCapitalize="off"
        />
      </div>
      <p className="text-[11px] text-muted-foreground">
        Only these sites; set by you, never by a page or the model. Exact hostnames, or <Mono>.suffix</Mono> for subdomains; no IP addresses, localhost or internal names. Up to {maxHosts}.
      </p>
      {note ? <p className="text-[11px] text-muted-foreground">{note}</p> : null}
    </div>
  );
}

export function GeneralTaskComposer({ modeSwitch }: { modeSwitch: ReactNode }) {
  const session = useSession();
  const roster = useSharedTaskList();
  const allowed = canOperate(session.role);
  const [profiles, setProfiles] = useState<TaskProfileInfo[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [profileId, setProfileId] = useState("");
  const [goal, setGoal] = useState("");
  const [domains, setDomains] = useState<string[]>([]);
  const [uploads, setUploads] = useState<Artifact[] | null>(null);
  const [quota, setQuota] = useState<UploadQuota | null>(null);
  const [uploadsError, setUploadsError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [uploading, setUploading] = useState<string | null>(null);
  const [uploadErrors, setUploadErrors] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const [scripts, setScripts] = useState<DiagnosticScript[] | null>(null);
  const [script, setScript] = useState("");
  const [heroLoaded, setHeroLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    setProfiles(null);
    setLoadError(null);
    getTaskProfiles(controller.signal)
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

  const refreshUploads = useCallback(async () => {
    try {
      const r = await listUploads();
      setUploads(r.artifacts);
      setQuota(r.quota);
      setUploadsError(null);
    } catch (err) {
      setUploadsError(err instanceof ApiError && err.status === 401 ? "Sign in to upload and list your files." : describeError(err));
    }
  }, []);

  useEffect(() => {
    if (!allowed) return;
    void refreshUploads();
    const controller = new AbortController();
    getDiagnostics(controller.signal)
      // The catalog carries no task kind; general scripts are named "general-*" (fixtures/scripted-general).
      .then((list) => setScripts(list.filter((d) => d.name.startsWith("general-"))))
      .catch(() => setScripts([]));
    return () => controller.abort();
  }, [allowed, refreshUploads]);

  const profile = profiles?.find((p) => p.id === profileId) ?? null;
  const domainProblems = profile ? domainListProblems(domains, profile) : [];
  const inputsAllowed = profile?.acceptsUploads ?? false;
  const effectiveInputs = inputsAllowed ? selected : [];
  const trimmed = goal.trim();
  const canSend = allowed && !busy && profile !== null && trimmed.length > 0 && domainProblems.length === 0 && uploading === null;

  const ingest = async (files: FileList | File[]) => {
    const list = Array.from(files);
    if (list.length === 0) return;
    const errors: string[] = [];
    for (const file of list) {
      if (file.size > UPLOAD_MAX_BYTES) {
        errors.push(`${file.name}: ${uploadErrorMessage(413, `This file is ${formatBytes(file.size)}; not sent.`, true)}`);
        continue;
      }
      setUploading(file.name);
      try {
        const artifact = await uploadFile(file, file.name);
        setSelected((cur) => (cur.includes(artifact.id) || cur.length >= MAX_INPUTS ? cur : [...cur, artifact.id]));
      } catch (err) {
        errors.push(`${file.name}: ${err instanceof ApiError ? uploadErrorMessage(err.status, err.message) : describeError(err)}`);
      }
    }
    setUploading(null);
    setUploadErrors(errors);
    await refreshUploads();
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);
    if (!allowed || !inputsAllowed) return;
    void ingest(e.dataTransfer.files);
  };

  const loadHero = () => {
    setProfileId(HERO_EXAMPLE.profileId);
    setGoal(HERO_EXAMPLE.goal);
    setDomains([...HERO_EXAMPLE.domains]);
    setHeroLoaded(true);
    setSubmitError(null);
  };

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!profile) return setSubmitError("Choose a task profile.");
    if (trimmed.length === 0) return setSubmitError("Describe the goal first.");
    if (goal.length > GOAL_MAX) return setSubmitError(`The goal is limited to ${GOAL_MAX.toLocaleString()} characters.`);
    if (domainProblems.length > 0) return setSubmitError(`Allowed sites: ${domainProblems.join("; ")}`);
    setBusy(true);
    setSubmitError(null);
    try {
      const task = await createGeneralTask({ profileId: profile.id, goal, inputArtifactIds: effectiveInputs, egressAllow: profile.browser ? domains : [], scriptedDriver: script || undefined });
      roster.refresh();
      navigate({ name: "task", id: task.id });
    } catch (err) {
      setSubmitError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && canSend) {
      e.preventDefault();
      void submit();
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader>
        {modeSwitch}
        <span className="ml-2 hidden text-sm text-muted-foreground sm:inline">Profile:</span>
        {profiles && profiles.length > 0 ? (
          <select
            aria-label="Task profile"
            className="h-8 min-w-0 max-w-full truncate rounded-md border-0 bg-transparent px-1.5 text-sm font-medium outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
            value={profileId}
            onChange={(e) => setProfileId(e.target.value)}
            disabled={busy}
          >
            {profiles.map((p) => (
              <option value={p.id} key={p.id}>
                {p.displayName}
              </option>
            ))}
          </select>
        ) : (
          <span className="text-sm text-muted-foreground">{loadError ? "unavailable" : "loading…"}</span>
        )}
      </PageHeader>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="mx-auto flex min-h-full w-full max-w-2xl flex-col items-center gap-4 px-4 py-8 text-center">
          <div className="flex flex-col items-center gap-3">
            <span className="flex size-12 items-center justify-center rounded-2xl bg-foreground text-background">
              <IconSparkles className="size-6" />
            </span>
            <h1 className="text-2xl font-medium tracking-tight">What should it do?</h1>
            <p className="max-w-md text-sm text-pretty text-muted-foreground">
              Describe a goal. The model plans and acts only through the profile's tools, in disposable sandboxes; the controller collects the outputs and
              runs its own completion checks. The model never decides whether it succeeded.
            </p>
          </div>

          {loadError ? <ErrorBox className="w-full text-left" message={loadError} onRetry={() => setReloadKey((k) => k + 1)} /> : null}
          {!profiles && !loadError ? <Skeleton className="h-40 w-full rounded-xl bg-muted/60" /> : null}

          {profiles && profiles.length > 0 ? (
            <Section title="Task profile" aside={profile ? <span>v{profile.version}</span> : null}>
              <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Task profile">
                {profiles.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    role="radio"
                    aria-checked={p.id === profileId}
                    onClick={() => setProfileId(p.id)}
                    disabled={busy}
                    className={cn(
                      "flex flex-col gap-1 rounded-lg border p-2.5 text-left text-xs transition-colors hover:bg-foreground/[0.03]",
                      p.id === profileId ? "border-foreground/50 bg-foreground/[0.04]" : "border-border",
                    )}
                  >
                    <span className="flex items-center gap-1 font-medium text-sm">
                      {p.browser ? <IconWorld className="size-3.5" /> : <IconLock className="size-3.5" />}
                      {p.displayName}
                    </span>
                    <span className="text-muted-foreground">{p.description}</span>
                  </button>
                ))}
              </div>
              {profile ? <ProfileDetails profile={profile} /> : null}
            </Section>
          ) : null}

          <Section
            title="Hero example"
            aside={
              <Button type="button" size="xs" variant="outline" onClick={loadHero} disabled={busy || !profiles?.some((p) => p.id === HERO_EXAMPLE.profileId)}>
                Load the hero example
              </Button>
            }
          >
            <p className="text-xs text-pretty text-muted-foreground">
              Fills the form with the web-analysis goal and site from the documented fixture (<Mono>{HERO_EXAMPLE.source}</Mono>). It only fills the form;
              nothing is sent until you press start. A live run needs that fixture page hosted at the listed site.
            </p>
            {heroLoaded ? (
              <Notice tone="warn" className="mt-2 text-xs">
                Hero example loaded into the form: profile web-analysis, goal and one allowed site. Review before starting.
              </Notice>
            ) : null}
          </Section>

          {profile?.browser ? (
            <Section title="Allowed sites" aside={<span>{domains.length} / {profile.maxEgressHosts}</span>}>
              <DomainInput domains={domains} onChange={setDomains} maxHosts={profile.maxEgressHosts} disabled={busy || !allowed} />
              {domainProblems.length > 0 && domains.length > 0 ? (
                <ul className="mt-2 flex flex-col gap-0.5 text-xs text-destructive">
                  {domainProblems.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              ) : domains.length === 0 ? (
                <p className="mt-2 text-xs text-warning">A browser profile needs at least one allowed site.</p>
              ) : null}
            </Section>
          ) : null}

          {profile ? (
            <Section title="Input files" aside={<span>{effectiveInputs.length} / {MAX_INPUTS} selected</span>}>
              {!inputsAllowed ? (
                <p className="text-xs text-muted-foreground">The {profile.displayName} profile does not accept input files.</p>
              ) : !allowed ? (
                <p className="text-xs text-muted-foreground">Sign in as operator or judge to upload files.</p>
              ) : (
                <div className="flex flex-col gap-2">
                  <div
                    role="button"
                    tabIndex={0}
                    aria-label="Upload files: drop them here or press to choose"
                    onDragOver={(e) => {
                      e.preventDefault();
                      setDragging(true);
                    }}
                    onDragLeave={() => setDragging(false)}
                    onDrop={onDrop}
                    onClick={() => fileInput.current?.click()}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        fileInput.current?.click();
                      }
                    }}
                    className={cn(
                      "flex cursor-pointer flex-col items-center gap-1 rounded-lg border border-dashed px-3 py-5 text-xs text-muted-foreground transition-colors",
                      dragging ? "border-foreground/60 bg-foreground/[0.04]" : "border-border hover:bg-foreground/[0.02]",
                    )}
                  >
                    <IconCloudUpload className="size-5" />
                    {uploading ? <span>Uploading {uploading}…</span> : <span>Drop files here, or press to choose. CSV, JSON, text, PDF, PNG or JPEG; up to 10 MiB each.</span>}
                    <input
                      ref={fileInput}
                      type="file"
                      multiple
                      className="hidden"
                      onChange={(e) => {
                        if (e.target.files) void ingest(e.target.files);
                        e.target.value = "";
                      }}
                    />
                  </div>
                  {uploadErrors.map((m) => (
                    <ErrorBox key={m} message={m} />
                  ))}
                  {uploadsError ? <p className="text-xs text-destructive">{uploadsError}</p> : null}
                  {quota ? <QuotaLine quota={quota} /> : null}
                  {uploads && uploads.length > 0 ? (
                    <ul className="flex flex-col gap-1">
                      {uploads.map((a) => (
                        <UploadRow
                          key={a.id}
                          artifact={a}
                          selected={selected.includes(a.id)}
                          disabled={selected.length >= MAX_INPUTS}
                          onToggle={() => setSelected((cur) => (cur.includes(a.id) ? cur.filter((x) => x !== a.id) : [...cur, a.id]))}
                        />
                      ))}
                    </ul>
                  ) : uploads ? (
                    <p className="text-xs text-muted-foreground">No uploads yet.</p>
                  ) : null}
                  <p className="text-[11px] text-muted-foreground">
                    The type shown is what the server sniffed from the bytes, not the file name. Checked files are placed read-only under <Mono>inputs/</Mono> in the code sandbox.
                  </p>
                </div>
              )}
            </Section>
          ) : null}

          {allowed && scripts && scripts.length > 0 ? (
            <Section title="Diagnostic driver (optional)" aside={<IconFlask className="size-4 text-warning" />}>
              <select
                aria-label="Labelled diagnostic script"
                className="h-8 w-full rounded-md border border-input bg-transparent px-2 text-xs"
                value={script}
                onChange={(e) => setScript(e.target.value)}
                disabled={busy}
              >
                <option value="">None: the configured model driver</option>
                {scripts.map((s) => (
                  <option key={s.name} value={s.name}>
                    {s.title || s.name} ({s.name})
                  </option>
                ))}
              </select>
              <p className="mt-1.5 text-[11px] text-muted-foreground">
                A scripted driver replays fixed turns through the same sandboxes and checks. No model is called; the task is labelled diagnostic everywhere.
              </p>
              {script ? (
                <Badge tone="warn" className="mt-1.5">
                  diagnostic: {script}
                </Badge>
              ) : null}
            </Section>
          ) : null}
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
                  You are signed out.{" "}
                  <a className="font-medium text-foreground underline underline-offset-4" href={hrefFor({ name: "login" })}>
                    Sign in
                  </a>{" "}
                  as operator or judge to run a task.
                </span>
              </Notice>
            ) : null}
            {submitError ? <ErrorBox message={submitError} /> : null}
          </div>
        }
        footnote="Cmd/Ctrl + Enter starts the task. The model sees this goal, the profile's tools, your files and tool results; it cannot change the allowed sites."
      >
        <textarea
          aria-label="Goal"
          className="max-h-[240px] min-h-16 w-full resize-none bg-transparent px-1 text-sm leading-relaxed outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
          value={goal}
          maxLength={GOAL_MAX}
          rows={3}
          placeholder="Describe the goal, e.g. summarise the uploaded CSV into outputs/summary.json…"
          onChange={(e) => setGoal(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={busy || !allowed}
        />
        <div className="flex items-center gap-2">
          {profile ? (
            <Chip className="max-w-[40%]">
              <span className="truncate">{profile.id}</span>
            </Chip>
          ) : null}
          {effectiveInputs.length ? <Chip>{effectiveInputs.length} file(s)</Chip> : null}
          {profile?.browser ? <Chip tone={domainProblems.length ? "bad" : "neutral"}>{domains.length} site(s)</Chip> : null}
          {script ? <Badge tone="warn">diagnostic</Badge> : null}
          <span className="ml-auto text-[11px] tabular-nums text-muted-foreground">
            {goal.length.toLocaleString()} / {GOAL_MAX.toLocaleString()}
          </span>
          <Button type="submit" aria-label="Start the task" title="Start the task" className="size-8 rounded-full p-0" size="icon" disabled={!canSend}>
            {busy ? <span className="size-3 animate-spin rounded-full border-2 border-current border-t-transparent" /> : <IconArrowUp className="size-4" />}
          </Button>
        </div>
      </ComposerFrame>
    </div>
  );
}
