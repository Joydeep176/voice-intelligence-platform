import {
  AUDIO_SERVICE_CONTRACT_VERSION,
  AudioProbeJob,
  AudioProbeResult,
  AudioTaskCreateRequest,
  buildPreprocessConfig,
  buildProbeConfig,
  decideRowAction,
  toolVersionsFromCapabilities,
  type AudioTaskState,
} from '@vip/contracts';
import {
  and,
  auditEvents,
  eq,
  markRecordingValidating,
  recordings,
  resetForRetry,
  resetRecordingToUploaded,
  setRecordingProbe,
  upsertPreprocessing,
  type Recording,
} from '@vip/db';
import { AudioClientError } from './audio-client';
import { backstopDeadlineAt } from './deadline';
import { configHashOf, idempotencyKey, originalKey, outputPrefix } from './keys';
import { FINISH, TransientError, type ProcessingDeps, type StepOutcome } from './types';

/** Failure codes that are the file's fault: the recording becomes `invalid` with that code. */
const FILE_FAULT_CODES = new Set([
  'UNSUPPORTED_FORMAT',
  'CORRUPT_MEDIA',
  'NO_DECODABLE_AUDIO',
  'DURATION_LIMIT_EXCEEDED',
  'RESOURCE_LIMIT_EXCEEDED',
]);

/**
 * One step of the `audio-probe` job (validation, LLD §4 step 2): `uploaded -> validating`, run the
 * probe task, then `valid` (probe record stored, no container tags) or `invalid` (error code).
 * A service-side fault (retries exhausted, bad result) is not the file's fault: the recording
 * returns to `uploaded` so processing can be requested again. With `thenPreprocess`, a valid
 * recording continues straight into preprocessing.
 */
export async function probeStep(deps: ProcessingDeps, payload: unknown): Promise<StepOutcome> {
  const data = AudioProbeJob.parse(payload);
  const { workspaceId, recordingId } = data;

  let recording = await findRecording(deps, workspaceId, recordingId);
  if (!recording) return FINISH;
  if (recording.status === 'uploaded') {
    await markRecordingValidating(deps.db, workspaceId, recordingId); // false: re-read below
    recording = await findRecording(deps, workspaceId, recordingId);
    if (!recording) return FINISH;
  }
  if (recording.status === 'valid' && data.thenPreprocess) {
    // Redelivery after the probe was stored but before the follow-up was queued.
    await startPreprocessing(deps, workspaceId, recordingId);
    return FINISH;
  }
  if (recording.status !== 'validating') return FINISH;

  return data.taskId ? poll(deps, data, data.taskId) : submit(deps, data);
}

async function submit(deps: ProcessingDeps, data: AudioProbeJob): Promise<StepOutcome> {
  const { workspaceId, recordingId } = data;
  if (data.submissions >= deps.config.maxRetries) {
    await giveUp(deps, data, 'TIMEOUT');
    return FINISH;
  }
  const config = buildProbeConfig();
  const hash = configHashOf(config);
  const submission = data.submissions + 1;
  const request = AudioTaskCreateRequest.parse({
    contractVersion: AUDIO_SERVICE_CONTRACT_VERSION,
    type: 'probe',
    idempotencyKey: idempotencyKey(recordingId, hash, 'probe', submission),
    workspaceId,
    recordingId,
    input: {
      originalKey: originalKey(workspaceId, recordingId),
      outputPrefix: outputPrefix(workspaceId, recordingId, hash),
    },
    config,
  });
  let taskId: string;
  try {
    taskId = (await deps.audio.submit(request)).taskId;
  } catch (error) {
    return handleClientError(deps, data, error);
  }
  deps.log({ msg: 'probe_submitted', recordingId, submission });
  return {
    kind: 'delay',
    delayMs: deps.config.pollIntervalMs,
    data: { taskId, submissions: submission, submittedAt: deps.now(), deadlineAt: undefined },
  };
}

