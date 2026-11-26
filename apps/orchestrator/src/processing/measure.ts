/**
 * Speech-aware measurement coordinator (Phase 3A, ADR-0045). Part of the preprocessing side, not of
 * A1: it runs the audio-service `measure` task for a preprocessing version and persists the
 * objective result as a measurement set (one per version and measure config hash, reused by every
 * run). It writes numbers only; A1 reads them and judges.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, realpath, rename, writeFile } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import {
  AudioMeasureConfig,
  AudioMeasureResult,
  INTERIM_TRANSCRIPTION_WINDOW,
  type AudioVadSettings,
} from '@vip/contracts';
import {
  completeMeasurementSet,
  getMeasurementSet,
  incrementSetAttempt,
  markSetFailed,
  markSetRunning,
  resetSetForRetry,
  touchRunningSet,
  upsertMeasurementSet,
  type AudioMeasurementSet,
  type AudioPreprocessing,
  type Database,
} from '@vip/db';
import { runAudioTask, type AudioTaskDeps } from '../providers/audio-task';
import { ProviderError } from '../providers/errors';

/**
 * Measure config defaults (M0: 1000 ms blocks; LTAS edge -50 dB above 300 Hz; ADR-0039 windows;
 * near-clean SNR switch at 45 dB, chosen on the M0 dev split, OD-52).
 */
export const MEASURE_DEFAULTS = {
  schemaVersion: 1,
  blockMs: 1000,
  // The transcription window grid (ADR-0039), so spans per window follow transcription's grid.
  windowMs: INTERIM_TRANSCRIPTION_WINDOW.windowMs,
  overlapMs: INTERIM_TRANSCRIPTION_WINDOW.overlapMs,
  ltasDropDb: 50,
  ltasMinHz: 300,
  snrNearCleanDb: 45,
} as const;

export interface MeasureDeps {
  db: Database;
  audio: AudioTaskDeps;
  storageRoot: string;
  vad: AudioVadSettings;
  /** Attempts of the measure task per set before it is recorded as failed. */
  maxAttempts: number;
  /** Interval of the running set's liveness heartbeat; keep it well below the sweep's stuck-after. */
  heartbeatMs: number;
  log: (event: Record<string, unknown>) => void;
}

/**
 * Hash of the measure config: SHA-256 of key-sorted JSON. (`canonicalJson` is integer-only for the
 * preprocessing config hash; the measure config carries the fractional VAD threshold.)
 */
export function measureConfigHash(config: unknown): string {
  const sorted = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sorted)
      : v !== null && typeof v === 'object'
        ? Object.fromEntries(
            Object.keys(v as object)
              .sort()
              .map((k) => [k, sorted((v as Record<string, unknown>)[k])]),
          )
        : v;
  return createHash('sha256')
    .update(JSON.stringify(sorted(config)))
    .digest('hex');
}

export const speechSeriesKey = (pre: AudioPreprocessing, measureHash: string): string =>
  `derived/${pre.workspaceId}/${pre.recordingId}/a1-measure/${measureHash}/speech-series.json`;

export function measureConfigFor(
  pre: AudioPreprocessing,
  vad: AudioVadSettings,
): AudioMeasureConfig {
  const samples = (pre.artifacts as { canonicalSamples?: unknown } | null)?.canonicalSamples;
  const audioDurationMs =
    typeof samples === 'number' ? Math.ceil(samples / 16) : (pre.canonicalDurationMs ?? 0);
  return AudioMeasureConfig.parse({ ...MEASURE_DEFAULTS, audioDurationMs, vad });
}

