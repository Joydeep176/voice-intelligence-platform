"""Phase 3A M6: production STT error on the A1 degradation corpus (the E7 method).

Runs inside the production image (models at /models) with the service's own transcription path:
30 s windows with 1 s overlap; Silero spans + padding (ADR-0038 settings); per-span language
detection and decoding with whisper.cpp small q5_1 (ADR-0036), 2 threads. Segments are kept by
midpoint ownership. Scores WER (English, Hinglish) and CER (Hindi) against the scene's reference
sentences with the C3 normaliser. Prints and writes numbers only (no text).

Usage (container): python m6_stt.py <corpus dir> <out json> [<scene index>]
"""

# ruff: noqa: T201, PLR2004
from __future__ import annotations

import json
import sys
import time
import wave
from pathlib import Path

import numpy as np
from sttbench.textnorm import char_errors, word_errors
from vadbench.sentences import all_sentences

from audio_service.contracts import VadSettings
from audio_service.domain.inference_models import ModelStore
from audio_service.domain.transcribe import (
    SileroDetector,
    TranscribeHandler,
    WhisperCppEngine,
    pad_and_merge,
)

corpus, out = Path(sys.argv[1]), Path(sys.argv[2])
scene = int(sys.argv[3]) if len(sys.argv) > 3 else 0
VAD = VadSettings(threshold=0.4, minSilenceMs=300, minSpeechMs=250, paddingMs=200)
models = ModelStore(Path("/models"))
text_by_id = {s["id"]: s["text"] for s in all_sentences()}
manifest = [m for m in json.loads((corpus / "manifest.json").read_text()) if m["scene"] == scene]


def transcribe(x: np.ndarray, engine: WhisperCppEngine) -> str:
    n_ms = len(x) // 16
    kept: list[tuple[int, str]] = []
    for start in range(0, n_ms, 29_000):
        end = min(start + 30_000, n_ms)
        seg = x[start * 16 : end * 16]
        det = SileroDetector(models, VAD)
        spans = pad_and_merge(det.spans(seg), VAD.paddingMs, end - start)
        det.close()
        own_from = start + (500 if start else 0)
        own_to = end - (500 if end < n_ms else 0)
        for a, b in spans:
            _, segments = TranscribeHandler._decode(engine, seg, start, a, b, hints=None)  # noqa: SLF001
            for s in segments:
                mid = (s.startMs + s.endMs) // 2
                if own_from <= mid < own_to:
                    kept.append((s.startMs, s.text))
        if end == n_ms:
            break
    return " ".join(t for _, t in sorted(kept))


engine = WhisperCppEngine(models, 2)
rows = []
try:
    for m in manifest:
        with wave.open(str(corpus / f"{m['id']}.wav")) as w:
            x = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").astype(np.float32) / 32768
        t0 = time.monotonic()
        hyp = transcribe(x, engine)
        ref = " ".join(text_by_id[s] for s in m["sentences"])
        werr, wn = word_errors(ref, hyp)
        cerr, cn = char_errors(ref, hyp)
        row = {
            "id": m["id"],
            "language": m["language"],
            "condition": m["condition"],
            "wer": round(werr / wn, 4) if wn else None,
            "cer": round(cerr / cn, 4) if cn else None,
            "wallS": round(time.monotonic() - t0, 1),
        }
        rows.append(row)
        print(json.dumps(row), flush=True)
        out.write_text(json.dumps(rows, indent=1) + "\n")
finally:
    engine.close()
