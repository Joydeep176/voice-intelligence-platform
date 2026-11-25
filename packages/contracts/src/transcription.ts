import { z } from 'zod';
import { IsoDateTime, Uuid } from './common.js';
import { ProcessingStatus } from './runs.js';

/* ------------------------------------------------------------------------------------------------
 * Phase 2C: transcription and diarization foundation (D-2C-01..03, DATABASE_DESIGN §4,
 * API §3 / §5, LLD §3.2). Enum arrays are the single source for the database enums and checks.
 * ---------------------------------------------------------------------------------------------- */

/** Stage scope of a run (D-2C-01). `completed` means the scoped stages completed, never the full pipeline. */
export const RUN_STAGES = ['transcription', 'diarization'] as const;
export const RunStage = z.enum(RUN_STAGES);
export type RunStage = z.infer<typeof RunStage>;

/** `pipeline_stage_runs.status`. `pending` is only ever derived for a stage with no row yet. */
export const STAGE_STATUSES = ['running', 'completed', 'failed', 'cancelled'] as const;
export const StageStatus = z.enum([...STAGE_STATUSES, 'pending']);
export type StageStatus = z.infer<typeof StageStatus>;

export const TRANSCRIPT_LANGUAGES = ['en', 'hi', 'mixed'] as const;
export const TranscriptLanguage = z.enum(TRANSCRIPT_LANGUAGES);
export type TranscriptLanguage = z.infer<typeof TranscriptLanguage>;

export const TRANSCRIPT_VERSION_KINDS = ['machine', 'user_correction'] as const;
export const TranscriptVersionKind = z.enum(TRANSCRIPT_VERSION_KINDS);

export const UNCERTAINTY_KINDS = [
  'low_confidence',
  'inaudible',
  'overlapping_speech',
  'language_uncertain',
  'speaker_uncertain',
] as const;
export const UncertaintyKind = z.enum(UNCERTAINTY_KINDS);
export type UncertaintyKind = z.infer<typeof UncertaintyKind>;

export const RAW_OUTPUT_SCOPES = ['whole', 'window'] as const;

/** Where the transcription windows came from (D-2C-02). Recorded on every run. */
export const WINDOW_SOURCES = ['vad_segments', 'fixed_windows'] as const;
export const WindowSource = z.enum(WINDOW_SOURCES);
export type WindowSource = z.infer<typeof WindowSource>;

/** INTERIM (OD-10 Open, D-2C-02): fixed window length and overlap used when there are no VAD segments. */
export const INTERIM_TRANSCRIPTION_WINDOW = { windowMs: 30_000, overlapMs: 1_000 } as const;
/** INTERIM (OD-10 Open): limit on re-executions of one run (user retries and sweeper recoveries). */
export const INTERIM_RUN_MAX_RETRIES = 3;

/** Provider id of the deterministic development adapters (ADR-0012). */
export const FAKE_PROVIDER_ID = 'fake';

/* ------------------------------------------------------------------------------------------------
 * Provider-neutral adapter interfaces (LLD §3.2). Types only: adapters live in the orchestrator.
 * Raw provider output is stored first (immutable, ADR-0007); `mapRaw` re-derives the neutral shape
 * from a stored payload so a retry never re-calls the provider for output it already holds.
 * Confidence is optional and NEVER fabricated: absent when the provider reports none.
 * ---------------------------------------------------------------------------------------------- */

export interface ProviderRawRef {
  payloadUri: string;
  /** Lowercase hex SHA-256 of the stored payload bytes. */
  sha256: string;
  providerModel: string;
}

export interface SttWord {
  startMs: number;
  endMs: number;
  text: string;
  confidence?: number;
}

export interface SttSegment {
  /** Absolute positions on the canonical timeline. */
  startMs: number;
  endMs: number;
  text: string;
  language: TranscriptLanguage;
  codeSwitchSpans?: { startChar: number; endChar: number; language: 'en' | 'hi' }[];
  confidence?: number;
  words?: SttWord[];
}

/**
 * Where the canonical audio lives, for self-hosted adapters that read it through the audio service
 * (ADR-0002): the recording and the preprocessing version (its config hash names the storage
 * prefix). Managed and fake providers ignore it and use `audioUri`.
 */
export interface AudioSourceRef {
  workspaceId: string;
  recordingId: string;
  preprocessingConfigHash: string;
}

export interface SttWindow {
  index: number;
  startMs: number;
  endMs: number;
}

