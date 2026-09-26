/**
 * Bounded execution inside a sandbox.
 *
 * Command-receipt and quarantine semantics adapted from OpenMuse `apps/server/src/computer.ts`
 * (pin 205cc386b75aae1a862f3fdd43104b570c8d0911, MIT, OpenMuse contributors 2026): every command is
 * wrapped in coreutils `timeout` inside the container; a lost client, a stream error or a
 * supervisor-side deadline is reported as `controlLost` so the caller stops the whole container.
 * Never leave an unknown command running. Output is captured up to a combined byte cap; anything
 * beyond it is drained and discarded with `truncated: true`.
 *
 * Result shape follows the contracts `ExecResult` (itself borrowed from OpenBot agent-computer
 * shell.ts).
 */
import type { ExecResult } from "@airlock/contracts";
import type { DockerApi, ExecSpec } from "./docker-api";
import { describe, statusOf, dockerUnavailable } from "./errors";

export const SANDBOX_USER = "1000:1000";
/** Grace added on top of the in-container timeout before the supervisor abandons the exec. */
export const SUPERVISOR_GRACE_MS = 7_000;
/** How long to wait for Docker to report an exit code after the stream ends. */
const EXIT_CODE_WAIT_MS = 5_000;

export interface RunExecOptions {
  /** Supervisor-side hard limit for the exec to end (stream close). */
  timeoutMs: number;
  /** Combined stdout+stderr capture cap in bytes. */
  outputBytes: number;
  /** External cancellation (revoke/freeze). */
  signal?: AbortSignal;
}

export interface ExecOutcome {
  result: ExecResult;
  /**
   * True when the supervisor can no longer say what is running inside the container (client lost,
   * stream error, supervisor-side timeout). The caller must stop the container.
   */
  controlLost: boolean;
}

/** `timeout --signal=TERM --kill-after=2s <n>s /bin/bash --noprofile --norc -c <command>`; command is data. */
export function authorCommand(command: string, timeoutSeconds: number): string[] {
  return timedCommand(["/bin/bash", "--noprofile", "--norc", "-c", command], timeoutSeconds);
}

/** A fixed argv under coreutils `timeout`. */
export function timedCommand(argv: string[], timeoutSeconds: number): string[] {
  const seconds = Math.max(1, Math.ceil(timeoutSeconds));
  return ["/usr/bin/timeout", "--signal=TERM", "--kill-after=2s", `${seconds}s`, ...argv];
}

/** Docker multiplexed stream parser: 8-byte header {type, 0,0,0, len BE32} then payload. */
export class Demuxer {
  private buffer: Uint8Array = new Uint8Array(0);
  private pendingType: number | null = null;
  private pendingLength = 0;

  push(chunk: Uint8Array): { type: number; data: Uint8Array }[] {
    const merged = new Uint8Array(this.buffer.length + chunk.length);
    merged.set(this.buffer, 0);
    merged.set(chunk, this.buffer.length);
    this.buffer = merged;
    const frames: { type: number; data: Uint8Array }[] = [];
    for (;;) {
      if (this.pendingType === null) {
        if (this.buffer.length < 8) break;
        const type = this.buffer[0] ?? 0;
        const view = new DataView(this.buffer.buffer, this.buffer.byteOffset, this.buffer.byteLength);
        const length = view.getUint32(4, false);
        if (type > 2) {
          // Not multiplexed (should never happen with Tty=false). Treat the rest as stdout.
          frames.push({ type: 1, data: this.buffer });
          this.buffer = new Uint8Array(0);
          break;
        }
        this.pendingType = type;
        this.pendingLength = length;
        this.buffer = this.buffer.subarray(8);
        if (length === 0) {
          this.pendingType = null;
          continue;
        }
      }
      if (this.buffer.length === 0) break;
      const take = Math.min(this.pendingLength, this.buffer.length);
      frames.push({ type: this.pendingType, data: this.buffer.subarray(0, take) });
      this.buffer = this.buffer.subarray(take);
      this.pendingLength -= take;
      if (this.pendingLength === 0) this.pendingType = null;
    }
    return frames;
  }
}

/** Captures up to `cap` bytes across both channels; the rest is counted and discarded. */
class BoundedCapture {
  private readonly out: Uint8Array[] = [];
  private readonly err: Uint8Array[] = [];
  private captured = 0;
  truncated = false;
  constructor(private readonly cap: number) {}
  write(type: number, data: Uint8Array): void {
    const room = this.cap - this.captured;
    if (room <= 0) {
      if (data.length > 0) this.truncated = true;
      return;
    }
    const take = data.subarray(0, Math.min(room, data.length));
    if (take.length < data.length) this.truncated = true;
    (type === 2 ? this.err : this.out).push(new Uint8Array(take));
    this.captured += take.length;
  }
  text(type: 1 | 2): string {
    const parts = type === 2 ? this.err : this.out;
    const total = parts.reduce((n, p) => n + p.length, 0);
    const joined = new Uint8Array(total);
    let offset = 0;
    for (const p of parts) {
      joined.set(p, offset);
      offset += p.length;
    }
    return new TextDecoder("utf-8", { fatal: false }).decode(joined);
  }
}

