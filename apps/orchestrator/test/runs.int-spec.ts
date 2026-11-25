import 'reflect-metadata';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { DiarizationRequest, DiarizationTurn, SttRequest } from '@vip/contracts';
import {
  DEV_WORKSPACE_ID,
  and,
  auditEvents,
  completePreprocessing,
  createDb,
  eq,
  getRun,
  getTranscriptForRun,
  getTranscriptVersion,
  insertCreatedRun,
  listDiarizationRawOutputs,
  listSpeakers,
  listStageRuns,
  listSttRawOutputs,
  listTranscriptSegments,
  listTranscriptVersions,
  listUncertainties,
  markRunning,
  recordings,
  requestRunCancel,
  resetRunForRetry,
  runMigrations,
  seedDevelopment,
  sql,
  submitRun,
  upsertPreprocessing,
  type DbHandle,
} from '@vip/db';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, type OrchestratorConfig } from '../src/config';
import { OrchestratorModule } from '../src/orchestrator.module';
import { FakeDiarizationProvider } from '../src/providers/diarization/fake';
import { ProviderError, UnknownProviderError } from '../src/providers/errors';
import { LocalRawStore, sttRawKey, type RawStore } from '../src/providers/raw-store';
import { FakeSttProvider } from '../src/providers/stt/fake';
import { RunQueues } from '../src/runs/queues';
import { RunWorkers } from '../src/runs/run.workers';
import { sweepRuns } from '../src/runs/sweeper';
import type { RunDeps } from '../src/runs/types';

