"""collect_outputs.py: every rejection rule, caps, ordering, envelope shape, -I -S isolation.

Run on the host:  uv run --with pytest pytest runtime/outputs/tests
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import socket
import struct
import subprocess
import sys
import tempfile
import zlib
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parents[1]
COLLECTOR = HERE / "collect_outputs.py"
sys.path.insert(0, str(HERE))

import collect_outputs as co  # noqa: E402


def png(width: int = 4, height: int = 3, *, crc_ok: bool = True, signature: bytes = co.PNG_SIGNATURE) -> bytes:
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    crc = zlib.crc32(b"IHDR" + ihdr) & 0xFFFFFFFF
    if not crc_ok:
        crc ^= 1
    raw = b"".join(b"\x00" + b"\x00" * (width * 3) for _ in range(min(height, 4)))
    idat = zlib.compress(raw)
    chunk = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)  # noqa: E731
    return signature + struct.pack(">I", 13) + b"IHDR" + ihdr + struct.pack(">I", crc) + chunk(b"IDAT", idat) + chunk(b"IEND", b"")


def run(root: Path, *extra: str) -> tuple[int, dict | None, str]:
    # Exactly how the supervisor runs it: isolated interpreter, no site, cwd outside the root.
    proc = subprocess.run(
        [sys.executable, "-I", "-S", str(COLLECTOR), "--root", str(root), *extra],
        capture_output=True, text=True, timeout=60, cwd="/",
    )
    out = json.loads(proc.stdout) if proc.stdout.strip() else None
    return proc.returncode, out, proc.stderr


def reasons(env: dict) -> dict[str, str]:
    return {r["path"]: r["reason"] for r in env["rejected"]}


def paths(env: dict) -> list[str]:
    return [f["path"] for f in env["files"]]


@pytest.fixture
def root(tmp_path: Path) -> Path:
    r = tmp_path / "candidate"
    (r / "outputs").mkdir(parents=True)
    (r / "inputs").mkdir()
    (r / "inputs" / "secret.csv").write_text("not collected\n")
    return r


def test_happy_path_envelope_shape_and_media_types(root: Path) -> None:
    out = root / "outputs"
    (out / "summary.json").write_text('{"worst":"West"}')
    (out / "chart.png").write_bytes(png())
    (out / "table.csv").write_text("region,revenue\nWest,1\n")
    (out / "notes.md").write_text("# notes é\n")
    (out / "log.txt").write_text("ok\n")
    (out / "analysis.py").write_text("print(1)\n")
    (out / "a.js").write_text("1\n")
    (out / "b.mjs").write_text("export {}\n")
    rc, env, err = run(root)
    assert rc == 0, err
    assert env["schemaVersion"] == 1
    assert env["rejected"] == []
    assert paths(env) == sorted(paths(env))
    media = {f["path"]: f["mediaType"] for f in env["files"]}
    assert media == {
        "a.js": "text/javascript", "analysis.py": "text/x-python", "b.mjs": "text/javascript",
        "chart.png": "image/png", "log.txt": "text/plain", "notes.md": "text/markdown",
        "summary.json": "application/json", "table.csv": "text/csv",
    }
    for f in env["files"]:
        data = (out / f["path"]).read_bytes()
        assert set(f) == {"path", "byteLength", "sha256", "contentBase64", "mediaType"}
        assert f["byteLength"] == len(data)
        assert f["sha256"] == hashlib.sha256(data).hexdigest()
        assert base64.b64decode(f["contentBase64"]) == data


def test_only_outputs_walked_and_nested_dirs_ordered(root: Path) -> None:
    out = root / "outputs"
    (out / "b").mkdir()
    (out / "b" / "z.txt").write_text("z")
    (out / "a.txt").write_text("a")
    (out / "B.txt").write_text("B")
    (out / "b.csv").write_text("x\n")
    rc, env, _ = run(root)
    assert rc == 0
    assert paths(env) == ["B.txt", "a.txt", "b.csv", "b/z.txt"]  # code-point order
    assert all("secret" not in p for p in paths(env))


def test_missing_outputs_is_empty_envelope(tmp_path: Path) -> None:
    (tmp_path / "ws").mkdir()
    rc, env, _ = run(tmp_path / "ws")
    assert rc == 0 and env == {"schemaVersion": 1, "files": [], "rejected": []}


def test_outputs_symlink_rejected(tmp_path: Path) -> None:
    ws = tmp_path / "ws"
    ws.mkdir()
    (tmp_path / "elsewhere").mkdir()
    (tmp_path / "elsewhere" / "x.txt").write_text("x")
    (ws / "outputs").symlink_to(tmp_path / "elsewhere")
    rc, env, _ = run(ws)
    assert rc == 0 and env["files"] == []
    assert reasons(env) == {"outputs": "symlink component 'outputs'"}


def test_outputs_not_directory_rejected(tmp_path: Path) -> None:
    ws = tmp_path / "ws"
    ws.mkdir()
    (ws / "outputs").write_text("file")
    rc, env, _ = run(ws)
    assert rc == 0 and env["files"] == [] and reasons(env) == {"outputs": "outputs is not a directory"}


def test_symlink_leaf_rejected(root: Path) -> None:
    (root / "outputs" / "passwd.csv").symlink_to("/etc/passwd")
    (root / "outputs" / "dangling.txt").symlink_to(root / "nope")
    rc, env, _ = run(root)
    assert env["files"] == []
    assert reasons(env) == {"dangling.txt": "symlink", "passwd.csv": "symlink"}


def test_symlink_directory_component_rejected(root: Path) -> None:
    (root / "outputs" / "sub").symlink_to(root / "inputs", target_is_directory=True)
    _, env, _ = run(root)
    assert env["files"] == [] and reasons(env) == {"sub": "symlink"}


def test_hardlink_rejected(root: Path) -> None:
    (root / "inputs" / "orig.csv").write_text("a,b\n")
    os.link(root / "inputs" / "orig.csv", root / "outputs" / "copy.csv")
    _, env, _ = run(root)
    assert env["files"] == [] and reasons(env)["copy.csv"].startswith("hardlink")


def test_fifo_rejected(root: Path) -> None:
    os.mkfifo(root / "outputs" / "pipe.txt")
    _, env, _ = run(root)
    assert reasons(env) == {"pipe.txt": "not a regular file"}


def test_socket_rejected() -> None:
    # AF_UNIX paths are short on macOS; use a short temp dir.
    with tempfile.TemporaryDirectory(dir="/tmp") as d:
        ws = Path(d)
        (ws / "outputs").mkdir()
        s = socket.socket(socket.AF_UNIX)
        try:
            s.bind(str(ws / "outputs" / "s.txt"))
            _, env, _ = run(ws)
        finally:
            s.close()
    assert reasons(env) == {"s.txt": "not a regular file"}


def test_svg_and_html_refused_explicitly(root: Path) -> None:
    (root / "outputs" / "chart.svg").write_text('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
    (root / "outputs" / "Other.SVG").write_text("<svg/>")
    (root / "outputs" / "page.html").write_text("<script></script>")
    _, env, _ = run(root)
    r = reasons(env)
    assert env["files"] == []
    assert "svg is active content" in r["chart.svg"] and "svg is active content" in r["Other.SVG"]
    assert "html is active content" in r["page.html"]


def test_disallowed_extensions(root: Path) -> None:
    for name in ("run.sh", "Makefile", "data.xlsx", "x.PNG", "evil.exe"):
        (root / "outputs" / name).write_bytes(b"x")
    _, env, _ = run(root)
    r = reasons(env)
    assert env["files"] == [] and set(r) == {"run.sh", "Makefile", "data.xlsx", "x.PNG", "evil.exe"}
    assert all("not allowed" in v for v in r.values())


def test_hidden_and_bad_names(root: Path) -> None:
    (root / "outputs" / ".env.txt").write_text("x")
    (root / "outputs" / ".hidden").mkdir()
    (root / "outputs" / ".hidden" / "a.txt").write_text("x")
    (root / "outputs" / "tab\there.txt").write_text("x")
    (root / "outputs" / "back\\slash.txt").write_text("x")
    _, env, _ = run(root)
    r = reasons(env)
    assert env["files"] == []
    assert r[".env.txt"] == "hidden file" and r[".hidden"] == "hidden file"
    assert r["tab\there.txt"].startswith("control")
    assert r["back\\slash.txt"] == "traversal or separator in name"


def test_name_checks_unit() -> None:
    assert co.name_problem(b"\xff\xfe.txt") == "name is not valid UTF-8"
    assert co.name_problem(b"..") == "traversal or separator in name"
    assert co.name_problem("é.txt".encode()) == "name is not NFC-normalised"
    assert co.name_problem(b"a" * 256) == "name too long"
    assert co.name_problem("‮evil.txt".encode()) is not None  # bidi override (Cf)
    assert co.name_problem("résumé.csv".encode()) is None
    assert not co.is_rel_path("../x") and not co.is_rel_path("/etc/passwd") and not co.is_rel_path("a//b")


@pytest.mark.skipif(sys.platform == "darwin", reason="APFS refuses non-UTF-8 file names")
def test_non_utf8_name_rejected(root: Path) -> None:
    os.close(os.open(os.path.join(os.fsencode(root / "outputs"), b"bad\xff.txt"), os.O_CREAT | os.O_WRONLY, 0o644))
    _, env, _ = run(root)
    assert env["files"] == [] and list(reasons(env).values()) == ["name is not valid UTF-8"]


def test_case_insensitive_duplicate_rejected(tmp_path: Path) -> None:
    ws = tmp_path / "ws"
    (ws / "outputs").mkdir(parents=True)
    (ws / "outputs" / "Summary.csv").write_text("a\n")
    try:
        (ws / "outputs" / "summary.csv").write_text("b\n")
    except OSError:
        pytest.skip("case-insensitive host file system")
    if len(os.listdir(ws / "outputs")) != 2:
        pytest.skip("case-insensitive host file system")
    _, env, _ = run(ws)
    assert paths(env) == ["Summary.csv"]
    assert reasons(env) == {"summary.csv": "duplicate (case-insensitive) path"}


def test_duplicate_unit_walker(tmp_path: Path) -> None:
    # Exercise the duplicate rule directly (works on case-insensitive hosts too).
    w = co.Walker({"maxFileBytes": 100, "maxTotalBytes": 1000, "maxFiles": 10})
    d = tmp_path / "d"
    d.mkdir()
    (d / "a.txt").write_text("x")
    fd = os.open(d, co.O_FLAGS_DIR)
    try:
        st = os.stat(b"a.txt", dir_fd=fd, follow_symlinks=False)
        w.consider_file(fd, b"a.txt", "Dir/A.txt", st)
        w.consider_file(fd, b"a.txt", "dir/a.txt", st)
    finally:
        os.close(fd)
    assert [f["path"] for f in w.files] == ["Dir/A.txt"]
    assert w.rejected == [{"path": "dir/a.txt", "reason": "duplicate (case-insensitive) path"}]


def test_per_file_cap(root: Path) -> None:
    (root / "outputs" / "big.txt").write_bytes(b"a" * 101)
    (root / "outputs" / "ok.txt").write_bytes(b"a" * 100)
    _, env, _ = run(root, "--max-file-bytes", "100")
    assert paths(env) == ["ok.txt"] and reasons(env)["big.txt"].startswith("oversize (101 > 100)")


def test_default_per_file_cap_is_5mib(root: Path) -> None:
    (root / "outputs" / "big.txt").write_bytes(b"a" * (5 * 1024 * 1024 + 1))
    _, env, _ = run(root)
    assert env["files"] == [] and reasons(env)["big.txt"].startswith("oversize")


def test_caps_can_only_be_lowered(root: Path) -> None:
    (root / "outputs" / "big.txt").write_bytes(b"a" * (5 * 1024 * 1024 + 1))
    _, env, _ = run(root, "--max-file-bytes", str(50 * 1024 * 1024), "--max-files", "1000")
    assert env["files"] == [] and reasons(env)["big.txt"].startswith("oversize")
    rc, _, err = run(root, "--max-files", "0")
    assert rc == 1 and "positive" in err


def test_total_cap(root: Path) -> None:
    for name in ("a.txt", "b.txt", "c.txt"):
        (root / "outputs" / name).write_bytes(b"x" * 40)
    _, env, _ = run(root, "--max-total-bytes", "100")
    assert paths(env) == ["a.txt", "b.txt"]
    assert reasons(env) == {"c.txt": "exceeds maxTotalBytes (100)"}


def test_max_files(root: Path) -> None:
    for i in range(55):
        (root / "outputs" / f"f{i:02d}.txt").write_text("x")
    _, env, _ = run(root)
    assert len(env["files"]) == 50
    assert paths(env)[-1] == "f49.txt"
    assert len(env["rejected"]) == 5 and all("maxFiles (50)" in r["reason"] for r in env["rejected"])


def test_entry_budget_stops_walk(root: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    for i in range(12):
        (root / "outputs" / f"f{i:02d}.bin").write_text("x")
    monkeypatch.setattr(co, "MAX_ENTRIES", 5)
    env = co.collect(str(root), {"maxFileBytes": 100, "maxTotalBytes": 1000, "maxFiles": 50})
    assert "walk stopped" in env["rejected"][-1]["reason"]
    assert len(env["rejected"]) == 6


def test_depth_limit(root: Path) -> None:
    d = root / "outputs"
    for i in range(co.MAX_DEPTH + 1):
        d = d / f"d{i}"
    d.mkdir(parents=True)
    (d / "deep.txt").write_text("x")
    _, env, _ = run(root)
    assert env["files"] == []
    assert list(reasons(env).values()) == [f"deeper than {co.MAX_DEPTH} directories"]


def test_png_rules(root: Path) -> None:
    out = root / "outputs"
    (out / "good.png").write_bytes(png(8192, 1))
    (out / "sig.png").write_bytes(png(signature=b"\x89PNX\r\n\x1a\n"))
    (out / "wide.png").write_bytes(png(8193, 10))
    (out / "tall.png").write_bytes(png(10, 100000))
    (out / "zero.png").write_bytes(png(0, 10))
    (out / "crc.png").write_bytes(png(crc_ok=False))
    (out / "short.png").write_bytes(co.PNG_SIGNATURE + b"\x00")
    (out / "fake.png").write_text("<svg onload=alert(1)>")
    _, env, _ = run(root)
    r = reasons(env)
    assert paths(env) == ["good.png"]
    assert r["sig.png"] == "not a PNG (bad signature)"
    assert "outside 1..8192" in r["wide.png"] and "outside 1..8192" in r["tall.png"] and "outside" in r["zero.png"]
    assert r["crc.png"] == "PNG IHDR CRC mismatch"
    assert r["short.png"] == "not a PNG (bad signature)"
    assert r["fake.png"] == "not a PNG (bad signature)"


def test_text_must_be_utf8_without_nul(root: Path) -> None:
    out = root / "outputs"
    (out / "latin1.csv").write_bytes(b"caf\xe9\n")
    (out / "trunc.txt").write_bytes(b"ok \xe2\x82")
    (out / "nul.md").write_bytes(b"a\x00b")
    (out / "code.py").write_bytes(b"\xff")
    # A multi-byte character split across the 64 KiB read boundary is still valid.
    (out / "split.txt").write_bytes(b"a" * (co.CHUNK - 1) + "€".encode())
    _, env, _ = run(root)
    r = reasons(env)
    assert paths(env) == ["split.txt"]
    assert r["latin1.csv"] == "not valid UTF-8"
    assert r["trunc.txt"] == "not valid UTF-8 (truncated sequence)"
    assert r["nul.md"] == "NUL byte in text file"
    assert r["code.py"] == "not valid UTF-8"


def test_json_must_parse(root: Path) -> None:
    (root / "outputs" / "bad.json").write_text("{'single': quotes}")
    (root / "outputs" / "deep.json").write_text("[" * 100000 + "]" * 100000)
    (root / "outputs" / "ok.json").write_text('[1, "é", {"a": null}]')
    _, env, _ = run(root)
    r = reasons(env)
    assert paths(env) == ["ok.json"]
    assert r["bad.json"] == "not valid JSON" and r["deep.json"] == "not valid JSON"


def test_grows_while_reading_rejected(root: Path) -> None:
    # Simulate a file larger than its lstat size (appended between lstat and read).
    p = root / "outputs" / "grow.txt"
    p.write_bytes(b"a" * 10)
    w = co.Walker({"maxFileBytes": 20, "maxTotalBytes": 1000, "maxFiles": 10})
    fd = os.open(root / "outputs", co.O_FLAGS_DIR)
    try:
        st = os.stat(b"grow.txt", dir_fd=fd, follow_symlinks=False)
        p.write_bytes(b"a" * 30)
        w.consider_file(fd, b"grow.txt", "grow.txt", st)
    finally:
        os.close(fd)
    assert w.files == [] and w.rejected[0]["reason"] == "oversize while reading (> 20)"


def test_unusable_root(tmp_path: Path) -> None:
    rc, env, err = run(tmp_path / "missing")
    assert rc == 1 and env is None and "not a directory" in err
    (tmp_path / "link").symlink_to(tmp_path)
    rc, env, _ = run(tmp_path / "link")
    assert rc == 1 and env is None
    proc = subprocess.run([sys.executable, "-I", "-S", str(COLLECTOR), "--root", "relative"], capture_output=True, text=True, cwd="/")
    assert proc.returncode == 1 and "absolute" in proc.stderr


def test_never_imports_from_workspace(root: Path) -> None:
    # A json.py / codecs.py in the workspace or its outputs must never shadow the stdlib.
    for d in (root, root / "outputs"):
        (d / "json.py").write_text("raise SystemExit('shadowed')\n")
        (d / "codecs.py").write_text("raise SystemExit('shadowed')\n")
    proc = subprocess.run([sys.executable, "-I", "-S", str(COLLECTOR), "--root", str(root)], capture_output=True, text=True, cwd=str(root / "outputs"))
    assert proc.returncode == 0, proc.stderr
    env = json.loads(proc.stdout)
    assert paths(env) == ["codecs.py", "json.py"]  # collected as data, not executed


def test_rejected_list_is_bounded(root: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(co, "MAX_REJECTED", 3)
    for i in range(6):
        (root / "outputs" / f"x{i}.exe").write_text("x")
    env = co.collect(str(root), {"maxFileBytes": 100, "maxTotalBytes": 1000, "maxFiles": 50})
    assert len(env["rejected"]) == 4 and env["rejected"][-1]["reason"] == "further rejections omitted"
