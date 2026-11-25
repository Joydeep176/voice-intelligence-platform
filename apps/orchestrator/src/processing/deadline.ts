import { INTERIM_PROCESSING_LIMITS } from '@vip/contracts';
import type { ProcessingConfig } from '../config';

/** Interim (OD-10 / D-2B-20 Open): the audio service's `0.5 x audio duration` term. */
export const DEADLINE_DURATION_FACTOR = 0.5;

/**
 * Task slots in the audio service (defaults: 1 running + 4 queued, `AUDIO_SERVICE_MAX_*`). A task that is still
 * queued may wait for every slot ahead of it to run a maximum-length task, so its bound is that many full bounds.
 */
export const SERVICE_TASK_SLOTS = 5;

export interface BackstopInput {
  kind: 'probe' | 'preprocess';
  /** Epoch ms the task was submitted. */
  submittedAt: number;
  /** Epoch ms the task was first observed `running`; undefined while it waits in the service queue. */
  runningSince?: number | null | undefined;
  /** The service's own deadline (epoch ms) once it reported one. */
  reportedDeadlineAt: number | null | undefined;
  /** Recording duration; unknown falls back to the longest accepted recording (conservative). */
  durationMs: number | null | undefined;
}

/**
 * Epoch ms after which Node stops waiting for a task and fails it with a retryable TIMEOUT
 * (ADR-0010/0014: polling is bounded). The service's reported deadline wins; before that the same
 * interim formula the service uses applies (probe: base only), plus the grace.
 */
export function backstopDeadlineAt(
  input: BackstopInput,
  config: Pick<ProcessingConfig, 'deadlineBaseMs' | 'deadlineGraceMs'>,
): number {
  if (input.reportedDeadlineAt !== null && input.reportedDeadlineAt !== undefined) {
    return input.reportedDeadlineAt + config.deadlineGraceMs;
  }
  const duration =
    input.kind === 'probe' ? 0 : (input.durationMs ?? INTERIM_PROCESSING_LIMITS.maxDurationMs);
  if (input.runningSince !== null && input.runningSince !== undefined) {
    return (
      input.runningSince +
      config.deadlineBaseMs +
      DEADLINE_DURATION_FACTOR * duration +
      config.deadlineGraceMs
    );
  }
  // Still queued inside the service: never time out a task that has not started because a long task is ahead
  // of it, but stay bounded (ADR-0010): every slot ahead may run a maximum-length task.
  const worstTask =
    config.deadlineBaseMs + DEADLINE_DURATION_FACTOR * INTERIM_PROCESSING_LIMITS.maxDurationMs;
  return input.submittedAt + SERVICE_TASK_SLOTS * worstTask + config.deadlineGraceMs;
}
