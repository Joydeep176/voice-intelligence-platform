import { z } from 'zod';
import { IsoDateTime, Uuid } from './common.js';

/** Queue names (LLD §5). Only the foundation check queue exists in Phase 1. */
export const QueueName = {
  /** Phase 1 foundation test of the queue boundary. Does not process audio. */
  FoundationCheck: 'foundation-check',
} as const;

/** Payloads carry IDs only (backend rule). */
export const FoundationCheckJob = z.object({
  checkId: Uuid,
  requestedAt: IsoDateTime,
});
export type FoundationCheckJob = z.infer<typeof FoundationCheckJob>;

export const FoundationCheckResult = z.object({
  checkId: Uuid,
  processedBy: z.literal('orchestrator'),
  processedAt: IsoDateTime,
});
export type FoundationCheckResult = z.infer<typeof FoundationCheckResult>;
