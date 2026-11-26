# Phase 3A: A1 algorithms, ML evaluation, testing and benchmarking

- **Status: DRAFT FOR THE USER'S REVIEW (2026-11-26). Nothing here is approved.** No model or dataset was downloaded
  for this plan.
- Covers deliverables 8 (ML and algorithm evaluation) and 9 (testing and benchmarking strategy).

## 1. Recommended approach: deterministic signal processing with the existing VAD

The method is in ADR-0043 (Proposed).

- **A1 itself is a deterministic rule engine** over objective measurements.
- **The only learned component** is Silero VAD, which is already selected, pinned, licensed (MIT) and benchmarked
  (ADR-0038). It is used as a measurement instrument for the speech/non-speech split.
- **Why no quality model in v1:**
  1. The SRS asks for objective measurements, plus A1's own diagnostics (FR-3.1), kept separate from model confidence
     (FR-3.3). Rules over measurements are explainable flag by flag.
  2. Each available learned quality model either needs PyTorch or a new ONNX runtime path (§3), meaning new
     dependencies and image size. Or its licence must first be verified. None is necessary to detect the problems
     that most affect STT on this platform: noise, low level, clipping, dropouts and band limits.
  3. The 768 MB / 2 CPU audio service is shared with STT, which already runs close to its deadline on dense speech
     (ADR-0041). Deterministic measurement costs a few minutes on a 4 h file, against hours of transcription.
  4. The evidence that would justify a model, such as real-speech quality labels, does not exist yet (OD-18).

## 2. Algorithms per dimension

| Dimension | Algorithm | Kind | Tier | Notes and risks |
| --- | --- | --- | --- | --- |
| Clipping | Existing rail-run counter (`minRunSamples` 2) on the original decode, and the true peak (`ebur128`) | measured | 0 | Lossy codecs can clip without reaching full scale after decode: a known false-negative mode. True peak > 0 dBTP is a supporting signal |
| Clipping regions | 100 ms `peakDbfs` at or near 0 dBFS | derived | 0 | Region resolution 100 ms |
| Silence regions | 100 ms `rmsDbfs` below the configured silence level, merged | derived | 0 | Energy silence, not speech absence |
| Low level | Tier 0: integrated loudness and canonical RMS. Tier 1: active-speech level (RMS over VAD speech frames, a P.56-like proxy) | estimate | 0 / 1 | Canonical audio is not loudness-normalised (2B), so levels reflect the recording |
| Noise level | Tier 0: `noiseFloorDbfs` (10th percentile). Tier 1: RMS of the non-speech frames | estimate | 0 / 1 | Tier 0 is biased low on continuous speech |
| SNR proxy | **Primary:** active-speech level minus non-speech level (VAD split; energy of speech frames includes noise, so a power-subtraction correction is applied; as approved in ADR-0048, near-clean audio uses the median noise-frame power, with the switch at 45 dB). **Secondary baseline in M0:** WADA-SNR (waveform amplitude distribution; a published, deterministic, dependency-free algorithm). It is another estimator, not a reference | estimate | 1 | VAD errors bias it. Both estimators are scored against the known mixing SNR (§6.1); agreement between them is not evidence of accuracy |
| Speech presence | Silero speech ratio, with the ADR-0038 settings | derived | 1 | The VAD benchmark has FPR 0.057 at 10/5 dB (synthetic). Tone and music can be mis-detected: test fixtures cover them |
| Pauses and fragmentation | Span and gap length distributions; spans per 30 s window on the transcription grid | derived | 1 | `fragmented_speech` predicts the ADR-0041 deadline risk. Candidate only (D-3A-07) |
| Bandwidth | Per-speech-frame rFFT, the frequency below which 95–99 % of energy lies (roll-off), median over speech frames | estimate | 1 | The canonical signal is 16 kHz, so only limits below 8 kHz are detectable. Codec pre-echo is not detected |
| Dropouts | Timeline gaps and decode errors (existing); digital-zero runs ≥ N ms bordered by non-silent audio | measured | 0 / 1 | Mid-file silence inserted by an encoder is indistinguishable from real silence unless it is digitally zero |
| Level consistency | Inter-quartile spread of the per-block active-speech level | estimate | 1 | Natural speaker differences also raise it, so it is only `low` severity unless the spread is extreme |
| Channel problems | `correlationCh*`, `dcOffset`, per-channel RMS imbalance | measured | 0 | Multichannel input only. Canonical is a mono downmix, so antiphase channels cancel and A1 should warn |
| Distortion (non-clipping), reverberation, echo | **Not assessed in v1** | — | — | Reported as `notAssessed` with a reason, never as "good" |
| Overlapping speech, language | **Out of A1's scope** | — | — | A2 owns them |

