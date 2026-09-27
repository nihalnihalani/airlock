import type { IsolationProbe, RuntimeInspection, TeardownRecord } from "@airlock/contracts";
import type { ReactNode } from "react";
import type { Checkpoints } from "../lib/eventViews";
import { formatDateTime } from "../lib/format";
import { Badge, BoolChip, Chip, KeyValue, Mono, type Tone } from "./common";

const PROBE_KEYS: { key: keyof Omit<IsolationProbe, "probedAt" | "allBlocked">; label: string }[] = [
  { key: "metadataEndpoint", label: "metadata 169.254.169.254" },
  { key: "dns", label: "DNS" },
  { key: "outboundTcp", label: "outbound TCP" },
  { key: "dockerSocket", label: "Docker socket" },
  { key: "hostMounts", label: "host mounts" },
];

function probeTone(result: IsolationProbe[keyof IsolationProbe]): Tone {
  return result === "BLOCKED" ? "ok" : result === "REACHED" ? "bad" : "warn";
}

const CHECK_LABELS: { key: keyof RuntimeInspection["checks"]; label: string }[] = [
  { key: "networkNone", label: "network none" },
  { key: "nonRootUser", label: "non-root" },
  { key: "readOnlyRootfs", label: "read-only rootfs" },
  { key: "capDropAll", label: "cap drop all" },
  { key: "noNewPrivileges", label: "no-new-privileges" },
  { key: "pidsLimited", label: "pids limited" },
  { key: "memoryLimited", label: "memory limited" },
  { key: "cpuLimited", label: "cpu limited" },
  { key: "noHostBinds", label: "no host binds" },
  { key: "noPorts", label: "no ports" },
  { key: "privateIpc", label: "private ipc" },
  { key: "restartDisabled", label: "restart disabled" },
  { key: "ownedLabels", label: "owned labels" },
];

function Checkpoint({ n, title, status, children }: { n: number; title: string; status?: ReactNode; children: ReactNode }) {
  return (
    <li className="rounded-lg border border-border bg-card p-3 dark:border-transparent">
      <div className="mb-2 flex items-center gap-2">
        <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-medium tabular-nums text-muted-foreground">{n}</span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{title}</span>
        {status}
      </div>
      <div className="flex flex-col gap-2 text-sm">{children}</div>
    </li>
  );
}

function Pending({ children }: { children: ReactNode }) {
  return <p className="text-xs text-muted-foreground">{children}</p>;
}

function EntryHead({ label, children }: { label: string; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-xs font-medium text-foreground/80">{label}</span>
      {children}
    </div>
  );
}

function InspectionView({ label, inspection }: { label: string; inspection: RuntimeInspection }) {
  return (
    <div className="flex flex-col gap-1.5">
      <EntryHead label={label}>
        <Chip tone={inspection.runtime === "runc" ? "bad" : "ok"}>{inspection.runtime}</Chip>
        {inspection.devUnsafe ? <Badge tone="bad">dev-unsafe</Badge> : null}
        <Badge tone={inspection.allPassed ? "ok" : "bad"}>{inspection.allPassed ? "all checks passed" : "checks FAILED"}</Badge>
      </EntryHead>
      <KeyValue
        className="text-xs"
        rows={[
          { key: "hostname", value: <Mono>{inspection.guestHostname || "(empty)"}</Mono> },
          { key: "uname", value: <Mono wrap>{inspection.guestUname || "(empty)"}</Mono> },
          { key: "container", value: <Mono wrap>{inspection.container}</Mono> },
          { key: "image digest", value: <Mono wrap>{inspection.imageDigest}</Mono> },
          { key: "inspected", value: formatDateTime(inspection.inspectedAt) },
        ]}
      />
      <details className="tool-line text-xs" open={!inspection.allPassed}>
        <summary className="flex cursor-pointer list-none items-center gap-1.5 text-muted-foreground [&::-webkit-details-marker]:hidden">
          <span aria-hidden className="tool-line-chevron transition-transform">
            ▸
          </span>
          {CHECK_LABELS.filter(({ key }) => inspection.checks[key]).length}/{CHECK_LABELS.length} container checks
        </summary>
        <div className="mt-1.5 flex flex-wrap gap-1">
          {CHECK_LABELS.map(({ key, label: l }) => (
            <Badge tone={inspection.checks[key] ? "ok" : "bad"} key={key}>
              {l}
            </Badge>
          ))}
        </div>
      </details>
    </div>
  );
}

