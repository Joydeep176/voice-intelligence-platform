"""STT speed experiment (user-approved measurement, 2026-11-24): per-span whisper.cpp variants.

Usage (inside the runtime image): experiment.py <canonical.wav> <threads> <variants csv> <out.json>
Variants:
  V0  baseline: auto_detect_language (full 1500-frame encoder) + transcribe (full encoder)
  V1  auto_detect_language (full) + transcribe(audio_ctx sized to the span)
  V2  whisper_full(detect_language, audio_ctx sized) -> whisper_full_lang_id + transcribe(audio_ctx sized)
Prints numbers only: times, languages, word-level disagreement with V0. No transcript text.
"""

import json
import math
import sys
import time
import wave
from pathlib import Path

import numpy as np

import _pywhispercpp as pw
from audio_service.contracts import VadSettings
from audio_service.domain.inference_models import WHISPER_SMALL_Q5_1, ModelStore
from audio_service.domain.transcribe import SileroDetector, choose_language, pad_and_merge

WAV, THREADS, VARIANTS, OUT = sys.argv[1], int(sys.argv[2]), sys.argv[3].split(","), sys.argv[4]
MARGIN_FRAMES = 64  # 1.28 s of encoder context beyond the span
models = ModelStore(Path("/models"))
vad = VadSettings(threshold=0.4, minSilenceMs=300, minSpeechMs=250, paddingMs=200)

with wave.open(WAV) as w:
    samples = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").astype(np.float32) / 32768

from pywhispercpp.model import Model  # noqa: E402

model = Model(
    str(models.path(WHISPER_SMALL_Q5_1)),
    n_threads=THREADS,
    print_progress=False,
    print_realtime=False,
    print_timestamps=False,
    language="auto",
)
HINTS = ["en", "hi"]


def ctx_for(ms: int) -> int:
    return min(1500, math.ceil(ms / 20) + MARGIN_FRAMES)


def detect_full(clip):
    _, probs = model.auto_detect_language(clip)
    return choose_language({str(k): float(v) for k, v in probs.items()}, HINTS)


def detect_small(clip, k):
    model.transcribe(clip, detect_language=True, audio_ctx=k, no_context=True)
    code = pw.whisper_lang_str(pw.whisper_full_lang_id(model._ctx))
    return choose_language({code: 1.0}, HINTS)


def decode(clip, lang, k):
    return " ".join(
        str(s.text).strip() for s in model.transcribe(clip, language=lang, audio_ctx=k, no_context=True)
    )


def wer(ref: str, hyp: str) -> float:
    r, h = ref.split(), hyp.split()
    if not r:
        return 0.0 if not h else 1.0
    d = list(range(len(h) + 1))
    for i, rw in enumerate(r, 1):
        prev, d[0] = d[0], i
        for j, hw in enumerate(h, 1):
            cur = min(d[j] + 1, d[j - 1] + 1, prev + (rw != hw))
            prev, d[j] = d[j], cur
    return d[len(h)] / len(r)


report = {"threads": THREADS, "margin_frames": MARGIN_FRAMES, "windows": []}
for w0 in range(0, len(samples) // 16, 30000):
    win = samples[w0 * 16 : (w0 + 30000) * 16]
    det = SileroDetector(models, vad)
    spans = pad_and_merge(det.spans(win), vad.paddingMs, len(win) // 16)
    det.close()
    entry = {"window_ms": [w0, w0 + len(win) // 16], "spans_ms": [b - a for a, b in spans], "variants": {}}
    texts = {}
    for v in VARIANTS:
        t_det = t_dec = 0.0
        langs, words = [], []
        for a, b in spans:
            clip = win[a * 16 : b * 16]
            k = ctx_for(b - a)
            t = time.monotonic()
            lang = detect_full(clip) if v in ("V0", "V1") else detect_small(clip, k)
            t_det += time.monotonic() - t
            t = time.monotonic()
            words.append(decode(clip, lang, 0 if v == "V0" else k))
            t_dec += time.monotonic() - t
            langs.append(lang)
        texts[v] = words
        entry["variants"][v] = {
            "detect_s": round(t_det, 1),
            "decode_s": round(t_dec, 1),
            "total_s": round(t_det + t_dec, 1),
            "rtf": round((t_det + t_dec) / (len(win) / 16000), 2),
            "languages": langs,
            "devanagari_spans": sum(any("ऀ" <= c <= "ॿ" for c in x) for x in words),
        }
    if "V0" in texts:
        for v in VARIANTS:
            if v != "V0":
                entry["variants"][v]["lang_agree_with_V0"] = sum(
                    x == y
                    for x, y in zip(entry["variants"][v]["languages"], entry["variants"]["V0"]["languages"])
                )
                entry["variants"][v]["word_disagreement_vs_V0"] = round(
                    wer(" ".join(texts["V0"]), " ".join(texts[v])), 3
                )
    report["windows"].append(entry)
    print(json.dumps(entry), flush=True)
json.dump(report, open(OUT, "w"), indent=1)
