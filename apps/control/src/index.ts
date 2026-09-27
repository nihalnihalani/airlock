/**
 * Control-plane composition root (VM A). Wires config → store → artifacts → profiles → supervisor
 * client → model driver → repair handler → worker → HTTP API. Refuses to start on missing secrets
 * or an unreachable supervisor configuration; never logs secrets.
 */
import { join } from "node:path";
import type { Task } from "@airlock/contracts";
import { createApp } from "./api.ts";
import { ArtifactService } from "./artifact-service.ts";
import { RepairAvailabilityService, describeDiagnostics, type DiagnosticScript } from "./availability.ts";
import { ArtifactStore, buildManifest, exportBundle, validateEnvelope, zipFiles } from "./artifacts/index.ts";
import { inferenceFetch, loadConfig, redactConfig, ConfigError } from "./config.ts";
import { TaskEventBus } from "./events.ts";
import { createDispatchingHandler, createGeneralHandler } from "./general-handler.ts";
import { log } from "./log.ts";
import { loadProfilesReport } from "./profiles.ts";
import { computeAdapterDigest, createRepairHandler, type DriverSource } from "./repair-handler.ts";
import { openScriptedCatalog, type ScriptedCatalog } from "./scripted.ts";
import { SessionService } from "./sessions.ts";
import { createStore } from "./store/index.ts";
import { HttpSupervisorClient } from "./supervisor-client.ts";
import { compare } from "./verifier/index.ts";
import { createScriptedDriver, createVultrDriver, type ModelDriver } from "./vultr-client.ts";
import { TaskWorker, backgroundFailure } from "./worker/index.ts";

