"""Container detection from magic bytes (never the file name or declared MIME type).

Mirrors `apps/api/src/recordings/media-signature.ts`. The result picks the FFmpeg demuxer, so
playlist-type demuxers (hls, dash, concat, image2) can never be selected: text such as `#EXTM3U`
or `ffconcat version 1.0` matches no signature and is refused as UNSUPPORTED_FORMAT.
"""

from __future__ import annotations

import os
from dataclasses import dataclass

from audio_service.contracts import ErrorCode
from audio_service.domain.errors import TaskFailure

SNIFF_BYTES = 16
MIN_MEDIA_BYTES = 12


@dataclass(frozen=True)
class Sniffed:
    container: str  # wav | flac | ogg | mp4 | matroska | mp3
    demuxer: str  # the FFmpeg `-f` name


_DEMUXER = {
    "wav": "wav",
    "flac": "flac",
    "ogg": "ogg",
    "mp4": "mov",
    "matroska": "matroska",
    "mp3": "mp3",
}


def detect_container(head: bytes) -> str | None:  # noqa: PLR0911 - one return per signature
    if len(head) >= 12 and head[0:4] == b"RIFF" and head[8:12] == b"WAVE":
        return "wav"
    if head[0:4] == b"fLaC":
        return "flac"
    if head[0:4] == b"OggS":
        return "ogg"
    if len(head) >= 8 and head[4:8] == b"ftyp":
        return "mp4"
    if head[0:4] == bytes.fromhex("1a45dfa3"):
        return "matroska"
    if head[0:3] == b"ID3" or (len(head) >= 2 and head[0] == 0xFF and head[1] & 0xE0 == 0xE0):
        return "mp3"
    return None


def sniff(fd: int) -> Sniffed:
    """Read the first bytes without moving the shared file offset. Unknown -> UNSUPPORTED_FORMAT;
    empty or shorter than any container header -> CORRUPT_MEDIA."""
    try:
        size = os.fstat(fd).st_size
        head = os.pread(fd, SNIFF_BYTES, 0)
    except OSError:
        raise TaskFailure(ErrorCode.STORAGE_ERROR) from None
    if size == 0 or len(head) < MIN_MEDIA_BYTES:
        raise TaskFailure(ErrorCode.CORRUPT_MEDIA)
    container = detect_container(head)
    if container is None:
        raise TaskFailure(ErrorCode.UNSUPPORTED_FORMAT)
    return Sniffed(container, _DEMUXER[container])
