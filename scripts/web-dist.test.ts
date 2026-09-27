import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The guard dev-up.sh applies to AIRLOCK_WEB_DIST, run through bash exactly as the script sources it.
const LIB = join(import.meta.dir, "lib/web-dist.sh");
async function action(value: string, root: string): Promise<{ out: string; err: string; code: number }> {
  const proc = Bun.spawn(["bash", "-c", `source "$1" && web_dist_action "$2" "$3"`, "bash", LIB, value, root], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { out: out.trim(), err: err.trim(), code };
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
