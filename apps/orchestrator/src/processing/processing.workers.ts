import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { QueueName } from '@vip/contracts';
import { createDb, type DbHandle } from '@vip/db';
import {
  DelayedError,
  UnrecoverableError,
  Worker,
  type Job,
  type Queue,
  type WorkerOptions,
} from 'bullmq';
import { ORCHESTRATOR_CONFIG, type OrchestratorConfig, workerConnection } from '../config';
import { AudioClient, type AudioTasks } from './audio-client';
import { failExhaustedPreprocess, preprocessStep } from './preprocess.step';
import { failExhaustedProbe, probeStep } from './probe.step';
import { ProcessingQueues } from './queues';
import { sweep } from './sweeper';
import { TransientError, type ProcessingDeps, type StepOutcome } from './types';

/** Test hook: replaces the HTTP audio client. */
export const AUDIO_TASKS_OVERRIDE = Symbol('AUDIO_TASKS_OVERRIDE');

type Step = (deps: ProcessingDeps, payload: unknown) => Promise<StepOutcome>;
type Exhausted = (deps: ProcessingDeps, payload: unknown) => Promise<void>;

/**
 * Runs one step of a step job and applies its outcome (LLD §5). A step never blocks the worker:
 * to wait for the audio service the job is moved to the delayed set and the worker is freed.
 * A transient failure is retried by BullMQ (attempts and backoff from config); once the attempts
 * are spent the domain row is failed or reset by `onExhausted`, so nothing waits forever.
 */
export async function runStep(
  deps: ProcessingDeps,
  job: Pick<Job, 'data' | 'attemptsMade' | 'opts' | 'updateData' | 'moveToDelayed'>,
  token: string | undefined,
  step: Step,
  onExhausted: Exhausted,
  /** Re-reads the job data from Redis: the API may have set `thenPreprocess` while the step ran. */
  latestData?: () => Promise<object | undefined>,
): Promise<void> {
  let outcome: StepOutcome;
  try {
    outcome = await step(deps, job.data);
  } catch (error) {
    if (error instanceof Error && error.name === 'ZodError') {
      throw new UnrecoverableError('INVALID_PAYLOAD'); // IDs only: a malformed payload never succeeds
    }
    const attempts = job.opts.attempts ?? 1;
    if (job.attemptsMade + 1 >= attempts) {
      await onExhausted(deps, job.data);
      deps.log({
        msg: 'job_attempts_exhausted',
        errorName: error instanceof Error ? error.name : 'unknown',
        reason: error instanceof TransientError ? error.reason : null,
      });
      return;
    }
    throw error;
  }
  if (outcome.kind === 'delay') {
    if (outcome.data) {
      const mine = job.data as { thenPreprocess?: boolean };
      const base = ((await latestData?.().catch(() => undefined)) ?? mine) as {
        thenPreprocess?: boolean;
      };
      const merged: Record<string, unknown> = { ...base, ...outcome.data };
      // An explicit start recorded on the live job is never lost to a stale in-memory copy.
      if (base.thenPreprocess === true || mine.thenPreprocess === true) {
        merged.thenPreprocess = true;
      }
      await job.updateData(merged);
    }
    await job.moveToDelayed(deps.now() + outcome.delayMs, token);
    throw new DelayedError();
  }
}

async function latestJobData(queue: Queue, job: Job): Promise<object | undefined> {
  if (!job.id) return undefined;
  return (await queue.getJob(job.id))?.data as object | undefined;
}

/**
 * Starts the audio processing workers (`audio-probe`, `audio-preprocess`) and the repeatable
 * stuck-job sweeper. Without `AUDIO_SERVICE_TOKEN` none of them start and a structured warning
 * names the variable only. Bounded concurrency and stall settings come from config (ADR-0010).
 */
