/**
 * The Airlock supervisor: the only process that holds the Docker socket.
 *
 * Adapted from OpenBot `supervisor/src/index.ts` (pin 3c73cf00efba46122dfd0447485e2b61f1d6a2cd):
 *
 *   MIT License, Copyright (c) 2026 CopilotKit. Permission is hereby granted, free of charge, to any
 *   person obtaining a copy of this software and associated documentation files (the "Software"),
 *   to deal in the Software without restriction ... THE SOFTWARE IS PROVIDED "AS IS", WITHOUT
 *   WARRANTY OF ANY KIND.
 *
 * Kept from upstream: Bun + Hono, bearer token on everything except /health, refusing to start
 * without the token, the principle that the vocabulary (not the token) is the boundary. Airlock
 * modifications: per-attempt disposable roles instead of per-Bot computers; execution, freeze,
 * invoke and hostile endpoints; operation journal and generation fencing; body digests; runtime tier
 * selection with dev-unsafe labelling; janitor and absolute deadlines.
 *
 * The shared secret is not the boundary; the vocabulary is. A caller with the token can create an
 * attempt for a supported profile, run a command inside it, freeze, revoke and destroy it. It cannot
 * name an image, a mount, a network, a runtime, a Docker option or a host path, because none of
 * those are expressible in this API.
 */
import { timingSafeEqual } from "node:crypto";
import { resolve } from "node:path";
import { Hono } from "hono";
import type { z } from "zod";
import {
  AuthorToolRequest,
  CreateAttemptRequest,
  DestroyRequest,
  FreezeRequest,
  HostileRunRequest,
  InvokeRequest,
  RevokeRequest,
  requestDigestOf,
} from "@airlock/contracts";
import { loadConfig } from "./config";
import { SupervisorError, describe } from "./errors";
import { checkHost } from "./host";
import { type Sentinel, createSentinel, hostileRun } from "./hostile";
import { invoke } from "./invoke";
import { Supervisor } from "./lifecycle";
import { validateId } from "./names";
import { Journal } from "./operations";
import { loadProfiles } from "./profiles";
import { createDockerode } from "./runtime";

export const MAX_BODY_BYTES = 16 * 1024 * 1024;

export interface AppDeps {
  core: Supervisor;
  token: string;
  sentinel: Sentinel;
}

