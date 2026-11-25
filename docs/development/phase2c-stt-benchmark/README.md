# Phase 2C C3: free local STT and diarization benchmark on a synthetic corpus

**Status: complete (2026-11-25).**

- All seven STT engines and both diarization embeddings are measured.
  - The whisper.cpp medium accuracy pass a covers 60 clips, and pass b 40 clips; 20 clips are compared for
    determinism.
  - WeSpeaker accuracy and resources are complete.
- `run.py report` regenerated `results.json` and `results-tables.md` on 2026-11-25. That run fixed a determinism
  comparison bug: only clips present in both passes are now compared.
- **Selections, made after this report:** OD-02b is whisper.cpp small (ADR-0036), and OD-03b is sherpa-onnx with CAM++
  (ADR-0037).
- **Not production-path accuracy:** this report measures the candidates in **single-pass** mode. The production
  path's accuracy (Silero speech spans with per-span language) is reported in ADR-0036 (E7).
- No accuracy threshold is set. SRS NFR-3 and NFR-4 remain "TBD"; a deferral is proposed in ADR-0042, awaiting the user's decision.

When written, this report selected nothing: OD-02b / OD-03b were the user's decision (ADR-0012). The benchmark harness
is not in `services/audio/src`, and its benchmark-only packages are not in the `runtime` image (asserted below). Everything runs offline, free and open source (ADR-0034, M1 8 GB).

**Read this first: the corpus is synthetic.** All speech is macOS text-to-speech: clean, evenly paced, one voice per
utterance, no reverberation, codec artefacts, breath, disfluency, accents beyond the voice's own, or real Hinglish
code-switching prosody. Noise is generated in NumPy. Numbers compare candidates *on this corpus* and say **nothing about
real-world accuracy**; real-speech accuracy awaits the dataset decision (OD-18 / D-2B-14). The test sets are small (the
cell sizes are in the tables), so differences of a few points are not meaningful.

Files: `results.json` (every number), `results-tables.md` (the generated tables, also reproduced below),
`corpus-manifest-stt.json`, `corpus-manifest-diarization.json` (seeds, voices, SHA-256 of every generated file),
`DEPENDENCIES.md` (versions, wheels, licences of code and weights, hashes, exclusions). Code: `services/audio/benchmarks/stt/`
(single entry point `run.py`) and `services/audio/benchmarks/diarization/`.

Reproduce, from the repository root (macOS with `say`, curl, Docker; about 6 GB of downloads):

```
uv run --directory services/audio --no-dev python benchmarks/stt/run.py all
uv run --directory services/audio --no-dev python benchmarks/stt/run.py check-runtime
```

## Method

### Candidates

| Id | Engine and model | Runs as |
| --- | --- | --- |
| `fw-small`, `fw-medium` | faster-whisper 1.2.1 (CTranslate2 4.9.0), Whisper small / medium, `compute_type="int8"` (weights are stored float16) | beam 5, language auto-detected, no VAD, no previous-text conditioning |
| `cpp-small`, `cpp-medium` | whisper.cpp through pywhispercpp 1.5.1, ggml small `q5_1` / medium `q5_0` | language detected once (`auto_detect_language`), then decoded with it; `no_context` |
| `sherpa-small`, `sherpa-medium` | sherpa-onnx 2.0.2, Whisper small / medium ONNX int8 | greedy search; language auto-detected (`language=""`); `max_tokens_per_second=15` (the default 6 truncates Hindi) |
| `omni-300m` | sherpa-onnx 2.0.2, Meta Omnilingual ASR 300M CTC v2 int8 (1,600+ languages incl. Hindi) | CTC greedy; no language report, no punctuation or casing |
| Diarization `campplus` | sherpa-onnx offline diarization: pyannote segmentation-3.0 (ONNX, fp32) + 3D-Speaker CAM++ (en, VoxCeleb) embeddings, agglomerative clustering | `min_duration_on` 0.3 s, `min_duration_off` 0.5 s |
| Diarization `wespeaker` | same pipeline, WeSpeaker ResNet34-LM (en, VoxCeleb) embeddings | same |

STT models are fed audio of at most 30 s (single utterances, or fixed 30 s windows for the long files: no VAD, no
overlap, no prompt). Every engine uses the same decoding policy where the engine allows. Excluded candidates and
reasons: `DEPENDENCIES.md`.

### Corpus (generated locally, ADR-0004)

- **STT clips.** The 180 original sentences and the macOS TTS utterances of the Phase 2B VAD corpus are reused
  (`.local-benchmarks/vad-corpus`, sentence IDs and split in the Phase 2B manifest). Dev/test split by sentence (Phase 2B
  split). Test: 20 sentences per language (Hinglish: 10 Devanagari-mixed read by `Lekha`, 10 romanised read by the en_IN
  voices), each at clean / 20 / 10 / 5 dB = 240 clips; dev: 6 sentences per language, clean only (18 clips; used for
  smoke checks, nothing was tuned on them). Each clip has 0.5 s of silence on both sides. One noise type per clip, drawn
  by seed from the seven Phase 2B generators (white, pink, brown, hum, am_pink, clicks, music); at SNR "clean" a white
  floor at -70 dBFS is added. Per-clip noise type, voice, seed and SHA-256 are in the manifest. Speech by language:
  English voices Aman, Rishi, Tara, Daniel, Fred, Albert; Hindi `Lekha`; Hinglish as above.
