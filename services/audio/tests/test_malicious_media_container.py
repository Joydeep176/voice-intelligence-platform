"""Malicious and adversarial media (plan §6.4) against the real probe in the audio image.

Pass criteria per case: the canary file in another workspace's `recordings/` directory is never
read (checked unconfined, where only the absence of any attempt keeps its access time unchanged,
and again under Landlock), the outcome is a success or a mapped error code, time is bounded, no
stderr, tag or file text reaches the result, an error or the logs, and the original's SHA-256 is
unchanged.
"""

from __future__ import annotations

import logging
import os
import random
import subprocess  # noqa: S404
import time
from pathlib import Path

import pytest
import timestamp_lab as lab
from helpers import OTHER_WS, REC, WS
from media_lab import (
    CANARY_TEXT,
    MAPPED_FAILURES,
    PRIVATE_COMMENT,
    PRIVATE_TITLE,
    canary_untouched,
    id3v2_header,
    make_canary,
    mp4_with_external_reference,
    patch_u32,
    run_probe_file,
    runner_pair,
    sha256,
    wav_header,
)

from audio_service.contracts import ErrorCode
from audio_service.domain import probe as probe_module

pytestmark = pytest.mark.container

BOUND_S = 30.0  # one probe (two ffprobe runs and a trial decode) must stay well inside this
LEAKY = ("Invalid data", "moov atom", "@ 0x", "Header missing", "not on whitelist")


@pytest.fixture
def root(tmp_path: Path) -> Path:
    base = tmp_path / "storage"
    (base / "recordings" / WS / REC).mkdir(parents=True)
    return base


@pytest.fixture
def canary(root: Path) -> tuple[Path, int]:
    path = make_canary(root / "recordings" / OTHER_WS / "44444444-4444-4444-8444-444444444444")
    return path, path.stat().st_atime_ns


def original(root: Path) -> Path:
    return root / "recordings" / WS / REC / "original"


def check(
    path: Path,
    canary: tuple[Path, int],
    *,
    expect: set[ErrorCode] | None = None,
    allow_success: bool = True,
) -> tuple[ErrorCode | None, str]:
    """Probe unconfined and confined; assert the common pass criteria; return the first result."""
    digest = sha256(path)
    outcomes: list[tuple[ErrorCode | None, str]] = []
    with runner_pair() as (confined, free):
        for runner in (free, confined):
            started = time.monotonic()
            code, body = run_probe_file(runner, path)
            assert time.monotonic() - started < BOUND_S
            outcomes.append((code, body))
            assert canary_untouched(*canary), "the canary was read"
            assert code is None or code in MAPPED_FAILURES, code
            assert CANARY_TEXT.decode() not in body
            assert PRIVATE_TITLE not in body and PRIVATE_COMMENT not in body
    assert outcomes[0][0] == outcomes[1][0]  # Landlock changes nothing for benign handling
    assert sha256(path) == digest
    code = outcomes[0][0]
    if expect is not None:
        assert code in expect, code
    if not allow_success:
        assert code is not None
    return outcomes[0]


def test_canary_control_a_plain_read_does_move_the_access_time(
    canary: tuple[Path, int],
) -> None:
    """Sensitivity check: without it, 'atime unchanged' would prove nothing."""
    path, before = canary
    with runner_pair() as (_, free):
        free.run(["cat", str(path)], stdout_sink=lambda _d: None, timeout_s=5)
    assert path.stat().st_atime_ns != before


def test_landlock_denies_the_canary_to_a_confined_child(canary: tuple[Path, int]) -> None:
    path, _ = canary
    leaked = bytearray()
    with runner_pair() as (confined, _):
        if not confined.landlock_enforced:
            pytest.skip("Landlock is not enforced on this kernel")
        result = confined.run(["cat", str(path)], stdout_sink=leaked.extend, timeout_s=5)
    assert result.returncode != 0 and not leaked


# -- playlists, manifests and lists under audio names ---------------------------------------


