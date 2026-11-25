import type { SttSegment } from '@vip/contracts';
import { stitchWindows } from './stitch';
import { planWindows } from './windowing';

const seg = (startMs: number, endMs: number, text = 't'): SttSegment => ({
  startMs,
  endMs,
  text,
  language: 'en',
});

describe('stitchWindows', () => {
  const plan = planWindows({ durationMs: 60_000 }); // [0,30000] [29000,59000] [58000,60000]

  it('keeps a segment from the window where it is farther from the edge; nothing is duplicated', () => {
    const [w0, w1, w2] = plan.windows as [
      (typeof plan.windows)[number],
      (typeof plan.windows)[number],
      (typeof plan.windows)[number],
    ];
    // The same utterance appears in both windows at 29_100-29_300 (mid 29_200 < boundary 29_500)
    // and another at 29_700-29_900 (mid 29_800 >= boundary 29_500).
    const early = seg(29_100, 29_300, 'early');
    const late = seg(29_700, 29_900, 'late');
    const out = stitchWindows([
      { window: w0, segments: [seg(0, 10_000, 'a'), early, late], rawOutputId: 'r0' },
      { window: w1, segments: [early, late, seg(40_000, 50_000, 'b')], rawOutputId: 'r1' },
      { window: w2, segments: [seg(58_500, 59_900, 'c')], rawOutputId: 'r2' },
    ]);
    expect(out.map((s) => [s.text, s.sourceRawOutputIds[0]])).toEqual([
      ['a', 'r0'],
      ['early', 'r0'],
      ['late', 'r1'],
      ['b', 'r1'],
      ['c', 'r2'],
    ]);
  });

  it('is order independent and sorts by time', () => {
    const [w0, w1] = plan.windows as [(typeof plan.windows)[number], (typeof plan.windows)[number]];
    const a = stitchWindows([
      { window: w1, segments: [seg(40_000, 41_000, 'b')], rawOutputId: 'r1' },
      { window: w0, segments: [seg(1_000, 2_000, 'a')], rawOutputId: 'r0' },
    ]);
    expect(a.map((s) => s.text)).toEqual(['a', 'b']);
  });

  it('the first window owns everything before it and the last everything after it', () => {
    const [w0, , w2] = plan.windows as [
      (typeof plan.windows)[number],
      (typeof plan.windows)[number],
      (typeof plan.windows)[number],
    ];
    const out = stitchWindows([
      { window: w0, segments: [seg(0, 100, 'first')], rawOutputId: 'r0' },
      { window: w2, segments: [seg(59_900, 60_000, 'last')], rawOutputId: 'r2' },
    ]);
    expect(out.map((s) => s.text)).toEqual(['first', 'last']);
  });

  it('drops empty text and keeps provider fields (confidence stays absent, words ride along)', () => {
    const [w0] = plan.windows as [(typeof plan.windows)[number]];
    const withWords: SttSegment = {
      ...seg(0, 1_000, 'x'),
      words: [{ startMs: 0, endMs: 500, text: 'x' }],
    };
    const out = stitchWindows([
      { window: w0, segments: [seg(2_000, 3_000, '   '), withWords], rawOutputId: 'r0' },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.words).toHaveLength(1);
    expect(out[0]!.confidence).toBeUndefined();
  });

  it('a single window passes everything through', () => {
    const single = planWindows({ durationMs: 5_000 });
    const out = stitchWindows([
      {
        window: single.windows[0]!,
        segments: [seg(0, 2_000, 'a'), seg(2_000, 5_000, 'b')],
        rawOutputId: 'r',
      },
    ]);
    expect(out).toHaveLength(2);
  });
});
