#!/usr/bin/env python3
"""Airlock bounded OUTPUT collector (analysis and Node task profiles).

    python3 -I -S /opt/airlock/collect_outputs.py --root /candidate

Runs in a FRESH container (the analysis image, for both the analysis and the Node profile) with the
stopped task workspace volume mounted read-only at ``--root`` and the working directory outside it
(the supervisor uses ``/``). Stdlib only, importable under ``-I -S``; it never imports or executes
anything from the workspace. It is the output-side sibling of ``runtime/python/collector.py``: that
one walks a profile's exact replacement allowlist, this one walks ``<root>/outputs/`` only.

Rules (every rejection is reported, nothing is silently dropped):

* only ``<root>/outputs`` is walked; ``outputs`` itself and every directory below it must be a real
  directory (a symlink at any component rejects that subtree), depth <= MAX_DEPTH;
* leaves must be regular files: symlinks, fifos, sockets, devices are rejected; hard-linked files
  (``st_nlink > 1``) are rejected;
* entry names must be valid UTF-8, NFC-normalised, printable, without backslash, not hidden
  (leading ``.``) and at most MAX_NAME bytes; the relative path is re-validated (no ``..``, no
  absolute path);
* case-insensitive (casefold + NFC) duplicate paths are rejected after the first one walked (walk
  order is code-point order within each directory), so an export can never collide on a
  case-insensitive file system;
* extension allowlist: .csv .json .txt .md .png .py .js .mjs (case-sensitive, lower-case only).
  ``.svg`` is rejected explicitly: SVG is active content (script, external references);
* caps: per file (default and ceiling 5 MiB), total (default and ceiling 20 MiB), file count
  (default and ceiling 50) and walked entries (MAX_ENTRIES). Arguments may LOWER the caps, never
  raise them. Sizes are checked from ``lstat`` and again while streaming in 64 KiB chunks;
* content checks: PNG must start with the 8-byte signature followed by a well-formed IHDR chunk
  (length 13, valid CRC) with 1 <= width, height <= 8192; .csv .json .txt .md .py .js .mjs must be
  valid UTF-8 without NUL bytes; .json must additionally parse as JSON;
* files are opened relative to their already-verified parent directory descriptor with
  ``O_NOFOLLOW`` and re-checked by (st_dev, st_ino), so nothing is ever read through a symlink.

Prints one envelope, the ``FileEnvelope`` shape of ``collector.py`` plus ``mediaType``:
``{"schemaVersion": 1, "files": [{path, byteLength, sha256, contentBase64, mediaType}],
"rejected": [{path, reason}]}``. ``path`` is relative to ``outputs/``. Files are ordered by
code point of ``path``. Everything in it is untrusted data for the controller to validate again.

Exit status: 0 when an envelope was produced (rejections are part of a valid envelope, a missing
``outputs/`` is an empty envelope); 1 when the root or arguments are unusable.
"""

from __future__ import annotations

import argparse
import base64
import codecs
import hashlib
import json
import os
import stat
import struct
import sys
import unicodedata
import zlib
from typing import Any

SCHEMA_VERSION = 1
CHUNK = 1 << 16
OUTPUTS_DIR = "outputs"

CEIL_FILE_BYTES = 5 * 1024 * 1024
CEIL_TOTAL_BYTES = 20 * 1024 * 1024
CEIL_FILES = 50
MAX_ENTRIES = 2000       # every directory entry walked, accepted or not
MAX_DEPTH = 8            # directories below outputs/
MAX_NAME = 255           # bytes per path component
MAX_PATH = 512
MAX_REASON = 256
MAX_REJECTED = 200
PNG_MAX_DIM = 8192

PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"

MEDIA_TYPES = {
    ".csv": "text/csv",
    ".json": "application/json",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".png": "image/png",
    ".py": "text/x-python",
    ".js": "text/javascript",
    ".mjs": "text/javascript",
}
EXPLICITLY_REFUSED = {
    ".svg": "svg is active content (script/external references); not an allowed output type",
    ".svgz": "svg is active content (script/external references); not an allowed output type",
    ".html": "html is active content; not an allowed output type",
    ".htm": "html is active content; not an allowed output type",
}

O_FLAGS_FILE = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NONBLOCK", 0)
O_FLAGS_DIR = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_DIRECTORY", 0)


