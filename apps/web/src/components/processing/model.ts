import {
  AudioMeasurementRecord,
  type AudioQuantity,
  type ProcessingPreprocessing,
  type ProcessingSnapshot,
  type ProcessingState,
} from '@vip/contracts';
import { ApiRequestError, describeError } from '@/lib/api';

export const POLL_MS = 2_000;
export const STALE_MS = 60_000;

const ACTIVE: readonly ProcessingState[] = ['validating', 'queued', 'processing'];
export const isActiveState = (state: ProcessingState) => ACTIVE.includes(state);

export type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';
export type BadgeKind = 'idle' | 'busy' | 'done' | 'error' | 'stopped' | 'cancelling';

const STAGES: Record<string, string> = {
  probe: 'Probing',
  decode: 'Decoding',
  measure: 'Measuring',
  segment: 'Segmenting',
  write: 'Writing',
};

export const stageLabel = (stage: string | undefined): string | null =>
  stage === undefined ? null : (STAGES[stage] ?? null);

export interface StatusView {
  label: string;
  tone: Tone;
  kind: BadgeKind;
}

export function statusView(s: ProcessingSnapshot): StatusView {
  const p = s.preprocessing;
  switch (s.state) {
    case 'not_started':
      return { label: 'Not started', tone: 'neutral', kind: 'idle' };
    case 'validating':
      return { label: 'Validating', tone: 'info', kind: 'busy' };
    case 'queued':
      return { label: 'Queued', tone: 'info', kind: 'busy' };
    case 'processing': {
      if (p?.cancelRequested) return { label: 'Cancelling…', tone: 'warning', kind: 'cancelling' };
      const stage = stageLabel(p?.progress?.stage);
      return { label: stage ? `Processing · ${stage}` : 'Processing', tone: 'info', kind: 'busy' };
    }
    case 'completed':
      return { label: 'Completed', tone: 'success', kind: 'done' };
    case 'failed':
      return { label: 'Failed', tone: 'danger', kind: 'error' };
    case 'cancelled':
      return { label: 'Cancelled', tone: 'neutral', kind: 'stopped' };
  }
}

/** Only persisted `progress.updatedAt` counts; no heartbeat is invented. */
export function isStale(s: ProcessingSnapshot, now: number): boolean {
  const updated = s.preprocessing?.progress?.updatedAt;
  if (s.state !== 'processing' || !updated) return false;
  const t = Date.parse(updated);
  return Number.isFinite(t) && now - t > STALE_MS;
}

export const retriesRemaining = (p: ProcessingPreprocessing) =>
  Math.max(0, p.maxRetries - p.attempt);

export interface Actions {
  start: boolean;
  retry: boolean;
  cancel: boolean;
  /** Retries left, only for failed or cancelled processing. */
  remaining: number | null;
}

export function actionsFor(s: ProcessingSnapshot): Actions {
  const p = s.preprocessing;
  const canRetry = (s.state === 'failed' || s.state === 'cancelled') && p !== null;
  const remaining = canRetry ? retriesRemaining(p) : null;
  return {
    start: s.state === 'not_started' && s.recording.status !== 'invalid',
    retry: canRetry && (remaining ?? 0) > 0,
    cancel: (s.state === 'queued' || s.state === 'processing') && !p?.cancelRequested,
    remaining,
  };
}

/** Plain-language copy per audio-service failure code (codes only, never server text). */
const FAILURES: Record<string, string> = {
  UNSUPPORTED_FORMAT: 'The audio format is not supported.',
  CORRUPT_MEDIA: 'The file appears to be damaged and could not be read.',
  NO_DECODABLE_AUDIO: 'No audio could be decoded from this file.',
  DURATION_LIMIT_EXCEEDED: 'The recording is longer than the processing limit.',
  RESOURCE_LIMIT_EXCEEDED:
    'The recording exceeds a processing limit (such as channels or sample rate).',
  TIMEOUT: 'Processing took too long and was stopped.',
  CANCELLED: 'Processing was cancelled.',
  STORAGE_ERROR: 'The audio file could not be read from or written to storage.',
  INTERNAL_ERROR: 'Processing hit an unexpected internal error.',
  CAPACITY_EXCEEDED: 'The audio service is busy right now.',
  INVALID_CONFIG: 'The processing settings were not accepted by the audio service.',
  CONFIG_HASH_MISMATCH: 'The processing settings were not accepted by the audio service.',
  TOOL_VERSION_MISMATCH: 'The audio service tools changed while processing.',
  CONTRACT_VERSION_MISMATCH: 'The audio service version is not compatible.',
  UNAUTHORIZED: 'The audio service rejected the request.',
};

export const failureMessage = (code: string | null | undefined): string =>
  (code && FAILURES[code]) || 'Processing failed for an unknown reason.';

/** `validationError` is a code; show a plain message, never the raw value. */
export const validationMessage = (code: string | null): string =>
  code && FAILURES[code]
    ? `This recording was rejected during validation. ${FAILURES[code]}`
    : 'This recording was rejected during validation.';

