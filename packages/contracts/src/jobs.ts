import { z } from 'zod';
import { IsoDateTime, Uuid } from './common.js';

/** Queue names (LLD §5). Only the foundation check queue exists in Phase 1. */
export const QueueName = {
  /** Phase 1 foundation test of the queue boundary. Does not process audio. */
  FoundationCheck: 'foundation-check',
  /** Phase 2B: probe task (validation) of an uploaded recording (LLD §5). */
  AudioProbe: 'audio-probe',
  /** Phase 2B: preprocess task of one `audio_preprocessings` version (LLD §5). */
  AudioPreprocess: 'audio-preprocess',
  /** Phase 2B: repeatable stuck-job sweeper for the two audio queues (LLD §5). */
  AudioSweep: 'audio-sweep',
  /** Phase 2C: one transcription + diarization run (D-2C-01); jobId = runId. */
  RunTranscription: 'run-transcription',
  /** Phase 2C: repeatable stuck-run sweeper. */
  RunSweep: 'run-sweep',
  /** Phase 3A: speech-aware `measure` task of one measurement set (ADR-0045); jobId = measure-<setId>. */
  AudioMeasure: 'audio-measure',
  /** Phase 3A: one A1 Audio Quality assessment of a run (ADR-0044); jobId = aq-<runId>-<attempt>. */
  RunAudioQuality: 'run-audio-quality',
} as const;

/**
 * BullMQ job IDs. BullMQ rejects custom IDs that contain `:` (outside its own three-part form),
 * so these use `-`. A job ID is the dedupe key: adding a job whose ID exists is a no-op.
 */
export const JobIds = {
  probe: (recordingId: string) => `probe-${recordingId}`,
  preprocess: (preprocessingId: string) => preprocessingId,
  run: (runId: string) => runId,
  measure: (measurementSetId: string) => `measure-${measurementSetId}`,
  audioQuality: (runId: string, attempt: number) => `aq-${runId}-${attempt}`,
} as const;

/** Payloads carry IDs only (backend rule). */
export const FoundationCheckJob = z.object({
  checkId: Uuid,
  requestedAt: IsoDateTime,
});
export type FoundationCheckJob = z.infer<typeof FoundationCheckJob>;

export const FoundationCheckResult = z.object({
  checkId: Uuid,
  processedBy: z.literal('orchestrator'),
  processedAt: IsoDateTime,
});
export type FoundationCheckResult = z.infer<typeof FoundationCheckResult>;

/**
 * `audio-probe` payload (IDs only). `taskId` and `submissions` are written back by the worker
 * (the audio-service task it submitted and how many times it submitted); they are not input.
 */
export const AudioProbeJob = z.object({
  workspaceId: Uuid,
  recordingId: Uuid,
  /** Start preprocessing once the recording is valid (explicit request on an `uploaded` recording). */
  thenPreprocess: z.boolean().default(false),
  taskId: Uuid.optional(),
  submissions: z.number().int().min(0).default(0),
  /** Epoch ms of the submission and the service-reported task deadline: the Node backstop (ADR-0010). */
  submittedAt: z.number().int().min(0).optional(),
  deadlineAt: z.number().int().min(0).optional(),
  /** Epoch ms the task was first observed `running` (the backstop counts from here, not from submission). */
  runningSince: z.number().int().min(0).optional(),
});
export type AudioProbeJob = z.infer<typeof AudioProbeJob>;

/** `audio-preprocess` payload (IDs only); `taskId` is written back by the worker. */
export const AudioPreprocessJob = z.object({
  workspaceId: Uuid,
  preprocessingId: Uuid,
  taskId: Uuid.optional(),
  /** Set after a retryable failure or a lost task: the next submission uses a new idempotency key. */
  resubmit: z.boolean().optional(),
  /** The submission (attempt) number of `taskId`: a loss or failure of it is counted once, however many observe it. */
  attempt: z.number().int().min(0).optional(),
  /** Epoch ms of the submission and the service-reported task deadline: the Node backstop (ADR-0010). */
  submittedAt: z.number().int().min(0).optional(),
  deadlineAt: z.number().int().min(0).optional(),
  /** Epoch ms the task was first observed `running` (the backstop counts from here, not from submission). */
  runningSince: z.number().int().min(0).optional(),
});
export type AudioPreprocessJob = z.infer<typeof AudioPreprocessJob>;

/** `run-transcription` payload (IDs only, LLD §5). */
export const RunTranscriptionJob = z.object({
  workspaceId: Uuid,
  runId: Uuid,
});
export type RunTranscriptionJob = z.infer<typeof RunTranscriptionJob>;

/** `audio-measure` payload (IDs only, ADR-0045); task bookkeeping is written back by the worker. */
export const AudioMeasureJob = z.object({
  workspaceId: Uuid,
  measurementSetId: Uuid,
  taskId: Uuid.optional(),
  resubmit: z.boolean().optional(),
  attempt: z.number().int().min(0).optional(),
  submittedAt: z.number().int().min(0).optional(),
  deadlineAt: z.number().int().min(0).optional(),
  runningSince: z.number().int().min(0).optional(),
});
export type AudioMeasureJob = z.infer<typeof AudioMeasureJob>;

/** `run-audio-quality` payload (IDs only, ADR-0044). `attempt` is the A1 stage attempt it executes. */
export const RunAudioQualityJob = z.object({
  workspaceId: Uuid,
  runId: Uuid,
  attempt: z.number().int().min(1),
});
export type RunAudioQualityJob = z.infer<typeof RunAudioQualityJob>;
