/**
 * Checkpoint 1: what the supervisor found on its host.
 *
 * Recorded per supervisor start and echoed per run. Nothing here is assumed: the runtime list comes
 * from `docker info`, KVM from the device node, CPU virtualization from /proc/cpuinfo on Linux.
 */
import { execFileSync } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { hostname, release, type as osType } from "node:os";
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

/** Checkpoint 3 host side: `uname -a` of this host, bounded (2 s, 512 chars); os.type/release if uname fails. */
export function hostUname(): string {
  try {
    const out = execFileSync("uname", ["-a"], { timeout: 2_000, maxBuffer: 4096, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const line = out.trim();
    if (line) return line.slice(0, 512);
  } catch {
    // fall through
  }
  return `${osType()} ${release()}`.slice(0, 512);
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
      hostUname: hostUname(),
      hostHostname: hostname().slice(0, 128),
      ...(config.instanceId ? { instanceId: config.instanceId } : {}),
      // Dev-unsafe without a pin: filled with the observed image ID at the first inspection.
      ...(config.runtimeImageId ? { runtimeImageId: config.runtimeImageId } : {}),
    },
    defaultRuntime: info.defaultRuntime,
    runtimeAvailable,
  };
}
