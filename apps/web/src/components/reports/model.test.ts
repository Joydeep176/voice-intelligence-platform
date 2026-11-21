import { describe, expect, it } from 'vitest';
import { recording, run } from '@/test/mock-api';
import { reportAvailability, visibleReports } from './model';

describe('reportAvailability', () => {
  it('is never available and gives the reason for no run', () => {
    expect(reportAvailability(recording({ latestRun: null }))).toEqual({
      available: false,
      label: 'Not generated',
      reason: 'No analysis run',
    });
  });

  it('explains a created (unsubmitted) run', () => {
    const a = reportAvailability(recording({ latestRun: run({ status: 'created' }) }));
    expect(a).toMatchObject({ available: false, label: 'Not generated' });
    expect(a.reason).toBe('Run not submitted · pipeline not connected');
  });

  it.each(['queued', 'running', 'completed', 'failed'] as const)(
    'stays unavailable for run status %s',
    (status) => {
      const a = reportAvailability(recording({ latestRun: run({ status }) }));
      expect(a.available).toBe(false);
      expect(a.reason).toBe('Report service not available yet');
    },
  );
});

describe('visibleReports', () => {
  const a = recording({
    id: 'a',
    originalFilename: 'Alpha.wav',
    createdAt: '2026-11-01T00:00:00.000Z',
  });
  const b = recording({
    id: 'b',
    originalFilename: 'beta.wav',
    createdAt: '2026-11-03T00:00:00.000Z',
  });
  const c = recording({
    id: 'c',
    originalFilename: 'Gamma.wav',
    createdAt: '2026-11-02T00:00:00.000Z',
  });
  const ids = (xs: { id: string }[]) => xs.map((x) => x.id);

  it('sorts newest, oldest and by name', () => {
    expect(ids(visibleReports([a, b, c], '', 'newest'))).toEqual(['b', 'c', 'a']);
    expect(ids(visibleReports([a, b, c], '', 'oldest'))).toEqual(['a', 'c', 'b']);
    expect(ids(visibleReports([a, b, c], '', 'name'))).toEqual(['a', 'b', 'c']);
  });

  it('filters case-insensitively on trimmed filename', () => {
    expect(ids(visibleReports([a, b, c], '  GAMMA ', 'newest'))).toEqual(['c']);
    expect(visibleReports([a, b, c], 'zzz', 'newest')).toEqual([]);
  });

  it('treats unparseable dates as oldest rather than throwing', () => {
    const bad = recording({ id: 'x', createdAt: 'not-a-date' });
    expect(ids(visibleReports([bad, a], '', 'newest'))).toEqual(['a', 'x']);
  });
});
