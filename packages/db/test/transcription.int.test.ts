import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  beginStage,
  completeRunWithTranscript,
  diarizationRawOutputs,
  finishStage,
  getRun,
  getSttRawOutput,
  getTranscriptForRun,
  getTranscriptVersion,
  getWholeDiarizationRawOutput,
  insertCreatedRun,
  insertDiarizationRawOutput,
  insertSttRawOutput,
  listSpeakers,
  listStageRuns,
  listStuckRuns,
  listTranscriptSegments,
  listTranscriptVersions,
  listUncertainties,
  markRunCancelled,
  markRunFailed,
  markRunStarted,
  mergeRunConfig,
  pipelineRuns,
  recordings,
  renameSpeaker,
  requestRunCancel,
  requeueStuckRun,
  resetRunForRetry,
  runMigrations,
  setRunStage,
  sttRawOutputs,
  submitRun,
  transcriptSegments,
  transcriptVersions,
  updateStageProgress,
  upsertPreprocessing,
  workspaces,
  type CompleteRunInput,
  type DbHandle,
} from '../src/index.js';
import { resetTestDatabase, resetTestDatabaseUpTo } from './test-db.js';

const WS_A = '00000000-0000-4000-8000-0000000000a1';
const WS_B = '00000000-0000-4000-8000-0000000000b2';
const HASH = 'a'.repeat(64);
const SHA = 'c'.repeat(64);

let handle: DbHandle;

async function addRecording(workspaceId = WS_A) {
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
  return id;
}

/** A run in `running`, ready for completion. */
async function runningRun(workspaceId = WS_A) {
  const recordingId = await addRecording(workspaceId);
  const { preprocessing } = await upsertPreprocessing(handle.db, {
    workspaceId,
    recordingId,
    configHash: HASH,
    config: { v: 1 },
    toolVersions: {},
  });
  const run = await insertCreatedRun(handle.db, workspaceId, recordingId);
  await submitRun(handle.db, workspaceId, run.id, {
    preprocessingId: preprocessing.id,
    config: { schemaVersion: 1, stages: ['transcription', 'diarization'] },
  });
  await markRunStarted(handle.db, workspaceId, run.id);
  return { runId: run.id, recordingId, preprocessingId: preprocessing.id };
}

const completion = (
  runId: string,
  overrides: Partial<CompleteRunInput> = {},
): CompleteRunInput => ({
  workspaceId: WS_A,
  runId,
  speakerKeys: ['SPEAKER_00', 'SPEAKER_01'],
  segments: [
    { startMs: 0, endMs: 1000, text: 'one', language: 'en', speakerKey: 'SPEAKER_00' },
    {
      startMs: 1000,
      endMs: 3000,
      text: 'two',
      language: 'hi',
      speakerKey: 'SPEAKER_01',
      confidence: 0.5,
    },
    { startMs: 3000, endMs: 4000, text: 'three', language: 'mixed', speakerKey: null },
  ],
  uncertainties: [
    { segmentIndex: 1, startMs: 1000, endMs: 1500, kind: 'overlapping_speech' },
    { segmentIndex: 2, startMs: 3000, endMs: 4000, kind: 'speaker_uncertain' },
  ],
  ...overrides,
});

const rawInput = (runId: string, overrides: Record<string, unknown> = {}) => ({
  workspaceId: WS_A,
  runId,
  windowIndex: 0,
  windowStartMs: 0,
  windowEndMs: 1000,
  provider: 'fake',
  providerModel: 'm',
  payloadUri: 'local://x',
  sha256: SHA,
  ...overrides,
});

beforeAll(async () => {
  handle = await resetTestDatabase();
  await handle.db.insert(workspaces).values([
    { id: WS_A, name: 'A' },
    { id: WS_B, name: 'B' },
  ]);
});
afterAll(async () => {
  await handle?.close();
});

