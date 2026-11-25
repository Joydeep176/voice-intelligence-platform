import { shouldWriteStageProgress } from './progress';

describe('shouldWriteStageProgress', () => {
  const last = { fraction: 0.5, at: 1_000_000 };
  it('writes the first progress of a stage (stage change)', () => {
    expect(shouldWriteStageProgress(null, 0.01, 0)).toBe(true);
  });
  it('writes when the fraction moved by 1 % or more', () => {
    expect(shouldWriteStageProgress(last, 0.51, last.at + 1)).toBe(true);
    expect(shouldWriteStageProgress(last, 0.505, last.at + 1)).toBe(false);
  });
  it('writes after 5 s even for a tiny move, not before', () => {
    expect(shouldWriteStageProgress(last, 0.5001, last.at + 4_999)).toBe(false);
    expect(shouldWriteStageProgress(last, 0.5001, last.at + 5_000)).toBe(true);
  });
});
