"""FastAPI application: probes, handshake, capabilities and the task API (contract v2).

Every route except `/health/live` requires `Authorization: Bearer <AUDIO_SERVICE_TOKEN>`
(ADR-0035). `main.py` registers the media handlers (`probe` since WS3, `preprocess` since WS4).
"""

from __future__ import annotations

import asyncio
import hmac
import logging
import os
import re
import time
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable, Mapping, MutableMapping
from contextlib import asynccontextmanager
from typing import Any
from uuid import UUID

from fastapi import FastAPI, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from audio_service import __version__
from audio_service.config import Settings
from audio_service.contracts import (
    CapabilitiesResponse,
    ErrorCode,
    ErrorResponse,
    HandshakeRequest,
    HandshakeResponse,
    ProbeResponse,
    TaskAccepted,
    TaskCreateRequest,
    TaskStatusResponse,
    TaskType,
)
from audio_service.domain.capabilities import measure_capabilities
from audio_service.domain.diarize import DiarizeHandler
from audio_service.domain.errors import RequestRejected
from audio_service.domain.handshake import ContractVersionMismatchError, handshake
from audio_service.domain.inference_models import (
    DIARIZATION_MODELS,
    MEASURE_MODELS,
    STT_MODELS,
    ModelStore,
)
from audio_service.domain.isolation import inference_runner as inference_runner_for
from audio_service.domain.isolation import models_readable
from audio_service.domain.landlock import disable_dumping
from audio_service.domain.measure import MeasureHandler
from audio_service.domain.preprocess import PreprocessHandler, ToolVersions
from audio_service.domain.probe import ProbeHandler
from audio_service.domain.runner import SandboxRunner
from audio_service.domain.storage import LocalStorageBackend, StorageBackend
from audio_service.domain.tasks import Handler, TaskExecutor
from audio_service.domain.transcribe import TranscribeHandler

log = logging.getLogger("audio_service.http")
_SAFE_ID = re.compile(r"^[A-Za-z0-9._-]{8,64}$")
_PROBLEM = "application/problem+json"
_PUBLIC_PATHS = frozenset({"/health/live"})
_REJECTION_STATUS = {
    ErrorCode.CONTRACT_VERSION_MISMATCH: 422,
    ErrorCode.UNSUPPORTED_TASK_TYPE: 422,
    ErrorCode.INVALID_STORAGE_KEY: 422,
    ErrorCode.WORKSPACE_MISMATCH: 422,
    ErrorCode.IDEMPOTENCY_CONFLICT: 409,
    ErrorCode.CAPACITY_EXCEEDED: 503,
    ErrorCode.TASK_NOT_FOUND: 404,
}


def _problem(status: int, code: str, title: str, detail: str | None = None) -> JSONResponse:
    body = ErrorResponse(status=status, code=code, title=title, detail=detail)
    return JSONResponse(body.model_dump(exclude_none=True), status_code=status, media_type=_PROBLEM)


def _authorized(request: Request, token: bytes) -> bool:
    scheme, _, presented = request.headers.get("authorization", "").partition(" ")
    if scheme.lower() != "bearer":
        return False
    # Constant-time comparison on bytes (str comparison raises for non-ASCII input).
    return hmac.compare_digest(presented.strip().encode(), token)


def _rejection(exc: RequestRejected) -> JSONResponse:
    status = _REJECTION_STATUS.get(exc.code, 422)
    response = _problem(status, exc.code.value, "Request rejected")
    if exc.code is ErrorCode.CAPACITY_EXCEEDED:
        response.headers["retry-after"] = "5"
    return response


class _BodyLimit:
    """Pure ASGI middleware: at most `max_bytes` of request body are ever read, whatever the
    framing. `Content-Length` is checked by the outer middleware before any read; this counts the
    bytes actually received, which is the only bound for chunked bodies (no Content-Length) and for
    clients that understate it. Over the limit the handler sees a disconnect and the response is
    replaced with a 413 problem document, whatever the handler answered."""

    def __init__(self, app: ASGIApp, max_bytes: int) -> None:
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        received = 0
        exceeded = False
        responded = False

        async def limited_receive() -> Message:
            nonlocal received, exceeded
            if exceeded:
                return {"type": "http.disconnect"}
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > self.max_bytes:
                    exceeded = True
                    return {"type": "http.disconnect"}  # stop reading; the 413 is sent below
            return message

        async def reply_413() -> None:
            nonlocal responded
            if responded:
                return
            responded = True
            response = _problem(413, "PAYLOAD_TOO_LARGE", "Payload too large")
            await response(scope, _no_receive, send)

        async def guarded_send(message: Message) -> None:
            if exceeded:
                await reply_413()  # whatever the handler made of the cut-off body is discarded
            elif not responded:
                await send(message)

        await self.app(scope, limited_receive, guarded_send)
        if exceeded:
            await reply_413()


