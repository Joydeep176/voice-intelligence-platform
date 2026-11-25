import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  AUDIO_SERVICE_CONTRACT_VERSION,
  buildPreprocessConfig,
  canonicalJson,
  decideRowAction,
  toolVersionsFromCapabilities,
  type AudioPreprocessConfig,
  type ProcessingSegmentList,
  type ProcessingSegmentsQuery,
  type ProcessingSnapshot,
} from '@vip/contracts';
import {
  getLatestPreprocessingForRecording,
  getPreprocessing,
  getMeasurements,
  listSegments,
  markCancelled,
  markRecordingValidating,
  requestCancel,
  resetForRetry,
  resetRecordingToUploaded,
  upsertPreprocessing,
  type AudioPreprocessing,
  type Recording,
} from '@vip/db';
import { createHash } from 'node:crypto';
import { AudioServiceClient } from '../audio-service/audio-service.client';
import { AppException } from '../common/app-exception';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { AudioQueues } from '../queue/audio-queues.producer';
import { RecordingsRepository } from '../recordings/recordings.repository';
import { toSegment, toSnapshot } from './processing.mapper';
import { ProcessingRepository } from './processing.repository';
import { gateRecording } from './start-decision';

export interface StartResult {
  snapshot: ProcessingSnapshot;
  /** `200` when the result already exists (nothing to run), otherwise `202`. */
  httpStatus: 200 | 202;
}

const unavailable = (detail: string) =>
  new AppException(503, 'DEPENDENCY_UNAVAILABLE', 'Audio processing unavailable', detail);

/**
 * Explicit audio processing control (Phase 2B WS7, ADR-0014/0025). Every method is workspace
 * scoped: a recording in another workspace is a 404. The API only writes the request (rows and
 * jobs); the orchestrator runs it. `pipeline_runs` are never touched (ADR-0025).
 */
@Injectable()
export class ProcessingService {
  private readonly logger = new Logger(ProcessingService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(RecordingsRepository) private readonly recordings: RecordingsRepository,
    @Inject(ProcessingRepository) private readonly repo: ProcessingRepository,
    @Inject(AudioServiceClient) private readonly audio: AudioServiceClient,
    @Inject(AudioQueues) private readonly queues: AudioQueues,
  ) {}

  async snapshot(workspaceId: string, recordingId: string): Promise<ProcessingSnapshot> {
    const recording = await this.requireRecording(workspaceId, recordingId);
    return this.snapshotOf(recording);
  }

  async segments(
    workspaceId: string,
    recordingId: string,
    query: ProcessingSegmentsQuery,
  ): Promise<ProcessingSegmentList> {
    await this.requireRecording(workspaceId, recordingId);
    const latest = await this.repo.latestSucceeded(workspaceId, recordingId);
    if (!latest) return { preprocessingId: null, items: [] };
    const rows = await listSegments(this.repo.db, workspaceId, latest.id, {
      ...(query.fromMs === undefined ? {} : { fromMs: query.fromMs }),
      ...(query.toMs === undefined ? {} : { toMs: query.toMs }),
      limit: query.limit,
    });
    return { preprocessingId: latest.id, items: rows.map(toSegment) };
  }

  async start(workspaceId: string, recordingId: string): Promise<StartResult> {
    const recording = await this.requireRecording(workspaceId, recordingId);
    const gate = gateRecording(recording.status);
    if (gate.kind === 'reject') {
      throw new AppException(
        409,
        'INVALID_STATE_TRANSITION',
        'Cannot start processing',
        gate.detail,
      );
    }
    if (gate.kind === 'validating') return this.continueValidating(workspaceId, recordingId);

    // Nothing is written unless the audio service can take the work (503, retryable).
    const toolVersions = await this.requireToolVersions();

    if (gate.kind === 'probe') {
      if (await markRecordingValidating(this.repo.db, workspaceId, recordingId)) {
        try {
          await this.queues.enqueueProbe(workspaceId, recordingId, true);
        } catch {
          await resetRecordingToUploaded(this.repo.db, workspaceId, recordingId);
          throw unavailable('The job queue is not reachable. Try again later.');
        }
        this.logger.log({ msg: 'processing_probe_requested', workspaceId, recordingId });
      } else {
        return this.continueValidating(workspaceId, recordingId); // another request got there first
      }
      return { snapshot: await this.snapshot(workspaceId, recordingId), httpStatus: 202 };
    }

    const config = buildPreprocessConfig(toolVersions);
    const configHash = createHash('sha256').update(canonicalJson(config)).digest('hex');
    const outcome = await this.recordings.transaction(async (tx) => {
      // The recording row lock serialises concurrent requests for one recording.
      const locked = await this.recordings.lockRecording(tx, workspaceId, recordingId);
      if (!locked) throw AppException.notFound('Recording');
      const { preprocessing } = await upsertPreprocessing(tx, {
        workspaceId,
        recordingId,
        configHash,
        config: config as unknown as Record<string, unknown>,
        toolVersions: config.toolVersions,
      });
      const decision = decideRowAction(preprocessing, this.config.processing.maxRetries);
      if (decision.kind === 'reject') {
        throw new AppException(
          409,
          'INVALID_STATE_TRANSITION',
          'Cannot start processing',
          decision.detail,
        );
      }
      let row: AudioPreprocessing = preprocessing;
      if (decision.kind === 'retry') {
        await resetForRetry(tx, workspaceId, preprocessing.id);
        row = (await getPreprocessing(tx, workspaceId, preprocessing.id)) ?? row; // this row, not the newest
      }
      return { row, enqueue: decision.kind !== 'return' };
    });

    if (outcome.enqueue) {
      try {
        await this.queues.enqueuePreprocess(workspaceId, outcome.row.id);
      } catch {
        // The row stays `queued`; the orchestrator's sweeper recovers a row without a job.
        throw unavailable('The job queue is not reachable. Try again later.');
      }
      this.logger.log({
        msg: 'processing_requested',
        workspaceId,
        recordingId,
        preprocessingId: outcome.row.id,
      });
    }
    return {
      snapshot: await this.snapshot(workspaceId, recordingId),
      httpStatus: outcome.enqueue ? 202 : 200,
    };
  }