describe('migration 0003_transcription', () => {
  it('leaves rows written under the 0002 schema identical and adds only null columns', async () => {
    const old = await resetTestDatabaseUpTo(3);
    try {
      await old.db.execute(sql`INSERT INTO workspaces (id, name) VALUES (${WS_A}, 'A')`);
      const recId = crypto.randomUUID();
      await old.db
        .execute(sql`INSERT INTO recordings (id, workspace_id, original_filename, storage_uri, mime_type, size_bytes, status)
        VALUES (${recId}, ${WS_A}, 'old.wav', ${'local://old/' + recId}, 'audio/wav', 10, 'valid')`);
      await old.db.execute(
        sql`INSERT INTO pipeline_runs (workspace_id, recording_id, status, retry_count) VALUES (${WS_A}, ${recId}, 'failed', 2)`,
      );
      const snapshot = async () => ({
        recordings: (await old.db.execute(sql`SELECT r::text AS t FROM recordings r`)).rows,
        runs: (
          await old.db.execute(
            sql`SELECT (to_jsonb(p) - 'preprocessing_id' - 'config' - 'cancel_requested_at')::text AS t FROM pipeline_runs p`,
          )
        ).rows,
      });
      const before = await snapshot();
      expect(before.runs).toHaveLength(1);
      await runMigrations(old.db);
      expect(await snapshot()).toEqual(before);
      const added = await old.db.execute(
        sql`SELECT preprocessing_id, config, cancel_requested_at FROM pipeline_runs`,
      );
      expect(added.rows[0]).toEqual({
        preprocessing_id: null,
        config: null,
        cancel_requested_at: null,
      });
    } finally {
      await old.close();
    }
    handle = await resetTestDatabase();
    await handle.db.insert(workspaces).values([
      { id: WS_A, name: 'A' },
      { id: WS_B, name: 'B' },
    ]);
  });

  it('creates all transcription tables on a fresh database', async () => {
    const res = await handle.db.execute(sql`
      SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'
      AND table_name IN ('pipeline_stage_runs','stt_raw_outputs','diarization_raw_outputs','transcripts',
        'transcript_versions','speakers','transcript_segments','transcription_uncertainties')`);
    expect(res.rows).toHaveLength(8);
  });
});

describe('composite workspace FKs and CHECKs', () => {
  it('rejects a run linked to another workspace preprocessing', async () => {
    const recB = await addRecording(WS_B);
    const { preprocessing: preB } = await upsertPreprocessing(handle.db, {
      workspaceId: WS_B,
      recordingId: recB,
      configHash: HASH,
      config: {},
      toolVersions: {},
    });
    const recA = await addRecording(WS_A);
    const run = await insertCreatedRun(handle.db, WS_A, recA);
    await expect(
      handle.db
        .update(pipelineRuns)
        .set({ preprocessingId: preB.id })
        .where(sql`id = ${run.id}`),
    ).rejects.toThrow();
  });

  it('rejects child rows whose workspace differs from the run workspace', async () => {
    const { runId } = await runningRun(WS_A);
    await expect(
      insertSttRawOutput(handle.db, rawInput(runId, { workspaceId: WS_B })),
    ).rejects.toThrow();
    await expect(beginStage(handle.db, WS_B, runId, 'transcription', 1)).rejects.toThrow();
  });

  it('rejects a segment pointing at a speaker of another workspace', async () => {
    const a = await runningRun(WS_A);
    const b = await runningRun(WS_B);
    await completeRunWithTranscript(handle.db, completion(a.runId));
    await completeRunWithTranscript(handle.db, { ...completion(b.runId), workspaceId: WS_B });
    const transcriptB = (await getTranscriptForRun(handle.db, WS_B, b.runId))!;
    const speakerB = (await listSpeakers(handle.db, WS_B, transcriptB.id))[0]!;
    const transcriptA = (await getTranscriptForRun(handle.db, WS_A, a.runId))!;
    const versionA = (await getTranscriptVersion(handle.db, WS_A, transcriptA.id))!;
    await expect(
      handle.db.insert(transcriptSegments).values({
        workspaceId: WS_A,
        transcriptVersionId: versionA.id,
        speakerId: speakerB.id,
        startMs: 5000,
        endMs: 6000,
        text: 'x',
        language: 'en',
      }),
    ).rejects.toThrow();
  });

  it('enforces CHECKs: ranges, language, confidence, version', async () => {
    const { runId } = await runningRun();
    await completeRunWithTranscript(handle.db, completion(runId));
    const transcript = (await getTranscriptForRun(handle.db, WS_A, runId))!;
    const version = (await getTranscriptVersion(handle.db, WS_A, transcript.id))!;
    const base = {
      workspaceId: WS_A,
      transcriptVersionId: version.id,
      startMs: 10,
      endMs: 20,
      text: 'x',
      language: 'en' as const,
    };
    await expect(
      handle.db.insert(transcriptSegments).values({ ...base, startMs: 20, endMs: 20 }),
    ).rejects.toThrow();
    await expect(
      handle.db.insert(transcriptSegments).values({ ...base, language: 'fr' as 'en' }),
    ).rejects.toThrow();
    await expect(
      handle.db.insert(transcriptSegments).values({ ...base, confidence: 1.2 }),
    ).rejects.toThrow();
    await expect(
      handle.db.insert(transcriptVersions).values({
        workspaceId: WS_A,
        transcriptId: transcript.id,
        version: 0,
        kind: 'machine',
        createdBy: 'system',
      }),
    ).rejects.toThrow();
    await expect(
      handle.db.insert(transcriptVersions).values({
        workspaceId: WS_A,
        transcriptId: transcript.id,
        version: 2,
        kind: 'user_correction',
        createdBy: 'u',
      }),
    ).rejects.toThrow(); // a correction needs a base version
  });
});

