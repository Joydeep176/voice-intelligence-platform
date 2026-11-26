/**
 * Repository functions for Phase 2C transcription runs (DATABASE_DESIGN §4, D-2C-01).
 * Same conventions as `audio-processing.ts`: the workspace ID is a parameter of every function and
 * filters every query; every state change is a guarded conditional UPDATE that reports whether it
 * applied, so a duplicate or racing worker cannot move a run backwards. Pass a transaction or the
 * database. The sweeper's `listStuckRuns` is the one deliberate cross-workspace read (system work).
 */
import { and, asc, desc, eq, gt, inArray, lt, or, sql, type SQL } from 'drizzle-orm';
import type { Executor } from './audio-processing.js';
import {
  audioPreprocessings,
  diarizationRawOutputs,
  pipelineRuns,
  pipelineStageRuns,
  speakers,
  sttRawOutputs,
  transcriptionUncertainties,
  transcriptSegments,
  transcriptVersions,
  transcripts,
  type AudioPreprocessing,
  type DiarizationRawOutput,
  type PipelineRun,
  type PipelineStageRun,
  type Speaker,
  type SttRawOutput,
  type Transcript,
  type TranscriptionUncertainty,
  type TranscriptSegment,
  type TranscriptVersion,
} from './schema.js';

const INSERT_CHUNK = 500;
/** One more than the API's maximum page size, so a caller can fetch `limit + 1` to detect a next page. */
const MAX_PAGE = 1001;

const runScope = (workspaceId: string, runId: string) =>
  and(eq(pipelineRuns.workspaceId, workspaceId), eq(pipelineRuns.id, runId));

type RunStatus = PipelineRun['status'];

/** Guarded UPDATE: applies only when the current status is in `from`. */
async function guardedRunUpdate(
  tx: Executor,
  workspaceId: string,
  runId: string,
  from: RunStatus[],
  set: Partial<typeof pipelineRuns.$inferInsert>,
  extra?: SQL,
): Promise<boolean> {
  const rows = await tx
    .update(pipelineRuns)
    .set({ ...set, updatedAt: new Date() })
    .where(and(runScope(workspaceId, runId), inArray(pipelineRuns.status, from), extra))
    .returning({ id: pipelineRuns.id });
  return rows.length === 1;
}

/* ------------------------------------------------------------------------------------------------
 * Run reads
 * ---------------------------------------------------------------------------------------------- */

export async function getRun(
  tx: Executor,
  workspaceId: string,
  runId: string,
): Promise<PipelineRun | null> {
  const [row] = await tx.select().from(pipelineRuns).where(runScope(workspaceId, runId));
  return row ?? null;
}

/** Locks the run row for the rest of the transaction. */
export async function lockRun(
  tx: Executor,
  workspaceId: string,
  runId: string,
): Promise<PipelineRun | null> {
  const [row] = await tx
    .select()
    .from(pipelineRuns)
    .where(runScope(workspaceId, runId))
    .for('update');
  return row ?? null;
}

/** The newest run of the recording in one of `statuses`. */
export async function findLatestRunByStatus(
  tx: Executor,
  workspaceId: string,
  recordingId: string,
  statuses: RunStatus[],
): Promise<PipelineRun | null> {
  const [row] = await tx
    .select()
    .from(pipelineRuns)
    .where(
      and(
        eq(pipelineRuns.workspaceId, workspaceId),
        eq(pipelineRuns.recordingId, recordingId),
        inArray(pipelineRuns.status, statuses),
      ),
    )
    .orderBy(desc(pipelineRuns.createdAt), desc(pipelineRuns.id))
    .limit(1);
  return row ?? null;
}

/** Newest succeeded preprocessing version of the recording (the input of a transcription run). */
export async function findLatestSucceededPreprocessing(
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
        eq(audioPreprocessings.status, 'succeeded'),
      ),
    )
    .orderBy(desc(audioPreprocessings.createdAt), desc(audioPreprocessings.id))
    .limit(1);
  return row ?? null;
}