@pytest.mark.parametrize(
    ("name", "content"),
    [
        ("hls.wav", b"#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:1,\n{canary}\n#EXT-X-ENDLIST\n"),
        ("hls-key.mp3", b'#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="file://{canary}"\nseg.ts\n'),
        ("dash.mp3", b'<?xml version="1.0"?><MPD><BaseURL>file://{canary}</BaseURL></MPD>'),
        ("concat.wav", b"ffconcat version 1.0\nfile {canary}\nfile 'subfile,,end,1,,:{canary}'\n"),
        ("subfile.mp3", b"subfile,,start,0,end,100,,:{canary}"),
        ("pattern.wav", b"frame%03d.png"),
        ("fileurl.mp3", b"file:{canary}\n"),
        ("png.wav", b"\x89PNG\r\n\x1a\n" + b"\0" * 64),
        ("html.mp3", b"<html><script>fetch('file://{canary}')</script></html>"),
    ],
)  # fmt: skip
def test_playlist_and_manifest_content_is_refused_before_ffmpeg_runs(
    root: Path, canary: tuple[Path, int], name: str, content: bytes
) -> None:
    original(root).write_bytes(content.replace(b"{canary}", str(canary[0]).encode()))
    code, _ = check(
        original(root), canary, expect={ErrorCode.UNSUPPORTED_FORMAT}, allow_success=False
    )
    assert code is ErrorCode.UNSUPPORTED_FORMAT


def test_image_sequence_siblings_are_never_globbed(root: Path, canary: tuple[Path, int]) -> None:
    """A valid WAV whose name looks like an image-sequence pattern, with numbered siblings."""
    directory = root / "recordings" / WS / REC
    for index in (1, 2, 3):
        (directory / f"frame{index:03d}.wav").write_bytes(b"\0" * 64)
    path = directory / "frame%03d.wav"
    lab.make_wav(path, 16000, 1, "pcm_s16le")
    siblings = {p: p.stat().st_atime_ns for p in directory.glob("frame0*.wav")}
    old = time.time() - 3 * 86400
    for sibling in siblings:
        os.utime(sibling, (old, old))
    before = {p: p.stat().st_atime_ns for p in siblings}
    code, body = check(path, canary)
    assert code is None and '"container":"wav"' in body
    assert {p: p.stat().st_atime_ns for p in siblings} == before


# -- MP4/MOV external data references -------------------------------------------------------


def make_m4a(path: Path) -> None:
    lab.ffmpeg([*lab.burst_source(44100, 1), "-c:a", "aac", "-f", "mp4", str(path)])


def read_by_plain_ffmpeg(path: Path, canary: Path, flags: list[str]) -> bool:
    """Unsandboxed FFmpeg on a *path* input; True if the canary's access time moved."""
    old = time.time() - 3 * 86400
    os.utime(canary, (old + 86400, old))
    before = canary.stat().st_atime_ns
    command = ["ffmpeg", "-v", "error", "-f", "mov", *flags, "-i", str(path), "-f", "null", "-"]
    subprocess.run(command, check=False, capture_output=True, timeout=30, stdin=subprocess.DEVNULL)
    return canary.stat().st_atime_ns != before


def hostile_references(clean: bytes, canary: Path) -> dict[str, bytes]:
    """FFmpeg's MOV demuxer parses only `alis` references into paths: an absolute one (opened only
    with `-use_absolute_path 1`) and a relative one that walks up from the input's directory
    (opened with `-enable_drefs 1`). A `url ` reference is skipped as unknown but kept as a case."""
    other = f"/x/{OTHER_WS}/44444444-4444-4444-8444-444444444444/original"
    return {
        "absolute": mp4_with_external_reference(clean, str(canary)),
        "relative-traversal": mp4_with_external_reference(clean, other, levels=(3, 3)),
        "url": mp4_with_external_reference(clean, f"file://{canary}", ref=b"url "),
    }


