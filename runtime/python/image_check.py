#!/usr/bin/env python3
"""Build-time self-check for airlock-runtime-python:<profileId> (run once by the Dockerfile).

    python3 /opt/airlock/image_check.py <profileId> <adapterModule>

Fails the build unless:
* /opt/airlock/profile/profile.json describes exactly this profile (id, adapterModule, language,
  sourceRoot, runtimeImage) and the adapter module file is present,
* /opt/airlock/profile/contract.json is ABSENT (the sandbox never sees expected values),
* the baseline tree at /opt/airlock/base digests to profile.baselineTreeDigest,
* /usr/bin/timeout, /usr/bin/sleep and /bin/bash exist,
* pytest imports (the pinned advisory test runner; ``python -m pytest`` must work offline).

It also strips ``referenceCommitMaintainerOnly`` from the in-image profile.json: the maintainer
reference commit must never reach a sandbox (CLAUDE.md §4 "never supplied to the agent").
"""

from __future__ import annotations

import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tree_digest import tree_digest  # noqa: E402

PROFILE_DIR = "/opt/airlock/profile"
BASE_DIR = "/opt/airlock/base"
PLAIN_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        sys.stderr.write("usage: image_check.py <profileId> <adapterModule>\n")
        return 2
    profile_id, module = argv
    problems: list[str] = []
    if not PLAIN_ID.match(profile_id):
        problems.append(f"PROFILE {profile_id!r} is not a plain identifier")

    profile_path = os.path.join(PROFILE_DIR, "profile.json")
    try:
        with open(profile_path, "rb") as fh:
            profile = json.load(fh)
    except (OSError, ValueError) as exc:
        sys.stderr.write(f"image_check: cannot read {profile_path}: {exc}\n")
        return 1
    if not isinstance(profile, dict):
        sys.stderr.write("image_check: profile.json is not an object\n")
        return 1

    expectations = {
        "id": profile_id,
        "adapterModule": module,
        "language": "python",
        "sourceRoot": "/workspace/src",
        "runtimeImage": f"airlock-runtime-python:{profile_id}",
    }
    for key, expected in expectations.items():
        if profile.get(key) != expected:
            problems.append(f"profile.json {key}={profile.get(key)!r}, expected {expected!r}")

    if os.path.lexists(os.path.join(PROFILE_DIR, "contract.json")):
        problems.append("contract.json is present in the image; the sandbox must never see it")
    if not os.path.isfile(os.path.join(PROFILE_DIR, f"{module}.py")):
        problems.append(f"adapter module {module}.py missing from {PROFILE_DIR}")
    for tool in ("/usr/bin/timeout", "/usr/bin/sleep", "/bin/bash"):
        if not os.access(tool, os.X_OK):
            problems.append(f"required executable missing: {tool}")
    try:
        import pytest  # noqa: F401  (pinned in the Dockerfile; the only package beyond the interpreter)
    except ImportError as exc:
        problems.append(f"pytest is not importable: {exc}")

    expected_digest = profile.get("baselineTreeDigest")
    try:
        actual_digest = tree_digest(BASE_DIR)
    except Exception as exc:  # noqa: BLE001 - any failure to digest is a build failure
        problems.append(f"cannot digest {BASE_DIR}: {exc}")
        actual_digest = None
    if actual_digest is not None and actual_digest != expected_digest:
        problems.append(f"baseline tree digest mismatch: image has {actual_digest}, profile says {expected_digest}")

    if problems:
        sys.stderr.write("image_check: FAILED\n  " + "\n  ".join(problems) + "\n")
        return 1

    if "referenceCommitMaintainerOnly" in profile:
        del profile["referenceCommitMaintainerOnly"]
        with open(profile_path, "w", encoding="utf-8") as fh:
            json.dump(profile, fh, indent=2, sort_keys=True)
            fh.write("\n")
    with open("/opt/airlock/base.digest", "w", encoding="utf-8") as fh:
        fh.write(actual_digest + "\n")
    sys.stdout.write(f"image_check: ok profile={profile_id} adapter={module} baseTreeDigest={actual_digest}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
