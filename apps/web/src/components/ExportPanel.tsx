import { useState } from "react";
import { createExport, describeError, exportUrl, type ExportResponse } from "../lib/api";
import { formatDateTime } from "../lib/format";
import { Digest, ErrorBox, KeyValue, Mono, Section } from "./ui";

export function ExportPanel({
  taskId,
  candidateDigest,
  verificationRecordId,
  canExport,
}: {
  taskId: string;
  candidateDigest: string;
  verificationRecordId: string;
  canExport: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [grant, setGrant] = useState<ExportResponse | null>(null);

  const request = async () => {
    setBusy(true);
    setError(null);
    try {
      setGrant(await createExport(taskId));
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  // Only ever link to our own export route; the grant id is the sole untrusted part and is encoded.
  const href = grant ? exportUrl(grant.grantId) : null;

  return (
    <Section title="Download">
      <KeyValue
        rows={[
          { key: "candidate digest", value: <Digest value={candidateDigest} /> },
          { key: "verification record", value: <Mono>{verificationRecordId}</Mono> },
        ]}
      />
      <p className="muted">
        The bundle contains patch.diff, manifest.json, verification.json, baseline.json, task.json (the task record
        with lease fields removed, including the pasted issue text), events.jsonl (the complete run event log, including
        every model turn and every command run), reproduction/ and README.txt for exactly this candidate digest and
        verification record.
      </p>
      {canExport ? (
        <div className="btn-row">
          <button type="button" className="btn btn-primary" onClick={() => void request()} disabled={busy}>
            {busy ? "Requesting grant…" : grant ? "Request a new grant" : "Request download"}
          </button>
        </div>
      ) : (
        <p className="muted">Sign in as operator or judge to request an export grant.</p>
      )}
      {error ? <ErrorBox message={error} /> : null}
      {grant && href ? (
        <div className="export-grant">
          <a className="btn btn-primary" href={href} download>
            Download bundle (zip)
          </a>
          <KeyValue
            rows={[
              { key: "grant", value: <Mono>{grant.grantId}</Mono> },
              { key: "expires", value: formatDateTime(grant.expiresAt) },
              { key: "route", value: <Mono>{href}</Mono> },
            ]}
          />
        </div>
      ) : null}
    </Section>
  );
}
