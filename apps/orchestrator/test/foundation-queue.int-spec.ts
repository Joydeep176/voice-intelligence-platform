import 'reflect-metadata';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { QueueName } from '@vip/contracts';
import { Queue, QueueEvents, UnrecoverableError } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { loadConfig, workerConnection } from '../src/config';
import type { FoundationProcessor } from '../src/foundation-check.worker';
import { processFoundationCheck } from '../src/foundation-check.processor';
import { OrchestratorModule } from '../src/orchestrator.module';

/** Integration tests against real Redis (DB 15, isolated from development data). */
function testRedisUrl(): string {
  const base = process.env.REDIS_URL;
  if (!base) throw new Error('REDIS_URL is not set (see .env.example).');
  const url = new URL(base);
  url.pathname = '/15';
  return url.toString();
}

const redisUrl = testRedisUrl();
const config = loadConfig({
  REDIS_URL: redisUrl,
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://unused:unused@127.0.0.1:5432/vip_test',
  AUDIO_SERVICE_URL: 'http://127.0.0.1:8001',
  LOG_LEVEL: 'fatal',
  SHUTDOWN_TIMEOUT_MS: '5000',
});
const connection = workerConnection(redisUrl);

describe('foundation-check queue (integration)', () => {
  let queue: Queue;
  let events: QueueEvents;
  let app: INestApplicationContext | undefined;

  const start = async (processor: FoundationProcessor) => {
    app = await NestFactory.createApplicationContext(
      OrchestratorModule.forRoot(config, processor),
      { logger: false },
    );
    await app.init();
  };
  const payload = () => ({ checkId: randomUUID(), requestedAt: new Date().toISOString() });

  beforeAll(async () => {
    queue = new Queue(QueueName.FoundationCheck, { connection });
    events = new QueueEvents(QueueName.FoundationCheck, { connection });
    await events.waitUntilReady();
  });
  beforeEach(async () => {
    await queue.obliterate({ force: true });
  });
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });
  afterAll(async () => {
    await events.close();
    await queue.close();
  });

  it('round-trips a job from producer to worker and returns a contract-valid result', async () => {
    await start((data) => processFoundationCheck(data));
    const data = payload();
    const job = await queue.add('check', data, { jobId: data.checkId });
    const result = await job.waitUntilFinished(events, 10_000);
    expect(result).toMatchObject({ checkId: data.checkId, processedBy: 'orchestrator' });
  });

  it('retries retryable failures a bounded number of times, then keeps the failed job', async () => {
    let calls = 0;
    await start(() => {
      calls += 1;
      throw new Error('TRANSIENT');
    });
    const job = await queue.add('check', payload(), {
      attempts: 3,
      backoff: { type: 'fixed', delay: 20 },
    });
    await expect(job.waitUntilFinished(events, 10_000)).rejects.toThrow('TRANSIENT');
    const failed = await queue.getJob(job.id!);
    expect(calls).toBe(3);
    expect(failed?.attemptsMade).toBe(3);
    expect(await failed?.getState()).toBe('failed');
  });

  it('does not retry unrecoverable errors', async () => {
    let calls = 0;
    await start(() => {
      calls += 1;
      throw new UnrecoverableError('INVALID_PAYLOAD');
    });
    const job = await queue.add('check', { bad: true }, { attempts: 3 });
    await expect(job.waitUntilFinished(events, 10_000)).rejects.toThrow('INVALID_PAYLOAD');
    expect(calls).toBe(1);
  });

  it('lets an active job finish during graceful shutdown', async () => {
    let finished = false;
    await start(async (data) => {
      await new Promise((r) => setTimeout(r, 400));
      finished = true;
      return processFoundationCheck(data);
    });
    const job = await queue.add('check', payload());
    await new Promise((r) => setTimeout(r, 100)); // job is now active
    await app!.close();
    app = undefined;
    expect(finished).toBe(true);
    expect(await (await queue.getJob(job.id!))?.getState()).toBe('completed');
  });
});
