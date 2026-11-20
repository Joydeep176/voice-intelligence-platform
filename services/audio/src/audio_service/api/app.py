"""FastAPI application: probes and the Phase 1 handshake. No audio processing endpoints exist."""

from __future__ import annotations

import logging
import re
import time
import uuid
from collections.abc import Awaitable, Callable

from fastapi import FastAPI, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from audio_service import __version__
from audio_service.config import Settings
from audio_service.contracts import (
    ErrorResponse,
    HandshakeRequest,
    HandshakeResponse,
    ProbeResponse,
)
from audio_service.domain.handshake import ContractVersionMismatchError, handshake

log = logging.getLogger("audio_service.http")
_SAFE_ID = re.compile(r"^[A-Za-z0-9._-]{8,64}$")
_PROBLEM = "application/problem+json"


def _problem(status: int, code: str, title: str, detail: str | None = None) -> JSONResponse:
    body = ErrorResponse(status=status, code=code, title=title, detail=detail)
    return JSONResponse(body.model_dump(exclude_none=True), status_code=status, media_type=_PROBLEM)


def create_app(settings: Settings) -> FastAPI:
    app = FastAPI(
        title="VIP audio service (internal)",
        version=__version__,
        docs_url=None if settings.env == "production" else "/docs",
        redoc_url=None,
        openapi_url=None if settings.env == "production" else "/openapi.json",
    )

    @app.middleware("http")
    async def request_context(
        request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        incoming = request.headers.get("x-request-id", "")
        request_id = incoming if _SAFE_ID.match(incoming) else str(uuid.uuid4())
        length = request.headers.get("content-length")
        if length is not None and (
            not length.isdigit() or int(length) > settings.max_request_bytes
        ):
            response: Response = _problem(413, "PAYLOAD_TOO_LARGE", "Payload too large")
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
    async def ready() -> ProbeResponse:
        # Phase 1 has no dependencies to check (no FFmpeg work, no storage access yet).
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

    return app
