import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { JobIds, QueueName, RunAudioQualityJob } from '@vip/contracts';
import {
  beginStage,
  createDb,
  findLatestSucceededPreprocessing,
  finishStage,
  getLatestAudioQualityStage,
  getPreprocessing,
  getRun,
  listRunsAwaitingAudioQuality,
  listRunsWithStaleAudioQuality,
  listStuckAudioQualityStages,
  listStuckMeasurementSets,
  markSetFailed,
  type Database,
  type DbHandle,
} from '@vip/db';
import { Queue, UnrecoverableError, Worker, type Job } from 'bullmq';
import {
  ORCHESTRATOR_CONFIG,
  type AudioQualityConfig,
  type OrchestratorConfig,
  workerConnection,
} from '../../config';
import { AudioClient } from '../../processing/audio-client';
import { ensureMeasurementSet, type MeasureDeps } from '../../processing/measure';
import { A1InputError } from './inputs';
import { A1Cancelled, runAudioQuality } from './node';
import { A1_RULE_CONFIG, type A1RuleConfig } from './rule-config';

const NODE = 'audio_quality' as const;

/** The A1 queue handle: one job per (run, attempt); jobs carry IDs only. */
export class AudioQualityQueue {
  readonly queue: Queue;

  constructor(redisUrl: string, cfg: AudioQualityConfig) {
    this.queue = new Queue(QueueName.RunAudioQuality, {
      connection: workerConnection(redisUrl),
      defaultJobOptions: {
        attempts: cfg.attempts,
        backoff: { type: 'exponential' as const, delay: cfg.backoffMs },
        removeOnComplete: { count: 200, age: 24 * 3600 },
        removeOnFail: { count: 1000 },
      },
    });
  }

  async isLive(jobId: string): Promise<boolean> {
    const job = await this.queue.getJob(jobId);
    if (!job) return false;
    const state = await job.getState();
    return state !== 'completed' && state !== 'failed' && state !== 'unknown';
  }

  async enqueue(workspaceId: string, runId: string, attempt: number): Promise<void> {
    const data = RunAudioQualityJob.parse({ workspaceId, runId, attempt });
    const jobId = JobIds.audioQuality(runId, attempt);
    if (await this.isLive(jobId)) return;
    const stale = await this.queue.getJob(jobId);
    if (stale) await stale.remove().catch(() => undefined);
    await this.queue.add('assess', data, { jobId });
  }

  close(): Promise<void> {
    return this.queue.close();
  }
}

export interface AudioQualityDeps {
  db: Database;
  storageRoot: string;
  cfg: AudioQualityConfig;
  rules: A1RuleConfig;
  log: (event: Record<string, unknown>) => void;
  /**
   * Tier 1 (ADR-0045): the preprocessing-side measurement coordinator, run before the A1 node so
   * the node only reads. Absent when Tier 1 is off or no audio-service token is configured.
   */
  measure?: MeasureDeps;
}

const cancelledStatus = (status: string | undefined) =>
  status === undefined || status === 'cancelling' || status === 'cancelled';

/** Candidate preprocessing version of a run (lifecycle L1). */
async function pinnedPreprocessing(
  db: Database,
  run: { workspaceId: string; recordingId: string; preprocessingId: string | null },
): Promise<string | null> {
  if (run.preprocessingId) return run.preprocessingId;
  return (await findLatestSucceededPreprocessing(db, run.workspaceId, run.recordingId))?.id ?? null;
}

/**
 * Executes one A1 attempt. Never touches the transcription job; an A1 failure is recorded on its
 * own stage and leaves the run status and transcription unaffected (ADR-0021, lifecycle L4).
 */
