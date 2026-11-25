"""Settings validated at startup (LLD §8), read from AUDIO_SERVICE_* environment variables."""

from __future__ import annotations

import os
from collections.abc import Mapping
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, SecretStr, ValidationError


class Settings(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    env: Literal["development", "test", "production"] = "development"
    log_level: Literal["debug", "info", "warning", "error"] = "info"
    host: str = "127.0.0.1"
    port: int = Field(default=8001, ge=1, le=65535)
    max_request_bytes: int = Field(default=64 * 1024, ge=1024, le=1024 * 1024)
    # ADR-0035: required, no default, at least 32 characters. Never logged (SecretStr).
    token: SecretStr = Field(min_length=32, repr=False)
    # Shared storage root (plan §5). Unset: no task can touch storage.
    storage_root: Path | None = None
    max_concurrent_tasks: int = Field(default=1, ge=1, le=4)
    max_queued_tasks: int = Field(default=4, ge=0, le=64)
    task_retention_max: int = Field(default=256, ge=1, le=10_000)
    task_retention_ttl_seconds: int = Field(default=3600, ge=1, le=7 * 86_400)
    # Overall wall-clock deadline of one task (ADR-0010): base + audio duration x permille / 1000.
    # The defaults are the existing interim per-child formula, 120 s + 0.5 x duration (OD-10 /
    # D-2B-20 Open, not approved); no new number is introduced.
    task_deadline_base_ms: int = Field(default=120_000, ge=1_000, le=86_400_000)
    task_deadline_per_audio_ms_permille: int = Field(default=500, ge=0, le=100_000)
    landlock: Literal["auto", "required", "off"] = "auto"
    # Absolute ceilings a task config cannot exceed. Interim development defaults; OD-10 Open.
    max_duration_ms: int = Field(default=14_400_000, ge=1_000, le=14_400_000)
    max_channels: int = Field(default=8, ge=1, le=8)
    max_sample_rate_hz: int = Field(default=192_000, ge=8_000, le=192_000)
    # Self-hosted inference (OD-02b / OD-03b, ADR-0036 / ADR-0037). Unset: the `transcribe` and
    # `diarize` tasks are not offered. The directory holds the pinned model files (read-only mount).
    models_dir: Path | None = None
    inference_threads: int = Field(default=1, ge=1, le=8)
    # Inference budget per task: base + audio x permille / 1000. Interim (OD-10): 4 x audio, above
    # the worst measured real-time factor on one CPU (whisper.cpp small 2.96, CAM++ 1.24).
    inference_deadline_per_audio_ms_permille: int = Field(default=4_000, ge=1_000, le=20_000)


class SettingsError(Exception):
    """Lists invalid variable names only; values may be sensitive."""

    def __init__(self, variables: list[str]) -> None:
        self.variables = variables
        super().__init__(f"Invalid environment variables: {', '.join(variables)}")


_PREFIX = "AUDIO_SERVICE_"


def load_settings(environ: Mapping[str, str] | None = None) -> Settings:
    env = os.environ if environ is None else environ
    values = {
        key[len(_PREFIX) :].lower(): value
        for key, value in env.items()
        if key.startswith(_PREFIX) and key[len(_PREFIX) :].lower() in Settings.model_fields
    }
    try:
        return Settings.model_validate(values)
    except ValidationError as exc:
        names = sorted({_PREFIX + str(err["loc"][0]).upper() for err in exc.errors()})
        raise SettingsError(names) from None
