"""Unit tests for the self-hosted `transcribe` / `diarize` tasks (ADR-0036 / ADR-0037).

Fake engines only: no model is loaded. A real canonical WAV is published to temporary local
storage, so the storage, manifest and window-reading paths are the production ones.
"""

from __future__ import annotations

import io
import math
import wave
from collections.abc import Mapping
from pathlib import Path
from typing import Any
from uuid import uuid4

import numpy as np
import pytest
from helpers import REC, WS, task_request

from audio_service.contracts import (
    DiarizeConfig,
    DiarizeEngine,
    DiarizeResult,
    EngineInfo,
    ErrorCode,
    ModelRef,
    TaskProgress,
    TranscribeResult,
)
from audio_service.domain.diarize import (
    DiarizeHandler,
    diarize_windows,
    match_speakers,
    owned_span,
    plan_windows,
)
from audio_service.domain.errors import TaskFailure
from audio_service.domain.inference_models import ModelFile, ModelStore, ModelUnavailable
from audio_service.domain.storage import LocalStorageBackend
from audio_service.domain.storage_keys import TaskRefs
from audio_service.domain.tasks import CancellationToken, TaskContext, TaskDeadline
from audio_service.domain.transcribe import TranscribeHandler, choose_language, pad_and_merge

PREFIX = f"derived/{WS}/{REC}/{'c' * 64}"
SR = 16_000


# -- helpers -------------------------------------------------------------------------------------


def wav_bytes(samples: np.ndarray) -> bytes:
    pcm = (np.clip(samples, -1, 1 - 1 / 32768) * 32768).astype("<i2").tobytes()
    out = io.BytesIO()
    with wave.open(out, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm)
    return out.getvalue()


def publish(root: Path, samples: np.ndarray) -> LocalStorageBackend:
    storage = LocalStorageBackend(root)
    (root / "derived").mkdir(exist_ok=True)
    refs = TaskRefs(uuid4().__class__(WS), uuid4().__class__(REC))
    with storage.begin_output(PREFIX, refs, uuid4()) as session:
        session.create_file("canonical.wav").write(wav_bytes(samples))
        session.publish()
    return storage


def tone(seconds: float, amplitude: float = 0.3, freq: float = 220.0) -> np.ndarray:
    t = np.arange(int(seconds * SR)) / SR
    return (amplitude * np.sin(2 * math.pi * freq * t)).astype(np.float32)


def context(
    task_type: str, config: dict[str, Any], progress: list[TaskProgress] | None = None
) -> TaskContext:
    request = task_request(
        type=task_type,
        config=config,
        input={"originalKey": f"recordings/{WS}/{REC}/original", "outputPrefix": PREFIX},
    )
    deadline = TaskDeadline(base_ms=120_000, per_audio_permille=500, max_duration_ms=1_000)
    return TaskContext(
        task_id=uuid4(),
        request=request,
        refs=TaskRefs(request.workspaceId, request.recordingId),
        cancel=CancellationToken(),
        _report=(progress if progress is not None else []).append,
        deadline=deadline,
    )


ENGINE = EngineInfo(
    id="whisper-cpp", model="fake", modelSha256="0" * 64, runtime="fake 1", threads=1
)


