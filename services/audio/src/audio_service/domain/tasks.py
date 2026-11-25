"""In-memory task executor (LLD §3.1): bounded queue, bounded workers, idempotent submission.

Framework-independent. State is intentionally not persistent: Node owns the job lifecycle and
treats an unknown task id (after a restart) as lost and retryable. Handlers are registered by task
type; they are blocking functions run on worker threads and must check `ctx.check_cancelled()`
between units of work.
"""

from __future__ import annotations

import hashlib
import json
import logging
import threading
import time
from collections import deque
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import Any
from uuid import UUID, uuid4

from audio_service.contracts import (
    CONTRACT_VERSION,
    ErrorCode,
    TaskAccepted,
    TaskCreateRequest,
    TaskErrorInfo,
    TaskProgress,
    TaskStatus,
    TaskStatusResponse,
    TaskType,
)
from audio_service.domain.errors import RequestRejected, TaskCancelled, TaskFailure, is_retryable
from audio_service.domain.storage_keys import (
    TaskRefs,
    validate_original_key,
    validate_output_prefix,
)

log = logging.getLogger("audio_service.tasks")


class TaskDeadline:
    """Overall wall-clock budget of one task (ADR-0010), measured from the moment it starts running.

    Interim formula, OD-10 / D-2B-20 Open (not approved): the existing per-child formula
    `120 s + 0.5 x audio duration` applied to the whole task, expressed as integers:
    `base_ms + duration_ms * per_audio_permille / 1000` (defaults 120000 and 500). Until the audio
    duration is known the ceiling duration is used; `tighten_for_duration` only ever shortens it.
    """

    def __init__(
        self,
        *,
        base_ms: int,
        per_audio_permille: int,
        max_duration_ms: int,
        clock: Callable[[], float] = time.monotonic,
        wall_clock: Callable[[], float] = time.time,
    ) -> None:
        self._base_ms = base_ms
        self._permille = per_audio_permille
        self._clock = clock
        self._wall = wall_clock
        self._start = clock()
        self._at = self._start + self._budget_s(max_duration_ms)

    def _budget_s(self, duration_ms: int) -> float:
        return (self._base_ms + duration_ms * self._permille / 1000) / 1000

    def tighten_for_duration(self, duration_ms: int) -> None:
        self._at = min(self._at, self._start + self._budget_s(max(0, duration_ms)))

    def set_inference_budget(self, duration_ms: int, per_audio_permille: int) -> None:
        """Model inference (transcribe, diarize) runs near or above real time on one CPU, so its
        budget is `base + duration x per_audio_permille / 1000` with its own factor (interim,
        OD-10), replacing the FFmpeg-oriented ceiling. Called once, before any inference starts."""
        self._at = (
            self._start + (self._base_ms + max(0, duration_ms) * per_audio_permille / 1000) / 1000
        )

    @property
    def expired(self) -> bool:
        return self._clock() >= self._at

    @property
    def remaining_s(self) -> float:
        return self._at - self._clock()

    @property
    def epoch_ms(self) -> int:
        """The deadline as epoch milliseconds (for Node's backstop)."""
        return round((self._wall() + (self._at - self._clock())) * 1000)


class CancellationToken:
    """Cooperative stop signal. `cancelled` is also true once the task's deadline has passed, so
    every place that already polls it (the runner kills the child's process group, the decoder
    unwinds) stops on a deadline exactly as on a cancellation. `requested` tells the two apart."""

    def __init__(self) -> None:
        self._event = threading.Event()
        self._deadline: TaskDeadline | None = None

    def cancel(self) -> None:
        self._event.set()

    def attach_deadline(self, deadline: TaskDeadline) -> None:
        self._deadline = deadline

    @property
    def requested(self) -> bool:
        """An explicit cancellation (caller or shutdown), not a deadline."""
        return self._event.is_set()

    @property
    def expired(self) -> bool:
        return self._deadline is not None and self._deadline.expired

    @property
    def cancelled(self) -> bool:
        return self._event.is_set() or self.expired

    def check(self) -> None:
        if self.cancelled:
            raise TaskCancelled


@dataclass
class TaskContext:
    task_id: UUID
    request: TaskCreateRequest
    refs: TaskRefs
    cancel: CancellationToken
    _report: Callable[[TaskProgress], None]
    deadline: TaskDeadline | None = None

    def check_cancelled(self) -> None:
        self.cancel.check()

    def set_audio_duration_ms(self, duration_ms: int) -> None:
        """Shorten the task deadline to the formula for this (now known) audio duration."""
        if self.deadline is not None:
            self.deadline.tighten_for_duration(duration_ms)

    def set_inference_budget(self, duration_ms: int, per_audio_permille: int) -> None:
        if self.deadline is not None:
            self.deadline.set_inference_budget(duration_ms, per_audio_permille)

    def report_progress(self, stage: str, fraction: float, processed_ms: int) -> None:
        self._report(
            TaskProgress(
                stage=stage, fraction=min(1.0, max(0.0, fraction)), processedMs=processed_ms
            )
        )