- **Diarization conversations.** Every voice reads the sentences of its language group (Aman, Rishi, Tara: English and
  romanised Hinglish; Daniel, Fred, Albert: English; Lekha: Hindi and Devanagari Hinglish), rendered on the host with
  `say`. A conversation takes turns of one or two utterances (the same speaker continues 15% of turns), with gaps of
  0.2-1.5 s (and 3-6 s in 5% of turns) and, in 12% of turns, an overlap of 0.3-1.0 s with the previous speaker. Reference
  segments are the speech runs of each utterance (Phase 2B reference rule: frame RMS within 40 dB of the utterance peak,
  gaps under 100 ms filled). Nine test conversations (2, 3, 4 speakers; 2, 5, 10 min; three voice sets per speaker count,
  including a Lekha voice in two of the test conversations), three 2-minute dev conversations (clustering threshold
  tuned there), and one 60-minute 4-speaker file (ADR-0016 memory behaviour). Dev and test conversations draw from
  disjoint sentences (the Phase 2B split). Sentences are re-used within the long conversations once a voice's pool is
  exhausted. All conversations are clean (white floor at -70 dBFS).
- **Timing files.** `rtf-mixed.wav` (3 min of 40 clean utterances, mixed languages) for the STT RTF; the Phase 2B
  `long-60.wav` (60.8 min of speech and gaps, noisy) for STT long-file behaviour; `test-3spk-b-5min` for diarization RTF.

### Text normalisation and metrics

Applied identically to references and hypotheses (`sttbench/textnorm.py`, with self-checks in `test_metrics.py`):
Unicode NFC; lower case; apostrophes deleted; every other punctuation or symbol (including the Devanagari danda) becomes
a space; format characters (ZWJ/ZWNJ) deleted; whitespace collapsed. **No transliteration and no script conversion**:
Devanagari stays Devanagari, so an engine that writes Hinglish in the other script is charged for it. Numerals are not
normalised ("nine" vs "9" is an error for every engine). WER is over whitespace tokens, CER over Unicode code points
with spaces removed (a combining vowel sign counts as a character). Scores are corpus-level (sum of edits over sum of
reference length) per language and SNR. Language-ID accuracy is the share of English clips detected as `en` and Hindi
clips detected as `hi`; for Hinglish the reference language is undefined, so the detected codes are listed.
DER (`diarbench/der.py`): 10 ms frames, **250 ms collar** around every reference segment boundary (excluded from
scoring), **overlapped reference speech is scored**, one-to-one label mapping maximising overlap (exact dynamic
programme), DER = (missed + false alarm + confusion) / reference speech, averaged over conversations weighted by
reference speech.

### Resource measurement

Each engine runs in a fresh hardened container (`--read-only`, `--cap-drop ALL`, `--network none`, `--cpus 1`,
`--memory 3g --memory-swap 3g`, tmpfs `/tmp`), the same posture as the production audio container except for the memory
limit (production: 512 MB, 1 CPU). The model needs more than 512 MB in several cases, so the main run uses 3 GiB to
measure what each model *needs*; then the same run is repeated at `--memory 512m` to record whether 512 MB is feasible
(OOM-killed or completed). RTF is wall time over audio time, median of 3 passes over `rtf-mixed.wav` after a warm-up
(single thread: `BENCH_THREADS=1`); CPU s per audio hour from `time.process_time()`; model load time; peak memory from
`memory.peak` (includes page cache of the model file) and anonymous memory sampled every 100 ms from `memory.stat`
(the figure that decides an OOM kill). Accuracy runs use 4 threads (accuracy does not depend on the thread count; wall
times of those runs are not reported). The container runs in Docker Desktop's Linux VM on an Apple M1 (3.8 GiB VM
memory, 8 CPUs): absolute speeds differ from a production AWS Graviton or x86 task.

<!-- BEGIN:tables -->
## Common subset: the 60 test clips every engine transcribed (percent)

Same clips for every engine (clean and 10 dB, first 10 sentences per language, Hinglish 5 per kind), so the rows are directly comparable. Cells hold few words: read differences of a few points as noise.

### WER

| Engine | Language | clean | 10 dB | clips/cell |
| --- | --- | --- | --- | --- |
| faster-whisper-small-int8 | english | 3.1 | 10.0 | 10 |
| faster-whisper-small-int8 | hindi | 35.0 | 39.0 | 10 |
| faster-whisper-small-int8 | hinglish | 82.2 | 85.1 | 10 |
| faster-whisper-small-int8 | hinglish-hd | 41.5 | 46.3 | 5 |
| faster-whisper-small-int8 | hinglish-hr | 110.0 | 111.7 | 5 |
| faster-whisper-medium-int8 | english | 2.3 | 2.3 | 10 |
| faster-whisper-medium-int8 | hindi | 22.0 | 30.0 | 10 |
| faster-whisper-medium-int8 | hinglish | 77.2 | 78.2 | 10 |
| faster-whisper-medium-int8 | hinglish-hd | 36.6 | 41.5 | 5 |
| faster-whisper-medium-int8 | hinglish-hr | 105.0 | 103.3 | 5 |
| whisper.cpp-small-q5_1 | english | 3.1 | 9.2 | 10 |
| whisper.cpp-small-q5_1 | hindi | 37.0 | 41.0 | 10 |
| whisper.cpp-small-q5_1 | hinglish | 84.2 | 92.1 | 10 |
| whisper.cpp-small-q5_1 | hinglish-hd | 46.3 | 48.8 | 5 |
| whisper.cpp-small-q5_1 | hinglish-hr | 110.0 | 121.7 | 5 |
| sherpa-onnx-whisper-small-int8 | english | 3.1 | 10.0 | 10 |
| sherpa-onnx-whisper-small-int8 | hindi | 33.0 | 35.0 | 10 |
| sherpa-onnx-whisper-small-int8 | hinglish | 80.2 | 85.1 | 10 |
| sherpa-onnx-whisper-small-int8 | hinglish-hd | 41.5 | 48.8 | 5 |
| sherpa-onnx-whisper-small-int8 | hinglish-hr | 106.7 | 110.0 | 5 |
| sherpa-onnx-whisper-medium-int8 | english | 1.5 | 6.2 | 10 |
| sherpa-onnx-whisper-medium-int8 | hindi | 28.0 | 31.0 | 10 |
| sherpa-onnx-whisper-medium-int8 | hinglish | 76.2 | 86.1 | 10 |
| sherpa-onnx-whisper-medium-int8 | hinglish-hd | 36.6 | 43.9 | 5 |
| sherpa-onnx-whisper-medium-int8 | hinglish-hr | 103.3 | 115.0 | 5 |
| sherpa-onnx-omnilingual-300M-ctc-int8 | english | 21.5 | 25.4 | 10 |
| sherpa-onnx-omnilingual-300M-ctc-int8 | hindi | 21.0 | 33.0 | 10 |
| sherpa-onnx-omnilingual-300M-ctc-int8 | hinglish | 82.2 | 96.0 | 10 |
| sherpa-onnx-omnilingual-300M-ctc-int8 | hinglish-hd | 41.5 | 75.6 | 5 |
| sherpa-onnx-omnilingual-300M-ctc-int8 | hinglish-hr | 110.0 | 110.0 | 5 |

