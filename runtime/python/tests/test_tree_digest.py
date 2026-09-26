"""tree_digest.py and prepare-profile.sh: the pinned digest reproduces; mismatches are refused."""

from __future__ import annotations

import hashlib
import os
import shutil
import subprocess
from pathlib import Path

import pytest

import tree_digest


def test_ordering_is_case_insensitive_then_exact(tmp_path: Path):
    # Names must not collide case-insensitively: macOS APFS is case-insensitive by default.
    for name in ("b.txt", "A.txt", "c.txt", ".hidden", "Zdir/x", "ydir/y", "B-dash.txt"):
        p = tmp_path / name
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(name)
    lines = tree_digest.tree_lines(tmp_path)
    assert [l.split(" ")[0] for l in lines] == [".hidden", "A.txt", "B-dash.txt", "b.txt", "c.txt", "ydir/y", "Zdir/x"]
    for line in lines:
        path, digest = line.split(" ")
        assert digest == hashlib.sha256(path.encode()).hexdigest()


def test_symlink_is_hashed_as_its_target_bytes_and_git_is_skipped(tmp_path: Path):
    (tmp_path / "real").write_text("content")
    (tmp_path / "link").symlink_to("real")
    (tmp_path / ".git").mkdir()
    (tmp_path / ".git" / "HEAD").write_text("ref")
    lines = tree_digest.tree_lines(tmp_path)
    assert [l.split(" ")[0] for l in lines] == ["link", "real"]
    assert lines[0].split(" ")[1] == lines[1].split(" ")[1]


def test_broken_symlink_and_special_files_are_errors(tmp_path: Path):
    (tmp_path / "dangling").symlink_to("nowhere")
    with pytest.raises(tree_digest.TreeDigestError):
        tree_digest.tree_digest(tmp_path)
    (tmp_path / "dangling").unlink()
    os.mkfifo(tmp_path / "fifo")
    with pytest.raises(tree_digest.TreeDigestError):
        tree_digest.tree_digest(tmp_path)


def test_pinned_profile_digest_reproduces(base_tree: Path, profile: dict):
    assert tree_digest.tree_digest(base_tree) == profile["baselineTreeDigest"]


def test_prepare_profile_refuses_digest_mismatch(runtime_dir: Path, repo_root: Path, tmp_path: Path):
    if shutil.which("git") is None:
        pytest.skip("git not available")
    # Copy the script pair into a fake repo layout whose profile points at a wrong digest but at the
    # real reference clone, so no network is needed.
    clone = repo_root / "research" / "reference-repos" / "python-tabulate"
    if not (clone / ".git").is_dir():
        pytest.skip("reference clone research/reference-repos/python-tabulate not present")
    fake = tmp_path / "repo"
    (fake / "runtime" / "python").mkdir(parents=True)
    (fake / "profiles" / "wrongdigest").mkdir(parents=True)
    (fake / "research" / "reference-repos").mkdir(parents=True)
    os.symlink(clone, fake / "research" / "reference-repos" / "python-tabulate")
    for name in ("prepare-profile.sh", "tree_digest.py"):
        shutil.copy(runtime_dir / name, fake / "runtime" / "python" / name)
    (fake / "profiles" / "wrongdigest" / "profile.json").write_text(
        '{"repository": "https://github.com/astanin/python-tabulate", '
        '"baselineCommit": "e13a4d0dd292cade200e653eb9155a1ca0f1dbea", '
        '"baselineTreeDigest": "0000000000000000000000000000000000000000000000000000000000000000"}'
    )
    proc = subprocess.run(["bash", str(fake / "runtime" / "python" / "prepare-profile.sh"), "wrongdigest"],
                          capture_output=True, text=True, timeout=120)
    assert proc.returncode == 2, proc.stderr
    assert "REFUSING" in proc.stderr and "d20b5bf8" in proc.stderr
    assert not (fake / "profiles" / "wrongdigest" / "base").exists()
    assert not list((fake / "profiles" / "wrongdigest").glob(".base.tmp.*"))


def test_prepare_profile_rejects_bad_ids(runtime_dir: Path):
    for bad in ("../x", "a b", ""):
        proc = subprocess.run(["bash", str(runtime_dir / "prepare-profile.sh"), bad], capture_output=True, text=True, timeout=30)
        assert proc.returncode == 1
