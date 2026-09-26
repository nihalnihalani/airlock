import { describe, expect, test } from "bun:test";
import { Demuxer, authorCommand, runExec, timedCommand } from "../src/exec";
import { FakeDocker, frame } from "./fake-docker";

const SPEC = { cmd: ["/bin/true"], user: "1000:1000", workingDir: "/workspace" };

async function running(handler: ConstructorParameters<typeof FakeDocker>[0]): Promise<FakeDocker> {
  const docker = new FakeDocker(handler);
  await docker.createContainer({
    name: "c1",
    image: "img",
    labels: {},
    env: [],
    user: "1000:1000",
    workingDir: "/workspace",
    entrypoint: ["/usr/bin/sleep"],
    cmd: ["infinity"],
    hostname: "sandbox",
    hostConfig: {
      runtime: "runc",
      networkMode: "none",
      readonlyRootfs: true,
      capDrop: ["ALL"],
      securityOpt: ["no-new-privileges"],
      pidsLimit: 64,
      memory: 1,
      memorySwap: 1,
      nanoCpus: 1,
      ipcMode: "private",
      restartPolicy: { Name: "no" },
      tmpfs: {},
      mounts: [],
    },
  });
  await docker.startContainer("c1");
  return docker;
}

describe("exec", () => {
  test("demuxes frames split across chunks and separates stdout/stderr", () => {
    const d = new Demuxer();
    const enc = new TextEncoder();
    const bytes = new Uint8Array([...frame(1, enc.encode("hello ")), ...frame(2, enc.encode("oops")), ...frame(1, enc.encode("world"))]);
    const frames = [];
    for (let i = 0; i < bytes.length; i += 3) frames.push(...d.push(bytes.subarray(i, Math.min(i + 3, bytes.length))));
    const out = frames.filter((f) => f.type === 1).map((f) => new TextDecoder().decode(f.data)).join("");
    const err = frames.filter((f) => f.type === 2).map((f) => new TextDecoder().decode(f.data)).join("");
    expect(out).toBe("hello world");
    expect(err).toBe("oops");
  });

  test("bounds combined output and flags truncation", async () => {
    const docker = await running(() => ({ stdout: "x".repeat(10_000), stderr: "e".repeat(10_000), chunk: 1000 }));
    const outcome = await runExec(docker, "c1", SPEC, { timeoutMs: 5_000, outputBytes: 4_096 });
    expect(outcome.result.status).toBe("succeeded");
    expect(outcome.result.truncated).toBe(true);
    expect(outcome.result.stdout.length + outcome.result.stderr.length).toBe(4_096);
    expect(outcome.controlLost).toBe(false);
  });

  test("small output is captured exactly and not truncated", async () => {
    const docker = await running(() => ({ stdout: "1\n", stderr: "" }));
    const outcome = await runExec(docker, "c1", SPEC, { timeoutMs: 5_000, outputBytes: 65_536 });
    expect(outcome.result).toMatchObject({ status: "succeeded", exitCode: 0, stdout: "1\n", stderr: "", truncated: false, timedOut: false });
  });

  test("maps in-container timeout (exit 124) to timed_out without losing control", async () => {
    const docker = await running(() => ({ stdout: "", exitCode: 124 }));
    const outcome = await runExec(docker, "c1", SPEC, { timeoutMs: 5_000, outputBytes: 1024 });
    expect(outcome.result.status).toBe("timed_out");
    expect(outcome.result.timedOut).toBe(true);
    expect(outcome.result.exitCode).toBe(124);
    expect(outcome.controlLost).toBe(false);
  });

  test("non-zero exit is failed", async () => {
    const docker = await running(() => ({ stderr: "boom", exitCode: 3 }));
    const outcome = await runExec(docker, "c1", SPEC, { timeoutMs: 5_000, outputBytes: 1024 });
    expect(outcome.result.status).toBe("failed");
    expect(outcome.result.exitCode).toBe(3);
    expect(outcome.result.stderr).toBe("boom");
  });

  test("supervisor-side deadline on a hung stream → timed_out and control lost", async () => {
    const docker = await running(() => ({ stdout: "partial", hang: true }));
    const outcome = await runExec(docker, "c1", SPEC, { timeoutMs: 200, outputBytes: 1024 });
    expect(outcome.result.status).toBe("timed_out");
    expect(outcome.result.timedOut).toBe(true);
    expect(outcome.result.exitCode).toBeNull();
    expect(outcome.result.stdout).toBe("partial");
    expect(outcome.controlLost).toBe(true);
  });

  test("stream error → interrupted and control lost", async () => {
    const docker = await running(() => ({ error: "socket hang up" }));
    const outcome = await runExec(docker, "c1", SPEC, { timeoutMs: 5_000, outputBytes: 1024 });
    expect(outcome.result.status).toBe("interrupted");
    expect(outcome.controlLost).toBe(true);
    expect(outcome.result.stderr).toContain("socket hang up");
  });

  test("external revoke signal → interrupted and control lost", async () => {
    const docker = await running(() => ({ stdout: "", hang: true }));
    const controller = new AbortController();
    const pending = runExec(docker, "c1", SPEC, { timeoutMs: 5_000, outputBytes: 1024, signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    const outcome = await pending;
    expect(outcome.result.status).toBe("interrupted");
    expect(outcome.controlLost).toBe(true);
  });

  test("unknown exit code after a normal end is interrupted, never a receipt", async () => {
    const docker = await running(() => ({ stdout: "done", exitCode: null }));
    const outcome = await runExec(docker, "c1", SPEC, { timeoutMs: 5_000, outputBytes: 1024 });
    expect(outcome.result.status).toBe("interrupted");
    expect(outcome.result.exitCode).toBeNull();
    expect(outcome.controlLost).toBe(true);
  });

  test("a stopped container refuses without control loss", async () => {
    const docker = await running(() => ({ stdout: "" }));
    await docker.stopContainer("c1", 2);
    const outcome = await runExec(docker, "c1", SPEC, { timeoutMs: 5_000, outputBytes: 1024 });
    expect(outcome.result.status).toBe("interrupted");
    expect(outcome.controlLost).toBe(false);
  });

  test("command wrappers pass the author command as data", () => {
    expect(authorCommand("echo $(id) ; rm -rf /", 30)).toEqual([
      "/usr/bin/timeout",
      "--signal=TERM",
      "--kill-after=2s",
      "30s",
      "/bin/bash",
      "--noprofile",
      "--norc",
      "-c",
      "echo $(id) ; rm -rf /",
    ]);
    expect(timedCommand(["/bin/x"], 0.2)[3]).toBe("1s");
  });
});
