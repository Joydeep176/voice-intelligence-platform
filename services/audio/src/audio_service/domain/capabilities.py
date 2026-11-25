"""Capabilities measured at startup (never hard-coded)."""

from __future__ import annotations

import platform
import re
import subprocess  # noqa: S404 - fixed argv, fixed environment

import numpy as np

from audio_service import __version__
from audio_service.contracts import (
    CONTRACT_VERSION,
    CapabilitiesResponse,
    FfmpegCapability,
    LandlockCapability,
    TaskType,
)
from audio_service.domain.runner import SAFE_ENV, SandboxRunner

_FFMPEG_VERSION = re.compile(r"^ffmpeg version (\S+)")


def measure_ffmpeg_version() -> str | None:
    try:
        out = subprocess.run(  # noqa: S603 - fixed argv, no shell
            ["ffmpeg", "-version"],  # noqa: S607 - resolved with the fixed PATH below
            capture_output=True,
            timeout=10,
            env=dict(SAFE_ENV),
            check=False,
            stdin=subprocess.DEVNULL,
        ).stdout.decode(errors="replace")
    except (OSError, subprocess.SubprocessError):
        return None
    match = _FFMPEG_VERSION.match(out.splitlines()[0]) if out else None
    return match.group(1) if match else None


def measure_capabilities(runner: SandboxRunner, task_types: list[TaskType]) -> CapabilitiesResponse:
    ffmpeg = measure_ffmpeg_version()
    return CapabilitiesResponse(
        contractVersion=CONTRACT_VERSION,
        serviceVersion=__version__,
        python=platform.python_version(),
        ffmpeg=None if ffmpeg is None else FfmpegCapability(version=ffmpeg),
        numpy=np.__version__,
        vad="none",
        landlock=LandlockCapability(
            supported=runner.landlock_supported,
            abi=runner.landlock_abi,
            enforced=runner.landlock_enforced,
            scoped=runner.landlock_scoped,
        ),
        taskTypes=task_types,
    )
