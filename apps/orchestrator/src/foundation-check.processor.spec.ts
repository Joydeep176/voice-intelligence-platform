import { UnrecoverableError } from 'bullmq';
import { processFoundationCheck } from './foundation-check.processor';
import { loadConfig, workerConnection } from './config';

describe('processFoundationCheck', () => {
  it('acknowledges a valid payload without doing any audio work', () => {
    const now = new Date('2026-11-19T00:00:00.000Z');
    const result = processFoundationCheck(
      { checkId: '6f1c1f9e-6a3e-4c55-9a4e-2f1f2d0f7b10', requestedAt: now.toISOString() },
      () => now,
    );
    expect(result).toEqual({
      checkId: '6f1c1f9e-6a3e-4c55-9a4e-2f1f2d0f7b10',
      processedBy: 'orchestrator',
      processedAt: now.toISOString(),
    });
  });

  it('rejects malformed payloads as unrecoverable (no retries)', () => {
    expect(() => processFoundationCheck({ checkId: 'nope' })).toThrow(UnrecoverableError);
  });
});

const required = {
  DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/db',
  AUDIO_SERVICE_URL: 'http://127.0.0.1:8001',
};

describe('orchestrator config', () => {
  it('requires REDIS_URL and applies bounded defaults', () => {
    expect(() => loadConfig({})).toThrow('REDIS_URL');
    const config = loadConfig({ ...required, REDIS_URL: 'redis://:pw@127.0.0.1:6380/2' });
    expect(config.foundation.concurrency).toBe(2);
    expect(workerConnection(config.redisUrl)).toMatchObject({
      port: 6380,
      db: 2,
      password: 'pw',
      maxRetriesPerRequest: null,
    });
  });
});
