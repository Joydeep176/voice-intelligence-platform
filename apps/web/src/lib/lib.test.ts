import { describe, expect, it } from 'vitest';
import { json, mockFetch, recording } from '@/test/mock-api';
import { formatBytes, formatDuration } from './format';
import { matchRoute } from './router';
import { resumeUpload } from './upload';

describe('matchRoute', () => {
  it('matches known routes and rejects malformed IDs', () => {
    expect(matchRoute('/')).toEqual({ name: 'dashboard' });
    expect(matchRoute('/recordings/')).toEqual({ name: 'recordings' });
    expect(matchRoute('/recordings/new')).toEqual({ name: 'upload' });
    expect(matchRoute(`/recordings/${recording().id}`)).toEqual({
      name: 'recording',
      id: recording().id,
    });
    expect(matchRoute('/recordings/../../etc')).toEqual({ name: 'not-found' });
  });
});

describe('format', () => {
  it('formats bytes and durations', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(12_844)).toBe('12.5 KB');
    expect(formatBytes(2 * 1024 ** 3)).toBe('2.0 GB');
    expect(formatDuration(null)).toBe('Not yet determined');
    expect(formatDuration(3_725_000)).toBe('1:02:05');
  });
});

describe('resumeUpload', () => {
  it('sends only the parts the server has not received, using file slices', async () => {
    const sent: { part: number; size: number }[] = [];
    mockFetch(async (method, url, init) => {
      if (method === 'GET' && url.pathname.endsWith('/upload')) {
        return json(200, {
          strategy: 'local_chunked',
          status: 'active',
          partSize: 4,
          totalParts: 3,
          partsReceived: [{ partNumber: 1, sizeBytes: 4 }],
          expiresAt: recording().createdAt,
        });
      }
      if (method === 'PUT') {
        const size = (init?.body as Blob).size;
        sent.push({ part: Number(url.pathname.split('/').pop()), size });
        return json(200, { partNumber: 1, sizeBytes: size });
      }
      if (method === 'POST') return json(200, recording());
      return undefined;
    });
    const progress: number[] = [];
    const file = new File([new Uint8Array(10)], 'x.wav', { type: 'audio/wav' });
    await resumeUpload(file, recording().id, { onProgress: (p) => progress.push(p.uploadedBytes) });
    expect(sent).toEqual([
      { part: 2, size: 4 },
      { part: 3, size: 2 },
    ]);
    expect(progress).toEqual([4, 8, 10]);
  });
});
