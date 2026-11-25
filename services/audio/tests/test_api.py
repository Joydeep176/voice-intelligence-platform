from __future__ import annotations

import json
import os
import uuid
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from audio_service import __version__
from audio_service.api.app import create_app
from audio_service.config import Settings
from audio_service.domain import capabilities as capabilities_module

REQ_ID = "6f1c1f9e-6a3e-4c55-9a4e-2f1f2d0f7b10"


@pytest.fixture
def ready_client(
    settings: Settings, auth: dict[str, str], monkeypatch: pytest.MonkeyPatch
) -> Iterator[TestClient]:
    """A service whose dependencies are present: a writable `derived/` and an FFmpeg that reports
    a version (the host running these unit tests may have no FFmpeg)."""
    assert settings.storage_root is not None
    (settings.storage_root / "derived").mkdir(parents=True)
    monkeypatch.setattr(capabilities_module, "measure_ffmpeg_version", lambda: "7.1.5-test")
    with TestClient(create_app(settings), raise_server_exceptions=False, headers=auth) as c:
        yield c


def test_liveness_and_readiness(ready_client: TestClient) -> None:
    client = ready_client
    for path in ("/health/live", "/health/ready"):
        res = client.get(path)
        assert res.status_code == 200
        assert res.json() == {"status": "ok", "service": "audio-service", "version": __version__}


def test_handshake_echoes_request_and_contract(client: TestClient) -> None:
    res = client.post("/v1/handshake", json={"contractVersion": "2", "requestId": REQ_ID})
    assert res.status_code == 200
    assert res.json() == {
        "contractVersion": "2",
        "serviceVersion": __version__,
        "requestId": REQ_ID,
        "accepted": True,
    }


def test_handshake_rejects_other_contract_versions(client: TestClient) -> None:
    for version in ("1", "99"):
        res = client.post("/v1/handshake", json={"contractVersion": version, "requestId": REQ_ID})
        assert res.status_code == 422
        assert res.headers["content-type"].startswith("application/problem+json")
        assert res.json()["code"] == "CONTRACT_VERSION_MISMATCH"


def test_validation_errors_name_fields_but_never_echo_input(client: TestClient) -> None:
    content = "transcript-like-content-should-not-echo"
    res = client.post("/v1/handshake", json={"contractVersion": "", "requestId": content})
    assert res.status_code == 422
    body = res.json()
    assert body["code"] == "VALIDATION_FAILED"
    assert "requestId" in body["detail"] and "contractVersion" in body["detail"]
    assert content not in res.text


def test_unknown_fields_are_rejected(client: TestClient) -> None:
    res = client.post(
        "/v1/handshake", json={"contractVersion": "2", "requestId": REQ_ID, "extra": True}
    )
    assert res.status_code == 422


def test_malformed_json_is_a_safe_422(client: TestClient) -> None:
    res = client.post(
        "/v1/handshake",
        content=b'{"contractVersion": ',
        headers={"content-type": "application/json"},
    )
    assert res.status_code == 422
    assert res.json()["code"] == "VALIDATION_FAILED"


def test_oversized_bodies_are_rejected_before_parsing(client: TestClient) -> None:
    res = client.post(
        "/v1/handshake",
        content=b"x" * (70 * 1024),
        headers={"content-type": "application/json"},
    )
    assert res.status_code == 413
    assert res.json()["code"] == "PAYLOAD_TOO_LARGE"


def test_unknown_route_is_problem_details(client: TestClient) -> None:
    res = client.get("/v1/nothing-here")
    assert res.status_code == 404
    assert res.json()["code"] == "NOT_FOUND"


def test_request_id_is_propagated_or_generated(client: TestClient) -> None:
    assert (
        client.get("/health/live", headers={"x-request-id": "abc-123-def"}).headers["x-request-id"]
        == "abc-123-def"
    )
    generated = client.get("/health/live", headers={"x-request-id": "<bad>"}).headers[
        "x-request-id"
    ]
    uuid.UUID(generated)


# -- readiness reports real dependencies (liveness never does) ----------------------------------


def not_ready(client: TestClient) -> None:
    assert client.get("/health/live").status_code == 200  # liveness is unchanged
    res = client.get("/health/ready")
    assert res.status_code == 503
    assert res.json() == {"status": "down", "service": "audio-service", "version": __version__}


