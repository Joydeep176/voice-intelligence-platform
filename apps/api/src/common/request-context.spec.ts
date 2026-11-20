import 'reflect-metadata';
import { Controller, Get, HttpCode, Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { configureApp } from '../bootstrap';
import { loadConfig } from '../config/app-config';

@Controller('media/recordings')
class TokenRouteController {
  @Get(':token')
  @HttpCode(204)
  get(): void {}
}

describe('requestContext', () => {
  let app: NestExpressApplication;
  afterEach(async () => {
    jest.restoreAllMocks();
    await app.close();
  });

  it('logs the route pattern, never the raw URL or a capability token', async () => {
    const lines: unknown[] = [];
    jest.spyOn(Logger.prototype, 'log').mockImplementation((m) => void lines.push(m));
    const moduleRef = await Test.createTestingModule({
      controllers: [TokenRouteController],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({
      bodyParser: false,
      logger: false,
    });
    configureApp(
      app,
      loadConfig({
        AUTH_MODE: 'dev',
        DEV_WORKSPACE_ID: '00000000-0000-4000-8000-000000000001',
        DATABASE_URL: 'postgres://u:p@127.0.0.1:1/x',
        REDIS_URL: 'redis://127.0.0.1:1',
        AUDIO_SERVICE_URL: 'http://127.0.0.1:1',
        MEDIA_URL_SIGNING_SECRET: 'test-only-media-url-signing-secret-000000000000',
      }),
    );
    await app.init();

    await request(app.getHttpServer())
      .get('/api/v1/media/recordings/SECRET-TOKEN.SIGNATURE?x=y')
      .expect(204);

    const requests = lines.filter(
      (l) => typeof l === 'object' && (l as { msg?: string }).msg === 'http_request',
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      msg: 'http_request',
      method: 'GET',
      route: '/api/v1/media/recordings/:token',
      status: 204,
    });
    expect(JSON.stringify(lines)).not.toContain('SECRET-TOKEN');
  });
});
