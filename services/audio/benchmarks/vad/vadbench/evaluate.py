"""Dev tuning, test evaluation, long-file drift. Runs inside the benchmark container."""

from __future__ import annotations

import hashlib
import json
import wave
from pathlib import Path
from typing import Any

import numpy as np

from . import common as c
from . import detectors as d
from . import metrics as m
from .corpus import read_wav

Array = np.ndarray
TUNE_SNRS = ("10", "5")


def load_index(corpus: Path) -> dict[str, Any]:
    return c.read_json(corpus / "index.json")


def iter_mixtures(corpus: Path, index: dict[str, Any], split: str) -> Any:
    for meta in index["mixtures"]:
        if meta["split"] == split:
            yield meta, read_wav(corpus / meta["wav"]), np.load(corpus / meta["ref"])


def _f1(tp: int, fp: int, fn: int) -> float:
    return 2 * tp / (2 * tp + fp + fn) if tp else 0.0


def tune(candidate: str, corpus: Path, models: Path) -> dict[str, Any]:
    """Pick parameters on the dev split only: maximise mean F1 over 10 dB and 5 dB (pooled over
    languages and noise types); ties go to the lower pooled FPR, then the first in the grid."""
    index = load_index(corpus)
    params_grid = d.grid(candidate)
    by_key: dict[tuple[Any, ...], list[dict[str, Any]]] = {}
    for p in params_grid:
        by_key.setdefault(d.scoring_key(candidate, p), []).append(p)
    rows = []
    for _key, plist in by_key.items():
        detector = d.make_detector(candidate, plist[0], models)
        cache = []
        for meta, audio, ref in iter_mixtures(corpus, index, "dev"):
            if str(meta["snr"]) in TUNE_SNRS:
                cache.append((str(meta["snr"]), d.run_chunked(detector, audio), ref))
        for p in plist:
            tot = {s: np.zeros(4, dtype=np.int64) for s in TUNE_SNRS}
            for snr, scores, ref in cache:
                pred = d.decide(candidate, scores, p)[: len(ref)]
                tot[snr] += [
                    np.sum(pred & ref),
                    np.sum(pred & ~ref),
                    np.sum(~pred & ref),
                    np.sum(~pred & ~ref),
                ]
            f1s = {s: _f1(int(t[0]), int(t[1]), int(t[2])) for s, t in tot.items()}
            fp = sum(int(t[1]) for t in tot.values())
            tn = sum(int(t[3]) for t in tot.values())
            rows.append(
                {
                    "params": p,
                    "objective_mean_f1": float(np.mean(list(f1s.values()))),
                    "dev_f1": f1s,
                    "dev_fpr": fp / (fp + tn),
                }
            )
    best = max(rows, key=lambda r: (round(r["objective_mean_f1"], 6), -r["dev_fpr"]))
    return {"selected": best["params"], "objective": best["objective_mean_f1"], "grid": rows}


def evaluate(candidate: str, params: dict[str, Any], corpus: Path, models: Path) -> dict[str, Any]:
    """Score every test mixture with the dev-tuned parameters; return metrics and a digest."""
    index = load_index(corpus)
    detector = d.make_detector(candidate, params, models)
    digest = hashlib.sha256()
    items = []
    audio_s = 0.0
    for meta, audio, ref in iter_mixtures(corpus, index, "test"):
        pred = d.decide(candidate, d.run_chunked(detector, audio), params)[: len(ref)]
        digest.update(np.packbits(pred).tobytes())
        items.append((meta, m.mixture_record(pred, ref, meta["spans"])))
        audio_s += len(audio) / c.SAMPLE_RATE
    rows = m.group_metrics(items)
    return {
        "candidate": candidate,
        "params": params,
        "test_mixtures": len(items),
        "test_audio_hours": audio_s / 3600,
        "decisions_sha256": digest.hexdigest(),
        "metrics_sha256": hashlib.sha256(json.dumps(rows, sort_keys=True).encode()).hexdigest(),
        "rows": rows,
    }


def stream_wav(path: Path) -> Any:
    """Yield int16 chunks of CHUNK_SAMPLES from a WAV without loading it whole."""
    with wave.open(str(path), "rb") as w:
        while True:
            raw = w.readframes(c.CHUNK_SAMPLES)
            if not raw:
                return
            yield np.frombuffer(raw, dtype="<i2")


def score_stream(detector: Any, path: Path) -> Array:
    detector.reset()
    parts = []
    total = 0
    for chunk in stream_wav(path):
        total += len(chunk)
        pad = (-len(chunk)) % d.ALIGN
        padded = np.concatenate([chunk, np.zeros(pad, dtype=chunk.dtype)]) if pad else chunk
        parts.append(detector.feed(padded))
    return np.concatenate(parts, axis=1)[:, : total // c.FRAME]


def drift(candidate: str, params: dict[str, Any], corpus: Path, models: Path) -> dict[str, Any]:
    """Continuous (state never reset) pass over each long file: F1/FPR per 10-minute block, plus
    the share of frames that differ from the same audio scored one mixture at a time."""
    index = load_index(corpus)
    by_id = {x["id"]: x for x in index["mixtures"]}
    detector = d.make_detector(candidate, params, models)
    out = []
    block = 60_000  # 10 minutes of 10 ms frames
    for lf in index["long_files"]:
        ref = np.load(corpus / lf["ref"])
        pred = d.decide(candidate, score_stream(detector, corpus / lf["wav"]), params)[: len(ref)]
        blocks = []
        for start in range(0, len(ref), block):
            p, r = pred[start : start + block], ref[start : start + block]
            tp, fp, fn = int(np.sum(p & r)), int(np.sum(p & ~r)), int(np.sum(~p & r))
            tn = len(r) - tp - fp - fn
            blocks.append(
                {
                    "start_min": start / 6000,
                    "minutes": len(r) / 6000,
                    "f1": _f1(tp, fp, fn),
                    "fpr": fp / max(1, fp + tn),
                    "recall": tp / max(1, tp + fn),
                }
            )
        pieces = [
            d.decide(candidate, d.run_chunked(detector, read_wav(corpus / by_id[i]["wav"])), params)
            for i in lf["mixtures"]
        ]
        reset = np.concatenate(pieces)[: len(ref)]
        # The hangover/segmenter tail crosses mixture boundaries only in the continuous run, so
        # compare frames, not segments.
        f1s = [b["f1"] for b in blocks if b["minutes"] >= 5]
        out.append(
            {
                "id": lf["id"],
                "duration_min": lf["duration_s"] / 60,
                "blocks": blocks,
                "f1_first_block": blocks[0]["f1"],
                "f1_last_full_block": f1s[-1],
                "f1_min_block": min(f1s),
                "f1_max_block": max(f1s),
                "frames_differing_from_per_mixture_scoring": int(np.sum(pred != reset)),
                "frames_total": len(ref),
                "differing_fraction": float(np.mean(pred != reset)),
            }
        )
    return {"candidate": candidate, "params": params, "long_files": out}
