import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  audioDiagnosticFlags,
  audioDiagnostics,
  audioMeasurementSets,
  audioMeasurements,
  completeMeasurementSet,
  completePreprocessing,
  getLatestDiagnostics,
  getLatestMeasurementSet,
  getMeasurements,
  getSetMeasurement,
  insertCreatedRun,
  insertDiagnostics,
  listDiagnosticFlags,
  markRunning,
  markSetFailed,
  markSetRunning,
  maxDiagnosticsAttempt,
  pipelineStageRuns,
  recordings,
  resetSetForRetry,
  upsertMeasurementSet,
  upsertPreprocessing,
  workspaces,
  type DbHandle,
  type DiagnosticsInput,
} from '../src/index.js';
import { resetTestDatabase } from './test-db.js';

const WS_A = '00000000-0000-4000-8000-0000000000a3';
const WS_B = '00000000-0000-4000-8000-0000000000b3';
const HASH = 'a'.repeat(64);
const MHASH = 'd'.repeat(64);

let handle: DbHandle;

async function setup(workspaceId = WS_A) {
  const recordingId = crypto.randomUUID();
  await handle.db.insert(recordings).values({
    id: recordingId,
    workspaceId,
    originalFilename: 'synthetic.wav',
    storageUri: `local://recordings/${workspaceId}/${recordingId}/original`,
    mimeType: 'audio/wav',
    sizeBytes: 1000,
    status: 'valid',
  });
  const { preprocessing } = await upsertPreprocessing(handle.db, {
    workspaceId,
    recordingId,
    configHash: HASH,
    config: { v: 1 },
    toolVersions: { ffmpeg: 'x' },
  });
  await markRunning(handle.db, workspaceId, preprocessing.id);
  await completePreprocessing(handle.db, {
    workspaceId,
    id: preprocessing.id,
    normalizedUri: 'local://normalized/x',
    canonicalSha256: 'c'.repeat(64),
    canonicalDurationMs: 2000,
    timeline: { schemaVersion: 1 },
    segments: [],
    measurements: [
      { source: 'canonical', schemaVersion: '1', measurements: { a: 1 }, serviceVersion: 's1' },
      {
        source: 'original_decoded',
        schemaVersion: '1',
        measurements: { a: 2 },
        serviceVersion: 's1',
      },
    ],
  });
  const run = await insertCreatedRun(handle.db, workspaceId, recordingId);
  return { recordingId, preprocessingId: preprocessing.id, runId: run.id };
}

async function succeededSet(workspaceId: string, preprocessingId: string) {
  const { set } = await upsertMeasurementSet(handle.db, {
    workspaceId,
    preprocessingId,
    configHash: MHASH,
    config: { blockMs: 1000 },
  });
  expect(await markSetRunning(handle.db, workspaceId, set.id)).toBe(true);
  expect(
    await completeMeasurementSet(handle.db, {
      workspaceId,
      id: set.id,
      seriesUri: 'local://derived/speech-series.json',
      toolVersions: { silero: 'v6.2.3' },
      measurements: { snrDb: 12.5 },
      schemaVersion: '2',
      serviceVersion: 's1',
    }),
  ).toBe(true);
  return set;
}

