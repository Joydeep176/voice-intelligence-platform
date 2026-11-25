import { z } from 'zod';

/**
 * Interim development bounds of transcription runs (OD-10 Open). Read from the environment here
 * because they are shared with the orchestrator (same variable names); validated at startup.
 */
const Env = z.object({
  /** Limit on re-executions of one run (user retries and sweeper recoveries). */
  RUN_MAX_RETRIES: z.coerce.number().int().min(0).max(10).default(3),
  /** Automatic BullMQ attempts for transient failures. */
  QUEUE_RUN_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  QUEUE_RUN_BACKOFF_MS: z.coerce.number().int().min(10).max(600_000).default(5000),
});

export interface RunSettings {
  maxRetries: number;
  attempts: number;
  backoffMs: number;
}

export const RUN_SETTINGS = Symbol('RUN_SETTINGS');

export function loadRunSettings(env: NodeJS.ProcessEnv = process.env): RunSettings {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const names = [...new Set(parsed.error.issues.map((i) => String(i.path[0])))];
    throw new Error(`Invalid or missing environment variables: ${names.join(', ')}`);
  }
  return {
    maxRetries: parsed.data.RUN_MAX_RETRIES,
    attempts: parsed.data.QUEUE_RUN_ATTEMPTS,
    backoffMs: parsed.data.QUEUE_RUN_BACKOFF_MS,
  };
}
