# 22 · Feasibility Lab: do the curated demo inputs actually reproduce?

**Date:** 2026-09-26 (before the event). **Status:** measured, not estimated. This is research only and contains no product code. The throwaway driver, the hand-written repro tests and the raw JSON results are in `research/raw/lab/` (gitignored). The experiment log is `experiments-lab.jsonl` (EXP-L-01…21).

**Host caveats (read first).** Everything ran natively on macOS arm64 with CPython 3.12.12 from uv. The "no network" runs used `sandbox-exec` with `(deny network*)`, which I verified blocks DNS and connects (`curl pypi.org` fails with exit 6). It is **not** Docker or gVisor: the daemon was off, so container overhead is **NOT RUN** (EXP-L-20). Online timings come from a residential connection, not Vultr `atl` (EXP-L-21). The repro tests are mine, written the way the agent would write them from the issue text. I did not run any issue code verbatim.

## 1. Protocol (per issue × ref ∈ {before = fix^1, after = fix, head})

1. **Source.** `git archive <sha> | tar -x`. This is the tarball equivalent, and like a tarball it has no `.git`. Set `SETUPTOOLS_SCM_PRETEND_VERSION=0.0.0+lab`.
2. **Online install** (sandbox A/P analog). Fresh `uv venv --python 3.12`, then `uv pip install --no-cache <src> pytest`.
3. **Prep P.** `uv pip freeze`, then `pip download --no-deps --only-binary=:all:` for the dependencies, then `pip wheel --no-deps <src>`. This produces a lock of `name==ver --hash=sha256:…` for every wheel (5–6 wheels, about 1.8 MB per ref).
4. **Verify B/C/D analog**, all under `sandbox-exec` with network denied:
   - Create a new venv and run `uv pip install --offline --no-index --no-deps --require-hashes --find-links wheelhouse -r lock.txt` with a **cold uv cache**.
   - Repeat the install with **stock pip** in a `python -m venv`.
   - Run `pytest --junitxml` **twice** from a clean cwd.

Every hashed offline install succeeded, with both uv and pip, for all 30 (issue, ref) pairs.

## 2. Results

Outcome is the test result at each ref. "FAIL" means the claimed behaviour was observed. Every ref ran twice, and **all 30 pairs were deterministic** (same rc and signature both times). Times are wall-clock seconds.

| ID | Issue | before → after → head (40-hex in `results/*.json`) | before | after | head | Failure signature at before | Pipeline total (3 refs) | Predicted verdict |
|---|---|---|---|---|---|---|---|---|
| E01 | humanize#333 | `08cf2c30` → `b48b37b1` → `392aef70` | ✅FAIL | ✅PASS | ✅PASS | `OverflowError: cannot convert float infinity to integer` (frame `humanize/time.py:151`) | 19.8 | ALREADY_FIXED (high) |
| E02 | more-itertools#1284 | `b2f3aff7` → `3ea9b009` → `fbb9a98d` | ✅FAIL | ✅PASS | ✅PASS | `AssertionError: assert ['a', 'b', 'c'] == ['a', 'b']` | 17.8 | ALREADY_FIXED (high) |
| E03 | more-itertools#1250 | `a826a4e0` → `d92f081a` → `fbb9a98d` | ✅FAIL | ✅PASS | ✅PASS | `Failed: DID NOT RAISE TypeError` (no package frame, so assertion kind) | 14.1 | ALREADY_FIXED (high) |
| E04 | tabulate#365 | `e13a4d0d` → `87a9a4e0` → `268615a5` | ✅FAIL | ✅PASS | ✅PASS | `IndexError: list index out of range` (frame `tabulate/__init__.py:2291`) | 19.3 | ALREADY_FIXED (high) |
| E05 | cachetools#395 | `1ddec068` → `c624ceb3` → `3c082c65` | FAIL | **❌FAIL** | **❌FAIL** | `AssertionError: assert 'a' not in FIFOCache({'a': 99, 'c': 3}…)` | 16.5 | **INCONCLUSIVE** (C fails too) |
| E06 | parse#249 | `8059e320` → `529dc2e0` → `529dc2e0` (HEAD == fix) | ✅FAIL | ✅PASS | ✅PASS | `assert None is not None` | 15.9 | ALREADY_FIXED (high) |
| E07 | packaging#1315 | `c4fb81ff` → `0a85b41e` → `7b898d9f` | ✅FAIL | ✅PASS | ✅PASS | `assert True == False` (reparsed marker flips) | 13.0 | ALREADY_FIXED (high) |
| E08 | packaging#1154 | `905c90c1` → `06c6555f` → `7b898d9f` | FAIL | **❌FAIL** | **❌FAIL** | `ValueError: Exceeds the limit (4300 digits)…` (frame `packaging/version.py:427`) | 12.9 | **INCONCLUSIVE** (C fails too) |
| E09 | semver#460 | `d959aa7d` → `d8813b67` → `887d057e` | ✅FAIL | ✅PASS | ✅PASS | `AssertionError: 1.0.0-rc10` | 15.6 | ALREADY_FIXED (high) |
| E10 | marshmallow#2891 | `78a94ea0` → `39e7c833` → `7f0792bd` | ✅FAIL | ✅PASS | ✅PASS | `marshmallow.exceptions.ValidationError: {'url': ['Not a valid URL.']}` (frame `marshmallow/schema.py:730`) | 13.0 | ALREADY_FIXED (high) |

