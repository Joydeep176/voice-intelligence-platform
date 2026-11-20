"""Contract tests: the shared JSON fixtures validate against the Pydantic mirrors.

The same fixtures are validated by the zod schemas in packages/contracts (Vitest), so a
change on one side that is not mirrored on the other fails one of the two suites.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from pydantic import ValidationError

from audio_service.contracts import (
    CONTRACT_VERSION,
    ErrorResponse,
    HandshakeRequest,
    HandshakeResponse,
    ProbeResponse,
)

FIXTURES = Path(__file__).resolve().parents[3] / "packages/contracts/fixtures/audio-service"
TS_CONTRACT = Path(__file__).resolve().parents[3] / "packages/contracts/src/audio-service.ts"


def load(name: str) -> Any:
    return json.loads((FIXTURES / name).read_text())


def test_valid_fixtures_parse() -> None:
    HandshakeRequest.model_validate(load("handshake-request.valid.json"))
    HandshakeResponse.model_validate(load("handshake-response.valid.json"))
    ProbeResponse.model_validate(load("probe.valid.json"))
    ErrorResponse.model_validate(load("error.valid.json"))


def test_invalid_fixture_is_rejected() -> None:
    with pytest.raises(ValidationError):
        HandshakeRequest.model_validate(load("handshake-request.invalid.json"))


def test_contract_version_matches_typescript() -> None:
    assert f"AUDIO_SERVICE_CONTRACT_VERSION = '{CONTRACT_VERSION}'" in TS_CONTRACT.read_text()
