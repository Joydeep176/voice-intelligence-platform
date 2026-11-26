"""Pydantic mirrors of the audio-service schemas in packages/contracts/src/audio-service.ts.

Change both together. tests/test_contracts.py validates the shared JSON fixtures in
packages/contracts/fixtures/audio-service, which the TypeScript tests also validate.
"""

from __future__ import annotations

import hashlib
import json
import math
from enum import StrEnum
from typing import Annotated, Any, Literal
from uuid import UUID

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StrictBool,
    StrictFloat,
    StrictInt,
    StringConstraints,
    model_validator,
)

CONTRACT_VERSION = "2"


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class ErrorCode(StrEnum):
    """Stable, content-free failure codes (plan §16, ADR-0035). Mirrors AudioServiceErrorCode."""

    UNSUPPORTED_FORMAT = "UNSUPPORTED_FORMAT"
    CORRUPT_MEDIA = "CORRUPT_MEDIA"
    NO_DECODABLE_AUDIO = "NO_DECODABLE_AUDIO"
    DURATION_LIMIT_EXCEEDED = "DURATION_LIMIT_EXCEEDED"
    RESOURCE_LIMIT_EXCEEDED = "RESOURCE_LIMIT_EXCEEDED"
    TIMEOUT = "TIMEOUT"
    CANCELLED = "CANCELLED"
    STORAGE_ERROR = "STORAGE_ERROR"
    INTERNAL_ERROR = "INTERNAL_ERROR"
    UNAUTHORIZED = "UNAUTHORIZED"
    TASK_NOT_FOUND = "TASK_NOT_FOUND"
    IDEMPOTENCY_CONFLICT = "IDEMPOTENCY_CONFLICT"
    CAPACITY_EXCEEDED = "CAPACITY_EXCEEDED"
    UNSUPPORTED_TASK_TYPE = "UNSUPPORTED_TASK_TYPE"
    INVALID_STORAGE_KEY = "INVALID_STORAGE_KEY"
    WORKSPACE_MISMATCH = "WORKSPACE_MISMATCH"
    CONTRACT_VERSION_MISMATCH = "CONTRACT_VERSION_MISMATCH"
    INVALID_CONFIG = "INVALID_CONFIG"
    CONFIG_HASH_MISMATCH = "CONFIG_HASH_MISMATCH"
    TOOL_VERSION_MISMATCH = "TOOL_VERSION_MISMATCH"
    RESOURCE_EXHAUSTED = "RESOURCE_EXHAUSTED"  # a child was killed by a signal we did not send


TaskType = Literal["probe", "preprocess", "transcribe", "diarize", "measure"]
TaskStatus = Literal["queued", "running", "succeeded", "failed", "cancelled"]


class ProbeResponse(_Model):
    status: Literal["ok", "down"]
    service: Literal["audio-service"] = "audio-service"
    version: str


class HandshakeRequest(_Model):
    contractVersion: str = Field(min_length=1, max_length=16)  # noqa: N815 (wire format)
    requestId: UUID  # noqa: N815


class HandshakeResponse(_Model):
    contractVersion: str  # noqa: N815
    serviceVersion: str  # noqa: N815
    requestId: UUID  # noqa: N815
    accepted: Literal[True] = True


class FfmpegCapability(_Model):
    version: str


class LandlockCapability(_Model):
    # Strict scalars: zod does not coerce "4" to 4 or 1 to true, so neither may the mirror.
    supported: StrictBool
    abi: StrictInt | None = Field(ge=1)
    enforced: StrictBool
    # Landlock scoping (signals, abstract UNIX sockets; ABI >= 6) applied to children.
    scoped: StrictBool = False


class CapabilitiesResponse(_Model):
    contractVersion: str  # noqa: N815
    serviceVersion: str  # noqa: N815
    python: str
    ffmpeg: FfmpegCapability | None
    numpy: str
    # VAD is not selected (OD-29): the only value is "none" until a later workstream adds one.
    vad: Literal["none"]
    landlock: LandlockCapability
    taskTypes: list[TaskType]  # noqa: N815


