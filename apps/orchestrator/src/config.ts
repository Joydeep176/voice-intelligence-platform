import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { AudioVadSettings } from '@vip/contracts';
import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'verbose']).default('info'),
  REDIS_URL: z.url(),
  QUEUE_FOUNDATION_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(2),
  QUEUE_STALLED_INTERVAL_MS: z.coerce.number().int().min(1000).default(30_000),
  QUEUE_MAX_STALLED_COUNT: z.coerce.number().int().min(0).max(10).default(1),
  QUEUE_LOCK_DURATION_MS: z.coerce.number().int().min(1000).default(30_000),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(100).default(10_000),
  DATABASE_URL: z.url(),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(50).default(5),
  AUDIO_SERVICE_URL: z.url(),
  AUDIO_SERVICE_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(3000),
  /**
   * Bearer token for the audio service (ADR-0035). Without it the audio processing workers do
   * not start (a warning names the variable). Empty means unset. Never logged.
   */
  AUDIO_SERVICE_TOKEN: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.string().min(32).optional(),
  ),
  /** Interim development defaults (OD-10 Open): bounds of the audio processing coordinator. */
  PROCESSING_MAX_RETRIES: z.coerce.number().int().min(1).max(10).default(3),
  PROCESSING_POLL_INTERVAL_MS: z.coerce.number().int().min(10).max(60_000).default(2000),
  PROCESSING_RETRY_BACKOFF_MS: z.coerce.number().int().min(10).max(600_000).default(5000),
  /**
   * Staleness base of the sweeper only (see `stuckAfterMs`). It does NOT bound a task: the Node
   * backstop deadline is the two variables below. Name kept so existing environments stay valid.
   */
  PROCESSING_TASK_TIMEOUT_MS: z.coerce.number().int().min(1000).default(900_000),
  /**
   * Node backstop for a submitted task (ADR-0010; INTERIM, OD-10 / D-2B-20 Open). Deadline =
   * service-reported `deadlineAt` + grace, or, before the service reports one,
   * submit time + base + 0.5 x recording duration + grace (the service's own interim formula).
   */
  PROCESSING_TASK_DEADLINE_BASE_MS: z.coerce.number().int().min(1000).default(120_000),
  PROCESSING_TASK_DEADLINE_GRACE_MS: z.coerce.number().int().min(0).default(60_000),
  PROCESSING_SWEEP_INTERVAL_MS: z.coerce.number().int().min(50).default(60_000),
  PROCESSING_SWEEP_BATCH: z.coerce.number().int().min(1).max(500).default(50),
  QUEUE_AUDIO_CONCURRENCY: z.coerce.number().int().min(1).max(4).default(1),
  QUEUE_AUDIO_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(5),
  QUEUE_AUDIO_BACKOFF_MS: z.coerce.number().int().min(10).max(600_000).default(5000),
  /** Phase 2C transcription runs (D-2C-01). Interim development defaults (OD-10 Open). */
  STORAGE_LOCAL_ROOT: z.string().min(1).default('.local-storage'),
  /**
   * Adapter keys (ADR-0012): `fake` (development and tests), `whisper-cpp` (ADR-0036) and
   * `sherpa-onnx` (ADR-0037), the latter two run in the audio service. An unknown key stops the run
   * workers at startup.
   */
  STT_PROVIDER: z.string().min(1).max(64).default('fake'),
  DIARIZATION_PROVIDER: z.string().min(1).max(64).default('fake'),
  /** Diarization parameters sent to the audio service (C3 benchmark values; windows: ADR-0016, interim OD-10). */
  DIARIZATION_CLUSTER_THRESHOLD: z.coerce.number().min(0).max(2).default(0.6),
  DIARIZATION_MIN_ON_MS: z.coerce.number().int().min(0).max(10_000).default(300),
  DIARIZATION_MIN_OFF_MS: z.coerce.number().int().min(0).max(10_000).default(500),
  DIARIZATION_WHOLE_FILE_MAX_MS: z.coerce.number().int().min(10_000).default(600_000),
  DIARIZATION_WINDOW_MS: z.coerce.number().int().min(60_000).default(600_000),
  DIARIZATION_OVERLAP_MS: z.coerce.number().int().min(0).default(30_000),
  DIARIZATION_MATCH_THRESHOLD: z.coerce.number().min(0).max(1).default(0.5),
  /** Silero VAD inside transcription windows (OD-29, ADR-0038; Phase 2B tuned values). */
  STT_VAD_THRESHOLD: z.coerce.number().min(0).max(1).default(0.4),
  STT_VAD_MIN_SILENCE_MS: z.coerce.number().int().min(0).max(5000).default(300),
  STT_VAD_MIN_SPEECH_MS: z.coerce.number().int().min(0).max(5000).default(250),
  STT_VAD_PADDING_MS: z.coerce.number().int().min(0).max(2000).default(200),
  /** How often a self-hosted adapter polls its audio-service task. */
  PROVIDER_POLL_INTERVAL_MS: z.coerce.number().int().min(10).max(60_000).default(1000),
  /** Limit on re-executions of one run (user retries and sweeper recoveries). */
  RUN_MAX_RETRIES: z.coerce.number().int().min(0).max(10).default(3),
  /** Whole-run deadline backstop (checked between windows): base + audio duration x permille / 1000. */
  RUN_DEADLINE_MS: z.coerce.number().int().min(1000).default(3_600_000),
  RUN_DEADLINE_PER_AUDIO_PERMILLE: z.coerce.number().int().min(0).max(100_000).default(6000),
  /** Bound of one provider call: base + audio of the call x permille / 1000 (local inference is near real time). */
  RUN_PROVIDER_TIMEOUT_MS: z.coerce.number().int().min(50).default(120_000),
  RUN_PROVIDER_TIMEOUT_PER_AUDIO_PERMILLE: z.coerce
    .number()
    .int()
    .min(0)
    .max(100_000)
    .default(5000),
  QUEUE_RUN_CONCURRENCY: z.coerce.number().int().min(1).max(2).default(1),
  /** Automatic job attempts for transient failures (BullMQ). */
  QUEUE_RUN_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  QUEUE_RUN_BACKOFF_MS: z.coerce.number().int().min(10).max(600_000).default(5000),
  RUN_SWEEP_INTERVAL_MS: z.coerce.number().int().min(50).default(60_000),
  /** A run row untouched for longer than this with no live job is stuck. */
  RUN_STUCK_AFTER_MS: z.coerce.number().int().min(100).default(600_000),
  /** Phase 3A A1 Audio Quality (ADR-0044). Queue bounds per ADR-0010. */
  QUEUE_AUDIO_QUALITY_CONCURRENCY: z.coerce.number().int().min(1).max(4).default(1),
  QUEUE_AUDIO_QUALITY_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  QUEUE_AUDIO_QUALITY_BACKOFF_MS: z.coerce.number().int().min(10).max(600_000).default(5000),
  /** How often the A1 trigger sweep looks for runs to assess (lifecycle L2 / L3). */
  AUDIO_QUALITY_SWEEP_INTERVAL_MS: z.coerce.number().int().min(50).default(15_000),
  AUDIO_QUALITY_SWEEP_BATCH: z.coerce.number().int().min(1).max(500).default(50),
  /** Cap on A1 attempts per run (automatic re-assessments and user retries together). */
  AUDIO_QUALITY_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
  /** A running A1 stage untouched for longer than this has lost its job. */
  AUDIO_QUALITY_STUCK_AFTER_MS: z.coerce.number().int().min(100).default(120_000),
  /**
   * Tier 1 (speech-aware measure task, ADR-0045). If the audio service does not offer `measure`,
   * the measurement set fails permanently and A1 falls back to Tier 0 with low confidence.
   */
  AUDIO_QUALITY_TIER1: z.enum(['on', 'off']).default('on'),
});