class FakeStt:
    """Per-span fake: each `detect` call takes the next language distribution, each `transcribe`
    call the next list of (relative) segments."""

    def __init__(
        self,
        segments: list[list[tuple[int, int, str, float | None]]],
        probs: list[Mapping[str, float]],
    ) -> None:
        self.info = ENGINE
        self.segments = list(segments)
        self.probs = list(probs)
        self.calls: list[tuple[int, str]] = []
        self.closed = False

    def detect(self, samples: np.ndarray) -> tuple[str | None, float | None, Mapping[str, float]]:
        probs = self.probs.pop(0)
        code = max(probs, key=lambda k: probs[k])
        return code, probs[code], probs

    def transcribe(
        self, samples: np.ndarray, language: str
    ) -> list[tuple[int, int, str, float | None]]:
        self.calls.append((len(samples) // 16, language))
        return self.segments.pop(0)

    def close(self) -> None:
        self.closed = True


class FakeVad:
    def __init__(self, spans: list[tuple[int, int]]) -> None:
        self._spans = spans
        self.closed = False

    def spans(self, samples: np.ndarray) -> list[tuple[int, int]]:
        return list(self._spans)

    def close(self) -> None:
        self.closed = True


VAD = {"threshold": 0.4, "minSilenceMs": 300, "minSpeechMs": 250, "paddingMs": 200}


def stt_config(start: int, end: int, duration: int, **extra: Any) -> dict[str, Any]:
    return {
        "schemaVersion": 1,
        "engine": "whisper-cpp",
        "window": {"startMs": start, "endMs": end},
        "audioDurationMs": duration,
        "vad": VAD,
        **extra,
    }


def stt_handler(storage: Any, root: Path, vad: FakeVad, engine: Any) -> TranscribeHandler:
    return TranscribeHandler(
        lambda: storage,
        ModelStore(root),
        threads=1,
        deadline_per_audio_permille=4000,
        detector_factory=lambda _s: vad,
        engine_factory=lambda: engine,
        isolate=False,
    )


# -- language choice and spans ---------------------------------------------------------------------


def test_urdu_probability_counts_towards_hindi() -> None:
    assert choose_language({"ur": 0.5, "hi": 0.2, "en": 0.3}, None) == "hi"
    assert choose_language({"en": 0.6, "ur": 0.3}, None) == "en"


def test_hints_restrict_the_choice() -> None:
    assert choose_language({"en": 0.9, "hi": 0.1}, ["hi"]) == "hi"
    assert choose_language({}, None) == "en"  # no evidence: first candidate


def test_spans_are_padded_clipped_and_joined_up_to_the_whisper_limit() -> None:
    assert pad_and_merge([(100, 1000), (1300, 2000)], 200, 30_000) == [(0, 2200)]
    assert pad_and_merge([(0, 1000), (5000, 6000)], 200, 5_500) == [(0, 1200), (4800, 5500)]
    # joining would exceed 29 s: kept apart even though they touch after padding
    assert pad_and_merge([(0, 20_000), (20_300, 29_500)], 200, 30_000) == [
        (0, 20_200),
        (20_100, 29_700),
    ]


# -- transcribe handler ----------------------------------------------------------------------------


def test_each_speech_span_is_decoded_with_its_own_language(tmp_path: Path) -> None:
    """Regression for the measured failure: a mixed en/hi window decoded in one pass."""
    storage = publish(tmp_path, tone(75))
    vad = FakeVad([(1000, 6000), (8000, 20_000)])
    engine = FakeStt(
        [[(0, 4000, "Please turn off the lights.", 0.9)], [(0, 9000, "नमस्ते", None)]],
        [{"en": 0.97, "hi": 0.01}, {"ur": 0.6, "en": 0.3}],
    )
    result = TranscribeResult.model_validate(
        stt_handler(storage, tmp_path, vad, engine)(
            context("transcribe", stt_config(29_000, 59_000, 75_000))
        )
    )
    # spans padded by 200 ms, absolute; each span decoded on its own clip with its own language
    assert [(sp.startMs, sp.endMs, sp.decodedAs) for sp in result.spans] == [
        (29_800, 35_200, "en"),
        (36_800, 49_200, "hi"),
    ]
    assert engine.calls == [(5_400, "en"), (12_400, "hi")]
    assert [(s.startMs, s.endMs, s.language, s.text) for s in result.segments] == [
        (29_800, 33_800, "en", "Please turn off the lights."),
        (36_800, 45_800, "hi", "नमस्ते"),
    ]
    assert result.vad.model == "silero-vad-v6.2.3" and vad.closed and engine.closed


def test_segments_are_clipped_to_their_span(tmp_path: Path) -> None:
    storage = publish(tmp_path, tone(30))
    engine = FakeStt([[(0, 9_999, "runs past the span", None)]], [{"en": 1.0}])
    result = TranscribeResult.model_validate(
        stt_handler(storage, tmp_path, FakeVad([(1000, 3000)]), engine)(
            context("transcribe", stt_config(0, 30_000, 30_000))
        )
    )
    assert [(s.startMs, s.endMs) for s in result.segments] == [(800, 3200)]


def test_no_speech_skips_the_engine(tmp_path: Path) -> None:
    storage = publish(tmp_path, np.zeros(10 * SR, dtype=np.float32))

    def never() -> FakeStt:
        raise AssertionError("whisper must not be loaded without speech")

    handler = TranscribeHandler(
        lambda: storage,
        ModelStore(tmp_path),
        threads=1,
        deadline_per_audio_permille=4000,
        detector_factory=lambda _s: FakeVad([]),
        engine_factory=never,
        isolate=False,
    )
    result = TranscribeResult.model_validate(
        handler(context("transcribe", stt_config(0, 10_000, 10_000)))
    )
    assert result.spans == [] and result.segments == [] and result.warnings == ["no_speech"]


def test_transcribe_rejects_a_config_that_does_not_match_the_audio(tmp_path: Path) -> None:
    storage = publish(tmp_path, tone(10))
    handler = stt_handler(storage, tmp_path, FakeVad([]), FakeStt([], []))
    with pytest.raises(TaskFailure) as wrong_duration:
        handler(context("transcribe", stt_config(0, 5_000, 20_000)))
    assert wrong_duration.value.code == ErrorCode.INVALID_CONFIG
    with pytest.raises(TaskFailure) as bad:
        handler(context("transcribe", {"schemaVersion": 1, "engine": "whisper-cpp"}))
    assert bad.value.code == ErrorCode.INVALID_CONFIG


def test_transcribe_needs_a_published_preprocessing(tmp_path: Path) -> None:
    storage = LocalStorageBackend(tmp_path)
    (tmp_path / "derived").mkdir()
    handler = stt_handler(storage, tmp_path, FakeVad([]), FakeStt([], []))
    with pytest.raises(TaskFailure) as missing:
        handler(context("transcribe", stt_config(0, 5_000, 10_000)))
    assert missing.value.code in {ErrorCode.STORAGE_ERROR, ErrorCode.INVALID_STORAGE_KEY}


def test_inference_budget_replaces_the_ffmpeg_ceiling() -> None:
    clock = [0.0]
    deadline = TaskDeadline(
        base_ms=120_000, per_audio_permille=500, max_duration_ms=1_000, clock=lambda: clock[0]
    )
    deadline.set_inference_budget(60_000, 4000)  # 120 s + 4 x 60 s = 360 s
    clock[0] = 359.0
    assert not deadline.expired
    clock[0] = 360.0
    assert deadline.expired


# -- diarization: windows, ownership, matching ----------------------------------------------


def test_a_short_file_is_diarized_whole() -> None:
    assert plan_windows(600_000, 600_000, 600_000, 30_000) == [(0, 600_000)]


def test_windows_overlap_and_their_owned_spans_tile_the_timeline() -> None:
    windows = plan_windows(3_600_000, 600_000, 600_000, 30_000)
    assert windows[0] == (0, 600_000) and windows[-1][1] == 3_600_000
    for (_s0, e0), (s1, _e1) in zip(windows, windows[1:], strict=False):
        assert e0 - s1 == 30_000
    spans = [owned_span(windows, i) for i in range(len(windows))]
    assert spans[0][0] == 0 and spans[-1][1] == 3_600_000
    for (_lo, hi), (lo, _hi) in zip(spans, spans[1:], strict=False):
        assert hi == lo


def test_matching_is_one_to_one_and_creates_new_speakers_below_threshold() -> None:
    globals_: list[Any] = []
    a, b = np.array([1.0, 0.0]), np.array([0.0, 1.0])
    assert match_speakers(globals_, {0: (a, 10.0), 1: (b, 10.0)}, 0.5) == {0: 0, 1: 1}
    # next window: labels swapped, plus a third voice
    c = np.array([0.7071, -0.7071])
    assert match_speakers(globals_, {0: (b, 5.0), 1: (a, 5.0), 2: (c, 5.0)}, 0.8) == {
        0: 1,
        1: 0,
        2: 2,
    }


class SignEngine:
    """Speaker A is positive samples, B negative. Local labels are swapped in odd windows, as a
    real clusterer may number speakers differently in every window."""

    engine = DiarizeEngine(
        id="sherpa-onnx",
        runtime="fake 1",
        threads=1,
        segmentation=ModelRef(model="fake-seg", sha256="1" * 64),
        embedding=ModelRef(model="fake-emb", sha256="2" * 64),
    )

    def __init__(self) -> None:
        self.window = 0

    def diarize(self, samples: np.ndarray) -> list[tuple[int, int, int]]:
        swap = self.window % 2 == 1
        self.window += 1
        turns: list[tuple[int, int, int]] = []
        block = SR  # 1 s blocks
        for i in range(0, len(samples) // block):
            spk = 0 if samples[i * block] > 0 else 1
            label = 1 - spk if swap else spk
            s, e = i * 1000, (i + 1) * 1000
            if turns and turns[-1][2] == label and turns[-1][1] == s:
                turns[-1] = (turns[-1][0], e, label)
            else:
                turns.append((s, e, label))
        return turns

    def embed(self, samples: np.ndarray) -> np.ndarray:
        return np.array([1.0, 0.0]) if float(np.mean(samples)) > 0 else np.array([0.0, 1.0])

    def close(self) -> None:
        pass


def alternating(seconds: int, turn_s: int) -> np.ndarray:
    blocks = [
        np.full(turn_s * SR, 0.5 if (i % 2 == 0) else -0.5, dtype=np.float32)
        for i in range(seconds // turn_s)
    ]
    return np.concatenate(blocks)


def test_speakers_stay_consistent_across_windows_and_turns_do_not_overlap() -> None:
    samples = alternating(1500, 60)  # 25 min, speakers alternate every 60 s
    windows = plan_windows(1_500_000, 600_000, 600_000, 30_000)
    assert len(windows) == 3
    turns, infos = diarize_windows(
        SignEngine(),
        lambda s, e: samples[s * 16 : e * 16],
        windows,
        match_threshold=0.5,
        check=lambda: None,
        progress=lambda f, ms: None,
    )
    assert [w.localSpeakers for w in infos] == [2, 2, 2]
    assert len(turns) == 25  # one turn per minute: boundary-split turns were joined
    for n, t in enumerate(turns):
        assert (t.startMs, t.endMs) == (n * 60_000, (n + 1) * 60_000)
        assert t.speakerKey == ("SPEAKER_00" if n % 2 == 0 else "SPEAKER_01")


def test_diarize_handler_whole_file_and_tamper_detection(tmp_path: Path) -> None:
    samples = alternating(120, 10)
    storage = publish(tmp_path, samples)
    config = DiarizeConfig(
        schemaVersion=1,
        engine="sherpa-onnx",
        audioDurationMs=120_000,
        clusteringThreshold=0.6,
        minDurationOnMs=300,
        minDurationOffMs=500,
        wholeFileMaxMs=600_000,
        windowMs=600_000,
        overlapMs=30_000,
        matchThreshold=0.5,
    ).model_dump(mode="json")
    handler = DiarizeHandler(
        lambda: storage,
        ModelStore(tmp_path),
        threads=1,
        deadline_per_audio_permille=4000,
        engine_factory=lambda cfg: SignEngine(),
        isolate=False,
    )
    result = DiarizeResult.model_validate(handler(context("diarize", config)))
    assert result.mode == "whole" and result.speakerCount == 2 and len(result.turns) == 12
    assert result.turns[0].speakerKey == "SPEAKER_00"

    wav = next((tmp_path / "derived").rglob("canonical.wav"))
    data = bytearray(wav.read_bytes())
    data[-1] ^= 0xFF  # same size, different bytes
    wav.write_bytes(bytes(data))
    with pytest.raises(TaskFailure) as tampered:
        handler(context("diarize", config))
    assert tampered.value.code == ErrorCode.STORAGE_ERROR


# -- model pins ------------------------------------------------------------------------------------


def test_model_store_verifies_size_and_hash(tmp_path: Path) -> None:
    import hashlib

    content = b"model-bytes"
    (tmp_path / "m").mkdir()
    (tmp_path / "m" / "f.bin").write_bytes(content)
    good = ModelFile("f", "m/f.bin", hashlib.sha256(content).hexdigest(), len(content))
    store = ModelStore(tmp_path)
    assert store.path(good) == (tmp_path / "m" / "f.bin").resolve()
    assert not store.available((ModelFile("f", "m/f.bin", "0" * 64, len(content)),))
    assert not store.available((ModelFile("f", "m/f.bin", good.sha256, len(content) + 1),))
    with pytest.raises(ModelUnavailable):
        store.path(ModelFile("f", "../outside.bin", good.sha256, len(content)))
    assert not store.available((ModelFile("x", "m/missing.bin", good.sha256, 1),))
