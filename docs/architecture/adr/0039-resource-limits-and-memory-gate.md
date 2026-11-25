# ADR-0039: Resource limits, memory gate and processing limits

- Status: Accepted (user-authorised resolution, 2026-11-24); decision 2 CPU/threads amended by ADR-0041
- Date: 2026-11-24
- Resolves: OD-10; Phase 2B decisions D-2B-18, D-2B-19, D-2B-20 and the lossy-timestamp target (plan §11.3)
- Affects: `infra/docker/compose.yaml`, `services/audio/src/audio_service/config.py`, `apps/orchestrator/src/config.ts`,
  `apps/api` run settings, DEPLOYMENT_ARCHITECTURE, `.env.example`

## Context

OD-10 (limits and targets) and the Phase 2B resource decisions were open. The development values were interim. The
Phase 2B evidence (`docs/development/phase2b-resources/README.md`) showed that `memory.peak` is not a usable gate,
because it counts reclaimable page cache: the 30 min WAV and the 4 h FLAC reached the 512 MB limit while their
anonymous memory was 88 MB and 100 MB. The evidence recommended gating on anonymous memory.

Phase 2C self-hosted inference (ADR-0036 / ADR-0037) added two needs:

- **Memory.** whisper.cpp small measured **488.8 MiB** anonymous memory decoding a 30 s window in one pass in a
  512 MB container. With the service baseline (~45 MiB) that exceeds 512 MB.
- **Time.** Local inference runs near or above real time on one CPU, so the FFmpeg-oriented timeouts
  (120 s + 0.5 × duration) and the 1 h run deadline cannot hold.

## Decision

1. **Memory gate (D-2B-20): anonymous memory peak**, sampled at ≥ 10 Hz, with `memory.peak` reported but not gated.
2. **Audio-service container: 768 MB, 1.0 CPU, 64 pids, one task at a time.** *Amended by ADR-0041 (2026-11-25): 2.0 CPUs
   and 2 inference threads; memory and pids unchanged.* Measured anonymous peaks:

   | Task | Anonymous peak |
   | --- | --- |
   | Media tasks | ≤ 170 MiB |
   | Transcription (VAD spans + whisper, 30 s window) | 394.7 MiB |
   | Diarization (5 min, whole file) | 282.8 MiB |
   | Diarization (60 min, windowed) | see ADR-0037 |

   ONNX and whisper threads: 1 (`OMP_NUM_THREADS=1`, `AUDIO_SERVICE_INFERENCE_THREADS=1`).
3. **Limits (D-2B-18):** maximum duration 4 h; upload 2 GiB; ≤ 8 channels; ≤ 192 kHz.
4. **Segmentation (D-2B-19):** 1–30 s; split on silence ≥ 500 ms; merge gaps < 300 ms; padding 200 ms; 1 s overlap on
   forced splits. This applies when preprocessing VAD is enabled; it is not enabled (ADR-0038).
5. **Timeouts:**
   - Media tasks keep `120 s + 0.5 × duration`.
   - Inference tasks get their own budget, `120 s + 4 × audio duration` (`AUDIO_SERVICE_INFERENCE_DEADLINE_PER_AUDIO_MS_PERMILLE`).
   - The orchestrator bounds one provider call at `120 s + 5 × audio of the call` (`RUN_PROVIDER_TIMEOUT_*`).
   - A run's deadline is `1 h + 6 × recording duration` (`RUN_DEADLINE_*`).
6. **Transcription windows:** 30 s with 1 s overlap (D-2C-02). Speech spans inside a window come from ADR-0038.
   Diarization: whole file up to 10 min; above that, 10 min windows with 30 s overlap (ADR-0037).
7. **Retries:** 3 per run (`RUN_MAX_RETRIES`); BullMQ attempts 3.
8. **Lossy-timestamp target: ±10 ms** (plan §11.3, proposed in Phase 2B). Lossy inputs are never reported as `exact`.

All values are configuration, validated at startup, with these defaults.

## Consequences

- The Docker Desktop VM (4 GiB here) has room for Postgres, Redis, the audio service and a benchmark container.
- These are single-machine development values for an Apple M1 with 8 GB. Production sizing remains part of OD-48.
- Long recordings take hours on one CPU (ADR-0036). Latency targets are therefore stated as these bounds, not as
  real-time goals.
