"""Pydantic mirrors of the audio-service schemas in packages/contracts/src/audio-service.ts.

Change both together. tests/test_contracts.py validates the shared JSON fixtures in
packages/contracts/fixtures/audio-service, which the TypeScript tests also validate.
"""

from __future__ import annotations

from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

CONTRACT_VERSION = "1"


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class ProbeResponse(_Model):
    status: Literal["ok", "down"]
    service: Literal["audio-service"] = "audio-service"
    version: str


class HandshakeRequest(_Model):
    contractVersion: str = Field(min_length=1, max_length=16)  # noqa: N815 (wire format)
    requestId: UUID  # noqa: N815


class HandshakeResponse(_Model):
    contractVersion: str  # noqa: N815
    serviceVersion: str  # noqa: N815
    requestId: UUID  # noqa: N815
    accepted: Literal[True] = True


class ErrorResponse(_Model):
    type: str = "about:blank"
    title: str
    status: int
    code: str
    detail: str | None = None
