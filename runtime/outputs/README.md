# runtime/outputs — the bounded output collector

`collect_outputs.py` extends the read-only collector idea of `runtime/python/collector.py` (exact
replacement allowlist) to **approved output types** for the analysis and Node profiles (doc 40
Stage 4, research/42 C29). Baked into `airlock-runtime-analysis` at `/opt/airlock/collect_outputs.py`;
the Node image has no Python and is collected by the analysis image.

## Invocation (fixed)

1. Provision a fresh collector container (analysis image, same hardened flags, cwd `/`) with the
   attempt volume at `/candidate:ro` **while the author still runs** — a tmpfs-backed volume only
   exists while some container holds the mount (same order as `lifecycle.ts` freeze).
2. Stop the author and confirm it stopped; settle outstanding execs.
3. Probe the collector (`allBlocked`).
4. `docker exec -u 1000:1000 -w / <collector> env -i PATH=/usr/bin:/bin python3 -I -S /opt/airlock/collect_outputs.py --root /candidate [--max-file-bytes N] [--max-total-bytes N] [--max-files N]`

Caps default to, and can only be **lowered** below: 5 MiB per file, 20 MiB total, 50 files.
Exit 0 with an envelope (rejections included; a missing `outputs/` is an empty envelope); exit 1 when
the root/arguments are unusable. Stdout can be ~28 MiB at the caps; size the exec output bound
accordingly.

## Envelope

The `FileEnvelope` of `collector.py` plus `mediaType`, `path` relative to `outputs/`, files sorted by
code point:

```json
{"schemaVersion":1,
 "files":[{"path":"chart.png","byteLength":21337,"sha256":"…","contentBase64":"…","mediaType":"image/png"}],
 "rejected":[{"path":"chart.svg","reason":"svg is active content (script/external references); not an allowed output type"}]}
```

## Rules

| Rule | Rejection reason |
|---|---|
| only `<root>/outputs` walked; `outputs` itself a symlink / not a dir | `symlink component 'outputs'` / `outputs is not a directory` |
| symlink at any component or leaf (never followed; `openat` + `O_NOFOLLOW`, inode re-check) | `symlink` |
| hard link (`st_nlink > 1`, re-checked on the open fd) | `hardlink (nlink=N)` |
| fifo, socket, device | `not a regular file` |
| name: invalid UTF-8, control/format/unassigned char (incl. bidi overrides), not NFC, backslash, `.`/`..`, > 255 bytes, hidden (`.x`) | specific reason |
| depth > 8 directories; > 2000 entries walked (walk stops) | `deeper than 8 directories` / `…walk stopped` |
| case-insensitive (casefold+NFC) duplicate path | `duplicate (case-insensitive) path` |
| extension not in `.csv .json .txt .md .png .py .js .mjs` (lower-case) | `extension '.x' not allowed` |
| `.svg`/`.svgz`/`.html`/`.htm` (any case) | `svg is active content…` / `html is active content…` |
| per-file cap (from `lstat` and while streaming 64 KiB chunks), total cap, file count | `oversize…` / `exceeds maxTotalBytes` / `more than maxFiles` |
| PNG: 8-byte signature, first chunk IHDR length 13 with valid CRC, 1..8192 width and height | `not a PNG (bad signature)` / `PNG IHDR CRC mismatch` / `PNG dimensions WxH outside 1..8192` |
| text types: strict incremental UTF-8, no NUL; `.json` must also parse | `not valid UTF-8` / `NUL byte in text file` / `not valid JSON` |

The rejected list is capped at 200 entries. Everything in the envelope remains untrusted: the
controller re-validates before sealing artifacts and must serve outputs with their `mediaType`,
`Content-Disposition: attachment` for non-images and `X-Content-Type-Options: nosniff`.

## Tests

```
uv run --with pytest pytest runtime/outputs/tests        # macOS host: 29 passed, 2 skipped (APFS)
```
31 tests; on Linux (`python:3.12-slim`, uid≠0) all 31 pass, including the non-UTF-8 file name and the
case-sensitive duplicate cases that APFS cannot represent. They run the collector exactly as the
supervisor does (`python3 -I -S`, cwd `/`) and cover every rejection above, envelope shape/sha256/
base64, code-point ordering, cap lowering only, growth during read, and that `json.py`/`codecs.py`
planted in the workspace never shadow the stdlib.

`demo-lib.sh` holds the shared docker helpers for `runtime/analysis/demo.sh` and
`runtime/node/demo.sh`.
