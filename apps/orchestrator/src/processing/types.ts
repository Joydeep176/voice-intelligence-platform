import type { Database } from '@vip/db';
import type { ProcessingConfig } from '../config';
import type { AudioTasks } from './audio-client';

/**
 * Result of one step of a step job (LLD §5). A step never blocks a worker: it does a bounded
 * amount of work and either finishes the job or asks to be run again after a delay (the worker
 * moves the job to the delayed set). `data` is merged into the job data (the task ID).
 */
export type StepOutcome =
  { kind: 'finish' } | { kind: 'delay'; delayMs: number; data?: Record<string, unknown> };

export const FINISH: StepOutcome = { kind: 'finish' };

/** A dependency failed in a way worth retrying with BullMQ's attempts and backoff. */
export class TransientError extends Error {
  constructor(readonly reason: string) {
    super(`Transient failure: ${reason}`);
    this.name = 'TransientError';
  }
}

export interface ProcessingEnqueuer {
  enqueueProbe(workspaceId: string, recordingId: string, thenPreprocess: boolean): Promise<void>;
  enqueuePreprocess(workspaceId: string, preprocessingId: string): Promise<void>;
}

/** Everything a step needs; the clock and log are injectable for tests. IDs and codes only in logs. */
export interface ProcessingDeps {
  db: Database;
  audio: AudioTasks;
  config: ProcessingConfig;
  enqueuer: ProcessingEnqueuer;
  now: () => number;
  log: (event: Record<string, string | number | boolean | null>) => void;
}
