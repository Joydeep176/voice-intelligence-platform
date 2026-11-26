import { JobIds, RunSnapshot, SpeakerList, TranscriptPage, UncertaintyList } from '@vip/contracts';
import {
  DEV_WORKSPACE_ID,
  and,
  auditEvents,
  completePreprocessing,
  completeRunWithTranscript,
  createDb,
  eq,
  getRun,
  insertCreatedRun,
  insertDiarizationRawOutput,
  insertSttRawOutput,
  markRunStarted,
  markRunFailed,
  mergeRunConfig,
  markRunning,
  recordings,
  sql,
  upsertPreprocessing,
  beginStage,
  finishStage,
  type DbHandle,
} from '@vip/db';
import request from 'supertest';
import { RunQueues } from '../src/queue/run-queues.producer';
import { OTHER_WORKSPACE_ID, type TestApp, createTestApp, resetDatabase } from './support/test-app';

const W = DEV_WORKSPACE_ID;
const base = `/api/v1/workspaces/${W}`;
const baseOther = `/api/v1/workspaces/${OTHER_WORKSPACE_ID}`;

describe('transcription runs and transcript endpoints (integration: Postgres + Redis)', () => {
  let t: TestApp;
  let handle: DbHandle;
  let queues: RunQueues;
  const http = () => request(t.app.getHttpServer());

  /** A recording and, unless `none`, a succeeded preprocessing. Returns IDs. */
  const addRecording = async (
    opts: {
      status?: 'valid' | 'uploaded' | 'invalid';
      workspaceId?: string;
      preprocessing?: 'succeeded' | 'queued' | 'none';
    } = {},
  ) => {
    const workspaceId = opts.workspaceId ?? W;
    const id = crypto.randomUUID();
    await handle.db.insert(recordings).values({
      id,
      workspaceId,
      originalFilename: 'synthetic.wav',
      storageUri: `local://recordings/${workspaceId}/${id}/original`,
      mimeType: 'audio/wav',
      sizeBytes: 1000,
      status: opts.status ?? 'valid',
    });
    let preprocessingId: string | null = null;
    const mode = opts.preprocessing ?? 'succeeded';
    if (mode !== 'none') {
      const { preprocessing } = await upsertPreprocessing(handle.db, {
        workspaceId,
        recordingId: id,
        configHash: 'a'.repeat(64),
        config: {},
        toolVersions: {},
      });
      preprocessingId = preprocessing.id;
      if (mode === 'succeeded') {
        await markRunning(handle.db, workspaceId, preprocessing.id);
        await completePreprocessing(handle.db, {
          workspaceId,
          id: preprocessing.id,
          normalizedUri: 'local://derived/x/canonical.wav',
          canonicalSha256: 'b'.repeat(64),
          canonicalDurationMs: 60_000,
          timeline: { schemaVersion: 1 },
          segments: [],
          measurements: [],
        });
      }
    }
    return { id, workspaceId, preprocessingId };
  };

  const post = (recordingId: string, body?: unknown, ws = base) => {
    const req = http().post(`${ws}/recordings/${recordingId}/runs`);
    return body === undefined ? req : req.send(body as object);
  };
  const audits = async (resourceId: string) =>
    (
      await handle.db
        .select({
          action: auditEvents.action,
          actorId: auditEvents.actorId,
          metadata: auditEvents.metadata,
        })
        .from(auditEvents)
        .where(eq(auditEvents.resourceId, resourceId))
    ).sort((a, b) => a.action.localeCompare(b.action));
  const jobState = async (runId: string) => {
    const job = await queues.run.getJob(JobIds.run(runId));
    return job ? job.getState() : null;
  };
  const runCountFor = async (recordingId: string) =>
    (
      await handle.db.execute(
        sql`SELECT count(*)::int AS n FROM pipeline_runs WHERE recording_id = ${recordingId}`,
      )
    ).rows[0] as { n: number };

  /** Moves a run to `running` as the orchestrator would. */
  const startRun = async (runId: string, workspaceId = W) => {
    expect(await markRunStarted(handle.db, workspaceId, runId)).toBe(true);
  };

  /** A completed run with a persisted transcript (as the orchestrator persists it). */
  const completedRun = async (workspaceId = W) => {
    const rec = await addRecording({ workspaceId });
    const run = await insertCreatedRun(handle.db, workspaceId, rec.id);
    await handle.db.execute(
      sql`UPDATE pipeline_runs SET status = 'running', preprocessing_id = ${rec.preprocessingId}, config = ${JSON.stringify({ schemaVersion: 1, stages: ['transcription', 'diarization'] })}::jsonb WHERE id = ${run.id}`,
    );
    await mergeRunConfig(handle.db, workspaceId, run.id, {
      providers: {
        stt: { id: 'fake', model: 'fake-stt-1', fake: true },
        diarization: { id: 'fake', model: 'fake-diarization-1', fake: true },
      },
      window: { source: 'fixed_windows', windowMs: 30000, overlapMs: 1000, count: 1 },
    });
    const raw = await insertSttRawOutput(handle.db, {
      workspaceId,
      runId: run.id,
      windowIndex: 0,
      windowStartMs: 0,
      windowEndMs: 30_000,
      provider: 'fake',
      providerModel: 'fake-stt-1',
      payloadUri: `local://runs/${workspaceId}/${run.id}/stt/0.json`,
      sha256: 'd'.repeat(64),
    });
    await insertDiarizationRawOutput(handle.db, {
      workspaceId,
      runId: run.id,
      provider: 'fake',
      providerModel: 'fake-diarization-1',
      scope: 'whole',
      payloadUri: `local://runs/${workspaceId}/${run.id}/diarization/whole.json`,
      sha256: 'e'.repeat(64),
    });
    await beginStage(handle.db, workspaceId, run.id, 'transcription', 1);
    await finishStage(handle.db, workspaceId, run.id, 'transcription', 1, 'completed');
    await completeRunWithTranscript(handle.db, {
      workspaceId,
      runId: run.id,
      speakerKeys: ['SPEAKER_00', 'SPEAKER_01'],
      segments: [0, 1, 2, 3, 4].map((i) => ({
        startMs: i * 10_000,
        endMs: (i + 1) * 10_000,
        text: `secret transcript text ${String(i)}`,
        language: 'en' as const,
        speakerKey: i % 2 === 0 ? 'SPEAKER_00' : 'SPEAKER_01',
        sourceRawOutputIds: [raw.row.id],
      })),
      uncertainties: [
        { segmentIndex: 2, startMs: 20_000, endMs: 20_500, kind: 'overlapping_speech' },
        { segmentIndex: null, startMs: 45_000, endMs: 46_000, kind: 'speaker_uncertain' },
      ],
    });
    return { runId: run.id, recordingId: rec.id };
  };

  beforeAll(async () => {
    await resetDatabase();
    handle = createDb(process.env.TEST_DATABASE_URL!, { maxConnections: 2 });
    t = await createTestApp();
    queues = t.app.get(RunQueues);
  });
  afterAll(async () => {
    await t?.close();
    await handle?.close();
  });
  beforeEach(async () => {
    await queues.run.obliterate({ force: true });
  });

  describe('POST /recordings/{id}/runs', () => {
    it("submits the recording's existing created run: 202, queued, linked preprocessing, job, audit", async () => {
      const rec = await addRecording();
      const created = await insertCreatedRun(handle.db, W, rec.id);
      const res = await post(rec.id).expect(202);
      const snap = RunSnapshot.parse(res.body);
      expect(snap).toMatchObject({
        id: created.id, // the run created at upload, not a new one
        recordingId: rec.id,
        status: 'queued',
        preprocessingId: rec.preprocessingId,
        scope: ['transcription', 'diarization'],
        retryCount: 0,
        maxRetries: 3,
        cancelRequested: false,
        transcriptAvailable: false,
        providers: null,
        window: null,
      });
      expect(snap.stages.map((s) => [s.node, s.status])).toEqual([
        ['transcription', 'pending'],
        ['diarization', 'pending'],
      ]);
      expect(await jobState(created.id)).toBe('waiting');
      const job = await queues.run.getJob(JobIds.run(created.id));
      expect(job?.data).toEqual({ workspaceId: W, runId: created.id }); // IDs only
      expect(job?.opts.attempts).toBe(3);
      expect(await audits(created.id)).toEqual([
        expect.objectContaining({ action: 'run.requested', actorId: 'dev-local' }),
      ]);
      expect(await runCountFor(rec.id)).toEqual({ n: 1 });
    });

    it('creates a run when the recording has none, and stores language hints', async () => {
      const rec = await addRecording();
      const res = await post(rec.id, { languageHints: ['en', 'hi'] }).expect(202);
      const run = (await getRun(handle.db, W, res.body.id))!;
      expect(run.config).toMatchObject({ schemaVersion: 1, languageHints: ['en', 'hi'] });
      expect(await jobState(run.id)).toBe('waiting');
    });

    it('is idempotent: repeated and concurrent requests give one run and one job', async () => {
      const rec = await addRecording();
      const results = await Promise.all([post(rec.id), post(rec.id), post(rec.id)]);
      for (const r of results) expect(r.status).toBe(202);
      expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
      const again = await post(rec.id).expect(202);
      expect(again.body.id).toBe(results[0]!.body.id);
      expect(await runCountFor(rec.id)).toEqual({ n: 1 });
      const counts = await queues.run.getJobCounts('waiting', 'delayed', 'active');
      expect(counts.waiting).toBe(1);
      expect(await audits(results[0]!.body.id)).toHaveLength(1);
    });

    it('re-ensures the job of an already queued run whose job was lost', async () => {
      const rec = await addRecording();
      const first = await post(rec.id).expect(202);
      await queues.run.obliterate({ force: true });
      await post(rec.id).expect(202);
      expect(await jobState(first.body.id)).toBe('waiting');
    });

    it('a finished run does not block a new one', async () => {
      const done = await completedRun();
      const res = await post(done.recordingId).expect(202);
      expect(res.body.id).not.toBe(done.runId);
      expect(res.body.status).toBe('queued');
      expect(await runCountFor(done.recordingId)).toEqual({ n: 2 });
    });

    it('409 when the recording is not valid or has no succeeded preprocessing', async () => {
      for (const status of ['uploaded', 'invalid'] as const) {
        const rec = await addRecording({ status, preprocessing: 'none' });
        const res = await post(rec.id).expect(409);
        expect(res.body.code).toBe('INVALID_STATE_TRANSITION');
      }
      const none = await addRecording({ preprocessing: 'none' });
      const res = await post(none.id).expect(409);
      expect(res.body.detail).toMatch(/preprocessing/);
      const queued = await addRecording({ preprocessing: 'queued' });
      await post(queued.id).expect(409);
      expect(await runCountFor(none.id)).toEqual({ n: 0 }); // nothing written on rejection
      expect(await queues.run.getJobCounts('waiting')).toMatchObject({ waiting: 0 });
    });

    it('404 for an unknown, malformed or other-workspace recording', async () => {
      const other = await addRecording({ workspaceId: OTHER_WORKSPACE_ID });
      await post(other.id).expect(404);
      await post(crypto.randomUUID()).expect(404);
      await post('not-a-uuid').expect(404);
      await post(other.id, undefined, baseOther).expect(404); // the dev principal is not a member
    });

    it('422 for a field that is not supported', async () => {
      const rec = await addRecording();
      const res = await post(rec.id, { sourceTranscriptVersionId: crypto.randomUUID() }).expect(
        422,
      );
      expect(res.body.code).toBe('VALIDATION_FAILED');
      await post(rec.id, { languageHints: ['fr'] }).expect(422);
    });
  });

  describe('GET /runs/{runId}', () => {
    it('returns the backward-compatible fields plus stages, providers and window', async () => {
      const { runId, recordingId } = await completedRun();
      const res = await http().get(`${base}/runs/${runId}`).expect(200);
      expect(res.headers['cache-control']).toBe('no-store');
      const snap = RunSnapshot.parse(res.body);
      expect(snap).toMatchObject({
        id: runId,
        recordingId,
        status: 'completed',
        currentStage: null,
        error: null,
        transcriptAvailable: true,
        providers: { stt: { id: 'fake', fake: true }, diarization: { id: 'fake', fake: true } },
        window: { source: 'fixed_windows', count: 1 },
      });
      for (const key of [
        'id',
        'recordingId',
        'status',
        'currentStage',
        'error',
        'startedAt',
        'completedAt',
        'createdAt',
        'updatedAt',
      ]) {
        expect(res.body).toHaveProperty(key);
      }
      expect(snap.stages[0]).toMatchObject({
        node: 'transcription',
        status: 'completed',
        attempt: 1,
      });
      expect(snap.stages[1]).toMatchObject({ node: 'diarization', status: 'pending' });
    });

    it('shows a run error as code and node only', async () => {
      const rec = await addRecording();
      const run = await insertCreatedRun(handle.db, W, rec.id);
      await handle.db.execute(
        sql`UPDATE pipeline_runs SET status = 'running' WHERE id = ${run.id}`,
      );
      await markRunFailed(handle.db, W, run.id, {
        code: 'PROVIDER_REJECTED',
        node: 'transcription',
      });
      const res = await http().get(`${base}/runs/${run.id}`).expect(200);
      expect(res.body.status).toBe('failed');
      expect(res.body.error).toEqual({ code: 'PROVIDER_REJECTED', node: 'transcription' });
    });

    it("404 for another workspace's run, an unknown run and a malformed ID", async () => {
      const other = await completedRun(OTHER_WORKSPACE_ID);
      await http().get(`${base}/runs/${other.runId}`).expect(404);
      await http().get(`${base}/runs/${crypto.randomUUID()}`).expect(404);
      await http().get(`${base}/runs/nope`).expect(404);
    });
  });

  describe('POST /runs/{runId}/cancel', () => {
    it('a queued run is cancelled at once and its waiting job removed', async () => {
      const rec = await addRecording();
      const { body } = await post(rec.id).expect(202);
      const res = await http().post(`${base}/runs/${body.id}/cancel`).expect(202);
      expect(res.body.status).toBe('cancelled');
      expect(await jobState(body.id)).toBeNull();
      expect((await audits(body.id)).map((a) => a.action)).toEqual([
        'run.cancelled',
        'run.requested',
      ]);
    });

    it('a running run becomes cancelling with the request recorded; repeating is accepted', async () => {
      const rec = await addRecording();
      const { body } = await post(rec.id).expect(202);
      await startRun(body.id);
      const res = await http().post(`${base}/runs/${body.id}/cancel`).expect(202);
      expect(res.body).toMatchObject({ status: 'cancelling', cancelRequested: true });
      await http().post(`${base}/runs/${body.id}/cancel`).expect(202);
      expect((await audits(body.id)).map((a) => a.action)).toContain('run.cancel_requested');
    });

    it('cancels a created run at once (ADR-0025, amended by ADR-0044 L5)', async () => {
      const rec = await addRecording();
      const created = await insertCreatedRun(handle.db, W, rec.id);
      const res = await http().post(`${base}/runs/${created.id}/cancel`).expect(202);
      expect(res.body.status).toBe('cancelled');
      expect((await audits(created.id)).map((a) => a.action)).toContain('run.cancelled');
      // ...and it stays non-retryable (ADR-0025): it never had a preprocessing version.
      const retry = await http().post(`${base}/runs/${created.id}/retry`).expect(409);
      expect(retry.body.code).toBe('INVALID_STATE_TRANSITION');
      expect((await getRun(handle.db, W, created.id))?.status).toBe('cancelled');
    });

    it('409 for a terminal run; 404 for another workspace', async () => {
      const done = await completedRun();
      const res = await http().post(`${base}/runs/${done.runId}/cancel`).expect(409);
      expect(res.body.code).toBe('INVALID_STATE_TRANSITION');
      const other = await completedRun(OTHER_WORKSPACE_ID);
      await http().post(`${base}/runs/${other.runId}/cancel`).expect(404);
    });
  });

  describe('POST /runs/{runId}/retry', () => {
    const failedRun = async (retryCount = 0) => {
      const rec = await addRecording();
      const { body } = await post(rec.id).expect(202);
      await startRun(body.id);
      await markRunFailed(handle.db, W, body.id, {
        code: 'PROVIDER_REJECTED',
        node: 'transcription',
      });
      await handle.db.execute(
        sql`UPDATE pipeline_runs SET retry_count = ${retryCount} WHERE id = ${body.id}`,
      );
      await queues.run.obliterate({ force: true });
      return body.id as string;
    };

    it('failed -> queued: counted, error cleared, job enqueued, audited', async () => {
      const id = await failedRun();
      const res = await http().post(`${base}/runs/${id}/retry`).expect(202);
      expect(res.body).toMatchObject({
        status: 'queued',
        retryCount: 1,
        error: null,
        completedAt: null,
      });
      expect(await jobState(id)).toBe('waiting');
      expect((await audits(id)).map((a) => a.action)).toContain('run.retried');
    });

    it('a cancelled run can be retried too', async () => {
      const rec = await addRecording();
      const { body } = await post(rec.id).expect(202);
      await http().post(`${base}/runs/${body.id}/cancel`).expect(202);
      const res = await http().post(`${base}/runs/${body.id}/retry`).expect(202);
      expect(res.body.status).toBe('queued');
    });

    it('409 when the run is not failed or cancelled, or the retry limit is reached', async () => {
      const rec = await addRecording();
      const { body } = await post(rec.id).expect(202);
      await http().post(`${base}/runs/${body.id}/retry`).expect(409); // queued
      const limited = await failedRun(3);
      const res = await http().post(`${base}/runs/${limited}/retry`).expect(409);
      expect(res.body.detail).toMatch(/limit/);
      expect((await getRun(handle.db, W, limited))!.status).toBe('failed');
      expect(await jobState(limited)).toBeNull();
    });

    it('404 for another workspace', async () => {
      const other = await completedRun(OTHER_WORKSPACE_ID);
      await http().post(`${base}/runs/${other.runId}/retry`).expect(404);
    });
  });

  describe('transcript endpoints', () => {
    it('versions, speakers and raw metadata of a completed run', async () => {
      const { runId } = await completedRun();
      const versions = await http().get(`${base}/runs/${runId}/transcript/versions`).expect(200);
      expect(versions.body.items).toHaveLength(1);
      expect(versions.body.items[0]).toMatchObject({
        version: 1,
        kind: 'machine',
        baseVersionId: null,
        createdBy: 'system',
        segmentCount: 5,
      });

      const speakers = SpeakerList.parse(
        (await http().get(`${base}/runs/${runId}/speakers`).expect(200)).body,
      );
      expect(speakers.items.map((s) => [s.speakerKey, s.displayName, s.totalSpeechMs])).toEqual([
        ['SPEAKER_00', null, 30_000],
        ['SPEAKER_01', null, 20_000],
      ]);

      const raw = await http().get(`${base}/runs/${runId}/transcript/raw`).expect(200);
      expect(raw.body.items.map((r: { kind: string; fake: boolean }) => [r.kind, r.fake])).toEqual([
        ['stt', true],
        ['diarization', true],
      ]);
      expect(JSON.stringify(raw.body)).not.toMatch(/local:|payloadUri|runs\//); // no storage location
      expect(raw.body.items[0].sha256).toBe('d'.repeat(64));
    });

    it('pages the transcript by keyset cursor and filters by time range and version', async () => {
      const { runId } = await completedRun();
      const first = TranscriptPage.parse(
        (await http().get(`${base}/runs/${runId}/transcript?limit=2`).expect(200)).body,
      );
      expect(first).toMatchObject({
        version: 1,
        kind: 'machine',
        windowSource: 'fixed_windows',
        providers: { stt: { fake: true } },
      });
      expect(first.items.map((s) => s.startMs)).toEqual([0, 10_000]);
      expect(first.nextCursor).not.toBeNull();
      const second = TranscriptPage.parse(
        (
          await http()
            .get(`${base}/runs/${runId}/transcript?limit=2&cursor=${first.nextCursor}`)
            .expect(200)
        ).body,
      );
      expect(second.items.map((s) => s.startMs)).toEqual([20_000, 30_000]);
      const third = TranscriptPage.parse(
        (
          await http()
            .get(`${base}/runs/${runId}/transcript?limit=2&cursor=${second.nextCursor}`)
            .expect(200)
        ).body,
      );
      expect(third.items.map((s) => s.startMs)).toEqual([40_000]);
      expect(third.nextCursor).toBeNull();
      expect(first.items[0]).toMatchObject({ confidence: null, language: 'en' });
      expect(first.items[0]!.speakerId).not.toBeNull();

      const ranged = TranscriptPage.parse(
        (await http().get(`${base}/runs/${runId}/transcript?fromMs=15000&toMs=30000`).expect(200))
          .body,
      );
      expect(ranged.items.map((s) => s.startMs)).toEqual([10_000, 20_000]);
      await http().get(`${base}/runs/${runId}/transcript?version=1`).expect(200);
      await http().get(`${base}/runs/${runId}/transcript?version=2`).expect(404);
    });

    it('rejects a bad cursor or query with 422', async () => {
      const { runId } = await completedRun();
      await http().get(`${base}/runs/${runId}/transcript?cursor=garbage`).expect(422);
      await http().get(`${base}/runs/${runId}/transcript?limit=0`).expect(422);
      await http().get(`${base}/runs/${runId}/transcript?fromMs=-5`).expect(422);
    });

    it('uncertainties are paged and range-filtered', async () => {
      const { runId } = await completedRun();
      const all = UncertaintyList.parse(
        (await http().get(`${base}/runs/${runId}/transcript/uncertainties`).expect(200)).body,
      );
      expect(all.items.map((u) => [u.kind, u.startMs, u.segmentId === null])).toEqual([
        ['overlapping_speech', 20_000, false],
        ['speaker_uncertain', 45_000, true],
      ]);
      const paged = UncertaintyList.parse(
        (await http().get(`${base}/runs/${runId}/transcript/uncertainties?limit=1`).expect(200))
          .body,
      );
      expect(paged.items).toHaveLength(1);
      expect(paged.nextCursor).not.toBeNull();
      const ranged = UncertaintyList.parse(
        (
          await http()
            .get(`${base}/runs/${runId}/transcript/uncertainties?fromMs=40000`)
            .expect(200)
        ).body,
      );
      expect(ranged.items.map((u) => u.kind)).toEqual(['speaker_uncertain']);
    });

    it('a run without a transcript: empty lists, 404 for the transcript itself', async () => {
      const rec = await addRecording();
      const run = await insertCreatedRun(handle.db, W, rec.id);
      expect(
        (await http().get(`${base}/runs/${run.id}/transcript/versions`).expect(200)).body,
      ).toEqual({ items: [] });
      expect((await http().get(`${base}/runs/${run.id}/speakers`).expect(200)).body).toEqual({
        items: [],
      });
      expect((await http().get(`${base}/runs/${run.id}/transcript/raw`).expect(200)).body).toEqual({
        items: [],
      });
      await http().get(`${base}/runs/${run.id}/transcript`).expect(404);
      await http().get(`${base}/runs/${run.id}/transcript/uncertainties`).expect(404);
    });

    it("workspace isolation: every read of another workspace's run is 404", async () => {
      const other = await completedRun(OTHER_WORKSPACE_ID);
      const speaker = (
        await handle.db.execute(
          sql`SELECT id FROM speakers WHERE workspace_id = ${OTHER_WORKSPACE_ID} LIMIT 1`,
        )
      ).rows[0] as { id: string };
      for (const path of [
        'transcript',
        'transcript/versions',
        'transcript/uncertainties',
        'transcript/raw',
        'speakers',
      ]) {
        const res = await http().get(`${base}/runs/${other.runId}/${path}`).expect(404);
        expect(JSON.stringify(res.body)).not.toMatch(/secret transcript/);
      }
      await http()
        .patch(`${base}/runs/${other.runId}/speakers/${speaker.id}`)
        .send({ displayName: 'x' })
        .expect(404);
      // the other workspace's own routes are not reachable for the dev principal either
      await http().get(`${baseOther}/runs/${other.runId}/transcript`).expect(404);
    });

    it('correction versions and derivations are not implemented (no such routes)', async () => {
      const { runId } = await completedRun();
      await http().post(`${base}/runs/${runId}/transcript/versions`).send({}).expect(404);
      await http().get(`${base}/runs/${runId}/transcript/derivations`).expect(404);
    });
  });

  describe('PATCH /runs/{runId}/speakers/{speakerId}', () => {
    it('renames the display name, keeps the key, and audits IDs only', async () => {
      const { runId } = await completedRun();
      const list = SpeakerList.parse((await http().get(`${base}/runs/${runId}/speakers`)).body);
      const target = list.items[0]!;
      const res = await http()
        .patch(`${base}/runs/${runId}/speakers/${target.id}`)
        .send({ displayName: '  Priya Sharma ' })
        .expect(200);
      expect(res.body).toEqual({
        id: target.id,
        speakerKey: target.speakerKey,
        displayName: 'Priya Sharma',
        totalSpeechMs: target.totalSpeechMs,
      });
      const after = SpeakerList.parse((await http().get(`${base}/runs/${runId}/speakers`)).body);
      expect(after.items[0]!.displayName).toBe('Priya Sharma');
      expect(after.items[1]!.displayName).toBeNull();
      const events = await handle.db
        .select()
        .from(auditEvents)
        .where(
          and(eq(auditEvents.resourceId, target.id), eq(auditEvents.action, 'speaker.renamed')),
        );
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        actorId: 'dev-local',
        resourceType: 'speaker',
        metadata: { runId },
      });
      expect(JSON.stringify(events[0])).not.toMatch(/Priya/); // no display name in the audit log
    });

    it('rejects speakerKey and invalid names with 422; the key stays unchanged', async () => {
      const { runId } = await completedRun();
      const target = SpeakerList.parse((await http().get(`${base}/runs/${runId}/speakers`)).body)
        .items[0]!;
      const url = `${base}/runs/${runId}/speakers/${target.id}`;
      await http().patch(url).send({ displayName: 'A', speakerKey: 'SPEAKER_99' }).expect(422);
      await http().patch(url).send({ speakerKey: 'SPEAKER_99' }).expect(422);
      await http().patch(url).send({ displayName: '   ' }).expect(422);
      await http()
        .patch(url)
        .send({ displayName: 'x'.repeat(81) })
        .expect(422);
      const after = SpeakerList.parse((await http().get(`${base}/runs/${runId}/speakers`)).body);
      expect(after.items[0]).toMatchObject({ speakerKey: target.speakerKey, displayName: null });
    });

    it('404 for an unknown speaker, a malformed ID, or a speaker of another run', async () => {
      const a = await completedRun();
      const b = await completedRun();
      const speakerOfB = SpeakerList.parse(
        (await http().get(`${base}/runs/${b.runId}/speakers`)).body,
      ).items[0]!;
      await http()
        .patch(`${base}/runs/${a.runId}/speakers/${speakerOfB.id}`)
        .send({ displayName: 'x' })
        .expect(404);
      await http()
        .patch(`${base}/runs/${a.runId}/speakers/${crypto.randomUUID()}`)
        .send({ displayName: 'x' })
        .expect(404);
      await http()
        .patch(`${base}/runs/${a.runId}/speakers/nope`)
        .send({ displayName: 'x' })
        .expect(404);
      const unchanged = SpeakerList.parse(
        (await http().get(`${base}/runs/${b.runId}/speakers`)).body,
      );
      expect(unchanged.items[0]!.displayName).toBeNull();
    });
  });
});
