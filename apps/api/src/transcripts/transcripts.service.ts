import { Inject, Injectable } from '@nestjs/common';
import type {
  RawOutputList,
  SpeakerDto,
  SpeakerList,
  SpeakerPatch,
  TranscriptPage,
  TranscriptQuery,
  TranscriptVersionList,
  UncertaintyList,
} from '@vip/contracts';
import {
  getRun,
  getTranscriptForRun,
  getTranscriptVersion,
  listDiarizationRawOutputs,
  listSpeakers,
  listSttRawOutputs,
  listTranscriptSegments,
  listTranscriptVersions,
  listUncertainties,
  renameSpeaker,
  type Database,
  type PipelineRun,
  type Transcript,
  type TranscriptVersion,
} from '@vip/db';
import { AppException } from '../common/app-exception';
import { DB } from '../database/database.module';
import { RunAudit } from '../runs/run-audit';
import {
  decodeCursor,
  encodeCursor,
  runContext,
  toDiarizationRawDto,
  toSegmentDto,
  toSpeakerDto,
  toSttRawDto,
  toUncertaintyDto,
  toVersionDto,
} from './transcript.mapper';

type TimeQuery = Pick<TranscriptQuery, 'version' | 'fromMs' | 'toMs' | 'cursor' | 'limit'>;

/**
 * Transcript reads and speaker rename (API §5). Every query is workspace scoped: a run in
 * another workspace is a 404. Correction versions and derivations are not implemented.
 */
@Injectable()
export class TranscriptsService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(RunAudit) private readonly audit: RunAudit,
  ) {}

  private async requireRun(workspaceId: string, runId: string): Promise<PipelineRun> {
    const run = await getRun(this.db, workspaceId, runId);
    if (!run) throw AppException.notFound('Run');
    return run;
  }

  /** The run's transcript and the requested (default latest) version, else 404. */
  private async requireVersion(
    workspaceId: string,
    runId: string,
    version: number | undefined,
  ): Promise<{ run: PipelineRun; transcript: Transcript; version: TranscriptVersion }> {
    const run = await this.requireRun(workspaceId, runId);
    const transcript = await getTranscriptForRun(this.db, workspaceId, runId);
    if (!transcript) throw AppException.notFound('Transcript');
    const row = await getTranscriptVersion(this.db, workspaceId, transcript.id, version);
    if (!row) throw AppException.notFound('Transcript version');
    return { run, transcript, version: row };
  }

  private cursorOf(query: TimeQuery): { startMs: number; id: string } | undefined {
    if (query.cursor === undefined) return undefined;
    const after = decodeCursor(query.cursor);
    if (!after) {
      throw new AppException(422, 'VALIDATION_FAILED', 'Validation failed', undefined, [
        { path: 'cursor', message: 'Invalid cursor' },
      ]);
    }
    return after;
  }

  async versions(workspaceId: string, runId: string): Promise<TranscriptVersionList> {
    await this.requireRun(workspaceId, runId);
    const transcript = await getTranscriptForRun(this.db, workspaceId, runId);
    if (!transcript) return { items: [] };
    const rows = await listTranscriptVersions(this.db, workspaceId, transcript.id);
    return { items: rows.map(toVersionDto) };
  }

  async segments(
    workspaceId: string,
    runId: string,
    query: TranscriptQuery,
  ): Promise<TranscriptPage> {
    const { run, transcript, version } = await this.requireVersion(
      workspaceId,
      runId,
      query.version,
    );
    const after = this.cursorOf(query);
    const rows = await listTranscriptSegments(this.db, workspaceId, version.id, {
      limit: query.limit + 1,
      ...(query.fromMs === undefined ? {} : { fromMs: query.fromMs }),
      ...(query.toMs === undefined ? {} : { toMs: query.toMs }),
      ...(after ? { after } : {}),
    });
    const page = rows.slice(0, query.limit);
    return {
      runId,
      transcriptId: transcript.id,
      version: version.version,
      kind: version.kind,
      ...runContext(run.config),
      items: page.map(toSegmentDto),
      nextCursor: rows.length > query.limit ? encodeCursor(page[page.length - 1]!) : null,
    };
  }

  async uncertainties(
    workspaceId: string,
    runId: string,
    query: TranscriptQuery,
  ): Promise<UncertaintyList> {
    const { version } = await this.requireVersion(workspaceId, runId, query.version);
    const after = this.cursorOf(query);
    const rows = await listUncertainties(this.db, workspaceId, version.id, {
      limit: query.limit + 1,
      ...(query.fromMs === undefined ? {} : { fromMs: query.fromMs }),
      ...(query.toMs === undefined ? {} : { toMs: query.toMs }),
      ...(after ? { after } : {}),
    });
    const page = rows.slice(0, query.limit);
    return {
      version: version.version,
      items: page.map(toUncertaintyDto),
      nextCursor: rows.length > query.limit ? encodeCursor(page[page.length - 1]!) : null,
    };
  }

  /** Raw provider output references: metadata only (no storage URI, no content, no signed URL). */
  async raw(workspaceId: string, runId: string): Promise<RawOutputList> {
    await this.requireRun(workspaceId, runId);
    const [stt, diarization] = await Promise.all([
      listSttRawOutputs(this.db, workspaceId, runId),
      listDiarizationRawOutputs(this.db, workspaceId, runId),
    ]);
    return { items: [...stt.map(toSttRawDto), ...diarization.map(toDiarizationRawDto)] };
  }

  async speakers(workspaceId: string, runId: string): Promise<SpeakerList> {
    await this.requireRun(workspaceId, runId);
    const transcript = await getTranscriptForRun(this.db, workspaceId, runId);
    if (!transcript) return { items: [] };
    const rows = await listSpeakers(this.db, workspaceId, transcript.id);
    return { items: rows.map(toSpeakerDto) };
  }

  /** Updates `display_name` only (`speakerKey` is immutable) and audits it in the same transaction. */
  async renameSpeaker(
    workspaceId: string,
    runId: string,
    speakerId: string,
    actorId: string,
    body: SpeakerPatch,
  ): Promise<SpeakerDto> {
    await this.requireRun(workspaceId, runId);
    const row = await this.db.transaction(async (tx) => {
      const updated = await renameSpeaker(tx, workspaceId, runId, speakerId, body.displayName);
      if (!updated) return null;
      await this.audit.record(
        {
          workspaceId,
          actorId,
          action: 'speaker.renamed',
          resourceType: 'speaker',
          resourceId: speakerId,
          metadata: { runId },
        },
        tx,
      );
      return updated;
    });
    if (!row) throw AppException.notFound('Speaker');
    return toSpeakerDto(row);
  }
}
