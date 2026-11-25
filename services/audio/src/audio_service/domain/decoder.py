"""Streamed decoder (plan §3, §11): FFmpeg through the sandbox runner, yielding fixed-size blocks.

Two passes over the same original, used by WS4's preprocess:
- native: native rate, every channel interleaved, `f32le` -> float32 blocks of shape
  (frames, channels);
- canonical: 16 kHz mono `s16le` -> int16 blocks of shape (frames,), after
  `aresample=16000:async=1:first_pts=0:min_hard_comp=0.02` so that sample index tracks presentation
  time (leading offsets are dropped, timestamp gaps are filled with silence). The raw bytes of every
  block are exposed so the caller can write the WAV without a copy: `samples` is a read-only view
  of `raw`.

Memory is bounded: the producer thread assembles one block, at most `QUEUE_DEPTH` finished blocks
wait for the consumer (backpressure stalls the child through its pipe), and one is in the consumer's
hands. The native block is capped at `NATIVE_BLOCK_MAX_BYTES` regardless of the requested length.
The wall-clock timeout covers the whole pass, consumer time included.

Decoder error lines are counted by class and discarded; they are never logged or returned.
`DecodeStats` never pads to the header duration: it reports what was decoded.
"""

from __future__ import annotations

import queue
import threading
import time
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from enum import StrEnum

import numpy as np
import numpy.typing as npt

from audio_service.contracts import ErrorCode
from audio_service.domain.errors import TaskCancelled, TaskFailure
from audio_service.domain.ffmpeg_args import ffmpeg_command
from audio_service.domain.media_args import (
    GLOBAL_ARGS,
    StderrClasses,
    classify_stderr,
    input_options,
)
from audio_service.domain.media_io import rewind, signal_failure_code
from audio_service.domain.runner import (
    STDERR_CAP_BYTES,
    Cancellable,
    Outcome,
    SandboxError,
    SandboxRunner,
)

CANONICAL_RATE_HZ = 16_000
DEFAULT_BLOCK_MS = 10_000
NATIVE_BLOCK_MAX_BYTES = 16 * 1024 * 1024
QUEUE_DEPTH = 1
# Tuned in tests: gaps above 20 ms are filled; smaller timestamp jitter is left alone.
CANONICAL_FILTER = "aresample=16000:async=1:first_pts=0:min_hard_comp=0.02"
_PUT_POLL_S = 0.05


class DecodeMode(StrEnum):
    NATIVE = "native"
    CANONICAL = "canonical"


@dataclass(frozen=True)
class DecodeBlock:
    index: int
    start_frame: int  # frame position of the first sample of the block in this pass
    raw: bytes
    samples: npt.NDArray[np.float32] | npt.NDArray[np.int16]


@dataclass
class DecodeStats:
    mode: DecodeMode
    sample_rate_hz: int
    channels: int
    frames: int = 0
    blocks: int = 0
    outcome: Outcome = Outcome.EXITED
    returncode: int | None = None
    errors: StderrClasses = field(default_factory=StderrClasses)
    first_error_frame: int | None = None  # frames emitted when stderr first spoke (approximate)

    @property
    def duration_ms(self) -> float:
        return self.frames * 1000 / self.sample_rate_hz

    @property
    def clean_exit(self) -> bool:
        return self.outcome is Outcome.EXITED and self.returncode == 0


def decode_timeout_s(duration_ms: int | None, *, max_duration_ms: int) -> float:
    """120 s + 0.5 x duration (interim default; OD-10 Open). Unknown duration uses the ceiling."""
    return 120.0 + 0.5 * (duration_ms if duration_ms is not None else max_duration_ms) / 1000


class _Abort(Exception):
    """Raised inside the sink to unwind the runner (and so kill the child's process group)."""

    def __init__(self, outcome: Outcome) -> None:
        self.outcome = outcome
        super().__init__(outcome.value)


