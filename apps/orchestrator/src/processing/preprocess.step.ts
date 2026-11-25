import {
  AUDIO_SERVICE_CONTRACT_VERSION,
  AudioPreprocessConfig,
  AudioPreprocessJob,
  AudioPreprocessResult,
  AudioServiceErrorCode,
  AudioTaskCreateRequest,
  type AudioTaskState,
} from '@vip/contracts';
import {
  and,
  auditEvents,
  completePreprocessing,
  eq,
  getPreprocessing,
  incrementAttempt,
  markCancelled,
  markFailed,
  markRunning,
  recordings,
  updateProgress,
  type AudioPreprocessing,
  type CompletePreprocessingInput,
  type Recording,
} from '@vip/db';
import { AudioClientError } from './audio-client';
import { backstopDeadlineAt } from './deadline';
import { idempotencyKey, originalKey, outputPrefix, uriForKey } from './keys';
import { shouldWriteProgress } from './progress';
import { FINISH, TransientError, type ProcessingDeps, type StepOutcome } from './types';

/**
 * One step of the `audio-preprocess` job (plan §3, LLD §5, ADR-0014). The row in
 * `audio_preprocessings` is the source of truth; the job only carries IDs and the audio-service
 * task ID. Every state change is a guarded UPDATE, so a duplicate or concurrent delivery cannot
 * move a row backwards or persist a result twice.
 */
export async function preprocessStep(deps: ProcessingDeps, payload: unknown): Promise<StepOutcome> {
  const data = AudioPreprocessJob.parse(payload);
  const { db } = deps;
  const { workspaceId, preprocessingId } = data;

  let row = await getPreprocessing(db, workspaceId, preprocessingId);
  if (!row) return FINISH;
  if (row.status === 'queued') {
    await markRunning(db, workspaceId, preprocessingId); // false: someone else moved it; re-read
    row = await getPreprocessing(db, workspaceId, preprocessingId);
    if (!row) return FINISH;
  }
  if (row.status !== 'running') {
    // Succeeded, failed or cancelled (for example cancelled while queued): no work. A task we
    // started for a version that is no longer running is stopped, never left to run.
    if (data.taskId && row.status !== 'succeeded') await stopTask(deps, data.taskId);
    return FINISH;
  }

  const recording = await findRecording(deps, workspaceId, row.recordingId);
  if (!recording || recording.status === 'deleting') {
    await markCancelled(db, workspaceId, preprocessingId);
    if (data.taskId) await stopTask(deps, data.taskId);
    deps.log({ msg: 'preprocess_cancelled_recording_gone', preprocessingId });
    return FINISH;
  }
  if (row.cancelRequestedAt && !data.taskId) {
    await markCancelled(db, workspaceId, preprocessingId);
    deps.log({ msg: 'preprocess_cancelled', preprocessingId });
    return FINISH;
  }

  return data.taskId
    ? poll(deps, data, row, recording, data.taskId)
    : submit(deps, data, row, recording);
}

