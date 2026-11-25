import { z } from 'zod';
import { Uuid } from './common.js';

/**
 * Audio-service internal API (LLD §3.1, ADR-0002, ADR-0023). Python mirrors these schemas
 * as Pydantic models in `services/audio/src/audio_service/contracts.py`; change both together.
 * Contract tests on both sides check the shared JSON fixtures in `packages/contracts/fixtures/audio-service`.
 */
export const AUDIO_SERVICE_CONTRACT_VERSION = '2';

export const AudioServiceProbe = z.object({
  status: z.enum(['ok', 'down']),
  service: z.literal('audio-service'),
  version: z.string(),
});
export type AudioServiceProbe = z.infer<typeof AudioServiceProbe>;

/**
 * Contract version 2 (Phase 2B WS1, ADR-0035): every route except `/health/live` requires
 * `Authorization: Bearer <AUDIO_SERVICE_TOKEN>`. The version is a string on every message.
 */

/** `POST /v1/handshake` verifies reachability and contract compatibility. */
export const HandshakeRequest = z.object({
  contractVersion: z.string().min(1).max(16),
  requestId: Uuid,
});
export type HandshakeRequest = z.infer<typeof HandshakeRequest>;

export const HandshakeResponse = z.object({
  contractVersion: z.string(),
  serviceVersion: z.string(),
  requestId: Uuid,
  accepted: z.literal(true),
});
export type HandshakeResponse = z.infer<typeof HandshakeResponse>;

/** Error body returned by the audio service (Problem Details subset). */
export const AudioServiceError = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  code: z.string(),
  detail: z.string().optional(),
});
export type AudioServiceError = z.infer<typeof AudioServiceError>;

/**
 * Stable, content-free failure codes (no stderr, paths or media metadata).
 *
 * `RESOURCE_EXHAUSTED` (retryable): a child process was terminated by a signal the service did not
 * send (cgroup OOM SIGKILL, SIGSEGV, ...). A condition of the host, not a property of the file, so
 * Node must never persist it as an invalid recording. SIGXCPU (the CPU-time rlimit) maps to `TIMEOUT`.
 */
export const AudioServiceErrorCode = z.enum([
  'UNSUPPORTED_FORMAT',
  'CORRUPT_MEDIA',
  'NO_DECODABLE_AUDIO',
  'DURATION_LIMIT_EXCEEDED',
  'RESOURCE_LIMIT_EXCEEDED',
  'TIMEOUT',
  'CANCELLED',
  'STORAGE_ERROR',
  'INTERNAL_ERROR',
  'UNAUTHORIZED',
  'TASK_NOT_FOUND',
  'IDEMPOTENCY_CONFLICT',
  'CAPACITY_EXCEEDED',
  'UNSUPPORTED_TASK_TYPE',
  'INVALID_STORAGE_KEY',
  'WORKSPACE_MISMATCH',
  'CONTRACT_VERSION_MISMATCH',
  'INVALID_CONFIG',
  'CONFIG_HASH_MISMATCH',
  'TOOL_VERSION_MISMATCH',
  'RESOURCE_EXHAUSTED',
]);
export type AudioServiceErrorCode = z.infer<typeof AudioServiceErrorCode>;

export const AudioTaskType = z.enum(['probe', 'preprocess', 'transcribe', 'diarize']);
export type AudioTaskType = z.infer<typeof AudioTaskType>;

export const AudioTaskStatus = z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']);
export type AudioTaskStatus = z.infer<typeof AudioTaskStatus>;

/** `GET /v1/capabilities`: values are measured by the service at startup. */
export const AudioServiceCapabilities = z.object({
  contractVersion: z.string(),
  serviceVersion: z.string(),
  python: z.string(),
  ffmpeg: z.object({ version: z.string() }).nullable(),
  numpy: z.string(),
  /** VAD is not selected (OD-29): `'none'` is the only value until a later workstream adds one. */
  vad: z.literal('none'),
  landlock: z.object({
    supported: z.boolean(),
    abi: z.number().int().min(1).nullable(),
    enforced: z.boolean(),
    /**
     * Landlock scoping (ABI >= 6: signals and abstract UNIX sockets) is applied to children. False
     * below ABI 6 and when absent (older services).
     */
    scoped: z.boolean().optional(),
  }),
  taskTypes: z.array(AudioTaskType),
});
export type AudioServiceCapabilities = z.infer<typeof AudioServiceCapabilities>;

