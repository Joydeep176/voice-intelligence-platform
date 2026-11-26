/**
 * Phase 1 foundation schema: a subset of DATABASE_DESIGN §4. Table and column names follow
 * that document. Enum values come from `@vip/contracts`, so the API contract and the database
 * cannot drift. This file has no relative imports, so drizzle-kit can load it directly.
 */
import {
  AUDIO_QUALITY_CLASSES,
  CONFIDENCE_LEVELS,
  DIAGNOSTIC_FLAG_KINDS,
  EVIDENCE_BASES,
  FLAG_SEVERITIES,
  MEASUREMENT_SET_STATUSES,
  MEASUREMENT_SOURCES,
  PREPROCESSING_STATUSES,
  RAW_OUTPUT_SCOPES,
  RECORDING_STATUSES,
  RUN_STATUSES,
  STAGE_NODES,
  STAGE_STATUSES,
  TRANSCRIPT_LANGUAGES,
  TRANSCRIPT_VERSION_KINDS,
  UNCERTAINTY_KINDS,
} from '@vip/contracts';
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const createdAt = () =>
  timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow();
const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

export const recordingStatus = pgEnum('recording_status', RECORDING_STATUSES);
export const runStatus = pgEnum('run_status', RUN_STATUSES);
export const preprocessingStatus = pgEnum('preprocessing_status', PREPROCESSING_STATUSES);
export const uploadStrategy = pgEnum('upload_strategy', ['local_chunked', 's3_multipart']);
export const uploadSessionStatus = pgEnum('upload_session_status', [
  'active',
  'completed',
  'expired',
  'aborted',
]);

/** Unit of data ownership and isolation (ADR-0003). Members/roles: OD-27 (Open). */
export const workspaces = pgTable('workspaces', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const recordings = pgTable(
  'recordings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'restrict' }),
    /** User-supplied metadata only; never used to build storage keys. */
    originalFilename: text('original_filename').notNull(),
    /** Opaque storage URI built from IDs (e.g. `local://recordings/<ws>/<id>/original`). Never exposed. */
    storageUri: text('storage_uri').notNull(),
    sha256: text('sha256'),
    mimeType: text('mime_type').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    durationMs: bigint('duration_ms', { mode: 'number' }),
    sampleRate: integer('sample_rate'),
    channels: integer('channels'),
    status: recordingStatus('status').notNull().default('uploading'),
    validationError: text('validation_error'),
    /** Container/codec probe record written by the audio service (Phase 2B plan §11.2/§12). */
    mediaProbe: jsonb('media_probe').$type<Record<string, unknown>>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('recordings_workspace_created_idx').on(t.workspaceId, t.createdAt.desc(), t.id.desc()),
    uniqueIndex('recordings_storage_uri_uq').on(t.storageUri),
    /** Target of the composite workspace FKs on the audio tables. */
    uniqueIndex('recordings_id_workspace_uq').on(t.id, t.workspaceId),
    check(
      'recordings_media_probe_object',
      sql`${t.mediaProbe} IS NULL OR jsonb_typeof(${t.mediaProbe}) = 'object'`,
    ),
    check('recordings_size_positive', sql`${t.sizeBytes} > 0`),
    check('recordings_sha256_hex', sql`${t.sha256} IS NULL OR ${t.sha256} ~ '^[0-9a-f]{64}$'`),
  ],
);

export const uploadSessions = pgTable(
  'upload_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    recordingId: uuid('recording_id')
      .notNull()
      .references(() => recordings.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'restrict' }),
    strategy: uploadStrategy('strategy').notNull(),
    partSize: integer('part_size').notNull(),
    totalParts: integer('total_parts').notNull(),
    /** Part number → size in bytes (and etag for S3 later). */
    partsReceived: jsonb('parts_received')
      .$type<Record<string, { sizeBytes: number }>>()
      .notNull()
      .default({}),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    status: uploadSessionStatus('status').notNull().default('active'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('upload_sessions_recording_idx').on(t.recordingId),
    check('upload_sessions_part_size_positive', sql`${t.partSize} > 0`),
    check('upload_sessions_total_parts_positive', sql`${t.totalParts} > 0`),
  ],
);

/** SEC-1. One attestation per recording. */
export const consentAttestations = pgTable(
  'consent_attestations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    recordingId: uuid('recording_id')
      .notNull()
      .references(() => recordings.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'restrict' }),
    /** Principal ID. In Phase 1 the dev principal (IdP is OD-08b). */
    attestedBy: text('attested_by').notNull(),
    attestedAt: timestamp('attested_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    statementVersion: text('statement_version').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('consent_attestations_recording_uq').on(t.recordingId)],
);

