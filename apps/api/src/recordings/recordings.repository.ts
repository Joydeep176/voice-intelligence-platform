import { Inject, Injectable } from '@nestjs/common';
import {
  and,
  consentAttestations,
  desc,
  eq,
  inArray,
  lt,
  or,
  sql,
  pipelineRuns,
  recordings,
  uploadSessions,
  type Database,
  type PipelineRun,
  type Recording,
  type UploadSessionRow,
} from '@vip/db';

import { DB } from '../database/database.module';

export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

export interface ListCursor {
  createdAt: Date;
  id: string;
}

/**
 * Every query filters by workspace (ADR-0003): a resource in another workspace is
 * indistinguishable from a missing one.
 */
@Injectable()
export class RecordingsRepository {
  constructor(@Inject(DB) readonly db: Database) {}

  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.transaction(fn);
  }

  async findRecording(
    workspaceId: string,
    id: string,
    tx: Tx | Database = this.db,
  ): Promise<Recording | null> {
    const [row] = await tx
      .select()
      .from(recordings)
      .where(and(eq(recordings.workspaceId, workspaceId), eq(recordings.id, id)))
      .limit(1);
    return row ?? null;
  }

  async lockRecording(tx: Tx, workspaceId: string, id: string): Promise<Recording | null> {
    const [row] = await tx
      .select()
      .from(recordings)
      .where(and(eq(recordings.workspaceId, workspaceId), eq(recordings.id, id)))
      .for('update')
      .limit(1);
    return row ?? null;
  }

  async listRecordings(
    workspaceId: string,
    limit: number,
    cursor?: ListCursor,
  ): Promise<Recording[]> {
    const scope = eq(recordings.workspaceId, workspaceId);
    const after = cursor
      ? or(
          lt(recordings.createdAt, cursor.createdAt),
          and(eq(recordings.createdAt, cursor.createdAt), lt(recordings.id, cursor.id)),
        )
      : undefined;
    return this.db
      .select()
      .from(recordings)
      .where(after ? and(scope, after) : scope)
      .orderBy(desc(recordings.createdAt), desc(recordings.id))
      .limit(limit);
  }

  async latestRuns(workspaceId: string, recordingIds: string[]): Promise<Map<string, PipelineRun>> {
    if (recordingIds.length === 0) return new Map();
    const rows = await this.db
      .selectDistinctOn([pipelineRuns.recordingId])
      .from(pipelineRuns)
      .where(
        and(
          eq(pipelineRuns.workspaceId, workspaceId),
          inArray(pipelineRuns.recordingId, recordingIds),
        ),
      )
      .orderBy(pipelineRuns.recordingId, desc(pipelineRuns.createdAt));
    return new Map(rows.map((r) => [r.recordingId, r]));
  }

  async findRun(workspaceId: string, runId: string): Promise<PipelineRun | null> {
    const [row] = await this.db
      .select()
      .from(pipelineRuns)
      .where(and(eq(pipelineRuns.workspaceId, workspaceId), eq(pipelineRuns.id, runId)))
      .limit(1);
    return row ?? null;
  }

  async findActiveSession(
    recordingId: string,
    workspaceId: string,
    tx: Tx | Database = this.db,
  ): Promise<UploadSessionRow | null> {
    const [row] = await tx
      .select()
      .from(uploadSessions)
      .where(
        and(
          eq(uploadSessions.recordingId, recordingId),
          eq(uploadSessions.workspaceId, workspaceId),
        ),
      )
      .orderBy(desc(uploadSessions.createdAt))
      .limit(1);
    return row ?? null;
  }

  async createRecording(
    tx: Tx,
    input: {
      id: string;
      workspaceId: string;
      originalFilename: string;
      mimeType: string;
      sizeBytes: number;
      storageUri: string;
      attestedBy: string;
      statementVersion: string;
      partSize: number;
      totalParts: number;
      expiresAt: Date;
    },
  ): Promise<{ recording: Recording; session: UploadSessionRow }> {
    const [recording] = await tx
      .insert(recordings)
      .values({
        id: input.id,
        workspaceId: input.workspaceId,
        originalFilename: input.originalFilename,
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
        storageUri: input.storageUri,
        status: 'uploading',
      })
      .returning();
    await tx.insert(consentAttestations).values({
      recordingId: input.id,
      workspaceId: input.workspaceId,
      attestedBy: input.attestedBy,
      statementVersion: input.statementVersion,
    });
    const [session] = await tx
      .insert(uploadSessions)
      .values({
        recordingId: input.id,
        workspaceId: input.workspaceId,
        strategy: 'local_chunked',
        partSize: input.partSize,
        totalParts: input.totalParts,
        expiresAt: input.expiresAt,
      })
      .returning();
    return { recording: recording!, session: session! };
  }

  /** Atomically records one received part (idempotent per part number). */
  async markPartReceived(sessionId: string, partNumber: number, sizeBytes: number): Promise<void> {
    const patch = JSON.stringify({ [String(partNumber)]: { sizeBytes } });
    await this.db
      .update(uploadSessions)
      .set({ partsReceived: sql`${uploadSessions.partsReceived} || ${patch}::jsonb` })
      .where(and(eq(uploadSessions.id, sessionId), eq(uploadSessions.status, 'active')));
  }

  async setSessionStatus(
    sessionId: string,
    status: UploadSessionRow['status'],
    tx: Tx | Database = this.db,
  ): Promise<void> {
    await tx.update(uploadSessions).set({ status }).where(eq(uploadSessions.id, sessionId));
  }

  async markUploaded(tx: Tx, recordingId: string, sha256: string): Promise<Recording | null> {
    const [row] = await tx
      .update(recordings)
      .set({ status: 'uploaded', sha256 })
      .where(and(eq(recordings.id, recordingId), eq(recordings.status, 'uploading')))
      .returning();
    return row ?? null;
  }

  async markInvalid(tx: Tx, recordingId: string, validationError: string): Promise<void> {
    await tx
      .update(recordings)
      .set({ status: 'invalid', validationError })
      .where(and(eq(recordings.id, recordingId), eq(recordings.status, 'uploading')));
  }

  async createRun(tx: Tx, workspaceId: string, recordingId: string): Promise<PipelineRun> {
    const [run] = await tx
      .insert(pipelineRuns)
      .values({ workspaceId, recordingId, status: 'created' })
      .returning();
    return run!;
  }
}
