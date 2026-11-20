import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import {
  DEV_WORKSPACE_ID,
  createDb,
  runMigrations,
  seedDevelopment,
  sql,
  workspaces,
} from '@vip/db';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { type AppConfig, loadConfig } from '../../src/config/app-config';

export const OTHER_WORKSPACE_ID = '00000000-0000-4000-8000-0000000000aa';

function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL is not set (see .env.example).');
  if (!new URL(url).pathname.endsWith('_test'))
    throw new Error('Test database name must end in _test');
  return url;
}

/** Resets the test database (all migrations from scratch) and seeds two workspaces. */
export async function resetDatabase(): Promise<void> {
  const handle = createDb(testDatabaseUrl(), { maxConnections: 1 });
  try {
    await handle.db.execute(sql`DROP SCHEMA IF EXISTS drizzle CASCADE`);
    await handle.db.execute(sql`DROP SCHEMA IF EXISTS public CASCADE`);
    await handle.db.execute(sql`CREATE SCHEMA public`);
    await runMigrations(handle.db);
    await seedDevelopment(handle.db);
    await handle.db
      .insert(workspaces)
      .values({ id: OTHER_WORKSPACE_ID, name: 'Other workspace (test)' });
  } finally {
    await handle.close();
  }
}

export interface TestApp {
  app: NestExpressApplication;
  config: AppConfig;
  storageRoot: string;
  close(): Promise<void>;
}

export async function createTestApp(overrides: Record<string, string> = {}): Promise<TestApp> {
  const storageRoot = await mkdtemp(join(tmpdir(), 'vip-api-int-'));
  const redis = new URL(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379');
  redis.pathname = '/15';
  const config = loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'fatal',
    AUTH_MODE: 'dev',
    DEV_WORKSPACE_ID,
    DATABASE_URL: testDatabaseUrl(),
    REDIS_URL: redis.toString(),
    STORAGE_LOCAL_ROOT: storageRoot,
    UPLOAD_PART_SIZE_BYTES: '4096',
    UPLOAD_MAX_BYTES: String(1024 * 1024),
    AUDIO_SERVICE_URL: process.env.AUDIO_SERVICE_URL ?? 'http://127.0.0.1:8001',
    AUDIO_SERVICE_TIMEOUT_MS: '1000',
    ...overrides,
  });
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule.forRoot(config)],
  }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({
    bodyParser: false,
    logger: false,
  });
  configureApp(app, config);
  await app.init();
  return {
    app,
    config,
    storageRoot,
    close: async () => {
      await app.close();
      await rm(storageRoot, { recursive: true, force: true });
    },
  };
}