def test_the_hostile_references_really_do_read_the_canary_when_given_a_path(
    root: Path, canary: tuple[Path, int], tmp_path: Path
) -> None:
    """Sensitivity control: with a path input and the references enabled, FFmpeg follows them.
    Without this the production tests below could pass for the wrong reason."""
    clean = tmp_path / "clean.m4a"
    make_m4a(clean)
    refs = hostile_references(clean.read_bytes(), canary[0])
    for name, flags in (
        ("absolute", ["-enable_drefs", "1", "-use_absolute_path", "1"]),
        ("relative-traversal", ["-enable_drefs", "1"]),
    ):
        original(root).write_bytes(refs[name])
        assert read_by_plain_ffmpeg(original(root), canary[0], flags), name
        assert not read_by_plain_ffmpeg(original(root), canary[0], []), name  # defaults: harmless


def test_mp4_external_data_references_never_open_the_canary(
    root: Path, canary: tuple[Path, int], tmp_path: Path
) -> None:
    clean = tmp_path / "clean.m4a"
    make_m4a(clean)
    for name, hostile in hostile_references(clean.read_bytes(), canary[0]).items():
        original(root).write_bytes(hostile)
        code, _ = check(original(root), canary)  # success or a mapped code; canary untouched
        print(f"DREF_{name.upper()}={code}")  # noqa: T201


def test_polyglot_wav_with_an_mp4_box_and_external_reference(
    root: Path, canary: tuple[Path, int], tmp_path: Path
) -> None:
    clean = tmp_path / "clean.m4a"
    make_m4a(clean)
    wav = tmp_path / "w.wav"
    lab.make_wav(wav, 16000, 1, "pcm_s16le")
    hostile = mp4_with_external_reference(clean.read_bytes(), str(canary[0]))
    original(root).write_bytes(wav.read_bytes() + hostile)
    code, body = check(original(root), canary)
    assert code is None and '"container":"wav"' in body  # the RIFF header wins; MOV never parses it


def test_mp4_ftyp_first_with_a_riff_tail_is_an_mp4_not_a_wav(
    root: Path, canary: tuple[Path, int], tmp_path: Path
) -> None:
    clean = tmp_path / "clean.m4a"
    make_m4a(clean)
    wav = tmp_path / "w.wav"
    lab.make_wav(wav, 16000, 1, "pcm_s16le")
    original(root).write_bytes(clean.read_bytes() + wav.read_bytes())
    code, body = check(original(root), canary)
    assert code is None and '"container":"mp4"' in body


# -- metadata that contains file: / subfile: strings ----------------------------------------


@pytest.mark.parametrize(
    ("suffix", "args"),
    [
        ("mp3", ["-c:a", "libmp3lame", "-id3v2_version", "3", "-f", "mp3"]),
        ("m4a", ["-c:a", "aac", "-f", "mp4"]),
        ("wav", ["-c:a", "pcm_s16le", "-f", "wav"]),
        ("flac", ["-c:a", "flac", "-f", "flac"]),
        ("ogg", ["-c:a", "libvorbis", "-f", "ogg"]),
    ],
)
def test_metadata_with_file_and_subfile_urls_is_never_followed_or_returned(
    root: Path, canary: tuple[Path, int], suffix: str, args: list[str]
) -> None:
    target = canary[0]
    lab.ffmpeg(
        [
            *lab.burst_source(44100, 1),
            "-metadata", f"title={PRIVATE_TITLE} file:{target}",
            "-metadata", f"comment={PRIVATE_COMMENT} subfile,,start,0,end,10,,:{target}",
            "-metadata", f"artist=concat:{target}|{target}",
            *args, str(original(root)),
        ]
    )  # fmt: skip
    assert PRIVATE_TITLE.encode() in original(root).read_bytes()  # present in the file...
    code, body = check(original(root), canary)  # ...never in the result
    assert code is None and "file:" not in body and "subfile" not in body


