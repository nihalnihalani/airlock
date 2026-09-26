import type { ReactNode } from "react";

export type Tone = "neutral" | "ok" | "warn" | "bad" | "info";

export function Badge({ tone = "neutral", title, children }: { tone?: Tone; title?: string | undefined; children: ReactNode }) {
  return (
    <span className={`badge badge-${tone}`} title={title}>
      {children}
    </span>
  );
}

export function Chip({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`chip chip-${tone}`}>{children}</span>;
}

export function BoolChip({ value, yes = "yes", no = "no", invert = false }: { value: boolean; yes?: string; no?: string; invert?: boolean }) {
  const good = invert ? !value : value;
  return <Chip tone={good ? "ok" : "bad"}>{value ? yes : no}</Chip>;
}

export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="error-box" role="alert">
      <span>{message}</span>
      {onRetry ? (
        <button type="button" className="btn btn-small" onClick={onRetry}>
          Retry
        </button>
      ) : null}
    </div>
  );
}

export function Notice({ tone = "info", children }: { tone?: Tone; children: ReactNode }) {
  return <div className={`notice notice-${tone}`}>{children}</div>;
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="loading" aria-live="polite">
      {label}
    </div>
  );
}

export function Section({
  title,
  aside,
  children,
  id,
}: {
  title: string;
  aside?: ReactNode;
  children: ReactNode;
  id?: string;
}) {
  return (
    <section className="card" id={id}>
      <header className="card-head">
        <h2>{title}</h2>
        {aside ? <div className="card-aside">{aside}</div> : null}
      </header>
      <div className="card-body">{children}</div>
    </section>
  );
}

export function KeyValue({ rows }: { rows: { key: string; value: ReactNode }[] }) {
  return (
    <dl className="kv">
      {rows.map((row) => (
        <div className="kv-row" key={row.key}>
          <dt>{row.key}</dt>
          <dd>{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Mono({ children, title, wrap = false }: { children: ReactNode; title?: string; wrap?: boolean }) {
  return (
    <code className={wrap ? "mono mono-wrap" : "mono"} title={title}>
      {children}
    </code>
  );
}

export function Pre({ children, className }: { children: string; className?: string }) {
  return <pre className={className ? `pre ${className}` : "pre"}>{children}</pre>;
}

export function Digest({ value, label }: { value: string; label?: string }) {
  return (
    <span className="digest" title={value}>
      {label ? <span className="digest-label">{label} </span> : null}
      <Mono>{value.slice(0, 16)}…</Mono>
    </span>
  );
}
