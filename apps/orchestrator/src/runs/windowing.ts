import { INTERIM_TRANSCRIPTION_WINDOW, type WindowSource } from '@vip/contracts';

export interface TranscriptionWindow {
  /** `audio_segments.index` for VAD windows, the running index for fixed windows. */
  index: number;
  startMs: number;
  endMs: number;
  /** Overlap shared with the previous / next window (0 at the ends). */
  overlapStartMs: number;
  overlapEndMs: number;
}

export interface VadSegment {
  index: number;
  startMs: number;
  endMs: number;
  overlapStartMs: number;
  overlapEndMs: number;
}

export interface WindowPlan {
  source: WindowSource;
  windows: TranscriptionWindow[];
  /** Fixed-window parameters; null for VAD windows (their layout comes from the segments). */
  params: { windowMs: number; overlapMs: number } | null;
}

/** A run never plans more windows than this (bounded fan-out, OPS-5). */
export const MAX_WINDOWS = 5000;

/**
 * Transcription windows (D-2C-02, LLD §4 step 5): the preprocessing version's VAD segments when
 * there are any, otherwise fixed windows over the canonical audio. Fixed window `i` starts at
 * `i x (windowMs - overlapMs)`, so consecutive windows share `overlapMs`; the last one ends at the
 * recording end. Pure and deterministic.
 */
export function planWindows(input: {
  durationMs: number;
  vadSegments?: VadSegment[];
  windowMs?: number;
  overlapMs?: number;
}): WindowPlan {
  if (!Number.isInteger(input.durationMs) || input.durationMs <= 0) {
    throw new RangeError('durationMs must be a positive integer.');
  }
  const vad = input.vadSegments ?? [];
  if (vad.length > 0) {
    const windows = [...vad]
      .sort((a, b) => a.startMs - b.startMs || a.index - b.index)
      .map((s) => ({
        index: s.index,
        startMs: s.startMs,
        endMs: Math.min(s.endMs, input.durationMs),
        overlapStartMs: s.overlapStartMs,
        overlapEndMs: s.overlapEndMs,
      }))
      .filter((w) => w.endMs > w.startMs);
    return { source: 'vad_segments', windows, params: null };
  }

  const windowMs = input.windowMs ?? INTERIM_TRANSCRIPTION_WINDOW.windowMs;
  const overlapMs = input.overlapMs ?? INTERIM_TRANSCRIPTION_WINDOW.overlapMs;
  if (windowMs <= 0 || overlapMs < 0 || overlapMs >= windowMs) {
    throw new RangeError('overlapMs must be smaller than windowMs.');
  }
  const stride = windowMs - overlapMs;
  const windows: TranscriptionWindow[] = [];
  for (let start = 0, index = 0; start < input.durationMs; start += stride, index += 1) {
    const end = Math.min(start + windowMs, input.durationMs);
    windows.push({
      index,
      startMs: start,
      endMs: end,
      overlapStartMs: index === 0 ? 0 : overlapMs,
      overlapEndMs: end >= input.durationMs ? 0 : overlapMs,
    });
    if (end >= input.durationMs) break;
  }
  return { source: 'fixed_windows', windows, params: { windowMs, overlapMs } };
}
