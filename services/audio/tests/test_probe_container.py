"""`probe` against real files in the audio image: formats, limits, cover art, end-to-end task."""

from __future__ import annotations

import hashlib
import os
import subprocess  # noqa: S404
from collections.abc import Iterator
from pathlib import Path

import pytest
import timestamp_lab as lab
from helpers import REC, WS, task_request, wait_for
from media_lab import run_probe_file

from audio_service.contracts import ErrorCode, ProbeResult
from audio_service.domain.media_limits import MediaLimits
from audio_service.domain.probe import ProbeHandler, probe_media
from audio_service.domain.runner import SandboxRunner
from audio_service.domain.storage import LocalStorageBackend
from audio_service.domain.tasks import TaskExecutor

pytestmark = pytest.mark.container


@pytest.fixture(scope="module")
def runner() -> Iterator[SandboxRunner]:
    r = SandboxRunner("auto")
    r.verify_enforcement()
    yield r
    r.close()


def probe(runner: SandboxRunner, path: Path, limits: MediaLimits = lab.LIMITS) -> ProbeResult:
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        return probe_media(runner, fd, limits)
    finally:
        os.close(fd)


def test_wav_pcm_s24_stereo(runner: SandboxRunner, tmp_path: Path) -> None:
    path = tmp_path / "a.wav"
    lab.make_wav(path, 48000, 2, "pcm_s24le")
    result = probe(runner, path)
    assert (result.container, result.demuxer, result.codec) == ("wav", "wav", "pcm_s24le")
    assert (result.sampleRateHz, result.channels, result.bitsPerRawSample) == (48000, 2, 24)
    assert result.headerDurationMs == 2000 and result.trialDecode.decodedMs == 2000
    assert result.timelineSource.gaplessInfo == "none"
    assert result.timelineSource.editListPresent is False
    assert result.tools.ffprobe.startswith("7.1")
    print(f"PROBE_WAV_START={result.timelineSource.startTimeTicks},{result.warnings}")  # noqa: T201


@pytest.mark.parametrize("recipe", lab.LOSSY, ids=lambda r: r.name)
def test_every_lossy_format_probes_and_validates_against_the_contract(
    runner: SandboxRunner, tmp_path: Path, recipe: lab.LossyRecipe
) -> None:
    path = tmp_path / f"a.{recipe.extension}"
    recipe.make(path)
    result = probe(runner, path)
    assert ProbeResult.model_validate_json(result.model_dump_json()) == result
    assert result.sampleRateHz == recipe.rate and result.channels == recipe.channels
    # An MP3 without Xing/LAME data has only an estimate (measured 1839 ms for 2000 ms of VBR).
    assert 1700 <= (result.headerDurationMs or 0) <= 2100
    assert result.trialDecode.decodable and result.trialDecode.decodedMs >= 1900
    print(f"PROBE {recipe.name}: {result.codec} {result.timelineSource.model_dump_json()}")  # noqa: T201


def test_flac_reports_bit_depth(runner: SandboxRunner, tmp_path: Path) -> None:
    path = tmp_path / "a.flac"
    lab.make_flac(path, 44100, 2, 24)
    result = probe(runner, path)
    assert result.codec == "flac" and result.bitsPerRawSample == 24


def test_mp3_with_cover_art_probes_and_never_returns_metadata(
    runner: SandboxRunner, tmp_path: Path
) -> None:
    path = tmp_path / "cover.mp3"
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
         "sine=frequency=440:duration=3", "-f", "lavfi", "-i", "color=c=red:s=64x64:d=3",
         "-map", "0", "-map", "1", "-c:a", "libmp3lame", "-c:v", "mjpeg", "-frames:v", "1",
         "-id3v2_version", "3", "-metadata", "title=PRIVATE-TITLE", "-metadata",
         "comment=file:/etc/passwd", "-disposition:v", "attached_pic", str(path)],
        check=True, timeout=60,
    )  # fmt: skip
    result = probe(runner, path)
    assert (result.streamCount, result.audioStreamCount) == (2, 1)
    assert "non_audio_streams_ignored" in result.warnings
    assert "PRIVATE" not in result.model_dump_json() and "passwd" not in result.model_dump_json()


