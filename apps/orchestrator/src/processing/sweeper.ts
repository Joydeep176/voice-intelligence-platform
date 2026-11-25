import { and, asc, audioPreprocessings, inArray, lt, markFailed, recordings, eq } from '@vip/db';
import { JobIds } from '@vip/contracts';
import type { ProcessingQueues } from './queues';
import type { ProcessingDeps } from './types';

/** Decision for a stuck row that has no live job. */
export function decideSweep(attempt: number, maxRetries: number): 'requeue' | 'fail' {
  return attempt < maxRetries ? 'requeue' : 'fail';
}

export interface SweepCounts {
  requeued: number;
  failed: number;
  probesRequeued: number;
}

/**
 * Recovers work that lost its job (Redis flush, crash before enqueue). Bounded per run by
 * `sweepBatch`. A row `queued|running` untouched for longer than `stuckAfterMs` with no live job
 * is re-enqueued while attempts remain (a requeue counts no attempt), else failed with a
 * retryable TIMEOUT. A recording stuck in `validating` with no live probe job gets its probe
 * re-enqueued (without `thenPreprocess`: that intent is not recoverable). Logs counts only.
 */
export async function sweep(deps: ProcessingDeps, queues: ProcessingQueues): Promise<SweepCounts> {
  const { db, config } = deps;
  const cutoff = new Date(deps.now() - config.stuckAfterMs);
  const counts: SweepCounts = { requeued: 0, failed: 0, probesRequeued: 0 };

  const rows = await db
    .select()
    .from(audioPreprocessings)
    .where(
      and(
        inArray(audioPreprocessings.status, ['queued', 'running']),
        lt(audioPreprocessings.updatedAt, cutoff),
      ),
    )
    .orderBy(asc(audioPreprocessings.updatedAt))
    .limit(config.sweepBatch);
  for (const row of rows) {
    if (await queues.isLive(queues.preprocess, JobIds.preprocess(row.id))) continue;
    if (decideSweep(row.attempt, config.maxRetries) === 'fail') {
      if (await markFailed(db, row.workspaceId, row.id, { code: 'TIMEOUT', retryable: true })) {
        counts.failed += 1;
      }
      continue;
    }
    // No attempt is counted here: the fresh job re-attaches to the live submission through the
    // same idempotency key. An attempt is counted only when a new submission is made after a
    // confirmed loss or failure (compare-and-set in the step), so a requeue never forks a task.
    await queues.enqueuePreprocess(row.workspaceId, row.id);
    counts.requeued += 1;
  }

  const stuck = await db
    .select({ id: recordings.id, workspaceId: recordings.workspaceId })
    .from(recordings)
    .where(and(eq(recordings.status, 'validating'), lt(recordings.updatedAt, cutoff)))
    .orderBy(asc(recordings.updatedAt))
    .limit(config.sweepBatch);
  for (const rec of stuck) {
    if (await queues.isLive(queues.probe, JobIds.probe(rec.id))) continue;
    await queues.enqueueProbe(rec.workspaceId, rec.id, false);
    counts.probesRequeued += 1;
  }

  if (counts.requeued + counts.failed + counts.probesRequeued > 0) {
    deps.log({ msg: 'sweep_recovered', ...counts });
  }
  return counts;
}
