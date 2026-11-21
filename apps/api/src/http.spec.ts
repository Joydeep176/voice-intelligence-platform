import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ApiError, type HealthResponse } from '@vip/contracts';
import request from 'supertest';
import { WorkspaceAccessGuard } from './auth/workspace-access.guard';
import { configureApp } from './bootstrap';
import { APP_CONFIG, loadConfig } from './config/app-config';
import { HealthController } from './health/health.controller';
import { HealthService } from './health/health.service';
import { PlaybackService } from './playback/playback.service';
import { RecordingsController } from './recordings/recordings.controller';
import { RecordingsService } from './recordings/recordings.service';

/**
 * HTTP-layer tests with the real bootstrap (prefix, filters, body limits, CORS, guard) and
 * mocked services. No database, Redis or audio service is needed.
 */
const WS = '00000000-0000-4000-8000-000000000001';
const config = loadConfig({
  NODE_ENV: 'test',
  AUTH_MODE: 'dev',
  DEV_WORKSPACE_ID: WS,
  DATABASE_URL: 'postgres://u:p@127.0.0.1:1/x',
  REDIS_URL: 'redis://127.0.0.1:1',
  AUDIO_SERVICE_URL: 'http://127.0.0.1:1',
  LOG_LEVEL: 'fatal',
  MEDIA_URL_SIGNING_SECRET: 'test-only-media-url-signing-secret-000000000000',
});

const healthy: HealthResponse = {
  status: 'degraded',
  service: 'api',
  version: '0.1.0',
  environment: 'test',
  time: new Date().toISOString(),
  dependencies: [
    { name: 'postgres', status: 'up', latencyMs: 1, reason: null },
    { name: 'redis', status: 'up', latencyMs: 1, reason: null },
    { name: 'audio-service', status: 'down', latencyMs: null, reason: 'UNREACHABLE' },
  ],
};