export const pipelineRuns = pgTable(
  'pipeline_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'restrict' }),
    recordingId: uuid('recording_id')
      .notNull()
      .references(() => recordings.id, { onDelete: 'cascade' }),
    status: runStatus('status').notNull().default('created'),
    /** Current pipeline node; null until the pipeline exists (later phase). */
    currentNode: text('current_node'),
    /** `{ code, node }` only, never content (DATABASE_DESIGN §4). */
    error: jsonb('error').$type<{ code: string; node: string | null }>(),
    retryCount: integer('retry_count').notNull().default(0),
    /** Preprocessing version this run transcribes (set at submission, Phase 2C). */
    preprocessingId: uuid('preprocessing_id'),
    /** Stage scope + provider ids/versions + window source/params snapshot (D-2C-01). `RunConfig` in contracts. */
    config: jsonb('config').$type<Record<string, unknown>>(),
    cancelRequestedAt: timestamp('cancel_requested_at', { withTimezone: true, mode: 'date' }),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }),
    finishedAt: timestamp('finished_at', { withTimezone: true, mode: 'date' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('pipeline_runs_recording_created_idx').on(t.recordingId, t.createdAt.desc()),
    index('pipeline_runs_workspace_idx').on(t.workspaceId),
    /** Target of the composite workspace FKs on the transcription tables. */
    uniqueIndex('pipeline_runs_id_workspace_uq').on(t.id, t.workspaceId),
    foreignKey({
      name: 'pipeline_runs_preprocessing_workspace_fk',
      columns: [t.preprocessingId, t.workspaceId],
      foreignColumns: [audioPreprocessings.id, audioPreprocessings.workspaceId],
    }),
    check('pipeline_runs_retry_nonnegative', sql`${t.retryCount} >= 0`),
    check(
      'pipeline_runs_config_object',
      sql`${t.config} IS NULL OR jsonb_typeof(${t.config}) = 'object'`,
    ),
  ],
);

/** Append-only audit log, IDs only (SEC-8). The application exposes no update path. */
export const auditEvents = pgTable(
  'audit_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'restrict' }),
    actorId: text('actor_id').notNull(),
    action: text('action').notNull(),
    resourceType: text('resource_type').notNull(),
    resourceId: uuid('resource_id'),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    metadata: jsonb('metadata').$type<Record<string, string | number | boolean | null>>(),
  },
  (t) => [index('audit_events_workspace_occurred_idx').on(t.workspaceId, t.occurredAt.desc())],
);

const HEX64 = sql.raw(`'^[0-9a-f]{64}$'`);

/**
 * One preprocessing version of a recording (ADR-0015): deterministic outputs for one config.
 * Lifecycle (status, progress, attempt, error) lives on this row (Phase 2B plan §12).
 */
export const audioPreprocessings = pgTable(
  'audio_preprocessings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'restrict' }),
    recordingId: uuid('recording_id').notNull(),
    configHash: text('config_hash').notNull(),
    hashAlgorithm: text('hash_algorithm').notNull().default('sha256'),
    config: jsonb('config').$type<Record<string, unknown>>().notNull(),
    toolVersions: jsonb('tool_versions').$type<Record<string, unknown>>().notNull(),
    status: preprocessingStatus('status').notNull().default('queued'),
    progress: jsonb('progress').$type<Record<string, unknown>>(),
    attempt: integer('attempt').notNull().default(0),
    /** `{ code, retryable }` only, never content. */
    error: jsonb('error').$type<{ code: string; retryable: boolean }>(),
    cancelRequestedAt: timestamp('cancel_requested_at', { withTimezone: true, mode: 'date' }),
    normalizedUri: text('normalized_uri'),
    canonicalSha256: text('canonical_sha256'),
    canonicalDurationMs: bigint('canonical_duration_ms', { mode: 'number' }),
    vad: jsonb('vad').$type<Record<string, unknown>>(),
    /** Timeline mapping record (plan §11.2). */
    timeline: jsonb('timeline').$type<Record<string, unknown>>(),
    artifacts: jsonb('artifacts').$type<Record<string, unknown>>(),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }),
    finishedAt: timestamp('finished_at', { withTimezone: true, mode: 'date' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: 'audio_preprocessings_recording_workspace_fk',
      columns: [t.recordingId, t.workspaceId],
      foreignColumns: [recordings.id, recordings.workspaceId],
    }).onDelete('cascade'),
    uniqueIndex('audio_preprocessings_recording_config_uq').on(t.recordingId, t.configHash),
    uniqueIndex('audio_preprocessings_id_workspace_uq').on(t.id, t.workspaceId),
    index('audio_preprocessings_workspace_recording_created_idx').on(
      t.workspaceId,
      t.recordingId,
      t.createdAt.desc(),
    ),
    check('audio_preprocessings_config_hash_hex', sql`${t.configHash} ~ ${HEX64}`),
    check(
      'audio_preprocessings_canonical_sha256_hex',
      sql`${t.canonicalSha256} IS NULL OR ${t.canonicalSha256} ~ ${HEX64}`,
    ),
    check('audio_preprocessings_attempt_nonnegative', sql`${t.attempt} >= 0`),
    check(
      'audio_preprocessings_canonical_duration_nonnegative',
      sql`${t.canonicalDurationMs} IS NULL OR ${t.canonicalDurationMs} >= 0`,
    ),
    check(
      'audio_preprocessings_timeline_object',
      sql`${t.timeline} IS NULL OR jsonb_typeof(${t.timeline}) = 'object'`,
    ),
    check(
      'audio_preprocessings_error_object',
      sql`${t.error} IS NULL OR jsonb_typeof(${t.error}) = 'object'`,
    ),
    check(
      'audio_preprocessings_started_finished_order',
      sql`${t.finishedAt} IS NULL OR ${t.startedAt} IS NULL OR ${t.finishedAt} >= ${t.startedAt}`,
    ),
    check(
      'audio_preprocessings_succeeded_complete',
      sql`${t.status} <> 'succeeded' OR (${t.finishedAt} IS NOT NULL AND ${t.canonicalSha256} IS NOT NULL AND ${t.normalizedUri} IS NOT NULL AND ${t.canonicalDurationMs} IS NOT NULL AND ${t.timeline} IS NOT NULL)`,
    ),
    check(
      'audio_preprocessings_failed_has_error',
      sql`${t.status} <> 'failed' OR ${t.error} IS NOT NULL`,
    ),
  ],
);

