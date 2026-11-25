"""Test-only lab for the timestamp validation (plan §11.3, WS3).

Generates tone-burst fixtures with FFmpeg `lavfi` (never available to production arguments: see
test_ffmpeg_args), runs the real probe / packet scan / streamed decoders / timeline mapping through
the sandbox runner, and measures where the bursts land on the canonical timeline. Shared by the
container tests and `benchmarks/timestamps/run.py`.
"""

from __future__ import annotations

import os
import subprocess  # noqa: S404
from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np

from audio_service.contracts import ProbeResult, Timeline
from audio_service.domain.decoder import (
    CANONICAL_RATE_HZ,
    DecodeMode,
    StreamedDecoder,
    decode_timeout_s,
)
from audio_service.domain.media_limits import MediaLimits
from audio_service.domain.probe import probe_media
from audio_service.domain.runner import SandboxRunner
from audio_service.domain.timeline import build_timeline, scan_packets

LIMITS = MediaLimits(max_duration_ms=14_400_000, max_channels=8, max_sample_rate_hz=192_000)
BURST_STARTS_S = (0.5, 1.25)
BURST_LENGTH_S = 0.04
BURST_HZ = 1000
DURATION_S = 2.0


def ffmpeg(args: Sequence[str], *, timeout: int = 120) -> None:
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *args],
        check=True,
        timeout=timeout,
        stdin=subprocess.DEVNULL,
    )


def burst_source(
    rate: int,
    channels: int,
    *,
    duration_s: float = DURATION_S,
    starts: Sequence[float] = BURST_STARTS_S,
    noise: float = 0.0,
) -> list[str]:
    """lavfi input: cosine bursts that start at full amplitude on exact sample positions."""
    expr = "+".join(
        f"between(t,{start},{start + BURST_LENGTH_S - 1 / rate})"
        f"*0.8*cos(2*PI*{BURST_HZ}*(t-{start}))"
        for start in starts
    )
    if noise:  # low-level noise so truncation fixtures have a body (aevalsrc random() is seeded)
        expr += f"+{noise}*(random(0)*2-1)"
    layout = "mono" if channels == 1 else "stereo"
    exprs = "|".join([expr] * channels)
    return [
        "-f",
        "lavfi",
        "-i",
        f"aevalsrc=exprs='{exprs}':s={rate}:d={duration_s}:c={layout}:n=960",
    ]


def detect_onsets(canonical: np.ndarray[Any, np.dtype[np.int16]], count: int) -> list[float]:
    """Onset times (ms on the canonical timeline): first sample above 25 % of the peak after a
    quiet stretch. Resolution: one canonical sample (0.0625 ms)."""
    x = np.abs(canonical.astype(np.float32))
    if x.size == 0:
        return []
    threshold = 0.25 * float(x.max())
    window = int(0.1 * CANONICAL_RATE_HZ)  # at least 100 ms of silence separates bursts
    onsets: list[float] = []
    index = 0
    while index < x.size and len(onsets) < count:
        above = np.nonzero(x[index:] > threshold)[0]
        if above.size == 0:
            break
        first = index + int(above[0])
        onsets.append(first * 1000 / CANONICAL_RATE_HZ)
        index = first + window + int(BURST_LENGTH_S * CANONICAL_RATE_HZ)
    return onsets


@dataclass
class Analysis:
    probe: ProbeResult
    timeline: Timeline
    canonical: np.ndarray[Any, np.dtype[np.int16]]
    native_frames: int
    onsets_ms: list[float] = field(default_factory=list)


def analyze(runner: SandboxRunner, path: Path, bursts: int = len(BURST_STARTS_S)) -> Analysis:
    """Probe, scan, decode both passes, map: the same steps WS4's preprocess will run."""
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        probe = probe_media(runner, fd, LIMITS)
        timeout = decode_timeout_s(probe.headerDurationMs, max_duration_ms=LIMITS.max_duration_ms)
        scan = scan_packets(runner, fd, probe, timeout_s=timeout)
        native = StreamedDecoder(
            runner,
            fd,
            demuxer=probe.demuxer,
            mode=DecodeMode.NATIVE,
            sample_rate_hz=probe.sampleRateHz,
            channels=probe.channels,
            timeout_s=timeout,
        )
        for _ in native.blocks():
            pass
        canon = StreamedDecoder(
            runner,
            fd,
            demuxer=probe.demuxer,
            mode=DecodeMode.CANONICAL,
            sample_rate_hz=probe.sampleRateHz,
            channels=probe.channels,
            timeout_s=timeout,
        )
        parts = [block.samples for block in canon.blocks()]
        pcm = np.concatenate(parts) if parts else np.zeros(0, dtype=np.int16)
        timeline = build_timeline(probe, scan, native.stats, canon.stats)
    finally:
        os.close(fd)
    return Analysis(probe, timeline, pcm, native.stats.frames, detect_onsets(pcm, bursts))


