import { loadRunSettings } from './run-settings';

describe('loadRunSettings', () => {
  it('applies the interim bounded defaults', () => {
    expect(loadRunSettings({})).toEqual({
      maxRetries: 3,
      attempts: 3,
      backoffMs: 5000,
      audioQuality: { attempts: 3, backoffMs: 5000, maxAttempts: 5 },
    });
  });
  it('reads overrides and rejects out-of-range values by variable name', () => {
    expect(loadRunSettings({ RUN_MAX_RETRIES: '5', QUEUE_RUN_ATTEMPTS: '2' })).toMatchObject({
      maxRetries: 5,
      attempts: 2,
    });
    expect(() => loadRunSettings({ RUN_MAX_RETRIES: '99' })).toThrow('RUN_MAX_RETRIES');
    expect(() => loadRunSettings({ QUEUE_RUN_ATTEMPTS: '0' })).toThrow('QUEUE_RUN_ATTEMPTS');
    expect(() => loadRunSettings({ AUDIO_QUALITY_MAX_ATTEMPTS: '0' })).toThrow(
      'AUDIO_QUALITY_MAX_ATTEMPTS',
    );
  });
});
