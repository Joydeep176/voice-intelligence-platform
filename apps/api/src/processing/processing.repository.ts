import { Inject, Injectable } from '@nestjs/common';
import {
  and,
  audioPreprocessings,
  audioSegments,
  desc,
  eq,
  sql,
  type AudioPreprocessing,
  type Database,
} from '@vip/db';
import { DB } from '../database/database.module';

/** Read queries for processing that the shared repository does not provide. Workspace-scoped. */
@Injectable()
export class ProcessingRepository {
  constructor(@Inject(DB) readonly db: Database) {}

  async latestSucceeded(
    workspaceId: string,
    recordingId: string,
  ): Promise<AudioPreprocessing | null> {
    const [row] = await this.db
      .select()
      .from(audioPreprocessings)
      .where(
        and(
          eq(audioPreprocessings.workspaceId, workspaceId),
          eq(audioPreprocessings.recordingId, recordingId),
          eq(audioPreprocessings.status, 'succeeded'),
        ),
      )
      .orderBy(desc(audioPreprocessings.createdAt), desc(audioPreprocessings.id))
      .limit(1);
    return row ?? null;
  }

  async segmentCount(workspaceId: string, preprocessingId: string): Promise<number> {
    const [row] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(audioSegments)
      .where(
        and(
          eq(audioSegments.workspaceId, workspaceId),
          eq(audioSegments.preprocessingId, preprocessingId),
        ),
      );
    return row?.n ?? 0;
  }
}
