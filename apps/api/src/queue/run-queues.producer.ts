import { Logger } from '@nestjs/common';
import { JobIds, QueueName, RunTranscriptionJob } from '@vip/contracts';
import { Queue } from 'bullmq';
import type { AppConfig } from '../config/app-config';
import { redisConnection } from './redis-connection';
import type { RunSettings } from './run-settings';

/**
 * Producer for the Phase 2C run queue (LLD §5). The job carries IDs only; its ID is the run ID, so
 * a live job (waiting, active, delayed) is never duplicated and a finished one that BullMQ still
 * retains is replaced so a retry can run again. The worker lives in apps/orchestrator.
 */
export class RunQueues {
  readonly run: Queue<RunTranscriptionJob>;
  private readonly logger = new Logger('Queue');
  private lastErrorLogAt = 0;

  constructor(config: AppConfig, settings: RunSettings) {
    this.run = new Queue(QueueName.RunTranscription, {
      connection: redisConnection(config.redis.url),
      defaultJobOptions: {
        attempts: settings.attempts,
        backoff: { type: 'exponential' as const, delay: settings.backoffMs },
        removeOnComplete: { count: 100, age: 24 * 3600 },
        removeOnFail: { count: 1000 },
      },
    });
    this.run.on('error', (error) => {
      const now = Date.now();
      if (now - this.lastErrorLogAt < 30_000) return;
      this.lastErrorLogAt = now;
      this.logger.warn({
        msg: 'redis_connection_error',
        queue: this.run.name,
        errorName: error.name,
        errorCode: (error as { code?: string }).code ?? null,
      });
    });
  }

  async enqueueRun(workspaceId: string, runId: string): Promise<void> {
    const data = RunTranscriptionJob.parse({ workspaceId, runId });
    const jobId = JobIds.run(runId);
    const existing = await this.run.getJob(jobId);
    if (existing) {
      const state = await existing.getState();
      if (state !== 'completed' && state !== 'failed') return;
      await existing.remove().catch(() => undefined);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await this.run.add('run', data as any, { jobId });
  }

  /** Removes a job that has not started; an active job is left to its worker (cooperative cancel). */
  async removeWaitingRun(runId: string): Promise<void> {
    const job = await this.run.getJob(JobIds.run(runId));
    if (!job) return;
    const state = await job.getState();
    if (state === 'waiting' || state === 'delayed' || state === 'prioritized') {
      await job.remove().catch(() => undefined); // lost the race to a worker: it re-checks the row
    }
  }

  async close(): Promise<void> {
    await Promise.allSettled([this.run.close()]);
  }
}
