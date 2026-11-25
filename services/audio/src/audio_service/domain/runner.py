"""Sandboxed subprocess runner for ffprobe/ffmpeg children (plan §6.2).

Controls, each covered by a test:
- argv list only, never a shell; executables resolved against the fixed PATH;
- environment exactly `{PATH=/usr/bin:/bin, LC_ALL=C}` (the service token never reaches a child);
- `close_fds=True`: the child keeps fds 0-2 and the one input descriptor (passed with `pass_fds`;
  CPython keeps its number, so the argv helper is given that number rather than a fixed 3);
- stdin is /dev/null; own session and process group (`start_new_session`);
- wall-clock timeout and cooperative cancellation: SIGTERM to the group, SIGKILL after 2 s, reap,
  verify no survivor remains (zombies adopted by init are not survivors);
- rlimits in the child: CPU (from the timeout, times the caller's declared thread count), FSIZE=0,
  NOFILE=64, CORE=0;
- Landlock (when supported and not `off`): read/exec only beneath /usr, /lib, /etc; no TCP
  (ABI >= 4); no signals to, and no abstract UNIX sockets of, processes outside the domain, the
  parent included (ABI >= 6). In mode `required` no child is started until the startup self-test
  `verify_enforcement()` has observed every control the kernel offers actually denying;
- profiles: an instance may add read/execute paths and fixed environment entries (the inference
  profile, ADR-0036 / ADR-0037, adds the virtual environment, the read-only models directory and
  thread pins). Every other control is identical, and each instance runs its own self-test;
- stdout is streamed to the caller (optional byte cap); stderr is kept in a 64 KiB buffer for the
  caller to classify and is never logged by this module. `stderr_signal` is called (with no data)
  whenever stderr produced output, so a caller can record roughly where in the stream it happened.

Pre-exec safety: `preexec_fn` runs in the forked child of a multi-threaded process, where only the
forking thread exists. If another thread held a lock (allocator, import lock) at fork time, code
that needs it would deadlock. The function therefore does nothing but call `resource.setrlimit`
and pre-bound ctypes callables with integer arguments: no imports, logging or I/O beyond the
syscalls themselves. Calls are made from the executor's worker threads; the residual risk is the
documented CPython limitation, accepted for a bounded, tested child step.
"""

from __future__ import annotations

import math
import os
import resource
import secrets
import selectors
import shutil
import signal
import socket
import subprocess  # noqa: S404 - this module is the audited subprocess boundary
import sys
import tempfile
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path
from typing import Literal, Protocol

from audio_service.domain.landlock import (
    DEFAULT_READ_EXEC_PATHS,
    Ruleset,
    build_ruleset,
    probe_abi,
)

SAFE_ENV = {"PATH": "/usr/bin:/bin", "LC_ALL": "C"}
STDERR_CAP_BYTES = 64 * 1024
KILL_GRACE_SECONDS = 2.0
NOFILE_LIMIT = 64
_POLL_SECONDS = 0.05
_READ_CHUNK = 64 * 1024

LandlockMode = Literal["auto", "required", "off"]


class SandboxError(Exception):
    """The sandbox could not be set up or torn down safely. Carries no paths or output."""


class Outcome(StrEnum):
    EXITED = "exited"
    TIMEOUT = "timeout"
    CANCELLED = "cancelled"
    OUTPUT_LIMIT = "output_limit"


class Cancellable(Protocol):
    @property
    def cancelled(self) -> bool: ...


@dataclass(frozen=True)
class RunResult:
    outcome: Outcome
    returncode: int | None
    stderr: bytes  # at most STDERR_CAP_BYTES; classify, then discard
    stdout_bytes: int


def _exited(proc: subprocess.Popen[bytes]) -> bool:
    """True once the leader has exited, without reaping it (keeps the pgid reserved)."""
    waitid = getattr(os, "waitid", None)
    if waitid is None:  # macOS development hosts: reaping early is acceptable there
        return proc.poll() is not None
    try:
        return waitid(os.P_PID, proc.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT) is not None
    except ChildProcessError:
        return True