**Combination and verdict:** see `A1_REQUIREMENTS_AND_SPEC.md` §4.5. Severity cut-points and coverage shares are
configuration, calibrated in M6 (§4).

## 3. Candidate ML models considered (none downloaded; licences to verify before any adoption)

| Candidate | What it gives | Runtime and dependency on this platform | Licence | Verdict for v1 |
| --- | --- | --- | --- | --- |
| Silero VAD v6.2.3 (existing) | Speech/non-speech | Already in the image through sherpa-onnx | MIT (verified, ADR-0038) | **Use** (as an instrument) |
| WebRTC VAD | Speech/non-speech | `webrtcvad-wheels`, benchmark group only | MIT/BSD | Rejected: failed the Phase 2B noise criteria |
| DNSMOS (P.808 / P.835 ONNX) | Non-intrusive MOS for signal, background and overall | Needs an onnxruntime path that loads arbitrary models (sherpa-onnx does not expose one): a new runtime dependency | **Unverified** for code and weights | Future candidate. Needs an ADR, a licence check, an M1 CPU benchmark, and validation that MOS correlates with STT error here |
| NISQA | Non-intrusive MOS plus dimensions (noisiness, discontinuity, colouration, loudness) | PyTorch: hundreds of MB, not in the image | **Unverified** (weights may carry non-commercial terms) | Not suitable in v1 |
| TorchAudio-Squim | Objective STOI/PESQ/SI-SDR estimates, non-intrusive | PyTorch | BSD (code); weights unverified | Not suitable in v1 (PyTorch, which ADR-0037 already excluded for diarization) |
| Brouhaha | VAD + SNR + C50 (reverberation) per frame | pyannote.audio / PyTorch | **Unverified** | Not suitable in v1. The most relevant future option for reverberation |
| Whisper `no_speech_prob` / token probabilities | Model confidence | Part of STT | — | **Excluded by FR-3.3**: diagnostics are never inferred from transcription confidence |

The upgrade path is a single ADR, if later evidence (real-speech labels) shows the deterministic proxies miss problems
that matter.

## 4. Threshold strategy (no numbers are invented here)

1. **Anchor each rule on a downstream effect, not taste.** For noise, level, bandwidth and clipping, use E7-style
   scoring: transcribe the controlled degradation sweeps with the production STT path, and find where WER/CER begins to
   rise materially relative to clean.
   - E7 already gives per-SNR WER (English 6.7 % clean → 15.4 % at 5 dB; Hindi about 47–51 %, flat; Hinglish about
     81–87 %).
   - So noise affects English much more visibly than Hindi on this corpus. Thresholds may need to be
     language-independent but conservative, because A1 does not know the language: D-3A-08.
2. **Use the direct definition where one exists:**
   - clipping: any run above N samples;
   - dropouts: digital-zero runs inside active audio;
   - silence: ratio of time.
   These need tolerance values, not calibration against STT.
3. **Calibrate on the dev split, report on the test split,** the same split discipline as the Phase 2B and 2C
   benchmarks.
4. **The user approves the values.** M6 delivers a proposal table (rule, value, evidence, false-positive rate on
   clean). Until approval, the rule config is marked `provisional` in its `ruleVersion` (for example
   `a1-rules-0.x-provisional`) and the UI labels assessments as provisional.
5. **Synthetic-only limitation:** all calibration and evaluation are on TTS speech with NumPy noise. The resulting
   metrics describe behaviour on that corpus only, and **must not be presented as real-world accuracy** in docs, the UI
   or acceptance reports. Real-speech recalibration with the OD-18 corpus is follow-up work and needs a download
   approval (D-3A-13).

