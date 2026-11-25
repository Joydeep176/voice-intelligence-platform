"""EBU R128 loudness through one extra FFmpeg pass (plan §9).

`ebur128=peak=true:framelog=quiet` prints only its final summary, at info level, to stderr. The
summary is parsed here, from the runner's bounded stderr buffer; the text itself is never logged or
returned. Anything that cannot be parsed is `unavailable` with a reason code, never guessed.
"""

from __future__ import annotations

import math
import re

from audio_service.contracts import Quantity, Unavailable
from audio_service.domain.ffmpeg_args import ffmpeg_command
from audio_service.domain.measurements import quantity
from audio_service.domain.media_args import GLOBAL_ARGS, input_options
from audio_service.domain.media_io import raise_for_outcome, rewind
from audio_service.domain.runner import Cancellable, SandboxRunner

LOUDNESS_FILTER = "ebur128=peak=true:framelog=quiet"
_METHOD = "EBU R128 (ITU-R BS.1770) via FFmpeg ebur128, true peak enabled"
_FIELDS = (
    ("integratedLoudnessLufs", re.compile(r"\bI:\s+(\S+) LUFS"), "LUFS"),
    ("loudnessRangeLu", re.compile(r"\bLRA:\s+(\S+) LU\b"), "LU"),
    ("truePeakDbtp", re.compile(r"\bPeak:\s+(\S+) dB(?:FS|TP)\b"), "dBTP"),
)


def parse_summary(stderr: bytes) -> tuple[dict[str, Quantity], list[Unavailable]]:
    quantities: dict[str, Quantity] = {}
    missing: list[Unavailable] = []
    text = stderr.decode("utf-8", errors="replace")
    marker = text.rfind("Summary:")
    if marker < 0:
        return {}, [Unavailable(name=name, reason="summary_not_found") for name, _, _ in _FIELDS]
    summary = text[marker:]
    for name, pattern, unit in _FIELDS:
        found = pattern.search(summary)
        try:
            value = float(found.group(1)) if found else None
        except ValueError:
            value = None
        if value is None or not math.isfinite(value):
            missing.append(Unavailable(name=name, reason="parse_failed"))
        else:
            quantities[name] = quantity(value, unit, "measured", _METHOD)  # type: ignore[arg-type]
    return quantities, missing


def loudness_argv(fd: int, demuxer: str) -> list[str]:
    argv = ffmpeg_command(
        fd,
        input_options=input_options(demuxer),
        output_args=[
            "-map", "0:a:0", "-vn", "-sn", "-dn",
            "-af", LOUDNESS_FILTER,
            "-f", "null", "-",
        ],
    )  # fmt: skip
    argv[argv.index("-loglevel") + 1] = "info"  # the summary is an info-level message
    argv[1:1] = GLOBAL_ARGS
    return argv


def measure_loudness(
    runner: SandboxRunner, fd: int, demuxer: str, *, timeout_s: float, cancel: Cancellable | None
) -> tuple[dict[str, Quantity], list[Unavailable]]:
    rewind(fd)
    result = runner.run(
        loudness_argv(fd, demuxer),
        stdout_sink=lambda _data: None,
        timeout_s=timeout_s,
        input_fd=fd,
        cancel=cancel,
    )
    raise_for_outcome(result)
    if result.returncode != 0:
        return {}, [Unavailable(name=name, reason="loudness_pass_failed") for name, _, _ in _FIELDS]
    return parse_summary(result.stderr)
