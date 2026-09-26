import type { Expectation, Observation, VerificationRecord } from "@airlock/contracts";
import { formatDateTime } from "../lib/format";
import { Badge, Chip, Digest, KeyValue, Mono, Section } from "./ui";

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
    <div className="record-summary">
      <div className="list-head">
        <strong>{label}</strong>
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
          {record.completedCases}/{record.requiredCases} cases completed
        </Chip>
        <Chip>exec {record.exec.status}</Chip>
        {record.exec.truncated ? <Badge tone="warn">output truncated</Badge> : null}
      </div>
      <KeyValue
        rows={[
          { key: "record id", value: <Mono>{record.id}</Mono> },
          { key: "candidate digest", value: <Digest value={record.candidateDigest} /> },
          { key: "contract digest", value: <Digest value={record.contractDigest} /> },
          { key: "adapter digest", value: <Digest value={record.adapterDigest} /> },
          { key: "runtime image", value: <Mono wrap>{record.runtimeImageDigest}</Mono> },
          { key: "comparator", value: record.comparatorVersion },
          { key: "created", value: formatDateTime(record.createdAt) },
        ]}
      />
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
  return (
    <Section title="Baseline vs candidate">
      {!baseline && !verification ? (
        <p className="muted">No verification records yet. Records appear after the baseline run and after freeze + verify.</p>
      ) : (
        <>
          <div className="record-summaries">
            {baseline ? <RecordSummary label="Baseline (pristine tree)" record={baseline} /> : null}
            {verification ? <RecordSummary label="Candidate (sealed bundle)" record={verification} /> : null}
          </div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Case</th>
                  <th>Baseline expected</th>
                  <th>Baseline observed</th>
                  <th>Candidate expected</th>
                  <th>Candidate observed</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.caseId}>
                    <td>
                      <div>{row.title}</div>
                      <div className="muted mono-small">
                        {row.caseId} · {row.kind}
                      </div>
                    </td>
                    <td>{row.baseline ? describeExpectation(row.baseline.expected) : <span className="muted">—</span>}</td>
                    <td>
                      {row.baseline ? (
                        <>
                          <Badge tone={row.baseline.passed ? "ok" : "bad"}>{row.baseline.passed ? "pass" : "fail"}</Badge>{" "}
                          {describeObservation(row.baseline.observed)}
                          <div className="muted">{row.baseline.reason}</div>
                        </>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td>{row.candidate ? describeExpectation(row.candidate.expected) : <span className="muted">—</span>}</td>
                    <td>
                      {row.candidate ? (
                        <>
                          <Badge tone={row.candidate.passed ? "ok" : "bad"}>{row.candidate.passed ? "pass" : "fail"}</Badge>{" "}
                          {describeObservation(row.candidate.observed)}
                          <div className="muted">{row.candidate.reason}</div>
                        </>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Section>
  );
}
