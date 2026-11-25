import {
  RunConfig,
  RunTranscriptionJob,
  type AudioSourceRef,
  type DiarizationRequest,
  type DiarizationTurn,
  type SttRequest,
  type SttSegment,
} from '@vip/contracts';
import {
  auditEvents,
  beginStage,
  completeRunWithTranscript,
  eq,
  finishStage,
  getPreprocessing,
  getRun,
  getSttRawOutput,
  getWholeDiarizationRawOutput,
  insertDiarizationRawOutput,
  insertSttRawOutput,
  listSegments,
  markRunCancelled,
  markRunFailed,
  markRunStarted,
  mergeRunConfig,
  recordings,
  and,
  setRunStage,
  updateStageProgress,
  type PipelineRun,
} from '@vip/db';
import { ProviderError } from '../providers/errors';
import { diarizationRawKey, obtainRawOutput, sttRawKey } from '../providers/raw-store';
import { alignSpeakers } from './align';
import { shouldWriteStageProgress, type WrittenProgress } from './progress';
import { stitchWindows, type WindowResult } from './stitch';
import {
  RunCancelledSignal,
  RunFailure,
  TransientRunError,
  type RunDeps,
  type RunNode,
} from './types';
import { MAX_WINDOWS, planWindows, type TranscriptionWindow } from './windowing';
import { validateSegments, validateTurns } from './validate';

type Node = RunNode;

export interface Attempts {
  /** BullMQ attempts already made / allowed for this job. */
  attemptsMade: number;
  attempts: number;
}

/** Bound of one provider call, scaled by the audio it covers (local inference is near real time). */
export function providerTimeoutMs(
  config: Pick<RunDeps['config'], 'providerTimeoutMs' | 'providerTimeoutPerAudioPermille'>,
  audioMs: number,
): number {
  return (
    config.providerTimeoutMs + Math.ceil((audioMs * config.providerTimeoutPerAudioPermille) / 1000)
  );
}

/** Whole-run deadline, scaled by the recording duration. */
export function runDeadlineMs(
  config: Pick<RunDeps['config'], 'deadlineMs' | 'deadlinePerAudioPermille'>,
  durationMs: number,
): number {
  return config.deadlineMs + Math.ceil((durationMs * config.deadlinePerAudioPermille) / 1000);
}

/** Resolves with the promise's value or rejects with a retryable timeout. The abandoned call's result is discarded. */
async function withTimeout<T>(promise: Promise<T>, ms: number, node: Node): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new TransientRunError('PROVIDER_TIMEOUT', node)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Provider failures keep their own code; unknown errors count as transient internal errors. */
function toRunError(error: unknown, node: Node | null): RunFailure | TransientRunError {
  if (error instanceof RunFailure || error instanceof TransientRunError) return error;
  if (error instanceof ProviderError) {
    return error.retryable
      ? new TransientRunError(error.code, node)
      : new RunFailure(error.code, node);
  }
  return new TransientRunError('INTERNAL_ERROR', node);
}

async function audit(
  deps: RunDeps,
  run: Pick<PipelineRun, 'workspaceId' | 'id'>,
  action: 'run.completed' | 'run.failed' | 'run.cancelled',
  metadata: Record<string, string | number | boolean | null>,
): Promise<void> {
  await deps.db.insert(auditEvents).values({
    workspaceId: run.workspaceId,
    actorId: 'orchestrator',
    action,
    resourceType: 'run',
    resourceId: run.id,
    metadata,
  });
}

/**
 * Executes one run of the stage scope (D-2C-01): transcription over windows, then diarization,
 * then atomic persistence of transcript v1. One bounded loop in one job (concurrency 1); the run
 * row is the source of truth, so a redelivered job resumes safely (raw outputs already stored are
 * reused, never re-requested). Cancel and the deadline are checked between windows. A transient
 * failure is rethrown for BullMQ's attempts and backoff until the attempts are spent, then the run
 * is failed with a code (no content). Logs and audit metadata carry IDs and codes only.
 */
