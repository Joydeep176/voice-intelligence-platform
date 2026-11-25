"""Child-process entry point for model inference (see `isolation.py`).

Reads one JSON argument (the task request, the inherited canonical-WAV descriptor and its
manifest entry, the models directory and thread count), runs the same `transcribe` or `diarize`
handler in-process, and writes JSON lines to stdout: `{"progress": ...}` and finally either
`{"result": ...}` or `{"error": "<ErrorCode>"}`. No deadline here: the parent enforces it and
kills this process.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any, cast
from uuid import UUID

from audio_service.contracts import ErrorCode, TaskCreateRequest
from audio_service.domain.errors import TaskFailure
from audio_service.domain.inference_models import ModelStore
from audio_service.domain.storage import PublishedFile, StorageBackend
from audio_service.domain.storage_keys import TaskRefs
from audio_service.domain.tasks import CancellationToken, TaskContext


def emit(message: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(message, ensure_ascii=False) + "\n")
    sys.stdout.flush()


class InheritedStorage:
    """Only what the inference handlers use: the parent's already-checked canonical WAV."""

    def __init__(self, published: PublishedFile) -> None:
        self._published = published

    def open_published_file(self, prefix: str, refs: TaskRefs, name: str) -> PublishedFile:  # noqa: ARG002
        return PublishedFile(
            fd=os.dup(self._published.fd), sha256=self._published.sha256, size=self._published.size
        )


def main() -> None:
    from audio_service.domain.diarize import DiarizeHandler  # noqa: PLC0415
    from audio_service.domain.transcribe import TranscribeHandler  # noqa: PLC0415

    msg = json.loads(sys.argv[1])  # stdin is /dev/null under the sandbox runner
    storage = cast(
        StorageBackend,
        InheritedStorage(
            PublishedFile(fd=int(msg["fd"]), sha256=msg["sha256"], size=int(msg["size"]))
        ),
    )
    models = ModelStore(Path(msg["modelsDir"]))
    request = TaskCreateRequest.model_validate(msg["request"])
    common = {
        "threads": int(msg["threads"]),
        "deadline_per_audio_permille": int(msg["permille"]),
        "isolate": False,
    }
    handler = (
        TranscribeHandler(lambda: storage, models, **common)  # type: ignore[arg-type]
        if request.type == "transcribe"
        else DiarizeHandler(lambda: storage, models, **common)  # type: ignore[arg-type]
    )
    ctx = TaskContext(
        task_id=UUID(msg["taskId"]),
        request=request,
        refs=TaskRefs(request.workspaceId, request.recordingId),
        cancel=CancellationToken(),
        _report=lambda p: emit({"progress": p.model_dump()}),
    )
    try:
        emit({"result": handler(ctx)})
    except TaskFailure as failure:
        emit({"error": failure.code.value})
    except Exception:  # noqa: BLE001 - a code only; the message could hold content
        emit({"error": ErrorCode.INTERNAL_ERROR.value})


if __name__ == "__main__":
    main()
