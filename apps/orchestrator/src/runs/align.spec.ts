import { alignSpeakers } from './align';

const turn = (startMs: number, endMs: number, speakerKey: string) => ({
  startMs,
  endMs,
  speakerKey,
});

describe('alignSpeakers', () => {
  it('assigns the speaker with the greatest overlap', () => {
    const { assignments } = alignSpeakers(
      [
        { startMs: 0, endMs: 10_000 },
        { startMs: 8_000, endMs: 20_000 }, // 2 s of A, 10 s of B
      ],
      [turn(0, 10_000, 'A'), turn(10_000, 30_000, 'B')],
    );
    expect(assignments.map((a) => a.speakerKey)).toEqual(['A', 'B']);
  });

  it('ties go to the smaller key; the result does not depend on turn order', () => {
    const turns = [turn(5_000, 10_000, 'B'), turn(0, 5_000, 'A')];
    const forward = alignSpeakers([{ startMs: 0, endMs: 10_000 }], turns);
    const reversed = alignSpeakers([{ startMs: 0, endMs: 10_000 }], [...turns].reverse());
    expect(forward.assignments[0]!.speakerKey).toBe('A');
    expect(reversed.assignments).toEqual(forward.assignments);
  });

  it('a segment no turn overlaps stays unassigned with a speaker_uncertain span', () => {
    const { assignments, uncertainties } = alignSpeakers(
      [
        { startMs: 0, endMs: 1_000 },
        { startMs: 50_000, endMs: 51_000 },
      ],
      [turn(0, 1_000, 'A')],
    );
    expect(assignments.map((a) => a.speakerKey)).toEqual(['A', null]);
    expect(uncertainties).toEqual([
      { segmentIndex: 1, startMs: 50_000, endMs: 51_000, kind: 'speaker_uncertain' },
    ]);
  });

  it('touching turns are not an overlap; overlapping turns of different speakers are', () => {
    const touching = alignSpeakers(
      [{ startMs: 0, endMs: 20_000 }],
      [turn(0, 10_000, 'A'), turn(10_000, 20_000, 'B')],
    );
    expect(touching.uncertainties).toEqual([]);

    const { uncertainties } = alignSpeakers(
      [
        { startMs: 0, endMs: 10_000 },
        { startMs: 10_000, endMs: 20_000 },
      ],
      [turn(0, 10_500, 'A'), turn(10_000, 20_000, 'B')],
    );
    expect(uncertainties).toEqual([
      { segmentIndex: 1, startMs: 10_000, endMs: 10_500, kind: 'overlapping_speech' },
    ]);
  });

  it('the same speaker overlapping themselves is not overlapping speech; identical spans are reported once', () => {
    const same = alignSpeakers(
      [{ startMs: 0, endMs: 10_000 }],
      [turn(0, 6_000, 'A'), turn(5_000, 10_000, 'A')],
    );
    expect(same.uncertainties).toEqual([]);
    const dup = alignSpeakers(
      [{ startMs: 0, endMs: 10_000 }],
      [turn(0, 10_000, 'A'), turn(0, 10_000, 'B'), turn(0, 10_000, 'C')],
    );
    expect(dup.uncertainties.filter((u) => u.kind === 'overlapping_speech')).toHaveLength(1);
  });

  it('an overlap span that no segment covers has no segment index', () => {
    const { uncertainties } = alignSpeakers(
      [{ startMs: 0, endMs: 1_000 }],
      [turn(5_000, 7_000, 'A'), turn(6_000, 8_000, 'B')],
    );
    expect(uncertainties).toContainEqual({
      segmentIndex: null,
      startMs: 6_000,
      endMs: 7_000,
      kind: 'overlapping_speech',
    });
  });
});
