"""Seeded random frame sequences against the segmentation invariants (plan §11.1; OD-10 interim)."""

from __future__ import annotations

import numpy as np
import pytest

from audio_service.contracts import PreprocessSegmentationConfig
from audio_service.domain.segmentation import SegmentationParams, segment_speech

SEEDS = range(60)


def random_params(rng: np.random.Generator) -> SegmentationParams:
    """Parameters the config schema accepts (multiples of 10 ms, the three cross-field rules)."""
    maximum = int(rng.integers(100, 600)) * 10
    split = int(rng.integers(10, 120)) * 10
    return SegmentationParams(
        min_segment_ms=int(rng.integers(10, maximum // 10 + 1)) * 10,
        max_segment_ms=maximum,
        split_silence_ms=split,
        merge_gap_ms=int(rng.integers(0, split // 10 + 1)) * 10,
        padding_ms=int(rng.integers(0, 40)) * 10,
        forced_split_overlap_ms=int(rng.integers(0, maximum // 40 + 1)) * 10,
    )


def random_frames(rng: np.random.Generator) -> np.ndarray:
    total = int(rng.integers(1, 6000))
    flags = np.zeros(total, dtype=np.bool_)
    position, speaking = 0, bool(rng.integers(0, 2))
    while position < total:
        length = int(rng.integers(1, 400 if speaking else 120))
        flags[position : position + length] = speaking
        position, speaking = position + length, not speaking
    return flags


@pytest.mark.parametrize("seed", SEEDS)
def test_invariants_hold_for_random_inputs(seed: int) -> None:  # noqa: PLR0914
    rng = np.random.default_rng(seed)
    params, flags = random_params(rng), random_frames(rng)
    PreprocessSegmentationConfig.model_validate(  # the generator stays inside the schema
        {
            "minSegmentMs": params.min_segment_ms,
            "maxSegmentMs": params.max_segment_ms,
            "splitSilenceMs": params.split_silence_ms,
            "mergeGapMs": params.merge_gap_ms,
            "paddingMs": params.padding_ms,
            "forcedSplitOverlapMs": params.forced_split_overlap_ms,
        }
    )
    # a partial final frame, as a real file has
    total_ms = flags.size * 10 - int(rng.integers(0, 10))
    energy = rng.random(flags.size)
    segments = segment_speech(flags, energy, total_ms=total_ms, params=params)
    again = segment_speech(flags.copy(), energy.copy(), total_ms=total_ms, params=params)
    assert segments == again  # deterministic

    if not flags.any():
        assert segments == []
        return
    assert [s.index for s in segments] == list(range(len(segments)))
    covered = np.zeros(flags.size, dtype=np.bool_)
    for position, seg in enumerate(segments):
        length = seg.end_ms - seg.start_ms
        assert 0 <= seg.start_ms < seg.end_ms <= total_ms  # within bounds, never zero length
        assert 0 <= seg.speech_ms <= length
        assert length <= params.max_segment_ms
        assert seg.overlap_start_ms <= length and seg.overlap_end_ms <= length
        covered[seg.start_ms // 10 : -(-seg.end_ms // 10)] = True
        if position:
            before = segments[position - 1]
            assert seg.start_ms > before.start_ms  # sorted
            assert before.overlap_end_ms == seg.overlap_start_ms  # both sides declare the same
            # Segments overlap only by the declared amount, and otherwise do not touch.
            assert seg.start_ms == before.end_ms - seg.overlap_start_ms or (
                seg.overlap_start_ms == 0 and seg.start_ms >= before.end_ms
            )
    assert segments[0].overlap_start_ms == 0 and segments[-1].overlap_end_ms == 0
    assert covered[flags].all()  # coverage: every speech frame is inside a segment
    assert sum(s.speech_ms for s in segments) >= int(flags.sum()) * 10 - 10  # nothing dropped
