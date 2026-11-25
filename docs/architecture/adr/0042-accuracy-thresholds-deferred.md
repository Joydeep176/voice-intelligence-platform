# ADR-0042: Transcription and diarization accuracy thresholds: proposed deferral

- Status: **Proposed, awaiting the user's decision.** No decision has been made. NFR-3 / NFR-4 remain "TBD" in the SRS
  until the user decides. Corrected 2026-11-26: an earlier version wrongly recorded this as an accepted user decision
- Date: 2026-11-26
- Addresses: SRS NFR-3 (transcription accuracy, WER/CER per language) and NFR-4 (diarization accuracy, DER), both
  previously "TBD, from benchmark" (ADR-0012)
- Affects: `docs/SRS.md` §4, ADR-0036, ADR-0037, `docs/development/PHASE2B_2C_REQUIREMENT_EVIDENCE_MATRIX.md`,
  `PHASE2B_2C_FINAL_ACCEPTANCE_REPORT.md`, `PROJECT_STATUS.md`

## Context

- **What the SRS left open:** NFR-3 and NFR-4 were to take their thresholds from the provider benchmark.
- **What exists:**
  - C3 compared candidates on a synthetic TTS corpus (`docs/development/phase2c-stt-benchmark/`).
  - E7 measured the selected production STT path.
  - The windowed diarization evaluations measured DER.
- **What was never decided:** no threshold. The Phase 2B/2C acceptance report could therefore not state pass or fail
  for accuracy.
- **Why a threshold now would be weak:** the corpus is synthetic only. A real-speech benchmark (OD-18 corpus) is still
  follow-up work. A threshold set now would be anchored to synthetic speech.

## Options considered

1. **Set thresholds now from the synthetic results:** possible, but they could mislead on real speech.
2. **Defer the thresholds, keep the measurements, and mark accuracy "Deferred", not passed.**

## Proposal (not decided)

**Proposed: Option 2.** The user has not decided between Option 1, Option 2 or another approach.

- Until the user decides, NFR-3 and NFR-4 have **no threshold**. They are **not** marked passed and **not** marked
  deferred: the requirement-to-evidence matrix shows them as **Awaiting the user's decision**.
- All current measurements are preserved unchanged as the baseline for whichever decision is made.

**Baseline preserved** (synthetic corpus only; percent).

**STT, production path** (E7, the full-context variant; 240 C3 test clips; WER / CER).

| Language | clean | 20 dB | 10 dB | 5 dB | all |
| --- | --- | --- | --- | --- | --- |
| English | 6.7 / 4.7 | 7.5 / 4.8 | 12.6 / 7.7 | 15.4 / 11.9 | 10.5 / 7.3 |
| Hindi | 46.9 / 23.9 | 48.8 / 22.6 | 47.8 / 23.2 | 51.2 / 24.7 | 48.7 / 23.6 |
| Hinglish | 81.2 / 82.5 | 83.6 / 82.2 | 84.5 / 81.6 | 87.0 / 85.6 | 84.1 / 83.0 |

- **STT language ID:** English `en` 77/80 (3 without speech), Hindi `hi` 80/80, Hinglish `hi` 78 / `en` 2.
- **Diarization DER** (CAM++, 250 ms collar):
  - dev-tuned threshold, 2 / 3 / 4 speakers: 14.7 / 21.4 / 6.1;
  - oracle speaker count: 3.1 / 2.8 / 3.1;
  - production windowing on 10 min files: 17.4 / 10.4 / 7.0;
  - 60 min file: 7.7.
- **Sources:**
  - `docs/development/phase2c-provider-validation/stt-speed-2026-11-24/e7-audio-ctx-accuracy-2026-11-25.log`;
  - `docs/development/phase2c-stt-benchmark/results-tables.md`;
  - `docs/development/phase2c-provider-validation/windowed-*.json`.

## Consequences (if the proposal is accepted)

- The SRS rows for NFR-3 and NFR-4 would change from "TBD" to "Deferred (user decision, ADR-0042)". Until then they
  stay "TBD".
- Phase acceptance would not depend on an accuracy threshold; accepting 2B/2C would accept the measured baseline as is.
- **Follow-up:** set the thresholds after a real-speech benchmark (OD-18 corpus), through `record-architecture-decision`.
- If the user chooses Option 1 instead, thresholds are set now from the baseline above and the matrix rows are scored
  against them.
