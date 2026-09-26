/**
 * Checkpoint 1: what the supervisor found on its host.
 *
 * Recorded per supervisor start and echoed per run. Nothing here is assumed: the runtime list comes
 * from `docker info`, KVM from the device node, CPU virtualization from /proc/cpuinfo on Linux.
 */
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import type { HostCheck } from "@airlock/contracts";
import type { SupervisorConfig } from "./config";
import type { DockerApi } from "./docker-api";

export interface HostReport {
  check: HostCheck;
  /** Docker's default runtime name; an empty HostConfig.Runtime on a container means this one. */
  defaultRuntime: string;
  /** Whether the configured runtime is one Docker lists (or is the default). */
  runtimeAvailable: boolean;
}

export function cpuVirtualizationFlags(cpuinfo: string): boolean {
  return /^flags\s*:.*\b(vmx|svm)\b/m.test(cpuinfo);
}

function readCpuVirtualization(): boolean {
  if (process.platform !== "linux") return false;
  try {
    return cpuVirtualizationFlags(readFileSync("/proc/cpuinfo", "utf8"));
  } catch {
    return false;
  }
}

function kvm(): { present: boolean; readWrite: boolean } {
  const present = existsSync("/dev/kvm");
  if (!present) return { present, readWrite: false };
  try {
    accessSync("/dev/kvm", constants.R_OK | constants.W_OK);
    return { present, readWrite: true };
  } catch {
    return { present, readWrite: false };
  }
}

export async function checkHost(api: DockerApi, config: SupervisorConfig): Promise<HostReport> {
  const [version, info] = await Promise.all([api.version(), api.info()]);
  const k = kvm();
  const runtimeAvailable =
    info.runtimes.includes(config.dockerRuntime) ||
    info.defaultRuntime === config.dockerRuntime ||
    // Docker lists runc as io.containerd.runc.v2 on newer engines; the plain name still resolves.
    (config.dockerRuntime === "runc" && info.runtimes.some((r) => /runc/.test(r)));
  return {
    check: {
      checkedAt: new Date().toISOString(),
      dockerVersion: version,
      cpuVirtualization: readCpuVirtualization(),
      kvmPresent: k.present,
      kvmReadWrite: k.readWrite,
      availableRuntimes: info.runtimes,
      selectedRuntime: config.runtime,
      devUnsafe: config.devUnsafe,
    },
    defaultRuntime: info.defaultRuntime,
    runtimeAvailable,
  };
}
