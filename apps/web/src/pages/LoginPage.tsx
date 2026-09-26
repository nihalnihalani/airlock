import { useState, type FormEvent } from "react";
import { useSession } from "../hooks/session";
import { describeError } from "../lib/api";
import { navigate } from "../lib/router";
import { Badge, ErrorBox, Section } from "../components/ui";

const MAX_PASSWORD = 512;

export function LoginPage() {
  const session = useSession();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password.length === 0) {
      setError("Enter a password.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await session.login(password);
      setPassword("");
      navigate({ name: "new" });
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page page-narrow">
      <Section title="Sign in" aside={<Badge tone="neutral">current role: {session.role}</Badge>}>
        <p className="muted">
          The operator and judge passwords come from the control app environment. Without signing in you can read
          every task as a viewer.
        </p>
        <form onSubmit={(e) => void submit(e)} className="form">
          <label className="label" htmlFor="password">
            Password
          </label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            value={password}
            maxLength={MAX_PASSWORD}
            onChange={(e) => setPassword(e.target.value)}
            disabled={busy}
          />
          <div className="btn-row">
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? "Signing in…" : "Sign in"}
            </button>
            {session.role !== "viewer" ? (
              <button type="button" className="btn" onClick={() => void session.logout()} disabled={busy}>
                Sign out
              </button>
            ) : null}
          </div>
        </form>
        {error ? <ErrorBox message={error} /> : null}
      </Section>
    </div>
  );
}
