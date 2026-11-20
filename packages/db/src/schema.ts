/**
 * Phase 1 foundation schema: a subset of DATABASE_DESIGN §4. Table and column names follow
 * that document. Enum values come from `@vip/contracts`, so the API contract and the database
 * cannot drift. This file has no relative imports, so drizzle-kit can load it directly.
 */
import { RECORDING_STATUSES, RUN_STATUSES } from '@vip/contracts';
import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
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
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('recordings_workspace_created_idx').on(t.workspaceId, t.createdAt.desc(), t.id.desc()),
    uniqueIndex('recordings_storage_uri_uq').on(t.storageUri),
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
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }),
    finishedAt: timestamp('finished_at', { withTimezone: true, mode: 'date' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('pipeline_runs_recording_created_idx').on(t.recordingId, t.createdAt.desc()),
    index('pipeline_runs_workspace_idx').on(t.workspaceId),
    check('pipeline_runs_retry_nonnegative', sql`${t.retryCount} >= 0`),
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

export type Workspace = typeof workspaces.$inferSelect;
export type Recording = typeof recordings.$inferSelect;
export type NewRecording = typeof recordings.$inferInsert;
export type UploadSessionRow = typeof uploadSessions.$inferSelect;
export type PipelineRun = typeof pipelineRuns.$inferSelect;
export type AuditEvent = typeof auditEvents.$inferInsert;
