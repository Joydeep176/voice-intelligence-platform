import { AudioClient, AudioClientError, classify } from './audio-client';

const problem = (status: number, code: string) => ({
  type: 'about:blank',
  title: 't',
  status,
  code,
});

describe('classify (client error mapping)', () => {
  it.each([
    [401, problem(401, 'UNAUTHORIZED'), 'CONFIG'],
    [404, problem(404, 'TASK_NOT_FOUND'), 'LOST'],
    [404, problem(404, 'NOT_FOUND'), 'REJECTED'],
    [503, problem(503, 'CAPACITY_EXCEEDED'), 'BUSY'],
    [503, problem(503, 'INTERNAL_ERROR'), 'UNAVAILABLE'],
    [500, undefined, 'UNAVAILABLE'],
    [422, problem(422, 'INVALID_CONFIG'), 'REJECTED'],
    [400, 'not json problem', 'REJECTED'],
  ] as const)('maps %s %j to %s', (status, body, kind) => {
    expect(classify(status, body).kind).toBe(kind);
  });

  it('carries the service code and never the body', () => {
    const error = classify(422, { ...problem(422, 'INVALID_CONFIG'), detail: 'secret transcript' });
    expect(error.code).toBe('INVALID_CONFIG');
    expect(JSON.stringify(error)).not.toContain('secret');
    expect(error.message).not.toContain('secret');
  });
});

describe('AudioClient', () => {
  const client = new AudioClient({
    url: 'http://audio.test',
    token: 'x'.repeat(32),
    timeoutMs: 100,
  });
  afterEach(() => jest.restoreAllMocks());

  it('sends the bearer token and validates the response', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        Response.json({ taskId: '6f1c1f9e-6a3e-4c55-9a4e-2f1f2d0f7b10', status: 'queued' }),
      );
    await client.cancel('6f1c1f9e-6a3e-4c55-9a4e-2f1f2d0f7b10');
    const init = fetchMock.mock.calls[0]![1]!;
    expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${'x'.repeat(32)}`);
    expect(init.method).toBe('DELETE');
  });

  it('maps transport failure to UNAVAILABLE and a contract-breaking body to INVALID_RESPONSE', async () => {
    jest.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(client.get('t')).rejects.toMatchObject({ kind: 'UNAVAILABLE' });
    jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json({ nope: 1 }));
    await expect(client.get('t')).rejects.toBeInstanceOf(AudioClientError);
    jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json({ nope: 1 }));
    await expect(client.get('t')).rejects.toMatchObject({ kind: 'INVALID_RESPONSE' });
  });
});
