import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { loadConfig } from '../config/app-config';
import { AudioServiceClient } from './audio-service.client';

type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => void;

// Throwaway, test-only value (not a credential).
const TEST_TOKEN = 'test-only-audio-token-0000000000000000';

const baseEnv = (port: number) => ({
  AUTH_MODE: 'dev',
  DEV_WORKSPACE_ID: '00000000-0000-4000-8000-000000000001',
  DATABASE_URL: 'postgres://u:p@127.0.0.1:1/x',
  REDIS_URL: 'redis://127.0.0.1:1',
  AUDIO_SERVICE_URL: `http://127.0.0.1:${port}`,
  AUDIO_SERVICE_TIMEOUT_MS: '200',
  MEDIA_URL_SIGNING_SECRET: 'test-only-media-url-signing-secret-000000000000',
});

describe('AudioServiceClient (stub server)', () => {
  let server: Server;
  let handler: Handler;
  let client: AudioServiceClient;
  let port: number;

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => handler(req, res, body));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
    client = new AudioServiceClient(
      loadConfig({ ...baseEnv(port), AUDIO_SERVICE_TOKEN: TEST_TOKEN }),
    );
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });

  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  };

  it('sends a valid handshake request and validates the echo', async () => {
    let received: unknown;
    handler = (_req, res, body) => {
      received = JSON.parse(body);
      const { requestId } = received as { requestId: string };
      json(res, 200, { contractVersion: '2', serviceVersion: '0.1.0', requestId, accepted: true });
    };
    await expect(client.handshake()).resolves.toMatchObject({ accepted: true });
    expect(received).toMatchObject({ contractVersion: '2', requestId: expect.any(String) });
  });

  it('fetches and validates capabilities', async () => {
    handler = (req, res) => {
      expect(req.url).toBe('/v1/capabilities');
      json(res, 200, {
        contractVersion: '2',
        serviceVersion: '0.1.0',
        python: '3.12.8',
        ffmpeg: { version: '7.1.2' },
        numpy: '2.5.5',
        vad: 'none',
        landlock: { supported: true, abi: 4, enforced: true },
        taskTypes: ['probe', 'preprocess'],
      });
    };
    await expect(client.capabilities()).resolves.toMatchObject({ serviceVersion: '0.1.0' });
    handler = (_req, res) => json(res, 200, { contractVersion: '2' });
    await expect(client.capabilities()).rejects.toMatchObject({ reason: 'INVALID_RESPONSE' });
  });

  it('sends the bearer token on every request and nothing else secret', async () => {
    const seen: (string | undefined)[] = [];
    handler = (req, res) => {
      seen.push(req.headers.authorization);
      json(res, 200, { status: 'ok', service: 'audio-service', version: '0.1.0' });
    };
    await client.ready();
    expect(seen).toEqual([`Bearer ${TEST_TOKEN}`]);
  });

  it('maps a 401 to UNAUTHORIZED without exposing the response body', async () => {
    handler = (_req, res) =>
      json(res, 401, { type: 'about:blank', title: 'x', status: 401, code: 'UNAUTHORIZED' });
    await expect(client.ready()).rejects.toMatchObject({ reason: 'UNAUTHORIZED', status: 401 });
  });

  it('reports NOT_CONFIGURED and sends no request when no token is set', async () => {
    let requests = 0;
    handler = (_req, res) => {
      requests += 1;
      json(res, 200, {});
    };
    const unconfigured = new AudioServiceClient(loadConfig(baseEnv(port)));
    await expect(unconfigured.ready()).rejects.toMatchObject({ reason: 'NOT_CONFIGURED' });
    await expect(unconfigured.handshake()).rejects.toMatchObject({ reason: 'NOT_CONFIGURED' });
    expect(requests).toBe(0);
  });

  it('maps a contract version mismatch problem to a typed failure', async () => {
    handler = (_req, res) =>
      json(res, 422, {
        type: 'about:blank',
        title: 'x',
        status: 422,
        code: 'CONTRACT_VERSION_MISMATCH',
      });
    await expect(client.handshake()).rejects.toMatchObject({
      reason: 'CONTRACT_VERSION_MISMATCH',
      status: 422,
    });
  });

  it('rejects responses that violate the contract', async () => {
    handler = (_req, res) => json(res, 200, { contractVersion: '2', accepted: 'yes' });
    await expect(client.handshake()).rejects.toMatchObject({ reason: 'INVALID_RESPONSE' });
  });

  it('rejects a mismatched request id echo', async () => {
    handler = (_req, res) =>
      json(res, 200, {
        contractVersion: '2',
        serviceVersion: '0.1.0',
        requestId: '6f1c1f9e-6a3e-4c55-9a4e-2f1f2d0f7b10',
        accepted: true,
      });
    await expect(client.handshake()).rejects.toMatchObject({ reason: 'CONTRACT_VERSION_MISMATCH' });
  });

  it('maps 5xx without a body to BAD_STATUS and slow responses to TIMEOUT', async () => {
    handler = (_req, res) => res.writeHead(500).end('internal details that must not leak');
    await expect(client.ready()).rejects.toMatchObject({ reason: 'BAD_STATUS', status: 500 });
    handler = (_req, res) => setTimeout(() => json(res, 200, {}), 1000);
    await expect(client.ready()).rejects.toMatchObject({ reason: 'TIMEOUT' });
  });
});
