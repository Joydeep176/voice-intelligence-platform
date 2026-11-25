"""`preprocess` task (plan §3, §5, §8, §9, §11): measurements, canonical WAV and the result record.

Order of work, each step before the next and nothing after a failed check:
1. integrity: the config validates, its recomputed hash equals the output prefix's hash
   (CONFIG_HASH_MISMATCH) and its tool versions equal this service's own (TOOL_VERSION_MISMATCH);
2. reuse: a published manifest whose files all verify against their SHA-256 returns the stored
   result without touching FFmpeg;
3. probe, packet scan, free-space precheck, temp directory;
4. pass A (native rate, every channel, before resampling or downmix), pass B (canonical 16 kHz mono
   s16 streamed into `canonical.wav`) and the EBU R128 pass;
5. with a registered VAD and a `segmentation` config (never in this build: OD-29 is Open, so only
   `vad: {method: "none"}` is accepted), the detector sees the same canonical blocks as pass B and
   its frames are segmented (WS6); with `none` there are no segments;
6. outputs written to the temp directory and published atomically (manifest last).

Any failure or cancellation discards the temp directory (`OutputSession` context manager); no
manifest and no partial output is ever left behind. Nothing here interprets the numbers.
"""

from __future__ import annotations

import json
import os
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any

import numpy as np
from pydantic import ValidationError

from audio_service.contracts import (
    ErrorCode,
    PreprocessArtifacts,
    PreprocessCanonical,
    PreprocessConfig,
    PreprocessResult,
    PreprocessSegment,
    PreprocessSegmentMeasurement,
    PreprocessToolVersions,
    PreprocessVadApplied,
    PreprocessVadNotConfigured,
    Timeline,
    canonical_json,
    config_hash,
)
from audio_service.domain.decoder import (
    CANONICAL_RATE_HZ,
    DecodeMode,
    StreamedDecoder,
    decode_timeout_s,
)
from audio_service.domain.errors import TaskFailure
from audio_service.domain.loudness import measure_loudness
from audio_service.domain.measurements import (
    CanonicalAnalyzer,
    NativeAnalyzer,
    canonical_record,
    full_scale_rule,
    level_series_chunks,
    original_record,
)
from audio_service.domain.media_limits import MediaLimits, resolve_limits
from audio_service.domain.packets import PacketScan
from audio_service.domain.probe import probe_media
from audio_service.domain.runner import SandboxRunner
from audio_service.domain.segmentation import (
    FrameStatsBuilder,
    SegmentationParams,
    measure_segments,
    segment_speech,
    total_ms_of,
)
from audio_service.domain.storage import StorageBackend, storage_failure
from audio_service.domain.tasks import TaskContext
from audio_service.domain.timeline import build_timeline, expected_canonical_ms, scan_packets
from audio_service.domain.vad import FRAME_SAMPLES, VadFactory, VoiceActivityDetector
from audio_service.domain.wav import HEADER_BYTES, WavWriter

CANONICAL_NAME = "canonical.wav"
# A MEASUREMENT series (RMS and sample peak per fixed window of the canonical audio), NOT waveform
# peaks for display. No API or UI may serve it as waveform peaks until OD-39 is decided.
LEVEL_SERIES_NAME = "level-series.json"
RESULT_NAME = "result.json"
OUTPUT_NAMES = frozenset({CANONICAL_NAME, LEVEL_SERIES_NAME, RESULT_NAME})
RESULT_MAX_BYTES = 8 * 1024 * 1024
BYTES_PER_MS = CANONICAL_RATE_HZ * 2 // 1000  # canonical bytes per millisecond (32)
BUDGET_SLACK_FRACTION = 0.10
BUDGET_SLACK_BYTES = 64 * 1024  # resampler rounding on very short inputs
FREE_SPACE_FACTOR = 3


@dataclass(frozen=True)
class ToolVersions:
    """The versions this service actually runs (measured at startup, never configured)."""

    service: str
    python: str
    ffmpeg: str
    numpy: str

    def as_dict(self) -> dict[str, str]:
        return {**self.__dict__, "vad": "none"}


def _bad_config() -> TaskFailure:
    return TaskFailure(ErrorCode.INVALID_CONFIG)


def parse_config(raw: dict[str, Any]) -> PreprocessConfig:
    """Validate, rejecting floats/booleans/null first (the hash is defined on integers only)."""
    try:
        canonical_json(raw)
        return PreprocessConfig.model_validate(raw)
    except (ValueError, ValidationError):
        raise _bad_config() from None