function tokenMatches(header: string | undefined, token: string): boolean {
  if (!header || !header.startsWith("Bearer ")) return false;
  const presented = Buffer.from(header.slice(7));
  const expected = Buffer.from(token);
  if (presented.length !== expected.length) return false;
  return timingSafeEqual(presented, expected);
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  const { core } = deps;

  app.use("*", async (c, next) => {
    if (c.req.path === "/health" && c.req.method === "GET") return next();
    if (!tokenMatches(c.req.header("authorization"), deps.token)) {
      return c.json({ error: "Unauthorized.", code: "unauthorized" }, 401);
    }
    return next();
  });

  app.onError((error, c) => {
    if (error instanceof SupervisorError) {
      return c.json({ error: error.message, code: error.code }, error.status as 400);
    }
    console.error(`[supervisor] unhandled error on ${c.req.method} ${c.req.path}: ${describe(error)}`);
    return c.json({ error: "Internal supervisor error.", code: "internal" }, 500);
  });

  /** Parse and validate a JSON body against a contracts schema; verify the operation digest. */
  async function body<S extends z.ZodTypeAny>(c: { req: { text(): Promise<string>; header(name: string): string | undefined } }, schema: S): Promise<z.infer<S>> {
    const length = Number(c.req.header("content-length") ?? "0");
    if (Number.isFinite(length) && length > MAX_BODY_BYTES) throw new SupervisorError("invalid_body", "Request body exceeds 16 MiB.");
    const text = await c.req.text();
    if (text.length > MAX_BODY_BYTES) throw new SupervisorError("invalid_body", "Request body exceeds 16 MiB.");
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new SupervisorError("invalid_body", "Request body is not JSON.");
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new SupervisorError("invalid_body", `Invalid request body: ${issue ? `${issue.path.join(".")}: ${issue.message}` : "does not match schema"}.`);
    }
    const data = parsed.data as { operation?: { operationId: string; requestDigest: string } };
    if (data.operation) {
      const digest = await requestDigestOf(raw as Record<string, unknown>);
      if (digest !== data.operation.requestDigest) {
        throw new SupervisorError("invalid_body", "operation.requestDigest does not match the request body.");
      }
    }
    return parsed.data;
  }

  function attemptParam(c: { req: { param(name: string): string | undefined } }): string {
    const checked = validateId(c.req.param("attemptId"), "attemptId");
    if (!checked.ok) throw new SupervisorError("invalid_body", checked.reason);
    return checked.value;
  }

  app.get("/health", async (c) => {
    const docker = await core.api.ping();
    return c.json({ status: docker ? "ok" : "degraded", docker, host: core.host.check });
  });

  app.get("/host", (c) => c.json(core.host.check));

  app.post("/attempts", async (c) => {
    const request = await body(c, CreateAttemptRequest);
    const response = await core.createAttempt(request);
    return c.json(response.body as object, response.status as 200);
  });

  app.get("/attempts", (c) => c.json(core.listAttempts()));

  app.get("/attempts/:attemptId", (c) => {
    const state = core.getAttempt(attemptParam(c));
    if (!state) throw new SupervisorError("not_found", "Unknown attempt.");
    return c.json(state);
  });

  app.post("/attempts/:attemptId/tool", async (c) => {
    const attemptId = attemptParam(c);
    const request = await body(c, AuthorToolRequest);
    if (request.ref.attemptId !== attemptId) throw new SupervisorError("invalid_body", "ref.attemptId does not match the path.");
    const response = await core.authorTool(request.ref, request.operation, request.args);
    return c.json(response.body as object, response.status as 200);
  });

  app.post("/attempts/:attemptId/freeze", async (c) => {
    const attemptId = attemptParam(c);
    const request = await body(c, FreezeRequest);
    if (request.ref.attemptId !== attemptId) throw new SupervisorError("invalid_body", "ref.attemptId does not match the path.");
    const response = await core.freeze(request.ref, request.operation);
    return c.json(response.body as object, response.status as 200);
  });

  app.post("/attempts/:attemptId/revoke", async (c) => {
    const attemptId = attemptParam(c);
    const request = await body(c, RevokeRequest);
    if (request.ref.attemptId !== attemptId) throw new SupervisorError("invalid_body", "ref.attemptId does not match the path.");
    const response = await core.revoke(request.ref, request.operation);
    return c.json(response.body as object, response.status as 200);
  });

  app.post("/attempts/:attemptId/destroy", async (c) => {
    const attemptId = attemptParam(c);
    const request = await body(c, DestroyRequest);
    if (request.ref.attemptId !== attemptId) throw new SupervisorError("invalid_body", "ref.attemptId does not match the path.");
    const response = await core.destroy(request.ref, request.operation);
    return c.json(response.body as object, response.status as 200);
  });

  app.post("/invoke", async (c) => {
    const request = await body(c, InvokeRequest);
    const response = await invoke(core, request);
    return c.json(response.body as object, response.status as 200);
  });

  app.post("/hostile", async (c) => {
    const request = await body(c, HostileRunRequest);
    const response = await hostileRun(core, request, deps.sentinel);
    return c.json(response.body as object, response.status as 200);
  });

  app.notFound((c) => c.json({ error: "Not found.", code: "not_found" }, 404));
  return app;
}

async function main(): Promise<void> {
  const repoRoot = resolve(import.meta.dir, "../../..");
  const loaded = loadConfig(process.env, repoRoot);
  if (!loaded.ok) {
    console.error(loaded.reason);
    process.exit(1);
  }
  const config = loaded.config;
  let profiles;
  try {
    profiles = loadProfiles(config.profilesDir);
  } catch (error) {
    console.error(describe(error));
    process.exit(1);
  }
  if (profiles.size === 0) {
    console.error(`No profiles found under ${config.profilesDir}.`);
    process.exit(1);
  }
  const api = createDockerode(config.dockerSocket);
  if (!(await api.ping())) {
    console.error("Docker is not reachable. The supervisor cannot start without the engine it supervises.");
    process.exit(1);
  }
  const host = await checkHost(api, config);
  if (!host.runtimeAvailable) {
    console.error(`Runtime ${config.dockerRuntime} (${config.runtime}) is not listed by Docker: ${host.check.availableRuntimes.join(", ") || "(none)"}. Refusing to start.`);
    process.exit(1);
  }
  if (config.devUnsafe) {
    console.warn("[supervisor] AIRLOCK_DEV_UNSAFE=1 with runtime runc: every record is labelled dev-unsafe. This is never a deployment configuration.");
  }
  const sentinel = await createSentinel(config.dataDir);
  const journal = new Journal(config.journalPath);
  const core = new Supervisor({ api, journal, config, profiles, host });
  await core.start();
  const app = createApp({ core, token: config.token, sentinel });
  const server = Bun.serve({ hostname: config.bind, port: config.port, fetch: app.fetch, maxRequestBodySize: MAX_BODY_BYTES, idleTimeout: 255 });
  console.info(
    `[supervisor] listening on http://${config.bind}:${config.port} runtime=${config.runtime} (${config.dockerRuntime})${config.devUnsafe ? " DEV-UNSAFE" : ""} profiles=${[...profiles.keys()].join(",")} kvm=${host.check.kvmPresent}`,
  );
  const shutdown = () => {
    console.info("[supervisor] shutting down");
    core.stop();
    server.stop(true);
    journal.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`[supervisor] fatal: ${describe(error)}`);
    process.exit(1);
  });
}
