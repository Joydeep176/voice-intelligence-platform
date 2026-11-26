import { AudioDiagnosticsSnapshot, JobIds } from '@vip/contracts';
import {
  DEV_WORKSPACE_ID,
  beginStage,
  completePreprocessing,
  createDb,
  finishStage,
  insertCreatedRun,
  insertDiagnostics,
  markRunning,
  recordings,
  requestRunCancel,
  upsertPreprocessing,
  type DbHandle,
} from '@vip/db';
import request from 'supertest';
import { RunQueues } from '../src/queue/run-queues.producer';
import { OTHER_WORKSPACE_ID, type TestApp, createTestApp, resetDatabase } from './support/test-app';

const W = DEV_WORKSPACE_ID;
const base = `/api/v1/workspaces/${W}`;

describe('audio diagnostics API (integration, ADR-0044 / API §4)', () => {
  let t: TestApp;
  let handle: DbHandle;
  let queues: RunQueues;
  const http = () => request(t.app.getHttpServer());

  const runWithPreprocessing = async (workspaceId = W) => {
    const id = crypto.randomUUID();
    await handle.db.insert(recordings).values({
      id,
      workspaceId,
      originalFilename: 'synthetic.wav',
      storageUri: `local://recordings/${workspaceId}/${id}/original`,
      mimeType: 'audio/wav',
      sizeBytes: 1000,
      status: 'valid',
    });
    const { preprocessing } = await upsertPreprocessing(handle.db, {
      workspaceId,
      recordingId: id,
      configHash: 'a'.repeat(64),
      config: {},
      toolVersions: {},
    });
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
    const run = await insertCreatedRun(handle.db, workspaceId, id);
    return { runId: run.id, preprocessingId: preprocessing.id };
  };

  const assessed = async (workspaceId = W) => {
    const ids = await runWithPreprocessing(workspaceId);
    await beginStage(handle.db, workspaceId, ids.runId, 'audio_quality', 1);
    await insertDiagnostics(handle.db, {
      workspaceId,
      runId: ids.runId,
      preprocessingId: ids.preprocessingId,
      measurementSetId: null,
      attempt: 1,
      ruleVersion: 'a1-rules-0.1-provisional',
      provisional: true,
      overall: 'acceptable_with_warnings',
      confidence: 'low',
      suitability: {
        transcription: { value: 'limited', reasons: ['dropout'] },
        diarization: { value: 'suitable', reasons: [] },
      },
      notAssessed: [{ dimension: 'reverberation', reason: 'not_supported_v1' }],
      recommendations: [{ code: 'check_recording_device' }],
      affectedRatio: 0.01,
      tier1: 'not_requested',
      ruleConfig: {},
      flags: [
        {
          kind: 'dropout',
          severity: 'medium',
          startMs: 5000,
          endMs: 5300,
          basis: 'measured',
          ruleId: 'dropout.timestamp_gap',
          measurementRefs: [{ quantity: 'timeline.gaps' }],
        },
        {
          kind: 'silence',
          severity: 'low',
          startMs: 40_000,
          endMs: 50_000,
          basis: 'derived',
          ruleId: 'silence.region',
          measurementRefs: [],
        },
      ],
    });
    await finishStage(handle.db, workspaceId, ids.runId, 'audio_quality', 1, 'completed');
    return ids;
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
    await queues.audioQuality.obliterate({ force: true });
  });

  it('returns pending for a created run whose preprocessing succeeded but has no assessment yet', async () => {
    const { runId } = await runWithPreprocessing();
    const res = await http().get(`${base}/runs/${runId}/audio-diagnostics`).expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = AudioDiagnosticsSnapshot.parse(res.body);
    expect(body).toMatchObject({ state: 'pending', diagnostics: null, stage: null });
  });

  it('returns the completed assessment with summary, flags and the provisional label', async () => {
    const { runId } = await assessed();
    const res = await http().get(`${base}/runs/${runId}/audio-diagnostics`).expect(200);
    const body = AudioDiagnosticsSnapshot.parse(res.body);
    expect(body.state).toBe('completed');
    expect(body.diagnostics?.summary).toMatchObject({
      overall: 'acceptable_with_warnings',
      provisional: true,
      flagCounts: { dropout: { medium: 1 }, silence: { low: 1 } },
    });
    expect(body.diagnostics?.flags).toHaveLength(2);
    expect(body.diagnostics?.recommendations).toEqual([{ code: 'check_recording_device' }]);
  });

  it('pages flags by time range; whole-recording counts stay in the summary', async () => {
    const { runId } = await assessed();
    const res = await http()
      .get(`${base}/runs/${runId}/audio-diagnostics?fromMs=30000&toMs=60000`)
      .expect(200);
    const body = AudioDiagnosticsSnapshot.parse(res.body);
    expect(body.diagnostics?.flags.map((f) => f.kind)).toEqual(['silence']);
    expect(body.diagnostics?.summary.flagCounts.dropout).toEqual({ medium: 1 });
    await http().get(`${base}/runs/${runId}/audio-diagnostics?fromMs=5&toMs=1`).expect(422);
  });

  it('404 for another workspace, an unknown run and a malformed ID (SEC-2)', async () => {
    const other = await assessed(OTHER_WORKSPACE_ID);
    await http().get(`${base}/runs/${other.runId}/audio-diagnostics`).expect(404);
    await http().post(`${base}/runs/${other.runId}/audio-diagnostics/retry`).expect(404);
    await http().get(`${base}/runs/${crypto.randomUUID()}/audio-diagnostics`).expect(404);
    await http().get(`${base}/runs/nope/audio-diagnostics`).expect(404);
    await http()
      .get(`/api/v1/workspaces/${OTHER_WORKSPACE_ID}/runs/${other.runId}/audio-diagnostics`)
      .expect(404); // the dev principal is not a member
  });

  it('A1-only retry enqueues attempt 1 for an unassessed run, then refuses a duplicate (L6)', async () => {
    const { runId } = await runWithPreprocessing();
    await http().post(`${base}/runs/${runId}/audio-diagnostics/retry`).expect(202);
    const job = await queues.audioQuality.getJob(JobIds.audioQuality(runId, 1));
    expect(job?.data).toEqual({ workspaceId: W, runId, attempt: 1 });
    // an assessed run needs no retry
    const done = await assessed();
    const res = await http().post(`${base}/runs/${done.runId}/audio-diagnostics/retry`).expect(409);
    expect(res.body.code).toBe('INVALID_STATE_TRANSITION');
  });

  it('retries after a failed attempt with the next attempt number; refuses cancelled runs', async () => {
    const { runId } = await runWithPreprocessing();
    await beginStage(handle.db, W, runId, 'audio_quality', 1);
    await finishStage(handle.db, W, runId, 'audio_quality', 1, 'failed', { code: 'A1_INTERNAL' });
    const failed = AudioDiagnosticsSnapshot.parse(
      (await http().get(`${base}/runs/${runId}/audio-diagnostics`).expect(200)).body,
    );
    expect(failed).toMatchObject({
      state: 'failed',
      stage: { attempt: 1, error: { code: 'A1_INTERNAL' } },
    });
    await http().post(`${base}/runs/${runId}/audio-diagnostics/retry`).expect(202);
    expect(await queues.audioQuality.getJob(JobIds.audioQuality(runId, 2))).toBeTruthy();
    expect(await requestRunCancel(handle.db, W, runId)).toBe('cancelled');
    await http().post(`${base}/runs/${runId}/audio-diagnostics/retry`).expect(409);
  });
});
