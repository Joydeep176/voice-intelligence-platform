# Phase 3A M0: A1 Tier 1 feasibility benchmark (synthetic corpus)

**Status: complete (2026-11-26).**

- **Authority:** the user authorised D-3A-00 on 2026-11-26.
- **What these figures are:** indicative only. They come from a benchmark *harness* that runs the candidate algorithms
  with the production image's pinned libraries. They do **not** come from the production `measure` task, which does
  not exist yet.
  - There is no task API, sandbox (Landlock, rlimits), deadline or concurrent service process.
  - M4 must repeat cost, memory and sandbox validation on the implemented task. **None of this is AC-10 acceptance
    evidence.**
- **Synthetic only:** macOS TTS speech and NumPy noise (Phase 2B VAD corpus). **These numbers are not real-world
  accuracy.**

Files:
- `results.json`: every aggregate;
- `results-tables.md`: generated tables;
- code: `services/audio/benchmarks/quality/` (`run.py`, `qbench/`, `test_estimators.py`).

The per-mixture outputs were kept in the session scratchpad, not in git. They are regenerable with the commands below.

## Method

The methodology is `docs/development/phase3a/A1_ALGORITHMS_AND_EVALUATION.md` §6.1.

- **Ground truth:** the known mixing SNR.
  - All 435 mixtures in `.local-benchmarks/vad-corpus/` were checked against `corpus-manifest.json` (WAV and reference
    SHA-256).
  - Each mixture was **regenerated** from its stored utterances and manifest seeds with the corpus's own generator,
    and compared with the stored WAV sample for sample.
  - The achieved active-speech SNR was then computed from the true components (scaled clean, and stored mixture minus
    scaled clean, which includes quantisation).
- **Speech split:** the audio service's own `SileroDetector` and `pad_and_merge` with the ADR-0038 settings (threshold
  0.4, silence 300 ms, speech 250 ms, padding 200 ms).
  - Speech frames are the raw Silero spans.
  - Noise frames are the frames outside the padded spans (a guard band).
- **Estimators:**
  - VAD-split SNR (primary): 10 log10((Ps − Pn) / Pn).
  - WADA-SNR (secondary baseline, never ground truth): its lookup table was re-derived by seeded Monte Carlo from the
    paper's model (gamma 0.4 speech plus Gaussian noise).
  - No estimator parameter was tuned. The dev split is included in the outputs but not used for tuning.
- **Bandwidth:**
  - Test mixtures, clean and white at 20 dB (12 each), were brick-wall low-passed at 7000 / 5500 / 4000 / 3400 Hz or
    left full band, then requantised.
  - The candidates were the long-term-spectrum edge (−50 dB from the maximum above 300 Hz) and the median 99 % / 95 %
    roll-off.
- **Fragmentation:** the 2C dense clip (13 utterances, 0.45 s gaps) and fragmented clip (16 × 1 s, 0.8 s gaps) were
  **reconstructed** from their recorded utterance IDs. The original clip files were not kept. Spans were counted per
  30 s transcription window with a 1 s overlap.
- **Block size:**
  - Per-block SNR (block speech power minus a local noise power, or the file noise power when the block has under 20 %
    non-speech) was compared with the per-block reference SNR from the true components.
  - The set was test mixtures with white, pink, am_pink or music noise at 20 / 10 / 5 dB (144 mixtures).
- **Determinism:** the full analysis ran twice on 12 test mixtures, and the digests were compared.
- **Cost:** a streaming two-pass harness (VAD plus 10 ms frame power, then the long-term spectrum and a 1 s block SNR
  series) ran on the 60.8 min and 120.0 min long files.
  - Container limits: `--cpus 2 --memory 768m`, read-only, no network, `cap-drop ALL`.
  - Anonymous memory was sampled every 50 ms from the container cgroup.

## Results (test split)

