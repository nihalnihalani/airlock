#!/usr/bin/env python3
"""Airlock pristine candidate materializer.

    python /opt/airlock/materialize.py [--base /opt/airlock/base] [--target /workspace/src]
                                       [--replacements /workspace/replacements]
                                       [--profile /opt/airlock/profile/profile.json] [--force]

1. Copies the pristine baseline tree (root-owned, read-only in the image) to the target as fresh,
   writable regular files. Refuses when the target already exists unless ``--force`` (then the old
   target directory is removed first; a target that is a symlink is always refused).
2. If a replacements directory exists, overlays regular files from it ONLY at the profile's
   ``allowedReplacementPaths``. Every path component under the replacements directory must be a
   real directory (no symlinks), the leaf must be a regular file (no symlinks, devices, fifos), and
   ``caps.maxFileBytes`` / ``caps.maxTotalBytes`` / ``caps.maxFiles`` are enforced with capped
   streaming copies. Anything else present under replacements is ignored and listed.
3. Prints ``{"materialized": n, "replaced": [paths], "ignored": [paths]}`` to stdout.

Never executes anything from the base tree or the replacements (no setup.py, no hooks). Untrusted
inputs are the replacements bytes; the base tree and profile.json are fixed image content.

Exit status: 0 ok; 1 refused (bad arguments, target exists, invalid replacement); 2 I/O failure.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import stat
import sys
from typing import Any

CHUNK = 1 << 16
MAX_IGNORED_LISTED = 200
MAX_ALLOWED_PATHS = 1024


class Refused(Exception):
    pass


def is_rel_path(path: Any) -> bool:
    """contracts.relPath: relative POSIX path, no traversal, no empty segments."""
    if not isinstance(path, str) or not 1 <= len(path) <= 512:
        return False
    if path.startswith("/") or "\\" in path or "\0" in path:
        return False
    return all(seg not in ("", ".", "..") for seg in path.split("/"))


def load_profile(path: str) -> tuple[list[str], dict[str, int]]:
    try:
        with open(path, "rb") as fh:
            profile = json.load(fh)
    except (OSError, ValueError) as exc:
        raise Refused(f"cannot read profile {path}: {exc}") from exc
    if not isinstance(profile, dict):
        raise Refused("profile.json must be an object")
    allowed = profile.get("allowedReplacementPaths")
    if not isinstance(allowed, list) or not allowed or len(allowed) > MAX_ALLOWED_PATHS:
        raise Refused("profile.allowedReplacementPaths must be a non-empty array")
    seen: set[str] = set()
    for p in allowed:
        if not is_rel_path(p):
            raise Refused(f"profile.allowedReplacementPaths contains an invalid path: {p!r}")
        if p in seen:
            raise Refused(f"profile.allowedReplacementPaths contains a duplicate: {p!r}")
        seen.add(p)
    caps = profile.get("caps")
    if not isinstance(caps, dict):
        raise Refused("profile.caps must be an object")
    out: dict[str, int] = {}
    for key in ("maxFileBytes", "maxTotalBytes", "maxFiles"):
        value = caps.get(key)
        if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
            raise Refused(f"profile.caps.{key} must be a positive integer")
        out[key] = value
    return list(allowed), out


def assert_no_symlink_components(root: str, rel: str) -> None:
    """Every component of ``rel`` under ``root`` must exist as a non-symlink directory, except the
    leaf which is checked by the caller."""
    current = root
    parts = rel.split("/")
    for part in parts[:-1]:
        current = os.path.join(current, part)
        st = os.lstat(current)  # raises FileNotFoundError → handled by caller
        if stat.S_ISLNK(st.st_mode):
            raise Refused(f"{rel}: path component {part!r} is a symlink")
        if not stat.S_ISDIR(st.st_mode):
            raise Refused(f"{rel}: path component {part!r} is not a directory")


def assert_target_components(target: str, rel: str) -> None:
    """Existing components of ``rel`` under the freshly materialized target must be real
    directories; missing ones will be created. A symlink anywhere refuses the overlay."""
    current = target
    for part in rel.split("/")[:-1]:
        current = os.path.join(current, part)
        try:
            st = os.lstat(current)
        except FileNotFoundError:
            return
        if stat.S_ISLNK(st.st_mode):
            raise Refused(f"{rel}: target path component {part!r} is a symlink")
        if not stat.S_ISDIR(st.st_mode):
            raise Refused(f"{rel}: target path component {part!r} is not a directory")


def copy_base(base: str, target: str, force: bool) -> int:
    if os.path.islink(target):
        raise Refused(f"target {target} is a symlink")
    if os.path.lexists(target):
        if not force:
            raise Refused(f"target {target} already exists (use --force to replace)")
        if not os.path.isdir(target):
            raise Refused(f"target {target} exists and is not a directory")
        shutil.rmtree(target)
    if not os.path.isdir(base) or os.path.islink(base):
        raise Refused(f"base {base} is not a directory")
    parent = os.path.dirname(os.path.abspath(target))
    if not os.path.isdir(parent):
        raise Refused(f"target parent {parent} does not exist")
    # copyfile (not copy2) so the read-only modes of the image tree are not carried over: the
    # author must be able to edit the materialized files. Symlinks inside the base are recreated
    # as symlinks (the base is trusted image content; the collector never follows them anyway).
    shutil.copytree(base, target, symlinks=True, copy_function=shutil.copyfile)
    # copytree copies directory modes with copystat; the image tree is 0555, so open the copied
    # directories up again or the author could not create files in them.
    count = 0
    for dirpath, dirnames, filenames in os.walk(target, followlinks=False):
        os.chmod(dirpath, 0o755)
        count += len(filenames)
    return count


def overlay(replacements: str, target: str, allowed: list[str], caps: dict[str, int]) -> tuple[list[str], list[str]]:
    if not os.path.lexists(replacements):
        return [], []
    if os.path.islink(replacements) or not os.path.isdir(replacements):
        raise Refused(f"replacements {replacements} is not a directory")

    replaced: list[str] = []
    total = 0
    for rel in allowed:
        src = os.path.join(replacements, rel)
        try:
            assert_no_symlink_components(replacements, rel)
            st = os.lstat(src)
        except FileNotFoundError:
            continue  # nothing supplied for this allowed path
        if stat.S_ISLNK(st.st_mode):
            raise Refused(f"{rel}: replacement is a symlink")
        if not stat.S_ISREG(st.st_mode):
            raise Refused(f"{rel}: replacement is not a regular file")
        if st.st_size > caps["maxFileBytes"]:
            raise Refused(f"{rel}: {st.st_size} bytes exceeds maxFileBytes {caps['maxFileBytes']}")
        if len(replaced) + 1 > caps["maxFiles"]:
            raise Refused(f"more than maxFiles ({caps['maxFiles']}) replacements")

        dst = os.path.join(target, rel)
        assert_target_components(target, rel)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        if os.path.islink(dst):
            raise Refused(f"{rel}: destination in target is a symlink")

        fd = os.open(src, os.O_RDONLY | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0))
        try:
            fst = os.fstat(fd)
            if not stat.S_ISREG(fst.st_mode) or (fst.st_ino, fst.st_dev) != (st.st_ino, st.st_dev):
                raise Refused(f"{rel}: replacement changed while being read")
            written = 0
            tmp = dst + ".airlock-tmp"
            with open(tmp, "wb") as out:
                while True:
                    chunk = os.read(fd, CHUNK)
                    if not chunk:
                        break
                    written += len(chunk)
                    if written > caps["maxFileBytes"]:
                        raise Refused(f"{rel}: grew past maxFileBytes while being read")
                    out.write(chunk)
            os.replace(tmp, dst)
        finally:
            os.close(fd)
            try:
                os.unlink(dst + ".airlock-tmp")
            except FileNotFoundError:
                pass
        total += written
        if total > caps["maxTotalBytes"]:
            raise Refused(f"replacements exceed maxTotalBytes {caps['maxTotalBytes']}")
        replaced.append(rel)

    ignored: list[str] = []
    allowed_set = set(allowed)
    for dirpath, dirnames, filenames in os.walk(replacements, followlinks=False):
        rel_dir = os.path.relpath(dirpath, replacements)
        for name in list(dirnames) + filenames:
            rel = name if rel_dir == "." else f"{rel_dir}/{name}".replace(os.sep, "/")
            full = os.path.join(dirpath, name)
            if rel in allowed_set and name in filenames and not os.path.islink(full):
                continue
            if name in dirnames and not os.path.islink(full) and any(a.startswith(rel + "/") for a in allowed_set):
                continue  # a directory on the way to an allowed path
            if len(ignored) < MAX_IGNORED_LISTED:
                ignored.append(rel[:512])
    return replaced, ignored


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Airlock pristine candidate materializer")
    parser.add_argument("--base", default="/opt/airlock/base")
    parser.add_argument("--target", default="/workspace/src")
    parser.add_argument("--replacements", default="/workspace/replacements")
    parser.add_argument("--profile", default="/opt/airlock/profile/profile.json")
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args(argv)
    try:
        allowed, caps = load_profile(args.profile)
        materialized = copy_base(args.base, args.target, args.force)
        replaced, ignored = overlay(args.replacements, args.target, allowed, caps)
    except Refused as exc:
        sys.stderr.write(f"materialize: refused: {exc}\n")
        return 1
    except OSError as exc:
        sys.stderr.write(f"materialize: I/O error: {exc}\n")
        return 2
    sys.stdout.write(json.dumps({"materialized": materialized, "replaced": replaced, "ignored": ignored}) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