/** Integration: real Postgres (`_test` database) and Redis DB 15, real BullMQ, fake providers, throwaway storage dir. */
function testUrls() {
  const db = process.env.TEST_DATABASE_URL;
  if (!db) throw new Error('TEST_DATABASE_URL is not set (see .env.example).');
  if (!new URL(db).pathname.endsWith('_test'))
    throw new Error('Test database name must end in _test');
  const redis = new URL(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379');
  redis.pathname = '/15';
  return { db, redis: redis.toString() };
}

const urls = testUrls();
const W = DEV_WORKSPACE_ID;

async function waitFor<T>(
  fn: () => Promise<T | null | false>,
  what: string,
  ms = 10_000,
): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Test hooks of the scripted STT: calls are recorded per window; `beforeWindow` may block or throw. */
interface Hooks {
  calls: number[];
  beforeWindow: (index: number) => Promise<void>;
  /** Rewrites the turns the diarization adapter returns (the stored raw payload is unchanged). */
  diarizationTurns?: (turns: DiarizationTurn[]) => DiarizationTurn[];
}
const newHooks = (): Hooks => ({ calls: [], beforeWindow: async () => undefined });

/** The fake STT with test hooks. */
class ScriptedStt extends FakeSttProvider {
  constructor(
    store: RawStore,
    private readonly hooks: Hooks,
  ) {
    super(store);
  }
  override async transcribe(req: SttRequest) {
    this.hooks.calls.push(req.window.index);
    await this.hooks.beforeWindow(req.window.index);
    return super.transcribe(req);
  }
}

/** The fake diarization with a test hook on the returned turns. */
class ScriptedDiarization extends FakeDiarizationProvider {
  constructor(
    store: RawStore,
    private readonly hooks: Hooks,
  ) {
    super(store);
  }
  override async diarize(req: DiarizationRequest) {
    const out = await super.diarize(req);
    return this.hooks.diarizationTurns
      ? { ...out, turns: this.hooks.diarizationTurns(out.turns) }
      : out;
  }
}

describe('transcription run coordinator (integration)', () => {
  let handle: DbHandle;
  let queues: RunQueues;
  let app: INestApplicationContext | undefined;
  let storageRoot: string;
  let config: OrchestratorConfig;
  let hooks: Hooks;

  const makeConfig = (extra: Record<string, string> = {}) =>
    loadConfig({
      REDIS_URL: urls.redis,
      DATABASE_URL: urls.db,
      AUDIO_SERVICE_URL: 'http://127.0.0.1:8001',
      LOG_LEVEL: 'fatal',
      SHUTDOWN_TIMEOUT_MS: '3000',
      STORAGE_LOCAL_ROOT: storageRoot,
      QUEUE_RUN_BACKOFF_MS: '40',
      QUEUE_RUN_ATTEMPTS: '3',
      RUN_MAX_RETRIES: '3',
      RUN_STUCK_AFTER_MS: '100',
      RUN_SWEEP_INTERVAL_MS: '3600000',
      PROCESSING_SWEEP_INTERVAL_MS: '3600000',
      ...extra,
    });

  const start = async (cfg = config) => {
    app = await NestFactory.createApplicationContext(
      OrchestratorModule.forRoot(cfg, undefined, undefined, (s) => ({
        stt: new ScriptedStt(s, hooks),
        diarization: new ScriptedDiarization(s, hooks),
      })),
      { logger: false },
    );
    await app.init();
  };

  /** A valid recording, a succeeded preprocessing and a submitted (`queued`) run. */
  const makeRun = async (
    opts: {
      durationMs?: number;
      vad?: { index: number; startMs: number; endMs: number }[];
      preprocessing?: 'succeeded' | 'none';
      stages?: string[];
    } = {},
  ) => {
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
    let preprocessingId: string | null = null;
    if (opts.preprocessing !== 'none') {
      const { preprocessing } = await upsertPreprocessing(handle.db, {
        workspaceId: W,
        recordingId,
        configHash: 'a'.repeat(64),
        config: { v: 1 },
        toolVersions: {},
      });
      await markRunning(handle.db, W, preprocessing.id);
      await completePreprocessing(handle.db, {
        workspaceId: W,
        id: preprocessing.id,
        normalizedUri: `local://derived/${W}/${recordingId}/canonical.wav`,
        canonicalSha256: 'b'.repeat(64),
        canonicalDurationMs: opts.durationMs ?? 100_000,
        timeline: { schemaVersion: 1 },
        segments: (opts.vad ?? []).map((s) => ({ ...s, speechMs: s.endMs - s.startMs })),
        measurements: [],
      });
      preprocessingId = preprocessing.id;
    }
    const run = await insertCreatedRun(handle.db, W, recordingId);
    if (preprocessingId) {
      await submitRun(handle.db, W, run.id, {
        preprocessingId,
        config: { schemaVersion: 1, stages: opts.stages ?? ['transcription', 'diarization'] },
      });
    } else {
      await handle.db.execute(
        sql`UPDATE pipeline_runs SET status = 'queued', config = ${JSON.stringify({ schemaVersion: 1, stages: ['transcription', 'diarization'] })}::jsonb WHERE id = ${run.id}`,
      );
    }
    return { runId: run.id, recordingId };
  };

  const status = async (runId: string) => (await getRun(handle.db, W, runId))?.status;
  const untilStatus = (runId: string, want: string) =>
    waitFor(async () => ((await status(runId)) === want ? true : null), `run ${want}`);
  const audits = async (runId: string) =>
    (
      await handle.db
        .select({
          action: auditEvents.action,
          actorId: auditEvents.actorId,
          metadata: auditEvents.metadata,
        })
        .from(auditEvents)
        .where(and(eq(auditEvents.resourceType, 'run'), eq(auditEvents.resourceId, runId)))
    ).map((a) => a.action);

  beforeAll(async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'vip-runs-int-'));
    config = makeConfig();
    handle = createDb(urls.db, { maxConnections: 4 });
    await runMigrations(handle.db);
    await seedDevelopment(handle.db);
    queues = new RunQueues(config);
  });
  afterAll(async () => {
    await queues.close();
    await handle.close();
    await rm(storageRoot, { recursive: true, force: true });
  });
  beforeEach(async () => {
    hooks = newHooks();
    await queues.run.obliterate({ force: true });
    await queues.sweep.obliterate({ force: true });
    // Runs left over by other suites (or earlier tests) must not be picked up by this test's sweeper.
    await handle.db.execute(
      sql`UPDATE pipeline_runs SET status = 'cancelled', finished_at = now() WHERE status IN ('created', 'queued', 'running', 'cancelling')`,
    );
  });
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('submit -> completed with transcript v1, speakers, uncertainties and traceable raw outputs', async () => {
    const { runId } = await makeRun({ durationMs: 100_000 });
    await start();
    await queues.enqueueRun(W, runId);
    await untilStatus(runId, 'completed');

    const run = (await getRun(handle.db, W, runId))!;
    expect(run).toMatchObject({ currentNode: null, error: null, retryCount: 0 });
    expect(run.config).toMatchObject({
      stages: ['transcription', 'diarization'],
      providers: {
        stt: { id: 'fake', model: 'fake-stt-1', fake: true },
        diarization: { id: 'fake', model: 'fake-diarization-1', fake: true },
      },
      window: { source: 'fixed_windows', windowMs: 30_000, overlapMs: 1_000, count: 4 },
    });

    const stages = await listStageRuns(handle.db, W, runId);
    expect(stages.map((s) => `${s.node}:${s.status}`).sort()).toEqual([
      'diarization:completed',
      'transcription:completed',
    ]);
    expect(stages.find((s) => s.node === 'transcription')!.progress).toMatchObject({ fraction: 1 });

    const transcript = (await getTranscriptForRun(handle.db, W, runId))!;
    const versions = await listTranscriptVersions(handle.db, W, transcript.id);
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({ version: 1, kind: 'machine' });
    const version = (await getTranscriptVersion(handle.db, W, transcript.id))!;
    const segments = await listTranscriptSegments(handle.db, W, version.id, { limit: 1000 });
    expect(segments).toHaveLength(10); // 10 s grid over 100 s, each exactly once
    expect(segments[0]).toMatchObject({
      startMs: 0,
      endMs: 10_000,
      confidence: null,
      language: 'en',
    });
    expect(segments[0]!.text).toBe('[fake transcript] window 0 (00:00:00–00:00:10)');
    expect(segments.at(-1)!.endMs).toBe(100_000);
    expect(segments.every((s) => s.speakerId !== null)).toBe(true);
    const speakers = await listSpeakers(handle.db, W, transcript.id);
    expect(speakers.map((s) => s.speakerKey)).toEqual(['SPEAKER_00', 'SPEAKER_01']);
    expect(speakers.reduce((n, s) => n + s.totalSpeechMs, 0)).toBe(100_000);
    const unc = await listUncertainties(handle.db, W, version.id, { limit: 1000 });
    expect(unc.length).toBeGreaterThan(0);
    expect(unc.every((u) => u.kind === 'overlapping_speech')).toBe(true);

    // Raw outputs: one per window plus the whole-file diarization; the sha256 matches the stored bytes.
    const raws = await listSttRawOutputs(handle.db, W, runId);
    expect(raws.map((r) => r.windowIndex)).toEqual([0, 1, 2, 3]);
    for (const raw of raws) {
      expect(raw.provider).toBe('fake');
      const bytes = await readFile(join(storageRoot, raw.payloadUri.replace('local://', '')));
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(raw.sha256);
    }
    const dia = await listDiarizationRawOutputs(handle.db, W, runId);
    expect(dia).toHaveLength(1);
    expect(dia[0]).toMatchObject({ scope: 'whole', provider: 'fake' });
    const diaBytes = await readFile(join(storageRoot, dia[0]!.payloadUri.replace('local://', '')));
    expect(createHash('sha256').update(diaBytes).digest('hex')).toBe(dia[0]!.sha256);
    // Every segment names the raw output(s) it came from.
    const rawIds = new Set(raws.map((r) => r.id));
    for (const s of segments) {
      expect(s.sourceRawOutputIds?.length).toBe(1);
      expect(rawIds.has(s.sourceRawOutputIds![0]!)).toBe(true);
    }
    expect(await audits(runId)).toEqual(['run.completed']);
  });

  it('uses VAD segments as windows when the preprocessing has them (window index = segment index)', async () => {
    const { runId } = await makeRun({
      durationMs: 60_000,
      vad: [
        { index: 0, startMs: 1_000, endMs: 20_000 },
        { index: 1, startMs: 30_000, endMs: 55_000 },
      ],
    });
    await start();
    await queues.enqueueRun(W, runId);
    await untilStatus(runId, 'completed');
    expect((await getRun(handle.db, W, runId))!.config).toMatchObject({
      window: { source: 'vad_segments', windowMs: null, overlapMs: null, count: 2 },
    });
    const raws = await listSttRawOutputs(handle.db, W, runId);
    expect(raws.map((r) => [r.windowIndex, r.windowStartMs, r.windowEndMs])).toEqual([
      [0, 1_000, 20_000],
      [1, 30_000, 55_000],
    ]);
  });

  it('a diarization-less scope completes with no speakers and no speaker uncertainty', async () => {
    const { runId } = await makeRun({ durationMs: 20_000, stages: ['transcription'] });
    await start();
    await queues.enqueueRun(W, runId);
    await untilStatus(runId, 'completed');
    const transcript = (await getTranscriptForRun(handle.db, W, runId))!;
    expect(await listSpeakers(handle.db, W, transcript.id)).toEqual([]);
    expect(await listDiarizationRawOutputs(handle.db, W, runId)).toEqual([]);
    const stages = await listStageRuns(handle.db, W, runId);
    expect(stages.map((s) => s.node)).toEqual(['transcription']);
  });

  it('is idempotent: re-enqueueing a completed run or a duplicate job changes nothing', async () => {
    const { runId } = await makeRun({ durationMs: 70_000 });
    await start();
    await Promise.all([queues.enqueueRun(W, runId), queues.enqueueRun(W, runId)]);
    await untilStatus(runId, 'completed');
    const before = hooks.calls.length;
    await queues.enqueueRun(W, runId);
    await waitFor(
      async () =>
        (await queues.run.getJobCounts('active', 'waiting', 'delayed')).waiting === 0 ? true : null,
      'idle',
    );
    await new Promise((r) => setTimeout(r, 200));
    expect(hooks.calls.length).toBe(before);
    const transcript = (await getTranscriptForRun(handle.db, W, runId))!;
    expect(await listTranscriptVersions(handle.db, W, transcript.id)).toHaveLength(1);
    expect(await audits(runId)).toEqual(['run.completed']);
  });

  it('cancel mid-run: stops between windows, keeps raw outputs, stores no transcript', async () => {
    const { runId } = await makeRun({ durationMs: 100_000 });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let reached = false;
    hooks.beforeWindow = async (index) => {
      if (index === 1) {
        reached = true;
        await gate;
      }
    };
    await start();
    await queues.enqueueRun(W, runId);
    await waitFor(async () => (reached ? true : null), 'window 1 reached');
    expect(await requestRunCancel(handle.db, W, runId)).toBe('cancelling');
    release();
    await untilStatus(runId, 'cancelled');
    expect(await getTranscriptForRun(handle.db, W, runId)).toBeNull();
    expect(hooks.calls).toEqual([0, 1]); // window 2 was never requested
    expect((await listSttRawOutputs(handle.db, W, runId)).map((r) => r.windowIndex)).toEqual([
      0, 1,
    ]);
    const stages = await listStageRuns(handle.db, W, runId);
    expect(stages.find((s) => s.node === 'transcription')!.status).toBe('cancelled');
    expect((await getRun(handle.db, W, runId))!.finishedAt).not.toBeNull();
    expect(await audits(runId)).toEqual(['run.cancelled']);
  });

  it('retry after an injected failure resumes: stored windows are not re-requested', async () => {
    const { runId } = await makeRun({ durationMs: 100_000 });
    let failOnce = true;
    hooks.beforeWindow = async (index) => {
      if (index === 2 && failOnce) {
        failOnce = false;
        throw new ProviderError('PROVIDER_REJECTED', false);
      }
    };
    await start();
    await queues.enqueueRun(W, runId);
    await untilStatus(runId, 'failed');
    expect(await getRun(handle.db, W, runId)).toMatchObject({
      error: { code: 'PROVIDER_REJECTED', node: 'transcription' },
      currentNode: null,
    });
    expect((await listStageRuns(handle.db, W, runId))[0]).toMatchObject({
      node: 'transcription',
      status: 'failed',
      error: { code: 'PROVIDER_REJECTED' },
    });
    expect(await getTranscriptForRun(handle.db, W, runId)).toBeNull();
    expect(hooks.calls).toEqual([0, 1, 2]);

    expect(await resetRunForRetry(handle.db, W, runId, 3)).toBe(true);
    await queues.enqueueRun(W, runId);
    await untilStatus(runId, 'completed');
    // Windows 0 and 1 came from storage; only 2 and 3 were requested on the second attempt.
    expect(hooks.calls).toEqual([0, 1, 2, 2, 3]);
    expect((await getRun(handle.db, W, runId))!.retryCount).toBe(1);
    expect((await listSttRawOutputs(handle.db, W, runId)).map((r) => r.windowIndex)).toEqual([
      0, 1, 2, 3,
    ]);
    const transcript = (await getTranscriptForRun(handle.db, W, runId))!;
    expect(await listTranscriptVersions(handle.db, W, transcript.id)).toHaveLength(1);
    expect(await audits(runId)).toEqual(expect.arrayContaining(['run.failed', 'run.completed']));
    // Stage rows of the second attempt are separate from the first.
    const stages = await listStageRuns(handle.db, W, runId);
    expect(
      stages.filter((s) => s.node === 'transcription').map((s) => `${s.attempt}:${s.status}`),
    ).toEqual(['2:completed', '1:failed']);
  });

  it('a transient provider failure is retried by the queue with backoff, then completes', async () => {
    const { runId } = await makeRun({ durationMs: 40_000 });
    let failures = 0;
    hooks.beforeWindow = async () => {
      if (failures < 2) {
        failures += 1;
        throw new ProviderError('PROVIDER_UNAVAILABLE', true);
      }
    };
    await start();
    await queues.enqueueRun(W, runId);
    await untilStatus(runId, 'completed');
    expect(failures).toBe(2);
    expect((await getRun(handle.db, W, runId))!.retryCount).toBe(0); // job-level retries are not run retries
  });

  it('transient failures that exhaust the job attempts fail the run with the provider code', async () => {
    const { runId } = await makeRun({ durationMs: 40_000 });
    hooks.beforeWindow = async () => {
      throw new ProviderError('PROVIDER_UNAVAILABLE', true);
    };
    await start();
    await queues.enqueueRun(W, runId);
    await untilStatus(runId, 'failed');
    expect(hooks.calls).toHaveLength(3);
    expect((await getRun(handle.db, W, runId))!.error).toEqual({
      code: 'PROVIDER_UNAVAILABLE',
      node: 'transcription',
    });
  });

  it('precondition failure: no succeeded preprocessing fails the run without calling a provider', async () => {
    const { runId } = await makeRun({ preprocessing: 'none' });
    await start();
    await queues.enqueueRun(W, runId);
    await untilStatus(runId, 'failed');
    expect((await getRun(handle.db, W, runId))!.error).toEqual({
      code: 'PREPROCESSING_REQUIRED',
      node: null,
    });
    expect(hooks.calls).toEqual([]);
  });

  it('an out-of-range diarization turn fails the run on the diarization stage with no transcript', async () => {
    // Regression (Phase 2C audit §11.2): turns are validated against the recording duration.
    const { runId } = await makeRun({ durationMs: 20_000 });
    hooks.diarizationTurns = (turns) => [
      ...turns,
      { startMs: 19_000, endMs: 25_000, speakerKey: 'SPEAKER_00' }, // ends 5 s past the audio
    ];
    await start();
    await queues.enqueueRun(W, runId);
    await untilStatus(runId, 'failed');
    expect((await getRun(handle.db, W, runId))!.error).toEqual({
      code: 'PROVIDER_OUTPUT_INVALID',
      node: 'diarization',
    });
    expect(await getTranscriptForRun(handle.db, W, runId)).toBeNull();
    const stages = await listStageRuns(handle.db, W, runId);
    expect(stages.find((s) => s.node === 'diarization')!.status).toBe('failed');
    // The raw output was stored first and stays, for diagnosis (ADR-0007).
    expect(await listDiarizationRawOutputs(handle.db, W, runId)).toHaveLength(1);
  });

  it('the whole-run deadline stops a run between windows with a TIMEOUT', async () => {
    const { runId } = await makeRun({ durationMs: 100_000 });
    hooks.beforeWindow = async (index) => {
      if (index === 0) await new Promise((r) => setTimeout(r, 1_200));
    };
    // A fixed 1 s bound: no duration-scaled share (RUN_DEADLINE_PER_AUDIO_PERMILLE, ADR-0039).
    await start(makeConfig({ RUN_DEADLINE_MS: '1000', RUN_DEADLINE_PER_AUDIO_PERMILLE: '0' }));
    await queues.enqueueRun(W, runId);
    await untilStatus(runId, 'failed');
    expect((await getRun(handle.db, W, runId))!.error).toEqual({
      code: 'TIMEOUT',
      node: 'transcription',
    });
    expect(hooks.calls).toEqual([0]);
  });

  it('a provider call that exceeds its bound is a retryable timeout', async () => {
    const { runId } = await makeRun({ durationMs: 20_000 });
    let slow = true;
    hooks.beforeWindow = async () => {
      if (slow) {
        slow = false;
        await new Promise((r) => setTimeout(r, 400));
      }
    };
    // A fixed 100 ms bound: no duration-scaled share (ADR-0039).
    await start(
      makeConfig({ RUN_PROVIDER_TIMEOUT_MS: '100', RUN_PROVIDER_TIMEOUT_PER_AUDIO_PERMILLE: '0' }),
    );
    await queues.enqueueRun(W, runId);
    await untilStatus(runId, 'completed'); // first attempt timed out, the retry succeeded
    expect(hooks.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('adopts a raw object a stopped attempt stored before its row instead of re-calling the provider', async () => {
    // Regression (Phase 2C audit §11.4): raw output is write-once and a stored object is reused.
    const { runId } = await makeRun({ durationMs: 70_000 }); // windows 0-30 s, 29-59 s, 58-70 s
    const orphan = await new FakeSttProvider(new LocalRawStore(storageRoot)).transcribe({
      audioUri: 'local://unused',
      offsetMs: 29_000,
      audioDurationMs: 70_000,
      window: { index: 1, startMs: 29_000, endMs: 59_000 },
      rawKey: sttRawKey(W, runId, 1),
    });
    await start();
    await queues.enqueueRun(W, runId);
    await untilStatus(runId, 'completed');
    expect(hooks.calls).toEqual([0, 2]); // window 1 came from the stored object
    const raws = await listSttRawOutputs(handle.db, W, runId);
    expect(raws.map((r) => r.windowIndex)).toEqual([0, 1, 2]);
    expect(raws.find((r) => r.windowIndex === 1)!.sha256).toBe(orphan.raw.sha256);
  });

  describe('sweeper', () => {
    // The sweeper uses only the database, config, clock and log.
    const deps = (): RunDeps =>
      ({
        db: handle.db,
        config: config.runs,
        now: () => Date.now(),
        log: () => undefined,
      }) as unknown as RunDeps;
    const ageRun = (runId: string) =>
      handle.db.execute(
        sql`UPDATE pipeline_runs SET updated_at = now() - interval '1 hour' WHERE id = ${runId}`,
      );

    it('requeues a stuck run without a live job (counted as a retry) and the worker finishes it', async () => {
      const { runId } = await makeRun({ durationMs: 40_000 });
      await handle.db.execute(sql`UPDATE pipeline_runs SET status = 'running' WHERE id = ${runId}`);
      await ageRun(runId);
      await start();
      const counts = await sweepRuns(deps(), queues);
      expect(counts).toEqual({ requeued: 1, failed: 0, cancelled: 0 });
      await untilStatus(runId, 'completed');
      expect((await getRun(handle.db, W, runId))!.retryCount).toBe(1);
      expect(await audits(runId)).toEqual(expect.arrayContaining(['run.retried', 'run.completed']));
    });

    it('fails a stuck run once the retry bound is reached, with TIMEOUT', async () => {
      const { runId } = await makeRun({ durationMs: 40_000 });
      await handle.db.execute(
        sql`UPDATE pipeline_runs SET status = 'running', retry_count = 3, current_node = 'transcription' WHERE id = ${runId}`,
      );
      await ageRun(runId);
      await start();
      expect(await sweepRuns(deps(), queues)).toMatchObject({ failed: 1, requeued: 0 });
      expect(await getRun(handle.db, W, runId)).toMatchObject({
        status: 'failed',
        error: { code: 'TIMEOUT', node: 'transcription' },
      });
      expect(hooks.calls).toEqual([]);
    });

    it('finishes a cancelling run that has no live job as cancelled', async () => {
      const { runId } = await makeRun({ durationMs: 40_000 });
      await handle.db.execute(
        sql`UPDATE pipeline_runs SET status = 'cancelling', cancel_requested_at = now() WHERE id = ${runId}`,
      );
      await ageRun(runId);
      await start();
      expect(await sweepRuns(deps(), queues)).toMatchObject({ cancelled: 1 });
      expect(await status(runId)).toBe('cancelled');
      expect(await audits(runId)).toEqual(['run.cancelled']);
    });

    it('leaves a run alone while its job is live', async () => {
      const { runId } = await makeRun({ durationMs: 40_000 });
      await ageRun(runId);
      await queues.enqueueRun(W, runId); // no worker is running: the job stays waiting
      expect(await sweepRuns(deps(), queues)).toEqual({ requeued: 0, failed: 0, cancelled: 0 });
      expect(await status(runId)).toBe('queued');
    });
  });

  it('an unknown provider key stops the run workers at startup', async () => {
    const workers = new RunWorkers(makeConfig({ DIARIZATION_PROVIDER: 'nope' }));
    await expect(workers.onApplicationBootstrap()).rejects.toThrow(UnknownProviderError);
    expect(workers.running).toBe(false);
  });
});