### CER

| Engine | Language | clean | 10 dB | clips/cell |
| --- | --- | --- | --- | --- |
| faster-whisper-small-int8 | english | 1.3 | 4.9 | 10 |
| faster-whisper-small-int8 | hindi | 17.3 | 19.5 | 10 |
| faster-whisper-small-int8 | hinglish | 86.8 | 89.2 | 10 |
| faster-whisper-small-int8 | hinglish-hd | 46.3 | 50.0 | 5 |
| faster-whisper-small-int8 | hinglish-hr | 113.4 | 115.0 | 5 |
| faster-whisper-medium-int8 | english | 1.1 | 1.6 | 10 |
| faster-whisper-medium-int8 | hindi | 10.7 | 13.7 | 10 |
| faster-whisper-medium-int8 | hinglish | 88.7 | 87.0 | 10 |
| faster-whisper-medium-int8 | hinglish-hd | 45.1 | 46.3 | 5 |
| faster-whisper-medium-int8 | hinglish-hr | 117.5 | 113.8 | 5 |
| whisper.cpp-small-q5_1 | english | 1.3 | 4.0 | 10 |
| whisper.cpp-small-q5_1 | hindi | 16.8 | 20.6 | 10 |
| whisper.cpp-small-q5_1 | hinglish | 89.7 | 95.6 | 10 |
| whisper.cpp-small-q5_1 | hinglish-hd | 49.4 | 54.3 | 5 |
| whisper.cpp-small-q5_1 | hinglish-hr | 116.3 | 122.8 | 5 |
| sherpa-onnx-whisper-small-int8 | english | 1.3 | 3.6 | 10 |
| sherpa-onnx-whisper-small-int8 | hindi | 16.5 | 18.4 | 10 |
| sherpa-onnx-whisper-small-int8 | hinglish | 88.5 | 88.0 | 10 |
| sherpa-onnx-whisper-small-int8 | hinglish-hd | 48.8 | 53.7 | 5 |
| sherpa-onnx-whisper-small-int8 | hinglish-hr | 114.6 | 110.6 | 5 |
| sherpa-onnx-whisper-medium-int8 | english | 0.9 | 4.1 | 10 |
| sherpa-onnx-whisper-medium-int8 | hindi | 13.2 | 14.0 | 10 |
| sherpa-onnx-whisper-medium-int8 | hinglish | 86.5 | 85.5 | 10 |
| sherpa-onnx-whisper-medium-int8 | hinglish-hd | 43.8 | 46.3 | 5 |
| sherpa-onnx-whisper-medium-int8 | hinglish-hr | 114.6 | 111.4 | 5 |
| sherpa-onnx-omnilingual-300M-ctc-int8 | english | 6.5 | 8.6 | 10 |
| sherpa-onnx-omnilingual-300M-ctc-int8 | hindi | 8.8 | 15.4 | 10 |
| sherpa-onnx-omnilingual-300M-ctc-int8 | hinglish | 87.0 | 98.0 | 10 |
| sherpa-onnx-omnilingual-300M-ctc-int8 | hinglish-hd | 45.1 | 72.2 | 5 |
| sherpa-onnx-omnilingual-300M-ctc-int8 | hinglish-hr | 114.6 | 115.0 | 5 |

## STT accuracy (test split, percent; WER = word, CER = code point; lower is better)

### WER