export async function executeRun(
  deps: RunDeps,
  payload: unknown,
  attempts: Attempts,
): Promise<void> {
  const { workspaceId, runId } = RunTranscriptionJob.parse(payload); // ZodError: caller treats as unrecoverable
  const { db } = deps;
  const run = await getRun(db, workspaceId, runId);
  if (!run) {
    deps.log({ msg: 'run_missing', runId });
    return;
  }
  if (run.status === 'cancelling') {
    await finishCancelled(deps, run);
    return;
  }
  if (run.status !== 'queued' && run.status !== 'running') return; // created or terminal: nothing to do
  if (!(await markRunStarted(db, workspaceId, runId))) return;

  const attempt = run.retryCount + 1;
  let node: Node | null = null;
  const startedAt = deps.now();
  try {
    const config = RunConfig.safeParse(run.config);
    if (!config.success || !config.data.stages.includes('transcription')) {
      throw new RunFailure('INVALID_RUN_CONFIG');
    }
    const stages = config.data.stages;
    if (!run.preprocessingId) throw new RunFailure('PREPROCESSING_REQUIRED');
    const preprocessing = await getPreprocessing(db, workspaceId, run.preprocessingId);
    if (
      !preprocessing ||
      preprocessing.status !== 'succeeded' ||
      !preprocessing.normalizedUri ||
      !preprocessing.canonicalDurationMs ||
      preprocessing.canonicalDurationMs <= 0
    ) {
      throw new RunFailure('PREPROCESSING_REQUIRED');
    }
    const [recording] = await db
      .select({ status: recordings.status })
      .from(recordings)
      .where(and(eq(recordings.workspaceId, workspaceId), eq(recordings.id, run.recordingId)));
    if (recording?.status !== 'valid') throw new RunFailure('RECORDING_NOT_VALID');

    const durationMs = preprocessing.canonicalDurationMs;
    const audioUri = preprocessing.normalizedUri;
    const source: AudioSourceRef = {
      workspaceId,
      recordingId: run.recordingId,
      preprocessingConfigHash: preprocessing.configHash,
    };
    const vad = await listSegments(db, workspaceId, preprocessing.id, { limit: MAX_WINDOWS + 1 });
    if (vad.length > MAX_WINDOWS) throw new RunFailure('WINDOW_LIMIT_EXCEEDED');
    const plan = planWindows({
      durationMs,
      vadSegments: vad.map((s) => ({
        index: s.index,
        startMs: s.startMs,
        endMs: s.endMs,
        overlapStartMs: s.overlapStartMs,
        overlapEndMs: s.overlapEndMs,
      })),
    });
    if (plan.windows.length === 0) throw new RunFailure('NO_AUDIO_WINDOWS');
    if (plan.windows.length > MAX_WINDOWS) throw new RunFailure('WINDOW_LIMIT_EXCEEDED');

    await mergeRunConfig(db, workspaceId, runId, {
      providers: {
        stt: { id: deps.stt.id, model: deps.stt.model, fake: deps.stt.capabilities().fake },
        diarization: {
          id: deps.diarization.id,
          model: deps.diarization.model,
          fake: deps.diarization.capabilities().fake,
        },
      },
      window: {
        source: plan.source,
        windowMs: plan.params?.windowMs ?? null,
        overlapMs: plan.params?.overlapMs ?? null,
        count: plan.windows.length,
      },
    });

    const checkpoint = async (): Promise<void> => {
      const current = await getRun(db, workspaceId, runId);
      if (!current) throw new RunFailure('RUN_MISSING');
      if (current.status === 'cancelling' || current.cancelRequestedAt)
        throw new RunCancelledSignal();
      if (current.status !== 'running') throw new RunCancelledSignal(); // not ours any more
      if (deps.now() - startedAt > runDeadlineMs(deps.config, durationMs))
        throw new RunFailure('TIMEOUT');
    };

    /* ---- stage: transcription ---- */
    node = 'transcription';
    await beginStage(db, workspaceId, runId, node, attempt);
    await setRunStage(db, workspaceId, runId, node);
    const results: WindowResult[] = [];
    let written: WrittenProgress | null = null;
    for (const [i, window] of plan.windows.entries()) {
      await checkpoint();
      results.push(
        await transcribeWindow(deps, run, audioUri, durationMs, config.data, window, source),
      );
      const fraction = (i + 1) / plan.windows.length;
      const now = deps.now();
      if (shouldWriteStageProgress(written, fraction, now)) {
        await updateStageProgress(db, workspaceId, runId, node, attempt, {
          fraction,
          processedMs: window.endMs,
          updatedAt: new Date(now).toISOString(),
        });
        written = { fraction, at: now };
      }
    }
    const segments = stitchWindows(results);
    await finishStage(db, workspaceId, runId, node, attempt, 'completed');

    /* ---- stage: diarization ---- */
    let turns: DiarizationTurn[] = [];
    if (stages.includes('diarization')) {
      node = 'diarization';
      await beginStage(db, workspaceId, runId, node, attempt);
      await setRunStage(db, workspaceId, runId, node);
      await checkpoint();
      const out = await diarize(deps, run, audioUri, durationMs, source);
      turns = out.turns;
      await updateStageProgress(db, workspaceId, runId, node, attempt, {
        fraction: 1,
        processedMs: durationMs,
        updatedAt: new Date(deps.now()).toISOString(),
      });
      await finishStage(db, workspaceId, runId, node, attempt, 'completed');
    }

    /* ---- persist transcript v1 (atomic) ---- */
    await checkpoint();
    const aligned = stages.includes('diarization')
      ? alignSpeakers(segments, turns)
      : { assignments: segments.map(() => ({ speakerKey: null })), uncertainties: [] };
    const speakerKeys = [
      ...new Set(aligned.assignments.flatMap((a) => (a.speakerKey ? [a.speakerKey] : []))),
    ].sort();
    const done = await completeRunWithTranscript(db, {
      workspaceId,
      runId,
      createdBy: 'system',
      speakerKeys,
      segments: segments.map((s, i) => ({
        startMs: s.startMs,
        endMs: s.endMs,
        text: s.text,
        language: s.language,
        codeSwitchSpans: s.codeSwitchSpans ?? null,
        confidence: s.confidence ?? null,
        words: s.words ?? null,
        speakerKey: aligned.assignments[i]?.speakerKey ?? null,
        sourceRawOutputIds: s.sourceRawOutputIds,
      })),
      uncertainties: aligned.uncertainties,
    });
    if (done) {
      await audit(deps, run, 'run.completed', {
        segmentCount: segments.length,
        speakerCount: speakerKeys.length,
        retryCount: run.retryCount,
      });
      deps.log({ msg: 'run_completed', runId, segments: segments.length });
    } else {
      const latest = await getRun(db, workspaceId, runId);
      if (latest?.status === 'cancelling') await finishCancelled(deps, latest);
    }
  } catch (error) {
    if (error instanceof RunCancelledSignal) {
      const latest = await getRun(db, workspaceId, runId);
      if (latest?.status === 'cancelling') await finishCancelled(deps, latest, node, attempt);
      return;
    }
    const failure = toRunError(error, node);
    const lastAttempt = attempts.attemptsMade + 1 >= attempts.attempts;
    if (failure instanceof TransientRunError && !lastAttempt) {
      deps.log({ msg: 'run_attempt_failed', runId, code: failure.code, retrying: true });
      throw failure; // BullMQ retries with backoff; the run stays `running`
    }
    await failRun(deps, run, failure.node ?? node, failure.code, attempt);
  }
}

