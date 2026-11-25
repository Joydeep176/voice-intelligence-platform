"""Runs model inference in a sandboxed child process (ADR-0036 / ADR-0037).

The native engines (whisper.cpp through pywhispercpp, sherpa-onnx) hold the Python GIL while they
compute, so running them on an executor thread blocked the HTTP event loop: status polls and
`/health/live` timed out for minutes (measured on the dev stack). The child runs through the same
`SandboxRunner` as FFmpeg, with the inference profile (`inference_runner`): Landlock read/execute
only beneath the system paths, the virtual environment and the read-only models directory, no TCP,
scoped signals and sockets; rlimits CPU, FSIZE=0, NOFILE, CORE; a fixed environment (never the
service token); stdin /dev/null; its own process group, killed on cancellation or the task
deadline. It gets the parent's already-opened, manifest-checked canonical WAV as an inherited
descriptor (storage policy stays in the parent) and the task message as its one argument, and
reports progress and its result as JSON lines on stdout (capped). A child killed by a signal the
runner did not send (for example the OOM killer) is `RESOURCE_EXHAUSTED`; SIGXCPU is `TIMEOUT`.
"""

from __future__ import annotations

import json
import os
import sys
from collections.abc import Callable
from pathlib import Path
from typing import Any

from pydantic import BaseModel, ValidationError

from audio_service.contracts import ErrorCode
from audio_service.domain.canonical_audio import CANONICAL_NAME
from audio_service.domain.errors import TaskFailure
from audio_service.domain.landlock import DEFAULT_READ_EXEC_PATHS
from audio_service.domain.media_io import raise_for_outcome
from audio_service.domain.runner import LandlockMode, Outcome, SandboxRunner
from audio_service.domain.storage import PublishedFile, StorageBackend
from audio_service.domain.tasks import TaskContext

CHILD_MODULE = "audio_service.domain.inference_child"
#: A result larger than this is refused (a 60 min diarization result is well under 1 MB).
MAX_OUTPUT_BYTES = 16 * 1024 * 1024
#: Fixed entries added to the runner's `PATH`/`LC_ALL` environment: thread pins for any implicit
#: pools (the engines take their thread count explicitly; it overrides these, ADR-0041) and no
#: bytecode writes. Nothing is inherited from the service.
INFERENCE_ENV = {
    "OMP_NUM_THREADS": "1",
    "OPENBLAS_NUM_THREADS": "1",
    "PYTHONDONTWRITEBYTECODE": "1",
}
#: The runner's wall-clock timeout trails the task deadline, which stops the child first (through
#: the cancellation token) and is reported as the task's TIMEOUT by the executor.
DEADLINE_SLACK_S = 5.0
#: Only when no task deadline is attached (unit tests).
NO_DEADLINE_TIMEOUT_S = 3600.0


def inference_runner(landlock_mode: LandlockMode, models_dir: Path) -> SandboxRunner:
    """The inference profile: the FFmpeg read/execute paths plus the interpreter's environment
    (installed packages and native libraries) and the read-only models directory. Storage, /tmp,
    /proc and /sys stay denied."""
    paths = (*DEFAULT_READ_EXEC_PATHS, os.path.realpath(sys.prefix), os.path.realpath(models_dir))
    return SandboxRunner(landlock_mode, read_exec_paths=paths, extra_env=INFERENCE_ENV)


def models_readable(runner: SandboxRunner, models_dir: Path, relpaths: list[str]) -> bool:
    """Startup self-test: a confined child can read the first byte of every pinned model file.

    Landlock path rules attach to inodes. On a filesystem with unstable inodes, for example Docker
    Desktop's macOS host bind mounts (`fakeowner`), a rule on the models directory never matches.
    Every inference child would then fail at its first model open. Measured 2026-11-24: rule on
    `/models` denied on `fakeowner`, allowed on an ext4 volume. The service reports that as
    not-ready instead of failing each task with INTERNAL_ERROR."""
    for relpath in relpaths:
        out = bytearray()
        result = runner.run(
            ["head", "-c", "1", str(models_dir / relpath)], stdout_sink=out.extend, timeout_s=10
        )
        if result.outcome is not Outcome.EXITED or result.returncode != 0 or len(out) != 1:
            return False
    return True