export interface SttRequest {
  audioUri: string;
  /** Position of the window start on the canonical timeline; returned segment times are absolute. */
  offsetMs: number;
  window: SttWindow;
  /** Duration of the whole canonical recording (segment times never exceed it). */
  audioDurationMs: number;
  languageHints?: ('en' | 'hi')[];
  /** Storage key the adapter must write the raw payload to (atomic) before returning. */
  rawKey: string;
  source?: AudioSourceRef;
}

export interface SpeechToTextProvider {
  readonly id: string;
  readonly model: string;
  capabilities(): {
    languages: ('en' | 'hi')[];
    codeSwitching: boolean;
    wordTimestamps: boolean;
    diarization: boolean;
    maxInputSeconds?: number;
    /** True for deterministic development adapters: their output is not a real transcription. */
    fake: boolean;
  };
  transcribe(req: SttRequest): Promise<{ raw: ProviderRawRef; segments: SttSegment[] }>;
  mapRaw(payload: unknown, req: SttRequest): SttSegment[];
}

export interface DiarizationTurn {
  startMs: number;
  endMs: number;
  speakerKey: string;
  confidence?: number;
}

export interface DiarizationRequest {
  audioUri: string;
  durationMs: number;
  expectedSpeakers?: number;
  /** ADR-0016 windowing hook: absent = whole file. Whole-file only is implemented. */
  window?: { startMs: number; endMs: number };
  rawKey: string;
  source?: AudioSourceRef;
}

export interface DiarizationProvider {
  readonly id: string;
  readonly model: string;
  capabilities(): { maxInputSeconds?: number; windowed: boolean; fake: boolean };
  diarize(req: DiarizationRequest): Promise<{ raw: ProviderRawRef; turns: DiarizationTurn[] }>;
  mapRaw(payload: unknown, req: DiarizationRequest): DiarizationTurn[];
}

/* ------------------------------------------------------------------------------------------------
 * Run snapshot (API §3).
 * ---------------------------------------------------------------------------------------------- */

export const RunProviderRef = z.object({
  id: z.string().min(1).max(64),
  model: z.string().min(1).max(128),
  /** True for the fake adapters: the UI must show that the output is not real. */
  fake: z.boolean(),
});
export type RunProviderRef = z.infer<typeof RunProviderRef>;

/** `pipeline_runs.config`: stage scope + provider ids/versions + window source and parameters. */
export const RunConfig = z.object({
  schemaVersion: z.literal(1),
  stages: z.array(RunStage).min(1),
  languageHints: z
    .array(z.enum(['en', 'hi']))
    .max(2)
    .optional(),
  providers: z.object({ stt: RunProviderRef, diarization: RunProviderRef }).optional(),
  window: z
    .object({
      source: WindowSource,
      windowMs: z.number().int().positive().nullable(),
      overlapMs: z.number().int().min(0).nullable(),
      count: z.number().int().min(0),
    })
    .optional(),
});
export type RunConfig = z.infer<typeof RunConfig>;

export const StageProgress = z.object({
  fraction: z.number().min(0).max(1),
  processedMs: z.number().int().min(0),
  updatedAt: IsoDateTime,
});
export type StageProgress = z.infer<typeof StageProgress>;

export const RunStageSnapshot = z.object({
  node: RunStage,
  status: StageStatus,
  attempt: z.number().int().min(0),
  progress: StageProgress.nullable(),
  startedAt: IsoDateTime.nullable(),
  finishedAt: IsoDateTime.nullable(),
  error: z.object({ code: z.string().max(64) }).nullable(),
});
export type RunStageSnapshot = z.infer<typeof RunStageSnapshot>;

/**
 * `GET /runs/{runId}`: a superset of `ProcessingStatus` (existing consumers keep working).
 * Content-free. `hasLimitations` and cost are not part of Phase 2C.
 */
export const RunSnapshot = ProcessingStatus.extend({
  preprocessingId: Uuid.nullable(),
  /** Stage scope of this run (D-2C-01). */
  scope: z.array(RunStage),
  stages: z.array(RunStageSnapshot),
  providers: z.object({ stt: RunProviderRef, diarization: RunProviderRef }).nullable(),
  window: RunConfig.shape.window.unwrap().nullable(),
  retryCount: z.number().int().min(0),
  maxRetries: z.number().int().min(0),
  cancelRequested: z.boolean(),
  transcriptAvailable: z.boolean(),
});
export type RunSnapshot = z.infer<typeof RunSnapshot>;

/** `POST /recordings/{id}/runs` body. Only `languageHints` is supported in Phase 2C. */
export const StartRunBody = z.strictObject({
  languageHints: z
    .array(z.enum(['en', 'hi']))
    .max(2)
    .optional(),
});
export type StartRunBody = z.infer<typeof StartRunBody>;

/* ------------------------------------------------------------------------------------------------
 * Transcript read DTOs (API §5).
 * ---------------------------------------------------------------------------------------------- */

