"""Entry point: `uv run audio-service` (or `python -m audio_service.main`)."""

from __future__ import annotations

import sys

import uvicorn

from audio_service.api.app import create_app
from audio_service.config import SettingsError, load_settings
from audio_service.logging import configure_logging


def run() -> None:
    try:
        settings = load_settings()
    except SettingsError as exc:
        sys.stderr.write(f"{exc}\n")
        raise SystemExit(1) from None
    configure_logging(settings.log_level)
    uvicorn.run(
        create_app(settings, media_handlers=True),
        host=settings.host,
        port=settings.port,
        log_config=None,
        server_header=False,
        timeout_graceful_shutdown=10,
    )


if __name__ == "__main__":
    run()
