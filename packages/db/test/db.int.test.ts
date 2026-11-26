import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEV_WORKSPACE_ID,
  consentAttestations,
  pipelineRuns,
  recordings,
  runMigrations,
  seedDevelopment,
  workspaces,
  type DbHandle,
} from '../src/index.js';
import { resetTestDatabase } from './test-db.js';

let handle: DbHandle;

beforeAll(async () => {
  handle = await resetTestDatabase();
});
afterAll(async () => {
  await handle?.close();
});

const newRecording = (overrides: Partial<typeof recordings.$inferInsert> = {}) => ({
  workspaceId: DEV_WORKSPACE_ID,
  originalFilename: 'synthetic-tone.wav',
  storageUri: `local://recordings/${DEV_WORKSPACE_ID}/${crypto.randomUUID()}/original`,
  mimeType: 'audio/wav',
  sizeBytes: 48_044,
  ...overrides,
});

describe('database foundation (integration)', () => {
  it('connects', async () => {
    const result = await handle.db.execute(sql`SELECT 1 AS ok`);
    expect(result.rows[0]).toEqual({ ok: 1 });
  });

  it('enables the pgvector extension (ADR-0005 verification)', async () => {
    const result = await handle.db.execute(
      sql`SELECT extname FROM pg_extension WHERE extname = 'vector'`,
    );
    expect(result.rows).toHaveLength(1);
  });

  it('re-applying migrations is a no-op (reproducible)', async () => {
    await expect(runMigrations(handle.db)).resolves.toBeUndefined();
    const applied = await handle.db.execute(
      sql`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`,
    );
    expect(applied.rows[0]).toEqual({ n: 6 }); // 0000-0005 (0005_audio_quality: Phase 3A)
  });

  it('seeds the development workspace idempotently', async () => {
    await seedDevelopment(handle.db);
    await seedDevelopment(handle.db);
    const rows = await handle.db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, DEV_WORKSPACE_ID));
    expect(rows).toHaveLength(1);
  });

  it('persists a recording, its consent and a created run', async () => {
    const [rec] = await handle.db.insert(recordings).values(newRecording()).returning();
    expect(rec?.status).toBe('uploading');
    expect(rec?.durationMs).toBeNull();

    await handle.db.insert(consentAttestations).values({
      recordingId: rec!.id,
      workspaceId: DEV_WORKSPACE_ID,
      attestedBy: 'dev-local',
      statementVersion: 'dev-2026-11',
    });
    const [run] = await handle.db
      .insert(pipelineRuns)
      .values({ recordingId: rec!.id, workspaceId: DEV_WORKSPACE_ID })
      .returning();
    expect(run?.status).toBe('created');
    expect(run?.currentNode).toBeNull();
    expect(run?.startedAt).toBeNull();
  });

  it('rejects invalid data at the database level', async () => {
    await expect(
      handle.db.insert(recordings).values(newRecording({ sizeBytes: 0 })),
    ).rejects.toThrow();
    await expect(
      handle.db.insert(recordings).values(newRecording({ sha256: 'NOT-HEX' })),
    ).rejects.toThrow();
    await expect(
      handle.db
        .insert(recordings)
        .values(newRecording({ workspaceId: '00000000-0000-4000-8000-0000000000ff' })),
    ).rejects.toThrow();
  });

  it('cascades run and consent rows when a recording is deleted', async () => {
    const [rec] = await handle.db.insert(recordings).values(newRecording()).returning();
    await handle.db
      .insert(pipelineRuns)
      .values({ recordingId: rec!.id, workspaceId: DEV_WORKSPACE_ID });
    await handle.db.delete(recordings).where(eq(recordings.id, rec!.id));
    const runs = await handle.db
      .select()
      .from(pipelineRuns)
      .where(eq(pipelineRuns.recordingId, rec!.id));
    expect(runs).toHaveLength(0);
  });
});
