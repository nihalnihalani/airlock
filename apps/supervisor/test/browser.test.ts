/**
 * Browser plane against the fake Docker: creation order and admission of both containers, fail-closed
 * inspection of containers and networks, sandbox evidence, journaled runner operations (replay,
 * stale refs, interrupted runner), freeze refusal, teardown of containers + networks, expiry,
 * restart reconciliation and the janitor.
 */
import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { type AttemptRef, type AttemptState, type BrowserOp, type BrowserOpResult, requestDigestOf } from "@airlock/contracts";
import { browserCosts } from "../src/capacity";
import { type BrowserPlaneConfig, loadConfig } from "../src/config";
import { SupervisorError } from "../src/errors";
import { createApp } from "../src/index";
import { createSentinel } from "../src/hostile";
import { Supervisor } from "../src/lifecycle";
import { ATTEMPT_LABEL, NAMESPACE_LABEL, NETWORK_LABEL, OWNER_LABEL, ROLE_LABEL, TASK_LABEL } from "../src/names";
import { Journal } from "../src/operations";
import type { DestroyResult } from "../src/types";
import { classifyReply } from "../src/browser";
import { FakeDocker, type RunnerRequest, type ScriptedExec, defaultHandler, fakeRunner } from "./fake-docker";
import { PROFILE, fakeHost, future, operationFor, tempDir, testConfig } from "./helpers";

const REPO = resolve(import.meta.dir, "../../..");
const REF: AttemptRef = { taskId: "task1", attemptId: "b1", generation: 1 };
const NS = "airlocktest";
const BROWSER = `${NS}-browser-task1-b1`;
const EGRESS = `${NS}-egress-task1-b1`;
const BNET = `${NS}-bnet-task1-b1`;
const ENET = `${NS}-enet-task1-b1`;
const ALLOW = ["example.com", ".iana.org"];

const PLANE: BrowserPlaneConfig = {
  image: "airlock-browser:dev",
  imageId: undefined,
  egressImage: "airlock-egress:dev",
  egressImageId: undefined,
  seccompPath: "/x/chromium.json",
  seccompJson: JSON.stringify({ defaultAction: "SCMP_ACT_ERRNO", syscalls: [] }),
  memoryBytes: 2 * 1024 ** 3,
  pidsLimit: 256,
  shmBytes: 256 * 1024 ** 2,
  tmpBytes: 512 * 1024 ** 2,
  cpus: 1,
  egressMemoryBytes: 128 * 1024 ** 2,
  egressPidsLimit: 64,
  egressCpus: 0.5,
  attemptTimeoutMs: 30 * 60_000, mutationOrigins: [] as string[],
};

function make(docker: FakeDocker, options: { journal?: Journal; dir?: string; capacity?: Partial<ReturnType<typeof testConfig>["capacity"]>; browser?: BrowserPlaneConfig | undefined } = {}) {
  const dir = options.dir ?? tempDir();
  const journal = options.journal ?? new Journal(join(dir, "journal.sqlite"));
  const base = testConfig(dir);
  const core = new Supervisor({
    api: docker,
    journal,
    config: { ...base, capacity: { ...base.capacity, ...options.capacity }, browser: "browser" in options ? options.browser : PLANE },
    profiles: new Map([[PROFILE.id, PROFILE]]),
    host: fakeHost(),
    log: () => {},
    browserWaits: { healthMs: 500, listeningMs: 500, pollMs: 10 },
  });
  return { core, journal, dir };
}

async function createBrowser(core: Supervisor, extra: { egressAllow?: string[]; absoluteDeadline?: string; ref?: AttemptRef; opId?: string } = {}) {
  const ref = extra.ref ?? REF;
  const base = { ref, profileId: "browser", role: "browser" as const, absoluteDeadline: extra.absoluteDeadline ?? future(60_000), egressAllow: extra.egressAllow ?? ALLOW };
  return core.createAttempt({ ...base, operation: await operationFor(extra.opId ?? `create-${ref.attemptId}`, base) });
}

async function op(core: Supervisor, opId: string, request: BrowserOp, ref: AttemptRef = REF) {
  const body = { ref, request };
  const operation = await operationFor(opId, body);
  return { response: await core.browserOp(ref, operation, request), operation };
}

function err(e: unknown): SupervisorError {
  if (!(e instanceof SupervisorError)) throw e;
  return e;
}

