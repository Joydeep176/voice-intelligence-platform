import {
  DEV_CONSENT_STATEMENT_VERSION,
  ProcessingStatus,
  RecordingMetadata,
  RecordingUploadResponse,
} from '@vip/contracts';
import { DEV_WORKSPACE_ID, auditEvents, createDb, eq, recordings } from '@vip/db';
import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import request from 'supertest';
import { syntheticWav } from './support/synthetic-wav';
import { OTHER_WORKSPACE_ID, type TestApp, createTestApp, resetDatabase } from './support/test-app';

const base = `/api/v1/workspaces/${DEV_WORKSPACE_ID}`;
const consent = { statementVersion: DEV_CONSENT_STATEMENT_VERSION, attested: true };
const wav = syntheticWav(400); // 12 844 bytes → 4 parts of 4096 bytes

function listFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name));
}

describe('recording upload workflow (integration: Postgres + Redis + local storage)', () => {
  let t: TestApp;
  const http = () => request(t.app.getHttpServer());

  const create = async (bytes: Buffer, mimeType = 'audio/wav', filename = 'synthetic-tone.wav') => {
    const res = await http()
      .post(`${base}/recordings`)
      .send({ filename, mimeType, sizeBytes: bytes.length, consent })
      .expect(201);
    return RecordingUploadResponse.parse(res.body);
  };
  const putPart = (id: string, n: number, body: Buffer) =>
    http()
      .put(`${base}/recordings/${id}/upload/parts/${n}`)
      .set('content-type', 'application/octet-stream')
      .send(body);
  const uploadAll = async (id: string, bytes: Buffer, partSize: number) => {
    for (let n = 1, off = 0; off < bytes.length; n++, off += partSize) {
      await putPart(id, n, bytes.subarray(off, off + partSize)).expect(200);
    }
  };

  beforeAll(async () => {
    await resetDatabase();
    t = await createTestApp();
  });
  afterAll(async () => {
    await t?.close();
  });

  it('uploads a synthetic recording end to end and creates a not-yet-processed run', async () => {
    const created = await create(wav);
    expect(created.recording.status).toBe('uploading');
    expect(created.recording.latestRun).toBeNull();
    expect(created.upload).toMatchObject({
      strategy: 'local_chunked',
      partSize: 4096,
      totalParts: 4,
      partsReceived: [],
    });
    expect(JSON.stringify(created)).not.toMatch(/local:\/\/|storage|\.local-storage/i);

    await uploadAll(created.recording.id, wav, 4096);
    const done = await http()
      .post(`${base}/recordings/${created.recording.id}/upload/complete`)
      .expect(200);
    const recording = RecordingMetadata.parse(done.body);
    expect(recording.status).toBe('uploaded');
    expect(recording.sha256).toBe(createHash('sha256').update(wav).digest('hex'));
    expect(recording.durationMs).toBeNull(); // not determined until the audio service probes it
    expect(recording.latestRun).toMatchObject({
      status: 'created',
      currentStage: null,
      startedAt: null,
      completedAt: null,
      error: null,
    });

    // The original is stored unmodified (FR-1.4) and the parts are cleaned up.
    const files = listFiles(t.storageRoot);
    expect(files).toHaveLength(1);
    expect(await readFile(files[0]!)).toEqual(wav);

    // Retrieval: metadata, processing status and listing.
    const fetched = RecordingMetadata.parse(
      (await http().get(`${base}/recordings/${recording.id}`).expect(200)).body,
    );
    expect(fetched.originalFilename).toBe('synthetic-tone.wav');
    const run = ProcessingStatus.parse(
      (await http().get(`${base}/runs/${fetched.latestRun!.id}`).expect(200)).body,
    );
    expect(run.status).toBe('created');
    const list = await http().get(`${base}/recordings`).expect(200);
    expect(list.body.items.map((r: { id: string }) => r.id)).toContain(recording.id);

    // Completing again is idempotent and creates no second run.
    const again = RecordingMetadata.parse(
      (await http().post(`${base}/recordings/${recording.id}/upload/complete`).expect(200)).body,
    );
    expect(again.latestRun?.id).toBe(run.id);
  });

  it('writes content-free audit events for the upload', async () => {
    const created = await create(syntheticWav(50), 'audio/wav', 'private-name.wav');
    await uploadAll(created.recording.id, syntheticWav(50), 4096);
    await http().post(`${base}/recordings/${created.recording.id}/upload/complete`).expect(200);
    const handle = createDb(process.env.TEST_DATABASE_URL!, { maxConnections: 1 });
    try {
      const rows = await handle.db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.resourceId, created.recording.id));
      expect(rows.map((r) => r.action).sort()).toEqual([
        'recording.upload_completed',
        'recording.upload_started',
      ]);
      expect(JSON.stringify(rows)).not.toContain('private-name');
    } finally {
      await handle.close();
    }
  });

  it('supports resuming: the session lists received parts', async () => {
    const created = await create(wav);
    await putPart(created.recording.id, 2, wav.subarray(4096, 8192)).expect(200);
    const session = await http()
      .get(`${base}/recordings/${created.recording.id}/upload`)
      .expect(200);
    expect(session.body.partsReceived).toEqual([{ partNumber: 2, sizeBytes: 4096 }]);
    const incomplete = await http()
      .post(`${base}/recordings/${created.recording.id}/upload/complete`)
      .expect(409);
    expect(incomplete.body.code).toBe('UPLOAD_INCOMPLETE');
  });

  it('rejects parts with the wrong size or number and stores nothing for them', async () => {
    const created = await create(wav);
    const short = await putPart(created.recording.id, 1, Buffer.alloc(100)).expect(422);
    expect(short.body.code).toBe('UPLOAD_PART_INVALID');
    const long = await putPart(created.recording.id, 4, Buffer.alloc(9000)).expect(422);
    expect(long.body.code).toBe('UPLOAD_PART_INVALID');
    await putPart(created.recording.id, 5, Buffer.alloc(10)).expect(422);
    await putPart(created.recording.id, 0, Buffer.alloc(10)).expect(422);
    const session = await http()
      .get(`${base}/recordings/${created.recording.id}/upload`)
      .expect(200);
    expect(session.body.partsReceived).toEqual([]);
    expect(listFiles(t.storageRoot).filter((f) => f.includes(created.recording.id))).toEqual([]);
  });

  it('rejects content that does not match the declared type and cleans up', async () => {
    const fake = Buffer.alloc(5000, 0x41);
    const created = await create(fake, 'audio/wav', 'not-audio.wav');
    await uploadAll(created.recording.id, fake, 4096);
    const res = await http()
      .post(`${base}/recordings/${created.recording.id}/upload/complete`)
      .expect(422);
    expect(res.body.code).toBe('MEDIA_SIGNATURE_MISMATCH');
    const rec = RecordingMetadata.parse(
      (await http().get(`${base}/recordings/${created.recording.id}`).expect(200)).body,
    );
    expect(rec.status).toBe('invalid');
    expect(rec.latestRun).toBeNull();
    expect(listFiles(t.storageRoot).filter((f) => f.includes(created.recording.id))).toEqual([]);
  });

  it('enforces the configured maximum size and MIME allow-list', async () => {
    const tooBig = await http()
      .post(`${base}/recordings`)
      .send({ filename: 'big.wav', mimeType: 'audio/wav', sizeBytes: 2 * 1024 * 1024, consent })
      .expect(413);
    expect(tooBig.body.code).toBe('PAYLOAD_TOO_LARGE');
    await http()
      .post(`${base}/recordings`)
      .send({ filename: 'x.exe', mimeType: 'application/x-msdownload', sizeBytes: 10, consent })
      .expect(422);
  });

  it('isolates workspaces: other workspaces and their resources are 404 (SEC-2)', async () => {
    const created = await create(syntheticWav(50));
    // Recording exists, but under another workspace prefix it must not be visible.
    await http()
      .get(`/api/v1/workspaces/${OTHER_WORKSPACE_ID}/recordings/${created.recording.id}`)
      .expect(404);
    await http().get(`/api/v1/workspaces/${OTHER_WORKSPACE_ID}/recordings`).expect(404);
    // A recording that belongs to another workspace is invisible from ours.
    const handle = createDb(process.env.TEST_DATABASE_URL!, { maxConnections: 1 });
    try {
      const [foreign] = await handle.db
        .insert(recordings)
        .values({
          workspaceId: OTHER_WORKSPACE_ID,
          originalFilename: 'f.wav',
          storageUri: 'local://foreign/x',
          mimeType: 'audio/wav',
          sizeBytes: 1,
        })
        .returning();
      await http().get(`${base}/recordings/${foreign!.id}`).expect(404);
      await http().get(`${base}/recordings/${foreign!.id}/upload`).expect(404);
      await http().post(`${base}/recordings/${foreign!.id}/upload/complete`).expect(404);
    } finally {
      await handle.close();
    }
    await http().get(`${base}/runs/6f1c1f9e-6a3e-4c55-9a4e-2f1f2d0f7b10`).expect(404);
  });

  it('paginates the recording list with a cursor', async () => {
    const page1 = await http().get(`${base}/recordings?limit=2`).expect(200);
    expect(page1.body.items).toHaveLength(2);
    expect(page1.body.nextCursor).toEqual(expect.any(String));
    const page2 = await http()
      .get(`${base}/recordings?limit=2&cursor=${page1.body.nextCursor}`)
      .expect(200);
    const ids1 = page1.body.items.map((r: { id: string }) => r.id);
    expect(page2.body.items.every((r: { id: string }) => !ids1.includes(r.id))).toBe(true);
    await http().get(`${base}/recordings?cursor=garbage`).expect(422);
  });

  it('reports Postgres and Redis as up in /health', async () => {
    const res = await http().get('/api/v1/health');
    const byName = Object.fromEntries(
      res.body.dependencies.map((d: { name: string; status: string }) => [d.name, d.status]),
    );
    expect(byName).toMatchObject({ postgres: 'up', redis: 'up' });
    expect(['ok', 'degraded']).toContain(res.body.status);
    await http().get('/api/v1/health/ready').expect(200);
  });
});
