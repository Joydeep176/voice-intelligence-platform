import type {
  RunSnapshot,
  RunStage,
  SpeakerDto,
  TranscriptLanguage,
  TranscriptSegmentDto,
  UncertaintyDto,
} from '@vip/contracts';
import { ApiRequestError, describeError } from '@/lib/api';
import type { BadgeKind, Tone } from '@/components/processing/model';

export const POLL_MS = 2_000;

const ACTIVE = ['queued', 'running', 'cancelling'] as const;
export const isActiveRun = (s: RunSnapshot) => (ACTIVE as readonly string[]).includes(s.status);

export interface RunView {
  label: string;
  tone: Tone;
  kind: BadgeKind;
}

/** `null` = no run exists yet. A `created` run (recorded at upload) has not been submitted. */
export function runView(s: RunSnapshot | null): RunView {
  if (s === null || s.status === 'created') {
    return { label: 'Not started', tone: 'neutral', kind: 'idle' };
  }
  switch (s.status) {
    case 'queued':
      return { label: 'Queued', tone: 'info', kind: 'busy' };
    case 'running':
      return s.cancelRequested
        ? { label: 'Cancelling…', tone: 'warning', kind: 'cancelling' }
        : { label: 'Running', tone: 'info', kind: 'busy' };
    case 'cancelling':
      return { label: 'Cancelling…', tone: 'warning', kind: 'cancelling' };
    case 'completed':
      return { label: 'Completed', tone: 'success', kind: 'done' };
    case 'failed':
      return { label: 'Failed', tone: 'danger', kind: 'error' };
    case 'cancelled':
      return { label: 'Cancelled', tone: 'neutral', kind: 'stopped' };
    case 'needs_review':
      return { label: 'Needs review', tone: 'warning', kind: 'idle' };
  }
}

export interface RunActions {
  start: boolean;
  retry: boolean;
  cancel: boolean;
}

export function runActions(s: RunSnapshot | null): RunActions {
  const notStarted = s === null || s.status === 'created';
  return {
    start: notStarted,
    retry:
      s !== null &&
      (s.status === 'failed' || s.status === 'cancelled') &&
      s.retryCount < s.maxRetries,
    cancel: s !== null && (s.status === 'queued' || (s.status === 'running' && !s.cancelRequested)),
  };
}

export const retriesLeft = (s: RunSnapshot) => Math.max(0, s.maxRetries - s.retryCount);

const STAGE_LABEL: Record<RunStage, string> = {
  transcription: 'Transcription',
  diarization: 'Speaker diarization',
};

export interface StageRow {
  node: RunStage;
  label: string;
  state: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  /** Persisted fraction only; null = indeterminate. Never estimated. */
  fraction: number | null;
}

export function stageRows(s: RunSnapshot): StageRow[] {
  return s.scope.map((node) => {
    const row = s.stages.find((st) => st.node === node);
    return {
      node,
      label: STAGE_LABEL[node],
      state: row?.status ?? 'pending',
      fraction: row?.status === 'running' ? (row.progress?.fraction ?? null) : null,
    };
  });
}

/** What a run does. Plain scope statement (D-2C-01): never implies the full pipeline. */
export function scopeText(s: RunSnapshot | null): string {
  const scope = s?.scope ?? [];
  if (scope.length === 0 || (scope.includes('transcription') && scope.includes('diarization'))) {
    return 'This run covers transcription and speaker diarization only.';
  }
  return `This run covers ${scope.map((n) => STAGE_LABEL[n].toLowerCase()).join(' and ')} only.`;
}

export function windowNote(w: RunSnapshot['window']): string | null {
  if (w === null) return null;
  if (w.source === 'vad_segments') return 'Windows follow voice activity detection segments.';
  const seconds = w.windowMs === null ? null : w.windowMs / 1000;
  return `Fixed ${seconds === null ? '' : `${seconds} s `}windows (no preprocessing segments)`;
}

export const hasFakeProvider = (
  p: { stt: { fake: boolean }; diarization: { fake: boolean } } | null | undefined,
) => p != null && (p.stt.fake || p.diarization.fake);

export const FAKE_BANNER =
  'Development placeholder: this transcript was produced by a fake provider and does not reflect the audio.';

