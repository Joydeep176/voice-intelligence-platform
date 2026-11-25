"""Measurement accuracy on analytic signals (no FFmpeg): the numbers must be right."""

from __future__ import annotations

import json
import math
from typing import Any

import numpy as np
import pytest

from audio_service.contracts import LevelSeries, MeasurementRecord
from audio_service.domain.measurements import (
    CanonicalAnalyzer,
    NativeAnalyzer,
    RunTracker,
    canonical_record,
    full_scale_rule,
    level_series_chunks,
    original_record,
)

RATE = 48_000
FLOAT = full_scale_rule("fltp", None)
S16 = full_scale_rule("s16", 16)


def analyse(
    signal: np.ndarray[Any, Any], *, rule: Any = FLOAT, min_run: int = 1, split: int = 20_011
) -> MeasurementRecord:
    frames = signal.reshape(signal.shape[0], -1).astype(np.float32)
    analyzer = NativeAnalyzer(frames.shape[1], rule, min_run=min_run)
    for start in range(0, frames.shape[0], split):  # odd block size: chunk and block edges differ
        analyzer.feed(frames[start : start + split])
    return original_record(
        analyzer.finish(), sample_rate_hz=RATE, rule=rule, loudness={}, loudness_unavailable=[]
    )


def value(record: MeasurementRecord, name: str, channel: int | None = None) -> float:
    quantities = record.quantities if channel is None else record.perChannel[channel].quantities
    return float(quantities[name].value)


def sine(seconds: float = 1.0, amplitude: float = 1.0, hz: int = 1000) -> np.ndarray[Any, Any]:
    t = np.arange(int(RATE * seconds)) / RATE
    return amplitude * np.sin(2 * math.pi * hz * t)


def test_full_scale_sine_peaks_at_0_dbfs_and_rms_is_minus_3_0103_db() -> None:
    record = analyse(sine())
    assert value(record, "peakDbfs") == pytest.approx(0.0, abs=0.01)
    assert value(record, "rmsDbfs") == pytest.approx(-3.0103, abs=0.01)
    assert value(record, "crestFactorDb") == pytest.approx(3.0103, abs=0.01)
    assert value(record, "rmsLinear") == pytest.approx(1 / math.sqrt(2), abs=1e-6)
    assert value(record, "dcOffset", 0) == pytest.approx(0.0, abs=1e-9)


def test_half_scale_sine_is_exactly_6_0206_db_lower() -> None:
    record = analyse(sine(amplitude=0.5))
    assert value(record, "peakDbfs") == pytest.approx(-6.0206, abs=0.001)
    assert value(record, "rmsDbfs") == pytest.approx(-9.0309, abs=0.001)


def test_dc_signal_has_exact_offset_rms_and_zero_crest_factor() -> None:
    record = analyse(np.full(RATE, 0.25))
    assert value(record, "dcOffset", 0) == pytest.approx(0.25, abs=1e-9)
    assert value(record, "rmsDbfs") == pytest.approx(-12.0412, abs=0.001)
    assert value(record, "crestFactorDb") == pytest.approx(0.0, abs=1e-6)
    negative = analyse(np.full(RATE, -0.5))
    assert value(negative, "dcOffset", 0) == pytest.approx(-0.5, abs=1e-9)
    assert value(negative, "peakLinear") == pytest.approx(0.5)


def test_digital_silence_lists_levels_as_unavailable_and_never_guesses() -> None:
    record = analyse(np.zeros(RATE))
    names = {u.name: u.reason for u in record.unavailable}
    assert names["peakDbfs"] == names["rmsDbfs"] == names["crestFactorDb"] == "digital_silence"
    assert "peakDbfs" not in record.quantities
    assert value(record, "peakLinear") == 0.0 and value(record, "clippedSamples") == 0


