import type { Expectation, Observation, VerificationRecord } from "@airlock/contracts";
import { formatDateTime } from "../lib/format";
import { Badge, Chip, Digest, KeyValue, Mono } from "./common";

function describeExpectation(e: Expectation): string {
  if (e.kind === "raises") return `raises ${e.exceptionType}${e.messageIncludes ? ` containing "${e.messageIncludes}"` : ""}`;
  return `returns ${shortValue(e.valueCanonical)}`;
}

function shortValue(canonical: string, max = 120): string {
  let text = canonical;
  try {
    const value: unknown = JSON.parse(canonical);
    text = typeof value === "string" ? JSON.stringify(value) : canonical;
  } catch {
    // keep raw
  }
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function describeObservation(o: Observation | undefined): string {
  if (!o) return "no observation";
  if (o.status === "error") return `raised ${o.exceptionType ?? "Error"}${o.message ? `: ${o.message.slice(0, 120)}` : ""}`;
  return o.valueCanonical !== undefined ? `returned ${shortValue(o.valueCanonical)}` : "ok (no value)";
}

interface JoinedRow {
  caseId: string;
  kind: string;
  title: string;
  baseline: VerificationRecord["cases"][number] | undefined;
  candidate: VerificationRecord["cases"][number] | undefined;
}

function join(baseline: VerificationRecord | undefined, candidate: VerificationRecord | undefined, titles: Map<string, string>): JoinedRow[] {
  const byId = new Map<string, JoinedRow>();
  for (const [record, side] of [
    [baseline, "baseline"],
    [candidate, "candidate"],
  ] as const) {
    if (!record) continue;
    for (const verdict of record.cases) {
      const row = byId.get(verdict.caseId) ?? {
        caseId: verdict.caseId,
        kind: verdict.kind,
        title: titles.get(verdict.caseId) ?? verdict.caseId,
        baseline: undefined,
        candidate: undefined,
      };
      if (side === "baseline") row.baseline = verdict;
      else row.candidate = verdict;
      byId.set(verdict.caseId, row);
    }
  }
  return [...byId.values()];
}

function RecordSummary({ label, record }: { label: string; record: VerificationRecord }) {
  return (
    <details className="tool-line rounded-lg border border-border bg-card dark:border-transparent">
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-1.5 px-3 py-2 [&::-webkit-details-marker]:hidden">
        <span aria-hidden className="tool-line-chevron text-xs text-muted-foreground transition-transform">
          ▸
        </span>
        <span className="text-sm font-medium">{label}</span>
        <Badge tone={record.passed ? "ok" : "bad"}>
          {record.role === "baseline"
            ? record.passed
              ? "reported failure reproduced"
              : "reported failure did NOT reproduce"
            : record.passed
              ? "all frozen cases passed"
              : "not all cases passed"}
        </Badge>
        <Chip>
          {record.completedCases}/{record.requiredCases} completed
        </Chip>
        <Chip>exec {record.exec.status}</Chip>
        {record.exec.truncated ? <Badge tone="warn">output truncated</Badge> : null}
      </summary>
      <div className="border-t border-border px-3 py-2.5 dark:border-foreground/5">
        <KeyValue
          className="text-xs"
          rows={[
            { key: "record id", value: <Mono wrap>{record.id}</Mono> },
            { key: "candidate digest", value: <Digest value={record.candidateDigest} /> },
            { key: "contract digest", value: <Digest value={record.contractDigest} /> },
            { key: "adapter digest", value: <Digest value={record.adapterDigest} /> },
            { key: "runtime image", value: <Mono wrap>{record.runtimeImageDigest}</Mono> },
            { key: "comparator", value: record.comparatorVersion },
            { key: "created", value: formatDateTime(record.createdAt) },
          ]}
        />
      </div>
    </details>
  );
}

function Side({ label, verdict }: { label: string; verdict: VerificationRecord["cases"][number] | undefined }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-md bg-muted/50 px-2.5 py-2 dark:bg-background/50">
      <div className="flex items-center gap-1.5">
        <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">{label}</span>
        {verdict ? <Badge tone={verdict.passed ? "ok" : "bad"}>{verdict.passed ? "pass" : "fail"}</Badge> : null}
      </div>
      {verdict ? (
        <>
          <span className="text-[11px] break-words text-muted-foreground">expected {describeExpectation(verdict.expected)}</span>
          <span className="text-xs break-words">{describeObservation(verdict.observed)}</span>
          {verdict.reason ? <span className="text-[11px] break-words text-muted-foreground">{verdict.reason}</span> : null}
        </>
      ) : (
        <span className="text-xs text-muted-foreground">not run</span>
      )}
    </div>
  );
}

export function CaseTable({
  baseline,
  verification,
  titles,
}: {
  baseline: VerificationRecord | undefined;
  verification: VerificationRecord | undefined;
  /** caseId → title from the profile contract when available. */
  titles: Map<string, string>;
}) {
  const rows = join(baseline, verification, titles);
  if (!baseline && !verification) {
    return <p className="text-xs text-muted-foreground">No verification records yet. Records appear after the baseline run and after freeze + verify.</p>;
  }
  return (
    <div className="flex flex-col gap-2">
      {baseline ? <RecordSummary label="Baseline (pristine tree)" record={baseline} /> : null}
      {verification ? <RecordSummary label="Candidate (sealed bundle)" record={verification} /> : null}
      <ul className="flex flex-col gap-2">
        {rows.map((row) => {
          return (
            <li key={row.caseId} className="rounded-lg border border-border bg-card p-3 dark:border-transparent">
              <div className="text-sm font-medium">{row.title}</div>
              <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                <Mono>{row.caseId}</Mono>
                <span>·</span>
                <span>{row.kind}</span>
              </div>
              <div className="mt-2 grid grid-cols-2 gap-1.5">
                <Side label="Baseline" verdict={row.baseline} />
                <Side label="Candidate" verdict={row.candidate} />
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
