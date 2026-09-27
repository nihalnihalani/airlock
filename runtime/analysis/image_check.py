#!/usr/bin/env python3
"""Build-time self-check for airlock-runtime-analysis. Fails the docker build on any mismatch.

    python3 -I /opt/airlock/image_check.py      (run once, as root, during the build)

Checks: installed distributions == requirements.lock exactly (nothing extra, nothing missing, same
versions); pip/ensurepip absent; no compiler or linker on PATH; no setuid/setgid files; matplotlib
backend is Agg, the prebuilt font cache exists and a PNG renders; readiness under -I -S; the fixed
scripts are present with the expected modes; the collector runs under -I -S.
"""

from __future__ import annotations

import importlib.metadata as md
import io
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile

FAIL: list[str] = []


def check(cond: bool, what: str) -> None:
    print(("ok    " if cond else "FAIL  ") + what)
    if not cond:
        FAIL.append(what)


def norm(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def main() -> int:
    locked: dict[str, str] = {}
    with open("/opt/airlock/requirements.lock", encoding="utf-8") as fh:
        for line in fh:
            m = re.match(r"^([A-Za-z0-9][A-Za-z0-9._-]*)==([^ \\]+)", line)
            if m:
                locked[norm(m.group(1))] = m.group(2)
    installed = {norm(d.metadata["Name"]): d.version for d in md.distributions()}
    check(installed == locked, f"installed distributions == requirements.lock ({len(locked)} pinned)")
    if installed != locked:
        print("      extra/mismatch:", {k: v for k, v in installed.items() if locked.get(k) != v})
        print("      missing:", sorted(set(locked) - set(installed)))

    check(subprocess.run([sys.executable, "-c", "import pip"], capture_output=True).returncode != 0, "pip not importable")
    check(not os.path.exists("/usr/local/lib/python3.12/ensurepip"), "ensurepip removed")
    for tool in ("pip", "pip3", "gcc", "cc", "c++", "g++", "clang", "ld", "as", "make", "curl", "wget"):
        check(shutil.which(tool) is None, f"{tool} not on PATH")

    suid = []
    for top in ("/bin", "/sbin", "/usr", "/etc", "/opt", "/lib", "/var"):
        for dirpath, _dirs, files in os.walk(top):
            for f in files:
                p = os.path.join(dirpath, f)
                try:
                    st = os.lstat(p)
                except OSError:
                    continue
                if stat.S_ISREG(st.st_mode) and st.st_mode & (stat.S_ISUID | stat.S_ISGID):
                    suid.append(p)
    check(not suid, f"no setuid/setgid files {suid[:5]}")

    import matplotlib

    check(matplotlib.get_backend().lower() == "agg", f"matplotlib backend Agg ({matplotlib.get_backend()})")
    check(any(n.startswith("fontlist-") for n in os.listdir("/opt/airlock/mplcache")), "prebuilt font cache present")
    import matplotlib.pyplot as plt
    import numpy
    import openpyxl  # noqa: F401
    import pandas

    fig, ax = plt.subplots()
    ax.bar(["a", "b"], numpy.array([1, 2]))
    buf = io.BytesIO()
    fig.savefig(buf, format="png")
    check(buf.getvalue()[:8] == b"\x89PNG\r\n\x1a\n", "matplotlib renders PNG")
    check(pandas.DataFrame({"a": [1, 2]})["a"].sum() == 3, "pandas works")

    ready = subprocess.run([sys.executable, "-I", "-S", "-c", "print('ready')"], capture_output=True, text=True)
    check(ready.stdout.strip() == "ready", "readiness python3 -I -S")
    for script in ("probe.sh", "collect_outputs.py", "run.sh", "image_check.py"):
        p = "/opt/airlock/" + script
        st = os.stat(p)
        check(st.st_uid == 0 and stat.S_IMODE(st.st_mode) == 0o555, f"{p} root-owned 0555")
    with tempfile.TemporaryDirectory() as d:
        os.mkdir(os.path.join(d, "outputs"))
        with open(os.path.join(d, "outputs", "x.txt"), "w") as fh:
            fh.write("x")
        out = subprocess.run([sys.executable, "-I", "-S", "/opt/airlock/collect_outputs.py", "--root", d], capture_output=True, text=True, cwd="/")
        check(out.returncode == 0 and '"path":"x.txt"' in out.stdout, "collector runs under -I -S")

    if FAIL:
        print(f"image_check: {len(FAIL)} failure(s)", file=sys.stderr)
        return 1
    print("image_check: all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
