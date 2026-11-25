import { shouldWriteProgress } from './progress';

const at = (ms: number) => new Date(ms).toISOString();
const stored = (fraction: number, stage = 'decode', ms = 1_000_000) => ({
  stage,
  fraction,
  processedMs: 1,
  updatedAt: at(ms),
});
const next = (fraction: number, stage = 'decode') => ({ stage, fraction, processedMs: 2 });

describe('shouldWriteProgress (throttling)', () => {
  it('writes when nothing valid is stored yet', () => {
    expect(shouldWriteProgress(null, next(0), 1_000_000)).toBe(true);
    expect(shouldWriteProgress({ junk: true }, next(0), 1_000_000)).toBe(true);
  });

  it('writes on a stage change', () => {
    expect(shouldWriteProgress(stored(0.5), next(0.5, 'measure'), 1_000_100)).toBe(true);
  });

  it('writes when the fraction moved by 1 % or more', () => {
    expect(shouldWriteProgress(stored(0.5), next(0.51), 1_000_100)).toBe(true);
    expect(shouldWriteProgress(stored(0.5), next(0.4), 1_000_100)).toBe(true);
  });

  it('skips small moves inside 5 s and writes once 5 s passed', () => {
    expect(shouldWriteProgress(stored(0.5), next(0.504), 1_000_000 + 4_999)).toBe(false);
    expect(shouldWriteProgress(stored(0.5), next(0.504), 1_000_000 + 5_000)).toBe(true);
  });
});
