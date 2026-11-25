import { AudioPreprocessJob, AudioProbeJob, JobIds, QueueName } from '@vip/contracts';
import { Queue } from 'bullmq';
import type { OrchestratorConfig } from '../config';
import { workerConnection } from '../config';
import type { ProcessingEnqueuer } from './types';

/**
 * The orchestrator's own handles on the audio queues: it enqueues the preprocess follow-up of a
 * probe, and the sweeper re-enqueues lost work. Same job IDs and dedupe rules as the API producer.
 */
export class ProcessingQueues implements ProcessingEnqueuer {
  readonly probe: Queue;
  readonly preprocess: Queue;
  readonly sweep: Queue;

  constructor(config: OrchestratorConfig) {
    const connection = workerConnection(config.redisUrl);
    const defaultJobOptions = {
      attempts: config.processing.attempts,
      backoff: { type: 'exponential' as const, delay: config.processing.backoffMs },
      removeOnComplete: { count: 100, age: 24 * 3600 },
      removeOnFail: { count: 1000 },
    };
    this.probe = new Queue(QueueName.AudioProbe, { connection, defaultJobOptions });
    this.preprocess = new Queue(QueueName.AudioPreprocess, { connection, defaultJobOptions });
    this.sweep = new Queue(QueueName.AudioSweep, {
      connection,
      defaultJobOptions: { removeOnComplete: { count: 10 }, removeOnFail: { count: 50 } },
    });
  }

  enqueueProbe(workspaceId: string, recordingId: string, thenPreprocess: boolean): Promise<void> {
    const data = AudioProbeJob.parse({ workspaceId, recordingId, thenPreprocess });
    return this.addUnique(this.probe, 'probe', data, JobIds.probe(recordingId));
  }

  enqueuePreprocess(workspaceId: string, preprocessingId: string): Promise<void> {
    const data = AudioPreprocessJob.parse({ workspaceId, preprocessingId });
    return this.addUnique(this.preprocess, 'preprocess', data, JobIds.preprocess(preprocessingId));
  }

  /** True while the job is waiting, active or delayed (not finished and not absent). */
  async isLive(queue: Queue, jobId: string): Promise<boolean> {
    const job = await queue.getJob(jobId);
    if (!job) return false;
    const state = await job.getState();
    return state !== 'completed' && state !== 'failed' && state !== 'unknown';
  }

  private async addUnique(queue: Queue, name: string, data: object, jobId: string): Promise<void> {
    if (await this.isLive(queue, jobId)) return;
    const stale = await queue.getJob(jobId);
    if (stale) await stale.remove().catch(() => undefined); // a finished job blocks the same ID
    await queue.add(name, data, { jobId });
  }

  async close(): Promise<void> {
    await Promise.allSettled([this.probe.close(), this.preprocess.close(), this.sweep.close()]);
  }
}
