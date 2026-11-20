import { Inject, Injectable } from '@nestjs/common';
import { auditEvents, type Database } from '@vip/db';
import { DB } from '../database/database.module';

export type AuditAction =
  | 'recording.upload_started'
  | 'recording.upload_completed'
  | 'recording.upload_rejected'
  | 'recording.playback_url_issued';

export interface AuditEntry {
  workspaceId: string;
  actorId: string;
  action: AuditAction;
  resourceType: 'recording';
  resourceId: string;
  /** IDs, sizes and codes only. Never filenames or content (SEC-8, SEC-9). */
  metadata?: Record<string, string | number | boolean | null>;
}

/** Append-only audit writer (SEC-8). There is deliberately no update or delete method. */
@Injectable()
export class AuditService {
  constructor(@Inject(DB) private readonly db: Database) {}

  async record(entry: AuditEntry, tx: Pick<Database, 'insert'> = this.db): Promise<void> {
    await tx.insert(auditEvents).values({ ...entry, metadata: entry.metadata ?? null });
  }
}