class TaskInput(_Model):
    originalKey: str = Field(min_length=1, max_length=512)  # noqa: N815
    outputPrefix: str = Field(min_length=1, max_length=512)  # noqa: N815


class TaskCreateRequest(_Model):
    contractVersion: str = Field(min_length=1, max_length=16)  # noqa: N815
    type: TaskType
    idempotencyKey: str = Field(min_length=8, max_length=128, pattern=r"^[A-Za-z0-9._:-]+$")  # noqa: N815
    workspaceId: UUID  # noqa: N815
    recordingId: UUID  # noqa: N815
    input: TaskInput
    config: dict[str, Any]


class TaskAccepted(_Model):
    taskId: UUID  # noqa: N815
    status: TaskStatus


class TaskProgress(_Model):
    stage: str = Field(min_length=1, max_length=64)
    fraction: float = Field(strict=True, ge=0, le=1)
    processedMs: StrictInt = Field(ge=0)  # noqa: N815


class TaskErrorInfo(_Model):
    code: ErrorCode
    retryable: StrictBool


class TaskStatusResponse(_Model):
    taskId: UUID  # noqa: N815
    type: TaskType
    status: TaskStatus
    progress: TaskProgress | None
    result: dict[str, Any] | None
    error: TaskErrorInfo | None
    # Epoch milliseconds of the task's overall wall-clock deadline (ADR-0010); None while queued.
    deadlineAt: StrictInt | None = Field(default=None, ge=0)  # noqa: N815


class ErrorResponse(_Model):
    type: str = "about:blank"
    title: str
    status: StrictInt
    code: str
    detail: str | None = None


# -- probe result and timeline record (Phase 2B WS3; plan §11.2) ----------------------------------
# Container tags and metadata are never part of these models (they can hold personal data).

GaplessInfo = Literal["lame", "itunsmpb", "edit_list", "codec_preskip", "none", "unknown"]
DecodeClass = Literal["full", "partial", "none"]
MappingStatus = Literal["exact", "offset_applied", "approximate", "uncertain"]
Ms = Annotated[float, Field(strict=True, ge=0, allow_inf_nan=False)]
MsSigned = Annotated[float, Field(strict=True, allow_inf_nan=False)]


class TimelineSource(_Model):
    timeBase: str = Field(pattern=r"^[0-9]{1,10}/[0-9]{1,10}$")  # noqa: N815
    startTimeTicks: StrictInt | None  # noqa: N815
    startTimeMs: MsSigned | None  # noqa: N815
    editListPresent: StrictBool | Literal["unknown"]  # noqa: N815
    encoderDelaySamples: StrictInt | None = Field(ge=0)  # noqa: N815
    paddingSamples: StrictInt | None = Field(ge=0)  # noqa: N815
    gaplessInfo: GaplessInfo  # noqa: N815


class TrialDecode(_Model):
    decodable: StrictBool
    decodedMs: StrictInt = Field(ge=0)  # noqa: N815


class ProbeTools(_Model):
    ffprobe: str


class ProbeResult(_Model):
    container: Literal["wav", "flac", "ogg", "mp4", "matroska", "mp3"]
    demuxer: str = Field(min_length=1, max_length=32)
    codec: str = Field(min_length=1, max_length=32)
    sampleRateHz: StrictInt = Field(ge=1)  # noqa: N815
    channels: StrictInt = Field(ge=1)
    channelLayout: str | None = Field(max_length=64)  # noqa: N815
    sampleFormat: str = Field(min_length=1, max_length=16)  # noqa: N815
    bitsPerRawSample: StrictInt | None = Field(ge=1)  # noqa: N815
    bitRate: StrictInt | None = Field(ge=0)  # noqa: N815
    headerDurationMs: StrictInt | None = Field(ge=0)  # noqa: N815
    streamCount: StrictInt = Field(ge=1)  # noqa: N815
    audioStreamCount: StrictInt = Field(ge=1)  # noqa: N815
    trialDecode: TrialDecode  # noqa: N815
    timelineSource: TimelineSource  # noqa: N815
    warnings: list[str]
    tools: ProbeTools