/** `POST /v1/tasks`. Keys, never paths; the key segments must equal workspaceId/recordingId. */
export const AudioTaskCreateRequest = z
  .object({
    contractVersion: z.string().min(1).max(16),
    type: AudioTaskType,
    idempotencyKey: z
      .string()
      .min(8)
      .max(128)
      .regex(/^[A-Za-z0-9._:-]+$/),
    workspaceId: Uuid,
    recordingId: Uuid,
    input: z
      .object({
        originalKey: z.string().min(1).max(512),
        outputPrefix: z.string().min(1).max(512),
      })
      .strict(),
    config: z.record(z.string(), z.unknown()),
  })
  .strict();
export type AudioTaskCreateRequest = z.infer<typeof AudioTaskCreateRequest>;

/** `202` body of `POST /v1/tasks` and `DELETE /v1/tasks/{id}`. */
export const AudioTaskAccepted = z.object({ taskId: Uuid, status: AudioTaskStatus });
export type AudioTaskAccepted = z.infer<typeof AudioTaskAccepted>;

/** `GET /v1/tasks/{id}`. An unknown id (404 TASK_NOT_FOUND) means lost: Node retries. */
export const AudioTaskState = z.object({
  taskId: Uuid,
  type: AudioTaskType,
  status: AudioTaskStatus,
  progress: z
    .object({
      stage: z.string().min(1).max(64),
      fraction: z.number().min(0).max(1),
      processedMs: z.number().int().min(0),
    })
    .nullable(),
  result: z.record(z.string(), z.unknown()).nullable(),
  error: z.object({ code: AudioServiceErrorCode, retryable: z.boolean() }).nullable(),
  /**
   * Wall-clock deadline of the whole task as epoch milliseconds, set once the task runs (ADR-0010).
   * Interim formula (OD-10 / D-2B-20 Open): base 120 s + 0.5 x audio duration, see
   * `AUDIO_SERVICE_TASK_DEADLINE_*`. The service fails the task with `TIMEOUT` (retryable) when it
   * passes; Node may use it as a backstop. Absent or null while queued and from older services.
   */
  deadlineAt: z.number().int().min(0).nullable().optional(),
});
export type AudioTaskState = z.infer<typeof AudioTaskState>;

/**
 * `probe` task result (Phase 2B WS3). Container tags and metadata are never part of it (they can hold
 * personal data). `editListPresent` is `'unknown'` for MP4/MOV without evidence: telling would mean
 * parsing the `elst` box.
 */
export const AudioGaplessInfo = z.enum([
  'lame',
  'itunsmpb',
  'edit_list',
  'codec_preskip',
  'none',
  'unknown',
]);
export type AudioGaplessInfo = z.infer<typeof AudioGaplessInfo>;

const FiniteMs = z.number().finite();
const NonNegativeMs = FiniteMs.min(0);

export const AudioTimelineSource = z
  .object({
    timeBase: z.string().regex(/^[0-9]{1,10}\/[0-9]{1,10}$/),
    startTimeTicks: z.number().int().nullable(),
    startTimeMs: FiniteMs.nullable(),
    editListPresent: z.union([z.boolean(), z.literal('unknown')]),
    encoderDelaySamples: z.number().int().min(0).nullable(),
    paddingSamples: z.number().int().min(0).nullable(),
    gaplessInfo: AudioGaplessInfo,
  })
  .strict();
export type AudioTimelineSource = z.infer<typeof AudioTimelineSource>;

export const AudioProbeResult = z
  .object({
    container: z.enum(['wav', 'flac', 'ogg', 'mp4', 'matroska', 'mp3']),
    demuxer: z.string().min(1).max(32),
    codec: z.string().min(1).max(32),
    sampleRateHz: z.number().int().min(1),
    channels: z.number().int().min(1),
    channelLayout: z.string().max(64).nullable(),
    sampleFormat: z.string().min(1).max(16),
    bitsPerRawSample: z.number().int().min(1).nullable(),
    bitRate: z.number().int().min(0).nullable(),
    headerDurationMs: z.number().int().min(0).nullable(),
    streamCount: z.number().int().min(1),
    audioStreamCount: z.number().int().min(1),
    trialDecode: z.object({ decodable: z.boolean(), decodedMs: z.number().int().min(0) }).strict(),
    timelineSource: AudioTimelineSource,
    warnings: z.array(z.string()),
    tools: z.object({ ffprobe: z.string() }).strict(),
  })
  .strict();
