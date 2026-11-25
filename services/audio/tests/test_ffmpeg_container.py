"""FFmpeg inside the audio image: version, the `fd` protocol with a seekable descriptor, and the
protocol allow-list. Test audio is generated here with lavfi; the production argument helpers can
never produce a lavfi command (see test_ffmpeg_args)."""

from __future__ import annotations

import json
import os
import subprocess  # noqa: S404
from collections.abc import Iterator
from pathlib import Path

import pytest

from audio_service.domain.capabilities import measure_ffmpeg_version
from audio_service.domain.ffmpeg_args import ffmpeg_command, ffprobe_command
from audio_service.domain.runner import Outcome, SandboxRunner

pytestmark = pytest.mark.container

PCM_ARGS = [
    "-vn",
    "-sn",
    "-dn",
    "-f",
    "s16le",
    "-acodec",
    "pcm_s16le",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-",
]


@pytest.fixture(scope="module")
def media(tmp_path_factory: pytest.TempPathFactory) -> Path:
    """One second 440 Hz tone as MP4/AAC with the default layout (moov atom at the END of the file,
    so a demuxer must seek: a non-seekable input would fail)."""
    path = tmp_path_factory.mktemp("media") / "tone.m4a"
    subprocess.run(  # noqa: S603
        [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:duration=1",  # noqa: S607
            "-c:a",
            "aac",
            "-f",
            "mp4",
            str(path),
        ],
        check=True,
        timeout=60,
    )
    data = path.read_bytes()
    assert data.rfind(b"moov") > data.rfind(b"mdat") > 0  # moov really is after the media data
    return path


@pytest.fixture
def runner() -> Iterator[SandboxRunner]:
    r = SandboxRunner("auto")  # confined by Landlock when the kernel allows it
    r.verify_enforcement()
    yield r
    r.close()


def test_ffmpeg_version_is_measured_and_recorded() -> None:
    version = measure_ffmpeg_version()
    print(f"FFMPEG_VERSION={version}")  # noqa: T201 - recorded in VERIFICATION_WS1.md
    assert version


def test_fd_protocol_decodes_a_seekable_mp4_through_the_runner(
    media: Path, runner: SandboxRunner
) -> None:
    fd = os.open(media, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        pcm = bytearray()
        result = runner.run(
            ffmpeg_command(fd, output_args=PCM_ARGS),
            stdout_sink=pcm.extend,
            timeout_s=30,
            input_fd=fd,
        )
    finally:
        os.close(fd)
    assert result.outcome is Outcome.EXITED and result.returncode == 0, result.stderr[:200]
    print(f"FD_PROTOCOL_PCM_BYTES={len(pcm)} LANDLOCK_ENFORCED={runner.landlock_enforced}")  # noqa: T201
    assert (
        30_000 <= len(pcm) <= 34_000
    )  # ~1 s of 16 kHz mono s16le (AAC priming can shift a little)


def test_ffprobe_reads_the_same_descriptor(media: Path, runner: SandboxRunner) -> None:
    fd = os.open(media, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        out = bytearray()
        result = runner.run(
            ffprobe_command(
                fd, output_args=["-print_format", "json", "-show_format", "-show_streams"]
            ),
            stdout_sink=out.extend,
            timeout_s=30,
            input_fd=fd,
            max_stdout_bytes=256 * 1024,
        )
    finally:
        os.close(fd)
    assert result.returncode == 0, result.stderr[:200]
    info = json.loads(out)
    assert info["streams"][0]["codec_name"] == "aac"
    assert 0.9 < float(info["format"]["duration"]) < 1.2


def test_protocol_allow_list_blocks_path_inputs(media: Path, runner: SandboxRunner) -> None:
    """Control for `-protocol_whitelist fd,pipe`: a path input must not be openable."""
    argv = [
        "ffmpeg",
        "-hide_banner",
        "-nostats",
        "-loglevel",
        "error",
        "-nostdin",
        "-protocol_whitelist",
        "fd,pipe",
        "-i",
        str(media),
        *PCM_ARGS,
    ]
    pcm = bytearray()
    result = runner.run(argv, stdout_sink=pcm.extend, timeout_s=30)
    assert result.returncode != 0 and not pcm
    assert b"whitelist" in result.stderr.lower()  # classified here only; never logged


def test_ffmpeg_cannot_write_files_even_with_an_explicit_output_path(
    media: Path, tmp_path: Path
) -> None:
    runner = SandboxRunner("off")  # isolate the RLIMIT_FSIZE control from Landlock
    fd = os.open(media, os.O_RDONLY | os.O_CLOEXEC)
    target = tmp_path / "out.wav"
    try:
        argv = ffmpeg_command(fd, output_args=["-vn", "-y", str(target)])
        result = runner.run(argv, stdout_sink=lambda _: None, timeout_s=30, input_fd=fd)
    finally:
        os.close(fd)
        runner.close()
    assert result.returncode != 0
    assert not target.exists() or target.stat().st_size == 0
