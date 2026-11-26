import { describe, expect, it } from 'vitest';
import {
  failureMessage,
  formatTimestamp,
  runActions,
  scopeText,
  uncertaintiesFor,
  windowNote,
} from './model';
import { completed, failed, run, running, segments } from './fixtures';

describe('formatTimestamp', () => {
  it.each([
    [0, '00:00'],
    [999, '00:00'],
    [65_400, '01:05'],
    [3_599_999, '59:59'],
    [3_725_000, '1:02:05'],
  ])('%i ms -> %s', (ms, text) => expect(formatTimestamp(ms)).toBe(text));
});

describe('runActions', () => {
  it('allows start only without a submitted run', () => {
    expect(runActions(null).start).toBe(true);
    expect(runActions(run()).start).toBe(true);
    expect(runActions(running(0.1)).start).toBe(false);
    expect(runActions(completed()).start).toBe(false);
  });
  it('bounds retry by retryCount < maxRetries', () => {
    expect(runActions(failed({ retryCount: 2 })).retry).toBe(true);
    expect(runActions(failed({ retryCount: 3 })).retry).toBe(false);
  });
  it('does not offer retry for a created run cancelled before start (ADR-0025)', () => {
    expect(runActions(run({ status: 'cancelled', preprocessingId: null })).retry).toBe(false);
  });
  it('does not offer cancel once requested', () => {
    expect(runActions(running(0.1)).cancel).toBe(true);
    expect(runActions({ ...running(0.1), cancelRequested: true }).cancel).toBe(false);
  });
});

describe('scope and window text', () => {
  it('states the scope', () => {
    expect(scopeText(null)).toMatch(/transcription and speaker diarization only/);
    expect(scopeText(run({ scope: ['transcription'] }))).toBe(
      'This run covers transcription only.',
    );
  });
  it('has no note without a window', () => expect(windowNote(null)).toBeNull());
});

describe('uncertaintiesFor', () => {
  const seg = segments[0]!;
  it('matches by segment id, else by overlap', () => {
    const base = { id: 'u', kind: 'overlapping_speech' as const, score: null };
    const byId = { ...base, segmentId: seg.id, startMs: 0, endMs: 1 };
    const byTime = { ...base, segmentId: null, startMs: seg.startMs + 1, endMs: seg.endMs + 50 };
    const other = { ...base, segmentId: 'other', startMs: seg.startMs, endMs: seg.endMs };
    expect(uncertaintiesFor(seg, [byId, byTime, other])).toEqual([byId, byTime]);
  });
});

describe('failureMessage', () => {
  it('explains audio-service failures instead of reporting an unknown reason', () => {
    expect(failureMessage('AUDIO_UNAVAILABLE')).toBe(
      'The audio service could not be reached. Retry once it is available again.',
    );
    expect(failureMessage('AUDIO_TIMEOUT')).toBe(
      'A transcription window took longer than its processing deadline.',
    );
    expect(failureMessage('AUDIO_RESOURCE_EXHAUSTED')).toBe(
      'The audio service ran out of memory or CPU time on this recording.',
    );
  });

  it('names an unlisted audio-service code rather than hiding it', () => {
    expect(failureMessage('AUDIO_SOMETHING_NEW')).toBe(
      'The audio service reported an error (SOMETHING_NEW).',
    );
  });

  it('keeps the unknown-reason fallback for other codes', () => {
    expect(failureMessage('NOT_A_CODE')).toBe('The run failed for an unknown reason.');
    expect(failureMessage(null)).toBe('The run failed for an unknown reason.');
  });
});
