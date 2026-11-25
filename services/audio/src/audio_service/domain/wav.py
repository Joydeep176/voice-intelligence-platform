"""Canonical WAV writer (plan §3, §5): a correct RIFF/WAVE header for 16 kHz mono signed 16-bit PCM.

The header is written first with zero sizes and patched when the stream ends, so the file never
needs to be held in memory. A byte budget stops a runaway decode before it fills the disk.
"""

from __future__ import annotations

import struct
from typing import IO

from audio_service.contracts import ErrorCode
from audio_service.domain.errors import TaskFailure

HEADER_BYTES = 44
BYTES_PER_SAMPLE = 2
_MAX_DATA_BYTES = 0xFFFFFFFF - 36


def wav_header(data_bytes: int, *, sample_rate_hz: int = 16_000) -> bytes:
    """44-byte header of a mono s16 PCM WAV holding `data_bytes` of samples."""
    if not 0 <= data_bytes <= _MAX_DATA_BYTES:
        raise ValueError("data size outside the RIFF range")
    block_align = BYTES_PER_SAMPLE
    return (
        b"RIFF"
        + struct.pack("<I", 36 + data_bytes)
        + b"WAVEfmt "
        + struct.pack("<IHHIIHH", 16, 1, 1, sample_rate_hz, sample_rate_hz * block_align, 2, 16)
        + b"data"
        + struct.pack("<I", data_bytes)
    )


class WavWriter:
    def __init__(self, handle: IO[bytes], *, budget_bytes: int) -> None:
        self._handle = handle
        self._budget = budget_bytes
        self._data_bytes = 0
        handle.write(wav_header(0))

    @property
    def data_bytes(self) -> int:
        return self._data_bytes

    def write(self, raw: bytes) -> None:
        if self._data_bytes + len(raw) + HEADER_BYTES > self._budget:
            raise TaskFailure(ErrorCode.RESOURCE_LIMIT_EXCEEDED)
        self._handle.write(raw)
        self._data_bytes += len(raw)

    def finalize(self) -> None:
        """Patch the RIFF and data sizes; the caller flushes or closes the handle."""
        self._handle.flush()
        self._handle.seek(0)
        self._handle.write(wav_header(self._data_bytes))
        self._handle.flush()