async function submit(
  deps: ProcessingDeps,
  data: AudioPreprocessJob,
  row: AudioPreprocessing,
  recording: Recording,
): Promise<StepOutcome> {
  const { db, config } = deps;
  const { workspaceId, preprocessingId } = data;

  // A fresh job for a row that was already submitted (job lost, sweeper, redelivery) re-attaches
  // to that submission's key instead of starting a second task. Only a retry after a failure or a
  // lost task (`resubmit`) counts a new attempt and uses a new key.
  // `data.attempt` is the submission whose loss or failure triggered a resubmit. It, not the row's
  // current counter, decides the next key: an observer that read the row after a concurrent
  // observer already counted the loss still derives the same key (and counts nothing twice).
  const isNewSubmission = row.attempt === 0 || data.resubmit === true;
  const basis = data.resubmit === true ? (data.attempt ?? row.attempt) : row.attempt;
  if (isNewSubmission && basis >= config.maxRetries) {
    await markFailed(db, workspaceId, preprocessingId, { code: 'TIMEOUT', retryable: true });
    deps.log({ msg: 'preprocess_failed', preprocessingId, code: 'TIMEOUT', attempt: basis });
    return FINISH;
  }
  const parsedConfig = AudioPreprocessConfig.safeParse(row.config);
  if (!parsedConfig.success) {
    await markFailed(db, workspaceId, preprocessingId, {
      code: 'INVALID_CONFIG',
      retryable: false,
    });
    deps.log({ msg: 'preprocess_failed', preprocessingId, code: 'INVALID_CONFIG' });
    return FINISH;
  }
  const submission = isNewSubmission ? basis + 1 : row.attempt;
  const request = AudioTaskCreateRequest.parse({
    contractVersion: AUDIO_SERVICE_CONTRACT_VERSION,
    type: 'preprocess',
    idempotencyKey: idempotencyKey(recording.id, row.configHash, 'preprocess', submission),
    workspaceId,
    recordingId: recording.id,
    input: {
      originalKey: originalKey(workspaceId, recording.id),
      outputPrefix: outputPrefix(workspaceId, recording.id, row.configHash),
    },
    config: row.config,
  });

  let taskId: string;
  try {
    taskId = (await deps.audio.submit(request)).taskId;
  } catch (error) {
    return handleClientError(deps, row, error);
  }
  // Counted after the submit succeeded: a crash in between repeats the submit with the same key.
  // Compare-and-set on the attempt this submission was derived from: concurrent observers of one
  // loss/failure submit the same key (one service task) and count it exactly once.
  if (isNewSubmission) await incrementAttempt(db, workspaceId, preprocessingId, basis);
  deps.log({ msg: 'preprocess_submitted', preprocessingId, attempt: submission });
  return {
    kind: 'delay',
    delayMs: config.pollIntervalMs,
    data: {
      taskId,
      resubmit: false,
      attempt: submission,
      submittedAt: deps.now(),
      deadlineAt: undefined,
    },
  };
}

async function poll(
  deps: ProcessingDeps,
  data: AudioPreprocessJob,
  row: AudioPreprocessing,
  recording: Recording,
  taskId: string,
): Promise<StepOutcome> {
  const { db, audio, config } = deps;
  const { workspaceId, preprocessingId } = data;

  let state: AudioTaskState;
  try {
    state = await audio.get(taskId);
  } catch (error) {
    if (error instanceof AudioClientError && error.kind === 'LOST') {
      // The service forgot the task (restart or eviction): submit again, bounded by the attempts.
      deps.log({ msg: 'preprocess_task_lost', preprocessingId });
      return submit(deps, { ...data, taskId: undefined, resubmit: true }, row, recording);
    }
    return handleClientError(deps, row, error);
  }

  switch (state.status) {
    case 'queued':
    case 'running': {
      const submittedAt = data.submittedAt ?? deps.now();
      const reported = state.deadlineAt ?? data.deadlineAt;
      const runningSince =
        data.runningSince ?? (state.status === 'running' ? deps.now() : undefined);
      const deadlineAt = backstopDeadlineAt(
        {
          kind: 'preprocess',
          submittedAt,
          runningSince,
          reportedDeadlineAt: reported,
          durationMs: recording.durationMs,
        },
        config,
      );
      if (deps.now() > deadlineAt) return timeOut(deps, row, recording, taskId);
      if (state.progress && shouldWriteProgress(row.progress, state.progress, deps.now())) {
        await updateProgress(db, workspaceId, preprocessingId, {
          stage: state.progress.stage,
          fraction: state.progress.fraction,
          processedMs: state.progress.processedMs,
          updatedAt: new Date(deps.now()).toISOString(),
        });
      }
      if (row.cancelRequestedAt) {
        try {
          await audio.cancel(taskId);
        } catch (error) {
          if (error instanceof AudioClientError && error.kind === 'LOST') {
            await markCancelled(db, workspaceId, preprocessingId);
            return FINISH;
          }
          // Otherwise the next poll asks again.
        }
      }
      const track =
        data.submittedAt === undefined ||
        (reported ?? undefined) !== data.deadlineAt ||
        runningSince !== data.runningSince
          ? { submittedAt, deadlineAt: reported ?? undefined, runningSince }
          : undefined;
      return { kind: 'delay', delayMs: config.pollIntervalMs, ...(track ? { data: track } : {}) };
    }
    case 'cancelled':
      await markCancelled(db, workspaceId, preprocessingId);
      deps.log({ msg: 'preprocess_cancelled', preprocessingId });
      return FINISH;
    case 'failed': {
      const error = state.error ?? { code: 'INTERNAL_ERROR' as const, retryable: false };
      if (error.retryable && row.attempt < config.maxRetries) {
        deps.log({
          msg: 'preprocess_retrying',
          preprocessingId,
          code: error.code,
          attempt: row.attempt,
        });
        return {
          kind: 'delay',
          delayMs: config.retryBackoffMs * 2 ** Math.max(0, row.attempt - 1),
          data: { taskId: undefined, resubmit: true },
        };
      }
      await markFailed(db, workspaceId, preprocessingId, {
        code: error.code,
        retryable: error.retryable,
      });
      deps.log({
        msg: 'preprocess_failed',
        preprocessingId,
        code: error.code,
        attempt: row.attempt,
      });
      return FINISH;
    }
    case 'succeeded':
      return complete(deps, row, recording, state);
  }
}