export async function processAssessment(
  deps: AudioQualityDeps,
  data: unknown,
  job: { attemptsMade: number; attempts: number },
): Promise<void> {
  const { workspaceId, runId, attempt } = RunAudioQualityJob.parse(data);
  const run = await getRun(deps.db, workspaceId, runId);
  if (!run) return;
  if (cancelledStatus(run.status)) {
    await finishStage(deps.db, workspaceId, runId, NODE, attempt, 'cancelled');
    return;
  }
  const preprocessingId = await pinnedPreprocessing(deps.db, run);
  if (!preprocessingId) return; // the sweep re-enqueues once a version has succeeded
  // A redelivered job never rewrites a finished attempt (L5: a completed stage is kept).
  const latest = await getLatestAudioQualityStage(deps.db, workspaceId, runId);
  if (latest && latest.attempt === attempt && latest.status !== 'running') return;
  await beginStage(deps.db, workspaceId, runId, NODE, attempt);
  try {
    if (deps.measure) {
      const pre = await getPreprocessing(deps.db, workspaceId, preprocessingId);
      // Retryable measure failures retry with this job; on its last attempt a failed set is
      // recorded and A1 continues on Tier 0 (lifecycle: measure failure never fails A1).
      if (pre?.status === 'succeeded')
        await ensureMeasurementSet(deps.measure, pre, job.attemptsMade + 1 < job.attempts);
    }
    const out = await runAudioQuality(
      { workspaceId, runId, preprocessingId, measurementSetId: null },
      attempt,
      {
        db: deps.db,
        storageRoot: deps.storageRoot,
        rules: deps.rules,
        tier1Enabled: deps.measure !== undefined,
        isCancelled: async () =>
          cancelledStatus((await getRun(deps.db, workspaceId, runId))?.status),
      },
    );
    await finishStage(deps.db, workspaceId, runId, NODE, attempt, 'completed');
    deps.log({ msg: 'a1_completed', runId, attempt, diagnosticsId: out.diagnosticsId });
  } catch (error) {
    if (error instanceof A1Cancelled) {
      await finishStage(deps.db, workspaceId, runId, NODE, attempt, 'cancelled');
      return;
    }
    if (error instanceof A1InputError) {
      await finishStage(deps.db, workspaceId, runId, NODE, attempt, 'failed', { code: error.code });
      deps.log({ msg: 'a1_failed', runId, attempt, code: error.code });
      return;
    }
    if (job.attemptsMade + 1 >= job.attempts) {
      await finishStage(deps.db, workspaceId, runId, NODE, attempt, 'failed', {
        code: 'A1_INTERNAL',
      });
      deps.log({ msg: 'a1_failed', runId, attempt, code: 'A1_INTERNAL' });
    }
    throw error;
  }
}

/** Finds runs to assess (L2), re-assessments after submission (L3) and lost jobs. */
export async function sweepAudioQuality(
  deps: AudioQualityDeps,
  queue: Pick<AudioQualityQueue, 'enqueue' | 'isLive'>,
  now = Date.now(),
): Promise<{ enqueued: number }> {
  let enqueued = 0;
  const { db, cfg } = deps;
  for (const r of await listRunsAwaitingAudioQuality(db, cfg.sweepBatch)) {
    const preprocessingId = await pinnedPreprocessing(db, r);
    if (!preprocessingId) continue;
    // With Tier 1 the A1 job itself ensures the measurement set before assessing (L2).
    await queue.enqueue(r.workspaceId, r.id, 1);
    enqueued += 1;
  }
  for (const r of await listRunsWithStaleAudioQuality(db, cfg.sweepBatch, cfg.maxAttempts)) {
    await queue.enqueue(r.workspaceId, r.id, r.maxAttempt + 1);
    enqueued += 1;
  }
  for (const s of await listStuckAudioQualityStages(
    db,
    new Date(now - cfg.stuckAfterMs),
    cfg.sweepBatch,
  )) {
    if (await queue.isLive(JobIds.audioQuality(s.runId, s.attempt))) continue;
    // A stage whose job was lost (crash, stall) is failed, not re-enqueued: re-enqueuing the same
    // attempt would refresh it forever. A new attempt is bounded by AUDIO_QUALITY_MAX_ATTEMPTS.
    await finishStage(db, s.workspaceId, s.runId, NODE, s.attempt, 'failed', {
      code: 'A1_STALLED',
    });
  }
  for (const set of await listStuckMeasurementSets(
    db,
    new Date(now - cfg.stuckAfterMs),
    cfg.sweepBatch,
  )) {
    // A measurement set left running by a lost job: retryable failure (the next A1 attempt resets it
    // while its attempt count is below the cap).
    await markSetFailed(db, set.workspaceId, set.id, { code: 'MEASURE_STALLED', retryable: true });
  }
  return { enqueued };
}

