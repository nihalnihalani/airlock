import { describe, expect, test } from "bun:test";
import { requestDigestOf } from "@airlock/contracts";
import { HttpSupervisorClient, SupervisorFenceError, SupervisorNotFoundError, SupervisorUnavailableError, buildOperation } from "../src/supervisor-client.ts";
import { fakeHost } from "./helpers/fake-supervisor.ts";

type Seen = { url: string; method: string; auth: string | null; body: unknown };

function client(handler: (seen: Seen, n: number) => Response | Promise<Response>, retries = 2) {
  const seen: Seen[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    const entry = { url, method: init?.method ?? "GET", auth: headers.get("authorization"), body };
    seen.push(entry);
    return handler(entry, seen.length);
  }) as typeof fetch;
  const c = new HttpSupervisorClient({ baseUrl: "http://sup.test:4300/", token: "t".repeat(20), fetch: fetchImpl, retries, retryDelayMs: 0 });
  return { c, seen };
}
const ref = { taskId: "task-1", attemptId: "att-1", generation: 1 };
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const attemptState = { ref, role: "author", container: "c", status: "running", deadline: new Date().toISOString() };

describe("supervisor client", () => {
  test("mutating calls carry a bearer token and an Operation whose digest binds the body", async () => {
    const { c, seen } = client(() => ok(attemptState));
    await c.createAttempt({ ref, profileId: "fx-1", role: "author", absoluteDeadline: new Date().toISOString() });
    const call = seen[0]!;
    expect(call.url).toBe("http://sup.test:4300/attempts");
    expect(call.auth).toBe(`Bearer ${"t".repeat(20)}`);
    const body = call.body as { operation: { operationId: string; requestDigest: string } };
    expect(body.operation.operationId).toMatch(/^op-[a-f0-9]{24}$/);
    expect(body.operation.requestDigest).toBe(await requestDigestOf(body as Record<string, unknown>));
  });

  test("409 → SupervisorFenceError, 404 → NotFound, 503 → Unavailable after retries, never retried on 409", async () => {
    const fence = client(() => new Response(JSON.stringify({ error: "stale generation" }), { status: 409 }));
    await expect(fence.c.revoke({ ref })).rejects.toBeInstanceOf(SupervisorFenceError);
    expect(fence.seen).toHaveLength(1);
    const missing = client(() => new Response(JSON.stringify({ error: "unknown attempt" }), { status: 404 }));
    await expect(missing.c.destroy({ ref })).rejects.toBeInstanceOf(SupervisorNotFoundError);
    const down = client(() => new Response(JSON.stringify({ error: "docker unavailable" }), { status: 503 }));
    await expect(down.c.freeze({ ref })).rejects.toBeInstanceOf(SupervisorUnavailableError);
    expect(down.seen).toHaveLength(3);
  });

  test("a transport failure on a read (host, getAttempt) surfaces as SupervisorUnavailableError naming the supervisor, never a raw fetch error", async () => {
    const down = client(() => {
      throw new TypeError("Unable to connect. Is the computer able to access the url?");
    });
    const error = (await down.c.host().catch((e) => e as Error)) as Error;
    expect(error).toBeInstanceOf(SupervisorUnavailableError);
    expect(error.message).toContain("http://sup.test:4300");
    expect(error.message).toContain("Unable to connect");
    await expect(down.c.getAttempt("att-1")).rejects.toBeInstanceOf(SupervisorUnavailableError);
    // Reads are idempotent: the read is retried once before giving up.
    expect(down.seen.length).toBeGreaterThanOrEqual(2);
    // A caller-side cancellation is reported as an aborted call, not as an unreachable supervisor.
    const controller = new AbortController();
    const hanging = (async (_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("The operation was aborted")), { once: true }))) as typeof fetch;
    const slow = { c: new HttpSupervisorClient({ baseUrl: "http://sup.test:4300/", token: "t".repeat(20), fetch: hanging, retries: 0, retryDelayMs: 0 }) };
    const pending = slow.c.host(controller.signal).catch((e) => e as Error);
    controller.abort();
    const aborted = (await pending) as Error;
    expect(aborted).not.toBeInstanceOf(SupervisorUnavailableError);
    expect(aborted.message).toContain("aborted");
  });

  test("a transport failure is retried with the SAME operationId", async () => {
    const { c, seen } = client((_seen, n) => {
      if (n === 1) throw new TypeError("fetch failed");
      return ok({ kind: "write", byteLength: 3 });
    });
    const result = await c.authorTool({ ref, args: { kind: "write", path: "lib/mod.py", content: "abc" } });
    expect(result).toEqual({ kind: "write", byteLength: 3 });
    expect(seen).toHaveLength(2);
    const ops = seen.map((s) => (s.body as { operation: { operationId: string } }).operation.operationId);
    expect(ops[0]).toBe(ops[1]!);
    expect(seen[1]!.url).toBe("http://sup.test:4300/attempts/att-1/tool");
  });

  test("explicit operationId replay produces the same digest; different bodies differ", async () => {
    const a = await buildOperation({ ref, args: { kind: "exec", command: "ls" } }, "op-fixed");
    const b = await buildOperation({ ref, args: { kind: "exec", command: "ls" } }, "op-fixed");
    const d = await buildOperation({ ref, args: { kind: "exec", command: "rm" } }, "op-fixed");
    expect(a).toEqual(b);
    expect(a.requestDigest).not.toBe(d.requestDigest);
  });

  test("responses that fail schema validation or are not JSON are typed 502 errors", async () => {
    const bad = client(() => ok({ nope: true }));
    await expect(bad.c.getAttempt("att-1")).rejects.toMatchObject({ status: 502 });
    const html = client(() => new Response("<html>", { status: 200 }));
    await expect(html.c.host()).rejects.toMatchObject({ status: 502 });
    const good = client(() => ok(fakeHost()));
    expect((await good.c.host()).selectedRuntime).toBe("runc");
    expect(good.seen[0]!.auth).toContain("Bearer");
  });

  test("health needs no token; invalid attempt ids are refused locally", async () => {
    const { c, seen } = client(() => ok({ status: "ok", docker: true, host: fakeHost() }));
    expect((await c.health()).docker).toBe(true);
    expect(seen[0]!.auth).toBeNull();
    await expect(c.getAttempt("../x")).rejects.toMatchObject({ status: 400 });
    expect(seen).toHaveLength(1);
  });

  test("aborted signal stops retries", async () => {
    const controller = new AbortController();
    const { c, seen } = client(() => {
      controller.abort();
      throw new Error("boom");
    });
    await expect(c.revoke({ ref }, { signal: controller.signal })).rejects.toMatchObject({ message: "Call aborted" });
    expect(seen).toHaveLength(1);
  });
});