class TimelineSourceRecord(TimelineSource):
    headerDurationMs: StrictInt | None = Field(ge=0)  # noqa: N815


class TimelineGap(_Model):
    startMs: Ms  # noqa: N815
    durationMs: Ms  # noqa: N815
    kind: Literal["timestamp_gap_filled"]


class TimelineOverlap(_Model):
    atMs: Ms  # noqa: N815
    durationMs: Ms  # noqa: N815


class TimelineDecodeErrors(_Model):
    count: StrictInt = Field(ge=0)
    firstAtMs: Ms | None  # noqa: N815


class Timeline(_Model):
    schemaVersion: Literal[1]  # noqa: N815
    nativeSampleRate: StrictInt = Field(ge=1)  # noqa: N815
    decodedSamplesNative: StrictInt = Field(ge=0)  # noqa: N815
    canonicalSamples: StrictInt = Field(ge=0)  # noqa: N815
    source: TimelineSourceRecord
    sourceOffsetMs: MsSigned | None  # noqa: N815
    decodeClass: DecodeClass  # noqa: N815
    decodedUntilMs: Ms | None  # noqa: N815
    gaps: list[TimelineGap]
    overlapsTrimmed: list[TimelineOverlap]  # noqa: N815
    decodeErrors: TimelineDecodeErrors  # noqa: N815
    mappingStatus: MappingStatus  # noqa: N815
    mappingErrorBoundMs: Ms | None  # noqa: N815
    reasons: list[str]


# -- preprocess config, result and measurement records (Phase 2B WS4; plan §8, §9, §12) -----------
# The config is hashed (ADR-0015): `config_hash` below and `configHash`/`canonicalJson` in the
# TypeScript contract implement the same rule, verified on shared fixtures by both test suites.


def canonical_json(value: Any) -> str:
    """Canonical JSON of a config: object keys sorted recursively (by Unicode code point; the keys
    of this schema are ASCII), no insignificant whitespace, UTF-8 (non-ASCII is not escaped), and
    numbers only as integers. Floats, booleans and null are rejected (ValueError): the config uses
    integer units (dBFS x 100, milliseconds) so that no number formatting can differ between
    languages. Mirrors `canonicalJson` in packages/contracts/src/audio-service.ts."""
    if isinstance(value, bool) or value is None or isinstance(value, float):
        raise ValueError("config values must be strings, integers, arrays or objects")
    if isinstance(value, int | str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, list | tuple):
        return "[" + ",".join(canonical_json(item) for item in value) + "]"
    if isinstance(value, dict):
        if not all(isinstance(key, str) for key in value):
            raise ValueError("object keys must be strings")
        body = ",".join(
            f"{json.dumps(key, ensure_ascii=False)}:{canonical_json(value[key])}"
            for key in sorted(value)
        )
        return "{" + body + "}"
    raise ValueError("unsupported config value")


def config_hash(config: Any) -> str:
    """Lower-case hex SHA-256 of the UTF-8 bytes of `canonical_json(config)`."""
    return hashlib.sha256(canonical_json(config).encode("utf-8")).hexdigest()


ToolVersion = Annotated[str, Field(pattern=r"^[A-Za-z0-9._+~:-]{1,64}$")]


class PreprocessCanonicalFormat(_Model):
    sampleRateHz: Literal[16000]  # noqa: N815
    channels: Literal[1]
    sampleFormat: Literal["s16"]  # noqa: N815
    container: Literal["wav"]


