"""ADR-0035: bearer authentication on every route except liveness. Each test fails if the control
is removed (missing check, non-constant-time compare, token logged)."""

from __future__ import annotations

import logging

import pytest
from fastapi.testclient import TestClient
from helpers import task_body

PROTECTED = [
    ("GET", "/health/ready"),
    ("POST", "/v1/handshake"),
    ("GET", "/v1/capabilities"),
    ("POST", "/v1/tasks"),
    ("GET", "/v1/tasks/6f1c1f9e-6a3e-4c55-9a4e-2f1f2d0f7b10"),
    ("DELETE", "/v1/tasks/6f1c1f9e-6a3e-4c55-9a4e-2f1f2d0f7b10"),
    ("GET", "/docs"),
    ("GET", "/no-such-route"),
]


@pytest.mark.parametrize(("method", "path"), PROTECTED)
def test_missing_token_is_401(anon_client: TestClient, method: str, path: str) -> None:
    res = anon_client.request(method, path)
    assert res.status_code == 401
    assert res.json()["code"] == "UNAUTHORIZED"
    assert res.headers["www-authenticate"] == "Bearer"


def test_auth_is_checked_before_the_body_is_parsed(anon_client: TestClient) -> None:
    res = anon_client.post(
        "/v1/tasks", content=b"{not json", headers={"content-type": "application/json"}
    )
    assert res.status_code == 401


def test_liveness_is_open(anon_client: TestClient) -> None:
    assert anon_client.get("/health/live").status_code == 200


def test_correct_token_is_accepted(client: TestClient) -> None:
    # Readiness reports real dependencies (503 on a bare unit-test host), so acceptance is asserted
    # on a route with no dependency, and on readiness as "authorised, whatever its verdict".
    assert client.get("/v1/capabilities").status_code == 200
    assert client.get("/health/ready").status_code in (200, 503)


def test_wrong_short_prefix_and_malformed_credentials_are_rejected(
    anon_client: TestClient, token: str
) -> None:
    same_length_wrong = ("A" if token[0] != "A" else "B") + token[1:]
    headers = [
        f"Bearer {same_length_wrong}",
        f"Bearer {token[:-1]}",  # a prefix of the real token
        f"Bearer {token}x",
        "Bearer ",
        "Bearer",
        token,  # no scheme
        f"Basic {token}",
        "Bearer éé",  # non-ASCII must not crash the comparison
    ]
    for value in headers:
        res = anon_client.get("/health/ready", headers={"authorization": value.encode("utf-8")})
        assert res.status_code == 401, value


def test_comparison_is_constant_time(
    anon_client: TestClient, token: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    import hmac

    calls: list[int] = []
    real = hmac.compare_digest

    def spy(a: bytes, b: bytes) -> bool:
        calls.append(1)
        return real(a, b)

    monkeypatch.setattr("audio_service.api.app.hmac.compare_digest", spy)
    anon_client.get("/health/ready", headers={"authorization": f"Bearer {token}"})
    anon_client.get("/health/ready", headers={"authorization": "Bearer wrong"})
    assert len(calls) == 2


def test_token_is_never_logged_or_returned(
    anon_client: TestClient, token: str, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.DEBUG)
    wrong = "wrong-" + token
    bodies = [
        anon_client.get("/health/ready", headers={"authorization": f"Bearer {token}"}).text,
        anon_client.get("/health/ready", headers={"authorization": f"Bearer {wrong}"}).text,
        anon_client.post(
            "/v1/tasks", json=task_body(), headers={"authorization": f"Bearer {token}"}
        ).text,
    ]
    haystack = caplog.text + " ".join(str(r.__dict__) for r in caplog.records) + " ".join(bodies)
    assert token not in haystack and wrong not in haystack