/** Speech segment on the canonical timeline. Immutable after insert (trigger in 0002). */
export const audioSegments = pgTable(
  'audio_segments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'restrict' }),
    preprocessingId: uuid('preprocessing_id').notNull(),
    index: integer('index').notNull(),
    startMs: bigint('start_ms', { mode: 'number' }).notNull(),
    endMs: bigint('end_ms', { mode: 'number' }).notNull(),
    overlapStartMs: integer('overlap_start_ms').notNull().default(0),
    overlapEndMs: integer('overlap_end_ms').notNull().default(0),
    speechMs: bigint('speech_ms', { mode: 'number' }).notNull(),
    containsSyntheticGap: boolean('contains_synthetic_gap').notNull().default(false),
    storageUri: text('storage_uri'),
  },
  (t) => [
    foreignKey({
      name: 'audio_segments_preprocessing_workspace_fk',
      columns: [t.preprocessingId, t.workspaceId],
      foreignColumns: [audioPreprocessings.id, audioPreprocessings.workspaceId],
    }).onDelete('cascade'),
    uniqueIndex('audio_segments_preprocessing_index_uq').on(t.preprocessingId, t.index),
    uniqueIndex('audio_segments_id_preprocessing_uq').on(t.id, t.preprocessingId),
    index('audio_segments_preprocessing_start_idx').on(t.preprocessingId, t.startMs),
    check('audio_segments_index_nonnegative', sql`${t.index} >= 0`),
    check('audio_segments_range_valid', sql`${t.startMs} >= 0 AND ${t.startMs} < ${t.endMs}`),
    check(
      'audio_segments_overlap_nonnegative',
      sql`${t.overlapStartMs} >= 0 AND ${t.overlapEndMs} >= 0`,
    ),
    check('audio_segments_speech_nonnegative', sql`${t.speechMs} >= 0`),
    check('audio_segments_speech_within_range', sql`${t.speechMs} <= ${t.endMs} - ${t.startMs}`),
  ],
);

/**
 * Phase 3A (ADR-0045): lifecycle of one speech-aware measurement set (the audio-service `measure`
 * task) of a preprocessing version and measure config. Results land in `audio_measurements`
 * (schema v2, `measurement_set_id` set). Objective numbers only; no judgements (ADR-0019).
 */