| Check | Result |
| --- | --- |
| Corpus verification | 435 / 435 hashes match; 435 / 435 regenerate sample-exact; 435 / 435 reference masks exact; achieved minus target SNR at most 0.0009 dB (420 noisy mixtures). **No reference value was missing or unverifiable** |
| **VAD-split SNR**, MAE / bias | **1.47 / −1.16 dB** overall (336). By language: English 2.99 / −2.65, Hindi 0.68 / −0.37, Hinglish 0.75 / −0.46. By level: 20 dB 3.05 / −2.91, 10 dB 1.10 / −0.88, 5 dB 0.79 / −0.48, 0 dB 0.95 / −0.36. Worst cell: am_pink at 20 dB, 3.94 / −3.85. No estimate unavailable |
| WADA-SNR (baseline), MAE / bias | 12.85 / +7.73 dB overall. Usable only on stationary broadband noise (white 2.24, pink 2.21, music 2.58). It fails on clicks (+60.6), hum (−7.1), brown (−4.7) and am_pink (+7.2). It saturates at its 100 dB table ceiling on clean speech |
| Clean (no numeric label) | Median VAD-split 51.8 dB, against a median computed reference of 52.2 dB |
| Speech ratio | MAE 5.54 percentage points, bias +1.45 (frame precision 0.919, recall 0.948). English is under-detected (−5.44 pp, recall 0.854); Hindi and Hinglish are over-detected (+4.0 / +5.8 pp) |
| Bandwidth | **The LTAS edge tracks every cutoff within one or two FFT bins** (MAE ≤ 49.5 Hz). It has a slight upward bias from Hann leakage. The 99 % / 95 % roll-off does **not** track band limits, because speech energy lies below about 2.3 kHz, so it is rejected |
| Fragmentation | Reconstructions give 2 spans (dense) and 14 spans (fragmented) per window, identical to the spans the 2C transcription runs recorded |
| Block size | 1000 ms: MAE 2.48 dB, coverage 0.932, 14,400 entries for 4 h. 500 ms: MAE 2.81 dB, coverage 0.925, 28,800 entries. **1000 ms is better on both** |
| Determinism | 12 / 12 identical. Production Silero runs with `num_threads = 1` (`SileroDetector`), so the ADR-0041 two-thread setting does not affect the VAD |
| Harness cost (indicative) | RTF 0.0117 (60 min) and 0.0116 (120 min) at 2 CPUs. Anonymous peak 68.7 MiB and 78.4 MiB; within each file, first-third against last-third is 66.8 → 68.7 and 71.4 → 78.4 MiB. Max RSS 117 MiB. cgroup `memory.peak` 413 MiB, which includes the page cache of the 230 MB file read |

## Conclusions for the Phase 3A design (indicative; for the user's review)

1. **The VAD-split SNR is viable as the primary Tier 1 SNR estimate.**
   - On this corpus it is within about 1.5 dB on average and biased low.
   - Its error is largest at high SNR (20 dB), where it matters least for flagging.
   - The banded-output fallback (ADR-0045) is not needed on this evidence.
   - **The English bias** (−2.65 dB) follows from English under-detection (recall 0.854). It should be recorded as a
     known estimator bias.
2. **WADA-SNR is not suitable as an A1 estimator.** It breaks on non-Gaussian and low-frequency noise. It is kept only
   as the documented baseline.
3. **Bandwidth:** use the LTAS-edge estimator; drop roll-off.
4. **Block size:** 1000 ms.
5. **`fragmented_speech`** (D-3A-07, candidate) is technically sound. The service's own VAD path reproduces the
   recorded transcription span counts exactly.
6. **Cost:**
   - Extrapolating linearly, about 2.8 min for a 4 h recording at 2 CPUs. This is **not measured**: no 4 h file was
     run.
   - Memory grows slowly with duration, because per-10 ms frame arrays are retained (about 10 MiB per extra hour in
     this harness). The production task should stream block aggregates rather than keep whole-file frame arrays. M4
     must show no material growth on a generated 4 h file.
7. **Speech-ratio error** of about 5–6 pp is acceptable for a `low_speech_presence` flag. It is not fine-grained.

## Reproduce

Run from the repository root. This needs the built `vip-audio-service` image, the `vip_audio-models` volume and the
local Phase 2B corpus. Nothing is downloaded.

