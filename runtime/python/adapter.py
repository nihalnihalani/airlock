#!/usr/bin/env python3
"""Airlock runtime adapter: fixed JSON input, one bounded Observation JSON object per line.

    python /opt/airlock/adapter.py [--request /workspace/request.json]
                                   [--source-root /workspace/src]
                                   [--profile-dir /opt/airlock/profile]
                                   [--case-timeout-seconds N]

Reads an ``AdapterRequest`` (``{"schemaVersion": 1, "cases": [{"id", "input"}]}``) from the file
named by ``--request`` or from stdin, puts the candidate source root FIRST on ``sys.path``, loads the
profile's ``adapterModule`` (``profile.json`` → ``<profile-dir>/<adapterModule>.py``) by explicit
file path so the candidate cannot shadow it, and calls ``run_case(input)`` once per case.

Output protocol (packages/contracts ``Observation``): exactly one JSON object per case on stdout,
one per line, never anything else on stdout. Candidate ``print`` calls are redirected to stderr
while a case runs. Every string is bounded to the contract limits (UTF-16 units, as zod counts):
``valueCanonical`` ≤ 65536, ``exceptionType`` ≤ 256, ``message`` ≤ 4096, ``tracebackTail`` ≤ 8192.
A return value whose canonical JSON would exceed the limit becomes an ``error`` observation rather
than a truncated (and therefore wrong) value.

This process runs INSIDE the untrusted sandbox with the candidate's code. It is a probe, not a judge:
its stdout is untrusted data that the supervisor parses and the comparator interprets. It cannot
declare anything passed.

Exit status: 0 when every case in a well-formed request produced an observation (including error
observations); 1 when the request itself could not be honoured (unreadable, oversize, malformed,
unloadable adapter module) or a case id could not be echoed. A non-zero exit can never pass.
"""

from __future__ import annotations

import argparse
import contextlib
import importlib.util
import io
import json
import math
import os
import re
import signal
import sys
import traceback
from typing import Any

SCHEMA_VERSION = 1
PLAIN_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")

MAX_REQUEST_BYTES = 8 * 1024 * 1024
MAX_CASES = 1000
LIMIT_VALUE = 65536
LIMIT_EXCEPTION_TYPE = 256
LIMIT_MESSAGE = 4096
LIMIT_TRACEBACK = 8192
MAX_DEPTH = 64

DEFAULT_SOURCE_ROOT = "/workspace/src"
DEFAULT_PROFILE_DIR = "/opt/airlock/profile"


class AdapterProtocolError(Exception):
    """The request cannot be honoured; reported on stderr with exit status 1."""


class CaseTimeout(BaseException):
    """Raised inside a case by the optional SIGALRM guard."""


# ---------------------------------------------------------------------------------------------
# Bounded strings (UTF-16 code units, which is what zod's .max() counts)
# ---------------------------------------------------------------------------------------------


def utf16_len(text: str) -> int:
    return len(text.encode("utf-16-le", "surrogatepass")) // 2


def bound(text: Any, limit: int) -> str:
    if not isinstance(text, str):
        text = str(text)
    if utf16_len(text) <= limit:
        return text
    # Cut by code points, then shrink until it fits in UTF-16 units.
    cut = text[:limit]
    while utf16_len(cut) > limit:
        cut = cut[:-1]
    return cut


def bound_tail(text: str, limit: int) -> str:
    if utf16_len(text) <= limit:
        return text
    cut = text[-limit:]
    while utf16_len(cut) > limit:
        cut = cut[1:]
    return cut


# ---------------------------------------------------------------------------------------------
# Canonical JSON, byte-compatible with contracts.canonicalJson (JSON.stringify, sorted keys)
# ---------------------------------------------------------------------------------------------


class Unserializable(Exception):
    pass


def _js_number(value: float) -> str:
    if not math.isfinite(value):
        return "null"  # JSON.stringify(NaN) === "null"
    if value == 0:
        return "0"  # JS prints -0 as "0"
    if value.is_integer() and abs(value) < 1e21:
        return str(int(value))  # JS prints 1.0 as "1"
    text = repr(value)  # shortest round-trip, like JS
    if "e" in text:
        mantissa, exponent = text.split("e")
        sign = "-" if exponent.startswith("-") else "+"
        digits = exponent.lstrip("+-").lstrip("0") or "0"
        text = f"{mantissa}e{sign}{digits}"
    return text