export async function insertCreatedRun(
  tx: Executor,
  workspaceId: string,
  recordingId: string,
): Promise<PipelineRun> {
  const [row] = await tx
    .insert(pipelineRuns)
    .values({ workspaceId, recordingId, status: 'created' })
    .returning();
  return row!;
}

/* ------------------------------------------------------------------------------------------------
 * Run transitions
 * ---------------------------------------------------------------------------------------------- */

/** created -> queued, linking the preprocessing version and recording the stage scope. */
export const submitRun = (
  tx: Executor,
  workspaceId: string,
  runId: string,
  input: { preprocessingId: string; config: Record<string, unknown> },
) =>
  guardedRunUpdate(tx, workspaceId, runId, ['created'], {
    status: 'queued',
    preprocessingId: input.preprocessingId,
    config: input.config,
    error: null,
  });

/**
 * queued|running -> running. `running` is accepted so a redelivered job (BullMQ attempt, stalled
 * recovery) can resume; the job ID is unique per run so there is only ever one live job.
 */
export async function markRunStarted(
  tx: Executor,
  workspaceId: string,
  runId: string,
): Promise<boolean> {
  const rows = await tx
    .update(pipelineRuns)
    .set({
      status: 'running',
      startedAt: sql`coalesce(${pipelineRuns.startedAt}, now())`,
      updatedAt: new Date(),
    })
    .where(and(runScope(workspaceId, runId), inArray(pipelineRuns.status, ['queued', 'running'])))
    .returning({ id: pipelineRuns.id });
  return rows.length === 1;
}

/** Merges provider ids/versions and the window source/params into the run's config snapshot. Only while running. */
export async function mergeRunConfig(
  tx: Executor,
  workspaceId: string,
  runId: string,
  patch: Record<string, unknown>,
): Promise<boolean> {
  const rows = await tx
    .update(pipelineRuns)
    .set({
      config: sql`coalesce(${pipelineRuns.config}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`,
      updatedAt: new Date(),
    })
    .where(and(runScope(workspaceId, runId), eq(pipelineRuns.status, 'running')))
    .returning({ id: pipelineRuns.id });
  return rows.length === 1;
}

/** Only while running. */
export const setRunStage = (
  tx: Executor,
  workspaceId: string,
  runId: string,
  node: string | null,
) => guardedRunUpdate(tx, workspaceId, runId, ['running'], { currentNode: node });

/**
 * Records the cancel request. A `created` (ADR-0025, lifecycle L5) or `queued` run is cancelled at once; a `running` one becomes
 * `cancelling` (the coordinator finishes it between windows, ADR-0014). `cancelling` is idempotent.
 */
export async function requestRunCancel(
  tx: Executor,
  workspaceId: string,
  runId: string,
): Promise<'cancelled' | 'cancelling' | null> {
  if (
    await guardedRunUpdate(tx, workspaceId, runId, ['created', 'queued'], {
      status: 'cancelled',
      finishedAt: new Date(),
    })
  ) {
    return 'cancelled';
  }
  if (
    await guardedRunUpdate(tx, workspaceId, runId, ['running'], {
      status: 'cancelling',
      cancelRequestedAt: new Date(),
    })
  ) {
    return 'cancelling';
  }
  const run = await getRun(tx, workspaceId, runId);
  return run?.status === 'cancelling' ? 'cancelling' : null;
}

/** queued|running|cancelling -> cancelled. */
export const markRunCancelled = (tx: Executor, workspaceId: string, runId: string) =>
  guardedRunUpdate(tx, workspaceId, runId, ['queued', 'running', 'cancelling'], {
    status: 'cancelled',
    currentNode: null,
    finishedAt: new Date(),
  });

/** queued|running -> failed. `error` holds a code and the failing node only, never content. */
export const markRunFailed = (
  tx: Executor,
  workspaceId: string,
  runId: string,
  error: { code: string; node: string | null },
) =>
  guardedRunUpdate(tx, workspaceId, runId, ['queued', 'running'], {
    status: 'failed',
    error: { code: error.code, node: error.node },
    currentNode: null,
    finishedAt: new Date(),
  });

