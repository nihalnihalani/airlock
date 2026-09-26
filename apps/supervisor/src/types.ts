/** Inferred request/response types for schemas the contracts export only as zod values. */
import type { z } from "zod";
import type {
  AuthorToolRequest,
  CreateAttemptRequest,
  DestroyRequest,
  DestroyResult,
  FreezeRequest,
  HostileRunRequest,
  InvokeRequest,
  RevokeRequest,
} from "@airlock/contracts";

export type CreateAttemptRequest = z.infer<typeof CreateAttemptRequest>;
export type AuthorToolRequest = z.infer<typeof AuthorToolRequest>;
export type FreezeRequest = z.infer<typeof FreezeRequest>;
export type RevokeRequest = z.infer<typeof RevokeRequest>;
export type DestroyRequest = z.infer<typeof DestroyRequest>;
export type DestroyResult = z.infer<typeof DestroyResult>;
export type InvokeRequest = z.infer<typeof InvokeRequest>;
export type HostileRunRequest = z.infer<typeof HostileRunRequest>;
