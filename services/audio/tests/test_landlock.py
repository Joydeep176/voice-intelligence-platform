"""Landlock confinement of children, measured inside the audio image (plan §6.2, proposed).

The kernel and Docker's seccomp profile decide whether Landlock is available; tests report the
actual ABI and skip (with the reason) rather than assume it.
"""

from __future__ import annotations

import socket
import threading
import uuid
from collections.abc import Iterator
from pathlib import Path

import pytest

from audio_service.domain.landlock import probe_abi
from audio_service.domain.runner import Outcome, SandboxRunner

pytestmark = pytest.mark.container

PYTHON = "/usr/local/bin/python3"  # the base image interpreter lives under /usr, outside the venv


def run(runner: SandboxRunner, argv: list[str]) -> tuple[int | None, bytes, bytes]:
    out = bytearray()
    result = runner.run(argv, stdout_sink=out.extend, timeout_s=10)
    assert result.outcome is Outcome.EXITED
    return result.returncode, bytes(out), result.stderr


@pytest.fixture(scope="module")
def abi() -> int:
    found = probe_abi()
    print(f"LANDLOCK_ABI={found}")  # noqa: T201 - recorded in VERIFICATION_WS1.md
    if found is None:
        pytest.skip("Landlock is not available here (kernel or seccomp); no isolation is claimed")
    return found


def verified_required() -> SandboxRunner:
    """`required` starts no child before the self-test has observed enforcement."""
    runner = SandboxRunner("required")
    assert runner.verify_enforcement() is True
    return runner


@pytest.fixture
def canary(tmp_path: Path) -> Iterator[Path]:
    path = tmp_path / f"canary-{uuid.uuid4()}"
    path.write_text("landlock-canary")
    yield path


def test_a_confined_child_cannot_read_files_outside_the_allowed_paths(
    abi: int, canary: Path
) -> None:
    confined = verified_required()
    unconfined = SandboxRunner("off")
    try:
        # Control: the same read works without Landlock, so the denial below is Landlock's.
        code, out, _ = run(unconfined, ["cat", str(canary)])
        assert (code, out) == (0, b"landlock-canary")
        code, out, _ = run(confined, ["cat", str(canary)])
        assert code != 0 and out == b""
        # Positive control: allowed paths still work under confinement.
        code, out, _ = run(confined, ["cat", "/etc/hostname"])
        assert code == 0 and out
    finally:
        confined.close()
        unconfined.close()


@pytest.mark.parametrize("path", ["/app/pyproject.toml", "/storage", "/proc/1/status", "/tmp"])
def test_application_storage_and_proc_are_not_readable_by_children(abi: int, path: str) -> None:
    if not Path(path).exists():
        pytest.skip(f"{path} does not exist in this container")
    confined = verified_required()
    try:
        code, out, _ = run(confined, ["ls", path] if Path(path).is_dir() else ["cat", path])
        assert code != 0 and out == b""
    finally:
        confined.close()


def test_a_confined_child_cannot_connect_over_tcp(abi: int) -> None:
    if abi < 4:
        pytest.skip(f"Landlock ABI {abi} < 4: TCP restriction unavailable (residual risk applies)")
    server = socket.socket()
    server.bind(("127.0.0.1", 0))
    server.listen(4)
    port = server.getsockname()[1]
    accepted: list[int] = []

    def accept() -> None:
        while True:
            try:
                conn, _ = server.accept()
            except OSError:
                return
            accepted.append(1)
            conn.close()

    threading.Thread(target=accept, daemon=True).start()
    program = f"import socket; socket.create_connection(('127.0.0.1', {port}), 3)"
    argv = [PYTHON, "-I", "-S", "-c", program]
    confined = verified_required()
    unconfined = SandboxRunner("off")
    try:
        code, _, _ = run(unconfined, argv)  # control: the connection succeeds without Landlock
        assert code == 0 and len(accepted) == 1
        code, _, _ = run(confined, argv)
        assert code != 0 and len(accepted) == 1
    finally:
        server.close()
        confined.close()
        unconfined.close()


def test_startup_self_check_reports_enforcement(abi: int) -> None:
    runner = SandboxRunner("auto")
    try:
        assert runner.landlock_abi == abi
        assert runner.verify_enforcement() is True
        assert runner.landlock_enforced is True
    finally:
        runner.close()


