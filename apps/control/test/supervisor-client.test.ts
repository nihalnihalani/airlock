import { describe, expect, test } from "bun:test";
import { requestDigestOf } from "@airlock/contracts";
import { HttpSupervisorClient, SupervisorFenceError, SupervisorNotFoundError, SupervisorUnavailableError, buildOperation, supervisorOperationStatus } from "../src/supervisor-client.ts";
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
  test("C41 O2: getOperation reads GET /operations/:id; 404 → no record; recovery phrases", async () => {
    const at = new Date().toISOString();
    const rec = { operationId: "op-1", kind: "invoke", state: "completed", httpStatus: 200, resultRecorded: true, interruptedByRestart: false, taskId: "task-1", attemptId: null, generation: null, createdAt: at, updatedAt: at };
    const { c, seen } = client((s) => (s.url.endsWith("/op-1") ? ok(rec) : s.url.endsWith("/op-2") ? ok({ ...rec, operationId: "op-2", interruptedByRestart: true }) : new Response(JSON.stringify({ error: "Unknown operation." }), { status: 404 })));
    expect(await c.getOperation("op-1")).toEqual(rec as never);
    expect(seen[0]).toMatchObject({ url: "http://sup.test:4300/operations/op-1", method: "GET", auth: `Bearer ${"t".repeat(20)}` });
    await expect(c.getOperation("op-x")).rejects.toBeInstanceOf(SupervisorNotFoundError);
    await expect(c.getOperation("../x")).rejects.toThrow();
    expect(await supervisorOperationStatus(c, "op-1")).toMatchObject({ status: "completed", text: "supervisor: completed (HTTP 200); result discarded, not replayed" });
    expect((await supervisorOperationStatus(c, "op-2")).status).toBe("interrupted");
    expect(await supervisorOperationStatus(c, "op-x")).toEqual({ status: "no-record", text: "supervisor has no record" });
  });

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
    const { c, seen } = client(() => ok({ ok: true }));
    expect((await c.health()).ok).toBe(true);
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
  test("renew posts {ref, authorizedUntil, operation} to /attempts/:id/renew; 404/409 are typed (authority lost)", async () => {
    const until = new Date(Date.now() + 40_000).toISOString();
    const { c, seen } = client(() => ok({ ...attemptState, authorizedUntil: until }));
    const state = await c.renew({ ref, authorizedUntil: until });
    expect(state.authorizedUntil).toBe(until);
    expect(seen[0]!.url).toBe("http://sup.test:4300/attempts/att-1/renew");
    const body = seen[0]!.body as { ref: unknown; authorizedUntil: string; operation: { operationId: string; requestDigest: string } };
    expect(body.ref).toEqual(ref);
    expect(body.authorizedUntil).toBe(until);
    expect(body.operation.requestDigest).toBe(await requestDigestOf(body as Record<string, unknown>));
    const fenced = client(() => new Response(JSON.stringify({ error: "revoked" }), { status: 409 }));
    await expect(fenced.c.renew({ ref, authorizedUntil: until })).rejects.toBeInstanceOf(SupervisorFenceError);
    const gone = client(() => new Response(JSON.stringify({ error: "unknown attempt" }), { status: 404 }));
    await expect(gone.c.renew({ ref, authorizedUntil: until })).rejects.toBeInstanceOf(SupervisorNotFoundError);
  });

  test("createAttempt carries authorizedUntil only when given", async () => {
    const { c, seen } = client(() => ok(attemptState));
    const until = new Date(Date.now() + 40_000).toISOString();
    await c.createAttempt({ ref, profileId: "fx-1", role: "author", absoluteDeadline: new Date(Date.now() + 60_000).toISOString(), authorizedUntil: until });
    await c.createAttempt({ ref, profileId: "fx-1", role: "author", absoluteDeadline: new Date(Date.now() + 60_000).toISOString() });
    expect((seen[0]!.body as { authorizedUntil?: string }).authorizedUntil).toBe(until);
    expect("authorizedUntil" in (seen[1]!.body as object)).toBe(false);
  });

  test("beforeSend receives the exact Operation before anything is sent; if it throws, nothing is sent; retries replay the same id", async () => {
    const recorded: { operationId: string; requestDigest: string }[] = [];
    let sentBeforeHook = false;
    const flaky = client((_seen, n) => (n === 1 ? new Response("{}", { status: 503 }) : ok(attemptState)));
    await flaky.c.revoke({ ref }, { beforeSend: (op) => { sentBeforeHook = flaky.seen.length > 0; recorded.push(op); } });
    expect(sentBeforeHook).toBe(false);
    expect(recorded).toHaveLength(1);
    expect(flaky.seen).toHaveLength(2);
    for (const call of flaky.seen) expect((call.body as { operation: unknown }).operation).toEqual(recorded[0]);
    const refused = client(() => ok(attemptState));
    await expect(refused.c.destroy({ ref }, { beforeSend: () => { throw new Error("journal unavailable"); } })).rejects.toThrow("journal unavailable");
    expect(refused.seen).toHaveLength(0);
  });
});
