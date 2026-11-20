from __future__ import annotations

from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from audio_service.api.app import create_app
from audio_service.config import Settings


@pytest.fixture
def client() -> Iterator[TestClient]:
    with TestClient(create_app(Settings(env="test")), raise_server_exceptions=False) as c:
        yield c
