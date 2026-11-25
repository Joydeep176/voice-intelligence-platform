import { JobIds, QueueName, RunTranscriptionJob } from '@vip/contracts';
import { Queue } from 'bullmq';
import type { OrchestratorConfig } from '../config';
import { workerConnection } from '../config';

/**
 * The orchestrator's handles on the run queues: the sweeper re-enqueues lost runs. Same job ID
 * (the run ID) and dedupe rules as the API producer.
 */
export class RunQueues {
  readonly run: Queue;
  readonly sweep: Queue;

  constructor(config: OrchestratorConfig) {
    const connection = workerConnection(config.redisUrl);
    this.run = new Queue(QueueName.RunTranscription, {
      connection,
      defaultJobOptions: {
        attempts: config.runs.attempts,
        backoff: { type: 'exponential' as const, delay: config.runs.backoffMs },
        removeOnComplete: { count: 100, age: 24 * 3600 },
        removeOnFail: { count: 1000 },
      },
    });
    this.sweep = new Queue(QueueName.RunSweep, {
      connection,
      defaultJobOptions: { removeOnComplete: { count: 10 }, removeOnFail: { count: 50 } },
    });
  }

  /** True while the job is waiting, active or delayed (not finished and not absent). */
  async isLive(jobId: string): Promise<boolean> {
    const job = await this.run.getJob(jobId);
    if (!job) return false;
    const state = await job.getState();
    return state !== 'completed' && state !== 'failed' && state !== 'unknown';
  }

  async enqueueRun(workspaceId: string, runId: string): Promise<void> {
    const data = RunTranscriptionJob.parse({ workspaceId, runId });
    const jobId = JobIds.run(runId);
    if (await this.isLive(jobId)) return;
    const stale = await this.run.getJob(jobId);
    if (stale) await stale.remove().catch(() => undefined); // a finished job blocks the same ID
    await this.run.add('run', data, { jobId });
  }

  async close(): Promise<void> {
    await Promise.allSettled([this.run.close(), this.sweep.close()]);
  }
}