/**
 * failed|cancelled -> queued while `retry_count < maxRetries`; counts the retry. Clears error,
 * cancel request and timestamps. Raw outputs of earlier attempts are kept and reused.
 */
export const resetRunForRetry = (
  tx: Executor,
  workspaceId: string,
  runId: string,
  maxRetries: number,
) =>
  guardedRunUpdate(
    tx,
    workspaceId,
    runId,
    ['failed', 'cancelled'],
    {
      status: 'queued',
      retryCount: sql`${pipelineRuns.retryCount} + 1` as unknown as number,
      error: null,
      currentNode: null,
      cancelRequestedAt: null,
      startedAt: null,
      finishedAt: null,
    },
    lt(pipelineRuns.retryCount, maxRetries),
  );

/**
 * Sweeper recovery of a run that lost its job: queued|running -> queued, counted as a retry and
 * bounded by `maxRetries`. It is a compare-and-set on the retry count, so concurrent observers
 * of the same stuck state count it once.
 */
export const requeueStuckRun = (
  tx: Executor,
  workspaceId: string,
  runId: string,
  maxRetries: number,
  expectedRetryCount: number,
) =>
  guardedRunUpdate(
    tx,
    workspaceId,
    runId,
    ['queued', 'running'],
    {
      status: 'queued',
      retryCount: sql`${pipelineRuns.retryCount} + 1` as unknown as number,
    },
    and(lt(pipelineRuns.retryCount, maxRetries), eq(pipelineRuns.retryCount, expectedRetryCount)),
  );

/** Cross-workspace by design (system recovery). Oldest first, bounded. */
export function listStuckRuns(tx: Executor, cutoff: Date, limit: number): Promise<PipelineRun[]> {
  return tx
    .select()
    .from(pipelineRuns)
    .where(
      and(
        inArray(pipelineRuns.status, ['queued', 'running', 'cancelling']),
        lt(pipelineRuns.updatedAt, cutoff),
      ),
    )
    .orderBy(asc(pipelineRuns.updatedAt))
    .limit(Math.max(1, Math.min(limit, 500)));
}

/* ------------------------------------------------------------------------------------------------
 * Stage runs
 * ---------------------------------------------------------------------------------------------- */

type StageNode = PipelineStageRun['node'];

const stageScope = (workspaceId: string, runId: string, node: StageNode, attempt: number) =>
  and(
    eq(pipelineStageRuns.workspaceId, workspaceId),
    eq(pipelineStageRuns.runId, runId),
    eq(pipelineStageRuns.node, node),
    eq(pipelineStageRuns.attempt, attempt),
  );

/** Inserts or restarts the (run, node, attempt) row as `running` (a redelivered job restarts its stage). */
export async function beginStage(
  tx: Executor,
  workspaceId: string,
  runId: string,
  node: StageNode,
  attempt: number,
): Promise<void> {
  await tx
    .insert(pipelineStageRuns)
    .values({ workspaceId, runId, node, attempt, status: 'running', startedAt: new Date() })
    .onConflictDoUpdate({
      target: [pipelineStageRuns.runId, pipelineStageRuns.node, pipelineStageRuns.attempt],
      set: {
        status: 'running',
        progress: null,
        error: null,
        startedAt: new Date(),
        finishedAt: null,
        updatedAt: new Date(),
      },
    });
}

/** Only while the stage is running; also touches the run so the sweeper sees liveness. */
export async function updateStageProgress(
  tx: Executor,
  workspaceId: string,
  runId: string,
  node: StageNode,
  attempt: number,
  progress: Record<string, unknown>,
): Promise<boolean> {
  const rows = await tx
    .update(pipelineStageRuns)
    .set({ progress, updatedAt: new Date() })
    .where(
      and(stageScope(workspaceId, runId, node, attempt), eq(pipelineStageRuns.status, 'running')),
    )
    .returning({ id: pipelineStageRuns.id });
  if (rows.length === 1) {
    await tx
      .update(pipelineRuns)
      .set({ updatedAt: new Date() })
      .where(runScope(workspaceId, runId));
  }
  return rows.length === 1;
}

