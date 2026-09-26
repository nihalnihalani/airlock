"""materialize.py: fresh copy of the base, overlay only at allowed paths, refuse traversal and symlinks."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest


def make_base(tmp_path: Path) -> Path:
    base = tmp_path / "base"
    (base / "pkg").mkdir(parents=True)
    (base / "pkg" / "__init__.py").write_text("")
    (base / "pkg" / "mod.py").write_text("ORIGINAL = 1\n")
    (base / "pkg" / "other.py").write_text("OTHER = 1\n")
    (base / "top.txt").write_text("top\n")
    (base / "README").symlink_to("top.txt")
    # Read-only like the image tree; the copy must still be writable.
    os.chmod(base / "pkg" / "mod.py", 0o444)
    return base


def run_materialize(runtime_dir: Path, *args: str) -> tuple[int, dict | None, str]:
    proc = subprocess.run([sys.executable, str(runtime_dir / "materialize.py"), *args], capture_output=True, text=True, timeout=60)
    out = json.loads(proc.stdout) if proc.stdout.strip() else None
    return proc.returncode, out, proc.stderr


@pytest.fixture
def env(tmp_path, fake_profile_dir, runtime_dir):
    base = make_base(tmp_path)
    ws = tmp_path / "ws"
    ws.mkdir()
    return {
        "base": base, "target": ws / "src", "repl": ws / "replacements",
        "profile": fake_profile_dir / "profile.json", "runtime": runtime_dir,
    }


def args(env, *extra):
    return ("--base", str(env["base"]), "--target", str(env["target"]), "--replacements", str(env["repl"]),
            "--profile", str(env["profile"]), *extra)


def test_fresh_copy_without_replacements(env):
    code, out, err = run_materialize(env["runtime"], *args(env))
    assert code == 0, err
    assert out == {"materialized": 5, "replaced": [], "ignored": []}
    assert (env["target"] / "pkg" / "mod.py").read_text() == "ORIGINAL = 1\n"
    assert os.access(env["target"] / "pkg" / "mod.py", os.W_OK), "author must be able to edit the copy"
    assert (env["target"] / "README").is_symlink()


def test_refuses_existing_target_unless_force(env):
    assert run_materialize(env["runtime"], *args(env))[0] == 0
    (env["target"] / "pkg" / "mod.py").write_text("EDITED\n")
    code, out, err = run_materialize(env["runtime"], *args(env))
    assert code == 1 and out is None and "already exists" in err
    code, out, _ = run_materialize(env["runtime"], *args(env, "--force"))
    assert code == 0
    assert (env["target"] / "pkg" / "mod.py").read_text() == "ORIGINAL = 1\n"


def test_refuses_symlink_target(env):
    elsewhere = env["target"].parent / "elsewhere"
    elsewhere.mkdir()
    env["target"].symlink_to(elsewhere)
    code, _, err = run_materialize(env["runtime"], *args(env, "--force"))
    assert code == 1 and "symlink" in err
    assert elsewhere.exists()


def test_overlays_only_allowed_paths_and_lists_ignored(env):
    repl = env["repl"]
    (repl / "pkg").mkdir(parents=True)
    (repl / "pkg" / "mod.py").write_text("PATCHED = 2\n")
    (repl / "pkg" / "evil.py").write_text("EVIL\n")
    (repl / "setup.py").write_text("import os; os.system('x')\n")
    (repl / "nested").mkdir()
    (repl / "nested" / "deep.txt").write_text("d\n")
    code, out, err = run_materialize(env["runtime"], *args(env))
    assert code == 0, err
    assert out["replaced"] == ["pkg/mod.py"]
    assert set(out["ignored"]) == {"pkg/evil.py", "setup.py", "nested", "nested/deep.txt"}
    assert (env["target"] / "pkg" / "mod.py").read_text() == "PATCHED = 2\n"
    assert not (env["target"] / "pkg" / "evil.py").exists()
    assert not (env["target"] / "setup.py").exists()


def test_refuses_symlink_leaf_and_symlink_component(env):
    repl = env["repl"]
    (repl / "pkg").mkdir(parents=True)
    (repl / "pkg" / "mod.py").symlink_to("/etc/hostname")
    code, _, err = run_materialize(env["runtime"], *args(env))
    assert code == 1 and "symlink" in err
    assert not env["target"].exists() or not (env["target"] / "pkg" / "mod.py").read_text().startswith("PATCH")

    (repl / "pkg" / "mod.py").unlink()
    (repl / "pkg").rmdir()
    outside = env["target"].parent / "outside"
    outside.mkdir()
    (outside / "mod.py").write_text("VIA LINK\n")
    (repl / "pkg").symlink_to(outside)
    code, _, err = run_materialize(env["runtime"], *args(env, "--force"))
    assert code == 1 and "symlink" in err


def test_refuses_non_regular_replacement(env):
    repl = env["repl"]
    (repl / "pkg").mkdir(parents=True)
    os.mkfifo(repl / "pkg" / "mod.py")
    code, _, err = run_materialize(env["runtime"], *args(env))
    assert code == 1 and "not a regular file" in err


def test_refuses_oversize_and_too_many(env):
    repl = env["repl"]
    (repl / "pkg").mkdir(parents=True)
    (repl / "pkg" / "mod.py").write_bytes(b"x" * 4097)
    code, _, err = run_materialize(env["runtime"], *args(env))
    assert code == 1 and "maxFileBytes" in err

    (repl / "pkg" / "mod.py").write_bytes(b"x" * 4000)
    (repl / "pkg" / "other.py").write_bytes(b"y" * 4000)
    (repl / "top.txt").write_bytes(b"z")
    code, _, err = run_materialize(env["runtime"], *args(env, "--force"))
    assert code == 1 and ("maxFiles" in err or "maxTotalBytes" in err)


def test_traversal_in_profile_allowlist_is_refused(env, tmp_path):
    bad = tmp_path / "bad_profile.json"
    bad.write_text(json.dumps({"allowedReplacementPaths": ["../escape.py"], "caps": {"maxFileBytes": 1, "maxTotalBytes": 1, "maxFiles": 1}}))
    env["profile"] = bad
    code, _, err = run_materialize(env["runtime"], *args(env))
    assert code == 1 and "invalid path" in err


def test_replacement_dir_that_is_a_symlink_is_refused(env):
    other = env["target"].parent / "other"
    other.mkdir()
    env["repl"].symlink_to(other)
    code, _, err = run_materialize(env["runtime"], *args(env))
    assert code == 1 and "not a directory" in err


def test_real_profile_and_base(runtime_dir, profile_dir, base_tree, tmp_path):
    target = tmp_path / "src"
    repl = tmp_path / "replacements"
    (repl / "tabulate").mkdir(parents=True)
    (repl / "tabulate" / "__init__.py").write_text("# candidate\n")
    code, out, err = run_materialize(runtime_dir, "--base", str(base_tree), "--target", str(target),
                                     "--replacements", str(repl), "--profile", str(profile_dir / "profile.json"))
    assert code == 0, err
    assert out["materialized"] == 23 and out["replaced"] == ["tabulate/__init__.py"]
    assert (target / "tabulate" / "__init__.py").read_text() == "# candidate\n"
    assert (target / "test" / "test_api.py").is_file()
    assert not (target / ".git").exists()