@Injectable()
export class ProcessingWorkers implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('ProcessingWorkers');
  private workers: Worker[] = [];
  private queues?: ProcessingQueues;
  private db?: DbHandle;
  private deps?: ProcessingDeps;

  constructor(
    @Inject(ORCHESTRATOR_CONFIG) private readonly config: OrchestratorConfig,
    @Optional() @Inject(AUDIO_TASKS_OVERRIDE) private readonly audioOverride?: AudioTasks,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const { token, url, timeoutMs } = this.config.audioService;
    if (token === undefined && !this.audioOverride) {
      this.logger.warn({
        msg: 'processing_workers_disabled',
        missingVariable: 'AUDIO_SERVICE_TOKEN',
      });
      return;
    }
    const p = this.config.processing;
    this.db = createDb(this.config.database.url, { maxConnections: this.config.database.poolMax });
    this.queues = new ProcessingQueues(this.config);
    this.deps = {
      db: this.db.db,
      audio: this.audioOverride ?? new AudioClient({ url, token: token as string, timeoutMs }),
      config: p,
      enqueuer: this.queues,
      now: () => Date.now(),
      log: (event) => this.logger.log(event),
    };
    const deps = this.deps;
    const options: WorkerOptions = {
      connection: workerConnection(this.config.redisUrl),
      concurrency: p.concurrency,
      stalledInterval: p.stalledIntervalMs,
      maxStalledCount: p.maxStalledCount,
      lockDuration: p.lockDurationMs,
    };
    this.workers = [
      this.start(QueueName.AudioProbe, options, (job, token_) =>
        runStep(deps, job, token_, probeStep, failExhaustedProbe, () =>
          latestJobData(this.queues!.probe, job),
        ),
      ),
      this.start(QueueName.AudioPreprocess, options, (job, token_) =>
        runStep(deps, job, token_, preprocessStep, failExhaustedPreprocess, () =>
          latestJobData(this.queues!.preprocess, job),
        ),
      ),
      this.start(
        QueueName.AudioSweep,
        { ...options, concurrency: 1 },
        async () => void (await sweep(deps, this.queues!)),
      ),
    ];
    try {
      await this.queues.sweep.upsertJobScheduler(
        'audio-sweep',
        { every: p.sweepIntervalMs },
        { name: 'sweep', data: {} },
      );
    } catch {
      this.logger.warn({ msg: 'sweeper_schedule_failed' });
    }
  }

  private start(
    queue: string,
    options: WorkerOptions,
    processor: (job: Job, token?: string) => Promise<unknown>,
  ): Worker {
    const worker = new Worker(queue, processor, options);
    worker.on('completed', (job) =>
      this.logger.log({ msg: 'job_completed', queue, jobId: job.id }),
    );
    worker.on('failed', (job, error) =>
      this.logger.warn({
        msg: 'job_failed',
        queue,
        jobId: job?.id,
        attemptsMade: job?.attemptsMade,
        errorName: error.name,
      }),
    );
    worker.on('error', (error) =>
      this.logger.error({ msg: 'worker_error', queue, errorName: error.name }),
    );
    this.logger.log({ msg: 'worker_started', queue, concurrency: options.concurrency ?? 1 });
    return worker;
  }

  /** Graceful shutdown: jobs stay in Redis, the delayed ones are picked up by the next start. */
  async onApplicationShutdown(): Promise<void> {
    const timeoutMs = this.config.shutdownTimeoutMs;
    for (const worker of this.workers) {
      let timer: NodeJS.Timeout | undefined;
      const timedOut = await Promise.race([
        worker.close().then(() => false),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(true), timeoutMs);
        }),
      ]).finally(() => clearTimeout(timer));
      if (timedOut) {
        await worker.close(true);
        this.logger.warn({ msg: 'worker_forced_close', queue: worker.name });
      }
    }
    this.workers = [];
    await this.queues?.close();
    await this.db?.close();
    if (this.deps) this.logger.log({ msg: 'processing_workers_stopped' });
  }

  get running(): boolean {
    return this.workers.length > 0;
  }
}
