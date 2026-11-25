"""Small helpers shared by every module that runs FFmpeg/ffprobe on an inherited descriptor."""

from __future__ import annotations

import os
import signal

from audio_service.contracts import ErrorCode
from audio_service.domain.errors import TaskCancelled, TaskFailure
from audio_service.domain.runner import Outcome, RunResult


def rewind(fd: int) -> None:
    """Children share the descriptor's offset; every invocation starts from byte 0."""
    os.lseek(fd, 0, os.SEEK_SET)


def signal_failure_code(outcome: Outcome, returncode: int | None) -> ErrorCode | None:
    """The failure code for a child terminated by a signal the runner did not send, else None.

    The runner only signals after it has decided an outcome (timeout, cancellation, output limit),
    so a negative return code with outcome EXITED came from outside: the cgroup OOM killer
    (SIGKILL), the CPU-time rlimit (SIGXCPU) or a crash (SIGSEGV, SIGABRT, ...). None of these is a
    property of the file in a way Node may persist, so none maps to CORRUPT_MEDIA:
    - SIGXCPU is the child exhausting the CPU budget derived from its wall-clock timeout, the same
      condition as that timeout: TIMEOUT (retryable);
    - everything else: RESOURCE_EXHAUSTED (retryable).
    """
    if outcome is not Outcome.EXITED or returncode is None or returncode >= 0:
        return None
    if -returncode == signal.SIGXCPU:
        return ErrorCode.TIMEOUT
    return ErrorCode.RESOURCE_EXHAUSTED


def raise_for_outcome(result: RunResult) -> None:
    """Map a non-normal outcome (or a signal-killed child) to its task failure; a normal exit
    (any exit status the child chose itself) returns."""
    if result.outcome is Outcome.CANCELLED:
        raise TaskCancelled
    if result.outcome is Outcome.TIMEOUT:
        raise TaskFailure(ErrorCode.TIMEOUT)
    if result.outcome is Outcome.OUTPUT_LIMIT:
        raise TaskFailure(ErrorCode.RESOURCE_LIMIT_EXCEEDED)
    code = signal_failure_code(result.outcome, result.returncode)
    if code is not None:
        raise TaskFailure(code)