export type AudioProbeResult = z.infer<typeof AudioProbeResult>;

/** Mapping record stored with a preprocessing (plan §11.2). Times are on the canonical 16 kHz timeline. */
export const AudioMappingStatus = z.enum(['exact', 'offset_applied', 'approximate', 'uncertain']);
export type AudioMappingStatus = z.infer<typeof AudioMappingStatus>;

export const AudioTimeline = z
  .object({
    schemaVersion: z.literal(1),
    nativeSampleRate: z.number().int().min(1),
    decodedSamplesNative: z.number().int().min(0),
    canonicalSamples: z.number().int().min(0),
    source: AudioTimelineSource.extend({
      headerDurationMs: z.number().int().min(0).nullable(),
    }).strict(),
    sourceOffsetMs: FiniteMs.nullable(),
    decodeClass: z.enum(['full', 'partial', 'none']),
    decodedUntilMs: NonNegativeMs.nullable(),
    gaps: z.array(
      z
        .object({
          startMs: NonNegativeMs,
          durationMs: NonNegativeMs,
          kind: z.literal('timestamp_gap_filled'),
        })
        .strict(),
    ),
    overlapsTrimmed: z.array(z.object({ atMs: NonNegativeMs, durationMs: NonNegativeMs }).strict()),
    decodeErrors: z
      .object({ count: z.number().int().min(0), firstAtMs: NonNegativeMs.nullable() })
      .strict(),
    mappingStatus: AudioMappingStatus,
    mappingErrorBoundMs: NonNegativeMs.nullable(),
    reasons: z.array(z.string()),
  })
  .strict();
export type AudioTimeline = z.infer<typeof AudioTimeline>;

/**
 * `preprocess` task config (Phase 2B WS4; ADR-0015). It is hashed: the hash is the last segment of
 * the output prefix `derived/<workspaceId>/<recordingId>/<configHash>`, and the service recomputes
 * it (CONFIG_HASH_MISMATCH) and compares `toolVersions` with its own (TOOL_VERSION_MISMATCH).
 *
 * Every number is an integer: dBFS values are in hundredths (`-5000` is -50.00 dBFS), times are
 * milliseconds. No float, boolean or null appears, so no number formatting can differ between languages.
 */
const ToolVersion = z.string().regex(/^[A-Za-z0-9._+~:-]{1,64}$/);

const VadMethod = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);

/** A positive-or-zero integer multiple of the 10 ms analysis frame, within [min, max]. */
const frameMs = (min: number, max: number) => z.number().int().min(min).max(max).multipleOf(10);

/**
 * Speech segmentation parameters (plan §11.1). INTERIM DEVELOPMENT DEFAULTS, OD-10 Open (not
 * approved): minSegmentMs 1000, maxSegmentMs 30000, splitSilenceMs 500, mergeGapMs 300,
 * paddingMs 200, forcedSplitOverlapMs 1000. All integers (the config hash allows no floats).
 */
export const AudioSegmentationConfig = z
  .object({
    minSegmentMs: frameMs(100, 60_000),
    maxSegmentMs: frameMs(1_000, 300_000),
    splitSilenceMs: frameMs(100, 60_000),
    mergeGapMs: frameMs(0, 60_000),
    paddingMs: frameMs(0, 10_000),
    forcedSplitOverlapMs: frameMs(0, 10_000),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (c.minSegmentMs > c.maxSegmentMs)
      ctx.addIssue({ code: 'custom', message: 'minSegmentMs must not exceed maxSegmentMs' });
    if (c.mergeGapMs > c.splitSilenceMs)
      ctx.addIssue({ code: 'custom', message: 'mergeGapMs must not exceed splitSilenceMs' });
    if (c.forcedSplitOverlapMs * 4 > c.maxSegmentMs)
      ctx.addIssue({
        code: 'custom',
        message: 'forcedSplitOverlapMs must not exceed a quarter of maxSegmentMs',
      });
  });
export type AudioSegmentationConfig = z.infer<typeof AudioSegmentationConfig>;

