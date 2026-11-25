"""Speech segmentation on the canonical timeline (Phase 2B WS6; plan §11.1). VAD-agnostic.

Input: one boolean per 10 ms frame (from any `VoiceActivityDetector`) and per-frame energy of the
canonical audio. Output: segments, half-open `[start, end)` in whole milliseconds on the canonical
timeline C. Everything is deterministic integer or exact-sum arithmetic and runs on the 10 ms grid
(every boundary is a multiple of 10 ms, except an end clamped to the canonical duration).

The parameters are INTERIM DEVELOPMENT DEFAULTS (OD-10 Open); they are not approved values.

Rules, in order:
1. Raw speech runs separated by fewer than `merge_gap_ms` of silence are merged.
2. Each region is padded by `padding_ms` on both sides, clamped to the file; padding never crosses
   a neighbour (a gap shorter than twice the padding is split midway, rounded down to the grid).
3. A region shorter than `min_segment_ms` is merged into its nearer neighbour (ties go to the
   earlier one) if the silence between them is below `split_silence_ms` and the joined length does
   not exceed `max_segment_ms`; otherwise it is kept as it is. Speech is never dropped, so a
   short segment can remain (an isolated short utterance, or a short tail of a forced split).
4. A region longer than `max_segment_ms` is split at the lowest-energy 10 ms frame (earliest on a
   tie) within the last quarter of the window that starts at the current piece's start. The next
   piece starts `forced_split_overlap_ms` before the split (clamped to half the earlier piece), so
   both pieces declare that overlap (`overlap_end_ms` / `overlap_start_ms`). Only forced splits
   overlap.
5. `speech_ms` counts the speech frames inside the segment; `contains_synthetic_gap` is true when
   the segment intersects a filled timestamp gap of the timeline.
Coverage: every speech frame lies inside at least one segment.
"""

from __future__ import annotations

import math
from bisect import bisect_left
from collections.abc import Sequence
from dataclasses import dataclass

import numpy as np
import numpy.typing as npt

from audio_service.contracts import MeasurementRecord, PreprocessSegmentationConfig
from audio_service.domain.measurements import segment_record
from audio_service.domain.vad import FRAME_MS, FRAME_SAMPLES

I16 = npt.NDArray[np.int16]
BoolArray = npt.NDArray[np.bool_]
CANONICAL_SAMPLES_PER_MS = 16


@dataclass(frozen=True)
class SegmentationParams:
    """Defaults are interim development values (OD-10 Open)."""

    min_segment_ms: int = 1000
    max_segment_ms: int = 30000
    split_silence_ms: int = 500
    merge_gap_ms: int = 300
    padding_ms: int = 200
    forced_split_overlap_ms: int = 1000

    @classmethod
    def from_config(cls, config: PreprocessSegmentationConfig) -> SegmentationParams:
        return cls(
            min_segment_ms=config.minSegmentMs,
            max_segment_ms=config.maxSegmentMs,
            split_silence_ms=config.splitSilenceMs,
            merge_gap_ms=config.mergeGapMs,
            padding_ms=config.paddingMs,
            forced_split_overlap_ms=config.forcedSplitOverlapMs,
        )


@dataclass(frozen=True)
class Segment:
    index: int
    start_ms: int
    end_ms: int
    overlap_start_ms: int
    overlap_end_ms: int
    speech_ms: int
    contains_synthetic_gap: bool


# -- per-frame statistics of the canonical audio ---------------------------------------------------


@dataclass(frozen=True)
class FrameStats:
    """Exact per-frame integer sums of the canonical samples (the last frame may be partial)."""

    sumsq: npt.NDArray[np.int64]
    peak: npt.NDArray[np.int32]
    samples: int

    @property
    def frames(self) -> int:
        return int(self.sumsq.size)

    def energy(self) -> npt.NDArray[np.float64]:
        """Mean square per frame (monotone in RMS, which is what the split rule compares)."""
        counts = np.full(self.frames, FRAME_SAMPLES, dtype=np.float64)
        if self.frames:
            counts[-1] = self.samples - (self.frames - 1) * FRAME_SAMPLES
        return np.asarray(self.sumsq / counts, dtype=np.float64)


