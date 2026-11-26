import { z } from 'zod';
import { AudioMeasurementRecord, AudioTier1Record } from './audio-service.js';
import { IsoDateTime, Uuid } from './common.js';

/* ------------------------------------------------------------------------------------------------
 * Phase 3A: Audio Quality Agent (A1) contracts (ADR-0043 / ADR-0044 / ADR-0046, accepted
 * 2026-11-26; design `docs/development/phase3a/A1_DESIGN.md` §4). Framework-independent: the
 * BullMQ job in Phase 3A and a LangGraph node later are both adapters over these shapes.
 * Enum arrays are the single source for database checks.
 * ---------------------------------------------------------------------------------------------- */

/** `pipeline_stage_runs.node` values. `RUN_STAGES` stays the transcription run scope (ADR-0044). */
export const STAGE_NODES = ['transcription', 'diarization', 'audio_quality'] as const;
export const StageNode = z.enum(STAGE_NODES);
export type StageNode = z.infer<typeof StageNode>;

export const AUDIO_QUALITY_CLASSES = [
  'good',
  'acceptable_with_warnings',
  'poor',
  'insufficient',
] as const;
export const AudioQualityClass = z.enum(AUDIO_QUALITY_CLASSES);
export type AudioQualityClass = z.infer<typeof AudioQualityClass>;

export const SUITABILITY_VALUES = ['suitable', 'limited', 'unreliable', 'not_assessable'] as const;
export const Suitability = z.enum(SUITABILITY_VALUES);
export type Suitability = z.infer<typeof Suitability>;

/** ADR-0043 flag kinds. `distortion` is reserved and not emitted in v1. */
export const DIAGNOSTIC_FLAG_KINDS = [
  'noise',
  'clipping',
  'distortion',
  'dropout',
  'silence',
  'low_level',
  'low_speech_presence',
  'narrowband',
  'level_inconsistency',
  'fragmented_speech',
] as const;
export const DiagnosticFlagKind = z.enum(DIAGNOSTIC_FLAG_KINDS);
export type DiagnosticFlagKind = z.infer<typeof DiagnosticFlagKind>;

export const FLAG_SEVERITIES = ['low', 'medium', 'high'] as const;
export const FlagSeverity = z.enum(FLAG_SEVERITIES);
export type FlagSeverity = z.infer<typeof FlagSeverity>;

/** The weakest kind of the quantities a flag rests on (measured > derived > estimate). */
export const EVIDENCE_BASES = ['measured', 'derived', 'estimate'] as const;
export const EvidenceBasis = z.enum(EVIDENCE_BASES);
export type EvidenceBasis = z.infer<typeof EvidenceBasis>;

/** Categorical, rule-derived; never a calibrated probability (ADR-0043). */
export const CONFIDENCE_LEVELS = ['high', 'medium', 'low'] as const;
export const ConfidenceLevel = z.enum(CONFIDENCE_LEVELS);
export type ConfidenceLevel = z.infer<typeof ConfidenceLevel>;

/** Lifecycle of a preprocessing-scoped speech-aware measurement set (ADR-0045). */
export const MEASUREMENT_SET_STATUSES = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
] as const;
export const MeasurementSetStatus = z.enum(MEASUREMENT_SET_STATUSES);
export type MeasurementSetStatus = z.infer<typeof MeasurementSetStatus>;

export const SuitabilityEntry = z
  .object({ value: Suitability, reasons: z.array(z.string().max(64)).max(32) })
  .strict();
export type SuitabilityEntry = z.infer<typeof SuitabilityEntry>;

export const NotAssessed = z
  .object({ dimension: z.string().max(64), reason: z.string().max(64) })
  .strict();
export type NotAssessed = z.infer<typeof NotAssessed>;

export const TIER1_STATES = ['available', 'failed', 'pending', 'not_requested'] as const;

/** The A1 summary other components may read (ADR-0046). Versioned. */
export const AudioQualitySummary = z
  .object({
    schemaVersion: z.literal(1),
    diagnosticsId: Uuid,
    runId: Uuid,
    preprocessingId: Uuid,
    ruleVersion: z.string().min(1).max(64),
    /**
     * True for assessments made with a provisional rule version (`a1-rules-0.1-provisional`);
     * never rewritten (ADR-0048).
     */
    provisional: z.boolean(),
    overall: AudioQualityClass,
    confidence: ConfidenceLevel,
    suitability: z
      .object({ transcription: SuitabilityEntry, diarization: SuitabilityEntry })
      .strict(),
    flagCounts: z.partialRecord(
      DiagnosticFlagKind,
      z.partialRecord(FlagSeverity, z.number().int()),
    ),
    /** Share of speech time (or of all time without a speech split) covered by medium/high flags. */
    affectedRatio: z.number().min(0).max(1).nullable(),
    notAssessed: z.array(NotAssessed).max(32),
    tier1: z.enum(TIER1_STATES),
    createdAt: IsoDateTime,
  })
  .strict();