export const audioMeasurementSets = pgTable(
  'audio_measurement_sets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'restrict' }),
    preprocessingId: uuid('preprocessing_id').notNull(),
    configHash: text('config_hash').notNull(),
    config: jsonb('config').$type<Record<string, unknown>>().notNull(),
    status: text('status', { enum: MEASUREMENT_SET_STATUSES }).notNull().default('queued'),
    attempt: integer('attempt').notNull().default(0),
    /** `{ code, retryable }` only, never content. */
    error: jsonb('error').$type<{ code: string; retryable: boolean }>(),
    cancelRequestedAt: timestamp('cancel_requested_at', { withTimezone: true, mode: 'date' }),
    seriesUri: text('series_uri'),
    toolVersions: jsonb('tool_versions').$type<Record<string, unknown>>(),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }),
    finishedAt: timestamp('finished_at', { withTimezone: true, mode: 'date' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: 'audio_measurement_sets_preprocessing_workspace_fk',
      columns: [t.preprocessingId, t.workspaceId],
      foreignColumns: [audioPreprocessings.id, audioPreprocessings.workspaceId],
    }).onDelete('cascade'),
    uniqueIndex('audio_measurement_sets_preprocessing_config_uq').on(
      t.preprocessingId,
      t.configHash,
    ),
    uniqueIndex('audio_measurement_sets_id_preprocessing_uq').on(t.id, t.preprocessingId),
    uniqueIndex('audio_measurement_sets_id_workspace_uq').on(t.id, t.workspaceId),
    check('audio_measurement_sets_config_hash_hex', sql`${t.configHash} ~ ${HEX64}`),
    check(
      'audio_measurement_sets_status_valid',
      sql`${t.status} IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')`,
    ),
    check('audio_measurement_sets_attempt_nonnegative', sql`${t.attempt} >= 0`),
    check(
      'audio_measurement_sets_failed_has_error',
      sql`${t.status} <> 'failed' OR ${t.error} IS NOT NULL`,
    ),
    check(
      'audio_measurement_sets_succeeded_complete',
      sql`${t.status} <> 'succeeded' OR (${t.finishedAt} IS NOT NULL AND ${t.seriesUri} IS NOT NULL)`,
    ),
  ],
);

/** Objective measurements per preprocessing version (ADR-0019: no judgements). Immutable. */
export const audioMeasurements = pgTable(
  'audio_measurements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'restrict' }),
    preprocessingId: uuid('preprocessing_id').notNull(),
    /** Null = whole recording. */
    segmentId: uuid('segment_id'),
    source: text('source', { enum: MEASUREMENT_SOURCES }).notNull(),
    schemaVersion: text('schema_version').notNull(),
    measurements: jsonb('measurements').$type<Record<string, unknown>>().notNull(),
    seriesUri: text('series_uri'),
    serviceVersion: text('service_version').notNull(),
    /** Phase 3A: set for Tier 1 (speech-aware) records; null for the Phase 2B preprocess records. */
    measurementSetId: uuid('measurement_set_id'),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: 'audio_measurements_preprocessing_workspace_fk',
      columns: [t.preprocessingId, t.workspaceId],
      foreignColumns: [audioPreprocessings.id, audioPreprocessings.workspaceId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'audio_measurements_segment_preprocessing_fk',
      columns: [t.segmentId, t.preprocessingId],
      foreignColumns: [audioSegments.id, audioSegments.preprocessingId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'audio_measurements_set_preprocessing_fk',
      columns: [t.measurementSetId, t.preprocessingId],
      foreignColumns: [audioMeasurementSets.id, audioMeasurementSets.preprocessingId],
    }).onDelete('cascade'),
    uniqueIndex('audio_measurements_whole_uq')
      .on(t.preprocessingId, t.source)
      .where(sql`${t.segmentId} IS NULL AND ${t.measurementSetId} IS NULL`),
    uniqueIndex('audio_measurements_set_uq')
      .on(t.measurementSetId, t.source)
      .where(sql`${t.measurementSetId} IS NOT NULL`),
    uniqueIndex('audio_measurements_segment_uq')
      .on(t.preprocessingId, t.segmentId, t.source)
      .where(sql`${t.segmentId} IS NOT NULL`),
    index('audio_measurements_preprocessing_idx').on(t.preprocessingId),
    check('audio_measurements_source_valid', sql`${t.source} IN ('original_decoded', 'canonical')`),
    check('audio_measurements_object', sql`jsonb_typeof(${t.measurements}) = 'object'`),
  ],
);

const inList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '));
const workspaceFk = () =>
  uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'restrict' });

/** One row per (run, stage, attempt) of the coordinator (D-2C-01). Lifecycle and progress of a stage. */
export const pipelineStageRuns = pgTable(
  'pipeline_stage_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceFk(),
    runId: uuid('run_id').notNull(),
    node: text('node', { enum: STAGE_NODES }).notNull(),
    attempt: integer('attempt').notNull(),
    status: text('status', { enum: STAGE_STATUSES }).notNull().default('running'),
    progress: jsonb('progress').$type<Record<string, unknown>>(),
    jobIds: jsonb('job_ids').$type<Record<string, unknown>>(),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }),
    finishedAt: timestamp('finished_at', { withTimezone: true, mode: 'date' }),
    /** `{ code }` only, never content. */
    error: jsonb('error').$type<{ code: string }>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: 'pipeline_stage_runs_run_workspace_fk',
      columns: [t.runId, t.workspaceId],
      foreignColumns: [pipelineRuns.id, pipelineRuns.workspaceId],
    }).onDelete('cascade'),
    uniqueIndex('pipeline_stage_runs_run_node_attempt_uq').on(t.runId, t.node, t.attempt),
    check('pipeline_stage_runs_node_valid', sql`${t.node} IN (${inList(STAGE_NODES)})`),
    check('pipeline_stage_runs_status_valid', sql`${t.status} IN (${inList(STAGE_STATUSES)})`),
    check('pipeline_stage_runs_attempt_positive', sql`${t.attempt} >= 1`),
    check(
      'pipeline_stage_runs_failed_has_error',
      sql`${t.status} <> 'failed' OR ${t.error} IS NOT NULL`,
    ),
  ],
);