class FrameStatsBuilder:
    """Streaming per-frame sums over blocks of any length (carries a partial frame across blocks).
    Memory: 12 bytes per 10 ms frame (about 17 MB for four hours)."""

    def __init__(self) -> None:
        self._carry: I16 = np.zeros(0, dtype=np.int16)
        self._sumsq: list[npt.NDArray[np.int64]] = []
        self._peak: list[npt.NDArray[np.int32]] = []
        self._samples = 0

    def feed(self, block: I16) -> None:
        self._samples += int(block.size)
        data = np.concatenate((self._carry, block)) if self._carry.size else block
        full = data.size // FRAME_SAMPLES
        if full:
            self._add(data[: full * FRAME_SAMPLES].reshape(full, FRAME_SAMPLES))
        self._carry = data[full * FRAME_SAMPLES :].copy()

    def _add(self, frames: I16) -> None:
        wide = frames.astype(np.int64)
        self._sumsq.append(np.einsum("ij,ij->i", wide, wide))
        self._peak.append(np.abs(wide).max(axis=1).astype(np.int32))

    def finish(self) -> FrameStats:
        if self._carry.size:
            self._add(self._carry.reshape(1, -1))
            self._carry = np.zeros(0, dtype=np.int16)
        return FrameStats(
            sumsq=np.concatenate(self._sumsq) if self._sumsq else np.zeros(0, dtype=np.int64),
            peak=np.concatenate(self._peak) if self._peak else np.zeros(0, dtype=np.int32),
            samples=self._samples,
        )


# -- segmentation ----------------------------------------------------------------------------------


def _raw_regions(speech: BoolArray, merge_gap: int) -> tuple[list[int], list[int]]:
    edges = np.diff(speech.astype(np.int8), prepend=np.int8(0), append=np.int8(0))
    starts = np.flatnonzero(edges == 1).tolist()
    ends = np.flatnonzero(edges == -1).tolist()
    cs: list[int] = []
    ce: list[int] = []
    for start, end in zip(starts, ends, strict=True):
        if ce and start - ce[-1] < merge_gap:
            ce[-1] = end
        else:
            cs.append(start)
            ce.append(end)
    return cs, ce


def _padded(cs: list[int], ce: list[int], pad: int, total: int) -> tuple[list[int], list[int]]:
    ps = [max(0, start - pad) for start in cs]
    pe = [min(total, end + pad) for end in ce]
    for i in range(len(cs) - 1):
        gap = cs[i + 1] - ce[i]
        if gap < 2 * pad:
            pe[i] = ps[i + 1] = ce[i] + gap // 2
    return ps, pe


def _merge_short(  # noqa: PLR0913, PLR0917
    cs: list[int],
    ce: list[int],
    ps: list[int],
    pe: list[int],
    p: tuple[int, int, int],
) -> list[int]:
    """Rule 3 on a linked list of regions. Returns the surviving region ids in time order."""
    min_f, max_f, split_f = p
    count = len(cs)
    nxt = [*range(1, count), -1]
    prv = [-1, *range(count - 1)]
    i = 0  # region 0 is never removed: a merge keeps the earlier region
    while i != -1:
        if pe[i] - ps[i] < min_f:
            left, right = prv[i], nxt[i]
            gap_left = cs[i] - ce[left] if left != -1 else None
            gap_right = cs[right] - ce[i] if right != -1 else None
            if gap_left is not None and (gap_right is None or gap_left <= gap_right):
                a, b, gap = left, i, gap_left
            elif gap_right is not None:
                a, b, gap = i, right, gap_right
            else:
                break
            if gap < split_f and pe[b] - ps[a] <= max_f:
                ce[a], pe[a] = ce[b], pe[b]
                nxt[a] = nxt[b]
                if nxt[b] != -1:
                    prv[nxt[b]] = a
                i = a  # the joined region may still be short
                continue
        i = nxt[i]
    order: list[int] = []
    j = 0
    while j != -1:
        order.append(j)
        j = nxt[j]
    return order


