import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadScriptedTurns, openScriptedCatalog } from "../src/scripted.ts";
import { createScriptedDriver } from "../src/vultr-client.ts";

const fixtures = new URL("./fixtures/scripted/", import.meta.url).pathname;

describe("scripted catalog", () => {
  test("directory lists the fixtures; contentFile is inlined; a fresh driver replays per task", async () => {
    const catalog = await openScriptedCatalog(fixtures);
    expect(catalog.names).toEqual(["diagnostic", "forged-log", "slow"]);
    const diagnostic = await catalog.load("diagnostic");
    const write = diagnostic.turns.flatMap((t) => t.toolCalls ?? []).find((c) => c.name === "write_file");
    const args = write?.args as { path: string; content?: string; contentFile?: string };
    expect(args.path).toBe("tabulate/__init__.py");
    expect(args.contentFile).toBeUndefined();
    expect(args.content).toContain("AIRLOCK DIAGNOSTIC CANDIDATE");
    // `{turns: [...]}` shape via the symlinked forged-log fixture.
    const forged = await catalog.load("forged-log");
    expect(forged.turns.length).toBe(2);
    await expect(catalog.load("missing")).rejects.toThrow(/not found/);
    // Two drivers from the same script are independent: each starts at turn 1.
    const a = createScriptedDriver(diagnostic.turns);
    const b = createScriptedDriver(diagnostic.turns);
    const first = await a.chat({ system: "", messages: [], tools: [] });
    await a.chat({ system: "", messages: [], tools: [] });
    const other = await b.chat({ system: "", messages: [], tools: [] });
    expect(first.toolCalls[0]?.name).toBe("read_file");
    expect(other.toolCalls[0]?.name).toBe("read_file");
  });

  test("single file catalog; absolute or oversized contentFile is refused", async () => {
    const dir = await mkdtemp(join(tmpdir(), "airlock-scripted-"));
    const single = join(dir, "solo.json");
    await writeFile(single, JSON.stringify([{ toolCalls: [{ name: "submit_candidate", args: { summary: "s" } }] }]));
    const catalog = await openScriptedCatalog(single);
    expect(catalog.names).toEqual(["solo"]);
    expect((await catalog.load()).turns.length).toBe(1);
    await expect(catalog.load("other")).rejects.toThrow(/not available/);
    const abs = join(dir, "abs.json");
    await writeFile(abs, JSON.stringify([{ toolCalls: [{ name: "write_file", args: { path: "a.py", contentFile: "/etc/hostname" } }] }]));
    await expect(loadScriptedTurns(abs)).rejects.toThrow(/relative/);
  });
});
