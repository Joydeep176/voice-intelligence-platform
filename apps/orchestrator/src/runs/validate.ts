import type { DiarizationTurn, SttSegment } from '@vip/contracts';
import { RunFailure } from './types';

/**
 * Tolerance for provider timestamps that run slightly past the end of the canonical audio
 * (frame rounding). Anything further out is invalid; anything within is clamped to the end.
 */
export const END_TOLERANCE_MS = 1000;

/** Longest speaker key accepted (matches `SpeakerDto.speakerKey`). */
export const MAX_SPEAKER_KEY_LENGTH = 64;

const validConfidence = (c: number | undefined): boolean => c === undefined || (c >= 0 && c <= 1);

/**
 * Rounds a provider interval to integer milliseconds and checks it lies on the recording:
 * finite, `0 <= start < durationMs`, `end > start`, `end <= durationMs + END_TOLERANCE_MS`.
 * Returns the interval with the end clamped to the recording, or null when it is invalid.
 */
function onTimeline(
  start: number,
  end: number,
  durationMs: number,
): { startMs: number; endMs: number } | null {
  const startMs = Math.round(start);
  const endMs = Math.round(end);
  if (
    !Number.isFinite(startMs) ||
    !Number.isFinite(endMs) ||
    startMs < 0 ||
    startMs >= durationMs ||
    endMs <= startMs ||
    endMs > durationMs + END_TOLERANCE_MS
  ) {
    return null;
  }
  return { startMs, endMs: Math.min(endMs, durationMs) };
}

/** STT provider output is untrusted: positions lie on the recording and ranges are non-empty. */
export function validateSegments(segments: SttSegment[], durationMs: number): SttSegment[] {
  return segments.map((s) => {
    const range = onTimeline(s.startMs, s.endMs, durationMs);
    if (!range || typeof s.text !== 'string' || !validConfidence(s.confidence)) {
      throw new RunFailure('PROVIDER_OUTPUT_INVALID', 'transcription');
    }
    return { ...s, ...range };
  });
}

/**
 * Diarization provider output is untrusted and follows the segment rules (Phase 2C audit §11.2):
 * every turn lies on the recording (no negative, reversed, empty, non-finite or out-of-range
 * interval), the speaker key is a non-blank string of at most 64 characters and a reported
 * confidence is within [0, 1]. Valid turns are returned rounded and clamped to the recording.
 */
export function validateTurns(turns: DiarizationTurn[], durationMs: number): DiarizationTurn[] {
  return turns.map((t) => {
    const range = onTimeline(t.startMs, t.endMs, durationMs);
    if (
      !range ||
      typeof t.speakerKey !== 'string' ||
      t.speakerKey.trim() === '' ||
      t.speakerKey.length > MAX_SPEAKER_KEY_LENGTH ||
      !validConfidence(t.confidence)
    ) {
      throw new RunFailure('PROVIDER_OUTPUT_INVALID', 'diarization');
    }
    return { ...t, ...range };
  });
}
