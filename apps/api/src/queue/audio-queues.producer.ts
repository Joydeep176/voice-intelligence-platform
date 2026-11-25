import { Logger } from '@nestjs/common';
import { AudioPreprocessJob, AudioProbeJob, JobIds, QueueName } from '@vip/contracts';
import { Queue } from 'bullmq';
import type { AppConfig } from '../config/app-config';
import { redisConnection } from './redis-connection';

/**
 * Producers for the Phase 2B audio queues (LLD §5). Jobs carry IDs only. The job ID is the dedupe
 * key: a live job (waiting, active, delayed) is never duplicated, and a finished one that BullMQ
 * still retains is replaced so an explicit retry can run again. Workers live in apps/orchestrator.
 */
export class AudioQueues {
  readonly probe: Queue<AudioProbeJob>;
  readonly preprocess: Queue<AudioPreprocessJob>;
  private readonly logger = new Logger('Queue');
  private lastErrorLogAt = 0;

  constructor(config: AppConfig) {
    const defaultJobOptions = {
      attempts: config.queues.audio.attempts,
      backoff: { type: 'exponential' as const, delay: config.queues.audio.backoffMs },
      removeOnComplete: { count: 100, age: 24 * 3600 },
      removeOnFail: { count: 1000 },
    };
    const connection = redisConnection(config.redis.url);
    this.probe = new Queue(QueueName.AudioProbe, { connection, defaultJobOptions });
    this.preprocess = new Queue(QueueName.AudioPreprocess, { connection, defaultJobOptions });
    for (const queue of [this.probe, this.preprocess]) {
      queue.on('error', (error) => this.logConnectionError(queue.name, error));
    }
  }

  private logConnectionError(queue: string, error: Error): void {
    const now = Date.now();
    if (now - this.lastErrorLogAt < 30_000) return;
    this.lastErrorLogAt = now;
    this.logger.warn({
      msg: 'redis_connection_error',
      queue,
      errorName: error.name,
      errorCode: (error as { code?: string }).code ?? null,
    });
  }

  async enqueueProbe(
    workspaceId: string,
    recordingId: string,
    thenPreprocess: boolean,
  ): Promise<void> {
    const data = AudioProbeJob.parse({ workspaceId, recordingId, thenPreprocess });
    await this.addUnique(this.probe, 'probe', data, JobIds.probe(recordingId));
  }

  async enqueuePreprocess(workspaceId: string, preprocessingId: string): Promise<void> {
    const data = AudioPreprocessJob.parse({ workspaceId, preprocessingId });
    await this.addUnique(this.preprocess, 'preprocess', data, JobIds.preprocess(preprocessingId));
  }

  /**
   * An explicit start arrived while a probe job already exists: record the intent on it. A live job
   * (waiting, delayed, active) gets `thenPreprocess: true` (the orchestrator re-reads the data on
   * every poll). `finished` means the job completed or failed, `absent` that there is none.
   */
  async promoteProbe(recordingId: string): Promise<'updated' | 'finished' | 'absent'> {
    const job = await this.probe.getJob(JobIds.probe(recordingId));
    if (!job) return 'absent';
    const state = await job.getState();
    if (state === 'completed' || state === 'failed') return 'finished';
    if (state === 'unknown') return 'absent';
    if (!job.data.thenPreprocess) await job.updateData({ ...job.data, thenPreprocess: true });
    return 'updated';
  }

  /** Removes a job that has not started; an active job is left to its worker (cooperative cancel). */
  async removeWaitingPreprocess(preprocessingId: string): Promise<void> {
    const job = await this.preprocess.getJob(JobIds.preprocess(preprocessingId));
    if (!job) return;
    const state = await job.getState();
    if (state === 'waiting' || state === 'delayed' || state === 'prioritized') {
      await job.remove().catch(() => undefined); // lost the race to a worker: it re-checks the row
    }
  }

  private async addUnique<T extends object>(
    queue: Queue<T>,
    name: string,
    data: T,
    jobId: string,
  ): Promise<void> {
    const existing = await queue.getJob(jobId);
    if (existing) {
      const state = await existing.getState();
      if (state !== 'completed' && state !== 'failed') return;
      await existing.remove().catch(() => undefined);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await queue.add(name as any, data as any, { jobId });
  }

  /** Redis round trip through the queues (used by tests and health). */
  async ping(): Promise<void> {
    await Promise.all([
      this.probe.getJobCounts('waiting'),
      this.preprocess.getJobCounts('waiting'),
    ]);
  }

  async close(): Promise<void> {
    await Promise.allSettled([this.probe.close(), this.preprocess.close()]);
  }
}