# -- recipes --------------------------------------------------------------------------------

LOSSLESS_PCM = {"s16": "pcm_s16le", "s24": "pcm_s24le", "s32": "pcm_s32le", "f32": "pcm_f32le"}
LOSSLESS_RATES = (8000, 16000, 44100, 48000, 96000, 192000)


def make_wav(path: Path, rate: int, channels: int, codec: str, *, noise: float = 0.0) -> None:
    ffmpeg([*burst_source(rate, channels, noise=noise), "-c:a", codec, "-f", "wav", str(path)])


def make_flac(path: Path, rate: int, channels: int, bits: int, *, noise: float = 0.0) -> None:
    fmt = "s16" if bits == 16 else "s32"
    ffmpeg(
        [
            *burst_source(rate, channels, noise=noise),
            "-sample_fmt",
            fmt,
            "-c:a",
            "flac",
            "-f",
            "flac",
            str(path),
        ]
    )


@dataclass(frozen=True)
class LossyRecipe:
    name: str
    rate: int
    channels: int
    output: tuple[str, ...]  # output codec/format arguments
    extension: str

    def make(self, path: Path, *, offset_s: float = 0.0, noise: float = 0.0) -> None:
        pre = ["-itsoffset", str(offset_s)] if offset_s else []
        ffmpeg(
            [*pre, *burst_source(self.rate, self.channels, noise=noise), *self.output, str(path)]
        )


LOSSY = (
    LossyRecipe("mp3_cbr_lame", 44100, 1, ("-c:a", "libmp3lame", "-b:a", "128k"), "mp3"),
    LossyRecipe(
        "mp3_cbr_no_xing",
        44100,
        1,
        ("-c:a", "libmp3lame", "-b:a", "128k", "-write_xing", "0"),
        "mp3",
    ),
    LossyRecipe("mp3_vbr_xing", 44100, 2, ("-c:a", "libmp3lame", "-q:a", "4"), "mp3"),
    LossyRecipe(
        "mp3_vbr_no_xing",
        44100,
        2,
        ("-c:a", "libmp3lame", "-q:a", "4", "-write_xing", "0"),
        "mp3",
    ),
    LossyRecipe("m4a_aac", 44100, 2, ("-c:a", "aac", "-b:a", "96k", "-f", "mp4"), "m4a"),
    LossyRecipe("ogg_vorbis", 44100, 2, ("-c:a", "libvorbis", "-q:a", "4", "-f", "ogg"), "ogg"),
    LossyRecipe("ogg_opus", 48000, 2, ("-c:a", "libopus", "-b:a", "64k", "-f", "ogg"), "opus"),
    LossyRecipe("webm_opus", 48000, 2, ("-c:a", "libopus", "-b:a", "64k", "-f", "webm"), "webm"),
)


# -- damaged inputs -------------------------------------------------------------------------

GAP_AT_S = 2.0
GAP_JUMP_S = 1.0
GAP_BURSTS = (0.5, 3.0)  # one before the gap, one after (source time)


def make_timestamp_gap(path: Path, codec: str = "pcm_s16le") -> None:
    """48 kHz audio in Matroska whose timestamps jump by 1 s after sample 96000 (frames are 960
    samples, so the jump falls on a packet boundary at exactly 2.0 s). With PCM the packet
    boundary is the jump; with Opus the encoder's own delay and framing blur it by up to a
    packet."""
    ffmpeg(
        [
            *burst_source(48000, 1, duration_s=4.0, starts=GAP_BURSTS),
            "-af",
            f"asetpts='if(gte(N,{int(GAP_AT_S * 48000)}),PTS+{GAP_JUMP_S}/TB,PTS)'",
            "-c:a",
            codec,
            "-f",
            "matroska",
            str(path),
        ]
    )


def make_dropped_packets(path: Path, first: int, count: int, codec: str = "libopus") -> None:
    """Matroska with `count` consecutive packets removed (20 ms each) from packet `first`."""
    clean = path.with_suffix(".clean.mkv")
    ffmpeg(
        [
            *burst_source(48000, 1, duration_s=4.0, starts=GAP_BURSTS),
            "-c:a",
            codec,
            "-f",
            "matroska",
            str(clean),
        ]
    )
    ffmpeg(
        [
            "-i",
            str(clean),
            "-c",
            "copy",
            "-bsf:a",
            f"noise=drop='between(n\\,{first}\\,{first + count - 1})'",
            "-f",
            "matroska",
            str(path),
        ]
    )
    clean.unlink()


