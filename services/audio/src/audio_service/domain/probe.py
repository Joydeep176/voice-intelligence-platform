"""`probe` task (plan §3, §6.1): sniff, ffprobe through the sandbox runner, limits, trial decode.

Nothing from the container's tags or metadata leaves this module: ffprobe is asked for an explicit
list of numeric/technical fields (`-show_entries`), never `-show_format` tags, and the only tag
looked at is the presence of `iTunSMPB` (a gapless marker), as a boolean. stderr is classified into
codes inside this module and discarded.
"""

from __future__ import annotations

import json
import math
import os
from collections.abc import Callable
from typing import Any, Literal

from audio_service.contracts import (
    ErrorCode,
    GaplessInfo,
    ProbeResult,
    ProbeTools,
    TimelineSource,
    TrialDecode,
)
from audio_service.domain.errors import TaskCancelled, TaskFailure
from audio_service.domain.ffmpeg_args import ffmpeg_command, ffprobe_command
from audio_service.domain.media_args import (
    FFPROBE_JSON_CAP_BYTES,
    GLOBAL_ARGS,
    classify_stderr,
    input_options,
    refusal_code_hint,
)
from audio_service.domain.media_io import raise_for_outcome, rewind
from audio_service.domain.media_limits import MediaLimits, resolve_limits
from audio_service.domain.media_sniff import sniff
from audio_service.domain.packets import PacketScan, PacketScanner, PacketStreamError
from audio_service.domain.runner import (
    STDERR_CAP_BYTES,
    Cancellable,
    RunResult,
    SandboxRunner,
)
from audio_service.domain.storage import StorageBackend
from audio_service.domain.tasks import TaskContext

PROBE_TIMEOUT_S = 60.0
TRIAL_DECODE_TIMEOUT_S = 60.0
TRIAL_DECODE_SECONDS = 30
TRIAL_RATE_HZ = 8000
EDGE_PACKETS = 8
TAIL_SECONDS = 1.0

_STREAM_FIELDS = (
    "index,codec_type,codec_name,sample_rate,channels,channel_layout,sample_fmt,"
    "bits_per_raw_sample,bits_per_sample,bit_rate,time_base,start_pts,start_time,duration"
)
_FORMAT_FIELDS = "format_name,duration,start_time,bit_rate,nb_streams"


def _failed_exit_code(result: RunResult) -> ErrorCode:
    if refusal_code_hint(result.stderr) == "whitelist":
        return ErrorCode.UNSUPPORTED_FORMAT
    return ErrorCode.CORRUPT_MEDIA  # a normal non-zero exit; signal deaths never get here


def _run_ffprobe(  # noqa: PLR0913
    runner: SandboxRunner,
    fd: int,
    demuxer: str,
    output_args: list[str],
    *,
    cancel: Cancellable | None,
    timeout_s: float,
    sink: Callable[[bytes], None],
    max_stdout_bytes: int | None,
) -> RunResult:
    rewind(fd)
    argv = ffprobe_command(fd, input_options=input_options(demuxer), output_args=output_args)
    argv[1:1] = GLOBAL_ARGS
    return runner.run(
        argv,
        stdout_sink=sink,
        timeout_s=timeout_s,
        input_fd=fd,
        max_stdout_bytes=max_stdout_bytes,
        cancel=cancel,
    )


def _number(value: Any) -> float | None:
    if isinstance(value, bool) or value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _int(value: Any) -> int | None:
    number = _number(value)
    return None if number is None else int(number)


def _positive_ms(seconds: float | None) -> int | None:
    return None if seconds is None or seconds < 0 else round(seconds * 1000)


def _select_audio(streams: list[dict[str, Any]]) -> tuple[dict[str, Any], int, int]:
    audio = [s for s in streams if s.get("codec_type") == "audio"]
    if not audio:
        raise TaskFailure(ErrorCode.NO_DECODABLE_AUDIO)
    return audio[0], len(streams), len(audio)


def edge_packets(
    runner: SandboxRunner,
    fd: int,
    demuxer: str,
    *,
    duration_s: float | None,
    cancel: Cancellable | None,
) -> PacketScan | None:
    """First packets and the last second of packets, for priming and padding side data. Best
    effort: any failure returns None (the probe then reports unknown instead of failing)."""
    interval = f"%+#{EDGE_PACKETS}"
    if duration_s is not None and duration_s > TAIL_SECONDS:
        interval += f",{duration_s - TAIL_SECONDS:.3f}%"
    scanner = PacketScanner(1)
    try:
        result = _run_ffprobe(
            runner,
            fd,
            demuxer,
            [
                "-select_streams",
                "a:0",
                "-read_intervals",
                interval,
                "-show_entries",
                "packet=pts,dts,duration,flags:packet_side_data",
                "-of",
                "csv=p=0",
            ],
            cancel=cancel,
            timeout_s=PROBE_TIMEOUT_S,
            sink=scanner.feed,
            max_stdout_bytes=FFPROBE_JSON_CAP_BYTES,
        )
        raise_for_outcome(result)
        if result.returncode != 0:
            return None
        return scanner.finish()
    except PacketStreamError:
        return None
    except TaskCancelled:
        raise
    except TaskFailure as failure:
        if failure.code in (ErrorCode.TIMEOUT, ErrorCode.RESOURCE_EXHAUSTED):
            raise  # host conditions are never swallowed as "edge packets unavailable"
        return None


