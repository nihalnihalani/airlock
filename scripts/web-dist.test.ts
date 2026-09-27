import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The guard dev-up.sh applies to AIRLOCK_WEB_DIST, run through bash exactly as the script sources it.
const LIB = join(import.meta.dir, "lib/web-dist.sh");
// File-backed stdio: under `bun test scripts/<file>` (a name filter) Bun 1.3.2 hands piped children
// a broken stdout (see live-gate.test.ts), so pipes read back "" there.
async function action(value: string, root: string): Promise<{ out: string; err: string; code: number }> {
  const logs = await mkdtemp(join(tmpdir(), "airlock-webdist-log-"));
  try {
    const proc = Bun.spawn(["bash", "-c", `source "$1" && web_dist_action "$2" "$3"`, "bash", LIB, value, root], { stdout: Bun.file(join(logs, "out")), stderr: Bun.file(join(logs, "err")) });
    const code = await proc.exited;
    const read = (name: string) => readFile(join(logs, name), "utf8").catch(() => "");
    return { out: (await read("out")).trim(), err: (await read("err")).trim(), code };
  } finally {
    await rm(logs, { recursive: true, force: true });
  }
}

describe("dev-up.sh AIRLOCK_WEB_DIST guard", () => {
  test("none and empty disable the UI instead of demanding a bundle (matches control's config.ts)", async () => {
    const root = await mkdtemp(join(tmpdir(), "airlock-webdist-"));
    await mkdir(join(root, "apps/web"), { recursive: true });
    expect(await action("none", root)).toEqual({ out: "skip", err: "", code: 0 });
    expect(await action("", root)).toEqual({ out: "skip", err: "", code: 0 });
  });

  test("every spelling of apps/web/dist rebuilds, even when a stale index.html is present", async () => {
    const root = await mkdtemp(join(tmpdir(), "airlock-webdist-"));
    await mkdir(join(root, "apps/web/dist"), { recursive: true });
    await writeFile(join(root, "apps/web/dist/index.html"), "<!doctype html>stale");
    await symlink(join(root, "apps/web/dist"), join(root, "dist-link"));
    for (const value of [`${root}/apps/web/dist`, `${root}/apps/web/dist/`, `${root}/apps/web/../web/dist`, `${root}/dist-link`]) {
      expect((await action(value, root)).out).toBe("build");
    }
    // The default is also recognised before the directory exists (first run).
    const fresh = await mkdtemp(join(tmpdir(), "airlock-webdist-"));
    await mkdir(join(fresh, "apps/web"), { recursive: true });
    expect((await action(`${fresh}/apps/web/dist`, fresh)).out).toBe("build");
  });

  test("another directory is served as is when built and refused when it has no index.html", async () => {
    const root = await mkdtemp(join(tmpdir(), "airlock-webdist-"));
    await mkdir(join(root, "apps/web"), { recursive: true });
    await mkdir(join(root, "elsewhere"));
    const missing = await action(join(root, "elsewhere"), root);
    expect(missing.code).toBe(2);
    expect(missing.err).toContain("has no index.html");
    await writeFile(join(root, "elsewhere/index.html"), "<!doctype html>");
    expect(await action(join(root, "elsewhere"), root)).toEqual({ out: "serve", err: "", code: 0 });
  });
});