def truncate(path: Path, fraction: float) -> int:
    size = path.stat().st_size
    keep = int(size * fraction)
    with path.open("r+b") as handle:
        handle.truncate(keep)
    return keep


# -- measured cases (shared by the container tests and benchmarks/timestamps/run.py) --------


def _round(value: float | None, places: int = 3) -> float | None:
    return None if value is None else round(value, places)


def summarize(a: Analysis) -> dict[str, Any]:
    t = a.timeline
    return {
        "container": a.probe.container,
        "codec": a.probe.codec,
        "mappingStatus": t.mappingStatus,
        "mappingErrorBoundMs": _round(t.mappingErrorBoundMs),
        "reasons": list(t.reasons),
        "sourceOffsetMs": _round(t.sourceOffsetMs),
        "gaplessInfo": t.source.gaplessInfo,
        "editListPresent": t.source.editListPresent,
        "encoderDelaySamples": t.source.encoderDelaySamples,
        "paddingSamples": t.source.paddingSamples,
        "decodeClass": t.decodeClass,
        "decodedUntilMs": _round(t.decodedUntilMs),
        "headerDurationMs": t.source.headerDurationMs,
        "canonicalSamples": t.canonicalSamples,
        "decodedSamplesNative": t.decodedSamplesNative,
        "gaps": [(g.startMs, g.durationMs) for g in t.gaps],
        "decodeErrors": t.decodeErrors.count,
        "onsetsMs": [_round(o) for o in a.onsets_ms],
    }


def lossless_case(  # noqa: PLR0913, PLR0917 - one flat parameter per grid axis
    runner: SandboxRunner, directory: Path, kind: str, rate: int, channels: int, depth: str
) -> dict[str, Any]:
    path = directory / f"case.{'wav' if kind == 'wav' else 'flac'}"
    if kind == "wav":
        make_wav(path, rate, channels, LOSSLESS_PCM[depth])
    else:
        make_flac(path, rate, channels, 16 if depth == "s16" else 24)
    try:
        a = analyze(runner, path)
    finally:
        path.unlink(missing_ok=True)
    errors = [o - s * 1000 for o, s in zip(a.onsets_ms, BURST_STARTS_S, strict=False)]
    return {
        "id": f"{kind}-{depth}-{rate}-{channels}ch",
        "kind": kind,
        "depth": depth,
        "rateHz": rate,
        "channels": channels,
        "onsetErrorMs": [_round(e) for e in errors],
        "maxAbsOnsetErrorMs": _round(max((abs(e) for e in errors), default=None), 4),
        "burstsFound": len(a.onsets_ms),
        **summarize(a),
    }


def lossy_case(
    runner: SandboxRunner, directory: Path, recipe: LossyRecipe, offset_s: float
) -> dict[str, Any]:
    path = directory / f"case.{recipe.extension}"
    recipe.make(path, offset_s=offset_s)
    try:
        a = analyze(runner, path)
    finally:
        path.unlink(missing_ok=True)
    carried = offset_s if recipe.extension != "mp3" else 0.0  # MP3 has no timestamps to carry
    offset_ms = a.timeline.sourceOffsetMs or 0.0
    error_c = [o - s * 1000 for o, s in zip(a.onsets_ms, BURST_STARTS_S, strict=False)]
    error_s = [
        o + offset_ms - (s + carried) * 1000
        for o, s in zip(a.onsets_ms, BURST_STARTS_S, strict=False)
    ]
    bound = a.timeline.mappingErrorBoundMs
    worst = max((abs(e) for e in error_s), default=None)
    return {
        "id": f"{recipe.name}{'+offset' if offset_s else ''}",
        "format": recipe.name,
        "leadingOffsetS": offset_s,
        "offsetCarriedByContainerS": carried,
        "onsetErrorOnCanonicalMs": [_round(e) for e in error_c],
        "onsetErrorOnSourceMs": [_round(e) for e in error_s],
        "maxAbsErrorOnSourceMs": _round(worst, 4),
        "boundContainsError": bound is not None and worst is not None and worst <= bound,
        "burstsFound": len(a.onsets_ms),
        **summarize(a),
    }


