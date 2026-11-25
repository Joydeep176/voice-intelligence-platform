# Phase 2B WS5a: VAD candidate benchmark on a synthetic corpus

**Status: measured, awaiting the user's decision.** OD-29 approves *benchmarking* WebRTC VAD and Silero VAD. This
report selects nothing, and no VAD has been added to `src/` or to the `runtime` image. The plan §13.4 rule is applied
mechanically below as input to the decision.

**Read this first: the corpus is synthetic.** Every utterance is macOS text-to-speech: clean, evenly paced, with no
overlapping speakers, reverberation, codec artefacts, breath, disfluency or real Hinglish code-switching prosody.
Noise is generated in NumPy and is simpler than real noise. Results are comparable *between candidates on this corpus*
but are **not** a substitute for real recordings. The real-speech benchmark awaits dataset approval (OD-18 / D-2B-14);
no dataset was downloaded or used here.

Files: `results.json` (every number), `results-tables.md` (full language x noise x SNR tables per candidate),
`corpus-manifest.json` (seeds, voices, sentence IDs, durations, SHA-256 of every generated file),
`DEPENDENCIES.md` (versions, wheels, SHA-256, licences). Code: `services/audio/benchmarks/vad/` (single entry point
`run.py`, see its README).

## Method

### Candidates and shared post-processing

| Candidate | Implementation in this benchmark |
| --- | --- |
| Silero VAD | ONNX model `silero_vad.onnx` (v6.2.3, SHA-256 in DEPENDENCIES.md) run with `onnxruntime` directly, 16 kHz, 512-sample (32 ms) frames with the model's 64-sample context, state carried across frames, `intra_op=1`, `inter_op=1`. Plain threshold on the speech probability (no hysteresis). Each 10 ms reference frame takes the probability of the 32 ms frame that contains its centre sample |
| WebRTC VAD | `webrtcvad-wheels` 2.0.14.post1, aggressiveness 0-3 and 10/20/30 ms frames (12 settings); a decision per frame is repeated over its 10 ms frames |
| NumPy baseline | Causal 25 ms Hann window per 10 ms frame; energy (dB) minus an adaptive noise floor (falls at rate 0.2 to any lower frame, rises at 0.01 only when the frame is within 6 dB of it); spectral flatness of about 94-4000 Hz; speech if `excess > T and flatness < F`; 80 ms hangover. Lives only in `benchmarks/vad/` |

All three feed the **same** segmenter, with these **benchmark settings (not approved segmentation limits)**:
minimum speech 250 ms, minimum silence 300 ms (gaps shorter than this are merged), padding 200 ms on both sides
(padded segments that touch are unioned). Order: merge gaps, drop short segments, pad.

### Tuning (dev split only)

Each candidate's parameters are chosen on the **dev** split: maximise the mean of the frame-level F1 at 10 dB and at
5 dB SNR, pooled over languages and noise types; ties go to the lower pooled FPR. Grids: Silero threshold 0.10-0.90
step 0.05; WebRTC 4 modes x 3 frame lengths; baseline `T` in {4, 6, 8, 10, 12, 15} dB x `F` in {0.2, 0.3, 0.4, 0.6, off}.
The test split is scored once with the selected setting. This objective is a benchmark choice, not a recommendation of
an operating point.

<!-- BEGIN:tuning -->
| Candidate | Selected on dev | Dev objective (mean F1 at 10/5 dB) | Grid size |
| --- | --- | --- | --- |
| Silero (ONNX) | {'threshold': 0.4} | 0.9394 | 17 |
| WebRTC | {'frame_ms': 10, 'mode': 3} | 0.8103 | 12 |
| NumPy baseline | {'excess_db': 2.0, 'flatness_max': 0.2} | 0.8475 | 72 |
<!-- END:tuning -->

### Corpus (generated locally, ADR-0004)

- **Speech.** 180 original sentences written for this benchmark (no copied text, no real people or data): 60 English,
  60 Hindi (Devanagari), 60 Hinglish (30 Devanagari with Latin words, spoken by `Lekha`; 30 romanised, spoken by the
  en_IN voices). Rendered on the Mac with `say --data-format=LEI16@16000`: English by `Aman`, `Rishi`, `Tara`,
  `Daniel`, `Fred`, `Albert` in rotation; Hindi by `Lekha`; romanised Hinglish by `Aman`, `Rishi`, `Tara` in rotation.
  Lekha reads the Latin words inside Devanagari Hinglish with a Hindi voice, so that kind of code-switching is only
  approximated. (The macOS version and the voice versions are in the manifest `environment`; the rendered audio depends on
  them.)
- **Split.** By sentence, per language: 12 dev and 48 test (Hinglish: 6 + 6 dev, 24 + 24 test from each kind). No
  sentence or mixture is shared across splits.
