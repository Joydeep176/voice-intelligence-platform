from __future__ import annotations

from typing import Any

import pytest

from audio_service.config import Settings
from audio_service.contracts import ErrorCode
from audio_service.domain.errors import TaskFailure
from audio_service.domain.media_limits import (
    DEFAULT_MAX_CHANNELS,
    DEFAULT_MAX_DURATION_MS,
    DEFAULT_MAX_SAMPLE_RATE_HZ,
    resolve_limits,
)

CEILINGS = {"max_duration_ms": 14_400_000, "max_channels": 8, "max_sample_rate_hz": 192_000}


def test_interim_defaults_are_the_documented_numbers() -> None:
    assert (DEFAULT_MAX_DURATION_MS, DEFAULT_MAX_CHANNELS, DEFAULT_MAX_SAMPLE_RATE_HZ) == (
        14_400_000,
        8,
        192_000,
    )
    limits = resolve_limits({}, **CEILINGS)
    assert (limits.max_duration_ms, limits.max_channels, limits.max_sample_rate_hz) == (
        14_400_000,
        8,
        192_000,
    )


def test_a_config_may_lower_a_limit() -> None:
    limits = resolve_limits(
        {"maxDurationMs": 60_000, "maxChannels": 2, "maxSampleRateHz": 48_000}, **CEILINGS
    )
    assert (limits.max_duration_ms, limits.max_channels, limits.max_sample_rate_hz) == (
        60_000,
        2,
        48_000,
    )


def test_settings_ceilings_lower_the_defaults() -> None:
    limits = resolve_limits(
        {}, max_duration_ms=3_600_000, max_channels=2, max_sample_rate_hz=48_000
    )
    assert (limits.max_duration_ms, limits.max_channels, limits.max_sample_rate_hz) == (
        3_600_000,
        2,
        48_000,
    )


@pytest.mark.parametrize(
    "config",
    [
        {"maxDurationMs": 14_400_001},
        {"maxChannels": 9},
        {"maxSampleRateHz": 192_001},
        {"maxDurationMs": 0},
        {"maxChannels": -1},
        {"maxChannels": True},
        {"maxDurationMs": "60000"},
        {"maxSampleRateHz": 48_000.5},
    ],
)
def test_a_config_can_never_exceed_the_ceiling_or_be_malformed(config: dict[str, Any]) -> None:
    with pytest.raises(TaskFailure) as info:
        resolve_limits(config, **CEILINGS)
    assert info.value.code is ErrorCode.RESOURCE_LIMIT_EXCEEDED


def test_settings_cannot_raise_the_ceilings_above_the_interim_defaults() -> None:
    token = "t" * 32
    for field, value in (
        ("max_duration_ms", 14_400_001),
        ("max_channels", 9),
        ("max_sample_rate_hz", 192_001),
    ):
        with pytest.raises(ValueError, match=field):
            Settings(token=token, **{field: value})  # type: ignore[arg-type]