const WORKER_LEASE_MS = 60_000;

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      log.error("configuration error", { error: error.message });
      process.exit(2);
    }
    throw error;
  }
  log.info("control starting", { logLevel: log.level, config: redactConfig(config) });

  const store = await createStore({ dataDir: join(config.dataDir, "pglite") });
  const artifacts = new ArtifactStore(join(config.dataDir, "artifacts"));
  const report = await loadProfilesReport(config.profilesDir);
  for (const skipped of report.skipped) log.warn("profile skipped", { id: skipped.id, reason: skipped.reason });
  if (report.profiles.size === 0) {
    log.error("no usable profiles; run runtime/python/prepare-profile.sh for each profile", { profilesDir: config.profilesDir });
    process.exit(2);
  }
  log.info("profiles loaded", { ids: [...report.profiles.keys()] });

  const supervisor = new HttpSupervisorClient({ baseUrl: config.supervisorUrl, token: config.supervisorToken });
  try {
    const health = await supervisor.health();
    const host = await supervisor.host();
    log.info("supervisor reachable", { url: config.supervisorUrl, ok: health.ok, runtime: host.selectedRuntime, devUnsafe: host.devUnsafe, instanceId: host.instanceId ?? null });
    if (host.devUnsafe) log.warn("supervisor reports devUnsafe=true (plain runc): local development only, never a deployment");
    if (config.production && (host.devUnsafe || host.selectedRuntime === "runc"))
      log.error("AIRLOCK_PRODUCTION=1 with a dev-unsafe supervisor: new tasks are refused and dev-unsafe records are never previewed or exported", { runtime: host.selectedRuntime });
  } catch (error) {
    log.warn("supervisor not reachable at start; tasks will fail until it is", { url: config.supervisorUrl, error });
  }

  // The driver is chosen per task: a task that names a script (a labelled diagnostic) runs that
  // script from its first turn, whatever the configured driver; every other task runs the
  // configured driver. The live driver is stateless and never follows a redirect.
  const liveDriver: ModelDriver | null =
    config.driver.kind === "vultr"
      ? createVultrDriver({ apiKey: config.vultr.apiKey ?? "", baseUrl: config.vultr.baseUrl, model: config.vultr.model, fetch: inferenceFetch(config.vultr.baseUrl) })
      : null;
  const driverCatalog: ScriptedCatalog | null = config.driver.kind === "scripted" ? await openScriptedCatalog(config.driver.scriptPath) : null;
  const diagnosticCatalog: ScriptedCatalog | null = config.diagnosticScriptsDir ? await openScriptedCatalog(config.diagnosticScriptsDir) : null;
  const generalCatalog: ScriptedCatalog | null = config.generalDiagnosticScriptsDir ? await openScriptedCatalog(config.generalDiagnosticScriptsDir) : null;
  const catalogFor = (name: string): ScriptedCatalog | null =>
    diagnosticCatalog?.names.includes(name) ? diagnosticCatalog : generalCatalog?.names.includes(name) ? generalCatalog : driverCatalog?.names.includes(name) ? driverCatalog : null;
  const scriptedDrivers = [...new Set([...(diagnosticCatalog?.names ?? []), ...(generalCatalog?.names ?? []), ...(driverCatalog?.names ?? [])])].sort();
  const diagnostics: DiagnosticScript[] = [
    ...(diagnosticCatalog ? await describeDiagnostics(diagnosticCatalog.path, diagnosticCatalog.names) : []),
    ...(generalCatalog ? await describeDiagnostics(generalCatalog.path, generalCatalog.names.filter((n) => !diagnosticCatalog?.names.includes(n))) : []),
    ...(driverCatalog ? await describeDiagnostics(driverCatalog.path, driverCatalog.names.filter((n) => !diagnosticCatalog?.names.includes(n))) : []),
  ].sort((a, b) => a.name.localeCompare(b.name));
  const defaultScriptedDriver = driverCatalog ? (driverCatalog.names.length === 1 ? driverCatalog.names[0]! : driverCatalog.names.includes("default") ? "default" : null) : null;
  const driver: DriverSource = async (task: Task) => {
    if (task.scriptedDriver !== undefined) {
      const catalog = catalogFor(task.scriptedDriver);
      if (!catalog) throw new Error(`diagnostic script "${task.scriptedDriver}" is not available on this control plane`);
      const script = await catalog.load(task.scriptedDriver);
      return createScriptedDriver(script.turns, { name: script.name });
    }
    if (liveDriver) return liveDriver;
    const script = await driverCatalog!.load();
    return createScriptedDriver(script.turns, { name: script.name });
  };
  if (driverCatalog) log.warn("model driver is SCRIPTED: diagnostics only, not a live repair", { scriptPath: driverCatalog.path, scripts: driverCatalog.names });
  if (diagnosticCatalog) log.info("diagnostic scripts available to operators and judges (labelled, never a model repair)", { dir: diagnosticCatalog.path, scripts: diagnosticCatalog.names });
  const availability = new RepairAvailabilityService({
    driver: config.driver.kind,
    model: config.driver.kind === "vultr" ? config.vultr.model : null,
    evidenceDir: config.liveGateEvidenceDir,
    repoRoot: config.repoRoot,
    controlInstanceId: config.instanceId,
    // A receipt is bound to the adapter that would run now and to this plane's own task records.
    adapterDigestOf: (profile) => computeAdapterDigest(config.runtimeDir, profile),
    tasks: store,
  });

  const bus = new TaskEventBus();
  const repairHandler = createRepairHandler({
    profiles: report.profiles,
    supervisor,
    driver,
    artifacts,
    store,
    compare,
    validateEnvelope,
    buildManifest,
    runtimeDir: config.runtimeDir,
    // Execution authorization renewed while the worker lease is held (M1): two heartbeats of a
    // 60 s lease, never past the attempt deadline.
    authorizationMs: Math.round((WORKER_LEASE_MS * 2) / 3),
    maxTokens: config.modelMaxTokens,
    ...(config.modelReasoningEffort ? { reasoningEffort: config.modelReasoningEffort } : {}),
    production: config.production,
    // A live task follows the latest live-gate evidence when it is first claimed, not only the
    // state when it was created (a scripted control plane has no live repair to gate).
    repairAvailability: async (_task, profile, host) => (availability.driver === "vultr" ? availability.evaluate(profile, host) : null),
  });
  // General tasks (kind "general") run the general handler at the same worker seam; repair is unchanged.
  const artifactService = new ArtifactService(store, artifacts);
  const generalHandler = createGeneralHandler({
    supervisor,
    driver,
    store,
    artifacts: artifactService,
    blobs: artifacts,
    authorizationMs: Math.round((WORKER_LEASE_MS * 2) / 3),
    maxTokens: config.modelMaxTokens,
    ...(config.modelReasoningEffort ? { reasoningEffort: config.modelReasoningEffort } : {}),
    vision: config.modelVision,
    production: config.production,
  });
  if (config.modelVision) log.info("AIRLOCK_MODEL_VISION=1: screenshots are sent to the model as images (verify with scripts/probe-model.ts --vision)");
  const handler = createDispatchingHandler({ repair: repairHandler, general: generalHandler });
  const worker = new TaskWorker(store, handler, { bus, leaseMs: WORKER_LEASE_MS, pollMs: 1000, concurrency: 2 });
  const sessions = new SessionService(store, {
    operatorPassword: config.operatorPassword,
    judgePassword: config.judgePassword,
    ttlMs: config.sessionTtlMs,
    secureCookies: config.secureCookies,
  });
  const app = createApp({
    store,
    sessions,
    profiles: report.profiles,
    supervisor,
    artifacts,
    artifactService,
    worker,
    bus,
    exportBundle,
    zipFiles,
    exportGrantTtlMs: config.exportGrantTtlMs,
    hostileMinIntervalMs: config.hostileMinIntervalMs,
    hostileGlobalMinIntervalMs: config.hostileGlobalMinIntervalMs,
    previewMinIntervalMs: config.previewMinIntervalMs,
    runtimeDir: config.runtimeDir,
    scriptedDrivers: scriptedDrivers.length ? scriptedDrivers : null,
    diagnostics,
    defaultScriptedDriver,
    availability,
    webDist: config.webDist,
    trustedProxies: config.trustedProxies,
    production: config.production,
  });
  if (config.trustedProxies.length > 0)
    log.info("AIRLOCK_TRUST_PROXY: the login rate limit keys on the reverse proxy's X-Forwarded-For hop for requests arriving from these peers; other peers are keyed on their own address", { trustedProxies: config.trustedProxies });
  if (config.webDist) log.info("serving web UI", { dir: config.webDist });
  else log.warn("no web UI directory (apps/web/dist); only /api is served. Build it with: bun run --cwd apps/web build");

  worker.start();
  const server = Bun.serve({ port: config.port, hostname: config.bind, fetch: app.fetch, idleTimeout: 255 });
  log.info("control listening", { url: `http://${config.bind}:${server.port}`, driver: config.driver.kind, model: config.driver.kind === "vultr" ? config.vultr.model : null, logLevel: log.level });

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info("shutting down", { signal });
    server.stop(true);
    await worker.stop().catch((error) => backgroundFailure("worker stop", error));
    await store.close().catch((error) => backgroundFailure("store close", error));
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error) => {
  log.error("control failed to start", { error });
  process.exit(1);
});