- **Scenes.** A scene is 12 utterances in a seeded order separated by gaps of 0.2-5 s (uniform, multiples of 10 ms),
  including a lead-in and a tail gap: about 60-84 s. Dev: 1 scene per language. Test: 4 scenes per language
  (the 48 test sentences, each used once).
- **Conditions.** Every scene is rendered clean and with each of 7 noise types at 20, 10, 5 and 0 dB: **29 mixtures per
  scene, 435 in all (87 dev, 348 test; 9.17 h)**. Stationary noise: white, pink, brown, 50 Hz hum with eight
  harmonics. Non-stationary: amplitude-modulated pink (0.4-2.5 Hz, depth 0.8), Poisson clicks (about 4/s, 3-12 ms), a
  synthetic tonal "music" bed (1.5-3 s chords, pentatonic, four harmonics). A given scene shares the same utterance
  order and gaps across all its conditions, so conditions are directly comparable.
- **SNR.** Broadband: speech power is the mean square over the reference speech samples of the clean scene; noise power is
  measured over the same samples; the noise gain is set for the target ratio. The mixture is scaled down together if it
  would clip (SNR unchanged). "Clean" has the TTS scene plus a seeded white floor at -70 dBFS (instead of digital zero,
  which is degenerate for energy-based detectors).
- **Long files.** `long-60` (60.8 min) and `long-120` (120.0 min): distinct, shuffled test mixtures concatenated; no new content.
- **Seeds.** Every generator uses `numpy.random.default_rng` with a fixed seed list (recorded per mixture in the manifest).
- **Not stored in git.** Audio is in `.local-benchmarks/vad-corpus/` (gitignored, 1.3 GB).

### Reference labels

Frame labels (10 ms) are derived from each **clean** utterance, not from the mixture: a frame is speech if its RMS is within
**40 dB of that utterance's peak sample**; then silences shorter than 100 ms inside speech are filled and speech runs
shorter than 30 ms are removed. Each utterance is trimmed to its first/last speech frame plus 50 ms. A **reference span** is
the first-to-last speech frame of an utterance and is what boundary errors are measured against.
**Limitations of this rule:** it is an energy rule, so weak fricatives, stop closures and the very low-energy ends of
words may be labelled either way (an error of tens of ms at the boundaries is within the labelling uncertainty, and
every candidate is scored against the same labels); a 100 ms fill rule means short pauses inside a sentence count as speech;
the TTS audio is clean so the rule is far more reliable than it would be on real recordings.

### Metrics

Frame level (10 ms, raw decisions before post-processing): precision, recall, FPR, FNR, F1, pooled by summing counts.
Boundary (on the unpadded post-processed segments): absolute onset/offset error against the reference span, median and
p95, plus the signed median in `results.json`; an onset is skipped if the matching segment also covers the previous
utterance (merged by the 300 ms rule), an offset likewise for the next; an utterance with no overlapping segment counts in
"missed". Post-processing (padded final segments): **speech coverage** = reference speech frames inside a segment /
reference speech frames; **non-speech inclusion (NSI)** = segment frames that are reference non-speech / segment frames.
Unpadded variants are in `results.json`.

Resources are measured **inside the container** (benchmark stage; `--cpus 1 --memory 512m --read-only --cap-drop ALL
--network none`), one **fresh container per candidate**, on `long-60` streamed in 29.8 s chunks, three consecutive passes in
the same process: RTF = wall time / audio time (median of 3), CPU seconds per audio hour (`process_time`, median of 3),
cgroup `memory.peak` at the end, and anonymous memory from `memory.stat` (`anon`) sampled every 50 ms (maximum, and the
maximum in the first and last third of the run to show growth). `memory.peak` includes page cache of the bind-mounted
audio file and of the libraries, so **anon is the better measure of the process's own growth**; both are reported. The
candidate figures exclude FFmpeg, FastAPI and uvicorn (the plan §4.2 estimates ~47 MB for the app and 20-60 MB for an
FFmpeg child on top). See Limitations.

Determinism: the whole test evaluation is run twice in separate containers; the SHA-256 of all packed frame decisions and
of the metric rows must match. Drift: each long file is processed in one continuous pass (state never reset); F1 is reported per
10-minute block, and the frames are compared with the same audio scored one mixture at a time from a fresh state.

## Results (test split, parameters tuned on dev)

### Headline: F1, FPR and non-speech inclusion at 10 dB and 5 dB per language (pooled over the 7 noise types)

