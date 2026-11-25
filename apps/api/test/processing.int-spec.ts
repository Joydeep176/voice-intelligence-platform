import {
  DEV_CONSENT_STATEMENT_VERSION,
  JobIds,
  ProcessingSnapshot,
  type AudioServiceCapabilities,
  buildPreprocessConfig,
  canonicalJson,
  toolVersionsFromCapabilities,
} from '@vip/contracts';
import {
  DEV_WORKSPACE_ID,
  auditEvents,
  audioPreprocessings,
  completePreprocessing,
  createDb,
  eq,
  markFailed,
  markRunning,
  recordings,
  upsertPreprocessing,
  type DbHandle,
} from '@vip/db';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import request from 'supertest';
import { AudioQueues } from '../src/queue/audio-queues.producer';
import {
  FAKE_AUDIO_TOKEN,
  FAKE_CAPABILITIES,
  FakeAudioService,
} from './support/fake-audio-service';
import { syntheticWav } from './support/synthetic-wav';
import { OTHER_WORKSPACE_ID, type TestApp, createTestApp, resetDatabase } from './support/test-app';

const base = `/api/v1/workspaces/${DEV_WORKSPACE_ID}`;
const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(
    readFileSync(
      new URL(`../../../packages/contracts/fixtures/audio-service/${name}`, `file://${__dirname}/`),
      'utf8',
    ),
  );