/** Plain-language copy per run failure code (codes only, never server text). */
const FAILURES: Record<string, string> = {
  PREPROCESSING_REQUIRED: 'Audio processing has not completed for this recording.',
  RECORDING_NOT_VALID: 'The recording is not valid audio.',
  INVALID_RUN_CONFIG: 'The run settings were not accepted.',
  WINDOW_LIMIT_EXCEEDED: 'The recording needs more transcription windows than the limit allows.',
  NO_AUDIO_WINDOWS: 'No audio was available to transcribe.',
  TIMEOUT: 'The run took too long and was stopped.',
  PROVIDER_TIMEOUT: 'The speech provider did not answer in time.',
  PROVIDER_OUTPUT_INVALID: 'The speech provider returned output that could not be used.',
  RAW_OUTPUT_CORRUPT: 'Stored provider output failed an integrity check.',
  RAW_OUTPUT_CONFLICT: 'Stored provider output conflicted with a new result.',
  RUN_MISSING: 'The run could not be found.',
  INTERNAL_ERROR: 'The run hit an unexpected internal error.',
  // Self-hosted providers (ADR-0036 / ADR-0037): audio-service failures arrive as `AUDIO_<code>`.
  AUDIO_UNAVAILABLE: 'The audio service could not be reached. Retry once it is available again.',
  AUDIO_LOST: 'The audio service restarted and lost the task. Retry to run it again.',
  AUDIO_CAPACITY_EXCEEDED: 'The audio service was busy with other work.',
  AUDIO_TIMEOUT: 'A transcription window took longer than its processing deadline.',
  AUDIO_RESOURCE_EXHAUSTED: 'The audio service ran out of memory or CPU time on this recording.',
  AUDIO_CANCELLED: 'The audio service task was cancelled.',
  AUDIO_STORAGE_ERROR: 'The audio service could not read the processed audio.',
  AUDIO_INTERNAL_ERROR: 'The audio service hit an unexpected internal error.',
};

export const failureMessage = (code: string | null | undefined) =>
  (code && FAILURES[code]) ||
  (code?.startsWith('AUDIO_')
    ? `The audio service reported an error (${code.slice('AUDIO_'.length)}).`
    : 'The run failed for an unknown reason.');

export function failureView(s: RunSnapshot): { message: string; retry: string } {
  const message = failureMessage(s.error?.code);
  const left = retriesLeft(s);
  return {
    message,
    retry:
      left === 0
        ? 'No retries left.'
        : `Retry is possible. ${left} of ${s.maxRetries} ${left === 1 ? 'retry' : 'retries'} left.`,
  };
}

export type RunAction = 'start' | 'cancel' | 'retry';

/** Inline message for a failed start, cancel or retry. Codes only, never raw JSON. */
export function actionErrorMessage(action: RunAction, error: unknown): string {
  if (error instanceof ApiRequestError) {
    if (error.code === 'INVALID_STATE_TRANSITION') {
      if (action === 'start') {
        return 'Transcription cannot start yet. The recording must be valid and its audio processing must have completed first.';
      }
      return action === 'cancel'
        ? 'Nothing is running, so there is nothing to cancel. The status has been refreshed.'
        : 'This run cannot be retried now: it has not failed or been cancelled, or the retry limit was reached.';
    }
    if (error.code === 'DEPENDENCY_UNAVAILABLE') {
      return 'The job queue is unavailable. If the run was recorded it is picked up once the queue recovers; this page keeps checking.';
    }
  }
  return describeError(error);
}

export function renameErrorMessage(error: unknown): string {
  if (error instanceof ApiRequestError) {
    if (error.status === 422 || error.code === 'VALIDATION_FAILED') {
      return 'Enter a name of 1 to 80 characters.';
    }
    if (error.status === 409) {
      return 'This speaker cannot be renamed right now. Refresh the page and try again.';
    }
  }
  return describeError(error);
}

/** mm:ss, or h:mm:ss from one hour. Floors, so a segment never appears to start late. */
export function formatTimestamp(ms: number): string {
  const total = Math.floor(Math.max(0, ms) / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${String(m).padStart(2, '0')}:${s}`;
}

export const LANGUAGES: Record<TranscriptLanguage, { label: string; lang: string | undefined }> = {
  en: { label: 'English', lang: 'en' },
  hi: { label: 'Hindi', lang: 'hi' },
  mixed: { label: 'Mixed', lang: undefined },
};

export function speakerLabel(
  segment: Pick<TranscriptSegmentDto, 'speakerId'>,
  speakers: ReadonlyMap<string, SpeakerDto>,
): string {
  if (segment.speakerId === null) return 'Unassigned speaker';
  const s = speakers.get(segment.speakerId);
  return s ? (s.displayName ?? s.speakerKey) : 'Speaker';
}

const UNCERTAINTY_LABEL: Record<UncertaintyDto['kind'], string> = {
  low_confidence: 'Low confidence',
  inaudible: 'Inaudible',
  overlapping_speech: 'Overlapping speech',
  language_uncertain: 'Language uncertain',
  speaker_uncertain: 'Speaker uncertain',
};
export const uncertaintyLabel = (kind: UncertaintyDto['kind']) => UNCERTAINTY_LABEL[kind];

/** By segment id; a span without a segment attaches to every segment it overlaps. */
export function uncertaintiesFor(
  segment: Pick<TranscriptSegmentDto, 'id' | 'startMs' | 'endMs'>,
  all: readonly UncertaintyDto[],
): UncertaintyDto[] {
  return all.filter((u) =>
    u.segmentId !== null
      ? u.segmentId === segment.id
      : u.startMs < segment.endMs && u.endMs > segment.startMs,
  );
}
