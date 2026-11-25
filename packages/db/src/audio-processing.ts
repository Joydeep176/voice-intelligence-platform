/**
 * Shared repository functions for audio preprocessing (Phase 2B plan §12, DATABASE_DESIGN §4).
 * Every function takes the workspace ID and filters by it. Every state change is a guarded
 * conditional UPDATE that reports whether it applied, so duplicate or concurrent workers cannot
 * move a row backwards (for example succeeded -> running). Pass a transaction or the database.
 */
import { and, asc, desc, eq, gt, inArray, isNull, lt, sql, type SQL } from 'drizzle-orm';
import type { Database } from './client.js';
import {
  audioMeasurements,
  audioPreprocessings,
  audioSegments,
  recordings,
  type AudioMeasurement,
  type AudioPreprocessing,
  type AudioSegment,
} from './schema.js';

/** A database handle or a transaction (a transaction is assignable to `Database`). */
export type Executor = Database;

const INSERT_CHUNK = 500;
const MAX_LIST_LIMIT = 5_000;

const scoped = (workspaceId: string, id: string) =>
  and(eq(audioPreprocessings.workspaceId, workspaceId), eq(audioPreprocessings.id, id));

export interface UpsertPreprocessingInput {
  workspaceId: string;
  recordingId: string;
  configHash: string;
  config: Record<string, unknown>;
  toolVersions: Record<string, unknown>;
}

/**
 * Returns the existing version for (recording, config hash) or inserts a `queued` one.
 * Never modifies an existing row, so a `succeeded` version is never reset.
 */
export async function upsertPreprocessing(
  tx: Executor,
  input: UpsertPreprocessingInput,
): Promise<{ preprocessing: AudioPreprocessing; created: boolean }> {
  const inserted = await tx
    .insert(audioPreprocessings)
    .values({
      workspaceId: input.workspaceId,
      recordingId: input.recordingId,
      configHash: input.configHash,
      config: input.config,
      toolVersions: input.toolVersions,
    })
    .onConflictDoNothing({
      target: [audioPreprocessings.recordingId, audioPreprocessings.configHash],
    })
    .returning();
  if (inserted[0]) return { preprocessing: inserted[0], created: true };

  const [existing] = await tx
    .select()
    .from(audioPreprocessings)
    .where(
      and(
        eq(audioPreprocessings.workspaceId, input.workspaceId),
        eq(audioPreprocessings.recordingId, input.recordingId),
        eq(audioPreprocessings.configHash, input.configHash),
      ),
    );
  if (!existing) throw new Error('Preprocessing conflict row not found in this workspace.');
  return { preprocessing: existing, created: false };
}

export async function getPreprocessing(
  tx: Executor,
  workspaceId: string,
  id: string,
): Promise<AudioPreprocessing | null> {
  const [row] = await tx.select().from(audioPreprocessings).where(scoped(workspaceId, id));
  return row ?? null;
}

export async function getLatestPreprocessingForRecording(
  tx: Executor,
  workspaceId: string,
  recordingId: string,
): Promise<AudioPreprocessing | null> {
  const [row] = await tx
    .select()
    .from(audioPreprocessings)
    .where(
      and(
        eq(audioPreprocessings.workspaceId, workspaceId),
        eq(audioPreprocessings.recordingId, recordingId),
      ),
    )
    .orderBy(desc(audioPreprocessings.createdAt), desc(audioPreprocessings.id))
    .limit(1);
  return row ?? null;
}

type Status = AudioPreprocessing['status'];

/** Guarded UPDATE: applies only when the current status is in `from`. */
async function guardedUpdate(
  tx: Executor,
  workspaceId: string,
  id: string,
  from: Status[],
  set: Partial<typeof audioPreprocessings.$inferInsert>,
): Promise<boolean> {
  const rows = await tx
    .update(audioPreprocessings)
    .set({ ...set, updatedAt: new Date() })
    .where(and(scoped(workspaceId, id), inArray(audioPreprocessings.status, from)))
    .returning({ id: audioPreprocessings.id });
  return rows.length === 1;
}

/** queued -> running. */
export const markRunning = (tx: Executor, workspaceId: string, id: string) =>
  guardedUpdate(tx, workspaceId, id, ['queued'], { status: 'running', startedAt: new Date() });

/** Only while running. */
export const updateProgress = (
  tx: Executor,
  workspaceId: string,
  id: string,
  progress: Record<string, unknown>,
) => guardedUpdate(tx, workspaceId, id, ['running'], { progress });

/** Records the request on a queued or running version; no effect once it is terminal. */
export async function requestCancel(
  tx: Executor,
  workspaceId: string,
  id: string,
): Promise<boolean> {
  const rows = await tx
    .update(audioPreprocessings)
    .set({ cancelRequestedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        scoped(workspaceId, id),
        inArray(audioPreprocessings.status, ['queued', 'running']),
        isNull(audioPreprocessings.cancelRequestedAt),
      ),
    )
    .returning({ id: audioPreprocessings.id });
  return rows.length === 1;
}

