import { describe, expect, it } from 'vitest';
import { recording } from '@/test/mock-api';
import { filterCounts, formatLabel, matchesFilter, visibleRecordings } from './model';

const mk = (id: string, over: Parameters<typeof recording>[0]) => recording({ id, ...over });
const items = [
  mk('a', {
    originalFilename: 'Alpha.wav',
    status: 'uploaded',
    sizeBytes: 100,
    createdAt: '2026-11-03T00:00:00.000Z',
  }),
  mk('b', {
    originalFilename: 'beta.mp3',
    status: 'valid',
    sizeBytes: 300,
    createdAt: '2026-11-02T00:00:00.000Z',
  }),
  mk('c', {
    originalFilename: 'Gamma.wav',
    status: 'uploading',
    sizeBytes: 200,
    createdAt: '2026-11-01T00:00:00.000Z',
  }),
  mk('d', {
    originalFilename: 'delta.wav',
    status: 'validating',
    sizeBytes: 50,
    createdAt: '2026-11-04T00:00:00.000Z',
  }),
  mk('e', {
    originalFilename: 'eps.wav',
    status: 'invalid',
    sizeBytes: 10,
    createdAt: '2026-11-05T00:00:00.000Z',
  }),
];
const ids = (xs: { id: string }[]) => xs.map((x) => x.id);

describe('recording filters', () => {
  it('counts by group', () => {
    expect(filterCounts(items)).toEqual({ all: 5, ready: 2, progress: 2, rejected: 1 });
    expect(filterCounts([])).toEqual({ all: 0, ready: 0, progress: 0, rejected: 0 });
  });

  it('matches status groups', () => {
    expect(matchesFilter(items[0]!, 'ready')).toBe(true);
    expect(matchesFilter(items[0]!, 'rejected')).toBe(false);
    expect(matchesFilter(items[4]!, 'all')).toBe(true);
  });

  it('filters by group and query together', () => {
    expect(ids(visibleRecordings(items, '', 'ready', 'name'))).toEqual(['a', 'b']);
    expect(ids(visibleRecordings(items, ' WAV ', 'ready', 'name'))).toEqual(['a']);
    expect(visibleRecordings(items, 'nothing', 'all', 'newest')).toEqual([]);
  });

  it('sorts', () => {
    expect(ids(visibleRecordings(items, '', 'all', 'newest'))).toEqual(['e', 'd', 'a', 'b', 'c']);
    expect(ids(visibleRecordings(items, '', 'all', 'oldest'))).toEqual(['c', 'b', 'a', 'd', 'e']);
    expect(ids(visibleRecordings(items, '', 'all', 'name'))).toEqual(['a', 'b', 'd', 'e', 'c']);
    expect(ids(visibleRecordings(items, '', 'all', 'largest'))).toEqual(['b', 'c', 'a', 'd', 'e']);
  });

  it('does not mutate its input', () => {
    const copy = [...items];
    visibleRecordings(items, '', 'all', 'name');
    expect(items).toEqual(copy);
  });
});

describe('formatLabel', () => {
  it('maps known types, ignoring parameters and case', () => {
    expect(formatLabel('audio/x-wav')).toBe('WAV');
    expect(formatLabel('Audio/MPEG; charset=x')).toBe('MP3');
    expect(formatLabel('audio/x-m4a')).toBe('M4A');
  });
  it('falls back to the subtype upper-cased', () => {
    expect(formatLabel('audio/opus')).toBe('OPUS');
  });
});
