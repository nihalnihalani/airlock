/**
 * Human control of a general task's browser (40 Stage 5; audit 42 C22–C24): who holds control,
 * take/return, the latest live frame, and the actions a person holding control can send. The
 * control plane enforces everything shown here (exclusive control, the allowlist, the deadline,
 * budgets); this panel restates its answers and never treats a click as an approval.
 * All page-derived strings (URLs, control names, file names) are React text nodes.
 */
import { IconArrowBackUp, IconCamera, IconClick, IconDownload, IconHandStop, IconKeyboard, IconRefresh, IconUpload, IconWorld } from "@tabler/icons-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { Artifact, Task } from "@airlock/contracts";
import { useTick, type BrowserControlData } from "../../hooks/useBrowserControl";
import { ApiError, describeError, humanAction, listUploads, refreshLive, releaseControl, takeControl } from "../../lib/api";
import {
  actionOutcome,
  buildHumanRequest,
  checkNavigateUrl,
  controlErrorMessage,
  controlView,
  expiryCountdown,
  generationAfter,
  HUMAN_KEYS,
  latestFrame,
  parseDownloads,
  parseObservation,
  refreshWait,
  RELEASE_EXPLANATION,
  rememberOwnerId,
  staleReason,
  TAKE_EXPLANATION,
  type ActionForm,
  type ActionOutcomeView,
  type ActionResponse,
  type DownloadRow,
  type Observation,
  type Viewer,
} from "../../lib/control";
import { formatBytes, formatDateTime, formatDurationMs, formatTime } from "../../lib/format";
import { artifactHref, shaPrefix } from "../../lib/general";
import type { RunEvent } from "@airlock/contracts";
import { cn } from "../../lib/utils";
import { Badge, Chip, ErrorBox, Mono, Notice } from "../common";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";

function errorText(err: unknown, action: Parameters<typeof controlErrorMessage>[2]): string {
  return err instanceof ApiError ? controlErrorMessage(err.status, err.message, action) : describeError(err);
}

