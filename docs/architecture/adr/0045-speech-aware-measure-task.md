# ADR-0045: Speech-aware objective measurements as a separate audio-service `measure` task

- Status: **Accepted** (user decision, 2026-11-26, with the M0 refinements and the as-built amendment below). First written as Proposed in the Phase 3A plan
  (2026-11-26)
- Date: 2026-11-26
- Addresses: OD-51 (new); the LLD §3 `measure` row ("no separate `measure` task"); plan decision D-3A-09
- Affects: `services/audio` (new task), `packages/contracts` (task type, `MeasurementRecord` schema v2, contract
  version), DATABASE_DESIGN (`audio_measurement_sets` new, `audio_measurements` uniqueness), LLD §3, §5

## Context

- **What A1 needs:** speech-aware objective measurements for its main dimensions — SNR proxy, speech presence,
  active-speech level, pauses and fragmentation, effective bandwidth.
- **What exists:**
  - Preprocessing VAD is fixed at `none` (ADR-0038), so `snr` is `unavailable: no_speech_split`.
  - Silero VAD exists, pinned and sandboxed, but only inside `transcribe`.
- **Rules that apply:**
  - ADR-0019: the service measures and never judges (the `FORBIDDEN_KEY` test).
  - ADR-0015: measurements belong to the preprocessing version.

## Options considered

1. **A new `measure` task** over the verified canonical WAV:
   - Silero in the existing sandboxed child, plus NumPy block features;
   - results stored per (preprocessing version, measure config hash) in a new `audio_measurement_sets` row, plus an
     immutable `audio_measurements` record (schema v2) and a `speech-series.json`
     artefact (not "quality-…": the service's `FORBIDDEN_KEY` guard matches "quality");
   - preprocessing unchanged.
2. **Enable Silero in preprocessing.** This changes the accepted 2B behaviour and its config hashes, and conflicts with
   ADR-0038's "preprocessing VAD stays `none`".
3. **No speech-aware measurement** (Tier 0 only). The SNR, speech-presence and bandwidth dimensions would be lost.

## Decision

**Option 1.**

- **Measurement only:** numbers with units, kinds and methods; `unavailable` with reasons. No judgement keys.
- **Determinism:** the config is hashed; a verified published output is reused.
- **Execution:** the media deadline formula; one task at a time (existing); no change to limits, model, windows or
  deadlines.
- **Default VAD settings:** the ADR-0038 transcription settings.
- **Cost check before adoption:**
  - Phase 3A M0 measures estimator error and the cost of a benchmark **harness** in the production image. These
    figures are indicative only: no task API, sandbox or concurrent service process is involved.
  - M4 repeats performance, memory and sandbox validation on the implemented task, and only those figures are
    acceptance evidence.
  - The Phase 2B evidence is Silero RTF 0.017 at 1 CPU, 172 MiB peak.

## Consequences

- The audio-service contract version is bumped; `AudioTaskType` gains `measure`; contract fixtures, including a
  judgement-key invalid fixture, are added.
- **Migration:**
  - new `audio_measurement_sets`;
  - `audio_measurements` gains `measurement_set_id` (composite FK with `preprocessing_id`); the existing
    whole-recording unique index is narrowed to rows without a set, and a partial unique (`measurement_set_id`,
    `source`) is added, so Tier 0 and Tier 1 rows coexist;
  - the immutability trigger and cascade deletion are unchanged in principle.
- LLD §3 "no separate `measure` task" is updated.
- AGENT_ARCHITECTURE §4 ("A1 requests the audio-service `measure` task") is amended: the preprocessing flow runs it,
  the preprocessing coordinator persists it (DATABASE_DESIGN "Writers"), and A1 only reads it.
- The whole-recording reader of the processing snapshot filters out Tier 1 rows, so accepted 2B output is unchanged.
- If the SNR proxy proves unreliable, the design falls back to banded SNR output or to dropping SNR-derived
  severity. The rest of the task is unaffected.

## M0 refinements (accepted with this ADR, 2026-11-26)

Evidence: `docs/development/phase3a-quality-benchmark/` (synthetic corpus; indicative harness figures).
- Tier 1 block size: **1000 ms**.
- Bandwidth estimator: the **long-term-spectrum edge** (the median roll-off is rejected).
- SNR estimator: the **VAD-split** method (WADA-SNR is not used). Its known low bias, largest for English and at
  20 dB, is documented with the estimate.
- `fragmented_speech` is kept, computed with the ADR-0038 settings.

## Amendment (user decision, 2026-11-26): as-built execution and contract version

Found by the Phase 3A architecture-conformance review; the user accepted both as built.

1. **Where `measure` runs.** The preprocessing-side measurement coordinator (`apps/orchestrator/src/processing/measure.ts`)
   runs the `measure` task inside the A1 job, *before* the A1 node, instead of as a separate `audio-measure` step
   job after preprocessing. Measurement sets stay preprocessing-scoped (one per version and measure config hash) and
   are reused by every run. The A1 node only reads. The speech series is written by the orchestrator.
2. **Contract version.** The audio-service contract version stays `'2'`: `measure` is an additive task type. An older
   service rejects only `measure`; the set is then recorded `failed`, and A1 falls back to Tier 0 with low
   confidence. The "version is bumped" consequence above is superseded by this amendment.
