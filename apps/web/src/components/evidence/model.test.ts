import { describe, expect, it } from 'vitest';
import { recording, run } from '@/test/mock-api';
import { evidenceAvailability } from './model';

describe('evidenceAvailability', () => {
  it('is unavailable with no run', () => {
    expect(evidenceAvailability(recording({ latestRun: null }))).toEqual({
      available: false,
      label: 'Not available',
      reason: 'No analysis run',
    });
  });

  it('explains a created run', () => {
    expect(evidenceAvailability(recording({ latestRun: run({ status: 'created' }) })).reason).toBe(
      'Run not submitted · research and fact validation not connected',
    );
  });

  it.each(['queued', 'running', 'completed', 'failed'] as const)(
    'is never available for run status %s',
    (status) => {
      const a = evidenceAvailability(recording({ latestRun: run({ status }) }));
      expect(a.available).toBe(false);
      expect(a.reason).toBe('Evidence service not available yet');
    },
  );
});
