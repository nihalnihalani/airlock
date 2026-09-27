/**
 * Typed client for the control API. Every response is validated against the shared contracts
 * before it reaches a component; every failure becomes an `ApiError` with a human-readable message
 * so the UI can show it verbatim (as text, never as HTML).
 */
import { z } from "zod";
import {
  BlastRadiusCard,
  HostCheck,
  PreviewResult,
  ProfileManifest,
  RepairAvailability,
  Role,
  sha256Hex,
  Task,
  TaskView,
} from "@airlock/contracts";
import { refusalLead, refusalOf } from "./evidence";
import type { CaseInput, PreviewResult as PreviewResultType } from "./types";

const MAX_ERROR_TEXT = 600;

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export const SessionInfo = z.object({ role: Role });
export type SessionInfo = z.infer<typeof SessionInfo>;

export const ExportResponse = z.object({
  grantId: z.string().min(1).max(128),
  url: z.string().min(1).max(2048),
  expiresAt: z.string(),
  /** sha256 of the sealed zip the grant serves (also sent as `x-airlock-zip-sha256`). */
  zipDigest: sha256Hex.optional(),
});
export type ExportResponse = z.infer<typeof ExportResponse>;

/** `GET /api/diagnostics` (operator/judge): scripted-driver scripts a task may name. */
export const DiagnosticScript = z.object({
  name: z.string().min(1).max(64),
  title: z.string().max(200),
  description: z.string().max(2000),
});
export type DiagnosticScript = z.infer<typeof DiagnosticScript>;
const DiagnosticsResponse = z.object({ scripts: z.array(DiagnosticScript).max(100) });

type Method = "GET" | "POST" | "DELETE";

interface RequestInit_ {
  method?: Method;
  body?: unknown;
  signal?: AbortSignal | undefined;
}

function statusFallback(status: number): string {
  switch (status) {
    case 400:
      return "The API rejected the request as invalid.";
    case 401:
      return "Not signed in, or this action needs a higher role.";
    case 403:
      return "Forbidden for the current role.";
    case 404:
      return "Not found.";
    case 409:
      return "Conflict: the request does not match the current state.";
    case 429:
      return "Execution host at capacity or rate limited; try again shortly.";
    case 503:
      return "Service unavailable (supervisor or Docker unreachable).";
    default:
      return `Request failed with HTTP ${status}.`;
  }
}

/** Pull a message out of an error body without trusting its shape. Always bounded. */
export function extractErrorMessage(status: number, rawText: string): string {
  const text = rawText.length > MAX_ERROR_TEXT ? `${rawText.slice(0, MAX_ERROR_TEXT)}…` : rawText;
  if (text.trim().length === 0) return statusFallback(status);
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      for (const key of ["error", "message", "reason", "detail"]) {
        const value = obj[key];
        if (typeof value === "string" && value.trim().length > 0) {
          return value.length > MAX_ERROR_TEXT ? `${value.slice(0, MAX_ERROR_TEXT)}…` : value;
        }
        if (value && typeof value === "object") {
          const inner = (value as Record<string, unknown>)["message"];
          if (typeof inner === "string" && inner.trim().length > 0) return inner.slice(0, MAX_ERROR_TEXT);
        }
      }
      // zod-style issue lists
      const issues = obj["issues"];
      if (Array.isArray(issues) && issues.length > 0) {
        const first = issues[0] as Record<string, unknown> | undefined;
        const msg = first ? first["message"] : undefined;
        if (typeof msg === "string") return `Invalid request: ${msg.slice(0, MAX_ERROR_TEXT)}`;
      }
    }
  } catch {
    // not JSON: fall through to plain text
  }
  return `${statusFallback(status)} ${text}`.trim();
}

