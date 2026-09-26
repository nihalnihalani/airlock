import { useState } from "react";
import type { BlastRadiusCard } from "@airlock/contracts";
import { canOperate, useSession } from "../hooks/session";
import { describeError, runHostile } from "../lib/api";
import { hrefFor } from "../lib/router";
import { BlastRadiusView } from "../components/BlastRadius";
import { ErrorBox, Mono, Notice, Section } from "../components/ui";

const COMMAND_MAX = 4096;

const QUICK: { label: string; command: string }[] = [
  { label: "rm -rf / --no-preserve-root", command: "rm -rf / --no-preserve-root; echo exit=$?; ls / | head" },
  { label: "fork bomb", command: ":(){ :|:& };:" },
  {
    label: "curl metadata",
    command:
      "curl -sS -m 3 http://169.254.169.254/v1.json || python3 -c \"import urllib.request; print(urllib.request.urlopen('http://169.254.169.254/v1.json', timeout=3).read()[:200])\"",
  },
  {
    label: "curl example.com",
    command:
      "curl -sS -m 3 https://example.com || python3 -c \"import urllib.request; print(urllib.request.urlopen('https://example.com', timeout=3).read()[:200])\"",
  },
];

export function HostilePage() {
  const session = useSession();
  const [command, setCommand] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cards, setCards] = useState<{ command: string; card: BlastRadiusCard }[]>([]);

  const allowed = canOperate(session.role);
  const trimmed = command.trim();

  const run = async () => {
    if (trimmed.length === 0) {
      setError("Enter a command.");
      return;
    }
    if (command.length > COMMAND_MAX) {
      setError(`Commands are limited to ${COMMAND_MAX} characters.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const card = await runHostile(command);
      setCards((prev) => [{ command, card }, ...prev].slice(0, 10));
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <Section title="Hostile input">
        <p className="muted">
          Runs one command in a disposable author-profile sandbox with the author caps, then destroys it. The command
          is passed as data to the sandbox shell; nothing runs on the control host. The card reports what died and what
          survived.
        </p>
        {!allowed ? (
          <Notice tone="warn">
            This panel is for judges and operators. <a href={hrefFor({ name: "login" })}>Sign in</a> to use it.
          </Notice>
        ) : null}
        <div className="btn-row">
          {QUICK.map((q) => (
            <button type="button" className="btn btn-small" key={q.label} onClick={() => setCommand(q.command)} disabled={busy}>
              {q.label}
            </button>
          ))}
        </div>
        <textarea
          value={command}
          rows={4}
          maxLength={COMMAND_MAX}
          spellCheck={false}
          aria-label="Hostile command"
          placeholder="bash command to run inside the sandbox"
          onChange={(e) => setCommand(e.target.value)}
          disabled={busy}
        />
        <div className="btn-row">
          <button type="button" className="btn btn-danger" onClick={() => void run()} disabled={busy || !allowed || trimmed.length === 0}>
            {busy ? "Running in sandbox…" : "Run hostile command"}
          </button>
          <span className="muted">
            {command.length}/{COMMAND_MAX}
          </span>
        </div>
        {error ? <ErrorBox message={error} /> : null}
      </Section>

      {cards.map((entry, i) => (
        <Section
          key={`${entry.card.operationId}-${i}`}
          title="Blast radius"
          aside={
            <Mono wrap title={entry.command}>
              {entry.command.length > 80 ? `${entry.command.slice(0, 80)}…` : entry.command}
            </Mono>
          }
        >
          <BlastRadiusView card={entry.card} />
        </Section>
      ))}
    </div>
  );
}