/**
 * The task outlived its deadline (the service's own plus grace): polling must end (ADR-0010).
 * The service task is cancelled best effort and the version fails with a retryable TIMEOUT, so an
 * explicit retry stays possible. One audit event, IDs only.
 */
async function timeOut(
  deps: ProcessingDeps,
  row: AudioPreprocessing,
  recording: Recording,
  taskId: string,
): Promise<StepOutcome> {
  await stopTask(deps, taskId);
  const applied = await deps.db.transaction(async (tx) => {
    const ok = await markFailed(tx, row.workspaceId, row.id, { code: 'TIMEOUT', retryable: true });
    if (ok) {
      await tx.insert(auditEvents).values({
        workspaceId: row.workspaceId,
        actorId: 'system:orchestrator',
        action: 'audio.preprocessing_timed_out',
        resourceType: 'recording',
        resourceId: recording.id,
        metadata: { preprocessingId: row.id, attempt: row.attempt },
      });
    }
    return ok;
  });
  deps.log({ msg: 'preprocess_failed', preprocessingId: row.id, code: 'TIMEOUT', applied });
  return FINISH;
}

async function complete(
  deps: ProcessingDeps,
  row: AudioPreprocessing,
  recording: Recording,
  state: AudioTaskState,
): Promise<StepOutcome> {
  const { db } = deps;
  const prefix = outputPrefix(row.workspaceId, recording.id, row.configHash);
  const parsed = AudioPreprocessResult.safeParse(state.result);
  const under = (key: string) => key.startsWith(`${prefix}/`);
  if (
    !parsed.success ||
    !under(parsed.data.canonical.key) ||
    !under(parsed.data.artifacts.levelSeriesKey) ||
    !under(parsed.data.artifacts.manifestKey)
  ) {
    // A result that breaks the contract is a service fault; nothing from it is persisted.
    await markFailed(db, row.workspaceId, row.id, { code: 'INTERNAL_ERROR', retryable: false });
    deps.log({ msg: 'preprocess_failed', preprocessingId: row.id, code: 'INTERNAL_ERROR' });
    return FINISH;
  }
  const result = parsed.data;
  const input: CompletePreprocessingInput = {
    workspaceId: row.workspaceId,
    id: row.id,
    normalizedUri: uriForKey(recording.storageUri, result.canonical.key),
    canonicalSha256: result.canonical.sha256,
    // The column is whole milliseconds; the exact sample count is kept in `artifacts`.
    canonicalDurationMs: Math.round(result.canonical.durationMs),
    timeline: result.timeline,
    vad: result.vad,
    artifacts: {
      levelSeriesUri: uriForKey(recording.storageUri, result.artifacts.levelSeriesKey),
      manifestUri: uriForKey(recording.storageUri, result.artifacts.manifestKey),
      canonicalSamples: result.canonical.samples,
      canonicalBytes: result.canonical.bytes,
    },
    segments: result.segments.map((s) => ({
      index: s.index,
      startMs: s.startMs,
      endMs: s.endMs,
      overlapStartMs: s.overlapStartMs,
      overlapEndMs: s.overlapEndMs,
      speechMs: s.speechMs,
      containsSyntheticGap: s.containsSyntheticGap,
    })),
    measurements: [
      ...result.measurements.map((record) => ({
        segmentIndex: null,
        source: record.source,
        schemaVersion: String(record.measurementsSchemaVersion),
        measurements: record as unknown as Record<string, unknown>,
        seriesUri:
          record.source === 'canonical'
            ? uriForKey(recording.storageUri, result.artifacts.levelSeriesKey)
            : null,
        serviceVersion: result.toolVersions.service,
      })),
      ...result.segmentMeasurements.map((m) => ({
        segmentIndex: m.segmentIndex,
        source: m.record.source,
        schemaVersion: String(m.record.measurementsSchemaVersion),
        measurements: m.record as unknown as Record<string, unknown>,
        serviceVersion: result.toolVersions.service,
      })),
    ],
  };

  const applied = await db.transaction(async (tx) => {
    const ok = await completePreprocessing(tx, input);
    if (ok) {
      await tx.insert(auditEvents).values({
        workspaceId: row.workspaceId,
        actorId: 'system:orchestrator',
        action: 'audio.preprocessing_completed',
        resourceType: 'recording',
        resourceId: recording.id,
        metadata: {
          preprocessingId: row.id,
          segmentCount: result.segments.length,
          canonicalDurationMs: input.canonicalDurationMs,
        },
      });
    }
    return ok;
  });
  deps.log({
    msg: applied ? 'preprocess_completed' : 'preprocess_completion_skipped',
    preprocessingId: row.id,
    segmentCount: result.segments.length,
  });
  return FINISH;
}

