"""collector.py: symlink components, non-regular files, oversize, duplicates, sha256 + byteLength."""

from __future__ import annotations

import base64
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest


def run_collector(runtime_dir: Path, root: Path, profile: Path) -> tuple[int, dict | None, str]:
    # Exactly how the supervisor runs it: isolated interpreter, no site, cwd outside the root.
    proc = subprocess.run(
        [sys.executable, "-I", "-S", str(runtime_dir / "collector.py"), "--root", str(root), "--profile", str(profile)],
        capture_output=True, text=True, timeout=60, cwd="/",
    )
    out = json.loads(proc.stdout) if proc.stdout.strip() else None
    return proc.returncode, out, proc.stderr


def write_profile(path: Path, allowed: list, caps: dict | None = None) -> Path:
    path.write_text(json.dumps({"allowedReplacementPaths": allowed,
                                "caps": caps or {"maxFileBytes": 4096, "maxTotalBytes": 6144, "maxFiles": 2}}))
    return path


@pytest.fixture
def root(tmp_path: Path) -> Path:
    r = tmp_path / "candidate"
    (r / "pkg").mkdir(parents=True)
    (r / "pkg" / "mod.py").write_bytes(b"PATCHED = 2\n\xf0\x9f\x98\x80")
    (r / "pkg" / "other.py").write_bytes(b"OTHER\n")
    (r / "top.txt").write_bytes(b"top\n")
    return r


def by_path(env: dict) -> dict:
    return {f["path"]: f for f in env["files"]}


def rejected(env: dict) -> dict:
    return {r["path"]: r["reason"] for r in env["rejected"]}


def test_collects_allowed_regular_files_with_correct_digest(runtime_dir, root, tmp_path):
    profile = write_profile(tmp_path / "p.json", ["pkg/mod.py", "top.txt"])
    code, env, err = run_collector(runtime_dir, root, profile)
    assert code == 0, err
    assert env["schemaVersion"] == 1 and env["rejected"] == []
    files = by_path(env)
    raw = (root / "pkg" / "mod.py").read_bytes()
    assert files["pkg/mod.py"]["byteLength"] == len(raw)
    assert files["pkg/mod.py"]["sha256"] == hashlib.sha256(raw).hexdigest()
    assert base64.b64decode(files["pkg/mod.py"]["contentBase64"]) == raw
    assert [f["path"] for f in env["files"]] == ["pkg/mod.py", "top.txt"]


def test_missing_file_is_reported_not_fatal(runtime_dir, root, tmp_path):
    profile = write_profile(tmp_path / "p.json", ["pkg/mod.py", "pkg/gone.py"])
    code, env, _ = run_collector(runtime_dir, root, profile)
    assert code == 0
    assert list(by_path(env)) == ["pkg/mod.py"]
    assert rejected(env) == {"pkg/gone.py": "missing"}


def test_rejects_symlink_leaf_and_symlink_component(runtime_dir, root, tmp_path):
    (root / "pkg" / "other.py").unlink()
    (root / "pkg" / "other.py").symlink_to(root / "top.txt")
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "secret.py").write_text("S")
    (root / "link").symlink_to(outside)
    profile = write_profile(tmp_path / "p.json", ["pkg/other.py", "link/secret.py", "pkg/mod.py"])
    code, env, _ = run_collector(runtime_dir, root, profile)
    assert code == 0
    assert list(by_path(env)) == ["pkg/mod.py"]
    r = rejected(env)
    assert r["pkg/other.py"] == "symlink"
    assert "symlink component" in r["link/secret.py"]


def test_rejects_non_regular_and_directory(runtime_dir, root, tmp_path):
    os.mkfifo(root / "pkg" / "fifo.py")
    (root / "pkg" / "dir.py").mkdir()
    profile = write_profile(tmp_path / "p.json", ["pkg/fifo.py", "pkg/dir.py"])
    code, env, _ = run_collector(runtime_dir, root, profile)
    assert code == 0 and env["files"] == []
    r = rejected(env)
    assert r["pkg/fifo.py"] == "not a regular file"
    assert r["pkg/dir.py"] == "directory"