```
docker run --rm --network none --cpus 2 --memory 768m --memory-swap 768m --read-only --tmpfs /tmp:size=16m \
  --cap-drop ALL --security-opt no-new-privileges:true -e OMP_NUM_THREADS=2 \
  -e PYTHONPATH=/bench/quality:/bench/vad -e QB_CORPUS=/corpus -e QB_OUT=/out -e QB_E2E_IDS=/e2e \
  -v vip_audio-models:/models:ro -v "$PWD/services/audio/benchmarks":/bench:ro \
  -v "$PWD/.local-benchmarks/vad-corpus":/corpus:ro \
  -v "$PWD/docs/development/phase2c-provider-validation/e2e-real-providers-2026-11-25":/e2e:ro \
  -v "$OUT":/out --entrypoint python vip-audio-service:latest /bench/quality/run.py <step>
# steps: estimate | bandwidth | fragmentation | determinism | cost   (run cost alone, on an idle host)
uv run --directory services/audio python benchmarks/quality/run.py report "$OUT" docs/development/phase3a-quality-benchmark
uv run --directory services/audio pytest benchmarks/quality      # estimator self-tests (6)
```

The harness is not in `services/audio/src` and is not copied into the runtime image.

## M4: the implemented `measure` task in the production image (acceptance-grade, 2026-11-26)

These figures come from the implemented `measure` task, not from the M0 harness. Driver:
`services/audio/benchmarks/quality/task-check.mjs`. Result: `m4-task-check.json` (numbers only).

**Setup**
- **Image:** the runtime image built from this tree (`vip-audio-service:phase3a`).
- **Container:** a throwaway container at the production limits (2 CPUs, 768 MB, `--memory-swap 768m`, pids 64,
  read-only, tmpfs `/tmp`, `cap-drop ALL`, `no-new-privileges`, `AUDIO_SERVICE_LANDLOCK=required`).
- **Models:** the existing pinned `vip_audio-models` volume, read-only. Nothing was downloaded.
- **Path:** each case ran preprocess, then `measure`, through the real task API, sandboxed inference child and
  Landlock.

| Case (synthetic) | Audio | Measure wall time | RTF | Peak anon (service + task) | Liveness failures | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| White noise at 10 dB (English scene) | 81.9 s | 1.78 s | 0.0217 | 113.9 MiB | 0 / 4 | SNR estimate 7.95 dB against a known 10 dB; a repeat run gave a byte-identical result |
| Clean | 81.9 s | 1.77 s | 0.0216 | 114.4 MiB | 0 / 4 | SNR estimate 50.9 dB |
| 120 min long file | 7,202 s | 92.1 s | 0.0128 | 131.4 MiB | 0 / 158 | 7,203 one-second blocks |
| **Generated 4 h** (long-120 twice, capped at 4 h − 1 s) | 14,399 s | **170.1 s** | **0.0118** | **139.9 MiB** | 0 / 308 | A cancellation 3 s into a second run ended `cancelled` within 4 s |

- **Capabilities:** `taskTypes` includes `measure`; Landlock is enforced.
- **Container memory:** no OOM kill. The cgroup `memory.peak` reached the 768 MiB limit. That figure includes the
  page cache of the files read and written (the 4 h preprocess handles about 460 MB of canonical audio). Anonymous
  memory peaked at 139.9 MiB.
- **Memory growth:** anonymous memory grows slightly with duration (114 → 140 MiB from 82 s to 4 h). This comes from
  the per-10 ms frame arrays (float32). It is bounded, and far below the cap.
- **Determinism:** a repeat run on the same audio was byte-identical (AC-4, measurement side).
- **Container test suite:** 973 passed, 12 skipped (previously 960 passed). The Docker-driven Compose hardening suite
  passed 9 / 9: limits are unchanged (768 MB / 2 CPUs).

## M6: calibration evidence for the threshold decision (USER GATE, OD-52; synthetic only)

`m6-calibration.mjs` runs the **real A1 engine** (orchestrator build) with the **provisional** rule config
(`a1-rules-0.1-provisional`) over the M0 speech-aware estimates of the 348 test mixtures. The known mixing SNR is the
ground truth. Tier 0 inputs are neutral, so only the noise and speech-presence rules decide. The result is in
`m6-calibration.json`.

| Known SNR | `good` | `acceptable_with_warnings` | `poor` | Noise flag (none / low / medium / high) |
| --- | --- | --- | --- | --- |
| clean (12) | 12 | 0 | 0 | 9 / 3 / 0 / 0 |
| 20 dB (84) | 75 | 9 | 0 | 13 / 62 / 9 / 0 |
| 10 dB (84) | 16 | 68 | 0 | 0 / 16 / 68 / 0 |
| 5 dB (84) | 0 | 17 | 67 | 0 / 0 / 17 / 67 |
| 0 dB (84) | 0 | 0 | 84 | 0 / 0 / 0 / 84 |