def _canonical(value: Any, depth: int) -> str:
    if depth > MAX_DEPTH:
        raise Unserializable("nesting deeper than %d" % MAX_DEPTH)
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, int):
        return str(int(value))
    if isinstance(value, float):
        return _js_number(value)
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(_canonical(v, depth + 1) for v in value) + "]"
    if isinstance(value, dict):
        items = []
        for key in sorted(value.keys(), key=_key_sort):
            if not isinstance(key, str):
                raise Unserializable("non-string dict key %r" % (key,))
            items.append(json.dumps(key, ensure_ascii=False) + ":" + _canonical(value[key], depth + 1))
        return "{" + ",".join(items) + "}"
    raise Unserializable("value of type %s is not JSON-representable" % type(value).__qualname__)


def _key_sort(key: Any) -> str:
    if not isinstance(key, str):
        raise Unserializable("non-string dict key %r" % (key,))
    # JS sorts keys by UTF-16 code units; approximate with the same encoding.
    return key.encode("utf-16-be", "surrogatepass").decode("latin-1")


def canonical_json(value: Any) -> str:
    text = _canonical(value, 0)
    try:
        text.encode("utf-8")
    except UnicodeEncodeError:
        # Lone surrogates: fall back to ASCII escapes so the line stays valid UTF-8.
        text = json.dumps(json.loads(text, strict=False), ensure_ascii=True, separators=(",", ":"), sort_keys=True)
    return text


# ---------------------------------------------------------------------------------------------
# Observations
# ---------------------------------------------------------------------------------------------


def exception_type_name(exc: BaseException) -> str:
    cls = type(exc)
    module = getattr(cls, "__module__", None)
    name = getattr(cls, "__qualname__", cls.__name__)
    if module in (None, "builtins", "__main__"):
        return name
    return f"{module}.{name}"


def error_observation(case_id: str, exc: BaseException | None, exception_type: str | None = None,
                      message: str | None = None) -> dict[str, Any]:
    obs: dict[str, Any] = {"caseId": case_id, "status": "error"}
    if exc is not None:
        obs["exceptionType"] = bound(exception_type or exception_type_name(exc), LIMIT_EXCEPTION_TYPE)
        try:
            obs["message"] = bound(message if message is not None else str(exc), LIMIT_MESSAGE)
        except Exception:  # a hostile __str__
            obs["message"] = bound("<unprintable exception message>", LIMIT_MESSAGE)
        try:
            tb = "".join(traceback.format_exception(type(exc), exc, exc.__traceback__))
        except Exception:
            tb = "<traceback unavailable>"
        obs["tracebackTail"] = bound_tail(tb, LIMIT_TRACEBACK)
    else:
        obs["exceptionType"] = bound(exception_type or "AdapterError", LIMIT_EXCEPTION_TYPE)
        obs["message"] = bound(message or "", LIMIT_MESSAGE)
    return obs


def ok_observation(case_id: str, value: Any) -> dict[str, Any]:
    try:
        text = canonical_json(value)
    except (Unserializable, RecursionError, ValueError, TypeError) as exc:
        return error_observation(case_id, None, "AdapterUnserializableReturn", str(exc))
    if utf16_len(text) > LIMIT_VALUE:
        return error_observation(
            case_id, None, "AdapterOutputTooLarge",
            f"valueCanonical would be {utf16_len(text)} units (limit {LIMIT_VALUE})",
        )
    return {"caseId": case_id, "status": "ok", "valueCanonical": text}


# ---------------------------------------------------------------------------------------------
# Request loading and validation
# ---------------------------------------------------------------------------------------------


def read_request_bytes(path: str | None) -> bytes:
    if path is None:
        data = sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1)
    else:
        try:
            with open(path, "rb") as fh:
                data = fh.read(MAX_REQUEST_BYTES + 1)
        except OSError as exc:
            raise AdapterProtocolError(f"cannot read request {path}: {exc}") from exc
    if len(data) > MAX_REQUEST_BYTES:
        raise AdapterProtocolError(f"request exceeds {MAX_REQUEST_BYTES} bytes")
    return data


def parse_request(data: bytes) -> list[tuple[str, Any]]:
    """Return (id, input) pairs. Entries with a valid id but bad input are kept so they can be
    reported as error observations; an invalid or missing id is a protocol error."""
    try:
        request = json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as exc:
        raise AdapterProtocolError(f"request is not valid JSON: {exc}") from exc
    if not isinstance(request, dict):
        raise AdapterProtocolError("request must be a JSON object")
    if request.get("schemaVersion") != SCHEMA_VERSION:
        raise AdapterProtocolError(f"unsupported schemaVersion {request.get('schemaVersion')!r}")
    cases = request.get("cases")
    if not isinstance(cases, list):
        raise AdapterProtocolError("request.cases must be an array")
    if len(cases) > MAX_CASES:
        raise AdapterProtocolError(f"request has {len(cases)} cases (limit {MAX_CASES})")
    out: list[tuple[str, Any]] = []
    seen: set[str] = set()
    for index, case in enumerate(cases):
        if not isinstance(case, dict):
            raise AdapterProtocolError(f"cases[{index}] is not an object")
        case_id = case.get("id")
        if not isinstance(case_id, str) or not PLAIN_ID.match(case_id):
            raise AdapterProtocolError(f"cases[{index}].id is not a plain identifier")
        if case_id in seen:
            raise AdapterProtocolError(f"duplicate case id {case_id!r}")
        seen.add(case_id)
        out.append((case_id, case.get("input")))
    return out