async function failRun(
  deps: RunDeps,
  run: PipelineRun,
  node: Node | null,
  code: string,
  attempt: number,
): Promise<void> {
  const { db } = deps;
  if (node) await finishStage(db, run.workspaceId, run.id, node, attempt, 'failed', { code });
  if (await markRunFailed(db, run.workspaceId, run.id, { code, node })) {
    await audit(deps, run, 'run.failed', { code, node, retryCount: run.retryCount });
    deps.log({ msg: 'run_failed', runId: run.id, code, node });
  }
}

/** cancelling -> cancelled: the running stage is closed, completed artefacts are kept. */
export async function finishCancelled(
  deps: RunDeps,
  run: Pick<PipelineRun, 'workspaceId' | 'id' | 'retryCount'>,
  node?: Node | null,
  attempt?: number,
): Promise<void> {
  const { db } = deps;
  for (const n of node ? [node] : (['transcription', 'diarization'] as const)) {
    await finishStage(db, run.workspaceId, run.id, n, attempt ?? run.retryCount + 1, 'cancelled');
  }
  if (await markRunCancelled(db, run.workspaceId, run.id)) {
    await audit(deps, run, 'run.cancelled', { retryCount: run.retryCount });
    deps.log({ msg: 'run_cancelled', runId: run.id });
  }
}