Handler = Callable[[TaskContext], dict[str, Any]]


@dataclass
class _Task:
    id: UUID
    request: TaskCreateRequest
    fingerprint: str
    cancel: CancellationToken = field(default_factory=CancellationToken)
    status: TaskStatus = "queued"
    progress: TaskProgress | None = None
    result: dict[str, Any] | None = None
    error: TaskErrorInfo | None = None
    finished_at: float | None = None
    deadline: TaskDeadline | None = None


# Interim development defaults for the overall task deadline: the existing per-child formula
# `120 s + 0.5 x audio duration` (OD-10 / D-2B-20 Open, not approved), as integers.
DEADLINE_BASE_MS = 120_000
DEADLINE_PER_AUDIO_PERMILLE = 500

_FINAL: frozenset[TaskStatus] = frozenset({"succeeded", "failed", "cancelled"})


class TaskExecutor:
    def __init__(  # noqa: PLR0913
        self,
        handlers: Mapping[TaskType, Handler],
        *,
        max_concurrent: int = 1,
        max_queued: int = 4,
        retention_max: int = 256,
        retention_ttl_seconds: float = 3600,
        clock: Callable[[], float] = time.monotonic,
        deadline_base_ms: int = DEADLINE_BASE_MS,
        deadline_per_audio_permille: int = DEADLINE_PER_AUDIO_PERMILLE,
        deadline_max_duration_ms: int = 14_400_000,
        deadline_clock: Callable[[], float] = time.monotonic,
        deadline_wall_clock: Callable[[], float] = time.time,
    ) -> None:
        self._handlers = dict(handlers)
        self._max_concurrent = max_concurrent
        self._max_queued = max_queued
        self._retention_max = retention_max
        self._retention_ttl = retention_ttl_seconds
        self._clock = clock
        self._deadline_args = {
            "base_ms": deadline_base_ms,
            "per_audio_permille": deadline_per_audio_permille,
            "max_duration_ms": deadline_max_duration_ms,
            "clock": deadline_clock,
            "wall_clock": deadline_wall_clock,
        }
        self._cond = threading.Condition()
        self._tasks: dict[UUID, _Task] = {}
        self._by_key: dict[str, UUID] = {}
        self._queue: deque[UUID] = deque()
        self._finished: deque[UUID] = deque()
        self._running = 0
        self._stopping = False
        self._threads: list[threading.Thread] = []

    @property
    def task_types(self) -> list[TaskType]:
        return sorted(self._handlers)

    # -- lifecycle -----------------------------------------------------------------------------

    def start(self) -> None:
        for index in range(self._max_concurrent):
            thread = threading.Thread(target=self._worker, name=f"audio-task-{index}", daemon=True)
            thread.start()
            self._threads.append(thread)

    def shutdown(self, timeout: float = 5.0) -> None:
        with self._cond:
            self._stopping = True
            for task in self._tasks.values():
                task.cancel.cancel()
            self._cond.notify_all()
        for thread in self._threads:
            thread.join(timeout)

    # -- submission ----------------------------------------------------------------------------

    def submit(self, request: TaskCreateRequest) -> TaskAccepted:
        if request.contractVersion != CONTRACT_VERSION:
            raise RequestRejected(ErrorCode.CONTRACT_VERSION_MISMATCH)
        if request.type not in self._handlers:
            raise RequestRejected(ErrorCode.UNSUPPORTED_TASK_TYPE)
        refs = TaskRefs(request.workspaceId, request.recordingId)
        validate_original_key(request.input.originalKey, refs)
        validate_output_prefix(request.input.outputPrefix, refs)
        fingerprint = hashlib.sha256(
            json.dumps(request.model_dump(mode="json"), sort_keys=True).encode()
        ).hexdigest()

        with self._cond:
            self._evict_locked()
            existing_id = self._by_key.get(request.idempotencyKey)
            if existing_id is not None:
                existing = self._tasks[existing_id]
                if existing.fingerprint != fingerprint:
                    raise RequestRejected(ErrorCode.IDEMPOTENCY_CONFLICT)
                return TaskAccepted(taskId=existing.id, status=existing.status)
            if self._stopping or (
                len(self._queue) + self._running >= self._max_concurrent + self._max_queued
            ):
                raise RequestRejected(ErrorCode.CAPACITY_EXCEEDED)
            task = _Task(id=uuid4(), request=request, fingerprint=fingerprint)
            self._tasks[task.id] = task
            self._by_key[request.idempotencyKey] = task.id
            self._queue.append(task.id)
            self._cond.notify()
            log.info("task_queued", extra={"taskId": str(task.id), "taskType": request.type})
            return TaskAccepted(taskId=task.id, status="queued")

    # -- queries and cancellation --------------------------------------------------------------

    def get(self, task_id: UUID) -> TaskStatusResponse:
        with self._cond:
            self._evict_locked()
            return self._snapshot(self._require(task_id))

    def cancel(self, task_id: UUID) -> TaskStatusResponse:
        """Cooperative: queued tasks end immediately, running tasks at their next check."""
        with self._cond:
            task = self._require(task_id)
            if task.status == "queued":
                self._queue.remove(task_id)
                self._finish_locked(task, "cancelled", error=ErrorCode.CANCELLED)
            elif task.status == "running":
                task.cancel.cancel()
            return self._snapshot(task)

    # -- internals -----------------------------------------------------------------------------

    def _require(self, task_id: UUID) -> _Task:
        task = self._tasks.get(task_id)
        if task is None:
            raise RequestRejected(ErrorCode.TASK_NOT_FOUND)
        return task

    def _snapshot(self, task: _Task) -> TaskStatusResponse:
        return TaskStatusResponse(
            taskId=task.id,
            type=task.request.type,
            status=task.status,
            progress=task.progress if task.status != "queued" else None,
            result=task.result,
            error=task.error,
            deadlineAt=None if task.deadline is None else task.deadline.epoch_ms,
        )

    def _finish_locked(
        self,
        task: _Task,
        status: TaskStatus,
        *,
        result: dict[str, Any] | None = None,
        error: ErrorCode | None = None,
    ) -> None:
        task.status = status
        task.result = result
        task.error = (
            None if error is None else TaskErrorInfo(code=error, retryable=is_retryable(error))
        )
        if status == "cancelled":  # cancellation is a caller decision, never retried
            task.error = TaskErrorInfo(code=ErrorCode.CANCELLED, retryable=False)
        task.finished_at = self._clock()
        self._finished.append(task.id)
        log.info(
            "task_finished",
            extra={
                "taskId": str(task.id),
                "taskType": task.request.type,
                "status": status,
                "errorCode": None if task.error is None else task.error.code.value,
            },
        )

    def _evict_locked(self) -> None:
        now = self._clock()
        while self._finished:
            oldest = self._tasks[self._finished[0]]
            expired = (
                oldest.finished_at is not None and now - oldest.finished_at >= self._retention_ttl
            )
            if not expired and len(self._finished) <= self._retention_max:
                break
            self._finished.popleft()
            del self._tasks[oldest.id]
            self._by_key.pop(oldest.request.idempotencyKey, None)

    def _report(self, task: _Task, progress: TaskProgress) -> None:
        with self._cond:
            if task.status == "running":
                task.progress = progress

    def _worker(self) -> None:
        while True:
            with self._cond:
                while not self._queue and not self._stopping:
                    self._cond.wait()
                if self._stopping:
                    return
                task = self._tasks[self._queue.popleft()]
                task.status = "running"
                self._running += 1
            self._run(task)
            with self._cond:
                self._running -= 1

    def _run(self, task: _Task) -> None:
        request = task.request
        deadline = TaskDeadline(**self._deadline_args)  # type: ignore[arg-type]
        with self._cond:
            task.deadline = deadline
        task.cancel.attach_deadline(deadline)
        ctx = TaskContext(
            task_id=task.id,
            request=request,
            refs=TaskRefs(request.workspaceId, request.recordingId),
            cancel=task.cancel,
            _report=lambda progress: self._report(task, progress),
            deadline=deadline,
        )
        status: TaskStatus = "succeeded"
        result: dict[str, Any] | None = None
        error: ErrorCode | None = None
        try:
            result = self._handlers[request.type](ctx)
        except TaskCancelled:
            if task.cancel.requested or not task.cancel.expired:
                status, error = "cancelled", ErrorCode.CANCELLED
            else:  # the deadline stopped it (children already killed, temp already cleaned)
                status, error = "failed", ErrorCode.TIMEOUT
        except TaskFailure as failure:
            status, error = "failed", failure.code
        except Exception as exc:  # noqa: BLE001 - deliberate: nothing may leak or kill the worker
            # The exception type only; its message may contain paths or media data.
            log.error(
                "task_unexpected_error",
                extra={"taskId": str(task.id), "errorName": type(exc).__name__},
            )
            status, error = "failed", ErrorCode.INTERNAL_ERROR
        with self._cond:
            self._finish_locked(task, status, result=result, error=error)
