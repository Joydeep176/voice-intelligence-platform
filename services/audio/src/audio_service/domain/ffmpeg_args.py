"""Command-line builders for FFmpeg/ffprobe children (plan §6.1).

No path or URL ever reaches FFmpeg: the input is an inherited descriptor and only the `fd`
and `pipe` protocols are whitelisted. The lavfi device and every other input source are
unreachable through these helpers.

Measured in the image (FFmpeg 7.1.5, WS1): the `fd:<n>` URL form is refused ("Doesn't support pass
file descriptor via URL"); the descriptor is passed with the protocol option `-fd <n>` and the
URL is the bare `fd:`. The descriptor must be seekable for MP4 with a trailing moov atom."""

from __future__ import annotations

from collections.abc import Sequence

PROTOCOL_WHITELIST = "fd,pipe"
_FORBIDDEN_OPTIONS = frozenset({"-i", "-fd", "-protocol_whitelist", "-filter_complex"})


def _check_input_options(options: Sequence[str]) -> None:
    for index, option in enumerate(options):
        previous = options[index - 1] if index else ""
        if (
            option in _FORBIDDEN_OPTIONS
            or option.lower() == "lavfi"
            or (previous == "-f" and option.lower() in {"lavfi", "concat", "hls", "dash"})
        ):
            raise ValueError("input option not allowed")


def ffmpeg_command(
    input_fd: int, *, input_options: Sequence[str] = (), output_args: Sequence[str] = ()
) -> list[str]:
    _check_input_options(input_options)
    return [
        "ffmpeg",
        "-hide_banner",
        "-nostats",
        "-loglevel",
        "error",
        "-nostdin",
        "-protocol_whitelist",
        PROTOCOL_WHITELIST,
        *input_options,
        "-fd",
        str(input_fd),
        "-i",
        "fd:",
        *output_args,
    ]


def ffprobe_command(
    input_fd: int, *, input_options: Sequence[str] = (), output_args: Sequence[str] = ()
) -> list[str]:
    _check_input_options(input_options)
    return [
        "ffprobe",
        "-hide_banner",
        "-loglevel",
        "error",
        "-protocol_whitelist",
        PROTOCOL_WHITELIST,
        *input_options,
        "-fd",
        str(input_fd),
        "-i",
        "fd:",
        *output_args,
    ]
