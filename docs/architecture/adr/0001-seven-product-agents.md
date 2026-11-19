# ADR-0001: Seven product agents and step mapping

- Status: Accepted (amended by ADR-0019)
- Date: 2026-11-19
- Resolves: OD-01
- Affects: HLD §3, AGENT_ARCHITECTURE, SRS C-4

## Context
The baseline requires seven specialised LangGraph agents for a ten-step workflow (SRS §3).

## Decision
Exactly seven product agents:
1. Audio Quality Agent: step 3 (preprocessing, step 2, is deterministic and not an agent; see ADR-0019)
2. Transcription Agent: steps 4–5 (diarization belongs to the transcription stage)
3. Context Intelligence Agent: step 6
4. Research Agent: step 7
5. Fact Validation Agent: step 8
6. Reporting Agent: step 9
7. QA Agent: step 10. Independent and read-only.

Steps 1 (ingestion) and 2 (preprocessing: decoding, normalisation, VAD, segmentation) are deterministic and not agents (ADR-0019). Audio signal diagnostics (Audio Quality) stay separate from transcription uncertainty (Transcription). No eighth agent may be added without a new ADR.

Amendment (2026-11-19): an earlier version of this ADR assigned step 2 to the Audio Quality Agent. That was incorrect and is corrected by ADR-0019.

## Consequences
Agent module names: `audio-quality`, `transcription`, `context-intelligence`, `research`, `fact-validation`, `reporting`, `qa`.
