import {
  AudioTranscribeConfig,
  AudioTranscribeResult,
  type AudioVadSettings,
  type SpeechToTextProvider,
  type SttRequest,
  type SttSegment,
} from '@vip/contracts';
import { z } from 'zod';
import { runAudioTask, type AudioTaskDeps } from '../audio-task';
import { ProviderError } from '../errors';
import type { RawStore } from '../raw-store';

export const WHISPER_CPP_PROVIDER_ID = 'whisper-cpp';
export const WHISPER_CPP_MODEL = 'ggml-small-q5_1';

/**
 * Stored raw payload: the audio-service task config as sent and its result, verbatim. The engine
 * and model identity inside `result` make the payload self-describing, so an adopted object from a
 * different model is refused instead of being labelled with the current one.
 */
const RawPayload = z
  .object({
    schema: z.literal('audio-service-transcribe-v1'),
    request: AudioTranscribeConfig,
    result: AudioTranscribeResult,
  })
  .strict();

/** Non-speech markers whisper.cpp emits as text, e.g. `[BLANK_AUDIO]`, `(music)`. Kept in the raw output, not mapped. */
const NON_SPEECH = /^\s*[[(][^\])]{1,40}[\])]\s*$/;

/**
 * Self-hosted speech-to-text (OD-02b, ADR-0036): Whisper small (whisper.cpp, ggml q5_1) running in
 * the audio service (ADR-0002) on one window of the preprocessing version's canonical audio.
 * Inside each window the service finds speech spans (Silero VAD, ADR-0038) and decodes each with its
 * own language, `en` or `hi`; code switching inside one span is not detected (a Hinglish span is
 * decoded as one of the two). Confidence is not reported: the engine's token probability is kept in
 * the raw output but is not a calibrated confidence.
 */
export class WhisperCppSttProvider implements SpeechToTextProvider {
  readonly id = WHISPER_CPP_PROVIDER_ID;
  readonly model = WHISPER_CPP_MODEL;

  constructor(
    private readonly store: RawStore,
    private readonly deps: AudioTaskDeps,
    private readonly vad: AudioVadSettings,
  ) {}

  capabilities() {
    return {
      languages: ['en' as const, 'hi' as const],
      codeSwitching: false,
      wordTimestamps: false,
      diarization: false,
      maxInputSeconds: 30,
      fake: false,
    };
  }

  async transcribe(req: SttRequest) {
    const config: AudioTranscribeConfig = {
      schemaVersion: 1,
      engine: 'whisper-cpp',
      window: { startMs: req.window.startMs, endMs: req.window.endMs },
      audioDurationMs: req.audioDurationMs,
      vad: this.vad,
      ...(req.languageHints?.length ? { languageHints: req.languageHints } : {}),
    };
    const result = await runAudioTask(this.deps, 'transcribe', req.source, config);
    const payload = { schema: 'audio-service-transcribe-v1', request: config, result };
    if (!RawPayload.safeParse(payload).success) {
      throw new ProviderError('PROVIDER_OUTPUT_INVALID', false);
    }
    const stored = await this.store.put(req.rawKey, payload); // verbatim, before mapping (ADR-0007)
    return {
      raw: { payloadUri: stored.uri, sha256: stored.sha256, providerModel: this.model },
      segments: this.mapRaw(payload, req),
    };
  }

  mapRaw(payload: unknown, req: SttRequest): SttSegment[] {
    const parsed = RawPayload.safeParse(payload);
    if (!parsed.success) throw new ProviderError('RAW_OUTPUT_INVALID', false);
    const { request, result } = parsed.data;
    if (result.engine.model !== this.model) throw new ProviderError('RAW_OUTPUT_CONFLICT', false);
    if (
      request.window.startMs !== req.window.startMs ||
      request.window.endMs !== req.window.endMs
    ) {
      throw new ProviderError('RAW_OUTPUT_CONFLICT', false);
    }
    return result.segments
      .filter((s) => s.text.trim().length > 0 && !NON_SPEECH.test(s.text))
      .map((s) => ({
        startMs: s.startMs,
        endMs: s.endMs,
        text: s.text,
        language: s.language,
      }));
  }
}
