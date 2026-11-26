import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEV_WORKSPACE_ID,
  completePreprocessing,
  createDb,
  getLatestAudioQualityStage,
  getLatestDiagnostics,
  getRun,
  insertCreatedRun,
  listDiagnosticFlags,
  markRunning,
  recordings,
  requestRunCancel,
  runMigrations,
  seedDevelopment,
  submitRun,
  upsertPreprocessing,
  beginStage,
  sql,
  type DbHandle,
} from '@vip/db';
import { loadConfig } from '../src/config';
import {
  processAssessment,
  sweepAudioQuality,
  type AudioQualityDeps,
} from '../src/agents/audio-quality/audio-quality.workers';
import { A1_RULE_CONFIG } from '../src/agents/audio-quality/rule-config';
import { FakeAudioTasks } from './support/fake-audio-tasks';
import { getLatestMeasurementSet, getSetMeasurement } from '@vip/db';
import { readFileSync } from 'node:fs';

/** Integration: real Postgres (`_test` database); the queue is a recording double. */
const dbUrl = process.env.TEST_DATABASE_URL;
if (!dbUrl || !new URL(dbUrl).pathname.endsWith('_test'))
  throw new Error('TEST_DATABASE_URL must point at a database ending in _test');

const W = DEV_WORKSPACE_ID;
const cfg = loadConfig({
  REDIS_URL: 'redis://127.0.0.1:6379/15',
  DATABASE_URL: dbUrl,
  AUDIO_SERVICE_URL: 'http://127.0.0.1:8001',
  LOG_LEVEL: 'fatal',
}).audioQuality;

let handle: DbHandle;
let storageRoot: string;
let deps: AudioQualityDeps;

const q = (value: number, kind: 'measured' | 'derived' | 'estimate', unit = 'dBFS') => ({
  value,
  unit,
  kind,
  method: 'test',
});

const record = (source: 'canonical' | 'original_decoded', quantities: Record<string, unknown>) => ({
  measurementsSchemaVersion: 1,
  source,
  sampleRateHz: 16000,
  channels: 1,
  frames: 960000,
  quantities,
  perChannel: [],
  unavailable: [],
});

const timeline = {
  schemaVersion: 1,
  nativeSampleRate: 16000,
  decodedSamplesNative: 960000,
  canonicalSamples: 960000,
  source: {
    container: 'wav',
    codec: 'pcm_s16le',
    sampleRateHz: 16000,
    channels: 1,
    headerDurationMs: 60000,
  },
  sourceOffsetMs: 0,
  decodeClass: 'full',
  decodedUntilMs: 60000,
  gaps: [],
  overlapsTrimmed: [],
  decodeErrors: { count: 0, firstAtMs: null },
  mappingStatus: 'exact',
  mappingErrorBoundMs: 0,
  reasons: [],
};

/** A succeeded preprocessing with Phase 2B-shaped measurements and a level series on disk. */
async function preparedRun(opts: { clipped?: boolean; seriesKey?: string } = {}) {
  const recordingId = crypto.randomUUID();
  await handle.db.insert(recordings).values({
    id: recordingId,
    workspaceId: W,
    originalFilename: 'synthetic.wav',
    storageUri: `local://recordings/${W}/${recordingId}/original`,
    mimeType: 'audio/wav',
    sizeBytes: 1000,
    status: 'valid',
  });
  const { preprocessing } = await upsertPreprocessing(handle.db, {
    workspaceId: W,
    recordingId,
    configHash: crypto.randomUUID().replaceAll('-', '').padEnd(64, '0'),
    config: {},
    toolVersions: {},
  });
  const key = opts.seriesKey ?? `derived/${W}/${recordingId}/${'a'.repeat(64)}/level-series.json`;
  const peak = Array(600).fill(-6);
  if (opts.clipped) peak.fill(0, 100, 110);
  if (!opts.seriesKey) {
    await mkdir(join(storageRoot, key, '..'), { recursive: true });
    await writeFile(
      join(storageRoot, key),
      JSON.stringify({
        schemaVersion: 1,
        intervalMs: 100,
        sampleRateHz: 16000,
        windows: 600,
        rmsDbfs: Array(600).fill(-24),
        peakDbfs: peak,
      }),
    );
  }
  await markRunning(handle.db, W, preprocessing.id);
  await completePreprocessing(handle.db, {
    workspaceId: W,
    id: preprocessing.id,
    normalizedUri: 'local://derived/x/canonical.wav',
    canonicalSha256: 'c'.repeat(64),
    canonicalDurationMs: 60000,
    timeline,
    artifacts: { levelSeriesUri: `local://${key}` },
    segments: [],
    measurements: [
      {
        source: 'canonical',
        schemaVersion: '1',
        serviceVersion: 's',
        measurements: record('canonical', {
          peakDbfs: q(opts.clipped ? 0 : -6, 'measured'),
          silenceRatio: q(0.1, 'derived', 'ratio'),
          noiseFloorDbfs: q(-70, 'estimate'),
        }),
      },
      {
        source: 'original_decoded',
        schemaVersion: '1',
        serviceVersion: 's',
        measurements: record('original_decoded', {
          clippedRatio: q(opts.clipped ? 0.1 : 0, 'derived', 'ratio'),
          integratedLoudnessLufs: q(-23, 'estimate', 'LUFS'),
        }),
      },
    ],
  });
  const run = await insertCreatedRun(handle.db, W, recordingId);
  return { recordingId, preprocessingId: preprocessing.id, runId: run.id };
}

