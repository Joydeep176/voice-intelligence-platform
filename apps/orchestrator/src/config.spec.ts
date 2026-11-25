import { loadConfig } from './config';

const base = {
  REDIS_URL: 'redis://127.0.0.1:6379',
  DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/db',
  AUDIO_SERVICE_URL: 'http://127.0.0.1:8001/',
};

describe('orchestrator processing config', () => {
  it('applies bounded interim defaults and derives the stuck threshold', () => {
    const c = loadConfig(base);
    expect(c.audioService.url).toBe('http://127.0.0.1:8001');
    expect(c.processing).toMatchObject({
      maxRetries: 3,
      pollIntervalMs: 2000,
      sweepIntervalMs: 60_000,
      concurrency: 1,
    });
    expect(c.processing.stuckAfterMs).toBe(2000 * 10 + 900_000);
  });

  it('has an interim Node backstop for submitted tasks, separate from the sweeper threshold', () => {
    const c = loadConfig(base).processing;
    expect(c).toMatchObject({
      deadlineBaseMs: 120_000,
      deadlineGraceMs: 60_000,
      sweepStaleBaseMs: 900_000,
    });
    const tuned = loadConfig({
      ...base,
      PROCESSING_TASK_DEADLINE_BASE_MS: '5000',
      PROCESSING_TASK_DEADLINE_GRACE_MS: '0',
    }).processing;
    expect(tuned).toMatchObject({ deadlineBaseMs: 5000, deadlineGraceMs: 0 });
    expect(() => loadConfig({ ...base, PROCESSING_TASK_DEADLINE_BASE_MS: '10' })).toThrow(
      'PROCESSING_TASK_DEADLINE_BASE_MS',
    );
  });

  it('treats an empty or missing AUDIO_SERVICE_TOKEN as unset and rejects a short one', () => {
    expect(loadConfig(base).audioService.token).toBeUndefined();
    expect(loadConfig({ ...base, AUDIO_SERVICE_TOKEN: '' }).audioService.token).toBeUndefined();
    expect(() => loadConfig({ ...base, AUDIO_SERVICE_TOKEN: 'short' })).toThrow(
      'AUDIO_SERVICE_TOKEN',
    );
  });

  it('bounds worker concurrency', () => {
    expect(() => loadConfig({ ...base, QUEUE_AUDIO_CONCURRENCY: '99' })).toThrow(
      'QUEUE_AUDIO_CONCURRENCY',
    );
  });

  it('has bounded interim defaults for transcription runs and resolves the storage root', () => {
    const { runs } = loadConfig(base);
    expect(runs).toMatchObject({
      sttProvider: 'fake',
      diarizationProvider: 'fake',
      maxRetries: 3,
      attempts: 3,
      concurrency: 1,
      deadlineMs: 3_600_000,
    });
    expect(runs.storageRoot.startsWith('/')).toBe(true);
    expect(loadConfig({ ...base, STORAGE_LOCAL_ROOT: '/tmp/vip' }).runs.storageRoot).toBe(
      '/tmp/vip',
    );
    expect(() => loadConfig({ ...base, QUEUE_RUN_CONCURRENCY: '9' })).toThrow(
      'QUEUE_RUN_CONCURRENCY',
    );
    expect(() => loadConfig({ ...base, RUN_MAX_RETRIES: '-1' })).toThrow('RUN_MAX_RETRIES');
  });
});