async def _no_receive() -> MutableMapping[str, Any]:
    return {"type": "http.disconnect"}


class _Resources:
    """Created in the lifespan; handlers resolve them per call."""

    storage: StorageBackend | None = None
    runner: SandboxRunner | None = None
    inference_runner: SandboxRunner | None = None  # the inference profile (ADR-0036 / ADR-0037)
    tool_versions: ToolVersions | None = None

    def get_runner(self) -> SandboxRunner:
        if self.runner is None:
            raise RuntimeError("service not started")
        return self.runner


def _readiness_problems(settings: Settings, state: Any) -> list[str]:
    """Reason codes (never paths) for which the service cannot run media tasks right now."""
    problems: list[str] = []
    root = settings.storage_root
    derived = None if root is None else root / "derived"
    if derived is None or not (
        derived.is_dir() and not derived.is_symlink() and os.access(derived, os.W_OK | os.X_OK)
    ):
        problems.append("storage_derived_not_writable")
    capabilities = getattr(state, "capabilities", None)
    if capabilities is None or capabilities.ffmpeg is None:
        problems.append("ffmpeg_missing")
    runner = getattr(state, "runner", None)
    inference_runner = getattr(state, "inference_runner", None)
    if settings.landlock == "required" and (
        runner is None
        or not runner.landlock_enforced
        or (inference_runner is not None and not inference_runner.landlock_enforced)
    ):
        problems.append("landlock_not_enforced")
    if getattr(state, "inference_models_readable", None) is False:
        problems.append("inference_models_unreadable")
    return problems


