/**
 * A1 rule configuration (ADR-0043). Thresholds approved by the user on 2026-11-26 (OD-52,
 * ADR-0048) from the Phase 3A M6 calibration. Assessments made with the earlier provisional
 * version keep `provisional: true` and their rule version; they are never rewritten.
 *
 * Changes from `a1-rules-0.1-provisional` (M6 production STT, `phase3a-quality-benchmark/`):
 * - clipping high band 1 % -> 5 % clipped samples (x4 clipping, 2.3-4.2 %, costs about as much
 *   WER as 10 dB noise: a warning, not `poor`);
 * - active speech level medium band -50 -> -45 dBFS (-30 dB attenuation, speech near -48 dBFS,
 *   costs +4-8 WER points);
 * - the SNR estimate uses the near-clean median switch (measure config `snrNearCleanDb`).
 *
 * Anchors (all synthetic-corpus evidence, never real-world accuracy):
 * - SNR bands: E7 production STT WER (English) 6.7 % clean, 7.5 % at 20 dB, 12.6 % at 10 dB,
 *   15.4 % at 5 dB (ADR-0036); M0 VAD-split SNR error ~1.5 dB, biased low (phase3a-quality-benchmark).
 * - Fragmentation: ADR-0041, windows with more than about 8 speech spans exceed the 240 s deadline.
 * - Silence level: the preprocessing silence threshold (-50 dBFS, processing.ts).
 * Bands without a direct anchor (silence ratio, loudness, noise floor, level spread, speech
 * presence, poor coverage 0.2) were accepted as they are; they need real-speech data (D-3A-13).
 */
export interface Bands {
  low: number;
  medium: number;
  high: number;
}

export interface A1RuleConfig {
  ruleVersion: string;
  provisional: boolean;
  /** Recordings shorter than this are assessed with low confidence; diarization not assessable. */
  minAssessableMs: number;
  /** Canonical peak below this (or digital silence) = no usable audio -> insufficient. */
  silentPeakDbfs: number;
  clipping: { ratio: Bands; regionPeakDbfs: number; minRegionMs: number; maxRegions: number };
  silence: { regionRmsDbfs: number; minRegionMs: number; ratio: Bands };
  /** Flag when the value is BELOW the band (lower is worse). */
  integratedLoudnessLufs: Bands;
  activeSpeechLevelDbfs: Bands;
  /** Tier 0 only (no speech split): flag when the noise floor is ABOVE the band. */
  noiseFloorDbfs: Bands;
  dropout: { digitalZeroMinMs: number; digitalZeroMaxMs: number; maxRegions: number };
  /** Flag when SNR is BELOW the band. Region flags use the same bands on 1 s blocks. */
  snrDb: Bands;
  snrRegion: { minRegionMs: number; maxRegions: number };
  speechPresence: { insufficientRatio: number; insufficientMs: number; ratio: Bands };
  /** Flag when the effective bandwidth edge is BELOW the band (Hz). */
  bandwidthHz: { low: number; medium: number };
  /** Flag when the inter-block speech-level spread is ABOVE the band (dB). */
  levelSpreadDb: { low: number; medium: number };
  /** Flag when the maximum speech spans per 30 s transcription window is ABOVE the band. */
  spansPerWindow: { low: number; medium: number };
  /** `poor` when high-severity flags cover more than this share of speech time (or of all time). */
  poorCoverage: number;
}

export const A1_RULE_CONFIG: A1RuleConfig = {
  ruleVersion: 'a1-rules-1.0',
  provisional: false,
  minAssessableMs: 3000,
  silentPeakDbfs: -60,
  clipping: {
    ratio: { low: 0.00001, medium: 0.001, high: 0.05 },
    regionPeakDbfs: -0.1,
    minRegionMs: 100,
    maxRegions: 200,
  },
  silence: { regionRmsDbfs: -50, minRegionMs: 5000, ratio: { low: 0.5, medium: 0.75, high: 0.95 } },
  integratedLoudnessLufs: { low: -35, medium: -45, high: -55 },
  activeSpeechLevelDbfs: { low: -40, medium: -45, high: -60 },
  noiseFloorDbfs: { low: -50, medium: -40, high: -30 },
  dropout: { digitalZeroMinMs: 200, digitalZeroMaxMs: 2000, maxRegions: 200 },
  snrDb: { low: 20, medium: 10, high: 5 },
  snrRegion: { minRegionMs: 3000, maxRegions: 200 },
  speechPresence: {
    insufficientRatio: 0.02,
    insufficientMs: 1000,
    ratio: { low: 0.3, medium: 0.15, high: 0.05 },
  },
  bandwidthHz: { low: 6000, medium: 3800 },
  levelSpreadDb: { low: 12, medium: 20 },
  spansPerWindow: { low: 6, medium: 8 },
  poorCoverage: 0.2,
};
