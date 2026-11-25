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
import { UnrecoverableError, Worker, type Job, type WorkerOptions } from 'bullmq';
import { ORCHESTRATOR_CONFIG, type OrchestratorConfig, workerConnection } from '../config';
import { AudioClient, type AudioTasks } from '../processing/audio-client';
import { LocalRawStore, type RawStore } from '../providers/raw-store';
import {
  assertKnownProviders,
  resolveProviders,
  type ResolvedProviders,
} from '../providers/registry';
import { RunQueues } from './queues';
import { executeRun } from './run.step';
import { sweepRuns } from './sweeper';
import type { RunDeps } from './types';

/** Test hook: replaces the adapters resolved from `STT_PROVIDER` / `DIARIZATION_PROVIDER`. */
export const RUN_PROVIDERS_OVERRIDE = Symbol('RUN_PROVIDERS_OVERRIDE');

/**
 * Starts the transcription run worker (`run-transcription`, jobId = runId) and the repeatable
 * stuck-run sweeper. Needs no audio service: it reads preprocessing results from the database.
 * Adapters come from config keys; an unknown key throws here, so the application fails at startup.
 * Bounded concurrency and stall settings come from config (ADR-0010).
 */
@Injectable()
export class RunWorkers implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('RunWorkers');
  private workers: Worker[] = [];
  private queues?: RunQueues;
  private db?: DbHandle;

  constructor(
    @Inject(ORCHESTRATOR_CONFIG) private readonly config: OrchestratorConfig,
    @Optional()
    @Inject(RUN_PROVIDERS_OVERRIDE)
    private readonly providersOverride?: (store: RawStore) => ResolvedProviders,
  ) {}

  /**
   * The audio-service client for self-hosted providers. Selecting one without
   * AUDIO_SERVICE_TOKEN stops the run workers at startup (like an unknown provider key); with only
   * the fakes, no client is needed and a placeholder that fails every call is used.
   */
  private audioClient(r: OrchestratorConfig['runs']): AudioTasks {
    const { url, token, timeoutMs } = this.config.audioService;
    const selfHosted = r.sttProvider !== 'fake' || r.diarizationProvider !== 'fake';
    if (token === undefined) {
      if (selfHosted) {
        throw new Error(
          'AUDIO_SERVICE_TOKEN is required when STT_PROVIDER or DIARIZATION_PROVIDER is self-hosted.',
        );
      }
      return new AudioClient({ url, token: '', timeoutMs });
    }
    return new AudioClient({ url, token, timeoutMs });
  }

  async onApplicationBootstrap(): Promise<void> {
    const r = this.config.runs;
    const store = new LocalRawStore(r.storageRoot);
    const keys = { sttProvider: r.sttProvider, diarizationProvider: r.diarizationProvider };
    // Unknown keys first: the audio-client check below treats any non-`fake` key as self-hosted.
    if (!this.providersOverride) assertKnownProviders(keys);
    const providers = this.providersOverride
      ? this.providersOverride(store)
      : resolveProviders(keys, store, {
          audio: { audio: this.audioClient(r), pollMs: r.providerPollMs },
          diarization: r.diarization,
          vad: r.vad,
        });
    this.db = createDb(this.config.database.url, { maxConnections: this.config.database.poolMax });
    this.queues = new RunQueues(this.config);
    const deps: RunDeps = {
      db: this.db.db,
      config: r,
      store,
      stt: providers.stt,
      diarization: providers.diarization,
      now: () => Date.now(),
      log: (event) => this.logger.log(event),
    };
    const options: WorkerOptions = {
      connection: workerConnection(this.config.redisUrl),
      concurrency: r.concurrency,
      stalledInterval: r.stalledIntervalMs,
      maxStalledCount: r.maxStalledCount,
      lockDuration: r.lockDurationMs,
    };
    this.workers = [
      this.start(QueueName.RunTranscription, options, async (job) => {
        try {
          await executeRun(deps, job.data, {
            attemptsMade: job.attemptsMade,
            attempts: job.opts.attempts ?? 1,
          });
        } catch (error) {
          if (error instanceof Error && error.name === 'ZodError') {
            throw new UnrecoverableError('INVALID_PAYLOAD'); // IDs only: a malformed payload never succeeds
          }
          throw error;
        }
      }),
      this.start(
        QueueName.RunSweep,
        { ...options, concurrency: 1 },
        async () => void (await sweepRuns(deps, this.queues!)),
      ),
    ];
    try {
      await this.queues.sweep.upsertJobScheduler(
        'run-sweep',
        { every: r.sweepIntervalMs },
        { name: 'sweep', data: {} },
      );
    } catch {
      this.logger.warn({ msg: 'run_sweeper_schedule_failed' });
    }
  }

  private start(
    queue: string,
    options: WorkerOptions,
    processor: (job: Job) => Promise<unknown>,
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

  /** Graceful shutdown: jobs stay in Redis and resume on the next start (raw outputs are reused). */
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
  }

  get running(): boolean {
    return this.workers.length > 0;
  }
}
