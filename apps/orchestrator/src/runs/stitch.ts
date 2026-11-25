import type { SttSegment } from '@vip/contracts';
import type { TranscriptionWindow } from './windowing';

export interface WindowResult {
  window: TranscriptionWindow;
  segments: SttSegment[];
  /** `stt_raw_outputs.id` the segments were mapped from. */
  rawOutputId: string;
}

export interface StitchedSegment extends SttSegment {
  sourceRawOutputIds: string[];
}

/**
 * Overlap stitching (LLD §4 step 6): where windows overlap, keep a segment from the window in
 * which it lies farther from that window's edge. A window "owns" the span between the middle of
 * its leading overlap and the middle of its trailing overlap, and keeps the segments whose
 * midpoint falls in it. The spans of consecutive windows tile the timeline, so every segment
 * midpoint has exactly one owner and nothing is duplicated. The first window owns everything
 * before it and the last everything after it. Segment-level (word-level selection is for
 * providers that return words; they ride along inside the kept segment). Pure and deterministic.
 */
export function stitchWindows(results: WindowResult[]): StitchedSegment[] {
  const ordered = [...results].sort((a, b) => a.window.startMs - b.window.startMs);
  const kept: StitchedSegment[] = [];
  ordered.forEach((result, i) => {
    const { window } = result;
    const lo = i === 0 ? -Infinity : window.startMs + window.overlapStartMs / 2;
    const hi = i === ordered.length - 1 ? Infinity : window.endMs - window.overlapEndMs / 2;
    for (const segment of result.segments) {
      const mid = (segment.startMs + segment.endMs) / 2;
      if (mid >= lo && mid < hi && segment.text.trim().length > 0) {
        kept.push({ ...segment, sourceRawOutputIds: [result.rawOutputId] });
      }
    }
  });
  return kept.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
}
