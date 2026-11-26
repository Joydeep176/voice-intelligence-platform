# Phase 3A: requirement-to-evidence matrix (A1 Audio Quality)

- **Status (2026-11-26): Phase 3A ACCEPTED by the user.** M0–M8 are complete. Thresholds and targets were decided
  by the user (OD-52, ADR-0048). Completion report: `PHASE3A_COMPLETION_REPORT.md`.
- **Acceptance does not change any row's status:** AC-8 stays **partially met**.
- **Real-world smoke test:** the product owner's successful test on a real recording is additional evidence for
  AC-1, AC-3 and AC-14 (the end-to-end path). It is not accuracy evidence for AC-5, AC-6, AC-8 or AC-9.
- **The statuses mean:**
  - **Passed:** evidence exists and meets the criterion.
  - **Awaiting decision:** the numeric target is the user's to set (E + U).
  - **Partial:** some of the criterion is evidenced, the rest is not.
  - **Not tested.**
- The criteria are AC-1 to AC-14 from `A1_REQUIREMENTS_AND_SPEC.md` §6.
- All evaluation is on synthetic data (macOS TTS, NumPy noise). **It is not real-world accuracy.**

| AC | Criterion (short) | Status | Evidence |
| --- | --- | --- | --- |
| AC-1 | Every preprocessed recording's run gets a diagnostics record; missing or failed states shown honestly | **Passed** | M8 E2E with `a1-rules-1.0` after the audio-service rebuild: 11 of 11 category clips assessed 4–10 s after preprocessing, all with Tier 1 available (`phase3a-quality-benchmark/e2e/e2e-results-v1.json`; first run: `e2e-results.json`). API states `not_started / pending / running / completed / failed / cancelled` (`apps/api/test/audio-quality.int-spec.ts`); card states (`audio-quality-card.test.tsx`). A live measurement set is kept fresh by a heartbeat, so the stuck sweep doesn't fail it (int test) |
| AC-2 | A1 reads no transcription data; no other writer of diagnostics; others read through the port only; transcription identical with or without A1 | **Passed** | `separation.spec.ts` (static check of the A1 module and repository); `createAudioQualityReader` has no write method; E2E transcript identity: 17 of 17 segments and the speaker partition identical against the Phase 2C reference run with A1 active |
| AC-3 | 2B/2C behaviour and suites unchanged | **Passed** (one approved change) | All unit and integration suites green (M8). M8 E2E with A1 active: the 2C reference transcript is identical (17 of 17 segments, same speaker partition). The processing snapshot is unchanged (DB test: Tier 1 rows excluded). **Approved change:** a `created` run can now be cancelled (ADR-0025 as amended by ADR-0044). The architecture review found such a run could then be retried; fixed: the API returns `409` and the UI offers no retry (ADR-0025: not retried), with tests |
| AC-4 | Determinism of diagnostics and measurements | **Passed** | Engine determinism test; M0: 12 of 12 identical; M4: a repeated production `measure` task gave a byte-identical result |
| AC-5 | Per-flag precision and recall on the labelled degradation set (P, R) | **Passed** (P = R = 0.9, ADR-0048) | Re-run with `a1-rules-1.0` (`m6-detection-v1.json`; 96 clips, real tasks): precision and recall 1.00 at any severity for clipping, low level, narrowband and dropout, **per language**. Noise rule: `m6-calibration.json` (noisy rows unchanged by the hybrid estimator) |
| AC-6 | Clean speech classed `good` in ≥ X %; no high flag on clean | **Passed** (X = 90 %) | Re-run: clean 12 of 12 `good`, 0 high flags (two low flags: fragmented speech, silence); clean minimum SNR 49.9 dB (was 13.5 dB before the hybrid estimator). E2E clean en / hi / Hinglish: `good` (provisional rules; not re-run) |
| AC-7 | Monotonicity along degradation sweeps | **Passed** (noise sweep) | M6: no SNR step gives a better class, overall and per noise type; engine monotonicity test |
| AC-8 | SNR proxy MAE ≤ Y dB against the known mixing SNR at 20 / 10 / 5 dB | **Partial** (Y = 2.0 dB) | M0 test split, hybrid estimator: 10 dB 1.10, 5 dB 0.79 (met); **20 dB 3.05, bias −2.91 (not met)**; pooled 1.47. Accepted as partially met by the user; Y kept at 2.0 dB; follow-up OD-55 |
| AC-9 | Positive rank correlation with E7 WER | **Passed** (report only) | Production STT on 24 clips (`m6-stt.json`). Spearman between the `a1-rules-1.0` class and WER: English 0.57, Hindi 0.53, Hinglish 0.73 (provisional rules: 0.34 / 0.32 / 0.52). Noise: 10 dB is `warn`, 5 dB is `poor` |
| AC-10 | Measure task within 768 MB, no material growth on 4 h, RTF ≤ Z | **Passed** (Z = 0.05) | M8 re-run with the final code (hybrid estimator, bounded contracts; `m8-task-check.json`): 4 h in 170.6 s (**RTF 0.0118**), anonymous peak 141.9 MiB (128 MiB at 2 h, 113 MiB at 82 s), no OOM, 0 of 307 liveness probes failed, cancellation in 4.0 s, deterministic. M4: `m4-task-check.json`. Compose hardening 9 of 9 (limits unchanged) |
| AC-11 | `insufficient` for silent, noise-only and tone-only input; short audio handled | **Passed** (tone-only not tested) | E2E: silence → `insufficient` (confidence high); noise-only → `insufficient`; engine tests: digital silence, very short audio (`not_assessable`, low confidence) |
| AC-12 | API 404 across workspaces; no content in logs; deleted with the recording | **Passed** (log capture: partial) | API int: 404 for another workspace, unknown or malformed IDs; DB int: cascade deletion of sets, Tier 1 records, diagnostics and flags; logs carry IDs and codes only (review of the code). No automated log-capture test for the A1 path |
| AC-13 | UI renders every state; axe has no serious or critical violations; diagnostics visually distinct from uncertainty | **Passed** | Web tests (card, step, timeline track, no `uncert-*` tokens; no provisional label for `a1-rules-1.0`); M8 E2E axe on 3 pages: 0 violations; UI timeline matches the API for 11 of 11 clips |
| AC-14 | Browser E2E per category on the real stack | **Passed** | M8 re-run with `a1-rules-1.0` and the rebuilt audio service: 11 categories (clean en / hi / Hinglish, noisy 5 dB en, noisy 0 dB hi, low-level, clipped, narrowband, silence, noise-only, fragmented); classes unchanged from the first run; cross-workspace API 404 for every clip; no console errors |

