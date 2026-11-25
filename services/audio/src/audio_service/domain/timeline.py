"""Packet timeline scan and the mapping record (plan §11.2).

`scan_packets` streams `ffprobe -show_entries packet=...` through the sandbox runner and parses it
incrementally (`packets.PacketScanner`), so a four-hour file never sits in memory. `build_timeline`
combines the probe result, that scan and the two decoder passes into the `Timeline` record and its
`mappingStatus`, which never claims more precision than the evidence allows:

- exact: lossless codec, no gaps/overlaps/errors, complete decode, source offset 0, no gapless
  metadata involved.
- offset_applied: the container's declared offset / edit list / priming metadata was applied by
  FFmpeg (lossless with an offset, or lossy with gapless information).
- approximate: lossy without gapless information; bound = one codec frame (longest packet seen).
- uncertain: gaps, overlaps, missing or non-monotonic PTS, decoder errors, partial decode, or no
  packet scan.

`ERROR_BOUND_*` constants are calibrated against the measurements in
`docs/development/phase2b-timestamps/`.
"""

from __future__ import annotations

from fractions import Fraction

from audio_service.contracts import (
    DecodeClass,
    ErrorCode,
    MappingStatus,
    ProbeResult,
    Timeline,
    TimelineDecodeErrors,
    TimelineGap,
    TimelineOverlap,
    TimelineSourceRecord,
)
from audio_service.domain.decoder import CANONICAL_RATE_HZ, DecodeStats
from audio_service.domain.errors import TaskFailure
from audio_service.domain.ffmpeg_args import ffprobe_command
from audio_service.domain.media_args import GLOBAL_ARGS, LOSSLESS_CODEC, input_options
from audio_service.domain.media_io import raise_for_outcome, rewind
from audio_service.domain.packets import PacketScan, PacketScanner, PacketStreamError, TimelineEvent
from audio_service.domain.runner import Cancellable, SandboxRunner

SCAN_STDOUT_CAP_BYTES = 128 * 1024 * 1024
HARD_COMPENSATION_MS = 20.0  # CANONICAL_FILTER's min_hard_comp: smaller gaps are not filled
OFFSET_EPSILON_MS = 0.05
PRIMING_MATCH_MS = 0.1
VORBIS_CODEC = "vorbis"
VORBIS_LONG_BLOCK = 1024  # samples
DECODE_TOLERANCE_MS = 100.0  # plus one packet: header/estimate slack before a decode is "partial"
CANONICAL_SAMPLE_MS = 1000 / CANONICAL_RATE_HZ
# One canonical sample: the resampler phase the plan allows (lossless, or lossy with exact gapless
# metadata). Revisit with measurements.
ERROR_BOUND_LOSSLESS_MS = CANONICAL_SAMPLE_MS
ERROR_BOUND_GAPLESS_LOSSY_MS = 2.0


def time_base_fraction(text: str) -> Fraction:
    num, _, den = text.partition("/")
    if not (num.isdigit() and den.isdigit() and int(den) > 0 and int(num) > 0):
        raise TaskFailure(ErrorCode.CORRUPT_MEDIA)
    return Fraction(int(num), int(den))


def scan_packets(
    runner: SandboxRunner,
    fd: int,
    probe: ProbeResult,
    *,
    timeout_s: float,
    cancel: Cancellable | None = None,
) -> PacketScan:
    """Stream the packet list of the first audio stream (TIMEOUT, CANCELLED or CORRUPT_MEDIA)."""
    tb = time_base_fraction(probe.timelineSource.timeBase)
    floor_s = Fraction(1, 1000)
    if probe.codec == VORBIS_CODEC:
        # Measured: Vorbis block switching makes pts deltas differ from packet durations by up to
        # about half a long block, so healthy files would be flagged with a tighter tolerance.
        floor_s = max(floor_s, Fraction(VORBIS_LONG_BLOCK, probe.sampleRateHz))
    scanner = PacketScanner(int(floor_s / tb) or 1)
    rewind(fd)
    argv = ffprobe_command(
        fd,
        input_options=input_options(probe.demuxer),
        output_args=[
            "-select_streams",
            "a:0",
            "-show_entries",
            "packet=pts,dts,duration,flags:packet_side_data",
            "-of",
            "csv=p=0",
        ],
    )
    argv[1:1] = GLOBAL_ARGS
    try:
        result = runner.run(
            argv,
            stdout_sink=scanner.feed,
            timeout_s=timeout_s,
            input_fd=fd,
            max_stdout_bytes=SCAN_STDOUT_CAP_BYTES,
            cancel=cancel,
        )
        raise_for_outcome(result)
        if result.returncode != 0:
            raise TaskFailure(ErrorCode.CORRUPT_MEDIA)
        return scanner.finish()
    except PacketStreamError:
        raise TaskFailure(ErrorCode.CORRUPT_MEDIA) from None


