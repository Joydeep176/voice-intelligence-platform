/**
 * A1 Audio Quality rule engine (ADR-0043). Pure and deterministic: the same input and rule config
 * give the same output. No I/O, no clock, no transcription data. Rules run in a fixed order; each
 * returns flags with the measurement references and basis behind them. Thresholds come only from
 * `A1RuleConfig` (approved thresholds, OD-52 / ADR-0048).
 */
import type {
  AudioQualityClass,
  ConfidenceLevel,
  DiagnosticFlagKind,
  EvidenceBasis,
  FlagSeverity,
  NotAssessed,
  Suitability,
} from '@vip/contracts';
import type { A1RuleConfig, Bands } from './rule-config';

/* -- input ---------------------------------------------------------------------------------------- */

export interface Quantity {
  value: number;
  kind: EvidenceBasis;
}

/** A measurement record reduced to what the rules read (quantities by name). */
export interface QuantitySet {
  quantities: Record<string, Quantity>;
  /** Per-channel quantities of the original decode (multichannel input only). */
  perChannel?: Record<string, Quantity>[];
}

export interface LevelSeries {
  intervalMs: number;
  /** null = digital silence in that window. */
  rmsDbfs: (number | null)[];
  peakDbfs: (number | null)[];
}

/** Tier 1 per-block series (ADR-0045, 1000 ms blocks). */
export interface SpeechSeries {
  blockMs: number;
  speechMs: number[];
  snrDb: (number | null)[];
}

export interface A1Input {
  durationMs: number;
  canonical: QuantitySet | null;
  original: QuantitySet | null;
  levelSeries: LevelSeries | null;
  timeline: {
    gaps: { startMs: number; durationMs: number }[];
    decodeErrors: { count: number; firstAtMs: number | null };
  } | null;
  tier1:
    | { state: 'available'; quantities: Record<string, Quantity>; series: SpeechSeries | null }
    | { state: 'failed' | 'pending' | 'not_requested' };
}

/* -- output --------------------------------------------------------------------------------------- */

export interface EngineFlag {
  kind: DiagnosticFlagKind;
  severity: FlagSeverity;
  startMs: number | null;
  endMs: number | null;
  basis: EvidenceBasis;
  ruleId: string;
  measurementRefs: {
    quantity: string;
    series?: 'level' | 'speech';
    fromIndex?: number;
    toIndex?: number;
  }[];
}

export interface EngineOutput {
  overall: AudioQualityClass;
  confidence: ConfidenceLevel;
  suitability: {
    transcription: { value: Suitability; reasons: string[] };
    diarization: { value: Suitability; reasons: string[] };
  };
  flags: EngineFlag[];
  affectedRatio: number | null;
  notAssessed: NotAssessed[];
  recommendations: { code: string }[];
  tier1: 'available' | 'failed' | 'pending' | 'not_requested';
}

/* -- helpers -------------------------------------------------------------------------------------- */

const SEVERITY_RANK: Record<FlagSeverity, number> = { low: 1, medium: 2, high: 3 };
const BASIS_RANK: Record<EvidenceBasis, number> = { measured: 3, derived: 2, estimate: 1 };

/** Severity when HIGHER values are worse (value >= band). */
export function severityAbove(value: number, bands: Bands): FlagSeverity | null {
  if (value >= bands.high) return 'high';
  if (value >= bands.medium) return 'medium';
  if (value >= bands.low) return 'low';
  return null;
}

/** Severity when LOWER values are worse (value < band). */
export function severityBelow(value: number, bands: Bands): FlagSeverity | null {
  if (value < bands.high) return 'high';
  if (value < bands.medium) return 'medium';
  if (value < bands.low) return 'low';
  return null;
}

export const weakestBasis = (...kinds: EvidenceBasis[]): EvidenceBasis =>
  kinds.reduce((a, b) => (BASIS_RANK[b] < BASIS_RANK[a] ? b : a), 'measured');

/** Contiguous index runs where `pred` holds; returns [fromIndex, toIndexExclusive]. */
export function runs<T>(values: T[], pred: (v: T, i: number) => boolean): [number, number][] {
  const out: [number, number][] = [];
  let start = -1;
  values.forEach((v, i) => {
    if (pred(v, i)) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      out.push([start, i]);
      start = -1;
    }
  });
  if (start >= 0) out.push([start, values.length]);
  return out;
}

const q = (set: QuantitySet | null, name: string): Quantity | undefined => set?.quantities[name];