def classify_gapless(  # noqa: PLR0911, PLR0913
    container: str,
    codec: str,
    *,
    skip_samples: int | None,
    first_pts: int | None,
    start_ms: float | None,
    itunsmpb: bool,
) -> tuple[GaplessInfo, bool | Literal["unknown"]]:
    """(gaplessInfo, editListPresent) from container facts. `editListPresent` is `unknown` for MOV
    without evidence: telling would mean parsing the `elst` box, which Python does not do."""
    primed = (skip_samples or 0) > 0
    if container == "mp3":
        return ("lame" if primed else "none"), False
    if container == "mp4":
        offset = (first_pts is not None and first_pts < 0) or (start_ms or 0) > 0
        if itunsmpb:
            return "itunsmpb", True
        if primed or offset:
            return "edit_list", True
        return "unknown", "unknown"
    if container in ("ogg", "matroska") and codec == "opus":
        return ("codec_preskip" if primed else "none"), False
    if container in ("wav", "flac", "ogg", "matroska"):
        return "none", False
    return "unknown", False


def trial_decode(
    runner: SandboxRunner, fd: int, demuxer: str, *, cancel: Cancellable | None
) -> tuple[int, int]:
    """Decode the first 30 s to a discarded sink. Returns (decoded bytes, error-ish lines)."""
    rewind(fd)
    counted = 0

    def sink(data: bytes) -> None:
        nonlocal counted
        counted += len(data)  # discarded: only the amount matters

    argv = ffmpeg_command(
        fd,
        input_options=input_options(demuxer),
        output_args=[
            "-map",
            "0:a:0",
            "-vn",
            "-sn",
            "-dn",
            "-t",
            str(TRIAL_DECODE_SECONDS),
            "-ac",
            "1",
            "-ar",
            str(TRIAL_RATE_HZ),
            "-f",
            "s16le",
            "-acodec",
            "pcm_s16le",
            "-",
        ],
    )
    argv[1:1] = GLOBAL_ARGS
    result = runner.run(
        argv, stdout_sink=sink, timeout_s=TRIAL_DECODE_TIMEOUT_S, input_fd=fd, cancel=cancel
    )
    raise_for_outcome(result)  # also: a signal-killed decode is a host condition, not a file fact
    classes = classify_stderr(result.stderr, cap=STDERR_CAP_BYTES)
    if counted == 0:
        if classes.whitelist_refusals:
            raise TaskFailure(ErrorCode.UNSUPPORTED_FORMAT)
        # Nothing decoded: if the decoder saw packets and rejected them the audio is undecodable;
        # if there were no packets at all the file ends right after its header.
        raise TaskFailure(
            ErrorCode.NO_DECODABLE_AUDIO if classes.decode_errors else ErrorCode.CORRUPT_MEDIA
        )
    # A normal non-zero exit with output is decoder evidence too (counted as one error).
    return counted, classes.decode_errors + (1 if result.returncode != 0 else 0)


