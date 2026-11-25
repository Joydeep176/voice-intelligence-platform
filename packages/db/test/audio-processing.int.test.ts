import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  audioMeasurements,
  audioPreprocessings,
  audioSegments,
  completePreprocessing,
  getLatestPreprocessingForRecording,
  getMeasurements,
  getPreprocessing,
  incrementAttempt,
  listSegments,
  markCancelled,
  markFailed,
  markRecordingValidating,
  markRunning,
  recordings,
  requestCancel,
  resetRecordingToUploaded,
  resetForRetry,
  runMigrations,
  setRecordingProbe,
  updateProgress,
  upsertPreprocessing,
  workspaces,
  type CompletePreprocessingInput,
  type DbHandle,
} from '../src/index.js';
import { resetTestDatabase, resetTestDatabaseUpTo } from './test-db.js';

const WS_A = '00000000-0000-4000-8000-0000000000a1';
const WS_B = '00000000-0000-4000-8000-0000000000b2';
const HASH = 'a'.repeat(64);
const HASH2 = 'b'.repeat(64);
const SHA = 'c'.repeat(64);

let handle: DbHandle;

async function addRecording(workspaceId = WS_A, status: 'uploaded' | 'valid' = 'valid') {
  const id = crypto.randomUUID();
  await handle.db.insert(recordings).values({
    id,
    workspaceId,
    originalFilename: 'synthetic.wav',
    storageUri: `local://recordings/${workspaceId}/${id}/original`,
    mimeType: 'audio/wav',
    sizeBytes: 1000,
    status,
  });
  return id;
}

async function newPre(recordingId: string, workspaceId = WS_A, configHash = HASH) {
  const { preprocessing } = await upsertPreprocessing(handle.db, {
    workspaceId,
    recordingId,
    configHash,
    config: { v: 1 },
    toolVersions: { ffmpeg: 'x' },
  });
  return preprocessing;
}

const completion = (
  workspaceId: string,
  id: string,
  overrides: Partial<CompletePreprocessingInput> = {},
): CompletePreprocessingInput => ({
  workspaceId,
  id,
  normalizedUri: 'local://normalized/x',
  canonicalSha256: SHA,
  canonicalDurationMs: 2000,
  timeline: { schemaVersion: 1 },
  segments: [
    { index: 0, startMs: 0, endMs: 1000, speechMs: 800 },
    { index: 1, startMs: 1000, endMs: 2000, speechMs: 500, containsSyntheticGap: true },
  ],
  measurements: [
    {
      source: 'canonical',
      schemaVersion: '1',
      measurements: { rms: 0.1 },
      serviceVersion: 's1',
    },
    {
      segmentIndex: 0,
      source: 'canonical',
      schemaVersion: '1',
      measurements: { rms: 0.2 },
      serviceVersion: 's1',
    },
  ],
  ...overrides,
});

async function succeeded(recordingId: string, workspaceId = WS_A, configHash = HASH) {
  const pre = await newPre(recordingId, workspaceId, configHash);
  await markRunning(handle.db, workspaceId, pre.id);
  expect(await completePreprocessing(handle.db, completion(workspaceId, pre.id))).toBe(true);
  return pre;
}

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

describe('migration 0002_audio_processing', () => {
  it('leaves rows written under the 0001 schema byte-identical', async () => {
    const old = await resetTestDatabaseUpTo(2);
    try {
      await old.db.execute(sql`INSERT INTO workspaces (id, name) VALUES (${WS_A}, 'A')`);
      const recId = crypto.randomUUID();
      await old.db
        .execute(sql`INSERT INTO recordings (id, workspace_id, original_filename, storage_uri, mime_type, size_bytes, status)
        VALUES (${recId}, ${WS_A}, 'old.wav', ${'local://old/' + recId}, 'audio/wav', 10, 'valid')`);
      await old.db.execute(
        sql`INSERT INTO pipeline_runs (workspace_id, recording_id) VALUES (${WS_A}, ${recId})`,
      );
      // media_probe is the one new column, so recordings are compared without it.
      const snapshot = async () => ({
        workspaces: (await old.db.execute(sql`SELECT w::text AS t FROM workspaces w`)).rows,
        recordings: (
          await old.db.execute(
            sql`SELECT (to_jsonb(r) - 'media_probe')::text AS t FROM recordings r`,
          )
        ).rows,
        // 0003 adds three nullable columns to pipeline_runs; they are compared separately in transcription.int.test.ts.
        runs: (
          await old.db.execute(
            sql`SELECT (to_jsonb(p) - 'preprocessing_id' - 'config' - 'cancel_requested_at')::text AS t FROM pipeline_runs p`,
          )
        ).rows,
      });
      const before = await snapshot();
      expect(before.recordings).toHaveLength(1);
      await runMigrations(old.db);
      expect(await snapshot()).toEqual(before);
      const probe = await old.db.execute(sql`SELECT media_probe FROM recordings`);
      expect(probe.rows[0]).toEqual({ media_probe: null });
    } finally {
      await old.close();
    }
    handle = await resetTestDatabase();
    await handle.db.insert(workspaces).values([
      { id: WS_A, name: 'A' },
      { id: WS_B, name: 'B' },
    ]);
  });

  it('rejects a non-object media_probe', async () => {
    const id = await addRecording();
    await expect(
      handle.db.execute(sql`UPDATE recordings SET media_probe = '[1]'::jsonb WHERE id = ${id}`),
    ).rejects.toThrow();
  });
});

