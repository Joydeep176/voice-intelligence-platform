"""Phase 3A `measure` task (ADR-0045): numbers only, deterministic, bounded. Synthetic signals;
the speech detector is a fake with the streaming interface (the real Silero path is covered by the
container tests)."""

from __future__ import annotations

import json
import math
import re

import numpy as np
import pytest
from pydantic import ValidationError

from audio_service.contracts import MeasureConfig, MeasureResult, VadInfo, VadSettings
from audio_service.domain.measure import analyse, spans_to_mask

SR = 16_000
FORBIDDEN_KEY = re.compile(r"quality|score|grade|verdict|recommend|rating|severity|diagnos")
VAD = VadSettings(threshold=0.4, minSilenceMs=300, minSpeechMs=250, paddingMs=200)


def config(duration_ms: int, **over: int) -> MeasureConfig:
    base = {
        "schemaVersion": 1,
        "audioDurationMs": duration_ms,
        "vad": VAD.model_dump(),
        "blockMs": 1000,
        "windowMs": 30_000,
        "overlapMs": 1000,
        "ltasDropDb": 50,
        "ltasMinHz": 300,
        "snrNearCleanDb": 45,
    }
    return MeasureConfig.model_validate({**base, **over})


class FakeDetector:
    """Returns the given absolute spans; records how much audio it was fed."""

    def __init__(self, spans: list[tuple[int, int]]) -> None:
        self.spans = spans
        self.fed = 0

    def start(self) -> None:
        self.fed = 0

    def feed(self, block: np.ndarray) -> None:
        self.fed += len(block)

    def finish(self) -> list[tuple[int, int]]:
        return self.spans


