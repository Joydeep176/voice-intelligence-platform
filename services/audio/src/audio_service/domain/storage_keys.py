"""Storage key policy shared by every storage backend (plan §5).

Keys, never paths, cross the Node/Python boundary. The pattern is identical to KEY_PATTERN in
apps/api/src/storage/local-storage.service.ts. Reads are allowed only for
`recordings/<workspaceId>/<recordingId>/original`; writes only below
`derived/<workspaceId>/<recordingId>/<configHash>`. The workspace and recording segments must
equal the task's own identifiers.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from uuid import UUID

from audio_service.contracts import ErrorCode
from audio_service.domain.errors import RequestRejected

KEY_PATTERN = re.compile(r"^[a-z0-9-]+(/[a-z0-9-]+)*$")
CONFIG_HASH_PATTERN = re.compile(r"^[0-9a-f]{64}$")
MAX_KEY_LENGTH = 512


@dataclass(frozen=True)
class TaskRefs:
    workspace_id: UUID
    recording_id: UUID

    @property
    def workspace(self) -> str:
        return str(self.workspace_id)

    @property
    def recording(self) -> str:
        return str(self.recording_id)


def _segments(key: str) -> list[str]:
    # KEY_PATTERN forbids empty segments, '.', '..', backslashes, uppercase and a leading '/'.
    if len(key) > MAX_KEY_LENGTH or not KEY_PATTERN.fullmatch(key):
        raise RequestRejected(ErrorCode.INVALID_STORAGE_KEY)
    return key.split("/")


def original_key(refs: TaskRefs) -> str:
    return f"recordings/{refs.workspace}/{refs.recording}/original"


def validate_original_key(key: str, refs: TaskRefs) -> list[str]:
    """Return the key segments when `key` is exactly this task's original."""
    parts = _segments(key)
    if len(parts) != 4 or parts[0] != "recordings" or parts[3] != "original":
        raise RequestRejected(ErrorCode.INVALID_STORAGE_KEY)
    if parts[1] != refs.workspace or parts[2] != refs.recording:
        raise RequestRejected(ErrorCode.WORKSPACE_MISMATCH)
    return parts


def validate_output_prefix(prefix: str, refs: TaskRefs) -> list[str]:
    """Return the segments (`derived`, ws, rec, configHash); one trailing '/' is tolerated."""
    parts = _segments(prefix[:-1] if prefix.endswith("/") else prefix)
    if len(parts) != 4 or parts[0] != "derived" or not CONFIG_HASH_PATTERN.fullmatch(parts[3]):
        raise RequestRejected(ErrorCode.INVALID_STORAGE_KEY)
    if parts[1] != refs.workspace or parts[2] != refs.recording:
        raise RequestRejected(ErrorCode.WORKSPACE_MISMATCH)
    return parts
