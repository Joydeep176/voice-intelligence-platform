"""Segmentation rules (plan §11.1) on hand-built 10 ms frames. Interim parameters (OD-10 Open)."""

from __future__ import annotations

import time
import tracemalloc
from typing import Any

import numpy as np
import pytest

from audio_service.domain.segmentation import (
    FrameStatsBuilder,
    Segment,
    SegmentationParams,
    measure_segments,
    segment_speech,
    total_ms_of,
)

F = 10  # ms per frame
DEFAULTS = SegmentationParams()


def speech(total: int, *runs: tuple[int, int]) -> Any:
    """`total` frames with speech in the half-open frame runs."""
    flags = np.zeros(total, dtype=np.bool_)
    for start, end in runs:
        flags[start:end] = True
    return flags


def run(  # noqa: PLR0913
    flags: Any,
    *,
    params: SegmentationParams = DEFAULTS,
    energy: Any = None,
    total_ms: int | None = None,
    gaps: Any = (),
) -> list[Segment]:
    return segment_speech(
        flags,
        np.ones(flags.size) if energy is None else energy,
        total_ms=flags.size * F if total_ms is None else total_ms,
        params=params,
        gaps=gaps,
    )


def spans(segments: list[Segment]) -> list[tuple[int, int]]:
    return [(s.start_ms, s.end_ms) for s in segments]


def test_the_defaults_are_the_interim_values() -> None:
    assert DEFAULTS == SegmentationParams(1000, 30000, 500, 300, 200, 1000)


def test_no_speech_gives_no_segments() -> None:
    assert run(speech(0)) == []
    assert run(speech(500)) == []


def test_a_region_is_padded_on_both_sides() -> None:
    assert spans(run(speech(500, (100, 200)))) == [(800, 2200)]


def test_padding_is_clamped_at_the_file_edges() -> None:
    assert spans(run(speech(100, (5, 90)))) == [(0, 1000)]  # 50 ms .. 900 ms, +-200 ms


def test_a_gap_below_the_merge_threshold_joins_the_regions() -> None:
    segments = run(speech(600, (100, 200), (220, 320)))  # 200 ms silence < 300 ms
    assert spans(segments) == [(800, 3400)]
    assert segments[0].speech_ms == 2000  # both runs, the gap is not speech


def test_a_gap_at_the_merge_threshold_keeps_the_regions_apart() -> None:
    # 300 ms silence is not below 300 ms; the padding of 2 x 200 ms would cross, so the gap is
    # split midway (150 ms each) and the segments touch.
    segments = run(speech(600, (100, 200), (230, 330)))
    assert spans(segments) == [(800, 2150), (2150, 3500)]


def test_padding_does_not_cross_into_a_neighbour_and_covers_a_wide_gap_fully() -> None:
    wide = run(speech(900, (100, 200), (290, 390)))  # 900 ms gap: full padding both sides
    assert spans(wide) == [(800, 2200), (2700, 4100)]
    narrow = run(speech(900, (100, 200), (235, 335)))  # 350 ms gap: split at +175 ms
    assert spans(narrow) == [(800, 2170), (2170, 3550)]  # 175 ms rounded down to the grid


def test_silence_at_or_above_the_split_threshold_never_bridges_short_regions() -> None:
    short = ((100, 130), (190, 220))  # each 300 ms + padding = 700 ms < 1000 ms, gap 600 ms
    assert len(run(speech(400, *short))) == 2
    near = ((100, 130), (175, 205))  # gap 450 ms: below the split threshold, merge allowed
    assert len(run(speech(400, *near))) == 1


def test_a_short_region_merges_with_the_nearer_neighbour() -> None:
    # A is long; S is short with 450 ms of silence to A and 350 ms to B, so S joins B.
    segments = run(speech(1200, (100, 300), (345, 360), (395, 595)))
    assert spans(segments) == [(800, 3200), (3250, 6150)]


def test_a_short_region_merges_into_the_earlier_neighbour_on_a_tie() -> None:
    segments = run(speech(1000, (100, 300), (345, 360), (405, 605)))  # 450 ms on both sides
    assert spans(segments) == [(800, 3800), (3850, 6250)]