| Engine | Language | clean | 20 dB | 10 dB | 5 dB | clips/cell |
| --- | --- | --- | --- | --- | --- | --- |
| faster-whisper-small-int8 | english | 3.9 | 4.3 | 12.2 | 12.2 | 20 |
| faster-whisper-small-int8 | hindi | 49.3 | 43.5 | 53.6 | 58.9 | 20 |
| faster-whisper-small-int8 | hinglish | 76.8 | 77.8 | 80.2 | 82.1 | 20 |
| faster-whisper-small-int8 | hinglish-hd | 40.0 | 41.1 | 46.7 | 53.3 | 10 |
| faster-whisper-small-int8 | hinglish-hr | 105.1 | 106.0 | 106.0 | 104.3 | 10 |
| faster-whisper-medium-int8 | english | 2.3 | n/a | 2.3 | n/a | 10 |
| faster-whisper-medium-int8 | hindi | 22.0 | n/a | 30.0 | n/a | 10 |
| faster-whisper-medium-int8 | hinglish | 77.2 | n/a | 78.2 | n/a | 10 |
| faster-whisper-medium-int8 | hinglish-hd | 36.6 | n/a | 41.5 | n/a | 5 |
| faster-whisper-medium-int8 | hinglish-hr | 105.0 | n/a | 103.3 | n/a | 5 |
| whisper.cpp-small-q5_1 | english | 3.1 | n/a | 9.2 | n/a | 10 |
| whisper.cpp-small-q5_1 | hindi | 37.0 | n/a | 41.0 | n/a | 10 |
| whisper.cpp-small-q5_1 | hinglish | 84.2 | n/a | 92.1 | n/a | 10 |
| whisper.cpp-small-q5_1 | hinglish-hd | 46.3 | n/a | 48.8 | n/a | 5 |
| whisper.cpp-small-q5_1 | hinglish-hr | 110.0 | n/a | 121.7 | n/a | 5 |
| sherpa-onnx-whisper-small-int8 | english | 3.9 | 4.7 | 11.8 | 15.4 | 20 |
| sherpa-onnx-whisper-small-int8 | hindi | 43.0 | 47.8 | 50.7 | 53.6 | 20 |
| sherpa-onnx-whisper-small-int8 | hinglish | 79.2 | 79.7 | 86.0 | 87.9 | 20 |
| sherpa-onnx-whisper-small-int8 | hinglish-hd | 47.8 | 48.9 | 58.9 | 63.3 | 10 |
| sherpa-onnx-whisper-small-int8 | hinglish-hr | 103.4 | 103.4 | 106.8 | 106.8 | 10 |
| sherpa-onnx-whisper-medium-int8 | english | 1.5 | n/a | 6.2 | n/a | 10 |
| sherpa-onnx-whisper-medium-int8 | hindi | 28.0 | n/a | 31.0 | n/a | 10 |
| sherpa-onnx-whisper-medium-int8 | hinglish | 76.2 | n/a | 86.1 | n/a | 10 |
| sherpa-onnx-whisper-medium-int8 | hinglish-hd | 36.6 | n/a | 43.9 | n/a | 5 |
| sherpa-onnx-whisper-medium-int8 | hinglish-hr | 103.3 | n/a | 115.0 | n/a | 5 |
| sherpa-onnx-omnilingual-300M-ctc-int8 | english | 24.0 | 26.4 | 27.6 | 33.9 | 20 |
| sherpa-onnx-omnilingual-300M-ctc-int8 | hindi | 27.1 | 38.6 | 45.4 | 55.1 | 20 |
| sherpa-onnx-omnilingual-300M-ctc-int8 | hinglish | 75.8 | 80.7 | 87.4 | 87.0 | 20 |
| sherpa-onnx-omnilingual-300M-ctc-int8 | hinglish-hd | 35.6 | 46.7 | 62.2 | 61.1 | 10 |
| sherpa-onnx-omnilingual-300M-ctc-int8 | hinglish-hr | 106.8 | 106.8 | 106.8 | 106.8 | 10 |

### CER

| Engine | Language | clean | 20 dB | 10 dB | 5 dB | clips/cell |
| --- | --- | --- | --- | --- | --- | --- |
| faster-whisper-small-int8 | english | 2.1 | 2.2 | 6.2 | 7.1 | 20 |
| faster-whisper-small-int8 | hindi | 28.0 | 22.0 | 29.8 | 39.4 | 20 |
| faster-whisper-small-int8 | hinglish | 82.6 | 82.9 | 84.1 | 85.4 | 20 |
| faster-whisper-small-int8 | hinglish-hd | 48.5 | 48.8 | 50.9 | 55.2 | 10 |
| faster-whisper-small-int8 | hinglish-hr | 106.5 | 106.7 | 107.3 | 106.5 | 10 |
| faster-whisper-medium-int8 | english | 1.1 | n/a | 1.6 | n/a | 10 |
| faster-whisper-medium-int8 | hindi | 10.7 | n/a | 13.7 | n/a | 10 |
| faster-whisper-medium-int8 | hinglish | 88.7 | n/a | 87.0 | n/a | 10 |
| faster-whisper-medium-int8 | hinglish-hd | 45.1 | n/a | 46.3 | n/a | 5 |
| faster-whisper-medium-int8 | hinglish-hr | 117.5 | n/a | 113.8 | n/a | 5 |
| whisper.cpp-small-q5_1 | english | 1.3 | n/a | 4.0 | n/a | 10 |
| whisper.cpp-small-q5_1 | hindi | 16.8 | n/a | 20.6 | n/a | 10 |
| whisper.cpp-small-q5_1 | hinglish | 89.7 | n/a | 95.6 | n/a | 10 |
| whisper.cpp-small-q5_1 | hinglish-hd | 49.4 | n/a | 54.3 | n/a | 5 |
| whisper.cpp-small-q5_1 | hinglish-hr | 116.3 | n/a | 122.8 | n/a | 5 |
| sherpa-onnx-whisper-small-int8 | english | 2.1 | 2.5 | 5.6 | 9.3 | 20 |
| sherpa-onnx-whisper-small-int8 | hindi | 20.2 | 24.4 | 31.0 | 31.4 | 20 |
| sherpa-onnx-whisper-small-int8 | hinglish | 84.4 | 83.8 | 87.1 | 88.3 | 20 |
| sherpa-onnx-whisper-small-int8 | hinglish-hd | 52.0 | 50.6 | 61.3 | 64.0 | 10 |
| sherpa-onnx-whisper-small-int8 | hinglish-hr | 107.1 | 107.1 | 105.1 | 105.3 | 10 |
| sherpa-onnx-whisper-medium-int8 | english | 0.9 | n/a | 4.1 | n/a | 10 |
| sherpa-onnx-whisper-medium-int8 | hindi | 13.2 | n/a | 14.0 | n/a | 10 |
| sherpa-onnx-whisper-medium-int8 | hinglish | 86.5 | n/a | 85.5 | n/a | 10 |
| sherpa-onnx-whisper-medium-int8 | hinglish-hd | 43.8 | n/a | 46.3 | n/a | 5 |
| sherpa-onnx-whisper-medium-int8 | hinglish-hr | 114.6 | n/a | 111.4 | n/a | 5 |
| sherpa-onnx-omnilingual-300M-ctc-int8 | english | 7.9 | 8.3 | 10.9 | 17.4 | 20 |
| sherpa-onnx-omnilingual-300M-ctc-int8 | hindi | 10.1 | 21.6 | 31.4 | 41.2 | 20 |
| sherpa-onnx-omnilingual-300M-ctc-int8 | hinglish | 81.1 | 83.8 | 88.0 | 89.0 | 20 |
| sherpa-onnx-omnilingual-300M-ctc-int8 | hinglish-hd | 43.6 | 50.6 | 60.2 | 62.8 | 10 |
| sherpa-onnx-omnilingual-300M-ctc-int8 | hinglish-hr | 107.3 | 107.1 | 107.5 | 107.3 | 10 |