def test_square_wave_clipping_counts_are_exact() -> None:
    period, periods = 20, 50
    one = np.concatenate([np.full(10, 32767 / 32768), np.full(10, -1.0)])
    record = analyse(np.tile(one, periods), rule=S16)
    assert value(record, "clippedSamples") == period * periods
    assert value(record, "clippedRatio") == 1.0
    assert value(record, "clippedRuns") == 2 * periods  # one run per rail per period
    assert value(record, "longestClippedRunSamples") == 10


def test_integer_rule_counts_only_the_extreme_codes() -> None:
    x = np.zeros(1000)
    x[10], x[20], x[30], x[40] = 32767 / 32768, -1.0, 32766 / 32768, -32767 / 32768
    record = analyse(x, rule=S16)
    assert value(record, "clippedSamples") == 2  # +32767 and -32768 only
    assert analyse(x, rule=FLOAT).quantities["clippedSamples"].value == 1  # only -1.0 reaches 1.0


def test_float_rule_counts_samples_at_or_beyond_plus_minus_one() -> None:
    x = np.zeros(100)
    x[5], x[6], x[50], x[60] = 1.0, 1.5, -1.0, 0.999
    record = analyse(x)
    assert value(record, "clippedSamples") == 3
    assert value(record, "clippedRuns") == 2  # [5, 6] at the positive rail, [50] at the negative
    assert value(record, "longestClippedRunSamples") == 2


def test_min_run_samples_filters_short_runs_but_not_the_sample_count() -> None:
    x = np.zeros(200)
    x[10] = 1.0  # a single sample
    x[50:54] = 1.0  # a run of four
    record = analyse(x, min_run=2)
    assert value(record, "clippedSamples") == 5
    assert value(record, "clippedRuns") == 1
    assert value(record, "longestClippedRunSamples") == 4


@pytest.mark.parametrize("start", [32_760, 32_767, 20_005, 0])
def test_known_runs_are_counted_once_across_chunk_and_block_boundaries(start: int) -> None:
    x = np.zeros(70_000)
    x[start : start + 9] = 1.0  # 9 samples; 32768 is the analysis chunk, 20011 the block size
    x[50_000:50_003] = -1.0
    x[-4:] = 1.0  # a run still open at the end of the signal
    record = analyse(x)
    assert value(record, "clippedSamples") == 9 + 3 + 4
    assert value(record, "clippedRuns") == 3
    assert value(record, "longestClippedRunSamples") == 9


def test_run_tracker_carries_an_open_run_over_empty_and_all_true_chunks() -> None:
    tracker = RunTracker(1)
    for chunk in ([True, True], [True], [], [True, False, True], [True]):
        tracker.feed(np.array(chunk, dtype=bool))
    tracker.finish()
    assert (tracker.runs, tracker.longest) == (2, 4)  # four consecutive across chunks, then two


def test_white_noise_statistics_with_a_fixed_seed() -> None:
    noise = 0.1 * np.random.default_rng(20261121).standard_normal(RATE * 2)
    record = analyse(noise)
    assert value(record, "rmsDbfs") == pytest.approx(-20.0, abs=0.05)
    assert abs(value(record, "dcOffset", 0)) < 1e-3
    assert 10.0 < value(record, "crestFactorDb") < 16.0
    assert value(record, "clippedSamples") == 0


def test_stereo_correlation_identical_inverted_and_independent() -> None:
    rng = np.random.default_rng(7)
    left = 0.3 * rng.standard_normal(RATE)
    same = analyse(np.stack([left, left], axis=1))
    inverted = analyse(np.stack([left, -left], axis=1))
    independent = analyse(np.stack([left, 0.3 * rng.standard_normal(RATE)], axis=1))
    assert value(same, "correlationCh0Ch1") == 1.0
    assert value(inverted, "correlationCh0Ch1") == -1.0
    assert abs(value(independent, "correlationCh0Ch1")) < 0.02
    assert len(same.perChannel) == 2 and same.channels == 2


