/**
 * Layout adapted from OpenBot `app/src/routes/sign.tsx` (pin 3c73cf00efba46122dfd0447485e2b61f1d6a2cd).
 *
 * MIT License
 * Copyright (c) 2026 CopilotKit
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
 * associated documentation files (the "Software"), to deal in the Software without restriction,
 * including without limitation the rights to use, copy, modify, merge, publish, distribute,
 * sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions: The above copyright notice and this
 * permission notice shall be included in all copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.
 *
 * Airlock modifications: the centred column, mark, heading and full-width outline controls are
 * OpenBot's; the OAuth/SSO providers are replaced by Airlock's role password form (POST
 * /api/session) and the current-role line; entrance motion is a CSS
 * stagger instead of the motion library. No better-auth.
 */
import { IconShieldLock } from "@tabler/icons-react";
import { useState, type FormEvent } from "react";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Separator } from "../components/ui/separator";
import { useSession } from "../hooks/session";
import { describeError } from "../lib/api";
import { navigate } from "../lib/router";

const MAX_PASSWORD = 512;
const ENTER = "animate-in fade-in-0 slide-in-from-bottom-2 duration-200 fill-mode-both motion-reduce:animate-none";

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
    <div className="flex h-dvh w-full flex-col items-center justify-center bg-background">
      <div className="-mt-12 flex w-full max-w-82 flex-1 flex-col items-center justify-center p-4">
        <div className={`flex items-center justify-center ${ENTER}`}>
          <span className="flex size-14 items-center justify-center rounded-2xl bg-foreground text-background shadow-sm">
            <IconShieldLock className="size-7" />
          </span>
        </div>
        <h1 className={`mt-8 text-center text-2xl font-medium tracking-tight ${ENTER} delay-75`}>Sign in to Airlock</h1>
        <div className={`mt-8 w-full ${ENTER} delay-150`}>
          <form className="flex flex-col gap-2" onSubmit={(e) => void submit(e)}>
            <Input
              aria-label="Password"
              type="password"
              autoComplete="current-password"
              autoFocus
              placeholder="Operator or judge password"
              className="h-10"
              value={password}
              maxLength={MAX_PASSWORD}
              onChange={(e) => setPassword(e.target.value)}
              disabled={busy}
            />
            <Button className="h-10 w-full tracking-tight" size="lg" type="submit" variant="outline" disabled={busy || password.length === 0}>
              {busy ? "Signing in…" : "Continue"}
            </Button>
          </form>
          {error ? (
            <p className="mt-3 text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}
          <Separator className="my-4" />
          <p className="text-center text-xs text-pretty text-muted-foreground">
            Passwords come from the control app environment. Case data is private to a session: a judge sees the cases it started in
            that session, and the operator sees every case.
          </p>
          <p className="mt-2 text-center text-xs text-muted-foreground">
            Current role: <span className="font-medium text-foreground">{session.loading ? "…" : session.role}</span>
            {session.role !== "viewer" ? (
              <>
                {" · "}
                <button type="button" className="underline underline-offset-4 hover:text-foreground" onClick={() => void session.logout()}>
                  sign out
                </button>
              </>
            ) : null}
          </p>
        </div>
      </div>
    </div>
  );
}
