"""`isolation.run_isolated`: sandboxed child-process inference (the GIL blocked the event loop
in-process). Landlock itself is covered by the container tests; here the runner is `off`."""

from __future__ import annotations

import os
import sys
import threading
import time
from pathlib import Path
from uuid import uuid4

import pytest
from helpers import REC, WS, task_request

from audio_service.contracts import ErrorCode, TaskProgress
from audio_service.domain.errors import TaskCancelled, TaskFailure
from audio_service.domain.isolation import (
    INFERENCE_ENV,
    inference_runner,
    models_readable,
    run_isolated,
)
from audio_service.domain.runner import SandboxRunner
from audio_service.domain.storage import PublishedFile
from audio_service.domain.storage_keys import TaskRefs
from audio_service.domain.tasks import CancellationToken, TaskContext

HERE = Path(__file__).parent


def ctx(
    mode: str, progress: list[TaskProgress], cancel: CancellationToken | None = None
) -> TaskContext:
    request = task_request(
        type="transcribe",
        config={"stub": mode},
        input={
            "originalKey": f"recordings/{WS}/{REC}/original",
            "outputPrefix": f"derived/{WS}/{REC}/{'c' * 64}",
        },
    )
    return TaskContext(
        task_id=uuid4(),
        request=request,
        refs=TaskRefs(request.workspaceId, request.recordingId),
        cancel=cancel or CancellationToken(),
        _report=progress.append,
    )


def published(tmp_path: Path) -> PublishedFile:
    path = tmp_path / "canonical.wav"
    path.write_bytes(b"RIFF" + b"\0" * 60)
    return PublishedFile(fd=os.open(path, os.O_RDONLY), sha256="0" * 64, size=64)


def run(
    mode: str, tmp_path: Path, progress: list[TaskProgress], cancel: CancellationToken | None = None
) -> dict:
    pub = published(tmp_path)
    try:
        return run_isolated(
            ctx(mode, progress, cancel),
            pub,
            SandboxRunner("off", extra_env=INFERENCE_ENV),
            models_dir=tmp_path,
            threads=1,
            deadline_per_audio_permille=4000,
            child_argv=[sys.executable, str(HERE / "inference_child_stub.py")],
        )
    finally:
        pub.close()


def test_relays_progress_and_result_and_passes_the_descriptor_not_the_token(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("AUDIO_SERVICE_TOKEN", "x" * 40)
    progress: list[TaskProgress] = []
    assert run("ok", tmp_path, progress) == {"bytes": 64, "token": None}
    assert [(p.stage, p.fraction, p.processedMs) for p in progress] == [("transcribe", 0.5, 1000)]


def test_child_error_codes_are_mapped(tmp_path: Path) -> None:
    with pytest.raises(TaskFailure) as known:
        run("error", tmp_path, [])
    assert known.value.code == ErrorCode.STORAGE_ERROR
    with pytest.raises(TaskFailure) as unknown:
        run("unknown-error", tmp_path, [])
    assert unknown.value.code == ErrorCode.INTERNAL_ERROR


def test_a_child_killed_by_a_signal_is_resource_exhausted(tmp_path: Path) -> None:
    with pytest.raises(TaskFailure) as killed:
        run("kill", tmp_path, [])
    assert killed.value.code == ErrorCode.RESOURCE_EXHAUSTED


def test_cancellation_kills_the_child_promptly(tmp_path: Path) -> None:
    cancel = CancellationToken()
    threading.Timer(0.5, cancel.cancel).start()
    started = time.monotonic()
    with pytest.raises(TaskCancelled):
        run("sleep", tmp_path, [], cancel)
    assert time.monotonic() - started < 5  # not the child's 30 s


def test_malformed_child_output_is_an_internal_error(tmp_path: Path) -> None:
    with pytest.raises(TaskFailure) as bad:
        run("garbage", tmp_path, [])
    assert bad.value.code == ErrorCode.INTERNAL_ERROR


def test_child_output_is_capped(tmp_path: Path) -> None:
    with pytest.raises(TaskFailure) as flood:
        run("flood", tmp_path, [])
    assert flood.value.code == ErrorCode.RESOURCE_LIMIT_EXCEEDED


def test_child_stdin_is_empty(tmp_path: Path) -> None:
    assert run("stdin", tmp_path, []) == {"stdin": ""}


def test_inference_profile_adds_only_thread_pins_to_the_environment() -> None:
    runner = inference_runner("off", Path("/models"))
    try:
        assert runner._env == {**INFERENCE_ENV, "PATH": "/usr/bin:/bin", "LC_ALL": "C"}  # noqa: SLF001
    finally:
        runner.close()


def test_models_readable_needs_every_file_to_yield_a_byte(tmp_path: Path) -> None:
    (tmp_path / "vad").mkdir()
    (tmp_path / "vad" / "m.onnx").write_bytes(b"m")
    (tmp_path / "empty.bin").write_bytes(b"")
    runner = SandboxRunner("off")
    assert models_readable(runner, tmp_path, ["vad/m.onnx"]) is True
    assert models_readable(runner, tmp_path, ["vad/m.onnx", "missing.bin"]) is False
    assert models_readable(runner, tmp_path, ["empty.bin"]) is False