/** drizzle wraps driver errors ("Failed query"); the trigger message is on `cause`. */
async function expectImmutable(promise: Promise<unknown>): Promise<void> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e as Error & { cause?: Error },
  );
  expect(error, 'expected the UPDATE to be rejected').not.toBeNull();
  expect(`${error?.message} ${error?.cause?.message ?? ''}`).toMatch(/immutable/);
}

describe('immutability triggers', () => {
  it('blocks UPDATE of raw outputs, versions, segments and speaker_key; allows display_name', async () => {
    const { runId } = await runningRun();
    const raw = await insertSttRawOutput(handle.db, rawInput(runId));
    const dia = await insertDiarizationRawOutput(handle.db, {
      workspaceId: WS_A,
      runId,
      provider: 'fake',
      providerModel: 'm',
      scope: 'whole',
      payloadUri: 'local://y',
      sha256: SHA,
    });
    await completeRunWithTranscript(handle.db, completion(runId));
    const transcript = (await getTranscriptForRun(handle.db, WS_A, runId))!;
    const version = (await getTranscriptVersion(handle.db, WS_A, transcript.id))!;
    const segment = (await listTranscriptSegments(handle.db, WS_A, version.id, { limit: 10 }))[0]!;
    const speaker = (await listSpeakers(handle.db, WS_A, transcript.id))[0]!;

    // Was `await expect(query)` with no matcher, so the lazy query never ran and nothing was asserted.
    await expectImmutable(
      handle.db
        .update(sttRawOutputs)
        .set({ sha256: 'd'.repeat(64) })
        .where(sql`id = ${raw.row.id}`),
    );
    await expectImmutable(
      handle.db
        .update(diarizationRawOutputs)
        .set({ payloadUri: 'local://z' })
        .where(sql`id = ${dia.row.id}`),
    );
    await expectImmutable(
      handle.db
        .update(transcriptVersions)
        .set({ note: 'x' })
        .where(sql`id = ${version.id}`),
    );
    await expectImmutable(
      handle.db
        .update(transcriptSegments)
        .set({ text: 'changed' })
        .where(sql`id = ${segment.id}`),
    );
    await expectImmutable(
      handle.db.execute(
        sql`UPDATE speakers SET speaker_key = 'SPEAKER_99' WHERE id = ${speaker.id}`,
      ),
    );

    const renamed = await renameSpeaker(handle.db, WS_A, runId, speaker.id, 'Anna');
    expect(renamed?.displayName).toBe('Anna');
    expect(renamed?.speakerKey).toBe(speaker.speakerKey);
  });

  it('allows DELETE through the recording cascade', async () => {
    const { runId, recordingId } = await runningRun();
    await completeRunWithTranscript(handle.db, completion(runId));
    await handle.db.execute(sql`DELETE FROM recordings WHERE id = ${recordingId}`);
    const left = await handle.db.execute(
      sql`SELECT count(*)::int AS n FROM transcripts WHERE run_id = ${runId}`,
    );
    expect(left.rows[0]).toEqual({ n: 0 });
  });

  /* Regression (Phase 2C audit §11.4, migration 0004_transcription_integrity). */
  it('refuses a direct speaker DELETE, leaving the speaker and its segments intact', async () => {
    const { runId } = await runningRun();
    await completeRunWithTranscript(handle.db, completion(runId));
    const transcript = (await getTranscriptForRun(handle.db, WS_A, runId))!;
    const version = (await getTranscriptVersion(handle.db, WS_A, transcript.id))!;
    const speaker = (await listSpeakers(handle.db, WS_A, transcript.id))[0]!;
    const before = await listTranscriptSegments(handle.db, WS_A, version.id, { limit: 10 });

    const error = await handle.db.execute(sql`DELETE FROM speakers WHERE id = ${speaker.id}`).then(
      () => null,
      (e: unknown) => e as Error & { cause?: Error },
    );
    expect(error, 'expected the DELETE to be rejected').not.toBeNull();
    expect(`${error?.message} ${error?.cause?.message ?? ''}`).toMatch(
      /deleted only with their transcript/,
    );
    expect(await listSpeakers(handle.db, WS_A, transcript.id)).toHaveLength(2);
    expect(await listTranscriptSegments(handle.db, WS_A, version.id, { limit: 10 })).toEqual(
      before,
    );
  });

  it('deleting a run cascades through transcript, speakers, segments and uncertainties', async () => {
    const { runId } = await runningRun();
    await completeRunWithTranscript(handle.db, completion(runId));
    const transcript = (await getTranscriptForRun(handle.db, WS_A, runId))!;
    await handle.db.execute(sql`DELETE FROM pipeline_runs WHERE id = ${runId}`);
    const left = await handle.db.execute(sql`
      SELECT (SELECT count(*) FROM speakers WHERE transcript_id = ${transcript.id})::int AS speakers,
             (SELECT count(*) FROM transcript_versions WHERE transcript_id = ${transcript.id})::int AS versions`);
    expect(left.rows[0]).toEqual({ speakers: 0, versions: 0 });
  });

  it('blocks UPDATE of transcription uncertainties', async () => {
    const { runId } = await runningRun();
    await completeRunWithTranscript(handle.db, completion(runId));
    const transcript = (await getTranscriptForRun(handle.db, WS_A, runId))!;
    const version = (await getTranscriptVersion(handle.db, WS_A, transcript.id))!;
    const [u] = await listUncertainties(handle.db, WS_A, version.id, { limit: 10 });
    await expectImmutable(
      handle.db.execute(
        sql`UPDATE transcription_uncertainties SET score = 0.9 WHERE id = ${u!.id}`,
      ),
    );
  });
});