def test_m4a_with_cover_art_probes(runner: SandboxRunner, tmp_path: Path) -> None:
    path = tmp_path / "cover.m4a"
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
         "sine=frequency=440:duration=3", "-f", "lavfi", "-i", "color=c=red:s=64x64:d=3",
         "-map", "0", "-map", "1", "-c:a", "aac", "-c:v", "mjpeg", "-frames:v", "1",
         "-disposition:v", "attached_pic", "-metadata", "title=PRIVATE-TITLE", str(path)],
        check=True, timeout=60,
    )  # fmt: skip
    result = probe(runner, path)
    assert result.container == "mp4" and result.audioStreamCount == 1
    assert "PRIVATE" not in result.model_dump_json()


def test_a_real_video_track_is_refused_by_the_codec_whitelist(
    runner: SandboxRunner, tmp_path: Path
) -> None:
    path = tmp_path / "video.mp4"
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
         "sine=frequency=440:duration=2", "-f", "lavfi", "-i", "color=c=red:s=64x64:d=2",
         "-c:a", "aac", "-c:v", "mpeg4", str(path)],
        check=True, timeout=60,
    )  # fmt: skip
    code, _ = run_probe_file(runner, path)
    assert code is ErrorCode.UNSUPPORTED_FORMAT


@pytest.mark.parametrize(
    ("limits", "make", "expected"),
    [
        (MediaLimits(1_000, 8, 192_000), lambda p: lab.make_wav(p, 16000, 1, "pcm_s16le"),
         ErrorCode.DURATION_LIMIT_EXCEEDED),
        (MediaLimits(14_400_000, 1, 192_000), lambda p: lab.make_wav(p, 16000, 2, "pcm_s16le"),
         ErrorCode.RESOURCE_LIMIT_EXCEEDED),
        (MediaLimits(14_400_000, 8, 16_000), lambda p: lab.make_wav(p, 48000, 1, "pcm_s16le"),
         ErrorCode.RESOURCE_LIMIT_EXCEEDED),
    ],
    ids=["duration", "channels", "sample-rate"],
)  # fmt: skip
def test_limits_reject_real_files_and_never_truncate(
    runner: SandboxRunner,
    tmp_path: Path,
    limits: MediaLimits,
    make,
    expected: ErrorCode,  # type: ignore[no-untyped-def]
) -> None:
    path = tmp_path / "a.wav"
    make(path)
    fd = os.open(path, os.O_RDONLY)
    try:
        with pytest.raises(Exception) as info:  # noqa: PT011 - TaskFailure checked below
            probe_media(runner, fd, limits)
    finally:
        os.close(fd)
    assert info.value.code is expected  # type: ignore[attr-defined]


def test_end_to_end_task_through_the_executor_leaves_the_original_untouched(
    runner: SandboxRunner, tmp_path: Path
) -> None:
    root = tmp_path / "storage"
    original = root / "recordings" / WS / REC / "original"
    original.parent.mkdir(parents=True)
    lab.make_wav(original, 44100, 2, "pcm_s16le")
    before = (hashlib.sha256(original.read_bytes()).hexdigest(), original.stat().st_ino)
    storage = LocalStorageBackend(root)
    handler = ProbeHandler(
        lambda: storage, lambda: runner,
        max_duration_ms=14_400_000, max_channels=8, max_sample_rate_hz=192_000,
    )  # fmt: skip
    executor = TaskExecutor({"probe": handler})
    executor.start()
    try:
        accepted = executor.submit(task_request(config={"maxDurationMs": 60_000}))
        wait_for(lambda: executor.get(accepted.taskId).status in ("succeeded", "failed"), 30)
        state = executor.get(accepted.taskId)
    finally:
        executor.shutdown()
    assert state.status == "succeeded" and state.error is None
    assert state.result is not None
    ProbeResult.model_validate(state.result)  # the contract mirror accepts it
    assert state.progress is not None and state.progress.fraction == 1.0
    assert (hashlib.sha256(original.read_bytes()).hexdigest(), original.stat().st_ino) == before
