# ADR-0043: Audio Quality Agent (A1) v1 method: deterministic rules over objective measurements

- Status: **Accepted** (user decision, 2026-11-26, with the M0 refinements below). First written as Proposed in the Phase 3A plan
  (2026-11-26)
- Date: 2026-11-26
- Addresses: OD-49 (new); AGENT_ARCHITECTURE §1 A1 "*Proposed*: rule-based, no LLM in v1"; plan decisions D-3A-01,
  D-3A-04 and D-3A-07
- Affects: AGENT_ARCHITECTURE §1, §3–§4; DATABASE_DESIGN (`audio_diagnostics.overall`, `audio_diagnostic_flags.kind`);
  SRS FR-3.1–FR-3.4; `packages/contracts`; `apps/orchestrator/src/agents/audio-quality` (future)

## Context

- **What the SRS requires:**
  - FR-3.1: A1 analyses objective measurements and produces its own diagnostics.
  - FR-3.3: diagnostics are never inferred from transcript confidence.
  - FR-3.4 / ADR-0008: poor audio never stops processing.
- **What exists:** Phase 2B already computes and stores objective measurements (`audio_measurements`, the 100 ms level
  series). No speech-aware measurement exists (preprocessing VAD `none`, ADR-0038).
- **Constraints:** ADR-0034 (zero spend, M1 8 GB); the audio service at 768 MB and 2 CPUs (ADR-0039 / ADR-0041).
- **Brief:** the user's Phase 3A brief asks for actionable assessments, a distinction between measured and estimated
  values, and candidate classes good / acceptable with warnings / poor / insufficient, with thresholds not invented.
- **Evidence:** `docs/development/phase3a/` (plan, algorithms and evaluation).

## Options considered

1. **Deterministic rules over objective measurements; Silero VAD (already selected, ADR-0038) only as a
   speech/non-speech instrument.** Explainable, cheap, no new dependency. It cannot assess reverberation or
   non-clipping distortion.
2. **Add a learned non-intrusive quality model** (DNSMOS, NISQA, Squim, Brouhaha). It could cover reverberation and
   perceived quality. But it brings PyTorch or a new ONNX runtime, the licences are unverified, and there is no
   evidence yet that it adds value over the proxies for STT suitability.
3. **An LLM interpreting the measurements.** Not needed for rule-shaped output, and OD-47 is Open.

## Decision

**Option 1.**

- **Rules:**
  - Ordered, pure, versioned rules (`ruleVersion`), with integer thresholds from validated configuration.
  - A config snapshot is stored with each diagnostics row.
  - The rule version is labelled *provisional* until the user approves calibrated thresholds (Phase 3A M6). No
    threshold is set by this ADR.
- **Overall classes:** `good | acceptable_with_warnings | poor | insufficient`. This **changes** the designed
  `good | degraded | poor`. `insufficient` means no usable speech, and it is still not a run failure (ADR-0008).
- **Categorical confidence** `high | medium | low`, from explicit rules. No calibrated probability is claimed.
- **Suitability** for transcription and for diarization: `suitable | limited | unreliable | not_assessable`, with
  reason codes.
- **Flag kinds:**
  - the designed six, plus `low_speech_presence`, `narrowband`, `level_inconsistency` and `fragmented_speech` (the last
    predicts the ADR-0041 dense-speech deadline risk, using the ADR-0038 VAD settings);
  - `distortion` reserved and not emitted in v1.
- **Each flag** carries a severity (`low | medium | high`), a time range or whole-recording scope, a basis (measured,
  derived or estimate) and measurement references.
- **A `notAssessed` list** names the dimensions A1 cannot assess (for example reverberation, non-clipping distortion).
  They are never reported as good.
- **Not used:** an ML quality model, an LLM, or transcription data.

## Consequences

- AGENT_ARCHITECTURE §3/§4 and DATABASE_DESIGN enums are updated, and the contracts are added in Phase 3A M1.
- Reverberation and non-clipping distortion remain undetected in v1 (a documented limitation). A learned model would
  need its own ADR (licence, dependency, M1 benchmark, evidence of value).
- Calibration and evaluation are synthetic-only (macOS TTS, NumPy noise) until a real-speech corpus is approved
  (OD-18 follow-up). Their results must not be presented as real-world accuracy.

## M0 refinements (accepted with this ADR, 2026-11-26)

Evidence: `docs/development/phase3a-quality-benchmark/` (synthetic corpus; indicative harness figures).
- Tier 1 block size: **1000 ms**.
- Bandwidth estimator: the **long-term-spectrum edge** (the median roll-off is rejected).
- SNR estimator: the **VAD-split** method (WADA-SNR is not used). Its known low bias, largest for English and at
  20 dB, is documented with the estimate.
- `fragmented_speech` is kept, computed with the ADR-0038 settings.