const diag = (
  ids: { runId: string; preprocessingId: string },
  overrides: Partial<DiagnosticsInput> = {},
): DiagnosticsInput => ({
  workspaceId: WS_A,
  runId: ids.runId,
  preprocessingId: ids.preprocessingId,
  measurementSetId: null,
  attempt: 1,
  ruleVersion: 'a1-rules-0.1-provisional',
  provisional: true,
  overall: 'acceptable_with_warnings',
  confidence: 'medium',
  suitability: { transcription: { value: 'limited', reasons: ['noise'] } },
  notAssessed: [{ dimension: 'reverberation', reason: 'not_supported_v1' }],
  recommendations: [{ code: 'reduce_background_noise' }],
  affectedRatio: 0.3,
  tier1: 'not_requested',
  ruleConfig: { version: 'a1-rules-0.1-provisional' },
  flags: [
    {
      kind: 'noise',
      severity: 'medium',
      startMs: 0,
      endMs: 1000,
      basis: 'estimate',
      ruleId: 'noise.tier0',
      measurementRefs: [{ quantity: 'noiseFloorDbfs' }],
    },
    {
      kind: 'clipping',
      severity: 'low',
      startMs: null,
      endMs: null,
      basis: 'measured',
      ruleId: 'clipping.ratio',
      measurementRefs: [],
    },
  ],
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

describe('migration 0005_audio_quality', () => {
  it('appends the hand-written immutability triggers', () => {
    const file = fileURLToPath(new URL('../drizzle/0005_audio_quality.sql', import.meta.url));
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('"audio_diagnostics_immutable"');
    expect(text).toContain('"audio_diagnostic_flags_immutable"');
  });

  it('accepts audio_quality as a stage node and keeps rejecting unknown nodes', async () => {
    const { runId } = await setup();
    await handle.db
      .insert(pipelineStageRuns)
      .values({ workspaceId: WS_A, runId, node: 'audio_quality', attempt: 1 });
    await expect(
      handle.db.execute(
        sql`INSERT INTO pipeline_stage_runs (workspace_id, run_id, node, attempt) VALUES (${WS_A}, ${runId}, 'reporting', 1)`,
      ),
    ).rejects.toThrow();
  });
});

describe('measurement sets (ADR-0045)', () => {
  it('upserts one set per (preprocessing, config hash) and completes atomically with its record', async () => {
    const { preprocessingId } = await setup();
    const first = await upsertMeasurementSet(handle.db, {
      workspaceId: WS_A,
      preprocessingId,
      configHash: MHASH,
      config: {},
    });
    const again = await upsertMeasurementSet(handle.db, {
      workspaceId: WS_A,
      preprocessingId,
      configHash: MHASH,
      config: {},
    });
    expect(first.created).toBe(true);
    expect(again.created).toBe(false);
    expect(again.set.id).toBe(first.set.id);
    expect(await getSetMeasurement(handle.db, WS_A, first.set.id)).toBeNull();
    await markSetRunning(handle.db, WS_A, first.set.id);
    await completeMeasurementSet(handle.db, {
      workspaceId: WS_A,
      id: first.set.id,
      seriesUri: 'local://s',
      toolVersions: {},
      measurements: { snrDb: 1 },
      schemaVersion: '2',
      serviceVersion: 's1',
    });
    const record = await getSetMeasurement(handle.db, WS_A, first.set.id);
    expect(record?.schemaVersion).toBe('2');
    expect((await getLatestMeasurementSet(handle.db, WS_A, preprocessingId))?.status).toBe(
      'succeeded',
    );
  });

  it('does not let Tier 1 records leak into the accepted processing snapshot reader', async () => {
    const { preprocessingId } = await setup();
    await succeededSet(WS_A, preprocessingId);
    const whole = await getMeasurements(handle.db, WS_A, preprocessingId, { segmentId: null });
    expect(whole.map((m) => m.source).sort()).toEqual(['canonical', 'original_decoded']);
    expect(whole.every((m) => m.measurementSetId === null)).toBe(true);
  });

  it('keeps Tier 0 uniqueness and allows one Tier 1 record per set and source', async () => {
    const { preprocessingId } = await setup();
    const set = await succeededSet(WS_A, preprocessingId);
    await expect(
      handle.db.insert(audioMeasurements).values({
        workspaceId: WS_A,
        preprocessingId,
        source: 'canonical',
        schemaVersion: '1',
        measurements: {},
        serviceVersion: 's1',
      }),
    ).rejects.toThrow();
    await expect(
      handle.db.insert(audioMeasurements).values({
        workspaceId: WS_A,
        preprocessingId,
        measurementSetId: set.id,
        source: 'canonical',
        schemaVersion: '2',
        measurements: {},
        serviceVersion: 's1',
      }),
    ).rejects.toThrow();
  });

  it('records a failure with a code, allows a reset, and refuses a set of another preprocessing', async () => {
    const a = await setup();
    const b = await setup();
    const { set } = await upsertMeasurementSet(handle.db, {
      workspaceId: WS_A,
      preprocessingId: a.preprocessingId,
      configHash: MHASH,
      config: {},
    });
    await markSetFailed(handle.db, WS_A, set.id, { code: 'TIMEOUT', retryable: true });
    expect(await resetSetForRetry(handle.db, WS_A, set.id)).toBe(true);
    // composite FK: a measurement of preprocessing B cannot point at A's set
    await expect(
      handle.db.insert(audioMeasurements).values({
        workspaceId: WS_A,
        preprocessingId: b.preprocessingId,
        measurementSetId: set.id,
        source: 'original_decoded',
        schemaVersion: '2',
        measurements: {},
        serviceVersion: 's1',
      }),
    ).rejects.toThrow();
  });
});

describe('diagnostics (A1)', () => {
  it('inserts diagnostics with flags idempotently per attempt and reads them back', async () => {
    const ids = await setup();
    const first = await insertDiagnostics(handle.db, diag(ids));
    const replay = await insertDiagnostics(handle.db, diag(ids));
    expect(first.created).toBe(true);
    expect(replay.created).toBe(false);
    expect(replay.diagnostics.id).toBe(first.diagnostics.id);
    const flags = await listDiagnosticFlags(handle.db, WS_A, first.diagnostics.id);
    expect(flags).toHaveLength(2);
    expect(await maxDiagnosticsAttempt(handle.db, WS_A, ids.runId)).toBe(1);
    const ranged = await listDiagnosticFlags(handle.db, WS_A, first.diagnostics.id, {
      fromMs: 1500,
      toMs: 2000,
    });
    expect(ranged.map((f) => f.kind)).toEqual(['clipping']); // whole-recording flag always overlaps
  });

  it('is immutable: updates of diagnostics and flags are rejected (23001)', async () => {
    const ids = await setup();
    const { diagnostics } = await insertDiagnostics(handle.db, diag(ids));
    const causeOf = async (p: PromiseLike<unknown>) => {
      try {
        await p;
      } catch (e) {
        return (e as { cause?: { code?: string; message?: string } }).cause;
      }
      return undefined;
    };
    const d = await causeOf(
      handle.db
        .update(audioDiagnostics)
        .set({ overall: 'good' })
        .where(eq(audioDiagnostics.id, diagnostics.id)),
    );
    expect(d?.code).toBe('23001');
    expect(d?.message).toMatch(/immutable/);
    const f = await causeOf(
      handle.db
        .update(audioDiagnosticFlags)
        .set({ severity: 'high' })
        .where(eq(audioDiagnosticFlags.diagnosticsId, diagnostics.id)),
    );
    expect(f?.code).toBe('23001');
  });

  it('pins to a preprocessing version and returns the newest attempt', async () => {
    const ids = await setup();
    await insertDiagnostics(handle.db, diag(ids));
    await insertDiagnostics(handle.db, diag(ids, { attempt: 2, overall: 'poor' }));
    expect((await getLatestDiagnostics(handle.db, WS_A, ids.runId))?.overall).toBe('poor');
    expect(await getLatestDiagnostics(handle.db, WS_A, ids.runId, crypto.randomUUID())).toBeNull();
  });

  it('rejects invalid classes, ranges and cross-workspace references', async () => {
    const ids = await setup();
    await expect(
      insertDiagnostics(handle.db, diag(ids, { overall: 'degraded' as never })),
    ).rejects.toThrow();
    await expect(
      insertDiagnostics(
        handle.db,
        diag(ids, {
          attempt: 3,
          flags: [
            {
              kind: 'noise',
              severity: 'low',
              startMs: 500,
              endMs: 100,
              basis: 'estimate',
              ruleId: 'x',
              measurementRefs: [],
            },
          ],
        }),
      ),
    ).rejects.toThrow();
    await expect(
      insertDiagnostics(handle.db, diag(ids, { workspaceId: WS_B, attempt: 4 })),
    ).rejects.toThrow();
    expect(await getLatestDiagnostics(handle.db, WS_B, ids.runId)).toBeNull();
  });

  it('is deleted with its recording (SEC-6): sets, Tier 1 records, diagnostics and flags', async () => {
    const ids = await setup();
    const set = await succeededSet(WS_A, ids.preprocessingId);
    await insertDiagnostics(handle.db, diag(ids, { measurementSetId: set.id }));
    await handle.db.delete(recordings).where(eq(recordings.id, ids.recordingId));
    const count = async (table: typeof audioDiagnostics | typeof audioMeasurementSets) =>
      (await handle.db.select().from(table).where(eq(table.workspaceId, WS_A))).filter(
        (r) => 'preprocessingId' in r && r.preprocessingId === ids.preprocessingId,
      ).length;
    expect(await count(audioDiagnostics)).toBe(0);
    expect(await count(audioMeasurementSets)).toBe(0);
    expect(
      await handle.db
        .select()
        .from(audioMeasurements)
        .where(eq(audioMeasurements.preprocessingId, ids.preprocessingId)),
    ).toHaveLength(0);
  });
});
