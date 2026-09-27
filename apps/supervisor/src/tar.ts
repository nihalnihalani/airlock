/**
 * Minimal ustar writer.
 *
 * Files are delivered into containers with Docker's PUT /archive (a tar upload), never by shell
 * interpolation. This writer produces only regular files and directories, owned by 1000:1000, with
 * validated relative paths. It is deliberately not a general tar implementation. An entry may override
 * its owner and mode (analysis/node inputs are root-owned and read-only: uid 0, 0444 / dirs 0555).
 */
export interface TarEntry {
  /** Relative POSIX path (already validated by the caller as traversal-free). */
  path: string;
  bytes?: Uint8Array;
  kind: "file" | "dir";
  /** Permission bits (default 0644 file, 0755 dir). */
  mode?: number;
  /** Owner uid/gid (default 1000:1000, the sandbox user). */
  uid?: number;
  gid?: number;
}

const BLOCK = 512;
const UID = 1000;
const GID = 1000;

export class TarError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TarError";
  }
}

function octal(value: number, width: number): Uint8Array {
  const digits = value.toString(8).padStart(width - 1, "0");
  if (digits.length > width - 1) throw new TarError(`value ${value} does not fit in ${width} octal characters`);
  return new TextEncoder().encode(`${digits}\0`);
}

function write(target: Uint8Array, offset: number, bytes: Uint8Array): void {
  target.set(bytes, offset);
}

function splitName(path: string): { name: string; prefix: string } {
  const encoded = new TextEncoder().encode(path);
  if (encoded.length <= 100) return { name: path, prefix: "" };
  // ustar: prefix (155) + "/" + name (100). Split at a slash so both halves fit.
  const segments = path.split("/");
  for (let i = 1; i < segments.length; i++) {
    const prefix = segments.slice(0, i).join("/");
    const name = segments.slice(i).join("/");
    const p = new TextEncoder().encode(prefix).length;
    const n = new TextEncoder().encode(name).length;
    if (p <= 155 && n <= 100) return { name, prefix };
  }
  throw new TarError(`path cannot be represented in a ustar header: ${path.slice(0, 80)}`);
}

function header(entry: TarEntry, size: number): Uint8Array {
  const buf = new Uint8Array(BLOCK);
  const enc = new TextEncoder();
  const { name, prefix } = splitName(entry.kind === "dir" ? `${entry.path}/` : entry.path);
  write(buf, 0, enc.encode(name));
  const mode = entry.mode ?? (entry.kind === "dir" ? 0o755 : 0o644);
  if (!Number.isInteger(mode) || mode < 0 || mode > 0o777) throw new TarError("mode must be permission bits only (no setuid/setgid/sticky)");
  write(buf, 100, octal(mode, 8));
  write(buf, 108, octal(entry.uid ?? UID, 8));
  write(buf, 116, octal(entry.gid ?? GID, 8));
  write(buf, 124, octal(size, 12));
  write(buf, 136, octal(Math.floor(Date.now() / 1000), 12));
  // checksum placeholder: 8 spaces
  buf.fill(0x20, 148, 156);
  buf[156] = entry.kind === "dir" ? 0x35 : 0x30; // '5' or '0'
  write(buf, 257, enc.encode("ustar\0"));
  write(buf, 263, enc.encode("00"));
  write(buf, 265, enc.encode("airlock"));
  write(buf, 297, enc.encode("airlock"));
  write(buf, 329, octal(0, 8));
  write(buf, 337, octal(0, 8));
  write(buf, 345, enc.encode(prefix));
  let sum = 0;
  for (const b of buf) sum += b;
  const check = sum.toString(8).padStart(6, "0");
  write(buf, 148, enc.encode(`${check}\0 `));
  return buf;
}

/** Build a tar archive in memory. Total size is the caller's responsibility to bound. */
export function createTar(entries: TarEntry[]): Uint8Array {
  const parts: Uint8Array[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.path)) throw new TarError(`duplicate tar entry: ${entry.path.slice(0, 80)}`);
    seen.add(entry.path);
    const bytes = entry.kind === "file" ? (entry.bytes ?? new Uint8Array(0)) : new Uint8Array(0);
    parts.push(header(entry, bytes.length));
    if (bytes.length > 0) {
      parts.push(bytes);
      const pad = (BLOCK - (bytes.length % BLOCK)) % BLOCK;
      if (pad > 0) parts.push(new Uint8Array(pad));
    }
  }
  parts.push(new Uint8Array(BLOCK * 2));
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** Directory entries for every ancestor of the given file paths, in creation order. */
export function ancestorDirs(paths: string[]): string[] {
  const dirs = new Set<string>();
  for (const path of paths) {
    const segments = path.split("/");
    for (let i = 1; i < segments.length; i++) dirs.add(segments.slice(0, i).join("/"));
  }
  return [...dirs].sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
}
