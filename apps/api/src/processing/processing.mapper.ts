import {
  AudioTimeline,
  ProcessingProgress,
  type ProcessingPreprocessing,
  type ProcessingProbeSummary,
  type ProcessingSegment,
  type ProcessingSnapshot,
  type ProcessingState,
} from '@vip/contracts';
import type { AudioMeasurement, AudioPreprocessing, AudioSegment, Recording } from '@vip/db';

/**
 * Pure mapping from database rows to the `GET /recordings/{id}/processing` snapshot. Never
 * fabricates: every value comes from a persisted column, and anything unknown is `null`.
 */
export function stateOf(
  recording: Pick<Recording, 'status'>,
  preprocessing: Pick<AudioPreprocessing, 'status'> | null,
): ProcessingState {
  if (preprocessing) {
    switch (preprocessing.status) {
      case 'queued':
        return 'queued';
      case 'running':
        return 'processing';
      case 'succeeded':
        return 'completed';
      case 'failed':
        return 'failed';
      case 'cancelled':
        return 'cancelled';
    }
  }
  if (recording.status === 'validating') return 'validating';
  if (recording.status === 'invalid') return 'failed';
  return 'not_started';
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const int = (v: unknown): number | null => (Number.isInteger(v) ? (v as number) : null);

export function probeSummary(recording: Recording): ProcessingProbeSummary | null {
  const probe = recording.mediaProbe;
  if (!probe) return null;
  return {
    container: str(probe.container),
    codec: str(probe.codec),
    sampleRateHz: int(probe.sampleRateHz),
    channels: int(probe.channels),
    durationMs: recording.durationMs,
  };
}

export function toPreprocessing(
  row: AudioPreprocessing,
  measurements: AudioMeasurement[],
  segmentCount: number | null,
  maxRetries: number,
): ProcessingPreprocessing {
  const progress = ProcessingProgress.safeParse(row.progress);
  const timeline = AudioTimeline.safeParse(row.timeline);
  const vad = row.vad as { method?: unknown; status?: unknown } | null;
  return {
    id: row.id,
    status: row.status,
    progress: progress.success ? progress.data : null,
    attempt: row.attempt,
    maxRetries,
    error: row.error ? { code: row.error.code, retryable: row.error.retryable } : null,
    cancelRequested: row.cancelRequestedAt !== null,
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    configHash: row.configHash,
    canonical:
      row.status === 'succeeded' && row.canonicalSha256 !== null && row.canonicalDurationMs !== null
        ? { durationMs: row.canonicalDurationMs, sha256: row.canonicalSha256 }
        : null,
    timeline: timeline.success
      ? {
          mappingStatus: timeline.data.mappingStatus,
          mappingErrorBoundMs: timeline.data.mappingErrorBoundMs,
          decodeClass: timeline.data.decodeClass,
          decodedUntilMs: timeline.data.decodedUntilMs,
          gapCount: timeline.data.gaps.length,
        }
      : null,
    measurements: measurements.map((m) => ({
      source: m.source,
      schemaVersion: m.schemaVersion,
      serviceVersion: m.serviceVersion,
      record: m.measurements,
    })),
    vad:
      vad && typeof vad.method === 'string' && typeof vad.status === 'string'
        ? { method: vad.method, status: vad.status }
        : null,
    segmentCount,
  };
}

export function toSnapshot(
  recording: Recording,
  preprocessing: AudioPreprocessing | null,
  measurements: AudioMeasurement[],
  segmentCount: number | null,
  maxRetries: number,
): ProcessingSnapshot {
  return {
    state: stateOf(recording, preprocessing),
    recording: { status: recording.status, validationError: recording.validationError },
    probe: probeSummary(recording),
    preprocessing: preprocessing
      ? toPreprocessing(preprocessing, measurements, segmentCount, maxRetries)
      : null,
  };
}

export function toSegment(row: AudioSegment): ProcessingSegment {
  return {
    index: row.index,
    startMs: row.startMs,
    endMs: row.endMs,
    overlapStartMs: row.overlapStartMs,
    overlapEndMs: row.overlapEndMs,
    speechMs: row.speechMs,
    containsSyntheticGap: row.containsSyntheticGap,
  };
}