/* -- rules (fixed order) -------------------------------------------------------------------------- */

type Rule = (input: A1Input, cfg: A1RuleConfig) => EngineFlag[];

const clipping: Rule = (input, cfg) => {
  const ratio = q(input.original, 'clippedRatio');
  if (!ratio) return [];
  const severity = severityAbove(ratio.value, cfg.clipping.ratio);
  if (!severity) return [];
  const flags: EngineFlag[] = [
    {
      kind: 'clipping',
      severity,
      startMs: null,
      endMs: null,
      basis: ratio.kind,
      ruleId: 'clipping.ratio',
      measurementRefs: [{ quantity: 'clippedRatio' }, { quantity: 'clippedRuns' }],
    },
  ];
  const s = input.levelSeries;
  if (s) {
    const minWin = Math.max(1, Math.ceil(cfg.clipping.minRegionMs / s.intervalMs));
    for (const [a, b] of runs(s.peakDbfs, (v) => v !== null && v >= cfg.clipping.regionPeakDbfs)
      .filter(([a, b]) => b - a >= minWin)
      .slice(0, cfg.clipping.maxRegions)) {
      flags.push({
        kind: 'clipping',
        severity,
        startMs: a * s.intervalMs,
        endMs: Math.min(input.durationMs, b * s.intervalMs),
        basis: 'derived',
        ruleId: 'clipping.region',
        measurementRefs: [{ quantity: 'peakDbfs', series: 'level', fromIndex: a, toIndex: b }],
      });
    }
  }
  return flags;
};

const silence: Rule = (input, cfg) => {
  const flags: EngineFlag[] = [];
  const ratio = q(input.canonical, 'silenceRatio');
  if (ratio) {
    const severity = severityAbove(ratio.value, cfg.silence.ratio);
    if (severity)
      flags.push({
        kind: 'silence',
        severity,
        startMs: null,
        endMs: null,
        basis: ratio.kind,
        ruleId: 'silence.ratio',
        measurementRefs: [{ quantity: 'silenceRatio' }],
      });
  }
  const s = input.levelSeries;
  if (s) {
    const minWin = Math.ceil(cfg.silence.minRegionMs / s.intervalMs);
    for (const [a, b] of runs(s.rmsDbfs, (v) => v === null || v < cfg.silence.regionRmsDbfs).filter(
      ([a, b]) => b - a >= minWin,
    )) {
      flags.push({
        kind: 'silence',
        severity: 'low',
        startMs: a * s.intervalMs,
        endMs: Math.min(input.durationMs, b * s.intervalMs),
        basis: 'derived',
        ruleId: 'silence.region',
        measurementRefs: [{ quantity: 'rmsDbfs', series: 'level', fromIndex: a, toIndex: b }],
      });
    }
  }
  return flags;
};

const dropout: Rule = (input, cfg) => {
  const flags: EngineFlag[] = [];
  for (const gap of input.timeline?.gaps ?? []) {
    if (gap.durationMs <= 0) continue;
    flags.push({
      kind: 'dropout',
      severity: 'medium',
      startMs: gap.startMs,
      endMs: gap.startMs + gap.durationMs,
      basis: 'measured',
      ruleId: 'dropout.timestamp_gap',
      measurementRefs: [{ quantity: 'timeline.gaps' }],
    });
  }
  const errors = input.timeline?.decodeErrors;
  if (errors && errors.count > 0) {
    flags.push({
      kind: 'dropout',
      severity: 'medium',
      startMs: null,
      endMs: null,
      basis: 'measured',
      ruleId: 'dropout.decode_errors',
      measurementRefs: [{ quantity: 'timeline.decodeErrors' }],
    });
  }
  // Short digital-zero runs inside otherwise active audio: low severity, because inserted silence
  // (and synthetic fixtures) produce them too.
  const s = input.levelSeries;
  if (s) {
    const minWin = Math.ceil(cfg.dropout.digitalZeroMinMs / s.intervalMs);
    const maxWin = Math.floor(cfg.dropout.digitalZeroMaxMs / s.intervalMs);
    const active = (i: number) => {
      const v = s.rmsDbfs[i];
      return v !== undefined && v !== null && v >= cfg.silence.regionRmsDbfs;
    };
    for (const [a, b] of runs(s.rmsDbfs, (v) => v === null)
      .filter(([a, b]) => b - a >= minWin && b - a <= maxWin && active(a - 1) && active(b))
      .slice(0, cfg.dropout.maxRegions)) {
      flags.push({
        kind: 'dropout',
        severity: 'low',
        startMs: a * s.intervalMs,
        endMs: b * s.intervalMs,
        basis: 'derived',
        ruleId: 'dropout.digital_zero',
        measurementRefs: [{ quantity: 'rmsDbfs', series: 'level', fromIndex: a, toIndex: b }],
      });
    }
  }
  return flags;
};

