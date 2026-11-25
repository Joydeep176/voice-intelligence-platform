import type { AudioVadSettings, DiarizationProvider, SpeechToTextProvider } from '@vip/contracts';
import type { DiarizationSettings } from '../config';
import type { AudioTaskDeps } from './audio-task';
import { FakeDiarizationProvider } from './diarization/fake';
import { SherpaOnnxDiarizationProvider } from './diarization/sherpa-onnx';
import { UnknownProviderError } from './errors';
import type { RawStore } from './raw-store';
import { FakeSttProvider } from './stt/fake';
import { WhisperCppSttProvider } from './stt/whisper-cpp';

export interface ResolvedProviders {
  stt: SpeechToTextProvider;
  diarization: DiarizationProvider;
}

/** What the self-hosted adapters need (the fakes need only the store). */
export interface ProviderDeps {
  audio: AudioTaskDeps;
  diarization: DiarizationSettings;
  vad: AudioVadSettings;
}

const STT: Record<string, (store: RawStore, deps: ProviderDeps) => SpeechToTextProvider> = {
  fake: (store) => new FakeSttProvider(store),
  'whisper-cpp': (store, deps) => new WhisperCppSttProvider(store, deps.audio, deps.vad),
};
const DIARIZATION: Record<string, (store: RawStore, deps: ProviderDeps) => DiarizationProvider> = {
  fake: (store) => new FakeDiarizationProvider(store),
  'sherpa-onnx': (store, deps) =>
    new SherpaOnnxDiarizationProvider(store, deps.audio, deps.diarization),
};

export const STT_PROVIDER_KEYS = Object.keys(STT);
export const DIARIZATION_PROVIDER_KEYS = Object.keys(DIARIZATION);

/**
 * Adapters by config key (ADR-0012). `fake` stays for development and tests; `whisper-cpp`
 * (ADR-0036) and `sherpa-onnx` (ADR-0037) are the selected self-hosted providers. An unknown key
 * throws, which stops the run workers at startup instead of failing every run later.
 */
export function assertKnownProviders(keys: { sttProvider: string; diarizationProvider: string }) {
  const stt = Object.hasOwn(STT, keys.sttProvider) ? STT[keys.sttProvider] : undefined;
  if (!stt) throw new UnknownProviderError('STT_PROVIDER', keys.sttProvider);
  const diarization = Object.hasOwn(DIARIZATION, keys.diarizationProvider)
    ? DIARIZATION[keys.diarizationProvider]
    : undefined;
  if (!diarization)
    throw new UnknownProviderError('DIARIZATION_PROVIDER', keys.diarizationProvider);
  return { stt, diarization };
}

export function resolveProviders(
  keys: { sttProvider: string; diarizationProvider: string },
  store: RawStore,
  deps: ProviderDeps,
): ResolvedProviders {
  const { stt, diarization } = assertKnownProviders(keys);
  return { stt: stt(store, deps), diarization: diarization(store, deps) };
}
