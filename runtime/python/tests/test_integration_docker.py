"""Container integration: build (or reuse) airlock-runtime-python:tabulate-365 and exercise the
materialize → adapter → probe → collector protocol in a runc container.

DEV-UNSAFE: these tests run on the local Docker's default runtime (plain runc on macOS). That is a
development configuration only (CLAUDE.md §3.8); the supervisor refuses runc unless
AIRLOCK_DEV_UNSAFE=1 and records it. Nothing here is a deployment claim.

Skipped entirely when docker is unavailable. Delivery into the container uses a tar stream over
`docker cp -` (the CLI equivalent of the Engine putArchive call the supervisor uses); nothing is
ever shell-interpolated.
"""

from __future__ import annotations

import io
import json
import subprocess
import tarfile
import time
import uuid
from pathlib import Path

import pytest

IMAGE = "airlock-runtime-python:tabulate-365"
REPORTED_CASE = "reported-empty-headers-maxheader"
RUN_FLAGS = [
    "--network", "none", "--user", "1000:1000", "--read-only",
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--pids-limit", "64", "--memory", "512m", "--cpus", "1",
    "--ipc", "private", "--restart", "no",
    "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=67108864,mode=1777",
    "--label", "airlock.test=dev-unsafe-runc",
]
# The supervisor's workspace: a local volume backed by a size-capped tmpfs (runtime.ts workspaceDriverOpts).
TMPFS_VOLUME_OPTS = ["--driver", "local", "--opt", "type=tmpfs", "--opt", "device=tmpfs", "--opt", "o=size=134217728,uid=1000,gid=1000,mode=0755"]


def docker(*args: str, input: bytes | None = None, timeout: int = 120, check: bool = True) -> subprocess.CompletedProcess:
    proc = subprocess.run(["docker", *args], input=input, capture_output=True, timeout=timeout)
    if check and proc.returncode != 0:
        raise AssertionError(f"docker {' '.join(args)} failed ({proc.returncode}):\n{proc.stderr.decode(errors='replace')}")
    return proc


@pytest.fixture(scope="session")
def image(docker_available: bool, runtime_dir: Path) -> str:
    if not docker_available:
        pytest.skip("docker unavailable")
    if docker("image", "inspect", IMAGE, check=False).returncode != 0:
        proc = subprocess.run(["bash", str(runtime_dir / "build.sh"), "tabulate-365"], capture_output=True, text=True, timeout=900)
        assert proc.returncode == 0, proc.stderr
    return IMAGE


def tar_bytes(files: dict[str, bytes]) -> bytes:
    """A tar with uid/gid 1000 and 0644 files, like the supervisor's putArchive payload."""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w") as tar:
        for path, data in files.items():
            info = tarfile.TarInfo(path)
            info.size = len(data)
            info.mode = 0o644
            info.uid = info.gid = 1000
            info.mtime = int(time.time())
            tar.addfile(info, io.BytesIO(data))
    return buf.getvalue()


class Sandbox:
    """One author-style sandbox: the supervisor's tmpfs-backed volume at /workspace, idle sleep
    entrypoint, exec as 1000:1000. `disk_workspace=True` uses a plain (disk) volume instead, for the
    collector test that reads the volume after the container stopped (the supervisor instead holds
    the tmpfs volume with the collector before it stops the author); the probe reports such a
    workspace as a host-backed mount."""

    def __init__(self, image: str, extra_run_flags: list[str] | None = None, disk_workspace: bool = False):
        suffix = uuid.uuid4().hex[:12]
        self.name = f"airlock-test-{suffix}"
        self.volume = f"airlock-test-vol-{suffix}"
        self.image = image
        self.extra = extra_run_flags or []
        self.disk_workspace = disk_workspace

    def __enter__(self) -> "Sandbox":
        docker("volume", "create", *([] if self.disk_workspace else TMPFS_VOLUME_OPTS), self.volume)
        docker("run", "-d", "--name", self.name, *RUN_FLAGS, *self.extra, "-v", f"{self.volume}:/workspace", self.image)
        return self

    def __exit__(self, *exc) -> None:
        docker("rm", "-f", self.name, check=False)
        docker("volume", "rm", "-f", self.volume, check=False)

    def put(self, files: dict[str, bytes], dest: str = "/workspace") -> None:
        docker("cp", "-", f"{self.name}:{dest}", input=tar_bytes(files))

    def exec(self, *cmd: str, timeout: int = 60, check: bool = False) -> subprocess.CompletedProcess:
        return docker("exec", "-u", "1000:1000", "-w", "/workspace", self.name, *cmd, timeout=timeout, check=check)

    def stop(self) -> None:
        docker("stop", "-t", "2", self.name)