def _ms(ticks: int | Fraction, tb: Fraction) -> float:
    return round(float(Fraction(ticks) * tb * 1000), 3)


def _origin_ticks(probe: ProbeResult, scan: PacketScan | None) -> int | None:
    start = probe.timelineSource.startTimeTicks
    if start is not None:
        return start
    return None if scan is None else scan.first_pts


def expected_canonical_ms(probe: ProbeResult, scan: PacketScan | None) -> float | None:
    """Duration C should have if every packet decoded: packet end minus the stream origin, minus
    the end padding the decoder trims. Falls back to the header duration only when the header is
    reliable (an MP3 header without Xing/LAME data is an estimate, so it is not used)."""
    source = probe.timelineSource
    candidates: list[float] = []
    origin = _origin_ticks(probe, scan)
    if scan is not None and scan.last_end is not None and origin is not None:
        tb = time_base_fraction(source.timeBase)
        end_ms = float(Fraction(scan.last_end - origin) * tb * 1000)
        padding_ms = (source.paddingSamples or 0) * 1000 / probe.sampleRateHz
        candidates.append(end_ms - padding_ms)
    reliable_header = not (probe.container == "mp3" and source.gaplessInfo != "lame")
    if probe.headerDurationMs is not None and reliable_header:
        # Container durations may run to the end timestamp, i.e. include a leading offset.
        lead = max(0.0, source.startTimeMs or 0.0)
        candidates.append(float(probe.headerDurationMs) - lead)
    return max(candidates) if candidates else None


def classify_decode(
    canonical: DecodeStats, *, expected_ms: float | None, tolerance_ms: float
) -> tuple[DecodeClass, float | None]:
    """`full | partial | none` and `decodedUntilMs` on C. Never pads to the header duration."""
    if canonical.frames == 0:
        return "none", None
    until = round(canonical.duration_ms, 3)
    short = expected_ms is not None and until < expected_ms - tolerance_ms
    if not canonical.clean_exit or short:
        return "partial", until
    return "full", until


def _discount_trimmed_priming(probe: ProbeResult, offset_ms: float | None) -> float | None:
    """FFmpeg 7.1.5's MP3 demuxer reports `start_time` equal to the LAME priming (for example
    1105 samples = 25.057 ms at 44.1 kHz) although the decoder removes exactly those samples, so
    the first decoded sample is signal sample 0 (measured: onset error 0.000 ms). The offset is
    therefore the reported start minus the trimmed priming, but only when they agree to 0.1 ms;
    MP4 and Opus streams already report their start after priming, so they are left alone."""
    source = probe.timelineSource
    if offset_ms is None or probe.container != "mp3" or source.gaplessInfo != "lame":
        return offset_ms
    priming_ms = (source.encoderDelaySamples or 0) * 1000 / probe.sampleRateHz
    if priming_ms and abs(offset_ms - priming_ms) <= PRIMING_MATCH_MS:
        return round(offset_ms - priming_ms, 3)
    return offset_ms


def _events_on_c(
    events: list[TimelineEvent], origin: int | None, tb: Fraction
) -> list[tuple[float, float]]:
    base = 0 if origin is None else origin
    return [(max(0.0, _ms(e.at_ticks - base, tb)), _ms(e.duration_ticks, tb)) for e in events]