describe('processing endpoints (integration: Postgres + Redis + fake audio service)', () => {
  const fake = new FakeAudioService();
  let t: TestApp;
  let handle: DbHandle;
  let queues: AudioQueues;
  const http = () => request(t.app.getHttpServer());

  const addRecording = async (
    status: 'uploading' | 'uploaded' | 'valid' | 'invalid',
    workspaceId = DEV_WORKSPACE_ID,
  ): Promise<string> => {
    const id = crypto.randomUUID();
    await handle.db.insert(recordings).values({
      id,
      workspaceId,
      originalFilename: 'synthetic.wav',
      storageUri: `local://recordings/${workspaceId}/${id}/original`,
      mimeType: 'audio/wav',
      sizeBytes: 1000,
      status,
      ...(status === 'invalid' ? { validationError: 'CORRUPT_MEDIA' } : {}),
    });
    return id;
  };
  const rows = (recordingId: string) =>
    handle.db
      .select()
      .from(audioPreprocessings)
      .where(eq(audioPreprocessings.recordingId, recordingId));
  const jobCount = async () =>
    (await queues.preprocess.getJobCounts('waiting', 'delayed', 'active')) as Record<
      string,
      number
    >;
  const post = (id: string, suffix = '') =>
    http().post(`${base}/recordings/${id}/processing${suffix}`);
  const get = (id: string, suffix = '') =>
    http().get(`${base}/recordings/${id}/processing${suffix}`);
  const succeed = async (rowId: string, withSegments = false) => {
    expect(await markRunning(handle.db, DEV_WORKSPACE_ID, rowId)).toBe(true);
    const result = fixture(
      withSegments ? 'preprocess-result.segmented.valid.json' : 'preprocess-result.valid.json',
    ) as {
      timeline: Record<string, unknown>;
      segments: Array<Record<string, number | boolean>>;
      measurements: Array<{ source: 'original_decoded' | 'canonical'; [k: string]: unknown }>;
    };
    await completePreprocessing(handle.db, {
      workspaceId: DEV_WORKSPACE_ID,
      id: rowId,
      normalizedUri: 'local://derived/x/canonical.wav',
      canonicalSha256: 'b'.repeat(64),
      canonicalDurationMs: 2000,
      timeline: result.timeline,
      vad: { method: 'none', status: 'not_configured' },
      segments: result.segments.map((s) => ({
        index: s.index as number,
        startMs: s.startMs as number,
        endMs: s.endMs as number,
        overlapStartMs: s.overlapStartMs as number,
        overlapEndMs: s.overlapEndMs as number,
        speechMs: s.speechMs as number,
      })),
      measurements: result.measurements.map((m) => ({
        source: m.source,
        schemaVersion: '1',
        measurements: m,
        serviceVersion: '0.1.0',
      })),
    });
  };

  beforeAll(async () => {
    await resetDatabase();
    handle = createDb(process.env.TEST_DATABASE_URL!, { maxConnections: 2 });
    const url = await fake.start();
    t = await createTestApp({ AUDIO_SERVICE_URL: url, AUDIO_SERVICE_TOKEN: FAKE_AUDIO_TOKEN });
    queues = t.app.get(AudioQueues);
  });
  afterAll(async () => {
    await t?.close();
    await handle?.close();
    await fake.stop();
  });
  beforeEach(async () => {
    fake.down = false;
    fake.capabilities = FAKE_CAPABILITIES;
    await queues.probe.obliterate({ force: true });
    await queues.preprocess.obliterate({ force: true });
  });

  it('queues validation (not preprocessing) after a new upload completes', async () => {
    const wav = syntheticWav(100);
    const created = await http()
      .post(`${base}/recordings`)
      .send({
        filename: 'synthetic.wav',
        mimeType: 'audio/wav',
        sizeBytes: wav.length,
        consent: { statementVersion: DEV_CONSENT_STATEMENT_VERSION, attested: true },
      })
      .expect(201);
    const id = (created.body as { recording: { id: string } }).recording.id;
    for (let n = 1, off = 0; off < wav.length; n++, off += 4096) {
      await http()
        .put(`${base}/recordings/${id}/upload/parts/${n}`)
        .set('content-type', 'application/octet-stream')
        .send(wav.subarray(off, off + 4096))
        .expect(200);
    }
    await http().post(`${base}/recordings/${id}/upload/complete`).expect(200);
    await http().post(`${base}/recordings/${id}/upload/complete`).expect(200); // idempotent repeat

    const job = await queues.probe.getJob(JobIds.probe(id));
    expect(job?.data).toMatchObject({
      workspaceId: DEV_WORKSPACE_ID,
      recordingId: id,
      thenPreprocess: false,
    });
    expect(Object.keys(job!.data).sort()).toEqual([
      'recordingId',
      'submissions',
      'thenPreprocess',
      'workspaceId',
    ]); // IDs and counters only
    expect(await queues.probe.getJobCounts('waiting')).toMatchObject({ waiting: 1 });
    expect((await jobCount()).waiting).toBe(0);
    expect(await rows(id)).toHaveLength(0);
  });

  describe('workspace isolation and validation', () => {
    it('answers 404 for another workspace, a malformed id and an unknown recording', async () => {
      const foreign = await addRecording('valid', OTHER_WORKSPACE_ID);
      for (const id of [foreign, 'not-a-uuid', crypto.randomUUID()]) {
        await get(id).expect(404);
        await get(id, '/segments').expect(404);
        await post(id).expect(404);
        await post(id, '/cancel').expect(404);
      }
      expect(await rows(foreign)).toHaveLength(0);
      expect(await jobCount()).toMatchObject({ waiting: 0 });
      // The other workspace's own route is not reachable by the development principal.
      await request(t.app.getHttpServer())
        .get(`/api/v1/workspaces/${OTHER_WORKSPACE_ID}/recordings/${foreign}/processing`)
        .expect(404);
    });

    it('validates the segment query', async () => {
      const id = await addRecording('valid');
      await get(id, '/segments?limit=1001').expect(422);
      await get(id, '/segments?limit=0').expect(422);
      await get(id, '/segments?fromMs=-1').expect(422);
      await get(id, '/segments?toMs=abc').expect(422);
      await get(id, '/segments?limit=1000').expect(200);
    });

    it('rejects recordings that cannot be processed with 409', async () => {
      for (const status of ['invalid', 'uploading'] as const) {
        const id = await addRecording(status);
        await post(id).expect(409);
        expect(await rows(id)).toHaveLength(0);
      }
    });
  });

  describe('snapshot', () => {
    it('is not_started for an unprocessed recording, never fabricating progress', async () => {
      const id = await addRecording('uploaded');
      const res = await get(id).expect(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(ProcessingSnapshot.parse(res.body)).toEqual({
        state: 'not_started',
        recording: { status: 'uploaded', validationError: null },
        probe: null,
        preprocessing: null,
      });
    });

    it('reports an invalid recording as failed with its validation code', async () => {
      const id = await addRecording('invalid');
      const body = ProcessingSnapshot.parse((await get(id).expect(200)).body);
      expect(body.state).toBe('failed');
      expect(body.recording).toEqual({ status: 'invalid', validationError: 'CORRUPT_MEDIA' });
    });
  });

  describe('start', () => {
    it('on an uploaded recording marks it validating and queues one probe then preprocess', async () => {
      const id = await addRecording('uploaded');
      const first = await post(id).expect(202);
      expect(ProcessingSnapshot.parse(first.body).state).toBe('validating');
      await post(id).expect(202); // repeat: no second job
      const job = await queues.probe.getJob(JobIds.probe(id));
      expect(job?.data).toMatchObject({ recordingId: id, thenPreprocess: true });
      expect(await queues.probe.getJobCounts('waiting')).toMatchObject({ waiting: 1 });
      const [rec] = await handle.db.select().from(recordings).where(eq(recordings.id, id));
      expect(rec?.status).toBe('validating');
      expect(await rows(id)).toHaveLength(0);
    });

    it('retrying a failed older config version enqueues that row, not the newest one', async () => {
      const id = await addRecording('valid');
      const current = buildPreprocessConfig(
        toolVersionsFromCapabilities(FAKE_CAPABILITIES as AudioServiceCapabilities)!,
      );
      const currentHash = createHash('sha256').update(canonicalJson(current)).digest('hex');
      const { preprocessing: older } = await upsertPreprocessing(handle.db, {
        workspaceId: DEV_WORKSPACE_ID,
        recordingId: id,
        configHash: currentHash,
        config: current as unknown as Record<string, unknown>,
        toolVersions: current.toolVersions,
      });
      await markRunning(handle.db, DEV_WORKSPACE_ID, older.id);
      await markFailed(handle.db, DEV_WORKSPACE_ID, older.id, { code: 'TIMEOUT', retryable: true });
      // A newer version (another config hash) exists for the same recording.
      const { preprocessing: newer } = await upsertPreprocessing(handle.db, {
        workspaceId: DEV_WORKSPACE_ID,
        recordingId: id,
        configHash: 'c'.repeat(64),
        config: {},
        toolVersions: {},
      });
      await post(id).expect(202);
      expect(await queues.preprocess.getJob(JobIds.preprocess(older.id))).toBeTruthy();
      expect(await queues.preprocess.getJob(JobIds.preprocess(newer.id))).toBeFalsy();
      const [row] = (await rows(id)).filter((r) => r.id === older.id);
      expect(row?.status).toBe('queued');
    });

    it('an explicit start on a recording validating behind a probe job sets thenPreprocess on it', async () => {
      const id = await addRecording('uploaded');
      await handle.db.update(recordings).set({ status: 'validating' }).where(eq(recordings.id, id));
      await queues.probe.add(
        'probe',
        { workspaceId: DEV_WORKSPACE_ID, recordingId: id, thenPreprocess: false, submissions: 0 },
        { jobId: JobIds.probe(id), delay: 600_000 },
      );
      await post(id).expect(202);
      const job = await queues.probe.getJob(JobIds.probe(id));
      expect(job?.data).toMatchObject({ thenPreprocess: true });
      expect(await queues.probe.getJobCounts('waiting', 'delayed')).toMatchObject({ delayed: 1 });
    });

    it('queues a continuing probe when the recording is validating but has no job', async () => {
      const id = await addRecording('uploaded');
      await handle.db.update(recordings).set({ status: 'validating' }).where(eq(recordings.id, id));
      await post(id).expect(202);
      const job = await queues.probe.getJob(JobIds.probe(id));
      expect(job?.data).toMatchObject({ recordingId: id, thenPreprocess: true });
    });

    it('on a valid recording creates one queued version and one job', async () => {
      const id = await addRecording('valid');
      const res = await post(id).expect(202);
      const snapshot = ProcessingSnapshot.parse(res.body);
      expect(snapshot.state).toBe('queued');
      const [row] = await rows(id);
      expect(row).toMatchObject({ status: 'queued', attempt: 0, workspaceId: DEV_WORKSPACE_ID });
      expect(snapshot.preprocessing).toMatchObject({ id: row!.id, maxRetries: 3, attempt: 0 });
      expect(row!.configHash).toBe(snapshot.preprocessing!.configHash);
      const job = await queues.preprocess.getJob(JobIds.preprocess(row!.id));
      expect(job?.data).toEqual({ workspaceId: DEV_WORKSPACE_ID, preprocessingId: row!.id });
    });

    it('is idempotent: repeated and concurrent requests give one row and one job', async () => {
      const id = await addRecording('valid');
      const results = await Promise.all(Array.from({ length: 6 }, () => post(id)));
      expect(results.map((r) => r.status).every((s) => s === 202)).toBe(true);
      await post(id).expect(202);
      expect(await rows(id)).toHaveLength(1);
      expect((await jobCount()).waiting).toBe(1);
      const ids = new Set(results.map((r) => (r.body as ProcessingSnapshot).preprocessing?.id));
      expect(ids.size).toBe(1);
    });

    it('returns a succeeded version without a job (200), with measurements and segments', async () => {
      const id = await addRecording('valid');
      await post(id).expect(202);
      const [row] = await rows(id);
      await queues.preprocess.obliterate({ force: true });
      await succeed(row!.id, true);

      const again = await post(id).expect(200);
      const snapshot = ProcessingSnapshot.parse(again.body);
      expect(snapshot.preprocessing?.id).toBe(row!.id);
      expect(snapshot.state).toBe('completed');
      expect(snapshot.preprocessing).toMatchObject({
        canonical: { durationMs: 2000 },
        segmentCount: 2,
        vad: { method: 'none', status: 'not_configured' },
        timeline: { decodeClass: expect.any(String) },
      });
      expect(snapshot.preprocessing?.measurements.map((m) => m.source).sort()).toEqual([
        'canonical',
        'original_decoded',
      ]);
      expect((await jobCount()).waiting).toBe(0);
      expect(await rows(id)).toHaveLength(1);

      const all = await get(id, '/segments').expect(200);
      expect(all.body).toMatchObject({ preprocessingId: row!.id });
      expect((all.body as { items: unknown[] }).items).toHaveLength(2);
      const window = await get(id, '/segments?fromMs=1200&limit=5').expect(200);
      expect(
        (window.body as { items: Array<{ index: number }> }).items.map((s) => s.index),
      ).toEqual([1]);
      const one = await get(id, '/segments?limit=1').expect(200);
      expect((one.body as { items: unknown[] }).items).toHaveLength(1);
    });

    it('retries a failed version while attempts remain, then answers 409', async () => {
      const id = await addRecording('valid');
      await post(id).expect(202);
      const [row] = await rows(id);
      await queues.preprocess.obliterate({ force: true });
      await markRunning(handle.db, DEV_WORKSPACE_ID, row!.id);
      await markFailed(handle.db, DEV_WORKSPACE_ID, row!.id, { code: 'TIMEOUT', retryable: true });
      await handle.db
        .update(audioPreprocessings)
        .set({ attempt: 2 })
        .where(eq(audioPreprocessings.id, row!.id));
      expect(ProcessingSnapshot.parse((await get(id)).body).state).toBe('failed');

      const retried = await post(id).expect(202);
      expect(ProcessingSnapshot.parse(retried.body)).toMatchObject({
        state: 'queued',
        preprocessing: { id: row!.id, attempt: 2, error: null },
      });
      expect((await jobCount()).waiting).toBe(1);

      await queues.preprocess.obliterate({ force: true });
      await markRunning(handle.db, DEV_WORKSPACE_ID, row!.id);
      await markFailed(handle.db, DEV_WORKSPACE_ID, row!.id, { code: 'TIMEOUT', retryable: true });
      await handle.db
        .update(audioPreprocessings)
        .set({ attempt: 3 })
        .where(eq(audioPreprocessings.id, row!.id));
      await post(id).expect(409);
      expect((await jobCount()).waiting).toBe(0);
    });

    it('answers 503 and writes nothing when the audio service is down', async () => {
      const uploaded = await addRecording('uploaded');
      const valid = await addRecording('valid');
      fake.down = true;
      await post(uploaded).expect(503);
      await post(valid).expect(503);
      fake.down = false;
      const [rec] = await handle.db.select().from(recordings).where(eq(recordings.id, uploaded));
      expect(rec?.status).toBe('uploaded');
      expect(await rows(valid)).toHaveLength(0);
      expect(await queues.probe.getJobCounts('waiting')).toMatchObject({ waiting: 0 });
      expect((await jobCount()).waiting).toBe(0);
    });

    it('answers 503 when the service cannot preprocess', async () => {
      const valid = await addRecording('valid');
      fake.capabilities = { ...fake.capabilities, taskTypes: ['probe'] };
      const res = await post(valid).expect(503);
      expect(res.body).toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE' });
      expect(await rows(valid)).toHaveLength(0);
    });

    it('answers 503 when no token is configured', async () => {
      const unconfigured = await createTestApp({ AUDIO_SERVICE_URL: 'http://127.0.0.1:9' });
      try {
        const valid = await addRecording('valid');
        await request(unconfigured.app.getHttpServer())
          .post(`${base}/recordings/${valid}/processing`)
          .expect(503);
        expect(await rows(valid)).toHaveLength(0);
      } finally {
        await unconfigured.close();
      }
    });
  });

  describe('cancel', () => {
    it('cancels a queued version immediately and removes its job', async () => {
      const id = await addRecording('valid');
      await post(id).expect(202);
      const [row] = await rows(id);
      const res = await post(id, '/cancel').expect(202);
      expect(ProcessingSnapshot.parse(res.body).state).toBe('cancelled');
      expect((await rows(id))[0]?.status).toBe('cancelled');
      expect(await queues.preprocess.getJob(JobIds.preprocess(row!.id))).toBeUndefined();
    });

    it('records the request on a running version and leaves it running', async () => {
      const id = await addRecording('valid');
      await post(id).expect(202);
      const [row] = await rows(id);
      await markRunning(handle.db, DEV_WORKSPACE_ID, row!.id);
      const res = await post(id, '/cancel').expect(202);
      expect(ProcessingSnapshot.parse(res.body)).toMatchObject({
        state: 'processing',
        preprocessing: { cancelRequested: true },
      });
    });

    it('answers 409 when nothing is active', async () => {
      const none = await addRecording('valid');
      await post(none, '/cancel').expect(409);
      const done = await addRecording('valid');
      await post(done).expect(202);
      const [row] = await rows(done);
      await queues.preprocess.obliterate({ force: true });
      await succeed(row!.id);
      await post(done, '/cancel').expect(409);
    });
  });

  it('writes no audit rows for read endpoints (nothing sensitive is recorded)', async () => {
    const before = await handle.db.select().from(auditEvents);
    const id = await addRecording('valid');
    await get(id).expect(200);
    await get(id, '/segments').expect(200);
    expect(await handle.db.select().from(auditEvents)).toHaveLength(before.length);
  });
});
