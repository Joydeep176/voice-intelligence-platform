/**
 * Phase 3A repositories (ADR-0043 / ADR-0044 / ADR-0045 / ADR-0046).
 *
 * Two write surfaces, kept apart on purpose:
 * - measurement sets: written by the preprocessing coordinator (objective numbers only);
 * - diagnostics: written by A1 only.
 * This module imports no transcription table (AGENT_ARCHITECTURE §2.2; enforced by a test). Every
 * function is workspace-scoped; state changes are guarded conditional UPDATEs.
 */
import {
  AudioQualitySummary,
  type AudioQualityLookup,
  type AudioQualityReader,
} from '@vip/contracts';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Executor } from './audio-processing.js';
import {
  audioDiagnosticFlags,
  audioDiagnostics,
  audioMeasurementSets,
  audioMeasurements,
  type AudioDiagnostic,
  type AudioDiagnosticFlagRow,
  type AudioMeasurement,
  type AudioMeasurementSet,
} from './schema.js';

/* -- measurement sets (preprocessing coordinator) ------------------------------------------------ */

const setScope = (workspaceId: string, id: string) =>
  and(eq(audioMeasurementSets.workspaceId, workspaceId), eq(audioMeasurementSets.id, id));

/** One set per (preprocessing version, measure config hash); returns the existing row on conflict. */
export async function upsertMeasurementSet(
  tx: Executor,
  input: {
    workspaceId: string;
    preprocessingId: string;
    configHash: string;
    config: Record<string, unknown>;
  },
): Promise<{ set: AudioMeasurementSet; created: boolean }> {
  const [inserted] = await tx
    .insert(audioMeasurementSets)
    .values(input)
    .onConflictDoNothing({
      target: [audioMeasurementSets.preprocessingId, audioMeasurementSets.configHash],
    })
    .returning();
  if (inserted) return { set: inserted, created: true };
  const [existing] = await tx
    .select()
    .from(audioMeasurementSets)
    .where(
      and(
        eq(audioMeasurementSets.workspaceId, input.workspaceId),
        eq(audioMeasurementSets.preprocessingId, input.preprocessingId),
        eq(audioMeasurementSets.configHash, input.configHash),
      ),
    );
  if (!existing) throw new Error('measurement set conflict without a row');
  return { set: existing, created: false };
}

export async function getMeasurementSet(
  tx: Executor,
  workspaceId: string,
  id: string,
): Promise<AudioMeasurementSet | null> {
  const [row] = await tx.select().from(audioMeasurementSets).where(setScope(workspaceId, id));
  return row ?? null;
}

/** Newest set of a preprocessing version (any status). */
export async function getLatestMeasurementSet(
  tx: Executor,
  workspaceId: string,
  preprocessingId: string,
): Promise<AudioMeasurementSet | null> {
  const [row] = await tx
    .select()
    .from(audioMeasurementSets)
    .where(
      and(
        eq(audioMeasurementSets.workspaceId, workspaceId),
        eq(audioMeasurementSets.preprocessingId, preprocessingId),
      ),
    )
    .orderBy(desc(audioMeasurementSets.createdAt), desc(audioMeasurementSets.id))
    .limit(1);
  return row ?? null;
}

async function guardedSetUpdate(
  tx: Executor,
  workspaceId: string,
  id: string,
  from: AudioMeasurementSet['status'][],
  set: Partial<typeof audioMeasurementSets.$inferInsert>,
): Promise<boolean> {
  const rows = await tx
    .update(audioMeasurementSets)
    .set({ ...set, updatedAt: new Date() })
    .where(and(setScope(workspaceId, id), inArray(audioMeasurementSets.status, from)))
    .returning({ id: audioMeasurementSets.id });
  return rows.length === 1;
}

export const markSetRunning = (tx: Executor, workspaceId: string, id: string) =>
  guardedSetUpdate(tx, workspaceId, id, ['queued'], { status: 'running', startedAt: new Date() });