describe('workspace-composite integrity', () => {
  it('rejects a preprocessing whose workspace differs from its recording', async () => {
    const rec = await addRecording(WS_A);
    await expect(newPre(rec, WS_B)).rejects.toThrow();
  });

  it('rejects a segment of preprocessing X carrying another workspace', async () => {
    const pre = await newPre(await addRecording(WS_A));
    await expect(
      handle.db.insert(audioSegments).values({
        workspaceId: WS_B,
        preprocessingId: pre.id,
        index: 0,
        startMs: 0,
        endMs: 10,
        speechMs: 5,
      }),
    ).rejects.toThrow();
  });

  it('rejects a measurement whose segment belongs to another preprocessing', async () => {
    const recId = await addRecording();
    const first = await succeeded(recId, WS_A, HASH);
    const second = await newPre(recId, WS_A, HASH2);
    const [seg] = await handle.db
      .select()
      .from(audioSegments)
      .where(eq(audioSegments.preprocessingId, first.id))
      .limit(1);
    await expect(
      handle.db.insert(audioMeasurements).values({
        workspaceId: WS_A,
        preprocessingId: second.id,
        segmentId: seg!.id,
        source: 'canonical',
        schemaVersion: '1',
        measurements: {},
        serviceVersion: 's',
      }),
    ).rejects.toThrow();
  });

  it('rejects an unknown measurement source and non-object measurements', async () => {
    const pre = await newPre(await addRecording());
    const base = {
      workspaceId: WS_A,
      preprocessingId: pre.id,
      schemaVersion: '1',
      serviceVersion: 's',
    };
    await expect(
      handle.db
        .insert(audioMeasurements)
        .values({ ...base, source: 'bogus' as 'canonical', measurements: {} }),
    ).rejects.toThrow();
    await expect(
      handle.db.insert(audioMeasurements).values({
        ...base,
        source: 'canonical',
        measurements: [] as unknown as Record<string, unknown>,
      }),
    ).rejects.toThrow();
  });

  it('allows one whole-recording measurement per source only', async () => {
    const pre = await succeeded(await addRecording());
    await expect(
      handle.db.insert(audioMeasurements).values({
        workspaceId: WS_A,
        preprocessingId: pre.id,
        source: 'canonical',
        schemaVersion: '1',
        measurements: {},
        serviceVersion: 's',
      }),
    ).rejects.toThrow();
  });
});

describe('lifecycle CHECKs', () => {
  it('rejects succeeded without canonical fields, and failed without error', async () => {
    const pre = await newPre(await addRecording());
    await expect(
      handle.db
        .update(audioPreprocessings)
        .set({ status: 'succeeded' })
        .where(eq(audioPreprocessings.id, pre.id)),
    ).rejects.toThrow();
    await expect(
      handle.db
        .update(audioPreprocessings)
        .set({ status: 'failed' })
        .where(eq(audioPreprocessings.id, pre.id)),
    ).rejects.toThrow();
  });

  it('rejects bad hashes, negative attempt and finished before started', async () => {
    const rec = await addRecording();
    await expect(newPre(rec, WS_A, 'NOT-HEX')).rejects.toThrow();
    const pre = await newPre(rec);
    await expect(
      handle.db
        .update(audioPreprocessings)
        .set({ attempt: -1 })
        .where(eq(audioPreprocessings.id, pre.id)),
    ).rejects.toThrow();
    await expect(
      handle.db
        .update(audioPreprocessings)
        .set({ startedAt: new Date(2000), finishedAt: new Date(1000) })
        .where(eq(audioPreprocessings.id, pre.id)),
    ).rejects.toThrow();
  });

  it('rejects invalid segment ranges and speech longer than the segment', async () => {
    const pre = await newPre(await addRecording());
    const base = { workspaceId: WS_A, preprocessingId: pre.id, index: 0 };
    await expect(
      handle.db.insert(audioSegments).values({ ...base, startMs: 10, endMs: 10, speechMs: 0 }),
    ).rejects.toThrow();
    await expect(
      handle.db.insert(audioSegments).values({ ...base, startMs: 0, endMs: 10, speechMs: 11 }),
    ).rejects.toThrow();
  });
});