export type AudioQualitySummary = z.infer<typeof AudioQualitySummary>;

export const MeasurementRef = z
  .object({
    quantity: z.string().max(64),
    series: z.enum(['level', 'speech']).optional(),
    fromIndex: z.number().int().nonnegative().optional(),
    toIndex: z.number().int().nonnegative().optional(),
  })
  .strict();

export const AudioDiagnosticFlag = z
  .object({
    id: Uuid,
    kind: DiagnosticFlagKind,
    severity: FlagSeverity,
    /** Both null = whole recording. Canonical timeline, integer ms, half-open. */
    startMs: z.number().int().nonnegative().nullable(),
    endMs: z.number().int().positive().nullable(),
    basis: EvidenceBasis,
    ruleId: z.string().max(64),
    measurementRefs: z.array(MeasurementRef).max(16),
  })
  .strict();
export type AudioDiagnosticFlag = z.infer<typeof AudioDiagnosticFlag>;

/** Read view for other agents (ADR-0046): summary plus flag kinds, severities and time ranges. */
export const AudioQualityContext = z
  .object({
    summary: AudioQualitySummary,
    flags: z.array(
      AudioDiagnosticFlag.pick({ kind: true, severity: true, startMs: true, endMs: true }),
    ),
  })
  .strict();
export type AudioQualityContext = z.infer<typeof AudioQualityContext>;

export type AudioQualityLookup =
  | { status: 'available'; context: AudioQualityContext }
  | { status: 'unavailable' | 'pending' | 'failed' };

/** Read-only port (ADR-0046). Implemented over A1's tables; no write method exists. */
export interface AudioQualityReader {
  get(q: {
    workspaceId: string;
    runId: string;
    preprocessingId: string;
  }): Promise<AudioQualityLookup>;
}

/** Shared-graph state slice, written only by A1 (AGENT_ARCHITECTURE §3). */
export const AudioQualityStateSlice = z
  .object({ diagnosticsId: Uuid, overall: AudioQualityClass, confidence: ConfidenceLevel })
  .strict();
export type AudioQualityStateSlice = z.infer<typeof AudioQualityStateSlice>;

/** A1 node boundary (D-3A-02): the same function runs under BullMQ now and a graph node later. */
export const A1NodeInput = z
  .object({
    workspaceId: Uuid,
    runId: Uuid,
    preprocessingId: Uuid,
    measurementSetId: Uuid.nullable(),
  })
  .strict();
export type A1NodeInput = z.infer<typeof A1NodeInput>;

export const A1NodeOutput = z
  .object({ diagnosticsId: Uuid, stateSlice: AudioQualityStateSlice })
  .strict();
export type A1NodeOutput = z.infer<typeof A1NodeOutput>;

/* -- API (§4) ------------------------------------------------------------------------------------ */

export const AUDIO_DIAGNOSTICS_STATES = [
  'not_started',
  'pending',
  'running',
  'completed',
  'failed',
  'cancelled',
] as const;

export const Recommendation = z.object({ code: z.string().max(64) }).strict();

export const AudioDiagnostics = z
  .object({
    summary: AudioQualitySummary,
    recommendations: z.array(Recommendation).max(16),
    flags: z.array(AudioDiagnosticFlag),
    /** The objective records the assessment was based on (FR-3.1); numbers only. */
    measurements: z.array(AudioMeasurementRecord),
    /** The speech-aware (Tier 1) record when the assessment used one (ADR-0045); else null. */
    tier1Record: AudioTier1Record.nullable(),
  })
  .strict();
export type AudioDiagnostics = z.infer<typeof AudioDiagnostics>;

/** `GET /runs/{runId}/audio-diagnostics`. `diagnostics` is null until A1 has completed. */
export const AudioDiagnosticsSnapshot = z
  .object({
    runId: Uuid,
    state: z.enum(AUDIO_DIAGNOSTICS_STATES),
    stage: z
      .object({
        attempt: z.number().int().positive(),
        error: z.object({ code: z.string() }).nullable(),
      })
      .nullable(),
    measurementSet: z
      .object({ status: MeasurementSetStatus, error: z.object({ code: z.string() }).nullable() })
      .nullable(),
    diagnostics: AudioDiagnostics.nullable(),
  })
  .strict();
export type AudioDiagnosticsSnapshot = z.infer<typeof AudioDiagnosticsSnapshot>;
