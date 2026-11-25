"""Input limits for untrusted media (plan §6.1, D-2B-18).

The numbers are interim development defaults; OD-10 is Open. Python settings are the absolute
ceilings (`Settings.max_*`); a task config may lower a limit but never raise it above the
ceiling. Media over a limit is rejected, never truncated.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from audio_service.contracts import ErrorCode
from audio_service.domain.errors import TaskFailure

# Interim development defaults; OD-10 Open.
DEFAULT_MAX_DURATION_MS = 14_400_000  # 4 h
DEFAULT_MAX_CHANNELS = 8
DEFAULT_MAX_SAMPLE_RATE_HZ = 192_000


@dataclass(frozen=True)
class MediaLimits:
    max_duration_ms: int
    max_channels: int
    max_sample_rate_hz: int


def _pick(config: Mapping[str, Any], key: str, default: int, ceiling: int) -> int:
    value = config.get(key)
    if value is None:
        return min(default, ceiling)
    # bool is an int subclass: reject it explicitly. The value never appears in the error.
    if isinstance(value, bool) or not isinstance(value, int) or value < 1 or value > ceiling:
        raise TaskFailure(ErrorCode.RESOURCE_LIMIT_EXCEEDED)
    return value


def resolve_limits(
    config: Mapping[str, Any], *, max_duration_ms: int, max_channels: int, max_sample_rate_hz: int
) -> MediaLimits:
    """Task config -> effective limits. A value above its ceiling (or not a positive int) fails the
    task with RESOURCE_LIMIT_EXCEEDED: a caller asking for more than the service allows."""
    return MediaLimits(
        max_duration_ms=_pick(config, "maxDurationMs", DEFAULT_MAX_DURATION_MS, max_duration_ms),
        max_channels=_pick(config, "maxChannels", DEFAULT_MAX_CHANNELS, max_channels),
        max_sample_rate_hz=_pick(
            config, "maxSampleRateHz", DEFAULT_MAX_SAMPLE_RATE_HZ, max_sample_rate_hz
        ),
    )