  /**
   * The recording is already validating: make sure the explicit start is not lost. A probe job that
   * will not continue into preprocessing is updated to do so; if the job already finished, the
   * request is handled against the recording's current state; with no job at all one is queued.
   */
  private async continueValidating(workspaceId: string, recordingId: string): Promise<StartResult> {
    let promoted: Awaited<ReturnType<AudioQueues['promoteProbe']>>;
    try {
      promoted = await this.queues.promoteProbe(recordingId);
    } catch {
      throw unavailable('The job queue is not reachable. Try again later.');
    }
    if (promoted === 'updated') {
      this.logger.log({ msg: 'processing_probe_promoted', workspaceId, recordingId });
      return { snapshot: await this.snapshot(workspaceId, recordingId), httpStatus: 202 };
    }
    const current = await this.requireRecording(workspaceId, recordingId);
    if (current.status !== 'validating') return this.start(workspaceId, recordingId);
    try {
      await this.queues.enqueueProbe(workspaceId, recordingId, true);
    } catch {
      throw unavailable('The job queue is not reachable. Try again later.');
    }
    this.logger.log({ msg: 'processing_probe_requested', workspaceId, recordingId });
    return { snapshot: await this.snapshotOf(current), httpStatus: 202 };
  }

  async cancel(workspaceId: string, recordingId: string): Promise<ProcessingSnapshot> {
    await this.requireRecording(workspaceId, recordingId);
    const row = await getLatestPreprocessingForRecording(this.repo.db, workspaceId, recordingId);
    if (!row || (row.status !== 'queued' && row.status !== 'running')) {
      throw new AppException(
        409,
        'INVALID_STATE_TRANSITION',
        'Nothing to cancel',
        'There is no queued or running processing for this recording.',
      );
    }
    if (row.status === 'queued') {
      // A queued version has not started: it is cancelled now and its waiting job removed. A
      // worker that raced us finds the row no longer queued and does no work.
      if (await markCancelled(this.repo.db, workspaceId, row.id)) {
        await this.queues.removeWaitingPreprocess(row.id).catch(() => undefined);
      } else {
        await requestCancel(this.repo.db, workspaceId, row.id); // it started in the meantime
      }
    } else {
      await requestCancel(this.repo.db, workspaceId, row.id);
    }
    this.logger.log({
      msg: 'processing_cancel_requested',
      workspaceId,
      recordingId,
      preprocessingId: row.id,
    });
    return this.snapshot(workspaceId, recordingId);
  }

  private async requireRecording(workspaceId: string, id: string): Promise<Recording> {
    const recording = await this.recordings.findRecording(workspaceId, id);
    if (!recording) throw AppException.notFound('Recording');
    return recording;
  }

  private async snapshotOf(recording: Recording): Promise<ProcessingSnapshot> {
    const row = await getLatestPreprocessingForRecording(
      this.repo.db,
      recording.workspaceId,
      recording.id,
    );
    let measurements: Awaited<ReturnType<typeof getMeasurements>> = [];
    let segmentCount: number | null = null;
    if (row?.status === 'succeeded') {
      measurements = await getMeasurements(this.repo.db, recording.workspaceId, row.id, {
        segmentId: null,
      });
      segmentCount = await this.repo.segmentCount(recording.workspaceId, row.id);
    }
    return toSnapshot(
      recording,
      row,
      measurements,
      segmentCount,
      this.config.processing.maxRetries,
    );
  }

  /** Tool versions of the live service, or a 503 when it is not configured, unreachable or unfit. */
  private async requireToolVersions(): Promise<AudioPreprocessConfig['toolVersions']> {
    let toolVersions: AudioPreprocessConfig['toolVersions'] | null;
    try {
      const capabilities = await this.audio.capabilities();
      toolVersions =
        capabilities.contractVersion === AUDIO_SERVICE_CONTRACT_VERSION
          ? toolVersionsFromCapabilities(capabilities)
          : null;
    } catch (error) {
      this.logger.warn({
        msg: 'audio_service_unavailable',
        reason: (error as { reason?: string }).reason ?? 'UNKNOWN',
      });
      throw unavailable('The audio service is not configured or not reachable. Try again later.');
    }
    if (!toolVersions) {
      throw unavailable('The audio service cannot preprocess audio right now.');
    }
    return toolVersions;
  }
}
