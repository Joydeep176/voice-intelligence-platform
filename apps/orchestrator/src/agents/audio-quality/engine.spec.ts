import { assess, runs, severityAbove, severityBelow, type A1Input, type Quantity } from './engine';
import { A1_RULE_CONFIG as CFG } from './rule-config';

const m = (value: number): Quantity => ({ value, kind: 'measured' });
const d = (value: number): Quantity => ({ value, kind: 'derived' });
const e = (value: number): Quantity => ({ value, kind: 'estimate' });

/** A clean, normal-level 60 s recording with Tier 0 only. */
function base(overrides: Partial<A1Input> = {}): A1Input {
  return {
    durationMs: 60_000,
    canonical: {
      quantities: {
        peakDbfs: m(-6),
        rmsDbfs: m(-24),
        silenceRatio: d(0.2),
        noiseFloorDbfs: e(-65),
      },
    },
    original: {
      quantities: { clippedRatio: d(0), clippedRuns: m(0), integratedLoudnessLufs: e(-23) },
    },
    levelSeries: { intervalMs: 100, rmsDbfs: Array(600).fill(-24), peakDbfs: Array(600).fill(-6) },
    timeline: { gaps: [], decodeErrors: { count: 0, firstAtMs: null } },
    tier1: { state: 'not_requested' },
    ...overrides,
  };
}

/** Tier 1 available with clean speech. */
function withTier1(q: Record<string, Quantity> = {}, snrSeries?: (number | null)[]): A1Input {
  const blocks = 60;
  return base({
    tier1: {
      state: 'available',
      quantities: {
        speechRatio: d(0.6),
        speechMs: d(36_000),
        activeSpeechLevelDbfs: e(-24),
        snrDb: e(35),
        bandwidthEdgeHz: e(8000),
        levelSpreadDb: e(4),
        maxSpansPerWindow: d(4),
        ...q,
      },
      series: {
        blockMs: 1000,
        speechMs: Array(blocks).fill(600),
        snrDb: snrSeries ?? Array(blocks).fill(35),
      },
    },
  });
}

describe('severity helpers', () => {
  it('maps bands in both directions', () => {
    expect(severityAbove(0.5, { low: 0.1, medium: 0.4, high: 0.9 })).toBe('medium');
    expect(severityAbove(0.05, { low: 0.1, medium: 0.4, high: 0.9 })).toBeNull();
    expect(severityBelow(4, CFG.snrDb)).toBe('high');
    expect(severityBelow(12, CFG.snrDb)).toBe('low');
    expect(severityBelow(25, CFG.snrDb)).toBeNull();
  });
  it('finds runs', () => {
    expect(runs([0, 1, 1, 0, 1], (v) => v === 1)).toEqual([
      [1, 3],
      [4, 5],
    ]);
  });
});

describe('A1 engine, Tier 0 (existing Phase 2B measurements)', () => {
  it('classes clean audio good, with low confidence and Tier 1 dimensions not assessed', () => {
    const out = assess(base(), CFG);
    expect(out.overall).toBe('good');
    expect(out.confidence).toBe('low');
    expect(out.flags).toEqual([]);
    expect(out.notAssessed.map((n) => n.dimension)).toEqual(
      expect.arrayContaining(['distortion', 'reverberation', 'snr', 'speech_presence']),
    );
    expect(out.suitability.transcription.value).toBe('suitable');
    expect(out.suitability.transcription.reasons).toContain('speech_measurements_unavailable');
  });

  it('approved bands (OD-52): moderate clipping and -48 dBFS speech warn, they are not poor', () => {
    // M6: x4 clipping (2.3-4.2 % clipped) and -30 dB attenuation cost about as much WER as
    // 10 dB noise.
    const clipped = assess(
      base({ original: { quantities: { clippedRatio: d(0.03), clippedRuns: m(40) } } }),
      CFG,
    );
    expect(clipped.flags.find((f) => f.kind === 'clipping')?.severity).toBe('medium');
    expect(clipped.overall).toBe('acceptable_with_warnings');
    const quiet = assess(withTier1({ activeSpeechLevelDbfs: e(-48) }), CFG);
    expect(quiet.flags.find((f) => f.kind === 'low_level')?.severity).toBe('medium');
    expect(quiet.overall).toBe('acceptable_with_warnings');
  });

  it('flags clipping with a whole-recording flag and timestamped regions', () => {
    const peak = Array(600).fill(-6);
    peak.fill(0, 100, 110);
    const out = assess(
      base({
        original: { quantities: { clippedRatio: d(0.1), clippedRuns: m(40) } },
        levelSeries: { intervalMs: 100, rmsDbfs: Array(600).fill(-24), peakDbfs: peak },
      }),
      CFG,
    );
    const clips = out.flags.filter((f) => f.kind === 'clipping');
    expect(clips[0]).toMatchObject({ severity: 'high', startMs: null, basis: 'derived' });
    expect(clips[1]).toMatchObject({ startMs: 10_000, endMs: 11_000, ruleId: 'clipping.region' });
    expect(out.overall).toBe('poor'); // a whole-recording high flag covers everything
    expect(out.recommendations).toContainEqual({ code: 'lower_input_gain' });
  });

  it('reports insufficient for digital silence and never a run failure', () => {
    const out = assess(
      base({
        canonical: { quantities: { silenceRatio: d(1) } }, // peakDbfs unavailable
        levelSeries: {
          intervalMs: 100,
          rmsDbfs: Array(600).fill(null),
          peakDbfs: Array(600).fill(null),
        },
      }),
      CFG,
    );
    expect(out.overall).toBe('insufficient');
    expect(out.suitability.transcription).toEqual({
      value: 'not_assessable',
      reasons: ['no_usable_audio'],
    });
    expect(out.recommendations).toContainEqual({ code: 'new_recording_recommended' });
  });

  it('turns timestamp gaps and decode errors into dropout flags', () => {
    const out = assess(
      base({
        timeline: {
          gaps: [{ startMs: 5000, durationMs: 300 }],
          decodeErrors: { count: 2, firstAtMs: 1 },
        },
      }),
      CFG,
    );
    const drops = out.flags.filter((f) => f.kind === 'dropout');
    expect(drops.map((f) => [f.startMs, f.endMs, f.basis])).toEqual([
      [5000, 5300, 'measured'],
      [null, null, 'measured'],
    ]);
    expect(out.overall).toBe('acceptable_with_warnings');
  });

  it('marks short digital-zero runs in active audio as low-severity dropouts only', () => {
    const rms: (number | null)[] = Array(600).fill(-24);
    rms.fill(null, 200, 205); // 500 ms
    const out = assess(
      base({ levelSeries: { intervalMs: 100, rmsDbfs: rms, peakDbfs: Array(600).fill(-6) } }),
      CFG,
    );
    const dz = out.flags.find((f) => f.ruleId === 'dropout.digital_zero');
    expect(dz).toMatchObject({ severity: 'low', startMs: 20_000, endMs: 20_500 });
    expect(out.overall).toBe('good'); // low flags do not change the class
  });

  it('uses the noise floor and loudness only as Tier 0 fallbacks', () => {
    const out = assess(
      base({
        canonical: { quantities: { peakDbfs: m(-6), noiseFloorDbfs: e(-28) } },
        original: { quantities: { clippedRatio: d(0), integratedLoudnessLufs: e(-50) } },
      }),
      CFG,
    );
    expect(out.flags.map((f) => [f.ruleId, f.severity])).toEqual(
      expect.arrayContaining([
        ['noise.floor', 'high'],
        ['low_level.loudness', 'medium'],
      ]),
    );
  });
});

