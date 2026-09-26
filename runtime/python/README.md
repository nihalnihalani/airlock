# runtime/python — the pinned Python sandbox runtime

Everything that runs *inside* an Airlock sandbox for a Python profile lives here: the image, the
fixed adapter/materializer/collector/probe scripts and the tooling that pins a profile's baseline
tree. Nothing in this directory is a judge. Every byte these scripts print is untrusted data that the
supervisor bounds and the controller's comparator interprets (CLAUDE.md §3).

## Image: `airlock-runtime-python:<profileId>`

```
runtime/python/build.sh tabulate-365        # prepare-profile.sh + docker build; prints JSON with the image id
```

| Property | Value |
|---|---|
| Base | `python:3.12-slim` (tag in `FROM`; observed digest `sha256:f77ac9e44ae96ef2c90b8053ea08c31f8be030f824196b0ae4db6d462c84e51f`, Python 3.12.14, Debian 13.7, recorded in the Dockerfile header) |
| User | `airlock` uid:gid 1000:1000, `HOME=/workspace`, `WORKDIR /workspace` |
| Process | `ENTRYPOINT ["/usr/bin/sleep"] CMD ["infinity"]`; the supervisor `docker exec`s into it |
| `/opt/airlock/base/` | pristine tracked tree of `profile.baselineCommit`, root-owned, 0555 dirs / 0444 files, digest re-verified at build time |
| `/opt/airlock/profile/` | `profile.json` (with `referenceCommitMaintainerOnly` stripped) and `<adapterModule>.py` only. `contract.json` is never copied; the build fails if it is present |
| `/opt/airlock/*.py`, `probe.sh` | fixed scripts, 0555 |
| Dependencies | none installed. The profile schema declares no runtime dependencies (tabulate has none); pytest and anything mentioned in an issue are never installed. `PIP_NO_INDEX=1` on top of `--network none` |
| Env | `PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 HOME=/workspace` |
| Tools present | `/usr/bin/timeout`, `/usr/bin/sleep`, `/bin/bash` (checked at build) |

The rootfs is meant to run read-only; `/workspace` is supplied per attempt by the supervisor as a
named volume (author role) or tmpfs (one-shot roles). Setuid/setgid bits are stripped from the image.

Build context is the repository root; `Dockerfile` takes `--build-arg PROFILE=<id>` and
`--build-arg ADAPTER_MODULE=<module>` (build.sh derives the module from `profile.json`).
`image_check.py` runs once during the build and fails it on any mismatch between the build args, the
in-image `profile.json`, the base tree digest and the required tools.

## Scripts

### `prepare-profile.sh <profileId>`
Reads `profiles/<id>/profile.json`; uses `research/reference-repos/<name>` when its `origin` matches
`profile.repository` (clones it otherwise); `git archive <baselineCommit>` into `profiles/<id>/base/`
(tracked files only, no `.git`); computes the tree digest and **refuses with a listing/diff** when it
differs from `profile.baselineTreeDigest`. Idempotent: a base/ that already matches is untouched.

### `tree_digest.py [--lines] DIR`
The canonical baseline tree digest: `sha256` of the concatenated `"<path> <sha256>\n"` lines of every
file, ordered by `(path.casefold(), path)`, with a symlink hashed under its own path as the bytes of
the regular file it resolves to (a checked-out tree), `.git` skipped. This is the rule the pinned
`tabulate-365` digest `d20b5bf8…` was measured with. **Note for the control plane:** ordering by raw
code points instead yields `99d281f9…` for the same tree; `apps/control` must use this same rule
(case-insensitive ordering, symlinks resolved) when it re-verifies `profiles/<id>/base`.

### `adapter.py [--request FILE]`
`python /opt/airlock/adapter.py --request /workspace/request.json` (or stdin). Reads an
`AdapterRequest`, puts `/workspace/src` first on `sys.path`, loads `<adapterModule>.py` from
`/opt/airlock/profile/` by explicit file path (the candidate cannot shadow it) and calls
`run_case(input)` per case. Prints exactly one `Observation` JSON object per line, in request order;
candidate `print()` output is redirected to stderr. Per-case `try/except BaseException`; `SystemExit`
inside a case is an error observation, not the end of the run. Strings are bounded to the contract
limits in UTF-16 units; a return value whose canonical JSON exceeds 65536 becomes an
`AdapterOutputTooLarge` error observation rather than a truncated value. Canonical JSON is
byte-compatible with `contracts.canonicalJson` (sorted keys, `JSON.stringify` number formatting:
`1.0 → 1`, `NaN → null`, `1e-07 → 1e-7`). Exit 1 (and no observations) when the request itself is
unusable: malformed JSON, wrong `schemaVersion`, invalid/duplicate ids, more than 1000 cases, more
than 8 MiB. Optional `--case-timeout-seconds N` (SIGALRM guard, disabled by default; the supervisor
owns the real deadline).