function TeardownView({ label, teardown }: { label: string; teardown: TeardownRecord }) {
  const remaining = teardown.containersRemaining.length + teardown.volumesRemaining.length;
  const clean = teardown.clean && remaining === 0;
  return (
    <div className="flex flex-col gap-1">
      <EntryHead label={label}>
        <Badge tone={clean ? "ok" : "bad"}>{clean ? "(no sandboxes)" : "teardown incomplete"}</Badge>
        <span className="text-[11px] text-muted-foreground">{formatDateTime(teardown.destroyedAt)}</span>
      </EntryHead>
      {remaining > 0 ? (
        <ul className="flex flex-col gap-0.5 text-xs">
          {teardown.containersRemaining.map((c) => (
            <li key={`c-${c}`}>
              container <Mono>{c}</Mono>
            </li>
          ))}
          {teardown.volumesRemaining.map((v) => (
            <li key={`v-${v}`}>
              volume <Mono>{v}</Mono>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function CheckpointsPanel({ cp }: { cp: Checkpoints }) {
  const probesBlocked = cp.probes.length > 0 && cp.probes.every((p) => p.probe.allBlocked);
  const teardownsClean = cp.teardowns.length > 0 && cp.teardowns.every((t) => t.teardown.clean && t.teardown.containersRemaining.length + t.teardown.volumesRemaining.length === 0);
  return (
    <ol className="flex flex-col gap-2">
      <Checkpoint n={1} title="Host check" status={cp.host ? <Chip tone={cp.host.selectedRuntime === "runc" ? "bad" : "ok"}>{cp.host.selectedRuntime}</Chip> : null}>
        {cp.host ? (
          <KeyValue
            className="text-xs"
            rows={[
              { key: "docker", value: cp.host.dockerVersion },
              { key: "CPU virtualization", value: <BoolChip value={cp.host.cpuVirtualization} /> },
              { key: "/dev/kvm", value: <BoolChip value={cp.host.kvmPresent} yes="present" no="absent" /> },
              { key: "kvm read/write", value: <BoolChip value={cp.host.kvmReadWrite} /> },
              {
                key: "runtimes",
                value: (
                  <span className="flex flex-wrap gap-1">
                    {cp.host.availableRuntimes.map((r) => (
                      <Chip key={r}>{r}</Chip>
                    ))}
                    {cp.host.availableRuntimes.length === 0 ? <span className="text-muted-foreground">none reported</span> : null}
                  </span>
                ),
              },
              { key: "dev-unsafe", value: <BoolChip value={cp.host.devUnsafe} invert /> },
              { key: "checked", value: `${formatDateTime(cp.host.checkedAt)} (${cp.hostSource})` },
            ]}
          />
        ) : (
          <Pending>Not recorded yet.</Pending>
        )}
      </Checkpoint>

      <Checkpoint n={2} title="Execution log" status={<Chip>{cp.execCount} runs</Chip>}>
        <p className="text-xs text-muted-foreground">
          {cp.execCount} executions with exit codes recorded, {cp.execFailures} not succeeded. Each is a tool card in the thread,
          with its command, exit code, duration and bounded output.
        </p>
      </Checkpoint>

      <Checkpoint n={3} title="In-sandbox uname / hostname" status={cp.inspections.length > 0 ? <Chip>{cp.inspections.length}</Chip> : null}>
        {cp.inspections.length === 0 ? (
          <Pending>No inspection recorded yet.</Pending>
        ) : (
          cp.inspections.map((i, idx) => <InspectionView key={`${i.inspection.container}-${idx}`} {...i} />)
        )}
      </Checkpoint>

      <Checkpoint
        n={4}
        title="Isolation probe"
        status={cp.probes.length > 0 ? <Badge tone={probesBlocked ? "ok" : "bad"}>{probesBlocked ? "all BLOCKED" : "NOT fully blocked"}</Badge> : null}
      >
        {cp.probes.length === 0 ? (
          <Pending>No probe recorded yet. An author sandbox is refused unless every probe is BLOCKED.</Pending>
        ) : (
          cp.probes.map((p, idx) => (
            <div className="flex flex-col gap-1" key={`${p.probe.probedAt}-${idx}`}>
              <EntryHead label={p.label}>
                <span className="text-[11px] text-muted-foreground">{formatDateTime(p.probe.probedAt)}</span>
              </EntryHead>
              <div className="flex flex-wrap gap-1">
                {PROBE_KEYS.map(({ key, label }) => (
                  <Badge tone={probeTone(p.probe[key])} key={key}>
                    {label}: {p.probe[key]}
                  </Badge>
                ))}
              </div>
            </div>
          ))
        )}
      </Checkpoint>

      <Checkpoint
        n={5}
        title="Teardown"
        status={cp.teardowns.length > 0 ? <Badge tone={teardownsClean ? "ok" : "bad"}>{teardownsClean ? "(no sandboxes)" : "incomplete"}</Badge> : null}
      >
        {cp.teardowns.length === 0 ? (
          <Pending>No teardown recorded yet.</Pending>
        ) : (
          cp.teardowns.map((t, idx) => <TeardownView key={`${t.teardown.destroyedAt}-${idx}`} {...t} />)
        )}
      </Checkpoint>
    </ol>
  );
}