class PreprocessClippingConfig(_Model):
    # A clipped run is a stretch of at least this many consecutive full-scale samples.
    minRunSamples: StrictInt = Field(ge=1, le=1000)  # noqa: N815


class PreprocessMeasurementConfig(_Model):
    clipping: PreprocessClippingConfig
    silenceThresholdCentiDbfs: StrictInt = Field(ge=-12000, le=0)  # noqa: N815 (dBFS x 100)
    levelSeriesIntervalMs: StrictInt = Field(ge=10, le=60000)  # noqa: N815


class PreprocessLimits(_Model):
    maxDurationMs: StrictInt = Field(ge=1)  # noqa: N815
    maxChannels: StrictInt = Field(ge=1)  # noqa: N815
    maxSampleRateHz: StrictInt = Field(ge=1)  # noqa: N815


VadMethod = Annotated[str, Field(pattern=r"^[a-z][a-z0-9-]{0,31}$")]


class PreprocessVadConfig(_Model):
    # OD-29: no VAD is selected. The schema only fixes the shape of a method name; the service
    # accepts `none` plus the methods registered with the handler (none are, in `src`).
    method: VadMethod


class PreprocessSegmentationConfig(_Model):
    """Segmentation parameters (plan §11.1). Interim development defaults, OD-10 Open: minSegmentMs
    1000, maxSegmentMs 30000, splitSilenceMs 500, mergeGapMs 300, paddingMs 200,
    forcedSplitOverlapMs 1000. Every value is an integer multiple of the 10 ms frame."""

    minSegmentMs: StrictInt = Field(ge=100, le=60_000, multiple_of=10)  # noqa: N815
    maxSegmentMs: StrictInt = Field(ge=1_000, le=300_000, multiple_of=10)  # noqa: N815
    splitSilenceMs: StrictInt = Field(ge=100, le=60_000, multiple_of=10)  # noqa: N815
    mergeGapMs: StrictInt = Field(ge=0, le=60_000, multiple_of=10)  # noqa: N815
    paddingMs: StrictInt = Field(ge=0, le=10_000, multiple_of=10)  # noqa: N815
    forcedSplitOverlapMs: StrictInt = Field(ge=0, le=10_000, multiple_of=10)  # noqa: N815

    @model_validator(mode="after")
    def _consistent(self) -> PreprocessSegmentationConfig:
        if self.minSegmentMs > self.maxSegmentMs:
            raise ValueError("minSegmentMs must not exceed maxSegmentMs")
        if self.mergeGapMs > self.splitSilenceMs:
            raise ValueError("mergeGapMs must not exceed splitSilenceMs")
        if self.forcedSplitOverlapMs * 4 > self.maxSegmentMs:
            raise ValueError("forcedSplitOverlapMs must not exceed a quarter of maxSegmentMs")
        return self


class PreprocessToolVersions(_Model):
    service: ToolVersion
    python: ToolVersion
    ffmpeg: ToolVersion
    numpy: ToolVersion
    vad: ToolVersion  # "none", or "<method>:<detector version>"


class PreprocessConfig(_Model):
    schemaVersion: Literal[1]  # noqa: N815
    canonical: PreprocessCanonicalFormat
    blockSeconds: StrictInt = Field(ge=1, le=30)  # noqa: N815
    measurement: PreprocessMeasurementConfig
    limits: PreprocessLimits
    vad: PreprocessVadConfig
    # Absent exactly when `vad.method` is "none" (so existing hashes do not change). An explicit
    # null is not allowed: the canonical JSON has no null.
    segmentation: PreprocessSegmentationConfig | None = None
    toolVersions: PreprocessToolVersions  # noqa: N815

    @model_validator(mode="before")
    @classmethod
    def _no_explicit_null(cls, data: Any) -> Any:
        if isinstance(data, dict) and "segmentation" in data and data["segmentation"] is None:
            raise ValueError("segmentation must be omitted, not null")
        return data

    @model_validator(mode="after")
    def _segmentation_iff_vad(self) -> PreprocessConfig:
        if (self.vad.method == "none") != (self.segmentation is None):
            raise ValueError("segmentation is required with a VAD method and forbidden without one")
        return self