/**
 * Liveness heartbeat of a running set (refreshes `updated_at` only): the stuck-set sweep must not
 * fail a set whose measure task is still queued or running in the audio service.
 */
export const touchRunningSet = (tx: Executor, workspaceId: string, id: string) =>
  guardedSetUpdate(tx, workspaceId, id, ['running'], {});

export const markSetFailed = (
  tx: Executor,
  workspaceId: string,
  id: string,
  error: { code: string; retryable: boolean },
) =>
  guardedSetUpdate(tx, workspaceId, id, ['queued', 'running'], {
    status: 'failed',
    error: { code: error.code, retryable: error.retryable },
    finishedAt: new Date(),
  });

export const markSetCancelled = (tx: Executor, workspaceId: string, id: string) =>
  guardedSetUpdate(tx, workspaceId, id, ['queued', 'running'], {
    status: 'cancelled',
    finishedAt: new Date(),
  });

/** failed|cancelled -> queued (keeps the attempt count). */
export const resetSetForRetry = (tx: Executor, workspaceId: string, id: string) =>
  guardedSetUpdate(tx, workspaceId, id, ['failed', 'cancelled'], {
    status: 'queued',
    error: null,
    cancelRequestedAt: null,
    startedAt: null,
    finishedAt: null,
  });

/** Compare-and-set attempt counter while queued or running. */
export async function incrementSetAttempt(
  tx: Executor,
  workspaceId: string,
  id: string,
  expectedAttempt?: number,
): Promise<boolean> {
  const rows = await tx
    .update(audioMeasurementSets)
    .set({ attempt: sql`${audioMeasurementSets.attempt} + 1`, updatedAt: new Date() })
    .where(
      and(
        setScope(workspaceId, id),
        inArray(audioMeasurementSets.status, ['queued', 'running']),
        ...(expectedAttempt === undefined
          ? []
          : [eq(audioMeasurementSets.attempt, expectedAttempt)]),
      ),
    )
    .returning({ id: audioMeasurementSets.id });
  return rows.length === 1;
}