def test_oversized_id3_tag_is_bounded_and_not_returned(
    root: Path, canary: tuple[Path, int], tmp_path: Path
) -> None:
    """A 20 MB ID3v2 tag (a sparse hole, so the 16 MB tmpfs is not consumed) in front of valid
    MP3 frames."""
    mp3 = tmp_path / "s.mp3"
    lab.ffmpeg([*lab.burst_source(44100, 1), "-c:a", "libmp3lame", "-write_xing", "0", str(mp3)])
    tag = 20 * 1024 * 1024
    with original(root).open("wb") as handle:
        handle.write(id3v2_header(tag))
        handle.seek(10 + tag)
        handle.write(mp3.read_bytes())
    code, body = check(original(root), canary)
    assert code is None or code in MAPPED_FAILURES
    assert body == "" or "ID3" not in body


def test_oversized_id3_tag_with_no_audio_after_it(root: Path, canary: tuple[Path, int]) -> None:
    with original(root).open("wb") as handle:
        handle.write(id3v2_header(20 * 1024 * 1024))
        handle.truncate(10 + 20 * 1024 * 1024)
    check(original(root), canary, allow_success=False)


# -- truncated, empty, header-only, wrong magic ---------------------------------------------


def test_zero_length_original(root: Path, canary: tuple[Path, int]) -> None:
    original(root).write_bytes(b"")
    code, _ = check(original(root), canary, expect={ErrorCode.CORRUPT_MEDIA}, allow_success=False)
    assert code is ErrorCode.CORRUPT_MEDIA


def test_header_only_wav_is_corrupt_media(root: Path, canary: tuple[Path, int]) -> None:
    original(root).write_bytes(wav_header())
    code, _ = check(original(root), canary, allow_success=False)
    assert code in {ErrorCode.CORRUPT_MEDIA, ErrorCode.NO_DECODABLE_AUDIO}
    print(f"HEADER_ONLY_WAV={code}")  # noqa: T201


def test_header_only_flac_and_mp3_and_ogg(
    root: Path, canary: tuple[Path, int], tmp_path: Path
) -> None:
    for suffix, args, keep in (
        ("flac", ["-c:a", "flac", "-f", "flac"], 42),
        ("mp3", ["-c:a", "libmp3lame", "-f", "mp3"], 64),
        ("ogg", ["-c:a", "libvorbis", "-f", "ogg"], 120),
    ):
        full = tmp_path / f"f.{suffix}"
        lab.ffmpeg([*lab.burst_source(44100, 1), *args, str(full)])
        original(root).write_bytes(full.read_bytes()[:keep])
        code, _ = check(original(root), canary, allow_success=False)
        print(f"HEADER_ONLY_{suffix.upper()}={code}")  # noqa: T201


@pytest.mark.parametrize("keep", [4, 11, 20, 30])
def test_wav_truncated_inside_the_header(root: Path, canary: tuple[Path, int], keep: int) -> None:
    original(root).write_bytes(wav_header()[:keep])
    code, _ = check(original(root), canary, allow_success=False)
    assert code is ErrorCode.CORRUPT_MEDIA


def test_wrong_magic_mp3_bytes_under_an_ogg_header(
    root: Path, canary: tuple[Path, int], tmp_path: Path
) -> None:
    mp3 = tmp_path / "m.mp3"
    lab.ffmpeg([*lab.burst_source(44100, 1), "-c:a", "libmp3lame", str(mp3)])
    original(root).write_bytes(b"OggS" + mp3.read_bytes()[4:])
    check(original(root), canary, allow_success=False)
    original(root).write_bytes(b"RIFF\x00\x00\x00\x00WAVE" + mp3.read_bytes())
    check(original(root), canary, allow_success=False)


# -- huge declared sizes, durations and parameters ------------------------------------------


def test_wav_declaring_a_four_gigabyte_data_chunk(root: Path, canary: tuple[Path, int]) -> None:
    original(root).write_bytes(wav_header(data_size=0xFFFFFFF0, riff_size=36) + b"\0" * 4096)
    code, body = check(original(root), canary)
    print(f"HUGE_WAV_DATA={code} {body[:0]}")  # noqa: T201 - outcome recorded in the docs


