import type { DiarizationTurn } from '@vip/contracts';

export interface AlignableSegment {
  startMs: number;
  endMs: number;
}

export interface AlignedSegment {
  speakerKey: string | null;
}

export interface GeneratedUncertainty {
  segmentIndex: number | null;
  startMs: number;
  endMs: number;
  kind: 'overlapping_speech' | 'speaker_uncertain';
}

const overlap = (aStart: number, aEnd: number, bStart: number, bEnd: number): number =>
  Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));

/**
 * Speaker alignment (LLD §4 step 9): each segment gets the speaker whose turns overlap it the
 * longest (ties go to the lexicographically smaller key). A segment no turn overlaps stays
 * unassigned and gets a `speaker_uncertain` span. Turns of different speakers that overlap in time
 * give an `overlapping_speech` span for the shared time, tied to the segment it overlaps most
 * (null when none). Segments must be sorted by start. Pure and deterministic.
 */
export function alignSpeakers(
  segments: AlignableSegment[],
  turns: DiarizationTurn[],
): { assignments: AlignedSegment[]; uncertainties: GeneratedUncertainty[] } {
  const uncertainties: GeneratedUncertainty[] = [];

  const assignments = segments.map((segment, index): AlignedSegment => {
    const perSpeaker = new Map<string, number>();
    for (const turn of turns) {
      const ms = overlap(segment.startMs, segment.endMs, turn.startMs, turn.endMs);
      if (ms > 0) perSpeaker.set(turn.speakerKey, (perSpeaker.get(turn.speakerKey) ?? 0) + ms);
    }
    let best: string | null = null;
    let bestMs = 0;
    for (const [key, ms] of [...perSpeaker].sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (ms > bestMs) {
        best = key;
        bestMs = ms;
      }
    }
    if (best === null) {
      uncertainties.push({
        segmentIndex: index,
        startMs: segment.startMs,
        endMs: segment.endMs,
        kind: 'speaker_uncertain',
      });
    }
    return { speakerKey: best };
  });

  const sorted = [...turns].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  const seen = new Set<string>();
  for (let i = 0; i < sorted.length; i += 1) {
    const a = sorted[i]!;
    for (let j = i + 1; j < sorted.length; j += 1) {
      const b = sorted[j]!;
      if (b.startMs >= a.endMs) break; // sorted by start: no later turn can overlap `a`
      if (a.speakerKey === b.speakerKey) continue;
      const start = Math.max(a.startMs, b.startMs);
      const end = Math.min(a.endMs, b.endMs);
      if (end <= start) continue;
      const id = `${String(start)}-${String(end)}`;
      if (seen.has(id)) continue;
      seen.add(id);
      uncertainties.push({
        segmentIndex: segmentMostOverlapping(segments, start, end),
        startMs: start,
        endMs: end,
        kind: 'overlapping_speech',
      });
    }
  }
  return { assignments, uncertainties };
}

function segmentMostOverlapping(
  segments: AlignableSegment[],
  start: number,
  end: number,
): number | null {
  let best: number | null = null;
  let bestMs = 0;
  for (let i = 0; i < segments.length; i += 1) {
    const s = segments[i]!;
    if (s.startMs >= end) break;
    const ms = overlap(s.startMs, s.endMs, start, end);
    if (ms > bestMs) {
      best = i;
      bestMs = ms;
    }
  }
  return best;
}