<!-- BEGIN:headline -->
| Language | SNR | Silero (ONNX) F1 | Silero (ONNX) FPR | Silero (ONNX) NSI | WebRTC F1 | WebRTC FPR | WebRTC NSI | NumPy baseline F1 | NumPy baseline FPR | NumPy baseline NSI |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| english | 10 dB | 0.903 | 0.045 | 0.123 | 0.877 | 0.282 | 0.244 | 0.866 | 0.301 | 0.213 |
| english | 5 dB | 0.898 | 0.044 | 0.121 | 0.828 | 0.503 | 0.316 | 0.841 | 0.296 | 0.213 |
| hindi | 10 dB | 0.973 | 0.049 | 0.146 | 0.835 | 0.369 | 0.346 | 0.856 | 0.314 | 0.283 |
| hindi | 5 dB | 0.971 | 0.050 | 0.146 | 0.763 | 0.627 | 0.437 | 0.847 | 0.306 | 0.276 |
| hinglish | 10 dB | 0.963 | 0.075 | 0.161 | 0.831 | 0.406 | 0.353 | 0.845 | 0.350 | 0.292 |
| hinglish | 5 dB | 0.961 | 0.076 | 0.161 | 0.777 | 0.605 | 0.420 | 0.835 | 0.343 | 0.288 |
<!-- END:headline -->

### All metrics by SNR (pooled over languages and noise types; `clean` = clean condition)

<!-- BEGIN:overall -->
| SNR | Candidate | Prec | Recall | FPR | FNR | F1 | Onset med ms | Onset p95 ms | Offset med ms | Offset p95 ms | Coverage | NSI | Missed utt. |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| clean | Silero (ONNX) | 0.961 | 0.982 | 0.048 | 0.018 | 0.971 | 10 | 50 | 60 | 90 | 0.999 | 0.137 | 0.000 |
| clean | WebRTC | 0.962 | 0.992 | 0.048 | 0.008 | 0.977 | 10 | 20 | 80 | 100 | 1.000 | 0.140 | 0.000 |
| clean | NumPy baseline | 0.951 | 0.990 | 0.062 | 0.010 | 0.970 | 0 | 20 | 110 | 120 | 1.000 | 0.146 | 0.000 |
| 20 | Silero (ONNX) | 0.954 | 0.946 | 0.055 | 0.054 | 0.950 | 10 | 60 | 80 | 140 | 0.959 | 0.143 | 0.020 |
| 20 | WebRTC | 0.905 | 0.966 | 0.123 | 0.034 | 0.935 | 10 | 699 | 70 | 569 | 0.999 | 0.217 | 0.000 |
| 20 | NumPy baseline | 0.782 | 0.979 | 0.331 | 0.021 | 0.870 | 10 | 80 | 80 | 120 | 1.000 | 0.265 | 0.000 |
| 10 | Silero (ONNX) | 0.952 | 0.937 | 0.057 | 0.063 | 0.945 | 10 | 70 | 80 | 160 | 0.950 | 0.144 | 0.030 |
| 10 | WebRTC | 0.765 | 0.953 | 0.356 | 0.047 | 0.849 | 20 | 1509 | 70 | 1001 | 0.996 | 0.313 | 0.000 |
| 10 | NumPy baseline | 0.781 | 0.948 | 0.323 | 0.052 | 0.856 | 10 | 289 | 60 | 269 | 0.997 | 0.261 | 0.000 |
| 5 | Silero (ONNX) | 0.952 | 0.932 | 0.057 | 0.068 | 0.942 | 20 | 90 | 90 | 170 | 0.947 | 0.143 | 0.031 |
| 5 | WebRTC | 0.669 | 0.968 | 0.582 | 0.032 | 0.791 | 50 | 2480 | 90 | 1760 | 0.997 | 0.391 | 0.000 |
| 5 | NumPy baseline | 0.778 | 0.914 | 0.316 | 0.086 | 0.841 | 20 | 686 | 50 | 633 | 0.984 | 0.258 | 0.000 |
| 0 | Silero (ONNX) | 0.948 | 0.918 | 0.061 | 0.082 | 0.933 | 20 | 150 | 90 | 230 | 0.939 | 0.143 | 0.035 |
| 0 | WebRTC | 0.622 | 0.979 | 0.724 | 0.021 | 0.760 | 30 | 2973 | 90 | 2190 | 0.997 | 0.410 | 0.000 |
| 0 | NumPy baseline | 0.766 | 0.836 | 0.310 | 0.164 | 0.800 | 20 | 973 | 70 | 1148 | 0.950 | 0.256 | 0.012 |
| all | Silero (ONNX) | 0.952 | 0.935 | 0.057 | 0.065 | 0.943 | 10 | 90 | 80 | 180 | 0.950 | 0.143 | 0.028 |
| all | WebRTC | 0.731 | 0.968 | 0.432 | 0.032 | 0.833 | 10 | 1710 | 80 | 1170 | 0.997 | 0.336 | 0.000 |
| all | NumPy baseline | 0.783 | 0.922 | 0.311 | 0.078 | 0.846 | 10 | 390 | 70 | 620 | 0.983 | 0.257 | 0.003 |
<!-- END:overall -->