def test_correlation_ignores_dc_and_gain_and_is_unavailable_without_variance() -> None:
    left = sine()
    shifted = analyse(np.stack([left, 0.2 * left + 0.5], axis=1))
    assert value(shifted, "correlationCh0Ch1") == 1.0
    flat = analyse(np.stack([left, np.full(RATE, 0.5)], axis=1))
    assert {"name": "correlationCh0Ch1", "reason": "zero_variance"} in [
        u.model_dump() for u in flat.unavailable
    ]


def test_multichannel_pairs_and_mono_source_reason() -> None:
    four = analyse(np.tile(sine(0.1)[:, None], (1, 4)))
    assert {n for n in four.quantities if n.startswith("correlation")} == {
        f"correlationCh{i}Ch{j}" for i in range(4) for j in range(i + 1, 4)
    }
    mono = analyse(sine(0.1))
    assert [u.model_dump() for u in mono.unavailable] == [
        {"name": "interChannelCorrelation", "reason": "mono_source"}
    ]


def test_per_channel_statistics_are_separate() -> None:
    both = np.stack([sine(amplitude=1.0), sine(amplitude=0.1)], axis=1)
    record = analyse(both)
    assert value(record, "peakLinear", 0) == pytest.approx(1.0)
    assert value(record, "peakLinear", 1) == pytest.approx(0.1, abs=1e-6)
    assert value(record, "peakLinear") == pytest.approx(1.0)  # aggregate: the maximum
    assert value(record, "clippedSamples", 1) == 0 and value(record, "clippedSamples", 0) > 0


def test_results_do_not_depend_on_how_the_signal_is_split_into_blocks() -> None:
    signal = np.stack([sine(2.0, 0.7), sine(2.0, 0.4, 330)], axis=1)
    reference = analyse(signal, split=96_000).model_dump_json()
    for split in (977, 8_191, 32_768, 50_000):
        assert analyse(signal, split=split).model_dump_json() == reference


def test_non_finite_samples_are_zeroed_and_counted() -> None:
    x = np.full(100, 0.5, dtype=np.float32)
    x[3] = np.nan
    x[4] = np.inf
    analyzer = NativeAnalyzer(1, FLOAT, min_run=1)
    analyzer.feed(x.reshape(-1, 1))
    stats = analyzer.finish()
    assert stats.non_finite == 2
    assert float(stats.peak[0]) == 0.5


@pytest.mark.parametrize(
    ("fmt", "bits", "positive"),
    [
        ("u8", None, 127 / 128),
        ("s16p", 16, 32767 / 32768),
        ("s32", 24, 8388607 / 8388608),
        ("s32", None, 1.0),
        ("fltp", None, 1.0),
        ("dbl", None, 1.0),
        ("weird", None, 1.0),
    ],
)
def test_full_scale_rule_per_sample_format(fmt: str, bits: int | None, positive: float) -> None:
    rule = full_scale_rule(fmt, bits)
    assert float(rule.positive) == positive and float(rule.negative) == -1.0


# -- canonical -------------------------------------------------------------------------------------


def canon(samples: np.ndarray[Any, Any], *, interval_ms: int = 100, split: int = 7_777) -> Any:
    analyzer = CanonicalAnalyzer(sample_rate_hz=16_000, interval_ms=interval_ms)
    pcm = samples.astype(np.int16)
    for start in range(0, pcm.size, split):
        analyzer.feed(pcm[start : start + split])
    return analyzer.finish()


def test_canonical_statistics_are_exact_for_a_constant() -> None:
    record = canonical_record(
        canon(np.full(32_000, 16_384)), sample_rate_hz=16_000, silence_threshold_centi_dbfs=-5000
    )
    assert float(record.quantities["rmsLinear"].value) == 0.5
    assert float(record.quantities["rmsDbfs"].value) == pytest.approx(-6.0206, abs=0.001)
    assert float(record.quantities["peakLinear"].value) == 0.5
    assert record.quantities["sampleCount"].value == 32_000
    assert float(record.quantities["durationMs"].value) == 2000.0
    assert record.quantities["noiseFloorDbfs"].kind == "estimate"


