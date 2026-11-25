"""Sandboxed subprocess runner (plan §6.2). Tests that need Linux /proc run in the container."""

from __future__ import annotations

import logging
import os
import threading
import time
from pathlib import Path

import pytest

from audio_service.domain import runner as runner_module
from audio_service.domain.runner import (
    STDERR_CAP_BYTES,
    Outcome,
    RunResult,
    SandboxError,
    SandboxRunner,
)


class Token:
    def __init__(self) -> None:
        self.cancelled = False


def run(r: SandboxRunner, argv: list[str], **kwargs: object) -> tuple[RunResult, bytes]:
    out = bytearray()
    options: dict[str, object] = {"timeout_s": 10, **kwargs}
    result = r.run(argv, stdout_sink=out.extend, **options)  # type: ignore[arg-type]
    return result, bytes(out)


@pytest.fixture
def plain() -> SandboxRunner:
    return SandboxRunner("off")


def alive(pid: int) -> bool:
    """True for a running process; zombies awaiting init's reaping count as dead."""
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    stat = Path(f"/proc/{pid}/stat")
    if stat.exists():
        return stat.read_text().rsplit(")", 1)[1].split()[0] != "Z"
    return True


def test_environment_is_exactly_path_and_lc_all(
    plain: SandboxRunner, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("AUDIO_SERVICE_TOKEN", "must-not-leak-" + "x" * 32)
    monkeypatch.setenv("HOME", "/home/leak")
    result, out = run(plain, ["env"])
    assert result.returncode == 0
    assert sorted(out.decode().split()) == ["LC_ALL=C", "PATH=/usr/bin:/bin"]


def test_arguments_are_never_interpreted_by_a_shell(plain: SandboxRunner, tmp_path: Path) -> None:
    marker = tmp_path / "pwned"
    result, out = run(plain, ["echo", f"$(touch {marker}); `touch {marker}` | ; &"])
    assert result.returncode == 0 and not marker.exists()
    assert b"$(touch" in out


def test_missing_executable_is_a_sandbox_error(plain: SandboxRunner) -> None:
    with pytest.raises(SandboxError):
        run(plain, ["definitely-not-installed-binary"])


def test_rlimits_are_applied(plain: SandboxRunner) -> None:
    result, out = run(
        plain, ["sh", "-c", "ulimit -n; ulimit -f; ulimit -c; ulimit -t"], timeout_s=7
    )
    assert result.returncode == 0
    nofile, fsize, core, cpu = out.decode().split()
    assert (nofile, fsize, core) == ("64", "0", "0")
    assert cpu == "8"  # ceil(timeout) + 1


def test_rlimit_fsize_blocks_file_writes(plain: SandboxRunner, tmp_path: Path) -> None:
    target = tmp_path / "written"
    result, _ = run(plain, ["dd", "if=/dev/zero", f"of={target}", "bs=1", "count=1"])
    assert result.returncode != 0
    assert not target.exists() or target.stat().st_size == 0


def test_stdin_is_dev_null(plain: SandboxRunner) -> None:
    result, out = run(plain, ["cat"])
    assert result.returncode == 0 and out == b""


def test_stdout_is_streamed_and_capped(plain: SandboxRunner) -> None:
    result, out = run(plain, ["head", "-c", "300000", "/dev/zero"])
    assert result.outcome is Outcome.EXITED and len(out) == 300000
    capped, got = run(plain, ["head", "-c", "300000", "/dev/zero"], max_stdout_bytes=1000)
    assert capped.outcome is Outcome.OUTPUT_LIMIT and len(got) <= 1000


def test_stderr_is_bounded_and_never_logged(
    plain: SandboxRunner, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.DEBUG)
    script = "echo SECRET-METADATA-IN-STDERR >&2; head -c 300000 /dev/zero >&2"
    result, _ = run(plain, ["sh", "-c", script])
    assert result.outcome is Outcome.EXITED
    assert len(result.stderr) == STDERR_CAP_BYTES
    assert result.stderr.startswith(b"SECRET-METADATA-IN-STDERR")
    assert "SECRET-METADATA" not in caplog.text


def test_wall_clock_timeout_kills_the_child(plain: SandboxRunner) -> None:
    started = time.monotonic()
    result, _ = run(plain, ["sleep", "30"], timeout_s=0.5)
    assert result.outcome is Outcome.TIMEOUT
    assert time.monotonic() - started < 5


def test_timeout_kills_the_whole_process_group_including_grandchildren(
    plain: SandboxRunner,
) -> None:
    grandchildren: list[int] = []
    out = bytearray()
    # A background grandchild plus a hung foreground child; SIGTERM is ignored by the shell child.
    script = "trap '' TERM; sleep 60 & echo $!; sleep 60; wait"
    started = time.monotonic()
    result = plain.run(["sh", "-c", script], stdout_sink=out.extend, timeout_s=0.5)
    grandchildren.append(int(out.split()[0]))
    assert result.outcome is Outcome.TIMEOUT
    assert time.monotonic() - started < 8  # SIGTERM ignored: SIGKILL after the 2 s grace
    assert not alive(grandchildren[0])


def test_cancellation_stops_a_running_child(plain: SandboxRunner) -> None:
    token = Token()
    threading.Timer(0.3, lambda: setattr(token, "cancelled", True)).start()
    started = time.monotonic()
    result, _ = run(plain, ["sleep", "30"], cancel=token, timeout_s=30)
    assert result.outcome is Outcome.CANCELLED
    assert time.monotonic() - started < 5


def test_leftover_background_processes_are_killed_after_a_normal_exit(
    plain: SandboxRunner,
) -> None:
    result, out = run(plain, ["sh", "-c", "sleep 60 >/dev/null 2>&1 & echo $!"])
    assert result.outcome is Outcome.EXITED
    assert not alive(int(out.split()[0]))


def test_the_input_descriptor_is_inherited_and_others_are_not(
    plain: SandboxRunner, tmp_path: Path
) -> None:
    source = tmp_path / "input.bin"
    source.write_bytes(b"input-bytes")
    leaked = os.open(source, os.O_RDONLY)
    os.set_inheritable(leaked, True)  # would survive exec if close_fds were disabled
    wanted = os.open(source, os.O_RDONLY | os.O_CLOEXEC)
    try:
        script = f"cat <&{wanted}"
        result, out = run(plain, ["sh", "-c", script], input_fd=wanted)
        assert out == b"input-bytes" and result.returncode == 0
        if Path("/proc/self/fd").exists():
            _, fds = run(plain, ["sh", "-c", "ls /proc/$$/fd"], input_fd=wanted)
            assert {int(x) for x in fds.split()} == {0, 1, 2, wanted}  # `leaked` is closed
        else:
            result, out = run(plain, ["sh", "-c", f"cat <&{leaked}"], input_fd=wanted)
            assert out == b""  # leaked descriptor is closed in the child
    finally:
        os.close(leaked)
        os.close(wanted)


def test_inherited_descriptors_are_closed_when_no_input_descriptor_is_passed(
    plain: SandboxRunner, tmp_path: Path
) -> None:
    source = tmp_path / "input.bin"
    source.write_bytes(b"input-bytes")
    leaked = os.open(source, os.O_RDONLY)
    os.set_inheritable(leaked, True)  # would survive exec if close_fds were disabled
    try:
        result, out = run(plain, ["sh", "-c", f"cat <&{leaked}"])
        assert out == b"" and result.returncode != 0
    finally:
        os.close(leaked)


def test_required_landlock_without_support_refuses_to_start_children(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(runner_module, "probe_abi", lambda: None)
    required = SandboxRunner("required")
    marker = tmp_path / "ran"
    with pytest.raises(SandboxError):
        run(required, ["touch", str(marker)])
    assert not marker.exists()
    assert required.landlock_supported is False and required.landlock_enforced is False


def test_auto_landlock_without_support_runs_unconfined_and_reports_it(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(runner_module, "probe_abi", lambda: None)
    auto = SandboxRunner("auto")
    result, out = run(auto, ["echo", "hi"])
    assert result.returncode == 0 and out == b"hi\n"
    assert (auto.landlock_supported, auto.landlock_abi) == (False, None)
    assert auto.verify_enforcement() is False and auto.landlock_enforced is False


@pytest.mark.container
def test_child_environ_in_proc_contains_only_path_and_lc_all(
    plain: SandboxRunner, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("AUDIO_SERVICE_TOKEN", "must-not-leak-" + "x" * 32)
    result, out = run(plain, ["cat", "/proc/self/environ"])
    assert result.returncode == 0
    assert sorted(x for x in out.decode().split("\0") if x) == ["LC_ALL=C", "PATH=/usr/bin:/bin"]


@pytest.mark.container
def test_service_process_is_not_root_and_has_no_capabilities() -> None:
    assert os.getuid() == 10001
    status = Path("/proc/self/status").read_text()
    caps = {
        line.split()[0].rstrip(":"): line.split()[1]
        for line in status.splitlines()
        if line.startswith("Cap")
    }
    assert caps["CapEff"] == caps["CapPrm"] == caps["CapBnd"] == "0000000000000000"
    assert "NoNewPrivs:\t1" in status
    assert Path("/proc/self/mountinfo").read_text().count(" / / ro,") == 1  # read-only rootfs
