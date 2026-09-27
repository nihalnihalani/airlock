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
 * selection with dev-unsafe labelling; janitor and absolute deadlines; renewable execution
 * authorization; host admission (429); a host-wide listing; `/health` reveals nothing but liveness.
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
  BrowserEvidence,
  BrowserOpResult,
  CollectOutputsRequest,
  CollectOutputsResult,
  DestroyResult,
  EgressLog,
  HostListing,
  CreateAttemptRequest,
  DestroyRequest,
  FreezeRequest,
  HostileRunRequest,
  InvokeRequest,
  RenewRequest,
  RevokeRequest,
  requestDigestOf,
} from "@airlock/contracts";
import { SupervisorBrowserOpRequest } from "./browser-files";
import { loadConfig } from "./config";
import { SupervisorError, describe } from "./errors";
import { checkHost } from "./host";
import { type Sentinel, createSentinel, hostileRun } from "./hostile";
import { invoke } from "./invoke";
import { Supervisor } from "./lifecycle";
import { log } from "./log";
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

  // Every request is logged at debug with its outcome (method, path, status, duration, body sizes);
  // never a body and never the bearer token.
  app.use("*", async (c, next) => {
    const startedAt = Date.now();
    try {
      if (c.req.path === "/health" && c.req.method === "GET") return await next();
      if (!tokenMatches(c.req.header("authorization"), deps.token)) {
        log.warn("unauthorized request", { method: c.req.method, path: c.req.path });
        return c.json({ error: "Unauthorized.", code: "unauthorized" }, 401);
      }
      return await next();
    } finally {
      if (log.enabled("debug")) {
        log.debug("http", {
          method: c.req.method,
          path: c.req.path,
          status: c.res.status,
          durationMs: Date.now() - startedAt,
          requestBytes: Number(c.req.header("content-length") ?? "0") || 0,
          responseBytes: Number(c.res.headers.get("content-length") ?? "0") || 0,
        });
      }
    }
  });

  app.onError((error, c) => {
    if (error instanceof SupervisorError) {
      log.debug("request refused", { method: c.req.method, path: c.req.path, status: error.status, code: error.code, error: error.message });
      return c.json({ error: error.message, code: error.code }, error.status as 400);
    }
    log.error("unhandled error", { method: c.req.method, path: c.req.path, error });
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

  /**
   * Route outputs that have a contracts schema are validated before they leave: a shape drift is a
   * supervisor bug (500), never a silently different receipt. Extra fields are kept.
   */
  function typed<S extends z.ZodTypeAny>(schema: S, value: unknown, what: string): object {
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      log.error("route output does not match its contract", { what, issue: issue ? `${issue.path.join(".")}: ${issue.message}` : "unknown" });
      throw new SupervisorError("internal", `Supervisor output for ${what} does not match its contract.`);
    }
    return value as object;
  }

  function attemptParam(c: { req: { param(name: string): string | undefined } }): string {
    const checked = validateId(c.req.param("attemptId"), "attemptId");
    if (!checked.ok) throw new SupervisorError("invalid_body", checked.reason);
    return checked.value;
  }

  // Unauthenticated liveness only (D15): no host inventory, runtimes or versions. The host check is
  // on the authenticated GET /host.
  app.get("/health", (c) => c.json({ ok: true }));

  app.get("/host", (c) => c.json(core.host.check));

  /** Host admission budget and current reservations (M2). */
  app.get("/capacity", (c) => c.json(core.capacity.usage()));

  /** Every Airlock-owned container and volume on this Docker host (contracts HostListing, M7). */
  app.get("/listing", async (c) => c.json(typed(HostListing, await core.hostListing(), "HostListing")));

  /**
   * M8: the journal's record of one operation, so the controller can reconcile an invoke, hostile,
   * browser or lifecycle call by id after a lost response: kind, pending/completed, the recorded HTTP
   * status, whether a receipt exists, whether a restart cut it off, and the task/attempt/generation
   * it was bound to. Never the result body itself (replay the same request to get it).
   */
  app.get("/operations/:operationId", (c) => {
    const checked = validateId(c.req.param("operationId"), "operationId");
    if (!checked.ok) throw new SupervisorError("invalid_body", checked.reason);
    const record = core.operationRecord(checked.value);
    if (!record) throw new SupervisorError("not_found", "Unknown operation.");
    return c.json(record);
  });

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
    // put: analysis/node attempts only (inputs/); refused for repair attempts inside the operation.
    const response = await core.authorTool(request.ref, request.operation, request.args);
    return c.json(response.body as object, response.status as 200);
  });

  /**
   * One runner operation on a live browser attempt (contracts BrowserOpRequest → BrowserOpResult).
   * 200 with status completed | refused | interrupted; fence/role/state refusals are 4xx like the
   * other attempt routes. `interrupted` closes the attempt; the operation is never replayed.
   */
  app.post("/attempts/:attemptId/browser", async (c) => {
    const attemptId = attemptParam(c);
    // contracts BrowserOp plus the file operations (download.list, download.read, upload; browser-files.ts).
    const request = await body(c, SupervisorBrowserOpRequest);
    if (request.ref.attemptId !== attemptId) throw new SupervisorError("invalid_body", "ref.attemptId does not match the path.");
    const response = await core.browserOp(request.ref, request.operation, request.request);
    return c.json(response.status === 200 ? typed(BrowserOpResult, response.body, "BrowserOpResult") : (response.body as object), response.status as 200);
  });

  /** Evidence taken when the browser attempt was created: Chromium sandbox status, inspections, probe, networks. */
  app.get("/attempts/:attemptId/browser", (c) => {
    const evidence = core.browserEvidence(attemptParam(c));
    if (!evidence) throw new SupervisorError("not_found", "No browser evidence for this attempt.");
    return c.json(typed(BrowserEvidence, evidence, "BrowserEvidence"));
  });

  /** The egress proxy's decisions for a browser attempt (newest 200) with allowed/denied counts. */
  app.get("/attempts/:attemptId/egress", async (c) => {
    const evidence = await core.egressEvidence(attemptParam(c));
    if (!evidence) throw new SupervisorError("not_found", "No browser attempt with egress evidence.");
    return c.json(typed(EgressLog, evidence, "EgressLog"));
  });

  app.post("/attempts/:attemptId/renew", async (c) => {
    const attemptId = attemptParam(c);
    const request = await body(c, RenewRequest);
    if (request.ref.attemptId !== attemptId) throw new SupervisorError("invalid_body", "ref.attemptId does not match the path.");
    const response = await core.renew(request.ref, request.operation, request.authorizedUntil);
    return c.json(response.body as object, response.status as 200);
  });

  app.post("/attempts/:attemptId/freeze", async (c) => {
    const attemptId = attemptParam(c);
    const request = await body(c, FreezeRequest);
    if (request.ref.attemptId !== attemptId) throw new SupervisorError("invalid_body", "ref.attemptId does not match the path.");
    const response = await core.freeze(request.ref, request.operation);
    return c.json(response.body as object, response.status as 200);
  });

  /**
   * Analysis/node attempts: revoke → hold the volume read-only → stop → settle → inspect stopped →
   * runtime/outputs/collect_outputs.py (contracts CollectOutputsRequest → CollectOutputsResult).
   */
  app.post("/attempts/:attemptId/collect-outputs", async (c) => {
    const attemptId = attemptParam(c);
    const request = await body(c, CollectOutputsRequest);
    if (request.ref.attemptId !== attemptId) throw new SupervisorError("invalid_body", "ref.attemptId does not match the path.");
    const response = await core.collectOutputs(request.ref, request.operation);
    return c.json(response.status === 200 ? typed(CollectOutputsResult, response.body, "CollectOutputsResult") : (response.body as object), response.status as 200);
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
    return c.json(response.status === 200 ? typed(DestroyResult, response.body, "DestroyResult") : (response.body as object), response.status as 200);
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
    log.error("configuration error", { error: loaded.reason });
    process.exit(1);
  }
  const config = loaded.config;
  let profiles;
  try {
    profiles = loadProfiles(config.profilesDir);
  } catch (error) {
    log.error("profiles failed to load", { profilesDir: config.profilesDir, error: describe(error) });
    process.exit(1);
  }
  if (profiles.size === 0) {
    log.error("no profiles found", { profilesDir: config.profilesDir });
    process.exit(1);
  }
  log.info("supervisor starting", { logLevel: log.level, bind: config.bind, port: config.port, runtime: config.runtime, dockerRuntime: config.dockerRuntime, devUnsafe: config.devUnsafe, production: config.production, runtimeImageId: config.runtimeImageId ?? null, instanceId: config.instanceId ?? null, capacity: config.capacity, namespace: config.namespace, profilesDir: config.profilesDir, dataDir: config.dataDir, journalPath: config.journalPath, dockerSocket: config.dockerSocket ?? null });
  const api = createDockerode(config.dockerSocket);
  if (!(await api.ping())) {
    log.error("Docker is not reachable. The supervisor cannot start without the engine it supervises.", { dockerSocket: config.dockerSocket ?? null });
    process.exit(1);
  }
  const host = await checkHost(api, config);
  log.info("host check", { ...host.check });
  if (!host.runtimeAvailable) {
    log.error("configured runtime is not listed by Docker; refusing to start", { runtime: config.runtime, dockerRuntime: config.dockerRuntime, availableRuntimes: host.check.availableRuntimes });
    process.exit(1);
  }
  if (config.runtimeImageId) {
    // D2: every supported profile's image tag must resolve to the pinned image ID now; each
    // container is checked again at every inspection.
    for (const profile of profiles.values()) {
      const image = await api.inspectImage(profile.runtimeImage);
      if (image?.id !== config.runtimeImageId) {
        log.error("runtime image does not match AIRLOCK_RUNTIME_IMAGE_ID; refusing to start", { profile: profile.id, runtimeImage: profile.runtimeImage, observed: image?.id ?? null, pinned: config.runtimeImageId });
        process.exit(1);
      }
    }
  }
  if (config.browser) {
    // The browser plane's images must exist now and, when pinned, resolve to the pinned IDs; every
    // browser-plane inspection checks the container's image ID again.
    for (const [ref, pinned, name] of [
      [config.browser.image, config.browser.imageId, "AIRLOCK_BROWSER_IMAGE_ID"],
      [config.browser.egressImage, config.browser.egressImageId, "AIRLOCK_EGRESS_IMAGE_ID"],
    ] as const) {
      const image = await api.inspectImage(ref);
      if (!image || (pinned !== undefined && image.id !== pinned)) {
        log.error("browser-plane image missing or not the pinned ID; refusing to start", { image: ref, observed: image?.id ?? null, pinned: pinned ?? null, variable: name });
        process.exit(1);
      }
    }
    log.info("browser plane enabled", { image: config.browser.image, egressImage: config.browser.egressImage, seccomp: config.browser.seccompPath, memoryBytes: config.browser.memoryBytes, pidsLimit: config.browser.pidsLimit, shmBytes: config.browser.shmBytes, tmpBytes: config.browser.tmpBytes });
  }
  for (const plane of [config.code.analysis, config.code.node]) {
    if (!plane) continue;
    // Code sandbox images must exist now and, when pinned, resolve to the pinned IDs; every
    // inspection of an analysis/node/collector container checks the image ID again.
    const image = await api.inspectImage(plane.image);
    if (!image || (plane.imageId !== undefined && image.id !== plane.imageId)) {
      log.error("code sandbox image missing or not the pinned ID; refusing to start", { role: plane.role, image: plane.image, observed: image?.id ?? null, pinned: plane.imageId ?? null, variable: `AIRLOCK_${plane.role.toUpperCase()}_IMAGE_ID` });
      process.exit(1);
    }
    log.info("code sandbox enabled", { role: plane.role, image: plane.image, imageId: image.id, cpus: plane.cpus, memoryBytes: plane.memoryBytes, pidsLimit: plane.pidsLimit, commandTimeoutMs: plane.commandTimeoutMs, workspaceBytes: plane.workspaceBytes });
  }
  if (config.devUnsafe) {
    log.warn("AIRLOCK_DEV_UNSAFE=1 with runtime runc: every record is labelled dev-unsafe. This is never a deployment configuration.");
  }
  const sentinel = await createSentinel(config.dataDir);
  const journal = new Journal(config.journalPath);
  const core = new Supervisor({ api, journal, config, profiles, host });
  await core.start();
  const app = createApp({ core, token: config.token, sentinel });
  const server = Bun.serve({ hostname: config.bind, port: config.port, fetch: app.fetch, maxRequestBodySize: MAX_BODY_BYTES, idleTimeout: 255 });
  log.info("supervisor listening", { url: `http://${config.bind}:${config.port}`, runtime: config.runtime, dockerRuntime: config.dockerRuntime, devUnsafe: config.devUnsafe, profiles: [...profiles.keys()], kvm: host.check.kvmPresent });
  const shutdown = () => {
    log.info("shutting down");
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
    log.error("fatal", { error });
    process.exit(1);
  });
}
