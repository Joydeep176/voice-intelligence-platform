import { Inject, Injectable, Logger } from '@nestjs/common';
import { RUN_STAGES, type RunSnapshot, type StartRunBody } from '@vip/contracts';
import {
  findLatestRunByStatus,
  findLatestSucceededPreprocessing,
  getRun,
  getTranscriptForRun,
  insertCreatedRun,
  listStageRuns,
  requestRunCancel,
  resetRunForRetry,
  submitRun,
  type Database,
  type PipelineRun,
} from '@vip/db';
import { AppException } from '../common/app-exception';
import { DB } from '../database/database.module';
import { RunQueues } from '../queue/run-queues.producer';
import { RUN_SETTINGS, type RunSettings } from '../queue/run-settings';
import { RecordingsRepository } from '../recordings/recordings.repository';
import { RunAudit } from './run-audit';
import { toRunSnapshot } from './run.mapper';

const unavailable = () =>
  new AppException(
    503,
    'DEPENDENCY_UNAVAILABLE',
    'Run queue unavailable',
    'The job queue is not reachable. Try again later.',
  );

/**
 * Run control for transcription runs (API §3, ADR-0014/0025, D-2C-01). Every method is workspace
 * scoped: a run or recording in another workspace is a 404. The API only writes the request (rows,
 * audit event, job); the orchestrator executes it. Audit events carry IDs and counts only.
 */
@Injectable()
export class RunsService {
  private readonly logger = new Logger(RunsService.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(RecordingsRepository) private readonly recordings: RecordingsRepository,
    @Inject(RunQueues) private readonly queues: RunQueues,
    @Inject(RunAudit) private readonly audit: RunAudit,
    @Inject(RUN_SETTINGS) private readonly settings: RunSettings,
  ) {}

  async get(workspaceId: string, runId: string): Promise<RunSnapshot> {
    const run = await getRun(this.db, workspaceId, runId);
    if (!run) throw AppException.notFound('Run');
    return this.snapshotOf(run);
  }

  /**
   * Submits the recording's `created` run (else creates one). An already queued, running or
   * cancelling run is returned as is (idempotent); only the missing job is re-ensured.
   */
  async start(
    workspaceId: string,
    recordingId: string,
    actorId: string,
    body: StartRunBody,
  ): Promise<RunSnapshot> {
    const recording = await this.recordings.findRecording(workspaceId, recordingId);
    if (!recording) throw AppException.notFound('Recording');
    if (recording.status !== 'valid') {
      throw new AppException(
        409,
        'INVALID_STATE_TRANSITION',
        'Cannot start a run',
        'The recording must be valid before a run can start.',
      );
    }
    const preprocessing = await findLatestSucceededPreprocessing(this.db, workspaceId, recordingId);
    if (!preprocessing) {
      throw new AppException(
        409,
        'INVALID_STATE_TRANSITION',
        'Cannot start a run',
        'A succeeded audio preprocessing is required first.',
      );
    }

    const run = await this.db.transaction(async (tx) => {
      // The recording row lock serialises concurrent requests for one recording.
      const locked = await this.recordings.lockRecording(tx, workspaceId, recordingId);
      if (!locked) throw AppException.notFound('Recording');
      const active = await findLatestRunByStatus(tx, workspaceId, recordingId, [
        'queued',
        'running',
        'cancelling',
      ]);
      if (active) return active;
      const created =
        (await findLatestRunByStatus(tx, workspaceId, recordingId, ['created'])) ??
        (await insertCreatedRun(tx, workspaceId, recordingId));
      const submitted = await submitRun(tx, workspaceId, created.id, {
        preprocessingId: preprocessing.id,
        config: {
          schemaVersion: 1,
          stages: [...RUN_STAGES],
          ...(body.languageHints ? { languageHints: body.languageHints } : {}),
        },
      });
      if (!submitted) throw new Error('A created run could not be submitted.');
      await this.audit.record(
        {
          workspaceId,
          actorId,
          action: 'run.requested',
          resourceType: 'run',
          resourceId: created.id,
          metadata: { recordingId, preprocessingId: preprocessing.id },
        },
        tx,
      );
      return (await getRun(tx, workspaceId, created.id))!;
    });

    if (run.status === 'queued') await this.enqueue(workspaceId, run.id);
    this.logger.log({ msg: 'run_requested', workspaceId, recordingId, runId: run.id });
    return this.snapshotOf((await getRun(this.db, workspaceId, run.id)) ?? run);
  }

