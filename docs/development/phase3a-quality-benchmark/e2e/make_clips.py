"""Phase 3A M7: synthetic category clips for the A1 browser E2E (ADR-0004: synthetic only).

Built from the local Phase 2B VAD corpus (macOS TTS + NumPy noise); writes 16 kHz mono s16 WAVs.
Usage: uv run --directory services/audio python <this file> <corpus dir> <out dir>
"""

import json
import sys
import wave
from pathlib import Path

import numpy as np

corpus, out = Path(sys.argv[1]), Path(sys.argv[2])
out.mkdir(parents=True, exist_ok=True)


def read(rel: str) -> np.ndarray:
    with wave.open(str(corpus / rel)) as w:
        return np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").astype(np.float64) / 32768


def write(name: str, x: np.ndarray) -> None:
    y = np.clip(np.rint(x * 32768), -32768, 32767).astype("<i2")
    with wave.open(str(out / f"{name}.wav"), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes(y.tobytes())


def lowpass(x: np.ndarray, hz: float) -> np.ndarray:
    s = np.fft.rfft(x)
    s[np.fft.rfftfreq(len(x), 1 / 16000) > hz] = 0
    return np.fft.irfft(s, len(x))


en = read("mixtures/test/test-english-s0-none-clean.wav")
rng = np.random.default_rng(20261126)
clips = {
    "clean-en": en,
    "clean-hi": read("mixtures/test/test-hindi-s0-none-clean.wav"),
    "clean-hinglish": read("mixtures/test/test-hinglish-s0-none-clean.wav"),
    "noisy-5db-en": read("mixtures/test/test-english-s0-white-5.wav"),
    "noisy-0db-hi": read("mixtures/test/test-hindi-s1-pink-0.wav"),
    "low-level-en": en * 10 ** (-40 / 20),
    "clipped-en": np.clip(en * 12, -1, 32767 / 32768),
    "narrowband-en": lowpass(en, 3400),
    "silence-30s": np.zeros(30 * 16000),
    "noise-only-30s": rng.standard_normal(30 * 16000) * 0.05,
}
ids = json.loads(Path(sys.argv[3]).read_text()) if len(sys.argv) > 3 else None
if ids:  # 2C fragmented-speech reconstruction: 16 x 1 s utterances with 0.8 s gaps
    parts = [np.zeros(8000)]
    for uid in ids:
        parts += [read(f"utterances/{uid}.wav")[:16000], np.zeros(12800)]
    clips["fragmented-16x1s"] = np.concatenate(parts)
for name, x in clips.items():
    write(name, x)
print(json.dumps({k: round(len(v) / 16000, 2) for k, v in clips.items()}))