export async function request<T>(schema: z.ZodType<T>, path: string, init: RequestInit_ = {}): Promise<T> {
  const method = init.method ?? "GET";
  const headers: Record<string, string> = { Accept: "application/json" };
  let body: string | undefined;
  if (init.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(init.body);
  }

  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers,
      credentials: "same-origin",
      cache: "no-store",
      ...(body !== undefined ? { body } : {}),
      ...(init.signal ? { signal: init.signal } : {}),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    const reason = err instanceof Error ? err.message : String(err);
    throw new ApiError(0, `Could not reach the control API (${reason}).`);
  }

  if (!res.ok) {
    let text = "";
    try {
      text = await res.text();
    } catch {
      text = "";
    }
    throw new ApiError(res.status, extractErrorMessage(res.status, text));
  }

  let payload: unknown;
  try {
    const text = await res.text();
    payload = text.length === 0 ? null : JSON.parse(text);
  } catch {
    throw new ApiError(res.status, "The API returned a response that is not valid JSON.");
  }
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first ? ` (${first.path.join(".") || "root"}: ${first.message})` : "";
    throw new ApiError(res.status, `The API returned an unexpected response shape${where}.`);
  }
  return parsed.data;
}

// --- Session ---------------------------------------------------------------------------------

export function getSession(signal?: AbortSignal): Promise<SessionInfo> {
  return request(SessionInfo, "/api/session", { signal });
}

export function login(password: string): Promise<SessionInfo> {
  return request(SessionInfo, "/api/session", { method: "POST", body: { password } });
}

export function logout(): Promise<unknown> {
  return request(z.unknown(), "/api/session", { method: "DELETE" });
}

// --- Profiles / host ---------------------------------------------------------------------------

export function getProfiles(signal?: AbortSignal): Promise<ProfileManifest[]> {
  return request(z.array(ProfileManifest), "/api/profiles", { signal });
}

export function getHost(signal?: AbortSignal): Promise<HostCheck> {
  return request(HostCheck, "/api/host", { signal });
}

/** Public. Whether live repair is currently backed by a live-gate receipt, and the instance ids. */
export function getRepairAvailability(signal?: AbortSignal): Promise<RepairAvailability> {
  return request(RepairAvailability, "/api/repair-availability", { signal });
}

export async function getDiagnostics(signal?: AbortSignal): Promise<DiagnosticScript[]> {
  return (await request(DiagnosticsResponse, "/api/diagnostics", { signal })).scripts;
}

// --- Tasks ------------------------------------------------------------------------------------

export function createTask(profileId: string, issueText: string, scriptedDriver?: string): Promise<Task> {
  return request(Task, "/api/tasks", { method: "POST", body: { profileId, issueText, ...(scriptedDriver ? { scriptedDriver } : {}) } });
}

export function listTasks(signal?: AbortSignal): Promise<Task[]> {
  return request(z.array(Task), "/api/tasks", { signal });
}

export function getTask(id: string, signal?: AbortSignal): Promise<TaskView> {
  return request(TaskView, `/api/tasks/${encodeURIComponent(id)}`, { signal });
}

export function cancelTask(id: string): Promise<Task> {
  return request(Task, `/api/tasks/${encodeURIComponent(id)}/cancel`, { method: "POST", body: {} });
}

export function previewTask(id: string, candidateDigest: string, input: CaseInput): Promise<PreviewResultType> {
  return request(PreviewResult, `/api/tasks/${encodeURIComponent(id)}/preview`, {
    method: "POST",
    body: { candidateDigest, input },
  });
}

export function createExport(id: string): Promise<ExportResponse> {
  return request(ExportResponse, `/api/tasks/${encodeURIComponent(id)}/export`, { method: "POST", body: {} });
}

export function exportUrl(grantId: string): string {
  return `/api/exports/${encodeURIComponent(grantId)}`;
}

// --- Hostile ----------------------------------------------------------------------------------

export function runHostile(command: string): Promise<BlastRadiusCard> {
  return request(BlastRadiusCard, "/api/hostile", { method: "POST", body: { command } });
}

export function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    // Capacity and role refusals get a plain lead; the server's own words stay verbatim after it.
    const kind = refusalOf(err.status);
    const lead = kind === "capacity" || kind === "forbidden" ? refusalLead(err.status, err.message) : null;
    return lead && !err.message.startsWith(statusFallback(err.status)) ? `${lead} ${err.message}` : err.message;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}