def request_for(contract: dict) -> bytes:
    return json.dumps({"schemaVersion": 1, "cases": [{"id": c["id"], "input": c["input"]} for c in contract["cases"]]}).encode()


def parse_observations(stdout: bytes) -> list[dict]:
    lines = stdout.decode("utf-8").splitlines()
    return [json.loads(line) for line in lines]


def assert_matches(observations: list[dict], contract: dict, side: str) -> None:
    by_id = {o["caseId"]: o for o in observations}
    assert set(by_id) == {c["id"] for c in contract["cases"]}
    for case in contract["cases"]:
        expected = case[side]
        got = by_id[case["id"]]
        if expected["kind"] == "raises":
            assert got["status"] == "error", got
            assert got["exceptionType"] == expected["exceptionType"], got
            if "messageIncludes" in expected:
                assert expected["messageIncludes"] in got["message"], got
        else:
            assert got["status"] == "ok", got
            assert got["valueCanonical"] == expected["valueCanonical"], (case["id"], got)


def test_baseline_reproduces_reported_failure_and_probe_is_blocked(image: str, contract: dict):
    with Sandbox(image) as sb:
        ident = sb.exec("bash", "-c", "id -u; id -g; hostname; uname -r; pwd; echo $HOME", check=True)
        uid, gid, hostname, kernel, cwd, home = ident.stdout.decode().split()
        assert (uid, gid, cwd, home) == ("1000", "1000", "/workspace", "/workspace") and hostname and kernel

        probe = sb.exec("bash", "/opt/airlock/probe.sh")
        result = json.loads(probe.stdout.decode().strip())
        assert result["allBlocked"] is True, result
        assert probe.returncode == 0

        sb.put({"request.json": request_for(contract)})
        mat = sb.exec("python", "/opt/airlock/materialize.py", check=True)
        assert json.loads(mat.stdout)["replaced"] == []
        assert json.loads(mat.stdout)["materialized"] == 23

        again = sb.exec("python", "/opt/airlock/materialize.py")
        assert again.returncode == 1 and b"already exists" in again.stderr

        run = sb.exec("python", "/opt/airlock/adapter.py", "--request", "/workspace/request.json", check=True)
        observations = parse_observations(run.stdout)
        assert len(observations) == 6
        assert_matches(observations, contract, "baseline")
        reported = next(o for o in observations if o["caseId"] == REPORTED_CASE)
        assert reported["exceptionType"] == "IndexError"

        # The sandbox cannot write outside /workspace and cannot see the contract.
        ro = sb.exec("bash", "-c", "touch /opt/airlock/x 2>&1; touch /etc/x 2>&1; ls /opt/airlock/profile")
        assert b"Read-only file system" in ro.stdout
        assert b"contract.json" not in ro.stdout
        assert b"referenceCommitMaintainerOnly" not in sb.exec("cat", "/opt/airlock/profile/profile.json").stdout


def test_author_command_wrapper_times_out(image: str):
    with Sandbox(image) as sb:
        sb.exec("python", "/opt/airlock/materialize.py", check=True)
        start = time.monotonic()
        proc = docker("exec", "-u", "1000:1000", "-w", "/workspace/src", sb.name,
                      "/usr/bin/timeout", "--signal=TERM", "--kill-after=2s", "1s",
                      "/bin/bash", "--noprofile", "--norc", "-c", "sleep 30; echo NOT_REACHED",
                      check=False, timeout=60)
        assert proc.returncode == 124
        assert b"NOT_REACHED" not in proc.stdout
        assert time.monotonic() - start < 15