class Unusable(Exception):
    pass


class Rejected(Exception):
    pass


class Stop(Exception):
    """The walk must end (entry budget exhausted)."""


def is_rel_path(path: Any) -> bool:
    if not isinstance(path, str) or not 1 <= len(path) <= MAX_PATH:
        return False
    if path.startswith("/") or "\\" in path or "\0" in path:
        return False
    return all(seg not in ("", ".", "..") for seg in path.split("/"))


def name_problem(raw: bytes) -> str | None:
    """Return why a directory entry name is unacceptable, or None."""
    if len(raw) > MAX_NAME:
        return "name too long"
    try:
        name = raw.decode("utf-8", "strict")
    except UnicodeDecodeError:
        return "name is not valid UTF-8"
    if name in (".", "..") or "/" in name or "\\" in name:
        return "traversal or separator in name"
    if name.startswith("."):
        return "hidden file"
    if any(unicodedata.category(ch) in ("Cc", "Cf", "Cs", "Co", "Cn", "Zl", "Zp") for ch in name):
        return "control or unassigned character in name"
    if unicodedata.normalize("NFC", name) != name:
        return "name is not NFC-normalised"
    return None


def display(raw_rel: bytes) -> str:
    return raw_rel.decode("utf-8", "backslashreplace")[:MAX_PATH]


def png_check(head: bytes) -> None:
    if len(head) < 33 or head[:8] != PNG_SIGNATURE:
        raise Rejected("not a PNG (bad signature)")
    length, ctype = struct.unpack(">I4s", head[8:16])
    if ctype != b"IHDR" or length != 13:
        raise Rejected("PNG does not start with a 13-byte IHDR chunk")
    data = head[16:29]
    (crc,) = struct.unpack(">I", head[29:33])
    if zlib.crc32(ctype + data) & 0xFFFFFFFF != crc:
        raise Rejected("PNG IHDR CRC mismatch")
    width, height = struct.unpack(">II", data[:8])
    if not (1 <= width <= PNG_MAX_DIM and 1 <= height <= PNG_MAX_DIM):
        raise Rejected(f"PNG dimensions {width}x{height} outside 1..{PNG_MAX_DIM}")


def read_file(dir_fd: int, name: bytes, st: os.stat_result, ext: str, file_cap: int) -> dict[str, Any]:
    fd = os.open(name, O_FLAGS_FILE, dir_fd=dir_fd)
    try:
        fst = os.fstat(fd)
        if not stat.S_ISREG(fst.st_mode) or (fst.st_ino, fst.st_dev) != (st.st_ino, st.st_dev):
            raise Rejected("changed between stat and open")
        if fst.st_nlink > 1:
            raise Rejected(f"hardlink (nlink={fst.st_nlink})")
        is_text = ext != ".png"
        decoder = codecs.getincrementaldecoder("utf-8")("strict") if is_text else None
        text_parts: list[str] = []
        digest = hashlib.sha256()
        pending = bytearray()
        b64: list[str] = []
        head = bytearray()
        length = 0
        while True:
            chunk = os.read(fd, CHUNK)
            if not chunk:
                break
            length += len(chunk)
            if length > file_cap:
                raise Rejected(f"oversize while reading (> {file_cap})")
            digest.update(chunk)
            if len(head) < 33:
                head += chunk[: 33 - len(head)]
            if decoder is not None:
                if b"\0" in chunk:
                    raise Rejected("NUL byte in text file")
                try:
                    piece = decoder.decode(chunk)
                except UnicodeDecodeError:
                    raise Rejected("not valid UTF-8") from None
                if ext == ".json":
                    text_parts.append(piece)
            pending += chunk
            usable = len(pending) - (len(pending) % 3)
            if usable:
                b64.append(base64.b64encode(bytes(pending[:usable])).decode("ascii"))
                del pending[:usable]
        if pending:
            b64.append(base64.b64encode(bytes(pending)).decode("ascii"))
        if decoder is not None:
            try:
                tail = decoder.decode(b"", final=True)
            except UnicodeDecodeError:
                raise Rejected("not valid UTF-8 (truncated sequence)") from None
            if ext == ".json":
                text_parts.append(tail)
                text = "".join(text_parts)
                # An explicit nesting bound, not the interpreter's recursion limit (which differs
                # between Python versions): deeper documents are refused before parsing.
                if json_depth(text) > MAX_JSON_DEPTH:
                    raise Rejected(f"JSON nested deeper than {MAX_JSON_DEPTH}")
                try:
                    json.loads(text)
                except (ValueError, RecursionError):
                    raise Rejected("not valid JSON") from None
        else:
            png_check(bytes(head))
    finally:
        os.close(fd)
    return {"byteLength": length, "sha256": digest.hexdigest(), "contentBase64": "".join(b64), "mediaType": MEDIA_TYPES[ext]}