def build_timeline(  # noqa: PLR0912, PLR0915 - one rule per reason keeps the logic auditable
    probe: ProbeResult,
    scan: PacketScan | None,
    native: DecodeStats,
    canonical: DecodeStats,
) -> Timeline:
    source = probe.timelineSource
    tb = time_base_fraction(source.timeBase)
    origin = _origin_ticks(probe, scan)
    offset_ms = _ms(origin, tb) if origin is not None else source.startTimeMs
    offset_ms = _discount_trimmed_priming(probe, offset_ms)
    packet_ms = 0.0 if scan is None else _ms(scan.max_duration_ticks, tb)
    expected = expected_canonical_ms(probe, scan)
    decode_class, until = classify_decode(
        canonical, expected_ms=expected, tolerance_ms=DECODE_TOLERANCE_MS + packet_ms
    )

    gaps = [
        TimelineGap(startMs=start, durationMs=duration, kind="timestamp_gap_filled")
        for start, duration in _events_on_c([] if scan is None else scan.gaps, origin, tb)
        if duration >= HARD_COMPENSATION_MS
    ]
    unfilled = (0 if scan is None else scan.gap_count) - len(gaps)
    overlaps = [
        TimelineOverlap(atMs=at, durationMs=duration)
        for at, duration in _events_on_c([] if scan is None else scan.overlaps, origin, tb)
    ]
    error_count = max(native.errors.decode_errors, canonical.errors.decode_errors)
    first_error = (
        None
        if canonical.first_error_frame is None or not error_count
        else round(canonical.first_error_frame * 1000 / CANONICAL_RATE_HZ, 3)
    )

    reasons: list[str] = []
    if scan is None:
        reasons.append("packet_scan_unavailable")
    else:
        if scan.gap_count:
            reasons.append("timestamp_gaps")
        if unfilled > 0:
            reasons.append("timestamp_gaps_below_fill_threshold")
        if scan.overlap_count:
            reasons.append("timestamp_overlaps")
        if scan.missing_pts:
            reasons.append("missing_pts")
        if scan.non_monotonic:
            reasons.append("non_monotonic_pts")
        if scan.corrupt_packets:
            reasons.append("corrupt_packets")
    if origin is None:
        reasons.append("source_start_unknown")
    if error_count:
        reasons.append("decoder_errors")
    if canonical.errors.compensation_failures:
        reasons.append("timestamp_compensation_failed")
    if decode_class != "full":
        reasons.append("partial_decode" if decode_class == "partial" else "nothing_decoded")

    status: MappingStatus
    bound: float | None
    if reasons:
        status, bound = "uncertain", None
    else:
        lossless = bool(LOSSLESS_CODEC.match(probe.codec))
        gapless = source.gaplessInfo in ("lame", "itunsmpb", "edit_list", "codec_preskip")
        has_offset = offset_ms is not None and abs(offset_ms) >= OFFSET_EPSILON_MS
        if lossless:
            if has_offset or gapless:
                status, bound = "offset_applied", ERROR_BOUND_LOSSLESS_MS
                reasons.append("declared_offset" if has_offset else f"gapless_{source.gaplessInfo}")
            else:
                status, bound = "exact", ERROR_BOUND_LOSSLESS_MS
                reasons.append("lossless_no_gaps")
        elif gapless:
            status, bound = "offset_applied", ERROR_BOUND_GAPLESS_LOSSY_MS
            reasons.append(f"gapless_{source.gaplessInfo}")
        else:
            status, bound = "approximate", max(packet_ms, CANONICAL_SAMPLE_MS)
            reasons.append("lossy_no_gapless_info")
            if has_offset:
                reasons.append("declared_offset")

    return Timeline(
        schemaVersion=1,
        nativeSampleRate=native.sample_rate_hz,
        decodedSamplesNative=native.frames,
        canonicalSamples=canonical.frames,
        source=TimelineSourceRecord(**source.model_dump(), headerDurationMs=probe.headerDurationMs),
        sourceOffsetMs=offset_ms,
        decodeClass=decode_class,
        decodedUntilMs=until,
        gaps=gaps,
        overlapsTrimmed=overlaps,
        decodeErrors=TimelineDecodeErrors(count=error_count, firstAtMs=first_error),
        mappingStatus=status,
        mappingErrorBoundMs=bound,
        reasons=reasons,
    )