export const AudioPreprocessConfig = z
  .object({
    schemaVersion: z.literal(1),
    canonical: z
      .object({
        sampleRateHz: z.literal(16000),
        channels: z.literal(1),
        sampleFormat: z.literal('s16'),
        container: z.literal('wav'),
      })
      .strict(),
    blockSeconds: z.number().int().min(1).max(30),
    measurement: z
      .object({
        /** A clipped run is a stretch of at least `minRunSamples` consecutive full-scale samples. */
        clipping: z.object({ minRunSamples: z.number().int().min(1).max(1000) }).strict(),
        silenceThresholdCentiDbfs: z.number().int().min(-12000).max(0),
        levelSeriesIntervalMs: z.number().int().min(10).max(60000),
      })
      .strict(),
    limits: z
      .object({
        maxDurationMs: z.number().int().min(1),
        maxChannels: z.number().int().min(1),
        maxSampleRateHz: z.number().int().min(1),
      })
      .strict(),
    /**
     * OD-29: no VAD is selected. The schema only fixes the shape of a method name; the service
     * accepts `none` plus the methods registered with it (none are yet), else INVALID_CONFIG.
     */
    vad: z.object({ method: VadMethod }).strict(),
    /**
     * Omitted exactly when `vad.method` is `none` (so existing hashes do not change); there is no
     * null in the canonical JSON. Required with any other method.
     */
    segmentation: AudioSegmentationConfig.optional(),
    toolVersions: z
      .object({
        service: ToolVersion,
        python: ToolVersion,
        ffmpeg: ToolVersion,
        numpy: ToolVersion,
        /** `none`, or `<method>:<detector version>`. */
        vad: ToolVersion,
      })
      .strict(),
  })
  .strict()
  .superRefine((config, ctx) => {
    if ((config.vad.method === 'none') !== (config.segmentation === undefined)) {
      ctx.addIssue({
        code: 'custom',
        message: 'segmentation is required with a VAD method and forbidden without one',
      });
    }
  });
export type AudioPreprocessConfig = z.infer<typeof AudioPreprocessConfig>;

/**
 * Canonical JSON of a config, the input of the config hash. Rule (identical to `canonical_json` in
 * services/audio/src/audio_service/contracts.py):
 *  - object keys sorted recursively, by code point (the keys of this schema are ASCII);
 *  - no whitespace between tokens; strings JSON-escaped, non-ASCII not escaped;
 *  - numbers only as integers (safe-integer range); floats, booleans and null throw.
 * `configHash = lowercase-hex SHA-256 of the UTF-8 bytes of this string`. This module is
 * browser-shared, so the hashing itself is left to the caller (`node:crypto` in the coordinator).
 */