## Not done or open

- **AC-8 is partially met:**
  - at 20 dB the MAE is 3.05 dB against Y = 2.0 dB (estimator bias −2.9 dB);
  - the user kept Y at 2.0 dB and accepted the partial status for Phase 3A;
  - known limitation; follow-up OD-55 (Open).
- **Not implemented:**
  - processing-cancel of an active measurement set (lifecycle L8);
  - the measurement backfill endpoint;
  - the `measurementSet` field on the processing snapshot (`A1_DESIGN.md` §9).
- **Observation (resolved in M8):** the provisional rules rated the Phase 2C reference clip `poor`. With
  `a1-rules-1.0` and Tier 1 available, it is now rated `good`.
- **Known pattern:** synthetic digital-silence pauses produce low-severity "dropout" flags. These do not change the
  class.
- **Real-speech evaluation:** no systematic evaluation was done (D-3A-13). One successful real-world smoke test by
  the product owner (2026-11-26) is not an accuracy validation.
- **Lifecycle deviations** (A1_DESIGN §9 notes 4, 10, 11): accepted (ADR-0044 Amendment 2).
- **Recording deletion and derived-file cleanup:** no deletion endpoint. This is a privacy and retention follow-up
  before production.
- **`pnpm format:check`:** fails only on committed, unchanged dev-tooling files (`.agents/`, `.codex/`, `AGENTS.md`).
