/**
 * Adapted from OpenBot `supervisor/src/names.ts` (pin 3c73cf00efba46122dfd0447485e2b61f1d6a2cd).
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
 * Airlock modifications: names are derived from a (taskId, attemptId, role) triple or from an
 * operation id instead of a Bot id; labels carry task/attempt/role/namespace; the namespace comes
 * from AIRLOCK_NAMESPACE; validation is shared with the contracts `plainId` rule.
 *
 * ---------------------------------------------------------------------------------------------
 * What an identifier is allowed to be, and what it becomes.
 *
 * This is a security boundary. Every id that arrives here is turned into a container name, a
 * volume name and a label filter. The supervisor only accepts plain identifiers, so callers cannot
 * name an existing container, volume, or host resource through this API. Names are derived rather
 * than accepted: a caller says which attempt; it never says which container.
 */
import { SandboxRole, plainId } from "@airlock/contracts";

const MAX_ID = 64;
const ALLOWED = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export const DEFAULT_NAMESPACE = "airlock";

/** The label every container and volume this supervisor owns carries. */
export const OWNER_LABEL = "airlock.supervisor";
export const TASK_LABEL = "airlock.task";
export const ATTEMPT_LABEL = "airlock.attempt";
export const ROLE_LABEL = "airlock.role";
export const NAMESPACE_LABEL = "airlock.namespace";
/** Marks a one-shot container (invoke/hostile/collector) with the operation that made it. */
export const OPERATION_LABEL = "airlock.operation";

export type NameResult<T> = { ok: true; value: T } | { ok: false; reason: string };

export function validateId(raw: unknown, what: string): NameResult<string> {
  if (typeof raw !== "string" || raw.length === 0) return { ok: false, reason: `${what} is required.` };
  if (raw.length > MAX_ID) return { ok: false, reason: `${what} may be at most ${MAX_ID} characters.` };
  if (!ALLOWED.test(raw)) {
    return {
      ok: false,
      reason: `${what} may contain only letters, digits, hyphen and underscore, and must start with a letter or digit.`,
    };
  }
  const parsed = plainId.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: `${what} is not a plain identifier.` };
  return { ok: true, value: raw };
}

export function resolveNamespace(configured: string | undefined): string {
  const value = configured?.trim();
  if (!value) return DEFAULT_NAMESPACE;
  const checked = validateId(value, "AIRLOCK_NAMESPACE");
  if (!checked.ok) throw new Error(checked.reason);
  return value;
}

/** Everything the supervisor is permitted to create for one attempt, and nothing it is not. */
export type AttemptNames = {
  namespace: string;
  taskId: string;
  attemptId: string;
  role: SandboxRole;
  container: string;
  volume: string;
  /** The fresh container that reads the stopped volume read-only during freeze. */
  collector: string;
};

export function attemptNames(
  namespace: string,
  taskId: unknown,
  attemptId: unknown,
  role: unknown,
): NameResult<AttemptNames> {
  const task = validateId(taskId, "taskId");
  if (!task.ok) return task;
  const attempt = validateId(attemptId, "attemptId");
  if (!attempt.ok) return attempt;
  const parsedRole = SandboxRole.safeParse(role);
  if (!parsedRole.success) return { ok: false, reason: "role is not a supported sandbox role." };
  const r = parsedRole.data;
  return {
    ok: true,
    value: {
      namespace,
      taskId: task.value,
      attemptId: attempt.value,
      role: r,
      container: `${namespace}-${r}-${task.value}-${attempt.value}`,
      volume: `${namespace}-ws-${task.value}-${attempt.value}`,
      collector: `${namespace}-collector-${task.value}-${attempt.value}`,
    },
  };
}

/** One-shot containers (invoke roles, hostile) are named by the operation, not by an attempt. */
export type OneShotNames = {
  namespace: string;
  taskId: string;
  operationId: string;
  role: SandboxRole;
  container: string;
  volume: string;
};

export function oneShotNames(
  namespace: string,
  taskId: unknown,
  operationId: unknown,
  role: unknown,
): NameResult<OneShotNames> {
  const task = validateId(taskId, "taskId");
  if (!task.ok) return task;
  const op = validateId(operationId, "operationId");
  if (!op.ok) return op;
  const parsedRole = SandboxRole.safeParse(role);
  if (!parsedRole.success) return { ok: false, reason: "role is not a supported sandbox role." };
  const r = parsedRole.data;
  return {
    ok: true,
    value: {
      namespace,
      taskId: task.value,
      operationId: op.value,
      role: r,
      container: `${namespace}-${r}-${task.value}-op-${op.value}`,
      volume: `${namespace}-ws-${task.value}-op-${op.value}`,
    },
  };
}

/** Labels for an attempt-scoped resource. */
export function attemptLabels(names: AttemptNames, role: SandboxRole | "collector" = names.role): Record<string, string> {
  return {
    [OWNER_LABEL]: "true",
    [NAMESPACE_LABEL]: names.namespace,
    [TASK_LABEL]: names.taskId,
    [ATTEMPT_LABEL]: names.attemptId,
    [ROLE_LABEL]: role,
  };
}

/** Labels for a one-shot resource. `attempt` carries the operation id so listing is uniform. */
export function oneShotLabels(names: OneShotNames): Record<string, string> {
  return {
    [OWNER_LABEL]: "true",
    [NAMESPACE_LABEL]: names.namespace,
    [TASK_LABEL]: names.taskId,
    [ATTEMPT_LABEL]: `op-${names.operationId}`,
    [ROLE_LABEL]: names.role,
    [OPERATION_LABEL]: names.operationId,
  };
}

/** Whether a labelled thing belongs to this deployment. Missing namespace label is never ours. */
export function ours(namespace: string, labels: Record<string, string> | null | undefined): boolean {
  if (labels?.[OWNER_LABEL] !== "true") return false;
  return labels[NAMESPACE_LABEL] === namespace;
}

/** Docker list filter for everything this deployment owns, optionally narrowed to one task/attempt. */
export function ownedFilter(namespace: string, narrow?: { taskId?: string; attemptId?: string }): string[] {
  const labels = [`${OWNER_LABEL}=true`, `${NAMESPACE_LABEL}=${namespace}`];
  if (narrow?.taskId) labels.push(`${TASK_LABEL}=${narrow.taskId}`);
  if (narrow?.attemptId) labels.push(`${ATTEMPT_LABEL}=${narrow.attemptId}`);
  return labels;
}