/**
 * Starts the A1 worker (`run-audio-quality`) and its repeatable trigger sweep. Separate from the
 * transcription worker: it never blocks, changes or waits on transcription (ADR-0021 / ADR-0046).
 */
@Injectable()
export class AudioQualityWorkers implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('AudioQualityWorkers');
  private worker?: Worker;
  private queue?: AudioQualityQueue;
  private db?: DbHandle;

  constructor(@Inject(ORCHESTRATOR_CONFIG) private readonly config: OrchestratorConfig) {}

  async onApplicationBootstrap(): Promise<void> {
    const cfg = this.config.audioQuality;
    this.db = createDb(this.config.database.url, { maxConnections: this.config.database.poolMax });
    this.queue = new AudioQualityQueue(this.config.redisUrl, cfg);
    const { url, token, timeoutMs } = this.config.audioService;
    const log = (event: Record<string, unknown>) => this.logger.log(event);
    if (cfg.tier1Enabled && token === undefined)
      this.logger.warn({
        msg: 'audio_quality_tier1_disabled',
        reason: 'AUDIO_SERVICE_TOKEN missing',
      });
    const deps: AudioQualityDeps = {
      db: this.db.db,
      storageRoot: this.config.runs.storageRoot,
      cfg,
      rules: A1_RULE_CONFIG,
      log,
      ...(cfg.tier1Enabled && token !== undefined
        ? {
            measure: {
              db: this.db.db,
              audio: {
                audio: new AudioClient({ url, token, timeoutMs }),
                pollMs: this.config.runs.providerPollMs,
              },
              storageRoot: this.config.runs.storageRoot,
              vad: this.config.runs.vad,
              maxAttempts: cfg.maxAttempts,
              // A quarter of the stuck-after: several missed beats before the sweep acts.
              heartbeatMs: Math.max(1, Math.floor(cfg.stuckAfterMs / 4)),
              log,
            },
          }
        : {}),
    };
    this.worker = new Worker(
      QueueName.RunAudioQuality,
      async (job: Job) => {
        if (job.name === 'sweep') return void (await sweepAudioQuality(deps, this.queue!));
        try {
          await processAssessment(deps, job.data, {
            attemptsMade: job.attemptsMade,
            attempts: job.opts.attempts ?? 1,
          });
        } catch (error) {
          if (error instanceof Error && error.name === 'ZodError')
            throw new UnrecoverableError('INVALID_PAYLOAD');
          throw error;
        }
      },
      {
        connection: workerConnection(this.config.redisUrl),
        concurrency: cfg.concurrency,
        stalledInterval: cfg.stalledIntervalMs,
        maxStalledCount: cfg.maxStalledCount,
        lockDuration: cfg.lockDurationMs,
      },
    );
    this.worker.on('failed', (job, error) =>
      this.logger.warn({
        msg: 'job_failed',
        queue: QueueName.RunAudioQuality,
        jobId: job?.id,
        error: error.name,
      }),
    );
    try {
      await this.queue.queue.upsertJobScheduler(
        'audio-quality-sweep',
        { every: cfg.sweepIntervalMs },
        { name: 'sweep', data: {}, opts: { attempts: 1 } },
      );
    } catch {
      this.logger.warn({ msg: 'audio_quality_sweep_schedule_failed' });
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
    await this.db?.close();
  }
}