describe('repository: upsert and reads', () => {
  it('upserts idempotently and never resets a succeeded row', async () => {
    const rec = await addRecording();
    const first = await upsertPreprocessing(handle.db, {
      workspaceId: WS_A,
      recordingId: rec,
      configHash: HASH,
      config: { v: 1 },
      toolVersions: {},
    });
    expect(first.created).toBe(true);
    expect(first.preprocessing.status).toBe('queued');
    await markRunning(handle.db, WS_A, first.preprocessing.id);
    await completePreprocessing(handle.db, completion(WS_A, first.preprocessing.id));
    const again = await upsertPreprocessing(handle.db, {
      workspaceId: WS_A,
      recordingId: rec,
      configHash: HASH,
      config: { v: 2 },
      toolVersions: {},
    });
    expect(again.created).toBe(false);
    expect(again.preprocessing.id).toBe(first.preprocessing.id);
    expect(again.preprocessing.status).toBe('succeeded');
    expect(again.preprocessing.config).toEqual({ v: 1 });
  });

  it('upsert for another workspace fails instead of exposing the row', async () => {
    const rec = await addRecording(WS_A);
    await newPre(rec, WS_A);
    await expect(newPre(rec, WS_B)).rejects.toThrow();
  });

  it('returns the latest version for a recording', async () => {
    const rec = await addRecording();
    await newPre(rec, WS_A, HASH);
    const later = await newPre(rec, WS_A, HASH2);
    const latest = await getLatestPreprocessingForRecording(handle.db, WS_A, rec);
    expect(latest?.id).toBe(later.id);
  });

  it('filters every read by workspace', async () => {
    const rec = await addRecording(WS_A);
    const pre = await succeeded(rec);
    expect(await getPreprocessing(handle.db, WS_B, pre.id)).toBeNull();
    expect(await getLatestPreprocessingForRecording(handle.db, WS_B, rec)).toBeNull();
    expect(await listSegments(handle.db, WS_B, pre.id, { limit: 10 })).toEqual([]);
    expect(await getMeasurements(handle.db, WS_B, pre.id)).toEqual([]);
    expect(await listSegments(handle.db, WS_A, pre.id, { limit: 10 })).toHaveLength(2);
    expect(await getMeasurements(handle.db, WS_A, pre.id)).toHaveLength(2);
    expect(await getMeasurements(handle.db, WS_A, pre.id, { segmentId: null })).toHaveLength(1);
  });

  it('lists segments by time range and limit', async () => {
    const pre = await succeeded(await addRecording());
    const late = await listSegments(handle.db, WS_A, pre.id, { fromMs: 1000, limit: 10 });
    expect(late.map((s) => s.index)).toEqual([1]);
    const early = await listSegments(handle.db, WS_A, pre.id, { toMs: 1000, limit: 10 });
    expect(early.map((s) => s.index)).toEqual([0]);
    expect(await listSegments(handle.db, WS_A, pre.id, { limit: 1 })).toHaveLength(1);
  });
});

