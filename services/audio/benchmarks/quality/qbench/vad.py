"""Silero VAD exactly as the audio service's `transcribe` task runs it (container only).

Imports the service's own `SileroDetector` and `pad_and_merge` with the ADR-0038 settings, so the
speech split matches what transcription uses. Needs the pinned models at /models.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np

from audio_service.contracts import VadSettings
from audio_service.domain.inference_models import ModelStore
from audio_service.domain.transcribe import SileroDetector, pad_and_merge

SETTINGS = VadSettings(threshold=0.4, minSilenceMs=300, minSpeechMs=250, paddingMs=200)
_MODELS: ModelStore | None = None


def models() -> ModelStore:
    global _MODELS  # noqa: PLW0603
    if _MODELS is None:
        _MODELS = ModelStore(Path("/models"))
    return _MODELS


def raw_spans(x: np.ndarray) -> list[tuple[int, int]]:
    """Silero spans (ms) over a whole signal, before padding."""
    det = SileroDetector(models(), SETTINGS)
    try:
        return det.spans(x.astype(np.float32))
    finally:
        det.close()


def padded(spans: list[tuple[int, int]], length_ms: int) -> list[tuple[int, int]]:
    return pad_and_merge(spans, SETTINGS.paddingMs, length_ms)


def window_spans(x: np.ndarray) -> list[list[tuple[int, int]]]:
    """Spans per 30 s transcription window, 1 s overlap (29 s hop), as transcription sees them."""
    n_ms = len(x) // 16
    out = []
    for start in range(0, n_ms, 29_000):
        end = min(start + 30_000, n_ms)
        seg = x[start * 16 : end * 16]
        out.append(padded(raw_spans(seg), len(seg) // 16))
        if end == n_ms:
            break
    return out


class StreamingVad:
    """Silero over a stream of blocks (same config as `SileroDetector`), for long files."""

    def __init__(self) -> None:
        self._det = SileroDetector(models(), SETTINGS)
        self._vad = self._det._vad  # noqa: SLF001 (benchmark: reuse the exact configuration)
        self._window = self._det._window  # noqa: SLF001
        self._pending = np.zeros(0, dtype=np.float32)
        self.spans: list[tuple[int, int]] = []

    def _drain(self) -> None:
        while not self._vad.empty():
            seg = self._vad.front
            start = int(seg.start) // 16
            self.spans.append((start, start + len(seg.samples) // 16))
            self._vad.pop()

    def feed(self, block: np.ndarray) -> None:
        data = np.concatenate([self._pending, block.astype(np.float32)])
        usable = len(data) // self._window * self._window
        for i in range(0, usable, self._window):
            self._vad.accept_waveform(data[i : i + self._window])
            self._drain()
        self._pending = data[usable:]

    def finish(self) -> list[tuple[int, int]]:
        if len(self._pending):
            self._vad.accept_waveform(self._pending)
        self._vad.flush()
        self._drain()
        self._det.close()
        return self.spans
