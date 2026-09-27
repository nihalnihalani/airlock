"""Shared fixtures for runtime/python tests.

Run locally with:  uv run --with pytest pytest runtime/python/tests
(The runtime image carries a pinned pytest for the model's advisory runs of the repository's own
tests; these tests here run on the host, outside the image.)
"""

from __future__ import annotations

import json
import os
import shutil
import sys
from pathlib import Path

import pytest

RUNTIME_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = RUNTIME_DIR.parents[1]
PROFILES_DIR = REPO_ROOT / "profiles"
PROFILE_ID = "tabulate-365"

sys.path.insert(0, str(RUNTIME_DIR))


@pytest.fixture(scope="session")
def repo_root() -> Path:
    return REPO_ROOT


@pytest.fixture(scope="session")
def runtime_dir() -> Path:
    return RUNTIME_DIR


@pytest.fixture(scope="session")
def profile_dir() -> Path:
    return PROFILES_DIR / PROFILE_ID


@pytest.fixture(scope="session")
def profile(profile_dir: Path) -> dict:
    with open(profile_dir / "profile.json", "rb") as fh:
        return json.load(fh)


@pytest.fixture(scope="session")
def contract(profile_dir: Path) -> dict:
    with open(profile_dir / "contract.json", "rb") as fh:
        return json.load(fh)


@pytest.fixture(scope="session")
def base_tree(profile_dir: Path) -> Path:
    base = profile_dir / "base"
    if not (base / "tabulate" / "__init__.py").is_file():
        pytest.skip("profiles/tabulate-365/base not prepared; run runtime/python/prepare-profile.sh tabulate-365")
    return base


@pytest.fixture
def fake_profile_dir(tmp_path: Path) -> Path:
    """A minimal profile dir with a trivial adapter module, for adapter protocol tests."""
    pdir = tmp_path / "profile"
    pdir.mkdir()
    (pdir / "profile.json").write_text(json.dumps({
        "id": "fake",
        "adapterModule": "fake_adapter",
        "allowedReplacementPaths": ["pkg/mod.py", "pkg/other.py", "top.txt"],
        "caps": {"maxFileBytes": 4096, "maxTotalBytes": 6144, "maxFiles": 2},
    }))
    (pdir / "fake_adapter.py").write_text(
        "import sys\n"
        "def run_case(input):\n"
        "    import pkg.mod\n"
        "    return pkg.mod.run(input)\n"
    )
    return pdir


@pytest.fixture
def fake_source_root(tmp_path: Path) -> Path:
    src = tmp_path / "src"
    (src / "pkg").mkdir(parents=True)
    (src / "pkg" / "__init__.py").write_text("")
    (src / "pkg" / "mod.py").write_text(
        "def run(input):\n"
        "    op = input.get('op')\n"
        "    if op == 'echo': return input.get('value')\n"
        "    if op == 'raise': raise IndexError('list index out of range')\n"
        "    if op == 'custom':\n"
        "        class WeirdError(Exception): pass\n"
        "        raise WeirdError('weird')\n"
        "    if op == 'big': return 'x' * int(input.get('n', 70000))\n"
        "    if op == 'print':\n"
        "        print('LEAK TO STDOUT')\n"
        "        return 'printed'\n"
        "    if op == 'object': return object()\n"
        "    if op == 'hang':\n"
        "        import time; time.sleep(30)\n"
        "    if op == 'float': return {'a': 1.0, 'b': 2.5, 'c': float('nan'), 'd': 1e21, 'e': 1e-7, 'f': -0.0}\n"
        "    if op == 'nested': return {'z': [1, {'y': 'ü', 'x': None}], 'a': (True, False)}\n"
        "    if op == 'exit': raise SystemExit(7)\n"
        "    raise ValueError('unknown op %r' % op)\n"
    )
    return src


@pytest.fixture(scope="session")
def docker_available() -> bool:
    if shutil.which("docker") is None:
        return False
    import subprocess

    try:
        proc = subprocess.run(["docker", "info", "--format", "{{.ServerVersion}}"], capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired):
        return False
    return proc.returncode == 0 and bool(proc.stdout.strip())