export const TranscriptVersionDto = z.object({
  id: Uuid,
  version: z.number().int().min(1),
  kind: TranscriptVersionKind,
  baseVersionId: Uuid.nullable(),
  createdBy: z.string().max(128),
  note: z.string().nullable(),
  createdAt: IsoDateTime,
  segmentCount: z.number().int().min(0),
});
export type TranscriptVersionDto = z.infer<typeof TranscriptVersionDto>;

export const TranscriptVersionList = z.object({ items: z.array(TranscriptVersionDto) });
export type TranscriptVersionList = z.infer<typeof TranscriptVersionList>;

export const CodeSwitchSpan = z.object({
  startChar: z.number().int().min(0),
  endChar: z.number().int().min(0),
  language: z.enum(['en', 'hi']),
});

export const TranscriptWordDto = z.object({
  startMs: z.number().int().min(0),
  endMs: z.number().int().min(0),
  text: z.string(),
  confidence: z.number().min(0).max(1).optional(),
});

export const TranscriptSegmentDto = z.object({
  id: Uuid,
  speakerId: Uuid.nullable(),
  startMs: z.number().int().min(0),
  endMs: z.number().int().min(0),
  text: z.string(),
  language: TranscriptLanguage,
  codeSwitchSpans: z.array(CodeSwitchSpan).nullable(),
  /** Null when the provider reported none: never estimated. */
  confidence: z.number().min(0).max(1).nullable(),
  words: z.array(TranscriptWordDto).nullable(),
});
export type TranscriptSegmentDto = z.infer<typeof TranscriptSegmentDto>;

const TimeRangeQuery = {
  version: z.coerce.number().int().min(1).optional(),
  fromMs: z.coerce.number().int().min(0).optional(),
  toMs: z.coerce.number().int().min(0).optional(),
  cursor: z.string().max(200).optional(),
};

export const TranscriptQuery = z.object({
  ...TimeRangeQuery,
  limit: z.coerce.number().int().min(1).max(1000).default(200),
});
export type TranscriptQuery = z.infer<typeof TranscriptQuery>;

export const TranscriptPage = z.object({
  runId: Uuid,
  transcriptId: Uuid,
  version: z.number().int().min(1),
  kind: TranscriptVersionKind,
  windowSource: WindowSource.nullable(),
  providers: z.object({ stt: RunProviderRef, diarization: RunProviderRef }).nullable(),
  items: z.array(TranscriptSegmentDto),
  nextCursor: z.string().nullable(),
});
export type TranscriptPage = z.infer<typeof TranscriptPage>;

export const UncertaintyDto = z.object({
  id: Uuid,
  segmentId: Uuid.nullable(),
  startMs: z.number().int().min(0),
  endMs: z.number().int().min(0),
  kind: UncertaintyKind,
  score: z.number().min(0).max(1).nullable(),
});
export type UncertaintyDto = z.infer<typeof UncertaintyDto>;

export const UncertaintyList = z.object({
  version: z.number().int().min(1),
  items: z.array(UncertaintyDto),
  nextCursor: z.string().nullable(),
});
export type UncertaintyList = z.infer<typeof UncertaintyList>;

/** Raw provider output reference: metadata only, never a storage URI or content (signed URLs: not implemented). */
export const RawOutputDto = z.object({
  id: Uuid,
  kind: z.enum(['stt', 'diarization']),
  provider: z.string(),
  providerModel: z.string().nullable(),
  scope: z.enum(RAW_OUTPUT_SCOPES),
  windowIndex: z.number().int().min(0).nullable(),
  windowStartMs: z.number().int().min(0).nullable(),
  windowEndMs: z.number().int().min(0).nullable(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  receivedAt: IsoDateTime,
  fake: z.boolean(),
});
export type RawOutputDto = z.infer<typeof RawOutputDto>;

export const RawOutputList = z.object({ items: z.array(RawOutputDto) });
export type RawOutputList = z.infer<typeof RawOutputList>;

export const SpeakerDto = z.object({
  id: Uuid,
  speakerKey: z.string().min(1).max(64),
  displayName: z.string().nullable(),
  totalSpeechMs: z.number().int().min(0),
});
export type SpeakerDto = z.infer<typeof SpeakerDto>;

export const SpeakerList = z.object({ items: z.array(SpeakerDto) });
export type SpeakerList = z.infer<typeof SpeakerList>;

/** `speakerKey` is immutable: any other field is rejected. */
export const SpeakerPatch = z.strictObject({
  displayName: z.string().trim().min(1).max(80),
});
export type SpeakerPatch = z.infer<typeof SpeakerPatch>;