export interface OrchestratorConfig {
  env: 'development' | 'test' | 'production';
  logLevel: z.infer<typeof EnvSchema>['LOG_LEVEL'];
  redisUrl: string;
  foundation: {
    concurrency: number;
    stalledIntervalMs: number;
    maxStalledCount: number;
    lockDurationMs: number;
  };
  shutdownTimeoutMs: number;
  database: { url: string; poolMax: number };
  audioService: { url: string; timeoutMs: number; token: string | undefined };
  processing: ProcessingConfig;
  runs: RunsConfig;
  audioQuality: AudioQualityConfig;
}

/** A1 Audio Quality bounds (ADR-0044, ADR-0010). Rule thresholds live in the agent's rule config. */
export interface AudioQualityConfig {
  concurrency: number;
  attempts: number;
  backoffMs: number;
  sweepIntervalMs: number;
  sweepBatch: number;
  maxAttempts: number;
  stuckAfterMs: number;
  tier1Enabled: boolean;
  stalledIntervalMs: number;
  maxStalledCount: number;
  lockDurationMs: number;
}

/** Bounds and provider keys of the transcription run coordinator (D-2C-01, ADR-0010). */
export interface RunsConfig {
  /** Absolute root of local object storage (same directory the API and audio service use). */
  storageRoot: string;
  sttProvider: string;
  diarizationProvider: string;
  diarization: DiarizationSettings;
  vad: AudioVadSettings;
  providerPollMs: number;
  maxRetries: number;
  deadlineMs: number;
  deadlinePerAudioPermille: number;
  providerTimeoutMs: number;
  providerTimeoutPerAudioPermille: number;
  concurrency: number;
  attempts: number;
  backoffMs: number;
  sweepIntervalMs: number;
  sweepBatch: number;
  stuckAfterMs: number;
  stalledIntervalMs: number;
  maxStalledCount: number;
  lockDurationMs: number;
}

