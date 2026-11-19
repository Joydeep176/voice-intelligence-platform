# ADR-0016: Diarization within bounded memory

- Status: Accepted (principle). Thresholds and algorithms are left to benchmarking (OD-03b).
- Date: 2026-11-19
- Addresses: review finding I-07, correction E6
- Affects: LLD §4 step 8 (transcription stage), `.claude/rules/python-audio.md`, NFR-7

## Context
Whole-file diarization contradicted the bounded-memory rule for recordings over two hours.

## Decision (accepted principle)
Diarization must use bounded memory for arbitrarily long recordings.

## Candidate approach (to be confirmed by benchmark)
- Managed providers receive a storage reference (no local memory concern).
- Self-hosted processes the whole file only when the duration is at or below a configured threshold derived from the task memory budget. Above it, it uses overlapping windows plus cross-window speaker-embedding clustering to keep speaker IDs global.
- Raw diarization output is stored per window (ADR-0007).

## Consequences
The threshold and window parameters are set from the benchmark (ADR-0012) and memory tests.
