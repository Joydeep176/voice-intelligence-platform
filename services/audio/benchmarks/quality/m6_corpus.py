"""Phase 3A M6: labelled degradation corpus for A1 calibration (synthetic only, ADR-0004).

From the 12 clean test scenes of the local Phase 2B VAD corpus (4 per language), applies controlled
degradations with a known ground truth. Writes 16 kHz mono s16 WAVs and `manifest.json` (numbers
and labels only; sentence IDs, never text).

Usage: uv run --directory services/audio python benchmarks/quality/m6_corpus.py <corpus> <out>
"""

# ruff: noqa: T201, PLR2004
from __future__ import annotations

import json
import sys
import wave
from pathlib import Path

import numpy as np

corpus, out = Path(sys.argv[1]), Path(sys.argv[2])
out.mkdir(parents=True, exist_ok=True)
SR = 16_000


def read(rel: str) -> np.ndarray:
    with wave.open(str(corpus / rel)) as w:
        return np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").astype(np.float64) / 32768


def write(name: str, x: np.ndarray) -> None:
    y = np.clip(np.rint(x * 32768), -32768, 32767).astype("<i2")
    with wave.open(str(out / f"{name}.wav"), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(y.tobytes())


def lowpass(x: np.ndarray, hz: float) -> np.ndarray:
    s = np.fft.rfft(x)
    s[np.fft.rfftfreq(len(x), 1 / SR) > hz] = 0
    return np.fft.irfft(s, len(x))


def dropouts(
    x: np.ndarray, ref: np.ndarray, rng: np.random.Generator
) -> tuple[np.ndarray, list[list[int]]]:
    """Five 300 ms digital-zero gaps placed inside reference speech (10 ms frame mask)."""
    y = x.copy()
    speech = np.flatnonzero(ref)
    gaps = []
    for frame in sorted(rng.choice(speech[30:-30], 5, replace=False)):
        a = int(frame) * 160
        y[a : a + 4800] = 0.0
        gaps.append([a // 16, a // 16 + 300])
    return y, gaps


CONDITIONS = {
    "clean": {"truth": None},
    "clip_moderate": {"truth": "clipping", "level": "gain x4, hard clip"},
    "clip_heavy": {"truth": "clipping", "level": "gain x12, hard clip"},
    "low_30": {"truth": "low_level", "level": "-30 dB"},
    "low_45": {"truth": "low_level", "level": "-45 dB"},
    "narrow_5500": {"truth": "narrowband", "level": "low-pass 5.5 kHz"},
    "narrow_3400": {"truth": "narrowband", "level": "low-pass 3.4 kHz"},
    "dropout_5x300ms": {"truth": "dropout", "level": "five 300 ms digital-zero gaps in speech"},
}

manifest = json.loads((corpus / "index.json").read_text())
scenes = [m for m in manifest["mixtures"] if m["split"] == "test" and m["snr"] == "clean"]
rng = np.random.default_rng(20261126)
rows = []
for m in scenes:
    x = read(m["wav"])
    ref = np.load(corpus / m["ref"])
    for cond, meta in CONDITIONS.items():
        gaps: list[list[int]] = []
        if cond == "clean":
            y = x
        elif cond == "clip_moderate":
            y = np.clip(x * 4, -1, 32767 / 32768)
        elif cond == "clip_heavy":
            y = np.clip(x * 12, -1, 32767 / 32768)
        elif cond == "low_30":
            y = x * 10 ** (-30 / 20)
        elif cond == "low_45":
            y = x * 10 ** (-45 / 20)
        elif cond == "narrow_5500":
            y = lowpass(x, 5500)
        elif cond == "narrow_3400":
            y = lowpass(x, 3400)
        else:
            y, gaps = dropouts(x, ref, rng)
        name = f"{m['language']}-s{m['scene']}-{cond}"
        write(name, y)
        rows.append(
            {
                "id": name,
                "language": m["language"],
                "scene": m["scene"],
                "condition": cond,
                "truth": meta["truth"],
                "level": meta.get("level"),
                "gapsMs": gaps,
                "sentences": m["sentences"],
                "durationMs": len(y) * 1000 // SR,
            }
        )
(out / "manifest.json").write_text(json.dumps(rows, indent=1) + "\n")
print(len(rows), "clips")