export function canonicalJson(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('config numbers must be integers');
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    const body = Object.keys(record)
      .sort((a, b) => compareCodePoints(a, b))
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${body.join(',')}}`;
  }
  throw new Error('config values must be strings, integers, arrays or objects');
}

function compareCodePoints(a: string, b: string): number {
  const left = Array.from(a, (c) => c.codePointAt(0) as number);
  const right = Array.from(b, (c) => c.codePointAt(0) as number);
  const length = Math.min(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    const diff = (left[i] as number) - (right[i] as number);
    if (diff !== 0) return diff;
  }
  return left.length - right.length;
}

/**
 * Measurements (plan §8, §9). Every quantity is a number with a unit, a kind and the method that
 * produced it. There are no categories, scores, verdicts or recommendations: interpretation belongs
 * to the future Audio Quality agent (ADR-0019). Quantities that cannot be measured appear in
 * `unavailable` with a reason code, never as a guess.
 */
export const AudioQuantity = z
  .object({
    value: z.number().finite(),
    unit: z.enum([
      'dBFS',
      'dB',
      'LUFS',
      'LU',
      'dBTP',
      'ratio',
      'samples',
      'ms',
      'fullscale',
      'count',
    ]),
    kind: z.enum(['measured', 'derived', 'estimate']),
    method: z.string().min(1).max(160),
  })
  .strict();
export type AudioQuantity = z.infer<typeof AudioQuantity>;

export const AudioMeasurementRecord = z
  .object({
    measurementsSchemaVersion: z.literal(1),
    source: z.enum(['original_decoded', 'canonical']),
    sampleRateHz: z.number().int().min(1),
    channels: z.number().int().min(1),
    frames: z.number().int().min(0),
    quantities: z.record(z.string(), AudioQuantity),
    perChannel: z.array(
      z
        .object({
          channel: z.number().int().min(0),
          quantities: z.record(z.string(), AudioQuantity),
        })
        .strict(),
    ),
    unavailable: z.array(
      z.object({ name: z.string().min(1).max(64), reason: z.string().min(1).max(64) }).strict(),
    ),
  })
  .strict();
export type AudioMeasurementRecord = z.infer<typeof AudioMeasurementRecord>;

/**
 * One speech segment on the canonical timeline: half-open `[startMs, endMs)` in whole
 * milliseconds. Maps 1:1 onto a row of `audio_segments`. Interim parameters, OD-10 Open.
 * Only a forced split of speech longer than the maximum overlaps: both neighbours declare the same
 * overlap (`overlapEndMs` of the earlier, `overlapStartMs` of the later).
 */
export const AudioSegment = z
  .object({
    index: z.number().int().min(0),
    startMs: z.number().int().min(0),
    endMs: z.number().int().min(1),
    overlapStartMs: z.number().int().min(0),
    overlapEndMs: z.number().int().min(0),
    speechMs: z.number().int().min(0),
    containsSyntheticGap: z.boolean(),
  })
  .strict()
  .superRefine((seg, ctx) => {
    const length = seg.endMs - seg.startMs;
    if (length <= 0) ctx.addIssue({ code: 'custom', message: 'startMs must be below endMs' });
    if (seg.speechMs > length)
      ctx.addIssue({ code: 'custom', message: 'speechMs must not exceed the segment length' });
    if (seg.overlapStartMs > length || seg.overlapEndMs > length)
      ctx.addIssue({ code: 'custom', message: 'an overlap must not exceed the segment length' });
  });
export type AudioSegment = z.infer<typeof AudioSegment>;

/** A `canonical` measurement record of one segment, linked by segment index (`audio_measurements`). */
export const AudioSegmentMeasurement = z
  .object({
    segmentIndex: z.number().int().min(0),
    record: AudioMeasurementRecord.refine((r) => r.source === 'canonical', {
      message: 'a segment record is measured on the canonical audio',
    }),
  })
  .strict();
export type AudioSegmentMeasurement = z.infer<typeof AudioSegmentMeasurement>;

/** `preprocess` task result. Keys are storage keys below the output prefix. */
export const AudioPreprocessResult = z
  .object({
    canonical: z
      .object({
        key: z.string().min(1).max(512),
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
        samples: z.number().int().min(0),
        /** `samples / 16`, exact (the canonical rate is 16 kHz). */
        durationMs: NonNegativeMs,
        sampleRateHz: z.literal(16000),
        channels: z.literal(1),
        sampleFormat: z.literal('s16'),
        bytes: z.number().int().min(44),
      })
      .strict(),
    timeline: AudioTimeline,
    measurements: z.array(AudioMeasurementRecord).length(2),
    artifacts: z
      .object({
        levelSeriesKey: z.string().min(1).max(512),
        manifestKey: z.string().min(1).max(512),
      })
      .strict(),
    vad: z.union([
      z.object({ method: z.literal('none'), status: z.literal('not_configured') }).strict(),
      z
        .object({
          method: VadMethod.refine((m) => m !== 'none'),
          version: ToolVersion,
          status: z.literal('applied'),
        })
        .strict(),
    ]),
    /** Empty when no VAD ran. Indices are 0..n-1 in time order. */
    segments: z.array(AudioSegment),
    /** One record per segment, in segment order. */
    segmentMeasurements: z.array(AudioSegmentMeasurement),
    toolVersions: AudioPreprocessConfig.shape.toolVersions,
    warnings: z.array(z.string()),
  })
  .strict()
  .superRefine((result, ctx) => {
    const fail = (message: string): void => ctx.addIssue({ code: 'custom', message });
    if (result.vad.status === 'not_configured' && result.segments.length > 0)
      fail('no VAD, no segments');
    const limit = Math.ceil(result.canonical.durationMs);
    result.segments.forEach((seg, position) => {
      if (seg.index !== position) fail('segment indices are 0..n-1 in order');
      if (seg.endMs > limit) fail('a segment ends beyond the canonical audio');
      const previous = result.segments[position - 1];
      if (previous !== undefined) {
        const shared = Math.min(previous.overlapEndMs, seg.overlapStartMs);
        if (seg.startMs <= previous.startMs || seg.startMs < previous.endMs - shared)
          fail('segments overlap beyond their declared overlap');
      }
    });
    const linked = result.segmentMeasurements.map((m) => m.segmentIndex);
    if (
      linked.length !== result.segments.length ||
      linked.some((index, i) => index !== result.segments[i]?.index)
    )
      fail('one measurement record per segment, in segment order');
  });
export type AudioPreprocessResult = z.infer<typeof AudioPreprocessResult>;

/**
 * `level-series.json`: one RMS and one peak value per window of the canonical audio; null = digital
 * silence. A measurement series, NOT waveform peaks: no API or UI may serve it as peaks until OD-39 is decided.
 */
export const AudioLevelSeries = z
  .object({
    schemaVersion: z.literal(1),
    intervalMs: z.number().int().min(10),
    sampleRateHz: z.literal(16000),
    windows: z.number().int().min(0),
    rmsDbfs: z.array(z.number().finite().nullable()),
    peakDbfs: z.array(z.number().finite().nullable()),
  })
  .strict();
export type AudioLevelSeries = z.infer<typeof AudioLevelSeries>;

/* ------------------------------------------------------------------------------------------------
 * Self-hosted speech-to-text and diarization tasks (OD-02b / OD-03b, ADR-0036 / ADR-0037). The
 * task input is the recording's `originalKey` (workspace/recording check) and the `outputPrefix`
 * of the preprocessing version whose `canonical.wav` is read; nothing is written to storage, the
 * result is returned inline and the orchestrator stores it verbatim as the raw provider output.
 * Times are integer milliseconds on the canonical timeline.
 * ---------------------------------------------------------------------------------------------- */

const IntMs = z.number().int().min(0);
const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
const EngineVersion = z.string().min(1).max(64);

/** `transcribe` task config: one window of the canonical audio. */
/** Speech detection inside a transcription window (OD-29: Silero VAD; Phase 2B tuned values). */
export const AudioVadSettings = z
  .object({
    threshold: z.number().min(0).max(1),
    minSilenceMs: z.number().int().min(0).max(5000),
    minSpeechMs: z.number().int().min(0).max(5000),
    paddingMs: z.number().int().min(0).max(2000),
  })
  .strict();
export type AudioVadSettings = z.infer<typeof AudioVadSettings>;

/**
 * `transcribe` task config: one window of the canonical audio. Inside the window, Silero VAD finds
 * speech spans and each span is decoded on its own with its own language (Whisper assumes one
 * language per pass, so a whole mixed-language window would be mistranscribed or translated).
 */
export const AudioTranscribeConfig = z
  .object({
    schemaVersion: z.literal(1),
    engine: z.literal('whisper-cpp'),
    window: z.object({ startMs: IntMs, endMs: IntMs }).strict(),
    audioDurationMs: z.number().int().min(1),
    vad: AudioVadSettings,
    /** Restricts language detection to these codes; absent = choose between `en` and `hi`. */
    languageHints: z
      .array(z.enum(['en', 'hi']))
      .min(1)
      .max(2)
      .optional(),
  })
  .strict()
  .refine((c) => c.window.startMs < c.window.endMs && c.window.endMs <= c.audioDurationMs, {
    message: 'window must be non-empty and inside the audio',
  });
export type AudioTranscribeConfig = z.infer<typeof AudioTranscribeConfig>;

export const AudioEngineInfo = z
  .object({
    id: z.string().min(1).max(32),
    model: z.string().min(1).max(128),
    modelSha256: Sha256Hex,
    runtime: EngineVersion,
    threads: z.number().int().min(1).max(16),
  })
  .strict();
export type AudioEngineInfo = z.infer<typeof AudioEngineInfo>;

const SpeechLanguage = z.enum(['en', 'hi']);

/** `transcribe` task result. Spans and segments are absolute and inside the window. */
export const AudioTranscribeResult = z
  .object({
    schemaVersion: z.literal(1),
    engine: AudioEngineInfo,
    vad: z
      .object({ model: z.string().min(1).max(128), sha256: Sha256Hex, settings: AudioVadSettings })
      .strict(),
    window: z.object({ startMs: IntMs, endMs: IntMs }).strict(),
    /** Speech spans found by the VAD, each with the language it was decoded with. */
    spans: z.array(
      z
        .object({
          startMs: IntMs,
          endMs: IntMs,
          /** Code the engine detected (may be outside en/hi, e.g. `ur`). */
          detected: z.string().min(2).max(8).nullable(),
          probability: z.number().min(0).max(1).nullable(),
          decodedAs: SpeechLanguage,
        })
        .strict(),
    ),
    segments: z.array(
      z
        .object({
          startMs: IntMs,
          endMs: IntMs,
          text: z.string().max(10_000),
          language: SpeechLanguage,
          /** Geometric mean of token probabilities as reported by whisper.cpp; not a calibrated confidence. */
          tokenProbability: z.number().min(0).max(1).nullable(),
        })
        .strict(),
    ),
    warnings: z.array(z.string().max(200)),
  })
  .strict()
  .superRefine((r, ctx) => {
    const inside = (x: { startMs: number; endMs: number }) =>
      x.startMs < x.endMs && x.startMs >= r.window.startMs && x.endMs <= r.window.endMs;
    if (!r.spans.every(inside) || !r.segments.every(inside)) {
      ctx.addIssue({
        code: 'custom',
        message: 'a span or segment lies outside its window or is empty',
      });
    }
  });
export type AudioTranscribeResult = z.infer<typeof AudioTranscribeResult>;

/** `diarize` task config. Whole file up to `wholeFileMaxMs`, else windows (ADR-0016). */
export const AudioDiarizeConfig = z
  .object({
    schemaVersion: z.literal(1),
    engine: z.literal('sherpa-onnx'),
    audioDurationMs: z.number().int().min(1),
    /** Agglomerative clustering distance threshold (tuned on the dev split). */
    clusteringThreshold: z.number().min(0).max(2),
    minDurationOnMs: z.number().int().min(0).max(10_000),
    minDurationOffMs: z.number().int().min(0).max(10_000),
    wholeFileMaxMs: z.number().int().min(10_000),
    windowMs: z.number().int().min(60_000),
    overlapMs: z.number().int().min(0),
    /** Cosine similarity at or above which a window speaker joins an existing global speaker. */
    matchThreshold: z.number().min(0).max(1),
  })
  .strict()
  .refine((c) => c.overlapMs * 2 < c.windowMs, { message: 'overlap must be under half a window' });
export type AudioDiarizeConfig = z.infer<typeof AudioDiarizeConfig>;

/** `diarize` task result. Speaker keys are stable within the recording (`SPEAKER_00`...). */
export const AudioDiarizeResult = z
  .object({
    schemaVersion: z.literal(1),
    engine: z
      .object({
        id: z.literal('sherpa-onnx'),
        runtime: EngineVersion,
        threads: z.number().int().min(1).max(16),
        segmentation: z.object({ model: z.string().min(1).max(128), sha256: Sha256Hex }).strict(),
        embedding: z.object({ model: z.string().min(1).max(128), sha256: Sha256Hex }).strict(),
      })
      .strict(),
    mode: z.enum(['whole', 'windowed']),
    /** SHA-256 of the canonical WAV as read (checked against the preprocessing manifest). */
    canonicalSha256: Sha256Hex,
    windows: z.array(
      z.object({ startMs: IntMs, endMs: IntMs, localSpeakers: z.number().int().min(0) }).strict(),
    ),
    turns: z.array(
      z
        .object({
          startMs: IntMs,
          endMs: IntMs,
          speakerKey: z.string().regex(/^SPEAKER_[0-9]{2,3}$/),
        })
        .strict(),
    ),
    speakerCount: z.number().int().min(0),
    warnings: z.array(z.string().max(200)),
  })
  .strict()
  .superRefine((r, ctx) => {
    const keys = new Set<string>();
    for (const t of r.turns) {
      if (t.startMs >= t.endMs) {
        ctx.addIssue({ code: 'custom', message: 'a turn is empty or reversed' });
        return;
      }
      keys.add(t.speakerKey);
    }
    if (keys.size !== r.speakerCount)
      ctx.addIssue({
        code: 'custom',
        message: 'speakerCount must equal the distinct speaker keys',
      });
  });
export type AudioDiarizeResult = z.infer<typeof AudioDiarizeResult>;
