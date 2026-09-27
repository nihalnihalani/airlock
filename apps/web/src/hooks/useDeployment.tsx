/**
 * What the deployment says about itself: `GET /api/repair-availability` (public: live repair gate
 * and the Vultr instance ids) and `GET /api/host` (needs a session: checkpoint 1 plus the host's
 * uname and instance id). Fetched once per session change; a 401 on the host check is "sign in to
 * see host checks", not an error, and a missing endpoint (older control plane) is reported as such.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { HostCheck, RepairAvailability } from "@airlock/contracts";
import { ApiError, describeError, getHost, getRepairAvailability } from "../lib/api";
import { useSession } from "./session";

export type HostState =
  | { state: "loading" }
  | { state: "signed-out" }
  | { state: "ok"; host: HostCheck }
  | { state: "error"; error: string };

export interface Deployment {
  availability: RepairAvailability | null;
  availabilityError: string | null;
  host: HostState;
  refresh: () => void;
}

const DeploymentContext = createContext<Deployment | null>(null);

export function DeploymentProvider({ children }: { children: ReactNode }) {
  const session = useSession();
  const [availability, setAvailability] = useState<RepairAvailability | null>(null);
  const [availabilityError, setAvailabilityError] = useState<string | null>(null);
  const [host, setHost] = useState<HostState>({ state: "loading" });
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  const signedIn = !session.loading && session.role !== "viewer";

  useEffect(() => {
    if (session.loading) return;
    const controller = new AbortController();
    getRepairAvailability(controller.signal)
      .then((a) => {
        setAvailability(a);
        setAvailabilityError(null);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setAvailability(null);
        setAvailabilityError(err instanceof ApiError && err.status === 404 ? "this control plane does not report repair availability" : describeError(err));
      });
    return () => controller.abort();
    // Refetch on sign-in: instance ids and the model name are only returned to a session.
  }, [tick, session.loading, signedIn, session.role]);

  useEffect(() => {
    if (session.loading) return;
    if (!signedIn) {
      setHost({ state: "signed-out" });
      return;
    }
    const controller = new AbortController();
    setHost({ state: "loading" });
    getHost(controller.signal)
      .then((h) => setHost({ state: "ok", host: h }))
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setHost(err instanceof ApiError && err.status === 401 ? { state: "signed-out" } : { state: "error", error: describeError(err) });
      });
    return () => controller.abort();
  }, [session.loading, signedIn, session.role, tick]);

  const value = useMemo<Deployment>(() => ({ availability, availabilityError, host, refresh }), [availability, availabilityError, host, refresh]);
  return <DeploymentContext.Provider value={value}>{children}</DeploymentContext.Provider>;
}

export function useDeployment(): Deployment {
  const ctx = useContext(DeploymentContext);
  if (!ctx) throw new Error("useDeployment must be used inside DeploymentProvider");
  return ctx;
}