const lowLevel: Rule = (input, cfg) => {
  if (input.tier1.state === 'available') {
    const level = input.tier1.quantities.activeSpeechLevelDbfs;
    if (!level) return [];
    const severity = severityBelow(level.value, cfg.activeSpeechLevelDbfs);
    return severity
      ? [
          {
            kind: 'low_level',
            severity,
            startMs: null,
            endMs: null,
            basis: level.kind,
            ruleId: 'low_level.speech',
            measurementRefs: [{ quantity: 'activeSpeechLevelDbfs' }],
          },
        ]
      : [];
  }
  const loud = q(input.original, 'integratedLoudnessLufs');
  if (!loud) return [];
  const severity = severityBelow(loud.value, cfg.integratedLoudnessLufs);
  return severity
    ? [
        {
          kind: 'low_level',
          severity,
          startMs: null,
          endMs: null,
          basis: loud.kind,
          ruleId: 'low_level.loudness',
          measurementRefs: [{ quantity: 'integratedLoudnessLufs' }],
        },
      ]
    : [];
};

const noise: Rule = (input, cfg) => {
  if (input.tier1.state !== 'available') {
    // Tier 0 fallback: the noise floor estimate (not an SNR).
    const floor = q(input.canonical, 'noiseFloorDbfs');
    if (!floor) return [];
    const severity = severityAbove(floor.value, cfg.noiseFloorDbfs);
    return severity
      ? [
          {
            kind: 'noise',
            severity,
            startMs: null,
            endMs: null,
            basis: 'estimate',
            ruleId: 'noise.floor',
            measurementRefs: [{ quantity: 'noiseFloorDbfs' }],
          },
        ]
      : [];
  }
  const flags: EngineFlag[] = [];
  const snr = input.tier1.quantities.snrDb;
  if (snr) {
    const severity = severityBelow(snr.value, cfg.snrDb);
    if (severity)
      flags.push({
        kind: 'noise',
        severity,
        startMs: null,
        endMs: null,
        basis: 'estimate',
        ruleId: 'noise.snr',
        measurementRefs: [{ quantity: 'snrDb' }],
      });
  }
  const s = input.tier1.series;
  if (s) {
    const minBlocks = Math.max(1, Math.ceil(cfg.snrRegion.minRegionMs / s.blockMs));
    const sev = (v: number | null) => (v === null ? null : severityBelow(v, cfg.snrDb));
    // Regions of consecutive blocks at medium or high severity; the region takes its worst block.
    const regions = runs(s.snrDb, (v) => {
      const x = sev(v);
      return x === 'medium' || x === 'high';
    })
      .filter(([a, b]) => b - a >= minBlocks)
      .slice(0, cfg.snrRegion.maxRegions);
    for (const [a, b] of regions) {
      const worst = s.snrDb
        .slice(a, b)
        .map(sev)
        .reduce<FlagSeverity>((w, x) => (x && SEVERITY_RANK[x] > SEVERITY_RANK[w] ? x : w), 'low');
      flags.push({
        kind: 'noise',
        severity: worst,
        startMs: a * s.blockMs,
        endMs: Math.min(input.durationMs, b * s.blockMs),
        basis: 'estimate',
        ruleId: 'noise.snr_region',
        measurementRefs: [{ quantity: 'snrDb', series: 'speech', fromIndex: a, toIndex: b }],
      });
    }
  }
  return flags;
};

const speechPresence: Rule = (input, cfg) => {
  if (input.tier1.state !== 'available') return [];
  const ratio = input.tier1.quantities.speechRatio;
  if (!ratio) return [];
  const severity = severityBelow(ratio.value, cfg.speechPresence.ratio);
  return severity
    ? [
        {
          kind: 'low_speech_presence',
          severity,
          startMs: null,
          endMs: null,
          basis: ratio.kind,
          ruleId: 'speech.presence',
          measurementRefs: [{ quantity: 'speechRatio' }],
        },
      ]
    : [];
};

