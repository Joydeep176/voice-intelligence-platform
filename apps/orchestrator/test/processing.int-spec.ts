import 'reflect-metadata';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { JobIds, buildPreprocessConfig, toolVersionsFromCapabilities } from '@vip/contracts';
import {
  DEV_WORKSPACE_ID,
  audioMeasurements,
  audioPreprocessings,
  audioSegments,
  auditEvents,
  createDb,
  eq,
  getPreprocessing,
  markRunning,
  recordings,
  requestCancel,
  runMigrations,
  seedDevelopment,
  sql,
  upsertPreprocessing,
  type DbHandle,
} from '@vip/db';
import { loadConfig, type OrchestratorConfig } from '../src/config';
import { OrchestratorModule } from '../src/orchestrator.module';
import { AudioClientError } from '../src/processing/audio-client';
import { configHashOf, idempotencyKey } from '../src/processing/keys';
import { preprocessStep } from '../src/processing/preprocess.step';
import { probeStep } from '../src/processing/probe.step';
import { ProcessingQueues } from '../src/processing/queues';
import { sweep } from '../src/processing/sweeper';
import { ProcessingWorkers } from '../src/processing/processing.workers';
import type { ProcessingDeps } from '../src/processing/types';
import { CAPABILITIES, FakeAudioTasks, preprocessResult } from './support/fake-audio-tasks';

/** Integration: real Postgres (`_test` database) and Redis DB 15, in-process audio service double. */
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
const config: OrchestratorConfig = loadConfig({
  REDIS_URL: urls.redis,
  DATABASE_URL: urls.db,
  AUDIO_SERVICE_URL: 'http://127.0.0.1:8001',
  AUDIO_SERVICE_TOKEN: 'test-only-audio-token-0000000000000000',
  LOG_LEVEL: 'fatal',
  SHUTDOWN_TIMEOUT_MS: '3000',
  PROCESSING_POLL_INTERVAL_MS: '40',
  PROCESSING_RETRY_BACKOFF_MS: '40',
  QUEUE_AUDIO_BACKOFF_MS: '40',
  QUEUE_AUDIO_ATTEMPTS: '3',
  PROCESSING_MAX_RETRIES: '3',
  PROCESSING_SWEEP_INTERVAL_MS: '3600000',
});

const toolVersions = toolVersionsFromCapabilities(CAPABILITIES)!;
const preprocessConfig = buildPreprocessConfig(toolVersions);
const configHash = configHashOf(preprocessConfig);

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