def test_a_short_region_stays_when_the_joined_length_exceeds_the_maximum() -> None:
    params = SegmentationParams(1000, 3000, 500, 300, 200, 500)
    flags = speech(400, (50, 280), (320, 330))  # A: 2300 ms padded; S short; joined > 3000 ms
    segments = run(flags, params=params)
    assert len(segments) == 2
    assert segments[1].speech_ms == 100  # never dropped, even though short


def test_an_isolated_short_region_is_kept() -> None:
    segments = run(speech(300, (100, 110)))
    assert spans(segments) == [(800, 1300)]
    assert segments[0].speech_ms == 100


def test_a_region_longer_than_the_maximum_splits_at_the_lowest_energy_frame() -> None:
    params = SegmentationParams(1000, 3000, 500, 300, 0, 500)  # no padding: easy to read
    energy = np.ones(700)
    energy[260] = 0.0  # in the last quarter [225, 300) of the first window
    energy[100] = -1.0  # lower, but outside that quarter: must be ignored
    segments = run(speech(700, (0, 700)), params=params, energy=energy)
    first, second = segments[0], segments[1]
    assert (first.start_ms, first.end_ms) == (0, 2600)
    assert first.overlap_start_ms == 0 and first.overlap_end_ms == 500
    assert second.start_ms == 2100 and second.overlap_start_ms == 500
    assert second.start_ms == first.end_ms - first.overlap_end_ms
    assert all(s.end_ms - s.start_ms <= 3000 for s in segments)
    assert segments[-1].end_ms == 7000 and segments[-1].overlap_end_ms == 0


def test_the_split_tie_break_is_the_earliest_frame() -> None:
    params = SegmentationParams(1000, 3000, 500, 300, 0, 500)
    segments = run(speech(400, (0, 400)), params=params)  # flat energy
    assert segments[0].end_ms == 2250  # first frame of the last quarter, 225 * 10 ms


def test_the_forced_split_overlap_is_clamped_to_half_the_piece() -> None:
    params = SegmentationParams(1000, 1000, 500, 300, 0, 2500)  # unreachable via the config
    segments = run(speech(300, (0, 300)), params=params)
    assert segments[0].overlap_end_ms == (segments[0].end_ms - segments[0].start_ms) // 2 // 10 * 10


def test_only_forced_splits_overlap() -> None:
    segments = run(speech(2000, (100, 200), (300, 400), (800, 900)))
    assert all(s.overlap_start_ms == 0 and s.overlap_end_ms == 0 for s in segments)


def test_speech_ms_counts_speech_frames_inside_the_segment() -> None:
    segments = run(speech(500, (100, 130), (140, 170)))  # joined, 100 ms gap
    assert len(segments) == 1 and segments[0].speech_ms == 600


def test_speech_ms_never_exceeds_the_length_with_a_partial_final_frame() -> None:
    flags = speech(100, (0, 100))  # 995 ms of audio: the last frame is 5 ms
    segments = run(flags, total_ms=995)
    assert spans(segments) == [(0, 995)]
    assert segments[0].speech_ms == 995


def test_a_segment_intersecting_a_synthetic_gap_is_flagged() -> None:
    flags = speech(1000, (100, 200), (600, 700))
    gaps = [(2500.0, 2500.0 + 40.0)]  # between the two segments: not intersecting
    assert [s.contains_synthetic_gap for s in run(flags, gaps=gaps)] == [False, False]
    inside = [(1500.0, 1520.0)]  # inside the first speech region
    assert [s.contains_synthetic_gap for s in run(flags, gaps=inside)] == [True, False]
    edge = [(2200.0, 2300.0)]  # starts exactly where the first segment ends: half-open
    assert [s.contains_synthetic_gap for s in run(flags, gaps=edge)] == [False, False]


def test_indices_run_from_zero_in_time_order() -> None:
    segments = run(speech(3000, (100, 200), (1000, 1100), (2000, 2100)))
    assert [s.index for s in segments] == [0, 1, 2]
    assert [s.start_ms for s in segments] == sorted(s.start_ms for s in segments)