**8 of 10 behave as 15 §6 expects. Two rows in 15 §6 are wrong and must be changed.**

- **E05 cachetools#395.** The "fix" `c624ceb` edits only `docs/index.rst`. The maintainer documented the reorder-on-update behaviour as intended. The claim reproduces at every ref. C fails with the same signature, so the verdict is INCONCLUSIVE ("not fix-specific"). Change the expected verdict to **INCONCLUSIVE**. This is a strong "REPRODUCED ≠ bug" demo beat.
- **E08 packaging#1154.** The 03c summary ("raw ValueError instead of InvalidVersion") matches the issue, but the fix went **the other way**. #1155, "Propagate int-max-str-digits ValueError", makes ValueError the contract. The claim reproduces at the reported version `packaging==26.0` from PyPI: ValueError for both version paths and for `SpecifierSet` (EXP-L-13). At fix^, `Version("1"*5000)` gave `InvalidVersion`. At fix and HEAD it gives ValueError everywhere. Change the expected verdict to **INCONCLUSIVE** (claim observed, maintainers chose the opposite behaviour). Pin `reported_sha` to the `26.0` tag, not fix^.
- **E06 parse.** HEAD equals the fix SHA, so D is byte-identical to C. Cache it; don't rebuild it.

## 3. Recommendations for the demo

**Hero issues.** All three are exception kind with a real package frame, so fault locality is satisfiable, and each takes under 20 s end-to-end.

1. **E01 humanize#333.** `naturaldelta(float("nan"))` → `'nan'`, but `naturaldelta(float("inf"))` → `OverflowError`. It is two lines, the asymmetry needs no explanation, and it fails in `humanize/time.py:151`.
2. **E10 marshmallow#2891.** `FILE:///…` is rejected with "Not a valid URL." while `file:///…` is accepted. Instantly legible.
3. **E04 tabulate#365.** An empty table plus `maxheadercolwidths` raises `IndexError` in `tabulate/__init__.py`. It is one call.

Backup: **E07 packaging#1315.** `str(Marker)` drops the parentheses and `evaluate` flips from False to True. It is very visual but assertion kind, so it needs C or D as the control.

**ALREADY_FIXED showcases.** Every hero is technically ALREADY_FIXED because all 10 are closed with fixes on main. Two work well because the failure message *is* the story:
- **E02 more-itertools#1284**: `['a','b','c'] == ['a','b']`, the phantom key shows in the diff.
- **E09 semver#460**: `1.0.0-rc9` bumps to `1.0.0-rc10`, which sorts lower.

A live **REPRODUCED (high)** verdict therefore still needs the planted `ror-demo-target` (E17). None of the curated public rows can produce it.

**NOT_REPRODUCED candidates.**
- **E11 (synthetic)**: report E01 at `b48b37b` as the reported ref. The frozen test passed at that ref deterministically, twice.
- **E12**: the same construction for E02 at `3ea9b00`. Also verified to pass twice.

No natural NOT_REPRODUCED case exists among the 10. **E05 and E08 are the honest INCONCLUSIVE ("claim observed, fix/maintainer disagrees") cases.**

## 4. Pitfalls found, and the fix for the build plan

