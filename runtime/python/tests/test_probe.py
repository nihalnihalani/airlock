"""probe.sh: output parses to the IsolationProbe shape with only the three allowed values."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

KEYS = ("metadataEndpoint", "dns", "outboundTcp", "dockerSocket", "hostMounts")
VALUES = {"BLOCKED", "REACHED", "UNKNOWN"}


def test_probe_output_parses_and_is_consistent(runtime_dir: Path):
    # On a developer machine with network access the probe is expected to report REACHED for some
    # checks; the contract here is the shape, the enum and the allBlocked derivation. The blocked
    # case is asserted in the Docker integration test.
    proc = subprocess.run(["bash", str(runtime_dir / "probe.sh")], capture_output=True, text=True, timeout=60)
    lines = proc.stdout.strip().splitlines()
    assert len(lines) == 1, proc.stdout + proc.stderr
    result = json.loads(lines[0])
    for key in KEYS:
        assert result[key] in VALUES, key
    assert isinstance(result["allBlocked"], bool)
    assert result["allBlocked"] == all(result[k] == "BLOCKED" for k in KEYS)
    assert proc.returncode == (0 if result["allBlocked"] else 3)
    assert result["probedAt"].endswith("Z")
    assert isinstance(result["details"], dict)


def test_probe_has_no_curl_dependency(runtime_dir: Path):
    text = (runtime_dir / "probe.sh").read_text()
    assert "curl" not in text.replace("no curl assumed", "")
    assert "-I -S" in text
