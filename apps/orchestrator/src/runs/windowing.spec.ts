import { planWindows } from './windowing';

describe('planWindows', () => {
  it('fixed windows: 30 s windows with 1 s overlap cover the recording exactly', () => {
    const plan = planWindows({ durationMs: 100_000 });
    expect(plan.source).toBe('fixed_windows');
    expect(plan.params).toEqual({ windowMs: 30_000, overlapMs: 1_000 });
    expect(plan.windows.map((w) => [w.index, w.startMs, w.endMs])).toEqual([
      [0, 0, 30_000],
      [1, 29_000, 59_000],
      [2, 58_000, 88_000],
      [3, 87_000, 100_000],
    ]);
    // Neighbours share exactly the overlap; the ends have none.
    expect(plan.windows[0]).toMatchObject({ overlapStartMs: 0, overlapEndMs: 1_000 });
    expect(plan.windows[1]).toMatchObject({ overlapStartMs: 1_000, overlapEndMs: 1_000 });
    expect(plan.windows[3]).toMatchObject({ overlapStartMs: 1_000, overlapEndMs: 0 });
    for (let i = 1; i < plan.windows.length; i += 1) {
      expect(plan.windows[i - 1]!.endMs - plan.windows[i]!.startMs).toBe(1_000);
    }
  });

  it('a recording shorter than one window is one window without overlap', () => {
    const plan = planWindows({ durationMs: 4_000 });
    expect(plan.windows).toEqual([
      { index: 0, startMs: 0, endMs: 4_000, overlapStartMs: 0, overlapEndMs: 0 },
    ]);
  });

  it('a recording of exactly one window length, and one that ends inside the overlap', () => {
    expect(planWindows({ durationMs: 30_000 }).windows).toHaveLength(1);
    const plan = planWindows({ durationMs: 29_500 });
    expect(plan.windows).toHaveLength(1);
    // 30_500 ms: window 1 starts at 29_000 and is only 1.5 s long
    const two = planWindows({ durationMs: 30_500 });
    expect(two.windows.map((w) => [w.startMs, w.endMs])).toEqual([
      [0, 30_000],
      [29_000, 30_500],
    ]);
  });

  it('VAD segments, when present, are the windows (with their own overlaps), sorted and clipped', () => {
    const plan = planWindows({
      durationMs: 50_000,
      vadSegments: [
        { index: 1, startMs: 20_000, endMs: 60_000, overlapStartMs: 500, overlapEndMs: 0 },
        { index: 0, startMs: 1_000, endMs: 20_500, overlapStartMs: 0, overlapEndMs: 500 },
      ],
    });
    expect(plan.source).toBe('vad_segments');
    expect(plan.params).toBeNull();
    expect(plan.windows).toEqual([
      { index: 0, startMs: 1_000, endMs: 20_500, overlapStartMs: 0, overlapEndMs: 500 },
      { index: 1, startMs: 20_000, endMs: 50_000, overlapStartMs: 500, overlapEndMs: 0 },
    ]);
  });

  it('falls back to fixed windows for an empty VAD list', () => {
    expect(planWindows({ durationMs: 10_000, vadSegments: [] }).source).toBe('fixed_windows');
  });

  it('rejects impossible input', () => {
    expect(() => planWindows({ durationMs: 0 })).toThrow(RangeError);
    expect(() => planWindows({ durationMs: 10, windowMs: 1000, overlapMs: 1000 })).toThrow(
      RangeError,
    );
  });
});
