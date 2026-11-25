"""Deterministic failure model for tasks. Messages never carry paths, stderr or media metadata."""

from __future__ import annotations

from audio_service.contracts import ErrorCode

# Whether Node may retry the same task later. Everything not listed is a permanent failure.
_RETRYABLE = frozenset(
    {
        ErrorCode.TIMEOUT,
        ErrorCode.STORAGE_ERROR,
        ErrorCode.INTERNAL_ERROR,
        ErrorCode.CAPACITY_EXCEEDED,
        ErrorCode.RESOURCE_EXHAUSTED,  # a host condition (OOM kill, ...), not a file property
    }
)


def is_retryable(code: ErrorCode) -> bool:
    return code in _RETRYABLE


class TaskFailure(Exception):
    """A handler or helper failed in a way that maps to a stable error code."""

    def __init__(self, code: ErrorCode) -> None:
        self.code = code
        super().__init__(code.value)  # the code only: nothing else may be attached


class TaskCancelled(TaskFailure):
    def __init__(self) -> None:
        super().__init__(ErrorCode.CANCELLED)


class RequestRejected(TaskFailure):
    """A request refused on its merits: rejected at submission (HTTP 4xx) or, if raised while a
    task runs, a failed task with the same code."""
