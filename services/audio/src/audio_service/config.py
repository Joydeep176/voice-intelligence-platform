"""Settings validated at startup (LLD §8), read from AUDIO_SERVICE_* environment variables."""

from __future__ import annotations

import os
from collections.abc import Mapping
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError


class Settings(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    env: Literal["development", "test", "production"] = "development"
    log_level: Literal["debug", "info", "warning", "error"] = "info"
    host: str = "127.0.0.1"
    port: int = Field(default=8001, ge=1, le=65535)
    max_request_bytes: int = Field(default=64 * 1024, ge=1024, le=1024 * 1024)


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
