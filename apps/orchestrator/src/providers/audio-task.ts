import { createHash } from 'node:crypto';
import type { AudioTaskCreateRequest, AudioTaskState, AudioTaskType } from '@vip/contracts';
import { AudioClientError, type AudioTasks } from '../processing/audio-client';
import { originalKey, outputPrefix } from '../processing/keys';
import type { AudioSourceRef } from '@vip/contracts';
import { ProviderError } from './errors';

/** What a self-hosted adapter needs to reach the audio service (ADR-0002). */
export interface AudioTaskDeps {
  audio: AudioTasks;
  pollMs: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Audio-service failures that trying again can fix (the rest are permanent for this input). */
const RETRYABLE_TASK_CODES = new Set([
  'TIMEOUT',
  'STORAGE_ERROR',
  'INTERNAL_ERROR',
  'CAPACITY_EXCEEDED',
  'RESOURCE_EXHAUSTED',
  'CANCELLED',
]);

/** Fresh keys tried when the service reports an earlier finished failure for the content key. */
const MAX_FRESH_KEYS = 3;

/**
 * Submits one inference task for the canonical audio of `source` and polls it to a final state.
 * The idempotency key is derived from the task content, so a resubmit after a lost response (a
 * timeout, a paused or restarting service, a second orchestrator) joins the task already queued or
 * running instead of queueing a duplicate inference behind it. The service answers a known key with
 * the earlier task and its status: an earlier `failed` / `cancelled` task is never replayed; the
 * call resubmits under a suffixed key so a retry really runs again. Engines are deterministic, so an
 * earlier `succeeded` task's result is the result. Failures become content-free `ProviderError` codes.
 */
export async function runAudioTask(
  deps: AudioTaskDeps,
  type: Extract<AudioTaskType, 'transcribe' | 'diarize' | 'measure'>,
  source: AudioSourceRef | undefined,
  config: Record<string, unknown>,
  /** Called after each poll while the task is queued or running (for example a liveness heartbeat). */
  onPoll?: () => Promise<void>,
): Promise<Record<string, unknown>> {
  if (!source) throw new ProviderError('AUDIO_SOURCE_REQUIRED', false);
  const request: AudioTaskCreateRequest = {
    contractVersion: '',
    type,
    idempotencyKey: '',
    workspaceId: source.workspaceId,
    recordingId: source.recordingId,
    input: {
      originalKey: originalKey(source.workspaceId, source.recordingId),
      outputPrefix: outputPrefix(
        source.workspaceId,
        source.recordingId,
        source.preprocessingConfigHash,
      ),
    },
    config,
  };
  const contentKey = `${type}:${createHash('sha256')
    .update(JSON.stringify([type, request.workspaceId, request.recordingId, request.input, config]))
    .digest('hex')
    .slice(0, 32)}`;
  const sleep = deps.sleep ?? defaultSleep;
  let state: AudioTaskState;
  try {
    let accepted = await deps.audio.submit({ ...request, idempotencyKey: contentKey });
    for (let n = 1; isFinishedFailure(accepted.status) && n <= MAX_FRESH_KEYS; n++) {
      accepted = await deps.audio.submit({ ...request, idempotencyKey: `${contentKey}:${n}` });
    }
    state = await deps.audio.get(accepted.taskId);
    while (state.status === 'queued' || state.status === 'running') {
      await sleep(deps.pollMs);
      state = await deps.audio.get(accepted.taskId);
      if (onPoll && (state.status === 'queued' || state.status === 'running')) await onPoll();
    }
  } catch (error) {
    throw toProviderError(error);
  }
  if (state.status === 'succeeded' && state.result) return state.result;
  const code = state.error?.code ?? 'TASK_FAILED';
  throw new ProviderError(
    `AUDIO_${code}`,
    state.error?.retryable ?? RETRYABLE_TASK_CODES.has(code),
  );
}

const isFinishedFailure = (status: AudioTaskState['status']): boolean =>
  status === 'failed' || status === 'cancelled';

function toProviderError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  if (error instanceof AudioClientError) {
    // LOST (task unknown after a service restart), BUSY and transport problems are retryable.
    const retryable = !['CONFIG', 'REJECTED'].includes(error.kind);
    return new ProviderError(`AUDIO_${error.code ?? error.kind}`, retryable);
  }
  return new ProviderError('AUDIO_CLIENT_ERROR', true);
}