### Language identification (test split, auto-detect, all SNRs pooled)

| Engine | English as en | Hindi as hi | Hinglish clips: detected codes |
| --- | --- | --- | --- |
| faster-whisper-small-int8 | 100.0% | 88.8% | {'hi': 72, 'ur': 7, 'de': 1} |
| faster-whisper-medium-int8 | 100.0% | 100.0% | {'hi': 19, 'nn': 1} |
| whisper.cpp-small-q5_1 | 100.0% | 100.0% | {'hi': 17, 'ur': 3} |
| sherpa-onnx-whisper-small-int8 | 100.0% | 93.8% | {'hi': 73, 'ur': 6, 'de': 1} |
| sherpa-onnx-whisper-medium-int8 | 100.0% | 100.0% | {'hi': 18, 'en': 1, 'ur': 1} |
| sherpa-onnx-omnilingual-300M-ctc-int8 | n/a (no language reported) | n/a (no language reported) | {'none': 80} |

### Determinism (two runs, same settings, first 40 clips)

| Engine | Identical text and language |
| --- | --- |
| faster-whisper-small-int8 | 40 of 40 |
| faster-whisper-medium-int8 | 12 of 12 |
| whisper.cpp-small-q5_1 | 12 of 12 |
| sherpa-onnx-whisper-small-int8 | 40 of 40 |
| sherpa-onnx-whisper-medium-int8 | 12 of 12 |
| sherpa-onnx-omnilingual-300M-ctc-int8 | 40 of 40 |

## STT resources (1 CPU, container; limits in the README)

| Engine | Disk MiB | Load s | RTF (median of 3) | CPU s per audio hour | Anon after load MiB | memory.peak MiB | Anon max MiB | Long file: wall / RTF | Long file anon first / last third MiB | 512 MiB container |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Diarization (test split; 250 ms collar; overlaps scored; percent)

### DER by speaker count, dev-tuned clustering threshold

| Candidate | Speakers | Conversations | DER | Missed | False alarm | Confusion | Speaker count exact | Mean detected |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| campplus | 2 | 3 | 14.7 | 0.0 | 0.4 | 14.3 | 1/3 | 4.0 |
| campplus | 3 | 3 | 21.4 | 0.6 | 0.4 | 20.4 | 1/3 | 6.0 |
| campplus | 4 | 3 | 6.1 | 0.6 | 0.7 | 4.8 | 1/3 | 7.0 |

### DER by speaker count, oracle speaker count

| Candidate | Speakers | Conversations | DER | Missed | False alarm | Confusion | Speaker count exact | Mean detected |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| campplus | 2 | 2 | 3.1 | 0.0 | 0.3 | 2.8 | 2/2 | 2.0 |
| campplus | 3 | 2 | 2.8 | 1.5 | 0.1 | 1.2 | 2/2 | 3.0 |
| campplus | 4 | 2 | 3.1 | 0.7 | 1.8 | 0.6 | 2/2 | 4.0 |

### Diarization resources (1 CPU)

| Candidate | Disk MiB | Load s | RTF (median of 3, 5 min file) | CPU s per audio hour | Long file: wall / RTF | Long file DER | Long file anon max MiB | memory.peak MiB | 512 MiB container |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |

### Script of Hinglish output (clean, common clips): share of Devanagari among letters

| Engine | Devanagari-mixed Hinglish (hd) | Romanised Hinglish (hr) |
| --- | --- | --- |
| faster-whisper-small-int8 | 100% (reference 54%) | 80% (reference 0%) |
| faster-whisper-medium-int8 | 100% (reference 54%) | 100% (reference 0%) |
| whisper.cpp-small-q5_1 | 100% (reference 54%) | 80% (reference 0%) |
| sherpa-onnx-whisper-small-int8 | 99% (reference 54%) | 100% (reference 0%) |
| sherpa-onnx-whisper-medium-int8 | 100% (reference 54%) | 100% (reference 0%) |
| sherpa-onnx-omnilingual-300M-ctc-int8 | 99% (reference 54%) | 95% (reference 0%) |

### Code-switch examples (synthetic text, clean, first clips of each Hinglish kind)

- `fw-small` hd ref: कृपया report कल तक email कर दीजिए।  
  hyp: क्रिप्या रेपोट कल तक इमेल कर दीजे
- `fw-small` hd ref: इस presentation में तीन slides और जोड़नी होंगी।  
  hyp: इस प्रेज़न्तेशन में तीन स्लाइप्स और जोरनी होंगी
- `fw-small` hr ref: kal subah ki meeting ke liye agenda share kar dena.  
  hyp: कल सुबा की मीٹिंके लिए प्यर ख्लोएस खर्मल पी सहेसिं पश्चमी अफरीकी रेंदेने वियन लियोनी देना