export function describeFailure(s: ProcessingSnapshot): { message: string; retry: string } {
  const p = s.preprocessing;
  if (s.recording.status === 'invalid' && !p) {
    return {
      message: validationMessage(s.recording.validationError),
      retry: 'It cannot be processed. Upload a different file.',
    };
  }
  const message = failureMessage(p?.error?.code);
  if (!p) return { message, retry: 'Retry is not available.' };
  const left = retriesRemaining(p);
  if (left === 0) return { message, retry: 'No retries left.' };
  const kind =
    p.error?.retryable === false ? 'This failure is unlikely to resolve on its own. ' : '';
  return { message, retry: `${kind}Retry is possible. ${left} of ${p.maxRetries} attempts left.` };
}

export function mappingExplanation(t: NonNullable<ProcessingPreprocessing['timeline']>): string {
  const bound = t.mappingErrorBoundMs;
  switch (t.mappingStatus) {
    case 'exact':
      return 'Sample-accurate: processed time matches the original recording.';
    case 'offset_applied':
    case 'approximate':
      return bound === null
        ? 'Approximate: the offset from the original recording is not bounded.'
        : `Approximate: within ±${bound} ms of the original recording.`;
    case 'uncertain': {
      const parts = [`${t.gapCount} ${t.gapCount === 1 ? 'gap' : 'gaps'}`];
      if (t.decodedUntilMs !== null) parts.push(`decoded until ${t.decodedUntilMs} ms`);
      return `Uncertain: the mapping to the original recording cannot be guaranteed (${parts.join(', ')}).`;
    }
  }
}

export const decodeClassLabel = (c: 'full' | 'partial' | 'none') =>
  ({ full: 'Fully decoded', partial: 'Partially decoded', none: 'Nothing decoded' })[c];

export function vadMessage(vad: ProcessingPreprocessing['vad']): string {
  if (vad === null) return 'Not available';
  if (vad.status === 'not_configured') {
    return 'Voice activity detection not configured — segments not produced';
  }
  return `${vad.method} (${vad.status})`;
}

const UNIT: Record<AudioQuantity['unit'], string> = {
  dBFS: ' dBFS',
  dB: ' dB',
  LUFS: ' LUFS',
  LU: ' LU',
  dBTP: ' dBTP',
  ratio: '',
  samples: ' samples',
  ms: ' ms',
  fullscale: ' (full scale = 1)',
  count: '',
};

export function formatQuantity(q: AudioQuantity): string {
  const digits = q.unit === 'samples' || q.unit === 'count' ? 0 : q.unit === 'ms' ? 1 : 3;
  const n = q.value.toLocaleString('en-US', { maximumFractionDigits: digits });
  return `${n}${UNIT[q.unit]}`;
}

const UNAVAILABLE_REASONS: Record<string, string> = {
  mono_source: 'the source has one channel',
  zero_variance: 'a channel has no variation',
  no_windows: 'the recording is too short',
  no_speech_split: 'no speech/non-speech split is available',
  no_reference: 'no reference signal is available',
};

export const unavailableReason = (reason: string) =>
  UNAVAILABLE_REASONS[reason] ?? reason.replaceAll('_', ' ');

/** "peakDbfs" -> "Peak dBFS". Names come from the service; unknown ones still render. */
export const quantityLabel = (name: string) => {
  const spaced = name.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  const fixed = spaced.replace(/\bdbfs\b/, 'dBFS').replace(/\bdb\b/, 'dB');
  return fixed.charAt(0).toUpperCase() + fixed.slice(1);
};

export const SOURCE_LABEL = {
  original_decoded: 'Original (decoded)',
  canonical: 'Canonical (16 kHz mono)',
} as const;

export interface MeasurementView {
  source: keyof typeof SOURCE_LABEL;
  record: AudioMeasurementRecord | null;
}

export const measurementViews = (p: ProcessingPreprocessing): MeasurementView[] =>
  p.measurements.map((m) => {
    const parsed = AudioMeasurementRecord.safeParse(m.record);
    return { source: m.source, record: parsed.success ? parsed.data : null };
  });

export type ProcessingAction = 'start' | 'cancel';

/** Inline message for a failed start, retry or cancel. Codes only, never raw JSON. */
export function actionErrorMessage(action: ProcessingAction, error: unknown): string {
  if (error instanceof ApiRequestError) {
    if (error.code === 'INVALID_STATE_TRANSITION') {
      return action === 'cancel'
        ? 'Nothing is running, so there is nothing to cancel. The status has been refreshed.'
        : 'Processing cannot be started or retried right now. The retry limit may have been reached, or the recording is not ready.';
    }
    if (error.code === 'DEPENDENCY_UNAVAILABLE') {
      return 'The audio service is unavailable. Try again shortly.';
    }
  }
  return describeError(error);
}
