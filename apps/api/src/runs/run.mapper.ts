import {
  RUN_STAGES,
  RunConfig,
  StageProgress,
  type RunSnapshot,
  type RunStage,
  type RunStageSnapshot,
} from '@vip/contracts';
import type { PipelineRun, PipelineStageRun } from '@vip/db';
import { toProcessingStatus } from '../recordings/recording.mapper';

/**
 * Snapshot of a run: the existing `ProcessingStatus` fields plus stage status and progress,
 * providers, window source and run-control state. Stage rows are passed newest attempt first;
 * a stage with no row yet is `pending`. Unknown values are `null`, never estimated.
 */
export function toRunSnapshot(
  run: PipelineRun,
  stageRows: PipelineStageRun[],
  maxRetries: number,
  transcriptAvailable: boolean,
): RunSnapshot {
  const config = RunConfig.safeParse(run.config);
  const scope: RunStage[] = config.success ? config.data.stages : [...RUN_STAGES];
  const stages = scope.map((node): RunStageSnapshot => {
    const row = stageRows.find((r) => r.node === node); // newest attempt first
    if (!row) {
      return {
        node,
        status: 'pending',
        attempt: 0,
        progress: null,
        startedAt: null,
        finishedAt: null,
        error: null,
      };
    }
    const progress = StageProgress.safeParse(row.progress);
    return {
      node,
      status: row.status,
      attempt: row.attempt,
      progress: progress.success ? progress.data : null,
      startedAt: row.startedAt?.toISOString() ?? null,
      finishedAt: row.finishedAt?.toISOString() ?? null,
      error: row.error ? { code: row.error.code } : null,
    };
  });
  return {
    ...toProcessingStatus(run),
    preprocessingId: run.preprocessingId,
    scope,
    stages,
    providers: config.success ? (config.data.providers ?? null) : null,
    window: config.success ? (config.data.window ?? null) : null,
    retryCount: run.retryCount,
    maxRetries,
    cancelRequested: run.cancelRequestedAt !== null || run.status === 'cancelling',
    transcriptAvailable,
  };
}