def _forced_splits(  # noqa: PLR0913, PLR0917
    start: int, end: int, energy: npt.NDArray[np.float64], max_f: int, overlap_f: int
) -> list[tuple[int, int, int, int]]:
    """Rule 4 for one region: (start, end, overlap_start, overlap_end) frames per piece."""
    pieces: list[tuple[int, int, int, int]] = []
    overlap_in = 0
    while end - start > max_f:
        lo = start + (3 * max_f) // 4
        split = lo + int(np.argmin(energy[lo : start + max_f]))  # earliest minimum
        overlap = min(overlap_f, (split - start) // 2)
        pieces.append((start, split, overlap_in, overlap))
        start, overlap_in = split - overlap, overlap
    pieces.append((start, end, overlap_in, 0))
    return pieces


def segment_speech(  # noqa: PLR0913
    speech: BoolArray,
    energy: npt.NDArray[np.float64],
    *,
    total_ms: int,
    params: SegmentationParams,
    gaps: Sequence[tuple[float, float]] = (),
) -> list[Segment]:
    """Segments of the speech frames. `total_ms` is the canonical duration rounded up to a whole
    millisecond; `gaps` are the filled timestamp gaps as (start, end) in ms on the timeline."""
    total = int(speech.size)
    if total == 0 or not speech.any():
        return []
    if energy.size != total:
        raise ValueError("one energy value per frame")
    min_f = params.min_segment_ms // FRAME_MS
    max_f = params.max_segment_ms // FRAME_MS
    split_f = params.split_silence_ms // FRAME_MS
    cs, ce = _raw_regions(speech, params.merge_gap_ms // FRAME_MS)
    ps, pe = _padded(cs, ce, params.padding_ms // FRAME_MS, total)
    survivors = _merge_short(cs, ce, ps, pe, (min_f, max_f, split_f))

    pieces: list[tuple[int, int, int, int]] = []
    for region in survivors:
        pieces += _forced_splits(
            ps[region],
            pe[region],
            energy,
            max_f,
            params.forced_split_overlap_ms // FRAME_MS,
        )

    cumulative = np.concatenate((np.zeros(1, dtype=np.int64), np.cumsum(speech, dtype=np.int64)))
    last_frame_ms = total_ms - (total - 1) * FRAME_MS  # the final frame may be partial
    gap_starts = sorted(gaps)
    starts = [g[0] for g in gap_starts]
    longest_end: list[float] = []
    for _, end in gap_starts:
        longest_end.append(max(end, longest_end[-1]) if longest_end else end)

    segments: list[Segment] = []
    for index, (sf, ef, ov_start, ov_end) in enumerate(pieces):
        start_ms, end_ms = sf * FRAME_MS, min(ef * FRAME_MS, total_ms)
        speech_ms = int(cumulative[ef] - cumulative[sf]) * FRAME_MS
        if ef == total and speech[total - 1]:
            speech_ms -= FRAME_MS - last_frame_ms
        reach = bisect_left(starts, end_ms)  # gaps that begin before the segment ends
        synthetic = reach > 0 and longest_end[reach - 1] > start_ms
        segments.append(
            Segment(
                index=index,
                start_ms=start_ms,
                end_ms=end_ms,
                overlap_start_ms=ov_start * FRAME_MS,
                overlap_end_ms=ov_end * FRAME_MS,
                speech_ms=speech_ms,
                contains_synthetic_gap=synthetic,
            )
        )
    return segments


def total_ms_of(samples: int) -> int:
    """Canonical duration in whole milliseconds, rounded up (segment ends are clamped to it)."""
    return math.ceil(samples / CANONICAL_SAMPLES_PER_MS)


def measure_segments(
    stats: FrameStats, segments: Sequence[Segment], *, vad_method: str
) -> list[tuple[int, MeasurementRecord]]:
    """One canonical record per segment (RMS, peak, speech), from the exact per-frame sums."""
    out: list[tuple[int, MeasurementRecord]] = []
    for seg in segments:
        first = seg.start_ms // FRAME_MS
        last = -(-seg.end_ms // FRAME_MS)  # frames [first, last)
        samples = min(last * FRAME_SAMPLES, stats.samples) - first * FRAME_SAMPLES
        out.append(
            (
                seg.index,
                segment_record(
                    samples=samples,
                    sumsq=int(stats.sumsq[first:last].sum()),
                    peak=int(stats.peak[first:last].max()),
                    speech_ms=seg.speech_ms,
                    vad_method=vad_method,
                ),
            )
        )
    return out
