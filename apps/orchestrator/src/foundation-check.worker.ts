import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { QueueName, type FoundationCheckResult } from '@vip/contracts';
import { type Job, Worker } from 'bullmq';
import { ORCHESTRATOR_CONFIG, type OrchestratorConfig, workerConnection } from './config';
import { processFoundationCheck } from './foundation-check.processor';

export const FOUNDATION_PROCESSOR = Symbol('FOUNDATION_PROCESSOR');
export type FoundationProcessor = (
  data: unknown,
) => FoundationCheckResult | Promise<FoundationCheckResult>;

/**
 * Consumer for the `foundation-check` queue with bounded concurrency, lock and stalled-job
 * settings from config (ADR-0010). Attempts/backoff are set by the producer per job.
 * Logs carry job IDs and codes only (SEC-9).
 */
@Injectable()
export class FoundationCheckWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('FoundationCheckWorker');
  private worker?: Worker;

  constructor(
    @Inject(ORCHESTRATOR_CONFIG) private readonly config: OrchestratorConfig,
    @Inject(FOUNDATION_PROCESSOR) private readonly processor: FoundationProcessor,
  ) {}

  onApplicationBootstrap(): void {
    const { concurrency, stalledIntervalMs, maxStalledCount, lockDurationMs } =
      this.config.foundation;
    this.worker = new Worker(
      QueueName.FoundationCheck,
      async (job: Job) => this.processor(job.data),
      {
        connection: workerConnection(this.config.redisUrl),
        concurrency,
        stalledInterval: stalledIntervalMs,
        maxStalledCount,
        lockDuration: lockDurationMs,
      },
    );
    this.worker.on('completed', (job) =>
      this.logger.log({ msg: 'job_completed', queue: job.queueName, jobId: job.id }),
    );
    this.worker.on('failed', (job, error) =>
      this.logger.warn({
        msg: 'job_failed',
        queue: job?.queueName,
        jobId: job?.id,
        attemptsMade: job?.attemptsMade,
        errorName: error.name,
      }),
    );
    this.worker.on('error', (error) =>
      this.logger.error({ msg: 'worker_error', errorName: error.name }),
    );
    this.logger.log({ msg: 'worker_started', queue: QueueName.FoundationCheck, concurrency });
  }

  /** Graceful shutdown: let active jobs finish, but never wait longer than the configured bound. */
  async onApplicationShutdown(): Promise<void> {
    if (!this.worker) return;
    const worker = this.worker;
    let timer: NodeJS.Timeout | undefined;
    const timedOut = await Promise.race([
      worker.close().then(() => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), this.config.shutdownTimeoutMs);
      }),
    ]).finally(() => clearTimeout(timer));
    if (timedOut) {
      // Unfinished jobs are recovered as stalled by another worker (OPS-4).
      await worker.close(true);
      this.logger.warn({ msg: 'worker_forced_close' });
    }
    this.logger.log({ msg: 'worker_stopped' });
  }

  get bullWorker(): Worker | undefined {
    return this.worker;
  }
}

export const defaultFoundationProcessor: FoundationProcessor = (data) =>
  processFoundationCheck(data);