describe('A1 engine, Tier 1 (speech-aware measurements)', () => {
  it('raises confidence to medium for clean speech and assesses everything but distortion and reverberation', () => {
    const out = assess(withTier1(), CFG);
    expect(out.overall).toBe('good');
    expect(out.confidence).toBe('medium');
    expect(out.notAssessed.map((n) => n.dimension)).toEqual(['distortion', 'reverberation']);
    expect(out.tier1).toBe('available');
  });

  it('flags low SNR overall and in timestamped regions; high noise is a language-ID risk', () => {
    const series = Array(60).fill(30);
    series.fill(3, 10, 20); // 10 s at 3 dB
    const out = assess(withTier1({ snrDb: e(4) }, series), CFG);
    const region = out.flags.find((f) => f.ruleId === 'noise.snr_region');
    expect(region).toMatchObject({
      severity: 'high',
      startMs: 10_000,
      endMs: 20_000,
      basis: 'estimate',
    });
    expect(out.overall).toBe('poor');
    expect(out.suitability.transcription.value).toBe('unreliable');
    expect(out.suitability.transcription.reasons).toContain('language_id_risk');
  });

  it('reports insufficient when there is (almost) no speech', () => {
    const out = assess(withTier1({ speechRatio: d(0.01), speechMs: d(600) }), CFG);
    expect(out.overall).toBe('insufficient');
    expect(out.suitability.diarization.value).toBe('not_assessable');
  });

  it('flags narrowband, level inconsistency and the dense-speech deadline risk', () => {
    const out = assess(
      withTier1({ bandwidthEdgeHz: e(3437), levelSpreadDb: e(25), maxSpansPerWindow: d(14) }),
      CFG,
    );
    expect(out.flags.map((f) => [f.kind, f.severity])).toEqual(
      expect.arrayContaining([
        ['narrowband', 'medium'],
        ['level_inconsistency', 'medium'],
        ['fragmented_speech', 'medium'],
      ]),
    );
    expect(out.suitability.transcription.reasons).toContain('deadline_risk');
    expect(out.overall).toBe('acceptable_with_warnings');
  });

  it('is monotonic: more noise never gives a better class', () => {
    const rank = { good: 0, acceptable_with_warnings: 1, poor: 2, insufficient: 3 } as const;
    let previous = -1;
    for (const snr of [40, 25, 15, 8, 3, 0]) {
      const out = assess(withTier1({ snrDb: e(snr) }, Array(60).fill(snr)), CFG);
      expect(rank[out.overall]).toBeGreaterThanOrEqual(previous);
      previous = rank[out.overall];
    }
  });

  it('is deterministic', () => {
    const input = withTier1({ snrDb: e(9) });
    expect(JSON.stringify(assess(input, CFG))).toBe(JSON.stringify(assess(input, CFG)));
  });

  it('gives low confidence and no diarization assessment for very short audio', () => {
    const out = assess({ ...withTier1(), durationMs: 2000 }, CFG);
    expect(out.confidence).toBe('low');
    expect(out.suitability.diarization).toEqual({
      value: 'not_assessable',
      reasons: ['too_short'],
    });
  });
});
