import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Role } from "@airlock/contracts";
import { ApiError, describeError, getSession, login as apiLogin, logout as apiLogout } from "../lib/api";
import { rememberOwnerId } from "../lib/control";

export interface SessionState {
  role: Role;
  /** True until the first GET /api/session has answered. */
  loading: boolean;
  /** Last error from refreshing the session (shown, not fatal: viewer mode still works). */
  error: string | null;
  refresh: () => Promise<void>;
  login: (password: string) => Promise<Role>;
  logout: () => Promise<void>;
}

const SessionContext = createContext<SessionState | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [role, setRole] = useState<Role>("viewer");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const info = await getSession();
      setRole(info.role);
      setError(null);
    } catch (err) {
      // 401 simply means "no session": that is the viewer role, not a failure.
      if (err instanceof ApiError && (err.status === 401 || err.status === 404)) {
        setRole("viewer");
        setError(null);
      } else {
        setRole("viewer");
        setError(describeError(err));
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const login = useCallback(async (password: string) => {
    const info = await apiLogin(password);
    // A new login is a new principal: forget the owner id learned from the previous one.
    rememberOwnerId(undefined);
    setRole(info.role);
    setError(null);
    return info.role;
  }, []);

  const logout = useCallback(async () => {
    try {
      await apiLogout();
    } finally {
      rememberOwnerId(undefined);
      setRole("viewer");
    }
  }, []);

  const value = useMemo<SessionState>(
    () => ({ role, loading, error, refresh, login, logout }),
    [role, loading, error, refresh, login, logout],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionState {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used inside SessionProvider");
  return ctx;
}

export function canOperate(role: Role): boolean {
  return role === "operator" || role === "judge";
}