/**
 * Verbatim provider output reference per transcription window (ADR-0007). Immutable (trigger in
 * 0003). `window_index` is the VAD `audio_segments.index` or the fixed-window index; the bytes are
 * at `payload_uri` and match `sha256`.
 */
export const sttRawOutputs = pgTable(
  'stt_raw_outputs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceFk(),
    runId: uuid('run_id').notNull(),
    windowIndex: integer('window_index').notNull(),
    windowStartMs: bigint('window_start_ms', { mode: 'number' }).notNull(),
    windowEndMs: bigint('window_end_ms', { mode: 'number' }).notNull(),
    provider: text('provider').notNull(),
    providerModel: text('provider_model').notNull(),
    requestParams: jsonb('request_params').$type<Record<string, unknown>>(),
    payloadUri: text('payload_uri').notNull(),
    sha256: text('sha256').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'stt_raw_outputs_run_workspace_fk',
      columns: [t.runId, t.workspaceId],
      foreignColumns: [pipelineRuns.id, pipelineRuns.workspaceId],
    }).onDelete('cascade'),
    uniqueIndex('stt_raw_outputs_run_window_uq').on(t.runId, t.windowIndex),
    uniqueIndex('stt_raw_outputs_id_workspace_uq').on(t.id, t.workspaceId),
    check('stt_raw_outputs_sha256_hex', sql`${t.sha256} ~ ${HEX64}`),
    check('stt_raw_outputs_window_index_nonnegative', sql`${t.windowIndex} >= 0`),
    check(
      'stt_raw_outputs_window_range',
      sql`${t.windowStartMs} >= 0 AND ${t.windowStartMs} < ${t.windowEndMs}`,
    ),
  ],
);

/** Verbatim diarization output reference (ADR-0007, ADR-0016). Immutable (trigger in 0003). */
export const diarizationRawOutputs = pgTable(
  'diarization_raw_outputs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceFk(),
    runId: uuid('run_id').notNull(),
    provider: text('provider').notNull(),
    providerModel: text('provider_model').notNull(),
    scope: text('scope', { enum: RAW_OUTPUT_SCOPES }).notNull(),
    windowStartMs: bigint('window_start_ms', { mode: 'number' }),
    windowEndMs: bigint('window_end_ms', { mode: 'number' }),
    payloadUri: text('payload_uri').notNull(),
    sha256: text('sha256').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'diarization_raw_outputs_run_workspace_fk',
      columns: [t.runId, t.workspaceId],
      foreignColumns: [pipelineRuns.id, pipelineRuns.workspaceId],
    }).onDelete('cascade'),
    uniqueIndex('diarization_raw_outputs_whole_uq')
      .on(t.runId)
      .where(sql`${t.scope} = 'whole'`),
    uniqueIndex('diarization_raw_outputs_window_uq')
      .on(t.runId, t.windowStartMs)
      .where(sql`${t.scope} = 'window'`),
    check('diarization_raw_outputs_scope_valid', sql`${t.scope} IN (${inList(RAW_OUTPUT_SCOPES)})`),
    check('diarization_raw_outputs_sha256_hex', sql`${t.sha256} ~ ${HEX64}`),
    check(
      'diarization_raw_outputs_scope_window',
      sql`(${t.scope} = 'whole' AND ${t.windowStartMs} IS NULL AND ${t.windowEndMs} IS NULL) OR (${t.scope} = 'window' AND ${t.windowStartMs} IS NOT NULL AND ${t.windowEndMs} IS NOT NULL AND ${t.windowStartMs} >= 0 AND ${t.windowStartMs} < ${t.windowEndMs})`,
    ),
  ],
);

/** The run's transcript (1:1 with the run, ADR-0015). Versions hold the content. */
export const transcripts = pgTable(
  'transcripts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceFk(),
    runId: uuid('run_id').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: 'transcripts_run_workspace_fk',
      columns: [t.runId, t.workspaceId],
      foreignColumns: [pipelineRuns.id, pipelineRuns.workspaceId],
    }).onDelete('cascade'),
    uniqueIndex('transcripts_run_uq').on(t.runId),
    uniqueIndex('transcripts_id_workspace_uq').on(t.id, t.workspaceId),
  ],
);

