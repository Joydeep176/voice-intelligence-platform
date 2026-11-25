"""The `probe` task through the real executor and HTTP API (failures that need no FFmpeg)."""

from __future__ import annotations

import hashlib
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from fastapi.testclient import TestClient
from helpers import REC, WS, task_body, wait_for

from audio_service.api.app import create_app
from audio_service.config import Settings
from audio_service.contracts import ErrorCode


@pytest.fixture
def media_client(settings: Settings, auth: dict[str, str]) -> Iterator[TestClient]:
    with TestClient(
        create_app(settings, media_handlers=True), raise_server_exceptions=False, headers=auth
    ) as c:
        yield c


def put_original(settings: Settings, content: bytes) -> Path:
    assert settings.storage_root is not None
    path = settings.storage_root / "recordings" / WS / REC / "original"
    path.parent.mkdir(parents=True)
    path.write_bytes(content)
    return path


def run(client: TestClient, **overrides: Any) -> dict[str, Any]:
    res = client.post("/v1/tasks", json=task_body(**overrides))
    assert res.status_code == 202
    task_id = res.json()["taskId"]
    wait_for(
        lambda: (
            client.get(f"/v1/tasks/{task_id}").json()["status"]
            in ("succeeded", "failed", "cancelled")
        )
    )
    body: dict[str, Any] = client.get(f"/v1/tasks/{task_id}").json()
    return body


def test_the_media_handlers_are_registered_by_the_production_wiring(
    media_client: TestClient,
) -> None:
    body = media_client.get("/v1/capabilities").json()
    assert body["taskTypes"] == ["preprocess", "probe"]
    assert body["vad"] == "none"
    assert body["numpy"] == np.__version__


def test_the_default_app_still_registers_nothing(client: TestClient) -> None:
    assert client.get("/v1/capabilities").json()["taskTypes"] == []


def test_explicit_handlers_are_used_as_given_and_win_over_the_media_flag(
    settings: Settings, auth: dict[str, str]
) -> None:
    app = create_app(settings, {}, media_handlers=True)
    with TestClient(app, headers=auth) as c:
        assert c.get("/v1/capabilities").json()["taskTypes"] == []


def test_a_missing_original_fails_with_a_storage_error_and_no_path(
    media_client: TestClient, settings: Settings
) -> None:
    assert settings.storage_root is not None
    settings.storage_root.mkdir(parents=True, exist_ok=True)
    body = run(media_client)
    assert body["status"] == "failed"
    assert body["error"] == {"code": ErrorCode.STORAGE_ERROR.value, "retryable": True}
    assert str(settings.storage_root) not in str(body)


@pytest.mark.parametrize(
    "config",
    [{"maxDurationMs": 14_400_001}, {"maxChannels": 9}, {"maxSampleRateHz": 768_000}],
)
def test_a_config_above_the_ceiling_fails_the_task_before_touching_storage(
    media_client: TestClient, config: dict[str, Any]
) -> None:
    body = run(media_client, config=config)
    assert body["status"] == "failed"
    assert body["error"]["code"] == ErrorCode.RESOURCE_LIMIT_EXCEEDED.value


def test_unrecognised_content_is_rejected_by_the_sniff_and_the_original_is_untouched(
    media_client: TestClient, settings: Settings
) -> None:
    content = b"#EXTM3U\n#EXT-X-VERSION:3\nfile:///etc/passwd\n"
    path = put_original(settings, content)
    before = (hashlib.sha256(path.read_bytes()).hexdigest(), path.stat().st_ino)
    body = run(media_client)
    assert body["status"] == "failed"
    assert body["error"] == {"code": ErrorCode.UNSUPPORTED_FORMAT.value, "retryable": False}
    assert (hashlib.sha256(path.read_bytes()).hexdigest(), path.stat().st_ino) == before


def test_an_empty_original_is_corrupt_media(media_client: TestClient, settings: Settings) -> None:
    put_original(settings, b"")
    body = run(media_client)
    assert body["error"]["code"] == ErrorCode.CORRUPT_MEDIA.value


def test_another_workspaces_key_is_refused_at_submission(media_client: TestClient) -> None:
    other = "33333333-3333-4333-8333-333333333333"
    body = task_body()
    body["input"]["originalKey"] = f"recordings/{other}/{REC}/original"
    res = media_client.post("/v1/tasks", json=body)
    assert res.status_code == 422