def test_not_ready_when_the_storage_root_is_missing(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(capabilities_module, "measure_ffmpeg_version", lambda: "7.1.5-test")
    not_ready(client)  # `settings.storage_root` does not exist


def test_not_ready_when_derived_is_missing_or_not_writable(
    settings: Settings, auth: dict[str, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(capabilities_module, "measure_ffmpeg_version", lambda: "7.1.5-test")
    assert settings.storage_root is not None
    settings.storage_root.mkdir(parents=True)  # the root exists, `derived/` does not
    with TestClient(create_app(settings), raise_server_exceptions=False, headers=auth) as c:
        not_ready(c)
        derived: Path = settings.storage_root / "derived"
        derived.mkdir()
        assert c.get("/health/ready").status_code == 200  # the check is live, not cached
        derived.chmod(0o500)
        try:
            if os.geteuid() != 0:  # root ignores permission bits
                assert c.get("/health/ready").status_code == 503
        finally:
            derived.chmod(0o700)


def test_not_ready_when_the_inference_child_cannot_read_the_models(
    settings: Settings, auth: dict[str, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(capabilities_module, "measure_ffmpeg_version", lambda: "7.1.5-test")
    assert settings.storage_root is not None
    (settings.storage_root / "derived").mkdir(parents=True)
    with TestClient(create_app(settings), raise_server_exceptions=False, headers=auth) as c:
        assert c.get("/health/ready").status_code == 200
        c.app.state.inference_models_readable = False  # type: ignore[attr-defined]
        not_ready(c)


def test_not_ready_without_a_storage_root(auth: dict[str, str], token: str) -> None:
    with TestClient(
        create_app(Settings(env="test", token=token)), raise_server_exceptions=False, headers=auth
    ) as c:
        not_ready(c)


def test_not_ready_when_ffmpeg_capability_is_absent(
    settings: Settings, auth: dict[str, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    assert settings.storage_root is not None
    (settings.storage_root / "derived").mkdir(parents=True)
    monkeypatch.setattr(capabilities_module, "measure_ffmpeg_version", lambda: None)
    with TestClient(create_app(settings), raise_server_exceptions=False, headers=auth) as c:
        not_ready(c)


def test_not_ready_when_landlock_is_required_but_not_enforced(
    settings: Settings, auth: dict[str, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    assert settings.storage_root is not None
    (settings.storage_root / "derived").mkdir(parents=True)
    monkeypatch.setattr(capabilities_module, "measure_ffmpeg_version", lambda: "7.1.5-test")
    required = settings.model_copy(update={"landlock": "required"})
    with TestClient(create_app(required), raise_server_exceptions=False, headers=auth) as c:
        if c.get("/v1/capabilities").json()["landlock"]["enforced"]:
            pytest.skip("this kernel enforces Landlock, so a required runner is ready")
        not_ready(c)


# -- request bodies are bounded while they are read, not only by their declared length -----------


def chunks(total: int, size: int = 4096) -> Iterator[bytes]:
    sent = 0
    while sent < total:
        yield b"x" * min(size, total - sent)
        sent += size


def test_a_chunked_body_over_the_cap_is_a_413_without_a_content_length(
    client: TestClient,
) -> None:
    res = client.post(
        "/v1/handshake",
        content=chunks(200 * 1024),  # an iterator: sent chunked, no Content-Length header
        headers={"content-type": "application/json"},
    )
    assert "content-length" not in res.request.headers
    assert res.status_code == 413
    assert res.json()["code"] == "PAYLOAD_TOO_LARGE"
    assert "x-request-id" in res.headers


def test_a_chunked_body_under_the_cap_is_still_served(client: TestClient) -> None:
    body = json.dumps({"contractVersion": "2", "requestId": REQ_ID}).encode()
    res = client.post(
        "/v1/handshake",
        content=iter([body[:10], body[10:]]),
        headers={"content-type": "application/json"},
    )
    assert "content-length" not in res.request.headers
    assert res.status_code == 200


def test_unauthorised_chunked_bodies_are_refused_before_being_read(
    anon_client: TestClient,
) -> None:
    res = anon_client.post("/v1/handshake", content=chunks(200 * 1024))
    assert res.status_code == 401