describe('atomic, idempotent transcript v1', () => {
  it('persists version, speakers, segments, uncertainties and completes the run', async () => {
    const { runId } = await runningRun();
    expect(await completeRunWithTranscript(handle.db, completion(runId))).toBe(true);
    const run = (await getRun(handle.db, WS_A, runId))!;
    expect(run.status).toBe('completed');
    expect(run.finishedAt).not.toBeNull();
    const transcript = (await getTranscriptForRun(handle.db, WS_A, runId))!;
    const versions = await listTranscriptVersions(handle.db, WS_A, transcript.id);
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({ version: 1, kind: 'machine', segmentCount: 3 });
    const speakers = await listSpeakers(handle.db, WS_A, transcript.id);
    expect(speakers.map((s) => [s.speakerKey, s.totalSpeechMs])).toEqual([
      ['SPEAKER_00', 1000],
      ['SPEAKER_01', 2000],
    ]);
    const segs = await listTranscriptSegments(handle.db, WS_A, versions[0]!.id, { limit: 10 });
    expect(segs.map((s) => s.confidence)).toEqual([null, 0.5, null]);
    expect(segs[2]?.speakerId).toBeNull();
    const unc = await listUncertainties(handle.db, WS_A, versions[0]!.id, { limit: 10 });
    expect(unc.map((u) => [u.kind, u.segmentId])).toEqual([
      ['overlapping_speech', segs[1]!.id],
      ['speaker_uncertain', segs[2]!.id],
    ]);
  });

  it('a second completion is a no-op (nothing duplicated)', async () => {
    const { runId } = await runningRun();
    expect(await completeRunWithTranscript(handle.db, completion(runId))).toBe(true);
    expect(await completeRunWithTranscript(handle.db, completion(runId))).toBe(false);
    const transcript = (await getTranscriptForRun(handle.db, WS_A, runId))!;
    expect(await listTranscriptVersions(handle.db, WS_A, transcript.id)).toHaveLength(1);
    expect(await listSpeakers(handle.db, WS_A, transcript.id)).toHaveLength(2);
  });

  it('concurrent completions persist exactly one transcript', async () => {
    const { runId } = await runningRun();
    const results = await Promise.allSettled([
      completeRunWithTranscript(handle.db, completion(runId)),
      completeRunWithTranscript(handle.db, completion(runId)),
      completeRunWithTranscript(handle.db, completion(runId)),
    ]);
    const applied = results.filter((r) => r.status === 'fulfilled' && r.value === true);
    expect(applied).toHaveLength(1);
    const transcript = (await getTranscriptForRun(handle.db, WS_A, runId))!;
    expect(await listTranscriptVersions(handle.db, WS_A, transcript.id)).toHaveLength(1);
  });

  it('rolls back everything when the run is no longer running (cancelling)', async () => {
    const { runId } = await runningRun();
    expect(await requestRunCancel(handle.db, WS_A, runId)).toBe('cancelling');
    expect(await completeRunWithTranscript(handle.db, completion(runId))).toBe(false);
    expect(await getTranscriptForRun(handle.db, WS_A, runId)).toBeNull();
    expect((await getRun(handle.db, WS_A, runId))?.status).toBe('cancelling');
  });

  it('rolls back everything on a bad reference (unlisted speaker)', async () => {
    const { runId } = await runningRun();
    await expect(
      completeRunWithTranscript(
        handle.db,
        completion(runId, {
          segments: [{ startMs: 0, endMs: 10, text: 'x', language: 'en', speakerKey: 'NOPE' }],
          uncertainties: [],
        }),
      ),
    ).rejects.toThrow();
    expect(await getTranscriptForRun(handle.db, WS_A, runId)).toBeNull();
    expect((await getRun(handle.db, WS_A, runId))?.status).toBe('running');
  });

  it('is workspace scoped: another workspace cannot complete or read the run', async () => {
    const { runId } = await runningRun(WS_A);
    expect(
      await completeRunWithTranscript(handle.db, { ...completion(runId), workspaceId: WS_B }),
    ).toBe(false);
    expect(await getRun(handle.db, WS_B, runId)).toBeNull();
    await completeRunWithTranscript(handle.db, completion(runId));
    expect(await getTranscriptForRun(handle.db, WS_B, runId)).toBeNull();
    const transcript = (await getTranscriptForRun(handle.db, WS_A, runId))!;
    expect(await listSpeakers(handle.db, WS_B, transcript.id)).toEqual([]);
    const speaker = (await listSpeakers(handle.db, WS_A, transcript.id))[0]!;
    expect(await renameSpeaker(handle.db, WS_B, runId, speaker.id, 'x')).toBeNull();
  });

  it('pages segments by keyset and filters by time range', async () => {
    const { runId } = await runningRun();
    await completeRunWithTranscript(handle.db, completion(runId));
    const transcript = (await getTranscriptForRun(handle.db, WS_A, runId))!;
    const version = (await getTranscriptVersion(handle.db, WS_A, transcript.id))!;
    const first = await listTranscriptSegments(handle.db, WS_A, version.id, { limit: 2 });
    expect(first).toHaveLength(2);
    const last = first[1]!;
    const next = await listTranscriptSegments(handle.db, WS_A, version.id, {
      limit: 2,
      after: { startMs: last.startMs, id: last.id },
    });
    expect(next.map((s) => s.text)).toEqual(['three']);
    const ranged = await listTranscriptSegments(handle.db, WS_A, version.id, {
      limit: 10,
      fromMs: 1500,
      toMs: 3000,
    });
    expect(ranged.map((s) => s.text)).toEqual(['two']);
  });
});