def load_adapter_module(profile_dir: str) -> Any:
    profile_path = os.path.join(profile_dir, "profile.json")
    try:
        with open(profile_path, "rb") as fh:
            profile = json.load(fh)
    except (OSError, ValueError) as exc:
        raise AdapterProtocolError(f"cannot read {profile_path}: {exc}") from exc
    module_name = profile.get("adapterModule") if isinstance(profile, dict) else None
    if not isinstance(module_name, str) or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,127}", module_name):
        raise AdapterProtocolError("profile.adapterModule is not a valid module name")
    module_path = os.path.join(profile_dir, module_name + ".py")
    spec = importlib.util.spec_from_file_location("airlock_profile_adapter", module_path)
    if spec is None or spec.loader is None:
        raise AdapterProtocolError(f"adapter module not found: {module_path}")
    module = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(module)
    except BaseException as exc:  # noqa: BLE001 - importing the profile adapter is trusted code, still bounded
        raise AdapterProtocolError(f"adapter module failed to import: {exception_type_name(exc)}: {exc}") from exc
    run_case = getattr(module, "run_case", None)
    if not callable(run_case):
        raise AdapterProtocolError("adapter module does not export a callable run_case")
    return run_case


# ---------------------------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------------------------


def _alarm_handler(signum: int, frame: Any) -> None:  # noqa: ARG001
    raise CaseTimeout()


def run_one(run_case: Any, case_id: str, case_input: Any, timeout_s: float) -> dict[str, Any]:
    if not isinstance(case_input, dict):
        return error_observation(case_id, None, "AdapterRequestError", "case input must be a JSON object")
    sink = io.StringIO()
    use_alarm = timeout_s > 0 and hasattr(signal, "setitimer")
    try:
        if use_alarm:
            signal.signal(signal.SIGALRM, _alarm_handler)
            signal.setitimer(signal.ITIMER_REAL, timeout_s)
        try:
            with contextlib.redirect_stdout(sink):
                value = run_case(case_input)
        finally:
            if use_alarm:
                signal.setitimer(signal.ITIMER_REAL, 0)
    except CaseTimeout:
        return error_observation(case_id, None, "AdapterCaseTimeout", f"case exceeded {timeout_s:g}s")
    except BaseException as exc:  # noqa: BLE001 - every failure inside the candidate becomes an observation
        return error_observation(case_id, exc)
    finally:
        leaked = sink.getvalue()
        if leaked:
            sys.stderr.write(f"[adapter] case {case_id} wrote {len(leaked)} chars to stdout; redirected\n")
    return ok_observation(case_id, value)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Airlock runtime adapter", add_help=True)
    parser.add_argument("--request", default=None, help="AdapterRequest JSON file (default: stdin)")
    parser.add_argument("--source-root", default=DEFAULT_SOURCE_ROOT)
    parser.add_argument("--profile-dir", default=DEFAULT_PROFILE_DIR)
    parser.add_argument("--case-timeout-seconds", type=float, default=0.0,
                        help="optional per-case wall-clock guard (0 = disabled; the supervisor owns the real deadline)")
    args = parser.parse_args(argv)

    # Observations go to the original stdout fd; sys.stdout is re-pointed at stderr so any stray
    # print() from candidate code (or from us) can never corrupt the line protocol.
    out_fd = os.dup(1)
    sys.stdout = sys.stderr

    def emit(obs: dict[str, Any]) -> None:
        line = json.dumps(obs, ensure_ascii=False, separators=(",", ":")) + "\n"
        data = line.encode("utf-8", "surrogatepass")
        view = memoryview(data)
        while view:
            written = os.write(out_fd, view)
            view = view[written:]

    try:
        cases = parse_request(read_request_bytes(args.request))
        if not os.path.isdir(args.source_root):
            raise AdapterProtocolError(f"source root {args.source_root} is not a directory")
        sys.path.insert(0, os.path.abspath(args.source_root))
        run_case = load_adapter_module(args.profile_dir)
    except AdapterProtocolError as exc:
        sys.stderr.write(f"[adapter] protocol error: {exc}\n")
        return 1

    for case_id, case_input in cases:
        emit(run_one(run_case, case_id, case_input, args.case_timeout_seconds))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