async function writeAtomic(root: string, key: string, payload: unknown): Promise<void> {
  const target = join(root, key);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  // Stay under the storage root even if a directory on the path is a symlink (mirrors inputs.ts).
  const [dir, base] = await Promise.all([realpath(dirname(target)), realpath(root)]);
  if (!dir.startsWith(base + sep)) throw new ProviderError('MEASURE_STORAGE_PATH_INVALID', false);
  const temp = `${target}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(payload), { mode: 0o600 });
  await rename(temp, target);
}

export type MeasureOutcome = 'succeeded' | 'failed';

/**
 * Ensures a terminal measurement set for the version. Retryable task failures are rethrown while
 * `canRetry` (the caller's job retries); afterwards the set is recorded `failed` with a code and
 * A1 falls back to Tier 0. Never throws for a permanent failure.
 */
export async function ensureMeasurementSet(
  deps: MeasureDeps,
  pre: AudioPreprocessing,
  canRetry: boolean,
): Promise<{ set: AudioMeasurementSet; outcome: MeasureOutcome }> {
  const config = measureConfigFor(pre, deps.vad);
  const configHash = measureConfigHash(config);
  let { set } = await upsertMeasurementSet(deps.db, {
    workspaceId: pre.workspaceId,
    preprocessingId: pre.id,
    configHash,
    config,
  });
  if (set.status === 'succeeded') return { set, outcome: 'succeeded' };
  // The attempt cap holds whatever the status (a set left `running` by a lost job included).
  if (set.attempt >= deps.maxAttempts) {
    if (set.status === 'queued' || set.status === 'running')
      await markSetFailed(deps.db, pre.workspaceId, set.id, {
        code: 'MEASURE_ATTEMPTS_EXHAUSTED',
        retryable: false,
      });
    set = (await getMeasurementSet(deps.db, pre.workspaceId, set.id)) ?? set;
    return { set, outcome: 'failed' };
  }
  if (set.status === 'failed' || set.status === 'cancelled')
    await resetSetForRetry(deps.db, pre.workspaceId, set.id);
  await markSetRunning(deps.db, pre.workspaceId, set.id);
  // Compare-and-set: of concurrent workers on one set, only the one that counts this attempt runs
  // the task. The loser retries later (or, on its last attempt, A1 proceeds with Tier 1 pending).
  if (!(await incrementSetAttempt(deps.db, pre.workspaceId, set.id, set.attempt))) {
    if (canRetry) throw new ProviderError('MEASURE_BUSY', true);
    return { set, outcome: 'failed' };
  }
  // Heartbeat while the task waits or runs (it can queue behind transcription for minutes), so the
  // stuck-set sweep only fails a set whose job is really gone.
  let beatAt = Date.now();
  const heartbeat = async (): Promise<void> => {
    if (Date.now() - beatAt < deps.heartbeatMs) return;
    beatAt = Date.now();
    await touchRunningSet(deps.db, pre.workspaceId, set.id);
  };
  try {
    const raw = await runAudioTask(
      deps.audio,
      'measure',
      {
        workspaceId: pre.workspaceId,
        recordingId: pre.recordingId,
        preprocessingConfigHash: pre.configHash,
      },
      config,
      heartbeat,
    );
    const result = AudioMeasureResult.safeParse(raw);
    if (!result.success) throw new ProviderError('MEASURE_OUTPUT_INVALID', false);
    const key = speechSeriesKey(pre, configHash);
    await writeAtomic(deps.storageRoot, key, result.data.series);
    const completed = await completeMeasurementSet(deps.db, {
      workspaceId: pre.workspaceId,
      id: set.id,
      seriesUri: `local://${key}`,
      toolVersions: { vadModel: result.data.vad.model, vadSha256: result.data.vad.sha256 },
      measurements: result.data.record as unknown as Record<string, unknown>,
      schemaVersion: '2',
      serviceVersion: 'measure-1',
    });
    deps.log({
      msg: completed ? 'measure_succeeded' : 'measure_completion_discarded',
      preprocessingId: pre.id,
      measurementSetId: set.id,
    });
  } catch (error) {
    const code = error instanceof ProviderError ? error.code : 'MEASURE_INTERNAL';
    const retryable = error instanceof ProviderError ? error.retryable : true;
    if (retryable && canRetry) throw error;
    await markSetFailed(deps.db, pre.workspaceId, set.id, { code, retryable });
    deps.log({ msg: 'measure_failed', preprocessingId: pre.id, measurementSetId: set.id, code });
  }
  set = (await getMeasurementSet(deps.db, pre.workspaceId, set.id)) ?? set;
  return { set, outcome: set.status === 'succeeded' ? 'succeeded' : 'failed' };
}