  async cancel(workspaceId: string, runId: string, actorId: string): Promise<RunSnapshot> {
    const run = await getRun(this.db, workspaceId, runId);
    if (!run) throw AppException.notFound('Run');
    const nothing = new AppException(
      409,
      'INVALID_STATE_TRANSITION',
      'Nothing to cancel',
      'The run is not created, queued or running.',
    );
    // `created` (ADR-0025): cancelled at once; it also stops a pending A1 stage (ADR-0044, L5).
    if (!['created', 'queued', 'running', 'cancelling'].includes(run.status)) throw nothing;
    const outcome = await requestRunCancel(this.db, workspaceId, runId);
    if (!outcome) throw nothing;
    if (outcome === 'cancelled') {
      // A queued run had not started: it is cancelled now and its waiting job removed. A worker
      // that raced us finds the run no longer queued and does no work.
      await this.queues.removeWaitingRun(runId).catch(() => undefined);
    }
    await this.audit.record({
      workspaceId,
      actorId,
      action: outcome === 'cancelled' ? 'run.cancelled' : 'run.cancel_requested',
      resourceType: 'run',
      resourceId: runId,
      metadata: { recordingId: run.recordingId },
    });
    this.logger.log({ msg: 'run_cancel_requested', workspaceId, runId, outcome });
    return this.get(workspaceId, runId);
  }

  async retry(workspaceId: string, runId: string, actorId: string): Promise<RunSnapshot> {
    const run = await getRun(this.db, workspaceId, runId);
    if (!run) throw AppException.notFound('Run');
    if (run.status !== 'failed' && run.status !== 'cancelled') {
      throw new AppException(
        409,
        'INVALID_STATE_TRANSITION',
        'Cannot retry',
        'Only a failed or cancelled run can be retried.',
      );
    }
    // A `created` run cancelled before submission has no preprocessing version: ADR-0025 keeps it
    // non-retryable (the ADR-0044 amendment allows only its cancellation). Start a new run instead.
    if (run.preprocessingId === null) {
      throw new AppException(
        409,
        'INVALID_STATE_TRANSITION',
        'Cannot retry',
        'This run was cancelled before it was started; start a new run instead.',
      );
    }
    if (!(await resetRunForRetry(this.db, workspaceId, runId, this.settings.maxRetries))) {
      throw new AppException(
        409,
        'INVALID_STATE_TRANSITION',
        'Cannot retry',
        run.retryCount >= this.settings.maxRetries
          ? 'The retry limit has been reached.'
          : 'The run changed state; check its status.',
      );
    }
    await this.audit.record({
      workspaceId,
      actorId,
      action: 'run.retried',
      resourceType: 'run',
      resourceId: runId,
      metadata: { retryCount: run.retryCount + 1, recordingId: run.recordingId },
    });
    await this.enqueue(workspaceId, runId);
    this.logger.log({ msg: 'run_retried', workspaceId, runId, retryCount: run.retryCount + 1 });
    return this.get(workspaceId, runId);
  }

  /** The row stays `queued` when the queue is down; the orchestrator's sweeper recovers it. */
  private async enqueue(workspaceId: string, runId: string): Promise<void> {
    try {
      await this.queues.enqueueRun(workspaceId, runId);
    } catch {
      throw unavailable();
    }
  }

  private async snapshotOf(run: PipelineRun): Promise<RunSnapshot> {
    const stages = await listStageRuns(this.db, run.workspaceId, run.id);
    const transcript = await getTranscriptForRun(this.db, run.workspaceId, run.id);
    return toRunSnapshot(run, stages, this.settings.maxRetries, transcript !== null);
  }
}