def test_probe_detects_a_host_mount(image: str, tmp_path: Path):
    (tmp_path / "leak").mkdir()
    with Sandbox(image, ["-v", f"{tmp_path / 'leak'}:/hostleak:ro"]) as sb:
        probe = sb.exec("bash", "/opt/airlock/probe.sh")
        result = json.loads(probe.stdout.decode().strip())
        assert result["hostMounts"] == "REACHED" and result["allBlocked"] is False
        assert any("/hostleak" in problem for problem in result["details"]["hostMounts"])
        assert probe.returncode == 3


def test_probe_reports_a_disk_backed_workspace(image: str):
    # D12: /workspace is no longer exempt. A plain Docker volume there is host disk, not the owned tmpfs.
    with Sandbox(image, disk_workspace=True) as sb:
        result = json.loads(sb.exec("bash", "/opt/airlock/probe.sh").stdout.decode().strip())
        assert result["hostMounts"] == "REACHED" and result["allBlocked"] is False
        assert any(problem.startswith("workspace /workspace") for problem in result["details"]["hostMounts"])


def test_freeze_collects_only_allowed_paths_from_stopped_volume(image: str, contract: dict, profile: dict):
    with Sandbox(image, disk_workspace=True) as sb:
        sb.exec("python", "/opt/airlock/materialize.py", check=True)
        # Author edits the allowed file, adds junk and a symlink; only the allowed file is collected.
        sb.exec("bash", "-c",
                "cd /workspace/src && printf '# edited by author\\n' >> tabulate/__init__.py "
                "&& echo junk > tabulate/junk.py && ln -s /etc/passwd tabulate/link.py", check=True)
        sb.stop()
        proc = docker("run", "--rm", *RUN_FLAGS, "-v", f"{sb.volume}:/candidate:ro", "-w", "/",
                      "--entrypoint", "python", image, "-I", "-S", "/opt/airlock/collector.py",
                      "--root", "/candidate/src", "--profile", "/opt/airlock/profile/profile.json")
        envelope = json.loads(proc.stdout)
        assert envelope["schemaVersion"] == 1 and envelope["rejected"] == []
        assert [f["path"] for f in envelope["files"]] == profile["allowedReplacementPaths"]
        f = envelope["files"][0]
        import base64, hashlib
        raw = base64.b64decode(f["contentBase64"])
        assert raw.endswith(b"# edited by author\n")
        assert f["byteLength"] == len(raw) and f["sha256"] == hashlib.sha256(raw).hexdigest()


def find_fixture_replacement(repo_root: Path) -> Path | None:
    fixture = repo_root / "apps" / "control" / "test" / "fixtures" / "diagnostic-candidate-tabulate-365"
    for candidate in (fixture / "tabulate" / "__init__.py", fixture / "replacements" / "tabulate" / "__init__.py",
                      fixture / "__init__.py"):
        if candidate.is_file():
            return candidate
    return None


def test_diagnostic_candidate_passes_contract(image: str, contract: dict, repo_root: Path):
    replacement = find_fixture_replacement(repo_root)
    if replacement is None:
        pytest.skip("apps/control/test/fixtures/diagnostic-candidate-tabulate-365 not present")
    with Sandbox(image) as sb:
        sb.put({"request.json": request_for(contract), "replacements/tabulate/__init__.py": replacement.read_bytes()})
        mat = sb.exec("python", "/opt/airlock/materialize.py", check=True)
        assert json.loads(mat.stdout)["replaced"] == ["tabulate/__init__.py"]
        run = sb.exec("python", "/opt/airlock/adapter.py", "--request", "/workspace/request.json", check=True)
        observations = parse_observations(run.stdout)
        assert len(observations) == 6
        assert_matches(observations, contract, "candidate")