describe('audio processing coordinator (integration)', () => {
  let handle: DbHandle;
  let queues: ProcessingQueues;
  let app: INestApplicationContext | undefined;
  let audio: FakeAudioTasks;

  const start = async (tasks: FakeAudioTasks = audio, cfg = config) => {
    app = await NestFactory.createApplicationContext(
      OrchestratorModule.forRoot(cfg, undefined, tasks),
      {
        logger: false,
      },
    );
    await app.init();
  };

  const addRecording = async (status: 'uploaded' | 'valid' | 'validating' = 'uploaded') => {
    const id = crypto.randomUUID();
    await handle.db.insert(recordings).values({
      id,
      workspaceId: W,
      originalFilename: 'synthetic.wav',
      storageUri: `local://recordings/${W}/${id}/original`,
      mimeType: 'audio/wav',
      sizeBytes: 1000,
      status,
    });
    return id;
  };
  const recording = async (id: string) =>
    (await handle.db.select().from(recordings).where(eq(recordings.id, id)))[0]!;
  const newVersion = async (recordingId: string) => {
    const { preprocessing } = await upsertPreprocessing(handle.db, {
      workspaceId: W,
      recordingId,
      configHash,
      config: preprocessConfig as unknown as Record<string, unknown>,
      toolVersions: preprocessConfig.toolVersions,
    });
    return preprocessing;
  };
  const rowOf = (id: string) => getPreprocessing(handle.db, W, id);
  const status = (id: string) => async () => {
    const r = await rowOf(id);
    return r?.status;
  };
  const untilStatus = (id: string, want: string) =>
    waitFor(async () => ((await status(id)()) === want ? true : null), `row ${want}`);
  const counts = async (id: string) => {
    const one = async (table: typeof audioMeasurements | typeof audioSegments) =>
      (
        await handle.db
          .select({ n: sql<number>`count(*)::int` })
          .from(table)
          .where(eq(table.preprocessingId, id))
      )[0]!.n;
    const audits = (
      await handle.db
        .select({ n: sql<number>`count(*)::int` })
        .from(auditEvents)
        .where(eq(auditEvents.resourceType, 'recording'))
    )[0]!.n;
    return {
      measurements: await one(audioMeasurements),
      segments: await one(audioSegments),
      audits,
    };
  };

  beforeAll(async () => {
    handle = createDb(urls.db, { maxConnections: 4 });
    await runMigrations(handle.db);
    await seedDevelopment(handle.db);
    queues = new ProcessingQueues(config);
  });
  afterAll(async () => {
    await queues.close();
    await handle.close();
  });
  beforeEach(async () => {
    audio = new FakeAudioTasks();
    await queues.probe.obliterate({ force: true });
    await queues.preprocess.obliterate({ force: true });
    await queues.sweep.obliterate({ force: true });
  });
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  describe('probe (validation)', () => {
    it('uploaded -> validating -> valid, storing the probe summary without container tags', async () => {
      const id = await addRecording('uploaded');
      await start();
      await queues.enqueueProbe(W, id, false);
      await waitFor(async () => (await recording(id)).status === 'valid', 'valid');
      const rec = await recording(id);
      expect(rec).toMatchObject({ validationError: null });
      expect(rec.sampleRate).toBeGreaterThan(0);
      expect(rec.channels).toBeGreaterThan(0);
      expect(JSON.stringify(rec.mediaProbe)).not.toMatch(/tags/i);
      expect(audio.submits.map((s) => s.type)).toEqual(['probe']);
      expect(await queues.preprocess.getJobCounts('waiting', 'delayed')).toMatchObject({
        waiting: 0,
        delayed: 0,
      });
    });

    it('a file-fault failure makes the recording invalid with the error code', async () => {
      const id = await addRecording('uploaded');
      audio.scripts.probe.push([{ status: 'failed', code: 'CORRUPT_MEDIA', retryable: false }]);
      await start();
      await queues.enqueueProbe(W, id, false);
      await waitFor(async () => (await recording(id)).status === 'invalid', 'invalid');
      expect(await recording(id)).toMatchObject({ validationError: 'CORRUPT_MEDIA' });
      expect(audio.submits).toHaveLength(1);
    });

    it.each([
      'UNSUPPORTED_FORMAT',
      'NO_DECODABLE_AUDIO',
      'DURATION_LIMIT_EXCEEDED',
      'RESOURCE_LIMIT_EXCEEDED',
    ])('file-property code %s makes the recording invalid', async (code) => {
      const id = await addRecording('uploaded');
      audio.scripts.probe.push([{ status: 'failed', code, retryable: false }]);
      await start();
      await queues.enqueueProbe(W, id, false);
      await waitFor(async () => (await recording(id)).status === 'invalid', 'invalid');
      expect(await recording(id)).toMatchObject({ validationError: code });
    });

    it.each([
      'RESOURCE_EXHAUSTED',
      'TIMEOUT',
      'INTERNAL_ERROR',
      'CAPACITY_EXCEEDED',
      'STORAGE_ERROR',
      'RESOURCE_LIMIT_EXCEEDED', // even a file-property code is never final when flagged retryable
    ])('retryable service fault %s never marks the recording invalid', async (code) => {
      const id = await addRecording('uploaded');
      for (let i = 0; i < config.processing.maxRetries; i++) {
        audio.scripts.probe.push([{ status: 'failed', code, retryable: true }]);
      }
      await start();
      await queues.enqueueProbe(W, id, false);
      await waitFor(async () => audio.submits.length === config.processing.maxRetries, 'retries');
      const job = await queues.probe.getJob(`probe-${id}`);
      await waitFor(
        async () => ((await job?.getState()) === 'completed' ? true : null),
        'job completed',
      );
      expect(await recording(id)).toMatchObject({ status: 'uploaded', validationError: null });
    });

    describe('bounded polling (Node backstop)', () => {
      const stepDeps = (now: () => number): ProcessingDeps => ({
        db: handle.db,
        audio,
        config: config.processing,
        enqueuer: queues,
        now,
        log: () => undefined,
      });
      const actions = async (resourceId: string) =>
        (await handle.db.select().from(auditEvents).where(eq(auditEvents.resourceId, resourceId)))
          .map((e) => e.action)
          .sort();

      it('a probe that never finishes is cancelled and returned to uploaded, not invalid', async () => {
        const id = await addRecording('uploaded');
        audio.scripts.probe.push([{ status: 'running' }]);
        const t0 = 1_000_000;
        const first = await probeStep(
          stepDeps(() => t0),
          { workspaceId: W, recordingId: id },
        );
        if (first.kind !== 'delay') throw new Error('expected delay');
        expect(first.data).toMatchObject({ submittedAt: t0 });
        // First poll observes `running`; the backstop counts from that observation.
        const poll = await probeStep(
          stepDeps(() => t0),
          { workspaceId: W, recordingId: id, thenPreprocess: false, submissions: 1, ...first.data },
        );
        if (poll.kind !== 'delay') throw new Error('expected delay');
        const data = {
          workspaceId: W,
          recordingId: id,
          thenPreprocess: false,
          submissions: 1,
          ...first.data,
          ...poll.data,
        };
        expect((data as { runningSince?: number }).runningSince).toBe(t0);
        const bound = t0 + config.processing.deadlineBaseMs + config.processing.deadlineGraceMs;
        expect(
          (
            await probeStep(
              stepDeps(() => bound),
              data,
            )
          ).kind,
        ).toBe('delay'); // not yet
        expect((await recording(id)).status).toBe('validating');
        expect(
          (
            await probeStep(
              stepDeps(() => bound + 1),
              data,
            )
          ).kind,
        ).toBe('finish');
        expect(await recording(id)).toMatchObject({ status: 'uploaded', validationError: null });
        expect(audio.cancels).toEqual([first.data!.taskId]);
        expect(await actions(id)).toEqual(['audio.probe_timed_out']);
      });

      it('a preprocess without a reported deadline fails TIMEOUT (retryable) past the derived bound', async () => {
        const id = await addRecording('valid');
        await handle.db.update(recordings).set({ durationMs: 20_000 }).where(eq(recordings.id, id));
        const row = await newVersion(id);
        audio.scripts.preprocess.push([{ status: 'running' }]);
        const t0 = 2_000_000;
        const first = await preprocessStep(
          stepDeps(() => t0),
          { workspaceId: W, preprocessingId: row.id },
        );
        if (first.kind !== 'delay') throw new Error('expected delay');
        // First poll observes `running`; the backstop counts from that observation (not from submission).
        const poll = await preprocessStep(
          stepDeps(() => t0),
          { workspaceId: W, preprocessingId: row.id, ...first.data },
        );
        if (poll.kind !== 'delay') throw new Error('expected delay');
        const data = { workspaceId: W, preprocessingId: row.id, ...first.data, ...poll.data };
        expect((data as { runningSince?: number }).runningSince).toBe(t0);
        const bound =
          t0 + config.processing.deadlineBaseMs + 10_000 + config.processing.deadlineGraceMs;
        expect(
          (
            await preprocessStep(
              stepDeps(() => bound),
              data,
            )
          ).kind,
        ).toBe('delay');
        expect(await status(row.id)()).toBe('running');
        expect(
          (
            await preprocessStep(
              stepDeps(() => bound + 1),
              data,
            )
          ).kind,
        ).toBe('finish');
        expect(await status(row.id)()).toBe('failed');
        expect((await rowOf(row.id))!.error).toEqual({ code: 'TIMEOUT', retryable: true });
        expect(audio.cancels).toEqual([first.data!.taskId]);
        expect(await actions(id)).toEqual(['audio.preprocessing_timed_out']);
      });

      it('the service-reported deadline (plus grace) replaces the derived bound', async () => {
        const id = await addRecording('valid');
        const row = await newVersion(id);
        const t0 = 3_000_000;
        const reported = t0 + 5_000;
        audio.scripts.preprocess.push([{ status: 'running', deadlineAt: reported }]);
        const first = await preprocessStep(
          stepDeps(() => t0),
          { workspaceId: W, preprocessingId: row.id },
        );
        if (first.kind !== 'delay') throw new Error('expected delay');
        let data: Record<string, unknown> = {
          workspaceId: W,
          preprocessingId: row.id,
          ...first.data,
        };
        const bound = reported + config.processing.deadlineGraceMs;
        const second = await preprocessStep(
          stepDeps(() => t0 + 1),
          data,
        );
        if (second.kind !== 'delay') throw new Error('expected delay');
        expect(second.data).toMatchObject({ deadlineAt: reported }); // recorded on the job
        data = { ...data, ...second.data };
        expect(
          (
            await preprocessStep(
              stepDeps(() => bound),
              data,
            )
          ).kind,
        ).toBe('delay');
        expect(await status(row.id)()).toBe('running');
        await preprocessStep(
          stepDeps(() => bound + 1),
          data,
        );
        expect(await status(row.id)()).toBe('failed');
      });
    });

    it('explicit start: probe then preprocess, ending succeeded with traceable data', async () => {
      const id = await addRecording('uploaded');
      await start();
      await queues.enqueueProbe(W, id, true);
      const row = await waitFor(async () => {
        const [r] = await handle.db
          .select()
          .from(audioPreprocessings)
          .where(eq(audioPreprocessings.recordingId, id));
        return r?.status === 'succeeded' ? r : null;
      }, 'succeeded');
      expect((await recording(id)).status).toBe('valid');
      expect(row).toMatchObject({
        configHash,
        normalizedUri: expect.stringContaining('local://derived/') as unknown as string,
        canonicalSha256: 'b'.repeat(64),
        attempt: 1,
        error: null,
      });
      expect(row.normalizedUri).toContain(`${id}/${configHash}/canonical.wav`);
      const pre = audio.submits.find((s) => s.type === 'preprocess')!;
      expect(pre.idempotencyKey).toBe(`${id}:${configHash}:preprocess`);
      expect(pre.input.originalKey).toBe(`recordings/${W}/${id}/original`);
      expect(pre.input.outputPrefix).toBe(`derived/${W}/${id}/${configHash}`);
      const c = await counts(row.id);
      expect(c.measurements).toBeGreaterThan(0);
      const [audit] = await handle.db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.resourceId, id));
      expect(audit).toMatchObject({
        action: 'audio.preprocessing_completed',
        actorId: 'system:orchestrator',
      });
      expect(Object.keys(audit!.metadata as object).sort()).toEqual([
        'canonicalDurationMs',
        'preprocessingId',
        'segmentCount',
      ]); // IDs and counts only
    });

    it('gives the recording back to uploaded when the service stays unreachable', async () => {
      const id = await addRecording('uploaded');
      audio.down = new AudioClientError('UNAVAILABLE');
      await start();
      await queues.enqueueProbe(W, id, false);
      await waitFor(
        async () => (await recording(id)).status === 'uploaded' && audio.submits.length === 0,
        'reset',
      );
      const job = await queues.probe.getJob(`probe-${id}`);
      await waitFor(
        async () => ((await job?.getState()) === 'completed' ? true : null),
        'job completed',
      );
    });
  });

  describe('preprocess', () => {
    const run = async (recordingId: string, tasks?: FakeAudioTasks) => {
      const row = await newVersion(recordingId);
      await start(tasks);
      await queues.enqueuePreprocess(W, row.id);
      return row;
    };

    it('runs a queued version to succeeded, writing progress and one audit event', async () => {
      const id = await addRecording('valid');
      audio.scripts.preprocess.push([
        { status: 'running', progress: { stage: 'measure', fraction: 0.4, processedMs: 800 } },
        { status: 'running', progress: { stage: 'measure', fraction: 0.4, processedMs: 800 } },
        { status: 'succeeded' },
      ]);
      const row = await run(id);
      await untilStatus(row.id, 'succeeded');
      const done = (await rowOf(row.id))!;
      expect(done.finishedAt).not.toBeNull();
      expect(done.timeline).toMatchObject({ mappingStatus: 'exact' });
      expect(done.vad).toMatchObject({ method: 'none' });
      expect((await counts(row.id)).audits).toBeGreaterThan(0);
    });

    it('a duplicate delivery cannot persist the result twice', async () => {
      const id = await addRecording('valid');
      const row = await run(id);
      await untilStatus(row.id, 'succeeded');
      const before = await counts(row.id);
      const deps = {
        db: handle.db,
        audio,
        config: config.processing,
        enqueuer: queues,
        now: Date.now,
        log: () => undefined,
      } as ProcessingDeps;
      const taskId = audio.polls[0]!;
      // Same job delivered again (stalled-job redelivery) with the task ID: nothing changes.
      await preprocessStep(deps, { workspaceId: W, preprocessingId: row.id, taskId });
      await preprocessStep(deps, { workspaceId: W, preprocessingId: row.id });
      expect(await counts(row.id)).toEqual(before);
      expect(audio.submits.filter((s) => s.type === 'preprocess')).toHaveLength(1);
    });

    it('a version cancelled while queued does no work', async () => {
      const id = await addRecording('valid');
      const row = await newVersion(id);
      await handle.db
        .update(audioPreprocessings)
        .set({ status: 'cancelled' })
        .where(eq(audioPreprocessings.id, row.id));
      await start();
      await queues.enqueuePreprocess(W, row.id);
      await waitFor(
        async () => (await queues.preprocess.getJobCounts('completed')).completed === 1,
        'job done',
      );
      expect(audio.submits).toHaveLength(0);
      expect(await status(row.id)()).toBe('cancelled');
    });

    it('a running version with a cancel request stops the task and becomes cancelled', async () => {
      const id = await addRecording('valid');
      audio.scripts.preprocess.push([{ status: 'running' }]);
      const row = await run(id);
      await waitFor(async () => audio.polls.length > 1, 'polling');
      expect(await requestCancel(handle.db, W, row.id)).toBe(true);
      await untilStatus(row.id, 'cancelled');
      expect(audio.cancels).toEqual([audio.polls[0]]);
      expect((await counts(row.id)).measurements).toBe(0);
    });

    it('retries a retryable failure with a new idempotency key, then succeeds', async () => {
      const id = await addRecording('valid');
      audio.scripts.preprocess.push([
        { status: 'failed', code: 'INTERNAL_ERROR', retryable: true },
      ]);
      const row = await run(id);
      await untilStatus(row.id, 'succeeded');
      const keys = audio.submits.map((s) => s.idempotencyKey);
      expect(keys).toEqual([
        idempotencyKey(id, configHash, 'preprocess', 1),
        idempotencyKey(id, configHash, 'preprocess', 2),
      ]);
      expect((await rowOf(row.id))!.attempt).toBe(2);
    });

    it('fails a non-retryable failure once, without retry', async () => {
      const id = await addRecording('valid');
      audio.scripts.preprocess.push([
        { status: 'failed', code: 'CORRUPT_MEDIA', retryable: false },
      ]);
      const row = await run(id);
      await untilStatus(row.id, 'failed');
      expect(audio.submits).toHaveLength(1);
      expect((await rowOf(row.id))!.error).toMatchObject({
        code: 'CORRUPT_MEDIA',
        retryable: false,
      });
      expect((await counts(row.id)).measurements).toBe(0);
    });

    it('stops retrying a retryable failure after the attempt bound', async () => {
      const id = await addRecording('valid');
      const failing: Array<Array<{ status: 'failed'; code: string; retryable: boolean }>> = [
        1, 2, 3, 4,
      ].map(() => [{ status: 'failed', code: 'INTERNAL_ERROR', retryable: true }]);
      audio.scripts.preprocess.push(...failing);
      const row = await run(id);
      await untilStatus(row.id, 'failed');
      expect(audio.submits).toHaveLength(config.processing.maxRetries);
      expect((await rowOf(row.id))!.error).toMatchObject({ retryable: true });
    });

    it('resubmits a task the service lost', async () => {
      const id = await addRecording('valid');
      audio.scripts.preprocess.push([{ status: 'running' }]);
      const row = await run(id);
      await waitFor(async () => audio.polls.length > 0, 'first poll');
      audio.lost.add([...new Set(audio.polls)][0]!);
      await untilStatus(row.id, 'succeeded');
      expect(audio.submits).toHaveLength(2);
      expect(audio.submits[1]!.idempotencyKey).not.toBe(audio.submits[0]!.idempotencyKey);
    });

    it('a schema-invalid result fails INTERNAL_ERROR and persists nothing', async () => {
      const id = await addRecording('valid');
      audio.scripts.preprocess.push([{ status: 'succeeded', result: { canonical: 'nope' } }]);
      const row = await run(id);
      await untilStatus(row.id, 'failed');
      expect((await rowOf(row.id))!.error).toMatchObject({
        code: 'INTERNAL_ERROR',
        retryable: false,
      });
      const done = (await rowOf(row.id))!;
      expect(done.normalizedUri).toBeNull();
      expect(await counts(row.id)).toMatchObject({ measurements: 0, segments: 0 });
    });

    it('a result whose keys point outside the version prefix is rejected, nothing persisted', async () => {
      const id = await addRecording('valid');
      const row = await newVersion(id);
      const request = { input: { outputPrefix: `derived/${W}/${id}/${'f'.repeat(64)}` } } as never;
      audio.scripts.preprocess.push([{ status: 'succeeded', result: preprocessResult(request) }]);
      await start();
      await queues.enqueuePreprocess(W, row.id);
      await untilStatus(row.id, 'failed');
      expect((await rowOf(row.id))!.error).toMatchObject({ code: 'INTERNAL_ERROR' });
      expect((await counts(row.id)).measurements).toBe(0);
    });

    it('a rejected request (bad token) fails the version without retry', async () => {
      const id = await addRecording('valid');
      audio.submitErrors.push(new AudioClientError('CONFIG', 'UNAUTHORIZED', 401));
      const row = await run(id);
      await untilStatus(row.id, 'failed');
      expect((await rowOf(row.id))!.error).toMatchObject({
        code: 'UNAUTHORIZED',
        retryable: false,
      });
    });

    it('a deleting recording cancels the version', async () => {
      const id = await addRecording('valid');
      await handle.db.update(recordings).set({ status: 'deleting' }).where(eq(recordings.id, id));
      const row = await run(id);
      await untilStatus(row.id, 'cancelled');
      expect(audio.submits).toHaveLength(0);
    });
  });

  describe('sweeper', () => {
    const makeDeps = (): { deps: ProcessingDeps; later: () => number } => {
      const later = () => Date.now() + config.processing.stuckAfterMs + 60_000;
      return {
        later,
        deps: {
          db: handle.db,
          audio,
          config: config.processing,
          enqueuer: queues,
          now: later,
          log: () => undefined,
        },
      };
    };

    it('re-enqueues a stuck queued row without a job, without counting an attempt', async () => {
      const id = await addRecording('valid');
      const row = await newVersion(id);
      const { deps } = makeDeps();
      const counts1 = await sweep(deps, queues);
      expect(counts1.requeued).toBeGreaterThanOrEqual(1);
      expect(await queues.preprocess.getJob(row.id)).toBeTruthy();
      expect((await rowOf(row.id))!.attempt).toBe(0); // a requeue is not a new submission
      // The job is live now: a second sweep leaves it alone.
      const again = await sweep(deps, queues);
      expect(again.requeued).toBe(0);
      expect((await rowOf(row.id))!.attempt).toBe(0);
    });

    it('a requeue while the service still runs the task re-attaches: no second task, attempt unchanged', async () => {
      const id = await addRecording('valid');
      const row = await newVersion(id);
      audio.scripts.preprocess.push([{ status: 'running' }]);
      const deps = { ...makeDeps().deps, now: Date.now };
      const first = await preprocessStep(deps, { workspaceId: W, preprocessingId: row.id });
      expect(first.kind).toBe('delay');
      expect(audio.submits).toHaveLength(1);
      expect((await rowOf(row.id))!.attempt).toBe(1);
      // The job is lost (nothing is queued); the sweeper requeues, the fresh job has no task ID.
      const swept = await sweep(makeDeps().deps, queues);
      expect(swept.requeued).toBeGreaterThanOrEqual(1);
      const job = await queues.preprocess.getJob(JobIds.preprocess(row.id));
      await preprocessStep(deps, job!.data);
      expect(audio.submits).toHaveLength(1); // same idempotency key: still one service task
      expect((await rowOf(row.id))!.attempt).toBe(1);
    });

    it('concurrent observers of one lost task submit one key and count one attempt', async () => {
      const id = await addRecording('valid');
      const row = await newVersion(id);
      audio.scripts.preprocess.push([{ status: 'running' }]);
      const deps = { ...makeDeps().deps, now: Date.now };
      const first = await preprocessStep(deps, { workspaceId: W, preprocessingId: row.id });
      if (first.kind !== 'delay') throw new Error('expected delay');
      const data = { workspaceId: W, preprocessingId: row.id, ...first.data };
      audio.lost.add(first.data!.taskId as string);
      await Promise.all([preprocessStep(deps, data), preprocessStep(deps, data)]);
      expect(audio.submits.map((s) => s.idempotencyKey)).toEqual([
        idempotencyKey(id, configHash, 'preprocess', 1),
        idempotencyKey(id, configHash, 'preprocess', 2),
      ]);
      expect((await rowOf(row.id))!.attempt).toBe(2); // +1 once, not +2
    });

    it('fails a stuck row with a retryable TIMEOUT once attempts are spent', async () => {
      const id = await addRecording('valid');
      const row = await newVersion(id);
      await handle.db
        .update(audioPreprocessings)
        .set({ attempt: 3 })
        .where(eq(audioPreprocessings.id, row.id));
      await sweep(makeDeps().deps, queues);
      expect(await status(row.id)()).toBe('failed');
      expect((await rowOf(row.id))!.error).toMatchObject({ code: 'TIMEOUT', retryable: true });
    });

    it('does not touch a row that is still fresh', async () => {
      const id = await addRecording('valid');
      const row = await newVersion(id);
      const { deps } = makeDeps();
      await sweep({ ...deps, now: Date.now }, queues);
      expect(await queues.preprocess.getJob(row.id)).toBeFalsy();
      expect(await status(row.id)()).toBe('queued');
    });

    it('re-enqueues the probe of a recording stuck in validating, and the worker finishes it', async () => {
      const id = await addRecording('validating');
      const { deps } = makeDeps();
      await sweep(deps, queues);
      expect(await queues.probe.getJob(`probe-${id}`)).toBeTruthy();
      await start();
      await waitFor(async () => (await recording(id)).status === 'valid', 'valid');
    });

    it('recovers a running row whose job vanished (end to end with workers)', async () => {
      const id = await addRecording('valid');
      const row = await newVersion(id);
      expect(await markRunning(handle.db, W, row.id)).toBe(true);
      await sweep(makeDeps().deps, queues);
      await start();
      await untilStatus(row.id, 'succeeded');
    });
  });

  describe('startup', () => {
    it('does not start the processing workers without AUDIO_SERVICE_TOKEN', async () => {
      const noToken = loadConfig({
        REDIS_URL: urls.redis,
        DATABASE_URL: urls.db,
        AUDIO_SERVICE_URL: 'http://127.0.0.1:8001',
        LOG_LEVEL: 'fatal',
      });
      app = await NestFactory.createApplicationContext(OrchestratorModule.forRoot(noToken), {
        logger: false,
      });
      await app.init();
      expect(app.get(ProcessingWorkers).running).toBe(false);
    });

    it('starts the workers and shuts them down cleanly', async () => {
      await start();
      expect(app!.get(ProcessingWorkers).running).toBe(true);
      await app!.close();
      app = undefined;
    });
  });
});
