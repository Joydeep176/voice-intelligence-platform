# Audio service image (DEPLOYMENT §1). Non-root, read-only friendly, no dev dependencies in the
# runtime stage. FFmpeg is installed per DEPLOYMENT §1. The `test` stage adds the dev dependencies
# and the test suite on the same base image so FFmpeg/Landlock/sandbox tests run where the service
# runs (`pnpm audio:test:container`). The runtime stage must stay last: it is the default target.

FROM ghcr.io/astral-sh/uv:0.13.9 AS uv

FROM python:3.12-slim-trixie AS build
COPY --from=uv /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never
WORKDIR /app
COPY pyproject.toml uv.lock .python-version ./
RUN uv sync --locked --no-dev --no-install-project
COPY src ./src
RUN uv sync --locked --no-dev --no-editable

FROM build AS build-test
RUN uv sync --locked --no-editable

# Benchmark-only (Phase 2B WS5a, OD-29): runtime dependencies plus the `vad-benchmark` group. Never
# the default target and never merged into `runtime`.
FROM build AS build-vad-benchmark
RUN uv sync --locked --no-dev --group vad-benchmark --no-editable

# Benchmark-only (Phase 2C C3): runtime dependencies plus the `stt-benchmark` and
# `diarization-benchmark` groups. Never the default target and never merged into `runtime`.
FROM build AS build-phase2c-benchmark
RUN uv sync --locked --no-dev --group stt-benchmark --group diarization-benchmark --no-editable

FROM python:3.12-slim-trixie AS base
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 --no-create-home audiosvc
# One thread: the container has a 1.0 CPU quota (plan 4.3), more BLAS threads would only contend.
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 OMP_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1

FROM base AS test
COPY --from=build-test /app/.venv /app/.venv
WORKDIR /app
COPY pyproject.toml ./
COPY src ./src
COPY tests ./tests
COPY benchmarks ./benchmarks
ENV PATH="/app/.venv/bin:$PATH" \
    AUDIO_SERVICE_TEST_CONTAINER=1 \
    AUDIO_SERVICE_CONTRACTS_DIR=/contracts
USER audiosvc
CMD ["pytest", "-p", "no:cacheprovider"]

FROM base AS vad-benchmark
COPY --from=build-vad-benchmark /app/.venv /app/.venv
WORKDIR /app
COPY benchmarks ./benchmarks
ENV PATH="/app/.venv/bin:$PATH"
USER audiosvc
CMD ["python", "benchmarks/vad/run.py", "--help"]

FROM base AS phase2c-benchmark
COPY --from=build-phase2c-benchmark /app/.venv /app/.venv
WORKDIR /app
COPY benchmarks ./benchmarks
ENV PATH="/app/.venv/bin:$PATH"
USER audiosvc
CMD ["python", "benchmarks/stt/run.py", "--help"]

FROM base AS runtime
COPY --from=build /app/.venv /app/.venv
ENV PATH="/app/.venv/bin:$PATH" \
    AUDIO_SERVICE_HOST=0.0.0.0 \
    AUDIO_SERVICE_PORT=8001
USER audiosvc
EXPOSE 8001
CMD ["audio-service"]