async function poll(
  deps: ProcessingDeps,
  data: AudioProbeJob,
  taskId: string,
): Promise<StepOutcome> {
  let state: AudioTaskState;
  try {
    state = await deps.audio.get(taskId);
  } catch (error) {
    if (error instanceof AudioClientError && error.kind === 'LOST') {
      deps.log({ msg: 'probe_task_lost', recordingId: data.recordingId });
      return submit(deps, { ...data, taskId: undefined });
    }
    return handleClientError(deps, data, error);
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
          kind: 'probe',
          submittedAt,
          runningSince,
          reportedDeadlineAt: reported,
          durationMs: null,
        },
        deps.config,
      );
      if (deps.now() > deadlineAt) {
        await timeOut(deps, data, taskId);
        return FINISH;
      }
      const track =
        data.submittedAt === undefined ||
        (reported ?? undefined) !== data.deadlineAt ||
        runningSince !== data.runningSince
          ? { submittedAt, deadlineAt: reported ?? undefined, runningSince }
          : undefined;
      return {
        kind: 'delay',
        delayMs: deps.config.pollIntervalMs,
        ...(track ? { data: track } : {}),
      };
    }
    case 'cancelled':
      await giveUp(deps, data, 'CANCELLED');
      return FINISH;
    case 'failed': {
      const error = state.error ?? { code: 'INTERNAL_ERROR' as const, retryable: false };
      // Only a non-retryable file-property code invalidates the recording. A retryable failure
      // (RESOURCE_EXHAUSTED, TIMEOUT, ...) is a service or resource fault, never the file's.
      if (!error.retryable && FILE_FAULT_CODES.has(error.code)) {
        await setRecordingProbe(deps.db, data.workspaceId, data.recordingId, {
          status: 'invalid',
          validationError: error.code,
        });
        deps.log({ msg: 'probe_invalid', recordingId: data.recordingId, code: error.code });
        return FINISH;
      }
      if (error.retryable && data.submissions < deps.config.maxRetries) {
        return {
          kind: 'delay',
          delayMs: deps.config.retryBackoffMs * 2 ** Math.max(0, data.submissions - 1),
          data: { taskId: undefined },
        };
      }
      await giveUp(deps, data, error.code);
      return FINISH;
    }
    case 'succeeded': {
      const probe = AudioProbeResult.safeParse(state.result);
      if (!probe.success) {
        await giveUp(deps, data, 'INTERNAL_ERROR');
        return FINISH;
      }
      const stored = await setRecordingProbe(deps.db, data.workspaceId, data.recordingId, {
        status: 'valid',
        mediaProbe: probe.data as unknown as Record<string, unknown>,
        sampleRate: probe.data.sampleRateHz,
        channels: probe.data.channels,
        ...(probe.data.headerDurationMs === null
          ? {}
          : { durationMs: probe.data.headerDurationMs }),
      });
      deps.log({ msg: 'probe_valid', recordingId: data.recordingId, stored });
      if (stored && data.thenPreprocess) {
        await startPreprocessing(deps, data.workspaceId, data.recordingId);
      }
      return FINISH;
    }
  }
}

/**
 * Creates (or finds) the preprocessing version for a recording that just became valid and queues
 * it. Same rules as the API's explicit start (`decideRowAction`).
 */
export async function startPreprocessing(
  deps: ProcessingDeps,
  workspaceId: string,
  recordingId: string,
): Promise<void> {
  let toolVersions;
  try {
    toolVersions = toolVersionsFromCapabilities(await deps.audio.capabilities());
  } catch (error) {
    if (
      error instanceof AudioClientError &&
      (error.kind === 'CONFIG' || error.kind === 'REJECTED')
    ) {
      deps.log({ msg: 'preprocess_not_started', recordingId, code: error.kind });
      return;
    }
    throw new TransientError(error instanceof AudioClientError ? error.kind : 'UNKNOWN');
  }
  if (!toolVersions) {
    deps.log({ msg: 'preprocess_not_started', recordingId, code: 'CANNOT_PREPROCESS' });
    return;
  }
  const config = buildPreprocessConfig(toolVersions);
  const { preprocessing } = await upsertPreprocessing(deps.db, {
    workspaceId,
    recordingId,
    configHash: configHashOf(config),
    config: config as unknown as Record<string, unknown>,
    toolVersions: config.toolVersions,
  });
  const decision = decideRowAction(preprocessing, deps.config.maxRetries);
  if (decision.kind === 'retry') await resetForRetry(deps.db, workspaceId, preprocessing.id);
  if (decision.kind === 'enqueue' || decision.kind === 'retry') {
    await deps.enqueuer.enqueuePreprocess(workspaceId, preprocessing.id);
    deps.log({ msg: 'preprocess_queued', recordingId, preprocessingId: preprocessing.id });
  }
}

async function handleClientError(
  deps: ProcessingDeps,
  data: AudioProbeJob,
  error: unknown,
): Promise<StepOutcome> {
  if (error instanceof AudioClientError) {
    if (error.kind === 'CONFIG' || error.kind === 'REJECTED') {
      await giveUp(
        deps,
        data,
        error.kind === 'CONFIG' ? 'UNAUTHORIZED' : (error.code ?? 'REJECTED'),
      );
      return FINISH;
    }
    throw new TransientError(error.kind);
  }
  throw error;
}

/**
 * The probe task outlived its deadline (service's plus grace): stop polling (ADR-0010). A service
 * fault, so the recording returns to `uploaded` (never `invalid`); the task is cancelled best effort.
 */
async function timeOut(deps: ProcessingDeps, data: AudioProbeJob, taskId: string): Promise<void> {
  try {
    await deps.audio.cancel(taskId);
  } catch {
    // Best effort: the service bounds task lifetime itself.
  }
  const reset = await resetRecordingToUploaded(deps.db, data.workspaceId, data.recordingId);
  if (reset) {
    await deps.db.insert(auditEvents).values({
      workspaceId: data.workspaceId,
      actorId: 'system:orchestrator',
      action: 'audio.probe_timed_out',
      resourceType: 'recording',
      resourceId: data.recordingId,
      metadata: { submissions: data.submissions },
    });
  }
  deps.log({ msg: 'probe_gave_up', recordingId: data.recordingId, code: 'TIMEOUT' });
}

/** Not the file's fault: back to `uploaded`, so the user can request processing again. */
async function giveUp(deps: ProcessingDeps, data: AudioProbeJob, code: string): Promise<void> {
  await resetRecordingToUploaded(deps.db, data.workspaceId, data.recordingId);
  deps.log({ msg: 'probe_gave_up', recordingId: data.recordingId, code });
}

/** The job exhausted its BullMQ attempts on transient failures. */
export async function failExhaustedProbe(deps: ProcessingDeps, payload: unknown): Promise<void> {
  const data = AudioProbeJob.safeParse(payload);
  if (data.success) await giveUp(deps, data.data, 'TIMEOUT');
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
