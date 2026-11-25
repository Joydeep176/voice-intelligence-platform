"""Phase 2B review remediation against real FFmpeg in the audio image: a child killed mid-pass,
and the cover-art decoders that ffprobe opens. Run with `pnpm audio:test:container`."""

from __future__ import annotations

import os
import random
import shutil
import signal
import subprocess  # noqa: S404
import time
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any
from unittest.mock import patch

import numpy as np
import pytest
import timestamp_lab as lab
from media_lab import MAPPED_FAILURES, run_probe_file, runner_pair, sha256
from preprocess_fakes import make_context, prefix_for
from test_preprocess_container import (
    children,
    config_for,
    handler,
    place,
    temp_dirs,
    write_pcm,
)

from audio_service.contracts import ErrorCode, PreprocessResult
from audio_service.domain.capabilities import measure_capabilities
from audio_service.domain.errors import TaskFailure, is_retryable
from audio_service.domain.media_args import CODEC_WHITELIST, FORMAT_WHITELIST
from audio_service.domain.preprocess import ToolVersions
from audio_service.domain.runner import RunResult, SandboxRunner

pytestmark = pytest.mark.container


@pytest.fixture(scope="module")
def runner() -> Iterator[SandboxRunner]:
    r = SandboxRunner("auto")
    r.verify_enforcement()
    yield r
    r.close()


@pytest.fixture(scope="module")
def versions(runner: SandboxRunner) -> ToolVersions:
    caps = measure_capabilities(runner, [])
    assert caps.ffmpeg is not None
    return ToolVersions(caps.serviceVersion, caps.python, caps.ffmpeg.version, caps.numpy)


@pytest.fixture(autouse=True)
def _free_tmp(tmp_path: Path) -> Iterator[None]:
    yield
    shutil.rmtree(tmp_path, ignore_errors=True)  # the container's tmpfs is only 16 MB


@pytest.fixture
def root(tmp_path: Path) -> Iterator[Path]:
    yield tmp_path / "storage"
    shutil.rmtree(tmp_path, ignore_errors=True)  # the container's tmpfs is only 16 MB


# -- 1. a child killed by a signal mid-pass (the cgroup OOM killer's SIGKILL) -------------------


class KillingRunner:
    """Delegates to the real runner; on chunks of the pass whose argv contains `marker` it SIGKILLs
    that pass's FFmpeg child (until one kill landed), as the cgroup OOM killer would, then lets the
    runner finish. The child is the Popen the runner just created (recorded, not guessed from
    /proc)."""

    def __init__(self, inner: SandboxRunner, marker: str) -> None:
        self._inner, self._marker = inner, marker
        self.killed = 0
        self.chunks = 0
        self.alive_at_chunk: list[bool] = []

    def run(self, argv: list[str], *, stdout_sink: Callable[[bytes], None], **kw: Any) -> RunResult:
        if self._marker not in argv:
            return self._inner.run(argv, stdout_sink=stdout_sink, **kw)
        real, started = subprocess.Popen, []

        class Recording(real):  # type: ignore[valid-type, misc]
            def __init__(self, *args: Any, **kwargs: Any) -> None:
                super().__init__(*args, **kwargs)
                started.append(self)

        def sink(data: bytes) -> None:
            stdout_sink(data)
            self.chunks += 1
            if not self.killed and started:
                self.alive_at_chunk.append(started[-1].poll() is None)
                if self.alive_at_chunk[-1]:
                    os.kill(started[-1].pid, signal.SIGKILL)
                    self.killed += 1

        with patch.object(subprocess, "Popen", Recording):
            return self._inner.run(argv, stdout_sink=sink, **kw)