### `materialize.py [--force]`
Copies `/opt/airlock/base` → `/workspace/src` as fresh writable files (refuses if the target exists
unless `--force`; refuses a symlink target), then overlays regular files from
`/workspace/replacements/` **only** at `profile.allowedReplacementPaths`, refusing symlinks at any
component, non-regular files, oversize files (`caps.maxFileBytes`, checked before and during a
capped streaming copy), too many files and too many bytes. Prints
`{"materialized": n, "replaced": [...], "ignored": [...]}`. Never executes anything from either tree.

### `collector.py --root /candidate/src --profile /opt/airlock/profile/profile.json`
Run as `python -I -S` in a **fresh** container with the stopped author volume mounted read-only and
cwd `/`. Stdlib only, no site, never imports from the candidate. Walks only the allowed paths;
rejects symlink components, symlink/dir/special leaves, hard links, oversize (from `lstat` and again
while streaming in 64 KiB chunks), duplicates, and bounds `maxFiles`/`maxTotalBytes`. Missing files
are reported in `rejected` so the controller can fail the freeze. Prints a `FileEnvelope`.
`--root` is the source root inside the mounted volume: with the workspace volume mounted at
`/candidate`, that is `/candidate/src`.

### `probe.sh`
Isolation probe, checkpoint 4. Python stdlib only (`-I -S`), 2 s timeouts. Reports
`metadataEndpoint` (`http://169.254.169.254/v1.json`), `dns` (`example.com`), `outboundTcp`
(`1.1.1.1:443`), `dockerSocket` (`/var/run/docker.sock`, `/run/docker.sock`) and `hostMounts`
(any mount point outside `/`, `/workspace`, `/candidate`, `/tmp`, `/proc`, `/sys`, `/dev` and the
three Docker-managed files `/etc/hosts`, `/etc/hostname`, `/etc/resolv.conf`) as
`BLOCKED | REACHED | UNKNOWN`, plus `allBlocked` and a `details` object. Exit 0 only when all
blocked. Under `--network none` in the built image every check is BLOCKED (see the integration test);
a host bind mount is detected as REACHED.

## Profile adapter module

`profiles/tabulate-365/airlock_adapter_tabulate.py` exports `run_case(input) -> str`:
`tabulate.tabulate(**input)` after checking the keys are within `tabular_data`, `headers`,
`maxheadercolwidths`, `maxcolwidths`, `tablefmt` (anything else raises `ValueError`) and bounding
row/column counts. Raising propagates to the adapter as an error observation, which is how the
reported `IndexError` is observed at baseline.

## Tests

pytest is not in the image; run locally:

```
uv run --with pytest pytest runtime/python/tests
```

Unit tests cover the adapter protocol and bounds, canonical JSON compatibility, materialize
(traversal, symlinks, allowed-path overlay, caps), collector (symlink components, non-regular,
hard links, oversize, duplicates, sha256/byteLength, isolation from candidate imports), probe
parsing, tree digest ordering and `prepare-profile.sh` refusal.

`test_integration_docker.py` (skipped without Docker) builds or reuses the image and runs, in a
**dev-unsafe runc** container with `--network none --user 1000:1000 --read-only --cap-drop ALL
--security-opt no-new-privileges --pids-limit 64 --memory 512m`: the probe (all BLOCKED),
materialize + adapter with the contract's inputs (the reported case yields `IndexError` at baseline
and all six observations equal the contract's baseline expectations), the `timeout` wrapper, host
mount detection, freeze-style collection from a stopped volume in a fresh container, and the
diagnostic candidate from `apps/control/test/fixtures/diagnostic-candidate-tabulate-365` passing the
candidate expectations (skipped if the fixture is absent).

`runc` on the local machine is a development configuration only. It is never a deployment default
(CLAUDE.md §3.8); the supervisor inspects the effective runtime and refuses `runc` unless
`AIRLOCK_DEV_UNSAFE=1`.