describe('HTTP layer', () => {
  let app: NestExpressApplication;
  const recordings = { create: jest.fn(), list: jest.fn(), get: jest.fn() };
  const playback = { issue: jest.fn() };
  const health = { full: jest.fn(), readiness: jest.fn() };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController, RecordingsController],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: HealthService, useValue: health },
        { provide: RecordingsService, useValue: recordings },
        { provide: PlaybackService, useValue: playback },
        WorkspaceAccessGuard,
      ],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({
      bodyParser: false,
      logger: false,
    });
    configureApp(app, config);
    await app.init();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => jest.resetAllMocks());

  it('rejects non-loopback Host headers on every route in dev auth mode (SEC-01)', async () => {
    health.readiness.mockResolvedValue('ok');
    for (const path of [
      '/api/v1/health/live',
      '/api/v1/health/ready',
      '/api/v1/health',
      `/api/v1/workspaces/${WS}/recordings`,
      '/api/v1/media/recordings/some.token',
      '/api/v1/nope',
    ]) {
      const res = await request(app.getHttpServer()).get(path).set('Host', 'evil.example');
      expect(res.status).toBe(403);
      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body).toMatchObject({ status: 403, code: 'HOST_NOT_ALLOWED' });
      expect(JSON.stringify(res.body)).not.toContain('evil');
      expect(ApiError.safeParse(res.body).success).toBe(true);
    }
    expect(recordings.list).not.toHaveBeenCalled();
    await request(app.getHttpServer())
      .get('/api/v1/health/live')
      .set('Host', 'localhost:5173')
      .expect(200, { status: 'ok' });
    await request(app.getHttpServer())
      .get('/api/v1/health/live')
      .set('Host', '[::1]:4173')
      .expect(200);
  });

  it('serves health under /api/v1 with dependency status', async () => {
    health.full.mockResolvedValue(healthy);
    const res = await request(app.getHttpServer()).get('/api/v1/health').expect(200);
    expect(res.body.dependencies).toHaveLength(3);
    expect(JSON.stringify(res.body)).not.toMatch(/postgres:\/\/|redis:\/\//);
  });

  it('returns 503 when a required dependency is down', async () => {
    health.full.mockResolvedValue({ ...healthy, status: 'down' });
    await request(app.getHttpServer()).get('/api/v1/health').expect(503);
    health.readiness.mockResolvedValue('down');
    await request(app.getHttpServer()).get('/api/v1/health/ready').expect(503);
  });

  it('answers liveness without touching dependencies', async () => {
    await request(app.getHttpServer()).get('/api/v1/health/live').expect(200, { status: 'ok' });
    expect(health.full).not.toHaveBeenCalled();
  });

  it('renders unknown routes as problem details', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/nope').expect(404);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body).toMatchObject({ status: 404, code: 'NOT_FOUND' });
    expect(res.body.requestId).toEqual(expect.any(String));
  });

  it('hides other workspaces behind 404 (SEC-2)', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/workspaces/00000000-0000-4000-8000-0000000000ff/recordings')
      .expect(404);
    await request(app.getHttpServer()).get('/api/v1/workspaces/not-a-uuid/recordings').expect(404);
    expect(recordings.list).not.toHaveBeenCalled();
  });

  it('issues a playback URL with no-store, validated against the contract', async () => {
    const issued = {
      url: '/api/v1/media/recordings/abc.def',
      expiresAt: '2026-11-20T10:05:00.000Z',
    };
    playback.issue.mockResolvedValue(issued);
    const id = '6f1c1f9e-6a3e-4c55-9a4e-2f1f2d0f7b10';
    const res = await request(app.getHttpServer())
      .get(`/api/v1/workspaces/${WS}/recordings/${id}/audio`)
      .expect(200);
    expect(res.body).toEqual(issued);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(playback.issue).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'dev-local' }),
      WS,
      id,
    );
    await request(app.getHttpServer())
      .get(`/api/v1/workspaces/${WS}/recordings/not-a-uuid/audio`)
      .expect(404);
    await request(app.getHttpServer())
      .get('/api/v1/workspaces/00000000-0000-4000-8000-0000000000ff/recordings/' + id + '/audio')
      .expect(404);
    expect(playback.issue).toHaveBeenCalledTimes(1);
  });

  it('requires consent before anything else (SEC-1)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/workspaces/${WS}/recordings`)
      .send({ filename: 'a.wav', mimeType: 'audio/wav', sizeBytes: 10 })
      .expect(422);
    expect(res.body.code).toBe('CONSENT_REQUIRED');
    expect(recordings.create).not.toHaveBeenCalled();
  });

  it('validates the create body against the contract', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/workspaces/${WS}/recordings`)
      .send({
        filename: '../x.wav',
        mimeType: 'video/mp4',
        sizeBytes: -1,
        consent: { statementVersion: 'v', attested: true },
      })
      .expect(422);
    expect(res.body.code).toBe('VALIDATION_FAILED');
    expect(res.body.errors.map((e: { path: string }) => e.path).sort()).toEqual([
      'filename',
      'mimeType',
      'sizeBytes',
    ]);
    expect(JSON.stringify(res.body)).not.toContain('../x.wav');
  });

  it('rejects malformed and oversized JSON safely', async () => {
    const malformed = await request(app.getHttpServer())
      .post(`/api/v1/workspaces/${WS}/recordings`)
      .set('content-type', 'application/json')
      .send('{"filename": ')
      .expect(400);
    expect(malformed.body.code).toBe('MALFORMED_REQUEST');
    const big = await request(app.getHttpServer())
      .post(`/api/v1/workspaces/${WS}/recordings`)
      .set('content-type', 'application/json')
      .send(JSON.stringify({ filename: 'x'.repeat(70_000) }))
      .expect(413);
    expect(big.body.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('rejects non-octet-stream upload parts with 415', async () => {
    const res = await request(app.getHttpServer())
      .put(
        `/api/v1/workspaces/${WS}/recordings/6f1c1f9e-6a3e-4c55-9a4e-2f1f2d0f7b10/upload/parts/1`,
      )
      .set('content-type', 'application/json')
      .send('{}')
      .expect(415);
    expect(res.body.code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  it('allows only configured CORS origins', async () => {
    const allowed = await request(app.getHttpServer())
      .get('/api/v1/health/live')
      .set('origin', 'http://localhost:5173');
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    const denied = await request(app.getHttpServer())
      .get('/api/v1/health/live')
      .set('origin', 'http://evil.test');
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('keeps a safe incoming request id and replaces unsafe ones', async () => {
    const kept = await request(app.getHttpServer())
      .get('/api/v1/health/live')
      .set('x-request-id', 'abc-123-def');
    expect(kept.headers['x-request-id']).toBe('abc-123-def');
    const replaced = await request(app.getHttpServer())
      .get('/api/v1/health/live')
      .set('x-request-id', '<script>');
    expect(replaced.headers['x-request-id']).not.toBe('<script>');
  });
});
