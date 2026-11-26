import { Logger } from '@nestjs/common';
import { JobIds, QueueName, RunAudioQualityJob, RunTranscriptionJob } from '@vip/contracts';
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
  /** Phase 3A A1 queue (ADR-0044): one job per (run, attempt). */
  readonly audioQuality: Queue<RunAudioQualityJob>;
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
    this.audioQuality = new Queue(QueueName.RunAudioQuality, {
      connection: redisConnection(config.redis.url),
      defaultJobOptions: {
        attempts: settings.audioQuality.attempts,
        backoff: { type: 'exponential' as const, delay: settings.audioQuality.backoffMs },
        removeOnComplete: { count: 200, age: 24 * 3600 },
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

  /** A1-only (re-)assessment of a run (lifecycle L6). Never touches the transcription job. */
  async enqueueAudioQuality(workspaceId: string, runId: string, attempt: number): Promise<void> {
    const data = RunAudioQualityJob.parse({ workspaceId, runId, attempt });
    const jobId = JobIds.audioQuality(runId, attempt);
    const existing = await this.audioQuality.getJob(jobId);
    if (existing) {
      const state = await existing.getState();
      if (state !== 'completed' && state !== 'failed') return;
      await existing.remove().catch(() => undefined);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await this.audioQuality.add('assess', data as any, { jobId });
  }

  async close(): Promise<void> {
    await Promise.allSettled([this.run.close(), this.audioQuality.close()]);
  }
}
