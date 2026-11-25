"""Shared post-processing and the plan 13.2 metrics. Units: 10 ms frames unless stated."""

from __future__ import annotations

from typing import Any

import numpy as np

from . import common as c

Array = np.ndarray


def runs(mask: Array) -> list[tuple[int, int]]:
    d = np.diff(np.concatenate([[0], mask.astype(np.int8), [0]]))
    return list(zip(np.flatnonzero(d == 1).tolist(), np.flatnonzero(d == -1).tolist(), strict=True))


def segment(pred: Array) -> tuple[list[tuple[int, int]], list[tuple[int, int]]]:
    """Same segmenter for every candidate: merge gaps shorter than min silence, drop segments
    shorter than min speech, then pad both sides (padded segments that touch are unioned).

    Returns `(unpadded, padded)` as `(start, end)` frame pairs, end exclusive.
    """
    merged: list[list[int]] = []
    for s, e in runs(pred):
        if merged and s - merged[-1][1] < c.MIN_SILENCE_FRAMES:
            merged[-1][1] = e
        else:
            merged.append([s, e])
    unpadded = [(s, e) for s, e in merged if e - s >= c.MIN_SPEECH_FRAMES]
    padded: list[list[int]] = []
    for s, e in unpadded:
        s2, e2 = max(0, s - c.PAD_FRAMES), min(len(pred), e + c.PAD_FRAMES)
        if padded and s2 <= padded[-1][1]:
            padded[-1][1] = max(padded[-1][1], e2)
        else:
            padded.append([s2, e2])
    return unpadded, [(s, e) for s, e in padded]


def _mask(segments: list[tuple[int, int]], n: int) -> Array:
    out = np.zeros(n, dtype=bool)
    for s, e in segments:
        out[s:e] = True
    return out


def boundary_errors(segments: list[tuple[int, int]], spans: list[dict[str, int]]) -> dict[str, Any]:
    """Onset/offset error (ms, signed: detected minus reference) per reference utterance.

    An onset is skipped when the overlapping segment also covers the previous utterance (merged by
    the minimum-silence rule); an offset likewise for the next one. No overlap counts as missed.
    """
    onsets: list[float] = []
    offsets: list[float] = []
    missed = 0
    for i, sp in enumerate(spans):
        hit = [(s, e) for s, e in segments if s < sp["end_frame"] and e > sp["start_frame"]]
        if not hit:
            missed += 1
            continue
        first, last = hit[0], hit[-1]
        prev_end = spans[i - 1]["end_frame"] if i > 0 else -1
        next_start = spans[i + 1]["start_frame"] if i + 1 < len(spans) else 10**12
        if first[0] >= prev_end:
            onsets.append((first[0] - sp["start_frame"]) * 10.0)
        if last[1] <= next_start:
            offsets.append((last[1] - sp["end_frame"]) * 10.0)
    return {"onset_ms": onsets, "offset_ms": offsets, "missed": missed, "utterances": len(spans)}


def mixture_record(pred: Array, ref: Array, spans: list[dict[str, int]]) -> dict[str, Any]:
    n = len(ref)
    pred = pred[:n]
    tp = int(np.sum(pred & ref))
    fp = int(np.sum(pred & ~ref))
    fn = int(np.sum(~pred & ref))
    tn = n - tp - fp - fn
    unpadded, padded = segment(pred)
    rec: dict[str, Any] = {"tp": tp, "fp": fp, "fn": fn, "tn": tn}
    for tag, segs in (("padded", padded), ("unpadded", unpadded)):
        m = _mask(segs, n)
        rec[f"{tag}_covered_speech"] = int(np.sum(m & ref))
        rec[f"{tag}_segment_frames"] = int(np.sum(m))
        rec[f"{tag}_segment_nonspeech"] = int(np.sum(m & ~ref))
    rec["ref_speech"] = int(np.sum(ref))
    rec.update(boundary_errors(unpadded, spans))
    return rec


def _ratio(num: float, den: float) -> float | None:
    return None if den == 0 else num / den


def _pct(values: list[float], q: float) -> float | None:
    return float(np.percentile(np.abs(values), q)) if values else None


def aggregate(records: list[dict[str, Any]]) -> dict[str, Any]:
    """Sum counts and pool boundary errors over mixtures, then derive every metric."""
    s = {k: sum(r[k] for r in records) for k in records[0] if isinstance(records[0][k], int)}
    onsets = [v for r in records for v in r["onset_ms"]]
    offsets = [v for r in records for v in r["offset_ms"]]
    precision = _ratio(s["tp"], s["tp"] + s["fp"])
    recall = _ratio(s["tp"], s["tp"] + s["fn"])
    f1 = _ratio(2 * s["tp"], 2 * s["tp"] + s["fp"] + s["fn"])
    return {
        "mixtures": len(records),
        "frames": s["tp"] + s["fp"] + s["fn"] + s["tn"],
        "precision": precision,
        "recall": recall,
        "fpr": _ratio(s["fp"], s["fp"] + s["tn"]),
        "fnr": _ratio(s["fn"], s["fn"] + s["tp"]),
        "f1": f1,
        "onset_abs_median_ms": _pct(onsets, 50),
        "onset_abs_p95_ms": _pct(onsets, 95),
        "onset_signed_median_ms": float(np.median(onsets)) if onsets else None,
        "offset_abs_median_ms": _pct(offsets, 50),
        "offset_abs_p95_ms": _pct(offsets, 95),
        "offset_signed_median_ms": float(np.median(offsets)) if offsets else None,
        "missed_utterance_rate": _ratio(s["missed"], s["utterances"]),
        "speech_coverage": _ratio(s["padded_covered_speech"], s["ref_speech"]),
        "nonspeech_inclusion": _ratio(s["padded_segment_nonspeech"], s["padded_segment_frames"]),
        "speech_coverage_unpadded": _ratio(s["unpadded_covered_speech"], s["ref_speech"]),
        "nonspeech_inclusion_unpadded": _ratio(
            s["unpadded_segment_nonspeech"], s["unpadded_segment_frames"]
        ),
    }


def group_metrics(items: list[tuple[dict[str, Any], dict[str, Any]]]) -> list[dict[str, Any]]:
    """`items` are `(mixture_meta, record)`; one row per language x noise x SNR plus rollups.

    Rollup rows use `"all"` for the collapsed dimension. Noise `none` is the clean condition.
    """
    rows = []
    keys: set[tuple[str, str, str]] = set()
    for meta, _ in items:
        lang, noise, snr = meta["language"], meta["noise"], str(meta["snr"])
        for kl in (lang, "all"):
            for kn in (noise, "all"):
                for ks in (snr, "all"):
                    keys.add((kl, kn, ks))
    for kl, kn, ks in sorted(keys):
        sel = [
            r
            for m, r in items
            if kl in (m["language"], "all")
            and kn in (m["noise"], "all")
            and ks in (str(m["snr"]), "all")
        ]
        rows.append({"language": kl, "noise": kn, "snr": ks, **aggregate(sel)})
    return rows
