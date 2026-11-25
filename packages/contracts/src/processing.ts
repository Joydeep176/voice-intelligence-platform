import { z } from 'zod';
import { IsoDateTime, Uuid } from './common.js';
import {
  AudioMappingStatus,
  AudioPreprocessConfig,
  type AudioServiceCapabilities,
} from './audio-service.js';
import { RecordingStatus } from './recordings.js';

/** DATABASE_DESIGN §4 `audio_preprocessings.status` (Phase 2B plan §12). */
export const PREPROCESSING_STATUSES = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
] as const;
export const PreprocessingStatus = z.enum(PREPROCESSING_STATUSES);
export type PreprocessingStatus = z.infer<typeof PreprocessingStatus>;

/** DATABASE_DESIGN §4 `audio_measurements.source`: which signal the measurements describe. */
export const MEASUREMENT_SOURCES = ['original_decoded', 'canonical'] as const;
export const MeasurementSource = z.enum(MEASUREMENT_SOURCES);
export type MeasurementSource = z.infer<typeof MeasurementSource>;

/* ------------------------------------------------------------------------------------------------
 * Phase 2B WS7: processing coordinator DTOs and the shared config builder.
 * ---------------------------------------------------------------------------------------------- */

/**
 * INTERIM DEVELOPMENT DEFAULTS (OD-10 Open, not approved). They only fill the preprocess config;
 * the audio service may lower, never raise, its own ceilings.
 */
export const INTERIM_PROCESSING_LIMITS = {
  maxDurationMs: 14_400_000,
  maxChannels: 8,
  maxSampleRateHz: 192_000,
} as const;
export const INTERIM_BLOCK_SECONDS = 10;
export const INTERIM_MEASUREMENT = {
  clipping: { minRunSamples: 2 },
  silenceThresholdCentiDbfs: -5000,
  levelSeriesIntervalMs: 100,
} as const;

/** Tool versions the service measured, in the shape the config hash covers (null: cannot preprocess). */
export function toolVersionsFromCapabilities(
  capabilities: AudioServiceCapabilities,
): AudioPreprocessConfig['toolVersions'] | null {
  if (capabilities.ffmpeg === null || !capabilities.taskTypes.includes('preprocess')) return null;
  const parsed = AudioPreprocessConfig.shape.toolVersions.safeParse({
    service: capabilities.serviceVersion,
    python: capabilities.python,
    ffmpeg: capabilities.ffmpeg.version,
    numpy: capabilities.numpy,
    vad: capabilities.vad,
  });
  return parsed.success ? parsed.data : null;
}

/** The preprocess config of this release: no VAD (OD-29), so no segmentation. Pure and deterministic. */
export function buildPreprocessConfig(
  toolVersions: AudioPreprocessConfig['toolVersions'],
): AudioPreprocessConfig {
  return AudioPreprocessConfig.parse({
    schemaVersion: 1,
    canonical: { sampleRateHz: 16000, channels: 1, sampleFormat: 's16', container: 'wav' },
    blockSeconds: INTERIM_BLOCK_SECONDS,
    measurement: INTERIM_MEASUREMENT,
    limits: INTERIM_PROCESSING_LIMITS,
    vad: { method: 'none' },
    toolVersions,
  });
}

/** `probe` task config: limits only (the service reads `maxDurationMs`, `maxChannels`, `maxSampleRateHz`). */
export function buildProbeConfig(): Record<string, number> {
  return { ...INTERIM_PROCESSING_LIMITS };
}

export const PROCESSING_STATES = [
  'not_started',
  'validating',
  'queued',
  'processing',
  'completed',
  'failed',
  'cancelled',
] as const;
export const ProcessingState = z.enum(PROCESSING_STATES);
export type ProcessingState = z.infer<typeof ProcessingState>;

/** Persisted progress only (never estimated). */
export const ProcessingProgress = z.object({
  stage: z.string(),
  fraction: z.number().min(0).max(1),
  processedMs: z.number().int().min(0),
  updatedAt: IsoDateTime,
});
export type ProcessingProgress = z.infer<typeof ProcessingProgress>;

export const ProcessingProbeSummary = z.object({
  container: z.string().nullable(),
  codec: z.string().nullable(),
  sampleRateHz: z.number().int().nullable(),
  channels: z.number().int().nullable(),
  durationMs: z.number().int().nullable(),
});
export type ProcessingProbeSummary = z.infer<typeof ProcessingProbeSummary>;

