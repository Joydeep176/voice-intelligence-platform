"""A scripted stand-in for `SandboxRunner` so probe/decoder logic is unit-tested without FFmpeg."""

from __future__ import annotations

import json
import os
import tempfile
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from audio_service.domain.runner import Outcome, RunResult

Script = Callable[[list[str], Callable[[bytes], None], Callable[[], None] | None], RunResult]


def result(
    outcome: Outcome = Outcome.EXITED, rc: int | None = 0, stderr: bytes = b"", total: int = 0
) -> RunResult:
    return RunResult(outcome, rc, stderr, total)


@dataclass
class FakeRunner:
    """`scripts` maps the executable name to a callable(argv, sink, stderr_signal) -> RunResult."""

    scripts: dict[str, Script]
    calls: list[list[str]] = field(default_factory=list)

    def run(  # noqa: PLR0913
        self,
        argv: list[str],
        *,
        stdout_sink: Callable[[bytes], None],
        timeout_s: float,
        input_fd: int | None = None,
        max_stdout_bytes: int | None = None,
        cancel: Any = None,
        stderr_signal: Callable[[], None] | None = None,
    ) -> RunResult:
        self.calls.append(argv)
        return self.scripts[argv[0]](argv, stdout_sink, stderr_signal)


def probe_json(**overrides: Any) -> dict[str, Any]:
    """What `ffprobe -show_entries ... -of json` returns for a one-stream stereo MP3."""
    stream: dict[str, Any] = {
        "index": 0,
        "codec_name": "mp3",
        "codec_type": "audio",
        "sample_fmt": "fltp",
        "sample_rate": "44100",
        "channels": 2,
        "channel_layout": "stereo",
        "bits_per_sample": 0,
        "time_base": "1/14112000",
        "start_pts": 353600,
        "start_time": "0.025057",
        "duration": "2.037551",
        "bit_rate": "128000",
    }
    stream.update(overrides.pop("stream", {}))
    document: dict[str, Any] = {
        "programs": [],
        "streams": [stream],
        "format": {"format_name": "mp3", "nb_streams": 1, "start_time": "0.025057"},
        "program_version": {"version": "7.1.5-test"},
    }
    document.update(overrides)
    return document


def tmp_file(content: bytes) -> int:
    """Read-only descriptor of a temp file holding `content` (caller closes)."""
    handle = tempfile.TemporaryFile()  # noqa: SIM115 - descriptor is handed out
    handle.write(content)
    handle.flush()
    fd = os.dup(handle.fileno())
    handle.close()
    os.lseek(fd, 0, os.SEEK_SET)
    return fd


def json_script(document: dict[str, Any], rc: int = 0, stderr: bytes = b"") -> Script:
    def script(
        _a: list[str], sink: Callable[[bytes], None], _s: Callable[[], None] | None
    ) -> RunResult:
        sink(json.dumps(document).encode())
        return result(rc=rc, stderr=stderr)

    return script