def test_mp4_declaring_an_enormous_duration_is_rejected_not_truncated(
    root: Path, canary: tuple[Path, int], tmp_path: Path
) -> None:
    clean = tmp_path / "clean.m4a"
    make_m4a(clean)
    data = clean.read_bytes()
    # Header durations (v0: after the type: flags, created, modified, timescale, duration = +20),
    # the sample table's first run length (+12) and the edit list's segment duration (+12).
    data = patch_u32(data, b"mdhd", 0x7FFFFFFF, after=20)
    data = patch_u32(data, b"mvhd", 0x7FFFFFFF, after=20)
    data = patch_u32(data, b"stts", 0x00FFFFFF, after=12)
    if b"elst" in data:
        data = patch_u32(data, b"elst", 0x7FFFFFFF, after=12)
    original(root).write_bytes(data)
    code, _ = check(original(root), canary)
    print(f"HUGE_MP4_DURATION={code}")  # noqa: T201
    assert code is ErrorCode.DURATION_LIMIT_EXCEEDED


def test_flac_declaring_two_to_the_36_samples(
    root: Path, canary: tuple[Path, int], tmp_path: Path
) -> None:
    clean = tmp_path / "c.flac"
    lab.make_flac(clean, 44100, 1, 16)
    data = bytearray(clean.read_bytes())
    # STREAMINFO payload starts at byte 8; total samples = low nibble of byte 21 + bytes 22..25.
    data[21] |= 0x0F
    data[22:26] = b"\xff\xff\xff\xff"
    original(root).write_bytes(bytes(data))
    code, _ = check(original(root), canary)
    print(f"HUGE_FLAC_DURATION={code}")  # noqa: T201
    assert code is ErrorCode.DURATION_LIMIT_EXCEEDED


def test_255_channel_wav_header(root: Path, canary: tuple[Path, int]) -> None:
    original(root).write_bytes(wav_header(channels=255, rate=8000, data_size=2040) + b"\0" * 2040)
    code, _ = check(original(root), canary, allow_success=False)
    print(f"WAV_255_CHANNELS={code}")  # noqa: T201
    assert code is ErrorCode.RESOURCE_LIMIT_EXCEEDED


def test_768_khz_wav_header(root: Path, canary: tuple[Path, int]) -> None:
    original(root).write_bytes(wav_header(channels=1, rate=768000, data_size=4096) + b"\0" * 4096)
    code, _ = check(original(root), canary, allow_success=False)
    print(f"WAV_768KHZ={code}")  # noqa: T201
    assert code is ErrorCode.RESOURCE_LIMIT_EXCEEDED


# -- time bounds and process cleanup --------------------------------------------------------


def children_named(*names: str) -> list[str]:
    found = []
    for entry in Path("/proc").iterdir():
        if entry.name.isdigit():
            try:
                comm = (entry / "comm").read_text().strip()
            except OSError:
                continue
            if comm in names:
                found.append(entry.name)
    return found


def test_a_probe_that_exceeds_its_timeout_is_killed_and_leaves_no_process(
    root: Path, canary: tuple[Path, int], monkeypatch: pytest.MonkeyPatch
) -> None:
    lab.make_wav(original(root), 8000, 1, "pcm_s16le", noise=0.01)
    monkeypatch.setattr(probe_module, "PROBE_TIMEOUT_S", 0.0)
    started = time.monotonic()
    with runner_pair() as (_, free):
        fd = os.open(original(root), os.O_RDONLY)
        try:
            with pytest.raises(Exception) as info:  # noqa: PT011
                probe_module.probe_media(free, fd, lab.LIMITS)
        finally:
            os.close(fd)
    assert info.value.code is ErrorCode.TIMEOUT  # type: ignore[attr-defined]
    assert time.monotonic() - started < 10
    assert children_named("ffprobe", "ffmpeg") == []


# -- logs -----------------------------------------------------------------------------------