class StreamedDecoder:
    def __init__(  # noqa: PLR0913
        self,
        runner: SandboxRunner,
        fd: int,
        *,
        demuxer: str,
        mode: DecodeMode,
        sample_rate_hz: int,
        channels: int,
        timeout_s: float,
        block_ms: int = DEFAULT_BLOCK_MS,
        cancel: Cancellable | None = None,
        on_progress: Callable[[int], None] | None = None,
    ) -> None:
        self._runner, self._fd, self._demuxer = runner, fd, demuxer
        self._mode = mode
        self._timeout_s = timeout_s
        self._cancel = cancel
        self._on_progress = on_progress
        rate = CANONICAL_RATE_HZ if mode is DecodeMode.CANONICAL else sample_rate_hz
        channels = 1 if mode is DecodeMode.CANONICAL else channels
        self._frame_bytes = channels * (2 if mode is DecodeMode.CANONICAL else 4)
        frames = max(1, rate * block_ms // 1000)
        self._block_frames = max(1, min(frames, NATIVE_BLOCK_MAX_BYTES // self._frame_bytes))
        self._block_bytes = self._block_frames * self._frame_bytes
        self.stats = DecodeStats(mode, rate, channels)
        self._finished = False

    @property
    def finished(self) -> bool:
        return self._finished

    def _argv(self) -> list[str]:
        out = ["-map", "0:a:0", "-vn", "-sn", "-dn"]
        if self._mode is DecodeMode.CANONICAL:
            out += ["-af", CANONICAL_FILTER, "-ac", "1", "-f", "s16le", "-acodec", "pcm_s16le", "-"]
        else:
            out += ["-f", "f32le", "-acodec", "pcm_f32le", "-"]
        argv = ffmpeg_command(self._fd, input_options=input_options(self._demuxer), output_args=out)
        argv[1:1] = GLOBAL_ARGS
        return argv

    def _make_block(self, index: int, start_frame: int, raw: bytes) -> DecodeBlock:
        if self._mode is DecodeMode.CANONICAL:
            samples: npt.NDArray[np.float32] | npt.NDArray[np.int16] = np.frombuffer(
                raw, dtype="<i2"
            ).astype(np.int16, copy=False)
        else:
            flat = np.frombuffer(raw, dtype="<f4").astype(np.float32, copy=False)
            samples = flat.reshape(-1, self.stats.channels)
        return DecodeBlock(index, start_frame, raw, samples)

    def blocks(self) -> Iterator[DecodeBlock]:  # noqa: PLR0915 - producer closure plus consumer
        if self._finished or self.stats.blocks:
            raise RuntimeError("a decoder can be iterated once")
        stats = self.stats
        out: queue.Queue[DecodeBlock] = queue.Queue(maxsize=QUEUE_DEPTH)
        stop = threading.Event()
        finished = threading.Event()
        failure: list[BaseException] = []
        buffer = bytearray()
        produced = 0  # frames handed to the queue
        deadline = time.monotonic() + self._timeout_s

        def put(item: DecodeBlock) -> None:
            # The runner cannot check its own deadline or cancellation while the sink is blocked
            # on a slow consumer, so the wait enforces both.
            while True:
                if stop.is_set():
                    raise _Abort(Outcome.CANCELLED)
                if self._cancel is not None and self._cancel.cancelled:
                    raise _Abort(Outcome.CANCELLED)
                if time.monotonic() >= deadline:
                    raise _Abort(Outcome.TIMEOUT)
                try:
                    out.put(item, timeout=_PUT_POLL_S)
                    return
                except queue.Full:
                    continue

        def emit(raw: bytes) -> None:
            nonlocal produced
            block = self._make_block(stats.blocks, produced, raw)
            produced += len(raw) // self._frame_bytes
            stats.blocks += 1
            put(block)

        def sink(data: bytes) -> None:
            buffer.extend(data)
            while len(buffer) >= self._block_bytes:
                chunk = bytes(buffer[: self._block_bytes])
                del buffer[: self._block_bytes]
                emit(chunk)

        def note_stderr() -> None:
            if stats.first_error_frame is None:
                stats.first_error_frame = produced + len(buffer) // self._frame_bytes

        def produce() -> None:
            try:
                rewind(self._fd)  # children share the offset; always start at byte 0
                result = self._runner.run(
                    self._argv(),
                    stdout_sink=sink,
                    timeout_s=self._timeout_s,
                    input_fd=self._fd,
                    cancel=self._cancel,
                    stderr_signal=note_stderr,
                )
                whole = len(buffer) - len(buffer) % self._frame_bytes
                killed = signal_failure_code(result.outcome, result.returncode) is not None
                if whole and result.outcome is Outcome.EXITED and not killed:
                    emit(bytes(buffer[:whole]))  # a trailing partial frame is dropped
                stats.outcome, stats.returncode = result.outcome, result.returncode
                stats.errors = classify_stderr(result.stderr, cap=STDERR_CAP_BYTES)
                if stats.errors.whitelist_refusals:
                    stats.first_error_frame = None  # open-time noise would mislead the position
            except _Abort as abort:
                stats.outcome = abort.outcome
            except SandboxError:
                failure.append(TaskFailure(ErrorCode.INTERNAL_ERROR))
            except BaseException as exc:  # noqa: BLE001 - handed to the consumer, never lost
                failure.append(exc)
            finally:
                finished.set()

        thread = threading.Thread(target=produce, name="audio-decode", daemon=True)
        thread.start()
        try:
            while True:
                if self._cancel is not None and self._cancel.cancelled:
                    raise TaskCancelled
                try:
                    item = out.get(timeout=_PUT_POLL_S)
                except queue.Empty:
                    if finished.is_set() and out.empty():
                        break
                    continue
                stats.frames += len(item.raw) // self._frame_bytes
                yield item
                if self._on_progress is not None:
                    self._on_progress(round(stats.duration_ms))
        finally:
            stop.set()
            thread.join()
        self._finished = True
        if failure:
            raise failure[0]
        if stats.outcome is Outcome.TIMEOUT:
            raise TaskFailure(ErrorCode.TIMEOUT)
        if stats.outcome is Outcome.CANCELLED:
            raise TaskCancelled
        killed_code = signal_failure_code(stats.outcome, stats.returncode)
        if killed_code is not None:  # OOM kill, CPU rlimit, crash: never a property of the file
            raise TaskFailure(killed_code)
