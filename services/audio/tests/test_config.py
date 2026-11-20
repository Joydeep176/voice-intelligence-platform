from __future__ import annotations

import pytest

from audio_service.config import SettingsError, load_settings


def test_defaults() -> None:
    s = load_settings({})
    assert (s.env, s.port, s.host) == ("development", 8001, "127.0.0.1")


def test_reads_prefixed_variables_only() -> None:
    s = load_settings({"AUDIO_SERVICE_PORT": "9000", "PORT": "1", "AUDIO_SERVICE_ENV": "test"})
    assert (s.port, s.env) == (9000, "test")


def test_errors_name_variables_without_values() -> None:
    with pytest.raises(SettingsError) as info:
        load_settings({"AUDIO_SERVICE_PORT": "secret-value"})
    assert "AUDIO_SERVICE_PORT" in str(info.value)
    assert "secret-value" not in str(info.value)
