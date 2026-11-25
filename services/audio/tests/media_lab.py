"""Container-test helpers: hostile and damaged media built from bytes and FFmpeg (test-only)."""

from __future__ import annotations

import hashlib
import os
import struct
import time
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

import timestamp_lab as lab

from audio_service.contracts import ErrorCode
from audio_service.domain.errors import TaskFailure
from audio_service.domain.probe import probe_media
from audio_service.domain.runner import SandboxRunner

CANARY_TEXT = b"CANARY-OTHER-WORKSPACE-RECORDING"
PRIVATE_TITLE = "PRIVATE-TITLE-0xC0FFEE"
PRIVATE_COMMENT = "PRIVATE-COMMENT-0xBEEF"
MAPPED_FAILURES = frozenset(
    {
        ErrorCode.UNSUPPORTED_FORMAT,
        ErrorCode.CORRUPT_MEDIA,
        ErrorCode.NO_DECODABLE_AUDIO,
        ErrorCode.DURATION_LIMIT_EXCEEDED,
        ErrorCode.RESOURCE_LIMIT_EXCEEDED,
    }
)


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def make_canary(directory: Path) -> Path:
    """A file in 'another workspace's recordings' whose last access time is two days ago, so any
    read (even by an unconfined child) moves `st_atime_ns` forward under relatime."""
    directory.mkdir(parents=True, exist_ok=True)
    canary = directory / "original"
    canary.write_bytes(CANARY_TEXT)
    old = time.time() - 3 * 86400
    os.utime(canary, (old + 86400, old))  # atime two days old, mtime older still
    return canary


def canary_untouched(canary: Path, before_ns: int) -> bool:
    return canary.stat().st_atime_ns == before_ns


def run_probe_file(runner: SandboxRunner, path: Path) -> tuple[ErrorCode | None, str]:
    """(failure code or None, result JSON or ''), through the real probe."""
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        return None, probe_media(runner, fd, lab.LIMITS).model_dump_json()
    except TaskFailure as failure:
        return failure.code, ""
    finally:
        os.close(fd)


@contextmanager
def runner_pair() -> Iterator[tuple[SandboxRunner, SandboxRunner]]:
    """(confined by Landlock, unconfined). The unconfined one is the strict check: a child that
    could read anything still must not even try."""
    confined, free = SandboxRunner("auto"), SandboxRunner("off")
    confined.verify_enforcement()
    try:
        yield confined, free
    finally:
        confined.close()
        free.close()


# -- byte-level builders -----------------------------------------------------------------------


def wav_header(
    *, channels: int = 1, rate: int = 8000, bits: int = 16, data_size: int = 0, riff_size: int = 36
) -> bytes:
    block = channels * bits // 8
    fmt = struct.pack("<HHIIHH", 1, channels, rate, rate * block, block, bits)
    return (
        b"RIFF"
        + struct.pack("<I", min(riff_size + data_size, 0xFFFFFFFF))
        + b"WAVEfmt "
        + struct.pack("<I", 16)
        + fmt
        + b"data"
        + struct.pack("<I", data_size)
    )


def _boxes(data: bytes) -> list[tuple[bytes, bytes]]:
    out: list[tuple[bytes, bytes]] = []
    offset = 0
    while offset + 8 <= len(data):
        size, kind = struct.unpack(">I4s", data[offset : offset + 8])
        if size < 8 or offset + size > len(data):
            break
        out.append((kind, data[offset + 8 : offset + size]))
        offset += size
    return out


def _pack(boxes: list[tuple[bytes, bytes]]) -> bytes:
    return b"".join(struct.pack(">I4s", 8 + len(p), k) + p for k, p in boxes)


_CONTAINERS = {b"moov", b"trak", b"mdia", b"minf", b"dinf"}


def _alias_entry(location: bytes, levels: tuple[int, int]) -> bytes:
    """A Macintosh alias (`alis`) data reference with an absolute-path record. This is the only
    reference type FFmpeg's MOV demuxer parses into a path it may later open (a `url ` entry is
    skipped as unknown: measured)."""
    path = location + (b"\0" if len(location) % 2 else b"")
    record = (
        b"\0" * 10  # skipped
        + bytes([0])
        + b"\0" * 27  # volume length and name
        + b"\0" * 12  # skipped
        + bytes([0])
        + b"\0" * 63  # file name length and name
        + b"\0" * 16  # skipped
        + struct.pack(">HH", *levels)  # levels up from the input / down to the target
        + b"\0" * 16  # skipped
        + struct.pack(">HH", 2, len(path))
        + path  # type 2: absolute path
        + struct.pack(">HH", 0xFFFF, 0)  # type -1 ends the list
    )
    return struct.pack(">I4sI", 12 + len(record), b"alis", 0) + record


def _external_dref(payload: bytes, location: bytes, kind: bytes, levels: tuple[int, int]) -> bytes:
    """`dref` with one external data reference pointing at `location`."""
    if kind == b"alis":
        entry = _alias_entry(location, levels)
    else:
        entry = struct.pack(">I4sI", 12 + len(location) + 1, b"url ", 0) + location + b"\0"
    return payload[:4] + struct.pack(">I", 1) + entry


def _rewrite(
    boxes: list[tuple[bytes, bytes]], location: bytes, ref: bytes, levels: tuple[int, int]
) -> list[tuple[bytes, bytes]]:
    result = []
    for kind, payload in boxes:
        if kind in _CONTAINERS:
            result.append((kind, _pack(_rewrite(_boxes(payload), location, ref, levels))))
        elif kind == b"dref":
            result.append((kind, _external_dref(payload, location, ref, levels)))
        else:
            result.append((kind, payload))
    return result


def mp4_with_external_reference(
    mp4: bytes, location: str, ref: bytes = b"alis", levels: tuple[int, int] = (0, 0)
) -> bytes:
    """An MP4 whose track data reference (`dref`, entry type `alis` or `url `) points at `location`
    instead of itself. Works when `moov` follows `mdat` (FFmpeg's default), so no chunk offset
    needs rewriting."""
    boxes = _boxes(mp4)
    assert [k for k, _ in boxes].index(b"moov") > [k for k, _ in boxes].index(b"mdat")
    return _pack(_rewrite(boxes, location.encode(), ref, levels))


def patch_u32(data: bytes, marker: bytes, value: int, *, after: int) -> bytes:
    """Overwrite the big-endian u32 `after` bytes past the first `marker` occurrence."""
    at = data.index(marker) + after
    return data[:at] + struct.pack(">I", value) + data[at + 4 :]


def id3v2_header(tag_size: int) -> bytes:
    """ID3v2.4 header declaring `tag_size` bytes (syncsafe)."""
    safe = bytes(
        [(tag_size >> 21) & 0x7F, (tag_size >> 14) & 0x7F, (tag_size >> 7) & 0x7F, tag_size & 0x7F]
    )
    return b"ID3\x04\x00\x00" + safe
