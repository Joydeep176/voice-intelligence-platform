import type {
  AudioDiagnosticsSnapshot,
  AudioQualityClass,
  DiagnosticFlagKind,
  EvidenceBasis,
  FlagSeverity,
  Suitability,
} from '@vip/contracts';

/**
 * Copy and presentation of A1 audio diagnostics (ADR-0043). Audio diagnostics are a separate
 * channel from transcription uncertainty (FR-3.3 / FR-9.3): this module never mentions transcript
 * confidence, and its colours use only the `diag-*` token family (plus `success` for "good").
 */
export type DiagnosticsState = AudioDiagnosticsSnapshot['state'];

export const CLASS_LABEL: Record<AudioQualityClass, string> = {
  good: 'Good',
  acceptable_with_warnings: 'Acceptable, with warnings',
  poor: 'Poor',
  insufficient: 'Insufficient',
};

export const CLASS_DESCRIPTION: Record<AudioQualityClass, string> = {
  good: 'No audio problems were detected that are likely to affect processing.',
  acceptable_with_warnings: 'Processing can continue, but some audio problems were detected.',
  poor: 'Audio problems cover a large part of the recording; processing results may be unreliable.',
  insufficient:
    'Little or no usable speech was detected. Transcription can still be started; a new recording is recommended.',
};

/** Tailwind classes from the semantic token families (no raw colours, no brand accents). */
export const CLASS_TONE: Record<AudioQualityClass, string> = {
  good: 'text-success',
  acceptable_with_warnings: 'text-diag-medium',
  poor: 'text-diag-high',
  insufficient: 'text-diag-high',
};

export const SEVERITY_LABEL: Record<FlagSeverity, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
};

export const SEVERITY_TONE: Record<FlagSeverity, string> = {
  low: 'border-diag-low text-diag-low',
  medium: 'border-diag-medium text-diag-medium',
  high: 'border-diag-high text-diag-high',
};

export const FLAG_LABEL: Record<DiagnosticFlagKind, string> = {
  noise: 'Background noise',
  clipping: 'Clipping',
  distortion: 'Distortion',
  dropout: 'Dropout',
  silence: 'Silence',
  low_level: 'Low level',
  low_speech_presence: 'Little speech',
  narrowband: 'Narrow bandwidth',
  level_inconsistency: 'Inconsistent level',
  fragmented_speech: 'Fragmented speech',
};

export const BASIS_LABEL: Record<EvidenceBasis, string> = {
  measured: 'Measured',
  derived: 'Derived from measurements',
  estimate: 'Estimated',
};

export const SUITABILITY_LABEL: Record<Suitability, string> = {
  suitable: 'Suitable',
  limited: 'Limited',
  unreliable: 'Unreliable',
  not_assessable: 'Not assessable',
};

export const REASON_LABEL: Record<string, string> = {
  deadline_risk: 'dense, fragmented speech may make transcription windows slow',
  language_id_risk: 'heavy noise can make language identification harder',
  speech_measurements_unavailable: 'speech-aware measurements are not available yet',
  no_usable_audio: 'no usable audio',
  no_usable_speech: 'no usable speech',
  too_short: 'the recording is too short',
};

export const RECOMMENDATION_TEXT: Record<string, string> = {
  new_recording_recommended: 'Consider uploading a new recording that contains clear speech.',
  reduce_background_noise: 'Record in a quieter place or closer to the speakers.',
  lower_input_gain: 'Lower the recording level (input gain) to avoid clipping.',
  move_closer_or_raise_gain: 'Move the microphone closer or raise the recording level.',
  check_recording_device: 'Check the recording device and connection for interruptions.',
  check_long_silences: 'Check whether long silent stretches are expected.',
  upload_recording_with_speech: 'Make sure the recording contains speech.',
  use_wideband_or_lossless_format: 'Use a wideband source or a lossless format if possible.',
  keep_consistent_microphone_distance: 'Keep a consistent distance from the microphone.',
  expect_slower_transcription:
    'Transcription of very fragmented speech can be slow and may hit its time limit.',
};

export const NOT_ASSESSED_LABEL: Record<string, string> = {
  distortion: 'Distortion other than clipping',
  reverberation: 'Reverberation and echo',
  snr: 'Signal-to-noise ratio',
  speech_presence: 'Speech presence',
  bandwidth: 'Bandwidth',
  level_consistency: 'Level consistency',
  fragmentation: 'Speech fragmentation',
};

export const STATE_MESSAGE: Record<Exclude<DiagnosticsState, 'completed'>, string> = {
  not_started: 'No audio-quality assessment has been made for this run.',
  pending: 'The audio-quality assessment will start shortly.',
  running: 'Assessing audio quality…',
  failed: 'The audio-quality assessment failed. Transcription is not affected.',
  cancelled: 'The run was cancelled before the audio-quality assessment finished.',
};

export const isActiveDiagnostics = (state: DiagnosticsState | undefined): boolean =>
  state === 'pending' || state === 'running';

export const canRetryDiagnostics = (state: DiagnosticsState | undefined): boolean =>
  state === 'failed' || state === 'not_started';

/** `m:ss` (or `h:mm:ss`) on the canonical timeline. */
export function formatOffset(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

export function flagRange(startMs: number | null, endMs: number | null): string {
  return startMs === null || endMs === null
    ? 'Whole recording'
    : `${formatOffset(startMs)}–${formatOffset(endMs)}`;
}

/** Workflow-step wording for the "Audio quality analysis" step. */
export const DIAGNOSTICS_STEP: Record<
  DiagnosticsState,
  'Complete' | 'In progress' | 'Failed' | 'Cancelled' | 'Pending'
> = {
  not_started: 'Pending',
  pending: 'Pending',
  running: 'In progress',
  completed: 'Complete',
  failed: 'Failed',
  cancelled: 'Cancelled',
};