export async function runExec(
  api: DockerApi,
  container: string,
  spec: ExecSpec,
  options: RunExecOptions,
): Promise<ExecOutcome> {
  const startedAt = Date.now();
  const capture = new BoundedCapture(Math.max(1, options.outputBytes));
  const controller = new AbortController();
  let interrupted = false;
  let supervisorTimedOut = false;
  let streamError: string | undefined;

  const onExternalAbort = () => {
    interrupted = true;
    controller.abort();
  };
  if (options.signal?.aborted) {
    return {
      controlLost: false,
      result: {
        status: "interrupted",
        exitCode: null,
        stdout: "",
        stderr: "Interrupted before execution: dispatch was revoked.",
        truncated: false,
        timedOut: false,
        durationMs: 0,
      },
    };
  }
  options.signal?.addEventListener("abort", onExternalAbort, { once: true });

  let session;
  try {
    session = await api.exec(container, spec, controller.signal);
  } catch (error) {
    options.signal?.removeEventListener("abort", onExternalAbort);
    const status = statusOf(error);
    // 404 no such container, 409 container stopped, 500 "container not running": nothing is running.
    if (status === 404 || status === 409 || (status === 500 && /not running|is not running|paused/i.test(describe(error)))) {
      return {
        controlLost: false,
        result: {
          status: "interrupted",
          exitCode: null,
          stdout: "",
          stderr: `The sandbox is not running (${describe(error)}).`,
          truncated: false,
          timedOut: false,
          durationMs: Date.now() - startedAt,
        },
      };
    }
    throw dockerUnavailable(error);
  }

  const demuxer = new Demuxer();
  const timer = setTimeout(() => {
    supervisorTimedOut = true;
    session.abort();
    controller.abort();
  }, Math.max(1, options.timeoutMs));

  await new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    session.stream.on("data", (chunk: Uint8Array | string) => {
      const bytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk;
      for (const frame of demuxer.push(bytes)) capture.write(frame.type, frame.data);
    });
    session.stream.once("end", done);
    session.stream.once("close", done);
    session.stream.once("error", (error: unknown) => {
      if (!supervisorTimedOut && !interrupted) {
        streamError = describe(error);
        interrupted = true;
      }
      done();
    });
    controller.signal.addEventListener("abort", () => {
      try {
        session.abort();
      } catch {
        // already torn down
      }
      // Give the stream a moment to emit close; then resolve regardless.
      setTimeout(done, 250);
    }, { once: true });
  });
  options.signal?.removeEventListener("abort", onExternalAbort);

  let exitCode: number | null = null;
  if (!supervisorTimedOut && !interrupted) {
    exitCode = await withTimeout(session.exitCode(), EXIT_CODE_WAIT_MS, null);
  }

  const durationMs = Date.now() - startedAt;
  const stdout = capture.text(1);
  let stderr = capture.text(2);
  const controlLost = supervisorTimedOut || interrupted;

  let status: ExecResult["status"];
  let timedOut = false;
  if (supervisorTimedOut) {
    status = "timed_out";
    timedOut = true;
    stderr = appendNote(stderr, "The supervisor deadline passed before the command ended; the sandbox is being stopped.");
  } else if (interrupted) {
    status = "interrupted";
    stderr = appendNote(
      stderr,
      streamError
        ? `Execution was interrupted (${streamError}); the sandbox is being stopped.`
        : "Execution was interrupted; the sandbox is being stopped.",
    );
  } else if (exitCode === null) {
    // The stream ended but Docker cannot say how the process exited. Do not invent a receipt.
    status = "interrupted";
    stderr = appendNote(stderr, "Docker did not report an exit code for this command.");
  } else if (exitCode === 124) {
    status = "timed_out";
    timedOut = true;
  } else if (exitCode === 0) {
    status = "succeeded";
  } else {
    status = "failed";
  }

  return {
    // An unknown exit code after a normal stream end is also loss of control: something may still run.
    controlLost: controlLost || exitCode === null,
    result: { status, exitCode, stdout, stderr, truncated: capture.truncated, timedOut, durationMs },
  };
}

function appendNote(stderr: string, note: string): string {
  return stderr.length === 0 ? note : `${stderr}\n${note}`;
}

async function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  try {
    return await Promise.race([promise.catch(() => fallback), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
