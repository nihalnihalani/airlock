"""adapter.py protocol tests: one line per case, bounded values, error observations carry exceptionType."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

import adapter

PLAIN_ID_OK = "reported-empty-headers-maxheader"


def run_adapter(runtime_dir: Path, source_root: Path, profile_dir: Path, request: dict | bytes | None,
                *extra: str, via_file: Path | None = None) -> tuple[int, list[dict], str, list[str]]:
    cmd = [sys.executable, str(runtime_dir / "adapter.py"), "--source-root", str(source_root),
           "--profile-dir", str(profile_dir), *extra]
    data = request if isinstance(request, (bytes, type(None))) else json.dumps(request).encode()
    if via_file is not None:
        via_file.write_bytes(data or b"")
        cmd += ["--request", str(via_file)]
        proc = subprocess.run(cmd, capture_output=True, timeout=60)
    else:
        proc = subprocess.run(cmd, input=data or b"", capture_output=True, timeout=60)
    raw_lines = proc.stdout.decode("utf-8").splitlines()
    parsed = []
    for line in raw_lines:
        parsed.append(json.loads(line))  # every stdout line must be a JSON object
    return proc.returncode, parsed, proc.stderr.decode("utf-8", "replace"), raw_lines


def req(*cases: tuple[str, dict]) -> dict:
    return {"schemaVersion": 1, "cases": [{"id": i, "input": inp} for i, inp in cases]}


def test_one_line_per_case_in_order(runtime_dir, fake_source_root, fake_profile_dir):
    code, obs, _err, raw = run_adapter(runtime_dir, fake_source_root, fake_profile_dir, req(
        ("a", {"op": "echo", "value": 1}),
        ("b", {"op": "raise"}),
        ("c", {"op": "echo", "value": "s"}),
    ))
    assert code == 0
    assert len(raw) == 3
    assert [o["caseId"] for o in obs] == ["a", "b", "c"]
    assert obs[0] == {"caseId": "a", "status": "ok", "valueCanonical": "1"}
    assert obs[2]["valueCanonical"] == '"s"'


def test_error_observation_carries_exception_type_message_and_traceback(runtime_dir, fake_source_root, fake_profile_dir):
    code, obs, _err, _ = run_adapter(runtime_dir, fake_source_root, fake_profile_dir, req(("x", {"op": "raise"})))
    assert code == 0
    o = obs[0]
    assert o["status"] == "error"
    assert o["exceptionType"] == "IndexError"
    assert o["message"] == "list index out of range"
    assert "IndexError: list index out of range" in o["tracebackTail"]
    assert "valueCanonical" not in o


def test_non_builtin_exception_type_is_qualified(runtime_dir, fake_source_root, fake_profile_dir):
    _, obs, _, _ = run_adapter(runtime_dir, fake_source_root, fake_profile_dir, req(("x", {"op": "custom"})))
    assert obs[0]["exceptionType"].endswith("WeirdError")
    assert obs[0]["exceptionType"].startswith("pkg.mod.")


def test_request_via_file_and_stdin_agree(runtime_dir, fake_source_root, fake_profile_dir, tmp_path):
    r = req(("a", {"op": "echo", "value": [1, 2]}))
    _, via_stdin, _, _ = run_adapter(runtime_dir, fake_source_root, fake_profile_dir, r)
    _, via_file, _, _ = run_adapter(runtime_dir, fake_source_root, fake_profile_dir, r, via_file=tmp_path / "request.json")
    assert via_stdin == via_file == [{"caseId": "a", "status": "ok", "valueCanonical": "[1,2]"}]


def test_oversize_return_value_becomes_error_not_truncated_value(runtime_dir, fake_source_root, fake_profile_dir):
    _, obs, _, _ = run_adapter(runtime_dir, fake_source_root, fake_profile_dir, req(("big", {"op": "big", "n": 70000})))
    o = obs[0]
    assert o["status"] == "error"
    assert o["exceptionType"] == "AdapterOutputTooLarge"
    assert "valueCanonical" not in o


def test_value_at_limit_is_allowed(runtime_dir, fake_source_root, fake_profile_dir):
    # 65534 x's plus two quote characters = exactly 65536 UTF-16 units.
    _, obs, _, _ = run_adapter(runtime_dir, fake_source_root, fake_profile_dir, req(("b", {"op": "big", "n": 65534})))
    assert obs[0]["status"] == "ok"
    assert len(obs[0]["valueCanonical"]) == 65536


def test_long_message_and_traceback_are_bounded():
    exc = ValueError("m" * 10000)
    try:
        raise exc
    except ValueError as caught:
        obs = adapter.error_observation("c", caught)
    assert len(obs["message"]) == adapter.LIMIT_MESSAGE
    assert len(obs["tracebackTail"]) <= adapter.LIMIT_TRACEBACK
    assert len(adapter.bound("é" * 300, 256)) == 256
    # Non-BMP characters count as two units, as zod counts them.
    assert adapter.utf16_len(adapter.bound("😀" * 300, 256)) <= 256


def test_candidate_stdout_leak_is_redirected(runtime_dir, fake_source_root, fake_profile_dir):
    code, obs, err, raw = run_adapter(runtime_dir, fake_source_root, fake_profile_dir, req(("p", {"op": "print"})))
    assert code == 0
    assert len(raw) == 1
    assert obs[0] == {"caseId": "p", "status": "ok", "valueCanonical": '"printed"'}
    assert "LEAK TO STDOUT" not in "\n".join(raw)
    assert "redirected" in err


def test_unserializable_return_is_error(runtime_dir, fake_source_root, fake_profile_dir):
    _, obs, _, _ = run_adapter(runtime_dir, fake_source_root, fake_profile_dir, req(("o", {"op": "object"})))
    assert obs[0]["status"] == "error"
    assert obs[0]["exceptionType"] == "AdapterUnserializableReturn"


def test_system_exit_inside_case_does_not_kill_the_run(runtime_dir, fake_source_root, fake_profile_dir):
    code, obs, _, _ = run_adapter(runtime_dir, fake_source_root, fake_profile_dir, req(("e", {"op": "exit"}), ("a", {"op": "echo", "value": 0})))
    assert code == 0
    assert obs[0]["status"] == "error" and obs[0]["exceptionType"] == "SystemExit"
    assert obs[1]["status"] == "ok"


def test_case_timeout_guard(runtime_dir, fake_source_root, fake_profile_dir):
    _, obs, _, _ = run_adapter(runtime_dir, fake_source_root, fake_profile_dir,
                               req(("h", {"op": "hang"}), ("a", {"op": "echo", "value": 1})), "--case-timeout-seconds", "1")
    assert obs[0]["status"] == "error" and obs[0]["exceptionType"] == "AdapterCaseTimeout"
    assert obs[1]["status"] == "ok"


def test_non_object_input_is_error_observation_not_crash(runtime_dir, fake_source_root, fake_profile_dir):
    code, obs, _, _ = run_adapter(runtime_dir, fake_source_root, fake_profile_dir,
                                  {"schemaVersion": 1, "cases": [{"id": "n", "input": [1, 2]}]})
    assert code == 0
    assert obs[0]["exceptionType"] == "AdapterRequestError"


@pytest.mark.parametrize("bad", [
    b"not json",
    b"[]",
    json.dumps({"schemaVersion": 2, "cases": []}).encode(),
    json.dumps({"schemaVersion": 1, "cases": "x"}).encode(),
    json.dumps({"schemaVersion": 1, "cases": [{"id": "../x", "input": {}}]}).encode(),
    json.dumps({"schemaVersion": 1, "cases": [{"id": "a", "input": {}}, {"id": "a", "input": {}}]}).encode(),
    json.dumps({"schemaVersion": 1, "cases": [{"id": "a" * 65, "input": {}}]}).encode(),
    json.dumps({"schemaVersion": 1, "cases": [{"id": "a", "input": {}}] * 1001}).encode(),
])
def test_malformed_requests_exit_nonzero_with_no_observations(runtime_dir, fake_source_root, fake_profile_dir, bad):
    code, obs, err, _ = run_adapter(runtime_dir, fake_source_root, fake_profile_dir, bad)
    assert code == 1
    assert obs == []
    assert "protocol error" in err


def test_oversize_request_is_refused(runtime_dir, fake_source_root, fake_profile_dir):
    big = json.dumps({"schemaVersion": 1, "cases": [{"id": "a", "input": {"blob": "x" * (adapter.MAX_REQUEST_BYTES)}}]}).encode()
    code, obs, err, _ = run_adapter(runtime_dir, fake_source_root, fake_profile_dir, big)
    assert code == 1 and obs == [] and "exceeds" in err


def test_missing_adapter_module_or_source_root(runtime_dir, fake_source_root, fake_profile_dir, tmp_path):
    code, obs, err, _ = run_adapter(runtime_dir, tmp_path / "nope", fake_profile_dir, req(("a", {})))
    assert code == 1 and obs == [] and "source root" in err
    (fake_profile_dir / "fake_adapter.py").unlink()
    code, obs, err, _ = run_adapter(runtime_dir, fake_source_root, fake_profile_dir, req(("a", {})))
    assert code == 1 and obs == [] and "adapter module" in err


def test_candidate_cannot_shadow_adapter_module(runtime_dir, fake_source_root, fake_profile_dir):
    (fake_source_root / "fake_adapter.py").write_text("def run_case(input):\n    return 'SHADOWED'\n")
    _, obs, _, _ = run_adapter(runtime_dir, fake_source_root, fake_profile_dir, req(("a", {"op": "echo", "value": "real"})))
    assert obs[0]["valueCanonical"] == '"real"'


# --- canonical JSON must match contracts.canonicalJson (JSON.stringify with sorted keys) ---

@pytest.mark.parametrize("value,expected", [
    ("Name    Value\n------  -------", '"Name    Value\\n------  -------"'),
    ({"b": 1, "a": [1, 2, {"d": None, "c": True}]}, '{"a":[1,2,{"c":true,"d":null}],"b":1}'),
    (1.0, "1"),
    (2.5, "2.5"),
    (float("nan"), "null"),
    (float("inf"), "null"),
    (1e21, "1e+21"),
    (1e-7, "1e-7"),
    (-0.0, "0"),
    (123456789012345678, "123456789012345678"),
    ((1, "ü"), '[1,"ü"]'),
    ("tab\tquote\"back\\", '"tab\\tquote\\"back\\\\"'),
    ("\u0001", '"\\u0001"'),
])
def test_canonical_json_matches_js(value, expected):
    assert adapter.canonical_json(value) == expected


def test_canonical_json_rejects_non_string_keys_and_deep_nesting():
    with pytest.raises(adapter.Unserializable):
        adapter.canonical_json({1: 2})
    deep: list = []
    cur = deep
    for _ in range(100):
        nxt: list = []
        cur.append(nxt)
        cur = nxt
    with pytest.raises(adapter.Unserializable):
        adapter.canonical_json(deep)


def test_float_and_nested_values_through_subprocess(runtime_dir, fake_source_root, fake_profile_dir):
    _, obs, _, _ = run_adapter(runtime_dir, fake_source_root, fake_profile_dir, req(("f", {"op": "float"}), ("n", {"op": "nested"})))
    assert obs[0]["valueCanonical"] == '{"a":1,"b":2.5,"c":null,"d":1e+21,"e":1e-7,"f":0}'
    assert obs[1]["valueCanonical"] == '{"a":[true,false],"z":[1,{"x":null,"y":"ü"}]}'