/** running -> succeeded, atomically with the immutable Tier 1 measurement record. */
export function completeMeasurementSet(
  db: Executor,
  input: {
    workspaceId: string;
    id: string;
    seriesUri: string;
    toolVersions: Record<string, unknown>;
    measurements: Record<string, unknown>;
    schemaVersion: string;
    serviceVersion: string;
  },
): Promise<boolean> {
  return db.transaction(async (inner) => {
    const [row] = await inner
      .update(audioMeasurementSets)
      .set({
        status: 'succeeded',
        seriesUri: input.seriesUri,
        toolVersions: input.toolVersions,
        error: null,
        finishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(setScope(input.workspaceId, input.id), eq(audioMeasurementSets.status, 'running')))
      .returning();
    if (!row) return false;
    await inner.insert(audioMeasurements).values({
      workspaceId: input.workspaceId,
      preprocessingId: row.preprocessingId,
      measurementSetId: row.id,
      source: 'canonical',
      schemaVersion: input.schemaVersion,
      measurements: input.measurements,
      seriesUri: input.seriesUri,
      serviceVersion: input.serviceVersion,
    });
    return true;
  });
}

/** The Tier 1 record of a succeeded set, or null. */
export async function getSetMeasurement(
  tx: Executor,
  workspaceId: string,
  measurementSetId: string,
): Promise<AudioMeasurement | null> {
  const [row] = await tx
    .select()
    .from(audioMeasurements)
    .where(
      and(
        eq(audioMeasurements.workspaceId, workspaceId),
        eq(audioMeasurements.measurementSetId, measurementSetId),
      ),
    );
  return row ?? null;
}

/** Sets stuck in queued/running whose row has not moved since `cutoff` (for the sweeper). */
export function listStuckMeasurementSets(
  tx: Executor,
  cutoff: Date,
  limit: number,
): Promise<AudioMeasurementSet[]> {
  return tx
    .select()
    .from(audioMeasurementSets)
    .where(
      and(
        inArray(audioMeasurementSets.status, ['queued', 'running']),
        sql`${audioMeasurementSets.updatedAt} < ${cutoff}`,
      ),
    )
    .orderBy(asc(audioMeasurementSets.updatedAt))
    .limit(limit);
}

/* -- diagnostics (A1 only) ------------------------------------------------------------------------ */

export interface DiagnosticFlagInput {
  kind: AudioDiagnosticFlagRow['kind'];
  severity: AudioDiagnosticFlagRow['severity'];
  startMs: number | null;
  endMs: number | null;
  basis: AudioDiagnosticFlagRow['basis'];
  ruleId: string;
  measurementRefs: unknown[];
}

export interface DiagnosticsInput {
  workspaceId: string;
  runId: string;
  preprocessingId: string;
  measurementSetId: string | null;
  attempt: number;
  ruleVersion: string;
  provisional: boolean;
  overall: AudioDiagnostic['overall'];
  confidence: AudioDiagnostic['confidence'];
  suitability: Record<string, unknown>;
  notAssessed: unknown[];
  recommendations: unknown[];
  affectedRatio: number | null;
  tier1: string;
  ruleConfig: Record<string, unknown>;
  flags: DiagnosticFlagInput[];
}

/**
 * Inserts one immutable diagnostics row with its flags. Idempotent per (run, attempt): a
 * redelivered job that already wrote its attempt gets the existing row back.
 */
export function insertDiagnostics(
  db: Executor,
  input: DiagnosticsInput,
): Promise<{ diagnostics: AudioDiagnostic; created: boolean }> {
  return db.transaction(async (inner) => {
    const { flags, ...row } = input;
    const [inserted] = await inner
      .insert(audioDiagnostics)
      .values(row)
      .onConflictDoNothing({ target: [audioDiagnostics.runId, audioDiagnostics.attempt] })
      .returning();
    if (!inserted) {
      const [existing] = await inner
        .select()
        .from(audioDiagnostics)
        .where(
          and(
            eq(audioDiagnostics.workspaceId, input.workspaceId),
            eq(audioDiagnostics.runId, input.runId),
            eq(audioDiagnostics.attempt, input.attempt),
          ),
        );
      if (!existing) throw new Error('diagnostics conflict without a row');
      return { diagnostics: existing, created: false };
    }
    for (let i = 0; i < flags.length; i += 500) {
      await inner.insert(audioDiagnosticFlags).values(
        flags.slice(i, i + 500).map((f) => ({
          ...f,
          workspaceId: input.workspaceId,
          diagnosticsId: inserted.id,
        })),
      );
    }
    return { diagnostics: inserted, created: true };
  });
}

/** Newest diagnostics of a run, optionally only for one preprocessing version (lifecycle L3). */
export async function getLatestDiagnostics(
  tx: Executor,
  workspaceId: string,
  runId: string,
  preprocessingId?: string,
): Promise<AudioDiagnostic | null> {
  const [row] = await tx
    .select()
    .from(audioDiagnostics)
    .where(
      and(
        eq(audioDiagnostics.workspaceId, workspaceId),
        eq(audioDiagnostics.runId, runId),
        ...(preprocessingId ? [eq(audioDiagnostics.preprocessingId, preprocessingId)] : []),
      ),
    )
    .orderBy(desc(audioDiagnostics.attempt))
    .limit(1);
  return row ?? null;
}

export function listDiagnosticFlags(
  tx: Executor,
  workspaceId: string,
  diagnosticsId: string,
  range: { fromMs?: number; toMs?: number } = {},
): Promise<AudioDiagnosticFlagRow[]> {
  const conditions = [
    eq(audioDiagnosticFlags.workspaceId, workspaceId),
    eq(audioDiagnosticFlags.diagnosticsId, diagnosticsId),
  ];
  // Whole-recording flags (null range) always overlap any requested range.
  if (range.fromMs !== undefined)
    conditions.push(
      sql`(${audioDiagnosticFlags.endMs} IS NULL OR ${audioDiagnosticFlags.endMs} > ${range.fromMs})`,
    );
  if (range.toMs !== undefined)
    conditions.push(
      sql`(${audioDiagnosticFlags.startMs} IS NULL OR ${audioDiagnosticFlags.startMs} < ${range.toMs})`,
    );
  return tx
    .select()
    .from(audioDiagnosticFlags)
    .where(and(...conditions))
    .orderBy(asc(audioDiagnosticFlags.startMs), asc(audioDiagnosticFlags.id));
}

/** Highest A1 attempt already recorded for the run (0 when none). */
export async function maxDiagnosticsAttempt(
  tx: Executor,
  workspaceId: string,
  runId: string,
): Promise<number> {
  const [row] = await tx
    .select({ attempt: sql<number>`coalesce(max(${audioDiagnostics.attempt}), 0)` })
    .from(audioDiagnostics)
    .where(and(eq(audioDiagnostics.workspaceId, workspaceId), eq(audioDiagnostics.runId, runId)));
  return Number(row?.attempt ?? 0);
}

/* -- A1 trigger queries (lifecycle L2 / L3, ADR-0044) ------------------------------------------- */

const ACTIVE_RUN = sql.raw(`('created', 'queued', 'running')`);

/**
 * Runs (created, queued or running) with no A1 stage row yet, newest first. Reads run and stage
 * bookkeeping only (no transcription data).
 */
export async function listRunsAwaitingAudioQuality(
  tx: Executor,
  limit: number,
): Promise<
  { id: string; workspaceId: string; recordingId: string; preprocessingId: string | null }[]
> {
  const result = await tx.execute(sql`
    SELECT r.id, r.workspace_id, r.recording_id, r.preprocessing_id
    FROM pipeline_runs r
    WHERE r.status IN ${ACTIVE_RUN}
      AND NOT EXISTS (
        SELECT 1 FROM pipeline_stage_runs s WHERE s.run_id = r.id AND s.node = 'audio_quality')
      AND EXISTS (
        SELECT 1 FROM audio_preprocessings p
        WHERE p.recording_id = r.recording_id AND p.workspace_id = r.workspace_id
          AND p.status = 'succeeded')
    ORDER BY r.created_at DESC
    LIMIT ${limit}`);
  return (result.rows as Record<string, string | null>[]).map((r) => ({
    id: r.id!,
    workspaceId: r.workspace_id!,
    recordingId: r.recording_id!,
    preprocessingId: r.preprocessing_id ?? null,
  }));
}

/** Re-assessments after submission (L3) or a run retry (L7), below the automatic attempt cap. */
export async function listRunsWithStaleAudioQuality(
  tx: Executor,
  limit: number,
  attemptCap: number,
): Promise<{ id: string; workspaceId: string; preprocessingId: string; maxAttempt: number }[]> {
  // Submitted runs (queued/running, e.g. after submission L3 or a run retry L7) with A1 stage rows
  // but no diagnostics for the version the run now pins, no running A1 stage, under the cap.
  const result = await tx.execute(sql`
    SELECT r.id, r.workspace_id, r.preprocessing_id, m.max_attempt
    FROM pipeline_runs r
    JOIN LATERAL (
      SELECT max(s.attempt) AS max_attempt,
             bool_or(s.status = 'running') AS any_running
      FROM pipeline_stage_runs s WHERE s.run_id = r.id AND s.node = 'audio_quality') m ON true
    WHERE r.status IN ('queued', 'running')
      AND r.preprocessing_id IS NOT NULL
      AND m.max_attempt IS NOT NULL AND m.max_attempt < ${attemptCap}
      AND NOT m.any_running
      AND NOT EXISTS (
        SELECT 1 FROM audio_diagnostics d
        WHERE d.run_id = r.id AND d.preprocessing_id = r.preprocessing_id)
    LIMIT ${limit}`);
  return (result.rows as Record<string, string | number>[]).map((r) => ({
    id: String(r.id),
    workspaceId: String(r.workspace_id),
    preprocessingId: String(r.preprocessing_id),
    maxAttempt: Number(r.max_attempt),
  }));
}

/** A1 stage rows still `running` and untouched since `cutoff` (lost jobs). */
export async function listStuckAudioQualityStages(
  tx: Executor,
  cutoff: Date,
  limit: number,
): Promise<{ runId: string; workspaceId: string; attempt: number }[]> {
  const result = await tx.execute(sql`
    SELECT s.run_id, s.workspace_id, s.attempt FROM pipeline_stage_runs s
    WHERE s.node = 'audio_quality' AND s.status = 'running' AND s.updated_at < ${cutoff}
    ORDER BY s.updated_at ASC LIMIT ${limit}`);
  return (result.rows as Record<string, string | number>[]).map((r) => ({
    runId: String(r.run_id),
    workspaceId: String(r.workspace_id),
    attempt: Number(r.attempt),
  }));
}

/** Newest A1 stage row of a run, or null. */
export async function getLatestAudioQualityStage(
  tx: Executor,
  workspaceId: string,
  runId: string,
): Promise<{ attempt: number; status: string; error: { code: string } | null } | null> {
  const result = await tx.execute(sql`
    SELECT attempt, status, error FROM pipeline_stage_runs
    WHERE workspace_id = ${workspaceId} AND run_id = ${runId} AND node = 'audio_quality'
    ORDER BY attempt DESC LIMIT 1`);
  const row = result.rows[0] as
    { attempt: number; status: string; error: { code: string } | null } | undefined;
  return row ? { attempt: Number(row.attempt), status: row.status, error: row.error } : null;
}

/* -- read-only view for other components (ADR-0046) -------------------------------------------- */

/** Builds the versioned summary other components may read. Validated against the contract. */
export function toAudioQualitySummary(
  row: AudioDiagnostic,
  flags: Pick<AudioDiagnosticFlagRow, 'kind' | 'severity'>[],
): AudioQualitySummary {
  const flagCounts: Record<string, Record<string, number>> = {};
  for (const f of flags) {
    const bySeverity = (flagCounts[f.kind] ??= {});
    bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;
  }
  return AudioQualitySummary.parse({
    schemaVersion: 1,
    diagnosticsId: row.id,
    runId: row.runId,
    preprocessingId: row.preprocessingId,
    ruleVersion: row.ruleVersion,
    provisional: row.provisional,
    overall: row.overall,
    confidence: row.confidence,
    suitability: row.suitability,
    flagCounts,
    affectedRatio: row.affectedRatio,
    notAssessed: row.notAssessed,
    tier1: row.tier1,
    createdAt: row.createdAt.toISOString(),
  });
}

/**
 * The read-only port (ADR-0046). It has no write method. Consumers get the context for the run's
 * preprocessing version, or a status; they never wait for A1 (it never blocks).
 */
export function createAudioQualityReader(db: Executor): AudioQualityReader {
  return {
    async get({ workspaceId, runId, preprocessingId }): Promise<AudioQualityLookup> {
      const row = await getLatestDiagnostics(db, workspaceId, runId, preprocessingId);
      if (!row) {
        const stage = await getLatestAudioQualityStage(db, workspaceId, runId);
        if (!stage) return { status: 'unavailable' };
        return { status: stage.status === 'failed' ? 'failed' : 'pending' };
      }
      const flags = await listDiagnosticFlags(db, workspaceId, row.id);
      return {
        status: 'available',
        context: {
          summary: toAudioQualitySummary(row, flags),
          flags: flags.map((f) => ({
            kind: f.kind,
            severity: f.severity,
            startMs: f.startMs,
            endMs: f.endMs,
          })),
        },
      };
    },
  };
}