## 5. Evaluation corpus (generated locally; reuses existing generators; ADR-0004)

| Category | Source | Ground truth |
| --- | --- | --- |
| Clean speech, en/hi/Hinglish | Phase 2B VAD corpus scenes and the C3 STT clips (macOS TTS) | Reference speech labels; E7 WER per clip |
| Noisy (7 noise types at 20 / 10 / 5 / 0 dB) | Phase 2B VAD corpus mixtures (435 mixtures, 9.17 h) | **Known mixing SNR** and speech labels: the SNR-proxy and speech-ratio truth |
| Low volume | Gain sweep on clean scenes (for example −10 … −40 dB) | The applied gain |
| Clipped or saturated | Gain plus hard clip at controlled clipped ratios; soft-clip (tanh) variants | The clip ratio |
| Dropouts | Zeroed gaps; dropped packets / timestamp gaps (`timestamp_lab.make_dropped_packets`) | Gap positions |
| Narrowband or low bitrate | FFmpeg low-pass at 3.4 / 4 kHz; low-bitrate MP3 or Opus encodes, if the image's FFmpeg has the encoders | The applied band limit |
| Silence and non-speech | Digital silence, a white-noise floor only, a tone, music-like synthetic signals | No speech |
| Fragmented speech | The existing 14-span fragmented clip and the 2-span dense clip (`e2e-real-providers-2026-11-25/`) | Span counts |
| Level inconsistency | Gain steps between utterances | Step positions |
| Multi-speaker | C3 diarization conversations (2–4 speakers, 2–10 min, plus the 60 min file) | Speaker turns. A1 must *not* change with speaker count |
| Long recordings | Generated 4 h (resource test only) | — |
| Reverberation (negative control) | Synthetic exponential-decay impulse response | A1 must list reverberation as *not assessed*. A "good" class here is a documented gap, not a pass |

## 6. Metrics

- **Detection, per flag kind:**
  - precision, recall and F1 at the clip level;
  - region level: IoU ≥ 0.5 matching with a ±block tolerance;
  - per language.
- **False positive and false negative rates:**
  - false-positive rate on clean clips (any flag; high-severity flags separately);
  - false-negative rate per degradation level.
- **Estimators:**
  - SNR proxy: MAE and mean bias in dB against the known mixing SNR, grouped by noise type, language and SNR level
    (§6.1);
  - speech ratio: absolute error against the reference labels.
- **Consistency:**
  - determinism: byte-identical output on a repeat run in the container;
  - monotonicity along each sweep;
  - gain invariance of gain-invariant flags (noise, SNR, bandwidth) under a ±6 dB global gain.
- **Downstream relevance:** Spearman ρ between the A1 severity ordinal or SNR proxy and the E7 per-clip WER/CER,
  per language. Mean WER per A1 class.
- **Uncertain conditions:** the share of clips where A1 correctly reports `not_assessable` / `low` confidence (silent,
  too short) rather than a confident class.
- **Cost:** RTF and peak `memory.peak` / anonymous memory of the measure task in the production container (2 CPUs,
  768 MB); A1 classification time.

### 6.1 SNR evaluation methodology (M0)

- **Ground truth:** the known mixing SNR of the synthetic Phase 2B VAD corpus.
  - **Labels:** `docs/development/phase2b-vad-benchmark/corpus-manifest.json` records, for each of the 435 mixtures,
    the target `snr` (20 / 10 / 5 / 0 dB or `clean`), `noise` (7 types), `language`, `split`, the generator `seed` and
    the WAV SHA-256.
  - **Definition** (`services/audio/benchmarks/vad/vadbench/corpus.py` `mix()`): speech power is the mean square of the
    clean scene over the reference speech frames, and noise power is measured over the same frames. The noise gain sets
    the target ratio, so the label is an **active-speech SNR**.
  - **Scaling:** the mixture is then scaled uniformly to avoid clipping and quantised to int16. Uniform scaling leaves
    the ratio unchanged; quantisation adds a floor far below the 0 dB condition.