/** Diarization task parameters for the self-hosted adapter (ADR-0037). */
export interface DiarizationSettings {
  clusteringThreshold: number;
  minDurationOnMs: number;
  minDurationOffMs: number;
  wholeFileMaxMs: number;
  windowMs: number;
  overlapMs: number;
  matchThreshold: number;
}

/** Bounds of the audio processing coordinator (ADR-0010). All validated at startup. */
export interface ProcessingConfig {
  maxRetries: number;
  pollIntervalMs: number;
  retryBackoffMs: number;
  /** Sweeper staleness base (env `PROCESSING_TASK_TIMEOUT_MS`); not a task bound. */
  sweepStaleBaseMs: number;
  /** Interim base of the service's task deadline formula, used until it reports `deadlineAt`. */
  deadlineBaseMs: number;
  /** Interim grace added to the service deadline before Node gives up on a task. */
  deadlineGraceMs: number;
  sweepIntervalMs: number;
  sweepBatch: number;
  concurrency: number;
  attempts: number;
  backoffMs: number;
  stalledIntervalMs: number;
  maxStalledCount: number;
  lockDurationMs: number;
  /** A row untouched for longer than this (and with no live job) is stuck: poll × 10 + task timeout. */
  stuckAfterMs: number;
}

export const ORCHESTRATOR_CONFIG = Symbol('ORCHESTRATOR_CONFIG');

export class ConfigError extends Error {
  constructor(readonly variables: string[]) {
    super(`Invalid or missing environment variables: ${variables.join(', ')}`);
    this.name = 'ConfigError';
  }
}

/** Walks up from `start` to the directory containing pnpm-workspace.yaml. */
function findRepoRoot(start = process.cwd()): string {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(start);
    dir = parent;
  }
}

