# Third-party notices — runtime/python (partial, merged into THIRD_PARTY_NOTICES.md by the lead)

No source code in `runtime/python/` or `profiles/tabulate-365/airlock_adapter_tabulate.py` is copied
or adapted from OpenMuse (`205cc386b75aae1a862f3fdd43104b570c8d0911`) or OpenBot
(`3c73cf00efba46122dfd0447485e2b61f1d6a2cd`). The scripts are new Airlock code (Python, stdlib only).
Design ideas taken from the audited upstreams, with no code carried over:

| Airlock file | Upstream path | Modifications |
|---|---|---|
| `runtime/python/collector.py` | OpenBot `agent-computer/src/workspace.ts` (three-layer path confinement idea; bounded read limits) | Re-implemented in Python. Exact allowlist instead of workspace-relative resolution; symlink check at every component via `lstat`; hard-link, special-file and TOCTOU (`fstat` inode match) checks added; reads stream in 64 KiB chunks with a cap instead of reading the whole file before truncating. |
| `runtime/python/materialize.py` | OpenBot `agent-computer/src/workspace.ts` (write confinement idea) | Re-implemented in Python for a fixed base → target copy plus allowlisted overlay; no code reused. |
| `runtime/python/Dockerfile` | OpenMuse `apps/server/src/computer.ts` (idle `sleep infinity` sandbox process, non-root / read-only expectations) | Different image and layout; no code reused. |

## python-tabulate (profile `tabulate-365`)

MIT License, Copyright (c) 2011-2020 Sergey Astanin and contributors. https://github.com/astanin/python-tabulate

`profiles/tabulate-365/base/` is the pristine tracked tree at `e13a4d0dd292cade200e653eb9155a1ca0f1dbea`
produced by `runtime/python/prepare-profile.sh` (`git archive`, no `.git`). It is the untrusted
candidate base for the historical replay and is copied unchanged into the runtime image at
`/opt/airlock/base/`. It is not part of Airlock's codebase; its `LICENSE` file is included in the tree.