describe('run transitions (guarded)', () => {
  it('walks created -> queued -> running -> failed -> queued (retry, counted) and bounds retries', async () => {
    const recordingId = await addRecording();
    const run = await insertCreatedRun(handle.db, WS_A, recordingId);
    const { preprocessing } = await upsertPreprocessing(handle.db, {
      workspaceId: WS_A,
      recordingId,
      configHash: HASH,
      config: {},
      toolVersions: {},
    });
    const sub = {
      preprocessingId: preprocessing.id,
      config: { schemaVersion: 1, stages: ['transcription'] },
    };
    expect(await markRunStarted(handle.db, WS_A, run.id)).toBe(false); // created cannot start
    expect(await submitRun(handle.db, WS_A, run.id, sub)).toBe(true);
    expect(await submitRun(handle.db, WS_A, run.id, sub)).toBe(false); // second submit is a no-op
    expect(await markRunStarted(handle.db, WS_A, run.id)).toBe(true);
    expect(await mergeRunConfig(handle.db, WS_A, run.id, { providers: { x: 1 } })).toBe(true);
    expect((await getRun(handle.db, WS_A, run.id))?.config).toMatchObject({
      stages: ['transcription'],
      providers: { x: 1 },
    });
    expect(await setRunStage(handle.db, WS_A, run.id, 'transcription')).toBe(true);
    expect(
      await markRunFailed(handle.db, WS_A, run.id, {
        code: 'PROVIDER_ERROR',
        node: 'transcription',
      }),
    ).toBe(true);
    expect(await markRunFailed(handle.db, WS_A, run.id, { code: 'X', node: null })).toBe(false);
    expect(await markRunStarted(handle.db, WS_A, run.id)).toBe(false); // failed never restarts without a retry
    for (let i = 1; i <= 2; i++) {
      expect(await resetRunForRetry(handle.db, WS_A, run.id, 2)).toBe(true);
      const r = (await getRun(handle.db, WS_A, run.id))!;
      expect(r).toMatchObject({ status: 'queued', retryCount: i, error: null, finishedAt: null });
      await markRunStarted(handle.db, WS_A, run.id);
      await markRunFailed(handle.db, WS_A, run.id, { code: 'PROVIDER_ERROR', node: null });
    }
    expect(await resetRunForRetry(handle.db, WS_A, run.id, 2)).toBe(false); // limit reached
    expect(await resetRunForRetry(handle.db, WS_B, run.id, 9)).toBe(false); // other workspace
  });

  it('cancel: queued is cancelled at once, running becomes cancelling then cancelled', async () => {
    const queued = await runningRun();
    await handle.db.execute(
      sql`UPDATE pipeline_runs SET status = 'queued' WHERE id = ${queued.runId}`,
    );
    expect(await requestRunCancel(handle.db, WS_A, queued.runId)).toBe('cancelled');
    expect(await requestRunCancel(handle.db, WS_A, queued.runId)).toBeNull(); // terminal

    const running = await runningRun();
    expect(await requestRunCancel(handle.db, WS_A, running.runId)).toBe('cancelling');
    expect(await requestRunCancel(handle.db, WS_A, running.runId)).toBe('cancelling'); // idempotent
    const row = (await getRun(handle.db, WS_A, running.runId))!;
    expect(row.cancelRequestedAt).not.toBeNull();
    expect(await markRunCancelled(handle.db, WS_A, running.runId)).toBe(true);
    expect(await markRunCancelled(handle.db, WS_A, running.runId)).toBe(false);
    expect(await requestRunCancel(handle.db, WS_B, running.runId)).toBeNull();
  });

  it('sweeper requeue is a bounded compare-and-set', async () => {
    const { runId } = await runningRun();
    await handle.db.execute(
      sql`UPDATE pipeline_runs SET updated_at = now() - interval '1 hour' WHERE id = ${runId}`,
    );
    const stuck = await listStuckRuns(handle.db, new Date(Date.now() - 60_000), 100);
    const row = stuck.find((r) => r.id === runId)!;
    expect(row).toBeDefined();
    expect(await requeueStuckRun(handle.db, WS_A, runId, 3, row.retryCount + 1)).toBe(false);
    expect(await requeueStuckRun(handle.db, WS_A, runId, 3, row.retryCount)).toBe(true);
    expect(await requeueStuckRun(handle.db, WS_A, runId, 3, row.retryCount)).toBe(false); // counted once
    expect(await getRun(handle.db, WS_A, runId)).toMatchObject({ status: 'queued', retryCount: 1 });
    await handle.db.execute(sql`UPDATE pipeline_runs SET retry_count = 3 WHERE id = ${runId}`);
    expect(await requeueStuckRun(handle.db, WS_A, runId, 3, 3)).toBe(false); // limit reached
  });

  it('stage rows: begin, progress only while running, finish once, latest attempt first', async () => {
    const { runId } = await runningRun();
    await beginStage(handle.db, WS_A, runId, 'transcription', 1);
    expect(
      await updateStageProgress(handle.db, WS_A, runId, 'transcription', 1, { fraction: 0.5 }),
    ).toBe(true);
    expect(await finishStage(handle.db, WS_A, runId, 'transcription', 1, 'completed')).toBe(true);
    expect(
      await finishStage(handle.db, WS_A, runId, 'transcription', 1, 'failed', { code: 'X' }),
    ).toBe(false);
    expect(
      await updateStageProgress(handle.db, WS_A, runId, 'transcription', 1, { fraction: 0.9 }),
    ).toBe(false);
    await beginStage(handle.db, WS_A, runId, 'transcription', 2);
    await beginStage(handle.db, WS_A, runId, 'diarization', 2);
    await finishStage(handle.db, WS_A, runId, 'diarization', 2, 'failed', {
      code: 'PROVIDER_ERROR',
    });
    const rows = await listStageRuns(handle.db, WS_A, runId);
    expect(rows.map((r) => `${r.node}:${r.attempt}:${r.status}`)).toEqual([
      'diarization:2:failed',
      'transcription:2:running',
      'transcription:1:completed',
    ]);
    expect(await listStageRuns(handle.db, WS_B, runId)).toEqual([]);
    await expect(
      handle.db.execute(
        sql`UPDATE pipeline_stage_runs SET status = 'failed', error = NULL WHERE run_id = ${runId}`,
      ),
    ).rejects.toThrow(); // failed requires an error
  });
});