**Observations**
- **Monotonic:** a lower SNR never gave a better class, overall or per noise type.
- **20 dB:** English is classed `acceptable_with_warnings` more often (9 of 28) than Hindi and Hinglish (0 of 28).
  This follows from the estimator's English bias (−2.65 dB, M0). The many low-severity noise flags at 20 dB come
  from the −2.9 dB bias at that level.
- **Brown noise** at 10 dB is under-flagged: 8 of 12 classed `good`.
- **Downstream anchor:** E7 production STT WER (English) is 6.7 % clean, 7.5 % at 20 dB, 12.6 % at 10 dB and 15.4 % at
  5 dB (ADR-0036). The provisional bands put 10 dB at "warn" and 5 dB at "poor", in line with that rise. On this
  corpus, Hindi and Hinglish WER barely move with SNR.

**Proposal for the user's decision (OD-52). Not applied.**
1. **SNR bands:** keep 10 / 5 dB for medium / high. For the low band, either keep 20 dB (more low-severity flags,
   no class change) or lower it to 17 dB to offset the measured estimator bias.
2. **Clean false noise-flag rate:** 3 of 12 low-severity (0 medium or high). It is acceptable as low-only.
3. **Coverage share for `poor`:** keep 0.2 (no direct evidence; it needs real-speech data).
4. **Numeric acceptance values P / R / X / Y / Z** (AC-5, AC-6, AC-8, AC-9, AC-10): not proposed from this evidence
   alone. The evidence covers the noise and speech rules only; clipping, low level, bandwidth and dropout sweeps with
   STT are not run. They stay **open** until the user decides whether to run the full M6 STT sweeps (several hours,
   local, free) or to accept on this basis.

Until the user decides, every assessment carries `provisional: true`, and the UI labels it.

## M6 (continued): degradation detection and the SNR estimator on clean speech

**Detection on the labelled degradation corpus** (`m6-detection.json`)
- **Corpus:** `services/audio/benchmarks/quality/m6_corpus.py`. The 12 clean test scenes × 8 conditions = 96 clips:
  clean; clipping ×4 and ×12; level −30 and −45 dB; low-pass 5.5 and 3.4 kHz; five 300 ms dropouts.
- **Path:** each clip went through the **real** preprocess and `measure` tasks (production image, 2 CPUs / 768 MB),
  then the **real** A1 engine with the provisional rules.

| Flag kind | Precision / recall (any severity) | Recall (medium or higher) | False flags on other conditions |
| --- | --- | --- | --- |
| Clipping | 1.00 / 1.00 | 1.00 | 0 |
| Low level | 1.00 / 1.00 | 0.50 (−30 dB is flagged low only) | 0 |
| Narrowband | 1.00 / 1.00 | 0.50 (5.5 kHz is flagged low only) | 0 |
| Dropout | 1.00 / 1.00 | 0.00 (by design: digital-zero dropouts are low severity) | 0 |

**Classes per condition**
- clean: 11 `good`, 1 `acceptable_with_warnings`;
- clipping: `poor` 24 / 24;
- −45 dB: `poor` 12 / 12;
- −30 dB: 10 `good`, 1 `acceptable_with_warnings`, 1 `poor`;
- 3.4 kHz: 11 `acceptable_with_warnings`, 1 `poor`;
- 5.5 kHz: 10 `good`, 2 `acceptable_with_warnings`;
- dropouts: 11 `good`, 1 `acceptable_with_warnings`.

**Finding: false noise flags on some clean English speech.** One clean English scene (test s1) measures an SNR of
13.5 dB instead of about 52 dB, which produces high-severity noise regions; the same happens in its derived
conditions. The cause is speech that the VAD misses (English recall 0.854, M0) leaking into the "noise" frames.
The mean of the noise-frame power is very sensitive to that leak when the true noise is tiny.

**Robust variants, evaluated against the known mixing SNR** (M0 harness rerun; test split; MAE / bias dB)