def probe_media(  # noqa: PLR0912, PLR0915
    runner: SandboxRunner,
    fd: int,
    limits: MediaLimits,
    *,
    cancel: Cancellable | None = None,
) -> ProbeResult:
    sniffed = sniff(fd)
    chunks = bytearray()
    entries = f"format={_FORMAT_FIELDS}:stream={_STREAM_FIELDS}:program_version=version"
    if sniffed.demuxer == "mov":
        entries += ":format_tags=iTunSMPB"
    result = _run_ffprobe(
        runner,
        fd,
        sniffed.demuxer,
        ["-show_entries", entries, "-of", "json"],
        cancel=cancel,
        timeout_s=PROBE_TIMEOUT_S,
        sink=chunks.extend,
        max_stdout_bytes=FFPROBE_JSON_CAP_BYTES,
    )
    raise_for_outcome(result)
    if result.returncode != 0:
        raise TaskFailure(_failed_exit_code(result))
    try:
        document = json.loads(bytes(chunks))
        streams = list(document.get("streams") or [])
        fmt = dict(document.get("format") or {})
        version = str((document.get("program_version") or {}).get("version") or "unknown")
    except (ValueError, TypeError, AttributeError):
        raise TaskFailure(ErrorCode.CORRUPT_MEDIA) from None

    stream, stream_count, audio_count = _select_audio(streams)
    warnings: list[str] = []
    if audio_count > 1:
        warnings.append("multiple_audio_streams")
    if stream_count > audio_count:
        warnings.append("non_audio_streams_ignored")

    sample_rate = _int(stream.get("sample_rate"))
    channels = _int(stream.get("channels"))
    codec = stream.get("codec_name")
    sample_fmt = stream.get("sample_fmt")
    if not sample_rate or sample_rate < 1 or not channels or channels < 1:
        raise TaskFailure(ErrorCode.NO_DECODABLE_AUDIO)
    if not isinstance(codec, str) or not codec or not isinstance(sample_fmt, str) or not sample_fmt:
        raise TaskFailure(ErrorCode.NO_DECODABLE_AUDIO)
    if channels > limits.max_channels or sample_rate > limits.max_sample_rate_hz:
        raise TaskFailure(ErrorCode.RESOURCE_LIMIT_EXCEEDED)

    duration_s = _number(stream.get("duration"))
    if duration_s is None:
        duration_s = _number(fmt.get("duration"))
    header_ms = _positive_ms(duration_s)
    if header_ms is None:
        warnings.append("header_duration_unknown")
    elif header_ms > limits.max_duration_ms:
        raise TaskFailure(ErrorCode.DURATION_LIMIT_EXCEEDED)

    start_ticks = _int(stream.get("start_pts"))
    start_s = _number(stream.get("start_time"))
    if start_s is None:
        start_s = _number(fmt.get("start_time"))
    start_ms = None if start_s is None else round(start_s * 1000, 3)
    if start_ticks is None and start_ms is None:
        warnings.append("stream_start_time_unknown")

    edges = edge_packets(runner, fd, sniffed.demuxer, duration_s=duration_s, cancel=cancel)
    if edges is None:
        warnings.append("edge_packets_unavailable")
    skip = None if edges is None else edges.skip_samples_first
    padding = None if edges is None else edges.discard_padding_last
    itunsmpb = isinstance(fmt.get("tags"), dict) and "iTunSMPB" in fmt["tags"]
    gapless, edit_list = classify_gapless(
        sniffed.container,
        codec,
        skip_samples=skip,
        first_pts=None if edges is None else edges.first_pts,
        start_ms=start_ms,
        itunsmpb=itunsmpb,
    )

    decoded_bytes, trial_errors = trial_decode(runner, fd, sniffed.demuxer, cancel=cancel)
    if trial_errors:
        warnings.append("trial_decode_errors")

    raw_bits = _int(stream.get("bits_per_raw_sample")) or _int(stream.get("bits_per_sample"))
    bit_rate = _int(stream.get("bit_rate"))
    layout = stream.get("channel_layout")
    time_base = str(stream.get("time_base") or "")
    return ProbeResult(
        container=sniffed.container,  # type: ignore[arg-type]
        demuxer=sniffed.demuxer,
        codec=codec,
        sampleRateHz=sample_rate,
        channels=channels,
        channelLayout=layout if isinstance(layout, str) and layout else None,
        sampleFormat=sample_fmt,
        bitsPerRawSample=raw_bits if raw_bits and raw_bits > 0 else None,
        bitRate=bit_rate if bit_rate is not None and bit_rate >= 0 else None,
        headerDurationMs=header_ms,
        streamCount=stream_count,
        audioStreamCount=audio_count,
        trialDecode=TrialDecode(
            decodable=True, decodedMs=round(decoded_bytes * 1000 / (2 * TRIAL_RATE_HZ))
        ),
        timelineSource=TimelineSource(
            timeBase=time_base if _valid_time_base(time_base) else "0/1",
            startTimeTicks=start_ticks,
            startTimeMs=start_ms,
            editListPresent=edit_list,
            encoderDelaySamples=skip,
            paddingSamples=padding,
            gaplessInfo=gapless,
        ),
        warnings=warnings,
        tools=ProbeTools(ffprobe=version),
    )


def _valid_time_base(text: str) -> bool:
    num, _, den = text.partition("/")
    return num.isdigit() and den.isdigit() and int(den) > 0 and len(num) <= 10 and len(den) <= 10


class ProbeHandler:
    """Executor handler for task type `probe`. Storage and runner are resolved per call because
    the application creates them in its lifespan, after the executor exists."""

    def __init__(
        self,
        storage: Callable[[], StorageBackend | None],
        runner: Callable[[], SandboxRunner],
        *,
        max_duration_ms: int,
        max_channels: int,
        max_sample_rate_hz: int,
    ) -> None:
        self._storage = storage
        self._runner = runner
        self._ceilings = {
            "max_duration_ms": max_duration_ms,
            "max_channels": max_channels,
            "max_sample_rate_hz": max_sample_rate_hz,
        }

    def __call__(self, ctx: TaskContext) -> dict[str, Any]:
        storage = self._storage()
        if storage is None:
            raise TaskFailure(ErrorCode.STORAGE_ERROR)
        limits = resolve_limits(ctx.request.config, **self._ceilings)
        ctx.check_cancelled()
        # A probe reads a bounded prefix and trial-decodes 30 s: its task deadline is the base
        # allowance alone, with no per-audio-duration part (interim formula, OD-10 Open).
        ctx.set_audio_duration_ms(0)
        ctx.report_progress("probe", 0.0, 0)
        fd = storage.open_original(ctx.request.input.originalKey, ctx.refs)
        try:
            result = probe_media(self._runner(), fd, limits, cancel=ctx.cancel)
        finally:
            os.close(fd)
        ctx.report_progress("probe", 1.0, result.trialDecode.decodedMs)
        return result.model_dump(mode="json")