Num = Annotated[StrictInt | StrictFloat, Field(allow_inf_nan=False)]
QuantityUnit = Literal[
    "dBFS", "dB", "LUFS", "LU", "dBTP", "ratio", "samples", "ms", "fullscale", "count"
]
QuantityKind = Literal["measured", "derived", "estimate"]


class Quantity(_Model):
    value: Num
    unit: QuantityUnit
    kind: QuantityKind
    method: str = Field(min_length=1, max_length=160)


class Unavailable(_Model):
    name: str = Field(min_length=1, max_length=64)
    reason: str = Field(min_length=1, max_length=64)


class ChannelMeasurements(_Model):
    channel: StrictInt = Field(ge=0)
    quantities: dict[str, Quantity]


class MeasurementRecord(_Model):
    measurementsSchemaVersion: Literal[1]  # noqa: N815
    source: Literal["original_decoded", "canonical"]
    sampleRateHz: StrictInt = Field(ge=1)  # noqa: N815
    channels: StrictInt = Field(ge=1)
    frames: StrictInt = Field(ge=0)
    quantities: dict[str, Quantity]
    perChannel: list[ChannelMeasurements]  # noqa: N815
    unavailable: list[Unavailable]


class PreprocessCanonical(_Model):
    key: str = Field(min_length=1, max_length=512)
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    samples: StrictInt = Field(ge=0)
    durationMs: Ms  # noqa: N815 (samples / 16, exact)
    sampleRateHz: Literal[16000]  # noqa: N815
    channels: Literal[1]
    sampleFormat: Literal["s16"]  # noqa: N815
    bytes: StrictInt = Field(ge=44)


class PreprocessArtifacts(_Model):
    levelSeriesKey: str = Field(min_length=1, max_length=512)  # noqa: N815
    manifestKey: str = Field(min_length=1, max_length=512)  # noqa: N815


class PreprocessVadNotConfigured(_Model):
    method: Literal["none"]
    status: Literal["not_configured"]


class PreprocessVadApplied(_Model):
    method: VadMethod
    version: ToolVersion
    status: Literal["applied"]

    @model_validator(mode="after")
    def _a_real_method(self) -> PreprocessVadApplied:
        if self.method == "none":
            raise ValueError("an applied VAD has a method")
        return self


PreprocessVad = PreprocessVadNotConfigured | PreprocessVadApplied


class PreprocessSegment(_Model):
    """One speech segment on the canonical timeline C: half-open [startMs, endMs), whole ms.
    Maps 1:1 onto a row of `audio_segments`. Interim parameters, OD-10 Open."""

    index: StrictInt = Field(ge=0)
    startMs: StrictInt = Field(ge=0)  # noqa: N815
    endMs: StrictInt = Field(ge=1)  # noqa: N815
    overlapStartMs: StrictInt = Field(ge=0)  # noqa: N815
    overlapEndMs: StrictInt = Field(ge=0)  # noqa: N815
    speechMs: StrictInt = Field(ge=0)  # noqa: N815
    containsSyntheticGap: StrictBool  # noqa: N815

    @model_validator(mode="after")
    def _range(self) -> PreprocessSegment:
        length = self.endMs - self.startMs
        if length <= 0:
            raise ValueError("startMs must be below endMs")
        if self.speechMs > length:
            raise ValueError("speechMs must not exceed the segment length")
        if self.overlapStartMs > length or self.overlapEndMs > length:
            raise ValueError("an overlap must not exceed the segment length")
        return self