| Estimator | Noisy, all (336) | 20 dB | 0 dB | Clicks | am_pink | Clean minimum |
| --- | --- | --- | --- | --- | --- | --- |
| Mean of noise frames (current) | **1.47 / −1.16** | 3.05 / −2.91 | 0.95 / −0.36 | 1.91 | 1.91 | **13.5 dB** |
| Median of noise frames | 4.66 / +4.11 | 4.08 / +3.64 | 5.57 / +4.82 | 21.59 | 2.61 | 49.9 dB |
| 20th percentile | 7.73 / +7.73 | 6.96 | 8.98 | 22.07 | 11.86 | 50.4 dB |

**No variant wins outright.** The mean is the most accurate on noisy speech but can falsely flag clean speech; the
percentiles fix clean speech but over-estimate non-stationary noise. **Options for the user's decision:**
- (a) keep the mean and accept rare false noise flags on clean speech;
- (b) switch to the median;
- (c) a hybrid (for example the median when it indicates near-clean audio, else the mean), with its rule chosen on
  the **dev** split only and then re-scored on test.

No estimator change is applied.

## M6 (continued): production STT error per degradation (the E7 method; `m6-stt.json`)

**What was run**
- **Script:** `services/audio/benchmarks/quality/m6_stt.py`, run inside the production image (2 CPUs / 768 MB, no
  network).
- **Path:** the service's own transcription path:
  - 30 s windows with 1 s overlap;
  - Silero spans with the ADR-0038 settings;
  - whisper.cpp small q5_1 with 2 threads (ADR-0036).
- **Clips:** scene 0 of each language × 8 conditions = 24 clips, about 6 min each.
- **Metrics:** WER and CER against the reference sentences (C3 normaliser). Only numbers are kept.

**Limitations**
- **One scene per language:** a difference of a few points is within run-to-run variation between scenes.
- **Hinglish:** the absolute WER (77 % clean) is dominated by the script mismatch between the reference and the
  output. Only the change from clean means anything.

| Condition | A1 class (provisional rules) | English WER (Δ pp) | Hindi WER (Δ pp) | Hinglish WER (Δ pp) |
| --- | --- | --- | --- | --- |
| clean | good | 6.5 | 38.2 | 77.2 |
| clipping ×4 (2.3–4.2 % clipped) | poor | 10.3 (+3.9) | 43.1 (+4.9) | 80.3 (+3.1) |
| clipping ×12 (15–23 % clipped) | poor | 12.3 (+5.8) | 61.8 (+23.6) | 82.7 (+5.5) |
| −30 dB (speech ≈ −48 dBFS) | good | 14.2 (+7.7) | 44.7 (+6.5) | 81.1 (+3.9) |
| −45 dB (speech ≈ −63 dBFS) | poor | 21.3 (+14.8) | 51.2 (+13.0) | 89.8 (+12.6) |
| low-pass 5.5 kHz | good | 7.7 (+1.3) | 46.3 (+8.1) | 81.1 (+3.9) |
| low-pass 3.4 kHz | acceptable_with_warnings | 14.8 (+8.4) | 43.9 (+5.7) | 78.7 (+1.6) |
| 5 × 300 ms dropouts | good | 14.2 (+7.7) | 44.7 (+6.5) | 78.7 (+1.6) |

For comparison, E7 English additive noise gave +0.8 pp at 20 dB, +5.9 at 10 dB and +8.7 at 5 dB. The provisional
bands treat those levels as low / medium / high severity.

**Rank agreement between the A1 class and WER** (AC-9; Spearman, 8 conditions per language, scene 0)

| Rules | English | Hindi | Hinglish |
| --- | --- | --- | --- |
| Provisional `a1-rules-0.1` | 0.34 | 0.32 | 0.52 |
| Proposed bands, dropout kept at low severity (simulated class mapping) | 0.57 | 0.53 | 0.73 |
| Proposed bands, dropout raised to medium (simulated) | 0.70 | 0.62 | 0.66 |

**What the provisional rules get wrong, against the STT evidence**
- **Clipping ×4 is classed `poor`,** although it costs about as much accuracy as 10 dB noise (`warn`). The high band
  (1 % clipped samples) sits below the moderate condition (2.3–4.2 %).
- **−30 dB is classed `good`,** although it costs about as much as 5–10 dB noise. Speech at −48 dBFS falls just
  above the medium band (−50 dBFS).