/** running -> completed|failed|cancelled. */
export async function finishStage(
  tx: Executor,
  workspaceId: string,
  runId: string,
  node: StageNode,
  attempt: number,
  status: 'completed' | 'failed' | 'cancelled',
  error?: { code: string },
): Promise<boolean> {
  const rows = await tx
    .update(pipelineStageRuns)
    .set({
      status,
      error: status === 'failed' ? { code: error?.code ?? 'UNKNOWN' } : null,
      finishedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(stageScope(workspaceId, runId, node, attempt), eq(pipelineStageRuns.status, 'running')),
    )
    .returning({ id: pipelineStageRuns.id });
  return rows.length === 1;
}

export function listStageRuns(
  tx: Executor,
  workspaceId: string,
  runId: string,
): Promise<PipelineStageRun[]> {
  return tx
    .select()
    .from(pipelineStageRuns)
    .where(and(eq(pipelineStageRuns.workspaceId, workspaceId), eq(pipelineStageRuns.runId, runId)))
    .orderBy(desc(pipelineStageRuns.attempt), asc(pipelineStageRuns.node));
}

/* ------------------------------------------------------------------------------------------------
 * Raw provider outputs (immutable)
 * ---------------------------------------------------------------------------------------------- */

export interface SttRawInput {
  workspaceId: string;
  runId: string;
  windowIndex: number;
  windowStartMs: number;
  windowEndMs: number;
  provider: string;
  providerModel: string;
  requestParams?: Record<string, unknown> | null;
  payloadUri: string;
  sha256: string;
}

export async function getSttRawOutput(
  tx: Executor,
  workspaceId: string,
  runId: string,
  windowIndex: number,
): Promise<SttRawOutput | null> {
  const [row] = await tx
    .select()
    .from(sttRawOutputs)
    .where(
      and(
        eq(sttRawOutputs.workspaceId, workspaceId),
        eq(sttRawOutputs.runId, runId),
        eq(sttRawOutputs.windowIndex, windowIndex),
      ),
    );
  return row ?? null;
}

/** First write wins: an existing row for (run, window) is returned unchanged (`created: false`). */
export async function insertSttRawOutput(
  tx: Executor,
  input: SttRawInput,
): Promise<{ row: SttRawOutput; created: boolean }> {
  const inserted = await tx
    .insert(sttRawOutputs)
    .values({ ...input, requestParams: input.requestParams ?? null })
    .onConflictDoNothing({ target: [sttRawOutputs.runId, sttRawOutputs.windowIndex] })
    .returning();
  if (inserted[0]) return { row: inserted[0], created: true };
  const existing = await getSttRawOutput(tx, input.workspaceId, input.runId, input.windowIndex);
  if (!existing) throw new Error('STT raw output conflict row not found in this workspace.');
  return { row: existing, created: false };
}

export function listSttRawOutputs(
  tx: Executor,
  workspaceId: string,
  runId: string,
): Promise<SttRawOutput[]> {
  return tx
    .select()
    .from(sttRawOutputs)
    .where(and(eq(sttRawOutputs.workspaceId, workspaceId), eq(sttRawOutputs.runId, runId)))
    .orderBy(asc(sttRawOutputs.windowIndex));
}

export interface DiarizationRawInput {
  workspaceId: string;
  runId: string;
  provider: string;
  providerModel: string;
  scope: 'whole' | 'window';
  windowStartMs?: number | null;
  windowEndMs?: number | null;
  payloadUri: string;
  sha256: string;
}

export async function getWholeDiarizationRawOutput(
  tx: Executor,
  workspaceId: string,
  runId: string,
): Promise<DiarizationRawOutput | null> {
  const [row] = await tx
    .select()
    .from(diarizationRawOutputs)
    .where(
      and(
        eq(diarizationRawOutputs.workspaceId, workspaceId),
        eq(diarizationRawOutputs.runId, runId),
        eq(diarizationRawOutputs.scope, 'whole'),
      ),
    );
  return row ?? null;
}

/** First write wins for the whole-file output; windowed outputs are keyed by window start. */
export async function insertDiarizationRawOutput(
  tx: Executor,
  input: DiarizationRawInput,
): Promise<{ row: DiarizationRawOutput; created: boolean }> {
  const values = {
    ...input,
    windowStartMs: input.windowStartMs ?? null,
    windowEndMs: input.windowEndMs ?? null,
  };
  const inserted = await tx
    .insert(diarizationRawOutputs)
    .values(values)
    .onConflictDoNothing()
    .returning();
  if (inserted[0]) return { row: inserted[0], created: true };
  const [existing] = await tx
    .select()
    .from(diarizationRawOutputs)
    .where(
      and(
        eq(diarizationRawOutputs.workspaceId, input.workspaceId),
        eq(diarizationRawOutputs.runId, input.runId),
        eq(diarizationRawOutputs.scope, input.scope),
        ...(input.scope === 'window' && input.windowStartMs != null
          ? [eq(diarizationRawOutputs.windowStartMs, input.windowStartMs)]
          : []),
      ),
    );
  if (!existing)
    throw new Error('Diarization raw output conflict row not found in this workspace.');
  return { row: existing, created: false };
}

export function listDiarizationRawOutputs(
  tx: Executor,
  workspaceId: string,
  runId: string,
): Promise<DiarizationRawOutput[]> {
  return tx
    .select()
    .from(diarizationRawOutputs)
    .where(
      and(
        eq(diarizationRawOutputs.workspaceId, workspaceId),
        eq(diarizationRawOutputs.runId, runId),
      ),
    )
    .orderBy(asc(diarizationRawOutputs.windowStartMs), asc(diarizationRawOutputs.id));
}

/* ------------------------------------------------------------------------------------------------
 * Transcript v1 (atomic, idempotent)
 * ---------------------------------------------------------------------------------------------- */

export interface TranscriptSegmentInput {
  startMs: number;
  endMs: number;
  text: string;
  language: 'en' | 'hi' | 'mixed';
  codeSwitchSpans?: { startChar: number; endChar: number; language: 'en' | 'hi' }[] | null;
  /** Null/undefined when the provider gave none: never fabricated. */
  confidence?: number | null;
  words?: { startMs: number; endMs: number; text: string; confidence?: number }[] | null;
  /** Machine speaker ID (e.g. `SPEAKER_00`); null = unassigned. */
  speakerKey?: string | null;
  sourceRawOutputIds?: string[];
}

export interface TranscriptUncertaintyInput {
  /** Index into `segments`; null = not tied to one segment. */
  segmentIndex?: number | null;
  startMs: number;
  endMs: number;
  kind: TranscriptionUncertainty['kind'];
  score?: number | null;
}

export interface CompleteRunInput {
  workspaceId: string;
  runId: string;
  createdBy?: string;
  segments: TranscriptSegmentInput[];
  /** Speaker keys to create. Every `speakerKey` used by a segment must be listed. */
  speakerKeys: string[];
  uncertainties: TranscriptUncertaintyInput[];
}

class NotApplied extends Error {}

/**
 * Atomically persists machine transcript v1 (transcript, version, speakers, segments,
 * uncertainties) and moves the run running -> completed. Returns false, changing nothing, when a
 * transcript already exists (second completion is a no-op) or the run is no longer `running`
 * (cancelled, failed): the transaction rolls back, so no partial transcript can exist.
 */
export async function completeRunWithTranscript(
  tx: Executor,
  input: CompleteRunInput,
): Promise<boolean> {
  try {
    return await tx.transaction(async (inner) => {
      // The row lock serialises concurrent completions; a run that is not ours or not running is a no-op.
      const run = await lockRun(inner, input.workspaceId, input.runId);
      if (run?.status !== 'running') return false;
      const [transcript] = await inner
        .insert(transcripts)
        .values({ workspaceId: input.workspaceId, runId: input.runId })
        .onConflictDoNothing({ target: [transcripts.runId] })
        .returning();
      if (!transcript) return false;

      const done = await guardedRunUpdate(inner, input.workspaceId, input.runId, ['running'], {
        status: 'completed',
        currentNode: null,
        finishedAt: new Date(),
      });
      if (!done) throw new NotApplied();

      const [version] = await inner
        .insert(transcriptVersions)
        .values({
          workspaceId: input.workspaceId,
          transcriptId: transcript.id,
          version: 1,
          kind: 'machine',
          createdBy: input.createdBy ?? 'system',
        })
        .returning();

      const speechMs = new Map<string, number>(input.speakerKeys.map((k) => [k, 0]));
      for (const s of input.segments) {
        if (s.speakerKey == null) continue;
        if (!speechMs.has(s.speakerKey)) throw new Error('Segment references an unlisted speaker.');
        speechMs.set(s.speakerKey, (speechMs.get(s.speakerKey) ?? 0) + (s.endMs - s.startMs));
      }
      const speakerIdByKey = new Map<string, string>();
      if (input.speakerKeys.length > 0) {
        const rows = await inner
          .insert(speakers)
          .values(
            input.speakerKeys.map((key) => ({
              workspaceId: input.workspaceId,
              transcriptId: transcript.id,
              speakerKey: key,
              totalSpeechMs: speechMs.get(key) ?? 0,
            })),
          )
          .returning({ id: speakers.id, key: speakers.speakerKey });
        for (const r of rows) speakerIdByKey.set(r.key, r.id);
      }

      const segmentIds = input.segments.map(() => crypto.randomUUID());
      for (let i = 0; i < input.segments.length; i += INSERT_CHUNK) {
        await inner.insert(transcriptSegments).values(
          input.segments.slice(i, i + INSERT_CHUNK).map((s, j) => ({
            id: segmentIds[i + j]!,
            workspaceId: input.workspaceId,
            transcriptVersionId: version!.id,
            speakerId: s.speakerKey == null ? null : (speakerIdByKey.get(s.speakerKey) ?? null),
            startMs: s.startMs,
            endMs: s.endMs,
            text: s.text,
            language: s.language,
            codeSwitchSpans: s.codeSwitchSpans ?? null,
            confidence: s.confidence ?? null,
            words: s.words ?? null,
            sourceRawOutputIds: s.sourceRawOutputIds ?? null,
          })),
        );
      }

      for (let i = 0; i < input.uncertainties.length; i += INSERT_CHUNK) {
        await inner.insert(transcriptionUncertainties).values(
          input.uncertainties.slice(i, i + INSERT_CHUNK).map((u) => {
            let segmentId: string | null = null;
            if (u.segmentIndex !== null && u.segmentIndex !== undefined) {
              segmentId = segmentIds[u.segmentIndex] ?? null;
              if (!segmentId) throw new Error('Uncertainty references an unknown segment index.');
            }
            return {
              workspaceId: input.workspaceId,
              transcriptVersionId: version!.id,
              segmentId,
              startMs: u.startMs,
              endMs: u.endMs,
              kind: u.kind,
              score: u.score ?? null,
            };
          }),
        );
      }
      return true;
    });
  } catch (error) {
    if (error instanceof NotApplied) return false;
    throw error;
  }
}

/* ------------------------------------------------------------------------------------------------
 * Transcript reads
 * ---------------------------------------------------------------------------------------------- */

export async function getTranscriptForRun(
  tx: Executor,
  workspaceId: string,
  runId: string,
): Promise<Transcript | null> {
  const [row] = await tx
    .select()
    .from(transcripts)
    .where(and(eq(transcripts.workspaceId, workspaceId), eq(transcripts.runId, runId)));
  return row ?? null;
}

export async function listTranscriptVersions(
  tx: Executor,
  workspaceId: string,
  transcriptId: string,
): Promise<(TranscriptVersion & { segmentCount: number })[]> {
  const rows = await tx
    .select({
      version: transcriptVersions,
      segmentCount: sql<number>`(select count(*)::int from transcript_segments s where s.transcript_version_id = transcript_versions.id and s.workspace_id = ${workspaceId})`,
    })
    .from(transcriptVersions)
    .where(
      and(
        eq(transcriptVersions.workspaceId, workspaceId),
        eq(transcriptVersions.transcriptId, transcriptId),
      ),
    )
    .orderBy(asc(transcriptVersions.version));
  return rows.map((r) => ({ ...r.version, segmentCount: r.segmentCount }));
}

/** A specific version, or the latest when `version` is omitted. */
export async function getTranscriptVersion(
  tx: Executor,
  workspaceId: string,
  transcriptId: string,
  version?: number,
): Promise<TranscriptVersion | null> {
  const [row] = await tx
    .select()
    .from(transcriptVersions)
    .where(
      and(
        eq(transcriptVersions.workspaceId, workspaceId),
        eq(transcriptVersions.transcriptId, transcriptId),
        ...(version === undefined ? [] : [eq(transcriptVersions.version, version)]),
      ),
    )
    .orderBy(desc(transcriptVersions.version))
    .limit(1);
  return row ?? null;
}

export interface KeysetPage {
  fromMs?: number;
  toMs?: number;
  /** Rows strictly after this (startMs, id) position. */
  after?: { startMs: number; id: string };
  limit: number;
}

export function listTranscriptSegments(
  tx: Executor,
  workspaceId: string,
  versionId: string,
  page: KeysetPage,
): Promise<TranscriptSegment[]> {
  const conditions: (SQL | undefined)[] = [
    eq(transcriptSegments.workspaceId, workspaceId),
    eq(transcriptSegments.transcriptVersionId, versionId),
  ];
  if (page.fromMs !== undefined) conditions.push(gt(transcriptSegments.endMs, page.fromMs));
  if (page.toMs !== undefined) conditions.push(lt(transcriptSegments.startMs, page.toMs));
  if (page.after) {
    conditions.push(
      or(
        gt(transcriptSegments.startMs, page.after.startMs),
        and(
          eq(transcriptSegments.startMs, page.after.startMs),
          gt(transcriptSegments.id, page.after.id),
        ),
      ),
    );
  }
  return tx
    .select()
    .from(transcriptSegments)
    .where(and(...conditions))
    .orderBy(asc(transcriptSegments.startMs), asc(transcriptSegments.id))
    .limit(Math.max(1, Math.min(page.limit, MAX_PAGE)));
}

export function listUncertainties(
  tx: Executor,
  workspaceId: string,
  versionId: string,
  page: KeysetPage,
): Promise<TranscriptionUncertainty[]> {
  const t = transcriptionUncertainties;
  const conditions: (SQL | undefined)[] = [
    eq(t.workspaceId, workspaceId),
    eq(t.transcriptVersionId, versionId),
  ];
  if (page.fromMs !== undefined) conditions.push(gt(t.endMs, page.fromMs));
  if (page.toMs !== undefined) conditions.push(lt(t.startMs, page.toMs));
  if (page.after) {
    conditions.push(
      or(
        gt(t.startMs, page.after.startMs),
        and(eq(t.startMs, page.after.startMs), gt(t.id, page.after.id)),
      ),
    );
  }
  return tx
    .select()
    .from(t)
    .where(and(...conditions))
    .orderBy(asc(t.startMs), asc(t.id))
    .limit(Math.max(1, Math.min(page.limit, MAX_PAGE)));
}

export function listSpeakers(
  tx: Executor,
  workspaceId: string,
  transcriptId: string,
): Promise<Speaker[]> {
  return tx
    .select()
    .from(speakers)
    .where(and(eq(speakers.workspaceId, workspaceId), eq(speakers.transcriptId, transcriptId)))
    .orderBy(asc(speakers.speakerKey));
}

/** Updates only `display_name` (the key is immutable). Null when the speaker is not in this run/workspace. */
export async function renameSpeaker(
  tx: Executor,
  workspaceId: string,
  runId: string,
  speakerId: string,
  displayName: string,
): Promise<Speaker | null> {
  const [row] = await tx
    .update(speakers)
    .set({ displayName, updatedAt: new Date() })
    .where(
      and(
        eq(speakers.workspaceId, workspaceId),
        eq(speakers.id, speakerId),
        eq(
          speakers.transcriptId,
          sql`(select ${transcripts.id} from ${transcripts} where ${transcripts.runId} = ${runId} and ${transcripts.workspaceId} = ${workspaceId})`,
        ),
      ),
    )
    .returning();
  return row ?? null;
}