- `fw-small` hr ref: mujhe lagta hai ki yeh plan thoda mushkil hai lekin try karna chahiye.  
  hyp: मुझे लगता है कि ये प्लान थोडा मुष्किल है लेकिन त्रीकान चाहिये

- `fw-medium` hd ref: कृपया report कल तक email कर दीजिए।  
  hyp: क्रिप्या रिपोर्ट कल तक इमेल कर दिजी
- `fw-medium` hd ref: इस presentation में तीन slides और जोड़नी होंगी।  
  hyp: इस प्रेसंटेशन में तीन स्लाइड्स और जोनी होंगी।
- `fw-medium` hr ref: kal subah ki meeting ke liye agenda share kar dena.  
  hyp: कल सुबा की मीटिंग के लिए प्यर्ट्लोईस्थर्मल्प्पी सहिसिंग पर्ष्चमी अफ्रीकी रेंडिनिवियन लियोनी देना
- `fw-medium` hr ref: mujhe lagta hai ki yeh plan thoda mushkil hai lekin try karna chahiye.  
  hyp: मुझे लगता है कि ये प्लान थोड़ा मुश्किल है लेकिन ट्राइकान चाहिये

- `cpp-small` hd ref: कृपया report कल तक email कर दीजिए।  
  hyp: क्रिप्या रिपोट कल तक ये मेल कर दीजे.
- `cpp-small` hd ref: इस presentation में तीन slides और जोड़नी होंगी।  
  hyp: इस प्रज्द्टेशन में तींश श़्ाएप्स और जोर्नी होंगी.
- `cpp-small` hr ref: kal subah ki meeting ke liye agenda share kar dena.  
  hyp: कल सुबा की मीٹिंके लिए प्यर ख्लोएस खर्मल पी सहेसिंग पश्च्च्टिमी अफ्रीकी रेंदेने वियन लियोनी देना
- `cpp-small` hr ref: mujhe lagta hai ki yeh plan thoda mushkil hai lekin try karna chahiye.  
  hyp: मुझे लगता है कि ये प्लान थोडा मुष्किल है लेकिन त्रीकान चाहिये

- `sherpa-small` hd ref: कृपया report कल तक email कर दीजिए।  
  hyp: क्रिप्या रेपोट कल तक एमेल कर दीजे.
- `sherpa-small` hd ref: इस presentation में तीन slides और जोड़नी होंगी।  
  hyp: इस प्रेज़न्तेशन में तीं स्लाइप्स और जोरनी होंगी.
- `sherpa-small` hr ref: kal subah ki meeting ke liye agenda share kar dena.  
  hyp: कल सुबाकी मीٹिंके लिए प्यर ख्लोएस खर्मल प्यश्यहसिं पश्च्च्मी अफ्रीकी रेंदेने वियन लियोनी द
- `sherpa-small` hr ref: mujhe lagta hai ki yeh plan thoda mushkil hai lekin try karna chahiye.  
  hyp: मुझे लगता है कि ये प्लान थोडा मुष्किल है लेकिन त्रीकान चाहिये

- `sherpa-medium` hd ref: कृपया report कल तक email कर दीजिए।  
  hyp: क्रिप्या रिपोट कल तक इमेल कर दिजि
- `sherpa-medium` hd ref: इस presentation में तीन slides और जोड़नी होंगी।  
  hyp: इस प्रेसंटेशन में तीन स्लाइज़् और जोनी होंगी
- `sherpa-medium` hr ref: kal subah ki meeting ke liye agenda share kar dena.  
  hyp: कल सुबा की मीटिंग के लिए प्यर्ट्लोईस्त्रमल्प्पी सहिसिंग पर्ष्चमी अफ्रीकी रंडिनिवियन लियो
- `sherpa-medium` hr ref: mujhe lagta hai ki yeh plan thoda mushkil hai lekin try karna chahiye.  
  hyp: मुझे लगता है कि ये प्लान थोड़ा मुषकिल है लेकिन ट्राइकान चाहिये

- `omni-300m` hd ref: कृपया report कल तक email कर दीजिए।  
  hyp: कृतિयार रिपોर્ट कल तक एमेल करदीજिए
- `omni-300m` hd ref: इस presentation में तीन slides और जोड़नी होंगी।  
  hyp: इस प्रेजेंटेशन में तीन स्लाइबस और जोर्नी होंगी
- `omni-300m` hr ref: kal subah ki meeting ke liye agenda share kar dena.  
  hyp: कल सुबा की मीटिंग के लिए पिर क्लोएस्थर्मल पी सहेसिंग पश्चिमी अफ्रीकी रेंडनेवियन लियोनी देना
- `omni-300m` hr ref: mujhe lagta hai ki yeh plan thoda mushkil hai lekin try karna chahiye.  
  hyp: मुझे लगता है कि यह प्लैन थोड़ा मुश्किल है लेकिन ट्रायकान चाहिए

<!-- END:tables -->

## Observations (measured; not a recommendation)

- Whisper-family models detect English as `en` and most Hindi clips as `hi`; Hinglish clips are mostly `hi` with some `ur`. Omnilingual reports no language.
- English WER on clean synthetic speech is 1.5-4% for the Whisper models and about 22-24% for Omnilingual CTC (no casing/punctuation, character-level slips). Medium models are better than small on Hindi CER on this subset; differences between small variants are within a few points.
- All engines write Hinglish in Devanagari (see the script table), so romanised Hinglish scores at or above 100% by construction (no transliteration was applied).
- Diarization (campplus): with the dev-tuned threshold 0.6 the speaker count is wrong on most 5-10 minute conversations (over-clustering, 4-9 speakers detected), while with the true speaker count DER is 2.8-3.1%. Overlaps in this corpus are rare (under 1% of scored reference speech), so overlap handling is barely tested.
- PyAV (a hard faster-whisper dependency) bundles GPL codecs (libx264, libx265): licence review needed before faster-whisper could enter the runtime image (DEPENDENCIES.md).
- sherpa-onnx Whisper truncates Hindi at its default token cap (6 tokens/s); the benchmark sets 15.

