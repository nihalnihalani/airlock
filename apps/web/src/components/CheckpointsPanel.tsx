import type { IsolationProbe, RuntimeInspection, TeardownRecord } from "@airlock/contracts";
import type { Checkpoints } from "../lib/eventViews";
import { formatDateTime } from "../lib/format";
import { Badge, BoolChip, Chip, KeyValue, Mono, Section, type Tone } from "./ui";

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

function ProbeChips({ probe }: { probe: IsolationProbe }) {
  return (
    <span className="chips">
      {PROBE_KEYS.map(({ key, label }) => (
        <Chip tone={probeTone(probe[key])} key={key}>
          {label}: {probe[key]}
        </Chip>
      ))}
      <Badge tone={probe.allBlocked ? "ok" : "bad"}>{probe.allBlocked ? "all blocked" : "NOT fully blocked"}</Badge>
    </span>
  );
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

function InspectionView({ label, inspection }: { label: string; inspection: RuntimeInspection }) {
  return (
    <div className="checkpoint-entry">
      <div className="list-head">
        <strong>{label}</strong>
        <Chip>{inspection.runtime}</Chip>
        {inspection.devUnsafe ? <Badge tone="bad">dev-unsafe</Badge> : null}
        <Badge tone={inspection.allPassed ? "ok" : "bad"}>{inspection.allPassed ? "all checks passed" : "checks FAILED"}</Badge>
      </div>
      <KeyValue
        rows={[
          { key: "container", value: <Mono>{inspection.container}</Mono> },
          { key: "hostname", value: <Mono>{inspection.guestHostname || "(empty)"}</Mono> },
          { key: "uname", value: <Mono wrap>{inspection.guestUname || "(empty)"}</Mono> },
          { key: "image digest", value: <Mono wrap>{inspection.imageDigest}</Mono> },
          { key: "inspected at", value: formatDateTime(inspection.inspectedAt) },
        ]}
      />
      <span className="chips">
        {CHECK_LABELS.map(({ key, label: l }) => (
          <Chip tone={inspection.checks[key] ? "ok" : "bad"} key={key}>
            {l}
          </Chip>
        ))}
      </span>
    </div>
  );
}

function TeardownView({ label, teardown }: { label: string; teardown: TeardownRecord }) {
  const remaining = teardown.containersRemaining.length + teardown.volumesRemaining.length;
  return (
    <div className="checkpoint-entry">
      <div className="list-head">
        <strong>{label}</strong>
        <Badge tone={teardown.clean && remaining === 0 ? "ok" : "bad"}>
          {teardown.clean && remaining === 0 ? "(no sandboxes)" : "teardown incomplete"}
        </Badge>
        <span className="muted">{formatDateTime(teardown.destroyedAt)}</span>
      </div>
      {remaining > 0 ? (
        <ul className="plain-list">
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
  return (
    <Section title="Five checkpoints">
      <div className="checkpoints">
        <div className="checkpoint">
          <h3>1 · Host check</h3>
          {cp.host ? (
            <>
              <KeyValue
                rows={[
                  { key: "docker", value: cp.host.dockerVersion },
                  { key: "cpu virtualization", value: <BoolChip value={cp.host.cpuVirtualization} /> },
                  { key: "/dev/kvm", value: <BoolChip value={cp.host.kvmPresent} yes="present" no="absent" /> },
                  { key: "kvm rw", value: <BoolChip value={cp.host.kvmReadWrite} /> },
                  {
                    key: "runtimes",
                    value: (
                      <span className="chips">
                        {cp.host.availableRuntimes.map((r) => (
                          <Chip key={r}>{r}</Chip>
                        ))}
                        {cp.host.availableRuntimes.length === 0 ? <span className="muted">none reported</span> : null}
                      </span>
                    ),
                  },
                  { key: "selected", value: <Chip tone={cp.host.selectedRuntime === "runc" ? "bad" : "ok"}>{cp.host.selectedRuntime}</Chip> },
                  { key: "dev-unsafe", value: <BoolChip value={cp.host.devUnsafe} invert /> },
                  { key: "checked", value: `${formatDateTime(cp.host.checkedAt)} (${cp.hostSource})` },
                ]}
              />
            </>
          ) : (
            <p className="muted">Not recorded yet.</p>
          )}
        </div>

        <div className="checkpoint">
          <h3>2 · Execution log</h3>
          <p>
            {cp.execCount} executions with exit codes recorded, {cp.execFailures} not succeeded. See the tool / exec
            log for each command.
          </p>
        </div>

        <div className="checkpoint">
          <h3>3 · In-sandbox uname / hostname</h3>
          {cp.inspections.length === 0 ? (
            <p className="muted">No inspection recorded yet.</p>
          ) : (
            cp.inspections.map((i, idx) => <InspectionView key={`${i.inspection.container}-${idx}`} {...i} />)
          )}
        </div>

        <div className="checkpoint">
          <h3>4 · Isolation probe</h3>
          {cp.probes.length === 0 ? (
            <p className="muted">No probe recorded yet. An author sandbox is refused unless every probe is BLOCKED.</p>
          ) : (
            cp.probes.map((p, idx) => (
              <div className="checkpoint-entry" key={`${p.probe.probedAt}-${idx}`}>
                <div className="list-head">
                  <strong>{p.label}</strong>
                  <span className="muted">{formatDateTime(p.probe.probedAt)}</span>
                </div>
                <ProbeChips probe={p.probe} />
              </div>
            ))
          )}
        </div>

        <div className="checkpoint">
          <h3>5 · Teardown</h3>
          {cp.teardowns.length === 0 ? (
            <p className="muted">No teardown recorded yet.</p>
          ) : (
            cp.teardowns.map((t, idx) => <TeardownView key={`${t.teardown.destroyedAt}-${idx}`} {...t} />)
          )}
        </div>
      </div>
    </Section>
  );
}
