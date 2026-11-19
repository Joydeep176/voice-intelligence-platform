# ADR-0015: Run-specific asset ownership via preprocessing versions

- Status: Accepted
- Date: 2026-11-19
- Addresses: review finding I-02, correction E9
- Affects: DATABASE §2, §4; LLD §4; API §4

## Context
Audio segments and diagnostics were scoped to the recording but produced per run, so re-runs with different settings would conflict.

## Options
1. Scope all preprocessing artefacts to the run: simple, but duplicates work for identical settings.
2. **Preprocessing versions keyed by (recording, config hash), referenced by runs**: reusable and conflict-free.

## Decision
Option 2. The deterministic outputs (normalised audio, segments, objective audio measurements) belong to the preprocessing version. The Audio Quality Agent's diagnostic output (verdicts, flags) is run-scoped. Original audio is recording-scoped and immutable. Transcription and later artefacts are run-scoped. The hash is computed from a canonical record of the full configuration plus tool versions (audio service, Python, FFmpeg, librosa, NumPy, VAD implementation and version), and **that record is stored alongside the hash** so every preprocessing version can be reproduced and audited. Changing any version produces a new hash; stale outputs are never reused silently.
