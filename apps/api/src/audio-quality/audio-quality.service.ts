import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  AudioDiagnosticsSnapshot,
  AudioMeasurementRecord,
  AudioTier1Record,
  type AudioDiagnosticFlag,
} from '@vip/contracts';
import {
  findLatestSucceededPreprocessing,
  getLatestAudioQualityStage,
  getLatestDiagnostics,
  getLatestMeasurementSet,
  getMeasurements,
  getRun,
  getSetMeasurement,
  listDiagnosticFlags,
  toAudioQualitySummary,
  type Database,
  type PipelineRun,
} from '@vip/db';
import { AppException } from '../common/app-exception';
import { DB } from '../database/database.module';
import { RunQueues } from '../queue/run-queues.producer';
import { RUN_SETTINGS, type RunSettings } from '../queue/run-settings';
import { RunAudit } from '../runs/run-audit';

const conflict = (detail: string) =>
  new AppException(409, 'INVALID_STATE_TRANSITION', 'Cannot assess audio quality', detail);

/**
 * A1 Audio Quality read API and A1-only retry (API §4, ADR-0044 lifecycle L1-L6). Workspace
 * scoped: another workspace's run is a 404. Diagnostics are A1's output; the objective records it
 * rests on are returned with it (FR-3.1). Never mixed with transcription uncertainty (FR-3.3).
 */
@Injectable()
export class AudioQualityService {
  private readonly logger = new Logger(AudioQualityService.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(RunQueues) private readonly queues: RunQueues,
    @Inject(RunAudit) private readonly audit: RunAudit,
    @Inject(RUN_SETTINGS) private readonly settings: RunSettings,
  ) {}

  /** Lifecycle L1: the run's version once submitted, else the latest succeeded one. */
  private async pinned(run: PipelineRun): Promise<string | null> {
    if (run.preprocessingId) return run.preprocessingId;
    return (
      (await findLatestSucceededPreprocessing(this.db, run.workspaceId, run.recordingId))?.id ??
      null
    );
  }

  async get(
    workspaceId: string,
    runId: string,
    range: { fromMs?: number; toMs?: number } = {},
  ): Promise<AudioDiagnosticsSnapshot> {
    const run = await getRun(this.db, workspaceId, runId);
    if (!run) throw AppException.notFound('Run');
    const preprocessingId = await this.pinned(run);
    const stage = await getLatestAudioQualityStage(this.db, workspaceId, runId);
    const row = preprocessingId
      ? await getLatestDiagnostics(this.db, workspaceId, runId, preprocessingId)
      : null;
    const set = preprocessingId
      ? await getLatestMeasurementSet(this.db, workspaceId, preprocessingId)
      : null;

    let state: AudioDiagnosticsSnapshot['state'];
    if (stage?.status === 'running') state = 'running';
    else if (row) state = 'completed';
    else if (stage?.status === 'failed') state = 'failed';
    else if (
      stage?.status === 'cancelled' ||
      run.status === 'cancelled' ||
      run.status === 'cancelling'
    )
      state = 'cancelled';
    else if (preprocessingId && ['created', 'queued', 'running'].includes(run.status))
      state = 'pending';
    else state = 'not_started';

    let diagnostics: AudioDiagnosticsSnapshot['diagnostics'] = null;
    if (row) {
      const all = await listDiagnosticFlags(this.db, workspaceId, row.id);
      const ranged =
        range.fromMs === undefined && range.toMs === undefined
          ? all
          : await listDiagnosticFlags(this.db, workspaceId, row.id, range);
      const records = (
        await getMeasurements(this.db, workspaceId, row.preprocessingId, { segmentId: null })
      )
        .map((m) => AudioMeasurementRecord.safeParse(m.measurements))
        .flatMap((p) => (p.success ? [p.data] : []));
      diagnostics = {
        summary: toAudioQualitySummary(row, all),
        recommendations: row.recommendations as { code: string }[],
        flags: ranged.map((f): AudioDiagnosticFlag => ({
          id: f.id,
          kind: f.kind,
          severity: f.severity,
          startMs: f.startMs,
          endMs: f.endMs,
          basis: f.basis,
          ruleId: f.ruleId,
          measurementRefs: f.measurementRefs as AudioDiagnosticFlag['measurementRefs'],
        })),
        measurements: records,
        tier1Record: row.measurementSetId
          ? (AudioTier1Record.safeParse(
              (await getSetMeasurement(this.db, workspaceId, row.measurementSetId))?.measurements,
            ).data ?? null)
          : null,
      };
    }
    return AudioDiagnosticsSnapshot.parse({
      runId,
      state,
      stage: stage
        ? { attempt: stage.attempt, error: stage.error ? { code: stage.error.code } : null }
        : null,
      measurementSet: set
        ? { status: set.status, error: set.error ? { code: set.error.code } : null }
        : null,
      diagnostics,
    });
  }

  /** Lifecycle L6: A1-only (re-)assessment. Not a run retry; the run's retry count is unchanged. */
  async retry(
    workspaceId: string,
    runId: string,
    actorId: string,
  ): Promise<AudioDiagnosticsSnapshot> {
    const run = await getRun(this.db, workspaceId, runId);
    if (!run) throw AppException.notFound('Run');
    if (run.status === 'cancelling' || run.status === 'cancelled')
      throw conflict('The run has been cancelled.');
    const preprocessingId = await this.pinned(run);
    if (!preprocessingId) throw conflict('The recording has no successful preprocessing yet.');
    const stage = await getLatestAudioQualityStage(this.db, workspaceId, runId);
    if (stage?.status === 'running') throw conflict('An assessment is already running.');
    const current = await getLatestDiagnostics(this.db, workspaceId, runId, preprocessingId);
    if (current && stage?.status === 'completed')
      throw conflict('The run already has an assessment for its preprocessing version.');
    const attempt = (stage?.attempt ?? 0) + 1;
    if (attempt > this.settings.audioQuality.maxAttempts)
      throw conflict('The assessment attempt limit has been reached.');
    try {
      await this.queues.enqueueAudioQuality(workspaceId, runId, attempt);
    } catch {
      throw new AppException(
        503,
        'DEPENDENCY_UNAVAILABLE',
        'Queue unavailable',
        'The job queue is not reachable. Try again later.',
      );
    }
    await this.audit.record({
      workspaceId,
      actorId,
      action: 'audio_quality.requested',
      resourceType: 'run',
      resourceId: runId,
      metadata: { attempt, recordingId: run.recordingId },
    });
    this.logger.log({ msg: 'audio_quality_requested', workspaceId, runId, attempt });
    return this.get(workspaceId, runId);
  }
}