function Section({ title, aside, children, className }: { title: string; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn("flex flex-col gap-2", className)}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-medium">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

// --- Control panel -----------------------------------------------------------------------------------

export function ControlPanel({
  task,
  data,
  viewer,
  canOperate,
  onOwnerLearned,
}: {
  task: Task;
  data: BrowserControlData;
  viewer: Viewer;
  canOperate: boolean;
  onOwnerLearned: (id: string) => void;
}) {
  const [busy, setBusy] = useState<"take" | "release" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const running = task.status === "running";
  const view = controlView(data.control, viewer, { running, canOperate });
  const now = useTick(1000, view.idleExpiresAt !== null);
  const idle = view.idleExpiresAt ? expiryCountdown(view.idleExpiresAt, now) : null;

  const take = async () => {
    setBusy("take");
    setError(null);
    try {
      const c = await takeControl(task.id);
      if (c.holder === "human" && c.humanOwner) {
        rememberOwnerId(c.humanOwner);
        onOwnerLearned(c.humanOwner);
      }
      data.applyControl(c);
    } catch (err) {
      setError(errorText(err, "take"));
      data.refreshControl();
    } finally {
      setBusy(null);
    }
  };
  const release = async () => {
    setBusy("release");
    setError(null);
    try {
      data.applyControl(await releaseControl(task.id));
    } catch (err) {
      setError(errorText(err, "release"));
      data.refreshControl();
    } finally {
      setBusy(null);
    }
  };

  return (
    <Section
      title="Browser control"
      aside={
        <Badge tone={view.tone} title={view.sentence}>
          {view.holder}
        </Badge>
      }
    >
      <p className="text-xs text-pretty">{view.sentence}</p>
      <dl className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted-foreground">since</dt>
        <dd>{view.since ? formatDateTime(view.since) : "—"}</dd>
        <dt className="text-muted-foreground">reason</dt>
        <dd className="break-words">{view.reason ?? <span className="text-muted-foreground">none recorded</span>}</dd>
        {idle ? (
          <>
            <dt className="text-muted-foreground">idle expiry</dt>
            <dd className={cn(idle.urgent && "font-medium text-warning")}>
              {idle.text} (control returns to the agent after {data.control?.idleMs ? formatDurationMs(data.control.idleMs) : "a while"} without an action)
            </dd>
          </>
        ) : null}
        {view.fenceGeneration !== null ? (
          <>
            <dt className="text-muted-foreground">fence generation</dt>
            <dd>
              <Mono>{view.fenceGeneration}</Mono> <span className="text-muted-foreground">(page snapshots from before are stale)</span>
            </dd>
          </>
        ) : null}
      </dl>
      {data.controlError ? <p className="text-xs text-destructive">Control state unavailable: {data.controlError}</p> : null}
      {view.unavailable ? <p className="text-xs text-muted-foreground">{view.unavailable}</p> : null}
      <div className="flex flex-wrap gap-2">
        {view.canTake ? (
          <Button size="sm" onClick={() => void take()} disabled={busy !== null}>
            <IconHandStop />
            {busy === "take" ? "Taking control…" : view.holder === "Transferring" ? "Take control again" : "Take control"}
          </Button>
        ) : null}
        {view.canRelease ? (
          <Button size="sm" variant="outline" onClick={() => void release()} disabled={busy !== null}>
            <IconArrowBackUp />
            {busy === "release" ? "Returning…" : "Return control to the agent"}
          </Button>
        ) : null}
      </div>
      {view.canTake ? <p className="text-[11px] text-pretty text-muted-foreground">{TAKE_EXPLANATION}</p> : null}
      {view.youHold || view.canRelease ? <p className="text-[11px] text-pretty text-muted-foreground">{RELEASE_EXPLANATION}</p> : null}
      {error ? <ErrorBox message={error} /> : null}
    </Section>
  );
}

// --- Live view ------------------------------------------------------------------------------------------

export function LiveView({ task, data, events, canOperate }: { task: Task; data: BrowserControlData; events: readonly RunEvent[]; canOperate: boolean }) {
  const frame = useMemo(() => latestFrame(events, data.live?.frame ?? null), [events, data.live?.frame]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastAt, setLastAt] = useState<number | null>(null);
  const [imgFailed, setImgFailed] = useState<string | null>(null);
  const minMs = data.live?.refreshMinIntervalMs ?? 2000;
  const now = useTick(250, lastAt !== null);
  const wait = refreshWait(lastAt, minMs, now);
  const running = task.status === "running";

  const refresh = async () => {
    setBusy(true);
    setError(null);
    setLastAt(Date.now());
    try {
      await refreshLive(task.id);
      data.refreshLive();
    } catch (err) {
      setError(errorText(err, "refresh"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section
      title="Live view"
      aside={
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {data.live ? (data.live.liveBrowser ? <Badge tone="info">browser live</Badge> : <Badge>no live browser session</Badge>) : null}
          {data.live ? <span>{data.live.frames} frame(s) stored</span> : null}
        </span>
      }
    >
      {frame ? (
        <figure className="flex flex-col gap-1.5">
          {imgFailed === frame.artifactId ? (
            <div className="flex h-24 items-center justify-center rounded-lg border border-dashed text-xs text-muted-foreground">Frame {frame.artifactId} could not be loaded.</div>
          ) : (
            <a href={artifactHref(frame.artifactId)} target="_blank" rel="noreferrer noopener" title="Open the stored frame">
              <img
                key={frame.artifactId}
                src={artifactHref(frame.artifactId)}
                alt={`Latest browser frame ${frame.artifactId}${frame.url ? ` of ${frame.url}` : ""}`}
                decoding="async"
                referrerPolicy="no-referrer"
                className="max-h-[28rem] w-full rounded-lg border border-border bg-muted/40 object-contain object-top"
                onError={() => setImgFailed(frame.artifactId)}
              />
            </a>
          )}
          <figcaption className="flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
            <Mono>{frame.artifactId}</Mono>
            {frame.sha256 ? <Chip title={frame.sha256}>sha256 {shaPrefix(frame.sha256)}</Chip> : null}
            <span>captured {formatDateTime(frame.at)}</span>
            {frame.actor ? <Chip>{frame.actor === "observer" || frame.actor === "live_view" ? "live view" : frame.actor === "human" || frame.actor === "human_screenshot" ? "a person's screenshot" : frame.actor}</Chip> : null}
            {frame.url ? (
              <span className="w-full min-w-0 break-all" title={frame.url}>
                {frame.url}
              </span>
            ) : null}
          </figcaption>
        </figure>
      ) : (
        <p className="text-xs text-muted-foreground">No frame yet. A frame is a stored screenshot of the task's browser (the agent's, yours, or a live-view refresh).</p>
      )}
      {data.liveError ? <p className="text-xs text-destructive">Live view unavailable: {data.liveError}</p> : null}
      {running && canOperate ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => void refresh()} disabled={busy || wait > 0 || data.live?.liveBrowser === false}>
            <IconRefresh />
            {busy ? "Capturing…" : wait > 0 ? `Refresh in ${(wait / 1000).toFixed(1)} s` : "Refresh frame"}
          </Button>
          <span className="text-[11px] text-muted-foreground">
            Read-only: a frame never acts on the page. At most one refresh per {formatDurationMs(minMs)} per task; the server answers 429 inside that window.
          </span>
        </div>
      ) : null}
      {error ? <ErrorBox message={error} /> : null}
    </Section>
  );
}

// --- Human actions -----------------------------------------------------------------------------------------

interface LastResult {
  label: string;
  outcome: ActionOutcomeView;
  artifactId: string | null;
  durationMs: number | null;
  at: string;
}

function OutcomeLine({ r }: { r: LastResult }) {
  return (
    <div className={cn("flex flex-col gap-1 rounded-lg border p-2.5 text-xs", r.outcome.tone === "bad" ? "border-destructive/30" : r.outcome.tone === "warn" ? "border-warning/40" : "border-border")} role="status">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-medium">{r.label}</span>
        <Badge tone={r.outcome.tone} title="opState of this action as the control plane answered it">
          opState {r.outcome.opState}
        </Badge>
        {r.durationMs !== null ? <Chip>{formatDurationMs(r.durationMs)}</Chip> : null}
        <span className="ml-auto text-muted-foreground">{formatTime(r.at)}</span>
      </div>
      {r.outcome.error ? <p className="break-words text-destructive">{r.outcome.error}</p> : null}
      {r.outcome.explain ? <p className="text-pretty text-muted-foreground">{r.outcome.explain}</p> : null}
      {r.artifactId ? (
        <p>
          stored as{" "}
          <a className="underline underline-offset-4" href={artifactHref(r.artifactId)} target="_blank" rel="noreferrer noopener">
            <Mono>{r.artifactId}</Mono>
          </a>
        </p>
      ) : null}
    </div>
  );
}

export function HumanActions({ task, data }: { task: Task; data: BrowserControlData }) {
  const allow = task.egressAllow ?? [];
  const [url, setUrl] = useState("");
  const [obs, setObs] = useState<Observation | null>(null);
  const [latest, setLatest] = useState<{ generation: number | null; invalidated: boolean } | null>(null);
  const [ref, setRef] = useState("");
  const [text, setText] = useState("");
  const [submit, setSubmit] = useState(false);
  const [key, setKey] = useState<string>("Enter");
  const [dy, setDy] = useState("600");
  const [downloads, setDownloads] = useState<DownloadRow[] | null>(null);
  const [uploads, setUploads] = useState<Artifact[] | null>(null);
  const [uploadsError, setUploadsError] = useState<string | null>(null);
  const [uploadId, setUploadId] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [last, setLast] = useState<LastResult | null>(null);

  const urlCheck = url.trim() ? checkNavigateUrl(url, allow) : null;
  const stale = staleReason(obs, latest);
  const selected = obs?.controls.find((c) => c.ref === ref) ?? null;

  useEffect(() => {
    listUploads()
      .then((r) => {
        setUploads(r.artifacts);
        setUploadsError(null);
      })
      .catch((err: unknown) => setUploadsError(describeError(err)));
  }, []);

  const run = async (label: string, form: ActionForm, after?: (resp: ActionResponse) => void) => {
    const built = buildHumanRequest(form, { observation: obs, latest, allow });
    if (!built.ok) {
      setProblem(built.problem);
      return;
    }
    setProblem(null);
    setBusy(label);
    const started = Date.now();
    try {
      const resp = await humanAction(task.id, built.request);
      const outcome = actionOutcome(resp);
      const inner = resp.result?.response && resp.result.response.ok ? (resp.result.response as { result?: unknown }).result : undefined;
      const g = generationAfter(inner);
      if (outcome.error?.startsWith("stale_reference")) setLatest((l) => ({ generation: l?.generation ?? null, invalidated: true }));
      else if (g.generation !== null && built.request.op !== "observe") setLatest({ generation: g.generation, invalidated: g.invalidated });
      setLast({ label, outcome, artifactId: resp.artifactId ?? null, durationMs: resp.result?.durationMs ?? Date.now() - started, at: new Date().toISOString() });
      after?.(resp);
      if (built.request.op === "screenshot") data.refreshLive();
    } catch (err) {
      setLast({ label, outcome: { opState: "failed", tone: "bad", label: "failed", error: errorText(err, "action"), explain: null }, artifactId: null, durationMs: null, at: new Date().toISOString() });
      data.refreshControl();
    } finally {
      setBusy(null);
    }
  };

  const observe = () =>
    run("Observe", { kind: "observe" }, (resp) => {
      const inner = resp.result?.response && resp.result.response.ok ? (resp.result.response as { result?: unknown }).result : undefined;
      const o = resp.ok ? parseObservation(inner) : null;
      if (o) {
        setObs(o);
        setLatest({ generation: o.generation, invalidated: false });
        if (!o.controls.some((c) => c.ref === ref)) setRef("");
      }
    });

  const busyAny = busy !== null;

  return (
    <Section title="Your actions" aside={<Badge tone="info">you hold control</Badge>}>
      <p className="text-[11px] text-pretty text-muted-foreground">
        Every action goes through the control plane and the same egress proxy as the agent's, counts against the task's browser budget and deadline, and is recorded as yours. A
        click on a submit button is never an approval: a supported form refuses a submission without Airlock's one-use approval code.
      </p>

      {/* Navigate */}
      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium" htmlFor="human-nav-url">
          Navigate
        </label>
        <div className="flex gap-2">
          <Input id="human-nav-url" value={url} maxLength={2048} placeholder="https://…" onChange={(e) => setUrl(e.target.value)} className="h-8 font-mono text-xs" />
          <Button size="sm" onClick={() => void run("Navigate", { kind: "navigate", url })} disabled={busyAny || !urlCheck?.ok}>
            <IconWorld />
            Go
          </Button>
        </div>
        {urlCheck ? (
          urlCheck.ok ? (
            <p className={cn("text-[11px]", urlCheck.allowed ? "text-muted-foreground" : "text-warning")}>
              <Mono>{urlCheck.host}</Mono>{" "}
              {urlCheck.allowed ? "is on this task's allowed list." : `is not on this task's allowed list (${allow.join(", ") || "none"}); the server will refuse it before anything reaches the network.`}
            </p>
          ) : (
            <p className="text-[11px] text-destructive">{urlCheck.problem}</p>
          )
        ) : (
          <p className="text-[11px] text-muted-foreground">Allowed: {allow.length ? allow.join(", ") : "none"}. The server enforces the list; this hint only mirrors it.</p>
        )}
      </div>

      {/* Observe + controls */}
      <div className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => void observe()} disabled={busyAny}>
            <IconRefresh />
            {busy === "Observe" ? "Observing…" : "Observe page"}
          </Button>
          {obs ? (
            <span className="text-[11px] text-muted-foreground">
              generation <Mono>{obs.generation}</Mono> · {obs.controls.length} control(s){obs.controlsTruncated ? " (truncated)" : ""}
              {obs.pendingReview ? " · a dialog awaits a decision" : ""}
            </span>
          ) : null}
        </div>
        {obs ? (
          <>
            <p className="min-w-0 truncate text-[11px] text-muted-foreground" title={obs.url}>
              {obs.title ? `${obs.title} · ` : ""}
              {obs.url}
            </p>
            {stale ? (
              <Notice tone="warn" className="text-xs">
                {stale}
              </Notice>
            ) : null}
            <div className="max-h-64 overflow-auto rounded-lg border border-border">
              <table className="w-full border-collapse text-left text-xs">
                <thead className="sticky top-0 bg-muted">
                  <tr>
                    <th className="w-8 px-2 py-1" />
                    <th className="px-2 py-1 font-medium">ref</th>
                    <th className="px-2 py-1 font-medium">role</th>
                    <th className="px-2 py-1 font-medium">name (from the page)</th>
                  </tr>
                </thead>
                <tbody>
                  {obs.controls.map((c) => (
                    <tr key={c.ref} className={cn("border-t border-border align-top", ref === c.ref && "bg-blue-500/10")}>
                      <td className="px-2 py-1">
                        <input type="radio" name="human-control" aria-label={`Select control ${c.ref}`} checked={ref === c.ref} onChange={() => setRef(c.ref)} disabled={!!stale} />
                      </td>
                      <td className="px-2 py-1 font-mono">{c.ref}</td>
                      <td className="px-2 py-1">{c.role}</td>
                      <td className="px-2 py-1 break-words">
                        {c.name || <span className="text-muted-foreground">(no name)</span>}
                        {c.value ? <span className="text-muted-foreground"> = {c.value}</span> : null}
                        {c.disabled ? <Badge className="ml-1">disabled</Badge> : null}
                      </td>
                    </tr>
                  ))}
                  {obs.controls.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="px-2 py-2 text-muted-foreground">
                        No controls on this page.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <p className="text-[11px] text-muted-foreground">Observe the page to list its controls; click, type and upload act on a control from the latest observation.</p>
        )}
      </div>

      {/* Ref-bound actions */}
      <div className="flex flex-col gap-1.5 rounded-lg border border-border p-2.5">
        <p className="text-xs">
          Selected control:{" "}
          {selected ? (
            <>
              <Mono>{selected.ref}</Mono> {selected.role} <span className="break-words">“{selected.name}”</span>
            </>
          ) : (
            <span className="text-muted-foreground">none</span>
          )}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => void run("Click", { kind: "click", ref })} disabled={busyAny || !selected || !!stale}>
            <IconClick />
            Click
          </Button>
        </div>
        <Textarea value={text} maxLength={8192} placeholder="Text to type into the selected control (replaces its value)" onChange={(e) => setText(e.target.value)} className="min-h-16 text-xs" />
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs">
            <input type="checkbox" checked={submit} onChange={(e) => setSubmit(e.target.checked)} /> press Enter after typing
          </label>
          <Button size="sm" variant="outline" onClick={() => void run("Type", { kind: "type", ref, text, submit })} disabled={busyAny || !selected || !!stale}>
            <IconKeyboard />
            Type
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select aria-label="Your file to upload" className="h-7 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-xs dark:bg-input/30" value={uploadId} onChange={(e) => setUploadId(e.target.value)}>
            <option value="">Upload one of your files…</option>
            {(uploads ?? []).map((a) => (
              <option key={a.id} value={a.id}>
                {a.filename} ({formatBytes(a.byteLength)})
              </option>
            ))}
          </select>
          <Button size="sm" variant="outline" onClick={() => void run("Upload", { kind: "upload", ref, artifactId: uploadId })} disabled={busyAny || !selected || !!stale || !uploadId}>
            <IconUpload />
            Upload to control
          </Button>
        </div>
        {uploadsError ? <p className="text-[11px] text-destructive">Your files could not be listed: {uploadsError}</p> : null}
        {uploads && uploads.length === 0 ? <p className="text-[11px] text-muted-foreground">You have no uploaded files. Upload one from the new-task page.</p> : null}
        <p className="text-[11px] text-muted-foreground">Uploads place the exact recorded bytes of your own file into a file input; never a path on any host.</p>
      </div>

      {/* Keys, scroll, screenshot */}
      <div className="flex flex-wrap items-center gap-2">
        <select aria-label="Key" className="h-7 rounded-md border border-input bg-background px-2 text-xs dark:bg-input/30" value={key} onChange={(e) => setKey(e.target.value)}>
          {HUMAN_KEYS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <Button size="sm" variant="outline" onClick={() => void run(`Key ${key}`, { kind: "key", key })} disabled={busyAny || !!stale}>
          <IconKeyboard />
          Press key
        </Button>
        <span className="mx-1 h-4 w-px bg-border" />
        <Input aria-label="Scroll by pixels" value={dy} onChange={(e) => setDy(e.target.value)} className="h-7 w-20 text-xs" inputMode="numeric" />
        <Button size="sm" variant="outline" onClick={() => void run("Scroll", { kind: "scroll", dy })} disabled={busyAny}>
          Scroll
        </Button>
        <span className="mx-1 h-4 w-px bg-border" />
        <Button size="sm" variant="outline" onClick={() => void run("Screenshot", { kind: "screenshot", fullPage: false })} disabled={busyAny}>
          <IconCamera />
          Screenshot
        </Button>
      </div>
      <p className="text-[11px] text-muted-foreground">Keys: {HUMAN_KEYS.join(", ")} (the browser accepts no others). Scroll: positive is down, at most 10000 px.</p>

      {/* Downloads */}
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => void run("List downloads", { kind: "download.list" }, (resp) => setDownloads(resp.ok ? parseDownloads((resp.result?.response as { result?: unknown } | null)?.result) : null))} disabled={busyAny}>
            <IconDownload />
            List downloads
          </Button>
          <span className="text-[11px] text-muted-foreground">File names and URLs come from untrusted pages.</span>
        </div>
        {downloads ? (
          downloads.length === 0 ? (
            <p className="text-xs text-muted-foreground">No downloads in this browser session.</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {downloads.map((d) => (
                <li key={d.downloadId} className="flex flex-wrap items-center gap-1.5 rounded-md bg-muted/50 px-2 py-1 text-xs dark:bg-background/50">
                  <Mono>{d.downloadId}</Mono>
                  <span className="min-w-0 break-all">{d.suggestedFilename || "(no name)"}</span>
                  <Badge tone={d.state === "completed" ? "ok" : d.state === "in_progress" ? "info" : "bad"}>{d.state}</Badge>
                  {d.reason ? <span className="text-muted-foreground">{d.reason}</span> : null}
                  {d.bytes !== null ? <Chip>{formatBytes(d.bytes)}</Chip> : null}
                  {d.state === "completed" ? (
                    <Button size="xs" variant="outline" className="ml-auto" onClick={() => void run(`Save ${d.downloadId}`, { kind: "download.read", downloadId: d.downloadId })} disabled={busyAny}>
                      Save as artifact
                    </Button>
                  ) : null}
                  {d.url ? <span className="w-full min-w-0 truncate text-muted-foreground" title={d.url}>{d.url}</span> : null}
                </li>
              ))}
            </ul>
          )
        ) : null}
      </div>

      {problem ? <Notice tone="warn" className="text-xs">{problem}</Notice> : null}
      {busy ? <p className="text-xs text-muted-foreground">{busy}: waiting for the control plane…</p> : null}
      {last ? <OutcomeLine r={last} /> : null}
    </Section>
  );
}
