/**
 * Profile loading: `profiles/<id>/profile.json`, `contract.json` and the pristine `base/` tree.
 *
 * The base tree is verified against `profile.baselineTreeDigest` (sha256 of the sorted
 * "path sha256" lines of every file) before any of its bytes are trusted as the diff base.
 * A profile whose base is missing or does not match is NOT loaded; the reason is reported so the
 * operator can run runtime/python/prepare-profile.sh. Nothing here executes profile code.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import {
  CaseContract,
  ProfileManifest,
  canonicalJson,
  sha256,
  type CaseContract as CaseContractT,
  type ProfileManifest as ProfileManifestT,
} from "@airlock/contracts";

export interface LoadedProfile {
  manifest: ProfileManifestT;
  contract: CaseContractT;
  contractDigest: string;
  /** path → text of allowed+readable base files from profiles/<id>/base */
  baseFiles: Record<string, string>;
  /** Absolute profile directory (for the adapter module bytes). */
  dir: string;
}

export interface ProfileLoadReport {
  profiles: Map<string, LoadedProfile>;
  skipped: { id: string; reason: string }[];
}

const MAX_TREE_FILES = 20_000;

export async function loadProfiles(dir: string): Promise<Map<string, LoadedProfile>> {
  return (await loadProfilesReport(dir)).profiles;
}

export async function loadProfilesReport(dir: string): Promise<ProfileLoadReport> {
  const profiles = new Map<string, LoadedProfile>();
  const skipped: { id: string; reason: string }[] = [];
  let entries: string[];
  try {
    entries = (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch (error) {
    throw new Error(`Cannot read profiles directory ${dir}: ${error instanceof Error ? error.message : String(error)}`);
  }
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    try {
      profiles.set(name, await loadProfile(join(dir, name), name));
    } catch (error) {
      skipped.push({ id: name, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return { profiles, skipped };
}

export async function loadProfile(profileDir: string, expectedId: string): Promise<LoadedProfile> {
  const manifestRaw = await readJson(join(profileDir, "profile.json"));
  const manifestParsed = ProfileManifest.safeParse(manifestRaw);
  if (!manifestParsed.success) throw new Error(`profile.json invalid: ${manifestParsed.error.issues[0]?.path.join(".")} ${manifestParsed.error.issues[0]?.message}`);
  const manifest = manifestParsed.data;
  if (manifest.id !== expectedId) throw new Error(`profile.json id "${manifest.id}" does not match directory "${expectedId}"`);
  if (!/^[A-Za-z0-9_]+$/.test(manifest.adapterModule)) throw new Error("adapterModule must be a plain python module name");
  if (manifest.contractPath.includes("/") || manifest.contractPath.includes("..")) throw new Error("contractPath must be a file name inside the profile directory");

  const contractRaw = await readJson(join(profileDir, manifest.contractPath));
  const contractParsed = CaseContract.safeParse(contractRaw);
  if (!contractParsed.success) throw new Error(`${manifest.contractPath} invalid: ${contractParsed.error.issues[0]?.path.join(".")} ${contractParsed.error.issues[0]?.message}`);
  const contract = contractParsed.data;
  if (contract.profileId !== manifest.id) throw new Error(`contract profileId "${contract.profileId}" does not match profile "${manifest.id}"`);
  const ids = new Set<string>();
  for (const c of contract.cases) {
    if (ids.has(c.id)) throw new Error(`contract has duplicate case id "${c.id}"`);
    ids.add(c.id);
    if (canonicalJson(c.input).length > 65536) throw new Error(`contract case "${c.id}" input exceeds 64 KiB`);
  }
  if (!contract.cases.some((c) => c.kind === "reported")) throw new Error("contract has no reported case");
  const contractDigest = await sha256(canonicalJson(contract));

  const baseDir = join(profileDir, "base");
  let baseStat;
  try {
    baseStat = await stat(baseDir);
  } catch {
    throw new Error(`base tree missing at ${baseDir} (run runtime/python/prepare-profile.sh ${manifest.id})`);
  }
  if (!baseStat.isDirectory()) throw new Error(`${baseDir} is not a directory`);
  const treeDigest = await baselineTreeDigest(baseDir);
  if (treeDigest !== manifest.baselineTreeDigest)
    throw new Error(`base tree digest ${treeDigest} does not match profile.baselineTreeDigest ${manifest.baselineTreeDigest}`);

  const wanted = [...new Set([...manifest.allowedReplacementPaths, ...manifest.readablePaths])].sort();
  const baseFiles: Record<string, string> = {};
  for (const path of wanted) {
    const full = join(baseDir, ...path.split("/"));
    let s;
    try {
      s = await stat(full);
    } catch {
      if (manifest.allowedReplacementPaths.includes(path)) throw new Error(`allowed replacement path "${path}" is missing from the base tree`);
      continue;
    }
    if (!s.isFile()) continue;
    if (s.size > manifest.caps.maxFileBytes) {
      if (manifest.allowedReplacementPaths.includes(path)) throw new Error(`base file "${path}" exceeds caps.maxFileBytes`);
      continue;
    }
    const bytes = await readFile(full);
    const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    baseFiles[path] = text;
  }
  return { manifest, contract, contractDigest, baseFiles, dir: profileDir };
}

/**
 * sha256 over the `path sha256\n` lines of every file under `root`, the same recipe as
 * runtime/python/tree_digest.py: a symlink to a regular file is included under its own path with
 * the target's bytes (a checkout looks like that to a reader); symlinks to anything else, broken
 * symlinks and special files are refused; a `.git` at the root is skipped; symlinked directories are
 * not descended; lines are ordered by (path.casefold(), path).
 */
export async function baselineTreeDigest(root: string): Promise<string> {
  const entries: { path: string; digest: string }[] = [];
  const stack = [root];
  let count = 0;
  while (stack.length) {
    const current = stack.pop()!;
    const dirents = await readdir(current, { withFileTypes: true });
    for (const entry of dirents) {
      const full = join(current, entry.name);
      const rel = relative(root, full).split(sep).join("/");
      if (entry.isSymbolicLink()) {
        let target;
        try {
          target = await stat(full);
        } catch {
          throw new Error(`broken symlink in base tree: ${rel}`);
        }
        if (!target.isFile()) {
          if (target.isDirectory()) continue; // not descended, like os.walk(followlinks=False)
          throw new Error(`symlink to non-regular file in base tree: ${rel}`);
        }
      } else if (entry.isDirectory()) {
        if (current === root && entry.name === ".git") continue;
        stack.push(full);
        continue;
      } else if (!entry.isFile()) throw new Error(`non-regular file in base tree: ${rel}`);
      if (++count > MAX_TREE_FILES) throw new Error("base tree has too many files");
      entries.push({ path: rel, digest: await sha256(await readFile(full)) });
    }
  }
  entries.sort((a, b) => {
    const ka = a.path.toLowerCase();
    const kb = b.path.toLowerCase();
    if (ka !== kb) return ka < kb ? -1 : 1;
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });
  return sha256(entries.map((e) => `${e.path} ${e.digest}\n`).join(""));
}

async function readJson(path: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(`cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (text.length > 4 * 1024 * 1024) throw new Error(`${path} exceeds 4 MiB`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${path} is not valid JSON`);
  }
}