- **Dropouts are classed `good`,** although five 300 ms gaps cost +6.5 to +7.7 pp in English and Hindi. This is
  low severity by design: digital-zero runs also occur in edited or synthetic audio.
- **3.4 kHz bandwidth is in line with the evidence** (`warn`). 5.5 kHz is in line for English. The Hindi +8.1 pp is
  a single clip.

## M6 decision (OD-52, ADR-0048) and re-run with the approved rules (`m6-detection-v1.json`)

**What the user decided (2026-11-26)**
- **SNR estimator:** the hybrid. Near-clean audio uses the median noise-frame power, with the switch at 45 dB chosen
  on the M0 dev split. On the dev split:
  - noisy mixtures have a median-based estimate of at most 40.5 dB;
  - clean mixtures have at least 50.6 dB.
- **Clipping:** the high band moves to 5 %.
- **Speech level:** the medium band moves to −45 dBFS.
- **Dropout:** stays at low severity.
- **Acceptance targets:** P = R = 0.9; X = 90 % with no high flag on clean speech; Y = 2.0 dB; Z = 0.05.

**SNR estimator, scored on the test split** (the M0 per-mixture estimates; MAE / bias dB)

| | Noisy, all (336) | 20 dB | 10 dB | 5 dB | 0 dB | Clean minimum |
| --- | --- | --- | --- | --- | --- | --- |
| Mean (before) | 1.47 / −1.16 | 3.05 / −2.91 | 1.10 / −0.88 | 0.79 / −0.48 | 0.95 / −0.36 | 13.5 dB |
| Hybrid, 45 dB switch | 1.47 / −1.16 (no noisy mixture switches) | 3.05 | 1.10 | 0.79 | 0.95 | **49.9 dB** |

**Re-run setup:** the same 96 clips, the real preprocess and `measure` tasks (rebuilt production image, 2 CPUs /
768 MB), and the real engine with `a1-rules-1.0`.

**Class per condition (12 clips each)**

| Condition | Class |
| --- | --- |
| clean | 12 `good` |
| ×4 clipping | 12 `acceptable_with_warnings` |
| ×12 clipping | 12 `poor` |
| −30 dB | 12 `acceptable_with_warnings` |
| −45 dB | 12 `poor` |
| 5.5 kHz | 12 `good` (flagged low) |
| 3.4 kHz | 12 `acceptable_with_warnings` |
| dropouts | 12 `good` (flagged low) |

**Detection**
- **Clean speech:** the clean minimum SNR is now 49.9 dB on the real tasks, and no clean clip has a high-severity
  flag. Two clean Hindi clips carry one low flag each (fragmented speech, silence).
- **Per language:** precision and recall are 1.00 at any severity for every degradation kind (clipping, low level,
  narrowband, dropout).
- **Medium or higher:** recall is 1.00 for clipping and low level, 0.50 for narrowband (5.5 kHz is low by design),
  and 0.00 for dropout (low by decision).

**Rank agreement with production WER (AC-9).** Spearman between the class and WER on scene 0:

| English | Hindi | Hinglish |
| --- | --- | --- |
| 0.57 | 0.53 | 0.73 |

These were 0.34, 0.32 and 0.52 with the provisional rules.

**AC-8 status.**
- The MAE at 20 dB (3.05 dB) is above Y = 2.0 dB.
- The user kept the target and accepted AC-8 as partially met for Phase 3A.
- This is a known limitation, with follow-up OD-55.

## M8: final regression of the `measure` task (`m8-task-check.json`)

**Setup:** the same harness as M4, run on the final code (hybrid estimator, bounded Tier 1 contracts), with the
production image at 2 CPUs / 768 MB, Landlock required and a read-only root.

| Case | Audio | Wall time | RTF | Anonymous peak |
| --- | --- | --- | --- | --- |
| clean | 82 s | 1.8 s | 0.022 | 113 MiB |
| 120 min | 7202 s | 87.5 s | 0.012 | 128 MiB |
| generated 4 h | 14,399 s | 170.6 s | **0.0118** | 141.9 MiB |

- **Health:** no OOM and no liveness failures.
- **Cancellation:** a cancel of the 4 h task completed in 4.0 s.
- **Determinism:** the repeated task gave a byte-identical result.
- **Clean SNR:** 50.9 dB (hybrid switch).