Per language x noise type x SNR (87 rows per candidate, plus rollups): `results-tables.md` and `results.json`.

### Resources (container, 1 CPU, 512 MB)

<!-- BEGIN:resources -->
| Candidate | RTF (median of 3) | CPU s / audio hour | memory.peak MiB | anon max MiB (sampled) | anon first third max | anon last third max | file cache MiB (end) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Silero (ONNX) | 0.01697 | 60.4 | 172.2 | 51.7 | 49.8 | 51.7 | 115.9 |
| WebRTC | 0.00032 | 1.1 | 145.0 | 28.4 | 24.7 | 28.4 | 111.9 |
| NumPy baseline | 0.00180 | 6.3 | 181.2 | 64.3 | 57.3 | 62.6 | 111.4 |
<!-- END:resources -->

### Long-file drift (60 and 120 minutes)

<!-- BEGIN:drift -->
| Candidate | File | Minutes | F1 first 10 min | F1 last full block | F1 min block | F1 max block | Frames differing from per-mixture scoring |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Silero (ONNX) | long-60 | 60.8 | 0.959 | 0.953 | 0.899 | 0.959 | 5644 / 364873 |
| Silero (ONNX) | long-120 | 120.0 | 0.936 | 0.952 | 0.875 | 0.967 | 10104 / 720222 |
| WebRTC | long-60 | 60.8 | 0.887 | 0.839 | 0.545 | 0.887 | 150035 / 364873 |
| WebRTC | long-120 | 120.0 | 0.870 | 0.601 | 0.418 | 0.870 | 273657 / 720222 |
| NumPy baseline | long-60 | 60.8 | 0.845 | 0.765 | 0.765 | 0.923 | 28708 / 364873 |
| NumPy baseline | long-120 | 120.0 | 0.768 | 0.824 | 0.768 | 0.868 | 42208 / 720222 |
<!-- END:drift -->

### Determinism

<!-- BEGIN:determinism -->
| Candidate | Test decisions SHA-256 (prefix), runs a and b | Identical decisions and metrics |
| --- | --- | --- |
| Silero (ONNX) | cb385e88c09212c5 | yes |
| WebRTC | e4d649a95f723806 | yes |
| NumPy baseline | e6b05b1c2c59f58f | yes |
<!-- END:determinism -->

### Plan §13.4 criteria (mechanical; input to the user's decision, **not a selection**)

<!-- BEGIN:criteria -->
| Candidate | 1a Memory gate | 1b RTF <= 0.05 | 1c Deterministic | 1d Licence | 2 Not worst in any language at 10/5 dB | 3 FPR and NSI <= baseline at 10 / 5 dB |
| --- | --- | --- | --- | --- | --- | --- |
| Silero (ONNX) | meets (172.2 MiB peak) | meets (RTF 0.01697) | meets | meets (MIT / BSD / project code) | meets | meets (FPR 0.057/0.057 vs 0.323/0.316; NSI 0.144/0.143 vs 0.261/0.258; per-language cells 6/6) |
| WebRTC | meets (145.0 MiB peak) | meets (RTF 0.00032) | meets | meets (MIT / BSD / project code) | FAILS (worst in english@5dB, hindi@10dB, hindi@5dB, hinglish@10dB, hinglish@5dB) | FAILS (FPR 0.356/0.582 vs 0.323/0.316; NSI 0.313/0.391 vs 0.261/0.258; per-language cells 0/6) |
| NumPy baseline | meets (181.2 MiB peak) | meets (RTF 0.00180) | meets | meets (MIT / BSD / project code) | FAILS (worst in english@10dB) | meets (FPR 0.323/0.316 vs 0.323/0.316; NSI 0.261/0.258 vs 0.261/0.258; per-language cells 6/6) |
<!-- END:criteria -->

How each criterion was applied: (1a) container `memory.peak` of the candidate benchmark process <= 384 MB (the plan's single
threshold is for the whole service on a 4 h file; this is the candidate's share only); (1b) RTF median <= 0.05 at 1 CPU;
(1c) identical decisions and metrics in two runs; (1d) licence per DEPENDENCIES.md; (2) a candidate fails if its F1 is the
strictly lowest of the three in any of the 6 cells (3 languages x 10/5 dB, pooled over noise types); (3) pooled FPR and NSI
at 10 dB and at 5 dB must not exceed the baseline's (the baseline is trivially equal to itself; the number of the 6
language x SNR cells that satisfy it is also given); (4) tie-break by fewer dependencies is **not** applied here.

## Findings and limitations

(see the end of this file)