def _segment(  # noqa: PLR0913, PLR0917
    detector: VoiceActivityDetector,
    config: PreprocessConfig,
    frame_stats: FrameStatsBuilder,
    speech_chunks: list[Any],
    frames: int,
    timeline: Timeline,
) -> tuple[PreprocessVadApplied, list[PreprocessSegment], list[PreprocessSegmentMeasurement]]:
    """Rule set of `segmentation.py` applied to the detector's frames (WS6)."""
    assert config.segmentation is not None  # noqa: S101 (the config validator guarantees it)
    speech = np.concatenate(speech_chunks)
    stats = frame_stats.finish()
    if speech.dtype != np.bool_ or speech.size != -(-frames // FRAME_SAMPLES):
        raise TaskFailure(ErrorCode.INTERNAL_ERROR)  # the detector broke its contract
    found = segment_speech(
        speech,
        stats.energy(),
        total_ms=total_ms_of(frames),
        params=SegmentationParams.from_config(config.segmentation),
        gaps=[(g.startMs, g.startMs + g.durationMs) for g in timeline.gaps],
    )
    segments = [
        PreprocessSegment(
            index=s.index,
            startMs=s.start_ms,
            endMs=s.end_ms,
            overlapStartMs=s.overlap_start_ms,
            overlapEndMs=s.overlap_end_ms,
            speechMs=s.speech_ms,
            containsSyntheticGap=s.contains_synthetic_gap,
        )
        for s in found
    ]
    records = measure_segments(stats, found, vad_method=config.vad.method)
    return (
        PreprocessVadApplied(method=config.vad.method, version=detector.version, status="applied"),
        segments,
        [PreprocessSegmentMeasurement(segmentIndex=i, record=r) for i, r in records],
    )


class PreprocessHandler:
    """Executor handler for task type `preprocess`. Storage, runner and tool versions are resolved
    per call because the application creates them in its lifespan."""

    def __init__(  # noqa: PLR0913
        self,
        storage: Callable[[], StorageBackend | None],
        runner: Callable[[], SandboxRunner],
        tool_versions: Callable[[], ToolVersions | None],
        *,
        max_duration_ms: int,
        max_channels: int,
        max_sample_rate_hz: int,
        detectors: Mapping[str, VadFactory] | None = None,
    ) -> None:
        # Registered VAD methods. Empty in `src`: no VAD is selected (OD-29 Open).
        self._detectors: Mapping[str, VadFactory] = detectors or {}
        self._storage = storage
        self._runner = runner
        self._tool_versions = tool_versions
        self._ceilings = {
            "max_duration_ms": max_duration_ms,
            "max_channels": max_channels,
            "max_sample_rate_hz": max_sample_rate_hz,
        }

    def __call__(self, ctx: TaskContext) -> dict[str, Any]:
        storage = self._storage()
        if storage is None:
            raise TaskFailure(ErrorCode.STORAGE_ERROR)
        prefix = ctx.request.input.outputPrefix.removesuffix("/")
        config = parse_config(ctx.request.config)
        if config_hash(ctx.request.config) != prefix.rsplit("/", 1)[-1]:
            raise TaskFailure(ErrorCode.CONFIG_HASH_MISMATCH)
        detector = self._new_detector(config)
        actual = self._tool_versions()
        vad_version = "none" if detector is None else f"{detector.name}:{detector.version}"
        if actual is None or config.toolVersions.model_dump() != {
            **actual.as_dict(),
            "vad": vad_version,
        }:
            raise TaskFailure(ErrorCode.TOOL_VERSION_MISMATCH)
        limits = resolve_limits(config.limits.model_dump(), **self._ceilings)
        ctx.check_cancelled()

        stored = storage.read_verified(
            prefix, ctx.refs, RESULT_NAME, expected_names=OUTPUT_NAMES, max_bytes=RESULT_MAX_BYTES
        )
        if stored is not None:
            try:
                reused = PreprocessResult.model_validate_json(stored)
            except ValidationError:
                reused = None  # damaged or from another schema: recompute and republish
            if reused is not None and reused.toolVersions == config.toolVersions:
                return reused.model_dump(mode="json")

        ctx.report_progress("probe", 0.0, 0)
        fd = storage.open_original(ctx.request.input.originalKey, ctx.refs)
        try:
            return self._compute(ctx, storage, fd, config, limits, prefix, detector)
        finally:
            os.close(fd)

    def _new_detector(self, config: PreprocessConfig) -> VoiceActivityDetector | None:
        """A fresh detector for the configured method; None for `none`. An unregistered method is
        an invalid config (the schema only checks the name's shape)."""
        if config.vad.method == "none":
            return None
        factory = self._detectors.get(config.vad.method)
        if factory is None:
            raise _bad_config()
        detector = factory()
        if detector.name != config.vad.method:
            raise TaskFailure(ErrorCode.INTERNAL_ERROR)
        return detector

    def _compute(  # noqa: PLR0912, PLR0913, PLR0914, PLR0915, PLR0917
        self,
        ctx: TaskContext,
        storage: StorageBackend,
        fd: int,
        config: PreprocessConfig,
        limits: MediaLimits,
        prefix: str,
        detector: VoiceActivityDetector | None,
    ) -> dict[str, Any]:
        runner = self._runner()
        probe = probe_media(runner, fd, limits, cancel=ctx.cancel)
        timeout = decode_timeout_s(probe.headerDurationMs, max_duration_ms=limits.max_duration_ms)
        warnings = list(probe.warnings)
        scan: PacketScan | None
        try:
            scan = scan_packets(runner, fd, probe, timeout_s=timeout, cancel=ctx.cancel)
        except TaskFailure as failure:
            if failure.code is not ErrorCode.CORRUPT_MEDIA:
                raise
            scan = None
            warnings.append("packet_scan_unavailable")
        ctx.check_cancelled()

        packet_ms = expected_canonical_ms(probe, scan)
        if packet_ms is not None and packet_ms > limits.max_duration_ms:
            raise TaskFailure(ErrorCode.DURATION_LIMIT_EXCEEDED)  # a header that understates it
        known = [v for v in (probe.headerDurationMs, packet_ms) if v is not None]
        expected_ms = float(max(known)) if known else float(limits.max_duration_ms)
        ctx.set_audio_duration_ms(round(expected_ms))  # task deadline: interim formula (OD-10 Open)
        storage.ensure_free_space(
            FREE_SPACE_FACTOR * (int(expected_ms * BYTES_PER_MS) + HEADER_BYTES)
        )
        budget = (
            int(expected_ms * BYTES_PER_MS * (1 + BUDGET_SLACK_FRACTION))
            + HEADER_BYTES
            + BUDGET_SLACK_BYTES
        )

        def progress(stage: str) -> Callable[[int], None]:
            return lambda ms: ctx.report_progress(
                stage, ms / expected_ms if expected_ms else 0.0, ms
            )

        block_ms = config.blockSeconds * 1000
        measurement = config.measurement
        try:
            with storage.begin_output(prefix, ctx.refs, ctx.task_id) as session:
                # -- pass A: native rate, every channel ----------------------------------------
                ctx.report_progress("decode", 0.0, 0)
                rule = full_scale_rule(probe.sampleFormat, probe.bitsPerRawSample)
                native_analyzer = NativeAnalyzer(
                    probe.channels, rule, min_run=measurement.clipping.minRunSamples
                )
                native = StreamedDecoder(
                    runner, fd, demuxer=probe.demuxer, mode=DecodeMode.NATIVE,
                    sample_rate_hz=probe.sampleRateHz, channels=probe.channels,
                    timeout_s=timeout, block_ms=block_ms, cancel=ctx.cancel,
                    on_progress=progress("decode"),
                )  # fmt: skip
                for block in native.blocks():
                    ctx.check_cancelled()
                    native_analyzer.feed(block.samples)  # type: ignore[arg-type]
                native_stats = native_analyzer.finish()
                if native.stats.frames == 0:
                    raise TaskFailure(ErrorCode.NO_DECODABLE_AUDIO)
                if native_stats.non_finite:
                    warnings.append("non_finite_samples_zeroed")

                # -- pass B: canonical 16 kHz mono s16 -> canonical.wav ------------------------
                ctx.report_progress("measure", 0.0, 0)
                writer = WavWriter(session.create_file(CANONICAL_NAME), budget_bytes=budget)
                canon_analyzer = CanonicalAnalyzer(
                    sample_rate_hz=CANONICAL_RATE_HZ, interval_ms=measurement.levelSeriesIntervalMs
                )
                canon = StreamedDecoder(
                    runner, fd, demuxer=probe.demuxer, mode=DecodeMode.CANONICAL,
                    sample_rate_hz=probe.sampleRateHz, channels=probe.channels,
                    timeout_s=timeout, block_ms=block_ms, cancel=ctx.cancel,
                    on_progress=progress("measure"),
                )  # fmt: skip
                frame_stats = FrameStatsBuilder() if detector is not None else None
                speech_chunks: list[Any] = []
                for block in canon.blocks():
                    ctx.check_cancelled()
                    writer.write(block.raw)
                    canon_analyzer.feed(block.samples)  # type: ignore[arg-type]
                    if detector is not None and frame_stats is not None:
                        frame_stats.feed(block.samples)  # type: ignore[arg-type]
                        speech_chunks.append(detector.feed(block.samples))  # type: ignore[arg-type]
                writer.finalize()
                canon_stats = canon_analyzer.finish()
                frames = canon.stats.frames
                if frames == 0:
                    raise TaskFailure(ErrorCode.NO_DECODABLE_AUDIO)
                if writer.data_bytes != frames * 2 or canon_stats.samples != frames:
                    raise TaskFailure(ErrorCode.INTERNAL_ERROR)

                loudness, loudness_missing = measure_loudness(
                    runner, fd, probe.demuxer, timeout_s=timeout, cancel=ctx.cancel
                )

                # -- records and outputs -------------------------------------------------------
                timeline = build_timeline(probe, scan, native.stats, canon.stats)
                if detector is None or frame_stats is None or config.segmentation is None:
                    vad: PreprocessVadApplied | PreprocessVadNotConfigured = (
                        PreprocessVadNotConfigured(method="none", status="not_configured")
                    )
                    segments: list[PreprocessSegment] = []
                    segment_measurements: list[PreprocessSegmentMeasurement] = []
                else:
                    ctx.report_progress("segment", 0.0, 0)
                    speech_chunks.append(detector.finish())
                    vad, segments, segment_measurements = _segment(
                        detector, config, frame_stats, speech_chunks, frames, timeline
                    )
                level_file = session.create_file(LEVEL_SERIES_NAME)
                for chunk in level_series_chunks(canon_stats, sample_rate_hz=CANONICAL_RATE_HZ):
                    level_file.write(chunk)
                sha256, size = session.digest(CANONICAL_NAME)
                if size != HEADER_BYTES + frames * 2:
                    raise TaskFailure(ErrorCode.INTERNAL_ERROR)
                result = PreprocessResult(
                    canonical=PreprocessCanonical(
                        key=f"{prefix}/{CANONICAL_NAME}",
                        sha256=sha256,
                        samples=frames,
                        durationMs=frames * 1000 / CANONICAL_RATE_HZ,
                        sampleRateHz=16000,
                        channels=1,
                        sampleFormat="s16",
                        bytes=size,
                    ),
                    timeline=timeline,
                    measurements=[
                        original_record(
                            native_stats,
                            sample_rate_hz=probe.sampleRateHz,
                            rule=rule,
                            loudness=loudness,
                            loudness_unavailable=loudness_missing,
                        ),
                        canonical_record(
                            canon_stats,
                            sample_rate_hz=CANONICAL_RATE_HZ,
                            silence_threshold_centi_dbfs=measurement.silenceThresholdCentiDbfs,
                        ),
                    ],
                    artifacts=PreprocessArtifacts(
                        levelSeriesKey=f"{prefix}/{LEVEL_SERIES_NAME}",
                        manifestKey=f"{prefix}/manifest.json",
                    ),
                    vad=vad,
                    segments=segments,
                    segmentMeasurements=segment_measurements,
                    toolVersions=PreprocessToolVersions.model_validate(
                        config.toolVersions.model_dump()
                    ),
                    warnings=warnings,
                )
                document = result.model_dump(mode="json")
                session.create_file(RESULT_NAME).write(
                    json.dumps(document, sort_keys=True, separators=(",", ":")).encode()
                )
                ctx.report_progress("write", 0.0, round(frames * 1000 / CANONICAL_RATE_HZ))
                session.publish()
                ctx.report_progress("write", 1.0, round(frames * 1000 / CANONICAL_RATE_HZ))
                return document
        except OSError as error:
            raise storage_failure(error) from None
