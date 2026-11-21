import { ApiError } from '@vip/contracts';
import type { Request, Response } from 'express';
import { devHostGuard, hostnameOf, isLoopbackHost } from './dev-host-guard';

describe('isLoopbackHost', () => {
  it.each([
    'localhost',
    'localhost:5173',
    'LOCALHOST:4173',
    '127.0.0.1',
    '127.0.0.1:3000',
    '[::1]',
    '[::1]:3000',
    '::1',
  ])('allows %s', (host) => {
    expect(isLoopbackHost(host)).toBe(true);
  });

  it.each([
    undefined,
    '',
    '   ',
    'evil.example',
    'evil.example:3000',
    'localhost.evil.example',
    'evil.localhost.example:80',
    '127.0.0.1.evil.example',
    '0.0.0.0',
    '192.168.1.5:3000',
    '[::2]',
    '[::1',
    'localhost@evil.example',
  ])('denies %j', (host) => {
    expect(isLoopbackHost(host)).toBe(false);
  });

  it('strips ports and brackets consistently', () => {
    expect(hostnameOf('localhost:5173')).toBe('localhost');
    expect(hostnameOf('[::1]:3000')).toBe('[::1]');
  });
});

describe('devHostGuard', () => {
  function run(host: string | undefined) {
    const json = jest.fn();
    const res = { status: jest.fn(), type: jest.fn(), json } as unknown as Response;
    (res.status as jest.Mock).mockReturnValue(res);
    (res.type as jest.Mock).mockReturnValue(res);
    const next = jest.fn();
    devHostGuard({ headers: host === undefined ? {} : { host } } as Request, res, next);
    return { res, next, json };
  }

  it('passes loopback hosts through', () => {
    const { next, res } = run('localhost:5173');
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('answers 403 HOST_NOT_ALLOWED without echoing the host', () => {
    const { next, res, json } = run('evil.example');
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ code: 'HOST_NOT_ALLOWED' }));
    expect(JSON.stringify(json.mock.calls)).not.toContain('evil');
    expect(ApiError.safeParse(json.mock.calls[0]![0]).success).toBe(true);
  });

  it('rejects a missing Host header', () => {
    const { next, res } = run(undefined);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });
});