const narrowband: Rule = (input, cfg) => {
  if (input.tier1.state !== 'available') return [];
  const edge = input.tier1.quantities.bandwidthEdgeHz;
  if (!edge) return [];
  const severity: FlagSeverity | null =
    edge.value < cfg.bandwidthHz.medium
      ? 'medium'
      : edge.value < cfg.bandwidthHz.low
        ? 'low'
        : null;
  return severity
    ? [
        {
          kind: 'narrowband',
          severity,
          startMs: null,
          endMs: null,
          basis: 'estimate',
          ruleId: 'bandwidth.edge',
          measurementRefs: [{ quantity: 'bandwidthEdgeHz' }],
        },
      ]
    : [];
};

const levelConsistency: Rule = (input, cfg) => {
  if (input.tier1.state !== 'available') return [];
  const spread = input.tier1.quantities.levelSpreadDb;
  if (!spread) return [];
  const severity: FlagSeverity | null =
    spread.value > cfg.levelSpreadDb.medium
      ? 'medium'
      : spread.value > cfg.levelSpreadDb.low
        ? 'low'
        : null;
  return severity
    ? [
        {
          kind: 'level_inconsistency',
          severity,
          startMs: null,
          endMs: null,
          basis: 'estimate',
          ruleId: 'level.spread',
          measurementRefs: [{ quantity: 'levelSpreadDb' }],
        },
      ]
    : [];
};

const fragmentation: Rule = (input, cfg) => {
  if (input.tier1.state !== 'available') return [];
  const spans = input.tier1.quantities.maxSpansPerWindow;
  if (!spans) return [];
  const severity: FlagSeverity | null =
    spans.value > cfg.spansPerWindow.medium
      ? 'medium'
      : spans.value > cfg.spansPerWindow.low
        ? 'low'
        : null;
  return severity
    ? [
        {
          kind: 'fragmented_speech',
          severity,
          startMs: null,
          endMs: null,
          basis: 'derived',
          ruleId: 'speech.fragmentation',
          measurementRefs: [{ quantity: 'maxSpansPerWindow' }],
        },
      ]
    : [];
};

const RULES: Rule[] = [
  clipping,
  silence,
  dropout,
  lowLevel,
  noise,
  speechPresence,
  narrowband,
  levelConsistency,
  fragmentation,
];

/* -- combination ---------------------------------------------------------------------------------- */

const TRANSCRIPTION_KINDS: DiagnosticFlagKind[] = [
  'noise',
  'clipping',
  'low_level',
  'dropout',
  'low_speech_presence',
  'narrowband',
];
const DIARIZATION_KINDS: DiagnosticFlagKind[] = [
  'noise',
  'low_level',
  'level_inconsistency',
  'narrowband',
  'low_speech_presence',
  'dropout',
];

const RECOMMENDATION: Partial<Record<DiagnosticFlagKind, string>> = {
  noise: 'reduce_background_noise',
  clipping: 'lower_input_gain',
  low_level: 'move_closer_or_raise_gain',
  dropout: 'check_recording_device',
  silence: 'check_long_silences',
  low_speech_presence: 'upload_recording_with_speech',
  narrowband: 'use_wideband_or_lossless_format',
  level_inconsistency: 'keep_consistent_microphone_distance',
  fragmented_speech: 'expect_slower_transcription',
};

/** Share of the reference time (speech blocks with Tier 1, else the whole duration) covered by flags. */
function coverage(flags: EngineFlag[], input: A1Input): number {
  if (input.durationMs <= 0) return 0;
  if (flags.some((f) => f.startMs === null)) return 1;
  const series = input.tier1.state === 'available' ? input.tier1.series : null;
  if (series) {
    let speech = 0;
    let covered = 0;
    series.speechMs.forEach((ms, i) => {
      if (ms <= 0) return;
      speech += ms;
      const a = i * series.blockMs;
      const b = a + series.blockMs;
      if (flags.some((f) => (f.startMs ?? 0) < b && (f.endMs ?? 0) > a)) covered += ms;
    });
    return speech > 0 ? covered / speech : 0;
  }
  const ranges = flags
    .map((f) => [f.startMs ?? 0, f.endMs ?? 0] as [number, number])
    .sort((x, y) => x[0] - y[0]);
  let total = 0;
  let end = -1;
  for (const [a, b] of ranges) {
    const start = Math.max(a, end);
    if (b > start) total += b - start;
    end = Math.max(end, b);
  }
  return Math.min(1, total / input.durationMs);
}

