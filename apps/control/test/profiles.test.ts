import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadProfilesReport, loadProfile } from "../src/profiles.ts";
import { computeAdapterDigest } from "../src/repair-handler.ts";
import { makeFixture, type Fixture } from "./helpers/doubles.ts";

let fixture: Fixture;
beforeAll(async () => {
  fixture = await makeFixture();
});
afterAll(async () => {
  await fixture.cleanup();
});

describe("profiles", () => {
  test("loads a valid profile with contract digest and base files", async () => {
    const report = await loadProfilesReport(fixture.profilesDir);
    expect(report.skipped).toEqual([]);
    const p = report.profiles.get("fx-1")!;
    expect(p.contractDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.keys(p.baseFiles).sort()).toEqual(["README.md", "lib/mod.py"]);
    expect(p.manifest.referenceCommitMaintainerOnly).toBe("b".repeat(40));
    const digest = await computeAdapterDigest(fixture.runtimeDir, p);
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    // Changing the adapter module changes the adapter digest.
    const modulePath = join(p.dir, "fx_adapter.py");
    const original = await readFile(modulePath, "utf8");
    await writeFile(modulePath, original + "\n# changed\n");
    try {
      expect(await computeAdapterDigest(fixture.runtimeDir, p)).not.toBe(digest);
    } finally {
      await writeFile(modulePath, original);
    }
  });

  test("a tampered base tree is skipped with the digest mismatch reason", async () => {
    const dir = join(fixture.profilesDir, "fx-1");
    const path = join(dir, "base", "README.md");
    const original = await readFile(path, "utf8");
    await writeFile(path, original + "tampered\n");
    try {
      const report = await loadProfilesReport(fixture.profilesDir);
      expect(report.profiles.size).toBe(0);
      expect(report.skipped[0]?.reason).toContain("does not match profile.baselineTreeDigest");
    } finally {
      await writeFile(path, original);
    }
  });

  test("bad symlinks in the base tree, missing base, bad JSON and id mismatch are all refused", async () => {
    const dir = join(fixture.profilesDir, "fx-1");
    await symlink("/dev/null", join(dir, "base", "evil"));
    try {
      await expect(loadProfile(dir, "fx-1")).rejects.toThrow(/symlink to non-regular/);
    } finally {
      await rm(join(dir, "base", "evil"));
    }
    await symlink("./missing-target", join(dir, "base", "dangling"));
    try {
      await expect(loadProfile(dir, "fx-1")).rejects.toThrow(/broken symlink/);
    } finally {
      await rm(join(dir, "base", "dangling"));
    }
    await expect(loadProfile(dir, "other-id")).rejects.toThrow(/does not match directory/);
    const broken = join(fixture.root, "profiles-broken", "nb");
    await mkdir(broken, { recursive: true });
    await writeFile(join(broken, "profile.json"), await readFile(join(dir, "profile.json"), "utf8").then((t) => t.replace('"fx-1"', '"nb"')));
    await writeFile(join(broken, "contract.json"), "{not json");
    const report = await loadProfilesReport(join(fixture.root, "profiles-broken"));
    expect(report.skipped[0]?.reason).toContain("not valid JSON");
    await writeFile(join(broken, "contract.json"), await readFile(join(dir, "contract.json"), "utf8").then((t) => t.replace('"fx-1"', '"nb"')));
    const noBase = await loadProfilesReport(join(fixture.root, "profiles-broken"));
    expect(noBase.skipped[0]?.reason).toContain("base tree missing");
    await expect(loadProfilesReport(join(fixture.root, "does-not-exist"))).rejects.toThrow(/Cannot read profiles directory/);
  });

  test("the repository profile tabulate-365 loads and its base tree digest matches profile.json", async () => {
    const report = await loadProfilesReport(join(import.meta.dir, "../../../profiles"));
    for (const s of report.skipped) expect(s.reason).toMatch(/base tree missing/);
    const p = report.profiles.get("tabulate-365");
    if (!p) return; // base not prepared on this machine; the digest recipe is still covered by the fixture
    expect(p.manifest.baselineTreeDigest).toBe("d20b5bf8d4cefe19d3579d864269f0c04f7ded6f0a6ea75b93801b0e16693b06");
    expect(Object.keys(p.baseFiles)).toContain("tabulate/__init__.py");
    expect(p.contract.cases.length).toBe(6);
  });
});