/** queued|running -> failed. `error` holds a code and retryability only, never content. */
export const markFailed = (
  tx: Executor,
  workspaceId: string,
  id: string,
  error: { code: string; retryable: boolean },
) =>
  guardedUpdate(tx, workspaceId, id, ['queued', 'running'], {
    status: 'failed',
    error: { code: error.code, retryable: error.retryable },
    finishedAt: new Date(),
  });

/** queued|running -> cancelled. */
export const markCancelled = (tx: Executor, workspaceId: string, id: string) =>
  guardedUpdate(tx, workspaceId, id, ['queued', 'running'], {
    status: 'cancelled',
    finishedAt: new Date(),
  });

/**
 * Counts an execution attempt while the version is queued or running. With `expectedAttempt` it
 * is a compare-and-set (`attempt = expected`): of several observers that saw the same value only
 * one applies, so one confirmed loss or failure is counted exactly once.
 */
export async function incrementAttempt(
  tx: Executor,
  workspaceId: string,
  id: string,
  expectedAttempt?: number,
): Promise<boolean> {
  const rows = await tx
    .update(audioPreprocessings)
    .set({ attempt: sql`${audioPreprocessings.attempt} + 1`, updatedAt: new Date() })
    .where(
      and(
        scoped(workspaceId, id),
        inArray(audioPreprocessings.status, ['queued', 'running']),
        ...(expectedAttempt === undefined
          ? []
          : [eq(audioPreprocessings.attempt, expectedAttempt)]),
      ),
    )
    .returning({ id: audioPreprocessings.id });
  return rows.length === 1;
}

/**
 * failed|cancelled -> queued. Clears error, cancel request, progress and timestamps; keeps the
 * attempt count. Deletes nothing: a failed or cancelled version has no segments (completion is atomic).
 */
export const resetForRetry = (tx: Executor, workspaceId: string, id: string) =>
  guardedUpdate(tx, workspaceId, id, ['failed', 'cancelled'], {
    status: 'queued',
    error: null,
    cancelRequestedAt: null,
    progress: null,
    startedAt: null,
    finishedAt: null,
  });

export interface SegmentInput {
  index: number;
  startMs: number;
  endMs: number;
  overlapStartMs?: number;
  overlapEndMs?: number;
  speechMs: number;
  containsSyntheticGap?: boolean;
  storageUri?: string | null;
}

export interface MeasurementInput {
  /** Index of the segment this measurement describes; null/undefined = whole recording. */
  segmentIndex?: number | null;
  source: 'original_decoded' | 'canonical';
  schemaVersion: string;
  measurements: Record<string, unknown>;
  seriesUri?: string | null;
  serviceVersion: string;
}

export interface CompletePreprocessingInput {
  workspaceId: string;
  id: string;
  normalizedUri: string;
  canonicalSha256: string;
  canonicalDurationMs: number;
  timeline: Record<string, unknown>;
  vad?: Record<string, unknown> | null;
  artifacts?: Record<string, unknown> | null;
  segments: SegmentInput[];
  measurements: MeasurementInput[];
}

/**
 * Atomically: guarded running -> succeeded, then bulk insert segments and measurements.
 * If the guard does not apply (already completed, cancelled, failed), nothing is inserted.
 */
export function completePreprocessing(
  tx: Executor,
  input: CompletePreprocessingInput,
): Promise<boolean> {
  return tx.transaction(async (inner) => {
    const applied = await guardedUpdate(inner, input.workspaceId, input.id, ['running'], {
      status: 'succeeded',
      normalizedUri: input.normalizedUri,
      canonicalSha256: input.canonicalSha256,
      canonicalDurationMs: input.canonicalDurationMs,
      timeline: input.timeline,
      vad: input.vad ?? null,
      artifacts: input.artifacts ?? null,
      progress: null,
      finishedAt: new Date(),
    });
    if (!applied) return false;

    const segmentIdByIndex = new Map<number, string>();
    for (let i = 0; i < input.segments.length; i += INSERT_CHUNK) {
      const rows = await inner
        .insert(audioSegments)
        .values(
          input.segments.slice(i, i + INSERT_CHUNK).map((s) => ({
            workspaceId: input.workspaceId,
            preprocessingId: input.id,
            index: s.index,
            startMs: s.startMs,
            endMs: s.endMs,
            overlapStartMs: s.overlapStartMs ?? 0,
            overlapEndMs: s.overlapEndMs ?? 0,
            speechMs: s.speechMs,
            containsSyntheticGap: s.containsSyntheticGap ?? false,
            storageUri: s.storageUri ?? null,
          })),
        )
        .returning({ id: audioSegments.id, index: audioSegments.index });
      for (const row of rows) segmentIdByIndex.set(row.index, row.id);
    }

    for (let i = 0; i < input.measurements.length; i += INSERT_CHUNK) {
      await inner.insert(audioMeasurements).values(
        input.measurements.slice(i, i + INSERT_CHUNK).map((m) => {
          let segmentId: string | null = null;
          if (m.segmentIndex !== null && m.segmentIndex !== undefined) {
            segmentId = segmentIdByIndex.get(m.segmentIndex) ?? null;
            if (!segmentId) throw new Error('Measurement references an unknown segment index.');
          }
          return {
            workspaceId: input.workspaceId,
            preprocessingId: input.id,
            segmentId,
            source: m.source,
            schemaVersion: m.schemaVersion,
            measurements: m.measurements,
            seriesUri: m.seriesUri ?? null,
            serviceVersion: m.serviceVersion,
          };
        }),
      );
    }
    return true;
  });
}

