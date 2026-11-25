"""HTTP behaviour of /v1/capabilities and /v1/tasks (contract v2)."""

from __future__ import annotations

import threading
from collections.abc import Iterator
from typing import Any

import numpy as np
import pytest
from fastapi.testclient import TestClient
from helpers import OTHER_WS, REC, WS, task_body, wait_for

from audio_service import __version__
from audio_service.api.app import create_app
from audio_service.config import Settings
from audio_service.contracts import CONTRACT_VERSION, ErrorCode
from audio_service.domain.errors import TaskFailure
from audio_service.domain.tasks import TaskContext


@pytest.fixture
def gate() -> threading.Event:
    return threading.Event()


@pytest.fixture
def task_client(
    settings: Settings, auth: dict[str, str], gate: threading.Event
) -> Iterator[TestClient]:
    def probe(ctx: TaskContext) -> dict[str, Any]:
        ctx.report_progress("working", 0.5, 1000)
        while not gate.is_set():
            ctx.check_cancelled()
            gate.wait(0.01)
        if ctx.request.config.get("fail"):
            raise TaskFailure(ErrorCode.CORRUPT_MEDIA)
        return {"ok": True}

    app = create_app(settings.model_copy(update={"max_queued_tasks": 1}), {"probe": probe})
    with TestClient(app, raise_server_exceptions=False, headers=auth) as c:
        yield c


def test_capabilities_are_measured_not_hardcoded(client: TestClient) -> None:
    body = client.get("/v1/capabilities").json()
    assert body["contractVersion"] == CONTRACT_VERSION
    assert body["serviceVersion"] == __version__
    assert body["taskTypes"] == []  # no handler registered yet
    assert set(body["landlock"]) == {"supported", "abi", "enforced", "scoped"}
    assert body["landlock"]["supported"] == (body["landlock"]["abi"] is not None)
    assert body["landlock"]["enforced"] in (True, False)
    assert body["landlock"]["scoped"] in (True, False)
    if not body["landlock"]["enforced"] or (body["landlock"]["abi"] or 0) < 6:
        assert body["landlock"]["scoped"] is False  # reported only when observed
    assert body["ffmpeg"] is None or body["ffmpeg"]["version"]
    assert body["numpy"] == np.__version__
    assert body["vad"] == "none"  # OD-29: no VAD is selected


def test_capabilities_list_registered_task_types(task_client: TestClient) -> None:
    assert task_client.get("/v1/capabilities").json()["taskTypes"] == ["probe"]


def test_unregistered_task_type_is_422(client: TestClient) -> None:
    res = client.post("/v1/tasks", json=task_body())
    assert res.status_code == 422
    assert res.json()["code"] == "UNSUPPORTED_TASK_TYPE"


def test_submit_poll_and_result(task_client: TestClient, gate: threading.Event) -> None:
    res = task_client.post("/v1/tasks", json=task_body())
    assert res.status_code == 202
    task_id = res.json()["taskId"]
    wait_for(lambda: task_client.get(f"/v1/tasks/{task_id}").json()["status"] == "running")
    running = task_client.get(f"/v1/tasks/{task_id}").json()
    assert running["progress"] == {"stage": "working", "fraction": 0.5, "processedMs": 1000}
    gate.set()
    wait_for(lambda: task_client.get(f"/v1/tasks/{task_id}").json()["status"] == "succeeded")
    done = task_client.get(f"/v1/tasks/{task_id}").json()
    assert done["result"] == {"ok": True} and done["error"] is None and done["type"] == "probe"


def test_failed_task_reports_code_and_retryable_only(
    task_client: TestClient, gate: threading.Event
) -> None:
    gate.set()
    task_id = task_client.post("/v1/tasks", json=task_body(config={"fail": True})).json()["taskId"]
    wait_for(lambda: task_client.get(f"/v1/tasks/{task_id}").json()["status"] == "failed")
    body = task_client.get(f"/v1/tasks/{task_id}").json()
    assert body["error"] == {"code": "CORRUPT_MEDIA", "retryable": False}
    assert body["result"] is None


def test_idempotency_replay_and_conflict(task_client: TestClient) -> None:
    first = task_client.post("/v1/tasks", json=task_body()).json()
    again = task_client.post("/v1/tasks", json=task_body()).json()
    assert again["taskId"] == first["taskId"]
    conflict = task_client.post("/v1/tasks", json=task_body(config={"x": 1}))
    assert conflict.status_code == 409
    assert conflict.json()["code"] == "IDEMPOTENCY_CONFLICT"


def test_capacity_is_503_with_retry_after(task_client: TestClient) -> None:
    task_client.post("/v1/tasks", json=task_body(idempotencyKey="idem-key-0001"))
    task_client.post("/v1/tasks", json=task_body(idempotencyKey="idem-key-0002"))
    res = task_client.post("/v1/tasks", json=task_body(idempotencyKey="idem-key-0003"))
    assert res.status_code == 503
    assert res.json()["code"] == "CAPACITY_EXCEEDED"
    assert "retry-after" in res.headers


def test_unknown_task_is_404(task_client: TestClient) -> None:
    for method in ("GET", "DELETE"):
        res = task_client.request(method, "/v1/tasks/6f1c1f9e-6a3e-4c55-9a4e-2f1f2d0f7b10")
        assert res.status_code == 404
        assert res.json()["code"] == "TASK_NOT_FOUND"


def test_cancel_running_task_is_202_then_cancelled(task_client: TestClient) -> None:
    task_id = task_client.post("/v1/tasks", json=task_body()).json()["taskId"]
    wait_for(lambda: task_client.get(f"/v1/tasks/{task_id}").json()["status"] == "running")
    assert task_client.delete(f"/v1/tasks/{task_id}").status_code == 202
    wait_for(lambda: task_client.get(f"/v1/tasks/{task_id}").json()["status"] == "cancelled")
    assert task_client.get(f"/v1/tasks/{task_id}").json()["error"] == {
        "code": "CANCELLED",
        "retryable": False,
    }


@pytest.mark.parametrize(
    ("overrides", "code"),
    [
        ({"contractVersion": "1"}, "CONTRACT_VERSION_MISMATCH"),
        (
            {"input": {"originalKey": f"recordings/{WS}/{REC}/../x", "outputPrefix": "x"}},
            "INVALID_STORAGE_KEY",
        ),
        (
            {
                "input": {
                    "originalKey": f"recordings/{OTHER_WS}/{REC}/original",
                    "outputPrefix": f"derived/{WS}/{REC}/{'a' * 64}",
                }
            },
            "WORKSPACE_MISMATCH",
        ),
    ],
)
def test_submission_rejections_are_422(
    task_client: TestClient, overrides: dict[str, Any], code: str
) -> None:
    res = task_client.post("/v1/tasks", json=task_body(**overrides))
    assert res.status_code == 422
    assert res.json()["code"] == code


def test_invalid_bodies_are_validation_failures(task_client: TestClient) -> None:
    for body in (task_body(type="translate"), task_body(workspaceId="nope"), task_body(extra=1)):
        res = task_client.post("/v1/tasks", json=body)
        assert res.status_code == 422 and res.json()["code"] == "VALIDATION_FAILED"
