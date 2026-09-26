/**
 * Lifecycle errors with the HTTP status the API maps them to.
 *
 * Shape adapted from OpenBot `supervisor/src/docker.ts` (NameHeldError / DockerUnavailableError):
 * distinct classes because the operator's next action differs per failure.
 */
export type SupervisorErrorCode =
  | "invalid_body"
  | "unauthorized"
  | "not_found"
  | "fenced"
  | "stale_generation"
  | "revoked"
  | "operation_conflict"
  | "operation_in_progress"
  | "inspection_failed"
  | "probe_failed"
  | "bundle_mismatch"
  | "name_held"
  | "docker_unavailable"
  | "unsupported_profile"
  | "internal";

const STATUS: Record<SupervisorErrorCode, number> = {
  invalid_body: 400,
  unauthorized: 401,
  not_found: 404,
  fenced: 409,
  stale_generation: 409,
  revoked: 409,
  operation_conflict: 409,
  operation_in_progress: 409,
  inspection_failed: 409,
  probe_failed: 409,
  bundle_mismatch: 409,
  name_held: 409,
  docker_unavailable: 503,
  unsupported_profile: 400,
  internal: 500,
};

export class SupervisorError extends Error {
  readonly code: SupervisorErrorCode;
  readonly status: number;
  constructor(code: SupervisorErrorCode, message: string) {
    super(message);
    this.name = "SupervisorError";
    this.code = code;
    this.status = STATUS[code];
  }
}

export function dockerUnavailable(cause: unknown): SupervisorError {
  return new SupervisorError(
    "docker_unavailable",
    `The supervisor could not complete a Docker operation (${describe(cause)}).`,
  );
}

export function describe(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 512);
  return String(error).slice(0, 512);
}

export function statusOf(error: unknown): number | undefined {
  const code = (error as { statusCode?: unknown }).statusCode;
  return typeof code === "number" ? code : undefined;
}