export interface ListSegmentsOptions {
  /** Include segments ending after this canonical position. */
  fromMs?: number;
  /** Include segments starting before this canonical position. */
  toMs?: number;
  limit: number;
}

export async function listSegments(
  tx: Executor,
  workspaceId: string,
  preprocessingId: string,
  options: ListSegmentsOptions,
): Promise<AudioSegment[]> {
  const conditions: SQL[] = [
    eq(audioSegments.workspaceId, workspaceId),
    eq(audioSegments.preprocessingId, preprocessingId),
  ];
  if (options.fromMs !== undefined) conditions.push(gt(audioSegments.endMs, options.fromMs));
  if (options.toMs !== undefined) conditions.push(lt(audioSegments.startMs, options.toMs));
  return tx
    .select()
    .from(audioSegments)
    .where(and(...conditions))
    .orderBy(asc(audioSegments.startMs), asc(audioSegments.index))
    .limit(Math.max(1, Math.min(options.limit, MAX_LIST_LIMIT)));
}

export async function getMeasurements(
  tx: Executor,
  workspaceId: string,
  preprocessingId: string,
  options: { segmentId?: string | null } = {},
): Promise<AudioMeasurement[]> {
  const conditions: SQL[] = [
    eq(audioMeasurements.workspaceId, workspaceId),
    eq(audioMeasurements.preprocessingId, preprocessingId),
  ];
  if (options.segmentId === null) conditions.push(isNull(audioMeasurements.segmentId));
  else if (options.segmentId !== undefined)
    conditions.push(eq(audioMeasurements.segmentId, options.segmentId));
  return tx
    .select()
    .from(audioMeasurements)
    .where(and(...conditions))
    .orderBy(asc(audioMeasurements.createdAt), asc(audioMeasurements.id));
}

export interface RecordingProbeInput {
  status: 'valid' | 'invalid';
  mediaProbe?: Record<string, unknown>;
  durationMs?: number;
  sampleRate?: number;
  channels?: number;
  validationError?: string;
}

/** uploaded -> validating. Only from `uploaded` (no implicit re-probe). */
export async function markRecordingValidating(
  tx: Executor,
  workspaceId: string,
  recordingId: string,
): Promise<boolean> {
  const rows = await tx
    .update(recordings)
    .set({ status: 'validating', updatedAt: new Date() })
    .where(
      and(
        eq(recordings.workspaceId, workspaceId),
        eq(recordings.id, recordingId),
        eq(recordings.status, 'uploaded'),
      ),
    )
    .returning({ id: recordings.id });
  return rows.length === 1;
}

/** validating -> valid|invalid, recording the probe results. */
export async function setRecordingProbe(
  tx: Executor,
  workspaceId: string,
  recordingId: string,
  input: RecordingProbeInput,
): Promise<boolean> {
  const rows = await tx
    .update(recordings)
    .set({
      status: input.status,
      mediaProbe: input.mediaProbe ?? null,
      durationMs: input.durationMs ?? null,
      sampleRate: input.sampleRate ?? null,
      channels: input.channels ?? null,
      validationError: input.validationError ?? null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(recordings.workspaceId, workspaceId),
        eq(recordings.id, recordingId),
        eq(recordings.status, 'validating'),
      ),
    )
    .returning({ id: recordings.id });
  return rows.length === 1;
}

/**
 * validating -> uploaded. Used when validation could not finish for a reason that is not the
 * file's fault (service fault, retries exhausted): the recording stays explicitly re-requestable.
 */
export async function resetRecordingToUploaded(
  tx: Executor,
  workspaceId: string,
  recordingId: string,
): Promise<boolean> {
  const rows = await tx
    .update(recordings)
    .set({ status: 'uploaded', updatedAt: new Date() })
    .where(
      and(
        eq(recordings.workspaceId, workspaceId),
        eq(recordings.id, recordingId),
        eq(recordings.status, 'validating'),
      ),
    )
    .returning({ id: recordings.id });
  return rows.length === 1;
}
