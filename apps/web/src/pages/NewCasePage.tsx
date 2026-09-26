import { useEffect, useState, type FormEvent } from "react";
import type { ProfileManifest } from "@airlock/contracts";
import { canOperate, useSession } from "../hooks/session";
import { createTask, describeError, getProfiles } from "../lib/api";
import { formatBytes, formatDurationMs, shortSha } from "../lib/format";
import { hrefFor, navigate } from "../lib/router";
import { Badge, Chip, ErrorBox, KeyValue, Loading, Mono, Notice, Section } from "../components/ui";

const ISSUE_MAX = 20000;

function ProfileCard({ profile }: { profile: ProfileManifest }) {
  const caps = profile.caps;
  return (
    <div className="profile-card">
      <div className="list-head">
        <strong>{profile.displayName}</strong>
        <Badge tone="info" title="A disclosed replay of a historical, already-fixed issue. Not a benchmark claim.">
          historical replay
        </Badge>
        <Chip>{profile.language}</Chip>
      </div>
      <KeyValue
        rows={[
          {
            key: "issue",
            value: (
              <a href={profile.issueUrl} target="_blank" rel="noreferrer noopener">
                {profile.issueUrl}
              </a>
            ),
          },
          {
            key: "repository",
            value: (
              <a href={profile.repository} target="_blank" rel="noreferrer noopener">
                {profile.repository}
              </a>
            ),
          },
          {
            key: "baseline commit",
            value: <Mono title={profile.baselineCommit}>{shortSha(profile.baselineCommit)}</Mono>,
          },
          { key: "runtime image", value: <Mono>{profile.runtimeImage}</Mono> },
          {
            key: "agent may change",
            value: (
              <span className="chips">
                {profile.allowedReplacementPaths.map((p) => (
                  <Chip key={p}>
                    <Mono>{p}</Mono>
                  </Chip>
                ))}
              </span>
            ),
          },
          {
            key: "agent may read",
            value: (
              <span className="chips">
                {profile.readablePaths.map((p) => (
                  <Chip key={p}>
                    <Mono>{p}</Mono>
                  </Chip>
                ))}
              </span>
            ),
          },
          {
            key: "caps",
            value: `${caps.cpus} CPU · ${formatBytes(caps.memoryBytes)} · ${caps.pidsLimit} pids · ${formatDurationMs(
              caps.commandTimeoutMs,
            )} per command · ${formatDurationMs(caps.attemptTimeoutMs)} per attempt · ${caps.maxRepairAttempts} repair attempts · ${caps.maxModelCalls} model calls`,
          },
        ]}
      />
    </div>
  );
}

export function NewCasePage() {
  const session = useSession();
  const [profiles, setProfiles] = useState<ProfileManifest[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [profileId, setProfileId] = useState<string>("");
  const [issueText, setIssueText] = useState("");
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

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

  const selected = profiles?.find((p) => p.id === profileId) ?? null;
  const allowed = canOperate(session.role);
  const trimmed = issueText.trim();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
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
      navigate({ name: "task", id: task.id });
    } catch (err) {
      setSubmitError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <Section title="New case">
        <p className="muted">
          Airlock supports exactly the profiles listed here. Anything else is rejected by the API with a clear message;
          the UI never promises "any GitHub repo".
        </p>
        {loadError ? <ErrorBox message={loadError} onRetry={() => setReloadKey((k) => k + 1)} /> : null}
        {!profiles && !loadError ? <Loading label="Loading supported profiles…" /> : null}
        {profiles && profiles.length === 0 ? <Notice tone="warn">The control app lists no supported profiles.</Notice> : null}
        {profiles && profiles.length > 0 ? (
          <form className="form" onSubmit={(e) => void submit(e)}>
            <label className="label" htmlFor="profile">
              Supported profile
            </label>
            <select id="profile" value={profileId} onChange={(e) => setProfileId(e.target.value)} disabled={busy}>
              {profiles.map((p) => (
                <option value={p.id} key={p.id}>
                  {p.displayName} ({p.id})
                </option>
              ))}
            </select>
            {selected ? <ProfileCard profile={selected} /> : null}

            <label className="label" htmlFor="issue">
              Issue text
            </label>
            <p className="muted">
              Paste the report as the maintainer received it. The UI ships no issue text; copy it from the issue link
              above. Untrusted input: it only ever reaches the sandbox and the model, never a host shell.
            </p>
            <textarea
              id="issue"
              value={issueText}
              maxLength={ISSUE_MAX}
              rows={12}
              spellCheck={false}
              placeholder="Paste the issue title and body here."
              onChange={(e) => setIssueText(e.target.value)}
              disabled={busy}
            />
            <div className="counter muted">
              {issueText.length.toLocaleString()} / {ISSUE_MAX.toLocaleString()}
            </div>

            {!allowed ? (
              <Notice tone="warn">
                You are reading as a viewer. <a href={hrefFor({ name: "login" })}>Sign in</a> as operator or judge to start a
                case.
              </Notice>
            ) : null}
            <div className="btn-row">
              <button type="submit" className="btn btn-primary" disabled={busy || !allowed || !selected || trimmed.length === 0}>
                {busy ? "Starting…" : "Start"}
              </button>
            </div>
            {submitError ? <ErrorBox message={submitError} /> : null}
          </form>
        ) : null}
      </Section>
    </div>
  );
}
