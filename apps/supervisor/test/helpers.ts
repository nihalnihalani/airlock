import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Operation, type ProfileManifest, requestDigestOf } from "@airlock/contracts";
import type { SupervisorConfig } from "../src/config";
import type { HostReport } from "../src/host";
import { Supervisor } from "../src/lifecycle";
import { Journal } from "../src/operations";
import { FakeDocker } from "./fake-docker";

export const PROFILE: ProfileManifest = {
  schemaVersion: 1,
  id: "tabulate-365",
  displayName: "test profile",
  issueUrl: "https://github.com/astanin/python-tabulate/issues/365",
  repository: "https://github.com/astanin/python-tabulate",
  baselineCommit: "e13a4d0dd292cade200e653eb9155a1ca0f1dbea",
  baselineTreeDigest: "d20b5bf8d4cefe19d3579d864269f0c04f7ded6f0a6ea75b93801b0e16693b06",
  runtimeImage: "airlock-runtime-python:tabulate-365",
  language: "python",
  sourceRoot: "/workspace/src",
  allowedReplacementPaths: ["tabulate/__init__.py"],
  readablePaths: ["tabulate/__init__.py", "README.md"],
  adapterModule: "airlock_adapter_tabulate",
  contractPath: "contract.json",
  caps: {
    cpus: 1,
    memoryBytes: 536870912,
    pidsLimit: 64,
    commandTimeoutMs: 30000,
    attemptTimeoutMs: 300000,
    outputBytes: 65536,
    maxRepairAttempts: 2,
    maxModelCalls: 40,
    maxFileBytes: 1048576,
    maxTotalBytes: 4194304,
    maxFiles: 4,
  },
};

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "airlock-supervisor-"));
}

export function testConfig(dir: string): SupervisorConfig {
  return {
    token: "test-token-0123456789abcdef",
    port: 0,
    bind: "127.0.0.1",
    runtime: "runc",
    dockerRuntime: "runc",
    devUnsafe: true,
    profilesDir: dir,
    dataDir: dir,
    journalPath: join(dir, "journal.sqlite"),
    dockerSocket: undefined,
    namespace: "airlocktest",
    retentionMs: 60_000,
    janitorIntervalMs: 60_000,
  };
}

export function fakeHost(): HostReport {
  return {
    check: {
      checkedAt: new Date().toISOString(),
      dockerVersion: "fake-1.0",
      cpuVirtualization: false,
      kvmPresent: false,
      kvmReadWrite: false,
      availableRuntimes: ["runc"],
      selectedRuntime: "runc",
      devUnsafe: true,
    },
    defaultRuntime: "runc",
    runtimeAvailable: true,
  };
}

export function makeCore(api: FakeDocker, journal?: Journal, seams: { settleMs?: number; writeTimeoutMs?: number; dir?: string } = {}): { core: Supervisor; journal: Journal; dir: string } {
  const dir = seams.dir ?? tempDir();
  const j = journal ?? new Journal(join(dir, "journal.sqlite"));
  const core = new Supervisor({
    api,
    journal: j,
    config: testConfig(dir),
    profiles: new Map([[PROFILE.id, PROFILE]]),
    host: fakeHost(),
    log: () => {},
    ...(seams.settleMs !== undefined ? { settleMs: seams.settleMs } : {}),
    ...(seams.writeTimeoutMs !== undefined ? { writeTimeoutMs: seams.writeTimeoutMs } : {}),
  });
  return { core, journal: j, dir };
}

/** Build an Operation whose digest matches `body` (with the operation id inside). */
export async function operationFor(operationId: string, body: Record<string, unknown>): Promise<Operation> {
  const requestDigest = await requestDigestOf({ ...body, operation: { operationId } });
  return { operationId, requestDigest };
}

export function future(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}