## Exclusions

Full list with reasons in `DEPENDENCIES.md` ("Excluded candidates"): `pyannote.audio` (needs PyTorch and gated
pipelines), AI4Bharat IndicConformer / IndicWhisper and other NeMo/PyTorch-only Indic models, Whisper large-v3 / turbo
(scope and memory), Dolphin (not assessed), any account-gated or click-through model. The optional "simple energy/embedding
baseline" for diarization was not built: it would measure the harness, not a candidate.

## Limitations

- **Synthetic TTS is not speech.** One clean, evenly paced voice per utterance; no accents beyond the TTS voice, no
  disfluency, overlap in real prosody, reverberation, telephone codecs or far-field noise. Whisper-family models may be
  advantaged on TTS (very regular acoustics) or disadvantaged on the Hindi voice; no claim is made about real accuracy.
- **Small samples.** 20 sentences per language (about 240 words English), 10 per Hinglish kind; the "headline" subset of
  the medium models has clean and 10 dB only. A single sentence moves a cell by one or two points. No confidence
  intervals were computed.
- **Hinglish references fix a script.** The Devanagari-mixed sentences are scored against Devanagari-with-Latin-words
  references and the romanised ones against Latin references, with no transliteration. Whisper-family models and
  Omnilingual write Hindi-sounding speech in Devanagari, so the romanised set scores near or above 100% by construction
  (WER above 100% is possible because insertions count). That is a real property of the engines (they do not choose a
  Latin script for romanised Hinglish) but it also measures a spelling convention; a downstream normalisation or
  transliteration step would change the numbers. The Devanagari-mixed Hinglish score also depends on whether an engine
  writes the English loanwords in Latin or Devanagari script.
- **Hindi spelling variation.** Devanagari has many acceptable spellings (nasal marks, nukta, conjuncts); WER/CER
  against one reference overstates the real error.
- **Numerals and casing** are not normalised beyond the rule above.
- **Language ID** is only meaningful for the Whisper family; Omnilingual (CTC) reports none. `ur` for Hindi speech is a
  known Whisper confusion (same spoken language); it counts as a miss.
- **Diarization voices are few and TTS voices are acoustically simple.** Only seven voices exist on the host (three of
  them en_IN voices that sound alike, one Hindi voice), so 2-4 speaker sets share voices across conversations; the
  embedding models were trained on English or Chinese celebrity speech, not on Hindi. Overlaps are 0.3-1.0 s; real
  overlap is more frequent and longer. The clustering threshold was tuned on three 2-minute dev conversations.
- **Speed numbers are for this machine only**: Apple M1 through Docker Desktop's Linux VM (3.8 GiB, 8 CPUs, efficiency
  and performance cores), the pinned pip wheels (the whisper.cpp wheel lacks dot-product kernels), `--cpus 1`. A
  production Graviton or x86 task will differ. STT accuracy runs used 4 threads and ran in parallel with other jobs; their
  wall times are not used. Resource runs ran alone, one container at a time.
- **Long-file runs are budgeted.** STT long-file runs are capped at 15 minutes of wall time per engine (the processed
  audio length is in the table); the diarization long run is the full 60 minutes. Streaming is naive fixed 30 s windows
  without VAD or overlap, so words at window edges are split; the long-file result is about speed, memory and
  completion, not accuracy.
- **Provenance of the corpus manifest.** Reference text is not in the committed manifests (only sentence IDs and
  hashes); the sentence list is in `services/audio/benchmarks/vad/vadbench/sentences.py`.
- **Not tested**: streaming/partial results, word timestamps, diarization jointly with transcription, GPU, more than
  one concurrent job per container, models beyond those listed.

## Reproducing and checks

- `uv run --directory services/audio --no-dev python benchmarks/stt/run.py check-runtime` builds the default `runtime`
  image and fails if any benchmark package is installed in it (result in `.local-benchmarks/stt-results/runtime-image-check.json`).
- Metric self-checks: `uv run --directory services/audio pytest benchmarks/stt/test_metrics.py` (not part of
  `pnpm audio:test`, whose `testpaths` is `tests`).
- `docker build --target phase2c-benchmark` is the only stage that installs the benchmark groups; `runtime` and `test`
  stages are unchanged and Compose still builds `runtime`.

## STATUS OF THIS REPORT (historical, 2026-11-24; superseded)

**Superseded on 2026-11-25.** The runs below completed, `run.py report` was re-run, and the tables above now include
the resources.

- **The "60 s short file":** `rtf-mixed.wav` is 161.85 s long. The RTF pass measures its first 60 s
  (`RTF_AUDIO_S = 60.0`). The Method's "3 min" describes the file, not the measured part.
- **`check-runtime`:** pywhispercpp and sherpa-onnx are now *runtime* dependencies of the selected providers. The check
  still fails if any *benchmark-only* package (`BENCHMARK_PACKAGES`) is found in the runtime image.


Evidence section dated 2026-11-24. No provider is selected; OD-02b and OD-03b stay the user's decision.

**Measured and in the accuracy tables:** STT accuracy for six of seven engines (faster-whisper small/medium, whisper.cpp small, sherpa-onnx Whisper small/medium, Omnilingual 300M), two runs each for determinism; diarization tuning for both embeddings; diarization evaluation for `campplus` only.

**Failed, not measured:** whisper.cpp medium accuracy and the `wespeaker` diarization evaluation. The background queue ran the resource runs (completed 2026-11-22 to 2026-11-23, `.local-benchmarks/res-all2.log`). At 13:52 on 2026-11-23 the Docker daemon stopped ("failed to connect to the docker API") and these two accuracy runs failed. The log nevertheless prints `ACC-DONE cpp-medium`, `ACC-DONE diar-wespeaker` and `ALL-DONE`. **Those lines are not successes**: the queue script printed DONE regardless of exit status (the script is not in the repository). There is no accuracy result for either run.