export function loadConfig(env: NodeJS.ProcessEnv): OrchestratorConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError([...new Set(parsed.error.issues.map((i) => String(i.path[0])))]);
  }
  const e = parsed.data;
  if (e.DIARIZATION_OVERLAP_MS * 2 >= e.DIARIZATION_WINDOW_MS) {
    throw new ConfigError(['DIARIZATION_OVERLAP_MS']);
  }
  return {
    env: e.NODE_ENV,
    logLevel: e.LOG_LEVEL,
    redisUrl: e.REDIS_URL,
    foundation: {
      concurrency: e.QUEUE_FOUNDATION_CONCURRENCY,
      stalledIntervalMs: e.QUEUE_STALLED_INTERVAL_MS,
      maxStalledCount: e.QUEUE_MAX_STALLED_COUNT,
      lockDurationMs: e.QUEUE_LOCK_DURATION_MS,
    },
    shutdownTimeoutMs: e.SHUTDOWN_TIMEOUT_MS,
    database: { url: e.DATABASE_URL, poolMax: e.DATABASE_POOL_MAX },
    audioService: {
      url: e.AUDIO_SERVICE_URL.replace(/\/$/, ''),
      timeoutMs: e.AUDIO_SERVICE_TIMEOUT_MS,
      token: e.AUDIO_SERVICE_TOKEN,
    },
    processing: {
      maxRetries: e.PROCESSING_MAX_RETRIES,
      pollIntervalMs: e.PROCESSING_POLL_INTERVAL_MS,
      retryBackoffMs: e.PROCESSING_RETRY_BACKOFF_MS,
      sweepStaleBaseMs: e.PROCESSING_TASK_TIMEOUT_MS,
      deadlineBaseMs: e.PROCESSING_TASK_DEADLINE_BASE_MS,
      deadlineGraceMs: e.PROCESSING_TASK_DEADLINE_GRACE_MS,
      sweepIntervalMs: e.PROCESSING_SWEEP_INTERVAL_MS,
      sweepBatch: e.PROCESSING_SWEEP_BATCH,
      concurrency: e.QUEUE_AUDIO_CONCURRENCY,
      attempts: e.QUEUE_AUDIO_ATTEMPTS,
      backoffMs: e.QUEUE_AUDIO_BACKOFF_MS,
      stalledIntervalMs: e.QUEUE_STALLED_INTERVAL_MS,
      maxStalledCount: e.QUEUE_MAX_STALLED_COUNT,
      lockDurationMs: e.QUEUE_LOCK_DURATION_MS,
      stuckAfterMs: e.PROCESSING_POLL_INTERVAL_MS * 10 + e.PROCESSING_TASK_TIMEOUT_MS,
    },
    runs: {
      storageRoot: isAbsolute(e.STORAGE_LOCAL_ROOT)
        ? e.STORAGE_LOCAL_ROOT
        : join(findRepoRoot(), e.STORAGE_LOCAL_ROOT),
      sttProvider: e.STT_PROVIDER,
      diarizationProvider: e.DIARIZATION_PROVIDER,
      diarization: {
        clusteringThreshold: e.DIARIZATION_CLUSTER_THRESHOLD,
        minDurationOnMs: e.DIARIZATION_MIN_ON_MS,
        minDurationOffMs: e.DIARIZATION_MIN_OFF_MS,
        wholeFileMaxMs: e.DIARIZATION_WHOLE_FILE_MAX_MS,
        windowMs: e.DIARIZATION_WINDOW_MS,
        overlapMs: e.DIARIZATION_OVERLAP_MS,
        matchThreshold: e.DIARIZATION_MATCH_THRESHOLD,
      },
      vad: {
        threshold: e.STT_VAD_THRESHOLD,
        minSilenceMs: e.STT_VAD_MIN_SILENCE_MS,
        minSpeechMs: e.STT_VAD_MIN_SPEECH_MS,
        paddingMs: e.STT_VAD_PADDING_MS,
      },
      providerPollMs: e.PROVIDER_POLL_INTERVAL_MS,
      maxRetries: e.RUN_MAX_RETRIES,
      deadlineMs: e.RUN_DEADLINE_MS,
      deadlinePerAudioPermille: e.RUN_DEADLINE_PER_AUDIO_PERMILLE,
      providerTimeoutMs: e.RUN_PROVIDER_TIMEOUT_MS,
      providerTimeoutPerAudioPermille: e.RUN_PROVIDER_TIMEOUT_PER_AUDIO_PERMILLE,
      concurrency: e.QUEUE_RUN_CONCURRENCY,
      attempts: e.QUEUE_RUN_ATTEMPTS,
      backoffMs: e.QUEUE_RUN_BACKOFF_MS,
      sweepIntervalMs: e.RUN_SWEEP_INTERVAL_MS,
      sweepBatch: e.PROCESSING_SWEEP_BATCH,
      stuckAfterMs: e.RUN_STUCK_AFTER_MS,
      stalledIntervalMs: e.QUEUE_STALLED_INTERVAL_MS,
      maxStalledCount: e.QUEUE_MAX_STALLED_COUNT,
      lockDurationMs: e.QUEUE_LOCK_DURATION_MS,
    },
    audioQuality: {
      concurrency: e.QUEUE_AUDIO_QUALITY_CONCURRENCY,
      attempts: e.QUEUE_AUDIO_QUALITY_ATTEMPTS,
      backoffMs: e.QUEUE_AUDIO_QUALITY_BACKOFF_MS,
      sweepIntervalMs: e.AUDIO_QUALITY_SWEEP_INTERVAL_MS,
      sweepBatch: e.AUDIO_QUALITY_SWEEP_BATCH,
      maxAttempts: e.AUDIO_QUALITY_MAX_ATTEMPTS,
      stuckAfterMs: e.AUDIO_QUALITY_STUCK_AFTER_MS,
      tier1Enabled: e.AUDIO_QUALITY_TIER1 === 'on',
      stalledIntervalMs: e.QUEUE_STALLED_INTERVAL_MS,
      maxStalledCount: e.QUEUE_MAX_STALLED_COUNT,
      lockDurationMs: e.QUEUE_LOCK_DURATION_MS,
    },
  };
}

/** Worker connections need maxRetriesPerRequest=null (BullMQ requirement for blocking commands). */
export function workerConnection(url: string) {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    ...(u.username ? { username: decodeURIComponent(u.username) } : {}),
    ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
    db: u.pathname.length > 1 ? Number(u.pathname.slice(1)) : 0,
    ...(u.protocol === 'rediss:' ? { tls: {} } : {}),
    maxRetriesPerRequest: null,
  };
}
