import { afterEach, describe, expect, it, vi } from 'vitest';
import { json, problem, WS } from '@/test/mock-api';
import { issuePlaybackUrl } from './playback-url';

const ID = '22222222-2222-4222-8222-222222222222';
const signal = () => new AbortController().signal;
const stub = (res: Response | Error) => {
  const f = vi.fn(async () => {
    if (res instanceof Error) throw res;
    return res;
  });
  vi.stubGlobal('fetch', f);
  return f;
};

afterEach(() => vi.unstubAllGlobals());

describe('issuePlaybackUrl', () => {
  it('returns the signed url and requests the workspace-scoped audio endpoint', async () => {
    const f = stub(
      json(200, { url: '/api/v1/media/recordings/t.sig', expiresAt: '2026-11-21T10:05:00.000Z' }),
    );
    expect(await issuePlaybackUrl(ID, signal())).toEqual({
      ok: true,
      url: '/api/v1/media/recordings/t.sig',
    });
    expect(f.mock.calls[0]).toBeDefined();
    const call = f.mock.calls[0] as unknown as [string];
    expect(call[0]).toBe(`/api/v1/workspaces/${WS}/recordings/${ID}/audio`);
  });

  it('maps 409 to not-playable', async () => {
    stub(problem(409, 'CONFLICT'));
    expect(await issuePlaybackUrl(ID, signal())).toEqual({ ok: false, reason: 'not-playable' });
  });

  it.each([404, 500, 503])('maps %i to unavailable', async (status) => {
    stub(problem(status, 'NOT_FOUND'));
    expect(await issuePlaybackUrl(ID, signal())).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('rejects a url that is not the same-origin media path', async () => {
    stub(json(200, { url: 'https://evil.example/x', expiresAt: '2026-11-21T10:05:00.000Z' }));
    expect(await issuePlaybackUrl(ID, signal())).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('treats malformed bodies, network errors and aborts as unavailable without throwing', async () => {
    stub(new Response('not json', { status: 200 }));
    expect(await issuePlaybackUrl(ID, signal())).toEqual({ ok: false, reason: 'unavailable' });
    stub(new TypeError('network'));
    expect(await issuePlaybackUrl(ID, signal())).toEqual({ ok: false, reason: 'unavailable' });
    stub(new DOMException('aborted', 'AbortError'));
    expect(await issuePlaybackUrl(ID, signal())).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('never surfaces server text', async () => {
    stub(problem(500, 'INTERNAL', 'secret internal detail'));
    expect(JSON.stringify(await issuePlaybackUrl(ID, signal()))).not.toContain('secret');
  });
});