**Resource results are not in `results.json` or the tables above.** `results.json` still has `resources_main`, `resources_512m` and `feasibility_512m` as null for every engine, because `run.py report` was not re-run. The resource tables above (sections with RTF and memory columns) are therefore empty or stale. Read the tables below instead.

### Recorded resource results (raw, from `.local-benchmarks`; not regenerated into `results.json`)

Settings, from the raw files: 1 thread (`BENCH_THREADS=1`), `--cpus 1` (cgroup `cpu.max` 100000 100000), main run memory limit 3 GiB (3221225472 bytes), 512 MB run limit 536870912 bytes. Host as described under "Resource measurement": Docker Desktop Linux VM on an Apple M1, 3.8 GiB VM memory, 8 CPUs. **RTF is wall time over audio time** (see "Resource measurement"), so **RTF above 1 means slower than real time** on these settings. Absolute speeds differ from a production AWS task.

STT, short file: the raw `short.audio_s` is 60.0 s for every engine (the Method section describes `rtf-mixed.wav` as 3 min; the raw files record 60.0 s). RTF is the median of 3 passes (`short.rtf_median`). Peak memory is `memory_peak_mib` (includes page cache); anon max is `anon_max_mib`. Source files: `.local-benchmarks/stt-results/resources-<id>-main.json`.

| Engine | Load s | RTF (short, median of 3) | memory.peak MiB | Anon max MiB |
| --- | --- | --- | --- | --- |
| `fw-small` | 2.09 | 1.05 | 1884.6 | 1282.3 |
| `fw-medium` | 7.31 | 3.06 | 3072.0 | 2799.0 |
| `cpp-small` | 0.57 | 2.84 | 802.5 | 606.5 |
| `cpp-medium` | 1.80 | 7.53 | 1485.6 | 950.1 |
| `sherpa-small` | 1.95 | 0.99 | 1712.8 | 1334.1 |
| `sherpa-medium` | 6.65 | 4.23 | 3072.0 | 2991.9 |
| `omni-300m` | 2.19 | 1.31 | 1732.6 | 1363.8 |

Peak memory 3072.0 MiB equals the 3 GiB limit.

STT, long file (`file_audio_s` 3648.73 s). The long run is a wall-time-budgeted prefix (`evaluate.py`, `budget_s` 420.0 divided by the short RTF), so only part of the file was processed (`long.audio_s`). RTF is a single pass. It does not cover the full file.

| Engine | Audio processed s | Long RTF | Long wall s |
| --- | --- | --- | --- |
| `fw-small` | 400.4 | 1.91 | 764.7 |
| `fw-medium` | 137.5 | 7.33 | 1007.9 |
| `cpp-small` | 148.1 | 4.19 | 620.6 |
| `cpp-medium` | 55.8 | 8.52 | 475.3 |
| `sherpa-small` | 424.2 | 1.52 | 646.3 |
| `sherpa-medium` | 99.2 | 7.41 | 735.3 |
| `omni-300m` | 321.1 | 1.30 | 417.5 |

Diarization (source: `.local-benchmarks/diar-results/diar-resources-<candidate>-main.json` and `-512m.json`), short file 302.05 s, 1 thread:

| Run | Completed | RTF (short) | memory.peak MiB | Anon max MiB | Long file |
| --- | --- | --- | --- | --- | --- |
| `campplus`, 3 GiB | true | 1.14 (median of 3) | 1684.2 | 577.9 | 3600.0 s, RTF 1.24, wall 4469.6 s, DER 0.2518, 21 hypothesised speakers, anon max 423.0 MiB |
| `campplus`, 512 MB | true | 1.13 (1 pass) | 277.0 | 230.7 | none (`long` null) |
| `wespeaker`, 3 GiB | **false** | 3.27 (median of 3) | not recorded | not recorded | none (`long` null) |

The `wespeaker` resource run is incomplete (`completed` false), and its accuracy evaluation failed (no result).

### 512 MB feasibility (raw, `feasibility-<id>.json`)

| Candidate | Exit code | OOM-killed |
| --- | --- | --- |
| `cpp-small` | 0 | false |
| `campplus` | 0 | false |
| `fw-small`, `fw-medium`, `sherpa-small`, `sherpa-medium`, `omni-300m`, `cpp-medium` | 137 | true |
| `wespeaker` | 1 | false (the run failed, not an OOM kill; it ran when Docker stopped) |

Recorded 512 MB runs: `cpp-small` (60.0 s file, RTF 2.96 in one pass, memory.peak 512.0 MiB, anon max 405.0 MiB) and `campplus` (row above).

**Limitation:** every feasibility file has `long_minutes_in_512m_run` 0, so no long file was processed under 512 MB. "Fits in 512 MB" here means the short file completed, nothing more. `cpp-small` peaked at 512.0 MiB, the limit, because `memory.peak` includes page cache; the anon maximum was 405.0 MiB.

**Hardware constraint:** all runs are on an M1 with 8 GB, inside a 3.8 GiB Docker VM. Speeds and memory on production hardware will differ.

### Remaining steps (historical; all done 2026-11-25)

1. Restart Docker and re-run whisper.cpp medium accuracy and the `wespeaker` diarization evaluation; check each exit status and the result file (do not rely on `ACC-DONE`).
2. Re-run the `wespeaker` resource run if it should be complete.
3. Run `run.py report` to fold the raw resource results into `results.json` and the tables, and replace this section.
4. Review the regenerated report; the provider decision (OD-02b, OD-03b) is then the user's.