/** Client failures: a bad token or a refused request fails the version; the rest retry via BullMQ. */
async function handleClientError(
  deps: ProcessingDeps,
  row: AudioPreprocessing,
  error: unknown,
): Promise<StepOutcome> {
  if (error instanceof AudioClientError) {
    if (error.kind === 'CONFIG') {
      await markFailed(deps.db, row.workspaceId, row.id, {
        code: 'UNAUTHORIZED',
        retryable: false,
      });
      deps.log({ msg: 'preprocess_failed', preprocessingId: row.id, code: 'UNAUTHORIZED' });
      return FINISH;
    }
    if (error.kind === 'REJECTED') {
      const code = AudioServiceErrorCode.safeParse(error.code);
      await markFailed(deps.db, row.workspaceId, row.id, {
        code: code.success ? code.data : 'INTERNAL_ERROR',
        retryable: false,
      });
      deps.log({
        msg: 'preprocess_failed',
        preprocessingId: row.id,
        code: code.success ? code.data : 'INTERNAL_ERROR',
      });
      return FINISH;
    }
    throw new TransientError(error.kind);
  }
  throw error;
}

async function stopTask(deps: ProcessingDeps, taskId: string): Promise<void> {
  try {
    await deps.audio.cancel(taskId);
  } catch {
    // Best effort: the service bounds task lifetime itself.
  }
}

async function findRecording(
  deps: ProcessingDeps,
  workspaceId: string,
  recordingId: string,
): Promise<Recording | null> {
  const [row] = await deps.db
    .select()
    .from(recordings)
    .where(and(eq(recordings.workspaceId, workspaceId), eq(recordings.id, recordingId)))
    .limit(1);
  return row ?? null;
}

/**
 * The job exhausted its BullMQ attempts on transient failures: the version fails with a
 * retryable code, so a later explicit retry (bounded) is possible.
 */
export async function failExhaustedPreprocess(
  deps: ProcessingDeps,
  payload: unknown,
): Promise<void> {
  const data = AudioPreprocessJob.safeParse(payload);
  if (!data.success) return;
  const { workspaceId, preprocessingId } = data.data;
  if (data.data.taskId) await stopTask(deps, data.data.taskId);
  await markFailed(deps.db, workspaceId, preprocessingId, { code: 'TIMEOUT', retryable: true });
  deps.log({ msg: 'preprocess_failed', preprocessingId, code: 'TIMEOUT' });
}
