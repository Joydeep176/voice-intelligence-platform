import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { loadConfig } from '../config/app-config';
import { AudioServiceClient } from './audio-service.client';

type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => void;

describe('AudioServiceClient (stub server)', () => {
  let server: Server;
  let handler: Handler;
  let client: AudioServiceClient;

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => handler(req, res, body));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    client = new AudioServiceClient(
      loadConfig({
        AUTH_MODE: 'dev',
        DEV_WORKSPACE_ID: '00000000-0000-4000-8000-000000000001',
        DATABASE_URL: 'postgres://u:p@127.0.0.1:1/x',
        REDIS_URL: 'redis://127.0.0.1:1',
        AUDIO_SERVICE_URL: `http://127.0.0.1:${port}`,
        AUDIO_SERVICE_TIMEOUT_MS: '200',
      }),
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
      json(res, 200, { contractVersion: '1', serviceVersion: '0.1.0', requestId, accepted: true });
    };
    await expect(client.handshake()).resolves.toMatchObject({ accepted: true });
    expect(received).toMatchObject({ contractVersion: '1', requestId: expect.any(String) });
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
    handler = (_req, res) => json(res, 200, { contractVersion: '1', accepted: 'yes' });
    await expect(client.handshake()).rejects.toMatchObject({ reason: 'INVALID_RESPONSE' });
  });

  it('rejects a mismatched request id echo', async () => {
    handler = (_req, res) =>
      json(res, 200, {
        contractVersion: '1',
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
