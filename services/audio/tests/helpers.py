"""Shared builders for task tests."""

from __future__ import annotations

import os
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

from audio_service.contracts import TaskCreateRequest

WS = "11111111-1111-4111-8111-111111111111"
OTHER_WS = "33333333-3333-4333-8333-333333333333"
REC = "22222222-2222-4222-8222-222222222222"
CONFIG_HASH = "a" * 64


def task_body(**overrides: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "contractVersion": "2",
        "type": "probe",
        "idempotencyKey": "idem-key-0001",
        "workspaceId": WS,
        "recordingId": REC,
        "input": {
            "originalKey": f"recordings/{WS}/{REC}/original",
            "outputPrefix": f"derived/{WS}/{REC}/{CONFIG_HASH}",
        },
        "config": {},
    }
    body.update(overrides)
    return body


def task_request(**overrides: Any) -> TaskCreateRequest:
    return TaskCreateRequest.model_validate(task_body(**overrides))


def wait_for(condition: Callable[[], bool], timeout: float = 5.0) -> None:
    deadline = time.monotonic() + timeout
    while not condition():
        if time.monotonic() > deadline:
            raise AssertionError("condition not met in time")
        time.sleep(0.01)


def contracts_dir() -> Path:
    """packages/contracts: the repository path, or a read-only mount inside the test container."""
    override = os.environ.get("AUDIO_SERVICE_CONTRACTS_DIR")
    return (
        Path(override) if override else Path(__file__).resolve().parents[3] / "packages/contracts"
    )
