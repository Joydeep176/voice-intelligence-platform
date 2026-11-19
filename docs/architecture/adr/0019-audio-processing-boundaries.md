# ADR-0019: Deterministic audio-processing service and agent boundaries

- Status: Accepted
- Date: 2026-11-19
- Resolves: corrects OD-01 step assignment (amends ADR-0001)
- Affects: HLD §3–5, AGENT_ARCHITECTURE §1–4, LLD §2–4, DATABASE §2, SRS C-4, FR-2.x, FR-3.1, FR-4.2

## Decision
- FFmpeg decoding, normalisation, VAD and segmentation belong to the **deterministic audio-processing service**. A deterministic graph node invokes them; they are not an agent.
- The **Audio Quality Agent** analyses objective audio measurements and produces its own diagnostic output.
- The **Transcription Agent** owns transcription, language identification, diarization and transcription uncertainty.
- Audio diagnostics and transcription uncertainty remain separate data models; neither agent reads or writes the other's.

## Consequences
The audio service computes objective measurements but makes no quality judgements. The VAD implementation is OD-29 (Open; WebRTC VAD and Silero VAD approved for benchmarking). Parallel execution of A1 and A2: ADR-0021.