| # | Pitfall (evidence) | Fix |
|---|---|---|
| P1 | Building from a tarball without `.git`: humanize (hatch-vcs) and tabulate (flit_scm) fail with `LookupError: setuptools-scm was unable to detect version`. cachetools builds fine (EXP-L-14). | Always export `SETUPTOOLS_SCM_PRETEND_VERSION` in P. It is harmless for flit, setuptools and hatch. |
| P2 | Wheels are not reproducible without `SOURCE_DATE_EPOCH`: tabulate and semver produced different sha256 on two builds of the same ref. With it set, 8/8 were identical (EXP-L-15). | Set `SOURCE_DATE_EPOCH` to the commit time in P. Replay mode can then rebuild and compare hashes. |
| P3 | **A lock built on 3.12 but installed `--no-deps` into 3.10 "succeeds", then pytest dies with `ModuleNotFoundError: exceptiongroup`.** Every ref, including the fixed ones, returned rc=1: a **false FAIL** (EXP-L-18). 3.14 matched 3.12 exactly. | Lock and verify on the **same interpreter** (pin `python: "3.12"` per row and assert `sys.version_info` in `ror-gate`). Treat "junit ≥1 test collected and exactly the signature" as mandatory (already in 12 §5). rc alone is not a verdict. |
| P4 | The target package is also a pytest dependency: `packaging` (E07/E08) is the SUT **and** a pytest dependency. The lock must contain only the SUT wheel, not the PyPI `packaging`. | In P, drop the dependency that has the target's dist name from `deps.txt` before `pip download` (done in `run_lab.py`). Check this in lock validation. |
| P5 | Running pytest inside the checkout would import the flat-layout source (`parse.py`, `tabulate/`, `more_itertools/`) and the repo's `conftest.py`/`addopts`. | Run from a clean cwd holding only the frozen test, with `-p no:cacheprovider`. |
| P6 | junit-text signatures differ by kind: `assert None is not None` has no `AssertionError` prefix, and `Failed: DID NOT RAISE` comes from `pytest.raises`. | Take `exception_type` from the ror traceback dump, not by regexing junit. Map `Failed: DID NOT RAISE` and bare asserts to `kind:"assertion"`. |
| P7 | Stock pip is 15× slower than uv for the offline install (pip ~2.1 s = 1.0 s venv + 1.1 s install; uv 0.13 s with a cold cache). | Either works. Use uv in the image if you want B/C/D to feel instant. pip is acceptable. |
| P8 | Some default branches are not `main` (more-itertools, tabulate, cachetools, parse, semver: `master`; marshmallow: `dev`). | Resolve HEAD through the repo's `default_branch` from the API. Never hardcode `main`. |

There were **no** C extensions, no flakiness (30/30 pairs deterministic), and no Python-version constraints beyond `requires-python >= 3.10`.

## 5. Timing budget (measured on macOS; add container overhead on Vultr)

| Stage | Measured | Notes |
|---|---|---|
| Clone / tarball fetch | 1.5–6.4 s clone; `git archive` 0.03 s | Pre-fetch the curated repos |
| Online install per ref (A) | 0.7–4.4 s | `--no-cache`, residential network |
| Prep P per ref (cold, `--no-cache-dir`) | 1.8–2.3 s | 6 wheels, 1.8 MB |
| **B/C/D per ref, pre-built wheelhouse** (venv + hashed offline install + 2 pytest runs) | **0.55 s (uv) / ~2.7 s (pip)** | Container create/exec is not included (NOT RUN) |
| Single pytest run | 0.22–0.32 s | |
| Full non-LLM pipeline, 3 refs, all online, prep uncached | 12.9–19.8 s per issue | Sum of the columns above |

**Answers to the two questions:**
- **Does a pre-built wheelhouse get B/C/D under 10 s each?** Yes, by a wide margin: 0.6–2.7 s before container overhead. Even with a pessimistic 3 s for gVisor create, B + B′ + C + D stays under about 25 s total.
- **Does a live run fit in 60–90 s?** Yes. Non-LLM work with cached bundles is about 5–25 s, which leaves **35–85 s for authoring in A** (install ~2 s plus about 3–5 LLM calls). Uncached prep adds about 6 s per issue (3 refs × ~2 s), which still fits. Pre-build the hero bundles as 12 §5.3 item 5 says, and pin the head SHAs listed in §2.
