import { JobIds } from '@vip/contracts';
import {
  auditEvents,
  finishStage,
  listStuckRuns,
  markRunFailed,
  requeueStuckRun,
  type PipelineRun,
} from '@vip/db';
import { finishCancelled } from './run.step';
import type { RunQueues } from './queues';
import type { RunDeps } from './types';

/** Decision for a stuck run that has no live job. */
export function decideRunSweep(retryCount: number, maxRetries: number): 'requeue' | 'fail' {
  return retryCount < maxRetries ? 'requeue' : 'fail';
}

export interface RunSweepCounts {
  requeued: number;
  failed: number;
  cancelled: number;
}

/**
 * Recovers runs that lost their job (Redis flush, crash before enqueue). Bounded per sweep by
 * `sweepBatch`. A run `queued|running` untouched for longer than `stuckAfterMs` with no live job is
 * re-enqueued while `retry_count < RUN_MAX_RETRIES` (the recovery counts as a retry, compare-and-set
 * so concurrent sweepers count it once), else failed with a retryable TIMEOUT. A `cancelling` run
 * with no live job is finished as cancelled. Progress writes touch the run row, so a run that is
 * making progress is never swept. Logs counts only.
 */
export async function sweepRuns(deps: RunDeps, queues: RunQueues): Promise<RunSweepCounts> {
  const { db, config } = deps;
  const cutoff = new Date(deps.now() - config.stuckAfterMs);
  const counts: RunSweepCounts = { requeued: 0, failed: 0, cancelled: 0 };
  const rows = await listStuckRuns(db, cutoff, config.sweepBatch);
  for (const row of rows) {
    if (await queues.isLive(JobIds.run(row.id))) continue;
    if (row.status === 'cancelling') {
      await finishCancelled(deps, row);
      counts.cancelled += 1;
      continue;
    }
    if (decideRunSweep(row.retryCount, config.maxRetries) === 'fail') {
      if (await failStuck(deps, row)) counts.failed += 1;
      continue;
    }
    if (await requeueStuckRun(db, row.workspaceId, row.id, config.maxRetries, row.retryCount)) {
      await db.insert(auditEvents).values({
        workspaceId: row.workspaceId,
        actorId: 'orchestrator',
        action: 'run.retried',
        resourceType: 'run',
        resourceId: row.id,
        metadata: { reason: 'sweeper', retryCount: row.retryCount + 1 },
      });
      await queues.enqueueRun(row.workspaceId, row.id);
      counts.requeued += 1;
    }
  }
  if (counts.requeued + counts.failed + counts.cancelled > 0) {
    deps.log({ msg: 'run_sweep_recovered', ...counts });
  }
  return counts;
}

async function failStuck(deps: RunDeps, row: PipelineRun): Promise<boolean> {
  const { db } = deps;
  const node =
    row.currentNode === 'transcription' || row.currentNode === 'diarization'
      ? row.currentNode
      : null;
  if (node) {
    await finishStage(db, row.workspaceId, row.id, node, row.retryCount + 1, 'failed', {
      code: 'TIMEOUT',
    });
  }
  const applied = await markRunFailed(db, row.workspaceId, row.id, { code: 'TIMEOUT', node });
  if (applied) {
    await db.insert(auditEvents).values({
      workspaceId: row.workspaceId,
      actorId: 'orchestrator',
      action: 'run.failed',
      resourceType: 'run',
      resourceId: row.id,
      metadata: { code: 'TIMEOUT', node, retryCount: row.retryCount },
    });
  }
  return applied;
}