describe("browser attempt creation", () => {
  test("order: networks → egress (both networks, listening) → browser → inspect → status → probe; both containers admitted", async () => {
    const docker = new FakeDocker();
    const { core, journal } = make(docker);
    const created = await createBrowser(core);
    const state = created.body as AttemptState;
    expect(state.status).toBe("running");
    expect(state.role).toBe("browser");
    expect(state.container).toBe(BROWSER);
    expect(state.inspection?.allPassed).toBe(true);
    // true to fact: not network none; the topology is enforced by the network checks instead
    expect(state.inspection?.checks.networkNone).toBe(false);
    expect(state.inspection?.checks.networkAsDesigned).toBe(true);
    expect(state.inspection?.imageId).toBe(`sha256:${"0".repeat(64)}`);
    expect(state.probe?.allBlocked).toBe(true);

    const seq = docker.calls.filter((c) => !c.startsWith("inspectContainer"));
    const at = (p: RegExp) => seq.findIndex((c) => p.test(c));
    const order = [
      at(new RegExp(`^createNetwork ${BNET} internal=true`)),
      at(new RegExp(`^createNetwork ${ENET} internal=false`)),
      at(new RegExp(`^createContainer ${EGRESS}`)),
      at(new RegExp(`^connectNetwork ${BNET} ${EGRESS}`)),
      at(new RegExp(`^startContainer ${EGRESS}`)),
      at(new RegExp(`^createContainer ${BROWSER}`)),
      at(new RegExp(`^startContainer ${BROWSER}`)),
      at(new RegExp(`^exec ${BROWSER} .*client\\.mjs`)),
      at(new RegExp(`^exec ${BROWSER} .*node -e`)),
    ];
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);

    // Specs as designed
    const browser = docker.containers.get(BROWSER)!.spec;
    expect(browser.hostConfig.networkMode).toBe(BNET);
    expect(browser.user).toBe("1001:1001");
    expect(browser.hostConfig.securityOpt).toEqual(["no-new-privileges", `seccomp=${PLANE.seccompJson}`]);
    expect(browser.hostConfig.shmSize).toBe(PLANE.shmBytes);
    expect(browser.hostConfig.tmpfs["/tmp"]).toContain(`size=${PLANE.tmpBytes}`);
    expect(browser.hostConfig.tmpfs["/run/airlock"]).toContain("mode=0700,uid=1001");
    expect(browser.env).toEqual([`AIRLOCK_PROXY=http://${EGRESS}:3128`, "AIRLOCK_BROWSER_MUTATION_ORIGINS=[]"]);
    expect([...docker.containers.get(BROWSER)!.networks]).toEqual([BNET]);
    const egress = docker.containers.get(EGRESS)!.spec;
    expect(egress.hostConfig.securityOpt).toEqual(["no-new-privileges"]);
    expect(egress.env).toContain(`AIRLOCK_EGRESS_ALLOW=${JSON.stringify(ALLOW)}`);
    expect([...docker.containers.get(EGRESS)!.networks].sort()).toEqual([BNET, ENET].sort());
    expect(docker.networks.get(BNET)?.spec.options["com.docker.network.bridge.name"]).toMatch(/^ali[0-9a-f]{12}$/);
    expect(docker.networks.get(ENET)?.spec.options["com.docker.network.bridge.name"]).toMatch(/^ale[0-9a-f]{12}$/);
    expect(docker.networks.get(BNET)?.spec.labels).toMatchObject({ [OWNER_LABEL]: "true", [NAMESPACE_LABEL]: NS, [TASK_LABEL]: "task1", [ATTEMPT_LABEL]: "b1", [NETWORK_LABEL]: "internal" });

    // Admission: both containers reserved, each at its own cost
    const costs = browserCosts(PLANE, testConfig("/x").capacity);
    const usage = core.capacity.usage();
    expect(usage.used.sandboxes).toBe(2);
    expect(usage.used.memoryBytes).toBe(costs.browser.memoryBytes + costs.egress.memoryBytes);
    expect(usage.used.pids).toBe(PLANE.pidsLimit + PLANE.egressPidsLimit);

    const evidence = core.browserEvidence("b1");
    expect(evidence?.status.sandbox.zygotePresent).toBe(true);
    expect(evidence?.egressInspection.allPassed).toBe(true);
    expect(evidence?.egressInspection.imageId).toBe(`sha256:${"0".repeat(64)}`);
    expect(evidence?.egressInspection.checks.networkAsDesigned).toBe(true);
    expect(evidence?.networks).toEqual({ internal: BNET, egress: ENET });
    expect(journal.getBrowser("b1")?.egressAllow).toEqual(ALLOW);
    core.stop();
  });

  test("admission covers both containers: a host that fits only one refuses with 429 before any Docker call", async () => {
    const docker = new FakeDocker();
    const { core } = make(docker, { capacity: { memoryBytes: PLANE.memoryBytes + 64 * 1024 ** 2 } });
    const refused = err(await createBrowser(core).catch((e) => e));
    expect(refused.code).toBe("capacity");
    expect(refused.status).toBe(429);
    expect(docker.calls.some((c) => /^create/.test(c))).toBe(false);
    expect(core.capacity.used().sandboxes).toBe(0);
    // sandboxes limit counts both containers too
    const two = make(new FakeDocker(), { capacity: { maxSandboxes: 1 } });
    expect(err(await createBrowser(two.core).catch((e) => e)).code).toBe("capacity");
    core.stop();
    two.core.stop();
  });

  test("request validation: plane not configured, wrong profile, bad allowlist entries, egressAllow on author", async () => {
    const off = make(new FakeDocker(), { browser: undefined });
    expect(err(await createBrowser(off.core).catch((e) => e)).code).toBe("unsupported_profile");
    const { core } = make(new FakeDocker());
    const wrongProfile = { ref: REF, profileId: PROFILE.id, role: "browser" as const, absoluteDeadline: future(60_000) };
    expect(err(await core.createAttempt({ ...wrongProfile, operation: await operationFor("wp", wrongProfile) }).catch((e) => e)).code).toBe("invalid_body");
    expect(err(await createBrowser(core, { egressAllow: [".com"], opId: "c2" }).catch((e) => e)).code).toBe("invalid_body");
    expect(err(await createBrowser(core, { egressAllow: ["10.0.0.1"], opId: "c3" }).catch((e) => e)).code).toBe("invalid_body");
    const author = { ref: { ...REF, attemptId: "a1" }, profileId: PROFILE.id, role: "author" as const, absoluteDeadline: future(60_000), egressAllow: ["example.com"] };
    expect(err(await core.createAttempt({ ...author, operation: await operationFor("a1", author) }).catch((e) => e)).code).toBe("invalid_body");
    off.core.stop();
    core.stop();
  });

  test("an empty allowlist is passed as [] (deny all)", async () => {
    const docker = new FakeDocker();
    const { core } = make(docker);
    await createBrowser(core, { egressAllow: [] });
    expect(docker.containers.get(EGRESS)!.spec.env).toContain("AIRLOCK_EGRESS_ALLOW=[]");
    core.stop();
  });

  const refusals: [string, (docker: FakeDocker) => void, "inspection_failed" | "probe_failed"][] = [
    ["browser gains a capability", (d) => (d.tamper = (x) => (x.name === BROWSER ? { ...x, hostConfig: { ...x.hostConfig, CapAdd: ["SYS_ADMIN"] } } : x)), "inspection_failed"],
    ["browser attached to a second network", (d) => (d.tamper = (x) => (x.name === BROWSER ? { ...x, networks: { ...x.networks, bridge: {} } } : x)), "inspection_failed"],
    ["browser without the custom seccomp profile", (d) => (d.tamper = (x) => (x.name === BROWSER ? { ...x, hostConfig: { ...x.hostConfig, SecurityOpt: ["no-new-privileges"] } } : x)), "inspection_failed"],
    ["egress publishes a port", (d) => (d.tamper = (x) => (x.name === EGRESS ? { ...x, hostConfig: { ...x.hostConfig, PortBindings: { "3128/tcp": [{ HostPort: "3128" }] } } } : x)), "inspection_failed"],
    ["egress runs as root", (d) => (d.tamper = (x) => (x.name === EGRESS ? { ...x, config: { ...x.config, user: "0:0" } } : x)), "inspection_failed"],
    ["egress has a host bind", (d) => (d.tamper = (x) => (x.name === EGRESS ? { ...x, hostConfig: { ...x.hostConfig, Binds: ["/:/host"] } } : x)), "inspection_failed"],
    ["internal network is not internal", (d) => (d.tamperNetwork = (n) => (n.name === BNET ? { ...n, internal: false } : n)), "inspection_failed"],
    ["network with IPv6 enabled", (d) => (d.tamperNetwork = (n) => (n.name === ENET ? { ...n, enableIPv6: true } : n)), "inspection_failed"],
    ["egress proxy exits at start (config error)", (d) => (d.egressFails = true), "inspection_failed"],
    ["browser never becomes healthy", (d) => (d.health = () => "starting"), "inspection_failed"],
    [
      "Chromium runs with --no-sandbox",
      (d) =>
        (d.handler = defaultHandler({
          runner: fakeRunner({ status: (req) => ({ stdout: `${JSON.stringify({ schemaVersion: 1, id: req.id, op: "status", ok: true, result: { ready: true, browserVersion: "x", generation: 0, activeTabId: "tab-1", tabCount: 1, uid: 1001, proxy: `http://${EGRESS}:3128`, sandbox: { chromiumProcesses: 3, anyNoSandboxFlag: true, zygotePresent: false, renderersInNestedPidNamespace: false, renderers: 1 } } })}\n` }) }),
        })),
      "probe_failed",
    ],
    [
      "runner has no mutation guard (old image)",
      (d) =>
        (d.handler = defaultHandler({
          runner: fakeRunner({ status: (req) => ({ stdout: `${JSON.stringify({ schemaVersion: 1, id: req.id, op: "status", ok: true, result: { ready: true, browserVersion: "x", generation: 0, activeTabId: "tab-1", tabCount: 1, uid: 1001, proxy: `http://${EGRESS}:3128`, sandbox: { chromiumProcesses: 5, anyNoSandboxFlag: false, zygotePresent: true, renderersInNestedPidNamespace: true, renderers: 1 } } })}\n` }) }),
        })),
      "probe_failed",
    ],
    [
      "runner reports different mutation origins than configured",
      (d) =>
        (d.handler = defaultHandler({
          runner: fakeRunner({ status: (req) => ({ stdout: `${JSON.stringify({ schemaVersion: 1, id: req.id, op: "status", ok: true, result: { ready: true, browserVersion: "x", generation: 0, activeTabId: "tab-1", tabCount: 1, uid: 1001, proxy: `http://${EGRESS}:3128`, sandbox: { chromiumProcesses: 5, anyNoSandboxFlag: false, zygotePresent: true, renderersInNestedPidNamespace: true, renderers: 1 }, mutationGuard: { installed: true, origins: ["https://evil.test"], websockets: "blocked", blocked: 0 } } })}\n` }) }),
        })),
      "probe_failed",
    ],
    ["isolation probe reaches the metadata endpoint", (d) => (d.handler = defaultHandler({ browserProbe: { stdout: `${JSON.stringify({ metadataEndpoint: "REACHED", dns: "BLOCKED", outboundTcp: "BLOCKED", dockerSocket: "BLOCKED", hostMounts: "BLOCKED", allBlocked: true })}\n` } })), "probe_failed"],
    ["runner status transport failure (exit 3)", (d) => (d.handler = defaultHandler({ runner: fakeRunner({ status: () => ({ stdout: `${JSON.stringify({ schemaVersion: 1, id: null, op: null, ok: false, error: "runner_unavailable", message: "ECONNREFUSED" })}\n`, exitCode: 3 }) }) })), "probe_failed"],
  ];
  for (const [name, arrange, code] of refusals) {
    test(`fails closed and removes everything: ${name}`, async () => {
      const docker = new FakeDocker();
      arrange(docker);
      const { core, journal } = make(docker);
      const refused = err(await createBrowser(core).catch((e) => e));
      expect(refused.code).toBe(code);
      expect(docker.containers.size).toBe(0);
      expect(docker.networks.size).toBe(0);
      expect(journal.getAttempt("b1")?.status).toBe("destroyed");
      expect(journal.isTombstoned("b1")).toBe(true);
      expect(core.capacity.used().sandboxes).toBe(0);
      core.stop();
    });
  }
});

describe("browser operations", () => {
  test("journaled dispatch: request on stdin via head -c, per-op timeouts, generationBefore, duplicate id replays without a second exec", async () => {
    const docker = new FakeDocker();
    const seen: { spec: string[]; stdin: string; env: string[] }[] = [];
    const inner = defaultHandler();
    docker.handler = (container, spec) => {
      if (spec.cmd.join(" ").includes("client.mjs")) seen.push({ spec: spec.cmd, stdin: new TextDecoder().decode(spec.stdin), env: spec.env ?? [] });
      return inner(container, spec);
    };
    const { core } = make(docker);
    await createBrowser(core);
    const nav = await op(core, "nav1", { op: "navigate", args: { url: "https://example.com/" } });
    const result = nav.response.body as BrowserOpResult;
    expect(result.status).toBe("completed");
    expect(result.response).toMatchObject({ ok: true, id: "nav1", op: "navigate" });
    expect(result.generationBefore).toBe(0);
    const last = seen[seen.length - 1]!;
    expect(JSON.parse(last.stdin)).toEqual({ schemaVersion: 1, id: "nav1", op: "navigate", args: { url: "https://example.com/" } });
    expect(last.spec).toContain(String(Buffer.byteLength(last.stdin)));
    expect(last.spec.slice(0, 4)).toEqual(["/usr/bin/timeout", "--signal=TERM", "--kill-after=2s", "38s"]);
    expect(last.env).toEqual(["AIRLOCK_CLIENT_TIMEOUT_MS=35000"]);

    const execs = docker.calls.filter((c) => c.startsWith("exec ")).length;
    const replay = await core.browserOp(REF, nav.operation, { op: "navigate", args: { url: "https://example.com/" } });
    expect(replay).toEqual(nav.response);
    expect(docker.calls.filter((c) => c.startsWith("exec ")).length).toBe(execs);
    const conflict = err(await core.browserOp(REF, { operationId: "nav1", requestDigest: "f".repeat(64) }, { op: "observe" }).catch((e) => e));
    expect(conflict.code).toBe("operation_conflict");

    const obs = (await op(core, "obs1", { op: "observe" })).response.body as BrowserOpResult;
    expect(obs.generationBefore).toBe(1);
    expect(obs.response?.ok).toBe(true);
    core.stop();
  });

  test("stale reference is a completed runner refusal, not an interruption", async () => {
    const { core } = make(new FakeDocker());
    await createBrowser(core);
    const obs = (await op(core, "o1", { op: "observe" })).response.body as BrowserOpResult;
    const generation = (obs.response as { result: { generation: number } }).result.generation;
    const click = (await op(core, "c1", { op: "click", args: { ref: "e1", generation } })).response.body as BrowserOpResult;
    expect(click.status).toBe("completed");
    const stale = (await op(core, "c2", { op: "click", args: { ref: "e1", generation } })).response.body as BrowserOpResult;
    expect(stale.status).toBe("completed");
    expect(stale.response).toMatchObject({ ok: false, error: "stale_reference" });
    expect(core.getAttempt("b1")?.status).toBe("running");
    core.stop();
  });

  test("screenshot is verified (PNG, byte count, sha256)", async () => {
    const { core } = make(new FakeDocker());
    await createBrowser(core);
    const shot = (await op(core, "s1", { op: "screenshot" })).response.body as BrowserOpResult;
    expect(shot.status).toBe("completed");
    core.stop();
  });

  const lost: [string, (req: RunnerRequest) => ScriptedExec][] = [
    ["malformed reply", () => ({ stdout: "not json\n" })],
    ["client exit 3 (runner unavailable)", (req) => ({ stdout: `${JSON.stringify({ schemaVersion: 1, id: null, op: null, ok: false, error: "runner_unavailable", message: "gone" })}\n`, exitCode: 3 })],
    ["reply for another request", (req) => ({ stdout: `${JSON.stringify({ schemaVersion: 1, id: "other", op: req.op, ok: true, result: { generation: 3, tabId: "tab-1", url: "x", status: 200 } })}\n` })],
    ["oversized reply", () => ({ stdout: "x".repeat(4 * 1024 * 1024 + 70 * 1024) })],
    ["exit 0 but a result that fails its schema", (req) => ({ stdout: `${JSON.stringify({ schemaVersion: 1, id: req.id, op: req.op, ok: true, result: { nope: true } })}\n` })],
  ];
  for (const [name, reply] of lost) {
    test(`lost runner → interrupted, attempt revoked and both containers stopped: ${name}`, async () => {
      const docker = new FakeDocker();
      const { core, journal } = make(docker);
      await createBrowser(core);
      docker.handler = defaultHandler({ runner: fakeRunner({ navigate: (req) => reply(req) }) });
      const started = Date.now();
      const nav = await op(core, "n1", { op: "navigate", args: { url: "https://example.com/" } });
      const result = nav.response.body as BrowserOpResult;
      expect(result.status).toBe("interrupted");
      expect(journal.getAttempt("b1")?.revoked).toBe(true);
      expect(docker.containers.get(BROWSER)?.running).toBe(false);
      expect(docker.containers.get(EGRESS)?.running).toBe(false);
      // never replayed: the same id returns the recorded interruption without another exec
      const execs = docker.calls.filter((c) => c.startsWith("exec ")).length;
      expect((await core.browserOp(REF, nav.operation, { op: "navigate", args: { url: "https://example.com/" } })).body).toEqual(result);
      expect(docker.calls.filter((c) => c.startsWith("exec ")).length).toBe(execs);
      // dispatch is closed
      expect(err(await op(core, "n2", { op: "observe" }).catch((e) => e)).code).toBe("revoked");
      expect(Date.now() - started).toBeLessThan(10_000);
      core.stop();
    }, 60_000);
  }

  test("a supervisor-side timeout or lost control is always an interruption (classifyReply)", () => {
    const good = `${JSON.stringify({ schemaVersion: 1, id: "x1", op: "observe", ok: true, result: {} })}\n`;
    for (const outcome of [
      { status: "timed_out", exitCode: null, stdout: "", truncated: false, controlLost: true },
      { status: "interrupted", exitCode: null, stdout: good, truncated: false, controlLost: true },
      { status: "succeeded", exitCode: 0, stdout: good, truncated: true, controlLost: false },
      { status: "failed", exitCode: 1, stdout: good, truncated: false, controlLost: false },
      { status: "timed_out", exitCode: 124, stdout: "", truncated: false, controlLost: false },
    ]) {
      expect(classifyReply({ op: "observe" }, "x1", outcome).kind).toBe("interrupted");
    }
    const refused = `${JSON.stringify({ schemaVersion: 1, id: null, op: null, ok: false, error: "request_too_large", message: "big" })}\n`;
    expect(classifyReply({ op: "observe" }, "x1", { status: "failed", exitCode: 2, stdout: refused, truncated: false, controlLost: false }).kind).toBe("refused");
  });

  test("a screenshot whose bytes do not match its sha256 is an interruption", async () => {
    const docker = new FakeDocker();
    const { core } = make(docker);
    await createBrowser(core);
    docker.handler = defaultHandler({
      runner: fakeRunner({ screenshot: (req) => ({ stdout: `${JSON.stringify({ schemaVersion: 1, id: req.id, op: "screenshot", ok: true, result: { png: Buffer.from("\x89PNG\r\n\x1a\nzz").toString("base64"), bytes: 10, sha256: "0".repeat(64), width: 1, height: 1, url: "x", tabId: "tab-1", generation: 0, capturedAt: "t" } })}\n` }) }),
    });
    const shot = (await op(core, "s1", { op: "screenshot" })).response.body as BrowserOpResult;
    expect(shot.status).toBe("interrupted");
    core.stop();
  });

  test("operations are serialized per attempt (one runner op at a time)", async () => {
    const docker = new FakeDocker();
    const { core } = make(docker);
    await createBrowser(core);
    let active = 0;
    let peak = 0;
    const inner = defaultHandler();
    docker.handler = (container, spec) => {
      const out = inner(container, spec);
      if (!spec.cmd.join(" ").includes("client.mjs")) return out;
      active += 1;
      peak = Math.max(peak, active);
      setTimeout(() => (active -= 1), 40);
      return { ...out, delayMs: 40 };
    };
    await Promise.all([op(core, "p1", { op: "observe" }), op(core, "p2", { op: "observe" }), op(core, "p3", { op: "observe" })]);
    expect(peak).toBe(1);
    core.stop();
  });

  test("author tools, freeze and browser ops on the wrong role are refused (409)", async () => {
    const { core } = make(new FakeDocker());
    await createBrowser(core);
    expect(err(await core.freeze(REF, await operationFor("f1", { ref: REF })).catch((e) => e)).status).toBe(409);
    expect(err(await core.authorTool(REF, await operationFor("t1", {}), { kind: "exec", command: "id" }).catch((e) => e)).code).toBe("fenced");
    core.stop();
  });

  test("the HTTP route validates the digest and path, and returns BrowserOpResult", async () => {
    const dir = tempDir();
    const { core } = make(new FakeDocker(), { dir });
    await createBrowser(core);
    const app = createApp({ core, token: testConfig(dir).token, sentinel: await createSentinel(dir) });
    const auth = { authorization: `Bearer ${testConfig(dir).token}`, "content-type": "application/json" };
    const request = { op: "navigate", args: { url: "https://example.com/" } };
    const body = { ref: REF, request, operation: { operationId: "h1", requestDigest: await requestDigestOf({ ref: REF, request, operation: { operationId: "h1" } }) } };
    const ok = await app.request("/attempts/b1/browser", { method: "POST", headers: auth, body: JSON.stringify(body) });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as BrowserOpResult).status).toBe("completed");
    const tampered = await app.request("/attempts/b1/browser", { method: "POST", headers: auth, body: JSON.stringify({ ...body, request: { op: "observe" } }) });
    expect(tampered.status).toBe(400);
    const badOp = await app.request("/attempts/b1/browser", { method: "POST", headers: auth, body: JSON.stringify({ ...body, request: { op: "evaluate", args: {} } }) });
    expect(badOp.status).toBe(400);
    const evidence = await app.request("/attempts/b1/browser", { headers: auth });
    expect(evidence.status).toBe(200);
    const egress = await app.request("/attempts/b1/egress", { headers: auth });
    expect(egress.status).toBe(200);
    const unauth = await app.request("/attempts/b1/egress");
    expect(unauth.status).toBe(401);
    core.stop();
  });
});

describe("browser teardown, expiry, restart, janitor", () => {
  test("destroy removes both containers and both networks; clean teardown; egress evidence is kept", async () => {
    const docker = new FakeDocker();
    const { core } = make(docker);
    await createBrowser(core);
    const decision = (d: string, host: string, reason: string) => JSON.stringify({ ts: new Date().toISOString(), event: "decision", method: "CONNECT", host, port: 443, decision: d, reason, ...(d === "deny" ? { status: 403 } : { address: "93.184.215.14" }) });
    docker.logs.set(EGRESS, `${docker.logs.get(EGRESS)}${decision("allow", "example.com", "allowlisted")}\n${decision("deny", "www.wikipedia.org", "host_not_allowed")}\nnot json\n`);
    const live = await core.egressEvidence("b1");
    expect(live?.source).toBe("live");
    expect(live?.summary).toEqual({ allowed: 1, denied: 1 });
    expect(live?.listening?.allowSuffixes).toEqual([".iana.org"]);

    const destroyed = await core.destroy(REF, await operationFor("d1", { ref: REF }));
    const result = destroyed.body as DestroyResult & { egressSummary?: { allowed: number; denied: number }; teardown: { networksRemaining: string[] } };
    expect(result.teardown.clean).toBe(true);
    expect(result.teardown.containersRemaining).toEqual([]);
    expect(result.teardown.networksRemaining).toEqual([]);
    expect(result.egressSummary).toEqual({ allowed: 1, denied: 1 });
    expect(docker.containers.size).toBe(0);
    expect(docker.networks.size).toBe(0);
    // networks removed only after both containers
    const removeNet = docker.calls.findIndex((c) => c.startsWith(`removeNetwork ${BNET}`));
    expect(removeNet).toBeGreaterThan(docker.calls.findIndex((c) => c.startsWith(`removeContainer ${EGRESS}`)));
    expect(core.capacity.used().sandboxes).toBe(0);
    const recorded = await core.egressEvidence("b1");
    expect(recorded?.source).toBe("recorded");
    expect(recorded?.decisions.map((d) => d.host)).toEqual(["example.com", "www.wikipedia.org"]);
    core.stop();
  });

  test("a network that cannot be removed keeps the teardown unclean and the attempt unknown", async () => {
    const docker = new FakeDocker();
    const { core, journal } = make(docker);
    await createBrowser(core);
    docker.networks.get(BNET)!.containers.add("someone-else");
    const result = (await core.destroy(REF, await operationFor("d1", { ref: REF }))).body as { teardown: { clean: boolean; networksRemaining: string[] } };
    expect(result.teardown.clean).toBe(false);
    expect(result.teardown.networksRemaining).toEqual([BNET]);
    expect(journal.getAttempt("b1")?.status).toBe("unknown");
    core.stop();
  }, 20_000);

  test("revoke stops both containers; renew works like author attempts", async () => {
    const docker = new FakeDocker();
    const { core } = make(docker);
    await createBrowser(core);
    const renewed = await core.renew(REF, await operationFor("r1", { ref: REF, authorizedUntil: future(30_000) }), future(30_000));
    expect((renewed.body as AttemptState).authorizedUntil).toBeDefined();
    await core.revoke(REF, await operationFor("v1", { ref: REF }));
    expect(docker.containers.get(BROWSER)?.running).toBe(false);
    expect(docker.containers.get(EGRESS)?.running).toBe(false);
    expect(err(await op(core, "n1", { op: "observe" }).catch((e) => e)).code).toBe("revoked");
    core.stop();
  });

  test("deadline expiry revokes and stops both containers", async () => {
    const docker = new FakeDocker();
    const { core, journal } = make(docker);
    await createBrowser(core, { absoluteDeadline: future(400) });
    await new Promise((r) => setTimeout(r, 700));
    expect(journal.getAttempt("b1")?.revoked).toBe(true);
    expect(docker.containers.get(BROWSER)?.running).toBe(false);
    expect(docker.containers.get(EGRESS)?.running).toBe(false);
    core.stop();
  });

  test("restart reconcile: a live browser attempt is revoked, both containers stopped, marked unknown", async () => {
    const docker = new FakeDocker();
    const dir = tempDir();
    const first = make(docker, { dir });
    await createBrowser(first.core);
    first.core.stop();
    const second = make(docker, { dir, journal: first.journal });
    await second.core.start();
    const record = first.journal.getAttempt("b1");
    expect(record?.revoked).toBe(true);
    expect(record?.status).toBe("unknown");
    expect(docker.containers.get(BROWSER)?.running).toBe(false);
    expect(docker.containers.get(EGRESS)?.running).toBe(false);
    // both containers were adopted into the host budget at their browser-plane costs
    expect(second.core.capacity.used().sandboxes).toBe(2);
    // the janitor keeps the attempt's containers and networks (still recorded) until destroy
    expect(docker.networks.size).toBe(2);
    const result = (await second.core.destroy(REF, await operationFor("d1", { ref: REF }))).body as DestroyResult;
    expect(result.teardown.clean).toBe(true);
    expect(second.core.capacity.used().sandboxes).toBe(0);
    second.core.stop();
  });

  test("janitor removes an owned network no live attempt claims, never a live attempt's", async () => {
    const docker = new FakeDocker();
    const { core } = make(docker);
    await createBrowser(core);
    await docker.createNetwork({ name: `${NS}-bnet-task9-gone`, labels: { [OWNER_LABEL]: "true", [NAMESPACE_LABEL]: NS, [ATTEMPT_LABEL]: "gone", [ROLE_LABEL]: "browser" }, internal: true, options: {} });
    const report = await core.janitor();
    expect(report.removedUnknown).toContain(`${NS}-bnet-task9-gone`);
    expect(docker.networks.has(BNET)).toBe(true);
    expect(docker.networks.has(ENET)).toBe(true);
    expect(docker.containers.has(EGRESS)).toBe(true);
    const listing = await core.hostListing();
    expect(listing.networks).toEqual([BNET, ENET].sort());
    core.stop();
  });
});

describe("browser plane configuration", () => {
  const env = { SUPERVISOR_TOKEN: "x".repeat(24), AIRLOCK_RUNTIME: "runc", AIRLOCK_DEV_UNSAFE: "1" };
  test("off unless AIRLOCK_BROWSER_IMAGE is set; defaults and overrides", () => {
    const off = loadConfig(env, REPO);
    expect(off.ok && off.config.browser).toBeUndefined();
    const on = loadConfig({ ...env, AIRLOCK_BROWSER_IMAGE: "airlock-browser:dev", AIRLOCK_BROWSER_MEMORY_BYTES: "1073741824" }, REPO);
    if (!on.ok) throw new Error(on.reason);
    expect(on.config.browser).toMatchObject({ image: "airlock-browser:dev", egressImage: "airlock-egress:dev", memoryBytes: 1073741824, pidsLimit: 256, shmBytes: 268435456, tmpBytes: 536870912 });
    expect(on.config.browser?.seccompPath).toBe(join(REPO, "runtime/browser/seccomp/chromium.json"));
    expect(JSON.parse(on.config.browser!.seccompJson).defaultAction).toBe("SCMP_ACT_ERRNO");
  });
  test("outside dev-unsafe the browser and egress image IDs are required; a bad seccomp path refuses", () => {
    const prod = { SUPERVISOR_TOKEN: "x".repeat(24), AIRLOCK_RUNTIME: "runsc", AIRLOCK_RUNTIME_IMAGE_ID: `sha256:${"a".repeat(64)}`, AIRLOCK_BROWSER_IMAGE: "airlock-browser:dev" };
    const missing = loadConfig(prod, REPO);
    expect(missing.ok).toBe(false);
    const pinned = loadConfig({ ...prod, AIRLOCK_BROWSER_IMAGE_ID: `sha256:${"b".repeat(64)}`, AIRLOCK_EGRESS_IMAGE_ID: `sha256:${"c".repeat(64)}` }, REPO);
    expect(pinned.ok).toBe(true);
    const badSeccomp = loadConfig({ ...env, AIRLOCK_BROWSER_IMAGE: "airlock-browser:dev", AIRLOCK_BROWSER_SECCOMP: "/nonexistent.json" }, REPO);
    expect(badSeccomp.ok).toBe(false);
  });
});