/** Immutable transcript version (ADR-0007). v1 is always `machine`. Update blocked by trigger in 0003. */
export const transcriptVersions = pgTable(
  'transcript_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceFk(),
    transcriptId: uuid('transcript_id').notNull(),
    version: integer('version').notNull(),
    kind: text('kind', { enum: TRANSCRIPT_VERSION_KINDS }).notNull(),
    baseVersionId: uuid('base_version_id'),
    /** `system` for machine versions, a principal ID for corrections. */
    createdBy: text('created_by').notNull(),
    note: text('note'),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: 'transcript_versions_transcript_workspace_fk',
      columns: [t.transcriptId, t.workspaceId],
      foreignColumns: [transcripts.id, transcripts.workspaceId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'transcript_versions_base_workspace_fk',
      columns: [t.baseVersionId, t.workspaceId],
      foreignColumns: [t.id, t.workspaceId],
    }),
    uniqueIndex('transcript_versions_transcript_version_uq').on(t.transcriptId, t.version),
    uniqueIndex('transcript_versions_id_workspace_uq').on(t.id, t.workspaceId),
    check('transcript_versions_version_positive', sql`${t.version} >= 1`),
    check(
      'transcript_versions_kind_valid',
      sql`${t.kind} IN (${inList(TRANSCRIPT_VERSION_KINDS)})`,
    ),
    check('transcript_versions_v1_machine', sql`${t.version} <> 1 OR ${t.kind} = 'machine'`),
    check(
      'transcript_versions_correction_has_base',
      sql`${t.kind} = 'machine' OR ${t.baseVersionId} IS NOT NULL`,
    ),
  ],
);

/** `speaker_key` is the machine ID and immutable (trigger in 0003); `display_name` is user-editable and audited. */
export const speakers = pgTable(
  'speakers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceFk(),
    transcriptId: uuid('transcript_id').notNull(),
    speakerKey: text('speaker_key').notNull(),
    displayName: text('display_name'),
    totalSpeechMs: bigint('total_speech_ms', { mode: 'number' }).notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: 'speakers_transcript_workspace_fk',
      columns: [t.transcriptId, t.workspaceId],
      foreignColumns: [transcripts.id, transcripts.workspaceId],
    }).onDelete('cascade'),
    uniqueIndex('speakers_transcript_key_uq').on(t.transcriptId, t.speakerKey),
    uniqueIndex('speakers_id_workspace_uq').on(t.id, t.workspaceId),
    check('speakers_total_speech_nonnegative', sql`${t.totalSpeechMs} >= 0`),
  ],
);

/** Immutable segment of a transcript version (update blocked by trigger in 0003). Times are canonical-timeline ms. */
export const transcriptSegments = pgTable(
  'transcript_segments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceFk(),
    transcriptVersionId: uuid('transcript_version_id').notNull(),
    speakerId: uuid('speaker_id'),
    startMs: bigint('start_ms', { mode: 'number' }).notNull(),
    endMs: bigint('end_ms', { mode: 'number' }).notNull(),
    /** Original script as produced by the provider (or corrected in a later version). */
    text: text('text').notNull(),
    language: text('language', { enum: TRANSCRIPT_LANGUAGES }).notNull(),
    codeSwitchSpans:
      jsonb('code_switch_spans').$type<
        { startChar: number; endChar: number; language: 'en' | 'hi' }[]
      >(),
    /** Null when the provider gave none: never estimated. */
    confidence: doublePrecision('confidence'),
    words:
      jsonb('words').$type<
        { startMs: number; endMs: number; text: string; confidence?: number }[]
      >(),
    /** `stt_raw_outputs` ids this segment was mapped from (machine versions). */
    sourceRawOutputIds: uuid('source_raw_output_ids').array(),
    /** Segment of the base version this one corrects (correction versions; not used yet). */
    sourceSegmentId: uuid('source_segment_id'),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: 'transcript_segments_version_workspace_fk',
      columns: [t.transcriptVersionId, t.workspaceId],
      foreignColumns: [transcriptVersions.id, transcriptVersions.workspaceId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'transcript_segments_speaker_workspace_fk',
      columns: [t.speakerId, t.workspaceId],
      foreignColumns: [speakers.id, speakers.workspaceId],
    }).onDelete('cascade'), // speakers are only deleted with their transcript (direct DELETE refused by a trigger, 0004); avoids a NO ACTION check mid-cascade
    foreignKey({
      name: 'transcript_segments_source_segment_workspace_fk',
      columns: [t.sourceSegmentId, t.workspaceId],
      foreignColumns: [t.id, t.workspaceId],
    }),
    uniqueIndex('transcript_segments_id_workspace_uq').on(t.id, t.workspaceId),
    index('transcript_segments_version_start_idx').on(t.transcriptVersionId, t.startMs, t.id),
    check('transcript_segments_range_valid', sql`${t.startMs} >= 0 AND ${t.startMs} < ${t.endMs}`),
    check(
      'transcript_segments_language_valid',
      sql`${t.language} IN (${inList(TRANSCRIPT_LANGUAGES)})`,
    ),
    check(
      'transcript_segments_confidence_range',
      sql`${t.confidence} IS NULL OR (${t.confidence} >= 0 AND ${t.confidence} <= 1)`,
    ),
  ],
);

