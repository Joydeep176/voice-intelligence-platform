"""Diarization error rate, implemented here so the definition is explicit.

10 ms frames. Frames within `collar` seconds of any reference segment boundary (start or end of any
reference speaker segment) are excluded from scoring (pyannote/NIST convention, 250 ms each side).
Overlapped reference speech IS scored. Speaker labels are mapped one-to-one by maximising the
overlapped time (exact, by dynamic programming over the at most four reference speakers).
Per scored frame: missed = max(0, n_ref - n_hyp); false alarm = max(0, n_hyp - n_ref);
confusion = min(n_ref, n_hyp) - n_correct; DER = (missed + false alarm + confusion) / total n_ref.
"""

from __future__ import annotations

from typing import Any

import numpy as np

FRAME_S = 0.01


def _matrix(segs: list[dict[str, Any]], n_frames: int) -> tuple[np.ndarray, list[str]]:
    names = sorted({s["speaker"] for s in segs}, key=str)
    m = np.zeros((n_frames, max(1, len(names))), dtype=bool)
    idx = {n: i for i, n in enumerate(names)}
    for s in segs:
        a = max(0, int(round(s["start"] / FRAME_S)))
        b = min(n_frames, int(round(s["end"] / FRAME_S)))
        if b > a:
            m[a:b, idx[s["speaker"]]] = True
    return m, names


def _collar_mask(ref: list[dict[str, Any]], n_frames: int, collar: float) -> np.ndarray:
    keep = np.ones(n_frames, dtype=bool)
    w = int(round(collar / FRAME_S))
    for s in ref:
        for t in (s["start"], s["end"]):
            c = int(round(t / FRAME_S))
            keep[max(0, c - w) : min(n_frames, c + w)] = False
    return keep


def _best_mapping_overlap(overlap: np.ndarray) -> int:
    """Max total overlap of a one-to-one mapping (rows = ref speakers, columns = hyp speakers)."""
    n_ref = overlap.shape[0]
    full = (1 << n_ref) - 1
    dp = np.full(full + 1, -1, dtype=np.int64)
    dp[0] = 0
    for h in range(overlap.shape[1]):
        new = dp.copy()
        for mask in range(full + 1):
            if dp[mask] < 0:
                continue
            for r in range(n_ref):
                if not mask & (1 << r):
                    cand = dp[mask] + overlap[r, h]
                    new[mask | (1 << r)] = max(new[mask | (1 << r)], cand)
        dp = new
    return int(dp.max())


def der(
    ref: list[dict[str, Any]], hyp: list[dict[str, Any]], seconds: float, collar: float = 0.25
) -> dict[str, float]:
    n = int(np.ceil(seconds / FRAME_S))
    r, _ = _matrix(ref, n)
    h, hyp_names = _matrix(hyp, n)
    keep = _collar_mask(ref, n, collar)
    r, h = r[keep], h[keep]
    n_ref, n_hyp = r.sum(axis=1), h.sum(axis=1)
    overlap = r.T.astype(np.int64) @ h.astype(np.int64)
    correct = _best_mapping_overlap(overlap)
    total = int(n_ref.sum())
    miss = int(np.maximum(0, n_ref - n_hyp).sum())
    fa = int(np.maximum(0, n_hyp - n_ref).sum())
    conf = int(np.minimum(n_ref, n_hyp).sum()) - correct
    div = max(1, total)
    return {
        "der": (miss + fa + conf) / div,
        "missed": miss / div,
        "false_alarm": fa / div,
        "confusion": conf / div,
        "ref_speech_s": total * FRAME_S,
        "scored_s": int(keep.sum()) * FRAME_S,
        "overlap_ref_share": float((n_ref > 1).sum()) / max(1, int((n_ref > 0).sum())),
        "hyp_speakers": len(hyp_names) if hyp else 0,
    }