describe('repository: guarded transitions', () => {
  it('moves forward through the lifecycle and records progress only while running', async () => {
    const pre = await newPre(await addRecording());
    expect(await updateProgress(handle.db, WS_A, pre.id, { pct: 1 })).toBe(false);
    expect(await markRunning(handle.db, WS_A, pre.id)).toBe(true);
    expect(await markRunning(handle.db, WS_A, pre.id)).toBe(false);
    expect(await updateProgress(handle.db, WS_A, pre.id, { pct: 50 })).toBe(true);
    expect(await incrementAttempt(handle.db, WS_A, pre.id)).toBe(true);
    const row = await getPreprocessing(handle.db, WS_A, pre.id);
    expect(row?.progress).toEqual({ pct: 50 });
    expect(row?.attempt).toBe(1);
    expect(row?.startedAt).not.toBeNull();
  });

  it('incrementAttempt with an expected value applies once for concurrent observers', async () => {
    const pre = await newPre(await addRecording());
    expect(await markRunning(handle.db, WS_A, pre.id)).toBe(true);
    const results = await Promise.all([
      incrementAttempt(handle.db, WS_A, pre.id, 0),
      incrementAttempt(handle.db, WS_A, pre.id, 0),
      incrementAttempt(handle.db, WS_A, pre.id, 0),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await getPreprocessing(handle.db, WS_A, pre.id))?.attempt).toBe(1);
    expect(await incrementAttempt(handle.db, WS_A, pre.id, 0)).toBe(false); // stale expectation
    expect(await incrementAttempt(handle.db, WS_A, pre.id, 1)).toBe(true);
    expect((await getPreprocessing(handle.db, WS_A, pre.id))?.attempt).toBe(2);
  });

  it('cannot go succeeded -> running/failed/cancelled, and cancel after success is a no-op', async () => {
    const pre = await succeeded(await addRecording());
    expect(await markRunning(handle.db, WS_A, pre.id)).toBe(false);
    expect(await markFailed(handle.db, WS_A, pre.id, { code: 'X', retryable: false })).toBe(false);
    expect(await markCancelled(handle.db, WS_A, pre.id)).toBe(false);
    expect(await requestCancel(handle.db, WS_A, pre.id)).toBe(false);
    expect(await incrementAttempt(handle.db, WS_A, pre.id)).toBe(false);
    const row = await getPreprocessing(handle.db, WS_A, pre.id);
    expect(row?.status).toBe('succeeded');
    expect(row?.cancelRequestedAt).toBeNull();
  });

  it('inserts segments and measurements once when completion is attempted twice', async () => {
    const pre = await newPre(await addRecording());
    await markRunning(handle.db, WS_A, pre.id);
    const results = await Promise.all([
      completePreprocessing(handle.db, completion(WS_A, pre.id)),
      completePreprocessing(handle.db, completion(WS_A, pre.id)),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await listSegments(handle.db, WS_A, pre.id, { limit: 10 })).toHaveLength(2);
    expect(await getMeasurements(handle.db, WS_A, pre.id)).toHaveLength(2);
  });

  it('inserts nothing when completion does not apply (queued, cancelled, wrong workspace)', async () => {
    const queued = await newPre(await addRecording());
    expect(await completePreprocessing(handle.db, completion(WS_A, queued.id))).toBe(false);
    expect(await listSegments(handle.db, WS_A, queued.id, { limit: 10 })).toEqual([]);

    const running = await newPre(await addRecording());
    await markRunning(handle.db, WS_A, running.id);
    expect(await completePreprocessing(handle.db, completion(WS_B, running.id))).toBe(false);
    await markCancelled(handle.db, WS_A, running.id);
    expect(await completePreprocessing(handle.db, completion(WS_A, running.id))).toBe(false);
    expect(await listSegments(handle.db, WS_A, running.id, { limit: 10 })).toEqual([]);
  });

  it('rolls the whole completion back when a segment/measurement insert fails', async () => {
    const pre = await newPre(await addRecording());
    await markRunning(handle.db, WS_A, pre.id);
    await expect(
      completePreprocessing(
        handle.db,
        completion(WS_A, pre.id, {
          measurements: [
            {
              segmentIndex: 99,
              source: 'canonical',
              schemaVersion: '1',
              measurements: {},
              serviceVersion: 's',
            },
          ],
        }),
      ),
    ).rejects.toThrow();
    const row = await getPreprocessing(handle.db, WS_A, pre.id);
    expect(row?.status).toBe('running');
    expect(await listSegments(handle.db, WS_A, pre.id, { limit: 10 })).toEqual([]);
  });

  it('fails, resets for retry and keeps the attempt count', async () => {
    const pre = await newPre(await addRecording());
    await markRunning(handle.db, WS_A, pre.id);
    await incrementAttempt(handle.db, WS_A, pre.id);
    await requestCancel(handle.db, WS_A, pre.id);
    expect(await markFailed(handle.db, WS_A, pre.id, { code: 'DECODE', retryable: true })).toBe(
      true,
    );
    const failed = await getPreprocessing(handle.db, WS_A, pre.id);
    expect(failed?.error).toEqual({ code: 'DECODE', retryable: true });
    expect(await resetForRetry(handle.db, WS_B, pre.id)).toBe(false);
    expect(await resetForRetry(handle.db, WS_A, pre.id)).toBe(true);
    const reset = await getPreprocessing(handle.db, WS_A, pre.id);
    expect(reset).toMatchObject({
      status: 'queued',
      error: null,
      cancelRequestedAt: null,
      progress: null,
      attempt: 1,
      startedAt: null,
      finishedAt: null,
    });
    expect(await resetForRetry(handle.db, WS_A, pre.id)).toBe(false);
  });
});

describe('immutability and cascade', () => {
  it('blocks UPDATE of segments and measurements', async () => {
    const pre = await succeeded(await addRecording());
    // Drizzle wraps driver errors; the Postgres message and code are on `cause`.
    const causeOf = async (p: Promise<unknown>) => {
      try {
        await p;
      } catch (e) {
        return (e as { cause?: { code?: string; message?: string } }).cause;
      }
      return undefined;
    };
    const seg = await causeOf(
      Promise.resolve(
        handle.db
          .update(audioSegments)
          .set({ speechMs: 1 })
          .where(eq(audioSegments.preprocessingId, pre.id)),
      ),
    );
    expect(seg?.code).toBe('23001');
    expect(seg?.message).toMatch(/immutable/);
    const meas = await causeOf(
      Promise.resolve(
        handle.db
          .update(audioMeasurements)
          .set({ measurements: { x: 1 } })
          .where(eq(audioMeasurements.preprocessingId, pre.id)),
      ),
    );
    expect(meas?.code).toBe('23001');
    const [row] = await listSegments(handle.db, WS_A, pre.id, { limit: 1 });
    expect(row?.speechMs).toBe(800);
  });

  it('cascades a recording delete to preprocessings, segments and measurements', async () => {
    const rec = await addRecording();
    const pre = await succeeded(rec);
    await handle.db.delete(recordings).where(eq(recordings.id, rec));
    expect(await getPreprocessing(handle.db, WS_A, pre.id)).toBeNull();
    const segs = await handle.db
      .select()
      .from(audioSegments)
      .where(eq(audioSegments.preprocessingId, pre.id));
    const meas = await handle.db
      .select()
      .from(audioMeasurements)
      .where(eq(audioMeasurements.preprocessingId, pre.id));
    expect(segs).toHaveLength(0);
    expect(meas).toHaveLength(0);
  });
});

describe('recording probe transitions', () => {
  it('moves uploaded -> validating -> valid only in order and per workspace', async () => {
    const rec = await addRecording(WS_A, 'uploaded');
    const probe = { durationMs: 1234, sampleRate: 16000, channels: 1, mediaProbe: { c: 'wav' } };
    expect(await setRecordingProbe(handle.db, WS_A, rec, { status: 'valid', ...probe })).toBe(
      false,
    );
    expect(await markRecordingValidating(handle.db, WS_B, rec)).toBe(false);
    expect(await markRecordingValidating(handle.db, WS_A, rec)).toBe(true);
    expect(await markRecordingValidating(handle.db, WS_A, rec)).toBe(false);
    expect(await setRecordingProbe(handle.db, WS_B, rec, { status: 'valid', ...probe })).toBe(
      false,
    );
    expect(await setRecordingProbe(handle.db, WS_A, rec, { status: 'valid', ...probe })).toBe(true);
    const [row] = await handle.db.select().from(recordings).where(eq(recordings.id, rec));
    expect(row).toMatchObject({
      status: 'valid',
      durationMs: 1234,
      sampleRate: 16000,
      channels: 1,
      mediaProbe: { c: 'wav' },
    });
    expect(await markRecordingValidating(handle.db, WS_A, rec)).toBe(false);
  });

  it('records an invalid probe with its error code', async () => {
    const rec = await addRecording(WS_A, 'uploaded');
    await markRecordingValidating(handle.db, WS_A, rec);
    expect(
      await setRecordingProbe(handle.db, WS_A, rec, {
        status: 'invalid',
        validationError: 'MEDIA_UNDECODABLE',
      }),
    ).toBe(true);
    const [row] = await handle.db.select().from(recordings).where(eq(recordings.id, rec));
    expect(row).toMatchObject({ status: 'invalid', validationError: 'MEDIA_UNDECODABLE' });
  });

  it('returns a validating recording to uploaded, only from validating and per workspace', async () => {
    const rec = await addRecording(WS_A, 'uploaded');
    expect(await resetRecordingToUploaded(handle.db, WS_A, rec)).toBe(false);
    await markRecordingValidating(handle.db, WS_A, rec);
    expect(await resetRecordingToUploaded(handle.db, WS_B, rec)).toBe(false);
    expect(await resetRecordingToUploaded(handle.db, WS_A, rec)).toBe(true);
    const [row] = await handle.db.select().from(recordings).where(eq(recordings.id, rec));
    expect(row?.status).toBe('uploaded');
    expect(await markRecordingValidating(handle.db, WS_A, rec)).toBe(true);
  });
});