@pytest.mark.parametrize(("marker", "pass_name"), [("s16le", "canonical"), ("f32le", "native")])
def test_a_pass_sigkilled_mid_stream_is_failed_resource_exhausted_and_publishes_nothing(
    runner: SandboxRunner, versions: ToolVersions, tmp_path: Path, marker: str, pass_name: str
) -> None:
    root = tmp_path / "storage"
    source = tmp_path / "long.wav"
    t = np.arange(16000 * 20) / 16000
    write_pcm(source, (np.sin(2 * np.pi * 440 * t) * 8000).astype(np.int16), 16000)
    place(root, source)
    config = config_for(versions)
    killer = KillingRunner(runner, marker)
    with pytest.raises(TaskFailure) as raised:
        handler(root, killer, versions)(make_context(config))
    print(  # noqa: T201
        f"SIGKILLED_{pass_name.upper()}_PASS_CHILDREN={killer.killed} CHUNKS={killer.chunks} "
        f"ALIVE={killer.alive_at_chunk}"
    )
    assert killer.killed >= 1, "the control did not kill a child: the test proved nothing"
    assert raised.value.code is ErrorCode.RESOURCE_EXHAUSTED
    assert is_retryable(raised.value.code)
    published = root / prefix_for(config)
    assert not (published / "manifest.json").exists()
    assert not published.exists() or not any(published.iterdir())
    assert temp_dirs(root) == []
    assert children() == []  # no survivor

    # Nothing was published, so nothing can be reused: the next run computes both passes afresh.
    result = handler(root, runner, versions)(make_context(config))
    assert PreprocessResult.model_validate(result).timeline.decodeClass == "full"
    assert (published / "manifest.json").exists()


# -- 4. cover-art decoders: ffprobe opens them, so hostile pictures are reachable ---------------

JPEG_SOI = b"\xff\xd8\xff"
PNG_SIG = b"\x89PNG\r\n\x1a\n"
BOUND_S = 30.0


def make_tagged(directory: Path, kind: str) -> tuple[Path, int, int]:
    """(path, picture offset, picture length): a real file with a real attached picture."""
    tone = directory / "tone.wav"
    lab.ffmpeg(["-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-ar", "16000", str(tone)])
    if kind == "mp3-jpeg":
        art, magic, codec = directory / "art.jpg", JPEG_SOI, "copy"
        lab.ffmpeg(["-f", "lavfi", "-i", "color=c=red:s=64x64:d=1", "-frames:v", "1", str(art)])
        out = directory / "tagged.mp3"
        lab.ffmpeg(
            ["-i", str(tone), "-i", str(art), "-map", "0:a", "-map", "1:v", "-c:a", "libmp3lame",
             "-c:v", codec, "-id3v2_version", "3", str(out)]
        )  # fmt: skip
    else:
        suffix, codec = ("png", "png") if kind == "m4a-png" else ("jpg", "mjpeg")
        art, magic = directory / f"art.{suffix}", PNG_SIG if suffix == "png" else JPEG_SOI
        lab.ffmpeg(["-f", "lavfi", "-i", "color=c=blue:s=64x64:d=1", "-frames:v", "1", str(art)])
        out = directory / "tagged.m4a"
        lab.ffmpeg(
            ["-i", str(tone), "-i", str(art), "-map", "0:a", "-map", "1:v", "-c:a", "aac",
             "-c:v", codec, "-disposition:v", "attached_pic", str(out)]
        )  # fmt: skip
    data, picture = out.read_bytes(), art.read_bytes()
    offset = data.index(picture)  # the muxer copied the picture verbatim
    assert data[offset:].startswith(magic)
    return out, offset, len(picture)


def corrupt(path: Path, offset: int, length: int, how: str) -> None:
    """Rewrite the picture in place (same length, so no container offset moves)."""
    data = bytearray(path.read_bytes())
    picture = bytearray(data[offset : offset + length])
    rng = random.Random(1234)  # deterministic hostile bytes  # noqa: S311
    if how == "truncated":  # a header, then nothing
        picture[24:] = bytes(len(picture) - 24)
    elif how == "random-body":
        picture[16:] = bytes(rng.randrange(256) for _ in range(len(picture) - 16))
    elif how == "huge-dimensions":
        if picture.startswith(PNG_SIG):  # IHDR width and height: 2^31 - 1, CRC left stale
            picture[16:24] = (0x7FFFFFFF).to_bytes(4, "big") * 2
        else:  # SOF0/SOF2 height and width: 65535 x 65535
            marker = next(
                i
                for i in range(len(picture) - 9)
                if picture[i] == 0xFF and picture[i + 1] in (0xC0, 0xC2)
            )
            picture[marker + 5 : marker + 9] = b"\xff\xff\xff\xff"
    else:
        raise AssertionError(how)
    data[offset : offset + length] = picture
    path.write_bytes(bytes(data))


COVER_CASES = [
    (kind, how)
    for kind in ("mp3-jpeg", "m4a-png", "m4a-jpeg")
    for how in ("truncated", "random-body", "huge-dimensions")
]


