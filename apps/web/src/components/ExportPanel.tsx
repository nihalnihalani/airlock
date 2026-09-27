import { IconDownload, IconKey } from "@tabler/icons-react";
import { useState } from "react";
import { createExport, describeError, exportUrl, type ExportResponse } from "../lib/api";
import { formatDateTime } from "../lib/format";
import { hrefFor } from "../lib/router";
import { Digest, ErrorBox, KeyValue, Mono } from "./common";
import { Button } from "./ui/button";

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
    <div className="flex flex-col gap-3">
      <KeyValue
        className="text-xs"
        rows={[
          { key: "candidate digest", value: <Digest value={candidateDigest} /> },
          { key: "verification record", value: <Mono wrap>{verificationRecordId}</Mono> },
        ]}
      />
      <p className="text-xs text-muted-foreground">
        The bundle contains patch.diff, manifest.json, verification.json, baseline.json, task.json (the task record with lease
        fields removed, including the pasted issue text), events.jsonl (the complete run event log, including every model turn
        and every command run), reproduction/ and README.txt for exactly this candidate digest and verification record.
      </p>
      {canExport ? (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant={grant ? "outline" : "default"} onClick={() => void request()} disabled={busy}>
            <IconKey />
            {busy ? "Requesting grant…" : grant ? "Request a new grant" : "Request download"}
          </Button>
          {grant && href ? (
            <Button size="sm" render={<a href={href} download />}>
              <IconDownload />
              Download bundle (zip)
            </Button>
          ) : null}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          <a className="underline underline-offset-4 hover:text-foreground" href={hrefFor({ name: "login" })}>
            Sign in
          </a>{" "}
          as operator or judge to request an export grant.
        </p>
      )}
      {error ? <ErrorBox message={error} /> : null}
      {grant && href ? (
        <KeyValue
          className="text-xs"
          rows={[
            { key: "grant", value: <Mono wrap>{grant.grantId}</Mono> },
            { key: "expires", value: formatDateTime(grant.expiresAt) },
            { key: "route", value: <Mono wrap>{href}</Mono> },
          ]}
        />
      ) : null}
    </div>
  );
}