# -- review remediation: `required` means enforced; scoping; the parent is not dumpable ------------

PROC_ENVIRON = "AUDIO_SERVICE_TEST_CONTAINER=1"  # set by the test image: part of pytest's environ


def test_required_refuses_to_start_children_before_the_self_test_ran() -> None:
    from audio_service.domain.runner import SandboxError

    runner = SandboxRunner("required")
    try:
        with pytest.raises(SandboxError):
            runner.run(["true"], stdout_sink=lambda _d: None, timeout_s=5)
    finally:
        runner.close()


def test_the_self_test_enforces_what_this_kernel_offers_and_reports_scoping(abi: int) -> None:
    runner = SandboxRunner("required")
    try:
        assert runner.verify_enforcement() is True
        print(f"LANDLOCK_ABI={abi} SCOPED={runner.landlock_scoped}")  # noqa: T201
        assert runner.landlock_scoped is (abi >= 6)
        code, out, _ = run(runner, ["echo", "ok"])  # children run once verified
        assert (code, out) == (0, b"ok\n")
    finally:
        runner.close()


SIGNAL_PARENT = (
    "import os,signal\n"
    "try:\n os.kill(os.getppid(), signal.SIGURG); print('SENT')\n"
    "except PermissionError:\n print('DENIED')\n"
)
ABSTRACT_CONNECT = (
    "import socket,sys\n"
    "s=socket.socket(socket.AF_UNIX)\n"
    "try:\n s.connect(b'\\0vip-test-' + sys.argv[1].encode()); print('CONNECTED')\n"
    "except PermissionError:\n print('DENIED')\n"
    "except OSError:\n print('OTHER')\n"
)


def test_a_confined_child_cannot_signal_the_parent(abi: int) -> None:
    if abi < 6:
        pytest.skip(f"Landlock ABI {abi} < 6: signal scoping unavailable (residual risk applies)")
    confined, unconfined = verified_required(), SandboxRunner("off")
    try:
        argv = [PYTHON, "-I", "-S", "-c", SIGNAL_PARENT]
        assert run(unconfined, argv)[1].strip() == b"SENT"  # control: allowed without scoping
        assert run(confined, argv)[1].strip() == b"DENIED"
    finally:
        confined.close()
        unconfined.close()


def test_a_confined_child_cannot_reach_a_parent_abstract_unix_socket(abi: int) -> None:
    if abi < 6:
        pytest.skip(f"Landlock ABI {abi} < 6: abstract socket scoping unavailable")
    name = uuid.uuid4().hex  # the abstract address is b"\0vip-test-" + name
    confined, unconfined = verified_required(), SandboxRunner("off")
    with socket.socket(socket.AF_UNIX) as server:
        server.bind(b"\0vip-test-" + name.encode())
        server.listen(2)
        try:
            argv = [PYTHON, "-I", "-S", "-c", ABSTRACT_CONNECT, name]
            assert run(unconfined, argv)[1].strip() == b"CONNECTED"  # control
            assert run(confined, argv)[1].strip() == b"DENIED"
        finally:
            confined.close()
            unconfined.close()


def test_a_child_cannot_read_the_parents_environ_once_dumping_is_disabled() -> None:
    """The service token lives in the parent's environment. An unconfined child (the worst case: it
    escaped Landlock) must not read it: PR_SET_DUMPABLE=0 makes /proc/<ppid>/environ root-owned."""
    import ctypes

    from audio_service.domain.landlock import disable_dumping

    unconfined = SandboxRunner("off")
    argv = ["sh", "-c", "cat /proc/$PPID/environ"]
    libc = ctypes.CDLL(None, use_errno=True)
    try:
        libc.prctl(4, 1, 0, 0, 0)  # other tests start the app, which already disabled dumping
        code, out, _ = run(unconfined, argv)  # control: readable by default
        assert code == 0 and PROC_ENVIRON.encode() in out
        assert disable_dumping() is True
        code, out, _ = run(unconfined, argv)
        assert code != 0 and PROC_ENVIRON.encode() not in out and out == b""
    finally:
        libc.prctl(4, 1, 0, 0, 0)  # PR_SET_DUMPABLE back to 1 for the rest of the test session
        unconfined.close()
