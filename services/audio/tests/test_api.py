from __future__ import annotations

import uuid

from fastapi.testclient import TestClient

from audio_service import __version__

REQ_ID = "6f1c1f9e-6a3e-4c55-9a4e-2f1f2d0f7b10"


def test_liveness_and_readiness(client: TestClient) -> None:
    for path in ("/health/live", "/health/ready"):
        res = client.get(path)
        assert res.status_code == 200
        assert res.json() == {"status": "ok", "service": "audio-service", "version": __version__}


def test_handshake_echoes_request_and_contract(client: TestClient) -> None:
    res = client.post("/v1/handshake", json={"contractVersion": "1", "requestId": REQ_ID})
    assert res.status_code == 200
    assert res.json() == {
        "contractVersion": "1",
        "serviceVersion": __version__,
        "requestId": REQ_ID,
        "accepted": True,
    }


def test_handshake_rejects_unknown_contract_version(client: TestClient) -> None:
    res = client.post("/v1/handshake", json={"contractVersion": "99", "requestId": REQ_ID})
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
        "/v1/handshake", json={"contractVersion": "1", "requestId": REQ_ID, "extra": True}
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
    res = client.get("/v1/tasks")
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