def oracle_decoded_ms(path: Path) -> float:
    """Independent count of decodable audio: plain FFmpeg (no sandbox, no timeline logic)."""
    command = ["ffmpeg", "-hide_banner", "-loglevel", "quiet", "-i", str(path)]
    command += ["-ac", "1", "-ar", "16000", "-f", "s16le", "-"]
    out = subprocess.run(
        command, capture_output=True, check=False, timeout=120, stdin=subprocess.DEVNULL
    )
    return len(out.stdout) / 2 * 1000 / CANONICAL_RATE_HZ


def damaged_gap_case(
    runner: SandboxRunner, directory: Path, codec: str, *, drop: int | None = None
) -> dict[str, Any]:
    path = directory / "case.mkv"
    if drop is None:
        make_timestamp_gap(path, codec)
        expected_start, expected_duration = GAP_AT_S * 1000, GAP_JUMP_S * 1000
        kind = "timestamp_gap"
    else:
        make_dropped_packets(path, 100, drop, codec)
        expected_start, expected_duration = 100 * 20.0, drop * 20.0
        kind = f"dropped_{drop}_packets"
    try:
        a = analyze(runner, path, bursts=2)
    finally:
        path.unlink(missing_ok=True)
    s = summarize(a)
    gap = s["gaps"][0] if s["gaps"] else None
    return {
        "id": f"{kind}-{codec}",
        "kind": kind,
        "codec": codec,
        "expectedGapStartMs": expected_start,
        "expectedGapDurationMs": expected_duration,
        "gapStartErrorMs": None if gap is None else _round(gap[0] - expected_start),
        "gapDurationErrorMs": None if gap is None else _round(gap[1] - expected_duration),
        **{k: v for k, v in s.items() if k != "codec"},
    }


def _noisy_maker(recipe: LossyRecipe) -> Any:
    return lambda path: recipe.make(path, noise=0.01)


def _faststart_m4a(path: Path) -> None:
    source = burst_source(44100, 2, noise=0.01)
    ffmpeg([*source, "-c:a", "aac", "-movflags", "faststart", "-f", "mp4", str(path)])


def truncated_cases(runner: SandboxRunner, directory: Path) -> list[dict[str, Any]]:
    """Each format cut at 60 % of its bytes (noise added so the body is not a few hundred bytes)."""
    makers: dict[str, Any] = {
        "wav_pcm_s16": ("wav", lambda p: make_wav(p, 16000, 1, "pcm_s16le", noise=0.01)),
        "flac": ("flac", lambda p: make_flac(p, 16000, 1, 16, noise=0.01)),
    }
    for recipe in LOSSY:
        makers[recipe.name] = (recipe.extension, _noisy_maker(recipe))
    makers["m4a_aac"] = ("m4a", _faststart_m4a)  # moov first, so a cut leaves a readable header
    rows = []
    for name, (extension, make) in makers.items():
        path = directory / f"case.{extension}"
        make(path)
        full_bytes = path.stat().st_size
        kept = truncate(path, 0.6)
        try:
            a = analyze(runner, path, bursts=1)
            oracle = oracle_decoded_ms(path)
        finally:
            path.unlink(missing_ok=True)
        s = summarize(a)
        rows.append(
            {
                "id": f"truncated-{name}",
                "format": name,
                "bytesKept": kept,
                "bytesFull": full_bytes,
                "oracleDecodedMs": _round(oracle),
                "decodedUntilErrorMs": _round((s["decodedUntilMs"] or 0.0) - oracle),
                **s,
            }
        )
    return rows


def corrupted_cases(runner: SandboxRunner, directory: Path) -> list[dict[str, Any]]:
    import random

    rnd = random.Random(1)  # noqa: S311 - fixed seed
    rows = []
    picks = (("mp3_cbr_lame", LOSSY[0]), ("ogg_opus", LOSSY[6]), ("m4a_aac", LOSSY[4]))
    for name, recipe in picks:
        path = directory / f"case.{recipe.extension}"
        recipe.make(path, noise=0.01)
        data = bytearray(path.read_bytes())
        start = len(data) // 2
        for index in range(start, start + 600):
            data[index] = rnd.randrange(256)
        path.write_bytes(bytes(data))
        try:
            a = analyze(runner, path, bursts=1)
            oracle = oracle_decoded_ms(path)
        finally:
            path.unlink(missing_ok=True)
        rows.append(
            {
                "id": f"corrupted-{name}",
                "format": name,
                "oracleDecodedMs": _round(oracle),
                **summarize(a),
            }
        )
    return rows
