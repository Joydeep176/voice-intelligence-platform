# ADR-0038: Silero VAD, used to split transcription windows into speech spans

- Status: Accepted (user-authorised resolution, 2026-11-24)
- Date: 2026-11-24
- Resolves: OD-29
- Affects: `services/audio` (`domain/transcribe.py`, `domain/inference_models.py`), LLD §3.2 and §4 step 5,
  `packages/contracts` (`AudioTranscribeConfig.vad`, `AudioTranscribeResult.spans`), orchestrator config
  (`STT_VAD_*`), `.claude/rules/python-audio.md`

## Context

OD-29 asked which VAD to use. The Phase 2B benchmark (`docs/development/phase2b-vad-benchmark/`) measured Silero
(ONNX), WebRTC VAD and a NumPy baseline on a synthetic en/hi/Hinglish corpus. Only Silero met every plan §13.4
criterion: F1 0.945 / 0.942 at 10 / 5 dB, FPR 0.057, RTF 0.017, 52 MiB anonymous memory, MIT licence. The tuned
setting is threshold 0.4 (dev split), with minimum silence 300 ms, minimum speech 250 ms and padding 200 ms.

Phase 2C closure found the decisive reason to use it. Whisper decodes **one language per pass**. On a 30 s window
of the C3 corpus where two English speakers and a Hindi speaker alternate (`test-4spk-b-5min`, 58–88 s):

- forced `hi`, whisper.cpp returned one wrong segment at 58–62 s and nothing else;
- forced `en`, it *translated* the Hindi speech into English text.

Split at speech pauses, every span was detected correctly (en 0.97 / 0.96 / 0.95, hi 0.92 / 0.88) and transcribed
in the right script. Evidence: `docs/development/phase2c-provider-validation/README.md`.

## Options considered

1. **Silero VAD inside the `transcribe` task, through sherpa-onnx.** sherpa-onnx is already the selected
   diarization runtime (ADR-0037), so this needs no new Python package, only the pinned 2.3 MB model.
2. **Silero VAD in preprocessing**, emitting `audio_segments` used as transcription windows (D-2C-02's VAD path).
   This works at the pipeline level, but it changes the accepted Phase 2B preprocessing contract and output. Its
   segmentation merges speech up to 30 s, so a segment can still mix speakers and languages.
3. **No VAD (fixed 30 s windows).** Measured to mistranscribe mixed-language conversation. Rejected.
4. **WebRTC VAD / NumPy baseline.** Each failed at least one §13.4 criterion. Rejected.

## Decision

Option 1. **Silero VAD v6.2.3** (`snakers4/silero-vad` @ `5cd79456…`, MIT, SHA-256 `1a153a22…88e3`, the Phase 2B
pin) runs in the audio service's `transcribe` task through sherpa-onnx 2.0.2:

- Settings: threshold 0.4, minimum silence 300 ms, minimum speech 250 ms (the Phase 2B tuned values), and maximum
  span 29 s (Whisper's limit).
- Each span is padded by 200 ms, clipped to the window, and spans that then touch are joined up to 29 s.
- Each span is decoded on its own, with its own detected language (`en` or `hi`).
- The VAD runs and is released before whisper is loaded; no speech means no whisper call.
- Settings come from the orchestrator config (`STT_VAD_*`), are validated at startup and are sent with every task.
  The VAD model identity and settings are recorded in the raw output.

Preprocessing keeps VAD method `none`: its segment output is not needed for transcription and stays a
configuration option for later.

## Consequences

- Correct per-span language for mixed en/hi conversation, at a cost: each span costs one language-detection pass
  and one decode pass. Measured RTF: macOS host, one thread, 0.16 → 0.33 for the four spans of the test window;
  Docker 1 CPU, see ADR-0036.
- A span that itself switches language (true intra-sentence Hinglish) is still decoded as one language.
- Silero accuracy evidence is synthetic speech only (OD-18).
- `tests/test_architecture_extra.py` now asserts that the VAD is used only by `transcribe`, through sherpa-onnx, and
  that preprocessing registers no detector.
