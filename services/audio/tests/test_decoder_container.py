"""Streamed decoding, the packet scan and cancellation against real FFmpeg in the audio image."""

from __future__ import annotations

import os
import resource
import time
from collections.abc import Iterator
from pathlib import Path

import numpy as np
import pytest
import timestamp_lab as lab
from media_lab import wav_header

from audio_service.contracts import ErrorCode
from audio_service.domain.decoder import DecodeMode, StreamedDecoder
from audio_service.domain.errors import TaskCancelled, TaskFailure
from audio_service.domain.probe import probe_media
from audio_service.domain.runner import SandboxRunner
from audio_service.domain.tasks import CancellationToken
from audio_service.domain.timeline import scan_packets

pytestmark = pytest.mark.container


@pytest.fixture(scope="module")
def runner() -> Iterator[SandboxRunner]:
    r = SandboxRunner("auto")
    r.verify_enforcement()
    yield r
    r.close()


def sparse_wav(path: Path, *, seconds: int, rate: int = 16000) -> None:
    """A valid mono s16 WAV whose PCM body is a sparse hole (reads as zeros, uses no tmpfs)."""
    size = seconds * rate * 2
    with path.open("wb") as handle:
        handle.write(wav_header(channels=1, rate=rate, data_size=size))
        handle.truncate(44 + size)


def open_fd(path: Path) -> int:
    return os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)


def decoder(runner: SandboxRunner, fd: int, mode: DecodeMode, rate: int, ch: int, **kw):  # type: ignore[no-untyped-def]
    return StreamedDecoder(
        runner, fd, demuxer="wav", mode=mode, sample_rate_hz=rate, channels=ch,
        timeout_s=kw.pop("timeout_s", 120.0), **kw,
    )  # fmt: skip


def peak_rss_mb() -> float:
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024  # KiB on Linux


def children() -> list[str]:
    found = []
    for entry in Path("/proc").iterdir():
        if entry.name.isdigit():
            try:
                comm = (entry / "comm").read_text().strip()
            except OSError:
                continue
            if comm in ("ffmpeg", "ffprobe"):
                found.append(entry.name)
    return found


def test_canonical_blocks_cover_the_file_exactly(runner: SandboxRunner, tmp_path: Path) -> None:
    path = tmp_path / "a.wav"
    lab.make_wav(path, 44100, 2, "pcm_s16le")  # 2 s
    fd = open_fd(path)
    try:
        dec = decoder(runner, fd, DecodeMode.CANONICAL, 44100, 2, block_ms=700)
        blocks = list(dec.blocks())
    finally:
        os.close(fd)
    assert [b.samples.shape[0] for b in blocks] == [11200, 11200, 9600]
    assert sum(b.samples.size for b in blocks) == 32000 == dec.stats.frames
    assert dec.stats.clean_exit and dec.stats.errors.total == 0
    assert b"".join(b.raw for b in blocks) == np.concatenate([b.samples for b in blocks]).tobytes()


def test_native_pass_keeps_the_native_rate_and_channels(
    runner: SandboxRunner, tmp_path: Path
) -> None:
    path = tmp_path / "a.wav"
    lab.make_wav(path, 48000, 2, "pcm_s24le")
    fd = open_fd(path)
    try:
        dec = decoder(runner, fd, DecodeMode.NATIVE, 48000, 2, block_ms=500)
        blocks = list(dec.blocks())
    finally:
        os.close(fd)
    assert all(b.samples.dtype == np.float32 and b.samples.shape[1] == 2 for b in blocks)
    assert dec.stats.frames == 96000 == sum(b.samples.shape[0] for b in blocks)
    peak = max(float(np.abs(b.samples).max()) for b in blocks)
    assert 0.79 < peak < 0.81  # the 0.8 amplitude bursts, as float32 in [-1, 1]


def test_memory_stays_bounded_while_decoding_an_hour(runner: SandboxRunner, tmp_path: Path) -> None:
    path = tmp_path / "hour.wav"
    sparse_wav(path, seconds=3600)  # 115 MB of PCM
    fd = open_fd(path)
    try:
        before = peak_rss_mb()
        dec = decoder(runner, fd, DecodeMode.CANONICAL, 16000, 1)
        frames = sum(b.samples.size for b in dec.blocks())
        native = decoder(runner, fd, DecodeMode.NATIVE, 16000, 1)
        native_frames = sum(b.samples.shape[0] for b in native.blocks())
        growth = peak_rss_mb() - before
    finally:
        os.close(fd)
    assert frames == native_frames == 3600 * 16000
    assert growth < 48, growth  # two passes over 115 MB each: a few blocks, never the file
    print(f"DECODE_1H_PEAK_RSS_GROWTH_MB={growth:.1f} PEAK_RSS_MB={peak_rss_mb():.1f}")  # noqa: T201