class PreprocessSegmentMeasurement(_Model):
    """A `canonical` measurement record of one segment, linked by segment index. Maps 1:1 onto a
    row of `audio_measurements` with a segment id."""

    segmentIndex: StrictInt = Field(ge=0)  # noqa: N815
    record: MeasurementRecord

    @model_validator(mode="after")
    def _canonical(self) -> PreprocessSegmentMeasurement:
        if self.record.source != "canonical":
            raise ValueError("a segment record is measured on the canonical audio")
        return self


class PreprocessResult(_Model):
    canonical: PreprocessCanonical
    timeline: Timeline
    measurements: Annotated[list[MeasurementRecord], Field(min_length=2, max_length=2)]
    artifacts: PreprocessArtifacts
    vad: PreprocessVad
    segments: list[PreprocessSegment]
    segmentMeasurements: list[PreprocessSegmentMeasurement]  # noqa: N815
    toolVersions: PreprocessToolVersions  # noqa: N815
    warnings: list[str]

    @model_validator(mode="after")
    def _segments_are_ordered_and_linked(self) -> PreprocessResult:  # noqa: C901
        if isinstance(self.vad, PreprocessVadNotConfigured) and self.segments:
            raise ValueError("no VAD, no segments")
        limit = math.ceil(self.canonical.durationMs)
        previous: PreprocessSegment | None = None
        for position, seg in enumerate(self.segments):
            if seg.index != position:
                raise ValueError("segment indices are 0..n-1 in order")
            if seg.endMs > limit:
                raise ValueError("a segment ends beyond the canonical audio")
            if previous is not None:
                shared = min(previous.overlapEndMs, seg.overlapStartMs)
                if seg.startMs <= previous.startMs or seg.startMs < previous.endMs - shared:
                    raise ValueError("segments overlap beyond their declared overlap")
            previous = seg
        if [m.segmentIndex for m in self.segmentMeasurements] != [s.index for s in self.segments]:
            raise ValueError("one measurement record per segment, in segment order")
        return self


class LevelSeries(_Model):
    """`level-series.json`: one RMS and one peak value per window; null = digital silence.

    A measurement series, not waveform peaks: no API or UI may serve it as peaks until OD-39 is
    decided.
    """

    schemaVersion: Literal[1]  # noqa: N815
    intervalMs: StrictInt = Field(ge=10)  # noqa: N815
    sampleRateHz: Literal[16000]  # noqa: N815
    windows: StrictInt = Field(ge=0)
    rmsDbfs: list[Num | None]  # noqa: N815
    peakDbfs: list[Num | None]  # noqa: N815


# -- self-hosted speech-to-text and diarization (OD-02b / OD-03b, ADR-0036 / ADR-0037) ----------
# Mirrors AudioTranscribeConfig / AudioTranscribeResult / AudioDiarizeConfig / AudioDiarizeResult.

Sha256Hex = Annotated[str, Field(pattern=r"^[0-9a-f]{64}$")]
IntMs = Annotated[StrictInt, Field(ge=0)]
Probability = Annotated[StrictFloat | StrictInt, Field(ge=0, le=1)]


class MsRange(_Model):
    startMs: IntMs  # noqa: N815
    endMs: IntMs  # noqa: N815


class VadSettings(_Model):
    threshold: StrictFloat | StrictInt = Field(ge=0, le=1)
    minSilenceMs: StrictInt = Field(ge=0, le=5000)  # noqa: N815
    minSpeechMs: StrictInt = Field(ge=0, le=5000)  # noqa: N815
    paddingMs: StrictInt = Field(ge=0, le=2000)  # noqa: N815


class TranscribeConfig(_Model):
    schemaVersion: Literal[1]  # noqa: N815
    engine: Literal["whisper-cpp"]
    window: MsRange
    audioDurationMs: StrictInt = Field(ge=1)  # noqa: N815
    vad: VadSettings
    languageHints: list[Literal["en", "hi"]] | None = Field(  # noqa: N815
        default=None, min_length=1, max_length=2
    )

    @model_validator(mode="after")
    def _window_inside(self) -> TranscribeConfig:
        if not (self.window.startMs < self.window.endMs <= self.audioDurationMs):
            raise ValueError("window must be non-empty and inside the audio")
        return self