def scene(
    seconds: int, snr_db: float | None, seed: int = 1
) -> tuple[np.ndarray, list[tuple[int, int]]]:
    """Speech-like bursts (gamma noise) 2 s on / 1 s off, plus white noise at `snr_db` measured
    over the speech samples; returns float32 signal and the burst spans (ms)."""
    rng = np.random.default_rng(seed)
    n = seconds * SR
    x = np.zeros(n)
    spans = []
    for start in range(0, seconds * 1000 - 2000, 3000):
        a, b = start * 16, (start + 2000) * 16
        x[a:b] = rng.gamma(0.4, 1.0, b - a) * rng.choice((-1.0, 1.0), b - a)
        spans.append((start, start + 2000))
    speech = spans_to_mask(spans, n // 160).repeat(160)
    x *= 0.1 / math.sqrt(np.mean(x[speech] ** 2))
    if snr_db is not None:
        noise = rng.standard_normal(n)
        noise *= math.sqrt(
            np.mean(x[speech] ** 2) / (np.mean(noise[speech] ** 2) * 10 ** (snr_db / 10))
        )
        x = x + noise
    return x.astype(np.float32), spans


def reader(x: np.ndarray):
    return lambda s, e: x[s * 16 : e * 16]


def run(x: np.ndarray, spans: list[tuple[int, int]], **over: int):
    duration = len(x) // 16
    return analyse(reader(x), duration, config(duration, **over), FakeDetector(spans))


def test_snr_estimate_tracks_a_known_snr() -> None:
    for target in (20, 10, 5):
        x, spans = scene(60, target)
        record, _, _ = run(x, spans)
        snr = record.quantities["snrDb"]
        assert snr.kind == "estimate"
        assert abs(snr.value - target) < 1.0


def test_near_clean_switch_resists_speech_missed_by_the_vad() -> None:
    """OD-52 (M6): on near-clean audio, speech the VAD misses leaks into the noise frames and
    drags the mean-based SNR down; the median switch keeps the recording and its blocks clean."""
    x, spans = scene(60, 60)
    missed = [(a, b - 1000) if i % 4 == 0 else (a, b) for i, (a, b) in enumerate(spans)]
    leaky, _, _ = run(x, missed, snrNearCleanDb=80)  # switch out of reach: mean only
    assert leaky.quantities["snrDb"].value < 30
    record, series, _ = run(x, missed)
    snr = record.quantities["snrDb"]
    assert snr.value >= 45
    assert "median" in snr.method
    assert all(v is None or v >= 45 for v in series.snrDb)


def test_noisy_audio_keeps_the_mean_estimate() -> None:
    x, spans = scene(60, 10)
    record, _, _ = run(x, spans)
    assert "mean" in record.quantities["snrDb"].method


def test_quantities_have_units_kinds_and_methods_and_no_judgement_keys() -> None:
    x, spans = scene(60, 15)
    record, series, warnings = run(x, spans)
    names = set(record.quantities)
    assert {
        "speechMs",
        "speechRatio",
        "speechSpanCount",
        "activeSpeechLevelDbfs",
        "nonSpeechLevelDbfs",
        "snrDb",
        "levelSpreadDb",
        "maxSpansPerWindow",
        "bandwidthEdgeHz",
    } <= names
    assert record.quantities["speechRatio"].unit == "ratio"
    assert abs(record.quantities["speechRatio"].value - 40_000 / 60_000) < 0.01
    assert series.blockMs == 1000 and len(series.speechMs) == len(series.snrDb) == 60
    assert warnings == []
    result = MeasureResult(
        schemaVersion=1,
        vad=VadInfo(model="silero_vad_v6.2.3.onnx", sha256="a" * 64, settings=VAD),
        record=record,
        series=series,
        warnings=warnings,
    )
    dumped = json.dumps(result.model_dump(mode="json"))
    assert not FORBIDDEN_KEY.search(dumped)


def test_reasons_instead_of_guesses() -> None:
    x = np.zeros(10 * SR, dtype=np.float32)  # digital silence, no speech
    record, series, warnings = run(x, [])
    reasons = {u.name: u.reason for u in record.unavailable}
    assert reasons["snrDb"] == "no_speech"
    assert reasons["activeSpeechLevelDbfs"] == "no_speech"
    assert reasons["bandwidthEdgeHz"] == "no_speech_frames"
    assert reasons["levelSpreadDb"] == "too_few_speech_blocks"
    assert record.quantities["speechMs"].value == 0
    assert warnings == ["no_speech"]
    assert all(v is None for v in series.snrDb)


def test_no_noise_frames_is_reported() -> None:
    x, _ = scene(10, 20)
    record, _, _ = run(x, [(0, 10_000)])  # everything is speech
    assert {u.name: u.reason for u in record.unavailable}["snrDb"] == "no_noise_frames"


def test_bandwidth_edge_follows_a_band_limit() -> None:
    x, spans = scene(30, None)
    spec = np.fft.rfft(x.astype(np.float64))
    spec[np.fft.rfftfreq(len(x), 1 / SR) > 3400] = 0
    narrow = np.fft.irfft(spec, len(x)).astype(np.float32)
    full, _, _ = run(x, spans)
    band, _, _ = run(narrow, spans)
    assert full.quantities["bandwidthEdgeHz"].value > 7500
    assert 3300 <= band.quantities["bandwidthEdgeHz"].value <= 3400 + 4 * 31.25


def test_spans_per_window_counts_fragmented_speech() -> None:
    spans = [(500 + i * 1800, 1500 + i * 1800) for i in range(16)]  # 16 x 1 s, 0.8 s gaps
    x = np.zeros(30 * SR, dtype=np.float32)
    record, _, _ = run(x, spans)
    # 0.8 s gaps survive 200 ms padding: 16 separate spans in the single 30 s window
    assert record.quantities["maxSpansPerWindow"].value == 16


def test_deterministic_and_streamed() -> None:
    x, spans = scene(95, 10)  # not a multiple of the 30 s read block
    det = FakeDetector(spans)
    duration = len(x) // 16
    a = analyse(reader(x), duration, config(duration), det)
    assert det.fed == len(x)
    b = analyse(reader(x), duration, config(duration), FakeDetector(spans))
    assert a[0].model_dump_json() == b[0].model_dump_json()
    assert a[1].model_dump_json() == b[1].model_dump_json()


def test_config_is_validated() -> None:
    with pytest.raises(ValidationError):
        config(1000, overlapMs=20_000)
    with pytest.raises(ValidationError):
        config(1000, blockMs=10)
    with pytest.raises(ValidationError):
        MeasureConfig.model_validate({**config(1000).model_dump(), "extra": 1})