def test_no_stderr_or_tag_text_reaches_the_logs(
    root: Path, canary: tuple[Path, int], caplog: pytest.LogCaptureFixture
) -> None:
    lab.ffmpeg(
        [
            *lab.burst_source(44100, 1),
            "-metadata", f"title={PRIVATE_TITLE}",
            "-c:a", "libmp3lame", "-f", "mp3", str(original(root)),
        ]
    )  # fmt: skip
    data = bytearray(original(root).read_bytes())
    for index in range(len(data) // 2, len(data) // 2 + 400):
        data[index] = (index * 37) % 256  # damage, so FFmpeg writes complaints to stderr
    broken = root / "recordings" / WS / REC / "broken"
    broken.write_bytes(bytes(data))
    with caplog.at_level(logging.DEBUG), runner_pair() as (confined, _):
        run_probe_file(confined, original(root))
        run_probe_file(confined, broken)
    text = "\n".join(f"{r.name} {r.getMessage()} {r.__dict__}" for r in caplog.records)
    for fragment in (PRIVATE_TITLE, *LEAKY, str(canary[0])):
        assert fragment not in text


# -- seeded mutation fuzzing ----------------------------------------------------------------


def valid_samples(directory: Path) -> dict[str, bytes]:
    specs = {
        "wav": ["-c:a", "pcm_s16le", "-f", "wav"],
        "mp3": ["-c:a", "libmp3lame", "-f", "mp3"],
        "m4a": ["-c:a", "aac", "-f", "mp4"],
        "flac": ["-c:a", "flac", "-f", "flac"],
        "ogg": ["-c:a", "libvorbis", "-f", "ogg"],
    }
    samples = {}
    for name, args in specs.items():
        path = directory / f"v.{name}"
        lab.ffmpeg([*lab.burst_source(16000, 1, duration_s=1.0, noise=0.01), *args, str(path)])
        samples[name] = path.read_bytes()
    return samples


def mutate(data: bytes, rnd: random.Random) -> bytes:
    out = bytearray(data)
    kind = rnd.choice(("flip", "header", "truncate", "insert", "zero"))
    if kind == "flip":
        for _ in range(rnd.randint(1, 32)):
            out[rnd.randrange(len(out))] ^= 1 << rnd.randrange(8)
    elif kind == "header":
        for _ in range(rnd.randint(1, 8)):
            out[rnd.randrange(min(64, len(out)))] = rnd.randrange(256)
    elif kind == "truncate":
        del out[rnd.randrange(8, len(out)) :]
    elif kind == "insert":
        at = rnd.randrange(len(out))
        out[at:at] = bytes(rnd.randrange(256) for _ in range(rnd.randint(1, 64)))
    else:
        at = rnd.randrange(len(out))
        out[at : at + rnd.randint(1, 256)] = b"\0" * rnd.randint(1, 256)
    return bytes(out)


def test_fifty_seeded_mutations_of_valid_media(
    root: Path, canary: tuple[Path, int], tmp_path: Path
) -> None:
    samples = valid_samples(tmp_path)
    rnd = random.Random(20261121)  # noqa: S311 - fixed seed: the same 50 variants every run
    outcomes: dict[str, int] = {}
    slowest = 0.0
    with runner_pair() as (confined, free):
        for index in range(50):
            name = sorted(samples)[index % 5]
            original(root).write_bytes(mutate(samples[name], rnd))
            digest = sha256(original(root))
            for runner in (free, confined) if index % 10 == 0 else (confined,):
                started = time.monotonic()
                code, body = run_probe_file(runner, original(root))
                slowest = max(slowest, time.monotonic() - started)
                assert code is None or code in MAPPED_FAILURES, (index, name, code)
                assert "tags" not in body and "PRIVATE" not in body
            outcomes[str(code)] = outcomes.get(str(code), 0) + 1
            assert sha256(original(root)) == digest
            assert canary_untouched(*canary)
    assert slowest < BOUND_S
    print(f"FUZZ_OUTCOMES={sorted(outcomes.items())} SLOWEST_S={slowest:.2f}")  # noqa: T201
    assert sum(outcomes.values()) == 50 and children_named("ffprobe", "ffmpeg") == []
