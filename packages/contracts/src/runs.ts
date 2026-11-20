import { z } from 'zod';
import { IsoDateTime, Uuid } from './common.js';

/**
 * DATABASE_DESIGN §4 `pipeline_runs.status`. `created` = recorded at upload, not yet
 * submitted to the pipeline (ADR-0025).
 */
export const RUN_STATUSES = [
  'created',
  'queued',
  'running',
  'cancelling',
  'cancelled',
  'completed',
  'failed',
  'needs_review',
] as const;
export const RunStatus = z.enum(RUN_STATUSES);
export type RunStatus = z.infer<typeof RunStatus>;

export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = ['cancelled', 'completed', 'failed'];

/** `GET /runs/{runId}` status snapshot (FR-11.1). Content-free. */
export const ProcessingStatus = z.object({
  id: Uuid,
  recordingId: Uuid,
  status: RunStatus,
  /** Current pipeline node; null until the pipeline exists and starts the run. */
  currentStage: z.string().nullable(),
  error: z.object({ code: z.string().max(64), node: z.string().max(64).nullable() }).nullable(),
  startedAt: IsoDateTime.nullable(),
  completedAt: IsoDateTime.nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ProcessingStatus = z.infer<typeof ProcessingStatus>;
