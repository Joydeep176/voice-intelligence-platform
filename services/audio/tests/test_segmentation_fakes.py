"""Test-only voice-activity detector (no VAD is selected, OD-29 Open; nothing like it lives in src).

A deterministic energy threshold on each 10 ms frame, only to exercise the segmentation plumbing.
It is not a candidate detector and its output means nothing about real speech.
"""

from __future__ import annotations

from typing import Any

import numpy as np

from audio_service.domain.vad import FRAME_SAMPLES

METHOD = "example-vad"
TOOL_VERSION = f"{METHOD}:1"
SEGMENTATION: dict[str, int] = {
    "minSegmentMs": 1000,
    "maxSegmentMs": 30000,
    "splitSilenceMs": 500,
    "mergeGapMs": 300,
    "paddingMs": 200,
    "forcedSplitOverlapMs": 1000,
}


class ThresholdVad:
    """Speech where the mean absolute amplitude of a frame exceeds `threshold` (int16 codes)."""

    name = METHOD
    version = "1"

    def __init__(self, threshold: int = 500) -> None:
        self._threshold = threshold
        self._carry = np.zeros(0, dtype=np.int16)

    def _frames(self, data: Any, *, last: bool) -> Any:
        full = data.size // FRAME_SAMPLES
        parts = [data[: full * FRAME_SAMPLES].reshape(full, FRAME_SAMPLES)] if full else []
        rest = data[full * FRAME_SAMPLES :]
        flags = [np.abs(p.astype(np.int64)).mean(axis=1) > self._threshold for p in parts]
        self._carry = rest.copy()
        if last and rest.size:
            flags.append(np.array([np.abs(rest.astype(np.int64)).mean() > self._threshold]))
        return np.concatenate(flags) if flags else np.zeros(0, dtype=np.bool_)

    def feed(self, block: Any) -> Any:
        return self._frames(np.concatenate((self._carry, block)), last=False)

    def finish(self) -> Any:
        return self._frames(self._carry, last=True)
