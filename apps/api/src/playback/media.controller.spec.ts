import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import request from 'supertest';
import { configureApp } from '../bootstrap';
import { loadConfig } from '../config/app-config';
import { LocalStorageService } from '../storage/local-storage.service';
import { StorageService } from '../storage/storage.service';
import { MediaController } from './media.controller';
import { PlaybackService } from './playback.service';

const config = loadConfig({
  NODE_ENV: 'test',
  AUTH_MODE: 'dev',
  DEV_WORKSPACE_ID: '00000000-0000-4000-8000-000000000001',
  DATABASE_URL: 'postgres://u:p@127.0.0.1:1/x',
  REDIS_URL: 'redis://127.0.0.1:1',
  AUDIO_SERVICE_URL: 'http://127.0.0.1:1',
  MEDIA_URL_SIGNING_SECRET: 'test-only-media-url-signing-secret-000000000000',
});
const DATA = Buffer.from('0123456789'.repeat(10)); // 100 synthetic bytes
const KEY = 'recordings/ws/rec/original';
const TOKEN = 'SECRET-TOKEN-VALUE.SECRET-SIGNATURE';

describe('MediaController', () => {
  let app: NestExpressApplication;
  let root: string;
  let storage: LocalStorageService;
  const playback = { resolve: jest.fn() };
  let logged: unknown[];

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'vip-media-'));
    storage = new LocalStorageService(root);
    await storage.writeObject(KEY, Readable.from([DATA]), { maxBytes: 1000 });
    const moduleRef = await Test.createTestingModule({
      controllers: [MediaController],
      providers: [
        { provide: PlaybackService, useValue: playback },
        { provide: StorageService, useValue: storage },
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
    await rm(root, { recursive: true, force: true });
  });
  beforeEach(() => {
    jest.resetAllMocks();
    logged = [];
    jest.spyOn(Logger.prototype, 'log').mockImplementation((m) => void logged.push(m));
    jest.spyOn(Logger.prototype, 'warn').mockImplementation((m) => void logged.push(m));
    playback.resolve.mockResolvedValue({
      recording: { id: 'rec', mimeType: 'audio/wav' },
      key: KEY,
    });
  });

  const get = () => request(app.getHttpServer()).get(`/api/v1/media/recordings/${TOKEN}`);

  it('serves the whole object with security headers', async () => {
    const res = await get().buffer(true).expect(200);
    expect(res.body).toEqual(DATA);
    expect(res.headers).toMatchObject({
      'content-type': 'audio/wav',
      'content-length': '100',
      'accept-ranges': 'bytes',
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, no-store',
      'content-disposition': 'inline',
      'cross-origin-resource-policy': 'same-origin',
      'referrer-policy': 'no-referrer',
    });
    expect(playback.resolve).toHaveBeenCalledWith(TOKEN, expect.any(Function));
  });

  it('serves a single range as 206', async () => {
    const res = await get().set('Range', 'bytes=10-19').buffer(true).expect(206);
    expect(res.body).toEqual(DATA.subarray(10, 20));
    expect(res.headers['content-range']).toBe('bytes 10-19/100');
    expect(res.headers['content-length']).toBe('10');
  });

  it('serves suffix ranges and ignores multi-range requests', async () => {
    const suffix = await get().set('Range', 'bytes=-5').buffer(true).expect(206);
    expect(suffix.body).toEqual(DATA.subarray(95));
    const multi = await get().set('Range', 'bytes=0-1,5-6').buffer(true).expect(200);
    expect(multi.body).toEqual(DATA);
  });

  it('answers an unsatisfiable range with 416 and an empty body', async () => {
    const res = await get().set('Range', 'bytes=500-').expect(416);
    expect(res.headers['content-range']).toBe('bytes */100');
    expect(res.headers['content-length']).toBe('0');
    expect(Buffer.from(res.body as Buffer).length).toBe(0);
  });

  it('returns one uniform 404 for an unresolved token and a missing object', async () => {
    playback.resolve.mockResolvedValue(null);
    const a = await get().expect(404);
    playback.resolve.mockResolvedValue({
      recording: { id: 'rec', mimeType: 'audio/wav' },
      key: 'recordings/ws/rec/other',
    });
    const b = await get().expect(404);
    const strip = ({ requestId: _r, ...rest }: Record<string, unknown>) => rest;
    expect(strip(a.body)).toEqual(strip(b.body));
    expect(a.headers['content-type']).toContain('application/problem+json');
    expect(a.headers['content-range']).toBeUndefined();
    expect(JSON.stringify(a.body)).not.toContain('SECRET');
  });

  it('never logs the token, only the route pattern', async () => {
    await get().expect(200);
    playback.resolve.mockResolvedValue(null);
    await get().expect(404);
    const text = JSON.stringify(logged);
    expect(text).not.toContain('SECRET-TOKEN');
    expect(text).not.toContain(root);
    expect(text).toContain('/api/v1/media/recordings/:token');
  });
});
