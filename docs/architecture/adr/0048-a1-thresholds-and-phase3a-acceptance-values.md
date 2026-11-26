# ADR-0048: A1 thresholds, SNR estimator and Phase 3A numeric acceptance values

- Status: Accepted (user decision, 2026-11-26)
- Date: 2026-11-26
- Resolves: OD-52 (HLD §10)
- Affects:
  - `apps/orchestrator/src/agents/audio-quality/rule-config.ts` (`a1-rules-1.0`);
  - the `measure` task: `services/audio/.../domain/measure.py`, `AudioMeasureConfig` / `MeasureConfig`
    (`snrNearCleanDb`), `apps/orchestrator/src/processing/measure.ts`;
  - `A1_REQUIREMENTS_AND_SPEC.md` §6 (AC-5 to AC-10);
  - the evidence matrix;
  - `phase3a-quality-benchmark/README.md`.

## Context

- **Provisional state:** ADR-0043 shipped A1 with provisional thresholds (`a1-rules-0.1-provisional`). The numeric
  targets P, R, X, Y and Z were left to the user (E + U), to be set from Phase 3A M6 evidence.
- **The user's choice:** run the full M6 sweeps before deciding.
- **Evidence:** all synthetic (macOS TTS, NumPy noise); it is **not real-world accuracy** (D-3A-13). It is in
  `docs/development/phase3a-quality-benchmark/`:
  - **M0:** the SNR estimator against the known mixing SNR.
  - **M6 calibration:** the noise rule across SNR levels.
  - **M6 detection:** 96 degradation clips through the real preprocess and `measure` tasks and the real engine.
  - **M6 STT:** production whisper.cpp WER and CER on 24 of those clips.
- **What the evidence showed:**
  1. **Leak on clean speech:** on near-clean audio, speech that the VAD misses leaks into the noise frames. This
     drags the mean-based SNR down: one clean English scene measured 13.5 dB instead of about 52 dB and got
     high-severity noise flags, so AC-6 was not met.
  2. **Moderate clipping:** ×4 clipping (2.3–4.2 % of samples clipped) cost +3 to +5 WER points, about the cost of
     10 dB noise, yet it was classed `poor`.
  3. **Quiet speech:** −30 dB attenuation (speech near −48 dBFS) cost +4 to +8 points, yet it was classed `good`.
  4. **Dropouts:** five 300 ms digital-zero dropouts cost +6.5 to +7.7 points in English and Hindi, at low severity.

## Options considered

**SNR estimator.** Options (a)–(c) below; MAE is measured on the M0 test split.
1. **(a) Mean of noise-frame power (as built).**
   - Most accurate on noisy speech: MAE 1.47 dB.
   - Falsely flags some clean speech.
2. **(b) Median.**
   - Fixes clean speech.
   - MAE 4.66 dB, and +21.6 dB on clicks.
3. **(c) Hybrid.**
   - Use the median when it indicates near-clean audio, otherwise the mean.
   - The switch point is chosen on the dev split only.

**Bands.** Either keep the provisional values, or apply the STT-anchored changes. Optionally, also lower the SNR low
band to 17 dB.

**Dropout severity.** Either keep it low, or raise it to medium when 3 or more digital-zero gaps fall in speech
blocks.

**Targets.** Either the proposed values, or stricter ones.

## Decision

The user's choices, 2026-11-26:

1. **SNR estimator: (c) hybrid.**
   - **Rule:** Pn is the mean noise-frame power. When the median noise-frame power gives an SNR of at least
     `snrNearCleanDb` = **45 dB**, the median is used instead, for the recording and for every block.
   - **Switch point:** chosen on the M0 **dev** split. Dev noisy mixtures have a median-based estimate of at most
     40.5 dB; dev clean mixtures have at least 50.6 dB; 45 dB is the midpoint.
   - **Re-scored on the test split:**
     - no noisy mixture switches, so noisy MAE stays 1.47 dB with bias −1.16 dB;
     - the minimum estimate on clean speech rises from 13.5 to 49.9 dB.
   - **Config:** the threshold is a new measure-config field, so a changed value yields a new measurement set (the
     config hash changes).
2. **Bands (`a1-rules-1.0`, `provisional: false`):**

   | Rule | Before | After |
   | --- | --- | --- |
   | Clipping ratio, high band | 0.01 | **0.05** |
   | Active speech level, medium band | −50 dBFS | **−45 dBFS** |

   Everything else is unchanged:
   - SNR 20 / 10 / 5 dB;
   - bandwidth 6000 / 3800 Hz;
   - clipping low / medium 0.00001 / 0.001;
   - speech level low / high −40 / −60 dBFS;
   - silence, loudness, noise floor, speech presence, level spread and spans per window;
   - poor coverage 0.2.

   The bands without a direct anchor need real-speech data (D-3A-13).
3. **Dropout:** digital-zero dropouts stay **low** severity.
   - The evidence is one clip per language.
   - Digital-zero runs also occur in edited or synthetic audio.
4. **Acceptance values** (synthetic corpus only):

   | Value | Criterion | Target |
   | --- | --- | --- |
   | P | AC-5 precision, per flag kind, at any severity | ≥ 0.9 |
   | R | AC-5 recall, per flag kind, at any severity | ≥ 0.9 |
   | X | AC-6 clean clips classed `good` | ≥ 90 %, and no high-severity flag on a clean clip |
   | Y | AC-8 SNR MAE against the known mixing SNR | ≤ 2.0 dB |
   | Z | AC-10 `measure` task RTF at 2 CPUs | ≤ 0.05 |

   **AC-9** keeps its "positive rank correlation" criterion and reports the measured values.

**Recorded caveat on Y:**
- AC-8 is stated per level: 20, 10 and 5 dB.
- At 10 dB the MAE is 1.10 dB and at 5 dB it is 0.79 dB: both meet Y.
- At **20 dB it is 3.05 dB** (bias −2.91 dB), which **does not** meet Y.
- The proposal put to the user quoted only the pooled MAE (1.47 dB).
- **User decision (2026-11-26):** Y stays at **2.0 dB**; it is not relaxed to obtain a pass.
- **AC-8 is accepted as partially met for Phase 3A.** The 20 dB estimator bias is recorded as a known limitation.
- **Follow-up:** OD-55 (Open) covers correcting the bias and evaluating the correction.

## Consequences

- **Old assessments:** assessments made with `a1-rules-0.1-provisional` keep that version and `provisional: true`;
  they are never rewritten. New assessments use `a1-rules-1.0`, and the UI no longer shows the provisional label for
  them.
- **Contract change:** the `measure` task config gains a required `snrNearCleanDb`. The orchestrator and the audio
  service must be deployed together. An audio service without the field rejects the config; the measure step then
  fails and A1 falls back to Tier 0 (ADR-0045), so transcription is unaffected.
- **Synthetic only:** the values are synthetic-corpus targets. Real-speech evaluation (D-3A-13) may require a new
  rule version; any change goes through a new ADR.
- **Follow-up:** the M6 detection is re-run with `a1-rules-1.0` and the hybrid estimator, and the evidence matrix is
  re-scored against these targets.
