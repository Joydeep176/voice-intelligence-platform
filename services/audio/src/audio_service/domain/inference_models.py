"""Pinned model files for self-hosted inference (OD-02b / OD-03b, ADR-0036 / ADR-0037).

Models are never downloaded by the service: `scripts/fetch_models.py` places them (hash-checked) in
a directory mounted read-only at `AUDIO_SERVICE_MODELS_DIR`. Every file is verified by size and
SHA-256 before first use; a missing or altered file makes the dependent task type unavailable.
"""

from __future__ import annotations

import hashlib
import os
import stat
import threading
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class ModelFile:
    """A pinned file below the models directory (relative path, SHA-256, size in bytes)."""

    name: str
    relpath: str
    sha256: str
    size: int


# Whisper small, whisper.cpp ggml q5_1 (ggerganov/whisper.cpp @ 5359861c..., MIT).
WHISPER_SMALL_Q5_1 = ModelFile(
    "ggml-small-q5_1",
    "whisper/ggml-small-q5_1.bin",
    "ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb",
    190_085_487,
)
# Silero VAD v6.2.3 (snakers4/silero-vad @ 5cd79456..., MIT): speech spans inside transcription
# windows (OD-29, ADR-0038). Same file and pin as the Phase 2B VAD benchmark.
SILERO_VAD_V6_2_3 = ModelFile(
    "silero-vad-v6.2.3",
    "vad/silero_vad.onnx",
    "1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3",
    2_327_524,
)
# pyannote segmentation-3.0, ONNX export (k2-fsa/sherpa-onnx release, MIT, ungated).
PYANNOTE_SEGMENTATION_3_0 = ModelFile(
    "pyannote-segmentation-3.0",
    "diarization/pyannote-segmentation-3-0.onnx",
    "220ad67ca923bef2fa91f2390c786097bf305bceb5e261d4af67b38e938e1079",
    5_992_913,
)
# 3D-Speaker CAM++ speaker embedding, English VoxCeleb (k2-fsa/sherpa-onnx release, Apache-2.0).
CAMPPLUS_EN_VOXCELEB = ModelFile(
    "3dspeaker-campplus-en-voxceleb-16k",
    "diarization/3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx",
    "98daf9bcf1c8abf3db374fec4c27a5eda7c58705bb3f180d057b085a72a88bb5",
    29_596_979,
)

STT_MODELS: tuple[ModelFile, ...] = (WHISPER_SMALL_Q5_1, SILERO_VAD_V6_2_3)
# Phase 3A `measure` (ADR-0045): only the pinned Silero VAD.
MEASURE_MODELS: tuple[ModelFile, ...] = (SILERO_VAD_V6_2_3,)
DIARIZATION_MODELS: tuple[ModelFile, ...] = (PYANNOTE_SEGMENTATION_3_0, CAMPPLUS_EN_VOXCELEB)


class ModelUnavailable(Exception):  # noqa: N818 - domain condition, not an error class name
    """A pinned model file is missing, not a regular file, or does not match its pin."""


class ModelStore:
    """Resolves pinned files below `root`, verifying each once per (size, mtime) observed."""

    def __init__(self, root: Path) -> None:
        self._root = root.resolve()
        # (relpath, pinned sha256) -> (size, mtime_ns) seen when that pin verified
        self._verified: dict[tuple[str, str], tuple[int, int]] = {}
        self._lock = threading.Lock()

    @property
    def root(self) -> Path:
        return self._root

    def path(self, model: ModelFile) -> Path:
        candidate = (self._root / model.relpath).resolve()
        if self._root not in candidate.parents:
            raise ModelUnavailable(model.name)
        try:
            info = os.stat(candidate, follow_symlinks=False)
        except OSError:
            raise ModelUnavailable(model.name) from None
        if not stat.S_ISREG(info.st_mode) or info.st_size != model.size:
            raise ModelUnavailable(model.name)
        stamp = (info.st_size, info.st_mtime_ns)
        with self._lock:
            if self._verified.get((model.relpath, model.sha256)) == stamp:
                return candidate
        sha = hashlib.sha256()
        with open(candidate, "rb") as handle:
            while chunk := handle.read(1 << 20):
                sha.update(chunk)
        if sha.hexdigest() != model.sha256:
            raise ModelUnavailable(model.name)
        with self._lock:
            self._verified[(model.relpath, model.sha256)] = stamp
        return candidate

    def available(self, models: tuple[ModelFile, ...]) -> bool:
        try:
            for model in models:
                self.path(model)
        except ModelUnavailable:
            return False
        return True