- **Verification before use:**
  - Check the local WAVs (`.local-benchmarks/vad-corpus/`, gitignored, generated in Phase 2B, present locally) against
    the manifest SHA-256.
  - On a sample, recompute the achieved SNR by regenerating the clean and noise components from the stored utterances
    and the manifest seeds.
  - **If either check fails, M0 reports the limitation**, for example "achieved SNR not verifiable; target labels used
    with that caveat" or "mixture missing". It never invents or substitutes reference values.
- **What is scored:**
  1. the VAD-split estimate against the known mixing SNR (**primary**);
  2. WADA-SNR against the known mixing SNR (**secondary baseline**).
  - Error = estimate − reference, in dB.
  - The two estimators are never scored against each other; agreement between them is not evidence of accuracy.
- **Reported:**
  - MAE and mean bias (dB), with the number of mixtures in each cell;
  - grouped by noise type (white, pink, brown, hum, modulated pink, clicks, music), by language (English, Hindi,
    Hinglish) and by SNR level (20 / 10 / 5 / 0 dB), plus the noise type × SNR level cross-table.
  - Results are reported on the **test** split. The dev split is used only to set estimator parameters (for example the
    power-subtraction correction).
- **Excluded or separate:**
  - `clean` mixtures have no numeric label (a −70 dBFS white floor, not a target SNR). They are excluded from MAE and
    bias, and the estimators' outputs on them are reported separately as a distribution. A numeric reference may be
    computed from the regenerated components with the same definition, but only if the verification above succeeds,
    and it is then labelled *computed*.
  - The 60 / 120 min long files are excluded (they repeat the test mixtures).
- **Known limitations, stated with the results:**
  - **Definitions differ.** WADA-SNR estimates a global SNR under its own speech and noise distribution assumptions,
    and the VAD-split estimate depends on detector errors. Both are compared with an active-speech reference, so some
    bias is definitional.
  - **Unrealistic noise.** The clicks and music types are non-stationary and synthetic.
  - **Synthetic only.** The speech is macOS TTS and the noise comes from NumPy, so the results are not real-world
    accuracy (§4, item 5).

## 7. Test layers

| Layer | Runner | What |
| --- | --- | --- |
| Unit: audio service | Pytest | Measure analysers on synthetic signals (sine, noise at a known SNR, clipping, zero runs, band-limited noise); VAD-split SNR on constructed signals; `unavailable` reasons; the judgement-key guard on the result |
| Unit: A1 rules | Jest (orchestrator) | Table-driven rule tests from hand-built measurement inputs; region merging; coverage; class, confidence and suitability derivation; monotonicity property tests; determinism |
| Contract | Vitest (`packages/contracts`) | Schemas and fixtures for the measure task, `AudioQualitySummary` and `AudioDiagnostics`; invalid fixtures (judgement keys in service results, unknown kinds) |
| Integration: DB | Vitest / Jest against `*_test` | Migration, constraints, immutability triggers, cascade deletion, composite workspace FKs |
| Integration: orchestrator | Jest | Measure step with the scripted fake audio client (retry, cancel, sweeper, reuse); A1 job (created run, re-assessment, failure isolation from `run-transcription`); repository separation (import-graph test) |
| Integration: API | Jest | Diagnostics endpoint shape; 404 across workspaces (the parameterised SEC-2 suite); time-range paging |
| Container | Pytest (`container` marker) | Real measure task in the image: determinism, Landlock enforced, memory on a generated 4 h file, deadline |
| Web | Vitest | Card, step and timeline states; copy distinguishes measured, estimated and assessed; no uncertainty tokens in diagnostics UI; axe |
| E2E | Playwright + the Phase 2C real-stack scripts | Per category clip: upload → preprocess → measure → A1 → UI; then start transcription and verify the transcript is unchanged against a reference run without A1 |
| Benchmark (not CI) | `services/audio/benchmarks/quality/` (benchmark-only, like C3) | M0: estimator accuracy and the *harness* cost, indicative only. M6: corpus generation, metrics (§6), the threshold proposal table. Saved evidence under `docs/development/phase3a-quality-benchmark/` |
| Production-task validation | Pytest `container` marker (M4) | RTF, memory and sandbox checks of the **implemented** `measure` task. This repeats M0's harness figures and is the only AC-10 evidence |

**Regression:** the full 2B/2C suites (unit, integration, audio host and container, Compose hardening) run before each
milestone is accepted (AC-3).
