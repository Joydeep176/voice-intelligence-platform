"""E10 (residual risk): speech spans per 30 s transcription window (1 s overlap) with the service's own
Silero VAD + pad_and_merge and production settings, over every synthetic conversation. Numbers only."""
import json, sys, wave
from collections import Counter
from pathlib import Path
import numpy as np
from audio_service.contracts import VadSettings
from audio_service.domain.inference_models import ModelStore
from audio_service.domain.transcribe import SileroDetector, pad_and_merge
models = ModelStore(Path("/models")); vad = VadSettings(threshold=0.4, minSilenceMs=300, minSpeechMs=250, paddingMs=200)
dist, per_file = Counter(), {}
for f in sorted(Path(sys.argv[1]).glob("*.wav")):
    with wave.open(str(f)) as w:
        x = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").astype(np.float32) / 32768
    n_ms = len(x) // 16; counts = []
    for start in range(0, n_ms, 29_000):
        end = min(start + 30_000, n_ms); seg = x[start * 16 : end * 16]
        det = SileroDetector(models, vad); spans = pad_and_merge(det.spans(seg), vad.paddingMs, len(seg) // 16); det.close()
        counts.append(len(spans)); dist[len(spans)] += 1
        if end == n_ms: break
    per_file[f.name] = {"windows": len(counts), "max": max(counts), "mean": round(sum(counts) / len(counts), 2)}
print(json.dumps({"per_file": per_file, "distribution": dict(sorted(dist.items())), "windows": sum(dist.values()),
                  "over_8": sum(v for k, v in dist.items() if k > 8)}, indent=1))
