"""Contract compatibility check for the Node ↔ Python prototype."""

from __future__ import annotations

from uuid import UUID

from audio_service import __version__
from audio_service.contracts import CONTRACT_VERSION, HandshakeResponse


class ContractVersionMismatchError(Exception):
    pass


def handshake(contract_version: str, request_id: UUID) -> HandshakeResponse:
    if contract_version != CONTRACT_VERSION:
        raise ContractVersionMismatchError
    return HandshakeResponse(
        contractVersion=CONTRACT_VERSION, serviceVersion=__version__, requestId=request_id
    )
