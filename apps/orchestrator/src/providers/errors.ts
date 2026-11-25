/**
 * A provider call failed. `code` is a stable, content-free identifier (never provider text);
 * `retryable` says whether trying again can help (LLD §7 `ProviderError{retryable}`).
 */
export class ProviderError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(`Provider error: ${code}`);
    this.name = 'ProviderError';
  }
}

export class UnknownProviderError extends Error {
  constructor(
    readonly kind: 'STT_PROVIDER' | 'DIARIZATION_PROVIDER',
    readonly key: string,
  ) {
    super(
      `Unknown ${kind} "${key}". Registered keys: fake, whisper-cpp (STT), sherpa-onnx (diarization).`,
    );
    this.name = 'UnknownProviderError';
  }
}
