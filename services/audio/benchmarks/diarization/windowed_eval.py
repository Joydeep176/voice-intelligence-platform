"""Phase 2C closure: evaluate the production windowed diarization (ADR-0016 / ADR-0037).

Runs `audio_service.domain.diarize.diarize_windows` with the real `SherpaDiarEngine` (pinned
models from `.local-models`) on the C3 synthetic diarization corpus and scores it with the C3 DER
code (250 ms collar). Steps:

1. `tune`: the cross-window `matchThreshold` is chosen on the DEV split only, with windows forced
   to 60 s / 10 s overlap so that every 2-minute dev conversation spans three windows.
2. `test`: the chosen threshold on the TEST split with forced 120 s / 15 s windows, compared with
   whole-file processing of the same files (same engine, same run).
3. `long`: the 60-minute 4-speaker file with the production settings (600 s windows, 30 s overlap).

Window outputs are memoised per window, so every threshold reuses one segmentation per window.
Synthetic TTS speech only: not evidence of real-world accuracy.

    uv run --directory services/audio python benchmarks/diarization/windowed_eval.py tune|test|long
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
import wave
from pathlib import Path
from typing import Any

import numpy as np

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / "services/audio/src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from diarbench.der import der  # noqa: E402

from audio_service.contracts import DiarizeConfig  # noqa: E402
from audio_service.domain.diarize import (  # noqa: E402
    SherpaDiarEngine,
    diarize_windows,
    plan_windows,
)
from audio_service.domain.inference_models import ModelStore  # noqa: E402

CORPUS = ROOT / ".local-benchmarks/diar-corpus"
OUT = ROOT / "docs/development/phase2c-provider-validation"
THRESHOLDS = [0.3, 0.4, 0.5, 0.6, 0.7]


def log(line: str) -> None:
    sys.stdout.write(line + "\n")
    sys.stdout.flush()


def load(path: Path) -> np.ndarray:
    with wave.open(str(path), "rb") as w:
        if (w.getframerate(), w.getnchannels(), w.getsampwidth()) != (16_000, 1, 2):
            raise SystemExit(f"{path.name}: not 16 kHz mono s16")
        return np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").astype(np.float32) / 32768


class Memo:
    """Caches engine.diarize / engine.embed by the exact samples (one segmentation per window)."""

    def __init__(self, engine: SherpaDiarEngine) -> None:
        self.engine = engine.engine
        self._e = engine
        self._d: dict[str, list[tuple[int, int, int]]] = {}
        self._v: dict[str, np.ndarray] = {}

    @staticmethod
    def _key(x: np.ndarray) -> str:
        return hashlib.sha1(x.tobytes()).hexdigest()  # noqa: S324 - cache key only

    def diarize(self, x: np.ndarray) -> list[tuple[int, int, int]]:
        k = self._key(x)
        if k not in self._d:
            self._d[k] = self._e.diarize(x)
        return self._d[k]

    def embed(self, x: np.ndarray) -> np.ndarray:
        k = self._key(x)
        if k not in self._v:
            self._v[k] = self._e.embed(x)
        return self._v[k]

    def close(self) -> None:
        pass


def engine() -> SherpaDiarEngine:
    cfg = DiarizeConfig(
        schemaVersion=1,
        engine="sherpa-onnx",
        audioDurationMs=1,
        clusteringThreshold=0.6,
        minDurationOnMs=300,
        minDurationOffMs=500,
        wholeFileMaxMs=600_000,
        windowMs=600_000,
        overlapMs=30_000,
        matchThreshold=0.5,
    )
    return SherpaDiarEngine(ModelStore(ROOT / ".local-models"), 1, cfg)


def score(
    conv: dict[str, Any], samples: np.ndarray, memo: Memo, windows: list[tuple[int, int]], th: float
) -> dict[str, Any]:
    turns, _infos = diarize_windows(
        memo,
        lambda s, e: samples[s * 16 : e * 16],
        windows,
        match_threshold=th,
        check=lambda: None,
        progress=lambda f, ms: None,
    )
    hyp = [
        {"speaker": t.speakerKey, "start": t.startMs / 1000, "end": t.endMs / 1000} for t in turns
    ]
    d = der(conv["segments"], hyp, conv["seconds"])
    return {
        "der": round(d["der"], 4),
        "confusion": round(d["confusion"], 4),
        "hyp_speakers": len({h["speaker"] for h in hyp}),
        "ref_speakers": conv["n_speakers"],
    }


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("stage", choices=["tune", "test", "long"])
    p.add_argument("--threshold", type=float)
    args = p.parse_args()
    convs = json.loads((CORPUS / "index.json").read_text())["conversations"]
    OUT.mkdir(parents=True, exist_ok=True)
    memo = Memo(engine())
    out: dict[str, Any] = {
        "stage": args.stage,
        "engine": memo.engine.model_dump(),
        "collar_s": 0.25,
        "rows": [],
    }
    t0 = time.perf_counter()
    if args.stage == "tune":
        for conv in [c for c in convs if c["split"] == "dev"]:
            x = load(CORPUS / conv["file"])
            dur = len(x) // 16
            w = plan_windows(dur, 10_000, 60_000, 10_000)
            row: dict[str, Any] = {"id": conv["id"], "windows": len(w), "by_threshold": {}}
            row["whole"] = score(conv, x, memo, [(0, dur)], 0.5)
            for th in THRESHOLDS:
                row["by_threshold"][str(th)] = score(conv, x, memo, w, th)
            out["rows"].append(row)
            log(json.dumps(row))
        means = {
            str(th): round(
                float(np.mean([r["by_threshold"][str(th)]["der"] for r in out["rows"]])), 4
            )
            for th in THRESHOLDS
        }
        out["mean_der_by_threshold"] = means
        out["selected"] = float(min(means, key=lambda k: (means[k], float(k))))
    else:
        th = args.threshold
        if th is None:
            raise SystemExit("--threshold is required for test and long")
        out["threshold"] = th
        chosen = (
            [c for c in convs if c["split"] == "test" and c["seconds"] > 500]
            if args.stage == "test"
            else [c for c in convs if c["split"] == "long"]
        )
        for conv in chosen:
            x = load(CORPUS / conv["file"])
            dur = len(x) // 16
            if args.stage == "test":
                w = plan_windows(dur, 10_000, 120_000, 15_000)
                row = {
                    "id": conv["id"],
                    "windows": len(w),
                    "windowed": score(conv, x, memo, w, th),
                    "whole": score(conv, x, memo, [(0, dur)], th),
                }
            else:
                w = plan_windows(dur, 600_000, 600_000, 30_000)
                row = {"id": conv["id"], "windows": len(w), "windowed": score(conv, x, memo, w, th)}
            out["rows"].append(row)
            log(json.dumps(row))
    out["wall_s"] = round(time.perf_counter() - t0, 1)
    (OUT / f"windowed-{args.stage}.json").write_text(json.dumps(out, indent=2) + "\n")
    log(f"wrote {OUT / f'windowed-{args.stage}.json'}")


if __name__ == "__main__":
    main()