@pytest.mark.parametrize(("kind", "how"), COVER_CASES, ids=[f"{k}-{h}" for k, h in COVER_CASES])
def test_malformed_cover_art_stays_bounded_and_mapped_under_the_sandbox(
    root: Path, tmp_path: Path, versions: ToolVersions, kind: str, how: str
) -> None:
    path, offset, length = make_tagged(tmp_path, kind)
    corrupt(path, offset, length, how)
    digest = sha256(path)
    with runner_pair() as (confined, free):
        for label, runner in (("unconfined", free), ("confined", confined)):
            started = time.monotonic()
            code, body = run_probe_file(runner, path)
            elapsed = time.monotonic() - started
            print(f"COVER_ART {kind} {how} {label}: {code or 'ok'} {elapsed:.2f}s")  # noqa: T201
            assert elapsed < BOUND_S
            # Mapped outcome only. In particular a crashed or killed child (RESOURCE_EXHAUSTED)
            # or an unmapped error would be a bounded-ness failure.
            assert code is None or code in MAPPED_FAILURES, code
            if code is None:
                assert "decodable" in body
            # The same file through the whole preprocess (packet scan and every decode pass).
            work = tmp_path / f"work-{label}"
            work.mkdir()
            copy = work / path.name
            shutil.copy(path, copy)
            outcome = _preprocess(runner, versions, work / "storage", copy)
            assert outcome is None or outcome in MAPPED_FAILURES, outcome
    assert sha256(path) == digest
    assert children() == [] and temp_dirs(tmp_path) == []


def _preprocess(
    runner: SandboxRunner, versions: ToolVersions, root: Path, source: Path
) -> ErrorCode | None:
    place(root, source)
    try:
        handler(root, runner, versions)(make_context(config_for(versions)))
    except TaskFailure as failure:
        return failure.code
    return None


@pytest.mark.parametrize("kind", ["mp3-jpeg", "m4a-png", "m4a-jpeg"])
def test_an_ordinary_tagged_file_is_still_accepted(
    root: Path, tmp_path: Path, versions: ToolVersions, runner: SandboxRunner, kind: str
) -> None:
    """Control for the cases above: the pictures are only hostile after `corrupt`."""
    path, _, _ = make_tagged(tmp_path, kind)
    code, body = run_probe_file(runner, path)
    assert code is None, code
    assert '"non_audio_streams_ignored"' in body
    assert _preprocess(runner, versions, root, path) is None


@pytest.mark.parametrize("kind", ["mp3-jpeg", "m4a-png"])
def test_ffprobe_opens_the_cover_art_decoder_so_the_whitelist_must_admit_it(
    tmp_path: Path, kind: str
) -> None:
    """The measured basis of the residual-risk statement. `avformat_find_stream_info` opens the
    decoder of an attached picture: without `mjpeg`/`png` in `-codec_whitelist` ffprobe cannot open
    the file at all ('not on whitelist', exit 1), and with them it is open (exit 0). There is no
    ffprobe option to skip it: `-nofind_stream_info` loses sample rate, channels and format."""
    path, _, _ = make_tagged(tmp_path, kind)
    picture = "mjpeg" if kind == "mp3-jpeg" else "png"
    audio_only = ",".join(c for c in CODEC_WHITELIST.split(",") if c not in ("mjpeg", "png"))

    def probe(whitelist: str, *extra: str) -> subprocess.CompletedProcess[bytes]:
        return subprocess.run(  # noqa: S603
            ["ffprobe", "-v", "error", "-format_whitelist", FORMAT_WHITELIST,  # noqa: S607
             "-codec_whitelist", whitelist, *extra,
             "-show_entries", "stream=codec_type,sample_fmt,sample_rate,channels",
             "-of", "csv=p=0", str(path)],
            capture_output=True, timeout=30, check=False, stdin=subprocess.DEVNULL,
        )  # fmt: skip

    refused = probe(audio_only)
    assert (
        refused.returncode != 0 and f"Codec ({picture}) not on whitelist".encode() in refused.stderr
    )
    admitted = probe(CODEC_WHITELIST)
    assert admitted.returncode == 0
    blind = probe(CODEC_WHITELIST, "-nofind_stream_info")
    assert blind.stdout != admitted.stdout  # the audio parameters the probe needs are lost
