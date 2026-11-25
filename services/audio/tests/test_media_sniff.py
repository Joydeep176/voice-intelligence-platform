"""Magic-byte container detection (mirror of apps/api media-signature.ts)."""

from __future__ import annotations

import os

import pytest
from media_fakes import tmp_file

from audio_service.contracts import ErrorCode
from audio_service.domain.errors import TaskFailure
from audio_service.domain.media_sniff import detect_container, sniff


@pytest.mark.parametrize(
    ("head", "container"),
    [
        (b"RIFF\x24\x00\x00\x00WAVEfmt ", "wav"),
        (b"fLaC\x00\x00\x00\x22", "flac"),
        (b"OggS\x00\x02\x00\x00", "ogg"),
        (b"\x00\x00\x00\x20ftypM4A ", "mp4"),
        (b"\x1a\x45\xdf\xa3\x01\x00\x00\x00", "matroska"),
        (b"ID3\x04\x00\x00\x00\x00\x00\x00", "mp3"),
        (b"\xff\xfb\x90\x00" + b"\0" * 12, "mp3"),
        (b"\xff\xf3\x90\x00" + b"\0" * 12, "mp3"),
    ],
)
def test_signatures(head: bytes, container: str) -> None:
    assert detect_container(head) == container


@pytest.mark.parametrize(
    "head",
    [
        b"#EXTM3U\n#EXT-X-VERSION:3\n",
        b"<?xml version='1.0'?>",
        b"ffconcat version 1.0\n",
        b"RIFF\x24\x00\x00\x00AVI LIST",  # RIFF but not WAVE
        b"\xff\x00\x00\x00",  # 0xff without the sync bits
        b"file:/etc/passwd\n",
        b"frame%03d.png\n",
    ],
)
def test_text_and_near_misses_have_no_container(head: bytes) -> None:
    assert detect_container(head) is None


def test_polyglot_wav_header_with_mp4_box_is_a_wav() -> None:
    # A RIFF/WAVE header comes first, so the demuxer forced is `wav` and no MOV parser runs.
    head = b"RIFF\x24\x00\x00\x00WAVE" + b"\x00\x00\x00\x20ftypM4A "
    assert detect_container(head) == "wav"


def test_the_extension_is_never_consulted() -> None:
    fd = tmp_file(b"#EXTM3U\n#EXT-X-VERSION:3\nseg.ts\n")  # an HLS playlist, whatever its name
    try:
        with pytest.raises(TaskFailure) as info:
            sniff(fd)
    finally:
        os.close(fd)
    assert info.value.code is ErrorCode.UNSUPPORTED_FORMAT


@pytest.mark.parametrize("content", [b"", b"RIFF", b"RIFF\0\0\0\0WAV"])
def test_empty_and_too_short_files_are_corrupt(content: bytes) -> None:
    fd = tmp_file(content)
    try:
        with pytest.raises(TaskFailure) as info:
            sniff(fd)
    finally:
        os.close(fd)
    assert info.value.code is ErrorCode.CORRUPT_MEDIA


def test_sniffing_does_not_move_the_shared_offset() -> None:
    fd = tmp_file(b"fLaC" + b"\0" * 64)
    try:
        os.lseek(fd, 17, os.SEEK_SET)
        sniff(fd)
        assert os.lseek(fd, 0, os.SEEK_CUR) == 17  # pread: children share this offset
    finally:
        os.close(fd)