def test_the_result_is_deterministic() -> None:
    rng = np.random.default_rng(5)
    flags = rng.random(5000) < 0.4
    energy = rng.random(5000)
    assert run(flags, energy=energy) == run(flags.copy(), energy=energy.copy())


def test_the_energy_array_must_match_the_frames() -> None:
    with pytest.raises(ValueError, match="energy"):
        segment_speech(speech(10, (1, 2)), np.ones(9), total_ms=100, params=DEFAULTS)


def test_four_hours_of_speech_are_split_in_bounded_time_and_memory() -> None:
    frames = 4 * 3600 * 100
    flags = np.ones(frames, dtype=np.bool_)
    energy = np.random.default_rng(1).random(frames)
    tracemalloc.start()
    started = time.perf_counter()
    segments = run(flags, energy=energy)
    elapsed = time.perf_counter() - started
    peak = tracemalloc.get_traced_memory()[1]
    tracemalloc.stop()
    assert elapsed < 10 and peak < 120 * 1024 * 1024
    assert segments[0].start_ms == 0 and segments[-1].end_ms == frames * F
    assert all(s.end_ms - s.start_ms <= 30000 for s in segments)
    for before, after in zip(segments, segments[1:], strict=False):
        assert (
            after.start_ms
            == before.end_ms - before.overlap_end_ms
            == (before.end_ms - after.overlap_start_ms)
        )


# -- frame statistics and per-segment measurements ----------------------------------------------


@pytest.mark.parametrize("block", [1, 159, 160, 161, 1000, 4096])
def test_frame_stats_do_not_depend_on_the_block_size(block: int) -> None:
    rng = np.random.default_rng(3)
    samples = rng.integers(-32767, 32768, size=1000, dtype=np.int16)  # 6 frames + 40 samples
    samples[500] = -32768
    reference = FrameStatsBuilder()
    reference.feed(samples)
    streamed = FrameStatsBuilder()
    for start in range(0, samples.size, block):
        streamed.feed(samples[start : start + block])
    a, b = reference.finish(), streamed.finish()
    assert np.array_equal(a.sumsq, b.sumsq) and np.array_equal(a.peak, b.peak)
    assert a.frames == 7 and a.samples == 1000
    wide = samples.astype(np.int64)
    assert a.sumsq[0] == int(np.dot(wide[:160], wide[:160]))
    assert a.sumsq[6] == int(np.dot(wide[960:], wide[960:]))
    assert a.peak.max() == 32768  # |-32768| does not overflow


def test_segment_measurements_are_exact_and_linked_by_index() -> None:
    samples = np.zeros(16_000, dtype=np.int16)
    samples[3200:6400] = 8192  # 200 .. 400 ms at 0.25 of full scale
    builder = FrameStatsBuilder()
    builder.feed(samples)
    stats = builder.finish()
    found = run(speech(100, (20, 40)), params=SegmentationParams(100, 30000, 500, 300, 0, 0))
    records = measure_segments(stats, found, vad_method="example-vad")
    assert [index for index, _ in records] == [0]
    q = records[0][1].quantities
    assert records[0][1].source == "canonical" and records[0][1].frames == 3200
    assert q["sampleCount"].value == 3200 and q["speechMs"].value == 200
    assert q["peakLinear"].value == 0.25 and q["rmsLinear"].value == 0.25
    assert q["rmsDbfs"].value == pytest.approx(-12.041, abs=1e-3)
    assert q["speechMs"].kind == "estimate"


def test_a_silent_segment_lists_the_levels_as_unavailable() -> None:
    builder = FrameStatsBuilder()
    builder.feed(np.zeros(16_000, dtype=np.int16))
    found = run(speech(100, (20, 40)), params=SegmentationParams(100, 30000, 500, 300, 0, 0))
    record = measure_segments(builder.finish(), found, vad_method="example-vad")[0][1]
    assert {u.name for u in record.unavailable} == {"peakDbfs", "rmsDbfs"}
    assert all(u.reason == "digital_silence" for u in record.unavailable)


def test_total_ms_rounds_up() -> None:
    assert (total_ms_of(32000), total_ms_of(31999), total_ms_of(1)) == (2000, 2000, 1)
