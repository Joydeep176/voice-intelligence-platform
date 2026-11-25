# ADR-0036: Self-hosted STT: whisper.cpp small q5_1 with per-span language

- Status: Accepted (selection delegated by the user, 2026-11-24). Compute sizing amended by ADR-0041 (accepted). The accuracy threshold (SRS NFR-3) is undecided: a deferral is proposed in ADR-0042, awaiting the user's decision.
- Date: 2026-11-24 (selection); written 2026-11-25 with the validation evidence
- Resolves: OD-02b (HLD §10)
- Affects: `services/audio` (`domain/transcribe.py`, `inference_models.py`, `isolation.py`, `inference_child.py`),
  `apps/orchestrator/src/providers/stt/whisper-cpp.ts`, `infra/docker/compose.yaml`, LLD §3.1 / §4, DEPLOYMENT_ARCHITECTURE

## Context

- **The rule:** STT goes through adapters, with fakes until a provider is selected by benchmark (SRS C-3, ADR-0012).
- **ADR-0034:** no paid API, service or dependency; local open-source models on an Apple M1 with 8 GB.
- **Requirements:**
  - FR-4.1: timestamps.
  - FR-4.2 / FR-4.3: language and code-switching preserved as produced.
  - FR-4.4: immutable raw output.
  - FR-4.8: providers selected by configuration.
  - NFR-6: a provider swap needs no domain-code change.
- **Hand-off:** on 2026-11-24 the user delegated the OD-02b selection, on the evidence, to the closure work.

## Options considered

All options were measured in C3 (`docs/development/phase2c-stt-benchmark/`) on a synthetic TTS corpus (ADR-0004):
English, Hindi and Hinglish, clean and 20 / 10 / 5 dB SNR, 240 test clips. Memory figures are from the C3 resource
runs.

| Candidate (licence) | Fits the audio service? | Notes |
| --- | --- | --- |
| **whisper.cpp small q5_1 (MIT)** | **Yes.** Anonymous peak 607 MiB single-pass at 3 GiB; completed in 512 MiB | Native LID, Devanagari output |
| whisper.cpp medium q5_0 | No: anonymous 950 MiB, OOM at 512 MiB | Best English and Hindi WER, about 2.7× the CPU |
| faster-whisper small / medium int8 | No: anonymous 1.28 / 2.8 GiB | OOM at 512 MiB |
| sherpa-onnx Whisper small / medium int8 | No: anonymous 1.33 / 2.99 GiB | OOM at 512 MiB |
| sherpa-onnx omnilingual 300M CTC | No: anonymous 1.36 GiB | No language ID; English WER 21.5 % clean |

## Decision

**Whisper small (ggml q5_1) through whisper.cpp 1.8.5, via pywhispercpp 1.5.1 (MIT), in the audio service's
`transcribe` task.**

- **Model:** pinned file `ggml-small-q5_1.bin`, SHA-256 `ae85e4a9…11bb`.
  - Mounted read-only from a named volume and verified at startup.
  - Never downloaded at runtime.
- **Pipeline per 30 s window (ADR-0039):**
  - Silero VAD speech spans (ADR-0038).
  - Each span gets its own language from `auto_detect_language`. Choices are restricted to `en` / `hi`; Urdu
    probability counts towards Hindi; language hints are honoured.
  - Each span is decoded in that language with `no_context`.
  - Per-span detection is what keeps code-switching. One language per 30 s pass gave wrong or *translated* Hindi on
    mixed windows.
- **Isolation:**
  - Inference runs in a child process through `SandboxRunner`: Landlock read/execute limited to the system paths,
    the venv and `/models`; rlimits (CPU, FSIZE=0, NOFILE 64, CORE 0); a fixed environment without the service token.
  - The canonical WAV arrives as an inherited, already checked descriptor.
  - This keeps the HTTP loop responsive, because pywhispercpp holds the GIL.
- **Compute:** 2 CPUs and 2 threads (ADR-0041). The deadline is 120 s + 4 × audio per task (ADR-0039).
- **Selection:** `STT_PROVIDER=whisper-cpp`. The fake adapter stays for development and tests (OD-02a).