def run_handler_isolated(  # noqa: PLR0913
    ctx: TaskContext,
    storage: StorageBackend | None,
    runner: SandboxRunner,
    result_model: type[BaseModel],
    *,
    models_dir: Path,
    threads: int,
    deadline_per_audio_permille: int,
    budget_audio_ms: int,
) -> dict[str, Any]:
    """Parent side of an inference task: the inference budget, the storage policy check (the
    canonical WAV is opened here), the sandboxed child run, and re-validation of its result."""
    if storage is None:
        raise TaskFailure(ErrorCode.STORAGE_ERROR)
    ctx.set_inference_budget(budget_audio_ms, deadline_per_audio_permille)
    published = storage.open_published_file(
        ctx.request.input.outputPrefix, ctx.refs, CANONICAL_NAME
    )
    try:
        out = run_isolated(
            ctx,
            published,
            runner,
            models_dir=models_dir,
            threads=threads,
            deadline_per_audio_permille=deadline_per_audio_permille,
        )
    finally:
        published.close()
    try:
        return result_model.model_validate(out).model_dump(mode="json")
    except ValidationError:
        raise TaskFailure(ErrorCode.INTERNAL_ERROR) from None


def run_isolated(  # noqa: PLR0913
    ctx: TaskContext,
    published: PublishedFile,
    runner: SandboxRunner,
    *,
    models_dir: Path,
    threads: int,
    deadline_per_audio_permille: int,
    child_argv: list[str] | None = None,
) -> dict[str, Any]:
    message = {
        "taskId": str(ctx.task_id),
        "request": ctx.request.model_dump(mode="json"),
        "fd": published.fd,
        "sha256": published.sha256,
        "size": published.size,
        "modelsDir": str(models_dir),
        "threads": threads,
        "permille": deadline_per_audio_permille,
    }
    sink = _LineSink(ctx)
    remaining = (
        NO_DEADLINE_TIMEOUT_S if ctx.deadline is None else max(0.0, ctx.deadline.remaining_s)
    )
    result = runner.run(
        [*(child_argv or [sys.executable, "-m", CHILD_MODULE]), json.dumps(message)],
        stdout_sink=sink,
        timeout_s=remaining + DEADLINE_SLACK_S,
        input_fd=published.fd,
        max_stdout_bytes=MAX_OUTPUT_BYTES,
        cancel=ctx.cancel,
        cpu_threads=threads,
    )
    # result.stderr holds native-library logs: never logged or returned.
    raise_for_outcome(result)
    if sink.malformed:
        raise TaskFailure(ErrorCode.INTERNAL_ERROR)
    if sink.result is not None:
        return sink.result
    if sink.error is not None:
        known = sink.error in ErrorCode.__members__
        raise TaskFailure(ErrorCode(sink.error) if known else ErrorCode.INTERNAL_ERROR)
    raise TaskFailure(ErrorCode.INTERNAL_ERROR)


class _LineSink:
    """Parses the child's JSON lines as they arrive; relays progress at once."""

    def __init__(self, ctx: TaskContext) -> None:
        self._report: Callable[[str, float, int], None] = ctx.report_progress
        self._buffer = b""
        self.result: dict[str, Any] | None = None
        self.error: str | None = None
        self.malformed = False

    def __call__(self, chunk: bytes) -> None:
        self._buffer += chunk
        *lines, self._buffer = self._buffer.split(b"\n")
        for line in lines:
            try:
                message = json.loads(line)
                if "progress" in message:
                    p = message["progress"]
                    self._report(str(p["stage"]), float(p["fraction"]), int(p["processedMs"]))
                elif "result" in message:
                    self.result = message["result"]
                elif "error" in message:
                    self.error = str(message["error"])
            except (ValueError, KeyError, TypeError):
                self.malformed = True
