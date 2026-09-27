/**
 * Scripted model scripts for diagnostics and tests (`AIRLOCK_MODEL_DRIVER=scripted:<path>`).
 *
 * A script is a JSON file holding `ScriptedTurn[]` (or `{ "turns": ScriptedTurn[] }` with an
 * optional `_comment`). A `write_file` (repair) or `code_write` (general) tool call may carry `contentFile` instead of `content`: a
 * path relative to the script file whose bytes become the content, so a labelled diagnostic
 * candidate can live next to the script as a real file rather than a JSON string.
 *
 * `<path>` may be one script file or a directory of `<name>.json` scripts. With a directory, a task
 * chooses its script by `CreateTaskRequest.scriptedDriver`; without one, `default.json` is used.
 * Every task gets a fresh driver instance: a script replays from its first turn per task.
 *
 * A scripted run is labelled as such in every model event and is never a live repair.
 */
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import type { ScriptedTurn } from "./vultr-client.ts";

const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const MAX_CONTENT_FILE_BYTES = 1_048_576;

const ToolCallSchema = z.object({ name: z.string().max(64), args: z.unknown() });
const TurnSchema = z.object({
  toolCalls: z.array(ToolCallSchema).max(16).optional(),
  text: z.string().max(65536).optional(),
});
const ScriptSchema = z.union([
  z.array(TurnSchema).max(500),
  z.object({ _comment: z.string().optional(), turns: z.array(TurnSchema).max(500) }),
]);

export interface ScriptedCatalog {
  /** The file or directory the driver was configured with. */
  path: string;
  /** Script names that a task may select (basename without `.json`). One entry for a single file. */
  names: string[];
  /** Resolve a name (or the single file / `default`) to turns. Fresh array per call. */
  load(name?: string): Promise<{ name: string; turns: ScriptedTurn[] }>;
}

/** Parse one script file, resolving `contentFile` references relative to the file. */
export async function loadScriptedTurns(file: string): Promise<ScriptedTurn[]> {
  const raw: unknown = JSON.parse(await readFile(file, "utf8"));
  const parsed = ScriptSchema.parse(raw);
  const turns = Array.isArray(parsed) ? parsed : parsed.turns;
  const dir = dirname(file);
  const out: ScriptedTurn[] = [];
  for (const turn of turns) {
    const toolCalls: { name: string; args: unknown }[] = [];
    for (const call of turn.toolCalls ?? []) {
      let args = call.args ?? null;
      if ((call.name === "write_file" || call.name === "code_write") && args && typeof args === "object" && typeof (args as Record<string, unknown>).contentFile === "string") {
        const { contentFile, ...rest } = args as Record<string, unknown>;
        const ref = String(contentFile);
        if (isAbsolute(ref) || ref.includes("\0")) throw new Error(`${file}: contentFile must be a relative path`);
        const target = resolve(dir, ref);
        const info = await stat(target);
        if (!info.isFile()) throw new Error(`${file}: contentFile ${ref} is not a regular file`);
        if (info.size > MAX_CONTENT_FILE_BYTES) throw new Error(`${file}: contentFile ${ref} exceeds ${MAX_CONTENT_FILE_BYTES} bytes`);
        args = { ...rest, content: await readFile(target, "utf8") };
      }
      toolCalls.push({ name: call.name, args });
    }
    out.push({ ...(turn.text !== undefined ? { text: turn.text } : {}), ...(turn.toolCalls ? { toolCalls } : {}) });
  }
  return out;
}

/** Build the catalog for a script file or a directory of scripts. Validates every script up front. */
export async function openScriptedCatalog(path: string): Promise<ScriptedCatalog> {
  const info = await stat(path);
  if (info.isFile()) {
    const name = basename(path).replace(/\.json$/, "");
    await loadScriptedTurns(path);
    return {
      path,
      names: [name],
      async load(requested?: string) {
        if (requested !== undefined && requested !== name) throw new Error(`scripted driver "${requested}" is not available; the configured script is "${name}"`);
        return { name, turns: await loadScriptedTurns(path) };
      },
    };
  }
  if (!info.isDirectory()) throw new Error(`AIRLOCK_MODEL_DRIVER script path is neither a file nor a directory: ${path}`);
  const entries = (await readdir(path)).filter((f) => f.endsWith(".json"));
  const names: string[] = [];
  for (const entry of entries) {
    const name = entry.slice(0, -".json".length);
    if (!NAME.test(name)) continue;
    await loadScriptedTurns(join(path, entry));
    names.push(name);
  }
  names.sort();
  if (names.length === 0) throw new Error(`no scripted driver scripts (*.json) under ${path}`);
  return {
    path,
    names,
    async load(requested?: string) {
      const name = requested ?? "default";
      if (!names.includes(name)) throw new Error(`scripted driver "${name}" not found under ${path}; available: ${names.join(", ")}`);
      return { name, turns: await loadScriptedTurns(join(path, `${name}.json`)) };
    },
  };
}
