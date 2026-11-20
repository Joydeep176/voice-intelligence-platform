---
paths:
  - "services/audio/**"
---

# Python audio service rules

- Separate, deterministic internal service (ADR-0002, ADR-0019): decoding, normalisation, VAD (method OD-29), segmentation, objective measurements, self-hosted diarization. It makes no quality judgements; that is the Audio Quality Agent's job. No BullMQ, Postgres or Redis access. Reads and writes object storage only and returns metadata.
- The contract stays framework-independent (schemas in `packages/contracts`). Domain modules must not import the HTTP framework (FastAPI is accepted only provisionally, ADR-0023; only the `api` adapter may import it).
- Tasks: idempotency key, bounded concurrency, timeout, cooperative cancellation, progress reporting (LLD §3.1).
- Bounded memory (NFR-7): streamed FFmpeg decode and block-wise librosa/NumPy analysis. Diarization processes the whole file only below the configured threshold; otherwise it is windowed with cross-window clustering (ADR-0016).
- Treat input media as untrusted: probe first, enforce size, duration and time limits.
- Timestamps are integer ms relative to the original recording. Thresholds and segment settings come from config.
- Request/response models mirror `packages/contracts`. Managed with uv. Tests: Pytest. Generate long fixtures; never commit real recordings.