function suitabilityFor(
  kinds: DiagnosticFlagKind[],
  flags: EngineFlag[],
  input: A1Input,
  cfg: A1RuleConfig,
): { value: Suitability; reasons: string[] } {
  const relevant = flags.filter((f) => kinds.includes(f.kind) && f.severity !== 'low');
  const reasons = [...new Set(relevant.map((f) => f.kind as string))];
  const high = relevant.filter((f) => f.severity === 'high');
  if (high.length && coverage(high, input) > cfg.poorCoverage)
    return { value: 'unreliable', reasons };
  if (relevant.length) return { value: 'limited', reasons };
  return { value: 'suitable', reasons };
}

export function assess(input: A1Input, cfg: A1RuleConfig): EngineOutput {
  const flags = RULES.flatMap((rule) => rule(input, cfg));
  const tier1 = input.tier1.state;
  const notAssessed: NotAssessed[] = [
    { dimension: 'distortion', reason: 'no_reference_free_detector' },
    { dimension: 'reverberation', reason: 'not_supported_v1' },
  ];
  if (tier1 !== 'available') {
    for (const dimension of [
      'snr',
      'speech_presence',
      'bandwidth',
      'level_consistency',
      'fragmentation',
    ])
      notAssessed.push({ dimension, reason: `measure_${tier1}` });
  }

  // insufficient: no usable audio, or (with Tier 1) no usable speech. Never a run failure (ADR-0008).
  const peak = q(input.canonical, 'peakDbfs');
  const silentAudio = !peak || peak.value < cfg.silentPeakDbfs;
  let noSpeech = false;
  if (input.tier1.state === 'available') {
    const ratio = input.tier1.quantities.speechRatio;
    const ms = input.tier1.quantities.speechMs;
    noSpeech =
      (ratio !== undefined && ratio.value < cfg.speechPresence.insufficientRatio) ||
      (ms !== undefined && ms.value < cfg.speechPresence.insufficientMs);
  }

  const medHigh = flags.filter((f) => f.severity !== 'low');
  const high = flags.filter((f) => f.severity === 'high');
  const affectedRatio = medHigh.length ? coverage(medHigh, input) : 0;

  let overall: AudioQualityClass;
  if (silentAudio || noSpeech) overall = 'insufficient';
  else if (high.length && coverage(high, input) > cfg.poorCoverage) overall = 'poor';
  else if (medHigh.length) overall = 'acceptable_with_warnings';
  else overall = 'good';

  // Confidence (categorical, ADR-0043): low without a speech split or for very short audio;
  // otherwise high only when the deciding flags rest on measured/derived values.
  let confidence: ConfidenceLevel;
  if (tier1 !== 'available' || input.durationMs < cfg.minAssessableMs) confidence = 'low';
  else if (overall === 'insufficient' && silentAudio) confidence = 'high';
  else {
    const deciding = overall === 'poor' ? high : medHigh;
    confidence =
      deciding.length && deciding.every((f) => f.basis !== 'estimate') ? 'high' : 'medium';
  }

  const transcription =
    overall === 'insufficient'
      ? {
          value: 'not_assessable' as const,
          reasons: [silentAudio ? 'no_usable_audio' : 'no_usable_speech'],
        }
      : suitabilityFor(TRANSCRIPTION_KINDS, flags, input, cfg);
  if (overall !== 'insufficient') {
    if (flags.some((f) => f.kind === 'fragmented_speech' && f.severity !== 'low'))
      transcription.reasons.push('deadline_risk');
    if (flags.some((f) => f.kind === 'noise' && f.severity === 'high'))
      transcription.reasons.push('language_id_risk');
    if (tier1 !== 'available') transcription.reasons.push('speech_measurements_unavailable');
  }
  const diarization =
    overall === 'insufficient' || input.durationMs < cfg.minAssessableMs
      ? {
          value: 'not_assessable' as const,
          reasons: [overall === 'insufficient' ? 'no_usable_speech' : 'too_short'],
        }
      : suitabilityFor(DIARIZATION_KINDS, flags, input, cfg);

  const codes = new Set<string>();
  if (overall === 'insufficient') codes.add('new_recording_recommended');
  for (const f of medHigh) {
    const code = RECOMMENDATION[f.kind];
    if (code) codes.add(code);
  }

  return {
    overall,
    confidence,
    suitability: { transcription, diarization },
    flags,
    affectedRatio: Math.round(affectedRatio * 10_000) / 10_000,
    notAssessed,
    recommendations: [...codes].sort().map((code) => ({ code })),
    tier1,
  };
}