/** Transcription uncertainty spans; no link to audio diagnostics (ADR-0019). */
export const transcriptionUncertainties = pgTable(
  'transcription_uncertainties',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceFk(),
    transcriptVersionId: uuid('transcript_version_id').notNull(),
    segmentId: uuid('segment_id'),
    startMs: bigint('start_ms', { mode: 'number' }).notNull(),
    endMs: bigint('end_ms', { mode: 'number' }).notNull(),
    kind: text('kind', { enum: UNCERTAINTY_KINDS }).notNull(),
    score: doublePrecision('score'),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: 'transcription_uncertainties_version_workspace_fk',
      columns: [t.transcriptVersionId, t.workspaceId],
      foreignColumns: [transcriptVersions.id, transcriptVersions.workspaceId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'transcription_uncertainties_segment_workspace_fk',
      columns: [t.segmentId, t.workspaceId],
      foreignColumns: [transcriptSegments.id, transcriptSegments.workspaceId],
    }).onDelete('cascade'),
    index('transcription_uncertainties_version_start_idx').on(
      t.transcriptVersionId,
      t.startMs,
      t.id,
    ),
    check(
      'transcription_uncertainties_range_valid',
      sql`${t.startMs} >= 0 AND ${t.startMs} <= ${t.endMs}`,
    ),
    check(
      'transcription_uncertainties_kind_valid',
      sql`${t.kind} IN (${inList(UNCERTAINTY_KINDS)})`,
    ),
    check(
      'transcription_uncertainties_score_range',
      sql`${t.score} IS NULL OR (${t.score} >= 0 AND ${t.score} <= 1)`,
    ),
  ],
);

export type Workspace = typeof workspaces.$inferSelect;
export type Recording = typeof recordings.$inferSelect;
export type NewRecording = typeof recordings.$inferInsert;
export type UploadSessionRow = typeof uploadSessions.$inferSelect;
export type PipelineRun = typeof pipelineRuns.$inferSelect;
export type AuditEvent = typeof auditEvents.$inferInsert;
export type AudioPreprocessing = typeof audioPreprocessings.$inferSelect;
export type AudioSegment = typeof audioSegments.$inferSelect;
export type NewAudioSegment = typeof audioSegments.$inferInsert;
export type AudioMeasurement = typeof audioMeasurements.$inferSelect;
export type AudioMeasurementSet = typeof audioMeasurementSets.$inferSelect;
export type AudioDiagnostic = typeof audioDiagnostics.$inferSelect;
export type AudioDiagnosticFlagRow = typeof audioDiagnosticFlags.$inferSelect;
export type NewAudioMeasurement = typeof audioMeasurements.$inferInsert;
export type PipelineStageRun = typeof pipelineStageRuns.$inferSelect;
export type SttRawOutput = typeof sttRawOutputs.$inferSelect;
export type DiarizationRawOutput = typeof diarizationRawOutputs.$inferSelect;
export type Transcript = typeof transcripts.$inferSelect;
export type TranscriptVersion = typeof transcriptVersions.$inferSelect;
export type Speaker = typeof speakers.$inferSelect;
export type TranscriptSegment = typeof transcriptSegments.$inferSelect;
export type TranscriptionUncertainty = typeof transcriptionUncertainties.$inferSelect;

/**
 * Phase 3A: A1 Audio Quality output, run-scoped (ADR-0043 / ADR-0044). Written only by the A1
 * repository; immutable after insert (trigger in 0005): a re-assessment inserts a new row.
 */