def test_most_negative_int16_is_full_scale_not_an_overflow() -> None:
    record = canonical_record(
        canon(np.array([-32768] * 1600)), sample_rate_hz=16_000, silence_threshold_centi_dbfs=-5000
    )
    assert float(record.quantities["peakDbfs"].value) == 0.0


def test_silence_ratio_counts_windows_below_the_threshold() -> None:
    loud = np.full(16_000, 8_000)  # ten 100 ms windows at about -12 dBFS
    quiet = np.zeros(16_000)
    record = canonical_record(
        canon(np.concatenate([loud, quiet, loud, loud])),
        sample_rate_hz=16_000,
        silence_threshold_centi_dbfs=-5000,
    )
    assert float(record.quantities["silenceRatio"].value) == 0.25


def test_windows_are_identical_whatever_the_block_split_and_the_last_may_be_short() -> None:
    rng = np.random.default_rng(3)
    samples = (rng.standard_normal(16_000 * 3 + 50) * 3000).astype(np.int16)  # 30.03 windows
    reference = canon(samples, split=len(samples))
    assert reference.windows.rms.size == 31  # 30 full windows and one of 50 samples
    for split in (1, 333, 1600, 5000, 16_000):
        got = canon(samples, split=split)
        assert np.array_equal(got.windows.rms, reference.windows.rms)
        assert np.array_equal(got.windows.peak, reference.windows.peak)
        assert got.sumsq == reference.sumsq and got.peak == reference.peak
    last = samples[-50:].astype(np.float64)
    assert reference.windows.rms[-1] == pytest.approx(math.sqrt(np.mean(last**2)) / 32768)


def test_noise_floor_is_the_lower_tenth_percentile_window() -> None:
    levels = [100 * (i + 1) for i in range(20)]  # 20 windows of constant amplitude
    samples = np.concatenate([np.full(1600, v) for v in levels])
    record = canonical_record(
        canon(samples), sample_rate_hz=16_000, silence_threshold_centi_dbfs=-5000
    )
    expected = 20 * math.log10(levels[(20 - 1) // 10] / 32768)  # sorted index 1
    assert float(record.quantities["noiseFloorDbfs"].value) == pytest.approx(expected, abs=0.001)


def test_unmeasurable_quantities_are_listed_with_reasons() -> None:
    record = canonical_record(
        canon(np.full(1600, 5)), sample_rate_hz=16_000, silence_threshold_centi_dbfs=-5000
    )
    reasons = {u.name: u.reason for u in record.unavailable}
    assert reasons == {"snr": "no_speech_split", "harmonicDistortion": "no_reference"}


def test_level_series_json_is_compact_valid_and_null_for_digital_silence() -> None:
    samples = np.concatenate([np.full(1600, 16_384), np.zeros(1600), np.full(800, 3)])
    stats = canon(samples)
    raw = b"".join(level_series_chunks(stats, sample_rate_hz=16_000))
    series = LevelSeries.model_validate_json(raw)
    assert series.windows == 3 == len(series.rmsDbfs) == len(series.peakDbfs)
    assert series.rmsDbfs[0] == pytest.approx(-6.02, abs=0.01)
    assert series.rmsDbfs[1] is None and series.peakDbfs[1] is None
    assert b" " not in raw and b"\n" not in raw
    assert json.loads(raw)["intervalMs"] == 100


def test_level_series_of_many_windows_spans_several_chunks() -> None:
    stats = canon(np.full(16_000 * 30, 1000), interval_ms=10)  # 3000 windows
    series = json.loads(b"".join(level_series_chunks(stats, sample_rate_hz=16_000)))
    assert series["windows"] == len(series["rmsDbfs"]) == len(series["peakDbfs"]) == 3000
    big = canon(np.full(16_000 * 130, 1000), interval_ms=10)  # 13000 windows: two series chunks
    parsed = json.loads(b"".join(level_series_chunks(big, sample_rate_hz=16_000)))
    assert len(parsed["rmsDbfs"]) == 13_000 == len(parsed["peakDbfs"])
