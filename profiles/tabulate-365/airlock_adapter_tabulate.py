"""Airlock profile adapter for ``tabulate-365``.

Loaded by /opt/airlock/adapter.py from /opt/airlock/profile/ inside the sandbox, with the candidate
source root first on ``sys.path`` so ``import tabulate`` resolves to the candidate under test.

``run_case(input)`` receives one contract case input (the keyword arguments to
``tabulate.tabulate``) and returns the rendered table string. Raising propagates to the adapter,
which records it as an error observation (this is how the reported ``IndexError`` is observed).

Only a small allowlist of keyword arguments is accepted so a case can never reach parameters that
take callables, file objects or formats outside the contract's scope.
"""

from __future__ import annotations

from typing import Any

ALLOWED_KEYS = frozenset({"tabular_data", "headers", "maxheadercolwidths", "maxcolwidths", "tablefmt"})
MAX_ROWS = 10_000
MAX_COLS = 256


def _check_width_option(name: str, value: Any) -> None:
    if value is None or isinstance(value, bool):
        if isinstance(value, bool):
            raise ValueError(f"{name} must be an int, a list of ints/nulls, or null")
        return
    if isinstance(value, int):
        return
    if isinstance(value, list):
        if len(value) > MAX_COLS:
            raise ValueError(f"{name} has more than {MAX_COLS} entries")
        for item in value:
            if item is not None and (isinstance(item, bool) or not isinstance(item, int)):
                raise ValueError(f"{name} entries must be ints or null")
        return
    raise ValueError(f"{name} must be an int, a list of ints/nulls, or null")


def run_case(input: dict[str, Any]) -> str:  # noqa: A002 - name fixed by the adapter protocol
    if not isinstance(input, dict):
        raise ValueError("case input must be an object")
    extra = sorted(set(input) - ALLOWED_KEYS)
    if extra:
        raise ValueError(f"unsupported keys for tabulate case: {extra}")
    if "tabular_data" not in input:
        raise ValueError("tabular_data is required")

    data = input["tabular_data"]
    if not isinstance(data, list):
        raise ValueError("tabular_data must be a list of rows")
    if len(data) > MAX_ROWS:
        raise ValueError(f"tabular_data has more than {MAX_ROWS} rows")
    for row in data:
        if isinstance(row, (list, dict)) and len(row) > MAX_COLS:
            raise ValueError(f"a row has more than {MAX_COLS} columns")

    if "headers" in input:
        headers = input["headers"]
        if not (isinstance(headers, str) or isinstance(headers, list) or isinstance(headers, dict)):
            raise ValueError("headers must be a string, a list or an object")
        if isinstance(headers, list) and len(headers) > MAX_COLS:
            raise ValueError(f"headers has more than {MAX_COLS} entries")
    if "tablefmt" in input and not isinstance(input["tablefmt"], str):
        raise ValueError("tablefmt must be a string")
    if "maxheadercolwidths" in input:
        _check_width_option("maxheadercolwidths", input["maxheadercolwidths"])
    if "maxcolwidths" in input:
        _check_width_option("maxcolwidths", input["maxcolwidths"])

    import tabulate  # candidate code: resolved from the source root, imported only now

    result = tabulate.tabulate(**input)
    if not isinstance(result, str):
        raise TypeError(f"tabulate returned {type(result).__name__}, expected str")
    return result