class EngineInfo(_Model):
    id: str = Field(min_length=1, max_length=32)
    model: str = Field(min_length=1, max_length=128)
    modelSha256: Sha256Hex  # noqa: N815
    runtime: str = Field(min_length=1, max_length=64)
    threads: StrictInt = Field(ge=1, le=16)


class VadInfo(_Model):
    model: str = Field(min_length=1, max_length=128)
    sha256: Sha256Hex
    settings: VadSettings


class TranscribeSpan(_Model):
    startMs: IntMs  # noqa: N815
    endMs: IntMs  # noqa: N815
    detected: str | None = Field(min_length=2, max_length=8)
    probability: Probability | None
    decodedAs: Literal["en", "hi"]  # noqa: N815


class TranscribeSegment(_Model):
    startMs: IntMs  # noqa: N815
    endMs: IntMs  # noqa: N815
    text: str = Field(max_length=10_000)
    language: Literal["en", "hi"]
    # Geometric mean of token probabilities as reported by whisper.cpp; not a calibrated confidence.
    tokenProbability: Probability | None  # noqa: N815


class TranscribeResult(_Model):
    schemaVersion: Literal[1]  # noqa: N815
    engine: EngineInfo
    vad: VadInfo
    window: MsRange
    spans: list[TranscribeSpan]
    segments: list[TranscribeSegment]
    warnings: list[Annotated[str, Field(max_length=200)]]

    @model_validator(mode="after")
    def _inside(self) -> TranscribeResult:
        w = self.window
        ranges = [(x.startMs, x.endMs) for x in self.spans] + [
            (x.startMs, x.endMs) for x in self.segments
        ]
        for start, end in ranges:
            if start >= end or start < w.startMs or end > w.endMs:
                raise ValueError("a span or segment lies outside its window or is empty")
        return self


class DiarizeConfig(_Model):
    schemaVersion: Literal[1]  # noqa: N815
    engine: Literal["sherpa-onnx"]
    audioDurationMs: StrictInt = Field(ge=1)  # noqa: N815
    clusteringThreshold: StrictFloat | StrictInt = Field(ge=0, le=2)  # noqa: N815
    minDurationOnMs: StrictInt = Field(ge=0, le=10_000)  # noqa: N815
    minDurationOffMs: StrictInt = Field(ge=0, le=10_000)  # noqa: N815
    wholeFileMaxMs: StrictInt = Field(ge=10_000)  # noqa: N815
    windowMs: StrictInt = Field(ge=60_000)  # noqa: N815
    overlapMs: StrictInt = Field(ge=0)  # noqa: N815
    matchThreshold: Probability  # noqa: N815

    @model_validator(mode="after")
    def _overlap(self) -> DiarizeConfig:
        if self.overlapMs * 2 >= self.windowMs:
            raise ValueError("overlap must be under half a window")
        return self


class ModelRef(_Model):
    model: str = Field(min_length=1, max_length=128)
    sha256: Sha256Hex


class DiarizeEngine(_Model):
    id: Literal["sherpa-onnx"]
    runtime: str = Field(min_length=1, max_length=64)
    threads: StrictInt = Field(ge=1, le=16)
    segmentation: ModelRef
    embedding: ModelRef


class DiarizeWindow(_Model):
    startMs: IntMs  # noqa: N815
    endMs: IntMs  # noqa: N815
    localSpeakers: StrictInt = Field(ge=0)  # noqa: N815


class DiarizeTurn(_Model):
    startMs: IntMs  # noqa: N815
    endMs: IntMs  # noqa: N815
    speakerKey: str = Field(pattern=r"^SPEAKER_[0-9]{2,3}$")  # noqa: N815


