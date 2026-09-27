# runtime/node — the offline Node sandbox runtime

A separate pinned offline code profile for JavaScript (doc 40 §2 "JavaScript/Node execution",
Stage 4; research/42 C30). Same execution contract as `runtime/analysis` (inputs/, code/, outputs/,
fixed runner, only outputs/ collected).

```
runtime/node/build.sh              # parity test, then -> airlock-runtime-node:dev; prints {imageId, ...}
runtime/node/demo.sh               # real Docker, runc = DEV-UNSAFE; 26 PASS lines expected
node --test runtime/node/tests/probe-parity.test.mjs
```

## Image: `airlock-runtime-node:<tag>`

| Property | Value |
|---|---|
| Base | `node:24-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6` (index digest; Node v24.21.0 = current Active LTS, Debian 12 slim; per-arch digests in the Dockerfile header) |
| Packages | `package.json` + committed `package-lock.json` (lockfile v3, sha512 `integrity` per tarball), installed in a **separate build stage** with `npm ci --ignore-scripts --omit=dev`: `csv-parse 7.0.3`, `csv-stringify 6.9.0`, `simple-statistics 7.12.0` — all zero-dependency, none fetch. Baked at `/opt/airlock/node/node_modules` (root, read-only); `/node_modules` symlinks to it so ESM `import` from `/workspace/code/*.mjs` resolves |
| Package managers | **removed**: `npm`, `npx`, `corepack`, `yarn`, `yarnpkg`, `/usr/local/lib/node_modules` (no `npm-cli.js` left to run with `node`). `npm i x` → `npm: not found` (127) |
| Python | **none** (deliberately). The probe is a Node port; output collection runs in the analysis image |
| User | the base image's `node` user, uid:gid 1000:1000, `HOME=/tmp`, `WORKDIR /workspace` |
| `/opt/airlock/` | `probe.sh` (bash shim, `env -i` → `node probe.mjs`), `probe.mjs`, `run.sh`, `image_check.mjs`, `node/` (deps) |
| Hardening | setuid/setgid stripped; no python/gcc/cc/ld/make/curl/wget; `image_check.mjs` fails the build on any regression or lock mismatch |
| Readiness | `node -e "console.log('ready')"` |

## Probe

`runtime/python/probe.sh` needs python3, which this image does not have. `probe.mjs` is a
line-for-line port: same targets (metadata `169.254.169.254`, DNS `example.com`, TCP `1.1.1.1:443`,
docker sockets), same 2 s timeouts, same mount rules (`--workspace-bytes`, `--shm-bytes`,
subtree binds, `/dev` children, file binds, writable cgroups, stacked mounts), and the **identical
JSON document** (`apps/supervisor/src/probe.ts` parses it unchanged). The supervisor invocation is
unchanged too: `/bin/bash --noprofile --norc /opt/airlock/probe.sh --workspace-bytes N`.
`tests/probe-parity.test.mjs` runs both probes over 24 mountinfo variants x 2 cap settings and
requires equal verdicts, equal `details` text and equal exit codes; `build.sh` runs it first, so a
change to `runtime/python/probe.sh` that is not ported **fails the Node build**.

## Runner

```
docker exec -u 1000:1000 -w /workspace <c> timeout <s> /opt/airlock/run.sh code/analyze.mjs
```

`run.sh` validates the path (`code/<path>.mjs|.js|.cjs`), clears the environment (`env -i`, so
`NODE_OPTIONS`/`NODE_PATH` injection is ignored — tested) and runs Node with the permission model:
read `/workspace`, the baked deps and `/tmp`; write only `/workspace/outputs` and `/tmp`; no child
processes, workers, native addons or WASI. Demo evidence: symlink creation, `/etc/passwd` read,
`inputs/` write and spawn all return `ERR_ACCESS_DENIED`. The permission model is defence in depth,
**not** the boundary; the container (`--network none`, read-only rootfs, cap-drop ALL,
no-new-privileges, uid 1000, pids/memory limits) is.

## Collection

The Node image has no Python, so the supervisor collects a Node workspace with the **analysis
image**: fresh collector container from `airlock-runtime-analysis`, Node attempt volume at
`/candidate:ro`, then `collect_outputs.py` exactly as for analysis (see `runtime/outputs/README.md`).
Adding CPython to the Node image only to run the collector would double its attack surface.

## Demo evidence (2026-09-27, Colima runc arm64, DEV-UNSAFE)

`runtime/node/demo.sh` → `26 passed, 0 failed`: readiness; Node probe allBlocked; the Node analysis
(`csv-parse` + `simple-statistics`) finds `Synthetic-West`; npm/npx/corepack/yarn unusable, no
`npm-cli.js`; `fetch` blocked; no python/compilers/setuid; collection in the analysis image accepts
`report.md`, `summary.json`, `totals.csv`; hostile outputs (svg, html, invalid json, symlinks and a
hardlink planted outside the permission model) are refused except `ok.txt`.

## Integration still needed

A `node` profile/role in the supervisor with this image (id-pinned), `run.sh` as the only exec
entry point, and a collector step that uses the analysis image for Node attempts.
