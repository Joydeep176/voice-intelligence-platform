import type { DiarizationTurn, SttSegment } from '@vip/contracts';
import { RunFailure } from './types';
import { END_TOLERANCE_MS, validateSegments, validateTurns } from './validate';

const DURATION = 60_000;

const turn = (startMs: number, endMs: number, speakerKey = 'SPEAKER_00'): DiarizationTurn => ({
  startMs,
  endMs,
  speakerKey,
});

const segment = (startMs: number, endMs: number): SttSegment => ({
  startMs,
  endMs,
  text: 'x',
  language: 'en',
});

function failure(fn: () => unknown): RunFailure {
  try {
    fn();
  } catch (error) {
    if (error instanceof RunFailure) return error;
    throw error;
  }
  throw new Error('expected a RunFailure');
}

describe('validateTurns (diarization output, audit §11.2)', () => {
  it('accepts turns on the recording, including overlapping turns of different speakers', () => {
    const turns = [turn(0, 10_000), turn(9_500, 20_000, 'SPEAKER_01'), turn(20_000, DURATION)];
    expect(validateTurns(turns, DURATION)).toEqual(turns);
  });

  it('rounds to integer milliseconds and keeps the confidence', () => {
    expect(
      validateTurns([{ startMs: 0.4, endMs: 999.6, speakerKey: 'A', confidence: 0.5 }], DURATION),
    ).toEqual([{ startMs: 0, endMs: 1000, speakerKey: 'A', confidence: 0.5 }]);
  });

  it('clamps an end within the tolerance to the recording end', () => {
    expect(validateTurns([turn(50_000, DURATION + END_TOLERANCE_MS)], DURATION)).toEqual([
      turn(50_000, DURATION),
    ]);
  });

  it.each([
    ['negative start', turn(-1, 1000)],
    ['reversed interval', turn(5000, 4000)],
    ['empty interval', turn(5000, 5000)],
    ['end beyond the recording', turn(50_000, DURATION + END_TOLERANCE_MS + 1)],
    ['start at the recording end', turn(DURATION, DURATION + 500)],
    ['start beyond the recording', turn(DURATION + 100, DURATION + 200)],
    ['non-finite start', turn(Number.NaN, 1000)],
    ['infinite end', turn(0, Number.POSITIVE_INFINITY)],
    ['blank speaker key', turn(0, 1000, '  ')],
    ['empty speaker key', turn(0, 1000, '')],
    ['speaker key over 64 characters', turn(0, 1000, 'S'.repeat(65))],
    ['confidence above 1', { ...turn(0, 1000), confidence: 1.5 }],
    ['negative confidence', { ...turn(0, 1000), confidence: -0.1 }],
    ['non-string speaker key', { ...turn(0, 1000), speakerKey: 7 as unknown as string }],
  ])('rejects a %s with PROVIDER_OUTPUT_INVALID on the diarization node', (_name, bad) => {
    const error = failure(() => validateTurns([turn(0, 1000), bad], DURATION));
    expect(error.code).toBe('PROVIDER_OUTPUT_INVALID');
    expect(error.node).toBe('diarization');
  });

  it('accepts an empty turn list (silence)', () => {
    expect(validateTurns([], DURATION)).toEqual([]);
  });
});

describe('validateSegments (STT output)', () => {
  it('keeps valid segments and clamps a tolerated end to the recording end', () => {
    expect(validateSegments([segment(0, 1000), segment(59_000, 60_400)], DURATION)).toEqual([
      segment(0, 1000),
      segment(59_000, DURATION),
    ]);
  });

  it.each([
    ['negative start', segment(-5, 1000)],
    ['reversed interval', segment(2000, 1000)],
    ['end beyond the tolerance', segment(59_000, DURATION + END_TOLERANCE_MS + 1)],
    // Regression: a segment starting at or after the end used to pass and be stored past the audio.
    ['start at the recording end', segment(DURATION, DURATION + 500)],
    ['confidence out of range', { ...segment(0, 1000), confidence: 2 }],
  ])('rejects a %s on the transcription node', (_name, bad) => {
    const error = failure(() => validateSegments([bad], DURATION));
    expect(error.code).toBe('PROVIDER_OUTPUT_INVALID');
    expect(error.node).toBe('transcription');
  });
});