class DiarizeResult(_Model):
    schemaVersion: Literal[1]  # noqa: N815
    engine: DiarizeEngine
    mode: Literal["whole", "windowed"]
    canonicalSha256: Sha256Hex  # noqa: N815
    windows: list[DiarizeWindow]
    turns: list[DiarizeTurn]
    speakerCount: StrictInt = Field(ge=0)  # noqa: N815
    warnings: list[Annotated[str, Field(max_length=200)]]

    @model_validator(mode="after")
    def _turns(self) -> DiarizeResult:
        keys: set[str] = set()
        for t in self.turns:
            if t.startMs >= t.endMs:
                raise ValueError("a turn is empty or reversed")
            keys.add(t.speakerKey)
        if len(keys) != self.speakerCount:
            raise ValueError("speakerCount must equal the distinct speaker keys")
        return self


# -- Phase 3A: speech-aware objective measurements (ADR-0045) -------------------------------------
# Numbers only (ADR-0019): no category, score, verdict or recommendation. Interpretation is the
# Audio Quality Agent's job (A1, in the orchestrator).


class MeasureConfig(_Model):
    schemaVersion: Literal[1]  # noqa: N815
    audioDurationMs: StrictInt = Field(ge=1)  # noqa: N815
    vad: VadSettings
    blockMs: StrictInt = Field(ge=100, le=60_000)  # noqa: N815
    windowMs: StrictInt = Field(ge=1000, le=300_000)  # noqa: N815
    overlapMs: StrictInt = Field(ge=0, le=60_000)  # noqa: N815
    ltasDropDb: StrictInt = Field(ge=10, le=120)  # noqa: N815
    ltasMinHz: StrictInt = Field(ge=0, le=4000)  # noqa: N815
    snrNearCleanDb: StrictInt = Field(ge=20, le=80)  # noqa: N815

    @model_validator(mode="after")
    def _window(self) -> MeasureConfig:
        if self.overlapMs * 2 >= self.windowMs:
            raise ValueError("overlapMs must be below half of windowMs")
        return self


# Bounds on the Tier 1 wire contract (mirror audio-service.ts; 4 h at 100 ms blocks is 144,000).
MAX_TIER1_QUANTITIES = 32
MAX_SERIES_BLOCKS = 200_000
Tier1Name = Annotated[str, StringConstraints(pattern=r"^[A-Za-z][A-Za-z0-9]{0,63}$")]


class Tier1Quantity(_Model):
    value: Num
    unit: Literal["dBFS", "dB", "ratio", "ms", "Hz", "count"]
    kind: Literal["measured", "derived", "estimate"]
    method: str = Field(min_length=1, max_length=200)


class Tier1Record(_Model):
    measurementsSchemaVersion: Literal[2]  # noqa: N815
    source: Literal["canonical"]
    quantities: dict[Tier1Name, Tier1Quantity] = Field(max_length=MAX_TIER1_QUANTITIES)
    unavailable: list[Unavailable] = Field(max_length=MAX_TIER1_QUANTITIES)


class SpeechSeries(_Model):
    schemaVersion: Literal[1]  # noqa: N815
    blockMs: StrictInt = Field(ge=100)  # noqa: N815
    speechMs: list[IntMs] = Field(max_length=MAX_SERIES_BLOCKS)  # noqa: N815
    snrDb: list[Num | None] = Field(max_length=MAX_SERIES_BLOCKS)  # noqa: N815

    @model_validator(mode="after")
    def _aligned(self) -> SpeechSeries:
        if len(self.speechMs) != len(self.snrDb):
            raise ValueError("series arrays must have one entry per block")
        return self


class MeasureResult(_Model):
    schemaVersion: Literal[1]  # noqa: N815
    vad: VadInfo
    record: Tier1Record
    series: SpeechSeries
    warnings: list[Annotated[str, Field(max_length=200)]]
