from __future__ import annotations

import os
import secrets
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from audio_service.api.app import create_app
from audio_service.config import Settings

IN_CONTAINER = os.environ.get("AUDIO_SERVICE_TEST_CONTAINER") == "1"
DOCKER_HOST = os.environ.get("AUDIO_SERVICE_TEST_DOCKER") == "1"


def pytest_collection_modifyitems(items: list[pytest.Item]) -> None:
    skips = {
        "container": pytest.mark.skip(
            reason="needs the audio image; run `pnpm audio:test:container` "
            "(sets AUDIO_SERVICE_TEST_CONTAINER=1)"
        ),
        "docker_host": pytest.mark.skip(reason="set AUDIO_SERVICE_TEST_DOCKER=1 to drive Docker"),
    }
    enabled = {"container": IN_CONTAINER, "docker_host": DOCKER_HOST}
    for item in items:
        for name, skip in skips.items():
            if name in item.keywords and not enabled[name]:
                item.add_marker(skip)


@pytest.fixture(scope="session")
def token() -> str:
    # Throwaway per test session; never a literal credential.
    return secrets.token_urlsafe(32)


@pytest.fixture
def settings(token: str, tmp_path: Path) -> Settings:
    return Settings(env="test", token=token, storage_root=tmp_path / "storage")


@pytest.fixture
def auth(token: str) -> dict[str, str]:
    return {"authorization": f"Bearer {token}"}


@pytest.fixture
def client(settings: Settings, auth: dict[str, str]) -> Iterator[TestClient]:
    app = create_app(settings)
    with TestClient(app, raise_server_exceptions=False, headers=auth) as c:
        yield c


@pytest.fixture
def anon_client(settings: Settings) -> Iterator[TestClient]:
    with TestClient(create_app(settings), raise_server_exceptions=False) as c:
        yield c