MAX_JSON_DEPTH = 64


def json_depth(text: str) -> int:
    """Maximum bracket nesting outside string literals (a lexical scan; parsing validates the rest)."""
    depth = deepest = 0
    in_string = escaped = False
    for ch in text:
        if in_string:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                in_string = False
        elif ch == '"':
            in_string = True
        elif ch in "[{":
            depth += 1
            if depth > deepest:
                deepest = depth
        elif ch in "]}":
            depth -= 1
    return deepest


class Walker:
    def __init__(self, caps: dict[str, int]) -> None:
        self.caps = caps
        self.files: list[dict[str, Any]] = []
        self.rejected: list[dict[str, str]] = []
        self.seen_fold: set[str] = set()
        self.entries = 0
        self.total = 0

    def reject(self, rel: str, reason: str) -> None:
        if len(self.rejected) < MAX_REJECTED:
            self.rejected.append({"path": rel[:MAX_PATH], "reason": reason[:MAX_REASON]})
        elif len(self.rejected) == MAX_REJECTED:
            self.rejected.append({"path": "*", "reason": "further rejections omitted"})

    def walk(self, dir_fd: int, prefix: bytes, depth: int) -> None:
        try:
            names = sorted(os.fsencode(n) for n in os.listdir(dir_fd))
        except OSError as exc:
            self.reject(display(prefix.rstrip(b"/")) or ".", f"unreadable directory: {exc.__class__.__name__}")
            return
        # Code-point order of the decoded name equals byte order for valid UTF-8, so sorting the raw
        # bytes gives the stable code-point ordering for every accepted path.
        for name in names:
            self.entries += 1
            raw_rel = prefix + name
            rel = display(raw_rel)
            if self.entries > MAX_ENTRIES:
                self.reject(rel, f"more than {MAX_ENTRIES} entries under outputs/; walk stopped")
                raise Stop()
            try:
                st = os.stat(name, dir_fd=dir_fd, follow_symlinks=False)
            except OSError as exc:
                self.reject(rel, f"unreadable: {exc.__class__.__name__}")
                continue
            problem = name_problem(name)
            if problem is not None:
                self.reject(rel, problem)
                continue
            if not is_rel_path(rel):
                self.reject(rel, "invalid relative path")
                continue
            if stat.S_ISLNK(st.st_mode):
                self.reject(rel, "symlink")
                continue
            if stat.S_ISDIR(st.st_mode):
                if depth >= MAX_DEPTH:
                    self.reject(rel, f"deeper than {MAX_DEPTH} directories")
                    continue
                try:
                    sub = os.open(name, O_FLAGS_DIR, dir_fd=dir_fd)
                except OSError as exc:
                    self.reject(rel, f"unopenable directory: {exc.__class__.__name__}")
                    continue
                try:
                    sst = os.fstat(sub)
                    if (sst.st_ino, sst.st_dev) != (st.st_ino, st.st_dev):
                        self.reject(rel, "changed between stat and open")
                        continue
                    self.walk(sub, raw_rel + b"/", depth + 1)
                finally:
                    os.close(sub)
                continue
            if not stat.S_ISREG(st.st_mode):
                self.reject(rel, "not a regular file")
                continue
            self.consider_file(dir_fd, name, rel, st)

    def consider_file(self, dir_fd: int, name: bytes, rel: str, st: os.stat_result) -> None:
        if st.st_nlink > 1:
            self.reject(rel, f"hardlink (nlink={st.st_nlink})")
            return
        base = rel.rsplit("/", 1)[-1]
        ext = os.path.splitext(base)[1]
        if ext in EXPLICITLY_REFUSED or ext.lower() in EXPLICITLY_REFUSED:
            self.reject(rel, EXPLICITLY_REFUSED.get(ext, EXPLICITLY_REFUSED.get(ext.lower(), "refused")))
            return
        if ext not in MEDIA_TYPES:
            self.reject(rel, f"extension {ext or '(none)'!r} not allowed")
            return
        fold = unicodedata.normalize("NFC", rel).casefold()
        if fold in self.seen_fold:
            self.reject(rel, "duplicate (case-insensitive) path")
            return
        self.seen_fold.add(fold)
        if len(self.files) >= self.caps["maxFiles"]:
            self.reject(rel, f"more than maxFiles ({self.caps['maxFiles']})")
            return
        if st.st_size > self.caps["maxFileBytes"]:
            self.reject(rel, f"oversize ({st.st_size} > {self.caps['maxFileBytes']})")
            return
        if self.total + st.st_size > self.caps["maxTotalBytes"]:
            self.reject(rel, f"exceeds maxTotalBytes ({self.caps['maxTotalBytes']})")
            return
        try:
            entry = read_file(dir_fd, name, st, ext, self.caps["maxFileBytes"])
        except Rejected as exc:
            self.reject(rel, str(exc))
            return
        except OSError as exc:
            self.reject(rel, f"unreadable: {exc.__class__.__name__}")
            return
        if self.total + entry["byteLength"] > self.caps["maxTotalBytes"]:
            self.reject(rel, f"exceeds maxTotalBytes ({self.caps['maxTotalBytes']})")
            return
        self.total += entry["byteLength"]
        self.files.append({"path": rel, **entry})


