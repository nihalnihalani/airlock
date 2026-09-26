#!/usr/bin/env python3
"""Airlock baseline tree digest (stdlib only; safe under ``python -I -S``).

The digest of a source tree is::

    sha256( "".join(f"{path} {sha256(bytes)}\n" for path, bytes in sorted_files) )

where

* ``path`` is the POSIX-style path relative to the tree root,
* every regular file is included; a symlink is included under its own path with the bytes of the
  regular file it resolves to (this is what a checked-out tree looks like to a reader), because
  the reference digest in ``profiles/<id>/profile.json`` was measured over a checkout,
* a ``.git`` directory at the root is skipped,
* the lines are ordered by ``(path.casefold(), path)``: case-insensitive first, exact path as the
  tie-breaker. This is the ordering the pinned profile digests were measured with (a case-folding
  ``sort(1)`` on the profile author's machine); it is written down here so every platform
  reproduces the same bytes. Pure code-point ordering yields a different digest.

Usage::

    tree_digest.py DIR            # prints the digest
    tree_digest.py --lines DIR    # prints the "path sha256" lines instead

Exit status 0 on success; 2 for unreadable trees, broken symlinks or files that are neither
regular nor symlinks to regular files.
"""

from __future__ import annotations

import hashlib
import os
import stat
import sys

CHUNK = 1 << 16


class TreeDigestError(Exception):
    pass


def sort_key(path: str) -> tuple[str, str]:
    return (path.casefold(), path)


def _hash_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        while True:
            chunk = fh.read(CHUNK)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


def tree_lines(root: str) -> list[str]:
    """Return the sorted ``path sha256`` lines for ``root``."""
    root = os.path.abspath(root)
    if not os.path.isdir(root):
        raise TreeDigestError(f"not a directory: {root}")
    entries: list[tuple[str, str]] = []
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        rel_dir = os.path.relpath(dirpath, root)
        if rel_dir == ".":
            dirnames[:] = [d for d in dirnames if d != ".git"]
        # Symlinked directories are not descended (followlinks=False) and are ignored; a checkout
        # of a git tree never contains one that matters for the digest of tracked regular files.
        for name in filenames:
            full = os.path.join(dirpath, name)
            st = os.lstat(full)
            if stat.S_ISLNK(st.st_mode):
                try:
                    target_st = os.stat(full)
                except OSError as exc:
                    raise TreeDigestError(f"broken symlink: {full}: {exc}") from exc
                if not stat.S_ISREG(target_st.st_mode):
                    raise TreeDigestError(f"symlink to non-regular file: {full}")
            elif not stat.S_ISREG(st.st_mode):
                raise TreeDigestError(f"not a regular file: {full}")
            rel = os.path.relpath(full, root).replace(os.sep, "/")
            entries.append((rel, _hash_file(full)))
    entries.sort(key=lambda e: sort_key(e[0]))
    return [f"{p} {d}" for p, d in entries]


def tree_digest(root: str) -> str:
    text = "".join(line + "\n" for line in tree_lines(root))
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def main(argv: list[str]) -> int:
    lines_only = False
    args = list(argv)
    if args and args[0] == "--lines":
        lines_only = True
        args = args[1:]
    if len(args) != 1:
        sys.stderr.write("usage: tree_digest.py [--lines] DIR\n")
        return 2
    try:
        if lines_only:
            sys.stdout.write("".join(line + "\n" for line in tree_lines(args[0])))
        else:
            sys.stdout.write(tree_digest(args[0]) + "\n")
    except (TreeDigestError, OSError) as exc:
        sys.stderr.write(f"tree_digest: {exc}\n")
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
