"""Scripted media for the preprocess handler tests: no FFmpeg, real storage, real analysers."""

from __future__ import annotations

import copy
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from uuid import uuid4

import numpy as np
from helpers import REC, WS, task_request
from media_fakes import FakeRunner, result

from audio_service.contracts import ProbeResult, TaskProgress, config_hash
from audio_service.domain.packets import PacketScan
from audio_service.domain.preprocess import PreprocessHandler, ToolVersions
from audio_service.domain.runner import Outcome, RunResult
from audio_service.domain.storage import LocalStorageBackend
from audio_service.domain.storage_keys import TaskRefs
from audio_service.domain.tasks import CancellationToken, TaskContext

VERSIONS = ToolVersions(service="0.1.0", python="3.12.8", ffmpeg="7.1.2", numpy="2.5.5")
SUMMARY = (
    b"[Parsed_ebur128_0 @ 0x1] Summary:\n\n  Integrated loudness:\n    I:         -20.5 LUFS\n"
    b"    Threshold: -30.5 LUFS\n\n  Loudness range:\n    LRA:         1.5 LU\n"
    b"    Threshold: -40.5 LUFS\n    LRA low:   -22.0 LUFS\n    LRA high:  -20.5 LUFS\n\n"
    b"  True peak:\n    Peak:       -3.0 dBFS\n"
)
CONFIG: dict[str, Any] = {
    "schemaVersion": 1,
    "canonical": {"sampleRateHz": 16000, "channels": 1, "sampleFormat": "s16", "container": "wav"},
    "blockSeconds": 1,
    "measurement": {
        "clipping": {"minRunSamples": 2},
        "silenceThresholdCentiDbfs": -5000,
        "levelSeriesIntervalMs": 100,
    },
    "limits": {"maxDurationMs": 14_400_000, "maxChannels": 8, "maxSampleRateHz": 192_000},
    "vad": {"method": "none"},
    "toolVersions": {**VERSIONS.as_dict()},
}


def make_config(**changes: Any) -> dict[str, Any]:
    config = copy.deepcopy(CONFIG)
    for path, value in changes.items():
        target = config
        *parents, leaf = path.split("__")
        for parent in parents:
            target = target[parent]
        target[leaf] = value
    return config


def probe_result(
    *, rate: int = 16000, channels: int = 1, duration_ms: int | None = 2000, **kw: Any
) -> ProbeResult:
    body: dict[str, Any] = {
        "container": "wav",
        "demuxer": "wav",
        "codec": "pcm_s16le",
        "sampleRateHz": rate,
        "channels": channels,
        "channelLayout": None,
        "sampleFormat": "s16",
        "bitsPerRawSample": 16,
        "bitRate": None,
        "headerDurationMs": duration_ms,
        "streamCount": 1,
        "audioStreamCount": 1,
        "trialDecode": {"decodable": True, "decodedMs": 1000},
        "timelineSource": {
            "timeBase": f"1/{rate}",
            "startTimeTicks": 0,
            "startTimeMs": 0.0,
            "editListPresent": False,
            "encoderDelaySamples": None,
            "paddingSamples": None,
            "gaplessInfo": "none",
        },
        "warnings": [],
        "tools": {"ffprobe": "test"},
    }
    body.update(kw)
    return ProbeResult.model_validate(body)


def packet_scan(rate: int, frames: int) -> PacketScan:
    return PacketScan(
        packets=10, first_pts=0, last_end=frames, max_duration_ticks=max(1, rate // 50)
    )


@dataclass
class Media:
    """A synthetic source: what the native and canonical passes emit, and the loudness summary."""

    rate: int
    native: np.ndarray[Any, Any]  # float32 (frames, channels)
    canonical: np.ndarray[Any, Any]  # int16 (samples,)
    summary: bytes = SUMMARY
    canonical_rc: int = 0
    native_rc: int = 0
    loudness_rc: int = 0
    chunk_bytes: int = 4096
    on_chunk: Callable[[str, int], None] | None = None  # (mode, chunk index)
    calls: list[str] = field(default_factory=list)

    @classmethod
    def from_signal(cls, signal: np.ndarray[Any, Any], rate: int, **kw: Any) -> Media:
        frames = signal.astype(np.float32).reshape(signal.shape[0], -1)
        mono = frames.mean(axis=1)
        count = frames.shape[0] * 16000 // rate
        index = np.minimum((np.arange(count) * rate // 16000), frames.shape[0] - 1)
        canonical = np.clip(np.round(mono[index] * 32768), -32768, 32767).astype(np.int16)
        return cls(rate, frames, canonical, **kw)

    def runner(self) -> FakeRunner:
        def script(argv: list[str], sink: Callable[[bytes], None], _s: Any) -> RunResult:
            if "f32le" in argv:
                mode, data, rc, stderr = (
                    "native",
                    self.native.astype("<f4").tobytes(),
                    self.native_rc,
                    b"",
                )
            elif "s16le" in argv:
                mode, data = "canonical", self.canonical.astype("<i2").tobytes()
                rc, stderr = self.canonical_rc, b""
            else:
                self.calls.append("loudness")
                return result(rc=self.loudness_rc, stderr=self.summary)
            self.calls.append(mode)
            for index, start in enumerate(range(0, len(data), self.chunk_bytes)):
                if self.on_chunk is not None:
                    self.on_chunk(mode, index)
                sink(data[start : start + self.chunk_bytes])
            return RunResult(Outcome.EXITED, rc, stderr, len(data))

        return FakeRunner({"ffmpeg": script})  # type: ignore[arg-type]


def prefix_for(config: dict[str, Any]) -> str:
    return f"derived/{WS}/{REC}/{config_hash(config)}"


def make_context(
    config: dict[str, Any],
    *,
    prefix: str | None = None,
    cancel: CancellationToken | None = None,
    progress: list[TaskProgress] | None = None,
) -> TaskContext:
    request = task_request(
        type="preprocess",
        config=config,
        input={
            "originalKey": f"recordings/{WS}/{REC}/original",
            "outputPrefix": prefix or prefix_for(config),
        },
    )
    sink = progress if progress is not None else []
    return TaskContext(
        task_id=uuid4(),
        request=request,
        refs=TaskRefs(request.workspaceId, request.recordingId),
        cancel=cancel or CancellationToken(),
        _report=sink.append,
    )


def put_original(root: Path, content: bytes = b"synthetic-original") -> None:
    path = root / "recordings" / WS / REC / "original"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)


def handler(
    root: Path,
    runner: Any,
    *,
    storage: LocalStorageBackend | None = None,
    versions: ToolVersions | None = VERSIONS,
) -> PreprocessHandler:
    backend = storage or LocalStorageBackend(root)
    return PreprocessHandler(
        lambda: backend,
        lambda: runner,
        lambda: versions,
        max_duration_ms=14_400_000,
        max_channels=8,
        max_sample_rate_hz=192_000,
    )
