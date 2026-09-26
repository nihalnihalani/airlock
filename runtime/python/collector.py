#!/usr/bin/env python3
"""Airlock bounded regular-file collector.

    python -I -S /opt/airlock/collector.py --root /candidate --profile /opt/airlock/profile/profile.json

Runs in a FRESH container with the stopped author volume mounted read-only at ``--root`` and the
working directory outside it (the supervisor uses ``/``). Stdlib only, importable under ``-I -S``
(no site, no user site, no script directory on ``sys.path``); it never imports anything from the
candidate tree and never executes candidate code.

Walks ONLY the profile's ``allowedReplacementPaths`` (exact paths, no globs). For each:

* every path component under root must be a real directory (a symlink anywhere rejects),
* the leaf must be a regular file: not a symlink, device, fifo, socket or directory,
* hard-linked files (``st_nlink > 1``) are rejected,
* ``caps.maxFileBytes`` is enforced from ``lstat`` AND while streaming (a file that grows during the
  read is rejected), reads are chunked and capped, never whole-file,
* ``caps.maxFiles`` and ``caps.maxTotalBytes`` bound the envelope,
* duplicates in the allowlist are rejected, missing files are reported as rejected (the controller
  decides whether a missing required file fails the freeze).

Prints one ``FileEnvelope`` JSON object (packages/contracts) to stdout:
``{"schemaVersion": 1, "files": [{path, byteLength, sha256, contentBase64}], "rejected": [{path, reason}]}``.
Everything in it is untrusted data for the controller to validate again.

Exit status: 0 when the envelope was produced (rejections are part of a valid envelope);
1 when the root or profile is unusable and no envelope can be produced.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import stat
import sys
from typing import Any

SCHEMA_VERSION = 1
CHUNK = 1 << 16
MAX_ALLOWED_PATHS = 1024
MAX_REASON = 256
MAX_PATH = 512


class Unusable(Exception):
    pass


def is_rel_path(path: Any) -> bool:
    if not isinstance(path, str) or not 1 <= len(path) <= MAX_PATH:
        return False
    if path.startswith("/") or "\\" in path or "\0" in path:
        return False
    return all(seg not in ("", ".", "..") for seg in path.split("/"))


def load_profile(path: str) -> tuple[list[Any], dict[str, int]]:
    try:
        with open(path, "rb") as fh:
            profile = json.load(fh)
    except (OSError, ValueError) as exc:
        raise Unusable(f"cannot read profile {path}: {exc}") from exc
    if not isinstance(profile, dict):
        raise Unusable("profile.json must be an object")
    allowed = profile.get("allowedReplacementPaths")
    if not isinstance(allowed, list) or not allowed or len(allowed) > MAX_ALLOWED_PATHS:
        raise Unusable("profile.allowedReplacementPaths must be a non-empty array")
    caps = profile.get("caps")
    if not isinstance(caps, dict):
        raise Unusable("profile.caps must be an object")
    out: dict[str, int] = {}
    for key in ("maxFileBytes", "maxTotalBytes", "maxFiles"):
        value = caps.get(key)
        if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
            raise Unusable(f"profile.caps.{key} must be a positive integer")
        out[key] = value
    return allowed, out


class Rejected(Exception):
    pass


def check_components(root: str, rel: str) -> None:
    current = root
    for part in rel.split("/")[:-1]:
        current = os.path.join(current, part)
        try:
            st = os.lstat(current)
        except FileNotFoundError:
            raise Rejected("missing") from None
        if stat.S_ISLNK(st.st_mode):
            raise Rejected(f"symlink component {part!r}")
        if not stat.S_ISDIR(st.st_mode):
            raise Rejected(f"non-directory component {part!r}")


def collect_one(root: str, rel: str, caps: dict[str, int]) -> dict[str, Any]:
    check_components(root, rel)
    full = os.path.join(root, rel)
    try:
        st = os.lstat(full)
    except FileNotFoundError:
        raise Rejected("missing") from None
    if stat.S_ISLNK(st.st_mode):
        raise Rejected("symlink")
    if stat.S_ISDIR(st.st_mode):
        raise Rejected("directory")
    if not stat.S_ISREG(st.st_mode):
        raise Rejected("not a regular file")
    if st.st_nlink > 1:
        raise Rejected(f"hardlink (nlink={st.st_nlink})")
    if st.st_size > caps["maxFileBytes"]:
        raise Rejected(f"oversize ({st.st_size} > {caps['maxFileBytes']})")

    fd = os.open(full, os.O_RDONLY | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0))
    try:
        fst = os.fstat(fd)
        if not stat.S_ISREG(fst.st_mode) or (fst.st_ino, fst.st_dev) != (st.st_ino, st.st_dev):
            raise Rejected("changed between stat and open")
        digest = hashlib.sha256()
        encoder_buffer = bytearray()
        parts: list[str] = []
        length = 0
        while True:
            chunk = os.read(fd, CHUNK)
            if not chunk:
                break
            length += len(chunk)
            if length > caps["maxFileBytes"]:
                raise Rejected(f"oversize while reading (> {caps['maxFileBytes']})")
            digest.update(chunk)
            encoder_buffer += chunk
            # base64 works on 3-byte groups; encode full groups as we go to keep memory bounded
            # to the cap rather than to twice the cap.
            usable = len(encoder_buffer) - (len(encoder_buffer) % 3)
            if usable:
                parts.append(base64.b64encode(bytes(encoder_buffer[:usable])).decode("ascii"))
                del encoder_buffer[:usable]
        if encoder_buffer:
            parts.append(base64.b64encode(bytes(encoder_buffer)).decode("ascii"))
    finally:
        os.close(fd)
    return {
        "path": rel,
        "byteLength": length,
        "sha256": digest.hexdigest(),
        "contentBase64": "".join(parts),
    }


def collect(root: str, allowed: list[Any], caps: dict[str, int]) -> dict[str, Any]:
    files: list[dict[str, Any]] = []
    rejected: list[dict[str, str]] = []
    seen: set[str] = set()
    total = 0

    def reject(path: Any, reason: str) -> None:
        text = path if isinstance(path, str) else repr(path)
        rejected.append({"path": text[:MAX_PATH], "reason": reason[:MAX_REASON]})

    for rel in allowed:
        if not is_rel_path(rel):
            reject(rel, "invalid path in allowlist")
            continue
        if rel in seen:
            reject(rel, "duplicate")
            continue
        seen.add(rel)
        if len(files) >= caps["maxFiles"]:
            reject(rel, f"more than maxFiles ({caps['maxFiles']})")
            continue
        try:
            entry = collect_one(root, rel, caps)
        except Rejected as exc:
            reject(rel, str(exc))
            continue
        except OSError as exc:
            reject(rel, f"unreadable: {exc.__class__.__name__}")
            continue
        total += entry["byteLength"]
        if total > caps["maxTotalBytes"]:
            reject(rel, f"exceeds maxTotalBytes ({caps['maxTotalBytes']})")
            total -= entry["byteLength"]
            continue
        files.append(entry)
    return {"schemaVersion": SCHEMA_VERSION, "files": files, "rejected": rejected}


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Airlock bounded regular-file collector")
    parser.add_argument("--root", required=True, help="stopped author workspace source root (mounted read-only)")
    parser.add_argument("--profile", required=True, help="profile.json from the image")
    args = parser.parse_args(argv)
    try:
        root = args.root
        if not os.path.isabs(root):
            raise Unusable("--root must be absolute")
        if os.path.islink(root) or not os.path.isdir(root):
            raise Unusable(f"--root {root} is not a directory")
        allowed, caps = load_profile(args.profile)
        envelope = collect(root, allowed, caps)
    except Unusable as exc:
        sys.stderr.write(f"collector: {exc}\n")
        return 1
    sys.stdout.write(json.dumps(envelope, separators=(",", ":")) + "\n")
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
