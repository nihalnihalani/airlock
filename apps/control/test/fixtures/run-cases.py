"""Test-only case runner: mirrors the runtime adapter protocol for the diagnostic fixture check.

Reads an AdapterRequest JSON file (argv[1]), calls ``tabulate.tabulate(**input)`` for each case
and prints exactly one Observation JSON object per line. Never raises out of a case.
This runs in a throwaway uv venv on the developer machine; it is not the production adapter.
"""
import json
import sys
import traceback

MAX_VALUE = 65536
MAX_MSG = 4096
MAX_TB = 8192


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def main():
    with open(sys.argv[1], "r", encoding="utf-8") as fh:
        request = json.load(fh)
    import tabulate  # the tree under test; must be first on sys.path via the venv install

    for case in request["cases"]:
        obs = {"caseId": case["id"]}
        try:
            value = tabulate.tabulate(**case["input"])
            text = canonical(value)
            obs["status"] = "ok"
            obs["valueCanonical"] = text[:MAX_VALUE]
        except BaseException as exc:  # noqa: BLE001 - every failure becomes an observation
            obs["status"] = "error"
            obs["exceptionType"] = type(exc).__name__[:256]
            obs["message"] = str(exc)[:MAX_MSG]
            obs["tracebackTail"] = traceback.format_exc()[-MAX_TB:]
        sys.stdout.write(json.dumps(obs) + "\n")
    sys.stdout.flush()


if __name__ == "__main__":
    main()
