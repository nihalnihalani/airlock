#!/usr/bin/env python3
"""Derive seccomp/chromium.json from Docker's builtin default profile.

Source: moby/profiles seccomp v0.1.0 default.json (the profile vendored by Docker Engine 28.4.0,
https://github.com/moby/moby/blob/v28.4.0/vendor/modules.txt), Apache-2.0.
Pinned bytes: sha256 recorded below; the script refuses a different input.

The ONLY change: one extra rule allowing the syscalls Chromium's namespace sandbox needs to build
its user/PID/network-namespace sandbox without any container capability (the container runs with
--cap-drop ALL and no-new-privileges, so the setuid sandbox is unavailable by design):
  clone, unshare  unconditionally (namespace flags), and chroot (called inside the new user
  namespace, where Chromium holds CAP_SYS_CHROOT; Docker only emits chroot when the container keeps
  CAP_SYS_CHROOT on the host side). Everything else remains Docker's default.
Usage: python3 derive.py default.json > chromium.json
"""
import hashlib, json, sys

EXPECTED_SHA256 = "01536f1d1df938ae611eba20d6349e0de7a99b6ecdee1549427a0b01b8301e28"
SOURCE_URL = "https://raw.githubusercontent.com/moby/moby/v28.4.0/vendor/github.com/moby/profiles/seccomp/default.json"

raw = open(sys.argv[1], "rb").read()
digest = hashlib.sha256(raw).hexdigest()
if digest != EXPECTED_SHA256:
    sys.exit(f"unexpected default profile digest {digest}; fetch {SOURCE_URL}")
profile = json.loads(raw)
profile["syscalls"].append({
    "names": ["clone", "unshare", "chroot"],
    "action": "SCMP_ACT_ALLOW",
    "comment": "Airlock: Chromium namespace sandbox (user/pid/net namespaces + chroot inside the new userns)",
})
json.dump(profile, sys.stdout, indent=1, sort_keys=False)
sys.stdout.write("\n")