export const ProcessingMeasurement = z.object({
  source: MeasurementSource,
  schemaVersion: z.string(),
  serviceVersion: z.string(),
  /** The measurement record as stored (quantities with units; no judgements, ADR-0019). */
  record: z.record(z.string(), z.unknown()),
});
export type ProcessingMeasurement = z.infer<typeof ProcessingMeasurement>;

export const ProcessingPreprocessing = z.object({
  id: Uuid,
  status: PreprocessingStatus,
  progress: ProcessingProgress.nullable(),
  attempt: z.number().int().min(0),
  maxRetries: z.number().int().min(0),
  error: z.object({ code: z.string(), retryable: z.boolean() }).nullable(),
  cancelRequested: z.boolean(),
  startedAt: IsoDateTime.nullable(),
  finishedAt: IsoDateTime.nullable(),
  configHash: z.string(),
  canonical: z.object({ durationMs: z.number().int(), sha256: z.string() }).nullable(),
  timeline: z
    .object({
      mappingStatus: AudioMappingStatus,
      mappingErrorBoundMs: z.number().nullable(),
      decodeClass: z.enum(['full', 'partial', 'none']),
      decodedUntilMs: z.number().nullable(),
      gapCount: z.number().int().min(0),
    })
    .nullable(),
  measurements: z.array(ProcessingMeasurement),
  vad: z.object({ method: z.string(), status: z.string() }).nullable(),
  segmentCount: z.number().int().min(0).nullable(),
});
export type ProcessingPreprocessing = z.infer<typeof ProcessingPreprocessing>;

/** `GET /recordings/{id}/processing` (and the body of start/cancel): a database snapshot. */
export const ProcessingSnapshot = z.object({
  state: ProcessingState,
  recording: z.object({ status: RecordingStatus, validationError: z.string().nullable() }),
  probe: ProcessingProbeSummary.nullable(),
  preprocessing: ProcessingPreprocessing.nullable(),
});
export type ProcessingSnapshot = z.infer<typeof ProcessingSnapshot>;

export const ProcessingSegmentsQuery = z.object({
  fromMs: z.coerce.number().int().min(0).optional(),
  toMs: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
});
export type ProcessingSegmentsQuery = z.infer<typeof ProcessingSegmentsQuery>;

export const ProcessingSegment = z.object({
  index: z.number().int().min(0),
  startMs: z.number().int(),
  endMs: z.number().int(),
  overlapStartMs: z.number().int(),
  overlapEndMs: z.number().int(),
  speechMs: z.number().int(),
  containsSyntheticGap: z.boolean(),
});
export type ProcessingSegment = z.infer<typeof ProcessingSegment>;

/** Segments of the latest succeeded preprocessing (empty without a VAD, OD-29). */
export const ProcessingSegmentList = z.object({
  preprocessingId: Uuid.nullable(),
  items: z.array(ProcessingSegment),
});
export type ProcessingSegmentList = z.infer<typeof ProcessingSegmentList>;

/** What to do with the (recording, config hash) row that an upsert returned. Shared by API and orchestrator. */
export type RowDecision =
  | { kind: 'enqueue' } // new, or still queued/running: make sure a job exists (dedupe by job ID)
  | { kind: 'return' } // succeeded: nothing to run
  | { kind: 'retry' } // failed/cancelled with attempts left: reset, then enqueue
  | { kind: 'reject'; detail: string };

export function decideRowAction(
  row: { status: PreprocessingStatus; attempt: number },
  maxRetries: number,
): RowDecision {
  switch (row.status) {
    case 'queued':
    case 'running':
      return { kind: 'enqueue' };
    case 'succeeded':
      return { kind: 'return' };
    case 'failed':
    case 'cancelled':
      return row.attempt < maxRetries
        ? { kind: 'retry' }
        : { kind: 'reject', detail: 'The retry limit for this processing has been reached.' };
  }
}

/**
 * Storage URI of `key` in the same scheme (and, for object stores, bucket) as `referenceUri`.
 * Parity with the API's `StorageService.uriFor`: the development driver yields `local://<key>`; a
 * bucketed scheme keeps its authority, `s3://<bucket>/<key>`. Pure, so API and orchestrator agree.
 */
export function storageUriForKey(referenceUri: string, key: string): string {
  const match = /^([a-z][a-z0-9+.-]*):\/\/([^/]*)/i.exec(referenceUri);
  if (!match) throw new Error('Reference storage URI has no scheme.');
  const [, scheme, authority] = match as unknown as [string, string, string];
  return scheme.toLowerCase() === 'local' || authority === ''
    ? `${scheme}://${key}`
    : `${scheme}://${authority}/${key}`;
}