const job = { attemptsMade: 0, attempts: 3 };

beforeAll(async () => {
  handle = createDb(dbUrl, { maxConnections: 4 });
  await runMigrations(handle.db);
  await seedDevelopment(handle.db);
  storageRoot = await mkdtemp(join(tmpdir(), 'vip-a1-'));
  deps = { db: handle.db, storageRoot, cfg, rules: A1_RULE_CONFIG, log: () => undefined };
});
afterAll(async () => {
  await handle?.close();
  await rm(storageRoot, { recursive: true, force: true });
});

describe('A1 Audio Quality worker (integration)', () => {
  it('sweep enqueues a created run whose preprocessing succeeded (lifecycle L2), once per attempt', async () => {
    const { runId } = await preparedRun();
    const enqueued: [string, number][] = [];
    const queue = {
      enqueue: async (_w: string, id: string, attempt: number) => void enqueued.push([id, attempt]),
      isLive: async () => false,
    };
    await sweepAudioQuality(deps, queue);
    expect(enqueued).toContainEqual([runId, 1]);
  });

  it('assesses a created run before transcription: diagnostics, flags, completed stage; run untouched', async () => {
    const ids = await preparedRun({ clipped: true });
    await processAssessment(deps, { workspaceId: W, runId: ids.runId, attempt: 1 }, job);
    const diag = await getLatestDiagnostics(handle.db, W, ids.runId, ids.preprocessingId);
    expect(diag).toMatchObject({
      overall: 'poor',
      confidence: 'low', // Tier 0 only: no speech split
      tier1: 'not_requested',
      provisional: false,
      ruleVersion: A1_RULE_CONFIG.ruleVersion,
    });
    const flags = await listDiagnosticFlags(handle.db, W, diag!.id);
    expect(flags.find((f) => f.ruleId === 'clipping.region')).toMatchObject({
      startMs: 10_000,
      endMs: 11_000,
    });
    expect(await getLatestAudioQualityStage(handle.db, W, ids.runId)).toMatchObject({
      attempt: 1,
      status: 'completed',
    });
    expect((await getRun(handle.db, W, ids.runId))?.status).toBe('created'); // never submitted by A1
  });

  it('is idempotent: a redelivered attempt returns the same diagnostics', async () => {
    const ids = await preparedRun();
    await processAssessment(deps, { workspaceId: W, runId: ids.runId, attempt: 1 }, job);
    const first = await getLatestDiagnostics(handle.db, W, ids.runId);
    await processAssessment(deps, { workspaceId: W, runId: ids.runId, attempt: 1 }, job);
    const again = await getLatestDiagnostics(handle.db, W, ids.runId);
    expect(again?.id).toBe(first?.id);
    expect(first?.overall).toBe('good');
  });

  it('records an invalid input as a failed A1 stage with a code and leaves the run alone (L4)', async () => {
    const ids = await preparedRun({ seriesKey: '../../etc/passwd.json' });
    await processAssessment(deps, { workspaceId: W, runId: ids.runId, attempt: 1 }, job);
    expect(await getLatestAudioQualityStage(handle.db, W, ids.runId)).toMatchObject({
      status: 'failed',
      error: { code: 'A1_SERIES_KEY_INVALID' },
    });
    expect(await getLatestDiagnostics(handle.db, W, ids.runId)).toBeNull();
    expect((await getRun(handle.db, W, ids.runId))?.status).toBe('created');
  });

  it('stops for a cancelled run and writes no diagnostics (L5)', async () => {
    const ids = await preparedRun();
    await submitRun(handle.db, W, ids.runId, { preprocessingId: ids.preprocessingId, config: {} });
    expect(await requestRunCancel(handle.db, W, ids.runId)).toBe('cancelled');
    await processAssessment(deps, { workspaceId: W, runId: ids.runId, attempt: 1 }, job);
    expect(await getLatestDiagnostics(handle.db, W, ids.runId)).toBeNull();
  });

  it('re-assesses after submission when the run pins a different preprocessing version (L3)', async () => {
    const ids = await preparedRun();
    await processAssessment(deps, { workspaceId: W, runId: ids.runId, attempt: 1 }, job);
    const other = await preparedRun();
    // submit the first run against the other recording's version: simulates a newer version
    await submitRun(handle.db, W, ids.runId, {
      preprocessingId: other.preprocessingId,
      config: {},
    });
    const enqueued: [string, number][] = [];
    await sweepAudioQuality(deps, {
      enqueue: async (_w, id, attempt) => void enqueued.push([id, attempt]),
      isLive: async () => false,
    });
    expect(enqueued).toContainEqual([ids.runId, 2]);
  });

  it('re-assesses after a run retry when the earlier A1 attempt failed (L7 / L3)', async () => {
    const ids = await preparedRun({ seriesKey: '../../etc/passwd.json' });
    await processAssessment(deps, { workspaceId: W, runId: ids.runId, attempt: 1 }, job);
    expect((await getLatestAudioQualityStage(handle.db, W, ids.runId))?.status).toBe('failed');
    await submitRun(handle.db, W, ids.runId, { preprocessingId: ids.preprocessingId, config: {} });
    const enqueued: [string, number][] = [];
    await sweepAudioQuality(deps, {
      enqueue: async (_w, id, attempt) => void enqueued.push([id, attempt]),
      isLive: async () => false,
    });
    expect(enqueued).toContainEqual([ids.runId, 2]);
  });

  it('a redelivered job never rewrites a completed attempt (L5)', async () => {
    const ids = await preparedRun();
    await processAssessment(deps, { workspaceId: W, runId: ids.runId, attempt: 1 }, job);
    const before = await getLatestAudioQualityStage(handle.db, W, ids.runId);
    await processAssessment(deps, { workspaceId: W, runId: ids.runId, attempt: 1 }, job);
    expect(await getLatestAudioQualityStage(handle.db, W, ids.runId)).toEqual(before);
  });

  it('fails a stuck A1 stage instead of re-enqueueing it forever (bounded workers)', async () => {
    const ids = await preparedRun();
    await beginStage(handle.db, W, ids.runId, 'audio_quality', 1);
    const enqueued: [string, number][] = [];
    await sweepAudioQuality(
      deps,
      { enqueue: async (_w, id, a) => void enqueued.push([id, a]), isLive: async () => false },
      Date.now() + cfg.stuckAfterMs + 60_000,
    );
    expect(await getLatestAudioQualityStage(handle.db, W, ids.runId)).toMatchObject({
      status: 'failed',
      error: { code: 'A1_STALLED' },
    });
    expect(enqueued.filter(([id]) => id === ids.runId)).toEqual([]);
  });

  describe('Tier 1 (measure task, ADR-0045)', () => {
    const measureResult = JSON.parse(
      readFileSync(
        join(
          __dirname,
          '../../../packages/contracts/fixtures/audio-service/measure-result.valid.json',
        ),
        'utf8',
      ),
    ) as Record<string, unknown>;
    const tier1Deps = (audio: FakeAudioTasks): AudioQualityDeps => ({
      ...deps,
      measure: {
        db: handle.db,
        audio: { audio, pollMs: 1, sleep: async () => undefined },
        storageRoot,
        vad: { threshold: 0.4, minSilenceMs: 300, minSpeechMs: 250, paddingMs: 200 },
        maxAttempts: 3,
        heartbeatMs: 0,
        log: () => undefined,
      },
    });

    it('a live set waiting behind other tasks is kept alive by its heartbeat, not failed as stuck', async () => {
      // Security review (Phase 3A M8): the measure task can queue behind a long transcription;
      // without the heartbeat the stuck-set sweep failed it and discarded the result.
      const ids = await preparedRun();
      const audio = new FakeAudioTasks();
      audio.scripts.measure.push([
        { status: 'running' },
        { status: 'running' },
        { status: 'running' },
        { status: 'succeeded', result: measureResult },
      ]);
      let sleeps = 0;
      const base = tier1Deps(audio);
      const live: AudioQualityDeps = {
        ...base,
        measure: {
          ...base.measure!,
          audio: {
            audio,
            pollMs: 1,
            sleep: async () => {
              sleeps += 1;
              // Poll 2: the set's last change is long past the stuck-after window...
              if (sleeps === 2)
                await handle.db.execute(
                  sql`UPDATE audio_measurement_sets SET updated_at = now() - interval '1 hour' WHERE preprocessing_id = ${ids.preprocessingId}`,
                );
              // ...poll 3: the sweep runs; the heartbeat after poll 2 has refreshed the set.
              if (sleeps === 3)
                await sweepAudioQuality(base, {
                  enqueue: async () => undefined,
                  isLive: async () => true,
                });
            },
          },
        },
      };
      await processAssessment(live, { workspaceId: W, runId: ids.runId, attempt: 1 }, job);
      const set = await getLatestMeasurementSet(handle.db, W, ids.preprocessingId);
      expect(set).toMatchObject({ status: 'succeeded' });
      expect(await getLatestDiagnostics(handle.db, W, ids.runId)).toMatchObject({
        tier1: 'available',
      });
    });

    it('measures once per preprocessing version, writes the speech series, then assesses with Tier 1', async () => {
      const ids = await preparedRun();
      const audio = new FakeAudioTasks();
      audio.scripts.measure.push([
        { status: 'running' },
        { status: 'succeeded', result: measureResult },
      ]);
      await processAssessment(
        tier1Deps(audio),
        { workspaceId: W, runId: ids.runId, attempt: 1 },
        job,
      );
      expect(audio.submits.map((r) => r.type)).toEqual(['measure']);
      const set = await getLatestMeasurementSet(handle.db, W, ids.preprocessingId);
      expect(set?.status).toBe('succeeded');
      expect((await getSetMeasurement(handle.db, W, set!.id))?.schemaVersion).toBe('2');
      const series = JSON.parse(
        readFileSync(join(storageRoot, set!.seriesUri!.slice('local://'.length)), 'utf8'),
      ) as { blockMs: number };
      expect(series.blockMs).toBe(1000);
      const diag = await getLatestDiagnostics(handle.db, W, ids.runId);
      expect(diag).toMatchObject({ tier1: 'available', measurementSetId: set!.id });
      expect(diag?.confidence).not.toBe('low'); // a speech split exists now
      // a second run on the same version reuses the set: no new measure task
      const run2 = await insertCreatedRun(handle.db, W, ids.recordingId);
      await processAssessment(
        tier1Deps(audio),
        { workspaceId: W, runId: run2.id, attempt: 1 },
        job,
      );
      expect(audio.submits).toHaveLength(1);
    });

    it('falls back to Tier 0 with low confidence when the measure task fails permanently', async () => {
      const ids = await preparedRun();
      const audio = new FakeAudioTasks();
      audio.scripts.measure.push([
        { status: 'failed', code: 'UNSUPPORTED_TASK_TYPE', retryable: false },
      ]);
      await processAssessment(
        tier1Deps(audio),
        { workspaceId: W, runId: ids.runId, attempt: 1 },
        job,
      );
      const set = await getLatestMeasurementSet(handle.db, W, ids.preprocessingId);
      expect(set).toMatchObject({
        status: 'failed',
        error: { code: 'AUDIO_UNSUPPORTED_TASK_TYPE' },
      });
      const diag = await getLatestDiagnostics(handle.db, W, ids.runId);
      expect(diag).toMatchObject({ tier1: 'failed', confidence: 'low' });
      expect(await getLatestAudioQualityStage(handle.db, W, ids.runId)).toMatchObject({
        status: 'completed',
      });
    });

    it('rethrows a retryable measure failure while the job can retry, without writing diagnostics', async () => {
      const ids = await preparedRun();
      const audio = new FakeAudioTasks();
      audio.scripts.measure.push([{ status: 'failed', code: 'TIMEOUT', retryable: true }]);
      await expect(
        processAssessment(tier1Deps(audio), { workspaceId: W, runId: ids.runId, attempt: 1 }, job),
      ).rejects.toThrow();
      expect(await getLatestDiagnostics(handle.db, W, ids.runId)).toBeNull();
      expect((await getLatestMeasurementSet(handle.db, W, ids.preprocessingId))?.status).toBe(
        'running',
      );
      // the retried job completes against a restarted service (the scripted double cannot replay
      // the real service's "earlier failed task" answer for a known key)
      const restarted = new FakeAudioTasks();
      restarted.scripts.measure.push([{ status: 'succeeded', result: measureResult }]);
      await processAssessment(
        tier1Deps(restarted),
        { workspaceId: W, runId: ids.runId, attempt: 1 },
        job,
      );
      expect((await getLatestDiagnostics(handle.db, W, ids.runId))?.tier1).toBe('available');
    });
  });
});
