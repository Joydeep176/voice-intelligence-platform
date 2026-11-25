"""Task executor: idempotency, capacity, cancellation, retention and error mapping."""

from __future__ import annotations

import logging
import threading
from collections.abc import Iterator
from typing import Any
from uuid import UUID, uuid4

import pytest
from helpers import OTHER_WS, REC, WS, task_request, wait_for

from audio_service.contracts import ErrorCode
from audio_service.domain.errors import RequestRejected, TaskFailure
from audio_service.domain.tasks import Handler, TaskContext, TaskExecutor


class Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


@pytest.fixture
def executors() -> Iterator[list[TaskExecutor]]:
    created: list[TaskExecutor] = []
    yield created
    for executor in created:
        executor.shutdown()


def make(executors: list[TaskExecutor], handler: Handler, **kwargs: Any) -> TaskExecutor:
    executor = TaskExecutor({"probe": handler}, **kwargs)
    executor.start()
    executors.append(executor)
    return executor


def status(executor: TaskExecutor, task_id: UUID) -> str:
    return executor.get(task_id).status


def test_same_key_and_body_returns_the_same_task_and_runs_once(
    executors: list[TaskExecutor],
) -> None:
    runs: list[UUID] = []

    def handler(ctx: TaskContext) -> dict[str, Any]:
        runs.append(ctx.task_id)
        return {}

    executor = make(executors, handler)
    first = executor.submit(task_request())
    second = executor.submit(task_request())
    wait_for(lambda: status(executor, first.taskId) == "succeeded")
    third = executor.submit(task_request())  # also after completion
    assert first.taskId == second.taskId == third.taskId
    assert runs == [first.taskId]


def test_same_key_with_different_body_conflicts(executors: list[TaskExecutor]) -> None:
    executor = make(executors, lambda ctx: {})
    executor.submit(task_request())
    with pytest.raises(RequestRejected) as info:
        executor.submit(task_request(config={"changed": True}))
    assert info.value.code is ErrorCode.IDEMPOTENCY_CONFLICT


def test_config_key_order_does_not_change_the_fingerprint(executors: list[TaskExecutor]) -> None:
    executor = make(executors, lambda ctx: {})
    a = executor.submit(task_request(config={"a": 1, "b": 2}))
    b = executor.submit(task_request(config={"b": 2, "a": 1}))
    assert a.taskId == b.taskId


def test_queue_is_bounded_and_frees_up(executors: list[TaskExecutor]) -> None:
    gate = threading.Event()
    executor = make(
        executors, lambda ctx: gate.wait(5) and {} or {}, max_concurrent=1, max_queued=1
    )
    running = executor.submit(task_request(idempotencyKey="idem-key-0001"))
    wait_for(lambda: status(executor, running.taskId) == "running")
    queued = executor.submit(task_request(idempotencyKey="idem-key-0002"))
    with pytest.raises(RequestRejected) as info:
        executor.submit(task_request(idempotencyKey="idem-key-0003"))
    assert info.value.code is ErrorCode.CAPACITY_EXCEEDED
    gate.set()
    wait_for(lambda: status(executor, queued.taskId) == "succeeded")
    executor.submit(task_request(idempotencyKey="idem-key-0004"))  # capacity is available again


def test_a_replayed_key_is_not_rejected_for_capacity(executors: list[TaskExecutor]) -> None:
    gate = threading.Event()
    executor = make(
        executors, lambda ctx: gate.wait(5) and {} or {}, max_concurrent=1, max_queued=0
    )
    first = executor.submit(task_request())
    assert executor.submit(task_request()).taskId == first.taskId
    gate.set()


def test_cancel_queued_task_never_runs(executors: list[TaskExecutor]) -> None:
    gate = threading.Event()
    ran: list[UUID] = []

    def handler(ctx: TaskContext) -> dict[str, Any]:
        ran.append(ctx.task_id)
        gate.wait(5)
        return {}

    executor = make(executors, handler, max_concurrent=1, max_queued=2)
    first = executor.submit(task_request(idempotencyKey="idem-key-0001"))
    wait_for(lambda: status(executor, first.taskId) == "running")
    queued = executor.submit(task_request(idempotencyKey="idem-key-0002"))
    snapshot = executor.cancel(queued.taskId)
    assert snapshot.status == "cancelled"
    assert snapshot.error is not None and snapshot.error.code is ErrorCode.CANCELLED
    gate.set()
    wait_for(lambda: status(executor, first.taskId) == "succeeded")
    assert ran == [first.taskId]


def test_cancel_running_task_is_cooperative(executors: list[TaskExecutor]) -> None:
    started = threading.Event()

    def handler(ctx: TaskContext) -> dict[str, Any]:
        started.set()
        while True:
            ctx.check_cancelled()
            threading.Event().wait(0.01)

    executor = make(executors, handler)
    task = executor.submit(task_request())
    assert started.wait(5)
    assert executor.cancel(task.taskId).status == "running"  # not yet observed by the handler
    wait_for(lambda: status(executor, task.taskId) == "cancelled")
    error = executor.get(task.taskId).error
    assert error is not None and (error.code, error.retryable) == (ErrorCode.CANCELLED, False)


def test_cancelling_a_finished_task_changes_nothing(executors: list[TaskExecutor]) -> None:
    executor = make(executors, lambda ctx: {"ok": 1})
    task = executor.submit(task_request())
    wait_for(lambda: status(executor, task.taskId) == "succeeded")
    assert executor.cancel(task.taskId).status == "succeeded"


