/**
 * CLAUDE.md §3.8: the runtime tier is inspected, never assumed. A configured tier can never relabel
 * a shared-kernel runtime that Docker actually reports, and the docker-name override cannot name a
 * runtime from a different tier than AIRLOCK_RUNTIME.
 */
import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config";
import { runtimeNameOf } from "../src/runtime";

// A pinned image ID is required outside dev-unsafe (D2); these tests are about the runtime tier.
const BASE_ENV = { SUPERVISOR_TOKEN: "test-token-0123456789abcdef", AIRLOCK_RUNTIME_IMAGE_ID: `sha256:${"a".repeat(64)}` };

describe("runtimeNameOf", () => {
  test("an effective runc is never relabelled as the configured tier", () => {
    // Misconfiguration: AIRLOCK_RUNTIME=kata with AIRLOCK_DOCKER_RUNTIME_NAME=runc.
    expect(runtimeNameOf("runc", "kata", "runc", "runc")).toBe("runc");
    expect(runtimeNameOf("io.containerd.runc.v2", "runsc", "io.containerd.runc.v2", "runc")).toBe("runc");
    expect(runtimeNameOf("crun", "kata", "crun", "runc")).toBe("runc");
    // Empty effective name means Docker's default; default runc with a kata config is still runc.
    expect(runtimeNameOf("", "kata", "runc", "runc")).toBe("runc");
  });

  test("a kata or gVisor name is classified by its name, whatever was configured", () => {
    expect(runtimeNameOf("io.containerd.kata.v2", "kata", "io.containerd.kata.v2", "runc")).toBe("kata");
    expect(runtimeNameOf("runsc", "runsc", "runsc", "runc")).toBe("runsc");
    expect(runtimeNameOf("runsc", "kata", "runsc", "runc")).toBe("runsc");
    expect(runtimeNameOf("io.containerd.kata.v2", "runsc", "io.containerd.kata.v2", "runc")).toBe("kata");
  });

  test("an unrecognised custom name maps to the configured tier only when it is the configured docker name", () => {
    expect(runtimeNameOf("my-vm-rt", "kata", "my-vm-rt", "runc")).toBe("kata");
    expect(runtimeNameOf("something-else", "kata", "my-vm-rt", "runc")).toBe("runc");
  });
});

describe("loadConfig AIRLOCK_DOCKER_RUNTIME_NAME", () => {
  test("rejects an override whose name belongs to a different tier than AIRLOCK_RUNTIME", () => {
    const kataRunc = loadConfig({ ...BASE_ENV, AIRLOCK_RUNTIME: "kata", AIRLOCK_DOCKER_RUNTIME_NAME: "runc" }, "/tmp");
    expect(kataRunc.ok).toBe(false);
    const runscRunc = loadConfig({ ...BASE_ENV, AIRLOCK_RUNTIME: "runsc", AIRLOCK_DOCKER_RUNTIME_NAME: "io.containerd.runc.v2" }, "/tmp");
    expect(runscRunc.ok).toBe(false);
    const kataRunsc = loadConfig({ ...BASE_ENV, AIRLOCK_RUNTIME: "kata", AIRLOCK_DOCKER_RUNTIME_NAME: "runsc" }, "/tmp");
    expect(kataRunsc.ok).toBe(false);
    const runcKata = loadConfig(
      { ...BASE_ENV, AIRLOCK_RUNTIME: "runc", AIRLOCK_DEV_UNSAFE: "1", AIRLOCK_DOCKER_RUNTIME_NAME: "io.containerd.kata.v2" },
      "/tmp",
    );
    expect(runcKata.ok).toBe(false);
  });

  test("accepts an override that names the same tier or a custom name", () => {
    const kata = loadConfig({ ...BASE_ENV, AIRLOCK_RUNTIME: "kata", AIRLOCK_DOCKER_RUNTIME_NAME: "io.containerd.kata.v2" }, "/tmp");
    expect(kata.ok).toBe(true);
    if (kata.ok) expect(kata.config.dockerRuntime).toBe("io.containerd.kata.v2");
    const custom = loadConfig({ ...BASE_ENV, AIRLOCK_RUNTIME: "kata", AIRLOCK_DOCKER_RUNTIME_NAME: "my-vm-rt" }, "/tmp");
    expect(custom.ok).toBe(true);
    const runc = loadConfig({ ...BASE_ENV, AIRLOCK_RUNTIME: "runc", AIRLOCK_DEV_UNSAFE: "1", AIRLOCK_DOCKER_RUNTIME_NAME: "io.containerd.runc.v2" }, "/tmp");
    expect(runc.ok).toBe(true);
    if (runc.ok) expect(runc.config.devUnsafe).toBe(true);
  });
});