## Evidence

**Accuracy of the production path (E7, the full-context variant; 240 C3 test clips; WER / CER, percent).**

| Language | clean | 20 dB | 10 dB | 5 dB | all |
| --- | --- | --- | --- | --- | --- |
| English | 6.7 / 4.7 | 7.5 / 4.8 | 12.6 / 7.7 | 15.4 / 11.9 | 10.5 / 7.3 |
| Hindi | 46.9 / 23.9 | 48.8 / 22.6 | 47.8 / 23.2 | 51.2 / 24.7 | 48.7 / 23.6 |
| Hinglish | 81.2 / 82.5 | 83.6 / 82.2 | 84.5 / 81.6 | 87.0 / 85.6 | 84.1 / 83.0 |

- **Hinglish by reference script:**
  - Devanagari-mixed references (hd): WER 52.2 %.
  - Romanised references (hr): WER 108.6 %. The engine writes Devanagari and no transliteration is applied, so above
    100 % is expected by construction.
- **Language ID** (majority per clip):
  - English: `en` 77 of 80 (3 clips without detected speech).
  - Hindi: `hi` 80 of 80.
  - Hinglish: `hi` 78, `en` 2.
- E7 ran with 4 threads. The thread count does not change the algorithm.
- Source: `docs/development/phase2c-provider-validation/stt-speed-2026-11-24/e7-audio-ctx-accuracy-2026-11-25.log`.

**C3 single-pass benchmark** (common 60-clip subset, clean / 10 dB): English WER 3.1 / 9.2 %, Hindi CER 16.8 / 20.6 %,
Hinglish WER 84.2 / 92.1 %. Source: `phase2c-stt-benchmark/results-tables.md`.

**Real service** (768 MB, 2 CPUs, Landlock enforced; synthetic 90 s English/Hindi clip):
- All 3 windows succeeded: 113.7 / 115.9 / 148.1 s against a 240 s deadline.
- Languages `en` / `en` / `en` + `hi`.
- Peak `memory.peak` 574 MiB, 0 of 846 liveness probes failed.
- Source: `stt-speed-2026-11-24/real-check-2cpu-2026-11-25.json`.

**Browser end-to-end with the real providers** (2026-11-25):
- The run snapshot reports `whisper-cpp` / `sherpa-onnx` with `fake: false`.
- 90 s English/Hindi clip: 17 segments (15 `en`, 2 `hi` in Devanagari), 4 speakers.
- 33 s Hinglish clip: 7 segments, all `hi`.
- The transcript persisted across a reload; another workspace gets 404.
- Source: `docs/development/phase2c-provider-validation/e2e-real-providers-2026-11-25/`.

## Consequences and limitations

- **Accuracy thresholds:** NFR-3 is undecided (deferral proposed in ADR-0042, awaiting the user's decision). This ADR reports the measured baseline and sets no
  threshold.
- **Hindi WER** is high (about 49 %) and its CER is about 24 %. Hinglish output is Devanagari-only:
  - English words inside Hindi are transliterated.
  - A span is labelled `en` or `hi`, never `mixed`.
  - Segment-level `mixed` labelling and code-switch spans (FR-4.2) are the Transcription Agent's job, in the agent
    phase.
- **Window boundaries:** stitching works per segment (midpoint ownership), so words in the 1 s window overlap can
  appear twice. Word-level stitching needs word timestamps, which this adapter does not request.
- **Speed and deadline:** cost scales with the number of speech spans: about 2 encoder passes per span, roughly
  13.5 s per pass at 2 CPUs. A 30 s window with more than about 8 spans can exceed its 240 s deadline. Investigation
  and handling: ADR-0041 and the Phase 2B/2C acceptance report.
- **Rejected speed-up:** a decode `audio_ctx` sized to the span failed the accuracy gate (E7) and is rejected.
- **Corpus:** synthetic TTS only. Accuracy on real speech is unmeasured.
