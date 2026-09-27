# Profile `tabulate-365`

Historical replay of [python-tabulate #365](https://github.com/astanin/python-tabulate/issues/365): an empty table with `headers` and `maxheadercolwidths` raises `IndexError: list index out of range` at `tabulate/__init__.py` (`num_cols = len(list_of_lists[0])`).

- **Baseline (untrusted candidate base):** `e13a4d0dd292cade200e653eb9155a1ca0f1dbea`. The pinned tree lives in `base/` (produced by `runtime/python/prepare-profile.sh tabulate-365`, tracked files only) and is materialized into the runtime image.
- **`baselineTreeDigest`** (`d20b5bf8…` in `profile.json`) is the sha256 of the concatenated `"<path> <sha256>\n"` lines of every file in `base/`, ordered by `(path.casefold(), path)` — case-insensitive first, exact path as the tie-break — with `.git` skipped. A symlink to a regular file is listed under its own path with the bytes of its target: this tree has `README -> README.md`, so the `README` line carries the sha256 of `README.md`'s bytes. `runtime/python/tree_digest.py` is the reference implementation and `apps/control/src/profiles.ts` re-verifies `base/` with the same rule at start-up; a `base/` that does not match is refused. Ordering by raw code points yields `99d281f9…` for the same tree, so the rule above is normative.
- **Reference (maintainer only):** `87a9a4e07a5efb39b81fdb6ac513b1d345bb21fb`. Used only to author `contract.json`; never supplied to any sandbox.
- **Contract:** `contract.json`, six cases. Expected values were **measured**, not written by hand: each case was executed at both commits in a clean venv (see `research/22-feasibility-lab.md` for the earlier lab). The reported case raises at baseline and returns the header-only table at reference; the five regression cases return identical output at both.
- **Agent may change:** `tabulate/__init__.py` only. The collector rejects anything else.
- Case ids use hyphens (plain identifiers). Inputs are the keyword arguments to `tabulate.tabulate`.
