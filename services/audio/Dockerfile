# Audio service image (DEPLOYMENT §1). Non-root, read-only friendly, no dev dependencies.
# FFmpeg is installed per DEPLOYMENT §1; Phase 1 code does not invoke it yet.

FROM ghcr.io/astral-sh/uv:0.13.9 AS uv

FROM python:3.12-slim-trixie AS build
COPY --from=uv /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never
WORKDIR /app
COPY pyproject.toml uv.lock .python-version ./
RUN uv sync --locked --no-dev --no-install-project
COPY src ./src
RUN uv sync --locked --no-dev --no-editable

FROM python:3.12-slim-trixie AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 --no-create-home audio
COPY --from=build /app/.venv /app/.venv
ENV PATH="/app/.venv/bin:$PATH" \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    AUDIO_SERVICE_HOST=0.0.0.0 \
    AUDIO_SERVICE_PORT=8001
USER audio
EXPOSE 8001
CMD ["audio-service"]
