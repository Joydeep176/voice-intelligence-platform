from __future__ import annotations

import pytest

from audio_service.config import SettingsError, load_settings

TOKEN = "x" * 32


def test_defaults() -> None:
    s = load_settings({"AUDIO_SERVICE_TOKEN": TOKEN})
    assert (s.env, s.port, s.host) == ("development", 8001, "127.0.0.1")
    assert (s.max_concurrent_tasks, s.max_queued_tasks, s.landlock) == (1, 4, "auto")
    assert s.storage_root is None


def test_reads_prefixed_variables_only() -> None:
    s = load_settings(
        {
            "AUDIO_SERVICE_PORT": "9000",
            "PORT": "1",
            "AUDIO_SERVICE_ENV": "test",
            "AUDIO_SERVICE_TOKEN": TOKEN,
            "AUDIO_SERVICE_URL": "http://ignored",
        }
    )
    assert (s.port, s.env) == (9000, "test")


def test_errors_name_variables_without_values() -> None:
    with pytest.raises(SettingsError) as info:
        load_settings({"AUDIO_SERVICE_PORT": "secret-value", "AUDIO_SERVICE_TOKEN": TOKEN})
    assert "AUDIO_SERVICE_PORT" in str(info.value)
    assert "secret-value" not in str(info.value)


@pytest.mark.parametrize("token", [None, "", "y" * 31])
def test_token_is_required_and_at_least_32_characters(token: str | None) -> None:
    environ = {} if token is None else {"AUDIO_SERVICE_TOKEN": token}
    with pytest.raises(SettingsError) as info:
        load_settings(environ)
    assert info.value.variables == ["AUDIO_SERVICE_TOKEN"]
    if token:
        assert token not in str(info.value)


def test_token_never_appears_in_repr() -> None:
    s = load_settings({"AUDIO_SERVICE_TOKEN": TOKEN})
    assert TOKEN not in repr(s) and TOKEN not in str(s)


def test_task_limits_and_landlock_mode_are_validated() -> None:
    base = {"AUDIO_SERVICE_TOKEN": TOKEN}
    s = load_settings(
        {**base, "AUDIO_SERVICE_MAX_CONCURRENT_TASKS": "2", "AUDIO_SERVICE_LANDLOCK": "required"}
    )
    assert (s.max_concurrent_tasks, s.landlock) == (2, "required")
    with pytest.raises(SettingsError) as info:
        load_settings(
            {**base, "AUDIO_SERVICE_LANDLOCK": "maybe", "AUDIO_SERVICE_MAX_QUEUED_TASKS": "-1"}
        )
    assert info.value.variables == ["AUDIO_SERVICE_LANDLOCK", "AUDIO_SERVICE_MAX_QUEUED_TASKS"]


def test_task_deadline_settings_default_to_the_interim_per_child_formula() -> None:
    """120 s + 0.5 x duration (OD-10 / D-2B-20 Open): no new number."""
    s = load_settings({"AUDIO_SERVICE_TOKEN": TOKEN})
    assert (s.task_deadline_base_ms, s.task_deadline_per_audio_ms_permille) == (120_000, 500)
    s = load_settings(
        {
            "AUDIO_SERVICE_TOKEN": TOKEN,
            "AUDIO_SERVICE_TASK_DEADLINE_BASE_MS": "60000",
            "AUDIO_SERVICE_TASK_DEADLINE_PER_AUDIO_MS_PERMILLE": "250",
        }
    )
    assert (s.task_deadline_base_ms, s.task_deadline_per_audio_ms_permille) == (60_000, 250)


@pytest.mark.parametrize(
    ("name", "value"),
    [
        ("AUDIO_SERVICE_TASK_DEADLINE_BASE_MS", "0"),
        ("AUDIO_SERVICE_TASK_DEADLINE_BASE_MS", "1.5"),
        ("AUDIO_SERVICE_TASK_DEADLINE_PER_AUDIO_MS_PERMILLE", "-1"),
        ("AUDIO_SERVICE_TASK_DEADLINE_PER_AUDIO_MS_PERMILLE", "0.5"),
    ],
)
def test_task_deadline_settings_are_validated_integers(name: str, value: str) -> None:
    with pytest.raises(SettingsError) as info:
        load_settings({"AUDIO_SERVICE_TOKEN": TOKEN, name: value})
    assert info.value.variables == [name]