async function transcribeWindow(
  deps: RunDeps,
  run: PipelineRun,
  audioUri: string,
  durationMs: number,
  config: RunConfig,
  window: TranscriptionWindow,
  source: AudioSourceRef,
): Promise<WindowResult> {
  const { db, store, stt } = deps;
  const request: SttRequest = {
    audioUri,
    offsetMs: window.startMs,
    audioDurationMs: durationMs,
    window: { index: window.index, startMs: window.startMs, endMs: window.endMs },
    ...(config.languageHints ? { languageHints: config.languageHints } : {}),
    rawKey: sttRawKey(run.workspaceId, run.id, window.index),
    source,
  };

  // Raw output already stored by an earlier attempt: re-map it, never re-request or overwrite it.
  const existing = await getSttRawOutput(db, run.workspaceId, run.id, window.index);
  let segments: SttSegment[];
  let rawOutputId: string;
  if (existing) {
    const stored = await store.get(request.rawKey).catch(() => null);
    if (!stored || stored.sha256 !== existing.sha256)
      throw new RunFailure('RAW_OUTPUT_CORRUPT', 'transcription');
    segments = stt.mapRaw(stored.payload, request);
    rawOutputId = existing.id;
  } else {
    const out = await obtainRawOutput(
      store,
      request.rawKey,
      stt.model,
      () =>
        withTimeout(
          stt.transcribe(request),
          providerTimeoutMs(deps.config, window.endMs - window.startMs),
          'transcription',
        ),
      (payload) => ({ segments: stt.mapRaw(payload, request) }),
    );
    const { row, created } = await insertSttRawOutput(db, {
      workspaceId: run.workspaceId,
      runId: run.id,
      windowIndex: window.index,
      windowStartMs: window.startMs,
      windowEndMs: window.endMs,
      provider: stt.id,
      providerModel: out.raw.providerModel,
      requestParams: config.languageHints ? { languageHints: config.languageHints } : null,
      payloadUri: out.raw.payloadUri,
      sha256: out.raw.sha256,
    });
    if (!created && row.sha256 !== out.raw.sha256)
      throw new RunFailure('RAW_OUTPUT_CONFLICT', 'transcription');
    segments = out.segments;
    rawOutputId = row.id;
  }
  return { window, segments: validateSegments(segments, durationMs), rawOutputId };
}

async function diarize(
  deps: RunDeps,
  run: PipelineRun,
  audioUri: string,
  durationMs: number,
  source: AudioSourceRef,
): Promise<{ turns: DiarizationTurn[]; rawId: string }> {
  const { db, store, diarization } = deps;
  const request: DiarizationRequest = {
    audioUri,
    durationMs,
    rawKey: diarizationRawKey(run.workspaceId, run.id),
    source,
  };
  const existing = await getWholeDiarizationRawOutput(db, run.workspaceId, run.id);
  let turns: DiarizationTurn[];
  let rawId: string;
  if (existing) {
    const stored = await store.get(request.rawKey).catch(() => null);
    if (!stored || stored.sha256 !== existing.sha256)
      throw new RunFailure('RAW_OUTPUT_CORRUPT', 'diarization');
    turns = diarization.mapRaw(stored.payload, request);
    rawId = existing.id;
  } else {
    const out = await obtainRawOutput(
      store,
      request.rawKey,
      diarization.model,
      () =>
        withTimeout(
          diarization.diarize(request),
          providerTimeoutMs(deps.config, durationMs),
          'diarization',
        ),
      (payload) => ({ turns: diarization.mapRaw(payload, request) }),
    );
    const { row, created } = await insertDiarizationRawOutput(db, {
      workspaceId: run.workspaceId,
      runId: run.id,
      provider: diarization.id,
      providerModel: out.raw.providerModel,
      scope: 'whole',
      payloadUri: out.raw.payloadUri,
      sha256: out.raw.sha256,
    });
    if (!created && row.sha256 !== out.raw.sha256)
      throw new RunFailure('RAW_OUTPUT_CONFLICT', 'diarization');
    turns = out.turns;
    rawId = row.id;
  }
  return { turns: validateTurns(turns, durationMs), rawId };
}