def collect(root: str, caps: dict[str, int]) -> dict[str, Any]:
    walker = Walker(caps)
    root_fd = os.open(root, O_FLAGS_DIR)
    try:
        try:
            st = os.stat(OUTPUTS_DIR, dir_fd=root_fd, follow_symlinks=False)
        except FileNotFoundError:
            st = None
        if st is None:
            pass  # no outputs: an empty, valid envelope
        elif stat.S_ISLNK(st.st_mode):
            walker.reject(OUTPUTS_DIR, "symlink component 'outputs'")
        elif not stat.S_ISDIR(st.st_mode):
            walker.reject(OUTPUTS_DIR, "outputs is not a directory")
        else:
            out_fd = os.open(OUTPUTS_DIR, O_FLAGS_DIR, dir_fd=root_fd)
            try:
                walker.walk(out_fd, b"", 0)
            except Stop:
                pass
            finally:
                os.close(out_fd)
    finally:
        os.close(root_fd)
    walker.files.sort(key=lambda f: f["path"])
    return {"schemaVersion": SCHEMA_VERSION, "files": walker.files, "rejected": walker.rejected}


def bounded_cap(name: str, value: int | None, ceiling: int) -> int:
    if value is None:
        return ceiling
    if value <= 0:
        raise Unusable(f"--{name} must be positive")
    return min(value, ceiling)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Airlock bounded output collector")
    parser.add_argument("--root", required=True, help="stopped task workspace (mounted read-only)")
    parser.add_argument("--max-file-bytes", type=int, default=None)
    parser.add_argument("--max-total-bytes", type=int, default=None)
    parser.add_argument("--max-files", type=int, default=None)
    try:
        args = parser.parse_args(argv)
    except SystemExit:
        return 1
    try:
        root = args.root
        if not os.path.isabs(root):
            raise Unusable("--root must be absolute")
        if os.path.islink(root) or not os.path.isdir(root):
            raise Unusable(f"--root {root} is not a directory")
        caps = {
            "maxFileBytes": bounded_cap("max-file-bytes", args.max_file_bytes, CEIL_FILE_BYTES),
            "maxTotalBytes": bounded_cap("max-total-bytes", args.max_total_bytes, CEIL_TOTAL_BYTES),
            "maxFiles": bounded_cap("max-files", args.max_files, CEIL_FILES),
        }
        envelope = collect(root, caps)
    except Unusable as exc:
        sys.stderr.write(f"collect_outputs: {exc}\n")
        return 1
    except OSError as exc:
        sys.stderr.write(f"collect_outputs: root unusable: {exc.__class__.__name__}\n")
        return 1
    sys.stdout.write(json.dumps(envelope, separators=(",", ":"), ensure_ascii=True) + "\n")
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