def _group_alive(pgid: int) -> bool:
    try:
        os.killpg(pgid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    if not Path("/proc/self").exists():
        return True
    for name in os.listdir("/proc"):
        if not name.isdigit():
            continue
        try:
            stat = Path(f"/proc/{name}/stat").read_text()
        except OSError:
            continue
        fields = stat[stat.rindex(")") + 2 :].split()
        if int(fields[2]) == pgid and fields[0] != "Z":  # zombies are dead, just not reaped
            return True
    return False


def _terminate_group(proc: subprocess.Popen[bytes]) -> None:
    pgid = proc.pid  # start_new_session makes the child a group leader
    for sig in (signal.SIGTERM, signal.SIGKILL):
        try:
            os.killpg(pgid, sig)
        except ProcessLookupError:
            pass
        deadline = time.monotonic() + KILL_GRACE_SECONDS
        while time.monotonic() < deadline:
            if proc.poll() is not None and not _group_alive(pgid):
                return
            time.sleep(0.02)
    proc.poll()
    if _group_alive(pgid):
        raise SandboxError("child process group survived SIGKILL")


class SandboxRunner:
    def __init__(
        self,
        landlock_mode: LandlockMode = "auto",
        *,
        read_exec_paths: tuple[str, ...] = DEFAULT_READ_EXEC_PATHS,
        extra_env: Mapping[str, str] | None = None,
    ) -> None:
        self._mode = landlock_mode
        # Literal, caller-chosen entries only; PATH and LC_ALL cannot be overridden.
        self._env = {**(extra_env or {}), **SAFE_ENV}
        self._abi: int | None = None if landlock_mode == "off" else probe_abi()
        self._ruleset: Ruleset | None = None
        self._enforced: bool | None = None
        self._scoped = False
        if self._abi is not None:
            self._ruleset = build_ruleset(self._abi, read_exec_paths)

    @property
    def landlock_supported(self) -> bool:
        return self._abi is not None

    @property
    def landlock_abi(self) -> int | None:
        return self._abi

    @property
    def landlock_enforced(self) -> bool:
        """True only if `verify_enforcement` observed a confined child."""
        return bool(self._enforced)

    @property
    def landlock_scoped(self) -> bool:
        """True only if `verify_enforcement` saw a confined child denied signals to the parent and
        abstract UNIX sockets (Landlock ABI >= 6)."""
        return self._scoped

    def close(self) -> None:
        if self._ruleset is not None:
            self._ruleset.close()
            self._ruleset = None

    def _preexec(self, timeout_s: float, cpu_threads: int = 1) -> Callable[[], None]:
        cpu = math.ceil(timeout_s * max(1, cpu_threads)) + 1
        limits = (
            (resource.RLIMIT_CPU, cpu),
            (resource.RLIMIT_FSIZE, 0),
            (resource.RLIMIT_NOFILE, NOFILE_LIMIT),
            (resource.RLIMIT_CORE, 0),
        )
        setrlimit = resource.setrlimit
        ruleset = self._ruleset

        def child_setup() -> None:
            for which, value in limits:
                setrlimit(which, (value, value))
            if ruleset is not None:
                ruleset.restrict_self()

        return child_setup

    def run(  # noqa: PLR0913
        self,
        argv: list[str],
        *,
        stdout_sink: Callable[[bytes], None],
        timeout_s: float,
        input_fd: int | None = None,
        max_stdout_bytes: int | None = None,
        cancel: Cancellable | None = None,
        stderr_signal: Callable[[], None] | None = None,
        cpu_threads: int = 1,
    ) -> RunResult:
        if self._mode == "required" and not self._enforced:
            # `required` means enforced, not merely requested: no child runs unconfined, and none
            # runs before the self-test observed the confinement actually denying.
            raise SandboxError("landlock is required but not verified as enforced")
        return self._run(
            argv,
            stdout_sink=stdout_sink,
            timeout_s=timeout_s,
            input_fd=input_fd,
            max_stdout_bytes=max_stdout_bytes,
            cancel=cancel,
            stderr_signal=stderr_signal,
            cpu_threads=cpu_threads,
        )

    def _run(  # noqa: PLR0912, PLR0913, PLR0915
        self,
        argv: list[str],
        *,
        stdout_sink: Callable[[bytes], None],
        timeout_s: float,
        input_fd: int | None = None,
        max_stdout_bytes: int | None = None,
        cancel: Cancellable | None = None,
        stderr_signal: Callable[[], None] | None = None,
        cpu_threads: int = 1,
    ) -> RunResult:
        if self._mode == "required" and self._ruleset is None:
            raise SandboxError("landlock is required but unavailable")  # children refuse to start
        exe = argv[0] if os.path.isabs(argv[0]) else shutil.which(argv[0], path=SAFE_ENV["PATH"])
        if exe is None:
            raise SandboxError("executable not found")
        try:
            proc = subprocess.Popen(  # noqa: S603 - argv list, no shell, fixed environment
                [exe, *argv[1:]],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                env=dict(self._env),
                cwd="/",
                close_fds=True,
                pass_fds=() if input_fd is None else (input_fd,),
                start_new_session=True,
                preexec_fn=self._preexec(timeout_s, cpu_threads),  # noqa: PLW1509 - see module docstring
            )
        except (OSError, subprocess.SubprocessError):
            raise SandboxError("child could not be started") from None

        assert proc.stdout is not None and proc.stderr is not None  # noqa: S101
        stderr = bytearray()
        total = 0
        outcome: Outcome | None = None
        deadline = time.monotonic() + timeout_s
        selector = selectors.DefaultSelector()
        selector.register(proc.stdout, selectors.EVENT_READ, "out")
        selector.register(proc.stderr, selectors.EVENT_READ, "err")
        try:
            while outcome is None:
                if cancel is not None and cancel.cancelled:
                    outcome = Outcome.CANCELLED
                elif time.monotonic() >= deadline:
                    outcome = Outcome.TIMEOUT
                elif selector.get_map():
                    for key, _ in selector.select(_POLL_SECONDS):
                        data = os.read(key.fd, _READ_CHUNK)
                        if not data:
                            selector.unregister(key.fileobj)
                        elif key.data == "err":
                            if stderr_signal is not None:
                                stderr_signal()  # content-free: lets the caller note *when*
                            stderr += data[: max(0, STDERR_CAP_BYTES - len(stderr))]
                        else:
                            total += len(data)
                            if max_stdout_bytes is not None and total > max_stdout_bytes:
                                outcome = Outcome.OUTPUT_LIMIT
                                break
                            stdout_sink(data)
                elif _exited(proc):
                    outcome = Outcome.EXITED
                else:
                    time.sleep(0.02)
        finally:
            selector.close()
            try:
                # Always stop the whole group: leaves no stragglers after a normal exit either.
                _terminate_group(proc)
            finally:
                proc.stdout.close()
                proc.stderr.close()
                proc.wait()
        return RunResult(outcome, proc.returncode, bytes(stderr), total)

    def verify_enforcement(self) -> bool:
        """Startup self-test: run confined children and record what the kernel actually denied.

        `enforced` is True only if every control this kernel offers was observed denying: reading a
        canary outside the allowed paths (all ABIs), a TCP connect to a listening local port
        (ABI >= 4), and, on ABI >= 6, a signal to the parent and a connect to a parent-owned
        abstract UNIX socket (`scoped`). A control that cannot be checked counts as not enforced.
        """
        self._enforced = self._scoped = False
        if self._ruleset is None:
            return False
        abi = self._abi or 0
        ok = self._canary_denied()
        python = _selftest_python() if abi >= 4 else None
        if abi >= 4:
            ok = ok and python is not None and self._tcp_denied(python)
        if abi >= 6:
            scoped = (
                python is not None and self._signal_denied(python) and self._socket_denied(python)
            )
            self._scoped = scoped
            ok = ok and scoped
        self._enforced = ok
        return ok

    def _canary_denied(self) -> bool:
        with tempfile.TemporaryDirectory() as directory:
            canary = Path(directory) / "canary"
            canary.write_text("landlock-canary")
            leaked = bytearray()
            result = self._run(["cat", str(canary)], stdout_sink=leaked.extend, timeout_s=5)
        # Confined: cat fails to open the canary. Output or success is not enforcement.
        return (
            result.outcome is Outcome.EXITED and result.returncode not in (0, None) and not leaked
        )

    def _denied_by_child(self, python: str, program: str, *args: str) -> bool:
        """True if the confined child reported a permission denial (and nothing else)."""
        out = bytearray()
        result = self._run(
            [python, "-I", "-S", "-c", program, *args], stdout_sink=out.extend, timeout_s=10
        )
        return (
            result.outcome is Outcome.EXITED and result.returncode == 0 and out.strip() == b"DENIED"
        )

    def _tcp_denied(self, python: str) -> bool:
        with socket.socket() as server:
            server.bind(("127.0.0.1", 0))
            server.listen(1)  # connects complete in the kernel backlog: no accept() needed
            return self._denied_by_child(python, _CONNECT_TCP, str(server.getsockname()[1]))

    def _signal_denied(self, python: str) -> bool:
        return self._denied_by_child(python, _SIGNAL_PARENT)

    def _socket_denied(self, python: str) -> bool:
        token = secrets.token_hex(8)  # abstract names are bytes starting with NUL; argv has no NUL
        with socket.socket(socket.AF_UNIX) as server:
            server.bind(b"\0vip-audio-selftest-" + token.encode())
            server.listen(1)
            return self._denied_by_child(python, _CONNECT_ABSTRACT, token)


def _selftest_python() -> str | None:
    """The base interpreter, if Landlock lets a child execute it (it must lie below an allowed
    read/execute path). The virtual environment is not readable by children."""
    base = os.path.realpath(getattr(sys, "_base_executable", sys.executable))
    allowed = tuple(p.rstrip("/") + "/" for p in DEFAULT_READ_EXEC_PATHS)
    return base if base.startswith(allowed) else None


# Self-test programs (`python -I -S -c`): print DENIED only for a permission error, so a refused
# connection, a missing socket or any other failure is never mistaken for enforcement.
_CONNECT_TCP = (
    "import socket,sys\n"
    "try:\n"
    " socket.create_connection(('127.0.0.1', int(sys.argv[1])), 3)\n"
    " print('CONNECTED')\n"
    "except PermissionError:\n"
    " print('DENIED')\n"
    "except OSError:\n"
    " print('OTHER')\n"
)
_SIGNAL_PARENT = (
    "import os,signal\n"
    "try:\n"
    " os.kill(os.getppid(), signal.SIGURG)\n"  # SIGURG is ignored by default: harmless if sent
    " print('SENT')\n"
    "except PermissionError:\n"
    " print('DENIED')\n"
    "except OSError:\n"
    " print('OTHER')\n"
)
_CONNECT_ABSTRACT = (
    "import socket,sys\n"
    "s=socket.socket(socket.AF_UNIX)\n"
    "try:\n"
    " s.connect(b'\\0vip-audio-selftest-' + sys.argv[1].encode())\n"
    " print('CONNECTED')\n"
    "except PermissionError:\n"
    " print('DENIED')\n"
    "except OSError:\n"
    " print('OTHER')\n"
)