describe('raw outputs: first write wins', () => {
  it('returns the existing row for a repeated window / whole-file output', async () => {
    const { runId } = await runningRun();
    const input = rawInput(runId, { windowIndex: 3, payloadUri: 'local://first' });
    const a = await insertSttRawOutput(handle.db, input);
    const b = await insertSttRawOutput(handle.db, {
      ...input,
      payloadUri: 'local://second',
      sha256: 'e'.repeat(64),
    });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.row.id).toBe(a.row.id);
    expect(b.row.payloadUri).toBe('local://first');
    expect(await getSttRawOutput(handle.db, WS_B, runId, 3)).toBeNull();

    const d = {
      workspaceId: WS_A,
      runId,
      provider: 'fake',
      providerModel: 'm',
      scope: 'whole' as const,
      payloadUri: 'local://d1',
      sha256: SHA,
    };
    const d1 = await insertDiarizationRawOutput(handle.db, d);
    const d2 = await insertDiarizationRawOutput(handle.db, { ...d, payloadUri: 'local://d2' });
    expect(d2.created).toBe(false);
    expect(d2.row.id).toBe(d1.row.id);
    expect((await getWholeDiarizationRawOutput(handle.db, WS_A, runId))?.payloadUri).toBe(
      'local://d1',
    );
    await expect(
      insertDiarizationRawOutput(handle.db, { ...d, scope: 'window', windowStartMs: null }),
    ).rejects.toThrow(); // window scope needs a range
  });
});
