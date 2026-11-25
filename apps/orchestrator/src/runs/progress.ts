/** Progress is persisted when the stage changes, the fraction moves by 1 % or more, or 5 s passed (as Phase 2B). */
export const STAGE_PROGRESS_MIN_FRACTION_DELTA = 0.01;
export const STAGE_PROGRESS_MIN_INTERVAL_MS = 5000;

export interface WrittenProgress {
  fraction: number;
  /** Epoch ms of the last write. */
  at: number;
}

/** `last` is the progress this execution last wrote for the stage (null = none yet: a stage change). */
export function shouldWriteStageProgress(
  last: WrittenProgress | null,
  nextFraction: number,
  nowMs: number,
): boolean {
  if (last === null) return true;
  if (Math.abs(nextFraction - last.fraction) >= STAGE_PROGRESS_MIN_FRACTION_DELTA) return true;
  return nowMs - last.at >= STAGE_PROGRESS_MIN_INTERVAL_MS;
}
