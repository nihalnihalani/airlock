/**
 * Control-plane composition root (VM A). Wires config → store → artifacts → profiles → supervisor
 * client → model driver → repair handler → worker → HTTP API. Refuses to start on missing secrets
 * or an unreachable supervisor configuration; never logs secrets.
 */
import { join } from "node:path";
import type { Task } from "@airlock/contracts";
import { createApp } from "./api.ts";
import { ArtifactStore, buildManifest, exportBundle, validateEnvelope, zipFiles } from "./artifacts/index.ts";
import { loadConfig, redactConfig, ConfigError } from "./config.ts";
import { TaskEventBus } from "./events.ts";
import { loadProfilesReport } from "./profiles.ts";
import { createRepairHandler, type DriverSource } from "./repair-handler.ts";
import { openScriptedCatalog } from "./scripted.ts";
import { SessionService } from "./sessions.ts";
import { createStore } from "./store/index.ts";
import { HttpSupervisorClient } from "./supervisor-client.ts";
import { compare } from "./verifier/index.ts";
import { createScriptedDriver, createVultrDriver } from "./vultr-client.ts";
import { TaskWorker, backgroundFailure } from "./worker/index.ts";

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`configuration error: ${error.message}`);
      process.exit(2);
    }
    throw error;
  }
  console.log({ timestamp: new Date().toISOString(), message: "control starting", config: redactConfig(config) });

  const store = await createStore({ dataDir: join(config.dataDir, "pglite") });
  const artifacts = new ArtifactStore(join(config.dataDir, "artifacts"));
  const report = await loadProfilesReport(config.profilesDir);
  for (const skipped of report.skipped) console.warn({ timestamp: new Date().toISOString(), message: "profile skipped", id: skipped.id, reason: skipped.reason });
  if (report.profiles.size === 0) {
    console.error(`no usable profiles in ${config.profilesDir}; run runtime/python/prepare-profile.sh for each profile`);
    process.exit(2);
  }
  console.log({ timestamp: new Date().toISOString(), message: "profiles loaded", ids: [...report.profiles.keys()] });

  const supervisor = new HttpSupervisorClient({ baseUrl: config.supervisorUrl, token: config.supervisorToken });
  try {
    const health = await supervisor.health();
    console.log({ timestamp: new Date().toISOString(), message: "supervisor reachable", status: health.status, docker: health.docker, runtime: health.host.selectedRuntime, devUnsafe: health.host.devUnsafe });
    if (health.host.devUnsafe) console.warn("supervisor reports devUnsafe=true (plain runc): local development only, never a deployment");
  } catch (error) {
    console.warn({ timestamp: new Date().toISOString(), message: "supervisor not reachable at start; tasks will fail until it is", error: error instanceof Error ? error.message.slice(0, 200) : "unknown" });
  }

  // One driver per task run: the scripted driver replays from its first turn for every task, and
  // a task may name its script when the catalog is a directory. The live driver is stateless.
  let driver: DriverSource;
  let scriptedDrivers: string[] | null = null;
  if (config.driver.kind === "vultr") {
    driver = createVultrDriver({ apiKey: config.vultr.apiKey ?? "", baseUrl: config.vultr.baseUrl, model: config.vultr.model });
  } else {
    const catalog = await openScriptedCatalog(config.driver.scriptPath);
    scriptedDrivers = catalog.names;
    driver = async (task: Task) => {
      const script = await catalog.load(task.scriptedDriver);
      return createScriptedDriver(script.turns, { name: script.name });
    };
    console.warn(`model driver is SCRIPTED from ${config.driver.scriptPath} (${catalog.names.join(", ")}): diagnostics only, not a live repair`);
  }

  const bus = new TaskEventBus();
  const handler = createRepairHandler({
    profiles: report.profiles,
    supervisor,
    driver,
    artifacts,
    store,
    compare,
    validateEnvelope,
    buildManifest,
    runtimeDir: config.runtimeDir,
  });
  const worker = new TaskWorker(store, handler, { bus, leaseMs: 60_000, pollMs: 1000, concurrency: 2 });
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
    worker,
    bus,
    exportBundle,
    zipFiles,
    exportGrantTtlMs: config.exportGrantTtlMs,
    hostileMinIntervalMs: config.hostileMinIntervalMs,
    scriptedDrivers,
    webDist: config.webDist,
  });
  if (config.webDist) console.log({ timestamp: new Date().toISOString(), message: "serving web UI", dir: config.webDist });
  else console.warn("no web UI directory (apps/web/dist); only /api is served. Build it with: bun run --cwd apps/web build");

  worker.start();
  const server = Bun.serve({ port: config.port, hostname: config.bind, fetch: app.fetch, idleTimeout: 255 });
  console.log({ timestamp: new Date().toISOString(), message: "control listening", url: `http://${config.bind}:${server.port}` });

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log({ timestamp: new Date().toISOString(), message: `shutting down on ${signal}` });
    server.stop(true);
    await worker.stop().catch((error) => backgroundFailure("worker stop", error));
    await store.close().catch((error) => backgroundFailure("store close", error));
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error) => {
  console.error({ timestamp: new Date().toISOString(), message: "control failed to start", error: error instanceof Error ? `${error.name}: ${error.message.slice(0, 500)}` : String(error) });
  process.exit(1);
});