export const audioDiagnostics = pgTable(
  'audio_diagnostics',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceFk(),
    runId: uuid('run_id').notNull(),
    preprocessingId: uuid('preprocessing_id').notNull(),
    measurementSetId: uuid('measurement_set_id'),
    attempt: integer('attempt').notNull(),
    ruleVersion: text('rule_version').notNull(),
    provisional: boolean('provisional').notNull(),
    overall: text('overall', { enum: AUDIO_QUALITY_CLASSES }).notNull(),
    confidence: text('confidence', { enum: CONFIDENCE_LEVELS }).notNull(),
    suitability: jsonb('suitability').$type<Record<string, unknown>>().notNull(),
    notAssessed: jsonb('not_assessed').$type<unknown[]>().notNull(),
    recommendations: jsonb('recommendations').$type<unknown[]>().notNull(),
    affectedRatio: doublePrecision('affected_ratio'),
    tier1: text('tier1').notNull(),
    ruleConfig: jsonb('rule_config').$type<Record<string, unknown>>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: 'audio_diagnostics_run_workspace_fk',
      columns: [t.runId, t.workspaceId],
      foreignColumns: [pipelineRuns.id, pipelineRuns.workspaceId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'audio_diagnostics_preprocessing_workspace_fk',
      columns: [t.preprocessingId, t.workspaceId],
      foreignColumns: [audioPreprocessings.id, audioPreprocessings.workspaceId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'audio_diagnostics_set_preprocessing_fk',
      columns: [t.measurementSetId, t.preprocessingId],
      foreignColumns: [audioMeasurementSets.id, audioMeasurementSets.preprocessingId],
    }).onDelete('cascade'),
    uniqueIndex('audio_diagnostics_run_attempt_uq').on(t.runId, t.attempt),
    uniqueIndex('audio_diagnostics_id_workspace_uq').on(t.id, t.workspaceId),
    index('audio_diagnostics_run_idx').on(t.runId, t.createdAt.desc()),
    check(
      'audio_diagnostics_overall_valid',
      sql`${t.overall} IN (${inList(AUDIO_QUALITY_CLASSES)})`,
    ),
    check(
      'audio_diagnostics_confidence_valid',
      sql`${t.confidence} IN (${inList(CONFIDENCE_LEVELS)})`,
    ),
    check('audio_diagnostics_attempt_positive', sql`${t.attempt} >= 1`),
    check(
      'audio_diagnostics_affected_ratio_range',
      sql`${t.affectedRatio} IS NULL OR (${t.affectedRatio} >= 0 AND ${t.affectedRatio} <= 1)`,
    ),
    check('audio_diagnostics_suitability_object', sql`jsonb_typeof(${t.suitability}) = 'object'`),
    check('audio_diagnostics_not_assessed_array', sql`jsonb_typeof(${t.notAssessed}) = 'array'`),
    check(
      'audio_diagnostics_recommendations_array',
      sql`jsonb_typeof(${t.recommendations}) = 'array'`,
    ),
  ],
);

/** Phase 3A: A1 flags (ADR-0043). Immutable; deleted only by cascade. */
export const audioDiagnosticFlags = pgTable(
  'audio_diagnostic_flags',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: workspaceFk(),
    diagnosticsId: uuid('diagnostics_id').notNull(),
    kind: text('kind', { enum: DIAGNOSTIC_FLAG_KINDS }).notNull(),
    severity: text('severity', { enum: FLAG_SEVERITIES }).notNull(),
    startMs: bigint('start_ms', { mode: 'number' }),
    endMs: bigint('end_ms', { mode: 'number' }),
    basis: text('basis', { enum: EVIDENCE_BASES }).notNull(),
    ruleId: text('rule_id').notNull(),
    measurementRefs: jsonb('measurement_refs').$type<unknown[]>().notNull(),
  },
  (t) => [
    foreignKey({
      name: 'audio_diagnostic_flags_diagnostics_workspace_fk',
      columns: [t.diagnosticsId, t.workspaceId],
      foreignColumns: [audioDiagnostics.id, audioDiagnostics.workspaceId],
    }).onDelete('cascade'),
    index('audio_diagnostic_flags_diagnostics_start_idx').on(t.diagnosticsId, t.startMs),
    check(
      'audio_diagnostic_flags_kind_valid',
      sql`${t.kind} IN (${inList(DIAGNOSTIC_FLAG_KINDS)})`,
    ),
    check(
      'audio_diagnostic_flags_severity_valid',
      sql`${t.severity} IN (${inList(FLAG_SEVERITIES)})`,
    ),
    check('audio_diagnostic_flags_basis_valid', sql`${t.basis} IN (${inList(EVIDENCE_BASES)})`),
    check(
      'audio_diagnostic_flags_range_valid',
      sql`(${t.startMs} IS NULL AND ${t.endMs} IS NULL) OR (${t.startMs} >= 0 AND ${t.endMs} > ${t.startMs})`,
    ),
    check('audio_diagnostic_flags_refs_array', sql`jsonb_typeof(${t.measurementRefs}) = 'array'`),
  ],
);