def test_rejects_hardlink(runtime_dir, root, tmp_path):
    os.link(root / "top.txt", root / "pkg" / "linked.py")
    profile = write_profile(tmp_path / "p.json", ["pkg/linked.py"])
    _, env, _ = run_collector(runtime_dir, root, profile)
    assert env["files"] == [] and rejected(env)["pkg/linked.py"].startswith("hardlink")


def test_rejects_oversize_and_bounds_count_and_total(runtime_dir, root, tmp_path):
    (root / "pkg" / "mod.py").write_bytes(b"x" * 4097)
    profile = write_profile(tmp_path / "p.json", ["pkg/mod.py"])
    _, env, _ = run_collector(runtime_dir, root, profile)
    assert env["files"] == [] and rejected(env)["pkg/mod.py"].startswith("oversize")

    (root / "pkg" / "mod.py").write_bytes(b"x" * 4000)
    (root / "pkg" / "other.py").write_bytes(b"y" * 4000)
    profile = write_profile(tmp_path / "p.json", ["pkg/mod.py", "pkg/other.py", "top.txt"])
    _, env, _ = run_collector(runtime_dir, root, profile)
    assert list(by_path(env)) == ["pkg/mod.py", "top.txt"]
    assert "maxTotalBytes" in rejected(env)["pkg/other.py"]

    profile = write_profile(tmp_path / "p.json", ["pkg/mod.py", "top.txt"],
                            {"maxFileBytes": 4096, "maxTotalBytes": 6144, "maxFiles": 1})
    _, env, _ = run_collector(runtime_dir, root, profile)
    assert list(by_path(env)) == ["pkg/mod.py"]
    assert "maxFiles" in rejected(env)["top.txt"]


def test_rejects_duplicates_and_invalid_allowlist_entries(runtime_dir, root, tmp_path):
    profile = write_profile(tmp_path / "p.json", ["top.txt", "top.txt", "../etc/passwd", "/abs", "a//b", 5])
    code, env, _ = run_collector(runtime_dir, root, profile)
    assert code == 0
    assert list(by_path(env)) == ["top.txt"]
    reasons = [r["reason"] for r in env["rejected"]]
    assert reasons.count("duplicate") == 1
    assert reasons.count("invalid path in allowlist") == 4


def test_unusable_root_or_profile_exits_nonzero(runtime_dir, root, tmp_path):
    profile = write_profile(tmp_path / "p.json", ["top.txt"])
    code, env, err = run_collector(runtime_dir, tmp_path / "missing", profile)
    assert code == 1 and env is None and "not a directory" in err
    link = tmp_path / "rootlink"
    link.symlink_to(root)
    code, env, err = run_collector(runtime_dir, link, profile)
    assert code == 1 and "not a directory" in err
    code, env, err = run_collector(runtime_dir, root, tmp_path / "nope.json")
    assert code == 1 and "cannot read profile" in err
    bad = tmp_path / "bad.json"
    bad.write_text(json.dumps({"allowedReplacementPaths": [], "caps": {}}))
    code, env, err = run_collector(runtime_dir, root, bad)
    assert code == 1


def test_never_imports_from_candidate(runtime_dir, root, tmp_path):
    # A sitecustomize/usercustomize or a shadowing stdlib module in the candidate must have no effect.
    for name in ("sitecustomize.py", "usercustomize.py", "json.py", "hashlib.py", "os.py"):
        (root / name).write_text("raise SystemExit('IMPORTED FROM CANDIDATE')\n")
    profile = write_profile(tmp_path / "p.json", ["top.txt"])
    code, env, err = run_collector(runtime_dir, root, profile)
    assert code == 0, err
    assert list(by_path(env)) == ["top.txt"]


def test_real_profile_base_tree(runtime_dir, profile_dir, base_tree, profile):
    code, env, err = run_collector(runtime_dir, base_tree, profile_dir / "profile.json")
    assert code == 0, err
    files = by_path(env)
    assert list(files) == ["tabulate/__init__.py"] and env["rejected"] == []
    raw = (base_tree / "tabulate" / "__init__.py").read_bytes()
    assert files["tabulate/__init__.py"]["sha256"] == hashlib.sha256(raw).hexdigest()
    assert files["tabulate/__init__.py"]["byteLength"] == len(raw) <= profile["caps"]["maxFileBytes"]