def test_packet_scan_streams_a_four_hour_file_in_bounded_memory(
    runner: SandboxRunner, tmp_path: Path
) -> None:
    path = tmp_path / "four-hours.wav"
    sparse_wav(path, seconds=4 * 3600, rate=8000)  # 230 MB of PCM, 4 h exactly
    fd = open_fd(path)
    try:
        probe = probe_media(runner, fd, lab.LIMITS)
        before = peak_rss_mb()
        started = time.monotonic()
        scan = scan_packets(runner, fd, probe, timeout_s=300)
        took = time.monotonic() - started
        growth = peak_rss_mb() - before
    finally:
        os.close(fd)
    assert probe.headerDurationMs == 14_400_000  # the ceiling itself is accepted
    assert scan.packets > 50_000 and scan.gap_count == 0 and scan.first_pts == 0
    assert scan.last_end == 4 * 3600 * 8000
    assert growth < 24, growth
    print(f"SCAN_4H_PACKETS={scan.packets} SECONDS={took:.1f} RSS_GROWTH_MB={growth:.1f}")  # noqa: T201


def test_cancellation_stops_the_pass_and_leaves_no_process(
    runner: SandboxRunner, tmp_path: Path
) -> None:
    path = tmp_path / "hour.wav"
    sparse_wav(path, seconds=3600)
    fd = open_fd(path)
    token = CancellationToken()
    try:
        dec = decoder(runner, fd, DecodeMode.CANONICAL, 16000, 1, cancel=token)
        started = time.monotonic()
        with pytest.raises(TaskCancelled):
            for index, _ in enumerate(dec.blocks()):
                if index == 2:
                    token.cancel()
        elapsed = time.monotonic() - started
    finally:
        os.close(fd)
    assert elapsed < 5 and children() == []
    print(f"CANCEL_LATENCY_S={elapsed:.2f}")  # noqa: T201


def test_a_stalled_consumer_is_cut_off_by_the_timeout_and_the_child_is_killed(
    runner: SandboxRunner, tmp_path: Path
) -> None:
    path = tmp_path / "hour.wav"
    sparse_wav(path, seconds=3600)
    fd = open_fd(path)
    try:
        dec = decoder(runner, fd, DecodeMode.CANONICAL, 16000, 1, timeout_s=1.0)
        started = time.monotonic()
        with pytest.raises(TaskFailure) as info:
            for index, _ in enumerate(dec.blocks()):
                if index == 0:
                    time.sleep(2.0)  # the child stalls on its full pipe meanwhile
        elapsed = time.monotonic() - started
    finally:
        os.close(fd)
    assert info.value.code is ErrorCode.TIMEOUT and elapsed < 10 and children() == []


def test_a_decoder_that_is_too_slow_for_its_deadline_times_out(
    runner: SandboxRunner, tmp_path: Path
) -> None:
    path = tmp_path / "hour.wav"
    sparse_wav(path, seconds=3600)
    fd = open_fd(path)
    try:
        dec = decoder(runner, fd, DecodeMode.NATIVE, 16000, 1, timeout_s=0.05)
        with pytest.raises(TaskFailure) as info:
            for _ in dec.blocks():
                pass
    finally:
        os.close(fd)
    assert info.value.code is ErrorCode.TIMEOUT and children() == []


def test_corrupt_input_counts_decoder_errors_without_keeping_their_text(
    runner: SandboxRunner, tmp_path: Path
) -> None:
    recipe = lab.LOSSY[0]
    path = tmp_path / "bad.mp3"
    recipe.make(path, noise=0.01)
    data = bytearray(path.read_bytes())
    for index in range(len(data) // 2, len(data) // 2 + 600):
        data[index] = (index * 91 + 7) % 256
    path.write_bytes(bytes(data))
    fd = open_fd(path)
    try:
        dec = StreamedDecoder(
            runner, fd, demuxer="mp3", mode=DecodeMode.CANONICAL,
            sample_rate_hz=44100, channels=1, timeout_s=60,
        )  # fmt: skip
        list(dec.blocks())
    finally:
        os.close(fd)
    assert dec.stats.errors.decode_errors > 0
    assert dec.stats.first_error_frame is not None
    held = {k: v for k, v in vars(dec.stats).items() if k not in ("mode", "outcome", "errors")}
    assert not any(isinstance(v, (bytes, bytearray, str)) for v in held.values())
    assert all(isinstance(v, (int, bool)) for v in vars(dec.stats.errors).values())
