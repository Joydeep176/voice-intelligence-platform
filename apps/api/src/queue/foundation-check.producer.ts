import {
  FoundationCheckJob,
  FoundationCheckResult,
  QueueName,
  type FoundationCheckResult as Result,
} from '@vip/contracts';
import { Logger } from '@nestjs/common';
import { Queue, QueueEvents } from 'bullmq';
import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../config/app-config';
import { redisConnection } from './redis-connection';

/**
 * Producer for the Phase 1 foundation check queue. It demonstrates the queue boundary
 * (API produces → orchestrator consumes, ADR-0002) and DOES NOT process audio.
 * Jobs carry IDs only; attempts/backoff/retention are bounded by config (ADR-0010).
 */
export class FoundationCheckProducer {
  readonly queue: Queue<FoundationCheckJob, Result>;
  private events?: QueueEvents;
  private readonly logger = new Logger('Queue');
  private lastErrorLogAt = 0;

  constructor(private readonly config: AppConfig) {
    const { attempts, backoffMs } = config.queues.foundation;
    this.queue = new Queue(QueueName.FoundationCheck, {
      connection: redisConnection(config.redis.url),
      defaultJobOptions: {
        attempts,
        backoff: { type: 'exponential', delay: backoffMs },
        removeOnComplete: { count: 100, age: 24 * 3600 },
        removeOnFail: { count: 1000 },
      },
    });
    this.queue.on('error', (error) => this.logConnectionError(error));
  }

  /** Structured, throttled and content-free: no hosts, ports or credentials (SEC-9). */
  private logConnectionError(error: Error): void {
    const now = Date.now();
    if (now - this.lastErrorLogAt < 30_000) return;
    this.lastErrorLogAt = now;
    this.logger.warn({
      msg: 'redis_connection_error',
      queue: QueueName.FoundationCheck,
      errorName: error.name,
      errorCode: (error as { code?: string }).code ?? null,
    });
  }

  async enqueue(): Promise<{ jobId: string; checkId: string }> {
    const payload = FoundationCheckJob.parse({
      checkId: randomUUID(),
      requestedAt: new Date().toISOString(),
    });
    const job = await this.queue.add('check', payload, { jobId: payload.checkId });
    return { jobId: job.id ?? payload.checkId, checkId: payload.checkId };
  }

  /** Waits for a job to finish and validates its result against the contract. */
  async waitForResult(jobId: string, timeoutMs: number): Promise<Result> {
    this.events ??= new QueueEvents(QueueName.FoundationCheck, {
      connection: { ...redisConnection(this.config.redis.url), maxRetriesPerRequest: null },
    });
    this.events.on('error', (error) => this.logConnectionError(error));
    await this.events.waitUntilReady();
    const job = await this.queue.getJob(jobId);
    if (!job) throw new Error('Job not found');
    return FoundationCheckResult.parse(await job.waitUntilFinished(this.events, timeoutMs));
  }

  /** Redis round trip through the queue itself (used by health checks). */
  async ping(): Promise<void> {
    await this.queue.getJobCounts('waiting');
  }

  async close(): Promise<void> {
    await Promise.allSettled([this.events?.close(), this.queue.close()]);
  }
}