def test_progress_is_reported_and_clamped(executors: list[TaskExecutor]) -> None:
    gate = threading.Event()

    def handler(ctx: TaskContext) -> dict[str, Any]:
        ctx.report_progress("decode", 7.0, 250)
        gate.wait(5)
        return {}

    executor = make(executors, handler)
    task = executor.submit(task_request())
    wait_for(lambda: executor.get(task.taskId).progress is not None)
    progress = executor.get(task.taskId).progress
    assert progress is not None and (progress.stage, progress.fraction, progress.processedMs) == (
        "decode",
        1.0,
        250,
    )
    gate.set()


@pytest.mark.parametrize(
    ("code", "retryable"),
    [
        (ErrorCode.CORRUPT_MEDIA, False),
        (ErrorCode.UNSUPPORTED_FORMAT, False),
        (ErrorCode.DURATION_LIMIT_EXCEEDED, False),
        (ErrorCode.TIMEOUT, True),
        (ErrorCode.STORAGE_ERROR, True),
    ],
)
def test_task_failures_map_to_code_and_retryability(
    executors: list[TaskExecutor], code: ErrorCode, retryable: bool
) -> None:
    def handler(ctx: TaskContext) -> dict[str, Any]:
        raise TaskFailure(code)

    executor = make(executors, handler)
    task = executor.submit(task_request())
    wait_for(lambda: status(executor, task.taskId) == "failed")
    error = executor.get(task.taskId).error
    assert error is not None and (error.code, error.retryable) == (code, retryable)


def test_unexpected_exceptions_become_internal_error_without_leaking(
    executors: list[TaskExecutor], caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.DEBUG)

    def handler(ctx: TaskContext) -> dict[str, Any]:
        raise RuntimeError("/storage/recordings/secret-path stderr: Metadata: title=private")

    executor = make(executors, handler)
    task = executor.submit(task_request())
    wait_for(lambda: status(executor, task.taskId) == "failed")
    snapshot = executor.get(task.taskId)
    assert snapshot.error is not None and snapshot.error.code is ErrorCode.INTERNAL_ERROR
    dumped = snapshot.model_dump_json() + caplog.text + str([r.__dict__ for r in caplog.records])
    assert "secret-path" not in dumped and "private" not in dumped
    # The worker survives and keeps serving tasks.
    again = executor.submit(task_request(idempotencyKey="idem-key-0002"))
    wait_for(lambda: status(executor, again.taskId) == "failed")


def test_finished_tasks_expire_by_ttl_and_free_their_idempotency_key(
    executors: list[TaskExecutor],
) -> None:
    clock = Clock()
    executor = make(executors, lambda ctx: {}, retention_ttl_seconds=60, clock=clock)
    task = executor.submit(task_request())
    wait_for(lambda: status(executor, task.taskId) == "succeeded")
    clock.now += 59
    assert executor.get(task.taskId).status == "succeeded"
    clock.now += 2
    with pytest.raises(RequestRejected) as info:
        executor.get(task.taskId)
    assert info.value.code is ErrorCode.TASK_NOT_FOUND
    assert executor.submit(task_request()).taskId != task.taskId  # key reusable after eviction


def test_finished_tasks_are_capped_by_count_oldest_first(executors: list[TaskExecutor]) -> None:
    executor = make(executors, lambda ctx: {}, retention_max=2)
    ids = []
    for index in range(4):
        accepted = executor.submit(task_request(idempotencyKey=f"idem-key-{index:04d}"))
        wait_for(lambda a=accepted: status(executor, a.taskId) == "succeeded")  # type: ignore[misc]
        ids.append(accepted.taskId)
    kept = []
    for task_id in ids:
        try:
            executor.get(task_id)
            kept.append(task_id)
        except RequestRejected:
            pass
    assert kept == ids[-2:]


def test_unfinished_tasks_are_never_evicted(executors: list[TaskExecutor]) -> None:
    gate = threading.Event()
    clock = Clock()
    executor = make(
        executors,
        lambda ctx: gate.wait(5) and {} or {},
        retention_ttl_seconds=1,
        retention_max=1,
        clock=clock,
    )
    task = executor.submit(task_request())
    wait_for(lambda: status(executor, task.taskId) == "running")
    clock.now += 10_000
    assert executor.get(task.taskId).status == "running"
    gate.set()


def test_submission_validation(executors: list[TaskExecutor]) -> None:
    executor = make(executors, lambda ctx: {})
    cases = {
        ErrorCode.CONTRACT_VERSION_MISMATCH: task_request(contractVersion="1"),
        ErrorCode.UNSUPPORTED_TASK_TYPE: task_request(type="preprocess"),
        ErrorCode.INVALID_STORAGE_KEY: task_request(
            input={"originalKey": f"recordings/{WS}/{REC}/original/..", "outputPrefix": "x"}
        ),
        ErrorCode.WORKSPACE_MISMATCH: task_request(
            input={
                "originalKey": f"recordings/{OTHER_WS}/{REC}/original",
                "outputPrefix": f"derived/{WS}/{REC}/{'a' * 64}",
            }
        ),
    }
    for code, request in cases.items():
        with pytest.raises(RequestRejected) as info:
            executor.submit(request)
        assert info.value.code is code


def test_unknown_task_id(executors: list[TaskExecutor]) -> None:
    executor = make(executors, lambda ctx: {})
    for call in (executor.get, executor.cancel):
        with pytest.raises(RequestRejected) as info:
            call(uuid4())
        assert info.value.code is ErrorCode.TASK_NOT_FOUND
