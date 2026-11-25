"""Reads windows of a preprocessing version's canonical audio (16 kHz mono s16 WAV).

Bounded memory (NFR-7): only the requested window is decoded into memory. The file is opened
through `StorageBackend.open_published_file` (manifest-listed, size-checked); callers that read the
whole file verify its SHA-256 with `PublishedFile.verify_sha256`.
"""

from __future__ import annotations

import math
import os
import wave
from types import TracebackType
from typing import Self

import numpy as np

from audio_service.contracts import ErrorCode
from audio_service.domain.errors import TaskFailure
from audio_service.domain.storage import PublishedFile

CANONICAL_NAME = "canonical.wav"
SAMPLE_RATE = 16_000
SAMPLES_PER_MS = SAMPLE_RATE // 1000


class CanonicalAudio:
    def __init__(self, published: PublishedFile) -> None:
        self._published = published
        self._handle = open(os.dup(published.fd), "rb")  # noqa: SIM115 - closed in close()
        try:
            self._wav = wave.open(self._handle, "rb")  # noqa: SIM115
        except (wave.Error, EOFError):
            self._handle.close()
            published.close()
            raise TaskFailure(ErrorCode.STORAGE_ERROR) from None
        if (
            self._wav.getnchannels() != 1
            or self._wav.getsampwidth() != 2  # noqa: PLR2004 - s16
            or self._wav.getframerate() != SAMPLE_RATE
        ):
            self.close()
            raise TaskFailure(ErrorCode.STORAGE_ERROR)
        self.samples = self._wav.getnframes()

    @property
    def duration_ms(self) -> int:
        """Duration rounded up to a whole millisecond (`samples / 16`)."""
        return math.ceil(self.samples / SAMPLES_PER_MS)

    def read_ms(self, start_ms: int, end_ms: int) -> np.ndarray:
        """Float32 samples in [-1, 1) for [start_ms, end_ms), clipped to the audio."""
        first = max(0, min(self.samples, start_ms * SAMPLES_PER_MS))
        last = max(first, min(self.samples, end_ms * SAMPLES_PER_MS))
        self._wav.setpos(first)
        raw = self._wav.readframes(last - first)
        return np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0

    def verify(self) -> None:
        """Fail the task when the bytes do not match the preprocessing manifest."""
        if not self._published.verify_sha256():
            raise TaskFailure(ErrorCode.STORAGE_ERROR)

    @property
    def sha256(self) -> str:
        return self._published.sha256

    def close(self) -> None:
        try:
            self._wav.close()
        finally:
            self._handle.close()
            self._published.close()

    def __enter__(self) -> Self:
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        self.close()
