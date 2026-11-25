from __future__ import annotations

import pytest

from audio_service.domain.ffmpeg_args import ffmpeg_command, ffprobe_command


def test_ffmpeg_command_uses_only_the_descriptor_and_the_fd_pipe_whitelist() -> None:
    assert ffmpeg_command(7, output_args=["-f", "s16le", "-"]) == [
        "ffmpeg",
        "-hide_banner",
        "-nostats",
        "-loglevel",
        "error",
        "-nostdin",
        "-protocol_whitelist",
        "fd,pipe",
        "-fd",
        "7",
        "-i",
        "fd:",
        "-f",
        "s16le",
        "-",
    ]


def test_ffprobe_command_shape() -> None:
    argv = ffprobe_command(5)
    assert argv[0] == "ffprobe"
    assert argv[argv.index("-protocol_whitelist") + 1] == "fd,pipe"
    assert argv[-4:] == ["-fd", "5", "-i", "fd:"]


@pytest.mark.parametrize(
    "options",
    [
        ["-f", "lavfi"],
        ["-f", "LAVFI"],
        ["lavfi"],
        ["-f", "concat"],
        ["-f", "hls"],
        ["-i", "/etc/passwd"],
        ["-fd", "9"],
        ["-protocol_whitelist", "file,http"],
        ["-filter_complex", "movie=/etc/passwd"],
    ],
)
def test_dangerous_input_options_are_refused(options: list[str]) -> None:
    for build in (ffmpeg_command, ffprobe_command):
        with pytest.raises(ValueError):
            build(3, input_options=options)
