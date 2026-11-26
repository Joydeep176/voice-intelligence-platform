import { Inject, Injectable } from '@nestjs/common';
import { auditEvents, type Database } from '@vip/db';
import { DB } from '../database/database.module';

export type RunAuditAction =
  | 'run.requested'
  | 'run.cancel_requested'
  | 'run.cancelled'
  | 'run.retried'
  | 'speaker.renamed'
  | 'audio_quality.requested';

export interface RunAuditEntry {
  workspaceId: string;
  actorId: string;
  action: RunAuditAction;
  resourceType: 'run' | 'speaker';
  resourceId: string;
  /** IDs, counts and codes only. Never transcript text or display names (SEC-8, SEC-9). */
  metadata?: Record<string, string | number | boolean | null>;
}

/** Append-only audit writer for run and speaker events. No update or delete method (SEC-8). */
@Injectable()
export class RunAudit {
  constructor(@Inject(DB) private readonly db: Database) {}

  async record(entry: RunAuditEntry, tx: Pick<Database, 'insert'> = this.db): Promise<void> {
    await tx.insert(auditEvents).values({ ...entry, metadata: entry.metadata ?? null });
  }
}
