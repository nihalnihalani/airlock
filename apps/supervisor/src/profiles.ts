/**
 * Supported profiles, loaded once from AIRLOCK_PROFILES_DIR.
 *
 * The supervisor uses the manifest only: runtime image, caps, allowed/readable paths, source root.
 * The contract stays with the controller/comparator. Unsupported profile ids are rejected.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ProfileManifest } from "@airlock/contracts";

const IMAGE_REF = /^[a-z0-9][a-z0-9._\/-]{0,200}(:[A-Za-z0-9._-]{1,128})?(@sha256:[a-f0-9]{64})?$/;

export function loadProfiles(dir: string): Map<string, ProfileManifest> {
  const profiles = new Map<string, ProfileManifest>();
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (error) {
    throw new Error(`AIRLOCK_PROFILES_DIR ${dir} cannot be read: ${(error as Error).message}`);
  }
  for (const entry of entries) {
    const path = join(dir, entry, "profile.json");
    try {
      if (!statSync(join(dir, entry)).isDirectory()) continue;
    } catch {
      continue;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      throw new Error(`Profile ${entry}: profile.json unreadable or invalid JSON (${(error as Error).message})`);
    }
    const parsed = ProfileManifest.safeParse(raw);
    if (!parsed.success) throw new Error(`Profile ${entry}: profile.json does not match ProfileManifest: ${parsed.error.message}`);
    const manifest = parsed.data;
    if (manifest.id !== entry) throw new Error(`Profile ${entry}: id "${manifest.id}" does not match its directory name.`);
    if (!IMAGE_REF.test(manifest.runtimeImage)) throw new Error(`Profile ${entry}: runtimeImage is not an image reference.`);
    if (manifest.sourceRoot !== "/workspace/src") throw new Error(`Profile ${entry}: sourceRoot must be /workspace/src for the python runtime.`);
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(manifest.adapterModule)) throw new Error(`Profile ${entry}: adapterModule is not a python module name.`);
    profiles.set(manifest.id, manifest);
  }
  return profiles;
}
