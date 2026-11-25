import { ProcessingProgress } from '@vip/contracts';

/** Progress is persisted when the stage changes, the fraction moves by 1 % or more, or 5 s passed. */
export const PROGRESS_MIN_FRACTION_DELTA = 0.01;
export const PROGRESS_MIN_INTERVAL_MS = 5000;

export interface TaskProgress {
  stage: string;
  fraction: number;
  processedMs: number;
}

/** `stored` is the row's persisted progress (unknown shapes count as none). */
export function shouldWriteProgress(stored: unknown, next: TaskProgress, nowMs: number): boolean {
  const prev = ProcessingProgress.safeParse(stored);
  if (!prev.success) return true;
  if (prev.data.stage !== next.stage) return true;
  if (Math.abs(next.fraction - prev.data.fraction) >= PROGRESS_MIN_FRACTION_DELTA) return true;
  return nowMs - Date.parse(prev.data.updatedAt) >= PROGRESS_MIN_INTERVAL_MS;
}
