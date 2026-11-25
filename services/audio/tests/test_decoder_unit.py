"""Streamed decoder against a scripted runner: blocks, bounds, cancellation, failure (no FFmpeg)."""

from __future__ import annotations

import threading
import time
from collections.abc import Callable
from typing import Any

import numpy as np
import pytest
from media_fakes import FakeRunner, result

from audio_service.contracts import ErrorCode
from audio_service.domain.decoder import (
    CANONICAL_FILTER,
    CANONICAL_RATE_HZ,
    NATIVE_BLOCK_MAX_BYTES,
    DecodeMode,
    StreamedDecoder,
    decode_timeout_s,
)
from audio_service.domain.errors import TaskCancelled, TaskFailure
from audio_service.domain.runner import Outcome, RunResult
from audio_service.domain.tasks import CancellationToken


def emit(total: int, *, chunk: int = 1000, **kw: Any) -> Callable[..., RunResult]:
    def script(_a: list[str], sink: Callable[[bytes], None], _s: Any) -> RunResult:
        sent = 0
        while sent < total:
            n = min(chunk, total - sent)
            sink(bytes(range(256)) * (n // 256) + b"\0" * (n % 256))
            sent += n
        return result(**kw)

    return script


def decoder(
    script: Callable[..., RunResult], mode: DecodeMode = DecodeMode.CANONICAL, **kw: Any
) -> StreamedDecoder:
    fd = kw.pop("fd", 0)
    params: dict[str, Any] = {
        "demuxer": "wav",
        "mode": mode,
        "sample_rate_hz": 44100,
        "channels": 2,
        "timeout_s": 30.0,
        "block_ms": 100,
    }
    params.update(kw)
    return StreamedDecoder(FakeRunner({"ffmpeg": script}), fd, **params)  # type: ignore[arg-type]


def test_canonical_blocks_are_fixed_size_int16_with_a_short_last_block() -> None:
    dec = decoder(emit(2 * (1600 * 3 + 800)))  # three 100 ms blocks and a 50 ms tail
    blocks = list(dec.blocks())
    assert [b.samples.shape for b in blocks] == [(1600,), (1600,), (1600,), (800,)]
    assert all(b.samples.dtype == np.int16 for b in blocks)
    assert [b.start_frame for b in blocks] == [0, 1600, 3200, 4800]
    assert [b.index for b in blocks] == [0, 1, 2, 3]
    assert dec.stats.frames == 5600 and dec.stats.blocks == 4
    assert dec.stats.duration_ms == pytest.approx(350.0)
    assert dec.stats.clean_exit


def test_raw_bytes_match_the_samples_so_the_wav_can_be_written_without_a_copy() -> None:
    dec = decoder(emit(3200))
    block = next(iter(dec.blocks()))
    assert block.raw == block.samples.tobytes()
    assert not block.samples.flags.writeable  # a view of the immutable bytes


def test_native_blocks_are_float32_interleaved_frames_by_channels() -> None:
    dec = decoder(emit(4 * 2 * 4410 * 2), DecodeMode.NATIVE)  # 0.2 s of stereo f32 at 44.1 kHz
    blocks = list(dec.blocks())
    assert [b.samples.shape for b in blocks] == [(4410, 2), (4410, 2)]
    assert blocks[0].samples.dtype == np.float32
    assert dec.stats.sample_rate_hz == 44100 and dec.stats.channels == 2
    assert dec.stats.frames == 8820


def test_native_block_is_capped_in_bytes_whatever_the_requested_length() -> None:
    dec = decoder(emit(0), DecodeMode.NATIVE, sample_rate_hz=192000, channels=8, block_ms=60_000)
    assert dec._block_bytes <= NATIVE_BLOCK_MAX_BYTES  # noqa: SLF001 - the bound under test
    assert dec._block_bytes % (8 * 4) == 0  # noqa: SLF001


def test_a_trailing_partial_frame_is_dropped_not_padded() -> None:
    dec = decoder(emit(2 * 1600 + 1))
    assert [b.samples.shape for b in dec.blocks()] == [(1600,)]
    assert dec.stats.frames == 1600


def test_the_canonical_pass_uses_the_tuned_filter_and_mono_s16() -> None:
    runner = FakeRunner({"ffmpeg": emit(0)})
    dec = StreamedDecoder(
        runner,  # type: ignore[arg-type]
        0,
        demuxer="mp3",
        mode=DecodeMode.CANONICAL,
        sample_rate_hz=44100,
        channels=2,
        timeout_s=1,
    )
    list(dec.blocks())
    argv = runner.calls[0]
    assert argv[argv.index("-af") + 1] == CANONICAL_FILTER
    assert CANONICAL_FILTER == "aresample=16000:async=1:first_pts=0:min_hard_comp=0.02"
    assert argv[argv.index("-ac") + 1] == "1"
    assert argv[argv.index("-f", argv.index("-ac")) + 1] == "s16le"
    assert argv[argv.index("-protocol_whitelist") + 1] == "fd,pipe"
    assert {"-vn", "-sn", "-dn"} <= set(argv)
    assert CANONICAL_RATE_HZ == 16000


def test_progress_is_reported_per_block() -> None:
    seen: list[int] = []
    dec = decoder(emit(2 * 1600 * 3), on_progress=seen.append)
    list(dec.blocks())
    assert seen == [100, 200, 300]


def test_decoder_errors_are_counted_classified_and_positioned() -> None:
    def script(
        _a: list[str], sink: Callable[[bytes], None], signal: Callable[[], None] | None
    ) -> RunResult:
        sink(b"\0" * 3200)  # 1600 frames in a full block
        assert signal is not None
        signal()  # stderr speaks after the first block went out
        sink(b"\0" * 3200)
        return result(stderr=b"[mp3float @ 0x1] Header missing\n")

    dec = decoder(script)
    list(dec.blocks())
    assert dec.stats.errors.decode_errors == 1
    assert dec.stats.first_error_frame == 1600


def test_open_time_whitelist_noise_does_not_become_an_error_position() -> None:
    def script(
        _a: list[str], sink: Callable[[bytes], None], signal: Callable[[], None] | None
    ) -> RunResult:
        assert signal is not None
        signal()
        sink(b"\0" * 3200)
        return result(stderr=b"[mpeg4 @ 0x1] Codec (mpeg4) not on whitelist 'x'\n")

    dec = decoder(script)
    list(dec.blocks())
    assert dec.stats.errors.whitelist_refusals == 1 and dec.stats.errors.decode_errors == 0
    assert dec.stats.first_error_frame is None


def test_nonzero_exit_is_reported_in_stats_not_raised() -> None:
    dec = decoder(emit(3200, rc=183, stderr=b"Invalid data\n"))
    list(dec.blocks())
    assert dec.stats.returncode == 183 and not dec.stats.clean_exit


@pytest.mark.parametrize(
    ("outcome", "expected"),
    [(Outcome.TIMEOUT, ErrorCode.TIMEOUT), (Outcome.CANCELLED, ErrorCode.CANCELLED)],
)
def test_timeout_and_cancel_outcomes_raise_after_the_blocks_decoded_so_far(
    outcome: Outcome, expected: ErrorCode
) -> None:
    dec = decoder(emit(3200, outcome=outcome, rc=None))
    got: list[int] = []
    with pytest.raises(TaskFailure) as info:
        for block in dec.blocks():
            got.append(block.samples.size)
    assert info.value.code is expected and got == [1600]
    assert dec.stats.outcome is outcome


def test_a_sandbox_error_becomes_internal_error_without_detail() -> None:
    from audio_service.domain.runner import SandboxError

    def script(*_a: Any) -> RunResult:
        raise SandboxError("/secret/path could not start")

    with pytest.raises(TaskFailure) as info:
        list(decoder(script).blocks())
    assert info.value.code is ErrorCode.INTERNAL_ERROR and "secret" not in str(info.value)


def test_cancellation_is_checked_per_block_and_stops_the_producer() -> None:
    token = CancellationToken()
    stopped = threading.Event()

    def script(_a: list[str], sink: Callable[[bytes], None], _s: Any) -> RunResult:
        try:
            for _ in range(10_000):
                sink(b"\0" * 3200)
        finally:
            stopped.set()  # the runner's finally would kill the process group here
        return result()

    dec = decoder(script, cancel=token)
    with pytest.raises(TaskCancelled):
        for index, _ in enumerate(dec.blocks()):
            if index == 1:
                token.cancel()
    assert stopped.wait(5)


def test_abandoning_the_iterator_stops_the_producer() -> None:
    stopped = threading.Event()

    def script(_a: list[str], sink: Callable[[bytes], None], _s: Any) -> RunResult:
        try:
            for _ in range(10_000):
                sink(b"\0" * 3200)
        finally:
            stopped.set()
        return result()

    dec = decoder(script)
    blocks = dec.blocks()
    next(blocks)
    blocks.close()
    assert stopped.wait(5)


def test_backpressure_bounds_the_blocks_in_flight() -> None:
    produced = 0
    lock = threading.Lock()

    def script(_a: list[str], sink: Callable[[bytes], None], _s: Any) -> RunResult:
        nonlocal produced
        for _ in range(50):
            sink(b"\0" * 3200)
            with lock:
                produced += 1
        return result()

    dec = decoder(script)
    blocks = dec.blocks()
    next(blocks)
    time.sleep(0.5)  # the consumer stalls; the producer must not run away
    with lock:
        in_flight = produced
    blocks.close()
    # consumed 1 + at most queue depth (1) + the one being handed over (1) + the one in the sink
    assert in_flight <= 4


def test_one_pass_only() -> None:
    dec = decoder(emit(3200))
    list(dec.blocks())
    with pytest.raises(RuntimeError):
        list(dec.blocks())


def test_decode_timeout_is_120_seconds_plus_half_the_duration() -> None:
    assert decode_timeout_s(60_000, max_duration_ms=14_400_000) == 150.0
    assert decode_timeout_s(14_400_000, max_duration_ms=14_400_000) == 120 + 7200
    assert decode_timeout_s(None, max_duration_ms=3_600_000) == 120 + 1800


def endless(stopped: threading.Event) -> Callable[..., RunResult]:
    def script(_a: list[str], sink: Callable[[bytes], None], _s: Any) -> RunResult:
        try:
            while True:
                sink(b"\0" * 3200)
        finally:
            stopped.set()  # the runner's finally would kill the process group here

    return script


def test_a_stalled_consumer_cannot_outlive_the_wall_clock_timeout() -> None:
    stopped = threading.Event()
    dec = decoder(endless(stopped), timeout_s=0.3)
    started = time.monotonic()
    with pytest.raises(TaskFailure) as info:
        for index, _ in enumerate(dec.blocks()):
            if index == 0:
                time.sleep(1.0)  # the producer is blocked on the full queue meanwhile
    assert info.value.code is ErrorCode.TIMEOUT
    assert stopped.wait(5) and time.monotonic() - started < 5
    assert dec.stats.outcome is Outcome.TIMEOUT


def test_cancellation_reaches_a_producer_blocked_on_a_slow_consumer() -> None:
    token = CancellationToken()
    stopped = threading.Event()
    dec = decoder(endless(stopped), cancel=token)
    blocks = dec.blocks()
    next(blocks)
    time.sleep(0.2)  # producer now blocked in put()
    token.cancel()
    with pytest.raises(TaskCancelled):
        next(blocks)
    assert stopped.wait(5)
