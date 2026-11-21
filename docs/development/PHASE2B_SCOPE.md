# Phase 2B · audio processing foundation (scope record)

Status: **Approved in scope by the user on 2026-11-21. Not authorised to begin.** No planning, implementation, dependency
installation or agents until the user's separate instruction. This file records the approved scope; it is not a
technical plan and resolves no decision.

## Objective

Turn uploaded audio into reliable, measurable, versioned, analysis-ready audio assets: backend audio-processing
infrastructure that the later A1 (Audio Quality) and A2 (Transcription) agents will consume. It does not build the agents.

## Scope (from the user's brief)

1. **Ingestion and validation:** integrity and format checks on actual content, container and codec information, safe
   handling of corrupt, unsupported and partly decodable files, bounded processing and resource limits.
2. **Decoding (FFmpeg):** supported formats, sample rate, channels, duration, stream metadata, a consistent decoded
   representation, error handling.
3. **Signal analysis (NumPy, librosa where justified):** RMS, peak, clipping, silence, defensible signal-to-noise, noise
   and distortion indicators, sample-rate and channel characteristics. Measured values are kept distinct from inferred
   quality assessments; no uncalibrated scores presented as calibrated.
4. **Preprocessing:** channel handling, mono conversion where appropriate, resampling, normalisation, consistent sample
   representation. The original is never modified; outputs are versioned derivatives.
5. **Voice activity detection:** evaluate free, open-source candidates (licence, maintenance, CPU and memory, Apple M2,
   offline, multilingual speech, noisy audio, long recordings); benchmark before selecting.
6. **Segmentation:** speech regions with timestamps, configurable minimum and maximum lengths, silence gaps, padding,
   overlap where justified, long recordings, and exact traceability to the original timeline.
7. **Versioning and storage:** original, retained decoded audio, derivatives, segment metadata, processing configuration
   and version, timestamps, measurements, errors and status, all traceable to the original, through the existing storage
   abstraction.
8. **NestJS integration:** internal contracts with validation, job lifecycle, retries, timeouts, idempotency, bounded
   concurrency, real progress, structured logging, persisted status.
9. **Testing and benchmarks:** unit, Python, contract and integration tests; synthetic and consented fixtures; corrupt,
   unsupported, long, silent, noisy, stereo and mono, clipped and distorted audio; resource, failure-recovery and
   timestamp-accuracy checks; measured processing time, memory and output quality.

Out of scope: speech-to-text, diarization, context intelligence, research, fact validation, report generation, the seven
agents and full LangGraph orchestration.

Workflow when authorised: one Opus planning pass, the technical plan presented for approval, sequential Sonnet
implementation, the user's implementation review, then consolidated testing plus architecture and security reviews and an
acceptance report. One engineering phase with internal workstreams, not separately accepted milestones.

## Constraints

ADR-0034 (zero additional spending; local and open-source only; Apple M2, 16 GB, 512 GB SSD). Existing ADRs and service
boundaries: Python owns audio processing, NestJS owns APIs, jobs and coordination (ADR-0002, provisional until
prototyped; ADR-0019 deterministic preprocessing stage, not an agent; ADR-0007 immutable originals; ADR-0010 bounded
workers; ADR-0015 preprocessing versions; ADR-0018 progress propagation).

## Open decisions and questions for the planning pass (not resolved here)

- **OD-29** VAD implementation: benchmarking WebRTC VAD and Silero VAD is approved; selection is open.
- **OD-10** limits and targets (formats, size and duration, segment length and overlap, latency).
- **OD-16** progress transport to the client (Proposed SSE); **OD-23b** service-to-service authentication; **OD-18** test
  audio corpus; **OD-39** waveform peaks artefact; **OD-48** production deployment target.
- **Measurement ownership:** DATABASE_DESIGN assigns `audio_measurements` to A1, while this scope computes signal
  measurements in the audio service without A1. The boundary between deterministic measurements and A1's quality
  assessment needs the user's decision (ADR-0019).
- Phase 2A open items remain open (validation README §7.3).