def create_app(  # noqa: PLR0915 - application factory: lifespan, middleware, routes
    settings: Settings,
    handlers: Mapping[TaskType, Handler] | None = None,
    *,
    media_handlers: bool = False,
) -> FastAPI:
    """`media_handlers=True` registers the real media task handlers (production wiring in
    `main.py`); explicit `handlers` always win and are used as given."""
    token = settings.token.get_secret_value().encode()
    resources = _Resources()
    registered: dict[TaskType, Handler] = dict(handlers or {})
    if media_handlers and handlers is None:
        registered["probe"] = ProbeHandler(
            lambda: resources.storage,
            resources.get_runner,
            max_duration_ms=settings.max_duration_ms,
            max_channels=settings.max_channels,
            max_sample_rate_hz=settings.max_sample_rate_hz,
        )
        registered["preprocess"] = PreprocessHandler(
            lambda: resources.storage,
            resources.get_runner,
            lambda: resources.tool_versions,
            max_duration_ms=settings.max_duration_ms,
            max_channels=settings.max_channels,
            max_sample_rate_hz=settings.max_sample_rate_hz,
        )
        if settings.models_dir is not None:
            # Self-hosted inference (ADR-0036 / ADR-0037): offered only when every pinned model
            # file verifies (size and SHA-256), so `taskTypes` tells Node what can run.
            models = ModelStore(settings.models_dir)
            if models.available(STT_MODELS):
                registered["transcribe"] = TranscribeHandler(
                    lambda: resources.storage,
                    models,
                    threads=settings.inference_threads,
                    deadline_per_audio_permille=settings.inference_deadline_per_audio_ms_permille,
                    runner=lambda: resources.inference_runner,
                )
            if models.available(DIARIZATION_MODELS):
                registered["diarize"] = DiarizeHandler(
                    lambda: resources.storage,
                    models,
                    threads=settings.inference_threads,
                    deadline_per_audio_permille=settings.inference_deadline_per_audio_ms_permille,
                    runner=lambda: resources.inference_runner,
                )
            if models.available(MEASURE_MODELS):
                # Phase 3A (ADR-0045): speech-aware measurements; a media-style deadline factor.
                registered["measure"] = MeasureHandler(
                    lambda: resources.storage,
                    models,
                    threads=settings.inference_threads,
                    deadline_per_audio_permille=settings.task_deadline_per_audio_ms_permille,
                    runner=lambda: resources.inference_runner,
                )
            log.info(
                "inference_models",
                extra={
                    "transcribe": "transcribe" in registered,
                    "diarize": "diarize" in registered,
                    "measure": "measure" in registered,
                },
            )
    executor = TaskExecutor(
        registered,
        max_concurrent=settings.max_concurrent_tasks,
        max_queued=settings.max_queued_tasks,
        retention_max=settings.task_retention_max,
        retention_ttl_seconds=settings.task_retention_ttl_seconds,
        deadline_base_ms=settings.task_deadline_base_ms,
        deadline_per_audio_permille=settings.task_deadline_per_audio_ms_permille,
        deadline_max_duration_ms=settings.max_duration_ms,
    )

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        # Before any child exists: a child that escaped its Landlock domain could otherwise read
        # /proc/<our pid>/environ (the service token) as the same user.
        dumping_disabled = disable_dumping()
        runner = SandboxRunner(settings.landlock)
        storage: StorageBackend | None = None
        if settings.storage_root is not None:
            storage = LocalStorageBackend(settings.storage_root)
            removed = await asyncio.to_thread(storage.cleanup_stale_temp)
            log.info("stale_temp_cleanup", extra={"removed": removed})
        await asyncio.to_thread(runner.verify_enforcement)
        inference_runner: SandboxRunner | None = None
        if settings.models_dir is not None and (
            {"transcribe", "diarize", "measure"} & registered.keys()
        ):
            inference_runner = inference_runner_for(settings.landlock, settings.models_dir)
            await asyncio.to_thread(inference_runner.verify_enforcement)
            relpaths = [
                m.relpath
                for task, specs in (
                    ("transcribe", STT_MODELS),
                    ("diarize", DIARIZATION_MODELS),
                    ("measure", MEASURE_MODELS),
                )
                if task in registered
                for m in specs
            ]
            relpaths = list(dict.fromkeys(relpaths))
            app.state.inference_models_readable = await asyncio.to_thread(
                models_readable, inference_runner, settings.models_dir, relpaths
            )
        app.state.inference_runner = inference_runner
        resources.inference_runner = inference_runner
        app.state.runner = runner
        app.state.storage = storage
        resources.runner = runner
        resources.storage = storage
        app.state.capabilities = await asyncio.to_thread(
            measure_capabilities, runner, executor.task_types
        )
        capabilities = app.state.capabilities
        if capabilities.ffmpeg is not None:
            resources.tool_versions = ToolVersions(
                service=capabilities.serviceVersion,
                python=capabilities.python,
                ffmpeg=capabilities.ffmpeg.version,
                numpy=capabilities.numpy,
            )
        log.info(
            "service_started",
            extra={
                "landlockSupported": runner.landlock_supported,
                "landlockAbi": runner.landlock_abi,
                "landlockEnforced": runner.landlock_enforced,
                "landlockScoped": runner.landlock_scoped,
                "dumpingDisabled": dumping_disabled,
                "inferenceLandlockEnforced": (
                    None if inference_runner is None else inference_runner.landlock_enforced
                ),
                "inferenceModelsReadable": getattr(app.state, "inference_models_readable", None),
            },
        )
        executor.start()
        try:
            yield
        finally:
            executor.shutdown()
            runner.close()
            if inference_runner is not None:
                inference_runner.close()

    app = FastAPI(
        lifespan=lifespan,
        title="VIP audio service (internal)",
        version=__version__,
        docs_url=None if settings.env == "production" else "/docs",
        redoc_url=None,
        openapi_url=None if settings.env == "production" else "/openapi.json",
    )

    # Added first, so it is the inner layer: unauthorised requests are refused before any body byte
    # is read, and the 413 passes back through `request_context` (request id, access log).
    app.add_middleware(_BodyLimit, max_bytes=settings.max_request_bytes)

    @app.middleware("http")
    async def request_context(
        request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        incoming = request.headers.get("x-request-id", "")
        request_id = incoming if _SAFE_ID.match(incoming) else str(uuid.uuid4())
        length = request.headers.get("content-length")
        if request.url.path not in _PUBLIC_PATHS and not _authorized(request, token):
            response: Response = _problem(401, ErrorCode.UNAUTHORIZED.value, "Unauthorized")
            response.headers["www-authenticate"] = "Bearer"
        elif length is not None and (
            not length.isdigit() or int(length) > settings.max_request_bytes
        ):
            response = _problem(413, "PAYLOAD_TOO_LARGE", "Payload too large")
        else:
            started = time.perf_counter()
            response = await call_next(request)
            route = request.scope.get("route")
            log.info(
                "http_request",
                extra={
                    "requestId": request_id,
                    "method": request.method,
                    "route": getattr(route, "path", "unmatched"),
                    "status": response.status_code,
                    "durationMs": round((time.perf_counter() - started) * 1000),
                },
            )
        response.headers["x-request-id"] = request_id
        return response

    @app.exception_handler(RequestValidationError)
    async def on_validation_error(_: Request, exc: RequestValidationError) -> JSONResponse:
        # Field paths and error types only. The request body is never echoed (SEC-9).
        fields = sorted({".".join(str(p) for p in e["loc"][1:]) or "(body)" for e in exc.errors()})
        return _problem(
            422, "VALIDATION_FAILED", "Validation failed", f"Invalid fields: {', '.join(fields)}"
        )

    @app.exception_handler(StarletteHTTPException)
    async def on_http_error(_: Request, exc: StarletteHTTPException) -> JSONResponse:
        code = {404: "NOT_FOUND", 405: "METHOD_NOT_ALLOWED"}.get(exc.status_code, "REQUEST_FAILED")
        return _problem(exc.status_code, code, "Request failed")

    @app.exception_handler(Exception)
    async def on_unhandled(_: Request, exc: Exception) -> JSONResponse:
        log.error("unhandled_error", extra={"errorName": type(exc).__name__})
        return _problem(500, "INTERNAL_ERROR", "Internal server error")

    @app.get("/health/live", response_model=ProbeResponse)
    async def live() -> ProbeResponse:
        return ProbeResponse(status="ok", version=__version__)

    @app.get("/health/ready", response_model=ProbeResponse)
    async def ready(request: Request) -> ProbeResponse | JSONResponse:
        """Ready for media tasks: `derived/` writable, FFmpeg present and, with Landlock `required`,
        confinement verified. Liveness (`/health/live`) is separate and unchanged."""
        problems = _readiness_problems(settings, request.app.state)
        if problems:
            log.warning("not_ready", extra={"reasons": problems})
            body = ProbeResponse(status="down", version=__version__)
            return JSONResponse(body.model_dump(), status_code=503)
        return ProbeResponse(status="ok", version=__version__)

    @app.post("/v1/handshake", response_model=HandshakeResponse)
    async def post_handshake(body: HandshakeRequest) -> HandshakeResponse | JSONResponse:
        try:
            return handshake(body.contractVersion, body.requestId)
        except ContractVersionMismatchError:
            return _problem(
                422,
                "CONTRACT_VERSION_MISMATCH",
                "Contract version mismatch",
                "Unsupported contract version.",
            )

    @app.get("/v1/capabilities", response_model=CapabilitiesResponse)
    async def get_capabilities(request: Request) -> CapabilitiesResponse:
        capabilities: CapabilitiesResponse = request.app.state.capabilities
        return capabilities

    @app.post("/v1/tasks", response_model=TaskAccepted, status_code=202)
    async def post_task(body: TaskCreateRequest) -> TaskAccepted | JSONResponse:
        try:
            return executor.submit(body)
        except RequestRejected as exc:
            return _rejection(exc)

    @app.get("/v1/tasks/{task_id}", response_model=TaskStatusResponse)
    async def get_task(task_id: UUID) -> TaskStatusResponse | JSONResponse:
        try:
            return executor.get(task_id)
        except RequestRejected as exc:
            return _rejection(exc)

    @app.delete("/v1/tasks/{task_id}", response_model=TaskAccepted, status_code=202)
    async def delete_task(task_id: UUID) -> TaskAccepted | JSONResponse:
        try:
            snapshot = executor.cancel(task_id)
        except RequestRejected as exc:
            return _rejection(exc)
        return TaskAccepted(taskId=snapshot.taskId, status=snapshot.status)

    return app
